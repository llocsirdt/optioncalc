'use strict';
// CANDLE GIVE-UP TRIGGER (2026-10-10) — the user's rule: give up on a 15m reversal candle, or on two 5m reversal
// candles IN A ROW (rolling: a pair spanning the last 5m of one 15m bar and the first 5m of the next counts).
//
// Run: node server/tests/unit/candle-spread-giveup-candle.test.js
const GC = require('../../src/candle-spread/giveup-candle');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const C = (open, high, low, close, x = {}) => ({ open, high, low, close, bbupper: 110, bbmiddle: 100, bblower: 90, ema: 100, ...x });

// ── kinds ─────────────────────────────────────────────────────────────────────────────────────────────────
{
  const prev = C(100, 105, 98, 104);
  ok(GC.against('break', C(103, 104, 97, 98), prev).bull, 'break: new low, no new high = reversal against a bull');
  ok(!GC.against('break', C(103, 106, 97, 98), prev).bull, 'break: an OUTSIDE bar (new low AND new high) is not a reversal');
  ok(GC.against('break', C(103, 107, 99, 106), prev).bear, 'break: new high, no new low = reversal against a bear');
  ok(GC.against('bbIn', C(111, 112, 108, 109), C(108, 113, 107, 112)).bull, 'bbIn: closed above the upper band, red and back inside');
  ok(!GC.against('bbIn', C(108, 112, 107, 109), C(108, 113, 107, 112)).bull, 'bbIn: back inside but GREEN is not a reversal');
  ok(GC.against('ema', C(102, 103, 98, 99), C(101, 103, 100, 102)).bull, 'ema: red close across the EMA');
  ok(GC.against('mid', C(98, 102, 97, 101), C(99, 100, 97, 98)).bear, 'mid: green close up through the midline (against a bear)');
}
// ── two 5m in a row, rolling across a 15m boundary ────────────────────────────────────────────────────────
{
  const st = {};
  const seq = [C(100, 105, 99, 104), C(103, 104, 97, 98), C(98, 99, 95, 96)];   // two consecutive 'break' downs
  const r0 = GC.step(st, 'break', seq[0], null);
  const r1 = GC.step(st, 'break', seq[1], null);                 // e.g. the last 5m of a 15m bar
  const r2 = GC.step(st, 'break', seq[2], null);                 // the first 5m of the next — no 15m close in between
  ok(!r0.bull && !r1.bull, 'one 5m reversal alone does not fire');
  ok(r2.bull && /two 5m/.test(r2.why), `the second in a row fires (${r2.why})`);
}
{
  const st = {};
  GC.step(st, 'break', C(100, 105, 99, 104), null);
  GC.step(st, 'break', C(103, 104, 97, 98), null);                // a reversal
  GC.step(st, 'break', C(98, 103, 98, 102), null);                // not a reversal — breaks the pair
  const r = GC.step(st, 'break', C(101, 102, 96, 97), null);      // a reversal again, but not two in a row
  ok(!r.bull, 'the pair must be consecutive');
}
// ── a single 15m reversal fires on its own ───────────────────────────────────────────────────────────────
{
  const st = {};
  GC.step(st, 'break', C(100, 101, 99, 100.5), C(100, 108, 99, 107));   // a 15m close establishes prev15
  const r = GC.step(st, 'break', C(100, 101, 99, 100.5), C(106, 107, 96, 97));
  ok(r.bull && /15m/.test(r.why), `one 15m reversal fires (${r.why})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
