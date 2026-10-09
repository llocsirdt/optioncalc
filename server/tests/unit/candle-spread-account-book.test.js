'use strict';
// ACCOUNT BOOK (2026-10-09) — the UI's pull of a LIVE variant shows what Schwab HOLDS, not what the engine
// believes. Fixture = 2026-10-09 v7-10: 6 filled orders / 12 legs at the account while the engine's book (and the
// UI) showed 8 legs — one adopted manual edit never booked (numeric-id bug), one cover placed by hand.
// Legs and execution prices are the real ones; account identifiers are not included.
//
// Run: node server/tests/unit/candle-spread-account-book.test.js
const AB = require('../../src/candle-spread/account-book');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

const sym = (t, k, d = '261009') => `NDXP  ${d}${t}${String(k * 1000).padStart(8, '0')}`;
let n = 0;
// legs: [instruction, type, strike, execPrice]
function order(id, time, type, price, legs, tag = 'TA_x', extra = {}) {
  const coll = legs.map(([ins, t, k], i) => ({ legId: i + 1, instruction: ins, quantity: 1, instrument: { symbol: sym(t, k, extra.d), assetType: 'OPTION' } }));
  return { orderId: id, status: 'FILLED', quantity: 1, filledQuantity: 1, orderType: type, price, tag, enteredTime: time, closeTime: time,
    orderLegCollection: coll,
    orderActivityCollection: [{ activityType: 'EXECUTION', executionLegs: legs.map((l, i) => ({ legId: i + 1, quantity: 1, price: l[3] })) }], ...extra };
}
const ORDERS = [
  order(1008239974621, '2026-10-09T14:45:10+0000', 'NET_DEBIT', 5.3, [['BUY_TO_OPEN', 'P', 30830, 65.1], ['SELL_TO_OPEN', 'P', 30820, 59.8]]),
  order(1008239975605, '2026-10-09T15:07:55+0000', 'NET_CREDIT', 4.8, [['SELL_TO_OPEN', 'P', 30820, 55.3], ['BUY_TO_OPEN', 'P', 30810, 50.5]]),
  order(1008240997636, '2026-10-09T15:17:50+0000', 'NET_DEBIT', 5.15, [['BUY_TO_OPEN', 'P', 30850, 54.3], ['SELL_TO_OPEN', 'P', 30840, 49.15]]),
  order(1008241934611, '2026-10-09T15:30:11+0000', 'NET_CREDIT', 4.75, [['SELL_TO_OPEN', 'C', 30820, 39.98], ['BUY_TO_OPEN', 'C', 30830, 35.23]]),
  order(1008241934649, '2026-10-09T15:30:42+0000', 'NET_CREDIT', 5.5, [['SELL_TO_OPEN', 'P', 30840, 56.28], ['BUY_TO_OPEN', 'P', 30830, 50.78]], 'API_'),
  order(1008241935021, '2026-10-09T15:35:43+0000', 'NET_CREDIT', 5.1, [['SELL_TO_OPEN', 'P', 30820, 51.4], ['BUY_TO_OPEN', 'P', 30810, 46.3]], 'API_'),
  // noise the book must ignore: a canceled order, another expiration, another underlying
  { ...order(1008241935171, '2026-10-09T15:35:00+0000', 'NET_DEBIT', 3.8, [['BUY_TO_OPEN', 'C', 30810, 1], ['SELL_TO_OPEN', 'C', 30820, 1]]), status: 'CANCELED', filledQuantity: 0 },
  order(1, '2026-10-09T15:00:00+0000', 'NET_DEBIT', 5, [['BUY_TO_OPEN', 'P', 30830, 1], ['SELL_TO_OPEN', 'P', 30820, 1]], 'TA_x', { d: '261010' }),
];
const pos = (t, k, q, avg) => ({ instrument: { symbol: sym(t, k), assetType: 'OPTION' }, longQuantity: q > 0 ? q : 0, shortQuantity: q < 0 ? -q : 0, averagePrice: avg });
const POSITIONS = [pos('P', 30810, 2, 48.4), pos('P', 30850, 1, 54.3), pos('P', 30840, -2, 52.715), pos('P', 30830, 2, 57.94),
  pos('P', 30820, -3, 55.5), pos('C', 30820, -1, 39.98), pos('C', 30830, 1, 35.23),
  { instrument: { symbol: 'QQQ', assetType: 'EQUITY' }, longQuantity: 10, shortQuantity: 0 }];
