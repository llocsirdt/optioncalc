'use strict';
// TREND-SIDED RAISE RATIO (2026-10-14). Live v7-10 bought C30240/30260 at 2.55 with spot 30,112.8 and a falling 15m
// trend, to repair a valley 157 points ABOVE spot — against the trend. The user: with the trend the raise may be
// cheaper per dollar of lift, against it dearer (sweepable pairs, e.g. 3:1 -> 6:1 with, 5:1 -> 10:1 against).
//
// Run: node server/tests/unit/candle-spread-raise-trend-ratio.test.js
const FR = require('../../src/candle-spread/floor-raise');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

// ── the ratio pair chosen by side ───────────────────────────────────────────────────────────────────
{
  const tr = { dir: -1, withMin: 3, withFar: 6, againstMin: 5, againstFar: 10 };
  ok(JSON.stringify(FR.trendSidedRatios(tr, 4, 8, true, 157)) === '[5,10]', 'bear trend, valley above spot = against');
  ok(JSON.stringify(FR.trendSidedRatios(tr, 4, 8, false, 157)) === '[3,6]', 'bear trend, valley below spot = with');
  ok(JSON.stringify(FR.trendSidedRatios({ ...tr, dir: 1 }, 4, 8, true, 157)) === '[3,6]', 'bull trend, valley above = with');
  ok(JSON.stringify(FR.trendSidedRatios(tr, 4, 8, true, 0)) === '[4,8]', 'valley touching spot keeps the plain pair');
  ok(JSON.stringify(FR.trendSidedRatios(null, 4, 8, true, 157)) === '[4,8]', 'no trend keeps the plain pair');
  ok(JSON.stringify(FR.trendSidedRatios({ dir: 0 }, 4, 8, true, 157)) === '[4,8]', 'unaligned trend keeps the plain pair');
  ok(JSON.stringify(FR.trendSidedRatios({ dir: -1, againstMin: 5 }, 4, 8, true, 157)) === '[5,8]', 'an unset side falls back to the plain value');
}

// ── the 10/14 12:00 raise through the planner ───────────────────────────────────────────────────────
// Synthetic book shaped like v7-10's at 12:00: flat at 0 except a -$880 valley at 30,270; spot 30,112.8.
{
  const spot = 30112.8, xs = []; for (let x = 29800; x <= 30420; x += 10) xs.push(x);
  const base = xs.map((x) => (x === 30270 ? -880 : 0));
  const legs = [{ side: 'long', type: 'C', strike: 30240 }, { side: 'short', type: 'C', strike: 30260 }];
  const run = (trendRatio) => FR.pickBest({ xs, base, cands: [{ structure: 'vertical', legs }], price: () => ({ debit: 2.55 }), qty: 1,
    minRatio: 4, minRatioFar: 8, farSigmas: 2, sigmaPts: 150, budget: Infinity, gNow: -880, objective: 'valley', spot,
    bandLo: 29800, bandHi: 30420, liftMetric: 'avg', trendRatio,
    globalFloorWith: (l, d) => Math.min(...xs.map((x, j) => base[j] + FR.payoff(l, x, 1) - d * 100)) });
  const plain = run(null), against = run({ dir: -1, withMin: 3, withFar: 6, againstMin: 5, againstFar: 10 }),
    withT = run({ dir: 1, withMin: 3, withFar: 6, againstMin: 5, againstFar: 10 });
  const bestOf = (r) => (r && (r.best || (r.legs ? r : null))) || null;
  ok(bestOf(plain) != null, 'plain 4:1 -> 8:1 still buys it (ratio ~6.8 vs need ~6.3)');
  ok(bestOf(against) == null, 'against a bear trend (5:1 -> 10:1, need ~7.8) it is refused');
  ok(bestOf(withT) != null, 'with a bull trend (3:1 -> 6:1) it is bought');
}

console.log(`raise trend-sided ratio: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
