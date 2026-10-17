'use strict';
// v11 TOUCH OVERLAY on runDay5m (backtest-only, 2026-10-17): opts.touchCover / touchTarget / touchFilter / touchAnyTime.
// Off = identical; 'be' books the touched cover at or under break-even; 'gu' sends it to the give-up path; the filter
// blocks the side opposite an active setup ('block-against') or anything not on the setup's side ('require').
//
// Run: cd server && node tests/run-unit.js touch-overlay
const { runDay5m } = require('../../src/candle-spread/backtest/backtest-v6-5m');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

const DAY0 = Date.UTC(2026, 9, 16, 4, 0, 0);   // EDT
// closes[k] = close of the bar stamped 09:35 + 5k. NQ 15m/60m trend UP (price and completed close above the 9EMA).
function makeDay(closes) {
  const bars = []; let prev = closes[0];
  for (let m = 9 * 60; m <= 16 * 60; m += 5) {
    const k = Math.max(0, (m - 575) / 5), c = m < 575 ? closes[0] : closes[Math.min(k, closes.length - 1)];
    const o = prev, f = { open: o, high: Math.max(o, c) + 2, low: Math.min(o, c) - 2, close: c, bbupper: c + 60, bblower: c - 60, bbmiddle: c, ema: c }; prev = c;
    const up = { open: c, high: c + 30, low: c - 30, close: c + 2, bbupper: c + 150, bblower: c - 150, bbmiddle: c, ema: c - 5 };
    bars.push({ dt: DAY0 + m * 60000, analysis: { '1m': f, '5m': f, '15m': up, '60m': { ...up }, m }, px: null, fifteen: m % 15 === 0 });
  }
  return bars;
}
const priceOf = (b) => { const c = b.analysis['5m']; return { close: c.close, high: c.high, low: c.low }; };
const prior = (level) => { const bars = [];
  for (let s = 8; s >= 1; s--) for (let m = 575; m <= 960; m += 5) bars.push({ day: `2026-10-${String(16 - s).padStart(2, '0')}`, min: m, open: level, high: level + 1, low: level - 1, close: level });
  return { priorBars: bars, priorClose: level }; };
// RTH 15m mid ~20060 (prior sessions), today below it at 20000 -> setup active toward BULL
const flat = Array.from({ length: 80 }, (_, k) => 20000 + (k % 2));
const rally = Array.from({ length: 80 }, (_, k) => (k < 4 ? 20000 : Math.min(20090, 20000 + 6 * (k - 3))));
const sig = (side, mins) => (A) => ({ openSide: mins.includes(A.m) ? side : null, cover: false });
const baseOpts = { rthActionOnly: true, priceOf, continuousCover: true, continuousCoverMinLockFrac: 0.2, coverLadder: true, ladderStepSeconds: 120,
  ladderStepPoints: 10, ladderLossCapFrac: 0, ladderStepDollars: 0.05, coverGiveUp: true, giveUpMaxLoss: 0.075, simFillAtLimit: true, coverFillAtResting: true,
  fillThroughTicksCover: 1, subBarFill: 'path', bidirectional: true, recordReplay: true, rthCtx: prior(20060) };
const strip = (r) => JSON.stringify({ t: r.terminal, f: r.floor, o: r.opens, p: r.positions.map((p) => [p.side, p.limit, p.covered, p.coverLimit, p.coverTime]) });

// 1) OFF = identical (flags absent vs explicit 'off', rthCtx present either way)
{
  const bars = makeDay(rally), fn = sig('bull', [580, 600, 620]);
  const a = runDay5m(bars, fn, { ...baseOpts });
  const b = runDay5m(bars, fn, { ...baseOpts, touchCover: 'off', touchFilter: 'off', touchTarget: 'mid', touchAnyTime: false });
  ok(a.opens > 0 && strip(a) === strip(b), 'off = byte-identical book');
  ok(a.touch === undefined && b.touch === undefined, 'no touch telemetry when off');
}

