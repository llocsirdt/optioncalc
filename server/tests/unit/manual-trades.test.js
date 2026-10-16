'use strict';
// MANUAL TRADES (2025 E*TRADE history) — order classifier, expiry settlement math, export parsing and the
// order-grouping inference for date-only exports. Fixtures are real fills (strikes/prices) from 2025-06;
// no account identifiers.
//
// Run: node server/tests/unit/manual-trades.test.js
const B = require('../../src/manual-trades/book');
const E = require('../../src/manual-trades/etrade');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
const L = (right, strike, qty, price = 0) => ({ right, strike, qty, price });

// ---- classifier ----
{
  const c = B.classifyOrder([L('P', 22640, 1, 53.62), L('P', 22610, -1, 36.7)]);   // #20361
  eq([c.style, c.subtype, c.direction, c.widths, c.netPerUnit], ['vertical', 'put debit', 'bear', [30], 16.92], 'put debit vertical');
}
{
  const c = B.classifyOrder([L('P', 22000, -1, 40), L('P', 21900, 1, 20)]);
  eq([c.subtype, c.direction, c.debitCredit], ['put credit', 'bull', 'credit'], 'put credit vertical');
  const d = B.classifyOrder([L('C', 21800, 1, 30), L('C', 21840, -1, 12)]);
  eq([d.subtype, d.direction], ['call debit', 'bull'], 'call debit vertical');
  const e = B.classifyOrder([L('C', 21800, -1, 30), L('C', 21840, 1, 12)]);
  eq([e.subtype, e.direction], ['call credit', 'bear'], 'call credit vertical');
}
{
  // quantity > 1 and partial-fill rows of the same leg aggregate
  const c = B.classifyOrder([L('P', 21850, -1, 49.2), L('P', 21890, 1, 72.65), L('P', 21850, -1, 49.3), L('P', 21890, 1, 72.8)]);
  eq([c.style, c.unit, c.widths, c.netPerUnit], ['vertical', 2, [40], 23.47], 'partial fills -> 2-lot vertical, VWAP net');
}
{
  const c = B.classifyOrder([L('C', 21940, 1), L('C', 22000, -2), L('C', 22060, 1)]);
  eq([c.style, c.direction, c.widths, c.center], ['butterfly', 'long', [60, 60], 22000], 'symmetric fly');
  const bw = B.classifyOrder([L('P', 20020, 1), L('P', 20090, -2), L('P', 20190, 1)]);
  eq([bw.style, bw.widths, bw.lean], ['broken-wing butterfly', [70, 100], 'peak-low (narrow lower wing)'], 'broken-wing fly');
}
{
  // the asymmetric style: 2:-3:1 with 2*50 == 1*100 -> both tails flat at zero
  const c = B.classifyOrder([L('P', 21200, 2), L('P', 21250, -3), L('P', 21350, 1)]);
  eq([c.style, c.subtype, c.widths, c.ratio], ['asymmetric butterfly', 'balanced (zero both tails)', [50, 100], [2, -3, 1]], 'balanced asym fly');
  const prof = B.payoffProfile(c.legs);
  ok(prof.slopeBelow === 0 && prof.slopeAbove === 0, 'balanced asym fly has flat tails');
  eq(prof.points.map(p => p.value), [0, 10000, 0], 'balanced asym fly: 0 / peak 2*50*100 / 0');
  const u = B.classifyOrder([L('P', 19700, 2), L('P', 19750, -3), L('P', 19980, 1)]);
  eq(u.subtype, 'unbalanced (tail risk)', 'unbalanced asym fly');
}
{
  const c = B.classifyOrder([L('C', 21650, 1), L('C', 21750, -1), L('C', 21850, -1), L('C', 21950, 1)]);
  eq([c.style, c.widths], ['condor', [100, 100, 100]], 'condor');
  const b = B.classifyOrder([L('P', 21770, 1), L('P', 21800, -1), L('P', 21810, -1), L('P', 21830, 1)]);
  eq(b.style, 'broken-wing condor', 'broken-wing condor');
  const ic = B.classifyOrder([L('C', 22630, -1, 28.35), L('C', 22660, 1, 16.8), L('P', 22580, 1, 23.93), L('P', 22610, -1, 35.47)]); // #20357
  eq([ic.style, ic.widths, ic.debitCredit], ['iron condor', [30, 20, 30], 'credit'], 'iron condor');
  const ib = B.classifyOrder([L('C', 100, -1), L('C', 110, 1), L('P', 90, 1), L('P', 100, -1)]);
  eq(ib.style, 'iron butterfly', 'iron butterfly');
  const s = B.classifyOrder([L('C', 21740, 1, 51.62)]);
  eq([s.style, s.subtype, s.direction], ['single', 'long call', 'bull'], 'single');
}

