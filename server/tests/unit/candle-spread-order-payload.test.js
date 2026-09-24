'use strict';
// THE PAYLOAD HAS TO DESCRIBE THE ORDER. buildOrderPayload declared complexOrderStrategyType 'VERTICAL'
// for everything — including 1-leg naked wings and 4-leg flies/condors — and emitted a butterfly's body
// (the SAME strike twice) as two separate SELL_TO_OPEN legs at quantity 1 instead of one at quantity 2.
// Schwab may reject either; if it accepts, what comes back is not the structure that was priced.
const trader = require('../../src/candle-spread/trader');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const L = (side, type, strike) => ({ side, type, strike, symbol: `${type}${strike}` });
const build = (legs, q, net) => trader.buildOrderPayload(legs, 5.00, q || 1, net || 'DEBIT');
const sig = (p) => p.orderLegCollection.map(l => `${l.instruction === 'BUY_TO_OPEN' ? 'B' : 'S'}${l.quantity}:${l.instrument.symbol}`).join(' ');

// The common case must not move.
{
  const p = build([L('long', 'C', 100), L('short', 'C', 110)]);
  ok(p.complexOrderStrategyType === 'VERTICAL', 'two legs is still VERTICAL');
  ok(sig(p) === 'B1:C100 S1:C110', `and its legs are unchanged (${sig(p)})`);
  ok(p.orderStrategyType === 'SINGLE' && p.session === 'NORMAL' && p.duration === 'DAY', 'envelope unchanged');
  ok(build([L('long', 'C', 100), L('short', 'C', 110)], 1, 'CREDIT').orderType === 'NET_CREDIT', 'credit still NET_CREDIT');
}
// A naked wing is one leg, and one leg is not a vertical.
{
  const p = build([L('long', 'C', 120)]);
  ok(p.complexOrderStrategyType === 'NONE', `a single leg is NONE, not VERTICAL (${p.complexOrderStrategyType})`);
  ok(sig(p) === 'B1:C120', 'and goes out as itself');
}
// A butterfly's body is ONE leg at twice the size.
{
  const p = build([L('long', 'C', 90), L('short', 'C', 100), L('short', 'C', 100), L('long', 'C', 110)]);
  ok(p.complexOrderStrategyType === 'CUSTOM', 'four legs is CUSTOM');
  ok(p.orderLegCollection.length === 3, `the duplicated body merges, so 3 legs go out, not 4 (got ${p.orderLegCollection.length})`);
  ok(sig(p) === 'B1:C90 S2:C100 B1:C110', `a 1-2-1 butterfly (${sig(p)})`);
}
// A condor keeps all four — nothing to merge.
{
  const p = build([L('long', 'C', 90), L('short', 'C', 100), L('short', 'C', 110), L('long', 'C', 120)]);
  ok(p.orderLegCollection.length === 4 && p.complexOrderStrategyType === 'CUSTOM', 'a condor stays four legs, CUSTOM');
}
// Quantity scales the whole structure, body included.
{
  const p = build([L('long', 'C', 90), L('short', 'C', 100), L('short', 'C', 100), L('long', 'C', 110)], 2);
  ok(sig(p) === 'B2:C90 S4:C100 B2:C110', `qty 2 scales every leg including the doubled body (${sig(p)})`);
}
// Opposing legs at one strike would net to nothing; sending nothing is worse than sending the legs.
{
  const p = build([L('long', 'C', 100), L('short', 'C', 100)]);
  ok(p.orderLegCollection.length > 0, 'a fully-netting pair still produces a payload rather than an empty one');
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
