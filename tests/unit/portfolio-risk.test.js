#!/usr/bin/env node

/**
 * Regression tests for shared/portfolio-risk.js's findPortfolioHedgeCandidates —
 * the aggregate N-leg hedge search. Run with: node tests/unit/portfolio-risk.test.js
 *
 * No external test framework — plain Node + assert, matching this repo's
 * existing convention. Exits non-zero on any failure so it can gate CI/commits.
 */

const assert = require('assert');
const path = require('path');

const PortfolioRisk = require(path.join(__dirname, '../../shared/portfolio-risk.js'));

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

// Same linear-premium fixture used by tests/unit/spread-hedge-strategy.test.js,
// so results are directly comparable between the two panels.
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

console.log('shared/portfolio-risk.js — findPortfolioHedgeCandidates');

test('results come back sorted best-to-worst by locked-profit tier, then by rankScore within a tier', () => {
  // Not a plain rankScore sort: a candidate with a small locked loss but huge
  // upside/gap should NOT automatically outrank one with a genuine locked
  // profit but little upside (see git history — reweighting a single
  // continuous score couldn't fix this without breaking something else).
  const legs = [
    { qty: 1, type: 'p', strike: 28130, cost: 5461 },
    { qty: -1, type: 'p', strike: 28090, cost: -3709 }
  ];
  const { candidates } = PortfolioRisk.findPortfolioHedgeCandidates(legs, WIDE_CHAIN);
  assert.ok(candidates.length > 0, 'expected at least one improving candidate');
  assert.deepStrictEqual(
    candidates.slice().sort(PortfolioRisk.compareCandidatesByTier).map(c => c.legs),
    candidates.map(c => c.legs),
    'candidates should already come back sorted by compareCandidatesByTier'
  );
  for (let i = 1; i < candidates.length; i++) {
    const prevTier = Math.floor(candidates[i - 1].lockedFraction / 0.05);
    const curTier = Math.floor(candidates[i].lockedFraction / 0.05);
    assert.ok(prevTier >= curTier, 'locked-profit tier should never increase further down the list');
    if (prevTier === curTier) {
      assert.ok(candidates[i - 1].rankScore >= candidates[i].rankScore, 'within the same tier, candidates should be sorted best-to-worst by rankScore');
    }
  }
});

test('compareCandidatesByTier: a modest locked profit outranks a bigger-upside locked loss in a different tier', () => {
  const modestProfit = { legs: [], lockedFraction: 0.02, rankScore: 0.02 };       // tier 0
  const bigUpsideSmallLoss = { legs: [], lockedFraction: -0.03, rankScore: 0.25 }; // tier -1, much higher rankScore
  const sorted = [bigUpsideSmallLoss, modestProfit].sort(PortfolioRisk.compareCandidatesByTier);
  assert.strictEqual(sorted[0], modestProfit, 'the locked-profit candidate should come first despite its much lower rankScore');
});

test('compareCandidatesByTier: within the same tier, rankScore (upside x gap) still decides the order', () => {
  const a = { legs: [], lockedFraction: -0.01, rankScore: 0.10 };
  const b = { legs: [], lockedFraction: -0.02, rankScore: 0.05 }; // same tier as a (both floor to -1 at width 0.05)
  const sorted = [b, a].sort(PortfolioRisk.compareCandidatesByTier);
  assert.strictEqual(sorted[0], a, 'higher rankScore should win when both candidates are in the same locked-profit tier');
});

test('every candidate has a label, rankScore, and strikeGapWidth field', () => {
  const legs = [
    { qty: 1, type: 'p', strike: 28130, cost: 5461 },
    { qty: -1, type: 'p', strike: 28090, cost: -3709 }
  ];
  const { candidates } = PortfolioRisk.findPortfolioHedgeCandidates(legs, WIDE_CHAIN);
  candidates.forEach(c => {
    assert.strictEqual(typeof c.label, 'string');
    assert.strictEqual(typeof c.rankScore, 'number');
    assert.strictEqual(typeof c.strikeGapWidth, 'number');
    assert.ok(c.strikeGapWidth >= 0, 'strikeGapWidth should never be negative');
  });
});

test('the exact box-equivalent candidate (opposite type, same strikes as the position) has a zero-credit upside', () => {
  // The bull_call_spread +1C28090,-1C28130 mirrors the position's own strikes
  // exactly, same as "Exact offset" in the single-spread panel — its short
  // strike coincides with an existing position strike, so strikeGapWidth
  // should be 0 there too.
  const legs = [
    { qty: 1, type: 'p', strike: 28130, cost: 5461 },
    { qty: -1, type: 'p', strike: 28090, cost: -3709 }
  ];
  const { candidates } = PortfolioRisk.findPortfolioHedgeCandidates(legs, WIDE_CHAIN);
  const box = candidates.find(c => c.strategy === 'bull_call_spread' && c.legs.some(l => l.strike === 28090) && c.legs.some(l => l.strike === 28130));
  assert.ok(box, 'expected to find the box-equivalent bull_call_spread candidate');
  assert.strictEqual(box.strikeGapWidth, 0, 'its short strike (28090) coincides with an existing position strike');
});

