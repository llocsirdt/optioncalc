'use strict';
// BB FADE (v20 / v21, backtest only, 2026-10-21): the open signal (5m close beyond BOTH the 15m and 60m bands) and the
// v21 strike pick (the vertical whose mark is closest to f x W, nearest the money on a tie).
//   - both-band condition: one band alone never fires; equality never fires; wrapper keeps the parent's cover
//   - no look-ahead: the 15m/60m candles slotted at a 5m mark are the last COMPLETED ones (analysis-builder), so the
//     signal at T does not change when later 1m candles are appended
//   - pickByPrice: closest price, nearest-money tie-break, bull/bear legs; makePriceTargetGeo never declines
//
// Run: node server/tests/run-unit.js bb-fade
const BF = require('../../src/candle-spread/signals/bb-fade');
const AB = require('../../src/candle-spread/analysis-builder');
const W = require('../../src/candle-spread/backtest/backtest-width');
const eng = require('../../src/candle-spread/backtest/backtest-v4');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

// ── both-band condition ──────────────────────────────────────────────────────────────────────────────
const C = (close, lo, hi) => ({ open: close, high: close, low: close, close, bblower: lo, bbupper: hi, bbmiddle: (lo + hi) / 2, ema: close });
const A = (x, b15, b60) => ({ '1m': C(x, 0, 1e9), '5m': C(x, 0, 1e9), '15m': C(100, b15[0], b15[1]), '60m': C(100, b60[0], b60[1]) });
ok(BF.bbFadeSide(A(89, [90, 110], [95, 105])) === 'bull', 'below both lower bands -> bull');
ok(BF.bbFadeSide(A(111, [90, 110], [95, 105])) === 'bear', 'above both upper bands -> bear');
ok(BF.bbFadeSide(A(92, [90, 110], [95, 105])) === null, 'below the 60m lower only -> nothing');
ok(BF.bbFadeSide(A(89, [90, 110], [85, 115])) === null, 'below the 15m lower only -> nothing');
ok(BF.bbFadeSide(A(107, [90, 110], [95, 105])) === null, 'above the 60m upper only -> nothing');
ok(BF.bbFadeSide(A(90, [90, 110], [95, 105])) === null, 'close ON the band is not beyond it');
ok(BF.bbFadeSide({ '5m': C(80, 0, 1e9), '15m': C(100, 90, 110) }) === null, 'missing 60m -> nothing');
{
  const parent = () => ({ openSide: 'bear', coverSide: 'bull', reason: 'trend-flip' });
  const s = BF.bbFadeSignal(parent)(A(89, [90, 110], [95, 105]), null, {});
  ok(s.openSide === 'bull' && s.coverSide === 'bull', 'wrapper: open from the fade, cover from the parent');
  const s2 = BF.bbFadeSignal(parent)(A(100, [90, 110], [95, 105]), null, {});
  ok(s2.openSide === null && s2.coverSide === 'bull', 'wrapper: no fade -> parent open dropped, its cover kept');
}

// ── no look-ahead through the live / dataset analysis builder ────────────────────────────────────────
{
  // 1m series: flat drift for warm-up, then a hard drop. Times on the epoch grid (15m/60m buckets aligned).
  const t0 = Date.UTC(2026, 0, 5, 0, 0), M = 60000, raw = [];
  let px = 20000;
  for (let i = 0; i < 60 * 30; i++) { px += Math.sin(i / 7) * 2; raw.push({ datetime: t0 + i * M, open: px, high: px + 1, low: px - 1, close: px, volume: 1 }); }
  const T = t0 + 60 * 30 * M - 10 * M + 5 * M;          // a 5m mark that is NOT a 15m boundary (xx:05 style)
  const before = raw.filter((c) => c.datetime < T);
  const { A: A1 } = AB.buildA(before, T);
  // append the future: a crash after T. The slotted 15m/60m candles and the signal at T must not change.
  const fut = raw.filter((c) => c.datetime < T).concat(Array.from({ length: 120 }, (_, k) => {
    const p = px - 50 * (k + 1); return { datetime: T + k * M, open: p, high: p, low: p, close: p, volume: 1 };
  }));
  const { A: A2 } = AB.buildA(fut, T);
  ok(JSON.stringify(A1['15m']) === JSON.stringify(A2['15m']) && JSON.stringify(A1['60m']) === JSON.stringify(A2['60m']), '15m/60m bands at T ignore candles after T');
  ok(BF.bbFadeSide(A1) === BF.bbFadeSide(A2), 'signal at T unchanged by the future');
  // and the slotted 15m candle is the last COMPLETED one: its bucket ends at or before T
  const s15 = AB.buildSeries(before)['15m'];
  const last15Start = Math.floor(T / (15 * M)) * 15 * M - 15 * M;   // T is mid-bucket -> previous bucket is the completed one
  ok(A1['15m'].close === s15.byStart.get(last15Start).close, '15m candle at a mid-bucket 5m mark = the previous (completed) 15m bar');
}

