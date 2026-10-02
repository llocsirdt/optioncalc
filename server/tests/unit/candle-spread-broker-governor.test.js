'use strict';
// THE GOVERNOR AND THE REPLACE RACE UNDER A REAL BROKER (2026-10-02 sweep, findings #4 and #8).
//
// #4 HAPPENED: v7-10's bear cover filled at 10:50 with three naked bulls on, the book floor went
// -1,278 -> -1,748 (lossMax 1,500) and the day settled exactly there. The positions below are that book,
// copied from the archived record. #8: the old order filling while its replacement is pending.
const os = require('os'), path = require('path'), fs = require('fs');
process.env.CANDLE_SPREAD_RUNS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bg-'));
const trader = require('../../src/candle-spread/trader');
const RC = require('../../src/candle-spread/risk-curve');
const OM = require('../../src/candle-spread/order-manager');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const P = (side, type, strike) => ({ side, type, strike });

// ── THE 10-02 BOOK ─────────────────────────────────────────────────────────────────────────────────
const bear = () => ({ id: 'bear', side: 'bear', filled: true, quantity: 1, limit: 5.28, covered: false,
  legs: [P('long', 'P', 31000), P('short', 'P', 30990)],
  // its cover as it RESTED (credit 5.30 = canonical 4.70), before the 10:50 fill
  pendingCover: { legs: [P('short', 'C', 30990), P('long', 'C', 30980)], target: 4.7, orderId: 'cov-bear',
    sentNet: 'CREDIT', sentCredit: 5.3 } });
const bull = (id, lo, limit) => ({ id, side: 'bull', filled: true, quantity: 1, limit, covered: false,
  legs: [P('long', 'C', lo), P('short', 'C', lo + 10)] });
const b1 = () => bull('b1', 30980, 6.0), b2 = () => bull('b2', 30970, 5.8), b3 = () => bull('b3', 30960, 5.7);
const broker = { fillSource: 'broker', lossMax: 1500 };
const cfg = { spreadWidth: 10, tickIncrement: 0.05, quantity: 1 };

{
  const st = { positions: [bear(), b1(), b2(), b3()] };
  const asBooked = RC.bookFloor(st.positions, null, 10);
  ok(Math.round(asBooked) === -1278, `as booked (cover not yet filled) the floor reads -1,278 (${asBooked})`);
  ok(trader.govFloor(st, broker, null) === asBooked,
    'design B: a working COVER is not assumed filled — the governor can refuse it, so the floor is the booked one');
  ok(trader.govFloor(st, { fillSource: 'mark', lossMax: 1500 }, null) === asBooked, 'and the mark path agrees');
}
// A resting cover whose fill would breach is PULLED; one that would not, is left alone.
{
  const cancels = [];
  const deps = { ...broker, cancelOrder: async (id, m) => { cancels.push({ id, m }); return { status: 'cancelled' }; } };
  const st = { positions: [bear(), b1(), b2(), b3()] };
  const d = [];
  ok(trader.governRestingCovers(st, cfg, deps, d) === 1, 'with three naked bulls the bear cover is pulled');
  ok(cancels.length === 1 && cancels[0].id === 'cov-bear' && cancels[0].m.reason === 'governor', 'cancelled at the broker');
  const dec = d.find((x) => x.action === 'cover-defer-governor');
  ok(dec && dec.source === 'broker-resting' && Math.round(dec.floorIfBooked) === -1748, 'logged with the floor it avoided');
  ok(st.positions[0].pendingCover && st.positions[0].pendingCover.cancelRequestedAt, 'kept pending until the broker answers');
  ok(trader.governRestingCovers(st, cfg, deps, []) === 0 && cancels.length === 1, 'and not cancelled twice');

  const st2 = { positions: [bear(), b1(), b2()] };
  const c2 = [];
  ok(trader.governRestingCovers(st2, cfg, { ...broker, cancelOrder: async (id) => { c2.push(id); } }, []) === 0 && c2.length === 0,
    'with two bulls the cover fill keeps the floor inside lossMax (-1,178) — it stays');
  ok(trader.governRestingCovers({ positions: [bear(), b1(), b2(), b3()] }, cfg, { fillSource: 'mark', lossMax: 1500 }, []) === 0,
    'inert on the mark path (resolveRestingCovers already defers there)');
}
// A cover that IMPROVES the floor is never refused, however bad the book.
{
  const st = { positions: [bear(), b1(), b2(), b3()] };
  st.positions[0].pendingCover = null;
  // a bull's own cover: the bear put tent above it locks that bull's loss
  const b = st.positions[1];
  b.pendingCover = { legs: [P('short', 'P', 30990), P('long', 'P', 31000)], target: 3.0, orderId: 'cov-b1' };
  const d = [];
  ok(trader.governRestingCovers(st, cfg, { ...broker, cancelOrder: async () => ({}) }, d) === 0,
    'a cover that raises the floor stays working even with the book past lossMax');
}
// A kept, reversed open still waiting on the broker counts as filled in the gate.
{
  const st = { positions: [b1(), b2(), { ...b3(), filled: false, orderId: 'o-kept', orderStatus: 'cancelled', cancelRequestedAt: 1 }] };
  const without = RC.bookFloor(st.positions, null, 10);
  const g = trader.govFloor(st, broker, null);
  ok(g < without, `a reversed open kept until the broker answers counts against the floor (${Math.round(g)} vs ${Math.round(without)})`);
}