test('rankScore matches the shared rankCandidateScore formula given the same inputs', () => {
  const legs = [
    { qty: 1, type: 'p', strike: 28130, cost: 5461 },
    { qty: -1, type: 'p', strike: 28090, cost: -3709 }
  ];
  const { candidates } = PortfolioRisk.findPortfolioHedgeCandidates(legs, WIDE_CHAIN);
  const c = candidates[0];
  const baselineWidth = 40; // |28130 - 28090|
  const combinedWidth = baselineWidth + c.spreadWidth;
  const combinedMaxValue = combinedWidth * 100;
  const expected = PortfolioRisk.rankCandidateScore(c.lockedInProfit, c.profitPotential, combinedMaxValue, c.strikeGapWidth, combinedWidth);
  approx(c.rankScore, expected, 0.0001, 'rankScore should equal rankCandidateScore(...) recomputed from the candidate\'s own fields');
});

// ============================================================
// findTailRiskHedgeCandidates: a call spread (above the money) + put spread
// (below it) added TOGETHER, for positions where BOTH the far-low and
// far-high price extremes are already underwater — a shape no single 2-leg
// spread can fix (findPortfolioHedgeCandidates only ever adds one spread at
// a time). See git history — the real find here was that scoring each wing
// by its improvement at a single far-out point picked candidates that were
// too narrow/too far out, leaving a gap that made the worst case WORSE; the
// fix scores each wing by its improvement across its whole half of the curve.
// ============================================================

// Short iron condor: sell call spread 110/120, sell put spread 90/80 for a
// combined $800 credit — profits in the middle, loses $200 on EITHER tail
// (symmetric by construction here) once price moves far enough either way.
const DOUBLE_TAILED_LEGS = [
  { qty: -1, type: 'c', strike: 110, cost: -600 },
  { qty: 1, type: 'c', strike: 120, cost: 200 },
  { qty: -1, type: 'p', strike: 90, cost: -600 },
  { qty: 1, type: 'p', strike: 80, cost: 200 }
];
const CONDOR_CHAIN = buildLinearChain(40, 200, 5, 250, -50);

test('findTailRiskHedgeCandidates: finds dual-wing candidates for a double-tailed position, all improving on the baseline', () => {
  const baseline = PortfolioRisk.analyzePortfolioRisk(DOUBLE_TAILED_LEGS);
  assert.ok(baseline.lockedInProfit < 0, 'sanity check: baseline should be underwater at its worst case');

  const { candidates } = PortfolioRisk.findTailRiskHedgeCandidates(DOUBLE_TAILED_LEGS, CONDOR_CHAIN);
  assert.ok(candidates.length > 0, 'expected at least one dual-wing candidate for a double-tailed position');
  candidates.forEach(c => {
    assert.strictEqual(c.family, 'tail-risk');
    assert.strictEqual(c.legs.length, 4, 'a dual-wing candidate should have 2 call legs + 2 put legs');
    assert.ok(c.legs.some(l => l.type.toLowerCase() === 'c'), 'expected a call leg');
    assert.ok(c.legs.some(l => l.type.toLowerCase() === 'p'), 'expected a put leg');
    assert.ok(c.lockedInProfit > baseline.lockedInProfit, 'every candidate should improve on the baseline worst case');
  });
});

test('findTailRiskHedgeCandidates: finds nothing when only one side (or neither) is underwater', () => {
  // A simple bear put spread: worst case only on the upside, not both tails —
  // the single-spread search already covers this, so this search should bail.
  const oneSidedLegs = [
    { qty: 1, type: 'p', strike: 110, cost: 500 },
    { qty: -1, type: 'p', strike: 90, cost: -200 }
  ];
  const { candidates } = PortfolioRisk.findTailRiskHedgeCandidates(oneSidedLegs, CONDOR_CHAIN);
  assert.strictEqual(candidates.length, 0, 'a one-sided loss should not trigger the dual-wing search');
});

test('findTailRiskHedgeCandidates: finds nothing for genuinely unbounded (naked) risk', () => {
  const nakedShortCall = [{ qty: -1, type: 'c', strike: 100, cost: -500 }];
  const { candidates } = PortfolioRisk.findTailRiskHedgeCandidates(nakedShortCall, CONDOR_CHAIN);
  assert.strictEqual(candidates.length, 0, 'a bounded 2-leg-per-side hedge cannot fix truly unbounded naked exposure');
});

// ============================================================
// findLocalDipHedgeCandidates: a butterfly (long 1x / short 2x / long 1x, one
// option type) centered near the worst point, for positions whose worst case
// is a LOCAL DIP somewhere in the middle of the curve — both tails are fine,
// only an interior notch is bad, which neither the single-spread search nor
// the dual-wing tail-risk search is built to fix.
// ============================================================

