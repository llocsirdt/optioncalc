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

// A DEBIT must go out BELOW the real price, or not at all.
for (const p of [0.05, 0.10, 0.15, 0.50, 2.00, 12.95, 19.95]) {
  const s = px('NET_DEBIT', p);
  ok(s === null || s < p, `debit ${p} -> ${s}: below the real price, or refused`);
}
ok(px('NET_DEBIT', 0.05) === null, 'a debit already AT the tick floor is refused, not sent at its own price');
ok(px('NET_DEBIT', 0.10) === 0.05, 'a $0.10 debit still has room below it');

// A CREDIT must DEMAND MORE than the market offers, or not at all.
for (const p of [0.05, 2.00, 12.95, 19.50, 19.90, 19.95]) {
  const s = px('NET_CREDIT', p);
  ok(s === null || s > p, `credit ${p} -> ${s}: above the real ask, or refused`);
}
ok(px('NET_CREDIT', 19.95) === null, 'a credit already at width - tick is refused, not sent at its own price');
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
