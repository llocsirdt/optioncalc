'use strict';
// COVER TO OPEN, WAIT (deps.coverToOpenWait, 2026-10-16). An open signal on a side that is already underwater (an
// uncovered position on it marks below what it paid) escalates that position's cover to the give-up path and skips
// the open; the opposite side is unaffected.
//
// Run: cd server && node tests/run-unit.js cover-to-open-wait
const os = require('os'), path = require('path'), fs = require('fs');
process.env.CANDLE_SPREAD_RUNS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-c2o-'));
const store = require('../../src/candle-spread/store');
const trader = require('../../src/candle-spread/trader');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const base = { symbol: 'NDX', expiration: '2026-10-16', spreadWidth: 10, strikeIncrement: 10, quantity: 1, tickIncrement: 0.05,
  coverSelector: 'fixed-mark', coverFillModel: 'resting', captureChain: false };
const legFor = (U) => (type, strike) => {
  const tv = 2.5 * Math.exp(-Math.abs(U - strike) / 25);
  const mid = (type === 'C' ? Math.max(0, U - strike) : Math.max(0, strike - U)) + tv;
  return { mid: Math.round(mid * 20) / 20, symbol: `NDX_${type}${strike}`, bid: mid - 0.05, ask: mid + 0.05 };
};
const placeOrder = async () => ({ status: 'sim', filled: true });

let n = 0;
async function step(rec, U, side, extra) {
  const A = { '5m': { close: U, open: U, high: U + 5, low: U - 5 }, '15m': { close: U } };
  const candle = { timeEST: `10/16 10:${String(n++).padStart(2, '0')}`, open: U, high: U + 5, low: U - 5, close: U };
  return trader.processCandleClose(rec, candle, null, { getLeg: legFor(U), placeOrder, signalFn: () => ({ openSide: side }),
    A, priorA: null, underlying: U, isFifteen: true, bidirectional: true, ...extra });
}
const bulls = (rec) => rec.state.positions.filter((p) => p.side === 'bull' && p.filled);

(async () => {
  // 1) a bull goes underwater; the next bull signal waits and escalates its cover
  {
    const rec = store.initRun({ ...base, variant: 'c2o-on' }, '2026-10-16');
    await step(rec, 22000, 'bull', { coverToOpenWait: true });
    ok(bulls(rec).length === 1, 'first bull opens');
    const p = bulls(rec)[0];
    p.pendingCover = p.pendingCover || { legs: [{ side: 'long', type: 'P', strike: p.legs[1].strike }, { side: 'short', type: 'P', strike: p.legs[0].strike }],
      target: 4, openCost: p.limit };
    const r = await step(rec, 21960, 'bull', { coverToOpenWait: true });
    const d = (r && r.decisions) || [];
    ok(d.some((x) => x.action === 'open-skip-c2o-wait'), 'a bull signal on an underwater bull side is skipped');
    ok(bulls(rec).length === 1, 'no second bull goes on');
    ok(p.c2o === true && d.some((x) => x.action === 'c2o-escalate' && x.positionId === p.id), 'the underwater bull is sent to the give-up path');
    // 2) the opposite side still opens
    const r2 = await step(rec, 21960, 'bear', { coverToOpenWait: true });
    ok(!((r2 && r2.decisions) || []).some((x) => x.action === 'open-skip-c2o-wait'), 'a bear signal is not held back by the underwater bull');
    ok(rec.state.positions.some((x) => x.side === 'bear' && x.filled), 'the bear opens');
    // 3) once the bull is covered the side is clear
    p.covered = true;
    ok(trader.underwaterOnSide(rec.state, 'bull', legFor(21960)).length === 0, 'a covered position is no longer underwater');
  }
  // 4) off: the same path stacks the second bull
  {
    const rec = store.initRun({ ...base, variant: 'c2o-off' }, '2026-10-16');
    await step(rec, 22000, 'bull', {});
    const r = await step(rec, 21960, 'bull', {});
    ok(!((r && r.decisions) || []).some((x) => x.action === 'open-skip-c2o-wait'), 'off by default');
    ok(bulls(rec).length === 2, `without the flag the second bull opens (${bulls(rec).length})`);
  }
  // 5) a bull in profit does not hold the side
  {
    const st = { positions: [{ id: 'a', side: 'bull', filled: true, covered: false, limit: 5,
      legs: [{ side: 'long', type: 'C', strike: 21990 }, { side: 'short', type: 'C', strike: 22000 }] }] };
    ok(trader.underwaterOnSide(st, 'bull', legFor(22050)).length === 0, 'a position marking above what it paid is not underwater');
    ok(trader.underwaterOnSide(st, 'bull', legFor(21950)).length === 1, 'the same position below its price is');
  }

  console.log(`cover to open wait: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
