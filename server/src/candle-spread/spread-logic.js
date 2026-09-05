/**
 * Pure, deterministic logic for the candle-spread trader (no I/O — unit-testable).
 *
 * Strategy summary (see project spec): on each 15-min candle close, open a $W debit
 * spread centered on the close (bull call on a green candle, bear put on a red one),
 * and on a direction reversal cover the prior uncovered spreads with an offsetting
 * spread that shares the short strike. All the "why" behaviors are commented so they
 * are easy to find and change later.
 */

// --- Candle classification -------------------------------------------------

// Direction by close-vs-open ONLY (no high/low break). Used for the COVER trigger:
// a candle whose simple direction is opposite our held direction covers those spreads,
// regardless of whether it broke the prior high/low.
function simpleDirection(candle) {
  if (candle.close > candle.open) return 'bull';
  if (candle.close < candle.open) return 'bear';
  return 'flat';
}

// Does this candle qualify to OPEN a new spread, and on which side? Returns
// 'bull' | 'bear' | null (null = neutral / no open — an intentionally isolated
// branch so we can add logic for neutral candles later).
//
//  - Normal candle: green(bull) = close>open AND high > prior candle's high;
//                   red(bear)   = close<open AND low  < prior candle's low.
//  - FIRST candle of the day (no prior candle): replace the high/low-break test with
//    the 15m Bollinger(20,2) — still requires the close-vs-open color:
//       green only if close is BELOW the upper band (inside);
//       red   only if close is ABOVE the lower band (inside).
//    If the close is outside the relevant band, we skip (no open).
function classifyOpen(candle, priorCandle, bands /* {upper, lower} | null */) {
  const dir = simpleDirection(candle);
  if (dir === 'flat') return null;

  if (priorCandle) {
    if (dir === 'bull') return candle.high > priorCandle.high ? 'bull' : null;
    return candle.low < priorCandle.low ? 'bear' : null;
  }

  // First candle of the day — Bollinger gate.
  if (!bands || bands.upper == null || bands.lower == null) return null;
  if (dir === 'bull') return candle.close < bands.upper ? 'bull' : null;
  return candle.close > bands.lower ? 'bear' : null;
}

// Whether a reversal candle CONFIRMS a reversal strongly enough to cover the held
// (uncovered) spreads. Replaces the naive "any opposite close-vs-open" trigger, which
// gave false positives (see the run where the first 3 opens flip-flopped). Rule:
//   - Only a candle closing OPPOSITE the held direction can trigger a cover.
//   - Held BULL, reversal is a RED candle: cover only if the red candle did NOT make a
//     new high vs the prior candle (the uptrend failed to extend). If it broke the prior
//     HIGH, the trend is intact -> do NOT cover.
//   - Held BEAR, reversal is a GREEN candle: cover only if it did NOT make a new low.
//   - Bollinger override: if the PRIOR (trend) candle closed OUTSIDE its band on the
//     trend-extreme side (bull: above upper band; bear: below lower band), the move is
//     over-extended -> cover REGARDLESS of the high/low break.
// priorBands = the prior candle's own Bollinger(20,2) { upper, lower } (or null).
function shouldCover(heldDirection, candle, priorCandle, priorBands) {
  const dir = simpleDirection(candle);
  if (heldDirection === 'bull') {
    if (dir !== 'bear') return false;
    if (!priorCandle) return true; // can't evaluate the break -> fall back to covering
    if (priorBands && priorBands.upper != null && priorCandle.close > priorBands.upper) return true; // over-extended up
    return !(candle.high > priorCandle.high); // cover unless it made a NEW HIGH
  }
  if (heldDirection === 'bear') {
    if (dir !== 'bull') return false;
    if (!priorCandle) return true;
    if (priorBands && priorBands.lower != null && priorCandle.close < priorBands.lower) return true; // over-extended down
    return !(candle.low < priorCandle.low); // cover unless it made a NEW LOW
  }
  return false; // heldDirection === 'none'
}

// --- Strike / leg construction --------------------------------------------

// Greatest grid strike at or below the close (the spread is CENTERED here). Off-grid
// strikes (a stray $5 strike on a 10-grid) are ignored by construction, since we only
// ever land on multiples of strikeIncrement.
function centerStrike(close, strikeIncrement) {
  return Math.floor(close / strikeIncrement) * strikeIncrement;
}

// The two strikes of a spread centered on centerStrike. spreadWidth must be an even
// multiple of strikeIncrement so both legs land on the grid (validated at run config).
function spreadStrikes(center, spreadWidth) {
  const half = spreadWidth / 2;
  return { lower: center - half, upper: center + half };
}