// Before the third bull goes out, the bear cover is pulled — and the open waits for the cancel to be accepted.
const beforeOpen = (async () => {
  const st = { positions: [bear(), b1(), b2()] };
  const third = { legs: b3().legs, limit: 5.7 };
  const projected = trader.govFloor(st, broker, { filled: true, legs: third.legs, limit: 5.7, quantity: 1, covered: false });
  ok(-projected <= 1500, `the open gate admits the third bull on the booked floor (${Math.round(projected)})`);
  const order = [];
  const deps = { ...broker, cancelOrder: async (id) => { await new Promise((r) => setTimeout(r, 5)); order.push('cancel:' + id); return {}; } };
  const d = [];
  const n = await trader.pullCoversForOpen(st, third, cfg, deps, d);
  order.push('open');
  ok(n === 1 && order[0] === 'cancel:cov-bear' && order[1] === 'open', 'the bear cover is cancelled and ACCEPTED before the open is sent');
  ok(d.some((x) => x.action === 'cover-defer-governor' && x.source === 'broker-before-open'), 'logged as pulled before the open');
  const st2 = { positions: [bear(), b1()] };
  ok(await trader.pullCoversForOpen(st2, { legs: b2().legs, limit: 5.8 }, cfg, deps, []) === 0,
    'with room left under lossMax nothing is pulled');
})();
// On the mark path the open in the slot counts too (it can still fill); a reversed one does not.
{
  const pend = { ...b3(), filled: false, orderStatus: 'working' };
  const st = { positions: [b1(), b2(), pend] };
  ok(trader.govFloor(st, { fillSource: 'mark', lossMax: 1500 }, null) < RC.bookFloor(st.positions, null, 10),
    'mark path: a working open counts as filled');
  pend.orderStatus = 'cancelled';
  ok(trader.govFloor(st, { fillSource: 'mark', lossMax: 1500 }, null) === RC.bookFloor(st.positions, null, 10),
    'mark path: a reversed (cancelled) open is gone');
}

// ── #8 THE REPLACE RACE ────────────────────────────────────────────────────────────────────────────
function client(status) {
  const del = [];
  return { del, orderDelete: async (_h, id) => { del.push(id); }, orderById: async (_h, id) => ({ status: status[id] || 'WORKING',
    ...(status[id] === 'FILLED' ? { price: 4.0, orderType: 'NET_DEBIT', filledQuantity: 1 } : {}) }) };
}
const coverPos = () => ({ id: 'pc1', side: 'bull', filled: true, quantity: 1, limit: 6.0, covered: false,
  legs: [P('long', 'C', 30980), P('short', 'C', 30990)],
  pendingCover: { legs: [P('short', 'P', 30990), P('long', 'P', 31000)], target: 4.0, orderId: 'new', sentNet: 'DEBIT' } });
const pair = () => [
  { orderId: 'old', kind: 'cover-rest', positionId: 'pc1', net: 'NET_DEBIT', status: 'working', replacedBy: 'new', placedAt: Date.now() },
  { orderId: 'new', kind: 'cover-reprice', positionId: 'pc1', net: 'NET_DEBIT', status: 'working', replaces: 'old', placedAt: Date.now() }];

