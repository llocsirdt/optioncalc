'use strict';
// NATURAL COVER (v12 / v13) on runDay5m (backtest-only, 2026-10-17; opts.natural). REV fires only when touch + speed + run
// all hold; a 5m mid/9EMA touch alone never triggers; 'same' reuses the prior short; the jump guard fires on a +-X mark
// breach and raises the floor; v12 places no per-position covers; v13 covers only after N minutes; no lookahead.
//
// Run: cd server && node tests/run-unit.js v12-engine
const { runDay5m } = require('../../src/candle-spread/backtest/backtest-v6-5m');
const { makeGeo } = require('../../src/candle-spread/backtest/backtest-width');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

const DAY0 = Date.UTC(2026, 9, 16, 4, 0, 0);   // EDT
// closes[k] = close of the bar stamped 09:35 + 5k. nq60Touch: the completed NQ 60m candle sits AT its upper band.
function makeDay(closes, { nq60Touch = true } = {}) {
  const bars = []; let prev = closes[0];
  for (let m = 9 * 60; m <= 16 * 60; m += 5) {
    const k = Math.max(0, (m - 575) / 5), c = m < 575 ? closes[0] : closes[Math.min(k, closes.length - 1)];
    const o = prev, f = { open: o, high: Math.max(o, c), low: Math.min(o, c), close: c, bbupper: c + 60, bblower: c - 60, bbmiddle: c, ema: c }; prev = c;
    const t15 = { open: c, high: c + 2, low: c - 2, close: c, bbupper: c + 120, bblower: c - 120, bbmiddle: c, ema: c };
    const t60 = nq60Touch ? { open: c, high: c + 5, low: c - 40, close: c, bbupper: c + 5, bblower: c - 200, bbmiddle: c - 100, ema: c - 50 }
      : { open: c, high: c + 5, low: c - 40, close: c, bbupper: c + 200, bblower: c - 200, bbmiddle: c, ema: c };
    bars.push({ dt: DAY0 + m * 60000, analysis: { '1m': f, '5m': f, '15m': t15, '60m': t60, m }, px: null, fifteen: m % 15 === 0 });
  }
  return bars;
}
const priceOf = (b) => { const c = b.analysis['5m']; return { close: c.close, high: c.high, low: c.low }; };
// wide prior RTH series (alternating +-200) so the RTH 5m band is far away: the NQ 60m touch is the only touch in play
const wide = (() => { const bars = []; let n = 0;
  for (let s = 8; s >= 1; s--) for (let m = 575; m <= 960; m += 5) { const c = 20000 + Math.round(200 * Math.sin(1.3 * n++)); bars.push({ day: `2026-10-${String(16 - s).padStart(2, '0')}`, min: m, open: c, high: c, low: c, close: c }); }
  return { priorBars: bars, priorClose: 20000 }; })();
const sig = (side, mins) => (A) => ({ openSide: mins.includes(A.m) ? side : null, cover: false });
const base = { rthActionOnly: true, priceOf, geo: makeGeo({ width: 20 }), natural: 'v12', lossMax: 6000, rthCtx: wide, guardMedianIv: 0.2, jumpGuard: false, recordReplay: true };
const rally = (startK, pts) => Array.from({ length: 80 }, (_, k) => (k <= startK ? 20000 : Math.min(20000 + pts, 20000 + 12 * (k - startK))));
const revs = (r) => r.positions.filter((p) => p._nat === 'rev');
const bullAt0940 = sig('bull', [580]);

// 1) REV needs touch + window + run
{
  const r = runDay5m(makeDay(rally(1, 60)), bullAt0940, base);
  const bull = r.positions.find((p) => p.side === 'bull' && !p._nat), rv = revs(r)[0];
  ok(bull && rv && rv.side === 'bear', `touch + fast + 60 pt run -> a bear REV (${revs(r).length})`);
  ok(rv && rv.shortStrike === bull.shortStrike && r.natural.revSameHit >= 1, "'same' REV reuses the prior short strike");
  ok(bull && bull._offset === true && r.natural.offset >= 1, 'the paired position is marked offset (natural cover)');
  const noTouch = runDay5m(makeDay(rally(1, 60), { nq60Touch: false }), bullAt0940, base);
  ok(revs(noTouch).length === 0, 'no outer-band touch -> no REV');
  const late = runDay5m(makeDay(rally(9, 60)), bullAt0940, base);
  ok(revs(late).length === 0, 'the run arrives > 30 min after the last same-side open -> no REV');
  ok(revs(runDay5m(makeDay(rally(9, 60)), bullAt0940, { ...base, revWindowMin: false })).length > 0, 'revWindowMin off -> the late run REVs');
  const small = runDay5m(makeDay(rally(1, 30)), bullAt0940, base);
  ok(revs(small).length === 0, 'a 30 pt run (< 40) -> no REV');
  ok(revs(runDay5m(makeDay(rally(1, 30)), bullAt0940, { ...base, revRun: false })).length > 0, 'revRun off -> the small run REVs');
}

