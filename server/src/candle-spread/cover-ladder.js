'use strict';
/**
 * COVER LADDER — work the order instead of resting it once and hoping.
 *
 * WHY THIS EXISTS. On 2026-09-08, the first full live session, 43 of 101 covers never filled. Every one
 * of them was placed at `W - openCost - minLock` — a price derived from what we paid and the profit we
 * demanded, never from the market — and then left untouched for the rest of the day. The unfilled orders
 * sat at a median 40% of the mark at placement. The engine had no mechanism to move a live order's price,
 * so a position whose cover had drifted out of reach simply rode to expiry naked and took the FULL loss
 * instead of a bounded one. That is the foundational principle failing: we do not make money on the opens,
 * we make money on the covers.
 *
 * THE SHAPE (user's design, 2026-09-08):
 *   - START at the IDEAL price — bare break-even, `W - openCost`, which locks nothing but loses nothing.
 *     Not at a loss-locking price: opening there gives away money we might not have had to give.
 *   - Then WORK IT UP incrementally toward the market.
 *   - Stop at a bounded small loss (`lossCapFrac` x W, default 0.10). Better a small realised loss than a
 *     naked position at expiry.
 *
 * ESCALATION IS DRIVEN BY THE UNDERLYING, NOT ONLY THE CLOCK (user, 2026-09-06): *"since the strikes are
 * in $10 increments, basically a move of the underlying by just about 5 points is enough to necessitate a
 * reasonable offer bump... it's less about time and more about what the underlying price is doing."* So a
 * step is earned by EITHER enough elapsed time OR enough underlying movement, whichever comes first — a
 * fast tape escalates fast, a still tape does not churn the book for nothing.
 *
 * WHAT THIS MODULE IS NOT: it does not decide WHETHER to cover, or pick strikes, or send anything. It
 * answers one question — "given how long this has rested and how far the underlying has moved, what limit
 * should be working right now?" — so the policy is testable without a broker.
 */

// STEP TIMING MUST MATCH THE EVALUATION CADENCE. These were written for a sub-minute loop, but BOTH
// engines re-check resting covers once per CANDLE — trader.workRestingCovers from processCandleClose,
// and backtest-v6-5m once per bar. At 45s against a 300s cadence, `restingMs` is already 300,000 at the
// FIRST re-check, so every config maxed out instantly: the ladder never walked, it jumped straight to
// maxPay (the bounded loss). That is what made the first two ladder sweeps look catastrophic — all three
// timing arms returned byte-identical results, which is the tell. 300 = one step per 5m candle.
// Measured on 765 days, v6-20: the old 45s default cost -$1,059,987 against control; 300s/12 steps cost
// -$437,238; 300s/12 with cap 0% cost -$295,223 while lifting fill 54% -> 77%. On the 34-day 1m dual set
// (NDX pricing) the 60-minute walk cut the average losing day 57% and the worst day 53% for $29k of $137k.
const DEFAULTS = {
  stepSeconds: 300,       // a step is earned every candle of resting …
  stepPoints: 5,          // … OR every ~5 points of underlying movement since placement, whichever is more
  steps: 6,               // how many increments span ideal -> maxPay (ignored when stepDollars is set)
  stepDollars: null,      // WIDTH-NEUTRAL alternative to `steps`: concede at most this much per step
  lossCapFrac: 0.10,      // the bounded loss we will accept rather than expire naked (fraction of width)
  neverExceedMark: true,  // don't bid above the market; the fill happens at the market anyway
};

const r2 = (n) => Math.round(n * 100) / 100;

/**
 * The price band this cover may work within.
 *   ideal  = W - openCost            → locks exactly 0
 *   maxPay = ideal + lossCapFrac x W → the most we will pay, i.e. the bounded loss
 * `minLock` only moves the STARTING price, and only for triggers that want a profit floor (an
 * opportunistic cover on a winner). A reversal cover starts at `ideal` because the upside it is buying
 * lives in the TENT the cover forms, not in what the cover itself banks.
 */
function band(W, openCost, opts) {
  const o = { ...DEFAULTS, ...(opts || {}) };
  const ideal = r2(W - openCost);
  const maxPay = r2(ideal + o.lossCapFrac * W);
  return { ideal, maxPay, lossAtMax: r2(-(o.lossCapFrac * W)) };
}

/**
 * How many escalation steps this order has earned. Time OR movement, whichever is further along —
 * they are alternative evidence for the same thing (the market has moved on and our price has not).
 */
