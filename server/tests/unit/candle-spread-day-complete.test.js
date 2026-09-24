'use strict';
// A session still in progress must never be cached as if it were the whole day.
const { dayIsComplete } = require('../../src/candle-spread/backtest/run-day-record');
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
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
