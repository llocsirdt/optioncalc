'use strict';
// A session still in progress must never be cached as if it were the whole day.
const RDR = require('../../src/candle-spread/backtest/run-day-record');
const { dayIsComplete } = RDR;
let pass=0, fail=0;
const ok=(c,m)=>{ if(c) pass++; else { fail++; console.log('FAIL:',m); } };
// ET minute -> epoch on a known non-DST-boundary weekday
const at=(h,m)=>Date.parse(`2026-09-23T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00-04:00`);
const day=(...mins)=>({ date:'2026-09-23', bars: mins.map(([h,m])=>({ dt: at(h,m) })) });

ok(dayIsComplete(day([9,35],[15,55])) === true, 'a day whose last bar is 15:55 ET is complete');
ok(dayIsComplete(day([9,35],[15,50])) === false, 'one ending 15:50 is NOT complete');
ok(dayIsComplete(day([9,35],[9,55])) === false,
  'the 09-23 case: five bars ending 09:55 is a session in progress, not a day');
ok(dayIsComplete(day([9,35],[11,40])) === false, 'the 09-21 case: a mid-session stump is not complete');
ok(dayIsComplete(day([9,35],[16,0])) === true, 'a bar past the close still counts as complete');
ok(dayIsComplete({ date:'x', bars: [] }) === false, 'no bars is not complete');
ok(dayIsComplete(null) === false, 'no day is not complete');
ok(dayIsComplete({ date:'x', bars: [{}] }) === false, 'a bar with no timestamp is not complete');
// `datetime` is the other spelling the builders use
ok(dayIsComplete({ date:'x', bars: [{ datetime: at(15,55) }] }) === true, 'accepts the `datetime` spelling too');
// ── A PARTIAL CACHE FOR *TODAY* GOES STALE TOO ──────────────────────────────────────────────────────
// The first version of this guard dropped a stale partial only when `date < etToday()` — "keep any
// partial for today, because today is still moving and rebuilding every request would hammer Schwab".
// That holds only while the session really is still moving. It is wrong from 16:00 ET until midnight, and
// wrong all day in a subtler way: a stump built at 09:55 was served unchanged at 15:00, 62 bars short.
//
// Observed on prod 2026-09-23 at 23:40 ET: the on-demand backtest returned FIVE bars (09:35 -> 09:55) and
// 3 positions for a session the live engine ran to 76 bars and 22 positions — so the compare and debug
// overlays drew a curve off a 20-minute stump while agreeing with each other perfectly.
//
// The real question is whether the tape has moved past the last bar we hold.
{
  const at = (d, h, m) => Date.parse(`${d}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00-04:00`);
  const day = (d, h, m) => ({ date: d, bars: [{ dt: at(d, h, m - 5) }, { dt: at(d, h, m) }] });
  const D = '2026-09-23';

  ok(RDR.cachedDayIsStale(day(D, 15, 55), D, at(D, 23, 40)) === false,
    'a COMPLETE day is never stale, whatever the hour');
  ok(RDR.cachedDayIsStale(day(D, 9, 55), D, at(D, 9, 57)) === false,
    'a stump is kept mid-bar — the next bar has not closed, so there is nothing to rebuild with');
  ok(RDR.cachedDayIsStale(day(D, 9, 55), D, at(D, 10, 0)) === true,
    'and dropped as soon as the next bar closes');
  ok(RDR.cachedDayIsStale(day(D, 9, 55), D, at(D, 15, 0)) === true,
    'a 09:55 stump is stale at 15:00 — 62 bars behind');
  ok(RDR.cachedDayIsStale(day(D, 9, 55), D, at(D, 23, 40)) === true,
    'and stale after the close — THE REGRESSION: `date < etToday()` said fresh until midnight');
  ok(RDR.cachedDayIsStale(day('2026-09-22', 12, 0), '2026-09-22', at(D, 23, 40)) === true,
    'a past session that never completed is stale');

  // Anything we cannot judge is stale: better one rebuild than a stump served forever.
  ok(RDR.cachedDayIsStale({ date: D, bars: [] }, D, at(D, 12, 0)) === true, 'no bars -> stale');
  ok(RDR.cachedDayIsStale({ date: D, bars: [{ dt: null }] }, D, at(D, 12, 0)) === true, 'unreadable stamps -> stale');

  // The bar interval is read off the data, not assumed: a 15m dataset must not be called stale 5m early.
  const d15 = { date: D, bars: [{ dt: at(D, 9, 45) }, { dt: at(D, 10, 0) }] };
  ok(RDR.cachedDayIsStale(d15, D, at(D, 10, 10)) === false, 'a 15m dataset is not stale 10 minutes on');
  ok(RDR.cachedDayIsStale(d15, D, at(D, 10, 15)) === true, 'but is once its own next bar closes');
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