// ---- settlement ----
{
  const fills = [
    { right: 'P', strike: 22650, side: 1, qty: 1, gross: -5000, fees: 1.26 },
    { right: 'P', strike: 22610, side: -1, qty: 1, gross: 3000, fees: 1.26 },
  ];
  const r = B.settleBook(fills, 22534.2);          // 2025-06-27 close
  eq([r.terminal, r.premiumCash, r.fees, r.net], [4000, -2000, 2.52, 1997.48], 'vertical fully ITM settles at width');
  const r2 = B.settleBook(fills, 22630);
  eq(r2.terminal, 2000, 'settle between strikes');
  const flat = B.settleBook([...fills, { right: 'P', strike: 22650, side: -1, qty: 1, gross: 4000, fees: 1.26 }], 22000);
  eq(flat.legs.length, 1, 'netting removes closed strike');
  // AM-settled NDX leg next to a PM NDXP leg
  const mix = B.settleBook([{ root: 'NDX', right: 'C', strike: 100, side: 1, qty: 1, gross: 0, fees: 0 },
    { root: 'NDXP', right: 'C', strike: 100, side: 1, qty: 1, gross: 0, fees: 0 }], { NDX: 105, NDXP: 110, default: 110 });
  eq(mix.terminal, 1500, 'per-root settle values');
  eq(B.impliedSettleFromRows([{ kind: 'cash-settle', right: 'P', strike: 22650, price: 115.8 }, { kind: 'cash-settle', right: 'C', strike: 22520, price: 14.2 }]),
    { min: 22534.2, max: 22534.2, n: 2 }, 'settle implied by E*TRADE cash-settle rows');
}

// ---- parsing (synthetic rows, account columns present but dropped) ----
{
  const timed = [
    'XXXX-0000, as of 07/01/25',
    '"Date / Time","Type","Account #","Account Name","Description","Fee","Comm","Amount"',
    '" 06/30/2025 04:34:04 PM","Bought To Open","XXXX-0000","Name - x0000","1 Put NDXP 06/30/25 22640.00 @ $53.62 (Order # 20361)","$0.02","$0.67","-$5,363.26"',
    '" 06/30/2025 04:34:04 PM","Sold Short","XXXX-0000","Name - x0000","1 Put NDXP 06/30/25 22610.00 @ $36.70 (Order # 20361)","$0.02","$0.67","$3,668.74"',
    '" 06/30/2025 03:00:00 AM","Sold","XXXX-0000","Name - x0000","1 Put NDXP 06/27/25 22650.00 @ $115.80","--","$0.00","$11,580.00"',
    '" 06/30/2025 03:00:00 AM","Sweep","XXXX-0000","Name - x0000","BANK DEPOSIT PROGRAM","--","$0.00","$4,656.88"',
  ].join('\n');
  const p = E.parseExport(timed);
  ok(p.format === 'timed' && !JSON.stringify(p.rows).includes('XXXX') && !JSON.stringify(p.rows).includes('x0000'), 'timed parse drops account columns');
  const x = E.extractNdx(p.rows);
  eq([x.fills.length, x.settlements.length, x.fills[0].timeET, x.fills[0].fees, x.fills[0].orderNo], [2, 1, '13:34:04', 1.26, '20361'], 'timed extract: ET = clock-3h, all-in fees');
  const dated = [
    'All Transactions', '', 'Activity/Trade Date,Transaction Date,Settlement Date,Activity Type,Description,Symbol,Cusip,Quantity #,Price $,Amount $,Commission,Category,Note',
    '06/13/2025,06/13/2025,06/16/2025,Sold Short,PUT  NDXP   06/16/25 21300.000,NDX,--,-3.0,35.23,10565.23,2.0,--,--',
    '06/13/2025,06/13/2025,06/16/2025,Bought To Open,PUT  NDXP   06/16/25 21200.000,NDX,--,2.0,23.35,-4672.51,1.33,--,--',
    '06/13/2025,06/13/2025,06/16/2025,Bought To Open,PUT  NDXP   06/16/25 21500.000,NDX,--,1.0,73.99,-7400.26,0.67,--,--',
    '06/13/2025,06/13/2025,06/12/2025,Option Expired,PUT  NDXP   06/12/25 21750.000,NDX,--,-1.0,,0.0,0.0,--,--',
    '"Footer text, legal"',
  ].join('\n');
  const d = E.parseExport(dated);
  const dx = E.extractNdx(d.rows);
  eq([d.format, dx.fills.length, dx.settlements.length, dx.fills[0].timeET, dx.fills[0].fees], ['dated', 3, 1, null, 3.77], 'dated parse');
  const g = E.inferOrders(dx.fills.map(f => ({ ...f, file: 0 })));
  eq(g.map(x => x.length), [3], 'inferred: 2:-3:1 ratio fly grouped as one order');
  // combine: timed wins a date only when it is complete
  const c = E.combineExports([p, d]);
  eq([c.sourceByDate['2025-06-30'].trade, c.sourceByDate['2025-06-13'].trade], ['timed', 'dated'], 'source by date');
  // dedupe: the same export twice adds nothing
  const twice = E.combineExports([p, E.parseExport(timed)]);
  eq(twice.rows.filter(r => r.opt).length, 3, 'duplicate export deduped');
}
{
  // interleaved legs of two adjacent orders + a partial fill split across rows
  const f = (seq, right, strike, q, price) => ({ file: 0, seq, date: 'd', expiry: 'd', open: true, right, strike, side: Math.sign(q), qty: Math.abs(q), price });
  const rows = [f(0, 'P', 22030, 3, 47.8), f(1, 'P', 22010, -3, 38.2), f(2, 'C', 21810, 1, 66.25), f(3, 'C', 21850, -1, 42.75),
    f(4, 'C', 21810, 1, 66.2), f(5, 'C', 21850, -1, 42.7)];
  const g = E.inferOrders(rows);
  eq(g.map(x => x.map(y => y.seq)), [[0, 1], [2, 3, 4, 5]], 'adjacent identical-net partial fills merge');
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
