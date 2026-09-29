'use strict';
// CLOSED-LOOP FILLS: trader.applyBrokerFills books what the BROKER did, from the order row the poller
// wrote. The measurement that motivated it (book-reconcile, prod v7-10 2026-09-25): 16 opens and 13 covers
// believed by the engine, 0 of 33 sent orders filled at the broker — 29 of 29 positions phantom.
//
// What has to hold:
//   1. inert unless deps.fillSource === 'broker' (79 simulated variants + every backtest depend on this)
//   2. the fill price is the BROKER'S, translated through parity so the record stays debit-canonical
//   3. a cover books the same floor the mark path books: (min(W, coverWidth) - limit - coverLimit) * 100 * q
//   4. exactly once, however many times it runs
//   5. the mark path books NOTHING while the broker is authoritative
const trader = require('../../src/candle-spread/trader');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const near = (a, b, e = 0.011) => Math.abs(a - b) < e;

const cfg = { spreadWidth: 20, strikeIncrement: 10, tickIncrement: 0.05, quantity: 2 };
const mkPos = (over = {}) => ({
  id: 'pos-1', side: 'bull', shortStrike: 120, quantity: 2,
  legs: [{ side: 'long', type: 'C', strike: 100 }, { side: 'short', type: 'C', strike: 120 }],
  limit: 8, filled: false, covered: false, pendingCover: null, orderId: 'ord-o', ...over });
const mkSt = (pos, los) => ({ positions: [pos], liveOrders: los, realizedPnl: 0, cashDeployed: 0,
  peakCashDeployed: 0, lastCandleTime: 't', lastCandleEpoch: 1 });

// ── 1. INERT BY DEFAULT ─────────────────────────────────────────────────────────────────────────────
{
  const pos = mkPos();
  const st = mkSt(pos, [{ orderId: 'ord-o', kind: 'open', status: 'filled', fillPrice: 7.5, fillSide: 'DEBIT' }]);
  const d = [];
  ok(trader.applyBrokerFills(st, cfg, {}, d) === 0, 'no fillSource -> applies nothing');
  ok(trader.applyBrokerFills(st, cfg, { fillSource: 'mark' }, d) === 0, "fillSource 'mark' -> applies nothing");
  ok(pos.filled === false && st.cashDeployed === 0 && d.length === 0,
    'and the position, the cash ledger and the decision log are all untouched');
}

// ── 2. A DEBIT OPEN BOOKS AT THE BROKER'S PRICE, NOT OURS ───────────────────────────────────────────
{
  const pos = mkPos({ limit: 8 });                       // we asked 8.00
  const lo = { orderId: 'ord-o', kind: 'open', status: 'filled', fillPrice: 7.55, fillSide: 'DEBIT' };
  const st = mkSt(pos, [lo]);
  const d = [];
  const n = trader.applyBrokerFills(st, cfg, { fillSource: 'broker' }, d);
  ok(n === 1, `one fill applied (${n})`);
  ok(pos.filled === true && pos.orderStatus === 'filled', 'the position is filled');
  ok(near(pos.limit, 7.55), `booked at the BROKER'S 7.55, not our 8.00 (${pos.limit})`);
  ok(near(st.cashDeployed, 7.55 * 100 * 2), `cash is the real debit x 100 x qty 2 (${st.cashDeployed})`);
  const dec = d.find((x) => x.action === 'open-fill');
  ok(dec && dec.source === 'broker' && near(dec.brokerPrice, 7.55), 'logged as source broker with the real price');
  // 4. IDEMPOTENT
  const again = trader.applyBrokerFills(st, cfg, { fillSource: 'broker' }, d);
  ok(again === 0 && near(st.cashDeployed, 7.55 * 100 * 2),
    'running again applies nothing and does not double the cash');
}

