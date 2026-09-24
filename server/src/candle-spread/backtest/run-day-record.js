'use strict';
/**
 * run-day-record.js — run the BACKTEST for one (date, variant) and hand back the result as a run record
 * in the LIVE record shape.
 *
 * WHY THIS EXISTS: the debug page already knows how to read a live run record — positions → order rows,
 * candle_close events → the time index, eod_settlement → the risk curve. Emitting the backtest in that
 * same shape means the live-vs-backtest comparison needs NO new curve or table logic; the backtest is
 * simply a second record fed through the code that already works. (backtest-replay.js makes the same
 * argument for the compare page, but it writes a whole-day bundle for every variant to disk — far too
 * heavy for "show me this one variant, now, while I'm staring at the live run".)
 *
 * The opts mapping is copied from reconcile-day.js DELIBERATELY, not re-derived: reconcile-day is the
 * reference for "run the backtest the way the live engine is configured", and two mappings that drift
 * would make the comparison lie. Note the ALIAS it documents — live's capitalRecapture is the backtest's
 * recaptureAlternate.
 *
 *   const { runDayRecord } = require('./run-day-record');
 *   const { record, model, dataDir } = runDayRecord({ date: '2026-09-09', variant: 'v6-20' });
 *
 * Throws Error with .code = 'BAD_DATE' | 'NO_DATASET' | 'NO_VARIANT' so a caller can pick a status code.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { runDay5m, load5mDays } = require('./backtest-v6-5m');
const { makeGeo, makeAdaptiveGeo } = require('./backtest-width');
const { buildRuns } = require('../index');
const VC = require('../variant-contract');
const { buildDualDay } = require('./day-builder');
const { optsFor: buildOpts } = require('./opts-for');

// Same preference order as reconcile-day: the DUAL set (signals /NQ, pricing cash NDX) IS the live model.
// The NQ-priced history is a fallback that answers a different question, so the model string says so and
// the caller is expected to surface it.
const DIRS = [
  { dir: path.join(__dirname, '..', '..', '..', '..', 'tests', 'backtest', 'backtest-data-5m-nq-ndx'), model: 'dual (NQ signal / NDX pricing)' },
  { dir: path.join(__dirname, '..', '..', '..', '..', 'tests', 'backtest', 'backtest-data-5m-nq'), model: 'NQ-priced (NOT the live model)' },
];

// load5mDays re-reads and re-parses the WHOLE directory (922 days in the NQ set). This module is called
// from an HTTP handler, so the parsed days are cached per directory for the life of the process — the 5m
// datasets are static files, they do not change under a running server.
const _daysCache = new Map();
function daysIn(dir) {
  if (!_daysCache.has(dir)) {
    // The deployed server ships only server/, so these dataset dirs do not exist there at all. A missing
    // directory is the NORMAL prod case, not an error — return empty and let the on-demand builder answer.
    try { _daysCache.set(dir, load5mDays(dir)); }
    catch (e) { _daysCache.set(dir, []); }
  }
  return _daysCache.get(dir);
}

// ON-DEMAND CACHE. A built day is ~51KB and Schwab only serves the 1m history it is built from ~48 days
// back, so the cache can never exceed ~2.4MB no matter how long it runs — no time-based purge is needed,
// just a cap that keeps the regenerable window. Bars are cached, NOT finished run records: the bars are
// the expensive part (two Schwab fetches + indicator warmup) and they are shared by all 80 variants, so
// switching variant on a date already built costs nothing.
const CACHE_DIR = process.env.CANDLE_BACKTEST_CACHE_DIR
  || (fs.existsSync('/var/optioncalc-data') ? '/var/optioncalc-data/backtest-days' : path.join(os.tmpdir(), 'backtest-days'));
const CACHE_MAX = Number(process.env.CANDLE_BACKTEST_CACHE_MAX || 60);
const cacheFile = (date) => path.join(CACHE_DIR, `dual-${date}.json`);


// IS THIS DAY FINISHED? A complete RTH session's last 5m bar closes at 15:55 ET (minute 955) — the same
// LAST_ACTION_MIN the live engine uses. Anything short of that is a session still in progress.
//
// This exists because an on-demand build was cached UNCONDITIONALLY. Ask for a date's backtest while its
// market is still open and buildDualDay returns however many 1m bars exist so far; writeCachedDay then
// froze that stump permanently and every later request got it. Caught 2026-09-23: the cached day ran
// 09:35 to 09:55 — five bars — so the backtest "traded" 2 positions against the live run's 21, and the
// compare overlay drew that as the day the candles implied. 09-21 was caught the same way at 23 bars.
// 09-18 and 09-22, first requested after their closes, are complete at 77.
const LAST_ACTION_MIN = 15 * 60 + 55;
function etMinuteOf(ms) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit',
    minute: '2-digit', hour12: false }).formatToParts(new Date(ms));
  const h = +(p.find((x) => x.type === 'hour') || {}).value;
  const m = +(p.find((x) => x.type === 'minute') || {}).value;
  return h * 60 + m;
}
function dayIsComplete(day) {
  const bars = (day && day.bars) || [];
  if (!bars.length) return false;
  const last = bars[bars.length - 1];
  const t = last && (last.dt != null ? last.dt : last.datetime);
  return Number.isFinite(t) && etMinuteOf(t) >= LAST_ACTION_MIN;
}
// Today in ET, so a partial cache for a PAST date can be thrown away and rebuilt while today's stays
// usable (rebuilding it every request would hammer Schwab for a day that is still moving anyway).
function etToday(nowMs) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(nowMs == null ? Date.now() : nowMs));
}

// The bar interval this dataset was built at, read off the data rather than assumed.
function barStepMin(bars) {
  if (!bars || bars.length < 2) return 5;
  const t = (b) => (b && (b.dt != null ? b.dt : b.datetime));
  const d = Math.round((t(bars[bars.length - 1]) - t(bars[bars.length - 2])) / 60000);
  return Number.isFinite(d) && d > 0 && d <= 60 ? d : 5;
}

// IS THIS CACHED DAY AS COMPLETE AS IT COULD BE RIGHT NOW?
//
// The old test was `!dayIsComplete(j) && date < etToday()` — "keep any partial for TODAY, because today is
// still moving and rebuilding every request would hammer Schwab". That reasoning holds only while the
// session is genuinely still moving. It is wrong from 16:00 ET until midnight, and wrong ALL DAY in a
// subtler way: a stump built at 09:55 was served unchanged at 15:00 with 62 bars missing.
//
// Observed on 2026-09-23 at 23:40 ET: the on-demand backtest returned FIVE bars (09:35 -> 09:55) and 3
// positions for a session the live engine ran to 76 bars and 22 positions, because the cache entry written
// at 09:55 that morning was still `date === etToday()` and so still "fresh".
//
// The honest question is whether the tape has moved past the last bar we hold. It has once the next bar
// would have closed, and after the close the yardstick stops at 15:55 so an incomplete day is always stale.
// `nowMs` is injectable so the rule can be tested at a chosen moment of the session rather than only at
// whatever time the suite happens to run.
function cachedDayIsStale(j, date, nowMs) {
  if (dayIsComplete(j)) return false;          // a finished day never goes stale
  const now = nowMs == null ? Date.now() : nowMs;
  const today = etToday(now);
  if (date !== today) return true;             // a past session that never completed, or a future date
  const bars = j.bars || [];
  const last = bars[bars.length - 1];
  const lastT = last && (last.dt != null ? last.dt : last.datetime);
  if (!Number.isFinite(lastT)) return true;
  const lastMin = etMinuteOf(lastT);
  const nowMin = Math.min(etMinuteOf(now), LAST_ACTION_MIN);
  return nowMin >= lastMin + barStepMin(bars);
}

function readCachedDay(date) {
  try {
    const j = JSON.parse(fs.readFileSync(cacheFile(date), 'utf8'));
    if (!j || !Array.isArray(j.bars) || !j.bars.length) return null;
    // A partial cache the tape has moved past is wrong and will stay wrong, so drop it and let the caller
    // rebuild. Self-heals entries already poisoned by the old behaviour without anyone clearing the cache
    // directory by hand.
    if (cachedDayIsStale(j, date)) {
      try { fs.unlinkSync(cacheFile(date)); } catch (e) { /* best effort */ }
      return null;
    }
    return j;
  } catch (e) { /* miss */ }
  return null;
}

