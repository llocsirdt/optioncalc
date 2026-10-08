'use strict';
// MANUAL EDIT AT SCHWAB -> ADOPTED, NOT DUPLICATED (2026-10-07). Built from the real probe
// (probe-manual-replace.js): order 1008216063823 edited in the Schwab app from 3.65 to 3.70 became REPLACED
// (closeTime 23:59:39) and a NEW order 1008216063832 carried it — same legs, entered the same second, tag
// prefix API_ instead of our TA_, no link field. Rules pinned here:
//   1. the successor is ADOPTED: the position's cover now works the new id at the user's price, no second order
//   2. an edit-of-an-edit is followed to the live end
//   3. if the edited order already FILLED, the adopted row books it on the same pass
//   4. NO successor (a different order, or none): after a short grace the engine re-creates its order as before
//   5. a replace the ENGINE made is untouched by any of this
//
// Run: node server/tests/unit/candle-spread-manual-edit-adoption.test.js
const os = require('os'), path = require('path'), fs = require('fs');
process.env.CANDLE_SPREAD_RUNS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-mea-'));
const OM = require('../../src/candle-spread/order-manager');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

const LEGS = [
  { instruction: 'SELL_TO_OPEN', quantity: 1, instrument: { symbol: 'NDXP  261008P31170000', assetType: 'OPTION' } },
  { instruction: 'BUY_TO_OPEN', quantity: 1, instrument: { symbol: 'NDXP  261008P31180000', assetType: 'OPTION' } },
];
const orig = { orderId: 1008216063823, status: 'REPLACED', price: 3.65, orderType: 'NET_DEBIT', quantity: 1,
  enteredTime: '2026-10-07T23:58:04+0000', closeTime: '2026-10-07T23:59:39+0000', tag: 'TA_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  orderLegCollection: LEGS };
const edited = { orderId: 1008216063832, status: 'PENDING_ACTIVATION', price: 3.7, orderType: 'NET_DEBIT', quantity: 1,
  enteredTime: '2026-10-07T23:59:39+0000', tag: 'API_xxxxxxxxxxx', orderLegCollection: LEGS };
const NOW = Date.parse('2026-10-08T00:00:10Z');

function client(byId, listing) {
  const calls = { list: 0, del: [] };
  return { calls,
    orderById: async (_h, id) => byId[String(id)] || { status: 'WORKING' },
    ordersByAccount: async () => { calls.list++; return listing; },
    orderDelete: async (_h, id) => { calls.del.push(id); return {}; } };
}
const mkRecord = () => {
  const pos = { id: 'p1', side: 'bull', filled: true, limit: 5.3, legs: [], covered: false,
    pendingCover: { legs: [{ type: 'P', strike: 31170 }, { type: 'P', strike: 31180 }], target: 3.65, orderId: '1008216063823', ladderStep: 4, sentNet: 'DEBIT' } };
  return { runId: 'r', config: { variant: 'v7-10' }, events: [],
    state: { positions: [pos], liveOrders: [{ orderId: '1008216063823', kind: 'cover-rest', positionId: 'p1', status: 'working',
      net: 'NET_DEBIT', sentPrice: 3.65, requestedPrice: 3.65, placedAt: NOW - 120000 }] } };
};

(async () => {
  // ── 1. adopted ────────────────────────────────────────────────────────────────────────────────────
  {
    const r = mkRecord();
    const c = client({ 1008216063823: orig, 1008216063832: edited }, [orig, edited]);
    await OM.reconcile(r, { tradingClient: c, accountHash: 'h' }, { now: NOW });
    const pc = r.state.positions[0].pendingCover;
    const old = r.state.liveOrders.find((o) => o.orderId === '1008216063823');
    const nu = r.state.liveOrders.find((o) => String(o.orderId) === '1008216063832');
    ok(String(pc.orderId) === '1008216063832' && pc.target === 3.7, `the position's cover now works the edited order at the user's price (${pc.orderId} @ ${pc.target})`);
    ok(pc.ladderStep === null, 'the ladder re-takes its step from the price the user set');
    ok(old.status === 'canceled' && old.canceledReason === 'manual-edit', 'the original row retires as a manual edit');
    ok(nu && nu.status === 'working' && nu.adoptedFrom === '1008216063823', 'the edited order is tracked, linked to the original');
    ok(r.state.positions[0].pendingCover != null, 'the cover is NOT cleared — the engine will not send a second one');
    ok(r.events.some((e) => e.type === 'order_adopted_manual_edit'), 'logged as order_adopted_manual_edit');
  }

  // ── 2. edited twice ───────────────────────────────────────────────────────────────────────────────
  {
    const r = mkRecord();
    const mid = { ...edited, status: 'REPLACED', closeTime: '2026-10-07T23:59:58+0000' };
    const last = { ...edited, orderId: 1008216063840, price: 3.75, enteredTime: '2026-10-07T23:59:58+0000' };
    const c = client({ 1008216063823: orig, 1008216063832: mid, 1008216063840: last }, [orig, mid, last]);
    await OM.reconcile(r, { tradingClient: c, accountHash: 'h' }, { now: NOW });
    const pc = r.state.positions[0].pendingCover;
    ok(String(pc.orderId) === '1008216063840' && pc.target === 3.75, `an edit of an edit is followed to the live order (${pc.orderId} @ ${pc.target})`);
  }

  // ── 3. already filled ─────────────────────────────────────────────────────────────────────────────
  {
    const r = mkRecord();
    const filled = { ...edited, status: 'FILLED', filledQuantity: 1, orderActivityCollection: [{ activityType: 'EXECUTION', executionType: 'FILL',
      executionLegs: [{ legId: 1, price: 10.0, quantity: 1 }, { legId: 2, price: 13.7, quantity: 1 }] }],
      orderLegCollection: LEGS.map((l, i) => ({ ...l, legId: i + 1 })) };
    const c = client({ 1008216063823: orig, 1008216063832: filled }, [orig, filled]);
    await OM.reconcile(r, { tradingClient: c, accountHash: 'h' }, { now: NOW });
    const nu = r.state.liveOrders.find((o) => String(o.orderId) === '1008216063832');
    ok(nu && nu.status === 'filled' && Math.abs(nu.fillPrice - 3.7) < 1e-9, `the edited order's fill is seen on the same pass (${nu && nu.status} @ ${nu && nu.fillPrice})`);
  }

  // ── 4. no successor -> grace, then the engine re-creates its order (existing behaviour) ────────────
  {
    const r = mkRecord();
    const other = { ...edited, orderLegCollection: [LEGS[0], { ...LEGS[1], instrument: { symbol: 'NDXP  261008P31190000' } }] };
    const c = client({ 1008216063823: orig }, [orig, other]);
    await OM.reconcile(r, { tradingClient: c, accountHash: 'h' }, { now: NOW });
    ok(r.state.positions[0].pendingCover != null, 'first sighting with no match: waits (the successor may not be listed yet)');
    await OM.reconcile(r, { tradingClient: c, accountHash: 'h' }, { now: NOW + 30000 });
    ok(r.state.positions[0].pendingCover == null && r.events.some((e) => e.type === 'order_manual_replace_unmatched'),
      'still no match after the grace: the cover is cleared so the engine RE-CREATES its order, as before');
  }

  // ── 5. the engine's own replace is untouched ─────────────────────────────────────────────────────
  {
    const r = mkRecord();
    r.state.liveOrders[0].replacedBy = '999';
    const c = client({ 1008216063823: orig }, [orig, edited]);
    await OM.reconcile(r, { tradingClient: c, accountHash: 'h' }, { now: NOW });
    ok(c.calls.list === 0 && r.state.positions[0].pendingCover.orderId === '1008216063823', 'a replace the engine made never looks for a manual successor');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
