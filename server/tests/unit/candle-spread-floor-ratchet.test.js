'use strict';
// FLOOR RATCHET. On 2026-09-16 every one of 79 live variants gave back book floor between its intraday
// peak and 15:00 — $278,125 of fleet peak down to $48,995, 82% of a GUARANTEED profit handed back. The
// day-loss governor cannot see that: it bounds how bad the book gets in absolute terms and says nothing
// about surrendering a floor already won.
//
// These cover the three things that can silently break the feature: the engage conditions (a
// fraction-of-peak budget is ZERO at peak zero, which would block every trade of the day), the
// high-water mark only ever ratcheting UP, and the A/B grid actually landing on the fleet the way the
// comments claim — including the two exclusions that exist for attribution reasons.
//
// Run: node server/tests/unit/candle-spread-floor-ratchet.test.js
const trader = require('../../src/candle-spread/trader');
const RC = require('../../src/candle-spread/risk-curve');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const near = (a, b, m) => ok(Math.abs(a - b) < 1e-6, `${m} (got ${a}, want ${b})`);

const ON = { floorRatchet: true, floorRatchetMinPeak: 1000, floorGiveBackFrac: 0.25 };

// ── ENGAGE CONDITIONS ───────────────────────────────────────────────────────────────────────────────
{
  ok(trader.ratchetLimit({ peakFloor: 5000 }, { floorRatchet: false }) === null, 'off when the flag is off');
  ok(trader.ratchetLimit({ peakFloor: 5000 }, undefined) === null, 'off when deps are missing');
  // THE ONE THAT MATTERS: at peak 0 a fraction budget is 0, so without this guard the ratchet would
  // block the first open of the day and every open after it.
  ok(trader.ratchetLimit({ peakFloor: 0 }, ON) === null, 'does not engage at peak zero');
  ok(trader.ratchetLimit({ peakFloor: -4000 }, ON) === null, 'does not engage on a NEGATIVE peak');
  ok(trader.ratchetLimit({ peakFloor: null }, ON) === null, 'does not engage before any peak is recorded');
  ok(trader.ratchetLimit({ peakFloor: 999 }, ON) === null, 'below minPeak there is nothing worth protecting');
  near(trader.ratchetLimit({ peakFloor: 1000 }, ON), 750, 'engages exactly at minPeak');
  near(trader.ratchetLimit({ peakFloor: 8000 }, ON), 6000, '0.25 give-back holds 75% of peak');
  near(trader.ratchetLimit({ peakFloor: 8000 }, { ...ON, floorGiveBackFrac: 0.5 }), 4000, '0.50 holds half');
}
// Defaults are the documented ones, so a variant that sets only floorRatchet still behaves.
{
  near(trader.ratchetLimit({ peakFloor: 4000 }, { floorRatchet: true }), 3000, 'defaults to a 0.25 give-back');
  ok(trader.ratchetLimit({ peakFloor: 900 }, { floorRatchet: true }) === null, 'defaults to a $1,000 minPeak');
}

// ── HIGH-WATER MARK ─────────────────────────────────────────────────────────────────────────────────
// A COVERED PAIR, in the real 'tent' geometry the engine actually books (taken from a live record):
// bull call lo/hi, covered by a debit PUT spread short at hi and long one width ABOVE. Payoff is W at
// both tails and 2W at the centre, so the pair is worth at least (W - debit - coverDebit) at EVERY
// settle price — a genuinely positive floor. Getting this backwards (covering with a put spread at the
// SAME strikes) builds a synthetic that swings -W to +W and has no floor at all, which is what the first
// version of this fixture did.
const coveredPair = (lo, hi, debit, coverDebit, qty) => ({
  filled: true, side: 'bull', quantity: qty || 1, limit: debit, covered: true,
  legs: [{ side: 'long', type: 'C', strike: lo }, { side: 'short', type: 'C', strike: hi }],
  coverLegs: [{ side: 'short', type: 'P', strike: hi }, { side: 'long', type: 'P', strike: hi + (hi - lo) }],
  coverLimit: coverDebit,
});
{
  const st = { positions: [coveredPair(29000, 29020, 5, 2, 3)] };   // floor = (20-7)*100*3 = $3,900
  const f1 = RC.bookFloor(st.positions, null, 10);
  ok(f1 > 0, `fixture really has a positive floor (${f1})`);
  trader.noteFloorPeak(st, ON);
  near(st.peakFloor, f1, 'records the floor as the peak');

  // The floor DROPS (a new uncovered debit spread is added) — the peak must not follow it down.
  st.positions.push({ filled: true, side: 'bull', quantity: 1, limit: 6, covered: false,
    legs: [{ side: 'long', type: 'C', strike: 29100 }, { side: 'short', type: 'C', strike: 29120 }] });
  const f2 = RC.bookFloor(st.positions, null, 10);
  ok(f2 < f1, `adding an uncovered debit spread lowers the floor (${f1} -> ${f2})`);
  trader.noteFloorPeak(st, ON);
  near(st.peakFloor, f1, 'the peak RATCHETS — it does not follow the floor down');

  // A better floor does move it up.
  st.positions[1].covered = true;
  st.positions[1].coverLegs = [{ side: 'short', type: 'P', strike: 29120 }, { side: 'long', type: 'P', strike: 29140 }];
  st.positions[1].coverLimit = 2;      // pair now worth at least (20 - 6 - 2) x 100 = $1,200 everywhere
  const f3 = RC.bookFloor(st.positions, null, 10);
  ok(f3 > f1, `covering it lifts the floor above the old peak (${f3})`);
  trader.noteFloorPeak(st, ON);
  near(st.peakFloor, f3, 'a new high DOES move the peak up');

  // And with the flag off nothing is tracked at all — the control arm must stay byte-identical.
  const ctl = { positions: [coveredPair(29000, 29020, 5, 2, 3)] };
  trader.noteFloorPeak(ctl, { floorRatchet: false });
  ok(ctl.peakFloor === undefined, 'records nothing when the ratchet is off');
}

