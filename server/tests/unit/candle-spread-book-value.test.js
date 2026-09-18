'use strict';
// BOOK VALUE. The risk curve, the settle P&L and the scrubber are all one question: what are the
// contracts actually held worth at an underlying price, net of the cash actually paid? Four hand-written
// copies of that calculation gave four answers for the same v7-10 book at NDX 29447 on 2026-09-17 —
// +$3,140 (debug), -$975 (compare), $2,840 (eodSettlement), $4,120 (RC.bookPnl). These pin the shared one.
//
// Run: node server/tests/unit/candle-spread-book-value.test.js
const BV = require('../../src/candle-spread/book-value');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const near = (a, b, m) => ok(Math.abs(a - b) < 0.01, `${m} (got ${a}, want ${b})`);

const rec = (positions, events) => ({ config: { quantity: 1 }, state: { positions }, events: events || [] });
const C = (side, k) => ({ side, type: 'C', strike: k });
const P = (side, k) => ({ side, type: 'P', strike: k });

// ── A PLAIN DEBIT SPREAD ────────────────────────────────────────────────────────────────────────────
{
  // Long 29000 / short 29040 call spread for 9. Max value 40, so +31 at/above 29040, -9 at/below 29000.
  const r = rec([{ id: 'a', filled: true, quantity: 1, limit: 9, legs: [C('long', 29000), C('short', 29040)] }]);
  const b = BV.heldBook(r);
  near(BV.valueAt(b, 29100), 3100, 'deep ITM debit spread is worth width less cost');
  near(BV.valueAt(b, 28900), -900, 'and loses exactly the debit below both strikes');
  near(BV.valueAt(b, 29020), 1100, 'and is linear between the strikes');
}

// ── THE CREDIT TWIN IS VALUED AS SENT ───────────────────────────────────────────────────────────────
// Capital recapture sends a CREDIT twin at the same strikes while the record stays debit-canonical. The
// book is worth what the twin is worth, not what the idealised debit would have been — they are equal
// only while sentLimit == W - debitLimit, which held for just 20 of 60 twins on 2026-09-17.
{
  const pos = { id: 'b', filled: true, quantity: 1, limit: 5.9, legs: [C('long', 29390), C('short', 29400)],
    sentNet: 'CREDIT', sentLimit: 4.2, sentLegs: [P('short', 29400), P('long', 29390)] };
  const b = BV.heldBook(rec([pos]));
  // Above both puts they expire worthless and the 4.20 credit is kept outright.
  near(BV.valueAt(b, 29447), 420, 'above both strikes the twin keeps its credit');
  // Below both, the put spread is worth -10 against a 4.20 credit.
  near(BV.valueAt(b, 29300), -580, 'below both it pays out the width less the credit');
  // The debit-canonical idealisation would have said 10 - 5.9 = 4.10, a different number. That gap is
  // exactly the pricing difference the as-sent convention exists to stop hiding.
  ok(Math.abs(BV.valueAt(b, 29447) - 410) > 1, 'and does NOT silently report the debit-canonical 4.10');
}

// ── THE CREDIT COVER IS VALUED FROM THE POSITION, NOT THE ORDER LOG ─────────────────────────────────
// THE COMPARE-PAGE BUG had two halves. It took the log's CREDIT twin legs and paired them with
// pos.coverLimit — the DEBIT fill — then negated it: legs from one convention, price from the other, and
// that is the -$975. The obvious repair, translating the price to W - coverLimit, is ALSO wrong: the log
// is not a reliable description of what was booked (2 of 91 covers on 2026-09-17 had log legs at
// different strikes than the recorded cover), and deriving a credit from its asking price moved fleet
// P&L by thousands, always flatteringly.
//
// The position's own coverLegs/coverLimit are what the engine wrote when the cover filled, and they are
// EXACT rather than approximate: a credit twin at the same strikes satisfies
// payoff(twin) + credit == payoff(debit pair) - debit whenever credit == W - debit.
{
  const cover = { type: 'order_simulated', meta: { of: 'c', kind: 'cover-rest', net: 'CREDIT',
    legs: [P('short', 29380), P('long', 29390)], limit: 6.8 } };
  const pos = { id: 'c', filled: true, quantity: 1, limit: 5, legs: [C('long', 29380), C('short', 29390)],
    covered: true, coverLegs: [P('short', 29380), P('long', 29390)], coverLimit: 3, coverSentNet: 'CREDIT' };
  const b = BV.heldBook(rec([pos], [cover]));
  // Above both pairs: the calls are worth 10, the puts nothing, against 5 + 3 paid.
  near(BV.valueAt(b, 29500), 200, 'a covered pair is worth its legs less what was actually paid');
  // And it must NOT be reading the log's asking price, which would inflate it.
  ok(Math.abs(BV.valueAt(b, 29500) - 1200) > 1, 'and not a credit derived from the order log');

  // A log entry at DIFFERENT strikes must not change the valuation at all — that cover was never held.
  const wrongLog = { type: 'order_simulated', meta: { of: 'c', kind: 'cover-rest', net: 'CREDIT',
    legs: [P('short', 29410), P('long', 29420)], limit: 6.8 } };
  near(BV.valueAt(BV.heldBook(rec([pos], [wrongLog])), 29500), 200,
    'a log entry at other strikes is ignored for valuation');
}

