require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3001;
const ETHERSCAN_KEY = process.env.ETHERSCAN_API_KEY || '7E223ZJ84EDSH1WG9YWQYG6DKDTI42RBB2';
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_PER_MINUTE, 10) || 10;

// ─── Middleware ─────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Simple In-Memory Rate Limiter ──────────────────────
const rateMap = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const windowStart = now - 60_000;
  const hits = rateMap.get(ip) || [];
  const recent = hits.filter(t => t > windowStart);
  if (recent.length >= RATE_LIMIT_MAX) return true;
  recent.push(now);
  rateMap.set(ip, recent);
  return false;
}

// ─── Helpers ────────────────────────────────────────────
const safeNum = (v, d = 0) => { const n = parseFloat(v); return isNaN(n) ? d : n; };
const pct = (v, t) => (!t ? 0 : (v / t) * 100);
const flag = (v) => v === '1' || v === 1;

const ETHERSCAN_CHAIN = {
  ethereum: '1', bsc: '56', polygon: '137', arbitrum: '42161',
  optimism: '10', avalanche: '43114', base: '8453', fantom: '250',
  cronos: '25', linea: '59144', zksync: '324', scroll: '534352',
};

const GOPLUS_CHAIN = { ...ETHERSCAN_CHAIN };
const HONEYPOT_CHAIN = {
  ethereum: 'eth', bsc: 'bsc', polygon: 'polygon', arbitrum: 'arbitrum',
  base: 'base', avalanche: 'avalanche', fantom: 'fantom', cronos: 'cronos', optimism: 'optimism',
};

// ─── External APIs ──────────────────────────────────────

