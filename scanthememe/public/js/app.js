const API_BASE = window.location.origin;

const ICONS = {
  'HONEYPOT SUSPICION': '🕸', 'HONEYPOT CONFIRMED': '🕸', 'SLOW RUG': '🐌',
  'LIQUIDITY EXIT RISK': '💧', 'FAKE VOLUME / WASH TRADING': '🔄',
  'PUMP & DUMP SETUP': '🚀', 'INSIDER ACCUMULATION': '🐋',
  'OVERVALUED / INSIDER CONTROL': '🎈', 'DEPLOYER RISK': '🧬', 'RELATIVELY SAFE': '✅',
};

const RISK_COLORS = { CRITICAL: '#ff4757', HIGH: '#ff9f43', MEDIUM: '#ffd32a', LOW: '#54a0ff', MINIMAL: '#00e5a0' };
const HISTORY_KEY = 'scanthememes_history';
const MAX_HISTORY = 15;

function riskColor(level) {
  return { CRITICAL: 'critical', HIGH: 'high', MEDIUM: 'medium', LOW: 'low', MINIMAL: 'safe' }[level] || 'low';
}

function fmt(n, digits = 0) {
  if (n == null) return '—';
  if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (Math.abs(n) >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
  return '$' + n.toFixed(digits);
}

function shortAddr(addr) {
  if (!addr) return '—';
  return addr.slice(0, 6) + '...' + addr.slice(-4);
}

function show(id) { document.getElementById(id).classList.add('visible'); }
function hide(id) { document.getElementById(id).classList.remove('visible'); }
function setHTML(id, html) { document.getElementById(id).innerHTML = html; }

document.getElementById('caInput').addEventListener('keydown', e => { if (e.key === 'Enter') scan(); });

let currentData = null;

async function scan() {
  const ca = document.getElementById('caInput').value.trim();
  if (!ca) return;

  document.getElementById('scanBtn').disabled = true;
  hide('result'); hide('errorBox'); show('loading');

  try {
    const res = await fetch(`${API_BASE}/api/scan?ca=${encodeURIComponent(ca)}`);
    const data = await res.json();
    hide('loading');

    if (!res.ok) {
      document.getElementById('errorBox').textContent = data.error || 'Unknown error';
      show('errorBox');
      return;
    }

    renderResult(data);
    addToHistory(data);
    show('result');
  } catch (e) {
    hide('loading');
    document.getElementById('errorBox').textContent = 'Network error. Please try again.';
    show('errorBox');
  } finally {
    document.getElementById('scanBtn').disabled = false;
  }
}

function renderResult(d) {
  currentData = d;
  const level = riskColor(d.riskLevel);
  const colorClass = 'color-' + level;
  const addrShort = d.token.address.length > 16 ? d.token.address.slice(0, 8) + '...' + d.token.address.slice(-6) : d.token.address;

  setHTML('tokenInfo', `
    <div>
      <div class="token-name">${d.token.symbol} <span style="font-weight:300;color:var(--muted)">${d.token.name}</span></div>
      <div class="token-addr">${addrShort}</div>
    </div>
    <div class="token-tags">
      <span class="tag">${d.token.chain}</span>
      <span class="tag">${d.token.dex}</span>
      ${d.token.pairAgeHours !== null ? `<span class="tag">${d.token.pairAgeHours}h old</span>` : ''}
      ${d.token.priceUsd ? `<span class="tag">$${parseFloat(d.token.priceUsd).toExponential(3)}</span>` : ''}
    </div>
  `);

  const card = document.getElementById('verdictCard');
  card.className = 'verdict ' + colorClass;
  setHTML('verdictIcon', ICONS[d.type] || '⚠️');
  setHTML('verdictType', d.type);
  setHTML('verdictToken', `<strong>${d.confidence}%</strong> confidence · Risk score: <strong>${d.riskScore}/100</strong>`);
  setHTML('riskBadge', d.riskLevel);
  document.getElementById('riskBadge').className = 'risk-badge';

  setHTML('riskScoreNum', d.riskScore + '/100');
  setTimeout(() => { document.getElementById('riskFill').style.width = d.riskScore + '%'; }, 100);

  setHTML('evidenceList', d.evidence.map(e => `
    <li class="evidence-item"><span class="evidence-bullet"></span><span>${e}</span></li>
  `).join(''));

  const sec = document.getElementById('secondarySection');
  if (d.secondaryFlags?.length) {
    sec.style.display = 'block';
    setHTML('flagsGrid', d.secondaryFlags.map(f => `
      <div class="flag-card">
        <div class="flag-name">${ICONS[f.type] || '⚠'} ${f.type}</div>
        <div class="flag-conf">${f.confidence}% confidence</div>
      </div>
    `).join(''));
  } else sec.style.display = 'none';

  const m = d.metrics;
  const metrics = [
    { label: 'Liquidity', value: fmt(m.liquidity), sub: m.liquidityToMcapPct ? m.liquidityToMcapPct.toFixed(1) + '% of mcap' : null },
    { label: 'Volume 24h', value: fmt(m.volume24h), sub: m.volumeToLiquidity ? m.volumeToLiquidity.toFixed(1) + 'x liquidity' : null },
    { label: 'Price Δ 24h', value: (m.priceChange24h >= 0 ? '+' : '') + m.priceChange24h.toFixed(1) + '%', sub: m.priceChange1h != null ? '1h: ' + (m.priceChange1h >= 0 ? '+' : '') + m.priceChange1h.toFixed(1) + '%' : null },
    { label: 'Market Cap', value: fmt(m.marketCap), sub: m.fdv !== m.marketCap ? 'FDV ' + fmt(m.fdv) : null },
    { label: 'Txns 24h', value: (m.txnsBuy24h + m.txnsSell24h).toLocaleString(), sub: m.buyRatio ? 'Buy ratio: ' + (m.buyRatio * 100).toFixed(0) + '%' : null },
    { label: 'Sell Txns', value: m.txnsSell24h.toLocaleString(), sub: m.txnsBuy24h ? 'vs ' + m.txnsBuy24h.toLocaleString() + ' buys' : null },
  ];

  setHTML('metricsGrid', metrics.map(({ label, value, sub }) => `
    <div class="metric-card">
      <div class="metric-label">${label}</div>
      <div class="metric-value">${value}</div>
      ${sub ? `<div class="metric-sub">${sub}</div>` : ''}
    </div>
  `).join(''));

  renderHoneypotIs(d.honeypotIs);
  renderContractIntelligence(d.contractIntelligence);
  renderWalletIntelligence(d.walletIntelligence);
}

function renderWalletIntelligence(wi) {
  const section = document.getElementById('walletIntelSection');
  const content = document.getElementById('walletIntelContent');

  if (!wi || !wi.supported) {
    section.style.display = 'block';
    content.innerHTML = `<div class="wi-unsupported">Wallet intelligence not available for this chain (Solana, etc.). Supported on ETH, BSC, Base, Polygon & more.</div>`;
    return;
  }

  section.style.display = 'block';
  if (!wi.deployer) {
    content.innerHTML = `<div class="wi-unsupported">Could not trace contract deployer. Wallet intelligence limited.</div>`;
    return;
  }

  const deployer = wi.deployer;
  const history = wi.deployerHistory;
  const explorerUrl = deployer.address ? `https://etherscan.io/address/${deployer.address}` : '#';

  let html = `
    <div class="wi-card">
      <div class="wi-header">
        <div class="wi-icon">🧬</div>
        <div>
          <div class="wi-title">Deployer Wallet</div>
          <div class="wi-subtitle">${deployer.inferred ? 'Inferred from first transaction' : 'Traced via contract creation'}</div>
        </div>
      </div>
      <div class="wi-body">
        <div class="wi-deployer-row">
          <div class="wi-deployer-info">
            <div class="wi-deployer-label">Address</div>
            <div class="wi-deployer-addr">${deployer.address}</div>
            <div class="wi-deployer-age">Deployed ${deployer.ageDays} days ago · Block #${deployer.blockNumber.toLocaleString()}</div>
          </div>
          <a class="wi-deployer-link" href="${explorerUrl}" target="_blank" rel="noopener">View on Etherscan ↗</a>
        </div>
  `;

  if (history) {
    const total = history.totalTokensLaunched;
    const recent = (history.recentTokens || []).filter(t => t.ageDays < 30).length;
    html += `
      <div class="wi-history-grid">
        <div class="wi-history-stat">
          <div class="wi-history-stat-label">Tokens Launched</div>
          <div class="wi-history-stat-value ${total >= 5 ? 'danger' : total >= 2 ? 'warn' : 'safe'}">${total}</div>
        </div>
        <div class="wi-history-stat">
          <div class="wi-history-stat-label">Last 30 Days</div>
          <div class="wi-history-stat-value ${recent >= 3 ? 'danger' : recent > 0 ? 'warn' : 'safe'}">${recent}</div>
        </div>
        <div class="wi-history-stat">
          <div class="wi-history-stat-label">Wallet Age</div>
          <div class="wi-history-stat-value safe">${deployer.ageDays}d</div>
        </div>
      </div>
    `;
    if (history.recentTokens?.length) {
      html += `<div class="wi-tokens-list">`;
      history.recentTokens.slice(0, 5).forEach(t => {
        html += `<div class="wi-token-item"><span class="wi-token-addr">${shortAddr(t.address)}</span><span class="wi-token-age">${t.ageDays}d ago</span></div>`;
      });
      html += `</div>`;
    }
  }

  const allFlags = [
    ...(wi.critical || []).map(f => ({ text: f, type: 'critical' })),
    ...(wi.warnings || []).map(f => ({ text: f, type: 'warning' })),
    ...(wi.safe || []).map(f => ({ text: f, type: 'safe' })),
  ];

  if (allFlags.length) {
    html += `<div class="wi-flags">`;
    allFlags.forEach(f => {
      const icon = f.type === 'critical' ? '✕' : f.type === 'warning' ? '!' : '✓';
      html += `<div class="ci-flag ${f.type}"><span class="ci-flag-icon">${icon}</span><span>${f.text}</span></div>`;
    });
    html += `</div>`;
  }

  html += `</div></div>`;
  content.innerHTML = html;
}

function renderContractIntelligence(ci) {
  const el = document.getElementById('contractIntelligence');
  if (!ci || !ci.supported) {
    el.innerHTML = `<div class="wi-unsupported">Contract analysis not available for this chain (Solana). Supported on ETH, BSC, Base, Polygon & more.</div>`;
    return;
  }

  const taxColor = (v) => v === null ? 'muted' : v > 10 ? 'bad' : v > 5 ? 'warn' : 'good';
  const stats = [
    { label: 'Buy Tax', value: ci.buyTax !== null ? ci.buyTax + '%' : '—', cls: taxColor(ci.buyTax) },
    { label: 'Sell Tax', value: ci.sellTax !== null ? ci.sellTax + '%' : '—', cls: taxColor(ci.sellTax) },
    { label: 'Top 10 Hold', value: ci.top10HolderPct !== null ? ci.top10HolderPct + '%' : '—', cls: ci.top10HolderPct > 60 ? 'bad' : ci.top10HolderPct > 40 ? 'warn' : 'good' },
    { label: 'LP Locked', value: ci.lockedLpPct !== null ? ci.lockedLpPct + '%' : '—', cls: ci.lockedLpPct > 80 ? 'good' : ci.lockedLpPct > 0 ? 'warn' : 'bad' },
    { label: 'Holders', value: ci.holderCount ? ci.holderCount.toLocaleString() : '—', cls: 'muted' },
    { label: 'Open Source', value: ci.isOpenSource ? 'YES' : 'NO', cls: ci.isOpenSource ? 'good' : 'warn' },
    { label: 'Mint Func', value: ci.hasMintFunction ? 'YES' : 'NO', cls: ci.hasMintFunction ? 'bad' : 'good' },
    { label: 'Blacklist', value: ci.hasBlacklist ? 'YES' : 'NO', cls: ci.hasBlacklist ? 'warn' : 'good' },
  ];

  const statsHTML = `<div class="ci-grid">${stats.map(s =>
    `<div class="ci-stat"><div class="ci-stat-label">${s.label}</div><div class="ci-stat-value ${s.cls}">${s.value}</div></div>`
  ).join('')}</div>`;

  const flagsHTML = [
    ...ci.critical.map(f => `<div class="ci-flag critical"><span class="ci-flag-icon">✕</span><span>${f}</span></div>`),
    ...ci.warnings.map(f => `<div class="ci-flag warning"><span class="ci-flag-icon">!</span><span>${f}</span></div>`),
    ...ci.safe.map(f => `<div class="ci-flag safe"><span class="ci-flag-icon">✓</span><span>${f}</span></div>`),
  ].join('');

  el.innerHTML = statsHTML + `<div class="ci-flags">${flagsHTML}</div>`;
}

function renderHoneypotIs(hp) {
  const section = document.getElementById('honeypotSection');
  const content = document.getElementById('honeypotContent');
  if (!hp || !hp.supported) { section.style.display = 'none'; return; }
  section.style.display = 'block';

  const vClass = hp.isHoneypot ? 'danger' : 'safe';
  const vIcon = hp.isHoneypot ? '✕' : '✓';
  const vText = hp.isHoneypot ? `HONEYPOT DETECTED${hp.reason ? ' — ' + hp.reason : ''}` : 'SAFE — simulation passed, token can be sold';

  const taxColor = (v) => v === null ? 'muted' : v > 10 ? 'bad' : v > 5 ? 'warn' : 'good';
  content.innerHTML = `
    <div class="hp-verdict ${vClass}"><span>${vIcon}</span><span>${vText}</span></div>
    <div class="hp-taxes">
      <div class="ci-stat"><div class="ci-stat-label">Buy Tax</div><div class="ci-stat-value ${taxColor(hp.buyTax)}">${hp.buyTax !== null ? hp.buyTax + '%' : '—'}</div></div>
      <div class="ci-stat"><div class="ci-stat-label">Sell Tax</div><div class="ci-stat-value ${taxColor(hp.sellTax)}">${hp.sellTax !== null ? hp.sellTax + '%' : '—'}</div></div>
      <div class="ci-stat"><div class="ci-stat-label">Transfer Tax</div><div class="ci-stat-value ${taxColor(hp.transferTax)}">${hp.transferTax !== null ? hp.transferTax + '%' : '—'}</div></div>
    </div>
    <div class="ci-flags">
      ${hp.critical.map(f => `<div class="ci-flag critical"><span class="ci-flag-icon">✕</span><span>${f}</span></div>`).join('')}
      ${hp.warnings.map(f => `<div class="ci-flag warning"><span class="ci-flag-icon">!</span><span>${f}</span></div>`).join('')}
      ${hp.safe.map(f => `<div class="ci-flag safe"><span class="ci-flag-icon">✓</span><span>${f}</span></div>`).join('')}
    </div>
  `;
}

function copyShareLink() {
  if (!currentData) return;
  const url = new URL(window.location.href);
  url.searchParams.set('ca', currentData.token.address);
  navigator.clipboard.writeText(url.toString()).then(() => {
    const btn = document.getElementById('copyLinkBtn');
    btn.textContent = '✓ Copied!'; btn.classList.add('copied');
    setTimeout(() => { btn.textContent = '⎘ Copy share link'; btn.classList.remove('copied'); }, 2000);
  });
}

function copyReport() {
  if (!currentData) return;
  const d = currentData, m = d.metrics;
  const lines = [
    `🔍 SCANTHEMEMES REPORT`, `Token: ${d.token.symbol} (${d.token.name})`,
    `Chain: ${d.token.chain} · DEX: ${d.token.dex}`, `CA: ${d.token.address}`, ``,
    `⚠️ Verdict: ${d.type}`, `Risk Score: ${d.riskScore}/100 (${d.riskLevel})`, `Confidence: ${d.confidence}%`, ``,
    `Evidence:`, ...d.evidence.map(e => `• ${e}`), ``,
    `Metrics:`, `• Liquidity: ${fmt(m.liquidity)}`, `• Volume 24h: ${fmt(m.volume24h)}`,
    `• Price Change 24h: ${m.priceChange24h?.toFixed(1)}%`, `• Market Cap: ${fmt(m.marketCap)}`, ``,
    `Scanned with scanthememes.com`,
  ];
  navigator.clipboard.writeText(lines.join('\n'));
  const btn = event.target;
  btn.textContent = '✓ Copied!'; btn.classList.add('copied');
  setTimeout(() => { btn.textContent = '✎ Copy report'; btn.classList.remove('copied'); }, 2000);
}

(function checkUrlParam() {
  const params = new URLSearchParams(window.location.search);
  const ca = params.get('ca');
  if (ca) { document.getElementById('caInput').value = ca; scan(); }
})();

function loadHistory() { try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; } catch { return []; } }
function saveHistory(items) { localStorage.setItem(HISTORY_KEY, JSON.stringify(items)); }