// ── 3. A CREDIT TWIN FILLS AT A CREDIT AND IS RECORDED DEBIT-CANONICALLY ────────────────────────────
// The whole point of the debit-canonical record: floor/settlement/governor arithmetic sees ONE convention
// no matter which twin went to the broker. Parity is sentLimit == W - limit, exactly.
{
  const pos = mkPos({ sentNet: 'CREDIT', sentLimit: 12, limit: 8,
    sentLegs: [{ side: 'short', type: 'C', strike: 100 }, { side: 'long', type: 'C', strike: 120 }] });
  const st = mkSt(pos, [{ orderId: 'ord-o', kind: 'open', status: 'filled', fillPrice: 12.4, fillSide: 'CREDIT' }]);
  const d = [];
  trader.applyBrokerFills(st, cfg, { fillSource: 'broker' }, d);
  ok(near(pos.sentLimit, 12.4), `the twin records the credit it RECEIVED (${pos.sentLimit})`);
  ok(near(pos.limit, 20 - 12.4), `the canonical record is W - credit = 7.60 (${pos.limit})`);
  ok(near(pos.sentLimit + pos.limit, cfg.spreadWidth), 'PARITY: sentLimit + limit == W');
  ok(near(st.cashDeployed, -12.4 * 100 * 2), `a credit open RELEASES capital (${st.cashDeployed})`);
}

// ── 4. A COVER BOOKS THE SAME FLOOR THE MARK PATH BOOKS ─────────────────────────────────────────────
// floorW = min(spreadWidth, coverWidth): a WIDER cover does not raise the guarantee.
{
  const pos = mkPos({ filled: true, limit: 8 });
  // A 10-wide cover against a 20-wide open -> floorW is 10, not 20.
  pos.pendingCover = { orderId: 'ord-c', target: 3,
    legs: [{ side: 'long', type: 'C', strike: 110 }, { side: 'short', type: 'C', strike: 120 }],
    geometry: 'tent', sentNet: 'DEBIT' };
  const st = mkSt(pos, [{ orderId: 'ord-c', kind: 'cover', positionId: 'pos-1', status: 'filled',
    fillPrice: 2.8, fillSide: 'DEBIT' }]);
  const d = [];
  trader.applyBrokerFills(st, cfg, { fillSource: 'broker' }, d);
  ok(pos.covered === true && pos.coverStatus === 'filled', 'the position is covered');
  ok(near(pos.coverLimit, 2.8), `the cover books at the broker's 2.80, not our 3.00 (${pos.coverLimit})`);
  ok(pos.pendingCover === null, 'and the pending cover is cleared');
  const want = (Math.min(20, 10) - 8 - 2.8) * 100 * 2;          // (10 - 8 - 2.8) * 200 = -160
  ok(near(st.realizedPnl, want), `floor = (min(W,cw) - limit - cover) x 100 x q = ${want} (${st.realizedPnl})`);
  const dec = d.find((x) => x.action === 'cover-fill');
  ok(dec && dec.source === 'broker' && near(dec.lockedFloor, want), 'the decision carries the same floor');
}

// ── 5. A CREDIT COVER: RECEIVED CREDIT -> CANONICAL, AND IT FREES CAPITAL ───────────────────────────
{
  const pos = mkPos({ filled: true, limit: 8 });
  pos.pendingCover = { orderId: 'ord-c', target: 5, sentNet: 'CREDIT', sentCredit: 15,
    legs: [{ side: 'short', type: 'C', strike: 120 }, { side: 'long', type: 'C', strike: 140 }],
    geometry: 'credit' };
  const st = mkSt(pos, [{ orderId: 'ord-c', kind: 'credit-cover', positionId: 'pos-1', status: 'filled',
    fillPrice: 15.6, fillSide: 'CREDIT' }]);
  trader.applyBrokerFills(st, cfg, { fillSource: 'broker' }, []);
  ok(near(pos.coverLimit, 20 - 15.6), `canonical = cw - credit = 4.40 (${pos.coverLimit})`);
  ok(pos.coverSentNet === 'CREDIT' && near(pos.coverSentCredit, 15.6), 'the as-sent twin records the real credit');
  ok(near(st.realizedPnl, (20 - 8 - 4.4) * 100 * 2), `floor off the canonical figures (${st.realizedPnl})`);
  ok(st.cashDeployed < 0, 'a credit cover releases deployed capital');
}

