'use strict';
// EVERY PRICE LEAVES AS CENTS. 2026-10-02 v7-10: a debit cover went to Schwab at 3.3000000000000003
// (66 ticks of 0.05 via roundToTick) and was rejected as an invalid price nine bars running.
process.env.CANDLE_SPREAD_RUNS_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'cs-wp-'));
const cs = require('../../src/candle-spread/order-manager');
const L = require('../../src/candle-spread/spread-logic');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

ok(L.roundToTick(3.3, 0.05) !== 3.3, 'precondition: roundToTick alone leaves a binary hair on 3.3');
const p = { orderType: 'NET_DEBIT', price: L.roundToTick(3.3, 0.05), orderLegCollection: [] };
const w = cs.wirePrice(p);
ok(w.price === 3.3 && String(w.price) === '3.3', `the wire price is exactly 3.3 (${w.price})`);
ok(p.price !== 3.3, 'and the caller\'s payload is not mutated');
ok(cs.wirePrice({ price: 5.55 }).price === 5.55, 'a clean price is untouched');
ok(cs.wirePrice({ price: 12.950000000000001 }).price === 12.95, 'the credit-side hair is cleaned too');
ok(cs.wirePrice({ price: null }).price === null && cs.wirePrice(null) === null, 'no price -> passed through');
// Every tick multiple a 0-10 spread can carry comes out with at most 2 decimals.
let bad = 0;
for (let i = 1; i < 200; i++) { const x = cs.wirePrice({ price: L.roundToTick(i * 0.05, 0.05) }).price; if (!/^\d+(\.\d{1,2})?$/.test(String(x))) bad++; }
ok(bad === 0, `all 199 tick prices 0.05-9.95 serialise as cents (${bad} bad)`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
