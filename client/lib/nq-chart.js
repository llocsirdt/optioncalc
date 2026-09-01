/**
 * Custom NQ candlestick chart (d3) — a replacement-in-progress for the TradingView widget.
 * Single timeframe for now (multi-timeframe BB/9EMA overlay is the next step). Renders OHLC
 * candles + Bollinger(20,2) band + 9EMA off NQ FUTURES data (Schwab /NQ via the server's
 * candle-analysis endpoint — NOT the NDX index the calculator prices against).
 *
 * Interactions: mouse-wheel / pinch zoom + drag to pan (time); drag the x-axis to stretch/
 * compress time; drag the y-axis to stretch/compress price (double-click either axis to reset);
 * hover a bar to read its OHLC + BB/EMA in the toolbar with a crosshair.
 *
 * Timeframes are index-spaced (not time-proportional), so overnight/weekend gaps don't leave
 * blank stretches — standard candlestick behavior.
 */
(function () {
  'use strict';
  if (typeof d3 === 'undefined') { console.warn('[nq-chart] d3 not loaded'); return; }

  const SYMBOL = '/NQ';
  const TIMEFRAMES = ['1m', '5m', '15m', '60m', 'daily'];
  const tfLabel = tf => tf === 'daily' ? '1D' : tf;

  // Per-timeframe coordinating colors so each TF's bands are easy to tell apart:
  //   1m amber/orange/yellow · 5m green/lime · 15m teal/aqua/light-blue · 60m blues · 1D purples.
  // outer = the upper/lower band stroke, mid = the center line, ema = the 9EMA, band = the fill.
  const TF_COLORS = {
    '1m':    { outer: '#ff8f00', mid: '#ffb300', ema: '#ffca28', band: '#ffc107' },
    '5m':    { outer: '#558b2f', mid: '#7cb342', ema: '#9ccc65', band: '#8bc34a' },
    '15m':   { outer: '#00838f', mid: '#00acc1', ema: '#4dd0e1', band: '#26c6da' },
    '60m':   { outer: '#1565c0', mid: '#1e88e5', ema: '#64b5f6', band: '#42a5f5' },
    'daily': { outer: '#6a1b9a', mid: '#8e24aa', ema: '#ba68c8', band: '#ab47bc' }
  };
  const REFRESH_MS = 4000;                 // interim; true real-time needs a streaming relay
  const INIT_BARS = 25;                    // default recent bars to show (until the user zooms)
  const PREFS_KEY = 'nqChartPrefs.v1';     // localStorage: timeframe + enabled lines + zoom width
  const margin = { top: 8, right: 66, bottom: 22, left: 6 };

  let timeframe = '15m';
  let lastSig = null;                       // skip redundant redraws when nothing changed
  let data = [];                           // selected-TF candles: {i,t,o,h,l,c,v,bbU,bbM,bbL,ema9}
  let allData = {};                        // tf -> raw server candles (for the multi-TF overlay)
  let overlayMapped = {};                  // tf -> {bbU,bbM,bbL,ema9} arrays indexed by selected candle
  let lineTfs = new Set(['15m']);          // which timeframes' BB + 9EMA lines are drawn
  let trades = [];                         // strategy trade markers: {epoch, side:'bull'|'bear', type:'open'|'cover'}
  let showTrades = true;                   // toggle for the open/cover markers
  let ndxMode = false;                      // show values skewed to NDX terms (subtract the basis)
  let serverBasis = null;                   // { basis, source, asOf, ndx, nq } from the server
  let transform = d3.zoomIdentity;
  let yZoom = 1;                           // manual vertical scale factor (1 = auto-fit)
  let visibleBars = INIT_BARS;             // how many bars to fit on reset / timeframe change
  let refreshTimer = null;
  // Historical (date-jump) mode: when the user jumps to a date outside the live window, we fetch a
  // deep window around it on demand (histData, not polled), and suspend the live refresh until the
  // user clicks LIVE. Keeps normal operation lean — see enterHistorical/exitHistorical.
  let histMode = false, histDate = null, histData = {};
  let els = null;                          // cached selections
  let hoverIndex = null;
  let hoverY = null;                        // cursor y (px) for the price axis label

  const num = v => (typeof v === 'number' && isFinite(v)) ? v : null;
  const fmtP = d3.format(',.2f');
  // How much to subtract from raw NQ prices for display (0 unless NDX mode is on and a basis exists).
  // Purely additive, so it only changes the numbers shown — candle/band/line geometry is unaffected.
  const priceShift = () => (ndxMode && serverBasis && typeof serverBasis.basis === 'number') ? serverBasis.basis : 0;

  // Remember the user's timeframe, which overlay lines are on, and their zoom width (visible bars)
  // across reloads.
  function loadPrefs() {
    try {
      const p = JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
      if (p.timeframe && TIMEFRAMES.includes(p.timeframe)) timeframe = p.timeframe;
      if (Array.isArray(p.lineTfs)) lineTfs = new Set(p.lineTfs.filter(t => TIMEFRAMES.includes(t)));
      if (p.visibleBars) visibleBars = Math.max(5, Math.min(400, p.visibleBars));
      if (typeof p.ndxMode === 'boolean') ndxMode = p.ndxMode;
    } catch (e) { /* ignore malformed prefs */ }
  }
  function savePrefs() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify({ timeframe, lineTfs: [...lineTfs], visibleBars, ndxMode })); } catch (e) { /* private mode etc. */ }
  }
  // Readable text color on a colored tag (dark text on light fills, white on dark).
  const textOn = hex => {
    const c = hex.replace('#', '');
    const r = parseInt(c.slice(0, 2), 16), g = parseInt(c.slice(2, 4), 16), b = parseInt(c.slice(4, 6), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.62 ? '#1a1a1a' : '#fff';
  };
  const apiBase = () => (typeof PROXY_URL !== 'undefined' ? PROXY_URL : 'http://localhost:3001') + '/api/v1/marketdata';
  const etTime = (ms, withDate) => new Date(ms).toLocaleString('en-US', {
    timeZone: 'America/New_York', hour12: false,
    ...(withDate ? { month: '2-digit', day: '2-digit' } : {}), hour: '2-digit', minute: '2-digit'
  });
  const etDateOnly = ms => new Date(ms).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: '2-digit', day: '2-digit' });
  const etDayISO = ms => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });   // YYYY-MM-DD (matches <input type=date>)

  async function fetchTf(tf) {
    const url = `${apiBase()}/chartseries?symbol=${encodeURIComponent(SYMBOL)}&timeframe=${tf}`;
    const j = await (await fetch(url)).json();
    if (j && j.basis) serverBasis = j.basis;   // NQ↔NDX basis (same for every timeframe)
    return (j && j.candles) || [];             // chronological, flat BB/EMA fields
  }

  // On-demand deep window around a historical date (date-jump). Server returns the full range with
  // warm BB/EMA; 1m beyond ~48d comes back empty (Schwab's minute cap) — handled as no data.
  async function fetchTfRange(tf, from, to) {
    const url = `${apiBase()}/chartseries?symbol=${encodeURIComponent(SYMBOL)}&timeframe=${tf}&from=${from}&to=${to}`;
    const j = await (await fetch(url)).json();
    if (j && j.basis) serverBasis = j.basis;
    return (j && j.candles) || [];
  }

  // Fetch every timeframe (parallel) — needed for the multi-TF overlay; switching timeframes
  // then reads from this cache (no refetch).
  async function fetchAll() {
    const results = await Promise.all(TIMEFRAMES.map(async tf => {
      try { return [tf, await fetchTf(tf)]; } catch (e) { return [tf, allData[tf] || []]; }
    }));
    allData = Object.fromEntries(results);
  }

  // The active series source: the on-demand historical windows in date-jump mode, else the live cache.
  const srcData = () => (histMode ? histData : allData);

  // Derive the selected-TF `data` from the cache and rebuild the overlay mapping.
  function rebuildSelected() {
    data = (srcData()[timeframe] || []).map((c, i) => ({
      i, t: c.datetime, o: +c.open, h: +c.high, l: +c.low, c: +c.close, v: +c.volume || 0,
      bbU: num(c.bbUpper), bbM: num(c.bbMiddle), bbL: num(c.bbLower), ema9: num(c.ema9)
    }));
    buildOverlayMapped();
  }

  // For each timeframe, map its BB/EMA onto the selected TF's time grid: overlayMapped[tf].bbU[i]
  // is that TF's upper-band value at the time of selected candle i (its most recent closed bar).
  function buildOverlayMapped() {
    overlayMapped = {};
    const times = data.map(c => c.t);
    for (const tf of TIMEFRAMES) {
      const cs = srcData()[tf];
      if (!cs || !cs.length) continue;
      const bbU = [], bbM = [], bbL = [], ema9 = [];
      let j = 0;
      for (let i = 0; i < times.length; i++) {
        const T = times[i];
        while (j + 1 < cs.length && cs[j + 1].datetime <= T) j++;
        const c = (cs[j] && cs[j].datetime <= T) ? cs[j] : null;
        bbU.push(c ? num(c.bbUpper) : null); bbM.push(c ? num(c.bbMiddle) : null);
        bbL.push(c ? num(c.bbLower) : null); ema9.push(c ? num(c.ema9) : null);
      }
      overlayMapped[tf] = { bbU, bbM, bbL, ema9 };
    }
  }

  // --- skeleton (built once) ---------------------------------------------
  function buildSkeleton() {
    const host = document.getElementById('nq-chart');
    if (!host) return false;
    const svg = d3.select(host).append('svg').attr('class', 'nq-svg');
    const defs = svg.append('defs');
    defs.append('clipPath').attr('id', 'nq-clip').append('rect');

    const gPlot = svg.append('g').attr('class', 'nq-plot');
    const gClip = gPlot.append('g').attr('clip-path', 'url(#nq-clip)');
    gClip.append('path').attr('class', 'nq-bb-band');
    gClip.append('path').attr('class', 'nq-bb nq-bb-upper');
    gClip.append('path').attr('class', 'nq-bb nq-bb-middle');
    gClip.append('path').attr('class', 'nq-bb nq-bb-lower');
    gClip.append('path').attr('class', 'nq-ema');
    gClip.append('g').attr('class', 'nq-overlay');   // multi-TF BB/EMA lines (behind candles)
    gClip.append('g').attr('class', 'nq-candles');
    gClip.append('g').attr('class', 'nq-trades');    // strategy open/cover markers (on top of candles)

    const gx = gPlot.append('g').attr('class', 'nq-axis nq-x-axis');
    const gy = gPlot.append('g').attr('class', 'nq-axis nq-y-axis');

    // crosshair (lines clipped to the plot area)
    const cross = gClip.append('g').attr('class', 'nq-cross').style('display', 'none');
    cross.append('line').attr('class', 'nq-cross-x');
    cross.append('line').attr('class', 'nq-cross-y');

    // hover annotations that live in the axis margins (unclipped): colored BB/EMA value tags on
    // the right y-axis, plus the crosshair's own price (y) and time (x) axis labels.
    const gTags = gPlot.append('g').attr('class', 'nq-val-tags').style('display', 'none');
    const gAxisLab = gPlot.append('g').attr('class', 'nq-axis-labels').style('display', 'none');
    const MONO = 'ui-monospace, Menlo, monospace';
    const yLab = gAxisLab.append('g').attr('class', 'nq-axis-lab nq-y-lab');
    yLab.append('rect').attr('fill', '#2b2b2b').attr('rx', 2);
    yLab.append('text').attr('fill', '#fff').attr('font-size', 10).attr('font-family', MONO).attr('dominant-baseline', 'middle');
    const xLab = gAxisLab.append('g').attr('class', 'nq-axis-lab nq-x-lab');
    xLab.append('rect').attr('fill', '#2b2b2b').attr('rx', 2);
    xLab.append('text').attr('fill', '#fff').attr('font-size', 10).attr('font-family', MONO).attr('text-anchor', 'middle');

    // Persistent last-price tag on the right axis, aligned to the latest close (candle up/down color).
    const gLast = gPlot.append('g').attr('class', 'nq-last-tag').style('display', 'none');
    gLast.append('rect').attr('rx', 2);
    gLast.append('text').attr('font-size', 9).attr('font-family', MONO).attr('dominant-baseline', 'middle');

    // interaction hit areas
    const zoomHit = gPlot.append('rect').attr('class', 'nq-hit nq-zoom-hit');
    const xHit = gPlot.append('rect').attr('class', 'nq-hit nq-x-hit');
    const yHit = gPlot.append('rect').attr('class', 'nq-hit nq-y-hit');

    els = { host, svg, defs, gPlot, gClip, gx, gy, cross, gTags, gLast, gAxisLab, yLab, xLab, zoomHit, xHit, yHit };
    buildNdxToggle();
    buildDateJump();
    wireInteractions();
    return true;
  }

  // Checkbox in the bottom-right of the chart area: re-label all values into NDX terms.
  function buildNdxToggle() {
    const container = document.getElementById('nq-chart-container') || els.host;
    if (!container || container.querySelector('.nq-ndx-toggle')) return;
    const lbl = document.createElement('label');
    lbl.className = 'nq-ndx-toggle';
    lbl.title = 'Skew NQ values to NDX terms (subtract the NQ↔NDX basis) so levels line up with NDX option strikes';
    lbl.innerHTML = `<input type="checkbox" class="nq-ndx-check"${ndxMode ? ' checked' : ''}> NDX<span class="nq-ndx-basis"></span>`;
    container.appendChild(lbl);
    lbl.querySelector('input').addEventListener('change', e => setNdxMode(e.target.checked));
    els.ndxBasisLabel = lbl.querySelector('.nq-ndx-basis');
  }

  // Date-jump: type/pick a date to center the view on that day's candles at the current timeframe.
  // Panning/zooming writes the centered bar's date back into the field (unless it's focused, so we
  // don't fight the user's typing). Mounted in the toolbar next to the timeframe buttons.
  function buildDateJump() {
    const bar = document.getElementById('nq-chart-toolbar');
    if (!bar || bar.querySelector('.nq-chart-date')) return;
    const lbl = document.createElement('label');
    lbl.className = 'nq-date-jump';
    lbl.title = 'Jump to a date (centers that day at the current timeframe). Deep 1m history is limited (~48d); 15m/1h/1D reach much further back.';
    lbl.innerHTML = `<span class="nq-date-ic">📅</span><input type="date" class="nq-chart-date">` +
      `<button class="nq-live-btn" title="Return to live data" style="display:none">● LIVE</button>`;
    const ohlc = document.getElementById('nq-chart-ohlc');
    if (ohlc) bar.insertBefore(lbl, ohlc); else bar.appendChild(lbl);
    const input = lbl.querySelector('input');
    input.addEventListener('change', () => { if (input.value) jumpToDate(input.value); });
    els.dateInput = input;
    els.liveBtn = lbl.querySelector('.nq-live-btn');
    els.liveBtn.addEventListener('click', exitHistorical);
  }

  // Nearest bar index to an ET calendar day (YYYY-MM-DD): prefer the first bar OF that day, else the
  // bar closest in time (weekend/holiday/out-of-window dates snap to the nearest available candle).
  function indexForDay(ymd) {
    if (!data.length) return -1;
    for (let i = 0; i < data.length; i++) if (etDayISO(data[i].t) === ymd) return i;
    const target = Date.parse(ymd + 'T16:00:00Z');   // ~noon ET
    let best = 0, bd = Infinity;
    for (let i = 0; i < data.length; i++) { const d = Math.abs(data[i].t - target); if (d < bd) { bd = d; best = i; } }
    return best;
  }

  // Days of history to pull each side of the target date, per timeframe — enough bars for BB warmup
  // + panning room, scaled so payloads stay modest (coarser TFs reach further for the same bar count).
  const HIST_SIDE_DAYS = { '1m': 1, '5m': 4, '15m': 10, '60m': 30, 'daily': 150 };
  const dayMs = ymd => Date.parse(ymd + 'T16:00:00Z');    // ~noon ET of the target day

  function jumpToDate(ymd) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return;
    const inWindow = data.length && ymd >= etDayISO(data[0].t) && ymd <= etDayISO(data[data.length - 1].t);
    if (inWindow) { const i = indexForDay(ymd); if (i >= 0) jumpToIndex(i); return; }
    enterHistorical(ymd);   // outside the loaded window → fetch a deep window around that date
  }

  // Fetch (once) the on-screen timeframes' deep windows around histDate into histData.
  async function ensureHist(ymd) {
    const D = dayMs(ymd);
    const need = [...liveTfs()].filter(tf => !histData[tf]);
    const got = await Promise.all(need.map(async tf => {
      const side = (HIST_SIDE_DAYS[tf] || 10) * 864e5;
      try { return [tf, await fetchTfRange(tf, D - side, Math.min(D + side, Date.now()))]; }
      catch (e) { return [tf, []]; }
    }));
    for (const [tf, cs] of got) histData[tf] = cs;
  }

  async function enterHistorical(ymd) {
    if (histDate !== ymd) { histData = {}; histDate = ymd; }
    histMode = true;
    stopRefresh();                 // don't let the live poll overwrite the historical window
    updateHistUI();
    await ensureHist(ymd);
    rebuildSelected();
    lastSig = null;
    const idx = indexForDay(ymd);
    if (data.length && idx >= 0) jumpToIndex(idx); else render();   // empty (e.g. 1m too old) → blank but recoverable
    if (hoverIndex == null && data.length) updateReadout(data[data.length - 1]);
  }

  function exitHistorical() {
    if (!histMode) return;
    histMode = false; histDate = null; histData = {};
    updateHistUI();
    load(true);                    // back to the live window + reset view
    startRefresh();
  }

  // Show/hide the LIVE (return-to-now) button + flag the date field as historical.
  function updateHistUI() {
    if (els && els.liveBtn) els.liveBtn.style.display = histMode ? '' : 'none';
    if (els && els.dateInput) els.dateInput.classList.toggle('nq-date-hist', histMode);
  }

  // Center bar `idx` on screen, keeping the current zoom width (visibleBars). Mirrors resetView's
  // transform math: zx(idx) = k·baseX(idx) + tx, solved so zx(idx) lands at innerW/2.
  function jumpToIndex(idx) {
    if (!els || !data.length) return;
    const { innerW } = dims();
    const n = data.length;
    const bars = Math.min(Math.max(5, visibleBars), n);
    const baseX = d3.scaleLinear().domain([-0.5, n - 0.5]).range([0, innerW]);
    const k = n / bars;
    const tx = innerW / 2 - k * baseX(Math.max(0, Math.min(n - 1, idx)));
    els.zoomHit.call(zoom.transform, d3.zoomIdentity.translate(tx, 0).scale(k));
  }

  // The [left, right] TIMES currently visible — captured before a timeframe change so we can restore the
  // same window (center + span) afterward instead of snapping back to the latest candle.
  function visibleTimeRange() {
    const s = els && els._scales;
    if (!s || !data.length) return null;
    const lo = data[Math.max(0, Math.min(data.length - 1, s.i0))];
    const hi = data[Math.max(0, Math.min(data.length - 1, s.i1))];
    return (lo && hi) ? [lo.t, hi.t] : null;
  }
  // Fit the [tL, tR] time window into the viewport (nearest candles in the current data). Mirrors
  // jumpToIndex's transform math; used to preserve the view across a timeframe change.
  function fitTimeRange(tL, tR) {
    if (!els || !data.length || tL == null || tR == null) return false;
    const near = (t) => { let b = 0, bd = Infinity; for (let i = 0; i < data.length; i++) { const dd = Math.abs(data[i].t - t); if (dd < bd) { bd = dd; b = i; } } return b; };
    const lo = Math.min(near(tL), near(tR)), hi = Math.max(near(tL), near(tR));
    const { innerW } = dims(), n = data.length;
    const bars = Math.min(Math.max(5, (hi - lo) + 1), n);
    const baseX = d3.scaleLinear().domain([-0.5, n - 0.5]).range([0, innerW]);
    const k = n / bars, tx = innerW / 2 - k * baseX((lo + hi) / 2);
    els.zoomHit.call(zoom.transform, d3.zoomIdentity.translate(tx, 0).scale(k));
    return true;
  }

  // Reflect the currently-centered bar's date back into the field (two-way), unless the user is
  // actively editing it. Setting .value programmatically does not fire 'change', so no jump loop.
  function syncDateField() {
    const input = els && els.dateInput, s = els && els._scales;
    if (!input || !s || !data.length || document.activeElement === input) return;
    const mid = data[Math.max(0, Math.min(data.length - 1, Math.round((s.i0 + s.i1) / 2)))];
    if (mid) input.value = etDayISO(mid.t);
  }

  function setNdxMode(on) {
    ndxMode = on;
    savePrefs();
    render();
    if (hoverIndex == null) updateReadout(data[data.length - 1]);
  }

  // Show the applied offset (and whether it's live or a held close) next to the toggle.
  function updateBasisLabel() {
    if (!els || !els.ndxBasisLabel) return;
    els.ndxBasisLabel.textContent = (ndxMode && serverBasis && typeof serverBasis.basis === 'number')
      ? ` −${Math.round(serverBasis.basis)}${serverBasis.source === 'live' ? '' : '*'}` : '';
    els.ndxBasisLabel.title = serverBasis && serverBasis.source !== 'live' ? 'held from last regular-hours close' : 'live basis';
  }

  function dims() {
    const host = els.host;
    const W = host.clientWidth || 360;
    const H = host.clientHeight || 320;
    const innerW = Math.max(10, W - margin.left - margin.right);
    const innerH = Math.max(10, H - margin.top - margin.bottom);
    return { W, H, innerW, innerH };
  }

  // --- render -------------------------------------------------------------
  function render() {
    if (!els || !data.length) return;
    const { W, H, innerW, innerH } = dims();

    els.svg.attr('width', W).attr('height', H);
    els.defs.select('rect').attr('width', innerW).attr('height', innerH);
    els.gPlot.attr('transform', `translate(${margin.left},${margin.top})`);
    els.gx.attr('transform', `translate(0,${innerH})`);
    els.gy.attr('transform', `translate(${innerW},0)`);
    els.zoomHit.attr('width', innerW).attr('height', innerH);
    els.xHit.attr('transform', `translate(0,${innerH})`).attr('width', innerW).attr('height', margin.bottom);
    els.yHit.attr('transform', `translate(${innerW},0)`).attr('width', margin.right).attr('height', innerH);

    const n = data.length;
    const baseX = d3.scaleLinear().domain([-0.5, n - 0.5]).range([0, innerW]);
    const zx = transform.rescaleX(baseX);

    let i0 = Math.max(0, Math.floor(zx.invert(0)));
    let i1 = Math.min(n - 1, Math.ceil(zx.invert(innerW)));
    if (i1 < i0) { els.gPlot.selectAll('.nq-candle').remove(); return; }
    const vis = data.slice(i0, i1 + 1);

    let lo = d3.min(vis, d => Math.min(d.l, d.bbL == null ? d.l : d.bbL));
    let hi = d3.max(vis, d => Math.max(d.h, d.bbU == null ? d.h : d.bbU));
    const padY = (hi - lo) * 0.06 || 1; lo -= padY; hi += padY;
    const cy = (lo + hi) / 2, half = ((hi - lo) / 2) / yZoom;
    const y = d3.scaleLinear().domain([cy - half, cy + half]).range([innerH, 0]);

    const slot = zx(1) - zx(0);
    const bw = Math.max(1, Math.min(slot * 0.7, 22));

    // Bands + lines for every enabled timeframe are drawn by the overlay (per lineTfs);
    // the single legacy band/line paths stay cleared.
    els.gClip.select('.nq-bb-band').attr('d', null);
    els.gClip.selectAll('.nq-bb, .nq-ema').attr('d', null);
    renderOverlay(zx, y, i0, i1);

    // Candles (only visible)
    const sel = els.gClip.select('.nq-candles').selectAll('g.nq-candle').data(vis, d => d.t);
    sel.exit().remove();
    const ent = sel.enter().append('g').attr('class', 'nq-candle');
    ent.append('line').attr('class', 'nq-wick');
    ent.append('rect').attr('class', 'nq-body');
    const all = ent.merge(sel).attr('transform', d => `translate(${zx(d.i)},0)`)
      .classed('nq-up', d => d.c >= d.o).classed('nq-down', d => d.c < d.o);
    all.select('.nq-wick').attr('x1', 0).attr('x2', 0).attr('y1', d => y(d.h)).attr('y2', d => y(d.l));
    all.select('.nq-body')
      .attr('x', -bw / 2).attr('width', bw)
      .attr('y', d => y(Math.max(d.o, d.c)))
      .attr('height', d => Math.max(1, Math.abs(y(d.o) - y(d.c))));

    // Axes
    const tfMin = { '1m': 1, '5m': 5, '15m': 15, '60m': 60, 'daily': 1440 }[timeframe] || 15;
    const spanBars = i1 - i0;
    const isDaily = timeframe === 'daily';
    els.gx.call(d3.axisBottom(zx).ticks(Math.min(8, Math.max(2, Math.floor(innerW / 90))))
      .tickFormat(v => { const idx = Math.round(v); const d = data[idx]; return d ? (isDaily ? etDateOnly(d.t) : etTime(d.t, spanBars * tfMin > 8 * 60)) : ''; }));
    // Geometry stays in raw price; when NDX mode is on, place ticks at nice NDX values (mapped back
    // to raw positions) and label everything as value − basis.
    const shift = priceShift();
    const yAxis = d3.axisRight(y).tickFormat(v => fmtP(v - shift));
    if (shift) {
      const dispTicks = d3.scaleLinear().domain([cy - half - shift, cy + half - shift]).ticks(6);
      yAxis.tickValues(dispTicks.map(t => t + shift));
    } else yAxis.ticks(6);
    els.gy.call(yAxis);

    els._scales = { zx, y, i0, i1, baseX, innerW, innerH, shift };
    drawTrades(zx, y, i0, i1);
    updateBasisLabel();
    drawLastPriceTag();
    syncDateField();
    if (hoverIndex != null) updateCrosshair(); else showRestingTags();
  }

  // Strategy open/cover markers: place each trade on the NQ candle whose epoch matches its 5m mark
  // (openEpoch/coverEpoch from the run). Opens = filled triangles just outside the bar (bull ▲ below,
  // bear ▼ above); covers = hollow diamonds one notch further out. Same-candle/side/type trades are
  // aggregated with a count so a busy 5m bar shows one marker, not 25. Positioned in raw NQ price (no
  // basis shift needed — it's relative to the candle's own high/low).
  function drawTrades(zx, y, i0, i1) {
    const layer = els.gClip.select('.nq-trades');
    if (!showTrades || !trades.length || !data.length) { layer.selectAll('*').remove(); return; }
    const epochs = data.map(d => d.t);
    const TOL = 5 * 60 * 1000;   // a trade must land within one 5m bar of a candle
    const nearest = (e) => {
      let lo = 0, hi = epochs.length - 1;
      if (e <= epochs[0]) return 0;
      if (e >= epochs[hi]) return hi;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (epochs[m] === e) return m; if (epochs[m] < e) lo = m + 1; else hi = m - 1; }
      return (Math.abs(epochs[lo] - e) < Math.abs(epochs[hi] - e)) ? lo : hi;
    };
    const groups = new Map();
    for (const t of trades) {
      if (t.epoch == null) continue;
      const idx = nearest(t.epoch);
      if (Math.abs(epochs[idx] - t.epoch) > TOL) continue;   // outside the loaded range
      if (idx < i0 - 1 || idx > i1 + 1) continue;            // offscreen
      const key = `${idx}|${t.type}|${t.side}`;
      const g = groups.get(key) || { key, idx, type: t.type, side: t.side, n: 0 };
      g.n++; groups.set(key, g);
    }
    const sel = layer.selectAll('g.nq-trade').data([...groups.values()], d => d.key);
    sel.exit().remove();
    const ent = sel.enter().append('g').attr('class', 'nq-trade');
    ent.append('path');
    ent.append('text').attr('class', 'nq-trade-n').attr('font-size', 8).attr('font-family', 'ui-monospace, Menlo, monospace').attr('text-anchor', 'middle');
    const merged = ent.merge(sel).attr('transform', (d) => {
      const c = data[d.idx];
      const out = d.type === 'cover' ? 20 : 9;   // covers sit one notch further from the bar
      const yy = d.side === 'bull' ? y(c.l) + out : y(c.h) - out;
      return `translate(${zx(d.idx)},${yy})`;
    });
    merged.select('path')
      .attr('d', (d) => d.type === 'open'
        ? (d.side === 'bull' ? 'M0,-7 L-5,1 L5,1 Z' : 'M0,7 L-5,-1 L5,-1 Z')   // filled triangle toward the bar
        : 'M0,-4.5 L4.5,0 L0,4.5 L-4.5,0 Z')                                    // cover diamond (hollow)
      .attr('fill', (d) => d.type === 'cover' ? 'none' : (d.side === 'bull' ? '#26a69a' : '#ef5350'))
      .attr('stroke', (d) => d.side === 'bull' ? '#26a69a' : '#ef5350')
      .attr('stroke-width', (d) => d.type === 'cover' ? 1.5 : 0);
    merged.select('text')
      .attr('y', (d) => d.side === 'bull' ? 13 : -8)
      .attr('fill', (d) => d.side === 'bull' ? '#1b8a7e' : '#c62828')
      .text((d) => d.n > 1 ? d.n : '');
  }

  // Pan/zoom the view to fit the trade markers (so they're visible even if the default view is on the
  // most-recent/after-hours bars while the trades are in the RTH session). Mirrors jumpToIndex's math.
  function focusTrades() {
    if (!els || !data.length || !trades.length) return;
    const epochs = data.map(d => d.t), TOL = 5 * 60 * 1000, idxs = [];
    for (const t of trades) {
      if (t.epoch == null) continue;
      let best = -1, bestD = Infinity;
      for (let i = 0; i < epochs.length; i++) { const dd = Math.abs(epochs[i] - t.epoch); if (dd < bestD) { bestD = dd; best = i; } }
      if (best >= 0 && bestD <= TOL) idxs.push(best);
    }
    if (!idxs.length) return;
    const i0 = Math.min(...idxs), i1 = Math.max(...idxs);
    const { innerW } = dims(), n = data.length;
    const bars = Math.min(Math.max(5, (i1 - i0) + 8), n);   // trade span + padding
    const baseX = d3.scaleLinear().domain([-0.5, n - 0.5]).range([0, innerW]);
    const k = n / bars, tx = innerW / 2 - k * baseX((i0 + i1) / 2);
    els.zoomHit.call(zoom.transform, d3.zoomIdentity.translate(tx, 0).scale(k));
  }

  // Public: set the strategy trade markers (from the Strategy positions pull) and redraw. opts.focus
  // pans the view to the trades (used on an explicit Pull / tab switch, not on the 45s auto-refresh).
  function setTrades(list, opts) {
    trades = Array.isArray(list) ? list.filter(t => t && t.epoch != null) : [];
    if (els) { render(); if (opts && opts.focus && trades.length) focusTrades(); }
  }
  function setShowTrades(on) { showTrades = !!on; if (els) render(); }

  // Always-on tag at the latest close on the right axis, colored like the candle (up = green,
  // down = red), styled like the BB/EMA value tags.
  function drawLastPriceTag() {
    const s = els._scales; if (!s || !data.length) { els.gLast.style('display', 'none'); return; }
    const last = data[data.length - 1];
    const color = last.c >= last.o ? '#26a69a' : '#ef5350';
    const ty = Math.max(7, Math.min(s.innerH - 7, s.y(last.c)));
    els.gLast.style('display', null).attr('transform', `translate(${s.innerW},${ty})`);
    els.gLast.select('rect').attr('x', 1).attr('y', -7).attr('width', margin.right - 2).attr('height', 14).attr('fill', color);
    els.gLast.select('text').attr('x', 4).attr('y', 3.5).attr('fill', textOn(color)).text(fmtP(last.c - s.shift));
  }

  // Draw every timeframe's BB (upper/mid/lower) + 9EMA as lines mapped onto the selected axis.
  // Encoding relative to the SELECTED timeframe: current = solid, most opaque, thickest; LONGER
  // timeframes = dashed; SHORTER = dotted; opacity falls off with distance. All are semi-
  // transparent so overlapping lines visually thicken — clustered levels across timeframes read
  // as stronger support/resistance, which is the whole point.
  function renderOverlay(zx, y, i0, i1) {
    const R = TIMEFRAMES.indexOf(timeframe);
    const bandSpecs = [];
    const lineSpecs = [];
    TIMEFRAMES.forEach((tf, r) => {
      if (!lineTfs.has(tf)) return;
      const m = overlayMapped[tf];
      if (!m) return;
      const col = TF_COLORS[tf] || TF_COLORS['15m'];
      const width = r === R ? 1.9 : 1.2;      // selected timeframe drawn a touch heavier
      // Always shade between this TF's bands; low opacity so overlapping bands stack.
      bandSpecs.push({ key: tf, bbU: m.bbU, bbL: m.bbL, fill: col.band });
      // Line style encodes the value: outer bands dotted, center line solid, 9EMA dashed;
      // color encodes the timeframe.
      lineSpecs.push({ key: tf + 'bbU', arr: m.bbU, color: col.outer, dash: '2,2', width });
      lineSpecs.push({ key: tf + 'bbL', arr: m.bbL, color: col.outer, dash: '2,2', width });
      lineSpecs.push({ key: tf + 'bbM', arr: m.bbM, color: col.mid, dash: null, width });
      lineSpecs.push({ key: tf + 'ema9', arr: m.ema9, color: col.ema, dash: '6,4', width });
    });
    const lo = Math.max(0, i0 - 1), hi = Math.min(data.length - 1, i1 + 1);
    // When the latest candle is on screen, extend one slot past it (index = data.length) at the
    // last value, so the lines/bands are visible in the reserved space instead of hiding behind
    // the candle body.
    const lastVisible = hi === data.length - 1;
    const mkLine = arr => {
      const pts = [];
      for (let i = lo; i <= hi; i++) pts.push([i, arr[i]]);
      if (lastVisible && arr[hi] != null) pts.push([data.length, arr[hi]]);
      return d3.line().defined(p => p[1] != null).x(p => zx(p[0])).y(p => y(p[1]))(pts);
    };
    const mkBand = (u, l) => {
      const pts = [];
      for (let i = lo; i <= hi; i++) pts.push([i, u[i], l[i]]);
      if (lastVisible && u[hi] != null && l[hi] != null) pts.push([data.length, u[hi], l[hi]]);
      return d3.area().defined(p => p[1] != null && p[2] != null)
        .x(p => zx(p[0])).y1(p => y(p[1])).y0(p => y(p[2]))(pts);
    };
    const ov = els.gClip.select('.nq-overlay');

    // Filled bands first (behind the lines).
    const bsel = ov.selectAll('path.nq-ol-band').data(bandSpecs, s => s.key);
    bsel.exit().remove();
    bsel.enter().insert('path', ':first-child').attr('class', 'nq-ol-band')
      .attr('stroke', 'none').attr('opacity', 0.2)
      .merge(bsel).attr('fill', s => s.fill).attr('d', s => mkBand(s.bbU, s.bbL));

    const sel = ov.selectAll('path.nq-ol').data(lineSpecs, s => s.key);
    sel.exit().remove();
    sel.enter().append('path').attr('class', 'nq-ol').attr('fill', 'none').attr('opacity', 0.9).merge(sel)
      .attr('d', s => mkLine(s.arr))
      .attr('stroke', s => s.color)
      .attr('stroke-width', s => s.width)
      .attr('stroke-dasharray', s => s.dash);
  }

  // --- interactions -------------------------------------------------------
  const zoom = d3.zoom().scaleExtent([0.4, 60])
    .on('zoom', ev => { transform = ev.transform; render(); })
    .on('end', ev => { if (ev.sourceEvent) saveVisibleBars(); });   // remember zoom width (user gestures only)

  function wireInteractions() {
    els.zoomHit.call(zoom).on('dblclick.zoom', null).on('dblclick', resetView);

    // x-axis drag: stretch/compress time (scale around the right edge = latest bar).
    els.xHit.style('cursor', 'ew-resize').call(d3.drag()
      .on('drag', ev => {
        const s = els._scales; if (!s) return;
        const factor = Math.exp(-ev.dx * 0.005);
        els.zoomHit.call(zoom.scaleBy, factor, [s.innerW, s.innerH / 2]);
      })
      .on('end', saveVisibleBars)).on('dblclick', resetView);

    // y-axis drag: stretch/compress price (manual vertical zoom); dbl-click restores auto-fit.
    els.yHit.style('cursor', 'ns-resize').call(d3.drag().on('drag', ev => {
      // TradingView-style: drag DOWN condenses (more range), drag UP expands (less range).
      yZoom = Math.max(0.2, Math.min(8, yZoom * Math.exp(-ev.dy * 0.005)));
      render();
    })).on('dblclick', () => { yZoom = 1; render(); });

    // hover crosshair + OHLC readout
    els.zoomHit
      .on('mousemove touchmove', ev => {
        const s = els._scales; if (!s) return;
        const [mx, my] = d3.pointer(ev, els.gPlot.node());
        hoverIndex = Math.max(s.i0, Math.min(s.i1, Math.round(s.zx.invert(mx))));
        hoverY = my;
        updateCrosshair();
        updateReadout(data[hoverIndex]);
      })
      .on('mouseleave', () => { hoverIndex = null; hoverY = null; showRestingTags(); updateReadout(data[data.length - 1]); });
  }

  function hideCross() {
    els.cross.style('display', 'none');
    els.gAxisLab.style('display', 'none');
    els.gTags.style('display', 'none');
  }

  // Crosshair lines + a price label (right y-axis) and time label (bottom x-axis) at the cursor,
  // plus color-coded BB/9EMA value tags on the right axis for every enabled timeframe at the
  // hovered bar (colors match each timeframe's lines).
  function updateCrosshair() {
    const s = els._scales; if (!s || hoverIndex == null) { hideCross(); return; }
    const x = s.zx(hoverIndex);
    els.cross.style('display', null);
    els.cross.select('.nq-cross-x').attr('x1', x).attr('x2', x).attr('y1', 0).attr('y2', s.innerH);
    if (hoverY != null) els.cross.select('.nq-cross-y').attr('x1', 0).attr('x2', s.innerW).attr('y1', hoverY).attr('y2', hoverY);

    // Crosshair axis labels (price at cursor height, time at cursor column).
    els.gAxisLab.style('display', null);
    if (hoverY != null) {
      els.yLab.style('display', null).attr('transform', `translate(${s.innerW},${hoverY})`);
      els.yLab.select('rect').attr('x', 1).attr('y', -8).attr('width', margin.right - 2).attr('height', 16);
      els.yLab.select('text').attr('x', 4).attr('y', 4).text(fmtP(s.y.invert(hoverY) - s.shift));
    } else els.yLab.style('display', 'none');
    const d = data[hoverIndex];
    const label = d ? (timeframe === 'daily' ? etDateOnly(d.t) : etTime(d.t, true) + ' ET') : '';
    const tw = Math.max(46, label.length * 6.4 + 10);
    const lx = Math.max(tw / 2, Math.min(s.innerW - tw / 2, x));
    els.xLab.style('display', null).attr('transform', `translate(${lx},${s.innerH})`);
    els.xLab.select('rect').attr('x', -tw / 2).attr('y', 2).attr('width', tw).attr('height', 16);
    els.xLab.select('text').attr('x', 0).attr('y', 14).attr('text-anchor', 'middle').text(label);

    drawValueTags(hoverIndex);
  }

  // Colored value tags (BB upper/mid/lower + 9EMA, per enabled timeframe) on the right y-axis for
  // one bar. Used at the hovered bar while the crosshair is active, and at the most recent bar as
  // the resting default when the cursor is off the chart.
  function drawValueTags(index) {
    const s = els._scales; if (!s || index == null) return;
    const tags = [];
    TIMEFRAMES.forEach(tf => {
      if (!lineTfs.has(tf)) return;
      const m = overlayMapped[tf]; if (!m) return;
      const col = TF_COLORS[tf] || TF_COLORS['15m'];
      [['bbU', col.outer], ['bbM', col.mid], ['bbL', col.outer], ['ema9', col.ema]].forEach(([field, color]) => {
        const v = m[field] ? m[field][index] : null;
        if (v == null) return;
        tags.push({ key: tf + field, y: Math.max(7, Math.min(s.innerH - 7, s.y(v))), color, text: fmtP(v - s.shift) });
      });
    });
    els.gTags.style('display', null);
    const g = els.gTags.selectAll('g.nq-val-tag').data(tags, t => t.key);
    g.exit().remove();
    const gEnter = g.enter().append('g').attr('class', 'nq-val-tag');
    gEnter.append('rect');
    gEnter.append('text').attr('font-size', 9).attr('font-family', 'ui-monospace, Menlo, monospace').attr('dominant-baseline', 'middle');
    const gAll = gEnter.merge(g).attr('transform', t => `translate(${s.innerW},${t.y})`);
    gAll.select('rect').attr('x', 1).attr('y', -7).attr('width', margin.right - 2).attr('height', 14).attr('rx', 2).attr('fill', t => t.color);
    gAll.select('text').attr('x', 4).attr('y', 3.5).attr('fill', t => textOn(t.color)).text(t => t.text);
  }

  // Resting state (no cursor): hide the crosshair lines + cursor axis labels, but keep the value
  // tags showing the most recent bar's levels.
  function showRestingTags() {
    if (!els._scales || !data.length) { hideCross(); return; }
    els.cross.style('display', 'none');
    els.gAxisLab.style('display', 'none');
    drawValueTags(data.length - 1);
  }

  function updateReadout(d) {
    const box = document.getElementById('nq-chart-ohlc');
    if (!box || !d) return;
    const sh = priceShift();
    const p = v => fmtP(v - sh);                 // show prices in NDX terms when the toggle is on
    const up = (d.c - d.o) >= 0;
    box.innerHTML =
      `<span class="nq-ro-time">${timeframe === 'daily' ? etDateOnly(d.t) : etTime(d.t, true) + ' ET'}</span>` +
      `<span class="nq-ro ${up ? 'nq-up-t' : 'nq-down-t'}">O ${p(d.o)} H ${p(d.h)} L ${p(d.l)} C ${p(d.c)}</span>` +
      (d.bbU != null ? `<span class="nq-ro nq-ro-bb">BB ${p(d.bbU)}/${p(d.bbM)}/${p(d.bbL)}</span>` : '') +
      (d.ema9 != null ? `<span class="nq-ro nq-ro-ema">9EMA ${p(d.ema9)}</span>` : '');
  }

  function resetView() {
    yZoom = 1;
    const { innerW } = dims();
    const n = data.length;
    if (!n) return;
    const baseX = d3.scaleLinear().domain([-0.5, n - 0.5]).range([0, innerW]);
    const bars = Math.min(visibleBars, n);
    const k = n / bars;
    // Reserve ~1 empty bar-slot to the right of the latest candle so it isn't jammed against the
    // axis (and so the overlay lines can extend into that space — see mkLine/mkBand).
    const slot = innerW / bars;
    const tx = innerW - slot - k * baseX(n - 1);
    els.zoomHit.call(zoom.transform, d3.zoomIdentity.translate(tx, 0).scale(k));
  }

  // Capture the current on-screen bar count so reloads / timeframe changes reopen at this zoom.
  function saveVisibleBars() {
    const s = els._scales; if (!s) return;
    visibleBars = Math.max(5, Math.min(data.length || 400, s.i1 - s.i0 + 1));
    savePrefs();
  }

  // --- public API + lifecycle --------------------------------------------
  // Each timeframe = a button (selects candles) + a checkbox (shows that TF's lines). Plus an
  // "all" checkbox to toggle every timeframe's lines at once.
  function buildToolbar() {
    const bar = document.getElementById('nq-chart-tf-buttons');
    if (!bar) return;
    const allOn = lineTfs.size === TIMEFRAMES.length;
    bar.innerHTML = TIMEFRAMES.map(tf => {
      const c = (TF_COLORS[tf] || {}).mid || '#888';   // color-code each control to its line family
      return `<span class="nq-tf-group">` +
        `<button class="nq-tf-btn ${tf === timeframe ? 'active' : ''}" data-tf="${tf}" style="border-bottom:3px solid ${c}">${tfLabel(tf)}</button>` +
        `<input type="checkbox" class="nq-tf-line" data-tf="${tf}" style="accent-color:${c}" title="show ${tfLabel(tf)} Bollinger + 9EMA lines"${lineTfs.has(tf) ? ' checked' : ''}>` +
      `</span>`;
    }).join('') +
      `<label class="nq-multi-toggle" title="toggle every timeframe's lines"><input type="checkbox" class="nq-all-lines"${allOn ? ' checked' : ''}> all</label>`;
    bar.querySelectorAll('.nq-tf-btn').forEach(b => b.addEventListener('click', () => setTimeframe(b.getAttribute('data-tf'))));
    bar.querySelectorAll('.nq-tf-line').forEach(c => c.addEventListener('change', () => toggleLine(c.getAttribute('data-tf'), c.checked)));
    const allc = bar.querySelector('.nq-all-lines');
    if (allc) allc.addEventListener('change', () => toggleAllLines(allc.checked));
  }

  function toggleLine(tf, on) {
    if (on) lineTfs.add(tf); else lineTfs.delete(tf);
    const allc = document.querySelector('#nq-chart-tf-buttons .nq-all-lines');
    if (allc) allc.checked = lineTfs.size === TIMEFRAMES.length;
    savePrefs();
    if (histMode && on) { ensureHist(histDate).then(() => { buildOverlayMapped(); render(); }); return; }  // fetch the newly-shown TF's window
    render();
  }
  function toggleAllLines(on) {
    lineTfs = on ? new Set(TIMEFRAMES) : new Set();
    savePrefs();
    buildToolbar();
    if (histMode && on) { ensureHist(histDate).then(() => { buildOverlayMapped(); render(); }); return; }
    render();
  }

  // The timeframes whose data is actually on screen right now = the selected candles plus every
  // enabled overlay line. Only these need re-fetching on the fast refresh tick.
  const liveTfs = () => new Set([timeframe, ...lineTfs]);

  // Signature over the last bar of every on-screen timeframe, so a refresh only redraws when
  // something visible actually changed (keeps zoom/hover steady otherwise).
  function seriesSig() {
    let sig = timeframe + '#' + data.length;
    for (const tf of liveTfs()) {
      const cs = allData[tf], l = cs && cs[cs.length - 1];
      sig += '|' + tf + ':' + (l ? l.datetime + ',' + l.close + ',' + l.high + ',' + l.low : '');
    }
    return sig;
  }

  async function load(resetTheView) {
    try {
      await fetchAll();
      rebuildSelected();
      if (resetTheView) resetView();
      else if (seriesSig() !== lastSig) render();
      lastSig = seriesSig();
      if (hoverIndex == null) updateReadout(data[data.length - 1]);
    } catch (e) { console.error('[nq-chart] load failed:', e && e.message); }
  }

  // Fast poll: refetch only the on-screen timeframes (not all 5 every tick) and redraw if changed.
  async function refreshTick() {
    if (histMode) return;               // frozen on a historical window until the user clicks LIVE
    try {
      const tfs = [...liveTfs()];
      const results = await Promise.all(tfs.map(async tf => {
        try { return [tf, await fetchTf(tf)]; } catch (e) { return [tf, allData[tf] || []]; }
      }));
      for (const [tf, cs] of results) allData[tf] = cs;
      rebuildSelected();
      if (seriesSig() !== lastSig) render();
      lastSig = seriesSig();
      if (hoverIndex == null) updateReadout(data[data.length - 1]);
    } catch (e) { console.error('[nq-chart] refresh failed:', e && e.message); }
  }

  // Switching timeframe reads from the already-fetched cache (no refetch) — instant.
  function setTimeframe(tf) {
    if (!TIMEFRAMES.includes(tf) || tf === timeframe) return;
    const keep = visibleTimeRange();   // remember the current window so the TF change doesn't snap to latest
    timeframe = tf;
    lineTfs.add(tf);            // selecting a timeframe also turns on its band/EMA lines
    savePrefs();
    buildToolbar();
    if (histMode) { enterHistorical(histDate); return; }   // pull this TF's historical window, re-center on the date
    if (allData[tf] && allData[tf].length) {
      rebuildSelected(); lastSig = null;
      if (!(keep && fitTimeRange(keep[0], keep[1]))) resetView();   // preserve the viewed time window, else default
      if (hoverIndex == null) updateReadout(data[data.length - 1]);
    } else {
      load(true);
    }
  }

  // The chart is a self-contained futures view — it polls on its own, independent of the app's
  // "Start Live Data" toggle (NQ trades nearly 24h and the data source is always fresh).
  function startRefresh() {
    stopRefresh();
    refreshTimer = setInterval(refreshTick, REFRESH_MS);
  }
  function stopRefresh() { if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; } }

  function init() {
    if (!document.getElementById('nq-chart')) return;
    loadPrefs();                 // restore timeframe / enabled lines / zoom width before first paint
    if (!buildSkeleton()) return;
    buildToolbar();
    load(true);
    startRefresh();
    window.addEventListener('resize', () => render());
  }

  window.NQChart = { init, setTimeframe, refresh: () => load(false), setTrades, setShowTrades };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
