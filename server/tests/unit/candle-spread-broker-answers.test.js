'use strict';
// THE BROKER'S ANSWER DECIDES, NOT OUR REQUEST. 2026-10-02 asymmetry sweep, the fixes shipped mid-session:
//   1. a HALTED place must read as not-sent (filled:false), or covers/hedges attach orderless pending state
//   2. an expired hedge under the broker is CANCELLED and kept until the broker answers (was: deleted, order left live)
//   3. a rejected/cancelled hedge clears its pendingHedge (clearDeadOrderState had no hedge branch)
//   + a strategy cancel / stale sweep keeps polling until CANCELED; PENDING_CANCEL is not dead
//   + a brake freezes the working open's ladder; the position reconcile compares the legs actually held
process.env.CANDLE_SPREAD_LIVE = 'true';
process.env.CANDLE_SPREAD_ARMED = 'v7-10';
process.env.CANDLE_SPREAD_ARMED_MODE = 'live';
const os = require('os'), path = require('path'), fs = require('fs');
process.env.CANDLE_SPREAD_RUNS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-ba-'));
const cs = require('../../src/candle-spread/index');
const SC = require('../../src/candle-spread/strategy-control');
const OM = require('../../src/candle-spread/order-manager');
const BR = require('../../src/candle-spread/book-reconcile');
const trader = require('../../src/candle-spread/trader');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

function install(file) {
  SC._reset(); SC.seedBaseline({ 'v7-10': 'live' });
  SC._state.variants = SC.normalise(file, null, { liveAllowed: true, baseline: { 'v7-10': 'live' } }).variants;
}
function client(statusOf = {}) {
  const calls = { place: 0, del: [], upd: 0 };
  return { calls,
    placeOrderByAcct: async () => { calls.place++; return { orderId: 'o1' }; },
    updateOrderById: async () => { calls.upd++; return { orderId: 'o2' }; },
    orderDelete: async (_h, id) => { calls.del.push(id); return {}; },
    orderById: async (_h, id) => ({ status: statusOf[id] || 'WORKING' }) };
}
const run = { variant: 'v7-10', spreadWidth: 10, tickIncrement: 0.05, dryRun: false };
const rec = (st = {}) => ({ runId: 'r', config: { variant: 'v7-10' }, state: { liveOrders: [], positions: [], ...st }, events: [] });

