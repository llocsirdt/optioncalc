'use strict';
/**
 * SPREAD QUOTES + MARK VALIDATION.
 *
 * Two jobs, both from the per-leg chain we already snapshot each candle:
 *
 *  1. NET quotes for a spread (bid / ask / mid, and what crossing actually costs over mid) so execution
 *     cost is MEASURED rather than assumed. NOTE: this is the LEGGED net — built from the two legs' own
 *     bid/ask. A native combo usually fills tighter, so `ask` here is an UPPER BOUND on what you pay, not
 *     an estimate. Real fills are the ground truth; capture them when orders start filling.
 *
 *  2. VALIDATION that a mark is real before ordering off it. Sometimes the book's mark is notably higher
 *     than what the position would execute for, almost always because ONE leg has an abnormally wide
 *     bid/ask. Three independent checks (the user's own discipline):
 *
 *     PARITY (strongest, and EXACT — not a heuristic). For the same strikes,
 *         bullCall + bearPut = [C(lo) − C(hi)] + [P(hi) − P(lo)]
 *                            = [C(lo) − P(lo)] − [C(hi) − P(hi)]
 *                            = (S − lo) − (S − hi) = W
 *     at zero rates. So the two MIDs must sum to the width; anything above that is friction or a bad
 *     quote. The CHEAPER side is never under-priced, so anchor on it: fair(expensive) = W − mid(cheap).
 *     Worked example: $20 spread, call marks $16, put marks $8 → sum $24, excess $4 → fair call = $12.
 *
 *     NEIGHBOUR. Price the same structure shifted a strike or two each way. A wide leg rarely affects its
 *     siblings, so a mark far off its neighbours' trend is the bad quote, not the market.
 *
 *     CEILING. Never pay more than ~65% of width for a long debit spread — above that the risk/reward
 *     isn't there. This one is a STRATEGY limit rather than a quote check: the right response is to
 *     decline or move strikes, NOT to book at the cap (booking `min(cap, mark)` pays below market).
 */

const r2 = (n) => Math.round(n * 100) / 100;

// Net quote of a leg-set from the chain. `bid` = what you'd receive selling it, `ask` = what you'd pay
// buying it (long legs at ask, short legs at bid), `mid` = the mark. crossOverMid = ask − mid = the cost
// of lifting the offer relative to the mark, i.e. the number the user quotes as "$0.05-$0.20 over mark".
function netQuote(legs, getLeg) {
  let bid = 0, ask = 0, mid = 0;
  for (const l of legs) {
    const q = getLeg(l.type, l.strike);
    if (!q || q.mid == null || q.bid == null || q.ask == null) return null;
    if (l.side === 'long') { bid += q.bid; ask += q.ask; mid += q.mid; }
    else { bid -= q.ask; ask -= q.bid; mid -= q.mid; }
  }
  return { bid: r2(bid), ask: r2(ask), mid: r2(mid), width: r2(ask - bid), crossOverMid: r2(ask - mid), perLeg: r2((ask - mid) / legs.length) };
}

const bullCallLegs = (lo, hi) => [{ side: 'long', type: 'C', strike: lo }, { side: 'short', type: 'C', strike: hi }];
const bearPutLegs = (lo, hi) => [{ side: 'long', type: 'P', strike: hi }, { side: 'short', type: 'P', strike: lo }];

/**
 * PARITY CHECK. Returns the two mids, their sum vs the width, and — when the sum exceeds the width by
 * more than `tolFrac` — which side looks inflated and what it should really be worth.
 * `fair` is the price to trust: derived from the cheaper side, which is never under-priced.
 */
function parityCheck(lo, hi, getLeg, opts) {
  const o = opts || {};
  const W = hi - lo;
  const call = netQuote(bullCallLegs(lo, hi), getLeg);
  const put = netQuote(bearPutLegs(lo, hi), getLeg);
  if (!call || !put) return null;
  const sum = r2(call.mid + put.mid);
  const excess = r2(sum - W);
  const tol = (o.tolFrac != null ? o.tolFrac : 0.05) * W;   // the user's "~5%" friction allowance
  const out = { width: W, callMid: call.mid, putMid: put.mid, sum, excess, tol: r2(tol), ok: excess <= tol };
  if (!out.ok) {
    // Anchor on the cheaper side; the expensive one is the suspect.
    out.inflated = call.mid >= put.mid ? 'call' : 'put';
    out.anchorMid = Math.min(call.mid, put.mid);
    out.fair = { call: r2(W - put.mid), put: r2(W - call.mid) };
    out.overstatedBy = out.inflated === 'call' ? r2(call.mid - out.fair.call) : r2(put.mid - out.fair.put);
  }
  return out;
}

