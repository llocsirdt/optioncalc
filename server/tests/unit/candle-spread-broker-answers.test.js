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
    const st = { positions: [hp], cashDeployed: 0, liveOrders: [{ orderId: 'hy', kind: 'wing', status: 'working' }] };
    const cancels = [];
    // like index.makeCancelOrder: an ACCEPTED cancel marks the order row
    const deps = { fillSource: 'broker', nowMs: 11 * 60000, getLeg, strikeIncrement: 10,
      cancelOrder: async (id, m) => { cancels.push({ id, m }); const r = st.liveOrders.find((o) => o.orderId === id); if (r) r.cancelRequestedAt = 1; return { status: 'cancelled' }; } };
    const d = [];
    trader.resolvePendingHedges(st, { tickIncrement: 0.05, spreadWidth: 10 }, deps, d);
    await new Promise((r) => setImmediate(r));
    ok(cancels.length === 1 && cancels[0].id === 'hy', 'past the TTL the hedge order is cancelled AT THE BROKER');
    ok(st.positions.includes(hp) && hp.pendingHedge && st.liveOrders[0].cancelRequestedAt,
      'and the hedge is kept pending (holds its slot) with the cancel recorded on the ORDER ROW');
    ok(d.some((x) => x.action === 'wing-expire-cancel'), 'logged as expire-cancel');
    const fresh = JSON.parse(JSON.stringify(st));   // the next pass reads the record from disk
    trader.resolvePendingHedges(fresh, { tickIncrement: 0.05, spreadWidth: 10 }, deps, d);
    ok(cancels.length === 1, 'a later pass does not cancel again — the row says a cancel is under way');
    // A FAILED cancel leaves no mark, so the next pass retries it (it used to freeze the hedge all day).
    {
      const hp2 = { id: 'h3', side: 'wing', legs: [{ side: 'long', type: 'C', strike: 100 }], filled: false, orderId: 'hz',
        pendingHedge: { kind: 'wing', limit: 1.0, orderId: 'hz', placedEpoch: 0 } };
      const st2 = { positions: [hp2], cashDeployed: 0, liveOrders: [{ orderId: 'hz', kind: 'wing', status: 'working' }] };
      let n = 0;
      const failing = { ...deps, cancelOrder: async () => { n++; return { status: 'error', error: '503' }; } };
      trader.resolvePendingHedges(st2, { tickIncrement: 0.05, spreadWidth: 10 }, failing, []);
      await new Promise((r) => setImmediate(r));
      ok(n === 1 && !st2.liveOrders[0].cancelRequestedAt, 'a failed cancel leaves the row unmarked');
      trader.resolvePendingHedges(JSON.parse(JSON.stringify(st2)), { tickIncrement: 0.05, spreadWidth: 10 }, failing, []);
      ok(n === 2, 'and the next pass RETRIES it');
    }
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

  // ── 9. A LIVE REPLACE KEEPS THE OLD ROW POLLING UNTIL THE BROKER CONFIRMS IT ──────────────────────
  {
    const c = client(); cs._setDeps({ isProd: true, tradingClient: c, accountHash: 'h' });
    const r = rec({ liveOrders: [{ orderId: 'o1', kind: 'open', positionId: null, status: 'working', net: 'NET_DEBIT', placedAt: Date.now() }] });
    const out = await cs.makeReplaceOrder(run, r)('o1', { orderType: 'NET_DEBIT', price: 6.05, legs: [] }, { kind: 'open-reprice', of: 'p7' });
    const [o, n] = r.state.liveOrders;
    ok(out.orderId === 'o2' && r.state.liveOrders.length === 2, 'the replacement is tracked AND the original row is kept');
    ok(o.replacedBy === 'o2' && o.positionId === 'p7' && o.status === 'working', 'the original is linked, given its position, and still polled');
    ok(n.replaces === 'o1', 'the replacement knows what it replaced');
  }

  // ── 10. THE GOVERNOR REFUSES TO PLACE A COVER WHOSE FILL WOULD BREACH lossMax ───────────────────────
  {
    const P = (side, type, strike) => ({ side, type, strike });
    const legAt = (type, strike) => { const mid = type === 'C' ? Math.max(0.5, (31100 - strike) / 10) : Math.max(0.5, (strike - 30700) / 10);
      return { mid, bid: mid - 0.1, ask: mid + 0.1, symbol: `S${type}${strike}` }; };
    const mkBook = () => ({ positions: [
      { id: 'bear', side: 'bear', filled: true, quantity: 1, limit: 5.28, covered: false, shortStrike: 30990,
        legs: [P('long', 'P', 31000), P('short', 'P', 30990)] },
      { id: 'b1', side: 'bull', filled: true, quantity: 1, limit: 6.0, covered: false, legs: [P('long', 'C', 30980), P('short', 'C', 30990)] },
      { id: 'b2', side: 'bull', filled: true, quantity: 1, limit: 5.8, covered: false, legs: [P('long', 'C', 30970), P('short', 'C', 30980)] },
      { id: 'b3', side: 'bull', filled: true, quantity: 1, limit: 5.7, covered: false, legs: [P('long', 'C', 30960), P('short', 'C', 30970)] }] });
    const plan = { legs: [P('short', 'C', 30990), P('long', 'C', 30980)], limit: 4.7, mark: 4.7, geometry: 'tent', longStrike: 30980 };
    const cfg = { spreadWidth: 10, tickIncrement: 0.05, quantity: 1, strikeIncrement: 10 };
    const sends = [];
    const deps = (over) => ({ getLeg: legAt, strikeIncrement: 10, capitalRecapture: false, enforceLegUniqueness: false,
      placeOrder: async () => { sends.push(1); return { status: 'sent', orderId: 'c1' }; }, ...over });
    const st = mkBook(), d = [];
    await trader.placeRestingCover(st.positions[0], plan, cfg, deps({ fillSource: 'broker', lossMax: 1500 }), '10/02 10:50', d, 'continuous', 0, st);
    ok(sends.length === 0 && !st.positions[0].pendingCover, 'with three naked bulls the bear cover is NOT placed under the broker');
    ok(d.some((x) => x.action === 'cover-defer-governor' && x.source === 'broker-place'), 'and the deferral is logged');
    const st2 = mkBook();
    await trader.placeRestingCover(st2.positions[0], plan, cfg, deps({ fillSource: 'mark', lossMax: 1500 }), '10/02 10:50', [], 'continuous', 0, st2);
    ok(sends.length === 1, 'the mark path still places it (its deferral happens at fill time, unchanged)');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL: threw ->', e && e.stack); process.exit(1); });
