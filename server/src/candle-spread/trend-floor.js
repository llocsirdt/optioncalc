'use strict';
// TREND-SIDE FLOOR (2026-10-11) — "risk should never be biased in the direction of the trend" (user). In practice
// the user enforces it by COVERING, or by OPENING new positions, to raise the floor on the side the trend is
// heading. Shared by the live trader and the backtest; pure — callers pass the curve and price the candidates.
//
// DEFINITIONS
//   trend side    — settle prices beyond spot in the trend's direction (above spot in a bull trend, below in a bear)
//   trend floor   — the book's worst settlement P&L on the trend side; counter floor the same on the other side
//   biased        — (user: "either") the trend floor is BELOW the counter floor, or BELOW ZERO
// ACTIONS (the caller builds candidates; this scores and picks):
//   cover — cover a position that loses if the trend continues (a bear spread in a bull trend)
//   open  — open a new spread WITH the trend
// Each candidate must lift the trend floor by at least minRatio x its cost, may not push the book's global floor
// past floorMin (-lossMax), and may not take a locked (>= 0) global floor below zero — floor raise's rules.
// order 'coverFirst' takes the best qualifying cover and only then an open; 'cheapest' takes the best ratio.

function sideFloors(xs, base, spot) {
  let up = Infinity, down = Infinity;
  for (let j = 0; j < xs.length; j++) {
    if (xs[j] > spot && base[j] < up) up = base[j];
    if (xs[j] < spot && base[j] < down) down = base[j];
  }
  return { up: Number.isFinite(up) ? up : 0, down: Number.isFinite(down) ? down : 0 };
}

// dir: +1 bull trend / -1 bear / 0 none. Returns null when there is no trend or no bias.
function bias(dir, xs, base, spot) {
  if (!dir) return null;
  const f = sideFloors(xs, base, spot);
  const trend = dir > 0 ? f.up : f.down, counter = dir > 0 ? f.down : f.up;
  if (!(trend < counter || trend < 0)) return null;
  return { trend, counter, gap: counter - trend };
}

/**
 * Pick the action. Each candidate: { kind:'cover'|'open', cost (dollars, > 0 for a debit), pay(x) -> dollars at
 * settle x of ADDING it to the book (already net of its own price), ...anything the caller needs back }.
 * @returns { best, scored } — best is null when nothing qualifies
 */
function pick({ dir, xs, base, spot, cands, minRatio = 1, floorMin = null, order = 'coverFirst' }) {
  const b = bias(dir, xs, base, spot);
  if (!b) return { best: null, scored: [], bias: null };
  const gNow = Math.min(...base);
  const onTrend = (x) => (dir > 0 ? x > spot : x < spot);
  const scored = [];
  for (const c of cands) {
    let trendAfter = Infinity, gAfter = Infinity;
    for (let j = 0; j < xs.length; j++) {
      const v = base[j] + c.pay(xs[j]);
      if (v < gAfter) gAfter = v;
      if (onTrend(xs[j]) && v < trendAfter) trendAfter = v;
    }
    const lift = trendAfter - b.trend;
    const cost = Math.max(1, c.cost);
    const ratio = lift / cost;
    let why = null;
    if (!(lift > 0)) why = 'no trend-side lift';
    else if (ratio < minRatio) why = `ratio ${ratio.toFixed(2)} < ${minRatio}`;
    else if (floorMin != null && gAfter < floorMin && gAfter < gNow) why = 'past the loss cap';
    else if (gNow >= 0 && gAfter < 0) why = 'would lose a locked profit';
    scored.push({ ...c, lift: Math.round(lift), ratio: Math.round(ratio * 100) / 100, trendAfter: Math.round(trendAfter), globalAfter: Math.round(gAfter), why });
  }
  const ok = scored.filter((s) => !s.why).sort((a, z) => z.ratio - a.ratio);
  const best = order === 'coverFirst' ? (ok.find((s) => s.kind === 'cover') || ok.find((s) => s.kind === 'open') || null) : (ok[0] || null);
  return { best, scored, bias: b };
}

module.exports = { sideFloors, bias, pick };
