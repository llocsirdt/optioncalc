'use strict';
// Is a run a whole trading day? The point of this module is that a truncated run and a finished one look
// identical downstream — same book, same P&L, same chart — so these tests pin the cases where they must
// be told apart, and especially the half-day case, where a SHORT session is not an INCOMPLETE one.
const assert = require('assert');
const rc = require('../../shared/run-completeness.js');

let passed = 0;
const t = (name, fn) => { try { fn(); console.log('  ✓ ' + name); passed++; } catch (e) { console.log('  ✗ ' + name + '\n     ' + e.message); process.exitCode = 1; } };

// Minimal run record: what the store keeps, reduced to what completeness reads.
function run({ date, lastCandle, settle, settleSource, settleEvent = true }) {
  const events = [{ type: 'candle_close' }];
  if (settleEvent && settle !== undefined) {
    events.push({ type: 'eod_settlement', settle, settleSource: settleSource || 'index-close' });
  }
  return { tradeDate: date, state: { lastCandleTime: lastCandle }, events };
}

console.log('\nrun-completeness');

t('a settled run is complete', () => {
  const a = rc.assessRun(run({ date: '2026-09-04', lastCandle: '09/04 15:55', settle: 29546.63 }));
  assert.strictEqual(a.complete, true);
  assert.strictEqual(a.status, 'settled');
  assert.strictEqual(a.settleSource, 'index-close');
  assert.match(a.detail, /16:00 close/);
});

t('a run that never settled is INCOMPLETE, and says how much it missed', () => {
  const a = rc.assessRun(run({ date: '2026-09-04', lastCandle: '09/04 15:45', settleEvent: false }));
  assert.strictEqual(a.complete, false);
  assert.strictEqual(a.status, 'unsettled');
  assert.strictEqual(a.shortfallMin, 10, '15:45 -> the 15:55 last action bar');
  assert.match(a.detail, /stopped at 09\/04 15:45/);
  assert.match(a.detail, /missing the last 10 min/);
});

t('reaching the last action bar but never settling is still incomplete', () => {
  // The 08/31 case: it got all the way to 15:55, so nothing is "missing" — but with no settlement there
  // is no terminal P&L, and calling that complete is how an unsettled book gets graded.
  const a = rc.assessRun(run({ date: '2026-08-31', lastCandle: '08/31 15:55', settleEvent: false }));
  assert.strictEqual(a.complete, false);
  assert.strictEqual(a.shortfallMin, 0);
  assert.ok(!/missing the last/.test(a.detail), 'must not claim missing minutes when there are none');
});

t('settlement that could not price the book is NOT complete', () => {
  const a = rc.assessRun({
    tradeDate: '2026-09-04', state: { lastCandleTime: '09/04 15:55' },
    events: [{ type: 'eod_settlement', note: 'no settle price available' }],
  });
  assert.strictEqual(a.complete, false);
  assert.strictEqual(a.status, 'no-settle-price');
});

// --- HALF DAYS: the case that breaks any check keyed on a 16:00 clock -------------------------------
t('a HALF DAY that settled at 13:00 is complete, not short', () => {
  // Black Friday 2026. A 13:00 finish is the whole session.
  const a = rc.assessRun(run({ date: '2026-11-27', lastCandle: '11/27 12:55', settle: 25000 }));
  assert.strictEqual(a.complete, true);
  assert.strictEqual(a.earlyClose, true);
  assert.strictEqual(a.expectedCloseMin, 13 * 60);
  assert.strictEqual(a.label, 'settled (half day)');
});

t('an unsettled half day is measured against 13:00, not 16:00', () => {
  const a = rc.assessRun(run({ date: '2026-11-27', lastCandle: '11/27 12:55', settleEvent: false }));
  assert.strictEqual(a.shortfallMin, 0, 'reached the 12:55 last action bar of a half day');
  const early = rc.assessRun(run({ date: '2026-11-27', lastCandle: '11/27 11:30', settleEvent: false }));
  assert.strictEqual(early.shortfallMin, 85, '11:30 -> 12:55');
});

t('the SAME clock time is a full session on a half day and a huge gap on a normal day', () => {
  // This is the whole reason the calendar is consulted rather than assuming 16:00.
  const half = rc.assessRun(run({ date: '2026-11-27', lastCandle: '11/27 12:55', settleEvent: false }));
  const full = rc.assessRun(run({ date: '2026-11-30', lastCandle: '11/30 12:55', settleEvent: false }));
  assert.strictEqual(half.shortfallMin, 0);
  assert.strictEqual(full.shortfallMin, 180, 'a normal Monday: 12:55 is three hours short of 15:55');
});

t('a run on a day the market was shut is flagged as such', () => {
  const a = rc.assessRun(run({ date: '2026-11-26', lastCandle: '11/26 12:00', settle: 25000 }));
  assert.strictEqual(a.status, 'not-a-trading-day', 'Thanksgiving');
  assert.strictEqual(a.complete, false);
  assert.match(a.detail, /holiday or weekend/);
});

t('comparabilityOf refuses an incomplete run and explains why', () => {
  const ok = rc.comparabilityOf(run({ date: '2026-09-04', lastCandle: '09/04 15:55', settle: 29546 }));
  assert.strictEqual(ok.ok, true);
  const bad = rc.comparabilityOf(run({ date: '2026-09-04', lastCandle: '09/04 15:20', settleEvent: false }));
  assert.strictEqual(bad.ok, false);
  assert.match(bad.reason, /never settled/);
});

t('handles a record with no date or no candles without throwing', () => {
  assert.strictEqual(rc.assessRun({}).complete, false);
  assert.strictEqual(rc.assessRun({ tradeDate: '2026-09-04', state: {}, events: [] }).status, 'unsettled');
  assert.doesNotThrow(() => rc.assessRun(null));
});

console.log(`\n${passed} passed\n`);