// ── THE SCRUBBER: the book AS IT STOOD at a moment ──────────────────────────────────────────────────
{
  const T = 1789580000000;
  const early = { id: 'e', filled: true, quantity: 1, limit: 4, openEpoch: T - 6e5,
    legs: [C('long', 29000), C('short', 29040)] };
  const late = { id: 'l', filled: true, quantity: 1, limit: 4, openEpoch: T + 6e5,
    legs: [C('long', 29100), C('short', 29140)] };
  const r = rec([early, late]);
  ok(BV.heldBook(r, { asOfEpoch: T }).parts.length === 1, 'a position opened later is not in the book yet');
  ok(BV.heldBook(r).parts.length === 2, 'and both are there with no asOf');

  // A cover applies only once it has BOOKED.
  const covered = { id: 'x', filled: true, quantity: 1, limit: 4, openEpoch: T - 6e5,
    legs: [C('long', 29000), C('short', 29040)],
    covered: true, coverEpoch: T + 6e5, coverLegs: [P('short', 29040), P('long', 29080)], coverLimit: 2 };
  ok(!BV.heldBook(rec([covered]), { asOfEpoch: T }).parts[0].covered, 'a cover booked later is not applied yet');
  ok(BV.heldBook(rec([covered]), { asOfEpoch: T + 9e5 }).parts[0].covered, 'and is once its epoch passes');
}

// ── UNFILLED ORDERS ARE NOT POSITIONS ───────────────────────────────────────────────────────────────
{
  const working = { id: 'w', filled: false, quantity: 1, limit: 5, legs: [C('long', 29000), C('short', 29040)] };
  ok(BV.heldBook(rec([working])).parts.length === 0, 'a working order is not held');
  ok(BV.heldBook(rec([working]), { includeUnfilled: true }).parts.length === 1, 'unless explicitly asked for');
}

// ── THE CURVE SAMPLES EVERY STRIKE ──────────────────────────────────────────────────────────────────
// The payoff is piecewise-linear with kinks ONLY at strikes, so a uniform grid alone can step straight
// over a peak. Including the strikes makes the extremes exact rather than nearly right.
{
  const b = BV.heldBook(rec([{ id: 'k', filled: true, quantity: 1, limit: 9,
    legs: [C('long', 29000), C('short', 29040)] }]));
  const c = BV.curve(b, 28900, 29100, 37);          // a step that lands on neither strike
  ok(c.some(([x]) => x === 29000) && c.some(([x]) => x === 29040), 'both strikes are sampled');
  const ys = c.map(([, y]) => y);
  near(Math.max(...ys), 3100, 'so the peak is exact');
  near(Math.min(...ys), -900, 'and so is the trough');
  ok(c.every(([x], i) => i === 0 || x > c[i - 1][0]), 'and the curve is sorted ascending');
}

// ── AN EMPTY BOOK ───────────────────────────────────────────────────────────────────────────────────
{
  const b = BV.heldBook(rec([]));
  near(BV.valueAt(b, 29000), 0, 'an empty book is worth nothing anywhere');
  ok(BV.curve(b, 29000, 29100, 10).every(([, y]) => y === 0), 'and its curve is flat zero');
}

// ── THE CLIENT BUILDER MUST AGREE ───────────────────────────────────────────────────────────────────
// compare.html and index.html both value a book through strategyRunToOptionArray; debug.html builds its
// own. They disagreed by thousands on 2026-09-17. This pins the client builder to the shared function on
// a book containing every shape that differed: a credit-twin open, a credit cover, and a FLY — whose net
// debit used to be attached to EVERY long leg, so a four-leg structure paid for itself twice ($732 on
// v6-20, and flies are live on 25 variants).
{
  const SP = require('../../../client/lib/strategy-positions');
  const S = 29447;
  const positions = [
    { id: 'd', filled: true, quantity: 1, limit: 5, openEpoch: 1, legs: [C('long', 29380), C('short', 29390)] },
    { id: 't', filled: true, quantity: 1, limit: 5.9, openEpoch: 2, legs: [C('long', 29390), C('short', 29400)],
      sentNet: 'CREDIT', sentLimit: 4.2, sentLegs: [P('short', 29400), P('long', 29390)] },
    { id: 'c', filled: true, quantity: 1, limit: 5, openEpoch: 3, legs: [C('long', 29400), C('short', 29410)],
      covered: true, coverEpoch: 4, coverLegs: [P('short', 29400), P('long', 29410)], coverLimit: 3,
      coverSentNet: 'CREDIT' },
    // A FLY: two longs. Net debit 7.32 — counted once, not once per long leg.
    { id: 'f', filled: true, quantity: 1, limit: 7.32, openEpoch: 5, side: 'fly',
      legs: [C('long', 29400), C('short', 29420), C('short', 29420), C('long', 29440)] },
  ];
  const run = { config: { quantity: 1 }, state: { positions }, events: [] };

  const shared = BV.terminalAt(run, S).total;
  const out = SP.strategyRunToOptionArray(run, {});
  const legs = out.legs || [];
  const clientVal = legs.reduce((t, l) =>
    t + l.qty * (l.type === 'c' ? Math.max(S - l.strike, 0) : Math.max(l.strike - S, 0)) * 100, 0)
    - legs.reduce((t, l) => t + (l.cost || 0), 0);
  near(clientVal, shared, 'the client builder agrees with the shared function');

  // The fly's debit appears ONCE across its four legs.
  const flyLegs = legs.filter((l) => l.strike >= 29400 && l.strike <= 29440);
  const flyCosts = flyLegs.filter((l) => l.cost).length;
  ok(flyCosts >= 1, 'the fly carries its cost');
  const fly = SP.spreadToLegs(positions[3].legs, 7.32, 1);
  near(fly.reduce((t, l) => t + (l.cost || 0), 0), 732, 'a four-leg structure books its debit exactly once');
  const vert = SP.spreadToLegs(positions[0].legs, 5, 1);
  near(vert.reduce((t, l) => t + (l.cost || 0), 0), 500, 'and a vertical is unchanged');
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
