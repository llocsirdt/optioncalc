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

function readCachedDay(date) {
  try {
    const j = JSON.parse(fs.readFileSync(cacheFile(date), 'utf8'));
    if (j && Array.isArray(j.bars) && j.bars.length) return j;
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

function optsFor(v, day) {
  const o = { rthActionOnly: true, intradayIV: true };
  if (v.ivSkew) o.ivSkew = true;
  if (v.bidirectional) o.bidirectional = true;
  for (const k of ['riskCap', 'softCap', 'hardCap', 'capitalCeiling', 'proactiveCoverFrac', 'lossTarget', 'lossMax']) if (v[k] != null) o[k] = v[k];
  if (v.exemptTrendStack) o.exemptTrendStack = true;
  if (v.floorOffset) o.floorOffset = true;
  if (v.continuousCover) o.continuousCover = true;
  if (v.continuousCoverMinLockFrac != null) o.continuousCoverMinLockFrac = v.continuousCoverMinLockFrac;
  if (v.lockCoverMode) o.lockCoverMode = v.lockCoverMode;
  if (v.coverGeometry) o.coverGeometry = v.coverGeometry;
  if (v.continuousCoverArmFrac != null) o.continuousCoverArmFrac = v.continuousCoverArmFrac;
  if (v.continuousCoverOppRatio != null) o.continuousCoverOppRatio = v.continuousCoverOppRatio;
  if (v.coverSelector) o.coverSelector = v.coverSelector;
  if (v.openNeverOtm) o.openNeverOtm = true;
  if (v.coverToStack) { o.coverToStack = true; o.coverToStackVsRisk = true; if (v.coverToStackMinFrac != null) o.coverToStackMinFrac = v.coverToStackMinFrac; }
  // NOTE the ALIAS: live calls this capitalRecapture, the backtest recaptureAlternate. Same feature.
  if (v.capitalRecapture) { o.recaptureAlternate = true; if (v.openAlternateEvery != null) o.openAlternateEvery = v.openAlternateEvery; if (v.creditCoverFrac != null) o.creditCoverFrac = v.creditCoverFrac; }
  if (v.enforceLegUniqueness) { o.enforceLegUniqueness = true; if (v.legMaxShift != null) o.legMaxShift = v.legMaxShift; if (v.legMaxWing != null) o.legMaxWing = v.legMaxWing; }
  if (v.wingConvert) { o.wingConvert = true; for (const k of ['wingMinRatio', 'wingAfterMin', 'wingBudgetFrac', 'wingNaked', 'wingUpsideLambda', 'wingOutSteps', 'wingMaxWings', 'wingQty', 'wingStep', 'wingBandSig']) if (v[k] != null) o[k] = v[k]; }
  o.geo = v.adaptiveGeo
    ? makeAdaptiveGeo({ width: v.spreadWidth || 20, incr: 10, maxDebitFrac: v.capFrac != null ? v.capFrac : 0.65, maxItmStrikes: v.maxItmStrikes != null ? v.maxItmStrikes : 3 })
    : makeGeo({ width: v.spreadWidth || 20, shift: v.spreadShift || 0, capFrac: v.capFrac != null ? v.capFrac : undefined });
  // FOUNDATIONAL: signals from /NQ, pricing and settlement from cash NDX. Without priceOf the engine
  // silently prices off the SIGNAL series — the quiet way to violate the rule.
  const hasPx = !!(day.bars && day.bars[0] && day.bars[0].px);
  if (hasPx) o.priceOf = (b) => b.px || { close: b.analysis['5m'].close, high: b.analysis['5m'].high, low: b.analysis['5m'].low };
  // recordReplay is what makes the engine hand back its positions and the RTH bar series — i.e. the two
  // things a run RECORD is made of. It does not change any decision the run makes.
  o.recordReplay = true;
  VC.assertForwarded(v, Object.keys(o), 'run-day-record optsFor',
    ['capitalRecapture', 'openAlternateEvery', 'creditCoverFrac', 'coverToStackMinFrac']);
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
  writeCachedDay(built);
  return { dir: CACHE_DIR, model: 'dual (NQ signal / NDX pricing) — built on demand', day: built, onDemand: true, cached: false };
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

module.exports = { runDayRecord, availableDates, iso };