function writeCachedDay(day) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cacheFile(day.date), JSON.stringify(day), 'utf8');
    // Evict oldest by DATE (the filename), not mtime: the useful set is "the most recent N sessions",
    // and mtime would keep whichever was browsed last rather than whichever is still regenerable.
    const files = fs.readdirSync(CACHE_DIR).filter((f) => /^dual-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - CACHE_MAX))) {
      try { fs.unlinkSync(path.join(CACHE_DIR, f)); } catch (e) { /* best effort */ }
    }
  } catch (e) { /* a cache write failure must never fail the request */ }
}

// load5mDays labels days M/D/YYYY (ET); the API speaks ISO. Normalise BOTH sides rather than assuming
// either — matching the raw strings silently finds nothing.
function iso(v) {
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
  return m ? `${m[3]}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}` : v;
}

// The variant -> engine-opts mapping is SHARED (see opts-for.js). This file used to carry its own copy,
// which is how the seven fly flags went missing here for two days while the baselines had them: every
// fly-enabled variant answered HTTP 500 on the on-demand endpoint, and before the contract guard existed
// the same omission would have silently run a DIFFERENT strategy than the baselines under the same name.
// recordReplay is genuinely local — it asks the engine to keep positions so a run RECORD can be built,
// and changes no decision the run makes.
function optsFor(v, day) {
  const o = buildOpts(v, {
    intradayIV: true,
    hasPx: !!(day && day.bars && day.bars[0] && day.bars[0].px),
    where: 'run-day-record optsFor',
  });
  o.recordReplay = true;
  return o;
}

