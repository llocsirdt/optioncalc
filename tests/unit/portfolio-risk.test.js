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

test('results come back sorted best-to-worst by rankScore', () => {
  const legs = [
    { qty: 1, type: 'p', strike: 28130, cost: 5461 },
    { qty: -1, type: 'p', strike: 28090, cost: -3709 }
  ];
  const { candidates } = PortfolioRisk.findPortfolioHedgeCandidates(legs, WIDE_CHAIN);
  assert.ok(candidates.length > 0, 'expected at least one improving candidate');
  for (let i = 1; i < candidates.length; i++) {
    assert.ok(candidates[i - 1].rankScore >= candidates[i].rankScore, 'candidates should be sorted best-to-worst by rankScore');
  }
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
