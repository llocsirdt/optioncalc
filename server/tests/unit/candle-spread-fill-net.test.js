'use strict';
// WHAT A REAL ORDER ACTUALLY COST.
//
// extractFillPrice returned executionLegs[0].price — the execution price of whichever leg Schwab listed
// first. Every order this engine sends is a NET order on 2, 3 or 4 legs, so leg 0 is a single option's
// price ($76.00 for a deep-ITM call) while the spread filled at $8.05. That number was written to
// o.fillPrice and logged as "broker FILLED @ 76": the one figure that says what a real order cost, off by
// an order of magnitude. Inert while every send is an unfillable test order; the record of record the
// moment the account is funded.
//
// Run: node server/tests/unit/candle-spread-fill-net.test.js
const OM = require('../../src/candle-spread/order-manager');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

// A real-shaped Schwab orderById response for a 1-lot bull call vertical bought for a net 8.05 debit:
// BUY C29390 at 76.00, SELL C29410 at 67.95.
const vertical = {
  status: 'FILLED', quantity: 1, orderType: 'NET_DEBIT', price: 8.05,
  orderLegCollection: [
    { legId: 1, instruction: 'BUY_TO_OPEN', quantity: 1, instrument: { symbol: 'NDX_C29390' } },
    { legId: 2, instruction: 'SELL_TO_OPEN', quantity: 1, instrument: { symbol: 'NDX_C29410' } },
  ],
  orderActivityCollection: [{ executionLegs: [
    { legId: 1, quantity: 1, price: 76.00 },
    { legId: 2, quantity: 1, price: 67.95 },
  ] }],
};

{
  const f = OM.extractFillNet(vertical);
  ok(f && f.price === 8.05, `the vertical's net is 8.05 (got ${f && f.price})`);
  ok(f && f.side === 'DEBIT', `and it is a debit (${f && f.side})`);
  ok(f && f.from === 'executionLegs', 'netted from the legs, not read off the order');
  ok(OM.extractFillPrice(vertical) === 8.05, 'the back-compat shim agrees');
  ok(OM.extractFillPrice(vertical) !== 76.00, 'and is NOT leg 0 — the regression');
}

// A CREDIT fill must come back as a credit, with its magnitude. Sign confusion here inverts the cash.
{
  const credit = { ...vertical, orderType: 'NET_CREDIT', price: 11.95,
    orderLegCollection: [
      { legId: 1, instruction: 'SELL_TO_OPEN', quantity: 1, instrument: { symbol: 'NDX_P29410' } },
      { legId: 2, instruction: 'BUY_TO_OPEN', quantity: 1, instrument: { symbol: 'NDX_P29390' } },
    ],
    orderActivityCollection: [{ executionLegs: [
      { legId: 1, quantity: 1, price: 20.00 },
      { legId: 2, quantity: 1, price: 8.05 },
    ] }] };
  const f = OM.extractFillNet(credit);
  ok(f && f.side === 'CREDIT', `a sold spread reports CREDIT (${f && f.side})`);
  ok(f && f.price === 11.95, `at its real magnitude 11.95 (got ${f && f.price})`);
  ok(f && f.net === -11.95, `signed negative (${f && f.net})`);
}

// A BUTTERFLY's body is a DOUBLE leg. Weighting every leg equally is how a fly's net comes out wrong even
// once the legs are signed correctly.
{
  const fly = {
    status: 'FILLED', quantity: 1, orderType: 'NET_DEBIT', price: 3.00,
    orderLegCollection: [
      { legId: 1, instruction: 'BUY_TO_OPEN', quantity: 1 },
      { legId: 2, instruction: 'SELL_TO_OPEN', quantity: 2 },
      { legId: 3, instruction: 'BUY_TO_OPEN', quantity: 1 },
    ],
    orderActivityCollection: [{ executionLegs: [
      { legId: 1, quantity: 1, price: 30.00 },
      { legId: 2, quantity: 2, price: 17.00 },
      { legId: 3, quantity: 1, price: 7.00 },
    ] }],
  };
  const f = OM.extractFillNet(fly);
  ok(f && f.price === 3.00, `the fly nets 30 - 2x17 + 7 = 3.00 (got ${f && f.price})`);
}

// MULTI-LOT: the per-contract price is the net divided by the ORDER quantity.
{
  const two = { ...vertical, quantity: 2,
    orderLegCollection: [
      { legId: 1, instruction: 'BUY_TO_OPEN', quantity: 2 },
      { legId: 2, instruction: 'SELL_TO_OPEN', quantity: 2 },
    ],
    orderActivityCollection: [{ executionLegs: [
      { legId: 1, quantity: 2, price: 76.00 },
      { legId: 2, quantity: 2, price: 67.95 },
    ] }] };
  ok(OM.extractFillNet(two).price === 8.05, `a 2-lot still reports 8.05 per contract (got ${OM.extractFillNet(two).price})`);
}

// A LEG IT CANNOT SIGN makes the sum a partial one dressed as a total — fall back to the order's own net
// price rather than report it.
{
  const orphan = { ...vertical, orderActivityCollection: [{ executionLegs: [
    { legId: 1, quantity: 1, price: 76.00 },
    { legId: 9, quantity: 1, price: 67.95 },     // no matching orderLegCollection entry
  ] }] };
  const f = OM.extractFillNet(orphan);
  ok(f && f.from === 'orderPrice', `an unsignable leg falls back to the order price (${f && f.from})`);
  ok(f && f.price === 8.05, `which is the net for a NET_DEBIT order (${f && f.price})`);
  ok(f && f.price !== 76.00, 'and never a bare leg price');
}

// NOTHING TO GO ON is null, not a guess.
{
  ok(OM.extractFillNet({ status: 'FILLED' }) === null, 'no executions and no order price -> null');
  ok(OM.extractFillNet(null) === null, 'no response -> null');
  ok(OM.extractFillPrice({ status: 'FILLED' }) === null, 'and the shim passes the null through');
}

// The ORDER-PRICE fallback must still honour the order type's sign.
{
  const c = { status: 'FILLED', quantity: 1, orderType: 'NET_CREDIT', price: 19.40 };
  const f = OM.extractFillNet(c);
  ok(f && f.side === 'CREDIT' && f.net === -19.40, `a NET_CREDIT order price is a credit (${f && f.net})`);
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