async function fetchDexscreener(ca) {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${ca}`;
  const res = await axios.get(url, { timeout: 8000 });
  const pairs = res.data?.pairs;
  if (!pairs?.length) return null;

  pairs.sort((a, b) => safeNum(b.liquidity?.usd) - safeNum(a.liquidity?.usd));
  const p = pairs[0];

  const liquidity = safeNum(p.liquidity?.usd);
  const volume24h = safeNum(p.volume?.h24);
  const volume1h  = safeNum(p.volume?.h1);
  const priceChange24 = safeNum(p.priceChange?.h24);
  const priceChange1  = safeNum(p.priceChange?.h1);
  const priceChange6  = safeNum(p.priceChange?.h6);
  const fdv = safeNum(p.fdv);
  const marketCap = safeNum(p.marketCap) || fdv;
  const txnsBuy24  = safeNum(p.txns?.h24?.buys);
  const txnsSell24 = safeNum(p.txns?.h24?.sells);
  const totalTxns24 = txnsBuy24 + txnsSell24;
  const pairAge = p.pairCreatedAt ? Math.floor((Date.now() - p.pairCreatedAt) / 3.6e6) : null;
  const buyRatio = totalTxns24 > 0 ? txnsBuy24 / totalTxns24 : null;
  const v1w = volume1h * 24;
  const volumeConsistency = (v1w && volume24h) ? Math.abs(v1w - volume24h) / (volume24h || 1) : null;

  return {
    liquidity, volume24h, volume1h, priceChange24, priceChange1, priceChange6,
    fdv, marketCap, txnsBuy24, txnsSell24, totalTxns24, pairAge,
    chain: p.chainId || 'unknown', dex: p.dexId || 'unknown',
    baseSymbol: p.baseToken?.symbol || '???', baseName: p.baseToken?.name || '???',
    baseAddress: p.baseToken?.address || ca, priceUsd: safeNum(p.priceUsd),
    totalPairs: pairs.length, buyRatio, volumeConsistency,
    liquidityToMcap: marketCap > 0 ? pct(liquidity, marketCap) : null,
    volumeToLiquidity: liquidity > 0 ? volume24h / liquidity : null,
  };
}

async function fetchGoPlus(ca, chain) {
  const chainId = GOPLUS_CHAIN[chain];
  if (!chainId) return null;
  try {
    const url = `https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${ca}`;
    const res = await axios.get(url, { timeout: 8000 });
    const r = res.data?.result?.[ca.toLowerCase()];
    if (!r) return null;

    const lockedLp = (r.lp_holders || []).filter(h => h.is_locked === 1);
    const lockedPct = lockedLp.reduce((s, h) => s + parseFloat(h.percent || 0), 0) * 100;

    return {
      isHoneypot: flag(r.is_honeypot),
      cannotBuy: flag(r.cannot_buy),
      cannotSellAll: flag(r.cannot_sell_all),
      hasMintFunction: flag(r.is_mintable),
      hasBlacklist: flag(r.is_blacklisted),
      hasWhitelist: flag(r.is_whitelisted),
      hasProxy: flag(r.is_proxy),
      selfDestruct: flag(r.selfdestruct),
      externalCall: flag(r.external_call),
      hiddenOwner: flag(r.hidden_owner),
      canTakeBackOwnership: flag(r.can_take_back_ownership),
      ownerChangeBalance: flag(r.owner_change_balance),
      buyTax: r.buy_tax != null ? parseFloat(r.buy_tax) : null,
      sellTax: r.sell_tax != null ? parseFloat(r.sell_tax) : null,
      slippageModifiable: flag(r.slippage_modifiable),
      isOpenSource: flag(r.is_open_source),
      ownershipRenounced: r.owner_address === '0x0000000000000000000000000000000000000000',
      holderCount: r.holder_count != null ? parseInt(r.holder_count) : null,
      top10HolderPercent: r.holders ? r.holders.slice(0, 10).reduce((s, h) => s + parseFloat(h.percent || 0), 0) : null,
      lockedLpPct: parseFloat(lockedPct.toFixed(1)),
      lpHolders: r.lp_holders || [],
    };
  } catch (e) { console.warn('[GoPlus]', e.message); return null; }
}

function analyzeGoPlus(gp) {
  if (!gp) return null;
  const c = [], w = [], s = [];

  if (gp.isHoneypot) c.push('CONTRACT CONFIRMED HONEYPOT — tokens cannot be sold');
  if (gp.hasMintFunction) c.push('Mint function present — supply can be inflated at will');
  if (gp.hiddenOwner) c.push('Hidden owner detected — contract control is concealed');
  if (gp.canTakeBackOwnership) c.push('Ownership can be reclaimed — renouncement is fake');
  if (gp.selfDestruct) c.push('Self-destruct function present — contract can be wiped');
  if (gp.cannotSellAll) c.push('Cannot sell full balance — partial exit trap');
  if (gp.cannotBuy) c.push('Buy function restricted — token has limited entry');
  if (gp.ownerChangeBalance) c.push('Owner can modify holder balances — extreme rug risk');

  if (gp.sellTax !== null) {
    if (gp.sellTax > 0.5) c.push(`Sell tax is ${(gp.sellTax * 100).toFixed(0)}% — effectively unsellable`);
    else if (gp.sellTax > 0.1) w.push(`High sell tax: ${(gp.sellTax * 100).toFixed(0)}%`);
    else if (gp.sellTax > 0.05) w.push(`Sell tax: ${(gp.sellTax * 100).toFixed(0)}% — above normal`);
  }
  if (gp.buyTax !== null && gp.buyTax > 0.1) w.push(`Buy tax: ${(gp.buyTax * 100).toFixed(0)}%`);
  if (gp.hasBlacklist) w.push('Blacklist function — deployer can block specific wallets');
  if (gp.hasWhitelist) w.push('Whitelist function — selective trading access');
  if (gp.hasProxy) w.push('Proxy contract — logic can be swapped after deployment');
  if (gp.externalCall) w.push('External call in contract — third-party dependency risk');
  if (gp.slippageModifiable) w.push('Slippage can be modified by owner');

  if (gp.top10HolderPercent !== null) {
    const p = gp.top10HolderPercent * 100;
    if (p > 80) c.push(`Top 10 holders own ${p.toFixed(1)}% — extreme concentration`);
    else if (p > 60) w.push(`Top 10 holders own ${p.toFixed(1)}% of supply`);
    else s.push(`Top 10 holders own ${p.toFixed(1)}% — reasonable distribution`);
  }

  if (gp.lockedLpPct > 80) s.push(`${gp.lockedLpPct.toFixed(0)}% of liquidity is locked`);
  else if (gp.lockedLpPct > 0) w.push(`Only ${gp.lockedLpPct.toFixed(0)}% of LP is locked`);
  else w.push('No liquidity lock detected');

  if (!gp.hasMintFunction) s.push('No mint function — supply is fixed');
  if (!gp.hasBlacklist) s.push('No blacklist function');
  if (gp.isOpenSource) s.push('Contract source code is verified');
  if (gp.ownershipRenounced) s.push('Ownership appears renounced');

  const boost = (c.length * 15) + (w.length * 5);
  return { critical: c, warnings: w, safe: s, isHoneypot: gp.isHoneypot, buyTax: gp.buyTax, sellTax: gp.sellTax, holderCount: gp.holderCount, top10Pct: gp.top10HolderPercent ? parseFloat((gp.top10HolderPercent * 100).toFixed(1)) : null, lockedLpPct: gp.lockedLpPct, isOpenSource: gp.isOpenSource, hasMint: gp.hasMintFunction, hasBlacklist: gp.hasBlacklist, gpRiskBoost: Math.min(boost, 30) };
}

async function fetchHoneypotIs(ca, chain) {
  const ch = HONEYPOT_CHAIN[chain];
  if (!ch) return null;
  try {
    const url = `https://api.honeypot.is/v2/IsHoneypot?address=${ca}&chainID=${ch}`;
    const res = await axios.get(url, { timeout: 7000 });
    const d = res.data; if (!d) return null;
    const sim = d.simulationResult || {};
    return {
      isHoneypot: d.isHoneypot === true,
      reason: d.honeypotResult?.reason || null,
      buyTax: sim.buyTax != null ? parseFloat(sim.buyTax) : null,
      sellTax: sim.sellTax != null ? parseFloat(sim.sellTax) : null,
      transferTax: sim.transferTax != null ? parseFloat(sim.transferTax) : null,
      flags: d.flags || [],
    };
  } catch (e) { console.warn('[Honeypot.is]', e.message); return null; }
}

