'use strict';
/**
 * RISK CURVE — the terminal (settlement) P&L of a book of spread positions across underlying prices, plus
 * shape analysis (peak, floor, loss zones). The substrate for the "risk-harvest" overlay (v11): late/lopsided
 * in the day the strategy has built a big profit PEAK with cheap-to-cap loss TAILS; this quantifies the curve
 * so we can find the far-side hedge that lifts a loss zone for little cost. Pure + isomorphic (backtest + live).
 *
 * A position: { legs:[{side:'long'|'short', type:'C'|'P', strike}], limit, covered?, coverLegs?, coverLimit?,
 * quantity?, filled? }. P&L per position at settle S = (payoff(legs,S) + covered·payoff(coverLegs,S)
 * − limit − coverLimit) × 100 × qty — identical to computeTerminalPnl / backtest terminal, over a grid.
 */
const r2 = n => Math.round(n * 100) / 100;

// Intrinsic value of a leg-set at settle S, signed by long/short.
function payoff(legs, S) {
  let v = 0;
  for (const l of legs) v += (l.side === 'long' ? 1 : -1) * (l.type === 'C' ? Math.max(S - l.strike, 0) : Math.max(l.strike - S, 0));
  return v;
}

function positionPnl(pos, S) {
  const q = pos.quantity || 1;
  let value = payoff(pos.legs, S), cost = pos.limit || 0;
  if (pos.covered && pos.coverLegs) { value += payoff(pos.coverLegs, S); cost += (pos.coverLimit || 0); }
  return (value - cost) * 100 * q;
}

// Total book P&L at settle S (only established/filled positions).
function bookPnl(positions, S) {
  let t = 0;
  for (const p of positions || []) { if (p && p.filled !== false && p.legs) t += positionPnl(p, S); }
  return t;
}

// SAMPLE POINTS FOR A BAND — the uniform grid PLUS every strike inside it, plus both endpoints.
//
// A terminal P&L curve is piecewise-linear with kinks ONLY at strikes, so its extrema over an interval are
// at a strike or at an endpoint and nowhere else. A uniform grid started from a fractional price therefore
// misses every extremum it is trying to find. This mattered because the hedge planners' whole objective is
// an extremum: reachableFloor is a min over the band, and a butterfly's entire lift is ONE POINT at the
// body strike, so the structure being scored is precisely the one a grid cannot see. Measured on the real
// v7-20 book: true apex $2,700 against $2,432 sampled — a 10% understatement of the thing being bought,
// and worse at coarser steps.
//
// book-value.js:curve does the same union for the same reason. Endpoints are included because the band is
// a hard window: the worst REACHABLE outcome may well be at its edge.
function bandPoints(positions, lo, hi, step) {
  if (!(hi > lo)) return [lo];
  const st = step > 0 ? step : Math.max(1, (hi - lo) / 240);
  const xs = new Set([r2(lo), r2(hi)]);
  for (let S = lo; S <= hi; S += st) xs.add(r2(S));
  for (const p of positions || []) {
    for (const group of [p && p.legs, p && p.coverLegs]) {
      for (const l of group || []) if (l && l.strike >= lo && l.strike <= hi) xs.add(l.strike);
    }
  }
  return [...xs].sort((a, b) => a - b);
}

// The curve as [[S, pnl], ...] over [lo, hi] step `step`. Default window auto-brackets the strikes ± a pad.
function riskCurve(positions, opts) {
  const o = opts || {};
  let lo = o.lo, hi = o.hi;
  if (lo == null || hi == null) {
    const ks = [];
    for (const p of positions || []) { if (p && p.legs) for (const l of p.legs) ks.push(l.strike); if (p && p.coverLegs) for (const l of p.coverLegs) ks.push(l.strike); }
    const pad = o.pad != null ? o.pad : 100;
    lo = lo != null ? lo : (ks.length ? Math.min(...ks) - pad : 0);
    hi = hi != null ? hi : (ks.length ? Math.max(...ks) + pad : 0);
  }
  const step = o.step || 5;
  const curve = [];
  for (let S = lo; S <= hi; S += step) curve.push([S, r2(bookPnl(positions, S))]);
  return curve;
}

