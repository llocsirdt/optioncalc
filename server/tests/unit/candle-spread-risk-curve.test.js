'use strict';
// risk-curve foundation: terminal-P&L curve + shape analysis (peak / floor / loss zones), the substrate
// for the v11 risk-harvest overlay. Verified on a known synthetic book.
//
// Run: node server/tests/nogit/candle-spread-risk-curve.test.js
const RC = require('../../src/candle-spread/risk-curve');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

// Book: a bull call DEBIT spread long C100 / short C120, debit $10, qty 1. At settle: S<=100 → -$1000
// (lost the debit); S>=120 → +$1000 (full width - debit); linear between. Peak +1000, floor -1000.
const book = [{ filled: true, legs: [{ side: 'long', type: 'C', strike: 100 }, { side: 'short', type: 'C', strike: 120 }], limit: 10, quantity: 1 }];
ok(RC.bookPnl(book, 90) === -1000, `deep OTM = -debit (${RC.bookPnl(book, 90)})`);
ok(RC.bookPnl(book, 130) === 1000, `deep ITM = width-debit (${RC.bookPnl(book, 130)})`);
ok(RC.bookPnl(book, 110) === 0, `mid = breakeven (${RC.bookPnl(book, 110)})`);

const curve = RC.riskCurve(book, { lo: 80, hi: 140, step: 5 });
const a = RC.analyzeCurve(curve, { atSpot: 95 });
ok(a.peak.pnl === 1000 && a.peak.price >= 120, `peak +1000 above 120 (${a.peak.pnl}@${a.peak.price})`);
ok(a.floor.pnl === -1000, `floor -1000 (${a.floor.pnl})`);
ok(a.lossZones.length === 1 && a.lossZones[0].to <= 110, `one loss zone below breakeven (${JSON.stringify(a.lossZones[0])})`);
ok(a.atSpot.pnl === -1000 && a.atSpot.sideOfPeak === 'below', `spot 95 is a loser BELOW the peak (${a.atSpot.pnl}, ${a.atSpot.sideOfPeak})`);

// Covered tent: add a debit put cover so the position is a locked box — curve should flatten to its floor.
const covered = [{ filled: true, legs: [{ side: 'long', type: 'C', strike: 100 }, { side: 'short', type: 'C', strike: 120 }], limit: 10,
  covered: true, coverLegs: [{ side: 'short', type: 'P', strike: 120 }, { side: 'long', type: 'P', strike: 140 }], coverLimit: 8, quantity: 1 }];
const cc = RC.analyzeCurve(RC.riskCurve(covered, { lo: 80, hi: 160, step: 5 }));
ok(cc.floor.pnl > -1000, `covered tent lifts the floor above the naked -1000 (${cc.floor.pnl})`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