// ── v21 strike pick ──────────────────────────────────────────────────────────────────────────────────
{
  // synthetic linear pricer: a bull call vertical [lo, hi] marks W * clamp(0.5 + (S - mid)/ (2*25)) — monotone in moneyness
  const S = 20003, Wd = 20;
  const mid = (legs) => (legs[0].strike + legs[1].strike) / 2;
  const lin = (legs) => { const m = mid(legs), isCall = legs[0].type === 'C', d = isCall ? (S - m) : (m - S); return Wd * Math.max(0.02, Math.min(0.98, 0.5 + d / 50)); };
  const b = W.pickByPrice('bull', S, Wd, 0.6, lin, { incr: 10 });
  ok(b && Math.abs(b.mark - 12) < 2.1, 'bull pick lands near 0.6 x W');
  // exhaustive check: no other grid spread is closer
  let bestErr = Infinity; for (let k = -12; k <= 12; k++) { const hi = 20000 + k * 10; const m = lin([{ type: 'C', strike: hi - Wd }, { type: 'C', strike: hi }]); bestErr = Math.min(bestErr, Math.abs(m - 12)); }
  ok(Math.abs(Math.abs(b.mark - 12) - bestErr) < 1e-9, 'bull pick is the closest-priced spread on the grid');
  ok(b.legs[0].side === 'long' && b.legs[0].type === 'C' && b.legs[1].strike - b.legs[0].strike === Wd, 'bull legs: long lower call, width W');
  ok(b.shortStrike < S + 10, 'f 0.6 bull spread sits at/inside the money');
  const p = W.pickByPrice('bear', S, Wd, 0.6, lin, { incr: 10 });
  ok(p.legs[0].type === 'P' && p.legs[0].side === 'long' && p.legs[0].strike - p.legs[1].strike === Wd, 'bear legs: long upper put, width W');
  // tie-break: a flat pricer prices everything the same -> nearest the money wins
  const flat = () => 10;
  const t = W.pickByPrice('bull', 20003, 20, 0.5, flat, { incr: 10 });
  ok(Math.abs((t.legs[0].strike + t.legs[1].strike) / 2 - 20003) <= 5, 'tie -> spread centred nearest the money');
  // real engine pricer: makePriceTargetGeo never declines and prices within reach of f x W
  const g = W.makePriceTargetGeo({ width: 20, f: 0.55, walkCapFrac: 0.625 });
  const o = g.buildOpen('bull', 20003, 0.25 / 365, 0.18);
  ok(!o.skip && o.legs && o.limit > 0, 'geo opens');
  ok(Math.abs(o.fracOfWidth - 0.55) < 0.15, 'geo price near target (BS)');
  ok(o.capOverride >= o.limit && Math.abs(o.capOverride - Math.max(o.limit, 12.5)) < 1e-9, 'walk cap = max(limit, walkCapFrac x W)');
  ok(Math.abs(eng.legsMark(o.legs, 20003, 0.25 / 365, 0.18) / 20 - o.fracOfWidth) < 1e-9, 'fracOfWidth = engine legsMark');
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
