'use strict';
// THE SAFETY PROPERTY OF TEST MODE. While the engine runs armed-but-unfillable against a funded account,
// this function is the only thing standing between "a real order went out" and "a real order filled".
// It had two holes at the boundaries, both verified against the real module before the fix:
//   NET_DEBIT  $0.05          -> $0.05   (the Math.max(tick, ...) floor returned the REAL price)
//   NET_CREDIT $19.95 on W=20 -> $19.95  (the spreadWidth - tick cap returned the REAL price)
const om = require('../../src/candle-spread/order-manager');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const W = 20, T = 0.05;
const px = (type, price, frac = 0.1, w = W) => om.unfillablePrice({ orderType: type, price }, frac, w, T);

// TEST MODE ALWAYS SENDS — the point of the mode is that a REAL order reaches Schwab and comes back
// through the real lifecycle. An earlier version returned null at the two boundaries and the caller
// skipped the send, which suppressed exactly the case worth seeing (a broken chain) and made "orders
// sent" stop matching "orders intended". It now sends at the least fillable price the structure admits
// and flags the order; the residual exposure there is ONE TICK.
const ord = (type, price, frac = 0.1, w = W) => om.unfillableOrder({ orderType: type, price }, frac, w, T);

// A DEBIT goes out BELOW the real price wherever there is room below it.
for (const p of [0.10, 0.15, 0.50, 2.00, 12.95, 19.95]) {
  const s = px('NET_DEBIT', p);
  ok(s < p, `debit ${p} -> ${s}: below the real price`);
  ok(ord('NET_DEBIT', p).guaranteed === true, `debit ${p} is provably unfillable`);
}
ok(px('NET_DEBIT', 0.10) === 0.05, 'a $0.10 debit still has room below it');

// THE DEBIT BOUNDARY: already at the tick floor, so nothing is below it.
{
  const u = ord('NET_DEBIT', 0.05);
  ok(u && u.price === 0.05, `a debit at the tick floor still SENDS, at one tick (${u && u.price})`);
  ok(u && u.guaranteed === false, 'and is flagged as not provably unfillable');
  ok(u && /tick floor/.test(u.why || ''), `with the reason stated (${u && u.why})`);
  // The exposure this buys: at most one tick, because nothing can be bought for less.
  ok(u.price - 0.05 <= 0, 'and it is the lowest price the book accepts — exposure bounded to one tick');
}

// A CREDIT DEMANDS MORE than the market offers wherever the width cap leaves room above it.
for (const p of [0.05, 2.00, 12.95, 19.50, 19.90]) {
  const s = px('NET_CREDIT', p);
  ok(s > p, `credit ${p} -> ${s}: above the real ask`);
  ok(ord('NET_CREDIT', p).guaranteed === true, `credit ${p} is provably unfillable`);
}

// THE CREDIT BOUNDARY: the real ask is already at the width cap, so nothing is above it.
{
  const u = ord('NET_CREDIT', 19.95);
  ok(u && u.price === 19.95, `a credit at width - tick still SENDS, at the cap (${u && u.price})`);
  ok(u && u.guaranteed === false, 'and is flagged as not provably unfillable');
  ok(u && /width cap/.test(u.why || ''), `with the reason stated (${u && u.why})`);
  // Exposure: receiving within one tick of the most a 20-wide vertical can ever be worth.
  ok(Math.round((W - u.price) * 100) / 100 <= 0.05, 'the cap is within one tick of the structure\'s maximum value');
}

// NULL IS RESERVED FOR "there is no order here at all" — not for "I could not prove it".
for (const bad of [null, undefined, 0, -1, NaN]) {
  ok(ord('NET_DEBIT', bad) === null, `a payload priced ${String(bad)} has nothing to send`);
  ok(ord('NET_CREDIT', bad) === null, `same for a credit priced ${String(bad)}`);
}
ok(px('NET_CREDIT', 19.50) === 19.95, 'and one below the cap is pushed up to it');

// frac is clamped: it shrinks a debit and grows a credit, so >= 1 would send at or through the real price.
for (const bad of [1, 1.5, 0, -0.2, NaN, undefined, null, 'x', Infinity]) {
  const d = px('NET_DEBIT', 2.00, bad), c = px('NET_CREDIT', 2.00, bad);
  ok(d === null || d < 2.00, `frac=${String(bad)}: debit still below the real price (got ${d})`);
  ok(c === null || c > 2.00, `frac=${String(bad)}: credit still above the real ask (got ${c})`);
}
ok(px('NET_DEBIT', 2.00, 1) === 0.20, 'frac=1 falls back to the 0.1 default rather than sending at the real price');

// Junk in, refusal out — never a fillable number.
for (const p of [0, -1, NaN, null, undefined]) {
  ok(px('NET_DEBIT', p) === null && px('NET_CREDIT', p) === null, `price ${String(p)} is refused for both directions`);
}
// No width given: the credit cap cannot be computed, but the demand must still exceed the real ask.
const noW = om.unfillablePrice({ orderType: 'NET_CREDIT', price: 2.00 }, 0.1, null, T);
ok(noW === null || noW > 2.00, `no spreadWidth: credit ${noW} still above the real ask`);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