// Strike selection with an optional ITM SHIFT (the $40 short-ATM geometry). shift=0 is
// ATM-centered (== spreadStrikes). For a BULL the spread moves DOWN by `shift` (short leg toward
// ATM, long leg deeper ITM); mirror for a BEAR. shift must also be a grid multiple. Matches
// backtest-width.makeGeo, so a $40 short-ATM ported run selects the same strikes as the backtest.
function spreadStrikesShifted(center, spreadWidth, shift, side) {
  const half = spreadWidth / 2;
  if (side === 'bull') { const upper = center + half - shift; return { lower: upper - spreadWidth, upper }; }
  const lower = center - half + shift; return { lower, upper: lower + spreadWidth };
}

// Legs of an OPENING spread. Bull = call debit (long lower / short upper); bear = put
// debit (long upper / short lower). Each leg: { side:'long'|'short', type:'C'|'P', strike }.
function openLegs(direction, lower, upper) {
  if (direction === 'bull') {
    return [ { side: 'long', type: 'C', strike: lower }, { side: 'short', type: 'C', strike: upper } ];
  }
  return [ { side: 'long', type: 'P', strike: upper }, { side: 'short', type: 'P', strike: lower } ];
}

// The short-strike of an opened spread (bull call short = upper call; bear put short = lower put).
function shortStrikeOf(direction, lower, upper) {
  return direction === 'bull' ? upper : lower;
}

// Legs of a COVER for an existing spread. Both styles SHARE the covered spread's short
// strike and extend spreadWidth into the opposite direction.
//   debit-offset (default):
//     cover a bull call (short S) -> bear put:  short put  S, long put  S+W  (forms a "tent")
//     cover a bear put  (short S) -> bull call: short call S, long call S-W
//   credit (option): a bear-call / bull-put CREDIT spread sharing S, which nets with the
//     covered debit spread into a long butterfly centered on S. NOTE: credit pricing is a
//     separate rule still to be defined (see engine) — geometry only here.
function coverLegs(coveredDirection, shortStrike, spreadWidth, coverStyle) {
  if (coverStyle === 'credit') {
    if (coveredDirection === 'bull') {
      return [ { side: 'short', type: 'C', strike: shortStrike }, { side: 'long', type: 'C', strike: shortStrike + spreadWidth } ];
    }
    return [ { side: 'short', type: 'P', strike: shortStrike }, { side: 'long', type: 'P', strike: shortStrike - spreadWidth } ];
  }
  // debit-offset
  if (coveredDirection === 'bull') {
    return [ { side: 'short', type: 'P', strike: shortStrike }, { side: 'long', type: 'P', strike: shortStrike + spreadWidth } ];
  }
  return [ { side: 'short', type: 'C', strike: shortStrike }, { side: 'long', type: 'C', strike: shortStrike - spreadWidth } ];
}

// --- Cover-geometry candidates (see project-candle-spread-cover-geometry) -----
// The fixed tent (coverLegs above) locks a loss on the LAST stacked open when the
// reversal fires before price retraces past its entry. Instead we generate a small set
// of candidate covers and let a selector pick. Each candidate is parameterized by its
// LONG strike; the short leg is longStrike ∓ width. For a covered BULL (short = Kup) the
// cover is a bear put with long strike >= Kup (box = long Kup; tent = long Kup+width;
// deeper = long further above). Mirror for a covered BEAR (short = Klow), a bull call
// with long strike <= Klow. Any longStrike on the correct side of the short leg keeps the
// combined (covered spread + cover) value >= width EVERYWHERE — so the guaranteed floor
// (width − openDebit − coverDebit) formula holds for every candidate, and there is never
// net adverse (old-direction) risk.

// Half-distance anchor: place the cover's long leg ~halfway between the underlying and the
// covered short strike. Rounds to the grid and clamps to the valid side (never inside box).
function coverAnchorLong(coveredSide, shortStrike, underlying, incr) {
  const raw = shortStrike + (underlying - shortStrike) / 2;
  const rounded = Math.round(raw / incr) * incr;
  return coveredSide === 'bull' ? Math.max(shortStrike, rounded) : Math.min(shortStrike, rounded);
}

// Candidate long strikes = anchor ± k increments, where k grows with how deep the move is
// (|underlying − short| in increments) but is hard-capped. The BOX (long = short strike) is
// always included as the guaranteed-floor candidate. Returns sorted, de-duped, valid-side longs.
function coverCandidateLongs(coveredSide, shortStrike, underlying, incr, kCap = 5) {
  const anchor = coverAnchorLong(coveredSide, shortStrike, underlying, incr);
  const depth = Math.abs(underlying - shortStrike) / incr;
  const k = Math.max(1, Math.min(kCap, Math.round(depth / 2)));
  const set = new Set([shortStrike]); // box always in the set
  for (let j = -k; j <= k; j++) {
    const Lstrike = anchor + j * incr;
    if (coveredSide === 'bull' ? Lstrike >= shortStrike : Lstrike <= shortStrike) set.add(Lstrike);
  }
  return [...set].sort((a, b) => a - b);
}

