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
  const REFRESH_MS = 4000;                 // interim; true real-time needs a streaming relay
  const INIT_BARS = 90;                    // how many recent bars to show initially
  const margin = { top: 8, right: 66, bottom: 22, left: 6 };

  let timeframe = '15m';
  let lastSig = null;                       // skip redundant redraws when nothing changed
  let data = [];                           // selected-TF candles: {i,t,o,h,l,c,v,bbU,bbM,bbL,ema9}
  let allData = {};                        // tf -> raw server candles (for the multi-TF overlay)
  let overlayMapped = {};                  // tf -> {bbU,bbM,bbL,ema9} arrays indexed by selected candle
  let lineTfs = new Set(['15m']);          // which timeframes' BB + 9EMA lines are drawn
  let transform = d3.zoomIdentity;
  let yZoom = 1;                           // manual vertical scale factor (1 = auto-fit)
  let refreshTimer = null;
  let els = null;                          // cached selections
  let hoverIndex = null;

  const num = v => (typeof v === 'number' && isFinite(v)) ? v : null;
  const fmtP = d3.format(',.2f');
  const apiBase = () => (typeof PROXY_URL !== 'undefined' ? PROXY_URL : 'http://localhost:3001') + '/api/v1/marketdata';
  const etTime = (ms, withDate) => new Date(ms).toLocaleString('en-US', {
    timeZone: 'America/New_York', hour12: false,
    ...(withDate ? { month: '2-digit', day: '2-digit' } : {}), hour: '2-digit', minute: '2-digit'
  });
  const etDateOnly = ms => new Date(ms).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: '2-digit', day: '2-digit' });

  async function fetchTf(tf) {
    const url = `${apiBase()}/chartseries?symbol=${encodeURIComponent(SYMBOL)}&timeframe=${tf}`;
    const j = await (await fetch(url)).json();
    return (j && j.candles) || [];   // chronological, flat BB/EMA fields
  }

  // Fetch every timeframe (parallel) — needed for the multi-TF overlay; switching timeframes
  // then reads from this cache (no refetch).
  async function fetchAll() {
    const results = await Promise.all(TIMEFRAMES.map(async tf => {
      try { return [tf, await fetchTf(tf)]; } catch (e) { return [tf, allData[tf] || []]; }
    }));
    allData = Object.fromEntries(results);
  }

  // Derive the selected-TF `data` from the cache and rebuild the overlay mapping.
  function rebuildSelected() {
    data = (allData[timeframe] || []).map((c, i) => ({
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
      const cs = allData[tf];
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

    const gx = gPlot.append('g').attr('class', 'nq-axis nq-x-axis');
    const gy = gPlot.append('g').attr('class', 'nq-axis nq-y-axis');

    // crosshair
    const cross = gClip.append('g').attr('class', 'nq-cross').style('display', 'none');
    cross.append('line').attr('class', 'nq-cross-x');
    cross.append('line').attr('class', 'nq-cross-y');

    // interaction hit areas
    const zoomHit = gPlot.append('rect').attr('class', 'nq-hit nq-zoom-hit');
    const xHit = gPlot.append('rect').attr('class', 'nq-hit nq-x-hit');
    const yHit = gPlot.append('rect').attr('class', 'nq-hit nq-y-hit');

    els = { host, svg, defs, gPlot, gClip, gx, gy, cross, zoomHit, xHit, yHit };
    wireInteractions();
    return true;
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
    els.gy.call(d3.axisRight(y).ticks(6).tickFormat(fmtP));

    els._scales = { zx, y, i0, i1, baseX, innerW, innerH };
    if (hoverIndex != null) drawCross();
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
      const dist = r - R;
      const dash = dist === 0 ? null : dist > 0 ? '6,3' : '2,3';
      const opacity = dist === 0 ? 0.9 : Math.max(0.22, 0.62 - 0.13 * Math.abs(dist));
      const width = dist === 0 ? 1.7 : 1.1;
      // Always shade between this TF's bands; low opacity so overlapping bands stack/darken.
      bandSpecs.push({ key: tf, bbU: m.bbU, bbL: m.bbL });
      [['bbU', false], ['bbM', false], ['bbL', false], ['ema9', true]].forEach(([field, isEma]) => {
        lineSpecs.push({ key: tf + field, arr: m[field], isEma, dash, opacity, width });
      });
    });
    const lo = Math.max(0, i0 - 1), hi = Math.min(data.length - 1, i1 + 1);
    const mkLine = arr => {
      const pts = [];
      for (let i = lo; i <= hi; i++) pts.push([i, arr[i]]);
      return d3.line().defined(p => p[1] != null).x(p => zx(p[0])).y(p => y(p[1]))(pts);
    };
    const mkBand = (u, l) => {
      const pts = [];
      for (let i = lo; i <= hi; i++) pts.push([i, u[i], l[i]]);
      return d3.area().defined(p => p[1] != null && p[2] != null)
        .x(p => zx(p[0])).y1(p => y(p[1])).y0(p => y(p[2]))(pts);
    };
    const ov = els.gClip.select('.nq-overlay');

    // Filled bands first (behind the lines).
    const bsel = ov.selectAll('path.nq-ol-band').data(bandSpecs, s => s.key);
    bsel.exit().remove();
    bsel.enter().insert('path', ':first-child').attr('class', 'nq-ol-band')
      .attr('stroke', 'none').attr('fill', '#5c6bc0').attr('opacity', 0.2)
      .merge(bsel).attr('d', s => mkBand(s.bbU, s.bbL));

    const sel = ov.selectAll('path.nq-ol').data(lineSpecs, s => s.key);
    sel.exit().remove();
    sel.enter().append('path').attr('class', 'nq-ol').attr('fill', 'none').merge(sel)
      .attr('d', s => mkLine(s.arr))
      .attr('stroke', s => s.isEma ? '#ff9800' : '#5c6bc0')
      .attr('stroke-width', s => s.width)
      .attr('stroke-dasharray', s => s.dash)
      .attr('opacity', s => s.opacity);
  }

  // --- interactions -------------------------------------------------------
  const zoom = d3.zoom().scaleExtent([0.4, 60]).on('zoom', ev => { transform = ev.transform; render(); });

  function wireInteractions() {
    els.zoomHit.call(zoom).on('dblclick.zoom', null).on('dblclick', resetView);

    // x-axis drag: stretch/compress time (scale around the right edge = latest bar).
    els.xHit.style('cursor', 'ew-resize').call(d3.drag().on('drag', ev => {
      const s = els._scales; if (!s) return;
      const factor = Math.exp(-ev.dx * 0.005);
      els.zoomHit.call(zoom.scaleBy, factor, [s.innerW, s.innerH / 2]);
    })).on('dblclick', resetView);

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
        const [mx] = d3.pointer(ev, els.gPlot.node());
        hoverIndex = Math.max(s.i0, Math.min(s.i1, Math.round(s.zx.invert(mx))));
        drawCross(d3.pointer(ev, els.gPlot.node())[1]);
        updateReadout(data[hoverIndex]);
      })
      .on('mouseleave', () => { hoverIndex = null; els.cross.style('display', 'none'); updateReadout(data[data.length - 1]); });
  }

  function drawCross(my) {
    const s = els._scales; if (!s || hoverIndex == null) return;
    const x = s.zx(hoverIndex);
    els.cross.style('display', null);
    els.cross.select('.nq-cross-x').attr('x1', x).attr('x2', x).attr('y1', 0).attr('y2', s.innerH);
    if (my != null) els.cross.select('.nq-cross-y').attr('x1', 0).attr('x2', s.innerW).attr('y1', my).attr('y2', my);
  }

  function updateReadout(d) {
    const box = document.getElementById('nq-chart-ohlc');
    if (!box || !d) return;
    const chg = d.c - d.o, up = chg >= 0;
    box.innerHTML =
      `<span class="nq-ro-time">${timeframe === 'daily' ? etDateOnly(d.t) : etTime(d.t, true) + ' ET'}</span>` +
      `<span class="nq-ro ${up ? 'nq-up-t' : 'nq-down-t'}">O ${fmtP(d.o)} H ${fmtP(d.h)} L ${fmtP(d.l)} C ${fmtP(d.c)}</span>` +
      (d.bbU != null ? `<span class="nq-ro nq-ro-bb">BB ${fmtP(d.bbU)}/${fmtP(d.bbM)}/${fmtP(d.bbL)}</span>` : '') +
      (d.ema9 != null ? `<span class="nq-ro nq-ro-ema">9EMA ${fmtP(d.ema9)}</span>` : '');
  }

  function resetView() {
    yZoom = 1;
    const { innerW } = dims();
    const n = data.length;
    if (!n) return;
    const baseX = d3.scaleLinear().domain([-0.5, n - 0.5]).range([0, innerW]);
    const bars = Math.min(INIT_BARS, n);
    const k = n / bars;
    const tx = innerW - 4 - k * baseX(n - 1);
    els.zoomHit.call(zoom.transform, d3.zoomIdentity.translate(tx, 0).scale(k));
  }

  // --- public API + lifecycle --------------------------------------------
  // Each timeframe = a button (selects candles) + a checkbox (shows that TF's lines). Plus an
  // "all" checkbox to toggle every timeframe's lines at once.
  function buildToolbar() {
    const bar = document.getElementById('nq-chart-tf-buttons');
    if (!bar) return;
    const allOn = lineTfs.size === TIMEFRAMES.length;
    bar.innerHTML = TIMEFRAMES.map(tf =>
      `<span class="nq-tf-group">` +
        `<button class="nq-tf-btn ${tf === timeframe ? 'active' : ''}" data-tf="${tf}">${tf}</button>` +
        `<input type="checkbox" class="nq-tf-line" data-tf="${tf}" title="show ${tf} Bollinger + 9EMA lines"${lineTfs.has(tf) ? ' checked' : ''}>` +
      `</span>`).join('') +
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
    render();
  }
  function toggleAllLines(on) {
    lineTfs = on ? new Set(TIMEFRAMES) : new Set();
    buildToolbar();
    render();
  }

  async function load(resetTheView) {
    try {
      await fetchAll();
      rebuildSelected();
      const last = data[data.length - 1];
      const sig = data.length + ':' + timeframe + ':' + (last ? last.t + ':' + last.c + ':' + last.h + ':' + last.l : '');
      if (resetTheView) { resetView(); }
      else if (sig !== lastSig) { render(); }   // only redraw on a real change (keeps zoom/hover steady)
      lastSig = sig;
      if (hoverIndex == null) updateReadout(last);
    } catch (e) { console.error('[nq-chart] load failed:', e && e.message); }
  }

  // Switching timeframe reads from the already-fetched cache (no refetch) — instant.
  function setTimeframe(tf) {
    if (!TIMEFRAMES.includes(tf) || tf === timeframe) return;
    timeframe = tf;
    lineTfs.add(tf);            // selecting a timeframe also turns on its band/EMA lines
    buildToolbar();
    if (allData[tf] && allData[tf].length) {
      rebuildSelected(); lastSig = null; resetView();
      if (hoverIndex == null) updateReadout(data[data.length - 1]);
    } else {
      load(true);
    }
  }

  function startRefresh() {
    stopRefresh();
    refreshTimer = setInterval(() => {
      if (typeof liveDataEnabled === 'undefined' || liveDataEnabled) load(false);
    }, REFRESH_MS);
  }
  function stopRefresh() { if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; } }

  function init() {
    if (!document.getElementById('nq-chart')) return;
    if (!buildSkeleton()) return;
    buildToolbar();
    load(true);
    startRefresh();
    window.addEventListener('resize', () => render());
  }

  window.NQChart = { init, setTimeframe, refresh: () => load(false) };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
