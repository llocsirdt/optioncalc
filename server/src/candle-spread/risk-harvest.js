'use strict';
/**
 * RISK-HARVEST hedge search (v11 overlay). Given the strategy's current book + a pricer for the live chain
 * + spot, find the cheapest far-side spread that lifts a REACHABLE loss zone — spending a sliver of the
 * profit peak to truncate a loss tail. Fires on a RATIO trigger, not a clock: return-on-cost = floor-lift ÷
 * premium; act when it clears a threshold (early/balanced curves yield low ratios → nothing fires).
 *
 * "risk-reduced" = the improvement in the REACHABLE FLOOR: min book P&L over [spot ± band], where band is the
 * remaining expected move (spot·iv·√tau·sigmas). Small tau (late day) → small band → only near-money tails
 * matter → cheap hedges — exactly the mechanic. Pure; pricer injected (BS in backtest, real chain live).
 */
const RC = require('./risk-curve');

// Worst book P&L over the reachable settle band [spot-band, spot+band].
function reachableFloor(positions, spot, band, step) {
  let m = Infinity;
  for (let S = spot - band; S <= spot + band; S += step) { const v = RC.bookPnl(positions, S); if (v < m) m = v; }
  return m;
}

// Candidate far-side DEBIT spreads that pay INTO a loss zone: a call spread for an upside loss (pays as S
// rises), a put spread for a downside loss. Long leg near/inside the zone, short leg `w` further out.
function candidateHedges(zoneSide, spot, incr, widths, depth) {
  const legsList = [];
  const base = Math.round(spot / incr) * incr;
  for (let k = 0; k <= depth; k++) {
    for (const w of widths) {
      if (zoneSide === 'above') {         // upside loss → long call spread above spot
        const lo = base + k * incr, hi = lo + w;
        legsList.push({ side: 'call', legs: [{ side: 'long', type: 'C', strike: lo }, { side: 'short', type: 'C', strike: hi }] });
      } else {                             // downside loss → long put spread below spot
        const hi = base - k * incr, lo = hi - w;
        legsList.push({ side: 'put', legs: [{ side: 'long', type: 'P', strike: hi }, { side: 'short', type: 'P', strike: lo }] });
      }
    }
  }
  return legsList;
}

// Net debit (per share) of a leg-set from the injected mark(type,strike) → mid. `slip` (per leg, price
// units) models the half-spread paid on entry: you buy the long legs above mid and sell the short below,
// so a debit costs `slip` more per leg. Real far-OTM 0DTE spreads don't fill at mid — this haircuts them.
function legsDebit(legs, mark, slip) {
  let d = 0;
  for (const l of legs) { const p = mark(l.type, l.strike); if (p == null) return null; d += (l.side === 'long' ? 1 : -1) * p; }
  return d + (slip || 0) * legs.length;
}

// Find the best hedge to add. Returns { legs, debit, cost, riskReduced, ratio, oldFloor, newFloor, side } or
// null. opts: { band, step, incr, widths, depth, qty, minRatio, ledger (optional leg-uniqueness) }.
function bestHedge(positions, mark, spot, opts) {
  const o = opts || {};
  const band = o.band, step = o.step || 5, incr = o.incr || 10, qty = o.qty || 1;
  const widths = o.widths || [20, 40, 60], depth = o.depth != null ? o.depth : 6, minRatio = o.minRatio != null ? o.minRatio : 3;
  const oldFloor = reachableFloor(positions, spot, band, step);
  if (oldFloor >= 0) return null;   // no reachable loss to harvest
  // which side is the loss on? sample the band's worst point
  let worstS = spot, worstV = Infinity;
  for (let S = spot - band; S <= spot + band; S += step) { const v = RC.bookPnl(positions, S); if (v < worstV) { worstV = v; worstS = S; } }
  const zoneSide = worstS >= spot ? 'above' : 'below';
  let best = null;
  for (const cand of candidateHedges(zoneSide, spot, incr, widths, depth)) {
    if (o.ledger && o.ledger.conflicts && o.ledger.conflicts(cand.legs)) continue;   // respect leg-uniqueness
    const debit = legsDebit(cand.legs, mark, o.slip);
    if (debit == null || debit <= 0) continue;
    const cost = debit * 100 * qty;
    const hedgePos = { filled: true, legs: cand.legs, limit: debit, quantity: qty };
    const newFloor = reachableFloor(positions.concat([hedgePos]), spot, band, step);
    const riskReduced = newFloor - oldFloor;
    if (riskReduced <= 0) continue;
    const ratio = riskReduced / cost;
    if (ratio >= minRatio && (!best || ratio > best.ratio)) best = { legs: cand.legs, debit: Math.round(debit * 100) / 100, cost: Math.round(cost), riskReduced: Math.round(riskReduced), ratio: Math.round(ratio * 100) / 100, oldFloor: Math.round(oldFloor), newFloor: Math.round(newFloor), side: zoneSide, hedgePos };
  }
  return best;
}

// GREEDY harvest: keep adding the best efficient hedge (ratio ≥ minRatio) until the reachable floor is
// lifted to >= target (default 0 = negate the reachable loss), or no hedge clears the ratio, or the budget /
// maxHedges is hit. This is the "a trade or two" plan. Returns { hedges[], spent, oldFloor, finalFloor }.
function harvestPlan(positions, mark, spot, opts) {
  const o = opts || {};
  const step = o.step || 5, target = o.target != null ? o.target : 0;
  const budget = o.budget != null ? o.budget : Infinity, maxHedges = o.maxHedges != null ? o.maxHedges : 8;
  const oldFloor = reachableFloor(positions, spot, o.band, step);
  let book = positions.slice(), hedges = [], spent = 0;
  for (let i = 0; i < maxHedges; i++) {
    if (reachableFloor(book, spot, o.band, step) >= target) break;
    const h = bestHedge(book, mark, spot, o);
    if (!h || spent + h.cost > budget) break;
    book = book.concat([h.hedgePos]); hedges.push(h); spent += h.cost;
    if (o.ledger && o.ledger.record) o.ledger.record(h.legs);
  }
  return { hedges, spent: Math.round(spent), oldFloor: Math.round(oldFloor), finalFloor: Math.round(reachableFloor(book, spot, o.band, step)), book };
}

module.exports = { reachableFloor, candidateHedges, legsDebit, bestHedge, harvestPlan };
