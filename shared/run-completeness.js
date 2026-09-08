// Is a candle-spread RUN a complete trading day, or a partial one?
//
// WHY THIS EXISTS: a run truncated mid-session looks exactly like a finished one. Both render as a book
// with positions and a P&L; nothing on the surface says "this stopped at 15:45 and the last 15 minutes of
// the day are missing". That is how a local run that died at 15:45 got read as the closing price — the
// number was real, it just was not the close. Worse, a partial live day graded against a full-day backtest
// average is comparing 6 hours to 6.5 and calling the difference performance.
//
// THE AUTHORITATIVE SIGNAL IS THE SETTLEMENT EVENT, not a clock time. The engine settles at the close, so
// a settled run is complete whether that close was 16:00 or a half day's 13:00 — which is exactly why half
// days need no special case here. The clock is only used to describe HOW incomplete an unsettled run is,
// and there it consults the market calendar so a 13:00 finish on Black Friday is not called short.
(function (root) {
  'use strict';

  const cal = (typeof require === 'function' && typeof module !== 'undefined' && module.exports)
    ? require('./market-calendar.js')
    : (typeof root !== 'undefined' ? root.MarketCalendar : null);

  // "MM/DD HH:MM" (the run's own candle-time format) -> minutes from ET midnight.
  function candleTimeMinutes(s) {
    const m = /(\d{1,2}):(\d{2})\s*$/.exec(String(s || ''));
    return m ? (+m[1]) * 60 + (+m[2]) : null;
  }
  const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

  // Where the wall clock is, in Eastern time. Needed to tell "this run has not settled YET" from "this run
  // never settled" — the two look identical in the record and mean opposite things.
  function etNow(nowMs) {
    const d = new Date(nowMs == null ? Date.now() : nowMs);
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(d).map((x) => [x.type, x.value]));
    let h = parseInt(p.hour, 10); if (h === 24) h = 0;
    return { dateISO: `${p.year}-${p.month}-${p.day}`, minutes: h * 60 + parseInt(p.minute, 10) };
  }

  // Grace after the close for the settlement event to actually land. Until it elapses a run on today's
  // date is still "in progress" rather than a failure — settlement is a scheduled job, not instantaneous.
  const SETTLE_GRACE_MIN = 10;

  // record: a run record from the runs store. Returns:
  //   { complete, status, settled, settleSource, lastCandle, lastCandleMin, expectedCloseMin,
  //     shortfallMin, earlyClose, tradingDay, label, detail }
  // status: 'settled' | 'unsettled' | 'no-settle-price' | 'not-a-trading-day' | 'unknown-date'
  function assessRun(record, nowMs) {
    const rec = (record && (record.record || record)) || {};
    const state = rec.state || {};
    const events = rec.events || [];
    const dateISO = rec.tradeDate || null;

    const settleEvent = [...events].reverse().find((e) => e.type === 'eod_settlement') || null;
    // A settlement that could not price anything is NOT a complete day — it recorded that it gave up.
    const priced = !!(settleEvent && settleEvent.settle != null);

    const lastCandle = state.lastCandleTime || null;
    const lastCandleMin = candleTimeMinutes(lastCandle);
    const expectedCloseMin = (cal && dateISO) ? cal.sessionCloseMinutes(dateISO) : null;
    const earlyClose = !!(cal && dateISO && cal.isEarlyClose(dateISO));
    const tradingDay = !!(cal && dateISO && cal.isTradingDay(dateISO));

    // How much of the session is missing. Measured to the LAST ACTION BAR (close − 5m), because the engine
    // never trades the closing bar itself — comparing to the close would report every healthy run as 5
    // minutes short.
    let shortfallMin = null;
    if (lastCandleMin != null && expectedCloseMin != null) {
      shortfallMin = Math.max(0, (expectedCloseMin - 5) - lastCandleMin);
    }

    // IS THE SESSION STILL RUNNING? A run for today, before the close (plus a grace for the settlement job
    // to land), has not settled YET — which is nothing like a run that never settled. Reporting the two the
    // same way meant the compare screen showed a red "never settled" warning through every live session,
    // for the entirely normal reason that the day was not over.
    const now = etNow(nowMs);
    const inSession = !!(dateISO && dateISO === now.dateISO && tradingDay
      && expectedCloseMin != null && now.minutes < expectedCloseMin + SETTLE_GRACE_MIN);

    let status, complete;
    if (dateISO && cal && !tradingDay) { status = 'not-a-trading-day'; complete = false; }
    else if (!dateISO) { status = 'unknown-date'; complete = priced; }
    else if (priced) { status = 'settled'; complete = true; }
    else if (settleEvent) { status = 'no-settle-price'; complete = false; }
    else if (inSession) { status = 'in-progress'; complete = false; }
    else { status = 'unsettled'; complete = false; }

    const closeLabel = expectedCloseMin != null ? hhmm(expectedCloseMin) : '?';
    let label, detail;
    if (status === 'settled') {
      label = earlyClose ? 'settled (half day)' : 'settled';
      detail = `settled at the ${closeLabel} close${settleEvent.settleSource ? ` (${settleEvent.settleSource})` : ''}`;
    } else if (status === 'not-a-trading-day') {
      label = 'not a trading day';
      detail = `${dateISO} is a market holiday or weekend — this run should not exist`;
    } else if (status === 'no-settle-price') {
      label = 'no settle price';
      detail = 'settlement ran but could not price the book, so the terminal P&L is not trustworthy';
    } else if (status === 'in-progress') {
      // NOT a warning. complete stays false so grading is still suppressed — a partial day compared with a
      // full-day backtest average still charges the missing hours to the strategy — but the reason is
      // "the day is not over", and the UI must be able to say that instead of crying failure.
      label = 'in progress';
      detail = `session is still open — settles at the ${closeLabel} close`
        + (lastCandle ? `; last candle ${lastCandle}` : '');
    } else {
      label = 'INCOMPLETE';
      detail = lastCandle
        ? `stopped at ${lastCandle} — never settled${shortfallMin ? `, missing the last ${shortfallMin} min to the ${closeLabel} close` : ''}`
        : 'never settled and recorded no candles';
    }
    return {
      complete, status, settled: priced,
      settleSource: settleEvent ? (settleEvent.settleSource || null) : null,
      lastCandle, lastCandleMin, expectedCloseMin, shortfallMin, earlyClose, tradingDay,
      inSession, date: dateISO, label, detail,
    };
  }

  // Guard for anything that GRADES a live day (against a backtest baseline, another variant, itself over
  // time). Returns { ok, reason } — callers should refuse, or clearly mark, when ok is false. Comparing a
  // truncated day to a full-day figure attributes missing hours to strategy performance.
  function comparabilityOf(record, nowMs) {
    const a = assessRun(record, nowMs);
    if (a.complete) return { ok: true, assessment: a };
    // `pending` separates "cannot be graded yet" from "cannot be graded at all". Both suppress grading;
    // only the second is a problem worth flagging.
    return { ok: false, pending: a.status === 'in-progress', reason: a.detail, assessment: a };
  }

  const api = { assessRun, comparabilityOf, candleTimeMinutes, etNow, SETTLE_GRACE_MIN };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof root !== 'undefined') root.RunCompleteness = api;
})(typeof window !== 'undefined' ? window : this);
