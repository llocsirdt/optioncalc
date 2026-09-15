'use strict';
// Classic (v0-v3) signal parity: the server's classicSignal must stay byte-identical to the backtest's
// (scripts/candle-spread/backtest-v4.js), and it must actually fire (produce opens + covers) on real A data.
//
// Run: node server/tests/nogit/candle-spread-classic-signal.test.js
const { classicSignal: srv } = require('../../src/candle-spread/signals/classic-signal');
const bt = require('../../../scripts/candle-spread/backtest-v4').classicSignal;
const { load5mDays } = require('../../../scripts/candle-spread/backtest-v6-5m');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

const days = load5mDays('tests/backtest/backtest-data-5m-nq').slice(0, 60);
let n = 0, mismatch = 0, opens = 0, covers = 0;
for (const d of days) {
  for (let i = 1; i < d.bars.length; i++) {
    const A = d.bars[i].analysis, P = d.bars[i - 1].analysis;
    for (const heldDir of ['none', 'bull', 'bear']) {
      const a = srv(A, P, { heldDir }), b = bt(A, P, { heldDir });
      n++;
      if (a.openSide !== b.openSide || !!a.cover !== !!b.cover) mismatch++;
      if (heldDir === 'none' && a.openSide) opens++;
      if (heldDir !== 'none' && a.cover) covers++;
    }
  }
}
ok(n > 10000, `enough comparisons (${n})`);
ok(mismatch === 0, `server classicSignal byte-identical to backtest (${mismatch} mismatches / ${n})`);
ok(opens > 0, `produces opens (${opens})`);
ok(covers > 0, `produces covers (${covers})`);

console.log(`\n${n.toLocaleString()} comparisons, ${mismatch} mismatches, ${opens} opens, ${covers} covers`);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