// The engine's order log: four booked, the adopted edit filled-but-unbooked, the manual one absent.
const ENGINE = [
  { orderId: '1008239974621', variant: 'v7-10', brokerApplied: true },
  { orderId: '1008239975605', variant: 'v7-10', brokerApplied: true },
  { orderId: '1008240997636', variant: 'v7-10', brokerApplied: true },
  { orderId: '1008241934611', variant: 'v7-10', brokerApplied: true },
  { orderId: 1008241934649, variant: 'v7-10', status: 'working', adoptedFrom: '1008241934614' },
];

{
  const b = AB.buildAccountBook({ symbol: 'NDX', expiration: '2026-10-09', orders: ORDERS, positions: POSITIONS, engineOrders: ENGINE });
  ok(b.counts.orders === 6 && b.counts.legs === 12, `6 filled orders, 12 legs (${b.counts.orders}/${b.counts.legs})`);
  ok(b.counts.engine === 4 && b.counts.engineUnbooked === 1 && b.counts.manual === 1, `4 engine, 1 unbooked, 1 manual (${JSON.stringify(b.counts)})`);
  ok(b.residual.length === 0, 'the fills explain every held contract — no residual');
  const net = Object.fromEntries(b.netByLeg.map((x) => [x.leg, x.qty]));
  ok(net.P30810 === 2 && net.P30820 === -3 && net.P30830 === 2 && net.P30840 === -2 && net.P30850 === 1 && net.C30820 === -1 && net.C30830 === 1,
    `net matches the account (${JSON.stringify(net)})`);
  const cash = b.legs.reduce((t, l) => t + l.cost, 0);
  ok(cash === -970, `net cash = +$970 credit, from the EXECUTIONS (${cash})`);
  ok(b.optionArrayString.startsWith('1p30830@530,-1p30820@0,-1p30820@0,1p30810@-480'), `optionArray in the engine-pull convention (${b.optionArrayString.slice(0, 60)})`);
  const unb = b.orders.find((o) => o.orderId === '1008241934649');
  ok(unb.origin === 'engine-unbooked' && unb.price === 5.5 && unb.net === 'CREDIT', 'a numeric engine id still matches; filled-but-unbooked is flagged');
  ok(b.flags.some((f) => f.kind === 'manual' && f.orderId === '1008241935021'), 'the hand-placed cover is flagged manual');
  ok(b.legEpochs.length === 12 && b.legEpochs[0] === Date.parse('2026-10-09T14:45:10Z'), 'per-leg fill times ride along');
}
{
  // A holding today's fills do not explain is still SHOWN — at its average price — and flagged.
  const extra = POSITIONS.concat([pos('C', 30900, 1, 2.1)]);
  const b = AB.buildAccountBook({ symbol: 'NDX', expiration: '2026-10-09', orders: ORDERS, positions: extra, engineOrders: ENGINE });
  ok(b.residual.length === 1 && b.residual[0].strike === 30900 && b.counts.legs === 13, 'unexplained holding added from the position list');
  ok(b.legs[12].cost === 210 && b.flags.some((f) => f.kind === 'residual'), 'at its average price, flagged');
}
{
  // Positions unreadable: legs from the orders alone, said so.
  const b = AB.buildAccountBook({ symbol: 'NDX', expiration: '2026-10-09', orders: ORDERS, positions: null, engineOrders: ENGINE });
  ok(b.counts.legs === 12 && b.flags.some((f) => f.kind === 'positions-unavailable'), 'no position list: orders only, flagged');
}
{
  // A partial fill counts only what filled.
  const part = { ...order(9, '2026-10-09T16:00:00+0000', 'NET_DEBIT', 5, [['BUY_TO_OPEN', 'P', 30900, 60], ['SELL_TO_OPEN', 'P', 30890, 55]]),
    status: 'CANCELED', quantity: 2, filledQuantity: 1 };
  part.orderLegCollection.forEach((l) => { l.quantity = 2; });
  const b = AB.buildAccountBook({ symbol: 'NDX', expiration: '2026-10-09', orders: [part], positions: null, engineOrders: [] });
  ok(b.legs.length === 2 && b.legs[0].qty === 1 && b.legs[0].cost === 500, `partial fill: 1 of 2 contracts at $5.00 (${JSON.stringify(b.legs)})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
