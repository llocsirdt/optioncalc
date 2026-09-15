'use strict';
// risk-harvest hedge search (v11): finds far-side spreads that lift a reachable loss zone, with a
// return-on-cost ratio gate and slippage. Verified on a book with a known upside loss tail.
//
// Run: node server/tests/nogit/candle-spread-risk-harvest.test.js
const RH = require('../../src/candle-spread/risk-harvest');
const RC = require('../../src/candle-spread/risk-curve');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

// A book that LOSES on the upside: a bear call spread short C100 / long C120 for a $8 credit (so limit is
// negative — a credit received). Above 120 it loses width-credit = -$1200; below 100 it keeps +$800.
// (Model the credit as a negative debit "limit".) Spot 95 (below), so the loss is on the upside.
const book = [{ filled: true, legs: [{ side: 'short', type: 'C', strike: 100 }, { side: 'long', type: 'C', strike: 120 }], limit: -8, quantity: 1 }];
ok(RC.bookPnl(book, 95) === 800, `keeps credit below (${RC.bookPnl(book, 95)})`);
ok(RC.bookPnl(book, 130) === -1200, `loses on the upside (${RC.bookPnl(book, 130)})`);

const spot = 95, iv = 0.4, tau = 0.02;
const bs = require('../../src/candle-spread/bs-pricer');
const mark = (type, strike) => bs.bsPrice(type, spot, strike, tau, iv);
const band = Math.round(spot * iv * Math.sqrt(tau) * 3);   // reach up into the loss

const noSlip = RH.harvestPlan(book, mark, spot, { band, step: 5, incr: 5, widths: [10, 20], depth: 6, minRatio: 2, target: 0, slip: 0 });
ok(noSlip.hedges.length > 0, `finds a hedge on the upside loss (${noSlip.hedges.length})`);
ok(noSlip.hedges.every(h => h.legs.every(l => l.type === 'C')), 'hedges are CALL spreads (far side = upside)');
ok(noSlip.finalFloor > noSlip.oldFloor, `lifts the reachable floor (${noSlip.oldFloor} → ${noSlip.finalFloor})`);

// Slippage raises entry cost → lowers the best hedge's return-on-cost ratio (the gate that kills churn).
const rMid = RH.bestHedge(book, mark, spot, { band, step: 5, incr: 5, widths: [10, 20], depth: 6, minRatio: 0.1, slip: 0 });
const rSlip = RH.bestHedge(book, mark, spot, { band, step: 5, incr: 5, widths: [10, 20], depth: 6, minRatio: 0.1, slip: 1.0 });
ok(rMid && rSlip && rSlip.ratio < rMid.ratio, `slippage lowers the ratio (${rMid && rMid.ratio} → ${rSlip && rSlip.ratio})`);
// A high ratio gate + slippage → nothing clears (the churn-killer).
ok(RH.bestHedge(book, mark, spot, { band, step: 5, incr: 5, widths: [10, 20], depth: 6, minRatio: 20, slip: 2.0 }) === null, 'high ratio gate + slippage → no hedge');

// A book with NO reachable loss → no hedge.
const winner = [{ filled: true, legs: [{ side: 'long', type: 'C', strike: 90 }, { side: 'short', type: 'C', strike: 110 }], limit: 5, quantity: 1 }];
const none = RH.bestHedge(winner, mark, 130, { band: 30, step: 5, incr: 5, widths: [10], depth: 4, minRatio: 2 });
ok(none === null, 'no hedge when the reachable floor is already >= 0');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