function analyzeHoneypotIs(hp) {
  if (!hp) return null;
  const c = [], w = [], s = [];
  if (hp.isHoneypot) c.push(`Honeypot.is CONFIRMED: ${hp.reason || 'token cannot be sold'}`);
  else s.push('Honeypot.is: no honeypot detected via simulation');

  if (hp.sellTax !== null) {
    if (hp.sellTax > 50) c.push(`Sell tax simulated at ${hp.sellTax.toFixed(1)}% — effectively a trap`);
    else if (hp.sellTax > 10) w.push(`Sell tax: ${hp.sellTax.toFixed(1)}% (simulated)`);
    else if (hp.sellTax > 0) s.push(`Sell tax: ${hp.sellTax.toFixed(1)}% (simulated)`);
  }
  if (hp.buyTax !== null && hp.buyTax > 10) w.push(`Buy tax: ${hp.buyTax.toFixed(1)}% (simulated)`);
  if (hp.transferTax !== null && hp.transferTax > 0) w.push(`Transfer tax: ${hp.transferTax.toFixed(1)}%`);
  if (hp.flags?.length) hp.flags.forEach(f => w.push(`Flag: ${f}`));
  return { isHoneypot: hp.isHoneypot, buyTax: hp.buyTax, sellTax: hp.sellTax, transferTax: hp.transferTax, reason: hp.reason, critical: c, warnings: w, safe: s };
}

// ─── Etherscan Wallet Intelligence ──────────────────────

async function etherscanRequest(params) {
  const qs = new URLSearchParams({ ...params, apikey: ETHERSCAN_KEY });
  const url = `https://api.etherscan.io/v2/api?${qs.toString()}`;
  const res = await axios.get(url, { timeout: 10000 });
  return res.data;
}

