'use strict';
// US equity market calendar: holidays and 1:00 PM early closes.
// Two kinds of check here, and both matter:
//   1. KNOWN DATES — hand-verified NYSE closures/half-days across several years, including every awkward
//      weekend-observance case. These pin the RULES.
//   2. OBSERVED DATA — the NDX capture sets. A day the calendar calls closed must have no bars, and a day
//      with bars must not be called closed. This checks the rules against reality rather than against me.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const cal = require('../../shared/market-calendar.js');

let passed = 0;
const t = (name, fn) => { try { fn(); console.log('  ✓ ' + name); passed++; } catch (e) { console.log('  ✗ ' + name + '\n     ' + e.message); process.exitCode = 1; } };

console.log('\nmarket-calendar');

t('fixed holidays', () => {
  assert.ok(cal.isHoliday('2026-01-01'), "New Year's 2026 (Thu)");
  assert.ok(cal.isHoliday('2026-07-03'), 'July 4 2026 is a Saturday -> observed Friday the 3rd');
  assert.ok(cal.isHoliday('2026-12-25'), 'Christmas 2026 (Fri)');
  assert.ok(cal.isHoliday('2025-06-19'), 'Juneteenth 2025 (Thu)');
  assert.ok(cal.isHoliday('2022-06-20'), 'Juneteenth 2022 fell Sunday -> observed Monday');
  assert.ok(!cal.isHoliday('2021-06-18'), 'Juneteenth was not yet a market holiday in 2021');
});

t("New Year's on a Saturday is NOT observed on the preceding Friday", () => {
  // The one place the generic weekend rule does not apply: NYSE traded Friday 2021-12-31.
  assert.ok(!cal.isHoliday('2021-12-31'), 'Dec 31 2021 was a full trading day');
  assert.ok(cal.isTradingDay('2021-12-31'));
  assert.ok(!cal.isHoliday('2022-01-01'), 'Jan 1 2022 was a Saturday — not a session at all');
});

t('floating holidays', () => {
  assert.ok(cal.isHoliday('2026-01-19'), 'MLK 2026 — 3rd Monday of January');
  assert.ok(cal.isHoliday('2026-02-16'), "Washington's Birthday 2026 — 3rd Monday of February");
  assert.ok(cal.isHoliday('2026-05-25'), 'Memorial Day 2026 — last Monday of May');
  assert.ok(cal.isHoliday('2026-09-07'), 'Labor Day 2026 — 1st Monday of September');
  assert.ok(cal.isHoliday('2026-11-26'), 'Thanksgiving 2026 — 4th Thursday of November');
});

t('Good Friday (the moveable one)', () => {
  assert.ok(cal.isHoliday('2026-04-03'), 'Good Friday 2026 (Easter Apr 5)');
  assert.ok(cal.isHoliday('2025-04-18'), 'Good Friday 2025 (Easter Apr 20)');
  assert.ok(cal.isHoliday('2024-03-29'), 'Good Friday 2024 (Easter Mar 31)');
  assert.ok(cal.isHoliday('2023-04-07'), 'Good Friday 2023 (Easter Apr 9)');
});

t('day after Thanksgiving is always a half day', () => {
  for (const [thx, fri] of [['2026-11-26', '2026-11-27'], ['2025-11-27', '2025-11-28'], ['2024-11-28', '2024-11-29'], ['2023-11-23', '2023-11-24']]) {
    assert.ok(cal.isHoliday(thx), thx + ' Thanksgiving');
    assert.ok(cal.isEarlyClose(fri), fri + ' should be a 1pm close');
    assert.strictEqual(cal.sessionCloseMinutes(fri), 13 * 60);
  }
});

t('July 3 is a half day only when the 4th is itself a trading day', () => {
  assert.ok(cal.isEarlyClose('2025-07-03'), 'July 4 2025 was a Friday -> Thu the 3rd is early');
  assert.ok(cal.isEarlyClose('2024-07-03'), 'July 4 2024 was a Thursday -> Wed the 3rd is early');
  assert.ok(cal.isEarlyClose('2023-07-03'), 'July 4 2023 was a Tuesday -> Mon the 3rd is early');
  assert.ok(!cal.isEarlyClose('2022-07-01'), 'July 4 2022 was a Monday -> no half day the Friday before');
  assert.ok(!cal.isEarlyClose('2026-07-03'), 'July 4 2026 is a Saturday -> the 3rd is the HOLIDAY, not a half day');
  assert.strictEqual(cal.sessionCloseMinutes('2026-07-03'), null, 'and it is not a session at all');
});

t('Christmas Eve is a half day Mon-Thu, and closed when it IS the observed holiday', () => {
  assert.ok(cal.isEarlyClose('2026-12-24'), 'Dec 24 2026 is a Thursday');
  assert.ok(cal.isEarlyClose('2025-12-24'), 'Dec 24 2025 is a Wednesday');
  assert.ok(cal.isEarlyClose('2024-12-24'), 'Dec 24 2024 is a Tuesday');
  // Dec 25 2021 was a Saturday, so Christmas was observed Friday Dec 24 — market CLOSED, not early.
  assert.ok(cal.isHoliday('2021-12-24'), 'Dec 24 2021 was the observed Christmas holiday');
  assert.ok(!cal.isEarlyClose('2021-12-24'), 'a closed day is not an early close');
  assert.ok(!cal.isEarlyClose('2023-12-24'), 'Dec 24 2023 was a Sunday');
});

t('session close minutes: 16:00 normally, 13:00 on a half day, null when shut', () => {
  assert.strictEqual(cal.sessionCloseMinutes('2026-09-04'), 960, 'a normal Friday');
  assert.strictEqual(cal.lastActionMinutes('2026-09-04'), 955, '15:55');
  assert.strictEqual(cal.sessionCloseMinutes('2026-11-27'), 780, 'half day');
  assert.strictEqual(cal.lastActionMinutes('2026-11-27'), 775, '12:55');
  assert.strictEqual(cal.sessionCloseMinutes('2026-09-05'), null, 'Saturday');
  assert.strictEqual(cal.sessionCloseMinutes('2026-09-07'), null, 'Labor Day');
});

t('a holiday and a weekend are distinct: a weekend is not "a holiday"', () => {
  assert.ok(!cal.isHoliday('2026-09-05'), 'Saturday is not a holiday, it is not a session');
  assert.ok(!cal.isTradingDay('2026-09-05'));
});

// --- checked against the real captures ------------------------------------------------------------
// The NDX sets follow the equity calendar (unlike the NQ set, which is FUTURES — NQ trades through
// equity holidays and Sunday evenings, so it cannot validate this calendar).
t('agrees with the NDX captures: no day with real bars is called closed', () => {
  const roots = ['backtest-data-5m-janapr', 'backtest-data-5m-v2', 'backtest-data-5m-nq-ndx'];
  let checked = 0;
  for (const dir of roots) {
    const p = path.join(__dirname, '..', 'backtest', dir);
    if (!fs.existsSync(p)) continue;
    for (const f of fs.readdirSync(p)) {
      const m = /(\d{4}-\d{2}-\d{2})/.exec(f);
      if (!m) continue;
      checked++;
      assert.ok(cal.isTradingDay(m[1]), `${dir}/${f} has bars but the calendar calls ${m[1]} closed`);
    }
  }
  assert.ok(checked > 100, `expected to check a real number of days, got ${checked}`);
});

console.log(`\n${passed} passed\n`);
