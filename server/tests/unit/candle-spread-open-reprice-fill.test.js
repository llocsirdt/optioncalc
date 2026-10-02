'use strict';
// THE FIRST REAL FILL (prod v7-10, 2026-10-02 09:45): the open ladder walked the order to the 6.00 cap,
// the replacement row was tagged 'open-reprice', the broker filled it — and applyBrokerFills only knew
// kind 'open', so it marked the row 'unhandled-kind' and left the position "working". The account held a
// 30890/30900 bull call spread the engine would never cover. This replays that exact record.
const trader = require('../../src/candle-spread/trader');
const BR = require('../../src/candle-spread/book-reconcile');
const OM = require('../../src/candle-spread/order-manager');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

const cfg = { spreadWidth: 10, strikeIncrement: 10, tickIncrement: 0.05, quantity: 1 };
const legs = [{ side: 'long', type: 'C', strike: 30890 }, { side: 'short', type: 'C', strike: 30900 }];
const mk = (over = {}) => {
  const pos = { id: 'pos-1790948707757-10', side: 'bull', legs, quantity: 1, shortStrike: 30900, cap: 6,
    limit: 6, orderStatus: 'sent', filled: false, covered: false, coverId: null, orderId: '1008147955066',
    sentNet: 'DEBIT', sentLimit: 5.8 };
  const lo = { orderId: '1008147955066', kind: 'open-reprice', positionId: pos.id, net: 'NET_DEBIT',
    requestedPrice: 6, sentPrice: 6, testMode: false, legs, status: 'filled', fillPrice: 6,
    fillSide: 'DEBIT', fillFrom: 'executionLegs', ...over };
  const st = { positions: [pos], liveOrders: [lo], realizedPnl: 0, cashDeployed: 0, peakCashDeployed: 0,
    pendingOpenId: pos.id };
  return { pos, lo, st };
};

ok(OM.isOpenKind('open') && OM.isOpenKind('open-reprice'), 'open and open-reprice are both open kinds');
ok(!OM.isOpenKind('combo-lock-open') && !OM.isOpenKind('cover') && !OM.isOpenKind('cover-reprice'),
  'combo-lock-open and covers are not');

// ── 1. A FRESH ROW BOOKS ────────────────────────────────────────────────────────────────────────────
{
  const { pos, lo, st } = mk();
  const d = [];
  ok(trader.applyBrokerFills(st, cfg, { fillSource: 'broker' }, d) === 1, 'the open-reprice fill is applied');
  ok(pos.filled === true && pos.limit === 6 && lo.brokerApplied === true, 'position filled at the broker 6.00');
  ok(st.cashDeployed === 600, `cash deployed $600 (${st.cashDeployed})`);
  ok(!d.some((x) => x.action === 'broker-fill-unhandled'), 'no unhandled decision');
  const r = BR.brokerBook({ state: st });
  ok(r.openFills === 1, `book-reconcile counts it as an open fill (${r.openFills})`);
}

// ── 2. THE ROW PROD ALREADY FLAGGED 'unhandled-kind' IS PICKED UP AFTER THE DEPLOY ──────────────────
{
  const { pos, st } = mk({ brokerApplied: 'unhandled-kind' });
  const d = [];
  ok(trader.applyBrokerFills(st, cfg, { fillSource: 'broker' }, d) === 1, 'the flagged row is retried and booked');
  ok(pos.filled === true && st.cashDeployed === 600, 'and the position is now held');
  ok(trader.applyBrokerFills(st, cfg, { fillSource: 'broker' }, d) === 0 && st.cashDeployed === 600,
    'exactly once');
}

// ── 3. A REPLACE WHOSE NEW ID NEVER CAME BACK: the position still holds the old id ───────────────────
{
  const { pos, st } = mk();
  pos.orderId = 'old-id';
  ok(trader.applyBrokerFills(st, cfg, { fillSource: 'broker' }, []) === 1 && pos.filled,
    'matched through positionId when the order id link is stale');
}

// ── 4. A GENUINELY UNHANDLED KIND IS REPORTED ONCE, NOT EVERY PASS ──────────────────────────────────
{
  const { st } = mk({ kind: 'mystery' });
  const d = [];
  const orig = console.error; console.error = () => {};
  trader.applyBrokerFills(st, cfg, { fillSource: 'broker' }, d);
  trader.applyBrokerFills(st, cfg, { fillSource: 'broker' }, d);
  console.error = orig;
  ok(d.filter((x) => x.action === 'broker-fill-unhandled').length === 1, 'one unhandled decision across two passes');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