async function fetchContractCreation(ca, chain) {
  const chainId = ETHERSCAN_CHAIN[chain];
  if (!chainId) return null;
  try {
    // Method 1: internal tx list
    const r1 = await etherscanRequest({ chainid: chainId, module: 'account', action: 'txlistinternal', address: ca, startblock: 0, endblock: 99999999, sort: 'asc' });
    if (r1?.status === '1' && r1.result?.length) {
      const tx = r1.result.find(t => t.contractAddress?.toLowerCase() === ca.toLowerCase());
      if (tx) return { deployer: tx.from, txHash: tx.hash, blockNumber: parseInt(tx.blockNumber), timestamp: parseInt(tx.timeStamp) * 1000, inferred: false };
    }
    // Method 2: first normal tx
    const r2 = await etherscanRequest({ chainid: chainId, module: 'account', action: 'txlist', address: ca, startblock: 0, endblock: 99999999, sort: 'asc', page: 1, offset: 1 });
    if (r2?.status === '1' && r2.result?.length) {
      const tx = r2.result[0];
      if (!tx.to || tx.to === '') return { deployer: tx.from, txHash: tx.hash, blockNumber: parseInt(tx.blockNumber), timestamp: parseInt(tx.timeStamp) * 1000, inferred: true };
    }
    return null;
  } catch (e) { console.warn('[Etherscan] creation:', e.message); return null; }
}

async function fetchDeployerHistory(deployer, chain, excludeCa) {
  const chainId = ETHERSCAN_CHAIN[chain];
  if (!chainId) return null;
  try {
    const r = await etherscanRequest({ chainid: chainId, module: 'account', action: 'txlistinternal', address: deployer, startblock: 0, endblock: 99999999, sort: 'desc' });
    if (r?.status !== '1' || !r.result) return null;
    const creations = r.result
      .filter(t => t.contractAddress && t.contractAddress.length > 0 && t.contractAddress.toLowerCase() !== excludeCa.toLowerCase())
      .map(t => ({ address: t.contractAddress, blockNumber: parseInt(t.blockNumber), timestamp: parseInt(t.timeStamp) * 1000 }));
    const seen = new Set();
    const unique = [];
    for (const c of creations) {
      if (!seen.has(c.address.toLowerCase())) { seen.add(c.address.toLowerCase()); unique.push(c); }
    }
    return unique.slice(0, 20);
  } catch (e) { console.warn('[Etherscan] history:', e.message); return null; }
}

async function fetchDeployerBalance(deployer, tokenCa, chain) {
  const chainId = ETHERSCAN_CHAIN[chain];
  if (!chainId) return null;
  try {
    const r = await etherscanRequest({ chainid: chainId, module: 'account', action: 'tokenbalance', contractaddress: tokenCa, address: deployer, tag: 'latest' });
    if (r?.status === '1') return { balance: safeNum(r.result) };
    return null;
  } catch (e) { console.warn('[Etherscan] balance:', e.message); return null; }
}

async function fetchDeployerTxns(deployer, chain) {
  const chainId = ETHERSCAN_CHAIN[chain];
  if (!chainId) return null;
  try {
    const r = await etherscanRequest({ chainid: chainId, module: 'account', action: 'txlist', address: deployer, startblock: 0, endblock: 99999999, sort: 'desc', page: 1, offset: 50 });
    if (r?.status !== '1' || !r.result) return null;
    return r.result.map(t => ({ hash: t.hash, to: t.to, value: t.value, timestamp: parseInt(t.timeStamp) * 1000, isError: t.isError === '1' }));
  } catch (e) { console.warn('[Etherscan] txns:', e.message); return null; }
}

