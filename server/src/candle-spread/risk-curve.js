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

module.exports = { payoff, positionPnl, bookPnl, riskCurve, analyzeCurve };
