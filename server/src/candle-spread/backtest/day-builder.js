'use strict';
/**
 * day-builder.js — build ONE trading day's dual bars ON DEMAND, from Schwab, with no pre-built dataset.
 *
 * WHY: the backtest overlay used to require a dataset file that was built locally (build-dual-dataset.js)
 * and committed. Any day not in that build simply had no backtest — which is every day since the last
 * manual rebuild, i.e. exactly the recent days you look at while debugging. The deployed server had it
 * worse: only server/ ships, so it had no datasets at all and the overlay was local-only.
 *
 * This builds the same thing the dataset holds, for a single date, from the 1m history Schwab already
 * serves. It is the SAME split the live engine trades and build-dual-dataset.js encodes:
 *     SIGNALS  from /NQ over the full 24h session (bands must carry the overnight)
 *     PRICING  from cash NDX (the options settle on NDX)
 * so a bar is { datetime, analysis: <NQ multi-TF>, px: { open, high, low, close } <NDX> }.
 *
 * WARMUP IS NOT OPTIONAL. BB(20)/EMA(9) on the 60m timeframe need ~20 hours of prior bars before the
 * first bar of the target day is "warm", and analysis-builder drops un-warm bars silently — ask for one
 * calendar day and you get an EMPTY day that looks like "no data" rather than an error. So the NQ fetch
 * reaches back WARMUP_DAYS before the date and the result is sliced to the target session afterwards.
 *
 * LIMIT: Schwab serves 1m history ~48 days back. Older dates cannot be built at all and must come from a
 * pre-built dataset. The caller decides that order; this module only builds.
 */
const AB = require('../analysis-builder');

const MS_DAY = 86400000;
const WARMUP_DAYS = 5;          // calendar days of NQ history before the date (covers weekends/holidays)
const STEP_MIN = 5;             // engine cadence

// ET calendar day for an epoch — the same convention the datasets and run records use.
const etDay = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

/**
 * @param date       'YYYY-MM-DD' (ET)
 * @param priceHistory  async (apiSymbol, {frequencyType,frequency,startDate,endDate}) -> { candles: [...] }
 *                      Injected so this module stays free of SDK wiring and is testable offline — the
 *                      server passes its MarketApiClient's method, a test passes a stub.
 * @returns { date, bars } in the shape load5mDays produces, or null when the day has no NDX session.
 */
async function buildDualDay(date, priceHistory, opts) {
  const o = opts || {};
  const step = o.stepMin || STEP_MIN;
  const warmDays = o.warmupDays != null ? o.warmupDays : WARMUP_DAYS;
  const dayStart = Date.parse(`${date}T00:00:00-05:00`);       // ET-ish; the slice below is by ET day anyway
  if (!Number.isFinite(dayStart)) { const e = new Error(`bad date ${date}`); e.code = 'BAD_DATE'; throw e; }
  const endDate = dayStart + MS_DAY;
  const startNq = dayStart - warmDays * MS_DAY;

  const fetch1m = async (sym, from, to) => {
    const r = await priceHistory(sym, { frequencyType: 'minute', frequency: 1, startDate: from, endDate: to });
    return ((r && r.candles) || []).filter((c) => c && c.datetime != null && c.close != null);
  };

  // /NQ carries the leading slash so Schwab returns the FULL 24h Globex session. Without it the signal
  // bands lose their overnight component and stop matching the live engine — the whole point of the split.
  const [nqRaw, ndxRaw] = await Promise.all([
    fetch1m('/NQ', startNq, endDate),
    fetch1m('$NDX', dayStart, endDate),
  ]);
  if (!ndxRaw.length) return null;                              // no cash session → not a trading day

  // Analysis over the WHOLE window (warmup included), then keep only the target day's bars.
  const allBars = AB.buildBars(nqRaw, step);
  const dayBars = allBars.filter((b) => etDay(b.datetime) === date);
  if (!dayBars.length) return null;

  // NDX price per bar: the 1m candle whose step-bucket this bar closes. Bars with no NDX print (pre-open
  // or a data gap) carry px:null and runDay5m falls back to the signal series for them, exactly as a
  // dataset-built bar with a missing px would.
  const stepMs = step * 60000;
  const byBucket = new Map();
  for (const c of ndxRaw) {
    const T = Math.floor(c.datetime / stepMs) * stepMs + stepMs;
    const cur = byBucket.get(T);
    if (!cur) byBucket.set(T, { open: c.open, high: c.high, low: c.low, close: c.close });
    else { cur.high = Math.max(cur.high, c.high); cur.low = Math.min(cur.low, c.low); cur.close = c.close; }
  }
  // ANCHOR ON THE NDX BARS, not the NQ ones. build-dual-dataset.js iterates the NDX 5m series, so a
  // dataset day holds only bars where cash NDX actually printed — RTH. Keeping every 24h NQ bar instead
  // produced 276 bars against the dataset's 77: harmless for decisions (rthActionOnly gates those) but it
  // moved `settle`, which is read off the last bar. Matching the dataset's window keeps an on-demand day
  // bit-comparable with the committed baselines.
  const bars = dayBars
    .filter((b) => byBucket.has(b.datetime))
    .map((b) => ({
      dt: b.datetime,
      analysis: b.analysis,
      px: byBucket.get(b.datetime),
      fifteen: new Date(b.datetime).getMinutes() % 15 === 0,
    }));
  if (!bars.length) return null;
  return { date, bars };
}

module.exports = { buildDualDay, etDay, WARMUP_DAYS };
