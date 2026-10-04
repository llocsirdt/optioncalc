'use strict';
// 2026-10-04 pre-Monday sweep fixes:
//   #1 the governor judges a give-up / ladder RAISE before it is sent (broker fills bypass the fill-time check)
//   #3 a rejection's reason is kept, repeated rejections alarm, and a fill resets the count
//   #7 a refused replacement restores the PRICE as well as the order id
const os = require('os'), path = require('path'), fs = require('fs');
process.env.CANDLE_SPREAD_RUNS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-pm-'));
const trader = require('../../src/candle-spread/trader');
const OM = require('../../src/candle-spread/order-manager');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const P = (side, type, strike) => ({ side, type, strike });
const cfg = { spreadWidth: 10, tickIncrement: 0.05, quantity: 1, coverFillModel: 'resting' };

(async () => {
  // ── #1 ──────────────────────────────────────────────────────────────────────────────────────────────
  // The 10-02 bear (open 5.28, cover resting at 4.70) with two naked bulls. Its cover at 4.70 keeps the floor
  // at -1,178; give-up would raise it to 5.20 -> floor -1,228. With lossMax 1,200 that raise must not go out.
  const mkBook = () => ({ positions: [
    { id: 'bear', side: 'bear', filled: true, quantity: 1, limit: 5.28, covered: false, shortStrike: 30990,
      legs: [P('long', 'P', 31000), P('short', 'P', 30990)],
      pendingCover: { legs: [P('short', 'C', 30990), P('long', 'C', 30980)], target: 4.7, openCost: 5.28, minLock: 0,
        orderId: 'cov-bear', sentNet: 'DEBIT', placedEpoch: Date.now(), placedUnder: 30950 } },
    { id: 'b1', side: 'bull', filled: true, quantity: 1, limit: 6.0, covered: false, legs: [P('long', 'C', 30980), P('short', 'C', 30990)] },
    { id: 'b2', side: 'bull', filled: true, quantity: 1, limit: 5.8, covered: false, legs: [P('long', 'C', 30970), P('short', 'C', 30980)] }],
    liveOrders: [{ orderId: 'cov-bear', kind: 'cover-rest', positionId: 'bear', status: 'working' }] });
  // NDX at 31,010 — 20 points THROUGH the bear's 30,990 short: give-up fires
  const getLeg = (type, k) => { const S = 31010; const mid = type === 'C' ? Math.max(0.5, S - k + 5) : Math.max(0.5, k - S + 5); return { mid, bid: mid - 0.1, ask: mid + 0.1, symbol: `S${type}${k}` }; };
  const sent = [];
  const deps = (lossMax) => ({ fillSource: 'broker', lossMax, getLeg, coverGiveUp: true, giveUpPoints: 10, giveUpMaxLoss: 0.05, underlying: 31010,
    replaceOrder: async (id, payload) => { sent.push(payload.price); return { status: 'replaced', orderId: id + 'r' }; } });
  {
    const st = mkBook(), d = [];
    await trader.workRestingCovers(st, cfg, d, deps(1200), 31010);
    ok(sent.length === 0, 'with lossMax 1,200 the give-up raise is NOT sent');
    ok(st.positions[0].pendingCover.target === 4.7, 'and the cover keeps its current price');
    const dec = d.find((x) => x.action === 'cover-giveup-defer-governor');
    ok(dec && Math.round(dec.floorIfBooked) === -1228, `logged with the floor it would have caused (${dec && dec.floorIfBooked})`);
    const d2 = [];
    await trader.workRestingCovers(st, cfg, d2, deps(1200), 31010);
    ok(!d2.some((x) => x.action === 'cover-giveup-defer-governor'), 'logged once, not every pass');
  }
  {
    const st = mkBook();
    await trader.workRestingCovers(st, cfg, [], deps(1500), 31010);
    ok(sent.length === 1 && sent[0] === 5.2 && st.positions[0].pendingCover.target === 5.2, `with room under lossMax 1,500 the give-up goes out at 5.20 (${sent[0]})`);
  }
  {
    const st = mkBook(); sent.length = 0;
    await trader.workRestingCovers(st, cfg, [], { ...deps(1200), fillSource: 'mark' }, 31010);
    ok(st.positions[0].pendingCover.target === 5.2, 'the mark path is unchanged (it defers at fill time instead)');
  }

  // ── #3 ──────────────────────────────────────────────────────────────────────────────────────────────
  {
    const pos = { id: 'p9', side: 'bull', filled: true, quantity: 1, limit: 5.7, covered: false, legs: [P('long', 'C', 30960), P('short', 'C', 30970)],
      pendingCover: { legs: [P('short', 'P', 30970), P('long', 'P', 30980)], target: 3.3, orderId: 'r1' } };
    const rec = { state: { positions: [pos], liveOrders: [] }, events: [] };
    const client = (id) => ({ orderById: async () => ({ status: 'REJECTED', statusDescription: 'Invalid price increment' }), orderDelete: async () => {} });
    const errs = []; const orig = console.error; console.error = (m) => errs.push(String(m));
    for (let k = 1; k <= 3; k++) {
      pos.pendingCover = { legs: pos.pendingCover ? pos.pendingCover.legs : [P('short', 'P', 30970), P('long', 'P', 30980)], target: 3.3, orderId: 'r' + k };
      rec.state.liveOrders.push({ orderId: 'r' + k, kind: 'cover-rest', positionId: 'p9', status: 'working', sentPrice: 3.3, placedAt: Date.now() });
      await OM.reconcile(rec, { tradingClient: client(), accountHash: 'h' });
    }
    console.error = orig;
    const row = rec.state.liveOrders[2];
    ok(row.status === 'rejected' && row.statusReason === 'Invalid price increment', 'Schwab\'s reason is kept on the row');
    ok(rec.events.some((e) => e.type === 'order_dead' && /Invalid price increment/.test(e.note)), 'and in the dead-order event');
    ok(rec.state.rejectStreaks['cover:p9'].count === 3, 'three rejections in a row are counted');
    ok(rec.events.some((e) => e.type === 'order_reject_streak' && e.count === 3) && errs.some((m) => /REPEATED REJECTION x3/.test(m)), 'and the third one ALARMS');
    // a fill resets it
    pos.pendingCover = { legs: [P('short', 'P', 30970), P('long', 'P', 30980)], target: 3.3, orderId: 'f1', sentNet: 'DEBIT' };
    rec.state.liveOrders.push({ orderId: 'f1', kind: 'cover-rest', positionId: 'p9', status: 'filled', fillPrice: 3.3, fillSide: 'DEBIT', net: 'NET_DEBIT' });
    trader.applyBrokerFills(rec.state, cfg, { fillSource: 'broker' }, []);
    ok(pos.covered && !rec.state.rejectStreaks['cover:p9'], 'a fill clears the streak');
  }

  // ── #7 ──────────────────────────────────────────────────────────────────────────────────────────────
  {
    const pos = { id: 'pc1', side: 'bull', filled: true, quantity: 1, limit: 6.0, covered: false, legs: [P('long', 'C', 30980), P('short', 'C', 30990)],
      pendingCover: { legs: [P('short', 'P', 30990), P('long', 'P', 31000)], target: 4.0, orderId: 'new', sentNet: 'DEBIT', ladderStep: 3, gaveUp: true } };
    const rec = { state: { positions: [pos], liveOrders: [
      { orderId: 'old', kind: 'cover-rest', positionId: 'pc1', status: 'working', replacedBy: 'new', placedAt: Date.now() },
      { orderId: 'new', kind: 'cover-giveup', positionId: 'pc1', status: 'working', replaces: 'old', prior: { target: 3.5, sentCredit: null }, placedAt: Date.now() }] }, events: [] };
    await OM.reconcile(rec, { tradingClient: { orderById: async (_h, id) => ({ status: id === 'new' ? 'REJECTED' : 'WORKING' }), orderDelete: async () => {} }, accountHash: 'h' });
    const pc = pos.pendingCover;
    ok(pc.orderId === 'old' && pc.target === 3.5, `a refused replacement restores the id AND the price (${pc.orderId} @ ${pc.target})`);
    ok(pc.ladderStep == null && pc.gaveUp === false, 'and lets the ladder / give-up re-take their step');
  }

  // ── #4: hedge prices land on the $0.05 tick, rounded UP ────────────────────────────────────────────
  {
    const cases = [[6.77, 6.8], [1.22, 1.25], [3.1, 3.1], [3.3000000000000003, 3.3], [0.01, 0.05], [2.051, 2.05], [2.06, 2.1]]   // cents first: 2.051 is 2.05, already on the tick;
    for (const [x, want] of cases) ok(trader.tickUp(x, 0.05) === want, `tickUp(${x}) = ${want} (got ${trader.tickUp(x, 0.05)})`);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL: threw ->', e && e.stack); process.exit(1); });
