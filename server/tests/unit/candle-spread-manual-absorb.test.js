'use strict';
// MANUAL ORDER ABSORPTION (2026-10-13). The user's hand-placed iron condor (long P30520 / short P30530 / short C30540 /
// long C30550, $8.20 credit) sat in the account but never in the engine's book: the floor still showed the −$244
// low spot at 30530-30540 as unrepaired. Absorbed orders join the book as hedges, count against the cap, are booked
// at the true net, and are never booked twice.
//
// Run: node server/tests/unit/candle-spread-manual-absorb.test.js
const MA = require('../../src/candle-spread/manual-absorb');
const RC = require('../../src/candle-spread/risk-curve');
const BR = require('../../src/candle-spread/book-reconcile');
const trader = require('../../src/candle-spread/trader');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const near = (a, b, e = 0.005) => Math.abs(a - b) <= e;

const EXP = '2026-10-13';
const sym = (t, k) => `NDXP  261013${t}${String(k * 1000).padStart(8, '0')}`;
// A Schwab order as ordersByAccount returns it. legs: [instruction, type, strike, qty, execPrice]
function order(id, legs, { status = 'FILLED', type = 'NET_CREDIT', price = 8.2, symbolOf = sym } = {}) {
  return { orderId: id, status, orderType: type, price, quantity: legs[0][3], filledQuantity: status === 'FILLED' ? legs[0][3] : 0,
    closeTime: '2026-10-13T18:31:00+0000', enteredTime: '2026-10-13T18:30:40+0000',
    orderLegCollection: legs.map(([ins, t, k, q], i) => ({ legId: i + 1, instruction: ins, quantity: q, instrument: { symbol: symbolOf(t, k) } })),
    orderActivityCollection: [{ executionLegs: legs.map(([, , , q, px], i) => ({ legId: i + 1, quantity: q, price: px })) }] };
}
const CONDOR = order(9001, [['BUY_TO_OPEN', 'P', 30520, 1, 10.0], ['SELL_TO_OPEN', 'P', 30530, 1, 14.0],
  ['SELL_TO_OPEN', 'C', 30540, 1, 12.2], ['BUY_TO_OPEN', 'C', 30550, 1, 8.0]]);
const ENGINE_ORDER = order(5001, [['BUY_TO_OPEN', 'C', 30530, 1, 9.0], ['SELL_TO_OPEN', 'C', 30540, 1, 3.6]], { type: 'NET_DEBIT', price: 5.4 });

// An engine book with a low spot at 30530-30540: a bull C30530/30540 @ 5.40 and a bear P30540/30530 @ 5.00.
function engineRecord() {
  return { config: { variant: 'v7-10', symbol: 'NDX', expiration: EXP, dryRun: false, quantity: 1 },
    state: { positions: [
      { id: 'pos-1', side: 'bull', filled: true, legs: [{ side: 'long', type: 'C', strike: 30530 }, { side: 'short', type: 'C', strike: 30540 }], limit: 5.4, quantity: 1, orderId: '5001', covered: false },
      { id: 'pos-2', side: 'bear', filled: true, legs: [{ side: 'long', type: 'P', strike: 30540 }, { side: 'short', type: 'P', strike: 30530 }], limit: 5.0, quantity: 1, orderId: '5002', covered: false },
    ], liveOrders: [{ orderId: '5001', kind: 'open', status: 'filled', fillPrice: 5.4 }, { orderId: '5002', kind: 'open', status: 'filled', fillPrice: 5.0 }],
    legLedger: {}, cashDeployed: 1040 } };
}