// Short call butterfly: sell 1x @90, buy 2x @100, sell 1x @110 for a $400 net
// credit. Flat +$400 on BOTH tails (net qty is 0, so it's constant beyond the
// wings on either side), but dips to -$600 exactly at the center (100).
const LOCAL_DIP_LEGS = [
  { qty: -1, type: 'c', strike: 90, cost: -1200 },
  { qty: 2, type: 'c', strike: 100, cost: 1000 },
  { qty: -1, type: 'c', strike: 110, cost: -200 }
];
const BUTTERFLY_CHAIN = buildLinearChain(20, 200, 5, 250, -50);

test('findLocalDipHedgeCandidates: finds butterfly AND condor candidates for a local dip, all improving on the baseline', () => {
  const baseline = PortfolioRisk.analyzePortfolioRisk(LOCAL_DIP_LEGS);
  assert.ok(baseline.lockedInProfit < 0, 'sanity check: baseline should be underwater at its worst case');
  approx(baseline.worstCasePrice, 100, 1, 'the dip should be at the center strike, not near either tail');

  const { candidates } = PortfolioRisk.findLocalDipHedgeCandidates(LOCAL_DIP_LEGS, BUTTERFLY_CHAIN);
  assert.ok(candidates.length > 0, 'expected at least one dual-shape candidate for a local-dip position');

  const butterflies = candidates.filter(c => c.strategy === 'local_dip_butterfly');
  const condors = candidates.filter(c => c.strategy === 'local_dip_condor');
  assert.ok(butterflies.length > 0, 'expected at least one butterfly candidate');
  assert.ok(condors.length > 0, 'expected at least one condor candidate');

  candidates.forEach(c => {
    assert.strictEqual(c.family, 'local-dip');
    assert.ok(c.lockedInProfit > baseline.lockedInProfit, 'every candidate should improve on the baseline worst case');
    if (c.strategy === 'local_dip_butterfly') {
      assert.strictEqual(c.legs.length, 3, 'a butterfly candidate should have exactly 3 legs');
      assert.strictEqual(Math.abs(c.legs.find(l => l.qty < 0).qty), 2, 'the center leg should be the 2x short');
    } else {
      assert.strictEqual(c.legs.length, 4, 'a condor candidate should have exactly 4 legs');
      assert.strictEqual(c.legs.filter(l => l.qty < 0).length, 2, 'a condor should have two distinct short legs');
      assert.ok(c.legs.every(l => Math.abs(l.qty) === 1), 'a condor has no 2x leg, unlike a butterfly');
    }
  });
});

test('findLocalDipHedgeCandidates: the exact inverse butterfly fully cancels the dip back to the flat tail value', () => {
  // +1C90,-2C100,+1C110 is the exact opposite of LOCAL_DIP_LEGS — under this
  // linear pricing model it should cost ~0 and flatten the curve completely,
  // so locked-in profit should equal the original flat tail value (+400).
  const { candidates } = PortfolioRisk.findLocalDipHedgeCandidates(LOCAL_DIP_LEGS, BUTTERFLY_CHAIN);
  const inverse = candidates.find(c => c.legs.some(l => l.strike === 90 && l.qty === 1) && c.legs.some(l => l.strike === 110 && l.qty === 1));
  assert.ok(inverse, 'expected to find the exact-inverse butterfly candidate');
  approx(inverse.lockedInProfit, 400, 1, 'the inverse butterfly should fully flatten the dip back to the tail value');
  approx(inverse.profitPotential, 400, 1, 'with the dip fully filled, best case should equal worst case (flat curve)');
});

test('findLocalDipHedgeCandidates: finds nothing when the worst case is at a tail, not an interior dip', () => {
  // DOUBLE_TAILED_LEGS' worst case sits at the very edge of the sampled
  // range (near price 30) — that's findTailRiskHedgeCandidates' job, not this one.
  const { candidates } = PortfolioRisk.findLocalDipHedgeCandidates(DOUBLE_TAILED_LEGS, BUTTERFLY_CHAIN);
  assert.strictEqual(candidates.length, 0, 'a tail-edge worst case should not trigger the local-dip search');
});

test('findLocalDipHedgeCandidates: finds nothing when there is no loss to fix', () => {
  const profitableLegs = [
    { qty: 1, type: 'c', strike: 90, cost: 1200 },
    { qty: -2, type: 'c', strike: 100, cost: -1000 },
    { qty: 1, type: 'c', strike: 110, cost: 200 }
  ]; // the inverse of LOCAL_DIP_LEGS — already flat and profitable everywhere
  const { candidates } = PortfolioRisk.findLocalDipHedgeCandidates(profitableLegs, BUTTERFLY_CHAIN);
  assert.strictEqual(candidates.length, 0, 'nothing to fix when the worst case is already non-negative');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
