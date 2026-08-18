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

// --- Pricing ---------------------------------------------------------------

function roundToTick(price, tick) {
  return Math.round(price / tick) * tick;
}

// Net-debit limit for an OPEN or a debit-offset COVER.
//   mark  = longMid - shortMid (the spread's net mid)
//   cap   = spreadWidth/2 * 1.05
//   limit = min(cap, mark), rounded to the chain's tick, and never allowed to exceed the cap.
// Returns { mark, cap, limit }. Caller should treat limit <= 0 as invalid (bad quotes).
function debitLimit(longMid, shortMid, spreadWidth, tick) {
  const mark = round2(longMid - shortMid);
  const cap = round2((spreadWidth / 2) * 1.05);
  let limit = roundToTick(Math.min(cap, mark), tick);
  if (limit > cap) limit = Math.floor(cap / tick) * tick; // never exceed the cap
  return { mark, cap, limit: round2(limit) };
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
  openLegs,
  shortStrikeOf,
  coverLegs,
  roundToTick,
  debitLimit,
  validateWidth
};
