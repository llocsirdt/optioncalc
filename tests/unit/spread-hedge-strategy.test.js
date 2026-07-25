#!/usr/bin/env node

/**
 * Regression tests for shared/spread-hedge-strategy.js — the curated
 * hedge/offset candidate generator. Run with: node tests/unit/spread-hedge-strategy.test.js
 *
 * No external test framework — plain Node + assert, matching this repo's
 * existing convention. Exits non-zero on any failure so it can gate CI/commits.
 */

const assert = require('assert');
const path = require('path');

const SpreadHedgeStrategy = require(path.join(__dirname, '../../shared/spread-hedge-strategy.js'));

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ok - ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL - ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

function approx(actual, expected, tolerance, message) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message}: expected ~${expected} (+/-${tolerance}), got ${actual}`
  );
}

// --- Synthetic chain fixtures ---

// Wide-range, simple linear premium model: callMid decreases $0.10/tick as
// strike rises, putMid increases $0.10/tick as strike rises. Deliberately
// simple so spread costs are hand-computable (see comments at each test).
function buildLinearChain(minStrike, maxStrike, step, callAnchor, putAnchor) {
  const callExp = {};
  const putExp = {};
  for (let strike = minStrike; strike <= maxStrike; strike += step) {
    const callMid = Math.max(1, (callAnchor - strike) / 10);
    const putMid = Math.max(1, (strike - putAnchor) / 10);
    callExp[strike + '.0'] = [{ bid: callMid - 0.25, ask: callMid + 0.25 }];
    putExp[strike + '.0'] = [{ bid: putMid - 0.25, ask: putMid + 0.25 }];
  }
  return {
    call: { '2026-07-17:0': callExp },
    put: { '2026-07-17:0': putExp }
  };
}

const WIDE_CHAIN = buildLinearChain(26000, 29000, 10, 28300, 27900);

function findByLabel(candidates, label) {
  return candidates.filter(c => c.label === label);
}

console.log('shared/spread-hedge-strategy.js');

// ============================================================
// Bear put spread (the user's primary test case): 1p28130@5461,-1p28090@-3709
// ============================================================
test('identifySpread: bear put spread — long/short/width/direction', () => {
  const position = { legs: [
    { qty: 1, type: 'p', strike: 28130, cost: 5461 },
    { qty: -1, type: 'p', strike: 28090, cost: -3709 }
  ] };
  const spec = SpreadHedgeStrategy.identifySpread(position);
  assert.strictEqual(spec.positionType, 'p');
  assert.strictEqual(spec.positionLongStrike, 28130);
  assert.strictEqual(spec.positionShortStrike, 28090);
  assert.strictEqual(spec.width, 40);
  assert.strictEqual(spec.direction, -1);
});

test('bear put spread: "Exact offset" is a box spread — locked == potential, score == 1.0', () => {
  const position = { legs: [
    { qty: 1, type: 'p', strike: 28130, cost: 5461 },
    { qty: -1, type: 'p', strike: 28090, cost: -3709 }
  ] };
  const candidates = SpreadHedgeStrategy.findHedgeCandidates(position, WIDE_CHAIN);
  const exact = findByLabel(candidates, 'Exact offset');
  assert.strictEqual(exact.length, 1, 'expected exactly one "Exact offset" candidate');

  const [c] = exact;
  // Box: long call @ 28090 (== original short put strike), short call @ 28130 (== original long put strike)
  const longLeg = c.legs.find(l => l.qty > 0);
  const shortLeg = c.legs.find(l => l.qty < 0);
  assert.strictEqual(longLeg.type, 'c');
  assert.strictEqual(longLeg.strike, 28090);
  assert.strictEqual(shortLeg.type, 'c');
  assert.strictEqual(shortLeg.strike, 28130);

  // Hand-derived: candidateCost = width * 10 = 400 under this linear model
  // (callMid(28090)=21.0, callMid(28130)=17.0 -> 2100 - 1700 = 400)
  approx(c.cost, 400, 0.01, 'exact-offset candidate cost');
  // totalCost = 1752 (original) + 400 = 2152; box value = 4000 - 2152 = 1848 at every price
  approx(c.lockedInProfit, 1848, 0.5, 'locked-in profit');
  approx(c.profitPotential, 1848, 0.5, 'profit potential');
  approx(c.profitPotentialScore, 1.0, 0.01, 'profit potential score (perfect box)');
});

test('bear put spread: shift family has the right strikes for each labeled tier', () => {
  const position = { legs: [
    { qty: 1, type: 'p', strike: 28130, cost: 5461 },
    { qty: -1, type: 'p', strike: 28090, cost: -3709 }
  ] };
  const candidates = SpreadHedgeStrategy.findHedgeCandidates(position, WIDE_CHAIN);

  const expectedByLabel = {
    'Exact offset': { long: 28090, short: 28130 },
    'Balanced offset': { long: 28070, short: 28110 },
    'Same-strike offset': { long: 28050, short: 28090 },
    'First extended offset': { long: 28030, short: 28070 },
  };

  Object.entries(expectedByLabel).forEach(([label, expected]) => {
    const matches = findByLabel(candidates, label);
    assert.strictEqual(matches.length, 1, `expected exactly one "${label}" candidate`);
    const longLeg = matches[0].legs.find(l => l.qty > 0);
    const shortLeg = matches[0].legs.find(l => l.qty < 0);
    assert.strictEqual(longLeg.strike, expected.long, `${label} long strike`);
    assert.strictEqual(shortLeg.strike, expected.short, `${label} short strike`);
    assert.strictEqual(longLeg.type, 'c', `${label} should be calls (opposite of put position)`);
  });

  // "Same-strike offset" should have a lower locked-in profit than "Exact offset"
  // (per the strategy: less immediate lock, more upside potential) and a higher
  // profit potential.
  const exact = findByLabel(candidates, 'Exact offset')[0];
  const straddle = findByLabel(candidates, 'Same-strike offset')[0];
  assert.ok(straddle.profitPotential > exact.profitPotential, 'straddle should have more profit potential than the box');
});

test('bear put spread: "Wider offset" is anchored at the straddle point with a wider width', () => {
  const position = { legs: [
    { qty: 1, type: 'p', strike: 28130, cost: 5461 },
    { qty: -1, type: 'p', strike: 28090, cost: -3709 }
  ] };
  const candidates = SpreadHedgeStrategy.findHedgeCandidates(position, WIDE_CHAIN);
  const widerOffsets = findByLabel(candidates, 'Wider offset');
  assert.ok(widerOffsets.length >= 1, 'expected at least one "Wider offset" candidate');

  const first = widerOffsets.find(c => c.meta.widthMultiplier === 1.5);
  assert.ok(first, 'expected a widthMultiplier=1.5 "Wider offset" candidate');
  const shortLeg = first.legs.find(l => l.qty < 0);
  const longLeg = first.legs.find(l => l.qty > 0);
  assert.strictEqual(shortLeg.strike, 28090, 'wider offset should still anchor its short leg at the straddle point');
  assert.strictEqual(longLeg.strike, 28030, 'wider offset long strike = 28090 - 1.5*40');
});

test('bear put spread: "same side" credit family starts at min(strike increment, width/2) past the short strike', () => {
  const position = { legs: [
    { qty: 1, type: 'p', strike: 28130, cost: 5461 },
    { qty: -1, type: 'p', strike: 28090, cost: -3709 }
  ] };
  const candidates = SpreadHedgeStrategy.findHedgeCandidates(position, WIDE_CHAIN);
  const creditOffsets = findByLabel(candidates, 'Credit offset');
  assert.strictEqual(creditOffsets.length, 1, 'expected exactly one "Credit offset" candidate');

  const c = creditOffsets[0];
  // $10 strike increment < width/2 ($20), so first offset should be $10, not $20.
  // direction=-1, so offsetShort = 28090 - 10 = 28080, offsetLong = 28080 - 40 = 28040.
  const shortLeg = c.legs.find(l => l.qty < 0);
  const longLeg = c.legs.find(l => l.qty > 0);
  assert.strictEqual(shortLeg.type, 'p', 'same-side family should be puts (same as original)');
  assert.strictEqual(shortLeg.strike, 28080);
  assert.strictEqual(longLeg.strike, 28040);
  assert.ok(c.cost < 0, 'same-side offset should be a net credit (negative cost)');

  // Should NOT reuse the original position's own strikes (28090/28130) — that
  // would just be closing the trade, not a genuine additional hedge.
  assert.notStrictEqual(shortLeg.strike, 28090);
});

test('bear put spread: "same side" first offset equals width/2 when strike increment >= width/2', () => {
  // $20-wide spread with $10 strike increments: min(10, 10) = 10 = width/2 exactly,
  // so there should be no extra distinct tier — same as the normal width/2 step.
  const position = { legs: [
    { qty: 1, type: 'p', strike: 28110, cost: 3000 },
    { qty: -1, type: 'p', strike: 28090, cost: -2000 }
  ] };
  const candidates = SpreadHedgeStrategy.findHedgeCandidates(position, WIDE_CHAIN);
  const creditOffsets = candidates.filter(c => c.family === 'same-side');
  const firstOffset = creditOffsets[0];
  assert.strictEqual(firstOffset.meta.offset, 10, 'first same-side offset should equal width/2 (10) here, not a smaller distinct step');
});

// ============================================================
// Stopping condition beyond the straddle point: a real-data test found that
// checking cost against a cap doesn't reliably track whether a candidate is
// actually still profitable, so the sweep now stops once a candidate's own
// lockedInProfit would go negative (worse than minLockedInProfit) instead.
// ============================================================
test('shift family stops sweeping once a candidate would lock in a loss', () => {
  // Build a chain where premiums spike sharply beyond a certain strike, so a
  // "further extended" candidate's own worst-case turns negative and the sweep stops.
  const callExp = {};
  const putExp = {};
  for (let strike = 27000; strike <= 29000; strike += 10) {
    // Cheap near the position, then a wall of expensive premiums further out
    // in the direction the sweep travels (below 28050).
    const callMid = strike < 28000 ? 500 : Math.max(1, (28300 - strike) / 10);
    putExp[strike + '.0'] = [{ bid: 5, ask: 5.5 }];
    callExp[strike + '.0'] = [{ bid: callMid - 0.25, ask: callMid + 0.25 }];
  }
  const wallChain = { call: { '2026-07-17:0': callExp }, put: { '2026-07-17:0': putExp } };

  const position = { legs: [
    { qty: 1, type: 'p', strike: 28130, cost: 5461 },
    { qty: -1, type: 'p', strike: 28090, cost: -3709 }
  ] };
  const candidates = SpreadHedgeStrategy.findHedgeCandidates(position, wallChain);
  const shiftCandidates = candidates.filter(c => c.family === 'shift');

  // The first three tiers (box/balanced/straddle) must survive regardless of outcome.
  ['Exact offset', 'Balanced offset', 'Same-strike offset'].forEach(label => {
    assert.strictEqual(findByLabel(shiftCandidates, label).length, 1, `${label} should always be included`);
  });
  // But it must NOT sweep forever into the expensive wall.
  assert.ok(shiftCandidates.length < 20, 'sweep should have stopped well before the hard step limit');
  // Every candidate beyond the straddle point should actually be non-negative.
  shiftCandidates
    .filter(c => c.meta.shiftMultiplier > 1)
    .forEach(c => assert.ok(c.lockedInProfit >= 0, `${c.label} should not lock in a loss (got ${c.lockedInProfit})`));
});

// ============================================================
// Generalization: bull call spread as the original position
// (1c28060@6666,-1c28090@-4974 from the user's larger 4-leg test set)
// ============================================================
test('bull call spread: "Exact offset" produces a bear put spread box (generalization check)', () => {
  const position = { legs: [
    { qty: 1, type: 'c', strike: 28060, cost: 6666 },
    { qty: -1, type: 'c', strike: 28090, cost: -4974 }
  ] };
  const spec = SpreadHedgeStrategy.identifySpread(position);
  assert.strictEqual(spec.direction, 1, 'bull call spread should have direction +1');
  assert.strictEqual(spec.width, 30);

  const candidates = SpreadHedgeStrategy.findHedgeCandidates(position, WIDE_CHAIN);
  const exact = findByLabel(candidates, 'Exact offset');
  assert.strictEqual(exact.length, 1);

  const c = exact[0];
  const longLeg = c.legs.find(l => l.qty > 0);
  const shortLeg = c.legs.find(l => l.qty < 0);
  assert.strictEqual(longLeg.type, 'p', 'offset for a bull call spread should be puts');
  // Box: offset short = position long strike (28060), offset long = position short strike (28090)
  assert.strictEqual(shortLeg.strike, 28060);
  assert.strictEqual(longLeg.strike, 28090);

  // Hand-derived: candidateCost = width * 10 = 300 under this linear model
  // (putMid(28090)=19.0, putMid(28060)=16.0 -> 1900 - 1600 = 300)
  approx(c.cost, 300, 0.01, 'exact-offset candidate cost');
  // totalCost = 1692 (6666-4974) + 300 = 1992; box value = 3000 - 1992 = 1008
  approx(c.lockedInProfit, 1008, 0.5, 'locked-in profit');
  approx(c.profitPotential, 1008, 0.5, 'profit potential');
  approx(c.profitPotentialScore, 1.0, 0.01, 'profit potential score (perfect box)');
});

test('bull put (credit) spread: "Exact offset" box is negative (-width*100), but a big enough combined credit still profits', () => {
  // Short put @ 28090 (credit), long put @ 28060 (debit) — net $1600 credit position,
  // same numbers as the user's own worked example (both spreads opened for $1600
  // credit each, box value -3000, net profit +200 regardless of closing price).
  const position = { legs: [
    { qty: -1, type: 'p', strike: 28090, cost: -3500 },
    { qty: 1, type: 'p', strike: 28060, cost: 1900 }
  ] }; // net cost = 1900 - 3500 = -1600

  const callExp = {
    '28060.0': [{ bid: 35.75, ask: 36.25 }], // callMid = 36
    '28090.0': [{ bid: 19.75, ask: 20.25 }]  // callMid = 20
  };
  const chainData = { call: { '2026-07-17:0': callExp }, put: {} };

  const spec = SpreadHedgeStrategy.identifySpread(position);
  assert.strictEqual(spec.direction, 1);
  assert.strictEqual(spec.width, 30);

  const candidates = SpreadHedgeStrategy.findHedgeCandidates(position, chainData);
  const exact = findByLabel(candidates, 'Exact offset');
  assert.strictEqual(exact.length, 1);

  const c = exact[0];
  const longLeg = c.legs.find(l => l.qty > 0);
  const shortLeg = c.legs.find(l => l.qty < 0);
  assert.strictEqual(longLeg.type, 'c', 'offset for a bull put spread should be calls');
  assert.strictEqual(longLeg.strike, 28090);
  assert.strictEqual(shortLeg.strike, 28060);

  // candidateCost = callMid(28090)*100 - callMid(28060)*100 = 2000 - 3600 = -1600 (credit)
  approx(c.cost, -1600, 0.01, 'exact-offset candidate cost (credit)');
  // totalCost = -1600 (original credit) + -1600 (offset credit) = -3200
  // box value for THIS type/direction combination is -width*100 = -3000 (not +3000 —
  // see comment on the bear-put test above; which sign you get depends on the
  // original position's type+direction, not just its width)
  // profit = -3000 - (-3200) = +200, matching the user's own worked example exactly
  approx(c.lockedInProfit, 200, 0.5, 'locked-in profit');
  approx(c.profitPotential, 200, 0.5, 'profit potential');
  approx(c.profitPotentialScore, 1.0, 0.01, 'profit potential score (perfect box, still profitable)');
});

test('bear call (credit) spread: "Exact offset" box is negative (-width*100), but a big enough combined credit still profits', () => {
  // Short call @ 28090 (credit), long call @ 28120 (debit) — net $1600 credit position,
  // mirroring the bull-put case above with calls/puts swapped.
  const position = { legs: [
    { qty: -1, type: 'c', strike: 28090, cost: -3600 },
    { qty: 1, type: 'c', strike: 28120, cost: 2000 }
  ] }; // net cost = 2000 - 3600 = -1600

  const putExp = {
    '28090.0': [{ bid: 19.75, ask: 20.25 }], // putMid = 20
    '28120.0': [{ bid: 35.75, ask: 36.25 }]  // putMid = 36
  };
  const chainData = { call: {}, put: { '2026-07-17:0': putExp } };

  const spec = SpreadHedgeStrategy.identifySpread(position);
  assert.strictEqual(spec.direction, -1);
  assert.strictEqual(spec.width, 30);

  const candidates = SpreadHedgeStrategy.findHedgeCandidates(position, chainData);
  const exact = findByLabel(candidates, 'Exact offset');
  assert.strictEqual(exact.length, 1);

  const c = exact[0];
  const longLeg = c.legs.find(l => l.qty > 0);
  const shortLeg = c.legs.find(l => l.qty < 0);
  assert.strictEqual(longLeg.type, 'p', 'offset for a bear call spread should be puts');
  assert.strictEqual(shortLeg.strike, 28120);
  assert.strictEqual(longLeg.strike, 28090);

  // candidateCost = putMid(28090)*100 - putMid(28120)*100 = 2000 - 3600 = -1600 (credit)
  approx(c.cost, -1600, 0.01, 'exact-offset candidate cost (credit)');
  // totalCost = -1600 + -1600 = -3200; box value = -3000; profit = -3000 - (-3200) = +200
  approx(c.lockedInProfit, 200, 0.5, 'locked-in profit');
  approx(c.profitPotential, 200, 0.5, 'profit potential');
  approx(c.profitPotentialScore, 1.0, 0.01, 'profit potential score (perfect box, still profitable)');
});

test('identifySpread rejects malformed positions', () => {
  assert.throws(() => SpreadHedgeStrategy.identifySpread({ legs: [{ qty: 1, type: 'c', strike: 100 }] }));
  assert.throws(() => SpreadHedgeStrategy.identifySpread({ legs: [
    { qty: 1, type: 'c', strike: 100 }, { qty: 1, type: 'c', strike: 110 }
  ] }), /long leg.*short leg/);
  assert.throws(() => SpreadHedgeStrategy.identifySpread({ legs: [
    { qty: 1, type: 'c', strike: 100 }, { qty: -1, type: 'p', strike: 110 }
  ] }), /same option type/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
