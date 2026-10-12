'use strict';
// COVER ON FILL (2026-10-11) — the user: "It should be placed immediately after the open fill confirmation."
// Continuous covers used to be placed only at the 5m candle close, so a filled open sat uncovered for up to five
// minutes. placeContinuousCovers is now shared by the candle close and the 30-second sub-bar worker, which calls it
// right after a fill books. Pins: a filled naked position gets its cover; an unfilled one does not; a second call is
// a no-op (both call sites run every bar, so it must be idempotent).
//
// Run: node server/tests/unit/candle-spread-cover-on-fill.test.js
const os = require('os'), path = require('path'), fs = require('fs');
process.env.CANDLE_SPREAD_RUNS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-cof-'));
const trader = require('../../src/candle-spread/trader');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

const W = 10;
const cfg = { symbol: 'NDX', expiration: '2026-10-12', spreadWidth: W, strikeIncrement: 10, quantity: 1,
  tickIncrement: 0.05, coverSelector: 'fixed-mark', coverFillModel: 'resting', coverGeometry: 'tent', variant: 'cof' };
// Monotonic and at parity (calls fall 0.5/point, puts rise 0.5/point).
const getLeg = (type, strike) => {
  const mid = type === 'C' ? 40 - (strike - 25000) * 0.5 : 10 + (strike - 25000) * 0.5;
  return { mid, symbol: `NDX_${type}${strike}`, bid: mid - 0.1, ask: mid + 0.1 };
};
const mkPos = (id, filled) => ({ id, side: 'bull', legs: [{ side: 'long', type: 'C', strike: 25000 }, { side: 'short', type: 'C', strike: 25010 }],
  quantity: 1, limit: 5.0, shortStrike: 25010, filled, covered: false, pendingCover: null, openTime: '10/12 10:00' });

(async () => {
  const st = { positions: [mkPos('p1', true), mkPos('p2', false)], cashDeployed: 0 };
  const sent = [];
  const deps = { getLeg, continuousCoverMinLockFrac: 0.10,
    placeOrder: async (payload, meta) => { sent.push(meta); return { status: 'sent', filled: true, orderId: `o${sent.length}` }; } };   // filled:true = the send was accepted
  const d = [];
  await trader.placeContinuousCovers(st, cfg, deps, d, '10/12 10:02', 25010);
  ok(st.positions[0].pendingCover, 'the filled position gets its resting cover immediately (between candle closes)');
  ok(st.positions[0].pendingCover && st.positions[0].pendingCover.placedAt === '10/12 10:02', 'stamped with the worker time, not a candle close');
  ok(!st.positions[1].pendingCover, 'an unfilled open is not covered');
  ok(sent.length === 1, `one order sent (${sent.length})`);
  await trader.placeContinuousCovers(st, cfg, deps, [], '10/12 10:02', 25010);
  ok(sent.length === 1, 'a second pass (the candle close after the worker) sends nothing more');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
