'use strict';
// A run that has not settled YET vs one that never settled. They look identical in the record — no
// eod_settlement event — and mean opposite things. Getting this wrong put a red "never settled" warning
// across the compare screen for the whole trading day, every day.
const assert = require('assert');
const RC = require('../../shared/run-completeness.js');

let passed = 0;
const t = (name, fn) => { try { fn(); console.log('  ✓ ' + name); passed++; } catch (e) { console.log('  ✗ ' + name + '\n     ' + e.message); process.exitCode = 1; } };

console.log('\nrun-completeness: in-progress vs incomplete');

// 2026-09-08 is a normal Tuesday session (16:00 close). ET is UTC-4 in September.
const DAY = '2026-09-08';
const etMs = (h, m) => Date.UTC(2026, 8, 8, h + 4, m);      // ET hour -> UTC ms
const run = (opts = {}) => ({
  tradeDate: opts.date || DAY,
  state: { lastCandleTime: opts.last === undefined ? '09/08 11:05' : opts.last },
  events: opts.settled
    ? [{ type: 'eod_settlement', settle: 29500, settleSource: 'chain' }]
    : (opts.settleFailed ? [{ type: 'eod_settlement' }] : []),
});

t('mid-session today is IN PROGRESS, not incomplete', () => {
  const a = RC.assessRun(run(), etMs(11, 5));
  assert.strictEqual(a.status, 'in-progress');
  assert.strictEqual(a.label, 'in progress');
  assert.match(a.detail, /still open/);
  assert.ok(!/never settled/i.test(a.detail), 'must not say "never settled" during the session');
});

t('in-progress is still NOT gradable — a partial day vs a full-day average is not a fair comparison', () => {
  const a = RC.assessRun(run(), etMs(11, 5));
  assert.strictEqual(a.complete, false);
  const c = RC.comparabilityOf(run(), etMs(11, 5));
  assert.strictEqual(c.ok, false);
  assert.strictEqual(c.pending, true, 'pending distinguishes "not yet" from "not ever"');
});

t('right at the open it is in progress', () => {
  assert.strictEqual(RC.assessRun(run({ last: '09/08 09:35' }), etMs(9, 35)).status, 'in-progress');
});

t('one minute before the close it is STILL in progress', () => {
  assert.strictEqual(RC.assessRun(run(), etMs(15, 59)).status, 'in-progress');
});

t('inside the settlement grace after the close it is still in progress', () => {
  assert.strictEqual(RC.assessRun(run(), etMs(16, 5)).status, 'in-progress',
    'settlement is a scheduled job, not instantaneous — a few minutes late is not a failure');
});

t('past the grace with no settlement, it IS incomplete', () => {
  const a = RC.assessRun(run(), etMs(16, 30));
  assert.strictEqual(a.status, 'unsettled');
  assert.strictEqual(a.label, 'INCOMPLETE');
  assert.match(a.detail, /never settled/);
});

t('a settled run is complete regardless of the clock', () => {
  for (const when of [etMs(11, 5), etMs(16, 5), etMs(23, 0)]) {
    const a = RC.assessRun(run({ settled: true }), when);
    assert.strictEqual(a.status, 'settled');
    assert.strictEqual(a.complete, true);
  }
});

t('a PRIOR day that never settled is incomplete even during the current session', () => {
  const a = RC.assessRun(run({ date: '2026-09-04' }), etMs(11, 5));
  assert.strictEqual(a.status, 'unsettled', 'only TODAY can be in progress');
  assert.match(a.detail, /never settled/);
});

t('a half day is in progress before 13:00 and incomplete well after', () => {
  // 2026-11-27 is the Friday after Thanksgiving — a 13:00 close.
  const half = { tradeDate: '2026-11-27', state: { lastCandleTime: '11/27 12:05' }, events: [] };
  const before = RC.assessRun(half, Date.UTC(2026, 10, 27, 12 + 5, 0));   // 12:00 ET (EST = UTC-5)
  const after = RC.assessRun(half, Date.UTC(2026, 10, 27, 14 + 5, 0));    // 14:00 ET
  assert.strictEqual(before.status, 'in-progress', 'still open at noon on a half day');
  assert.ok(before.earlyClose, 'and the calendar knows it is a half day');
  assert.strictEqual(after.status, 'unsettled', 'an hour past a 13:00 close is genuinely unsettled');
});

t('a settlement that ran but could not price is still a real failure, not "in progress"', () => {
  const a = RC.assessRun(run({ settleFailed: true }), etMs(11, 5));
  assert.strictEqual(a.status, 'no-settle-price');
  assert.strictEqual(a.complete, false);
});

console.log(`  ${passed} passed`);