// Shape summary: peak (max profit + its price), floor (min + its price), and contiguous LOSS ZONES (runs of
// price where pnl < `lossThresh`, default 0) with each zone's worst pnl. `atSpot` (optional) tags the current
// underlying's P&L and which side of the peak it sits on — the lopsidedness the harvest keys off.
function analyzeCurve(curve, opts) {
  const o = opts || {}, thresh = o.lossThresh != null ? o.lossThresh : 0;
  let peak = { price: null, pnl: -Infinity }, floor = { price: null, pnl: Infinity };
  for (const [S, v] of curve) { if (v > peak.pnl) peak = { price: S, pnl: v }; if (v < floor.pnl) floor = { price: S, pnl: v }; }
  const lossZones = [];
  let cur = null;
  for (const [S, v] of curve) {
    if (v < thresh) { if (!cur) cur = { from: S, to: S, worst: v, worstPrice: S }; else { cur.to = S; if (v < cur.worst) { cur.worst = v; cur.worstPrice = S; } } }
    else if (cur) { lossZones.push(cur); cur = null; }
  }
  if (cur) lossZones.push(cur);
  const out = { peak, floor, lossZones };
  if (o.atSpot != null) {
    const pnlAtSpot = r2(bookPnl_fromCurve(curve, o.atSpot));
    out.atSpot = { price: o.atSpot, pnl: pnlAtSpot, sideOfPeak: peak.price == null ? null : (o.atSpot < peak.price ? 'below' : o.atSpot > peak.price ? 'above' : 'at') };
  }
  return out;
}

// P&L at an arbitrary price by nearest curve point (curve is the sampled grid).
function bookPnl_fromCurve(curve, S) {
  let best = null, bd = Infinity;
  for (const [p, v] of curve) { const d = Math.abs(p - S); if (d < bd) { bd = d; best = v; } }
  return best == null ? 0 : best;
}

// EXACT book floor — the worst terminal P&L the CURRENT book can produce, and the quantity the day-loss
// governor bounds. Since realized day P&L = bookPnl(settle), holding floor >= -lossMax is a true bound on
// the day's loss (unlike a cap on at-risk debit, which is only an at-OPEN snapshot).
//
// Exact AND cheap: the terminal payoff is piecewise-linear in the settle price with kinks ONLY at strikes
// and flat tails beyond the outermost ones, so the minimum is attained at a strike or on a tail —
// evaluating the distinct strikes plus one point outside each end is exact, with no grid sweep. `extra` is
// an optional hypothetical position (the PROJECTED floor if we added it), which is what the open gate asks.
function bookFloor(positions, extra, pad) {
  const ks = [];
  const push = (k) => { if (k != null && ks.indexOf(k) < 0) ks.push(k); };
  for (const p of positions || []) {
    if (!p || p.filled === false || !p.legs) continue;
    for (const l of p.legs) push(l.strike);
    if (p.covered && p.coverLegs) for (const l of p.coverLegs) push(l.strike);
  }
  if (extra && extra.legs) for (const l of extra.legs) push(l.strike);
  if (!ks.length) return 0;
  // UNBOUNDED TAILS FIRST. Past the outermost strike the payoff is exactly linear — there are no strikes
  // left to bend it — so a sampled window cannot see a loss that keeps growing. It returns the value at
  // whatever point it happened to sample and calls that the floor.
  //
  // This is the floor the day-loss governor bounds, the floor the ratchet watches, and the floor every
  // open is gated on. A book with a net short call is unbounded above; a net short put is unbounded below
  // (to zero); and either way the honest answer is -Infinity, which is what shared/portfolio-risk.js has
  // always returned for the same shape. Without it, `lossMax` is not a bound at all on such a book — it
  // is a bound on one arbitrary sample of it.
  //
  // LATENT TODAY, not live: 0 of 807 archived books carry a net short tail, because everything held is a
  // balanced vertical or a tent of them. It becomes real the moment an unpaired short enters — a credit
  // cover valued as-sent, a hedge leg that did not get its pair, a wing-shift that left one side behind.
  let netCall = 0, netPut = 0;
  const addLegs = (legs, qty) => {
    for (const l of legs || []) {
      const n = (l.side === 'long' ? 1 : -1) * (l.quantity || qty || 1);
      if (l.type === 'C') netCall += n; else netPut += n;
    }
  };
  for (const p of positions || []) {
    if (!p || p.filled === false || !p.legs) continue;
    addLegs(p.legs, p.quantity);
    if (p.covered && p.coverLegs) addLegs(p.coverLegs, p.quantity);
  }
  if (extra && extra.legs) addLegs(extra.legs, extra.quantity);
  if (netCall < 0 || netPut < 0) return -Infinity;
  let lo = Infinity, hi = -Infinity;
  for (const k of ks) { if (k < lo) lo = k; if (k > hi) hi = k; }
  const step = pad || 10;
  const at = (S) => bookPnl(positions, S) + (extra ? positionPnl(extra, S) : 0);
  let m = Infinity;
  for (const k of ks) { const v = at(k); if (v < m) m = v; }
  const a = at(lo - step); if (a < m) m = a;
  const b = at(hi + step); if (b < m) m = b;
  return m;
}

module.exports = { payoff, positionPnl, bookPnl, bandPoints, riskCurve, analyzeCurve, bookFloor };
