// Unit tests for the candle-spread pure logic. Run: node tests/nogit/candle-spread-logic.test.js
const L = require('../../src/candle-spread/spread-logic');

let pass = 0, fail = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; }
  else { fail++; console.log(`FAIL ${label}\n   got:    ${a}\n   expect: ${e}`); }
}

// --- classification: normal candles ---
const prior = { open: 100, high: 110, low: 90, close: 105 };
// bull: close>open AND high>prior.high
eq(L.classifyOpen({ open: 105, high: 111, low: 104, close: 108 }, prior, null), 'bull', 'strict bull');
// up close but did NOT break prior high -> neutral
eq(L.classifyOpen({ open: 105, high: 109, low: 104, close: 108 }, prior, null), null, 'up but no high break -> neutral');
// bear: close<open AND low<prior.low
eq(L.classifyOpen({ open: 105, high: 106, low: 89, close: 101 }, prior, null), 'bear', 'strict bear');
// down close but did NOT break prior low -> neutral
eq(L.classifyOpen({ open: 105, high: 106, low: 91, close: 101 }, prior, null), null, 'down but no low break -> neutral');

// --- first candle: Bollinger gate (no prior) ---
const bands = { upper: 120, lower: 80 };
eq(L.classifyOpen({ open: 100, high: 108, low: 99, close: 115 }, null, bands), 'bull', 'first green inside upper band -> bull');
eq(L.classifyOpen({ open: 100, high: 125, low: 99, close: 122 }, null, bands), null, 'first green ABOVE upper band -> skip');
eq(L.classifyOpen({ open: 100, high: 101, low: 82, close: 85 }, null, bands), 'bear', 'first red inside lower band -> bear');
eq(L.classifyOpen({ open: 100, high: 101, low: 70, close: 78 }, null, bands), null, 'first red BELOW lower band -> skip');
eq(L.classifyOpen({ open: 100, high: 101, low: 99, close: 100 }, null, bands), null, 'flat -> null');

// --- simpleDirection (cover trigger) ---
eq(L.simpleDirection({ open: 100, close: 101 }), 'bull', 'simple bull');
eq(L.simpleDirection({ open: 100, close: 99 }), 'bear', 'simple bear');

// --- shouldCover (confirmed-reversal cover rule) ---
// Held BULL: prior (green) candle high=110 low=90. Reversal is a red candle.
const priorGreen = { open: 100, high: 110, low: 90, close: 108 };
// red that did NOT make a new high (110) -> cover
eq(L.shouldCover('bull', { open: 108, high: 109, low: 100, close: 101 }, priorGreen, null), true, 'bull: red no new high -> cover');
// red that DID make a new high (>110) -> do NOT cover (trend intact)
eq(L.shouldCover('bull', { open: 108, high: 112, low: 100, close: 101 }, priorGreen, null), false, 'bull: red broke prior high -> no cover');
// green candle (same dir) never triggers a bull cover
eq(L.shouldCover('bull', { open: 100, high: 115, low: 99, close: 112 }, priorGreen, null), false, 'bull: green candle -> no cover');
// Bollinger override: prior green closed ABOVE upper band -> cover regardless, even if new high
eq(L.shouldCover('bull', { open: 108, high: 112, low: 100, close: 101 }, priorGreen, { upper: 107, lower: 80 }), true, 'bull: prior above upper band -> cover regardless of new high');

// Held BEAR: prior (red) candle high=110 low=90. Reversal is a green candle.
const priorRed = { open: 108, high: 110, low: 90, close: 92 };
// green that did NOT make a new low (90) -> cover
eq(L.shouldCover('bear', { open: 92, high: 100, low: 91, close: 99 }, priorRed, null), true, 'bear: green no new low -> cover');
// green that DID make a new low (<90) -> do NOT cover
eq(L.shouldCover('bear', { open: 92, high: 100, low: 88, close: 99 }, priorRed, null), false, 'bear: green broke prior low -> no cover');
// red candle (same dir) never triggers a bear cover
eq(L.shouldCover('bear', { open: 100, high: 101, low: 85, close: 88 }, priorRed, null), false, 'bear: red candle -> no cover');
// Bollinger override: prior red closed BELOW lower band -> cover regardless, even if new low
eq(L.shouldCover('bear', { open: 92, high: 100, low: 88, close: 99 }, priorRed, { upper: 120, lower: 95 }), true, 'bear: prior below lower band -> cover regardless of new low');