(async () => {
  await beforeOpen;
  // The OLD order fills while the replace is pending.
  {
    const pos = coverPos(), rec = { state: { positions: [pos], liveOrders: pair() }, events: [] };
    const st = { old: 'FILLED' }, c = client(st);
    await OM.reconcile(rec, { tradingClient: c, accountHash: 'h' });
    const [o, n] = rec.state.liveOrders;
    ok(o.status === 'filled', 'the old order\'s fill is SEEN (it used to be retired on PUT success)');
    ok(c.del.includes('new') && n.supersededByFill === 'old', 'and its replacement is pulled');
    ok(rec.events.some((e) => e.type === 'order_replace_race'), 'logged as a replace race');
    st.new = 'CANCELED';
    await OM.reconcile(rec, { tradingClient: c, accountHash: 'h' });
    ok(n.status === 'canceled' && pos.pendingCover, 'the pulled replacement does NOT clear the pending cover');
    o.fillPrice = 4.0; o.fillSide = 'DEBIT';
    const d = [];
    trader.applyBrokerFills(rec.state, cfg, { fillSource: 'broker' }, d);
    ok(pos.covered === true && pos.coverLimit === 4.0, 'so the old order\'s fill BOOKS (no double cover, no lost fill)');
  }
  // The normal case: the old order confirms REPLACED and nothing happens to the position.
  {
    const pos = coverPos(), rec = { state: { positions: [pos], liveOrders: pair() }, events: [] };
    await OM.reconcile(rec, { tradingClient: client({ old: 'REPLACED' }), accountHash: 'h' });
    ok(rec.state.liveOrders[0].status === 'canceled' && rec.state.liveOrders[0].canceledReason === 'replaced',
      'REPLACED on the old row completes the replace');
    ok(pos.pendingCover && pos.pendingCover.orderId === 'new', 'and the cover stays tracked on the new order');
  }
  // The replace is REFUSED and the original keeps working: track the original again.
  {
    const pos = coverPos(), rec = { state: { positions: [pos], liveOrders: pair() }, events: [] };
    await OM.reconcile(rec, { tradingClient: client({ new: 'REJECTED' }), accountHash: 'h' });
    ok(pos.pendingCover && pos.pendingCover.orderId === 'old', 'a refused replacement points the cover back at the live original');
    ok(rec.state.liveOrders[0].replacedBy === null && rec.state.liveOrders[0].status === 'working', 'which keeps being polled');
  }
  // An OPEN's first row has no positionId; a fill on it during the replace still finds the position.
  {
    const pos = { id: 'po', side: 'bull', filled: false, quantity: 1, limit: 6.0, orderId: 'onew',
      legs: [P('long', 'C', 30890), P('short', 'C', 30900)] };
    const rec = { state: { positions: [pos], pendingOpenId: 'po', liveOrders: [
      { orderId: 'oold', kind: 'open', positionId: 'po', net: 'NET_DEBIT', status: 'filled', fillPrice: 5.8, fillSide: 'DEBIT', replacedBy: 'onew' },
      { orderId: 'onew', kind: 'open-reprice', positionId: 'po', net: 'NET_DEBIT', status: 'canceled', supersededByFill: 'oold', replaces: 'oold' }] } };
    trader.applyBrokerFills(rec.state, cfg, { fillSource: 'broker' }, []);
    ok(pos.filled === true && pos.limit === 5.8, 'the original open\'s fill books at its own price');
  }
  // ── LOGGING: an unbooked broker fill is a decision and an error line, not a silent flag ─────────────
  {
    const st = { positions: [], liveOrders: [{ orderId: 'x', kind: 'open-reprice', positionId: 'gone', status: 'filled', fillPrice: 6, fillSide: 'DEBIT', net: 'NET_DEBIT' }] };
    const d = [];
    const orig = console.error; console.error = () => {};
    trader.applyBrokerFills(st, cfg, { fillSource: 'broker' }, d);
    console.error = orig;
    const u = d.find((x) => x.action === 'broker-fill-unbooked');
    ok(u && u.why === 'no-position' && u.brokerPrice === 6, 'a fill with no position is reported (the 10-02 orphan was silent)');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL: threw ->', e && e.stack); process.exit(1); });