async function analyzeWalletIntelligence(ca, chain, tokenData) {
  const out = { deployer: null, deployerHistory: null, deployerBalance: null, deployerTxns: null, riskBoost: 0, critical: [], warnings: [], safe: [] };
  const creation = await fetchContractCreation(ca, chain);
  if (!creation) { out.warnings.push('Could not trace contract deployer'); return out; }

  out.deployer = { address: creation.deployer, ageDays: Math.floor((Date.now() - creation.timestamp) / 86400000), blockNumber: creation.blockNumber, inferred: creation.inferred };

  const history = await fetchDeployerHistory(creation.deployer, chain, ca);
  if (history) {
    out.deployerHistory = {
      totalTokensLaunched: history.length,
      recentTokens: history.slice(0, 5).map(h => ({ address: h.address, ageDays: Math.floor((Date.now() - h.timestamp) / 86400000) })),
    };
    if (history.length >= 5) { out.critical.push(`Deployer launched ${history.length} tokens — serial deployer`); out.riskBoost += 20; }
    else if (history.length >= 2) { out.warnings.push(`Deployer launched ${history.length} other tokens`); out.riskBoost += 10; }

    const recent = history.filter(h => (Date.now() - h.timestamp) < 30 * 86400000).length;
    if (recent >= 3) { out.critical.push(`Deployer launched ${recent} tokens in last 30 days — factory behavior`); out.riskBoost += 15; }
  }

  const bal = await fetchDeployerBalance(creation.deployer, ca, chain);
  if (bal) {
    if (bal.balance === 0) { out.critical.push('Deployer holds ZERO tokens — full exit suspected'); out.riskBoost += 25; }
    else out.safe.push('Deployer wallet still holds tokens');
    out.deployerBalance = bal;
  }

  const txns = await fetchDeployerTxns(creation.deployer, chain);
  if (txns) {
    const failed = txns.filter(t => t.isError).length;
    if (failed > 5) out.warnings.push(`${failed} failed transactions — possible bot behavior`);
    const dexAddrs = ['0x7a250d5630b4cf539739df2c5dacb4c659f2488d','0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45','0x10ed43c718714eb63d5aa57b78b54704e256024e'];
    const dexHits = txns.filter(t => t.to && dexAddrs.includes(t.to.toLowerCase())).length;
    if (dexHits > 0) { out.warnings.push(`Deployer interacted with DEX ${dexHits} times recently`); out.riskBoost += 10; }
    out.deployerTxns = { recentCount: txns.length, failedCount: failed, dexInteractionCount: dexHits };
  }

  if (tokenData.buyRatio !== null && tokenData.buyRatio > 0.85 && tokenData.totalTxns24 > 20) {
    out.warnings.push('Extreme buy dominance — possible insider accumulation or wash trading');
  }
  if (tokenData.txnsSell24 < 3 && tokenData.txnsBuy24 > 30) {
    out.critical.push('Virtually no sell transactions — holders may be unable to exit');
    out.riskBoost += 20;
  }
  return out;
}

// ─── Classification Engine ──────────────────────────────

function checkHoneypot(d) {
  const e = [], s = 0;
  if (d.txnsSell24 < 5 && d.txnsBuy24 > 30) { e.push(`Only ${d.txnsSell24} sell txns vs ${d.txnsBuy24} buys — sellers may be blocked`); s += 50; }
  else if (d.txnsSell24 < d.txnsBuy24 * 0.05 && d.txnsBuy24 > 20) { e.push(`Sell txns are ${((d.txnsSell24 / d.txnsBuy24) * 100).toFixed(1)}% of buys — abnormal asymmetry`); s += 40; }
  if (d.buyRatio !== null && d.buyRatio > 0.92 && d.totalTxns24 > 20) { e.push(`${(d.buyRatio * 100).toFixed(0)}% buys — almost no outflows`); s += 30; }
  if (d.priceChange24 > 20 && d.txnsSell24 < 10) { e.push('Price rising but selling near-zero — holders may be unable to exit'); s += 20; }
  return { type: 'HONEYPOT SUSPICION', triggered: s >= 40, confidence: Math.min(s, 95), evidence: e };
}

function checkLiquidityExit(d) {
  const e = [], s = 0;
  if (d.liquidity < 5000) { e.push(`Critically low liquidity ($${d.liquidity.toLocaleString()})`); s += 45; }
  else if (d.liquidity < 25000) { e.push(`Low liquidity ($${d.liquidity.toLocaleString()})`); s += 25; }
  if (d.liquidityToMcap !== null && d.liquidityToMcap < 2) { e.push(`Liquidity is only ${d.liquidityToMcap.toFixed(1)}% of mcap`); s += 30; }
  if (d.pairAge !== null && d.pairAge < 24 && d.liquidity < 50000) { e.push(`Pair is ${d.pairAge}h old — liquidity fragile`); s += 20; }
  if (d.totalPairs === 1) { e.push('Single trading pair — fragility high'); s += 10; }
  return { type: 'LIQUIDITY EXIT RISK', triggered: s >= 40, confidence: Math.min(s, 95), evidence: e };
}