// Legs of a cover with a chosen long strike (width = spreadWidth). Generalizes coverLegs
// (which is this at longStrike = short ± width, i.e. the tent).
//   bull cover -> bear put: short P (long−width), long P (long)
//   bear cover -> bull call: long C (long), short C (long+width)
function candidateCoverLegs(coveredSide, longStrike, spreadWidth) {
  if (coveredSide === 'bull') {
    return [ { side: 'short', type: 'P', strike: longStrike - spreadWidth }, { side: 'long', type: 'P', strike: longStrike } ];
  }
  return [ { side: 'short', type: 'C', strike: longStrike + spreadWidth }, { side: 'long', type: 'C', strike: longStrike } ];
}

// Peak EXTRA value a candidate retains above the guaranteed width floor:
// = min(width, |long − short|). Box -> 0 (locked flat); tent (|long−short| = width) -> width
// (can reach 2×width near the short strike); deeper -> still capped at width. This is the
// "potential" a selector weighs against the guaranteed floor.
function coverPeakExtra(shortStrike, longStrike, spreadWidth) {
  return Math.min(spreadWidth, Math.abs(longStrike - shortStrike));
}

// Signed intrinsic payoff of a set of {side,type,strike} legs at an expiry price (per 1x,
// per point — caller scales by 100 × qty). Long adds intrinsic, short subtracts.
function legsPayoff(legs, price) {
  let v = 0;
  for (const leg of legs) {
    const intrinsic = leg.type === 'C' ? Math.max(price - leg.strike, 0) : Math.max(leg.strike - price, 0);
    v += (leg.side === 'long' ? 1 : -1) * intrinsic;
  }
  return v;
}

// --- Pricing ---------------------------------------------------------------

function roundToTick(price, tick) {
  return Math.round(price / tick) * tick;
}

// Cover limit under the new (skew-aware) pricing: pay the real spread mark + 1 tick toward
// the ask so it fills, bounded by a loose sanity ceiling (width − 1 tick) and a tick floor.
// No sub-market cap (unlike debitLimit's width/2×1.05, which suppressed fills on ATM spreads).
function coverLimitFromMark(mark, spreadWidth, tick) {
  const ceil = spreadWidth - tick;
  const limit = roundToTick(mark + tick, tick);
  return round2(Math.max(tick, Math.min(limit, ceil)));
}

// Net-debit limit for an OPEN or a debit-offset COVER.
//   mark  = longMid - shortMid (the spread's net mid)
//   cap   = spreadWidth * capFrac (the user's risk/reward ceiling, default 65% of width)
//   limit = the real mark, rounded to the chain's tick.
// `exceedsCap` reports that the spread costs MORE than the ceiling allows — the caller decides. For an
// OPEN that means DECLINE (buildOpenAtStrikes returns {declined}); the old behaviour was to silently send
// at the cap, i.e. a limit order BELOW the market, which does not fill live and which the backtest counted
// as a fill anyway. Never price a trade you would refuse to make.
// Returns { mark, cap, exceedsCap, limit }. Caller should treat limit <= 0 as invalid (bad quotes).
function debitLimit(longMid, shortMid, spreadWidth, tick, capFrac = 0.65) {
  const mark = round2(longMid - shortMid);
  const cap = round2(spreadWidth * capFrac);
  return { mark, cap, exceedsCap: mark > cap, limit: round2(roundToTick(mark, tick)) };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// spreadWidth must be a positive, even multiple of strikeIncrement so both legs land on
// the grid and the center offset (width/2) is itself a grid step.
function validateWidth(spreadWidth, strikeIncrement) {
  if (!(spreadWidth > 0) || !(strikeIncrement > 0)) return false;
  const steps = spreadWidth / strikeIncrement;
  return Number.isInteger(steps) && steps % 2 === 0;
}

module.exports = {
  simpleDirection,
  classifyOpen,
  shouldCover,
  centerStrike,
  spreadStrikes,
  spreadStrikesShifted,
  openLegs,
  shortStrikeOf,
  coverLegs,
  coverAnchorLong,
  coverCandidateLongs,
  candidateCoverLegs,
  coverPeakExtra,
  legsPayoff,
  roundToTick,
  debitLimit,
  coverLimitFromMark,
  validateWidth
};