function addToHistory(data) {
  const items = loadHistory().filter(i => i.ca !== data.token.address);
  items.unshift({
    ca: data.token.address, symbol: data.token.symbol, name: data.token.name,
    type: data.type, riskScore: data.riskScore, riskLevel: data.riskLevel, chain: data.token.chain, ts: Date.now(),
  });
  saveHistory(items.slice(0, MAX_HISTORY));
  renderHistory();
}

function clearHistory() { localStorage.removeItem(HISTORY_KEY); renderHistory(); }

function timeAgo(ts) {
  const d = Math.floor((Date.now() - ts) / 1000);
  if (d < 60) return d + 's ago';
  if (d < 3600) return Math.floor(d / 60) + 'm ago';
  if (d < 86400) return Math.floor(d / 3600) + 'h ago';
  return Math.floor(d / 86400) + 'd ago';
}

function renderHistory() {
  const items = loadHistory();
  const section = document.getElementById('historySection');
  const list = document.getElementById('historyList');
  if (!items.length) { section.style.display = 'none'; return; }
  section.style.display = 'block';
  list.innerHTML = items.map(item => `
    <div class="history-item" onclick="rescan('${item.ca}')">
      <div class="history-verdict-dot" style="background:${RISK_COLORS[item.riskLevel] || '#666'}"></div>
      <div class="history-token">
        <div class="history-symbol">${item.symbol} <span style="font-weight:400;color:var(--muted);font-size:11px;">${item.chain}</span></div>
        <div class="history-type">${item.type}</div>
      </div>
      <div class="history-right">
        <div class="history-score" style="color:${RISK_COLORS[item.riskLevel] || '#666'}">${item.riskScore}/100</div>
        <div class="history-time">${timeAgo(item.ts)}</div>
      </div>
    </div>
  `).join('');
}

function rescan(ca) {
  document.getElementById('caInput').value = ca;
  window.scrollTo({ top: 0, behavior: 'smooth' });
  scan();
}

renderHistory();