// ── 6. NOTHING IS INVENTED WHEN THE FILL CANNOT BE PRICED ───────────────────────────────────────────
// extractFillNet returns null when the broker response carries no usable price. Booking a guess here is
// exactly the fabrication this change exists to remove.
{
  const pos = mkPos();
  const lo = { orderId: 'ord-o', kind: 'open', status: 'filled', fillPrice: null };
  const st = mkSt(pos, [lo]);
  const d = [];
  ok(trader.applyBrokerFills(st, cfg, { fillSource: 'broker' }, d) === 0, 'an unpriced fill books nothing');
  ok(pos.filled === false, 'the position stays unfilled');
  ok(lo.brokerApplied === 'unpriced' && d.some((x) => x.action === 'broker-fill-unpriced'),
    'and it is flagged rather than guessed');
}

// ── 6b. A FILL ON THE OTHER SIDE IS REFUSED, NOT BOOKED ─────────────────────────────────────────────
// order-manager derives fillSide from the legs that actually executed, independently of what we asked for.
// When it contradicts the order's own net, booking either reading is a guess — and the direction here comes
// from sentNet, so a contradicted side moves cash the wrong way ($2,400 on a $12 fill of one contract) and
// breaks the sentLimit + limit == W parity the floor, cashDeployed and the governor's bookFloor rest on.
// order-manager already flagged this as `wrongSide`; nothing refused the fill, so the detector logged while
// the book was written wrong anyway.
{
  const pos = mkPos({ sentNet: 'CREDIT', sentLimit: 12, limit: 8,
    sentLegs: [{ side: 'short', type: 'C', strike: 100 }, { side: 'long', type: 'C', strike: 120 }] });
  const lo = { orderId: 'ord-o', kind: 'open', status: 'filled', fillPrice: 12.4,
    net: 'NET_CREDIT', fillSide: 'DEBIT' };          // sent CREDIT, broker says DEBIT
  const st = mkSt(pos, [lo]);
  const d = [];
  const n = trader.applyBrokerFills(st, cfg, { fillSource: 'broker' }, d);
  ok(n === 0, `a contradicted side books nothing (applied ${n})`);
  ok(pos.filled === false && st.cashDeployed === 0, 'the position is untouched and no cash moves');
  ok(lo.brokerApplied === 'wrong-side', "the order records why it was refused ('wrong-side')");
  const dec = d.find((x) => x.action === 'broker-fill-wrong-side');
  ok(dec && dec.sentNet === 'NET_CREDIT' && dec.fillSide === 'DEBIT',
    'and the disagreement is logged with both sides, so it can be investigated');

  // THE CONTROL: the same fill with the sides AGREEING must book normally — otherwise this proves nothing
  // except that a guard exists.
  const pos2 = mkPos({ sentNet: 'CREDIT', sentLimit: 12, limit: 8,
    sentLegs: [{ side: 'short', type: 'C', strike: 100 }, { side: 'long', type: 'C', strike: 120 }] });
  const st2 = mkSt(pos2, [{ orderId: 'ord-o', kind: 'open', status: 'filled', fillPrice: 12.4,
    net: 'NET_CREDIT', fillSide: 'CREDIT' }]);
  ok(trader.applyBrokerFills(st2, cfg, { fillSource: 'broker' }, []) === 1,
    'control: sides agreeing, the same fill books');
  ok(near(pos2.sentLimit + pos2.limit, cfg.spreadWidth), 'and parity holds on the booked one');

  // An order with no `net` recorded cannot be contradicted — it must still book rather than stall forever.
  const pos3 = mkPos({ limit: 8 });
  const st3 = mkSt(pos3, [{ orderId: 'ord-o', kind: 'open', status: 'filled', fillPrice: 7.55 }]);
  ok(trader.applyBrokerFills(st3, cfg, { fillSource: 'broker' }, []) === 1,
    'an order carrying no sent side is not treated as contradicted');
}