// 2) 'be': positions opened toward the active setup are tagged; the touch books the cover at or under break-even
{
  const bars = makeDay(rally), fn = sig('bull', [580, 585, 590]);
  const r = runDay5m(bars, fn, { ...baseOpts, touchCover: 'be', continuousCoverMinLockFrac: 0.45 });
  ok(r.touch && r.touch.setupBars > 0, `setup active on some bars (${r.touch && r.touch.setupBars})`);
  const tagged = r.positions.filter((p) => p.touchLvl != null);
  ok(tagged.length > 0 && tagged.every((p) => p.side === 'bull' && p.touchLvl > p.openUnder), 'bull opens tagged with the level above them');
  ok(r.touch.hits > 0, `touches counted (${r.touch.hits})`);
  const touched = r.positions.filter((p) => p._touched && p.covered && !p._gu);
  ok(touched.length > 0 && touched.every((p) => p.limit + p.coverLimit <= 20 + 1e-9), `touched covers book <= break-even (${touched.map((p) => (p.limit + p.coverLimit).toFixed(2))})`);
  ok(r.touch.coverFills === r.positions.filter((p) => p._touched && p.covered).length, 'touch cover fills counted');
  const ctl = runDay5m(bars, fn, { ...baseOpts, continuousCoverMinLockFrac: 0.45 });
  ok(ctl.positions.filter((p) => p.covered).length <= r.positions.filter((p) => p.covered).length, 'be never covers fewer positions than the control here');
  // 'gu': the touched position goes to the give-up path
  const g = runDay5m(bars, fn, { ...baseOpts, touchCover: 'gu', continuousCoverMinLockFrac: 0.45 });
  ok(g.positions.some((p) => p._touched && p._gu), 'gu escalates the touched position to give-up');
  ok(g.positions.filter((p) => p.covered).every((p) => p.limit + p.coverLimit <= 20 * 1.075 + 1e-9), 'gu covers stay inside the give-up cap');
  // touchAnyTime: no setup ever active (maxDist tiny) -> nothing is tagged and no touch fires, unless touchAnyTime,
  // which reacts to any position whose profit side faces the RTH 15m mid
  const tiny = { ...baseOpts, touchCover: 'be', touchMaxDist: 0.01, continuousCoverMinLockFrac: 0.45 };
  const off = runDay5m(bars, fn, tiny), any = runDay5m(bars, fn, { ...tiny, touchAnyTime: true });
  ok(off.touch.setupBars === 0 && off.touch.hits === 0 && off.positions.every((p) => p.touchLvl == null), 'no setup -> no tags, no touches');
  ok(any.touch.hits > 0, `touchAnyTime touches untagged positions facing M (${any.touch.hits})`);
}

// 3) FILTER: setup is BULL; 'block-against' refuses bears and lets bulls through; 'require' refuses bears
{
  const bars = makeDay(flat);
  const bear = runDay5m(bars, sig('bear', [600, 640]), { ...baseOpts, touchFilter: 'block-against' });
  ok(bear.opens === 0 && bear.touch.blocked > 0, `block-against refuses bears opposite a bull setup (blocked ${bear.touch.blocked})`);
  const bull = runDay5m(bars, sig('bull', [600]), { ...baseOpts, touchFilter: 'block-against' });
  ok(bull.opens > 0 && bull.touch.blocked === 0, 'block-against lets the setup side through');
  const req = runDay5m(bars, sig('bear', [600]), { ...baseOpts, touchFilter: 'require' });
  ok(req.opens === 0 && req.touch.blocked > 0, 'require refuses the non-setup side');
  // no setup at all (prior at spot): require blocks everything, block-against blocks nothing
  const none = { ...baseOpts, rthCtx: prior(20000) };
  const rq = runDay5m(bars, sig('bull', [600]), { ...none, touchFilter: 'require' });
  const ba = runDay5m(bars, sig('bull', [600]), { ...none, touchFilter: 'block-against' });
  ok(rq.opens === 0 && ba.opens > 0, 'without a setup: require blocks, block-against does not');
}

console.log(`touch overlay: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