function checkSlowRug(d) {
  const e = [], s = 0;
  if (d.priceChange24 < -30 && d.volume24h < d.liquidity * 0.1) { e.push(`Price down ${Math.abs(d.priceChange24).toFixed(1)}% with low sell volume — controlled bleed`); s += 40; }
  if (d.priceChange24 < -15 && d.txnsSell24 > d.txnsBuy24 * 2) { e.push(`Sells (${d.txnsSell24}) overwhelm buys (${d.txnsBuy24}) — insider exit`); s += 30; }
  if (d.priceChange6 < -10 && d.priceChange1 < -5) { e.push('Consistent hourly decline without recovery'); s += 20; }
  if (d.liquidity < 30000 && d.priceChange24 < -20) { e.push('Low liquidity + price decline — rug possible'); s += 25; }
  return { type: 'SLOW RUG', triggered: s >= 40, confidence: Math.min(s, 95), evidence: e };
}

function checkPumpDump(d) {
  const e = [], s = 0;
  if (d.priceChange24 > 100) { e.push(`Price surged +${d.priceChange24.toFixed(1)}% in 24h`); s += 35; }
  else if (d.priceChange24 > 50) { e.push(`Price up ${d.priceChange24.toFixed(1)}% today`); s += 20; }
  if (d.volumeToLiquidity !== null && d.volumeToLiquidity > 8) { e.push(`Volume/liquidity: ${d.volumeToLiquidity.toFixed(1)}x`); s += 30; }
  if (d.buyRatio !== null && d.buyRatio > 0.75 && d.priceChange24 > 30) { e.push(`${(d.buyRatio * 100).toFixed(0)}% buys — coordinated buy wall`); s += 25; }
  if (d.pairAge !== null && d.pairAge < 48 && d.priceChange24 > 50) { e.push(`${d.pairAge}h old with massive spike — P&D pattern`); s += 20; }
  if (d.fdv > 0 && d.liquidity < d.fdv * 0.005) { e.push(`FDV $${(d.fdv / 1e6).toFixed(2)}M vs thin liquidity`); s += 15; }
  return { type: 'PUMP & DUMP SETUP', triggered: s >= 40, confidence: Math.min(s, 95), evidence: e };
}

function checkFakeVolume(d) {
  const e = [], s = 0;
  if (d.volume24h > 500000 && d.totalTxns24 < 50) { e.push(`$${(d.volume24h / 1e3).toFixed(0)}K volume from ${d.totalTxns24} txns — wash trading`); s += 50; }
  if (d.volumeConsistency !== null && d.volumeConsistency > 2.5) { e.push('Volume distribution irregular — artificial spikes'); s += 35; }
  if (d.volumeToLiquidity !== null && d.volumeToLiquidity > 15) { e.push(`Volume ${d.volumeToLiquidity.toFixed(0)}x liquidity — mathematically inconsistent`); s += 40; }
  if (d.priceChange24 > -2 && d.priceChange24 < 2 && d.volume24h > d.liquidity * 5) { e.push('Flat price despite massive volume — circular trading'); s += 30; }
  return { type: 'FAKE VOLUME / WASH TRADING', triggered: s >= 40, confidence: Math.min(s, 95), evidence: e };
}

function checkInsider(d) {
  const e = [], s = 0;
  if (d.pairAge !== null && d.pairAge < 12 && d.volume24h > 100000) { e.push(`${d.pairAge}h old with $${(d.volume24h / 1e3).toFixed(0)}K volume — early accumulation`); s += 30; }
  if (d.buyRatio !== null && d.buyRatio > 0.8 && d.priceChange24 < 10) { e.push(`Heavy buying (${(d.buyRatio * 100).toFixed(0)}%) with minimal price impact`); s += 35; }
  if (d.liquidityToMcap !== null && d.liquidityToMcap > 30 && d.volume24h < d.liquidity * 0.1) { e.push('High liquidity vs mcap with low volume — team holding off-market'); s += 25; }
  if (d.marketCap > 0 && d.fdv > d.marketCap * 5) { e.push(`FDV is ${(d.fdv / d.marketCap).toFixed(0)}x mcap — large unlocked insider supply`); s += 30; }
  return { type: 'INSIDER ACCUMULATION', triggered: s >= 40, confidence: Math.min(s, 95), evidence: e };
}

