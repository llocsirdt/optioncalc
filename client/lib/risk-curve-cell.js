'use strict';
/**
 * The compare grid's mini risk-curve cell, extracted VERBATIM so other pages render the identical chart
 * rather than an approximation of it. Same geometry, same colours, same dashed backtest references, same
 * locked-floor violet, same extremes on the right edge.
 *
 * Kept as a plain global (window.RiskCurveCell) to match how the other client libs load here — no build
 * step, usable from file:// as well as a served page.
 *
 * The caller supplies the helpers it closes over (fmtN, usdK, pnlAtPrice, CW, CH) so this file stays a
 * pure renderer with no opinion about where the numbers came from.
 */
(function (root) {
  function make(deps) {
    const { fmtN, usdK, pnlAtPrice, CW, CH } = deps;
    // FONT SCALE. The compare grid draws ~60 of these at thumbnail size, where 8-9.5px labels are right.
    // A page showing ONE chart at full width needs them proportionally larger to be readable, so the host
    // scales rather than the renderer guessing from CW. Default 1 keeps the grid byte-identical.
    const FS = deps.fontScale || 1;
    // gAbs is the LARGEST absolute P&L across every cell being drawn — it sets the gradient saturation so
    // a small book stays pale and only the biggest reaches full colour. It is a property of the whole
    // GRID, not of one cell, so the host supplies it: the compare page passes its running max, and a
    // single-chart page passes that chart's own magnitude.
    const gAbsOf = typeof deps.gAbs === 'function' ? deps.gAbs : () => (deps.gAbs || 0);
function svgCurve(v, d, yMin, yMax, bt, dB) {
  const xMin = d.xMin, xMax = d.xMax;
  // VERTICAL HEADROOM. The default is 8% of the plotted range, which is right for the compare grid's
  // thumbnails but too little on a full-size chart: at CH=300 a tall book's peak and valley run into the
  // edge, where they collide with the labels drawn at the extremes and with the page furniture above and
  // below (the time slider in particular).
  //
  // `padPx` asks for an EXACT pixel gutter instead. Reserving padPx at top and bottom means the data must
  // occupy CH - 2*padPx pixels, so the extra range each side is range * padPx / (CH - 2*padPx) — solved
  // rather than approximated, so 20 really is 20px at any CH. Falls back to the percentage rule when the
  // chart is too short to give up the space. Omitting padPx keeps the grid byte-identical.
  // Accepts a number (same gutter both ends) or {top, bottom} — the bottom usually needs more, because the
  // host may float a readout over the foot of the chart (debug's .nowlbl) and the time slider sits directly
  // beneath it. Reserving tPx/bPx means the data occupies CH - tPx - bPx pixels, so the extra range at each
  // end is range * px / (CH - tPx - bPx) — solved, not approximated, so the gutters are exact at any range.
  //
  // NOTE the default is NOT small: 8% of range works out to CH * 0.08/1.16 ≈ 6.9% of the canvas at ANY
  // range, i.e. ~20.7px at CH=300. So asking for 20px would be a REDUCTION. Pass more than that to gain room.
  const range = yMax - yMin;
  const pp = deps.padPx;
  const tPx = typeof pp === 'number' ? pp : (pp && pp.top) || 0;
  const bPx = typeof pp === 'number' ? pp : (pp && pp.bottom) || 0;
  const usable = CH - tPx - bPx;
  const exact = (tPx > 0 || bPx > 0) && usable > 0 && range > 0;
  const padTop = exact ? range * tPx / usable : ((yMax - yMin) * 0.08 || 1);
  const padBot = exact ? range * bPx / usable : ((yMax - yMin) * 0.08 || 1);
  const y0 = yMin - padBot, y1 = yMax + padTop;
  const X = (x) => ((x - xMin) / (xMax - xMin || 1)) * CW;
  const Y = (y) => CH - ((y - y0) / (y1 - y0 || 1)) * CH;
  const zeroY = Math.max(0, Math.min(CH, Y(0)));
  const pts = d.curve.map((p) => `${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(' ');
  const areaUp = `M0,${zeroY} L ${d.curve.map((p) => `${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(' L ')} L ${CW},${zeroY} Z`;
  const id = 'c' + Math.random().toString(36).slice(2, 8);
  // The overlay legend stacks down the TOP-LEFT (see ovEl below) and the reference labels below are drawn
  // in the same corner, so a reference line sitting above the book's own range gets pinned into the legend
  // and the two overprint — visible on the debug page as the backtest "best" value buried under
  // "if all covers filled". Knowing the legend's extent here lets the labels start below it instead.
  const overlays = (Array.isArray(dB) ? dB : [dB]).filter((o) => o && o.curve && o.curve.length);
  const legendRows = overlays.filter((o) => o.label).length;
  const legendBottom = legendRows ? (11 * FS) + legendRows * (10 * FS) : 0;

  // Backtest AVERAGE loss/profit: dashed reference lines (always shown) with the $ value inline at the LEFT.
  const btEl = (y, color, txt) => {
    if (y == null || !Number.isFinite(y)) return '';
    // The clamp must scale WITH the font. These constants were written for the grid's 8px labels; at
    // fontScale 2.1 the text is 16.8px, so a baseline pinned at y=8 puts the ascender near y=-5 — outside
    // the viewBox, which is the top-edge clipping seen on the debug page. Multiplying by FS keeps FS=1
    // byte-identical and makes the gutter proportional to the glyphs actually drawn.
    const ly = Math.max(Math.max(8 * FS, legendBottom), Math.min(CH - 1 * FS, Y(y) - 1.5));
    return `<line x1="0" y1="${Y(y).toFixed(1)}" x2="${CW}" y2="${Y(y).toFixed(1)}" stroke="${color}" stroke-width="1" stroke-dasharray="2 2" opacity="0.85"/>`
      + `<text x="2" y="${ly.toFixed(1)}" text-anchor="start" font-size="${(8 * FS).toFixed(1)}" font-weight="${FS > 1 ? 700 : 400}" font-family="ui-monospace,monospace" fill="${color}" stroke="#fff" stroke-width="${(2.4 * FS).toFixed(1)}" paint-order="stroke">${txt}</text>`;
  };
  // A floor above zero is a different STATE, not a smaller loss: the whole curve is in profit, so there is
  // no settlement price that loses money. Red said the opposite. Violet marks it without colliding with the
  // peak line directly above it. Position already conveys the sign; colour is doing identity + state.
  const floorCol = (y) => (y != null && y > 0 ? 'var(--locked)' : 'var(--loss)');
  const btLines = bt ? btEl(bt.worst, floorCol(bt.worst), fmtN(bt.worst)) + btEl(bt.best, 'var(--profit)', fmtN(bt.best)) : '';
  // THIS BOOK's max profit / max loss, on the RIGHT edge at the height of the peak and the valley — the
  // mirror of the dashed backtest averages on the left, so "mine vs typical" reads across the chart at a
  // glance instead of between the header and the plot.
  const exEl = (y, color, txt) => {
    if (y == null || !Number.isFinite(y)) return '';
    const ly = Math.max(9 * FS, Math.min(CH - 2 * FS, Y(y) - 2));   // scaled for the same reason as btEl
    return `<text x="${CW - 2}" y="${ly.toFixed(1)}" text-anchor="end" font-size="${(9.5 * FS).toFixed(1)}" font-weight="700"`
      + ` font-family="ui-monospace,monospace" fill="${color}" stroke="#fff" stroke-width="${(2.6 * FS).toFixed(1)}" paint-order="stroke">${txt}</text>`;
  };
  const exLines = exEl(d.hi, 'var(--profit)', d.unboundedGain ? '+∞' : usdK(d.hi))
                + exEl(d.lo, d.unboundedLoss ? 'var(--loss)' : floorCol(d.lo), d.unboundedLoss ? '−∞' : usdK(d.lo));
  // Underlying price lines are GRAY: solid = current underlying, dashed = the click cursor (P&L projection).
  const curLine = d.underlying != null ? `<line x1="${X(d.underlying).toFixed(1)}" y1="0" x2="${X(d.underlying).toFixed(1)}" y2="${CH}" stroke="#888" stroke-width="1.2"/>` : '';
  const cursor = `<line class="cursor" x1="0" y1="0" x2="0" y2="${CH}" stroke="#555" stroke-width="1" stroke-dasharray="3 2" visibility="hidden"/>`;
  // OVERLAY CURVES. `dB` began as a single counterfactual book (compare's backtest twin, debug's "if all
  // covers filled") and is now either that object or an ARRAY of them, because the debug page draws two:
  // the if-all-filled counterfactual AND the same day as the backtest engine ran it. Each may carry its
  // own colour/dash; the defaults reproduce the original single blue dashed line byte-for-byte, so every
  // existing caller renders exactly as before. Labels stack down the top-left in their own colour, which
  // is also the key — no separate legend to keep in sync.
  let ovRow = 0;
  const ovEl = (o) => {
    const col = o.color || '#6ab0f3', txt = o.labelColor || o.color || '#3d86c6', dash = o.dash || '4 2';
    const y = (11 * FS) + (ovRow++) * (10 * FS);
    return `<polyline points="${o.curve.map((p) => `${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(' ')}" fill="none" stroke="${col}" stroke-width="${(1.2 * FS).toFixed(1)}" stroke-dasharray="${dash}" opacity="0.95"/>`
      + (o.label ? `<text x="2" y="${y.toFixed(1)}" font-size="${(8 * FS).toFixed(1)}" font-weight="700" font-family="ui-monospace,monospace" fill="${txt}" stroke="#fff" stroke-width="${(2.4 * FS).toFixed(1)}" paint-order="stroke">${o.label}</text>` : '');
  };
  // FILL DEPTH = HOW BIG THE OUTCOME IS, in dollars. Each gradient runs from break-even (pale) to the
  // grid-wide extreme (full colour) in USER SPACE — so the full-saturation stop for a small book sits far
  // OFF the top/bottom of its own chart and only the pale end is ever visible, while the biggest books in
  // the grid reach deep green / deep red. Anchoring per-cell instead would make every book look equally
  // extreme, which is the opposite of what the colour is for.
  // Each gradient spans the cell's OWN area (so the payoff shape stays readable at any size), while how
  // DEEP it gets encodes the magnitude against the whole grid. sqrt compression keeps small books clearly
  // tinted rather than washing them out to white — the first version anchored the saturation stop at the
  // grid extreme in user space, which pushed it so far off a small chart that only near-white remained.
  const depth = (x) => (gAbsOf() > 0 ? Math.min(1, Math.sqrt(Math.abs(x || 0) / gAbsOf())) : 1);
  const upD = depth(d.hi), dnD = depth(d.lo);
  const o = (frac, k) => (0.13 + 0.5 * frac * k).toFixed(3);   // floor keeps a small book visible
  const grads = `
      <linearGradient id="gu${id}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="${zeroY.toFixed(1)}">
        <stop offset="0" stop-color="#0b6b5b" stop-opacity="${o(upD, 1)}"/>
        <stop offset="0.6" stop-color="#26a69a" stop-opacity="${o(upD, 0.55)}"/>
        <stop offset="1" stop-color="#8fd3c7" stop-opacity="0.09"/>
      </linearGradient>
      <linearGradient id="gd${id}" gradientUnits="userSpaceOnUse" x1="0" y1="${zeroY.toFixed(1)}" x2="0" y2="${CH}">
        <stop offset="0" stop-color="#f7b6b4" stop-opacity="0.09"/>
        <stop offset="0.4" stop-color="#ef5350" stop-opacity="${o(dnD, 0.55)}"/>
        <stop offset="1" stop-color="#a01916" stop-opacity="${o(dnD, 1)}"/>
      </linearGradient>`;
  return `<svg data-v="${v}" width="${CW}" height="${CH}" viewBox="0 0 ${CW} ${CH}">
    <defs>
      <clipPath id="up${id}"><rect x="0" y="0" width="${CW}" height="${zeroY}"/></clipPath>
      <clipPath id="dn${id}"><rect x="0" y="${zeroY}" width="${CW}" height="${CH - zeroY}"/></clipPath>
      ${grads}
    </defs>
    <path d="${areaUp}" fill="url(#gu${id})" clip-path="url(#up${id})"/>
    <path d="${areaUp}" fill="url(#gd${id})" clip-path="url(#dn${id})"/>
    <line x1="0" y1="${zeroY.toFixed(1)}" x2="${CW}" y2="${zeroY.toFixed(1)}" stroke="var(--zero)" stroke-width="1" stroke-dasharray="3 2"/>
    ${btLines}
    <polyline points="${pts}" fill="none" stroke="#333" stroke-width="1.3"/>
    ${exLines}
    ${overlays.map(ovEl).join('')}
    ${curLine}${cursor}
  </svg>`;
}
    return svgCurve;
  }
  root.RiskCurveCell = { make };
})(typeof window !== 'undefined' ? window : this);