// none / edge
eq(L.shouldCover('none', { open: 100, high: 101, low: 99, close: 99 }, priorRed, null), false, 'none -> never cover');
eq(L.shouldCover('bull', { open: 108, high: 109, low: 100, close: 101 }, null, null), true, 'bull: no prior candle -> fall back to cover');

// --- center strike + spread strikes (grid 10, width 20) ---
eq(L.centerStrike(28273, 10), 28270, 'center 28273 -> 28270');
eq(L.centerStrike(28277, 10), 28270, 'center 28277 -> 28270 (nearest grid BELOW, per spec)');
eq(L.centerStrike(28280, 10), 28280, 'center exactly on grid -> itself');
eq(L.spreadStrikes(28270, 20), { lower: 28260, upper: 28280 }, 'legs 28260/28280');

// --- open legs ---
eq(L.openLegs('bull', 28260, 28280),
  [{ side: 'long', type: 'C', strike: 28260 }, { side: 'short', type: 'C', strike: 28280 }], 'bull call legs');
eq(L.openLegs('bear', 28260, 28280),
  [{ side: 'long', type: 'P', strike: 28280 }, { side: 'short', type: 'P', strike: 28260 }], 'bear put legs');
eq(L.shortStrikeOf('bull', 28260, 28280), 28280, 'bull short = upper');
eq(L.shortStrikeOf('bear', 28260, 28280), 28260, 'bear short = lower');

// --- cover legs (debit-offset default) ---
eq(L.coverLegs('bull', 28280, 20, 'debit-offset'),
  [{ side: 'short', type: 'P', strike: 28280 }, { side: 'long', type: 'P', strike: 28300 }], 'cover bull -> bear put short28280/long28300');
eq(L.coverLegs('bear', 28260, 20, 'debit-offset'),
  [{ side: 'short', type: 'C', strike: 28260 }, { side: 'long', type: 'C', strike: 28240 }], 'cover bear -> bull call short28260/long28240');

// --- cover legs (credit style -> butterfly with covered spread) ---
eq(L.coverLegs('bull', 28280, 20, 'credit'),
  [{ side: 'short', type: 'C', strike: 28280 }, { side: 'long', type: 'C', strike: 28300 }], 'credit cover bull -> bear-call short28280/long28300');

// --- pricing ---
// CEILING CONTRACT (ab922ee, 2026-09-05): the default capFrac is 0.65, and debitLimit no longer CLAMPS
// the limit down to the cap. Clamping booked a sub-market price that would never fill; the ceiling is now
// a GATE — debitLimit reports `exceedsCap` and the caller (trader.buildOpenAtStrikes) declines the open.
// width 20 -> cap 13. mark 8.20 is under it -> limit 8.20
eq(L.debitLimit(20.00, 11.80, 20, 0.05), { mark: 8.2, cap: 13, exceedsCap: false, limit: 8.2 }, 'mark under cap -> mark');
// mark 15 is OVER the $13 ceiling: flagged, NOT clamped — the limit still reports the real mark
eq(L.debitLimit(27.00, 12.00, 20, 0.05).exceedsCap, true, 'mark over cap -> exceedsCap');
eq(L.debitLimit(27.00, 12.00, 20, 0.05).limit, 15, 'mark over cap -> limit is the mark, not the cap');
// the old 52.5% ceiling would have flagged this; at 65% it passes
eq(L.debitLimit(25.00, 12.00, 20, 0.05).exceedsCap, false, 'mark 13 is AT the 65% ceiling -> allowed');
// width 40 -> cap 26; mark 22 is under it
eq(L.debitLimit(30.00, 8.00, 40, 0.05), { mark: 22, cap: 26, exceedsCap: false, limit: 22 }, 'width40 cap 26');
// tick rounding to 0.05: mark 8.23 -> 8.25
eq(L.debitLimit(20.00, 11.77, 20, 0.05).limit, 8.25, 'round 8.23 -> 8.25');
// tick 0.01
eq(L.debitLimit(20.00, 11.77, 20, 0.01).limit, 8.23, 'tick 0.01 -> 8.23');