function checkOvervalued(d) {
  const e = [], s = 0;
  if (d.fdv > 0 && d.liquidity > 0 && d.fdv / d.liquidity > 500) { e.push(`FDV/liquidity ${(d.fdv / d.liquidity).toFixed(0)}x — massively overvalued`); s += 35; }
  if (d.priceChange24 > 200) { e.push(`+${d.priceChange24.toFixed(0)}% in 24h — unsustainable`); s += 30; }
  if (d.marketCap > 10e6 && d.liquidity < 50000) { e.push(`$${(d.marketCap / 1e6).toFixed(1)}M mcap, $${(d.liquidity / 1e3).toFixed(0)}K liquidity`); s += 35; }
  return { type: 'OVERVALUED / INSIDER CONTROL', triggered: s >= 40, confidence: Math.min(s, 95), evidence: e };
}

function classifyToken(d, wi) {
  const checks = [checkHoneypot(d), checkLiquidityExit(d), checkFakeVolume(d), checkSlowRug(d), checkPumpDump(d), checkInsider(d), checkOvervalued(d)];
  const triggered = checks.filter(c => c.triggered);

  if (wi?.critical?.length) triggered.push({ type: 'DEPLOYER RISK', triggered: true, confidence: Math.min(wi.riskBoost * 2, 95), evidence: wi.critical });

  if (!triggered.length) {
    const safe = [];
    if (d.liquidity >= 50000) safe.push(`Adequate liquidity ($${(d.liquidity / 1e3).toFixed(0)}K)`);
    if (d.priceChange24 > -20 && d.priceChange24 < 80) safe.push(`Price change normal (${d.priceChange24.toFixed(1)}%)`);
    if (d.buyRatio !== null && d.buyRatio > 0.3 && d.buyRatio < 0.8) safe.push(`Balanced buy/sell ratio`);
    if (wi?.deployerHistory?.totalTokensLaunched === 0) safe.push('First-time deployer');
    safe.push('No critical scam patterns detected');
    return { type: 'RELATIVELY SAFE', confidence: 65, evidence: safe, secondaryFlags: [] };
  }

  triggered.sort((a, b) => b.confidence - a.confidence);
  return { type: triggered[0].type, confidence: triggered[0].confidence, evidence: triggered[0].evidence, secondaryFlags: triggered.slice(1).map(t => ({ type: t.type, confidence: t.confidence })) };
}

function deriveRiskScore(cls, wi, gp) {
  if (cls.type === 'RELATIVELY SAFE') return Math.max(0, 35 - cls.confidence * 0.2);
  const weights = { 'HONEYPOT SUSPICION': 1.0, 'SLOW RUG': 0.95, 'LIQUIDITY EXIT RISK': 0.9, 'FAKE VOLUME / WASH TRADING': 0.8, 'PUMP & DUMP SETUP': 0.85, 'INSIDER ACCUMULATION': 0.75, 'OVERVALUED / INSIDER CONTROL': 0.7, 'DEPLOYER RISK': 0.95 };
  let score = cls.confidence * (weights[cls.type] || 0.75);
  if (cls.secondaryFlags) score += Math.min(cls.secondaryFlags.reduce((a, f) => a + f.confidence * 0.1, 0), 15);
  if (wi) score += Math.min(wi.riskBoost, 25);
  if (gp) score += gp.gpRiskBoost;
  return Math.min(Math.round(score), 99);
}

const riskLabel = (s) => s >= 80 ? 'CRITICAL' : s >= 60 ? 'HIGH' : s >= 40 ? 'MEDIUM' : s >= 20 ? 'LOW' : 'MINIMAL';

// ─── Routes ─────────────────────────────────────────────

