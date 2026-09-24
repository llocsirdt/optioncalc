'use strict';
// bookFloor IS THE GOVERNOR'S INPUT. lossMax bounds it, the ratchet watches it, and every open is gated
// on it — so a floor that cannot see an unbounded tail is not a bound, it is a bound on one arbitrary
// sample. Past the outermost strike the payoff is exactly linear (no strikes left to bend it), so a
// sampled window returns whatever it happened to land on and calls that the worst case.
// shared/portfolio-risk.js has always returned -Infinity for this shape; risk-curve.js did not.
const RC = require('../../src/candle-spread/risk-curve');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const pos = (legs, limit, quantity) => ({ filled: true, quantity: quantity || 1, limit, legs });

// UNBOUNDED — the floor must be -Infinity, not a number.
{
  const shortCall = [pos([{ side: 'short', type: 'C', strike: 29400 }], -50)];
  ok(RC.bookFloor(shortCall, null, 10) === -Infinity, 'a naked short CALL is unbounded above');
  ok(RC.bookPnl(shortCall, 29600) < -10000, 'and the curve really does keep falling past the strike');

  const shortPut = [pos([{ side: 'short', type: 'P', strike: 29400 }], -50)];
  ok(RC.bookFloor(shortPut, null, 10) === -Infinity, 'a naked short PUT is unbounded below');

  // A ratio: two shorts against one long still leaves a net short tail.
  const ratio = [pos([{ side: 'long', type: 'C', strike: 29360 }, { side: 'short', type: 'C', strike: 29400 },
    { side: 'short', type: 'C', strike: 29400 }], 5)];
  ok(RC.bookFloor(ratio, null, 10) === -Infinity, 'a ratio leaving a net short call is unbounded');

  // Unbalanced ACROSS positions, not within one — the net is what matters.
  const across = [pos([{ side: 'long', type: 'C', strike: 29360 }], 20),
    pos([{ side: 'short', type: 'C', strike: 29400 }, { side: 'short', type: 'C', strike: 29420 }], -8)];
  ok(RC.bookFloor(across, null, 10) === -Infinity, 'and the net is taken ACROSS the whole book');

  // The `extra` candidate is part of the book being judged.
  const balanced = [pos([{ side: 'long', type: 'C', strike: 29360 }, { side: 'short', type: 'C', strike: 29400 }], 10)];
  const extraShort = { legs: [{ side: 'short', type: 'P', strike: 29300 }], limit: -4, quantity: 1 };
  ok(RC.bookFloor(balanced, extraShort, 10) === -Infinity, 'a candidate that would open a tail is caught too');
}

// BOUNDED — unchanged, and still a real number.
{
  const vertical = [pos([{ side: 'long', type: 'C', strike: 29360 }, { side: 'short', type: 'C', strike: 29400 }], 10)];
  ok(RC.bookFloor(vertical, null, 10) === -1000, `a balanced vertical floors at its debit (${RC.bookFloor(vertical, null, 10)})`);

  const tent = [pos([{ side: 'long', type: 'C', strike: 29360 }, { side: 'short', type: 'C', strike: 29400 },
    { side: 'short', type: 'P', strike: 29400 }, { side: 'long', type: 'P', strike: 29440 }], 18)];
  ok(Number.isFinite(RC.bookFloor(tent, null, 10)), 'a tent is bounded and stays finite');
  ok(RC.bookFloor([], null, 10) === 0, 'an empty book is 0, not -Infinity');
  ok(RC.bookFloor([pos([{ side: 'long', type: 'C', strike: 29360 }], 20)], null, 10) === -2000,
    'a naked LONG is bounded below by what it cost');
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