// 2) a 5m mid / 9EMA touch alone never triggers (touch requirement off, no outer touch anywhere)
{
  const r = runDay5m(makeDay(rally(1, 60), { nq60Touch: false }), bullAt0940, { ...base, revTouch: 'off' });
  ok(revs(r).length === 0 && r.natural.revMidOnly > 0, `only the 5m mid/9EMA in the candle -> no REV (midOnly ${r.natural.revMidOnly})`);
}

// 3) v12 places no per-position covers even with the roster cover switched on
{
  const r = runDay5m(makeDay(rally(1, 60), { nq60Touch: false }), bullAt0940, { ...base, continuousCover: true, coverLadder: true, ladderStepDollars: 0.05, ladderLossCapFrac: 0 });
  ok(r.positions.length > 0 && r.positions.every((p) => !p.covered && !p.pendingCover), 'v12: no position covered, none with a resting cover');
}

// 4) v13 covers only after N minutes
{
  const cov = { continuousCover: true, continuousCoverMinLockFrac: 0, coverLadder: true, ladderStepSeconds: 120, ladderStepPoints: 10, ladderLossCapFrac: 0, ladderStepDollars: 0.05 };
  const r = runDay5m(makeDay(rally(1, 80), { nq60Touch: false }), bullAt0940, { ...base, ...cov, natural: 'v13', coverAfterMin: 30 });
  const c = r.positions.filter((p) => p.covered);
  ok(c.length > 0 && c.every((p) => p.coverEpoch - p.openEpoch >= 30 * 60000), `v13 covers fill >= 30 min after the open (${c.map((p) => (p.coverEpoch - p.openEpoch) / 60000)})`);
  const r60 = runDay5m(makeDay(rally(1, 80), { nq60Touch: false }), bullAt0940, { ...base, ...cov, natural: 'v13', coverAfterMin: 60 });
  ok(r60.positions.filter((p) => p.covered).every((p) => p.coverEpoch - p.openEpoch >= 60 * 60000), 'coverAfterMin 60 respected');
}

// 5) jump guard: a +-X mark breach buys the losing side and raises the floor
{
  const flat = new Array(80).fill(20000);
  const r = runDay5m(makeDay(flat, { nq60Touch: false }), bullAt0940, { ...base, jumpGuard: true, guardFixed: 60, guardAt: 300 });
  const g = r.positions.filter((p) => p._nat === 'guard');
  ok(r.natural.guard >= 1 && g.length >= 1 && g[0].side === 'bear', `guard fires on the down-jump breach (fires ${r.natural.guard})`);
  const noG = runDay5m(makeDay(flat, { nq60Touch: false }), bullAt0940, { ...base, jumpGuard: false });
  ok(r.lock.endBookFloor > noG.lock.endBookFloor, `the guard raises the book floor (${noG.lock.endBookFloor} -> ${r.lock.endBookFloor})`);
  const quiet = runDay5m(makeDay(flat, { nq60Touch: false }), bullAt0940, { ...base, jumpGuard: true, guardFixed: 60 });
  ok(quiet.natural.guard === 0, 'inside the cap (-lossMax 6000) the guard stays quiet');
}

// 6) no lookahead: decisions up to 10:30 are the same with the rest of the day removed
{
  const full = makeDay(rally(1, 60)), cut = full.filter((b) => b.analysis.m <= 630);
  const a = runDay5m(full, bullAt0940, base), b = runDay5m(cut, bullAt0940, base);
  const pre = (r) => JSON.stringify(r.positions.filter((p) => p.openEpoch <= DAY0 + 630 * 60000).map((p) => [p.side, p._nat || '', p.shortStrike, p.limit, p.openEpoch]));
  ok(pre(a) === pre(b) && a.positions.length > 0, 'opens through 10:30 identical with the future removed');
}

// 7) off = untouched: natural absent vs perPositionCovers default
{
  const bars = makeDay(rally(1, 60)), o = { rthActionOnly: true, priceOf, geo: makeGeo({ width: 20 }), lossMax: 6000, recordReplay: true };
  const a = runDay5m(bars, bullAt0940, o), b = runDay5m(bars, bullAt0940, { ...o, natural: null, rthCtx: wide });
  ok(JSON.stringify(a.positions.map((p) => [p.limit, p.covered])) === JSON.stringify(b.positions.map((p) => [p.limit, p.covered])) && a.natural === undefined, 'off = identical, no telemetry');
}

console.log(`v12 engine: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