app.get('/api/scan', async (req, res, next) => {
  try {
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
    if (isRateLimited(ip)) return res.status(429).json({ error: 'Rate limit exceeded. Try again in a minute.' });

    const { ca } = req.query;
    if (!ca || ca.trim().length < 10) return res.status(400).json({ error: 'Invalid contract address' });

    const data = await fetchDexscreener(ca.trim());
    if (!data) return res.status(404).json({ error: 'Token not found on Dexscreener' });

    // Fetch intelligence in parallel with resilience
    const [gpRaw, hpRaw, wi] = await Promise.all([
      fetchGoPlus(ca.trim(), data.chain),
      fetchHoneypotIs(ca.trim(), data.chain),
      analyzeWalletIntelligence(ca.trim(), data.chain, data),
    ]);

    const gp = analyzeGoPlus(gpRaw);
    const hp = analyzeHoneypotIs(hpRaw);

    const classification = classifyToken(data, wi);
    let riskScore = deriveRiskScore(classification, wi, gp);

    const honeypotConfirmed = gp?.isHoneypot || hp?.isHoneypot;
    if (honeypotConfirmed) {
      classification.type = 'HONEYPOT CONFIRMED';
      classification.confidence = 99;
      const sources = [gp?.isHoneypot ? 'GoPlus' : null, hp?.isHoneypot ? 'Honeypot.is' : null].filter(Boolean).join(' + ');
      classification.evidence.unshift(`${sources}: contract confirmed as honeypot`);
      riskScore = 99;
    }

    // Merge wallet intel into evidence
    if (wi?.critical.length) classification.evidence.unshift(...wi.critical);
    if (wi?.warnings.length) classification.evidence.push(...wi.warnings);

    res.json({
      type: classification.type,
      confidence: classification.confidence,
      riskScore,
      riskLevel: riskLabel(riskScore),
      evidence: classification.evidence,
      secondaryFlags: classification.secondaryFlags || [],
      token: {
        name: data.baseName, symbol: data.baseSymbol, address: data.baseAddress,
        chain: data.chain, dex: data.dex, priceUsd: data.priceUsd, pairAgeHours: data.pairAge,
      },
      metrics: {
        liquidity: data.liquidity, volume24h: data.volume24h,
        priceChange24h: data.priceChange24, priceChange1h: data.priceChange1,
        fdv: data.fdv, marketCap: data.marketCap,
        txnsBuy24h: data.txnsBuy24, txnsSell24h: data.txnsSell24,
        buyRatio: data.buyRatio ? parseFloat(data.buyRatio.toFixed(3)) : null,
        liquidityToMcapPct: data.liquidityToMcap ? parseFloat(data.liquidityToMcap.toFixed(2)) : null,
        volumeToLiquidity: data.volumeToLiquidity ? parseFloat(data.volumeToLiquidity.toFixed(2)) : null,
      },
      contractIntelligence: gp ? {
        supported: true, isHoneypot: gp.isHoneypot,
        buyTax: gp.buyTax !== null ? parseFloat((gp.buyTax * 100).toFixed(1)) : null,
        sellTax: gp.sellTax !== null ? parseFloat((gp.sellTax * 100).toFixed(1)) : null,
        holderCount: gp.holderCount, top10HolderPct: gp.top10Pct,
        lockedLpPct: gp.lockedLpPct, isOpenSource: gp.isOpenSource,
        hasMintFunction: gp.hasMint, hasBlacklist: gp.hasBlacklist,
        critical: gp.critical, warnings: gp.warnings, safe: gp.safe,
      } : { supported: false },
      honeypotIs: hp ? {
        supported: true, isHoneypot: hp.isHoneypot, reason: hp.reason,
        buyTax: hp.buyTax !== null ? parseFloat(hp.buyTax.toFixed(1)) : null,
        sellTax: hp.sellTax !== null ? parseFloat(hp.sellTax.toFixed(1)) : null,
        transferTax: hp.transferTax !== null ? parseFloat(hp.transferTax.toFixed(1)) : null,
        critical: hp.critical, warnings: hp.warnings, safe: hp.safe,
      } : { supported: false },
      walletIntelligence: {
        supported: wi.deployer !== null,
        deployer: wi.deployer, deployerHistory: wi.deployerHistory,
        deployerBalance: wi.deployerBalance, deployerTxns: wi.deployerTxns,
        critical: wi.critical, warnings: wi.warnings, safe: wi.safe,
      },
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handler
app.use((err, req, res, next) => {
  console.error('[Error]', err.message);
  if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
    return res.status(504).json({ error: 'Upstream API timeout. Try again.' });
  }
  res.status(500).json({ error: 'Internal error', detail: err.message });
});

app.listen(PORT, () => console.log(`🚀 ScanTheMemes running on port ${PORT}`));
