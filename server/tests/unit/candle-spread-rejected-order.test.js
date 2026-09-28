'use strict';
// A REJECTED ORDER IS NOT A RESTING ONE.
//
// The poller marked a dead order dead on its own liveOrders row and stopped there. Nothing reached the
// POSITION, so the state machine went on believing it held a working cover the broker had refused, and
// the ladder called replace on the dead id every bar. Measured on prod 2026-09-24: 28 orders rejected
// (16 opens, 12 cover-rests) producing 53 "Order in status REJECTED cannot be replaced" 400s across 19
// positions, one retried six times; 4 positions were still "resting" on a rejected cover at the close.
//
// The wasted calls are the visible half. The dangerous half is the belief: resolveRestingCovers books a
// fill from the MARK and cannot tell that the order behind it does not exist.
//
// Run: node server/tests/unit/candle-spread-rejected-order.test.js
const os = require('os'), path = require('path'), fs = require('fs');
process.env.CANDLE_SPREAD_RUNS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-rej-'));
const om = require('../../src/candle-spread/order-manager');
const store = require('../../src/candle-spread/store');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

const mkRec = () => ({ runId: 'r', tradeDate: '2026-09-28', config: { variant: 't' }, events: [],
  state: { positions: [], liveOrders: [], pendingOpenId: null } });

// ── A REJECTED COVER LEAVES THE POSITION UNCOVERED ──────────────────────────────────────────────────
{
  const rec = mkRec();
  const pos = { id: 'p1', filled: true, covered: false, coverStatus: 'resting',
    pendingCover: { orderId: 'o1', target: 12.5, legs: [{ side: 'short', type: 'P', strike: 100 }] } };
  rec.state.positions.push(pos);
  const cleared = om.clearDeadOrderState(rec, { orderId: 'o1', kind: 'cover-rest', positionId: 'p1' });
  ok(cleared === 'cover', `a rejected cover is reported as cleared (${cleared})`);
  ok(pos.pendingCover === null, 'pendingCover is gone — the engine can no longer reprice a ghost');
  ok(pos.coverStatus === 'rejected', `and the reason is recorded (${pos.coverStatus})`);
  ok(pos.covered === false, 'the position is honestly uncovered, so the cap counts its risk again');
}

// ── IT MUST NOT TOUCH A COVER THAT ALREADY FILLED ───────────────────────────────────────────────────
// A REPLACED order goes terminal at the broker too. If the replacement filled, clearing on the old id
// would un-book a real cover — strictly worse than the bug being fixed.
{
  const rec = mkRec();
  const pos = { id: 'p1', filled: true, covered: true, coverStatus: 'filled', coverLimit: 8,
    pendingCover: null };
  rec.state.positions.push(pos);
  const cleared = om.clearDeadOrderState(rec, { orderId: 'o1', kind: 'cover-rest', positionId: 'p1' });
  ok(cleared === null && pos.covered === true, 'a position already covered is left completely alone');
}

// ── NOR A PENDING COVER BELONGING TO A DIFFERENT ORDER ──────────────────────────────────────────────
// The ladder replaces, which retires the old id and tracks a new one. A late poll on the OLD id must not
// clear the pendingCover now resting under the NEW one.
{
  const rec = mkRec();
  const pos = { id: 'p1', filled: true, covered: false, pendingCover: { orderId: 'o2', target: 11 } };
  rec.state.positions.push(pos);
  const cleared = om.clearDeadOrderState(rec, { orderId: 'o1', kind: 'cover-rest', positionId: 'p1' });
  ok(cleared === null && pos.pendingCover && pos.pendingCover.orderId === 'o2',
    'a dead OLD id does not clear the cover now resting under a new one');
}

// ── A REJECTED OPEN RELEASES THE ONE-WORKING-OPEN SLOT ──────────────────────────────────────────────
{
  const rec = mkRec();
  const pos = { id: 'p9', filled: false, orderId: 'o9', orderStatus: 'sent' };
  rec.state.positions.push(pos); rec.state.pendingOpenId = 'p9';
  const cleared = om.clearDeadOrderState(rec, { orderId: 'o9', kind: 'open', positionId: 'p9' });
  ok(cleared === 'open', `a rejected open is reported as cleared (${cleared})`);
  ok(rec.state.pendingOpenId === null, 'the working-open slot is released, so the next signal can trade');
  ok(pos.orderStatus === 'rejected', 'and the position records why it never filled');
  ok(rec.state.positions.length === 1, 'the position row survives — it is evidence, and the summary counts it');
}

// ── A FILLED OPEN IS NOT TOUCHED ────────────────────────────────────────────────────────────────────
{
  const rec = mkRec();
  const pos = { id: 'p9', filled: true, orderId: 'o9', orderStatus: 'filled' };
  rec.state.positions.push(pos); rec.state.pendingOpenId = null;
  ok(om.clearDeadOrderState(rec, { orderId: 'o9', kind: 'open', positionId: 'p9' }) === null
    && pos.orderStatus === 'filled', 'a filled open is left alone');
}

// ── AN UNKNOWN POSITION IS A NO-OP, NOT A THROW ─────────────────────────────────────────────────────
{
  const rec = mkRec();
  ok(om.clearDeadOrderState(rec, { orderId: 'o1', kind: 'cover-rest', positionId: 'nope' }) === null,
    'an order naming a position we do not have is ignored quietly');
  ok(om.clearDeadOrderState(rec, { orderId: 'o1', kind: 'cover-rest' }) === null,
    'and so is one carrying no positionId at all');
}

// ── THE WHOLE PATH, THROUGH reconcile ───────────────────────────────────────────────────────────────
// The bug lived in reconcile's DEAD branch, so drive that rather than only the helper.
(async () => {
  const rec = mkRec();
  const pos = { id: 'p1', filled: true, covered: false, coverStatus: 'resting',
    pendingCover: { orderId: 'o1', target: 12.5 } };
  rec.state.positions.push(pos);
  om.trackOrder(rec, { orderId: 'o1', kind: 'cover-rest', positionId: 'p1', requestedPrice: 12.5, sentPrice: 12.5 });
  const deps = { accountHash: 'h', tradingClient: { orderById: async () => ({ status: 'REJECTED' }) } };
  await om.reconcile(rec, deps, { now: Date.now() });
  ok(pos.pendingCover === null, 'reconcile on a REJECTED cover clears the pendingCover end to end');
  const ev = rec.events.filter((e) => e.type === 'order_dead').pop();
  ok(ev && ev.positionId === 'p1', 'and the order_dead event now names the position it belonged to');
  ok(ev && ev.cleared === 'cover', `and says what it cleared (${ev && ev.cleared})`);
  ok(/uncovered again/.test((ev && ev.note) || ''), 'with a note a person can read');

  console.log(`${pass} passed, ${fail} failed`);
  try { fs.rmSync(process.env.CANDLE_SPREAD_RUNS_DIR, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 1 : 0);
})();
