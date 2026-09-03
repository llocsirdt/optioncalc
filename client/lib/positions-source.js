// Positions SOURCE controller: the account-tabs UI (Manual | Fidelity CSV | Strategy) that decides which
// positions dataset the calculator is showing, so Fidelity CSV imports and the live Strategy (paper) book
// never comingle. Owns: the selected source (persisted per symbol), the source-scoped localStorage cache
// key (so multiple datasets coexist per symbol+expiration), the Strategy pull from the candle-spread runs
// API + auto-refresh, and the timestamps store the future NQ-chart trade overlay will read.
//
// oc.js calls window.positionsCacheKey() for save/restore; everything else is wired here.
(function () {
  'use strict';
  const SOURCES = ['manual', 'fidelity', 'strategy'];

  const el = (id) => document.getElementById(id);
  const currentSymbol = () => (el('symbol-input') ? el('symbol-input').value.trim().toUpperCase() : '');
  const currentExpiration = () =>
    (typeof getSelectedExpiration === 'function' && getSelectedExpiration()) ||
    (el('expiration-dropdown') ? el('expiration-dropdown').value : '') || '';
  const currentVariant = () => (el('ps-variant-select') ? el('ps-variant-select').value : 'v6');

  // Strategy runs are keyed by TRADE DATE, which is NOT the chain expiration the calculator is viewing:
  // after a 0DTE expiration rolls off the chain dropdown post-close, the dropdown points at the NEXT session
  // while the run is still filed under today. Remember the date the last successful pull resolved to (per
  // symbol+variant) so restore/markers align with the run, not the rolled-forward chain.
  const resolvedExp = {};   // `${symbol}:${variant}` -> tradeDate string
  const strategyExpiration = () => resolvedExp[`${currentSymbol()}:${currentVariant()}`] || currentExpiration();

  const sourceKey = (symbol) => `positionsSource_${(symbol || currentSymbol()).toUpperCase()}`;
  function getPositionsSource(symbol) { try { return localStorage.getItem(sourceKey(symbol)) || 'manual'; } catch (e) { return 'manual'; } }
  function setStoredSource(s, symbol) { try { localStorage.setItem(sourceKey(symbol), s); } catch (e) {} }

  // Source-scoped cache key (Strategy also scopes by variant). oc.js uses this; it falls back to the
  // legacy `${SYMBOL}-${expiration}` key for the Manual source so pre-existing saves aren't lost.
  function positionsCacheKey(symbol, expiration) {
    const src = getPositionsSource(symbol);
    const base = `pos:${src}:${(symbol || '').toUpperCase()}:${expiration}`;
    return src === 'strategy' ? `${base}:${currentVariant()}` : base;
  }

  // Timestamps store for the future NQ-chart trade overlay: keeps each pulled position's open/cover
  // CANDLE time alongside its legs, keyed by symbol+expiration+variant.
  const metaKey = (sym, exp, v) => `posmeta:strategy:${sym}:${exp}:${v}`;
  function saveStrategyMeta(sym, exp, v, positions, fetchedAt) {
    try { localStorage.setItem(metaKey(sym, exp, v), JSON.stringify({ fetchedAt, positions })); } catch (e) {}
  }
  function getStrategyMeta(sym, exp, v) {
    try { return JSON.parse(localStorage.getItem(metaKey(sym, exp, v)) || 'null'); } catch (e) { return null; }
  }

  // Push open/cover markers to the NQ chart. Each covered position contributes an open AND a cover marker,
  // each keyed by the 5m-mark epoch so it lands on the exact NQ candle. Empty list clears the markers.
  function applyTradesToChart(positions, focus) {
    if (!(window.NQChart && window.NQChart.setTrades)) return;
    const box = el('ps-chart-markers');
    if (box && !box.checked) { window.NQChart.setTrades([]); return; }
    const trades = [];
    for (const p of positions || []) {
      if (p.openEpoch) trades.push({ epoch: p.openEpoch, side: p.side, type: 'open' });
      if (p.covered && p.coverEpoch) trades.push({ epoch: p.coverEpoch, side: p.side, type: 'cover' });
    }
    window.NQChart.setTrades(trades, { focus: !!focus });   // focus pans the chart to the trades (Pull / tab switch)
  }

  // STRATEGY TRADE DETAILS: render a simple per-event table (open ▲/▼, cover ◇ — colored + shaped to match
  // the NQ-chart markers) so the timing / legs / qty / cost of each open and its cover can be validated, tied
  // by a stable position # (chronological by open). Empty positions → clears the panel.
  function renderStrategyTradeDetails(positions) {
    const box = el('strategy-trade-details');
    if (!box) return;
    const evs = [];
    (positions || []).forEach((p) => {
      const q = p.quantity || 1;
      evs.push({ id: p.id, type: 'open', side: p.side, time: p.openTime, epoch: p.openEpoch || 0, legs: p.openLegs || '', cost: Math.round((p.openLimit || 0) * 100 * q), net: p.openNet || 'DEBIT' });
      if (p.coverLegs) evs.push({ id: p.id, type: 'cover', side: p.side, time: p.coverTime, epoch: p.coverEpoch || 0, legs: p.coverLegs, cost: Math.round((p.coverLimit || 0) * 100 * q), net: p.coverNet || 'DEBIT' });
    });
    if (!evs.length) { box.innerHTML = ''; return; }
    // Number positions #1.. by open time (earliest = #1); covers inherit their open's number.
    const seq = new Map();
    evs.filter(e => e.type === 'open').sort((a, b) => a.epoch - b.epoch).forEach((e, i) => seq.set(e.id, i + 1));
    evs.sort((a, b) => a.epoch - b.epoch || (a.type === 'open' ? -1 : 1));
    const color = s => (s === 'bull' ? '#26a69a' : '#ef5350');
    const usd = c => (c < 0 ? '-$' : '$') + Math.abs(c).toLocaleString();
    const glyph = e => e.type === 'open' ? (e.side === 'bull' ? '▲' : '▼') : '◇';
    const coveredIds = new Set(evs.filter(e => e.type === 'cover').map(e => e.id));
    const opens = evs.filter(e => e.type === 'open').length, covers = evs.length - opens;
    const uncovered = evs.filter(e => e.type === 'open' && !coveredIds.has(e.id)).length;
    const rows = evs.map(e => {
      const open = e.type === 'open';
      const isUncov = open && !coveredIds.has(e.id);   // an open with no matching cover = still exposed
      const label = open ? (isUncov ? 'OPEN*' : 'OPEN') : 'COVER';
      const cr = e.net === 'CREDIT';
      const costStr = cr ? `+${usd(e.cost)}` : usd(e.cost);   // credit = cash received → leading +
      return `<tr class="td-${e.type}${isUncov ? ' td-uncovered' : ''}" title="${e.id}">`
        + `<td class="td-time">${e.time || '—'}</td>`
        + `<td>#${seq.get(e.id) || '?'}</td>`
        + `<td class="td-ev" style="color:${color(e.side)}">${glyph(e)} ${label}</td>`
        + `<td class="td-legs">${e.legs}</td>`
        + `<td class="td-cost">${costStr} <span class="net-tag ${cr ? 'net-cr' : 'net-dr'}">${cr ? 'CR' : 'DB'}</span></td></tr>`;
    }).join('');
    box.innerHTML = `<h4>Strategy Trades <span class="ps-muted">${opens} opens · ${covers} covers${uncovered ? ` · ${uncovered} uncovered*` : ''}</span></h4>`
      + `<table class="trade-detail-table"><thead><tr><th>Time</th><th>Pos</th><th class="th-ev">Event</th><th class="th-legs">Legs</th><th>Cost</th></tr></thead>`
      + `<tbody>${rows}</tbody></table>`;
  }

  // --- tabs + affordances ---
  function renderTabs() {
    const bar = el('positions-source-tabs');
    if (!bar) return;
    const active = getPositionsSource();
    bar.querySelectorAll('.ps-tab').forEach((btn) => {
      const on = btn.dataset.source === active;
      btn.classList.toggle('ps-tab-active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    SOURCES.forEach((s) => { const a = el('ps-affordance-' + s); if (a) a.style.display = s === active ? '' : 'none'; });
    if (active === 'strategy') populateStrategyVariants();
    updateAutoRefresh();
  }

  function selectSource(source) {
    if (!SOURCES.includes(source)) return;
    setStoredSource(source);
    renderTabs();
    // Swap the displayed dataset: load this source's cached positions for the current symbol+expiration.
    if (typeof restoreAppropriateInput === 'function') restoreAppropriateInput(currentSymbol(), currentExpiration());
    // Chart markers are strategy-specific: show the cached book's trades on Strategy, clear otherwise.
    if (source === 'strategy') {
      const m = getStrategyMeta(currentSymbol(), strategyExpiration(), currentVariant());
      applyTradesToChart(m ? m.positions : [], true);
      renderStrategyTradeDetails(m ? m.positions : []);
    } else { applyTradesToChart([]); renderStrategyTradeDetails([]); }
  }

  // --- Strategy pull ---
  async function fetchJson(url) { const r = await fetch(url); if (!r.ok) { const e = new Error('http ' + r.status); e.status = r.status; throw e; } return r.json(); }

  async function populateStrategyVariants() {
    const sel = el('ps-variant-select');
    if (!sel || sel.dataset.loaded === '1') return;
    try {
      const data = await fetchJson(`${PROXY_URL}/api/v1/candle-spread/runs?cb=${Date.now()}`);
      const sym = currentSymbol();
      const variants = [...new Set((data.runs || []).filter((r) => !sym || r.symbol === sym).map((r) => r.variant))];
      if (variants.length) {
        const prev = sel.value;
        sel.innerHTML = variants.map((v) => `<option value="${v}">${v}</option>`).join('');
        sel.value = variants.indexOf(prev) >= 0 ? prev : (variants.indexOf('v6') >= 0 ? 'v6' : variants[0]);
        sel.dataset.loaded = '1';
      }
    } catch (e) { /* keep the default option; pull will report a clear error */ }
  }

  function setLastPulled(text, isError) {
    const s = el('ps-last-pulled');
    if (s) { s.textContent = text; s.classList.toggle('ps-error', !!isError); }
  }

  const runUrl = (symbol, exp, date, variant) =>
    `${PROXY_URL}/api/v1/candle-spread/runs/${encodeURIComponent(symbol)}/${encodeURIComponent(exp)}`
    + `?date=${encodeURIComponent(date)}&variant=${encodeURIComponent(variant)}&cb=${Date.now()}`;

  // Resolve the actual date a run is filed under from the runs index — the latest run for this
  // symbol+variant. Used as a fallback when the chain expiration doesn't match a run (post-close roll).
  async function resolveRunDate(symbol, variant) {
    try {
      const data = await fetchJson(`${PROXY_URL}/api/v1/candle-spread/runs?cb=${Date.now()}`);
      const mine = (data.runs || []).filter((r) => r.symbol === symbol && r.variant === variant && r.tradeDate);
      if (!mine.length) return null;
      mine.sort((a, b) => (a.tradeDate < b.tradeDate ? 1 : -1));
      return { expiration: mine[0].expiration || mine[0].tradeDate, date: mine[0].tradeDate };
    } catch (e) { return null; }
  }

  async function pullStrategyPositions(focus) {
    const doFocus = focus !== false;   // explicit Pull (no arg) focuses the chart; auto-refresh passes false
    const symbol = currentSymbol(), variant = currentVariant();
    let expiration = currentExpiration();
    if (!symbol) { setLastPulled('pick a symbol', true); return; }
    setLastPulled('pulling…', false);
    try {
      let run;
      try {
        if (!expiration) throw { status: 404 };
        run = await fetchJson(runUrl(symbol, expiration, expiration, variant));
      } catch (e1) {
        if (e1.status !== 404) throw e1;
        const r = await resolveRunDate(symbol, variant);   // roll-safe fallback: find the run's real date
        if (!r) throw (e1 instanceof Error ? e1 : Object.assign(new Error('http 404'), { status: 404 }));
        expiration = r.expiration;
        run = await fetchJson(runUrl(symbol, r.expiration, r.date, variant));
      }
      resolvedExp[`${symbol}:${variant}`] = expiration;    // remember so restore/markers stay aligned
      const record = run.record || run;
      const result = strategyRunToOptionArray(record);
      if (!result.count) { setLastPulled(`no ${variant} positions yet`, false); return; }
      const textInput = el('textInput');
      if (textInput) { textInput.value = JSON.stringify({ optionArray: result.optionArrayString }, null, 2); if (typeof processInput === 'function') processInput(); }
      saveStrategyMeta(symbol, expiration, variant, result.positions, Date.now());
      applyTradesToChart(result.positions, doFocus);
      renderStrategyTradeDetails(result.positions);
      const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      setLastPulled(`${result.count} pos · ${t}`, false);
    } catch (e) {
      setLastPulled(e.status === 404 ? `no ${variant} run for ${symbol}` : `pull failed (${e.message})`, true);
    }
  }

  // --- auto-refresh (Strategy tab only, market hours) ---
  let autoTimer = null;
  function updateAutoRefresh() {
    const box = el('ps-autorefresh');
    const on = getPositionsSource() === 'strategy' && box && box.checked;
    if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
    if (on) autoTimer = setInterval(() => { if (typeof isMarketHours !== 'function' || isMarketHours()) pullStrategyPositions(false); }, 45000);
  }

  function init() {
    const bar = el('positions-source-tabs');
    if (bar) bar.querySelectorAll('.ps-tab').forEach((btn) => btn.addEventListener('click', () => selectSource(btn.dataset.source)));
    const box = el('ps-autorefresh');
    if (box) box.addEventListener('change', updateAutoRefresh);
    const markers = el('ps-chart-markers');
    if (markers) markers.addEventListener('change', () => {
      if (window.NQChart && window.NQChart.setShowTrades) window.NQChart.setShowTrades(markers.checked);
      const m = markers.checked ? getStrategyMeta(currentSymbol(), strategyExpiration(), currentVariant()) : null;
      applyTradesToChart(m ? m.positions : []);
    });
    const varSel = el('ps-variant-select');
    if (varSel) varSel.addEventListener('change', () => {
      varSel.dataset.loaded = '1';
      // Changing the variant auto-pulls that variant's positions (no manual Pull click needed).
      if (getPositionsSource() === 'strategy') { pullStrategyPositions(); return; }
      if (typeof restoreAppropriateInput === 'function') restoreAppropriateInput(currentSymbol(), currentExpiration());
    });
    renderTabs();
  }

  window.getPositionsSource = getPositionsSource;
  window.positionsCacheKey = positionsCacheKey;
  window.pullStrategyPositions = pullStrategyPositions;
  window.getStrategyPositionsMeta = getStrategyMeta;      // consumed by the future NQ-chart trade overlay
  window.refreshPositionsSourceTabs = renderTabs;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