// Intrinsic value of one spread at a settlement price, in dollars.
const legsAt = (legs, x, qty) => (legs || []).reduce((a, l) => {
  const intr = l.type === 'C' ? Math.max(0, x - l.strike) : Math.max(0, l.strike - x);
  return a + (l.side === 'long' ? 1 : -1) * intr * 100 * qty;
}, 0);

function findDay(date) {
  for (const cand of DIRS) {
    if (!fs.existsSync(cand.dir)) continue;
    const days = daysIn(cand.dir);
    const d = days.find((x) => iso(x.date) === iso(date));
    if (d) return { ...cand, day: d };
  }
  return null;
}

/**
 * Resolve one day's bars, cheapest source first:
 *   1. a PRE-BUILT dataset day        — instant, and the shipped/committed build stays authoritative
 *   2. a CACHED on-demand build       — instant after the first request for that date
 *   3. a FRESH on-demand build        — two Schwab 1m fetches + indicator warmup, then cached
 * `priceHistory` is injected by the caller; without it only 1 and 2 are possible, which is what a
 * process with no market credentials (or no network) gets.
 */
async function resolveDay(date, priceHistory) {
  const hit = findDay(date);
  if (hit) return hit;
  const cached = readCachedDay(date);
  if (cached) return { dir: CACHE_DIR, model: 'dual (NQ signal / NDX pricing) — built on demand', day: cached, onDemand: true, cached: true };
  if (typeof priceHistory !== 'function') return null;
  const built = await buildDualDay(date, priceHistory);
  if (!built) return null;
  // Only a FINISHED day is worth keeping. A day still in progress is served for this request and thrown
  // away, so the next request after the close rebuilds it whole instead of inheriting a stump forever.
  const complete = dayIsComplete(built);
  if (complete) writeCachedDay(built);
  return { dir: CACHE_DIR, model: 'dual (NQ signal / NDX pricing) — built on demand', day: built,
    onDemand: true, cached: false, partial: !complete };
}

