'use strict';
// 4-leg combo (cover + open atomic order): distinctness detection, net-additivity (combo == cover + open),
// the marketable haircut, credit/debit netting, and the Schwab CUSTOM payload shape.
//
// Run: node server/tests/nogit/candle-spread-combo-order.test.js
const CO = require('../../src/candle-spread/combo-order');
const CL = require('../../src/candle-spread/capital-legs');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

// A flat, deterministic pricer: each option worth a fixed toy value by moneyness proxy (strike). Enough to
// verify the ARITHMETIC of the net (real pricing is exercised elsewhere).
const price = { C: {}, P: {} };
for (let k = 100; k <= 260; k += 10) { price.C[k] = Math.max(1, (200 - k) / 5 + 5); price.P[k] = Math.max(1, (k - 200) / 5 + 5); }
const mark = (type, strike) => price[type][strike] != null ? price[type][strike] : null;

// A bull winner covered by its CREDIT tent (sell the offsetting call spread to reclaim ~width) + a brand-new
// bull debit open at different strikes → 4 distinct contracts.
const coverLegs = CL.coverLegsFor('bull', 200, 20, 'credit');   // short C200 / long C220
const openLegs = CL.openLegsFor('bull', 160, 180, 'debit');     // long C160 / short C180

// 1) distinctness
const cl = CO.comboLegs(coverLegs, openLegs);
ok(cl.legs.length === 4, `combo has 4 legs (${cl.legs.length})`);
ok(cl.distinct === true, `distinct legs flagged distinct (${JSON.stringify(cl.collisions)})`);

// collision case: new open reuses a strike the cover already trades (C220) → not distinct
const clashOpen = CL.openLegsFor('bull', 200, 220, 'debit');    // long C200 / short C220 (C220 clashes)
const clash = CO.comboLegs(coverLegs, clashOpen);
ok(clash.distinct === false && clash.collisions.includes('C220'), `collision detected (${JSON.stringify(clash.collisions)})`);

// 2) net additivity: combo net (slip 0) == cover net + open net
const cn = CO.spreadNet(coverLegs, mark), on = CO.spreadNet(openLegs, mark);
const combo = CO.comboNet(coverLegs, openLegs, mark, 0);
ok(combo && combo.net === Math.round((cn + on) * 100) / 100, `combo net == cover + open (${combo && combo.net} vs ${cn}+${on})`);
ok(combo.coverNet === cn && combo.openNet === on, 'combo reports the cover/open parts');

// 3) credit cover + debit open nets DOWN (the capital win): |combo| < |open| alone when cover is a credit
ok(cn < 0, `deep-ITM cover is a credit (${cn})`);
ok(on > 0, `new open is a debit (${on})`);
ok(Math.abs(combo.net) < Math.abs(on), `combo net (${combo.net}) is smaller than the open debit alone (${on})`);

// 4) marketable haircut: slip adds slip*4 in the worse-for-us direction (bigger debit / smaller credit)
const slipped = CO.comboNet(coverLegs, openLegs, mark, 0.05);
ok(slipped.net === Math.round((combo.net + 0.05 * 4) * 100) / 100, `slip adds slip*nLegs (${slipped.net} vs ${combo.net}+0.20)`);

// 5) payload shape: CUSTOM, 4 legs, correct instructions + net type
const resolved = cl.legs.map((l, i) => ({ ...l, symbol: `SYM${i}` }));
const p = CO.buildComboPayload(resolved, 1.25, 1, 'DEBIT');
ok(p.complexOrderStrategyType === 'CUSTOM', 'payload is CUSTOM');
ok(p.orderType === 'NET_DEBIT' && p.price === 1.25, 'payload NET_DEBIT @ price');
ok(p.orderLegCollection.length === 4, `payload has 4 legs (${p.orderLegCollection.length})`);
ok(p.orderLegCollection.every(l => l.instruction === 'BUY_TO_OPEN' || l.instruction === 'SELL_TO_OPEN'), 'all legs open');
const longs = p.orderLegCollection.filter(l => l.instruction === 'BUY_TO_OPEN').length;
ok(longs === 2, `2 buy-to-open legs (${longs})`);
const pc = CO.buildComboPayload(resolved, 0.5, 1, 'CREDIT');
ok(pc.orderType === 'NET_CREDIT', 'credit combo → NET_CREDIT');

// 6) mergeLegs: a same-direction overlap (both long C220) merges into ONE leg at qty 2 → ≤4 distinct legs
const dupLegs = [
  { side: 'long', type: 'C', strike: 220, symbol: 'A' }, { side: 'short', type: 'C', strike: 200, symbol: 'B' },
  { side: 'long', type: 'C', strike: 220, symbol: 'A' }, { side: 'short', type: 'C', strike: 240, symbol: 'C' }
];
const merged = CO.mergeLegs(dupLegs, 1);
ok(merged.length === 3, `same-dir dup merges to 3 distinct legs (${merged.length})`);
const c220 = merged.find(l => l.strike === 220);
ok(c220 && c220.side === 'long' && c220.quantity === 2, `merged C220 is long qty 2 (${c220 && c220.quantity})`);
const mp = CO.buildComboPayload(merged, 1.0, 1, 'DEBIT');
ok(mp.orderLegCollection.find(l => l.instrument.symbol === 'A').quantity === 2, 'payload carries per-leg qty 2');
// opposite-direction pair nets down (defensive — shouldn't occur after resolution)
const opp = CO.mergeLegs([{ side: 'long', type: 'P', strike: 100 }, { side: 'short', type: 'P', strike: 100 }], 1);
ok(opp.length === 0, `opposite same-strike nets to nothing (${opp.length})`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
