'use strict';
/**
 * WING CONVERSION — turn PEAK into FLOOR. Late in a good day the book is a tall, narrow tent: a big peak
 * near spot that falls away to a much lower (or negative) floor in the wings. Buying a cheap OTM debit
 * spread on the declining side lifts that wing for a premium that costs *nothing at the peak* (the wing is
 * OTM there), converting unrealised peak into locked floor.
 *
 * WHY THIS IS NOT the risk-harvest / floorOffset overlay: those fire when the floor is BAD (a reachable
 * loss to negate). This fires when the book is GOOD — floor already positive — and the opportunity is to
 * bank more of it. Measured on the real 2026-09-04 15:30 books, floorOffset could never trigger because the
 * floors were +$1.6k..+$3.3k while the peak sat at $36k.
 *
 * SELECTION RULE (the user's actual method, and NOT "cheapest floor lift per dollar" — that objective
 * drifts too far OTM because the far tail is where the cheapest spread still caps at full width):
 *   put the SHORT leg at the KNEE — the price where the peak's decline flattens out (or where the curve
 *   crosses zero, when the job is lifting a negative floor into positive). The LONG leg goes INSIDE that,
 *   so the wing starts paying while the book is still declining rather than only in the dead tail.
 *   A combination of wings (both sides, or two on one side) is normal.
 *
 * Pure + isomorphic: the pricer is injected (BS in backtest, real chain quotes live).
 */
const RC = require('./risk-curve');

// Sample the book's terminal curve and locate the peak plus the KNEE on each side. The knee is the
// outermost price at which the curve is still meaningfully changing — beyond it the book is flat (every
// vertical has fully gone against us) so protection out there buys nothing extra.
// `zeroCross` is where the curve crosses 0 on that side, when it does — the alternate anchor the user
// uses when the job is to lift a floor into positive territory.
function curveShape(book, opts) {
  const o = opts || {};
  const step = o.step || 10, pad = o.pad != null ? o.pad : 400;
  const curve = RC.riskCurve(book, { step, pad });
  if (curve.length < 3) return null;
  let peakI = 0;
  for (let i = 1; i < curve.length; i++) if (curve[i][1] > curve[peakI][1]) peakI = i;
  // KNEE = where the decline COMPLETES, not where it first pauses. Take each side's minimum and walk out
  // from the peak to the first price that reaches it (within eps). Walking "until it stops falling" breaks
  // on any plateau mid-decline and lands far too close to the peak — measured on the real 2026-09-04
  // book that mis-read the $40 book's upside knee as 29,520 when the decline actually runs to 29,560.
  // Take each side's minimum and find where the decline from the peak has completed `kneeFrac` of its
  // total drop. "Walk until it stops falling" breaks on any plateau mid-decline (too close to the peak);
  // "walk to the exact side minimum" overshoots into the lumpy far tail (on the real 2026-09-04 $40 book
  // that gave 29,670 when the visible knee is 29,560). The fractional rule lands on the knee by eye.
  const frac = o.kneeFrac != null ? o.kneeFrac : 0.85;
  const pk = curve[peakI][1];
  let up = peakI, dn = peakI;
  let upMin = Infinity; for (let i = peakI; i < curve.length; i++) if (curve[i][1] < upMin) upMin = curve[i][1];
  const upTgt = pk - (pk - upMin) * frac;
  for (let i = peakI; i < curve.length; i++) if (curve[i][1] <= upTgt) { up = i; break; }
  let dnMin = Infinity; for (let i = peakI; i >= 0; i--) if (curve[i][1] < dnMin) dnMin = curve[i][1];
  const dnTgt = pk - (pk - dnMin) * frac;
  for (let i = peakI; i >= 0; i--) if (curve[i][1] <= dnTgt) { dn = i; break; }
  const cross = (from, dir) => {
    for (let i = from; i >= 0 && i < curve.length; i += dir) if (curve[i][1] < 0) return curve[i][0];
    return null;
  };
  return {
    curve,
    peak: { price: curve[peakI][0], pnl: curve[peakI][1] },
    kneeUp: curve[up][0], kneeUpPnl: curve[up][1],
    kneeDown: curve[dn][0], kneeDownPnl: curve[dn][1],
    zeroUp: cross(peakI, 1), zeroDown: cross(peakI, -1),
    floor: Math.min(...curve.map(c => c[1])),
  };
}

