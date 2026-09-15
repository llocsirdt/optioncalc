'use strict';
// Geometry test: $20 ATM (default) is unchanged, and the $40 short-ATM shift selects the short leg
// at ~ATM with the long leg deeper ITM (matching backtest-width.makeGeo), with the wider capFrac.
// Run: node server/tests/nogit/candle-spread-geometry.test.js
const trader = require('../../src/candle-spread/trader');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const getLeg = (type, strike) => ({ mid: type === 'C' ? Math.max(0.5, (22100 - strike) * 0.2) : Math.max(0.5, (strike - 21900) * 0.2), symbol: `NDX_${type}${strike}`, bid: 1, ask: 1.1 });
const strikesOf = res => res.legs.map(l => `${l.side[0]}${l.type}${l.strike}`).join(' ');

// $20 ATM (default shift 0, default capFrac) — must be exactly the pre-existing geometry.
const c20 = { spreadWidth: 20, strikeIncrement: 10, quantity: 1, tickIncrement: 0.05 };
const b20 = trader.buildOpen('bull', 22000, c20, getLeg);
ok(b20.lower === 21990 && b20.upper === 22010 && b20.shortStrike === 22010, `$20 bull strikes 21990/22010 short 22010 (${strikesOf(b20)})`);
// 65% ceiling since ab922ee (was 52.5%) — see candle-spread-logic.test.js for the contract.
ok(Math.abs(b20.cap - 13) < 1e-9, `$20 cap 13.00 (got ${b20.cap})`);

// $40 short-ATM (shift 20 = width/2): short leg ~ATM (22000), long leg deep ITM (21960).
const c40 = { spreadWidth: 40, strikeIncrement: 10, quantity: 1, tickIncrement: 0.05, spreadShift: 20, capFrac: 0.8 };
const b40 = trader.buildOpen('bull', 22000, c40, getLeg);
ok(b40.lower === 21960 && b40.upper === 22000 && b40.shortStrike === 22000, `$40 bull short ~ATM: 21960/22000 short 22000 (${strikesOf(b40)})`);
ok(Math.abs(b40.cap - 32) < 1e-9, `$40 cap 32.00 (capFrac 0.8; got ${b40.cap})`);
const s40 = trader.buildOpen('bear', 22000, c40, getLeg);
ok(s40.lower === 22000 && s40.upper === 22040 && s40.shortStrike === 22000, `$40 bear short ~ATM: 22000/22040 short 22000 (${strikesOf(s40)})`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
