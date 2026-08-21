'use strict';
// Run: node scripts/signal-lab/indicators.test.js
const { resample, bollinger, ema, withIndicators, color } = require('./indicators');

let pass = 0, fail = 0;
const eq = (a, e, label) => { if (JSON.stringify(a) === JSON.stringify(e)) pass++; else { fail++; console.log(`FAIL ${label}\n  got:    ${JSON.stringify(a)}\n  expect: ${JSON.stringify(e)}`); } };
const ok = (c, label) => { if (c) pass++; else { fail++; console.log('FAIL', label); } };

// --- resample 1m -> 5m (epoch-aligned buckets) ---
// Five 1m candles at 09:30-09:34 ET (2026-01-26). 09:30 ET = 14:30Z = 1769437800000.
const base = 1769437800000;
const min = 60 * 1000;
const c1m = [
  { datetime: base + 0 * min, open: 100, high: 102, low: 99, close: 101, volume: 10 },
  { datetime: base + 1 * min, open: 101, high: 103, low: 100, close: 102, volume: 12 },
  { datetime: base + 2 * min, open: 102, high: 104, low: 101, close: 103, volume: 8 },
  { datetime: base + 3 * min, open: 103, high: 105, low: 102, close: 104, volume: 9 },
  { datetime: base + 4 * min, open: 104, high: 106, low: 103, close: 105, volume: 11 }
];
const r5 = resample(c1m, 5);
eq(r5.length, 1, 'five 1m -> one 5m bucket');
eq({ o: r5[0].open, h: r5[0].high, l: r5[0].low, c: r5[0].close, v: r5[0].volume }, { o: 100, h: 106, l: 99, c: 105, v: 50 }, '5m OHLCV aggregation');
// A 6th candle at 09:35 starts a new 5m bucket.
const r5b = resample([...c1m, { datetime: base + 5 * min, open: 105, high: 107, low: 104, close: 106, volume: 5 }], 5);
eq(r5b.length, 2, 'sixth 1m -> second 5m bucket');

// --- bollinger: flat series -> sd 0, bands collapse to mean, %B null ---
const flat = Array.from({ length: 25 }, (_, i) => ({ datetime: base + i * min, open: 50, high: 50, low: 50, close: 50, volume: 1 }));
const bbFlat = bollinger(flat, 20, 2);
ok(bbFlat[18].bbMiddle === null, 'warmup: index 18 has no bands (needs 20)');
eq({ u: bbFlat[19].bbUpper, m: bbFlat[19].bbMiddle, l: bbFlat[19].bbLower, pb: bbFlat[19].percentB }, { u: 50, m: 50, l: 50, pb: null }, 'flat series: bands = mean, %B null');

// --- bollinger: known variance -> %B sign matches band position ---
const closes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
const seq = closes.map((c, i) => ({ datetime: base + i * min, open: c, high: c, low: c, close: c, volume: 1 }));
const bb = bollinger(seq, 20, 2)[19];
// mean of 1..20 = 10.5; last close 20 sits near (but inside) the 2σ upper band -> 0.8 < %B < 1
ok(bb.bbMiddle === 10.5, 'mean of 1..20 = 10.5');
ok(bb.percentB > 0.8 && bb.percentB < 1, 'rising close near upper band -> 0.8 < %B < 1');
// A close that jumps well beyond the band pushes %B above 1.
const jump = bollinger([...seq.slice(0, 19), { datetime: base + 19 * min, open: 40, high: 40, low: 40, close: 40, volume: 1 }], 20, 2)[19];
ok(jump.percentB > 1, 'close beyond the upper band -> %B > 1');

// --- withIndicators merges fields; color ---
const wi = withIndicators(seq, 20, 2);
ok(wi[19].close === 20 && wi[19].percentB > 0.8 && wi[19].percentB < 1, 'withIndicators keeps OHLC + adds %B');

// --- ema(9): seed = SMA(first 9), then recursive with k = 2/10 ---
const eFlat = ema(flat, 9);
ok(eFlat[7] === null, 'ema9 warmup: index 7 null');
ok(eFlat[8] === 50, 'ema9 flat series = value after warmup');
const eSeq = ema(seq, 9);
ok(eSeq[8] === 5, 'ema9 seed = SMA(1..9) = 5');
ok(eSeq[9] === 6, 'ema9 step = (10-5)*0.2+5 = 6');
ok(wi[19].ema9 != null, 'withIndicators adds ema9');
eq([color({ open: 1, close: 2 }), color({ open: 2, close: 1 }), color({ open: 1, close: 1 })], ['green', 'red', 'flat'], 'color by close vs open');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