// Candidate wings anchored on the knee (or the zero-crossing when we're lifting a negative floor).
// side 'up' → long CALL spread; 'down' → long PUT spread. The short leg sits at the anchor; the long leg
// steps INWARD toward spot in `incr` increments, so each candidate starts paying progressively sooner
// (and costs progressively more) — the trade-off the user makes by eye.
function candidateWings(shape, side, spot, incr, maxSteps) {
  if (!shape) return [];
  const out = [];
  const steps = maxSteps != null ? maxSteps : 6;
  const round = k => Math.round(k / incr) * incr;
  const anchors = [];
  if (side === 'up') {
    if (shape.kneeUp != null) anchors.push(round(shape.kneeUp));
    if (shape.zeroUp != null) anchors.push(round(shape.zeroUp));
  } else {
    if (shape.kneeDown != null) anchors.push(round(shape.kneeDown));
    if (shape.zeroDown != null) anchors.push(round(shape.zeroDown));
  }
  for (const anchor of [...new Set(anchors)]) {
    for (let s = 1; s <= steps; s++) {
      const longK = side === 'up' ? anchor - s * incr : anchor + s * incr;
      // keep the long leg out of the money — a wing is protection, not a new directional position
      if (side === 'up' && longK <= spot) break;
      if (side === 'down' && longK >= spot) break;
      out.push(side === 'up'
        ? { side, tag: `C ${longK}/${anchor}`, legs: [{ side: 'long', type: 'C', strike: longK }, { side: 'short', type: 'C', strike: anchor }] }
        : { side, tag: `P ${longK}/${anchor}`, legs: [{ side: 'long', type: 'P', strike: longK }, { side: 'short', type: 'P', strike: anchor }] });
    }
  }
  return out;
}

// Cost of a leg-set from an injected pricer. `price(type, strike, legSide)` should return the MARKETABLE
// price for that leg (ask when buying, bid when selling) if quotes are available, else a mid + slip.
function wingCost(legs, price) {
  let d = 0;
  for (const l of legs) { const p = price(l.type, l.strike, l.side); if (p == null) return null; d += (l.side === 'long' ? 1 : -1) * p; }
  return d;
}

/**
 * Plan a set of wings. Greedy, but scored on the REACHABLE region rather than the absolute floor — that
 * is what keeps the selection at the knee instead of drifting into the dead tail. `band` = how far the
 * underlying can plausibly travel by settle (spot·iv·√tau·σ); the score is the improvement in the WORST
 * outcome inside [spot−band, spot+band], per dollar spent.
 *   opts: { spot, band, incr, price, qty, budget, maxWings, minRatio, step }
 * Returns { wings:[{legs, cost, tag, side}], spent, before:{floor,reachFloor,peak}, after:{...} }.
 */
function planWings(book, opts) {
  const o = opts || {};
  const incr = o.incr || 10, qty = o.qty || 1, step = o.step || 10;
  const band = o.band, spot = o.spot;
  const budget = o.budget != null ? o.budget : Infinity;
  const maxWings = o.maxWings != null ? o.maxWings : 4;
  const minRatio = o.minRatio != null ? o.minRatio : 3;
  const reach = b => {
    let m = Infinity;
    for (let S = spot - band; S <= spot + band; S += step) { const v = RC.bookPnl(b, S); if (v < m) m = v; }
    return m;
  };
  const shape0 = curveShape(book, { step });
  if (!shape0) return null;
  const before = { floor: shape0.floor, reachFloor: reach(book), peak: shape0.peak.pnl };
  // Score each SIDE independently. Scoring on the whole band's minimum can only ever fix the worse side —
  // an upside wing scores zero lift whenever the downside sits lower — so it could never "play a
  // combination", which is the normal case. sideMin(b,'up') is the worst outcome between spot and
  // spot+band; 'down' likewise below spot.
  // Score on the OVERALL reachable minimum, not per side. Per-side scoring looks like it enables
  // "combinations", but it ignores that a wing's premium drags the OTHER side down — measured on the real
  // v4-20 book it bought two put wings and pushed the reachable floor DOWN $3,310 -> $2,540. Greedy on the
  // overall minimum produces combinations correctly and only when they help: buy the binding side, and if
  // that flips which side binds, the next pass buys the other one.
  let cur = book.slice(), spent = 0;
  const wings = [];
  for (let n = 0; n < maxWings; n++) {
    const shape = curveShape(cur, { step });
    let best = null;
    const r0 = reach(cur);
    for (const side of ['up', 'down']) {
      for (const cand of candidateWings(shape, side, spot, incr, o.maxSteps)) {
        const cost = wingCost(cand.legs, o.price);
        if (cost == null || !(cost > 0)) continue;
        const dollars = cost * 100 * qty;
        if (spent + dollars > budget) continue;
        const trial = cur.concat([{ filled: true, legs: cand.legs, limit: cost, quantity: qty, wing: true }]);
        const lift = reach(trial) - r0;
        if (lift <= 0) continue;
        const ratio = lift / dollars;
        if (ratio >= minRatio && (!best || ratio > best.ratio)) best = { cand, cost, dollars, ratio, trial };
      }
    }
    if (!best) break;
    cur = best.trial; spent += best.dollars;
    wings.push({ legs: best.cand.legs, cost: best.cost, tag: best.cand.tag, side: best.cand.side, ratio: Math.round(best.ratio * 10) / 10 });
  }
  const shape1 = curveShape(cur, { step });
  return {
    wings, spent: Math.round(spent), book: cur,
    before, after: { floor: shape1.floor, reachFloor: reach(cur), peak: shape1.peak.pnl },
    shape: shape0,
  };
}

module.exports = { curveShape, candidateWings, wingCost, planWings };
