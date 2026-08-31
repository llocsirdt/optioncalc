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

  async function pullStrategyPositions() {
    const symbol = currentSymbol(), expiration = currentExpiration(), variant = currentVariant();
    if (!symbol || !expiration) { setLastPulled('pick a symbol + expiration', true); return; }
    setLastPulled('pulling…', false);
    try {
      const url = `${PROXY_URL}/api/v1/candle-spread/runs/${encodeURIComponent(symbol)}/${encodeURIComponent(expiration)}`
        + `?date=${encodeURIComponent(expiration)}&variant=${encodeURIComponent(variant)}&cb=${Date.now()}`;
      const run = await fetchJson(url);
      const record = run.record || run;
      const result = strategyRunToOptionArray(record);
      if (!result.count) { setLastPulled(`no ${variant} positions yet`, false); return; }
      const textInput = el('textInput');
      if (textInput) { textInput.value = JSON.stringify({ optionArray: result.optionArrayString }, null, 2); if (typeof processInput === 'function') processInput(); }
      saveStrategyMeta(symbol, expiration, variant, result.positions, Date.now());
      const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      setLastPulled(`${result.count} pos · ${t}`, false);
    } catch (e) {
      setLastPulled(e.status === 404 ? `no ${variant} run for ${symbol} ${expiration}` : `pull failed (${e.message})`, true);
    }
  }

  // --- auto-refresh (Strategy tab only, market hours) ---
  let autoTimer = null;
  function updateAutoRefresh() {
    const box = el('ps-autorefresh');
    const on = getPositionsSource() === 'strategy' && box && box.checked;
    if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
    if (on) autoTimer = setInterval(() => { if (typeof isMarketHours !== 'function' || isMarketHours()) pullStrategyPositions(); }, 45000);
  }

  function init() {
    const bar = el('positions-source-tabs');
    if (bar) bar.querySelectorAll('.ps-tab').forEach((btn) => btn.addEventListener('click', () => selectSource(btn.dataset.source)));
    const box = el('ps-autorefresh');
    if (box) box.addEventListener('change', updateAutoRefresh);
    const varSel = el('ps-variant-select');
    if (varSel) varSel.addEventListener('change', () => { varSel.dataset.loaded = '1'; if (typeof restoreAppropriateInput === 'function') restoreAppropriateInput(currentSymbol(), currentExpiration()); });
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