(async () => {
  // ── 1. the condor joins the book ──────────────────────────────────────────────────────────────────────
  const rec = engineRecord();
  const before35 = RC.bookPnl(rec.state.positions, 30535), before60 = RC.bookPnl(rec.state.positions, 30600);
  const res = MA.absorbManualOrders(rec, { orders: [CONDOR, ENGINE_ORDER], knownOrderIds: new Set(['5001', '5002']) });
  ok(res.added.length === 1, 'one manual order absorbed (the engine order is not)');
  const p = res.added[0];
  ok(p && p.manual && p.hedge && p.side === 'manual' && p.filled, 'flagged manual + hedge, filled');
  ok(p && near(p.limit, -8.2), `booked at the execution net: credit 8.20 (got ${p && p.limit})`);
  ok(p && p.quantity === 1 && p.legs.length === 4, 'four legs, one unit');
  ok(p && near(p.maxLoss, 1.8), `max loss = width − credit = 1.80 (got ${p && p.maxLoss})`);
  ok(rec.state.positions.length === 3 && rec.state.absorbedOrderIds[0] === '9001', 'position + order id recorded on the run');
  ok(near(rec.state.cashDeployed, 1040 - 820, 0.01), 'capital view takes the $820 credit');
  // The risk curve now includes it: +$820 between the shorts, −$180 beyond the wings.
  ok(near(RC.bookPnl(rec.state.positions, 30535) - before35, 820, 0.01), 'curve at 30535 lifted by the $820 credit');
  ok(near(RC.bookPnl(rec.state.positions, 30600) - before60, -180, 0.01), 'curve beyond the wings pays the $180 max loss');
  // The governor's floor (cap room) sees it: −$40 flat engine book + the condor's −$180 tails = −$220.
  ok(near(trader.govFloor(rec.state, {}), RC.bookFloor(rec.state.positions, null, 10), 0.01)
    && near(RC.bookFloor(rec.state.positions, null, 10), -220, 0.01), `governor floor includes it (−220, got ${trader.govFloor(rec.state, {})})`);
  ok(res.nets.length === 0, 'no engine leg netted (C30540 short on both sides is additive)');

  // ── 2. idempotent ───────────────────────────────────────────────────────────────────────────────────
  const again = MA.absorbManualOrders(rec, { orders: [CONDOR], knownOrderIds: new Set(['5001', '5002']) });
  ok(again.added.length === 0 && rec.state.positions.length === 3, 'a second pass books nothing');

  // ── 3. self-heal: the engine claims the order (adopted manual edit) -> the manual copy goes ────────────
  const healed = MA.absorbManualOrders(rec, { orders: [CONDOR], knownOrderIds: new Set(['5001', '5002', '9001']) });
  ok(healed.removed.length === 1 && rec.state.positions.every((x) => !x.manual), 'manual copy removed once the engine owns the id');
  ok(near(rec.state.cashDeployed, 1040, 0.01) && !rec.state.absorbedOrderIds.length, 'cash and the absorbed list are restored');

  // ── 4. waits while an adoption is pending ─────────────────────────────────────────────────────────────
  const r4 = engineRecord();
  const w = MA.absorbManualOrders(r4, { orders: [CONDOR], knownOrderIds: new Set(['5001', '5002']), adoptionPending: true });
  ok(w.added.length === 0 && r4.state.positions.length === 2, 'nothing absorbed while an engine order awaits adoption');

  // ── 5. ignored: unfilled, other expiration, other underlying ─────────────────────────────────────────
  const r5 = engineRecord();
  const other = MA.absorbManualOrders(r5, { knownOrderIds: new Set(), orders: [
    order(9101, [['BUY_TO_OPEN', 'C', 30600, 1, 2]], { status: 'WORKING' }),
    order(9102, [['BUY_TO_OPEN', 'C', 30600, 1, 2]], { symbolOf: (t, k) => `NDXP  261014${t}${String(k * 1000).padStart(8, '0')}` }),
    order(9103, [['BUY_TO_OPEN', 'C', 600, 1, 2]], { symbolOf: (t, k) => `SPXW  261013${t}${String(k * 1000).padStart(8, '0')}` }),
  ] });
  ok(other.added.length === 0, 'working orders, other expirations and other underlyings are not absorbed');

  // ── 6. ratio order: legs expanded, quantity = common factor ──────────────────────────────────────────
  const r6 = engineRecord();
  const ratio = MA.absorbManualOrders(r6, { knownOrderIds: new Set(), orders: [
    order(9201, [['BUY_TO_OPEN', 'P', 30500, 2, 6.0], ['SELL_TO_OPEN', 'P', 30480, 4, 2.5]], { type: 'NET_DEBIT', price: 1.0 })] });
  const rp = ratio.added[0];
  ok(rp && rp.quantity === 2 && rp.legs.length === 3 && rp.legs.filter((l) => l.side === 'short').length === 2, '2x4 ratio -> qty 2 of [long, short, short]');
  ok(rp && near(rp.limit, 1.0), `net per unit: (2×6 − 4×2.5)/2 = 1.00 (got ${rp && rp.limit})`);

  // ── 7. a manual leg against an engine leg: booked at the true net, and an alert ─────────────────────
  const r7 = engineRecord();   // engine long C30530
  const n7 = MA.absorbManualOrders(r7, { knownOrderIds: new Set(['5001', '5002']), orders: [
    order(9301, [['SELL_TO_OPEN', 'C', 30530, 1, 9.5], ['BUY_TO_OPEN', 'C', 30560, 1, 2.0]], { type: 'NET_CREDIT', price: 7.5 })] });
  ok(n7.added.length === 1, 'still booked');
  ok(n7.nets.length === 1 && n7.nets[0].leg === 'C30530' && n7.nets[0].engine === 1 && n7.nets[0].manual === -1, 'alert names the netted leg');
  ok((BR.engineLegs(r7).get('C30530') || 0) === 0, 'book net on C30530 = 0, what Schwab would report');

  // ── 8. the account check no longer calls the condor unmanaged ───────────────────────────────────────
  const r8 = engineRecord();
  MA.absorbManualOrders(r8, { orders: [CONDOR], knownOrderIds: new Set(['5001', '5002']) });
  const held = new Map();
  for (const [k, q] of BR.engineLegs(r8)) held.set(k, q);
  const details = { securitiesAccount: { positions: [...held].filter(([, q]) => q).map(([k, q]) => ({
    instrument: { assetType: 'OPTION', symbol: sym(k[0], Number(k.slice(1))) }, longQuantity: q > 0 ? q : 0, shortQuantity: q < 0 ? -q : 0 })) } };
  const pr = BR.reconcilePositions(r8, details);
  ok(pr.severity === 'clean' && !pr.diffs.length, `account check clean once absorbed (${pr.severity}, ${pr.diffs.length} diffs)`);
  const prBefore = BR.reconcilePositions(engineRecord(), details);
  ok(prBefore.severity === 'DIVERGENT', 'and DIVERGENT without the absorbed position');
  ok(BR.positionDiffs(r8).length === 0, 'the order-level check reports no phantom for it');

  // ── 9. never covered, counted against the cap at its real risk ──────────────────────────────────────
  // A manual 2-LEG vertical: exactly what continuous covering would rest a cover on if it were an engine open.
  const vert = MA.positionFromOrder({ orderId: '9401', legs: [{ type: 'C', strike: 30530, qty: 1, price: 9 }, { type: 'C', strike: 30540, qty: -1, price: 4 }] });
  const deps = { getLeg: (t, k) => ({ mid: (t === 'C' ? Math.max(30545 - k, 0) : Math.max(k - 30545, 0)) + 2, bid: 1, ask: 3, symbol: `x${t}${k}` }),
    continuousCoverMinLockFrac: 0.05, tickIncrement: 0.05, strikeIncrement: 10 };
  const cfg = { spreadWidth: 10, quantity: 1, coverFillModel: 'resting', tickIncrement: 0.05, symbol: 'NDX', expiration: EXP };
  const coverRun = async (pos) => {
    const st = { positions: [pos] }, sent = [];
    await trader.placeContinuousCovers(st, cfg, { ...deps, nowMs: Date.now(), placeOrder: async (...a) => { sent.push(a); return { orderId: 'x' }; } }, [], '10/13 14:35', 30545);
    return { sent: sent.length, pending: !!st.positions[0].pendingCover };
  };
  const ctl = await coverRun({ ...vert, manual: false, hedge: false, side: 'bull', shortStrike: 30540 });
  ok(ctl.sent === 1 && ctl.pending, 'control: the same vertical as an engine open gets a resting cover');
  const man = await coverRun({ ...vert });
  ok(man.sent === 0 && !man.pending, 'the manual vertical is never covered');
  const r9 = engineRecord();
  MA.absorbManualOrders(r9, { orders: [CONDOR], knownOrderIds: new Set(['5001', '5002']) });
  r9.state.positions = r9.state.positions.filter((x) => x.manual);
  const cs = trader.capState(r9.state, { limit: 5 }, 'bull', cfg, { getLeg: () => ({ mid: 1 }), riskCap: 10000 });
  ok(cs && near(cs.totalUncov, 180, 0.01), `cap counts the condor at its $180 max loss, not its −$820 credit (got ${cs && cs.totalUncov})`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