// --- width validation ---
eq(L.validateWidth(20, 10), true, 'width 20 / grid 10 ok (even multiple)');
eq(L.validateWidth(10, 10), false, 'width 10 / grid 10 -> odd multiple (legs off-center)');
eq(L.validateWidth(50, 25), true, 'width 50 / grid 25 -> 2 steps (even) ok');
eq(L.validateWidth(25, 25), false, 'width 25 / grid 25 -> 1 step (odd) invalid');
eq(L.validateWidth(40, 10), true, 'width 40 / grid 10 ok');

// --- cover-geometry candidates -------------------------------------------
// Covered BULL: opened bull call [28260/28280], short = 28280, width 20, incr 10.
// anchor = box when price sits at the short strike (last open, no retrace)
eq(L.coverAnchorLong('bull', 28280, 28285, 10), 28280, 'bull anchor: price at short -> box');
// anchor = tent when price is a full 2*width above the short strike
eq(L.coverAnchorLong('bull', 28280, 28320, 10), 28300, 'bull anchor: price 2w above -> tent (short+width)');
// anchor slides above the tent for deeper moves
eq(L.coverAnchorLong('bull', 28280, 28340, 10), 28310, 'bull anchor: deep -> above tent');
// shallow -> just box + one neighbor
eq(L.coverCandidateLongs('bull', 28280, 28285, 10, 5), [28280, 28290], 'bull shallow candidates: box + one up');
// deep -> more candidates, box always included, all >= short
eq(L.coverCandidateLongs('bull', 28280, 28340, 10, 5), [28280, 28290, 28300, 28310, 28320, 28330, 28340], 'bull deep candidates');
// candidate legs: box vs tent
eq(L.candidateCoverLegs('bull', 28280, 20), [{ side: 'short', type: 'P', strike: 28260 }, { side: 'long', type: 'P', strike: 28280 }], 'bull box legs (bear put 28260/28280)');
eq(L.candidateCoverLegs('bull', 28300, 20), L.coverLegs('bull', 28280, 20, 'debit-offset'), 'bull tent candidate == fixed coverLegs');
// Covered BEAR mirror
eq(L.coverAnchorLong('bear', 28260, 28255, 10), 28260, 'bear anchor: price at short -> box');
eq(L.coverAnchorLong('bear', 28260, 28220, 10), 28240, 'bear anchor: price 2w below -> tent (short-width)');
eq(L.candidateCoverLegs('bear', 28240, 20), L.coverLegs('bear', 28260, 20, 'debit-offset'), 'bear tent candidate == fixed coverLegs');

// --- peak extra (potential above the guaranteed floor) ---
eq(L.coverPeakExtra(28280, 28280, 20), 0, 'box peak extra 0');
eq(L.coverPeakExtra(28280, 28300, 20), 20, 'tent peak extra = width');
eq(L.coverPeakExtra(28280, 28290, 20), 10, 'mid peak extra = 10');
eq(L.coverPeakExtra(28280, 28320, 20), 20, 'beyond-tent peak extra capped at width');

// --- combined value >= width everywhere (box locks flat = width) ---
// covered bull [long C28260, short C28280] + box cover [short P28260, long P28280]
const coveredBull = [{ side: 'long', type: 'C', strike: 28260 }, { side: 'short', type: 'C', strike: 28280 }];
const boxCover = L.candidateCoverLegs('bull', 28280, 20);
eq(L.legsPayoff(coveredBull, 28250) + L.legsPayoff(boxCover, 28250), 20, 'box value at 28250 = width');
eq(L.legsPayoff(coveredBull, 28270) + L.legsPayoff(boxCover, 28270), 20, 'box value at 28270 = width');
eq(L.legsPayoff(coveredBull, 28300) + L.legsPayoff(boxCover, 28300), 20, 'box value at 28300 = width');
// tent retains upside: value at the short strike = 2*width
const tentCover = L.candidateCoverLegs('bull', 28300, 20);
eq(L.legsPayoff(coveredBull, 28280) + L.legsPayoff(tentCover, 28280), 40, 'tent value at short strike = 2*width');

// --- cover limit (skew-aware: mark + 1 tick, no sub-market cap) ---
eq(L.coverLimitFromMark(8.20, 20, 0.05), 8.25, 'cover limit = mark + tick');
eq(L.coverLimitFromMark(14.00, 20, 0.05), 14.05, 'cover limit not capped below market (was 10.5)');
eq(L.coverLimitFromMark(19.99, 20, 0.05), 19.95, 'cover limit bounded by width - tick ceiling');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