(async () => {
  // ── 1. HALT: NOTHING SENT, AND IT SAYS SO ──────────────────────────────────────────────────────────
  {
    install({ variants: { 'v7-10': { restrict: 'halt' } } });
    const c = client(); cs._setDeps({ isProd: true, tradingClient: c, accountHash: 'h' });
    const out = await cs.makePlaceOrder(run, rec())({ orderType: 'NET_DEBIT', price: 3.3, legs: [] }, { kind: 'cover-rest' });
    ok(out.filled === false && out.sent === false, `halted place reads as not-filled (${JSON.stringify(out)})`);
    ok(c.calls.place === 0, 'and nothing reached the broker');
  }
  install({ variants: {} });

  // ── 2. A STRATEGY CANCEL KEEPS THE ROW UNTIL THE BROKER ANSWERS ───────────────────────────────────
  {
    const c = client(); cs._setDeps({ isProd: true, tradingClient: c, accountHash: 'h' });
    const r = rec({ liveOrders: [{ orderId: 'x1', kind: 'open', status: 'working', placedAt: Date.now() }] });
    const out = await cs.makeCancelOrder(run, r)('x1', { kind: 'cancel-open', reason: 'reversal' });
    const row = r.state.liveOrders.find((o) => o.orderId === 'x1');
    ok(out.status === 'cancelled' && c.calls.del[0] === 'x1', 'the DELETE went out');
    ok(row && row.status === 'working' && row.cancelRequestedAt, 'the row is KEPT, marked cancel-requested — not retired');
    const rp = await cs.makeReplaceOrder(run, r)('x1', { orderType: 'NET_DEBIT', price: 6, legs: [] }, { kind: 'open-reprice' });
    ok(rp.status === 'skipped:cancel-requested' && c.calls.upd === 0, 'a reprice of a cancel-requested order is refused');
  }

  // ── 3. THE POLLER RESOLVES IT: PENDING_CANCEL keeps working; CANCELED retires the kept open ────────
  {
    const pos = { id: 'p1', side: 'bull', legs: [], filled: false, orderId: 'x2', cancelRequestedAt: 1 };
    const r = rec({ positions: [pos], liveOrders: [{ orderId: 'x2', kind: 'open', status: 'working', cancelRequestedAt: 1, placedAt: Date.now() }] });
    const st = { x2: 'PENDING_CANCEL' };
    const c = client(st);
    await OM.reconcile(r, { tradingClient: c, accountHash: 'h' });
    ok(r.state.liveOrders[0].status === 'working', 'PENDING_CANCEL is still working — kept polling');
    st.x2 = 'CANCELED';
    await OM.reconcile(r, { tradingClient: c, accountHash: 'h' });
    ok(r.state.liveOrders[0].status === 'canceled' && pos.orderStatus === 'rejected' && pos.filled === false,
      'CANCELED retires the kept open through clearDeadOrderState');
  }

  // ── 4. STALE SWEEP: request, keep polling, then the slot is freed ─────────────────────────────────
  {
    const pos = { id: 'p2', side: 'bull', legs: [], filled: false, orderId: 'x3' };
    const r = rec({ pendingOpenId: 'p2', positions: [pos],
      liveOrders: [{ orderId: 'x3', kind: 'open-reprice', positionId: 'p2', status: 'working', placedAt: Date.now() - 91 * 60000 }] });
    const st = {}; const c = client(st);
    await OM.reconcile(r, { tradingClient: c, accountHash: 'h' });
    ok(c.calls.del.length === 1 && r.state.liveOrders[0].status === 'working' && r.state.liveOrders[0].cancelRequestedAt,
      'the 90m sweep requests the cancel and keeps the row working');
    await OM.reconcile(r, { tradingClient: c, accountHash: 'h' });
    ok(c.calls.del.length === 1, 'and does not re-send the DELETE every poll');
    st.x3 = 'CANCELED';
    await OM.reconcile(r, { tradingClient: c, accountHash: 'h' });
    ok(r.state.pendingOpenId === null, 'the broker\'s CANCELED frees the open slot (was jammed until a reversal)');
  }

  // ── 5. A REJECTED HEDGE CLEARS ITS PENDING STATE ──────────────────────────────────────────────────
  for (const kind of ['floor-offset', 'wing', 'fly']) {
    const hp = { id: 'h1', legs: [{ side: 'long', type: 'C', strike: 100 }], filled: false, orderId: 'hx',
      pendingHedge: { kind: kind === 'floor-offset' ? 'offset' : kind, limit: 1, orderId: 'hx', placedEpoch: 1 } };
    const r = rec({ positions: [hp] });
    const got = OM.clearDeadOrderState(r, { orderId: 'hx', kind, status: 'rejected', positionId: null });
    ok(got === 'hedge' && hp.pendingHedge === null && hp.expired === true, `${kind}: a rejected hedge releases its pending slot`);
  }

  // ── 6. HEDGE TTL UNDER THE BROKER: CANCEL ONCE, KEEP IT PENDING ───────────────────────────────────
  {
    const getLeg = (type, strike) => ({ mid: 5, bid: 4.9, ask: 5.1, symbol: `S${type}${strike}` });
    const hp = { id: 'h2', side: 'wing', legs: [{ side: 'long', type: 'C', strike: 100 }], filled: false, orderId: 'hy',
      pendingHedge: { kind: 'wing', limit: 1.0, orderId: 'hy', placedEpoch: 0 } };
    const st = { positions: [hp], cashDeployed: 0 };
    const cancels = [];
    const deps = { fillSource: 'broker', nowMs: 11 * 60000, getLeg, strikeIncrement: 10,
      cancelOrder: async (id, m) => { cancels.push({ id, m }); return { status: 'cancelled' }; } };
    const d = [];
    trader.resolvePendingHedges(st, { tickIncrement: 0.05, spreadWidth: 10 }, deps, d);
    ok(cancels.length === 1 && cancels[0].id === 'hy', 'past the TTL the hedge order is cancelled AT THE BROKER');
    ok(st.positions.includes(hp) && hp.pendingHedge && hp.pendingHedge.cancelRequestedAt,
      'and the hedge is kept pending (holds its slot, nothing re-placed) until the broker answers');
    ok(d.some((x) => x.action === 'wing-expire-cancel'), 'logged as expire-cancel');
    trader.resolvePendingHedges(st, { tickIncrement: 0.05, spreadWidth: 10 }, deps, d);
    ok(cancels.length === 1, 'a second pass does not cancel again');
    // Then the broker fills it before the cancel lands -> it books normally.
    st.liveOrders = [{ orderId: 'hy', kind: 'wing', status: 'filled', fillPrice: 1.0, fillSide: 'DEBIT', net: 'NET_DEBIT' }];
    trader.applyBrokerFills(st, { spreadWidth: 10, quantity: 1 }, { fillSource: 'broker' }, d);
    ok(hp.filled === true && st.cashDeployed === 100, 'a fill that beat the cancel is booked, not dropped');
  }

  // ── 7. A BRAKE FREEZES THE WORKING OPEN'S LADDER ──────────────────────────────────────────────────
  {
    const getLeg = (type, strike) => ({ mid: strike === 100 ? 9 : 2.5, bid: 0, ask: 20, symbol: `S${type}${strike}` });
    const mk = () => ({ id: 'p9', side: 'bull', legs: [{ side: 'long', type: 'C', strike: 100 }, { side: 'short', type: 'C', strike: 110 }],
      filled: false, limit: 6.0, cap: 7.0, orderId: 'z', quantity: 1, placedEpoch: 0 });
    const cfg = { tickIncrement: 0.05, spreadWidth: 10, quantity: 1 };
    const a = mk(), sa = { positions: [a], pendingOpenId: 'p9' };
    await trader.resolvePendingOpen(sa, cfg, { fillSource: 'broker', getLeg, coverLadder: true, strikeIncrement: 10, nowMs: 300000 }, []);
    ok(a.limit > 6.0, `control: with no brake the ladder walks (${a.limit})`);
    const b = mk(), sb = { positions: [b], pendingOpenId: 'p9' };
    const db = [];
    await trader.resolvePendingOpen(sb, cfg, { fillSource: 'broker', getLeg, coverLadder: true, strikeIncrement: 10, nowMs: 300000, blockNewOpens: true }, db);
    ok(b.limit === 6.0 && db.some((x) => /ladder frozen/.test(x.reason || '')), 'under a brake the working open is NOT walked');
  }

  // ── 8. THE POSITION RECONCILE COMPARES THE LEGS THE ACCOUNT HOLDS ─────────────────────────────────
  {
    const r = { config: { quantity: 1 }, state: { positions: [{ filled: true, quantity: 1, sentNet: 'CREDIT',
      legs: [{ side: 'long', type: 'C', strike: 100 }, { side: 'short', type: 'C', strike: 110 }],
      sentLegs: [{ side: 'short', type: 'P', strike: 110 }, { side: 'long', type: 'P', strike: 100 }],
      covered: true, coverSentNet: 'CREDIT',
      coverLegs: [{ side: 'short', type: 'P', strike: 110 }, { side: 'long', type: 'P', strike: 120 }] }] } };
    const m = BR.engineLegs(r);
    ok(!m.has('C100') && m.get('P100') === 1 && m.get('P110') === -1, 'a credit open counts its PUT twin, not the canonical calls');
    ok(m.get('C110') === -1 && m.get('C120') === 1, 'a credit cover counts the type-flipped legs actually sent');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL: threw ->', e && e.stack); process.exit(1); });
