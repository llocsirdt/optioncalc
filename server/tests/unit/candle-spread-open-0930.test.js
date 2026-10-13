'use strict';
// FIRST ACTION AT 09:30 + OPENING FALLBACK (2026-10-13).
//   The 09:30 decision acts on the completed 09:15-09:30 /NQ bar, priced off NDX's first 1-minute close.
//   If no placement can be priced then (every one over the cap, or quotes refused), the order is placed anyway:
//   short strike nearest the underlying, bull 0.50-0.55 x W, bear 0.47-0.52 x W, walked from the low end.
//
// Run: node server/tests/unit/candle-spread-open-0930.test.js
const T = require('../../src/candle-spread/trader');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

const cfg = { spreadWidth: 10, strikeIncrement: 10, tickIncrement: 0.05, quantity: 1, openFallbackUntilMin: 570,
  openFallbackBull: [0.50, 0.55], openFallbackBear: [0.47, 0.52] };
// Chaotic opening chain: every 10W vertical marks ~$7 (over the $6.50 cap).
const getLeg = (type, strike) => ({ mid: type === 'C' ? Math.max(0.1, (31000 - strike) * 0.7 + 20) : Math.max(0.1, (strike - 31000) * 0.7 + 20), bid: 1, ask: 40, symbol: `NDX_${type}${strike}` });

ok(T.openFallbackApplies(cfg, '10/14 09:30'), 'applies at the 09:30 decision');
ok(!T.openFallbackApplies(cfg, '10/14 09:45'), 'not at 09:45');
ok(!T.openFallbackApplies({ ...cfg, openFallbackUntilMin: null }, '10/14 09:30'), 'off when unset');

{
  const fb = T.buildOpenFallback('bull', 30996, cfg, getLeg);
  ok(!fb.error && fb.shortStrike === 31000, `bull: short strike nearest the underlying (${fb.shortStrike})`);
  ok(fb.legs.find((l) => l.side === 'long').strike === 30990 && fb.legs.every((l) => l.type === 'C'), 'bull: call spread 30990/31000');
  ok(fb.limit === 5 && fb.cap === 5.5, `bull: placed at 5.00, walks to 5.50 (${fb.limit} / ${fb.cap})`);
  ok(fb.payload.orderType === 'NET_DEBIT' && fb.payload.price === 5, 'sent as a NET_DEBIT at the low end');
}
{
  const fb = T.buildOpenFallback('bear', 31004, cfg, getLeg);
  ok(!fb.error && fb.shortStrike === 31000, `bear: short strike nearest the underlying (${fb.shortStrike})`);
  ok(fb.legs.find((l) => l.side === 'long').strike === 31010 && fb.legs.every((l) => l.type === 'P'), 'bear: put spread 31010/31000');
  ok(fb.limit === 4.7 && fb.cap === 5.2, `bear: placed at 4.70, walks to 5.20 (${fb.limit} / ${fb.cap})`);
}
{
  const fb = T.buildOpenFallback('bull', 30996, { ...cfg, spreadWidth: 20 }, getLeg);
  ok(fb.limit === 10 && fb.cap === 11, `20W scales by width (${fb.limit} / ${fb.cap})`);
}

{
  const day = { ...cfg, openFallbackUntilMin: 955, minDebitFrac: 0.45, capFrac: 0.55, openWalkCapFrac: 0.55 };
  ok(T.openFallbackApplies(day, '10/14 13:05'), 'all-day setting applies mid-day');
  const fb = T.buildOpenFallback('bear', 31004, day, getLeg, 13 * 60 + 5);
  ok(fb.limit === 4.5 && fb.cap === 5.5, `mid-day: the variant's own band, 4.50 -> 5.50 (${fb.limit} / ${fb.cap})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
