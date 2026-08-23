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
  const TIMEFRAMES = ['1m', '5m', '15m', '60m'];
  const REFRESH_MS = 15000;
  const INIT_BARS = 90;                    // how many recent bars to show initially
  const margin = { top: 8, right: 66, bottom: 22, left: 6 };

  let timeframe = '15m';
  let data = [];                           // chronological candles: {i,t,o,h,l,c,v,bbU,bbM,bbL,ema9}
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

  async function fetchCandles() {
    const url = `${apiBase()}/candleanalysis?symbol=${encodeURIComponent(SYMBOL)}&timeframe=${timeframe}`;
    const res = await fetch(url);
    const j = await res.json();
    const tf = j && j.candleData && j.candleData[timeframe];
    const cs = (tf && tf.candles) || [];
    data = cs.slice().reverse().map((c, i) => ({
      i, t: c.datetime, o: +c.open, h: +c.high, l: +c.low, c: +c.close, v: +c.volume || 0,
      bbU: num(c.indicators && c.indicators.bollinger20_2 && c.indicators.bollinger20_2.upper),
      bbM: num(c.indicators && c.indicators.bollinger20_2 && c.indicators.bollinger20_2.middle),
      bbL: num(c.indicators && c.indicators.bollinger20_2 && c.indicators.bollinger20_2.lower),
      ema9: num(c.indicators && c.indicators.ema9)
    }));
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

    // BB band + lines + EMA
    const dfn = key => d3.line().defined(d => d[key] != null).x(d => zx(d.i)).y(d => y(d[key]));
    const band = d3.area().defined(d => d.bbU != null && d.bbL != null).x(d => zx(d.i)).y0(d => y(d.bbL)).y1(d => y(d.bbU));
    els.gClip.select('.nq-bb-band').datum(vis).attr('d', band);
    els.gClip.select('.nq-bb-upper').datum(vis).attr('d', dfn('bbU'));
    els.gClip.select('.nq-bb-middle').datum(vis).attr('d', dfn('bbM'));
    els.gClip.select('.nq-bb-lower').datum(vis).attr('d', dfn('bbL'));
    els.gClip.select('.nq-ema').datum(vis).attr('d', dfn('ema9'));

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
    const tfMin = { '1m': 1, '5m': 5, '15m': 15, '60m': 60 }[timeframe] || 15;
    const spanBars = i1 - i0;
    els.gx.call(d3.axisBottom(zx).ticks(Math.min(8, Math.max(2, Math.floor(innerW / 90))))
      .tickFormat(v => { const idx = Math.round(v); const d = data[idx]; return d ? etTime(d.t, spanBars * tfMin > 8 * 60) : ''; }));
    els.gy.call(d3.axisRight(y).ticks(6).tickFormat(fmtP));

    els._scales = { zx, y, i0, i1, baseX, innerW, innerH };
    if (hoverIndex != null) drawCross();
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
      yZoom = Math.max(0.2, Math.min(8, yZoom * Math.exp(ev.dy * 0.005)));
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
      `<span class="nq-ro-time">${etTime(d.t, true)} ET</span>` +
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
  function buildToolbar() {
    const bar = document.getElementById('nq-chart-tf-buttons');
    if (!bar) return;
    bar.innerHTML = TIMEFRAMES.map(tf =>
      `<button class="nq-tf-btn ${tf === timeframe ? 'active' : ''}" data-tf="${tf}">${tf}</button>`).join('');
    bar.querySelectorAll('.nq-tf-btn').forEach(b =>
      b.addEventListener('click', () => setTimeframe(b.getAttribute('data-tf'))));
  }

  async function load(resetTheView) {
    try {
      await fetchCandles();
      if (resetTheView) resetView(); else render();
      updateReadout(data[data.length - 1]);
    } catch (e) { console.error('[nq-chart] load failed:', e && e.message); }
  }

  function setTimeframe(tf) {
    if (!TIMEFRAMES.includes(tf) || tf === timeframe) return;
    timeframe = tf;
    buildToolbar();
    load(true);
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