/**
 * NEIGHBOUR CHECK. Compare this spread's mid against the same structure shifted +/- k strikes. Returns the
 * neighbours' mids and how far this one sits from the straight line through them — a wide leg shows up as
 * a local outlier, since siblings rarely share the defect.
 */
function neighbourCheck(side, lo, hi, getLeg, opts) {
  const o = opts || {};
  const incr = o.incr || 10, n = o.neighbours || 2;
  const legsFor = (a, b) => (side === 'bull' ? bullCallLegs(a, b) : bearPutLegs(a, b));
  const self = netQuote(legsFor(lo, hi), getLeg);
  if (!self) return null;
  const pts = [];
  for (let k = -n; k <= n; k++) {
    if (k === 0) continue;
    const q = netQuote(legsFor(lo + k * incr, hi + k * incr), getLeg);
    if (q) pts.push({ k, mid: q.mid });
  }
  if (pts.length < 2) return { ok: true, self: self.mid, neighbours: pts, reason: 'too few neighbours' };
  // A vertical's price moves smoothly with strike, so a straight line through the neighbours is a decent
  // local expectation; the residual is what a single wide leg blows out.
  const meanK = pts.reduce((s, p) => s + p.k, 0) / pts.length;
  const meanM = pts.reduce((s, p) => s + p.mid, 0) / pts.length;
  let num = 0, den = 0;
  for (const p of pts) { num += (p.k - meanK) * (p.mid - meanM); den += (p.k - meanK) * (p.k - meanK); }
  const slope = den ? num / den : 0;
  const expected = r2(meanM + slope * (0 - meanK));
  const resid = r2(self.mid - expected);
  const scale = Math.max(0.05, (hi - lo) * (o.tolFrac != null ? o.tolFrac : 0.05));
  return { ok: Math.abs(resid) <= scale, self: self.mid, expected, resid, scale: r2(scale), neighbours: pts };
}

/**
 * The full gate for an OPEN. Combines all three checks and returns the price to actually use.
 *   ok:false + reason 'ceiling'  → the trade itself is too expensive (decline, or move strikes)
 *   ok:false + reason 'parity'/'neighbour' → the MARK is suspect; `limit` is the parity-derived fair price
 * `limit` is never above the observed mid — we do not invent a better price than the market shows, and we
 * never return a capped price for a trade we would still take (booking below market is the artifact this
 * whole module exists to avoid).
 */
function validateOpen(side, lo, hi, getLeg, opts) {
  const o = opts || {};
  const W = hi - lo;
  const maxFrac = o.maxDebitFrac != null ? o.maxDebitFrac : 0.65;
  const q = netQuote(side === 'bull' ? bullCallLegs(lo, hi) : bearPutLegs(lo, hi), getLeg);
  if (!q) return { ok: false, reason: 'no-quote' };
  const parity = parityCheck(lo, hi, getLeg, o);
  const neigh = o.neighbours === 0 ? null : neighbourCheck(side, lo, hi, getLeg, o);
  const reasons = [];
  let limit = q.mid;
  if (parity && !parity.ok) {
    const fair = side === 'bull' ? parity.fair.call : parity.fair.put;
    if (fair < limit) { limit = fair; reasons.push('parity'); }
  }
  if (neigh && !neigh.ok && neigh.expected < limit) { limit = neigh.expected; reasons.push('neighbour'); }
  limit = r2(Math.max(0.05, limit));
  const ceilingOk = limit <= maxFrac * W + 1e-9;
  return {
    ok: ceilingOk,
    reason: ceilingOk ? (reasons[0] || null) : 'ceiling',
    limit, quotedMid: q.mid, ask: q.ask, crossOverMid: q.crossOverMid, perLegCross: q.perLeg,
    maxAllowed: r2(maxFrac * W), fracOfWidth: r2(limit / W),
    adjusted: limit !== q.mid, checks: { parity, neighbour: neigh },
  };
}

module.exports = { netQuote, parityCheck, neighbourCheck, validateOpen, bullCallLegs, bearPutLegs };