async function runDayRecord({ date, variant, symbol, priceHistory }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) { const e = new Error('date=YYYY-MM-DD required'); e.code = 'BAD_DATE'; throw e; }
  const hit = await resolveDay(date, priceHistory);
  if (!hit) {
    const e = new Error(`No 5m data for ${date} — not in a pre-built dataset, and it could not be built`
      + ` on demand (Schwab serves ~48 days of 1m history; a non-trading day also yields nothing).`);
    e.code = 'NO_DATASET'; e.checked = DIRS.map((d) => path.basename(d.dir)).concat(['on-demand']); throw e;
  }
  const v = buildRuns().find((r) => r.variant === variant);
  if (!v) { const e = new Error(`unknown variant ${variant}`); e.code = 'NO_VARIANT'; throw e; }

  const sym = symbol || v.symbol || 'NDX';
  const fn = (A, p, ctx) => v.signalFn(A, p, { ...ctx, cfg: v.signalCfg || {} });
  const r = runDay5m(hit.day.bars, fn, optsFor(v, hit.day));
  const QTY = 1;

  // POSITIONS in the live record shape. `filled: true` because a backtest position exists only if it was
  // taken. pendingCover is KEPT (backtest-replay drops it) — an unfilled resting cover is exactly what the
  // live-vs-backtest comparison is about, so the fill rate has to be computable the same way on both sides:
  // covered vs (covered + still-pending).
  const positions = (r.positions || []).map((p, i) => {
    const pc = (!p.covered && p.pendingCover) ? p.pendingCover : null;
    return {
      id: `bt-${i}`, side: p.side, legs: p.legs, quantity: QTY, shortStrike: p.shortStrike,
      limit: p.limit, mark: p.limit, filled: true, orderStatus: 'backtest',
      openEpoch: p.openEpoch, openTime: p.openTime,
      covered: !!p.covered, coverLegs: p.coverLegs || null, coverLimit: p.coverLimit != null ? p.coverLimit : null,
      coverStatus: p.covered ? 'filled' : null, coverEpoch: p.coverEpoch || null, coverTime: p.coverTime || null,
      // markAtPlace is absent by design: the engine does not record the cover's mark at placement, and this
      // module does not get to add it (backtest-v6-5m.js is off-limits). The debug page renders "—" there.
      // placedMs is carried through (only the `continuous` trigger stamps it) so the synthesized order-log
      // row below can time the unfilled cover.
      pendingCover: pc ? { legs: pc.legs, target: pc.target, src: pc.src || null, placedMs: pc.placedMs || null } : null,
      hedge: p.hedge || undefined, wing: p.wing || undefined,
    };
  });

  // EVENTS. candle_close drives the page's time index and the time-of-day slider; the synthesized
  // order_simulated rows are what make an UNFILLED cover visible — strategy-positions.js reads unfilled
  // covers from the order log only, so without them a backtest cover that never filled would silently
  // vanish from the orders table instead of standing next to the live one that also never filled.
  const events = (r.replay || []).map((b) => ({
    type: 'candle_close', time: new Date(b.epoch).toISOString(),
    candle: { time: b.time, epoch: b.epoch, close: b.underlying },
    underlying: b.underlying, variant: v.variant,
  }));
  for (const p of positions) {
    if (!p.pendingCover || !p.pendingCover.legs) continue;
    // Placement time: only the `continuous` trigger stamps placedMs, so fall back to the position's open —
    // an unfilled cover is never EARLIER than its open, and a slightly early stamp beats no row at all.
    const ms = p.pendingCover.placedMs || p.openEpoch || null;
    events.push({ type: 'order_simulated', time: ms ? new Date(ms).toISOString() : undefined, variant: v.variant,
      meta: { of: p.id, kind: 'cover', legs: p.pendingCover.legs, net: 'DEBIT', limit: p.pendingCover.target } });
  }
  const settle = r.settle;
  const sePositions = positions.map((p) => ({
    id: p.id, side: p.side,
    pnl: Math.round(legsAt(p.legs, settle, QTY) - (p.limit || 0) * 100 * QTY
      + (p.covered ? legsAt(p.coverLegs, settle, QTY) - (p.coverLimit || 0) * 100 * QTY : 0)),
  }));
  events.push({ type: 'eod_settlement', variant: v.variant, settle, settleSource: 'backtest-dataset',
    terminalPnl: r.terminal, floorPnl: r.floor, positions: sePositions });

  const placed = r.coverBySrc ? Object.values(r.coverBySrc).reduce((a, b) => a + b, 0) : 0;
  const record = {
    runId: `BT_${sym}_${date}_${v.variant}`, tradeDate: date, symbol: sym, variant: v.variant,
    source: 'backtest', dataDir: path.basename(hit.dir), model: hit.model,
    config: { symbol: sym, spreadWidth: v.spreadWidth, spreadShift: v.spreadShift, quantity: QTY,
      variant: v.variant, variantLabel: v.variantLabel, lossTarget: v.lossTarget, lossMax: v.lossMax,
      capFrac: v.capFrac, continuousCoverMinLockFrac: v.continuousCoverMinLockFrac },
    // `placed`/`pending` are the engine's OWN cover counters (every placement over the day, including
    // re-placements), which is what reconcile-day reports. The per-position fill rate the UI shows is a
    // different denominator — both are here so a reader can tell which number they are looking at.
    summary: { terminal: r.terminal, floor: r.floor, opens: r.opens, filled: r.filled, naked: r.naked,
      bestCase: r.bestCase, worstCase: r.worstCase, coversPlaced: placed, coversPending: r.coverPending || 0,
      coverBySrc: r.coverBySrc || null },
    state: { positions, lastUnderlying: settle, realizedPnl: 0 },
    events,
  };
  return { record, model: hit.model, dataDir: path.basename(hit.dir) };
}

// Every ISO date the local 5m datasets can run, newest last. Used to tell the UI "no backtest for that
// day" without paying for a run.
function availableDates() {
  const out = [];
  for (const cand of DIRS) {
    if (!fs.existsSync(cand.dir)) continue;
    for (const d of daysIn(cand.dir)) out.push(iso(d.date));
  }
  return [...new Set(out)].sort();
}

module.exports = { cachedDayIsStale, dayIsComplete, runDayRecord, availableDates, iso };