function stepsEarned(restingMs, underlyingMovePts, opts) {
  const o = { ...DEFAULTS, ...(opts || {}) };
  const byTime = Math.floor(Math.max(0, restingMs) / (o.stepSeconds * 1000));
  const byMove = Math.floor(Math.abs(underlyingMovePts || 0) / o.stepPoints);
  return Math.min(o.steps, Math.max(byTime, byMove));
}

/**
 * The limit that should be working right now.
 * @param p.spreadWidth      W
 * @param p.openCost         what the open cost, per share
 * @param p.minLock          profit floor for THIS trigger (0 for a reversal cover)
 * @param p.restingMs        how long the current cover has been resting
 * @param p.underlyingMove   points the underlying has moved since the cover was placed
 * @param p.mark             the cover's CURRENT mark, if known
 * @param p.tick             tick increment for rounding
 * @returns { limit, step, ideal, maxPay, start, capped, atMax }
 */
function limitNow(p, opts) {
  const o = { ...DEFAULTS, ...(opts || {}) };
  const W = p.spreadWidth, tick = p.tick || 0.05;
  const { ideal, maxPay } = band(W, p.openCost, o);
  // Where this trigger begins. A profit-demanding start sits BELOW ideal; it can never start above it.
  const start = r2(Math.min(ideal, ideal - (p.minLock || 0)));
  // WIDTH NEUTRALITY. The span is W x (lossCapFrac + minLockFrac), so it scales linearly with width while
  // a fixed `steps` does not — on v6 that is $0.29 per step at $10 and $1.17 at $40, a 4x difference in
  // what each step concedes. The same schedule is therefore far more aggressive on wide spreads, which is
  // what the sweeps kept showing: the ladder helped at $10/$20 and hurt badly at $40 (v6-40 ret/DD 51->28
  // on 765 days, -$70,014 on the 1m dual set). `stepDollars` fixes the CONCESSION PER STEP instead of the
  // step COUNT, so one setting means the same thing at every width; a wider spread simply takes more
  // steps, and so escalates more slowly in time — which is the right instinct for a spread with more room.
  const span = maxPay - start;
  const nSteps = (o.stepDollars > 0)
    ? Math.max(1, Math.ceil(span / o.stepDollars))
    : o.steps;
  const step = stepsEarned(p.restingMs, p.underlyingMove, { ...o, steps: nSteps });
  // Linear walk from `start` to `maxPay` across `nSteps` increments.
  let limit = r2(start + (span * step) / nSteps);
  // Never bid above the market: the fill happens at the market anyway, and a limit above it just
  // advertises how much we were willing to overpay.
  let capped = false;
  if (o.neverExceedMark && p.mark != null && limit > p.mark) { limit = r2(p.mark); capped = true; }
  if (limit > maxPay) { limit = maxPay; capped = true; }
  const q = Math.max(tick, Math.round(limit / tick) * tick);
  return { limit: r2(q), step, steps: nSteps, ideal, maxPay, start, capped, atMax: step >= nSteps };
}

/**
 * Is a reprice worth sending? A cancel/replace is a round trip AND it surrenders queue position at the
 * exchange, so a marginal move actively costs fills rather than winning them.
 *
 * ONE TICK IS THE WRONG BAR. The ladder's own increments are `span / steps` — on a $20 spread with
 * openCost 11.65 and minLock 6 that is $1.33, i.e. 27 ticks. So a tick-level gate is ~27x more sensitive
 * than the mechanism it gates, and it only ever fires in the neverExceedMark case where the limit is
 * pinned to a mark that drifts a few cents every candle. That is pure churn.
 *
 * The real question is "has the ladder ESCALATED?", which is a step change — bounded to `steps` replaces
 * per order per day. `minMove` is the secondary guard for the pinned-to-mark case: default 5% of width
 * ($1.00 on a $20 spread), close to one ladder step, and never less than 2 ticks.
 */
function shouldReprice(currentLimit, nextLimit, tick, opts) {
  if (currentLimit == null || nextLimit == null) return false;
  const t = tick || 0.05;
  const o = opts || {};
  if (o.stepChanged) return Math.abs(nextLimit - currentLimit) >= t - 1e-9;   // a real escalation
  const frac = o.minMoveFrac != null ? o.minMoveFrac : 0.05;
  const minMove = Math.max(2 * t, frac * (o.spreadWidth || 0));
  return Math.abs(nextLimit - currentLimit) >= minMove - 1e-9;
}

module.exports = { limitNow, band, stepsEarned, shouldReprice, DEFAULTS };