// ── 7. NO DOUBLE BOOKING AGAINST A POSITION THE MARK PATH ALREADY FILLED ────────────────────────────
{
  const pos = mkPos({ filled: true, limit: 8 });
  const lo = { orderId: 'ord-o', kind: 'open', status: 'filled', fillPrice: 7.5 };
  const st = mkSt(pos, [lo]);
  trader.applyBrokerFills(st, cfg, { fillSource: 'broker' }, []);
  ok(near(pos.limit, 8) && st.cashDeployed === 0, 'an already-filled open is not re-booked');
  ok(lo.brokerApplied === 'already', 'and the order says why it was skipped');
}

// ── 8. THE MARK PATH STANDS DOWN WHILE THE BROKER IS AUTHORITATIVE ──────────────────────────────────
// A mark that would obviously fill (the market at zero against a positive limit) must book nothing.
(async () => {
  const bs = require('../../src/candle-spread/bs-pricer');
  const getLeg = (type, strike) => { const mid = bs.bsPrice(type, 100, strike, 0.01, 0.4);
    return mid == null ? null : { mid: Math.round(mid * 100) / 100, bid: mid - 0.1, ask: mid + 0.1, symbol: `X${type}${strike}` }; };
  const cfg2 = { spreadWidth: 20, strikeIncrement: 10, tickIncrement: 0.05, quantity: 1 };
  const mk = () => {
    const pos = { id: 'p', side: 'bull', shortStrike: 120, quantity: 1, filled: false, covered: false,
      legs: [{ side: 'long', type: 'C', strike: 100 }, { side: 'short', type: 'C', strike: 120 }],
      limit: 19.5, cap: 19.5, pendingCover: null };   // far above the mark -> fills instantly on the mark
    return { positions: [pos], pendingOpenId: 'p', realizedPnl: 0, cashDeployed: 0, liveOrders: [] };
  };
  const a = mk();
  await trader.resolvePendingOpen(a, cfg2, { getLeg, strikeIncrement: 10 }, []);
  ok(a.positions[0].filled === true, 'control: on the mark path this open fills (otherwise 8 proves nothing)');
  const b = mk();
  const db = [];
  await trader.resolvePendingOpen(b, cfg2, { getLeg, strikeIncrement: 10, fillSource: 'broker' }, db);
  ok(b.positions[0].filled !== true, 'under broker fills the SAME open does not fill on the mark');
  ok(b.cashDeployed === 0, 'and no cash is deployed');
  ok(db.some((x) => x.action === 'open-mark-fillable'),
    'but the near-miss is logged, so the evidence is not lost');

  // Covers, same control/treatment pair.
  const mkC = () => {
    const pos = { id: 'p', side: 'bull', shortStrike: 120, quantity: 1, filled: true, covered: false,
      legs: [{ side: 'long', type: 'C', strike: 100 }, { side: 'short', type: 'C', strike: 120 }], limit: 8 };
    pos.pendingCover = { target: 19.5, orderId: 'c', sentNet: 'DEBIT',
      legs: [{ side: 'long', type: 'C', strike: 110 }, { side: 'short', type: 'C', strike: 120 }] };
    return { positions: [pos], realizedPnl: 0, cashDeployed: 0, liveOrders: [] };
  };
  const c = mkC();
  trader.resolveRestingCovers(c, cfg2, getLeg, [], { getLeg, strikeIncrement: 10 });
  ok(c.positions[0].covered === true, 'control: on the mark path this cover fills');
  const e = mkC();
  trader.resolveRestingCovers(e, cfg2, getLeg, [], { getLeg, strikeIncrement: 10, fillSource: 'broker' });
  ok(e.positions[0].covered !== true && e.realizedPnl === 0,
    'under broker fills the SAME cover books no floor on the mark');
  ok(e.positions[0].pendingCover && e.positions[0].pendingCover.markLow != null,
    'while the low-water observation is still recorded');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