// ── THE GATE DECISION ───────────────────────────────────────────────────────────────────────────────
// Mirrors the branch in processCandleClose: an open is refused when the PROJECTED floor (book + the new
// position) sits below the ratchet limit.
{
  const st = { positions: [coveredPair(29000, 29020, 5, 2, 3)] };
  trader.noteFloorPeak(st, ON);
  const lim = trader.ratchetLimit(st, ON);
  const cand = (debit) => ({ filled: true, side: 'bull', quantity: 1, limit: debit, covered: false,
    legs: [{ side: 'long', type: 'C', strike: 29100 }, { side: 'short', type: 'C', strike: 29120 }] });
  const proj = (d) => RC.bookFloor(st.positions, cand(d), 10);
  const cheap = st.peakFloor - lim;                    // exactly the budget, in dollars
  ok(proj(cheap / 100 * 0.5) >= lim, 'an open inside the give-back budget is allowed');
  ok(proj(cheap / 100 * 2) < lim, 'an open that spends twice the budget is refused');
  // The governor and the ratchet are INDEPENDENT. This book is nowhere near any sane lossMax and the
  // ratchet still bites, which is the entire reason the feature exists.
  ok(-proj(cheap / 100 * 2) < 6000, 'the refused open is still far inside a $6,000 lossMax');
}

// ── THE GRID, MEASURED AND REJECTED ─────────────────────────────────────────────────────────────────
// 765 days, 2026-09-16: 31 of 31 ratcheted variants got WORSE (-$1.76M at 0.25, -$1.73M at 0.50) and the
// worst floor HELD did not move a dollar — it engages only once a peak exists, so it is active on the
// good days and dormant on the days that set the worst floor. The grid is therefore OFF by default and
// the flags stay for targeted re-tests. These pin BOTH halves: nothing armed by accident, and the env
// override still works, because a rejected feature that quietly re-arms itself is the worse failure.
{
  const idx = require('../../src/candle-spread/index');
  const runs = idx.buildRuns();
  ok(runs.filter(r => r.floorRatchet === true).length === 0, 'the fleet grid arms NOTHING by default');
  ok(runs.every(r => r.floorGiveBackFrac == null), 'and leaves no give-back fraction set');
}
// The override is the whole point of keeping the feature, so prove it still reaches a variant — in a
// child process, since the roster is built at module load and the env must be set before that.
{
  const { execFileSync } = require('child_process');
  const out = execFileSync(process.execPath, ['-e',
    "const r=require('./server/src/candle-spread/index.js').buildRuns().find(x=>x.variant==='v6-40');"
    + "console.log(JSON.stringify({on:r.floorRatchet,frac:r.floorGiveBackFrac,min:r.floorRatchetMinPeak}));"],
    { cwd: require('path').join(__dirname, '..', '..', '..'),
      env: { ...process.env, CANDLE_SPREAD_RATCHET: 'v6-40:0.25' }, encoding: 'utf8' });
  const got = JSON.parse(out.trim().split('\n').pop());
  ok(got.on === true && got.frac === 0.25, 'CANDLE_SPREAD_RATCHET still arms a named variant');
  ok(got.min === 4000, 'and minPeak still scales with width ($40 -> $4,000)');
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
