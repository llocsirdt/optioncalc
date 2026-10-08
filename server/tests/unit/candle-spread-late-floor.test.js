'use strict';
// LATE-DAY FLOOR GUARD (adopted 2026-10-08): from lateFloorAfterMin a floor that was >= 0 at the reference may not
// go negative — opens are skipped, floor-lowering covers deferred, floor raises bounded. Before the minute, or
// with the reference below zero (keepLocked only), nothing changes.
//
// Run: node server/tests/unit/candle-spread-late-floor.test.js
const T = require('../../src/candle-spread/trader');
const CS = require('../../src/candle-spread/index');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

const at = (hhmm) => Date.parse(`2026-10-08T${hhmm}:00-04:00`);
// A locked book: bull 31100/31110 @4.00 + bear 31110/31100 @5.00 -> +$100 at every settle.
const locked = () => [
  { id: 'B', side: 'bull', filled: true, quantity: 1, limit: 4.0, covered: false, legs: [{ side: 'long', type: 'C', strike: 31100 }, { side: 'short', type: 'C', strike: 31110 }] },
  { id: 'R', side: 'bear', filled: true, quantity: 1, limit: 5.0, covered: false, legs: [{ side: 'long', type: 'P', strike: 31110 }, { side: 'short', type: 'P', strike: 31100 }] }];
const deps = (over) => ({ lossMax: 2000, lateFloorAfterMin: 900, lateFloorKeepLocked: true, spreadWidth: 10, ...over });

{
  const st = { positions: locked() };
  ok(T.lateFloorLimit(st, deps({ nowMs: at('14:30') }), 870, 10) === null, 'before 15:00: no limit');
  ok(T.lateFloorLimit(st, deps({ nowMs: at('15:05') }), 905, 10) === 0 && st.lateFloorRef === 100, `15:05, floor +100: the limit is 0 (ref ${st.lateFloorRef})`);
  st.positions.push({ id: 'X', side: 'bull', filled: true, quantity: 1, limit: 5.0, covered: false, legs: [{ side: 'long', type: 'C', strike: 31200 }, { side: 'short', type: 'C', strike: 31210 }] });
  ok(T.lateFloorLimit(st, deps({ nowMs: at('15:30') }), 930, 10) === 0, 'the reference is kept for the rest of the day');
  const neg = { positions: [locked()[0]] };   // a lone bull: floor -400
  ok(T.lateFloorLimit(neg, deps({ nowMs: at('15:05') }), 905, 10) === null, 'a negative reference with keepLocked only: no limit');
  const give = { positions: [locked()[0]] };
  ok(T.lateFloorLimit(give, deps({ nowMs: at('15:05'), lateFloorGiveW: 0 }), 905, 10) === -400, 'with lateFloorGiveW 0 the reference itself is the limit (-400)');
}
{
  const runs = CS.buildRuns();
  ok(runs.every((r) => r.lateFloorAfterMin === 900 && r.lateFloorKeepLocked === true), 'every variant: 15:00 keep-locked');
  CS.assertDeps(runs); ok(true, 'startup contract accepts the fields');
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
