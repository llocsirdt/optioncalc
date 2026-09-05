// US equity market calendar (NYSE / Nasdaq) — holidays and 1:00 PM early closes.
//
// WHY RULES, NOT A LIST: a hardcoded table of dates silently expires. Every US market holiday is
// computable from the date itself, so this stays correct for any year, including the backtest history
// (2022-) and years we have not traded yet. The rules below are validated against the actual captured
// data in tests/unit/market-calendar.test.js — the days our own datasets have no bars for ARE the
// holidays, so the calendar is checked against observed reality rather than trusted on its own.
//
// Everything here works in ET wall-clock DATES ('YYYY-MM-DD'), never timestamps: a session belongs to a
// calendar day in New York, and converting through UTC is how off-by-one-day bugs get in.
(function (root) {
  'use strict';

  const CLOSE_NORMAL = 16 * 60;   // 16:00 ET
  const CLOSE_EARLY = 13 * 60;    // 13:00 ET — the standard half-day close

  // --- date helpers (pure Y/M/D arithmetic, no timezone conversion) ---------------------------------
  function parse(dateISO) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateISO || '').trim());
    if (!m) return null;
    return { y: +m[1], mo: +m[2], d: +m[3] };
  }
  const iso = (y, mo, d) => `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  // Day of week without timezone risk: build the date in UTC and read its UTC day.
  const dow = (y, mo, d) => new Date(Date.UTC(y, mo - 1, d)).getUTCDay();   // 0=Sun .. 6=Sat
  const isWeekend = (y, mo, d) => { const w = dow(y, mo, d); return w === 0 || w === 6; };

  // nth given weekday of a month (n = 1..5), e.g. nthDow(2026, 11, 4, 4) = 4th Thursday of November.
  function nthDow(y, mo, weekday, n) {
    const first = dow(y, mo, 1);
    return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
  }
  function lastDow(y, mo, weekday) {
    const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();   // days in month
    return days - ((dow(y, mo, days) - weekday + 7) % 7);
  }

  // A fixed-date holiday moves when it lands on a weekend: Saturday -> observed the Friday before,
  // Sunday -> the Monday after. (NYSE does not observe Jan 1 on the preceding Dec 31, so New Year's is
  // handled with that exception below.)
  function observed(y, mo, d) {
    const w = dow(y, mo, d);
    if (w === 6) return { y, mo, d: d - 1 };   // Sat -> Fri
    if (w === 0) return { y, mo, d: d + 1 };   // Sun -> Mon
    return { y, mo, d };
  }

  // Anonymous Gregorian computus — Easter Sunday, for Good Friday (the one moveable market holiday).
  function easter(y) {
    const a = y % 19, b = Math.floor(y / 100), c = y % 100;
    const dd = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - dd - g + 15) % 30;
    const i = Math.floor(c / 4), k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const mo = Math.floor((h + l - 7 * m + 114) / 31);
    const d = ((h + l - 7 * m + 114) % 31) + 1;
    return { y, mo, d };
  }
  function addDays(y, mo, d, n) {
    const t = new Date(Date.UTC(y, mo - 1, d + n));
    return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
  }

  // --- the calendar ---------------------------------------------------------------------------------
  // Full closures for a given year, as a Set of 'YYYY-MM-DD'.
  function holidaysFor(y) {
    const out = new Set();
    const add = (o) => out.add(iso(o.y, o.mo, o.d));

    // New Year's Day. Sunday -> observed Monday Jan 2. Saturday -> NOT observed (the market is open the
    // preceding Friday, Dec 31) — the one place the generic weekend rule does not apply.
    const nyDow = dow(y, 1, 1);
    if (nyDow === 0) add({ y, mo: 1, d: 2 });
    else if (nyDow !== 6) add({ y, mo: 1, d: 1 });

    add({ y, mo: 1, d: nthDow(y, 1, 1, 3) });        // MLK — 3rd Monday of January
    add({ y, mo: 2, d: nthDow(y, 2, 1, 3) });        // Washington's Birthday — 3rd Monday of February
    const e = easter(y);
    add(addDays(e.y, e.mo, e.d, -2));                 // Good Friday
    add({ y, mo: 5, d: lastDow(y, 5, 1) });           // Memorial Day — last Monday of May
    if (y >= 2022) add(observed(y, 6, 19));           // Juneteenth — a market holiday from 2022
    add(observed(y, 7, 4));                           // Independence Day
    add({ y, mo: 9, d: nthDow(y, 9, 1, 1) });         // Labor Day — 1st Monday of September
    add({ y, mo: 11, d: nthDow(y, 11, 4, 4) });       // Thanksgiving — 4th Thursday of November
    add(observed(y, 12, 25));                         // Christmas
    return out;
  }

  const holidayCache = new Map();
  function holidaySet(y) {
    if (!holidayCache.has(y)) holidayCache.set(y, holidaysFor(y));
    return holidayCache.get(y);
  }

  function isHoliday(dateISO) {
    const p = parse(dateISO);
    if (!p) return false;
    if (isWeekend(p.y, p.mo, p.d)) return false;   // a weekend is not "a holiday", it is not a session
    return holidaySet(p.y).has(dateISO);
  }

  // 1:00 PM closes. All three are "the session before a holiday", but each has its own wrinkle, and the
  // wrinkle is always "unless that day is itself the holiday or a weekend".
  function isEarlyClose(dateISO) {
    const p = parse(dateISO);
    if (!p) return false;
    if (isWeekend(p.y, p.mo, p.d) || holidaySet(p.y).has(dateISO)) return false;
    const { y, mo, d } = p;

    // Day after Thanksgiving — always a half day.
    if (mo === 11 && d === nthDow(y, 11, 4, 4) + 1) return true;

    // July 3, but only when the 4th is itself a trading day (Tue-Fri). If the 4th is a Monday the
    // preceding Friday is a full session; if it is a weekend the holiday moves and there is no half day.
    if (mo === 7 && d === 3) {
      const w4 = dow(y, 7, 4);
      return w4 >= 2 && w4 <= 5;
    }

    // Christmas Eve, Mon-Thu. When Dec 24 is a Friday, Christmas falls on Saturday and is OBSERVED on
    // the 24th — the market is closed, not early, so the holiday check above already returned false.
    if (mo === 12 && d === 24) {
      const w = dow(y, 12, 24);
      return w >= 1 && w <= 4;
    }
    return false;
  }

  // Is this calendar date a trading session at all?
  function isTradingDay(dateISO) {
    const p = parse(dateISO);
    if (!p) return false;
    return !isWeekend(p.y, p.mo, p.d) && !holidaySet(p.y).has(dateISO);
  }

  // Minutes-from-midnight ET at which the session closes: 960 normally, 780 on a half day, null if the
  // market is shut. THIS is the number every completeness check should compare against — never a
  // hardcoded 16:00, which is what makes half days look like truncated data.
  function sessionCloseMinutes(dateISO) {
    if (!isTradingDay(dateISO)) return null;
    return isEarlyClose(dateISO) ? CLOSE_EARLY : CLOSE_NORMAL;
  }

  // The last 5-minute action bar before the close (15:55 normally, 12:55 on a half day).
  function lastActionMinutes(dateISO) {
    const close = sessionCloseMinutes(dateISO);
    return close == null ? null : close - 5;
  }

  const api = {
    CLOSE_NORMAL, CLOSE_EARLY,
    isHoliday, isEarlyClose, isTradingDay, sessionCloseMinutes, lastActionMinutes, holidaysFor,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof root !== 'undefined') root.MarketCalendar = api;
})(typeof window !== 'undefined' ? window : this);
