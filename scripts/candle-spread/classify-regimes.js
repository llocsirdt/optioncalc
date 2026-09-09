#!/usr/bin/env node
'use strict';
/**
 * START-OF-DAY REGIME CLASSIFIER — "which variant should I run TODAY?"
 *
 * The question this answers is a SELECTION question, not a description question. We already know the
 * per-variant averages over the whole history (backtest-baselines.json); what we do not know is whether
 * the market tells us anything AT 09:30 about which variant to point at the day. So every feature here
 * is computed from information that exists BEFORE the first RTH bar closes:
 *
 *   NO-LOOKAHEAD CONTRACT (the whole exercise is worthless without it)
 *   - Prior-day features use RTH bars from days strictly BEFORE the classified day.
 *   - Daily BB(20,2)/EMA9 are computed on the daily series and then READ AT INDEX i-1 — the bands as of
 *     yesterday's close, which is what you actually have in hand at 09:30.
 *   - Premarket features use bars with ET minute < 570 on the classified day (the /NQ 24h feed makes the
 *     overnight session available; this is real, tradeable-time information).
 *   - The open feature uses ONLY the `open` field of the 09:30 bar. Its close is 09:35 information and is
 *     deliberately never touched. Bars are stamped at candle START (verified: the 09:30 bar's open is the
 *     RTH open), so `.open` at minute 570 is exactly the print at the bell.
 *   - Everything in `label` (the realized character of the day) is session data and is used ONLY as the
 *     target. It never feeds a feature. Any leak here manufactures an edge that cannot be traded.
 *
 * FEATURES (all start-of-day)
 *   prior-day candle : colour, body/range ratio (large-body / doji), upper+lower wick fraction (hammer /
 *                      shooting star), close vs daily BB (above upper / upper half / lower half / below
 *                      lower) and vs daily EMA9. WHY: yesterday's close is the reference every 0DTE
 *                      structure is placed around, and a close pinned to a band edge is the classic
 *                      continuation-or-snapback fork.
 *   multi-day trend  : net move over the prior 2/3/5 days in ATR units, higher-high/higher-low sequence,
 *                      consecutive same-colour day count. WHY: a stack of same-colour days is the only
 *                      cheap prior for "the tape is trending", and trend days are where a directional
 *                      spread ladder either compounds or gets run over.
 *   premarket        : overnight range vs its own 20-day average, drift from prior close in ATR units,
 *                      where the premarket close sits vs the prior close and vs the daily bands.
 *                      WHY: overnight range is the market's own forecast of today's range, and it is the
 *                      single most direct volatility signal available before the bell.
 *   the open         : gap in points and in ATR units, and where the open sits vs the daily bands / EMA9.
 *   volatility state : ATR(14) percentile within the trailing 252 days, daily BB-width percentile
 *                      (squeeze vs expansion). WHY: a squeeze is a textbook trend-day precursor, and the
 *                      strategies here are extremely sensitive to whether the day trends or ranges.
 *   calendar         : day-of-week, Monday-after-weekend. Cheap, and free of any estimation error.
 *
 * REALIZED LABELS (the target — explicit numeric rules, computed from RTH bars of the day itself)
 *   Let O/H/L/C be the RTH day candle, R = H-L, and PATH = sum(|close_i - close_{i-1}|) over the RTH 5m
 *   closes. Define efficiency E = |C-O| / PATH (how much of the walking got somewhere) and closeLoc =
 *   position of C inside [L,H].
 *     TREND    : E >= 0.20 AND |C-O| >= 0.60*R AND close in the outer 25% of the range on the move's side.
 *     REVERSAL : max excursion AGAINST the final direction >= 0.45*R (the day went one way, then the
 *                other) and it is not a TREND day.
 *     EARLY-MOVE: >= 55% of the day's total path length happens before 12:00 ET AND the 12:00-16:00
 *                range is <= 45% of R. (moves early, then goes quiet)
 *     DRIFT    : E >= 0.12 but fails the above — went somewhere, but gave a chunk of it back.
 *     CHOP     : everything else (below-median efficiency, no reversal shape) — the range day.
 *   Precedence: TREND > REVERSAL > EARLY-MOVE > DRIFT > CHOP, so each day gets exactly one label.
 *
 *   THRESHOLD CALIBRATION — these are not round numbers picked by feel; they are set at measured
 *   quantiles of the 765-day distribution so each bucket is populated enough to compare variants in:
 *   E has p50 0.116 / p75 0.190 / p90 0.273, so 0.20 is roughly the top quartile ("directional") and
 *   0.12 the median ("went somewhere at all"). |C-O|/R has p50 0.493 / p75 0.691. Adverse excursion / R
 *   has p75 0.388 / p90 0.557, so 0.45 is about the top fifth. An earlier draft used E >= 0.30 for both
 *   TREND and DRIFT; that put 71% of days in CHOP and left DRIFT literally EMPTY, which is a degenerate
 *   taxonomy, not a finding.
 *
 *   REAL FINDING FROM THE CALIBRATION: of the ~170 days with E >= 0.20, all but 5 also close in the
 *   outer quarter of their range. On /NQ an efficient day essentially always closes at its extreme —
 *   "efficient but faded into the close" is not a thing that happens, which is why DRIFT has to be
 *   defined off the weaker E >= 0.12 bar to exist at all.
 *
 * STRATEGY JOIN
 *   Per-day terminal P&L for the 30 CAPPED sweep variants via runDay5m. optsFor() is copied VERBATIM
 *   from build-backtest-baselines.js (including the VC.assertForwarded guard) — this repo has a history
 *   of analysis scripts silently dropping variant flags and reporting confident null results. The script
 *   then ASSERTS its per-variant totals against server/src/candle-spread/backtest-baselines.json to the
 *   dollar and refuses to report anything if they disagree.
 *
 * Usage: node scripts/candle-spread/classify-regimes.js [--dataDir D] [--workers N] [--cache F]
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { runDay5m, load5mDays } = require('./backtest-v6-5m');
const { makeGeo, makeAdaptiveGeo } = require('./backtest-width');
const { buildRuns } = require('../../server/src/candle-spread/index');
const VC = require('../../server/src/candle-spread/variant-contract');

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const DIR = arg('--dataDir', path.join(__dirname, '..', '..', 'tests', 'backtest', 'backtest-data-5m-nq'));
const WORKERS = Math.max(1, Math.min(16, Number(arg('--workers', String(Math.min(8, os.cpus().length)))) || 1));
const CACHE = arg('--cache', path.join(os.tmpdir(), 'classify-regimes-pnl-cache.json'));
const BASELINES = path.join(__dirname, '..', '..', 'server', 'src', 'candle-spread', 'backtest-baselines.json');
// The intraday-IV correction is CANONICAL in the committed baselines, so it must be on here too or the
// dollar-for-dollar reproduction check cannot pass. Kept as a named constant rather than a literal so the
// dependency between "what the baseline was built with" and "what we measure" is explicit.
const INTRADAY_IV = true;

const usd = n => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');
const pct = n => (n * 100).toFixed(1) + '%';

// ── time helpers ────────────────────────────────────────────────────────────────────────────────────
// ET wall-clock minute of a bar. The dataset is stamped in epoch ms and the session boundaries that
// matter (09:30 / 16:00) are ET, so every session test goes through this.
const etMin = ms => { const d = new Date(new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York' })); return d.getHours() * 60 + d.getMinutes(); };
const etDow = ms => new Date(new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York' })).getDay();
const RTH_OPEN = 570, RTH_CLOSE = 960;

// ══ 1. LOAD + TRADING-DAY FILTER ════════════════════════════════════════════════════════════════════
// Identical rule to build-backtest-baselines: a day counts only if it has a real RTH cash session. The
// 24h NQ feed carries Sunday-evening and holiday futures sessions with no cash session; they are
// untradeable for 0DTE NDX and would dilute every per-day average. This filter is also what makes the
// day COUNT match the baseline (765), which is the first half of the reproduction check.
const allDays = load5mDays(DIR);
if (!allDays.length) { console.error('no days loaded from', DIR); process.exit(1); }
const hasRth = d => d.bars.some(b => { const m = etMin(b.dt); return m >= RTH_OPEN && m < RTH_CLOSE; });
const days = allDays.filter(hasRth);
const HAS_PX = allDays.some(d => d.bars.some(b => b.px));

// ══ 2. DAILY CANDLES ════════════════════════════════════════════════════════════════════════════════
// There is no '1D' timeframe in the dataset, so the daily series is aggregated here from the RTH 5m
// bars: open = the 09:30 bar's OPEN, high/low = extremes of the 5m candles inside the session, close =
// the last RTH bar's close. Signals come from /NQ per the foundational rule, so this uses analysis['5m']
// (the NQ signal series) and never the optional NDX `px` series.
function dailyCandle(day) {
  const rth = day.bars.filter(b => { const m = etMin(b.dt); return m >= RTH_OPEN && m < RTH_CLOSE; });
  if (!rth.length) return null;
  let hi = -Infinity, lo = Infinity;
  for (const b of rth) { const a = b.analysis['5m']; if (a.high > hi) hi = a.high; if (a.low < lo) lo = a.low; }
  return {
    date: day.date, dt: rth[0].dt, rth,
    open: rth[0].analysis['5m'].open, high: hi, low: lo, close: rth[rth.length - 1].analysis['5m'].close,
  };
}
const D = days.map(dailyCandle);   // chronological — load5mDays sorts files by YYYY-MM-DD

// Daily BB(20,2) and EMA9 across DAYS. Stored per index; every consumer reads index i-1 when classifying
// day i, so nothing from day i's own session can reach a feature.
function dailyIndicators(D) {
  const out = D.map(() => ({}));
  const ema = []; const K = 2 / (9 + 1);
  for (let i = 0; i < D.length; i++) {
    const c = D[i].close;
    ema[i] = i === 0 ? c : c * K + ema[i - 1] * (1 - K);
    if (i >= 19) {
      let s = 0; for (let j = i - 19; j <= i; j++) s += D[j].close;
      const m = s / 20;
      let v = 0; for (let j = i - 19; j <= i; j++) v += (D[j].close - m) * (D[j].close - m);
      const sd = Math.sqrt(v / 20);
      out[i].bbmiddle = m; out[i].bbupper = m + 2 * sd; out[i].bblower = m - 2 * sd; out[i].bbwidth = 4 * sd;
    }
    out[i].ema9 = ema[i];
    // True range / ATR(14). ATR is the unit every "how big is this move" feature is expressed in — points
    // are not comparable across a 12,000 and a 22,000 NDX, and a gap of 60 points means something
    // completely different in a quiet regime than in a volatile one.
    const tr = i === 0 ? D[i].high - D[i].low
      : Math.max(D[i].high - D[i].low, Math.abs(D[i].high - D[i - 1].close), Math.abs(D[i].low - D[i - 1].close));
    out[i].tr = tr;
    if (i >= 13) { let s = 0; for (let j = i - 13; j <= i; j++) s += out[j].tr; out[i].atr14 = s / 14; }
  }
  return out;
}
const IND = dailyIndicators(D);

// Percentile of x within the trailing `win` observations ENDING at index i (inclusive). Trailing-window
// rather than full-history so the percentile is knowable in real time and does not drift as history is
// appended — a full-history percentile is a subtle lookahead (it uses the future to rank the past).
function trailingPct(arr, i, win) {
  const lo = Math.max(0, i - win + 1);
  const vals = []; for (let j = lo; j <= i; j++) if (arr[j] != null && isFinite(arr[j])) vals.push(arr[j]);
  if (vals.length < 30 || arr[i] == null) return null;
  let c = 0; for (const v of vals) if (v <= arr[i]) c++;
  return c / vals.length;
}

// ══ 3. START-OF-DAY FEATURES ════════════════════════════════════════════════════════════════════════
// Every value below is derived from indices < i (prior sessions), premarket bars of day i, or the OPEN
// print of day i. Nothing else.
const atrSeries = IND.map(x => x.atr14 == null ? null : x.atr14);
const bbwSeries = IND.map((x, i) => (x.bbwidth == null || !D[i].close) ? null : x.bbwidth / D[i].close);

function featuresFor(i) {
  // Need 20 prior days for the daily bands plus a 60-day runway for the percentiles to be meaningful.
  if (i < 60) return null;
  const p = D[i - 1], pi = IND[i - 1];            // yesterday's candle and yesterday's bands
  if (pi.bbupper == null || pi.atr14 == null || !pi.atr14) return null;
  const atr = pi.atr14;
  const f = { date: D[i].date, i };

  // ── prior-day candle shape ──
  const pr = p.high - p.low, body = p.close - p.open;
  f.pdGreen = body > 0 ? 1 : 0;
  f.pdBodyFrac = pr > 0 ? Math.abs(body) / pr : 0;                          // 1 = marubozu, ~0 = doji
  f.pdUpperWick = pr > 0 ? (p.high - Math.max(p.open, p.close)) / pr : 0;
  f.pdLowerWick = pr > 0 ? (Math.min(p.open, p.close) - p.low) / pr : 0;
  f.pdRangeAtr = pr / atr;
  // Bucketed shape — the user's own vocabulary. A hammer/star needs a long wick on one side AND a small
  // body; requiring both is what keeps "small body" from swallowing everything.
  f.pdShape = f.pdBodyFrac >= 0.62 ? 'large-body'
    : f.pdBodyFrac <= 0.22 ? (f.pdLowerWick > 0.45 ? 'hammer' : f.pdUpperWick > 0.45 ? 'star' : 'doji')
      : (f.pdLowerWick > 0.5 ? 'hammer' : f.pdUpperWick > 0.5 ? 'star' : 'mid-body');
  // Close vs yesterday's daily bands, in %B terms (0 = lower band, 1 = upper band).
  f.pdPctB = (p.close - pi.bblower) / (pi.bbupper - pi.bblower);
  f.pdBandZone = f.pdPctB > 1 ? 'above-upper' : f.pdPctB >= 0.5 ? 'upper-half'
    : f.pdPctB >= 0 ? 'lower-half' : 'below-lower';
  f.pdVsEma9 = (p.close - pi.ema9) / atr;

  // ── multi-day trend ──
  for (const n of [2, 3, 5]) f['ret' + n] = (p.close - D[i - n].close) / atr;
  // Higher-highs AND higher-lows over the last 3 completed days — the structural definition of an uptrend,
  // which is stricter (and less noisy) than "price went up".
  const hh = D[i - 1].high > D[i - 2].high && D[i - 2].high > D[i - 3].high;
  const hl = D[i - 1].low > D[i - 2].low && D[i - 2].low > D[i - 3].low;
  const lh = D[i - 1].high < D[i - 2].high && D[i - 2].high < D[i - 3].high;
  const ll = D[i - 1].low < D[i - 2].low && D[i - 2].low < D[i - 3].low;
  f.struct = (hh && hl) ? 'HH-HL' : (lh && ll) ? 'LH-LL' : 'mixed';
  let streak = 0;                                  // consecutive same-colour days ending yesterday
  const dir = D[i - 1].close > D[i - 1].open ? 1 : -1;
  for (let j = i - 1; j >= 0; j--) { const s = D[j].close > D[j].open ? 1 : -1; if (s !== dir) break; streak++; }
  f.streak = streak * dir;

  // ── volatility state ──
  f.atrPct = trailingPct(atrSeries, i - 1, 252);        // ATR percentile in the trailing year
  f.bbwPct = trailingPct(bbwSeries, i - 1, 252);        // BB-width percentile: squeeze (low) vs expansion
  f.volState = f.atrPct == null ? null : f.atrPct >= 0.70 ? 'high-vol' : f.atrPct <= 0.30 ? 'low-vol' : 'mid-vol';
  f.squeeze = f.bbwPct == null ? null : f.bbwPct <= 0.25 ? 'squeeze' : f.bbwPct >= 0.75 ? 'expanded' : 'normal';

  // ── premarket (bars strictly before 09:30 on day i) ──
  const pm = days[i].bars.filter(b => etMin(b.dt) < RTH_OPEN);
  if (pm.length >= 6) {
    let hi = -Infinity, lo = Infinity;
    for (const b of pm) { const a = b.analysis['5m']; if (a.high > hi) hi = a.high; if (a.low < lo) lo = a.low; }
    f.pmRange = hi - lo;
    f.pmRangeAtr = f.pmRange / atr;
    f.pmClose = pm[pm.length - 1].analysis['5m'].close;
    // NOTE: pmDrift is NUMERICALLY IDENTICAL to gapAtr below, because /NQ trades continuously — the close
    // of the 09:25 bar IS the open of the 09:30 bar. It is kept as its own name because they answer
    // different questions conceptually, but they must never be treated as two independent features; the
    // report says so explicitly rather than letting a reader count the same signal twice.
    f.pmDrift = (f.pmClose - p.close) / atr;
    f.pmPctB = (f.pmClose - pi.bblower) / (pi.bbupper - pi.bblower);
    // GENUINELY separate overnight information: where price stood at 08:00 ET, i.e. before the US cash
    // pre-open flow. The 08:00->open leg is then the part of the overnight move that happened in the last
    // 90 minutes, which is not collinear with the gap.
    const at8 = pm.filter(b => etMin(b.dt) <= 480).pop();
    f.pm08Drift = at8 ? (at8.analysis['5m'].close - p.close) / atr : null;
    f.pmLateDrift = at8 ? (f.pmClose - at8.analysis['5m'].close) / atr : null;
  } else { f.pmRangeAtr = null; f.pmDrift = null; f.pmPctB = null; f.pm08Drift = null; f.pmLateDrift = null; }
  // Overnight range vs its own trailing 20-day average — "is tonight unusually busy?" is a relative
  // question; the absolute overnight range just tracks the vol regime we already measured with ATR.
  f.pmRangeRel = null;
  if (f.pmRange != null) {
    const hist = [];
    for (let j = i - 1; j >= 0 && hist.length < 20; j--) {
      const q = days[j].bars.filter(b => etMin(b.dt) < RTH_OPEN);
      if (q.length < 6) continue;
      let h2 = -Infinity, l2 = Infinity;
      for (const b of q) { const a = b.analysis['5m']; if (a.high > h2) h2 = a.high; if (a.low < l2) l2 = a.low; }
      hist.push(h2 - l2);
    }
    if (hist.length >= 10) f.pmRangeRel = f.pmRange / (hist.reduce((a, b) => a + b, 0) / hist.length);
  }

  // ── the open itself (ONLY the open print of the 09:30 bar) ──
  f.open = D[i].open;
  f.gapPts = f.open - p.close;
  f.gapAtr = f.gapPts / atr;
  f.gapBucket = f.gapAtr >= 0.5 ? 'gap-up-big' : f.gapAtr >= 0.15 ? 'gap-up'
    : f.gapAtr <= -0.5 ? 'gap-dn-big' : f.gapAtr <= -0.15 ? 'gap-dn' : 'flat-open';
  f.openPctB = (f.open - pi.bblower) / (pi.bbupper - pi.bblower);
  f.openZone = f.openPctB > 1 ? 'above-upper' : f.openPctB >= 0.5 ? 'upper-half'
    : f.openPctB >= 0 ? 'lower-half' : 'below-lower';
  f.openVsEma9 = (f.open - pi.ema9) / atr;

  // ── calendar ── free, exact, and a real thing in index futures (Monday gap risk, Friday pin).
  f.dow = etDow(D[i].dt);
  return f;
}

// ══ 4. REALIZED LABEL (target only — NEVER a feature) ═══════════════════════════════════════════════
function labelFor(i) {
  const d = D[i], rth = d.rth;
  if (rth.length < 30) return null;
  const O = d.open, C = d.close, H = d.high, L = d.low, R = H - L;
  if (!(R > 0)) return null;
  // PATH = total absolute movement between consecutive 5m closes. Efficiency = net / path is the cleanest
  // scalar separator of "went somewhere" from "walked in circles": a 1% trend day and a 1% chop day can
  // have the same range, but never the same efficiency.
  const closes = rth.map(b => b.analysis['5m'].close);
  let path = 0; for (let k = 1; k < closes.length; k++) path += Math.abs(closes[k] - closes[k - 1]);
  const net = C - O, eff = path > 0 ? Math.abs(net) / path : 0;
  const closeLoc = (C - L) / R;                       // 1 = closed on the high, 0 = on the low
  const dir = net >= 0 ? 1 : -1;
  // Max adverse excursion measured against the day's FINAL direction: how far the tape went the wrong way
  // before ending up where it did. A big one is the signature of a mid-day reversal.
  const adverse = dir > 0 ? (O - L) : (H - O);
  // Time-of-day distribution of the walking, plus the size of the afternoon range.
  let pathEarly = 0;
  for (let k = 1; k < closes.length; k++) if (etMin(rth[k].dt) < 720) pathEarly += Math.abs(closes[k] - closes[k - 1]);
  const pm = rth.filter(b => etMin(b.dt) >= 720);
  let pmH = -Infinity, pmL = Infinity;
  for (const b of pm) { const a = b.analysis['5m']; if (a.high > pmH) pmH = a.high; if (a.low < pmL) pmL = a.low; }
  const pmRangeFrac = pm.length ? (pmH - pmL) / R : 1;
  const earlyFrac = path > 0 ? pathEarly / path : 0;

  const isTrend = eff >= 0.20 && Math.abs(net) >= 0.60 * R && (dir > 0 ? closeLoc >= 0.75 : closeLoc <= 0.25);
  const isReversal = adverse >= 0.45 * R;
  const isEarly = earlyFrac >= 0.55 && pmRangeFrac <= 0.45;
  const isDrift = eff >= 0.12;
  const label = isTrend ? (dir > 0 ? 'trend-up' : 'trend-dn')
    : isReversal ? 'reversal' : isEarly ? 'early-move' : isDrift ? 'drift' : 'chop';
  return { date: d.date, label, coarse: label.startsWith('trend') ? 'trend' : label,
    eff, closeLoc, netAtr: net, rangePts: R, adverseFrac: adverse / R, earlyFrac, pmRangeFrac, dir };
}

// ══ 5. STRATEGY P&L ═════════════════════════════════════════════════════════════════════════════════
// optsFor — COPIED VERBATIM from scripts/candle-spread/build-backtest-baselines.js, guard included.
// Do not "clean this up": every conditional here is a variant capability that was, at some point, silently
// dropped by a consumer and measured as a no-op. The assertForwarded call at the bottom is the tripwire.
function optsFor(v) {
  const o = { rthActionOnly: true, trackCapital: true };
  if (INTRADAY_IV) o.intradayIV = true;
  if (v.ivSkew) o.ivSkew = true;
  if (v.bidirectional) o.bidirectional = true;
  for (const k of ['riskCap', 'softCap', 'hardCap', 'capitalCeiling', 'proactiveCoverFrac', 'lossTarget', 'lossMax']) if (v[k] != null) o[k] = v[k];
  if (v.floorOffset) o.floorOffset = true;
  if (v.continuousCover) o.continuousCover = true;
  if (v.continuousCoverMinLockFrac != null) o.continuousCoverMinLockFrac = v.continuousCoverMinLockFrac;
  if (v.coverGeometry) o.coverGeometry = v.coverGeometry;
  if (v.continuousCoverArmFrac != null) o.continuousCoverArmFrac = v.continuousCoverArmFrac;
  if (v.continuousCoverOppRatio != null) o.continuousCoverOppRatio = v.continuousCoverOppRatio;
  if (v.wingConvert) o.wingConvert = true;
  for (const k of ['wingMinRatio', 'wingAfterMin', 'wingBudgetFrac', 'wingBudget', 'wingMaxPerDay',
    'wingBandSigmas', 'wingOutSteps', 'wingUpsideLambda', 'wingTailSigmas']) if (v[k] != null) o[k] = v[k];
  if (v.wingNaked) o.wingNaked = true;
  if (v.lockCoverMode) o.lockCoverMode = v.lockCoverMode;
  if (v.exemptTrendStack) o.exemptTrendStack = true;
  if (v.coverSelector) o.coverSelector = v.coverSelector;
  if (v.coverToStack) { o.coverToStack = true; o.coverToStackVsRisk = true; if (v.coverToStackMinFrac != null) o.coverToStackMinFrac = v.coverToStackMinFrac; }
  if (v.capitalRecapture) { o.recaptureAlternate = true; if (v.openAlternateEvery != null) o.openAlternateEvery = v.openAlternateEvery; if (v.creditCoverFrac != null) o.creditCoverFrac = v.creditCoverFrac; }
  if (v.openNeverOtm) o.openNeverOtm = true;
  if (v.enforceLegUniqueness) { o.enforceLegUniqueness = true; if (v.legMaxShift != null) o.legMaxShift = v.legMaxShift; if (v.legMaxWing != null) o.legMaxWing = v.legMaxWing; }
  const w = v.spreadWidth, sh = v.spreadShift || 0, cf = v.capFrac;
  o.geo = v.adaptiveGeo
    ? makeAdaptiveGeo({ width: w || 20, incr: 10, maxDebitFrac: cf != null ? cf : 0.65, maxItmStrikes: v.maxItmStrikes != null ? v.maxItmStrikes : 3 })
    : makeGeo({ width: w || 20, shift: sh, capFrac: cf != null ? cf : undefined });
  if (HAS_PX) o.priceOf = (b) => b.px || { close: b.analysis['5m'].close, high: b.analysis['5m'].high, low: b.analysis['5m'].low };
  VC.assertForwarded(v, Object.keys(o), 'classify-regimes optsFor',
    ['capitalRecapture', 'openAlternateEvery', 'creditCoverFrac', 'coverToStackMinFrac']);
  return o;
}
const wrap = (v) => (A, p, ctx) => v.signalFn(A, p, { ...ctx, cfg: v.signalCfg || {} });

// The 30 CAPPED sweep variants: v0-10 … v9-40. `-unc` (uncapped twins) breach the daily risk tolerance and
// are not deployable candidates; `-cATM` are fixed-strike controls, not candidates either.
const RUNS = buildRuns().filter(v => /^v\d+-(10|20|40)$/.test(v.variant));

// Worker mode: compute a strided slice of the variants and hand it back through a FILE (not stdout —
// process.exit truncates a pending async write past the pipe buffer, and 30x765 numbers is well past it).
const si = process.argv.indexOf('--_slice');
if (si >= 0) {
  const [k, n, outFile] = [Number(process.argv[si + 1]), Number(process.argv[si + 2]), process.argv[si + 3]];
  const res = {};
  for (const run of RUNS.filter((_, ix) => ix % n === k)) {
    const fn = wrap(run), opts = optsFor(run);
    res[run.variant] = days.map(d => runDay5m(d.bars, fn, opts).terminal);
  }
  fs.writeFileSync(outFile, JSON.stringify(res), 'utf8');
  process.exit(0);
}

async function computePnl() {
  // Cache keyed on dataset + day count + variant list. Regenerating the P&L takes minutes; the regime
  // rules get iterated on far more often than the engine does.
  const key = `${path.basename(DIR)}|${days.length}|${RUNS.map(r => r.variant).join(',')}|iv${INTRADAY_IV}`;
  if (fs.existsSync(CACHE)) {
    try { const c = JSON.parse(fs.readFileSync(CACHE, 'utf8')); if (c.key === key) { console.log('(P&L from cache)'); return c.pnl; } } catch (e) {}
  }
  const pnl = {};
  if (WORKERS > 1) {
    const { spawn } = require('child_process');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'regime-pnl-'));
    try {
      await Promise.all(Array.from({ length: WORKERS }, (_, k) => new Promise((resolve, reject) => {
        const outFile = path.join(tmp, `s${k}.json`);
        const ch = spawn(process.execPath, [__filename, '--dataDir', DIR, '--_slice', String(k), String(WORKERS), outFile],
          { stdio: ['ignore', 'ignore', 'inherit'] });
        ch.on('error', reject);
        ch.on('close', c => { if (c !== 0) return reject(new Error(`worker ${k} exited ${c}`)); Object.assign(pnl, JSON.parse(fs.readFileSync(outFile, 'utf8'))); resolve(); });
      })));
    } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} }
  } else {
    for (const run of RUNS) { const fn = wrap(run), opts = optsFor(run); pnl[run.variant] = days.map(d => runDay5m(d.bars, fn, opts).terminal); }
  }
  try { fs.writeFileSync(CACHE, JSON.stringify({ key, pnl }), 'utf8'); } catch (e) {}
  return pnl;
}

// ══ 6. REPORT ═══════════════════════════════════════════════════════════════════════════════════════
function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
// Cramer's V — the effect size for a contingency table, on 0..1. Chi-square alone grows with n and so
// says nothing about whether a feature is USEFUL; V is the number that answers "how much does knowing
// this feature move the label distribution?".
function cramersV(rows) {
  const rk = [...new Set(rows.map(r => r[0]))], ck = [...new Set(rows.map(r => r[1]))];
  if (rk.length < 2 || ck.length < 2) return { v: 0, chi2: 0, df: 0, n: rows.length };
  const obs = new Map(), rt = new Map(), ct = new Map();
  for (const [a, b] of rows) { const k = a + ' ' + b; obs.set(k, (obs.get(k) || 0) + 1); rt.set(a, (rt.get(a) || 0) + 1); ct.set(b, (ct.get(b) || 0) + 1); }
  const n = rows.length; let chi2 = 0;
  for (const a of rk) for (const b of ck) { const e = rt.get(a) * ct.get(b) / n; const o = obs.get(a + ' ' + b) || 0; chi2 += (o - e) * (o - e) / e; }
  return { v: Math.sqrt(chi2 / (n * Math.min(rk.length - 1, ck.length - 1))), chi2, df: (rk.length - 1) * (ck.length - 1), n };
}
// Chi-square upper-tail probability, via the regularized incomplete gamma Q(df/2, chi2/2) (Lentz continued
// fraction for large x, series for small). Cramer's V says how BIG the association is; the p-value says
// whether it is distinguishable from zero at all. Reporting V without p invites reading 0.10 on 20 degrees
// of freedom as a finding when it is exactly what noise produces.
function chi2p(x, df) {
  if (x <= 0 || df <= 0) return 1;
  const a = df / 2, xx = x / 2;
  const lg = (z) => {                                   // Lanczos log-gamma
    const g = [676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
      12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
    if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lg(1 - z);
    z -= 1; let s = 0.99999999999980993;
    for (let i = 0; i < g.length; i++) s += g[i] / (z + i + 1);
    const t = z + g.length - 0.5;
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(s);
  };
  if (xx < a + 1) {                                     // series for P(a,x), Q = 1 - P
    let ap = a, sum = 1 / a, del = sum;
    for (let n = 0; n < 500; n++) { ap++; del *= xx / ap; sum += del; if (Math.abs(del) < Math.abs(sum) * 1e-14) break; }
    return 1 - sum * Math.exp(-xx + a * Math.log(xx) - lg(a));
  }
  let b = xx + 1 - a, c = 1e300, d = 1 / b, h = d;      // continued fraction for Q(a,x)
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a); b += 2; d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d; const del = d * c; h *= del; if (Math.abs(del - 1) < 1e-14) break;
  }
  return Math.exp(-xx + a * Math.log(xx) - lg(a)) * h;
}
// Two-sided normal tail — with n in the hundreds the t distribution is the normal for reporting purposes.
const normP = z => { const t = 1 / (1 + 0.2316419 * Math.abs(z)); const d = 0.3989422804014327 * Math.exp(-z * z / 2); return 2 * d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429)))); };

// Welch t-statistic for a numeric feature split by binary outcome. Reported as |t| so the table can be
// read as "how many standard errors apart are these two groups" without sign bookkeeping.
function welch(a, b) {
  if (a.length < 5 || b.length < 5) return null;
  const ma = mean(a), mb = mean(b);
  const va = a.reduce((s, x) => s + (x - ma) ** 2, 0) / (a.length - 1);
  const vb = b.reduce((s, x) => s + (x - mb) ** 2, 0) / (b.length - 1);
  const se = Math.sqrt(va / a.length + vb / b.length);
  return se > 0 ? { t: (ma - mb) / se, ma, mb } : null;
}

(async () => {
  console.log(`\nSTART-OF-DAY REGIME CLASSIFIER — ${DIR.split(path.sep).slice(-1)[0]}`);
  console.log(`${allDays.length} calendar days -> ${days.length} trading days (RTH cash session present)`);
  console.log(`pricing series: ${HAS_PX ? 'cash NDX (px)' : 'signal series (single-instrument dataset)'}\n`);

  // features + labels, aligned by index into `days`/`D`
  const rows = [];
  for (let i = 0; i < D.length; i++) {
    const f = featuresFor(i), l = labelFor(i);
    if (f && l) rows.push({ i, date: D[i].date, f, l });
  }
  console.log(`classified ${rows.length} days (first ${60} skipped: daily BB/ATR/percentile warm-up)\n`);

  const pnl = await computePnl();

  // ── REPRODUCTION CHECK (blocking) ──
  const base = JSON.parse(fs.readFileSync(BASELINES, 'utf8'));
  console.log('BASELINE REPRODUCTION CHECK (must match to the dollar)');
  console.log('  variant    mine            committed       delta');
  let bad = 0;
  for (const name of RUNS.map(r => r.variant)) {
    const mineTot = Math.round(pnl[name].reduce((a, b) => a + b, 0));
    const ref = base.variants[name] ? base.variants[name].total : null;
    if (ref == null) { console.log(`  ${name.padEnd(10)} ${String(mineTot).padEnd(15)} (not in baselines)`); continue; }
    const dl = mineTot - ref;
    if (dl !== 0) { bad++; console.log(`  ${name.padEnd(10)} ${String(mineTot).padEnd(15)} ${String(ref).padEnd(15)} ${dl}  <<< MISMATCH`); }
  }
  console.log(`  ${bad === 0 ? 'ALL ' + RUNS.length + ' CAPPED VARIANTS MATCH backtest-baselines.json EXACTLY' : bad + ' MISMATCHES'}`);
  if (bad) { console.error('\nRefusing to report: opts do not reproduce the committed baseline.'); process.exit(1); }

  // index -> position in the pnl arrays (which are indexed over `days`, same order as D)
  const pnlAt = (name, i) => pnl[name][i];

  // ── label distribution ──
  console.log('\n\nREGIME LABEL DISTRIBUTION (realized character of the day — the TARGET)');
  const byLabel = new Map();
  for (const r of rows) { const k = r.l.label; if (!byLabel.has(k)) byLabel.set(k, []); byLabel.get(k).push(r); }
  const ORDER = ['trend-up', 'trend-dn', 'reversal', 'early-move', 'drift', 'chop'];
  console.log('  label'.padEnd(14) + 'days'.padEnd(8) + 'share'.padEnd(9) + 'avg eff'.padEnd(10) + 'avg range pts'.padEnd(16) + 'avg |net|/range');
  for (const k of ORDER) {
    const g = byLabel.get(k) || [];
    if (!g.length) continue;
    console.log('  ' + k.padEnd(12) + String(g.length).padEnd(8) + pct(g.length / rows.length).padEnd(9)
      + mean(g.map(x => x.l.eff)).toFixed(3).padEnd(10) + Math.round(mean(g.map(x => x.l.rangePts))).toString().padEnd(16)
      + mean(g.map(x => Math.abs(x.l.netAtr) / x.l.rangePts)).toFixed(3));
  }

  // ── predictive power of the features ──
  console.log('\n\nARE START-OF-DAY FEATURES PREDICTIVE OF THE REALIZED LABEL?');
  console.log('  Categorical features vs the 6-way label — Cramer\'s V (0 = none, 0.1 small, 0.3 moderate):');
  const catFeats = ['pdShape', 'pdBandZone', 'struct', 'volState', 'squeeze', 'gapBucket', 'openZone',
    'dow', 'pdGreen'];
  const vRows = [];
  for (const cf of catFeats) {
    const pairs = rows.filter(r => r.f[cf] != null).map(r => [String(r.f[cf]), r.l.label]);
    const cv = cramersV(pairs);
    vRows.push({ cf, ...cv });
  }
  vRows.sort((a, b) => b.v - a.v);
  console.log('    feature'.padEnd(16) + 'n'.padEnd(7) + "Cramer's V".padEnd(13) + 'chi2'.padEnd(10) + 'df'.padEnd(5) + 'p'.padEnd(9) + 'sig at 0.05/9 (Bonferroni)?');
  for (const r of vRows) {
    const p = chi2p(r.chi2, r.df);
    console.log('    ' + r.cf.padEnd(14) + String(r.n).padEnd(7) + r.v.toFixed(3).padEnd(13) + r.chi2.toFixed(1).padEnd(10)
      + String(r.df).padEnd(5) + p.toFixed(4).padEnd(9) + (p < 0.05 / vRows.length ? 'YES' : 'no'));
  }

  console.log('\n  Numeric features: trend-day (trend-up|trend-dn) vs everything else — Welch |t|');
  const numFeats = ['pdBodyFrac', 'pdRangeAtr', 'pdPctB', 'pdVsEma9', 'ret2', 'ret3', 'ret5', 'streak',
    'atrPct', 'bbwPct', 'pmRangeAtr', 'pmRangeRel', 'pm08Drift', 'pmLateDrift', 'gapAtr', 'openPctB', 'openVsEma9'];
  const isTrend = r => r.l.coarse === 'trend';
  const tRows = [];
  for (const nf of numFeats) {
    const A = rows.filter(r => isTrend(r) && r.f[nf] != null && isFinite(r.f[nf])).map(r => r.f[nf]);
    const B = rows.filter(r => !isTrend(r) && r.f[nf] != null && isFinite(r.f[nf])).map(r => r.f[nf]);
    const w = welch(A, B); if (w) tRows.push({ nf, ...w, nA: A.length, nB: B.length });
  }
  tRows.sort((a, b) => Math.abs(b.t) - Math.abs(a.t));
  console.log('    feature'.padEnd(16) + 'trend mean'.padEnd(13) + 'other mean'.padEnd(13) + '|t|'.padEnd(8) + 'p'.padEnd(9) + 'sig at 0.05/17?'.padEnd(17) + 'n(trend)/n(other)');
  for (const r of tRows) { const p = normP(r.t); console.log('    ' + r.nf.padEnd(14) + r.ma.toFixed(3).padEnd(13) + r.mb.toFixed(3).padEnd(13)
    + Math.abs(r.t).toFixed(2).padEnd(8) + p.toFixed(4).padEnd(9) + (p < 0.05 / tRows.length ? 'YES' : 'no').padEnd(17) + `${r.nA}/${r.nB}`); }

  // Same, but for the outcome we actually care about: does the feature predict a BAD P&L day on the
  // shipped variant? Predicting the label is interesting; predicting the money is the point.
  const REF = 'v7-10';
  console.log(`\n  Numeric features: ${REF} losing day vs winning day — Welch |t|`);
  const t2 = [];
  for (const nf of numFeats) {
    const A = rows.filter(r => pnlAt(REF, r.i) < 0 && r.f[nf] != null && isFinite(r.f[nf])).map(r => r.f[nf]);
    const B = rows.filter(r => pnlAt(REF, r.i) > 0 && r.f[nf] != null && isFinite(r.f[nf])).map(r => r.f[nf]);
    const w = welch(A, B); if (w) t2.push({ nf, ...w, nA: A.length, nB: B.length });
  }
  t2.sort((a, b) => Math.abs(b.t) - Math.abs(a.t));
  console.log('    feature'.padEnd(16) + 'loss mean'.padEnd(13) + 'win mean'.padEnd(13) + '|t|'.padEnd(8) + 'p'.padEnd(9) + 'sig at 0.05/17?'.padEnd(17) + 'n(loss)/n(win)');
  for (const r of t2) { const p = normP(r.t); console.log('    ' + r.nf.padEnd(14) + r.ma.toFixed(3).padEnd(13) + r.mb.toFixed(3).padEnd(13)
    + Math.abs(r.t).toFixed(2).padEnd(8) + p.toFixed(4).padEnd(9) + (p < 0.05 / t2.length ? 'YES' : 'no').padEnd(17) + `${r.nA}/${r.nB}`); }

  // ── per-bucket variant performance ──
  const names = RUNS.map(r => r.variant);
  const overall = {};
  for (const n of names) { const v = rows.map(r => pnlAt(n, r.i)); overall[n] = { avg: mean(v), win: v.filter(x => x > 0).length / v.length, total: v.reduce((a, b) => a + b, 0) }; }

  // WIDTH IS A SIZE DIAL, NOT A STRATEGY. Ranking all 30 variants on raw avg/day always crowns a $40 —
  // it trades roughly twice the notional of a $20 — and is a comparison of position size wearing the
  // costume of a comparison of strategies. Worse, width is not even a CLEAN size dial here: the day-loss
  // governor is looser at wider widths (lossMax $6k/$7k/$9k for $10/$20/$40), so 20/W normalization is an
  // approximation, not an identity. So the primary table below compares WITHIN each width — v0..v9 at a
  // fixed width is a genuine apples-to-apples strategy comparison — and the cross-width raw winner is
  // shown separately, labelled as what it is.
  const WIDTH_OF = new Map(RUNS.map(r => [r.variant, r.spreadWidth]));
  const byWidth = w => names.filter(n => WIDTH_OF.get(n) === w);
  const bucketOf = (keyFn) => { const g = new Map(); for (const r of rows) { const k = keyFn(r); if (k == null) continue; if (!g.has(k)) g.set(k, []); g.get(k).push(r); } return g; };
  const scoreIn = (set, pool) => pool.map(n => { const v = set.map(r => pnlAt(n, r.i)); return { n, avg: mean(v), win: v.filter(x => x > 0).length / v.length, worst: Math.min(...v), lift: mean(v) - overall[n].avg }; }).sort((a, b) => b.avg - a.avg);

  function bucketTable(title, keyFn, order) {
    const g = bucketOf(keyFn);
    const keys = (order || [...g.keys()].sort()).filter(k => g.has(k));
    console.log(`\n\n${title}`);
    console.log('  (best WITHIN each width — apples-to-apples; "lift" = that variant here minus its own all-days average)');
    console.log('  bucket'.padEnd(15) + 'days'.padEnd(6)
      + 'best@$10'.padEnd(10) + 'avg'.padEnd(9) + 'lift'.padEnd(10)
      + 'best@$20'.padEnd(10) + 'avg'.padEnd(9) + 'lift'.padEnd(10)
      + 'best@$40'.padEnd(10) + 'avg'.padEnd(9) + 'lift'.padEnd(10)
      + 'win%(20)'.padEnd(10) + 'worst day(20)');
    for (const k of keys) {
      const gg = g.get(k);
      const c = [10, 20, 40].map(w => scoreIn(gg, byWidth(w))[0]);
      console.log('  ' + String(k).padEnd(13) + String(gg.length).padEnd(6)
        + c.map(x => x.n.padEnd(10) + usd(x.avg).padEnd(9) + ((x.lift >= 0 ? '+' : '') + usd(x.lift)).padEnd(10)).join('')
        + pct(c[1].win).padEnd(10) + usd(c[1].worst));
    }
    return g;
  }

  console.log('\n\n════ WHICH VARIANT WINS IN WHICH REGIME ════');
  bucketTable('BY REALIZED LABEL (hindsight ceiling — NOT tradeable, shows how much regime matters at all)',
    r => r.l.label, ORDER);
  bucketTable('BY START-OF-DAY VOL STATE (ATR percentile, trailing 252d)', r => r.f.volState, ['low-vol', 'mid-vol', 'high-vol']);
  bucketTable('BY START-OF-DAY BB-WIDTH STATE (squeeze vs expansion)', r => r.f.squeeze, ['squeeze', 'normal', 'expanded']);
  bucketTable('BY GAP AT THE OPEN', r => r.f.gapBucket, ['gap-dn-big', 'gap-dn', 'flat-open', 'gap-up', 'gap-up-big']);
  bucketTable('BY PRIOR-DAY CANDLE SHAPE', r => r.f.pdShape, ['large-body', 'mid-body', 'doji', 'hammer', 'star']);
  bucketTable('BY PRIOR-DAY CLOSE vs DAILY BANDS', r => r.f.pdBandZone, ['below-lower', 'lower-half', 'upper-half', 'above-upper']);
  bucketTable('BY 3-DAY STRUCTURE', r => r.f.struct, ['LH-LL', 'mixed', 'HH-HL']);
  bucketTable('BY PREMARKET RANGE vs ITS 20d AVERAGE', r => r.f.pmRangeRel == null ? null : (r.f.pmRangeRel < 0.75 ? 'quiet-ON' : r.f.pmRangeRel > 1.35 ? 'busy-ON' : 'normal-ON'), ['quiet-ON', 'normal-ON', 'busy-ON']);
  bucketTable('BY CONSECUTIVE SAME-COLOUR DAYS', r => { const s = r.f.streak; return s <= -3 ? 'red x3+' : s === -2 ? 'red x2' : s === -1 ? 'red x1' : s === 1 ? 'green x1' : s === 2 ? 'green x2' : 'green x3+'; },
    ['red x3+', 'red x2', 'red x1', 'green x1', 'green x2', 'green x3+']);
  bucketTable('BY DAY OF WEEK', r => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][r.f.dow], ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);

  // FULL per-bucket ranking of the ten $20 strategies, for the two buckets that matter most: the realized
  // label (the hindsight ceiling) and the tradeable vol state. The summary tables above only show the
  // winner; the spread between 1st and 10th is what says whether the choice is worth making at all.
  function detail(title, keyFn, order) {
    const g = bucketOf(keyFn);
    const keys = (order || [...g.keys()].sort()).filter(k => g.has(k) && g.get(k).length >= 20);
    console.log(`\n\nFULL RANKING WITHIN $20 WIDTH — ${title}`);
    for (const k of keys) {
      const gg = g.get(k), s = scoreIn(gg, byWidth(20));
      console.log(`\n  ${k}  (${gg.length} days, ${pct(gg.length / rows.length)} of history)`);
      console.log('    variant'.padEnd(12) + 'total'.padEnd(13) + 'avg/day'.padEnd(11) + 'win%'.padEnd(8)
        + 'worst day'.padEnd(12) + 'lift vs own all-days avg');
      for (const x of s) console.log('    ' + x.n.padEnd(10) + usd(x.avg * gg.length).padEnd(13) + usd(x.avg).padEnd(11)
        + pct(x.win).padEnd(8) + usd(x.worst).padEnd(12) + (x.lift >= 0 ? '+' : '') + usd(x.lift));
    }
  }
  detail('BY REALIZED LABEL (hindsight)', r => r.l.label, ORDER);
  detail('BY START-OF-DAY VOL STATE', r => r.f.volState, ['low-vol', 'mid-vol', 'high-vol']);

  // ── SPLIT-SAMPLE STABILITY ─────────────────────────────────────────────────────────────────────────
  // The headline claim of this whole exercise is "bucket X favours variant Y". With 765 days across
  // several buckets that claim is cheap to manufacture. Split the history in half and print BOTH halves:
  // a bucket effect that flips sign between halves is noise and must be reported as noise.
  const MID = Math.floor(rows.length / 2);
  const idx = new Map(rows.map((r, k) => [r, k]));
  function stability(title, keyFn, order, pool) {
    const P = pool || byWidth(20);
    const g = bucketOf(keyFn);
    const keys = (order || [...g.keys()].sort()).filter(k => g.has(k));
    console.log(`\n\nSPLIT-SAMPLE — ${title}   (pool: ${P.length} variants)`);
    console.log(`  (H1 = ${rows[0].date}..${rows[MID - 1].date}, H2 = ${rows[MID].date}..${rows[rows.length - 1].date})`);
    console.log('  bucket'.padEnd(15) + 'n(H1)/n(H2)'.padEnd(13) + 'best in H1'.padEnd(12) + 'H1 avg'.padEnd(10)
      + 'same var in H2'.padEnd(16) + 'best in H2'.padEnd(12) + 'H2 avg'.padEnd(10) + 'verdict');
    for (const k of keys) {
      const gg = g.get(k);
      const A = gg.filter(r => idx.get(r) < MID), B = gg.filter(r => idx.get(r) >= MID);
      if (A.length < 15 || B.length < 15) { console.log('  ' + String(k).padEnd(15) + `${A.length}/${B.length}`.padEnd(13) + '(too few days in one half to judge)'); continue; }
      const sA = scoreIn(A, P), sB = scoreIn(B, P);
      const bestA = sA[0], bestB = sB[0];
      const bestAinB = sB.find(x => x.n === bestA.n);
      const rankAinB = sB.findIndex(x => x.n === bestA.n) + 1;
      // "Best in H1" beating the pool in H1 is arithmetic. The only question worth asking is where that
      // same variant lands in H2. Top-third = the ranking carried; bottom half = the H1 winner was noise.
      const verdict = bestA.n === bestB.n ? 'STABLE (same winner)'
        : rankAinB <= Math.ceil(P.length / 3) ? `soft (H1 winner ranks ${rankAinB}/${P.length} in H2)`
          : `UNSTABLE (H1 winner ranks ${rankAinB}/${P.length} in H2)`;
      console.log('  ' + String(k).padEnd(15) + `${A.length}/${B.length}`.padEnd(13) + bestA.n.padEnd(12) + usd(bestA.avg).padEnd(10)
        + usd(bestAinB.avg).padEnd(16) + bestB.n.padEnd(12) + usd(bestB.avg).padEnd(10) + verdict);
    }
  }
  stability('BY VOL STATE', r => r.f.volState, ['low-vol', 'mid-vol', 'high-vol']);
  stability('BY SQUEEZE STATE', r => r.f.squeeze, ['squeeze', 'normal', 'expanded']);
  stability('BY GAP', r => r.f.gapBucket, ['gap-dn-big', 'gap-dn', 'flat-open', 'gap-up', 'gap-up-big']);
  stability('BY REALIZED LABEL (hindsight)', r => r.l.label, ORDER);
  stability('BY DAY OF WEEK', r => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][r.f.dow], ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);
  stability('BY VOL STATE — all 30 variants (width free to change)', r => r.f.volState, ['low-vol', 'mid-vol', 'high-vol'], names);

  // ── DOES SWITCHING ACTUALLY PAY? ───────────────────────────────────────────────────────────────────
  // The only honest test of a regime rule: FIT the bucket->variant map on the first half, APPLY it blind
  // to the second half, and compare against just running the single best variant all the way through.
  // In-sample bucket winners always beat the flat baseline — that is arithmetic, not a finding.
  const H1 = rows.slice(0, MID), H2 = rows.slice(MID);
  const SWITCHERS = [
    ['vol state', r => r.f.volState], ['squeeze state', r => r.f.squeeze], ['gap bucket', r => r.f.gapBucket],
    ['prior-day shape', r => r.f.pdShape], ['band zone', r => r.f.pdBandZone], ['3d structure', r => r.f.struct],
    ['day of week', r => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][r.f.dow]],
    ['premarket range', r => r.f.pmRangeRel == null ? 'na' : (r.f.pmRangeRel < 0.75 ? 'quiet' : r.f.pmRangeRel > 1.35 ? 'busy' : 'normal')],
    ['streak', r => { const s = r.f.streak; return s <= -2 ? 'red2+' : s === -1 ? 'red1' : s === 1 ? 'green1' : 'green2+'; }],
  ];
  // A NULL CONTROL is mandatory here. "Fit the argmax of 30 noisy means per bucket on H1" is a procedure
  // with a large positive bias even when the feature is pure noise, so an out-of-sample gain only counts if
  // it beats what the SAME procedure produces from a feature that cannot possibly carry information. The
  // control is a deterministic pseudo-random bucketing of the same cardinality, seeded off the date string.
  const hash = s => { let h = 2166136261; for (let k = 0; k < s.length; k++) { h ^= s.charCodeAt(k); h = Math.imul(h, 16777619); } return (h >>> 0); };
  function switchTest(pool, poolLabel) {
    const bestFlatH1 = scoreIn(H1, pool)[0];
    const flatH2 = H2.map(r => pnlAt(bestFlatH1.n, r.i)), flatTot = flatH2.reduce((a, b) => a + b, 0);
    console.log(`\n\nOUT-OF-SAMPLE SWITCHING TEST — pool: ${poolLabel} (${pool.length} variants)`);
    console.log('  (fit bucket -> best variant on H1, apply BLIND to H2; in-sample bucket winners always beat flat, that is arithmetic)');
    console.log('  rule'.padEnd(36) + 'H2 total'.padEnd(14) + 'H2 avg/day'.padEnd(13) + 'vs flat-best');
    console.log('  ' + `flat ${bestFlatH1.n} (best in H1)`.padEnd(34) + usd(flatTot).padEnd(14) + usd(mean(flatH2)).padEnd(13) + '—');
    const run = (nm, kf) => {
      const g = new Map();
      for (const r of H1) { const k = kf(r); if (k == null) continue; if (!g.has(k)) g.set(k, []); g.get(k).push(r); }
      const map = new Map(); for (const [k, gg] of g) map.set(k, scoreIn(gg, pool)[0].n);
      const v = H2.map(r => { const k = kf(r); return pnlAt(map.has(k) ? map.get(k) : bestFlatH1.n, r.i); });
      const tot = v.reduce((a, b) => a + b, 0);
      console.log('  ' + nm.padEnd(34) + usd(tot).padEnd(14) + usd(mean(v)).padEnd(13) + (tot - flatTot >= 0 ? '+' : '') + usd(tot - flatTot));
      return tot - flatTot;
    };
    for (const [nm, kf] of SWITCHERS) run('switch on ' + nm, kf);
    // ORACLE: the same fit-on-H1 / apply-to-H2 procedure, but keyed on the day's REALIZED label — i.e.
    // what a PERFECT 09:30 regime classifier would be worth. This is the ceiling the whole exercise is
    // chasing, and printing it next to the real rules is what makes "the features don't predict it"
    // quantitative instead of a shrug.
    const oracle = run('ORACLE: switch on realized label', r => r.l.label);
    // The nulls are the honest yardstick: the fit procedure is argmax over noisy per-bucket means, which
    // is biased upward even on a feature with zero information. 20 seeds, not 5 — with a small pool the
    // argmax often lands on the same variant in every random bucket, producing an exact +$0 that would
    // otherwise dominate a 5-seed average and make the null look tighter than it is.
    const nulls = [];
    console.log('  ' + '(20 null controls run, distribution below)'.padEnd(34));
    for (let seed = 1; seed <= 20; seed++) {
      const g = new Map();
      for (const r of H1) { const k = 'z' + (hash(r.date + '|' + seed) % 3); if (!g.has(k)) g.set(k, []); g.get(k).push(r); }
      const map = new Map(); for (const [k, gg] of g) map.set(k, scoreIn(gg, pool)[0].n);
      const v = H2.map(r => pnlAt(map.get('z' + (hash(r.date + '|' + seed) % 3)) || bestFlatH1.n, r.i));
      nulls.push(v.reduce((a, b) => a + b, 0) - flatTot);
    }
    const ns = [...nulls].sort((a, b) => a - b);
    const nMean = mean(nulls), nSd = Math.sqrt(mean(nulls.map(x => (x - nMean) ** 2)));
    console.log(`  NULL controls (20 random 3-way splits): mean ${usd(nMean)}, sd ${usd(nSd)}, p90 ${usd(ns[17])}, best ${usd(ns[19])}`);
    console.log(`  => a rule is only interesting if its edge clears ~${usd(ns[17])} (the 90th percentile of pure noise).`);
    console.log(`  ORACLE (perfect regime foresight) edge: ${usd(oracle)} — the ceiling if a classifier existed.`);
  }
  // ── THE DECISION THAT ACTUALLY MATTERS ─────────────────────────────────────────────────────────────
  // The regime tables show one clean, huge, stable split: v7 (be-wrong) owns trend and drift days and
  // LOSES on reversal/chop days; v4 (multiTF-overext) is its exact mirror. If any start-of-day feature is
  // going to pay, it is by calling that fork. So test it directly as a binary classification problem,
  // with the base rate printed next to it — a rule that is right 55% of the time when the base rate is
  // 54% has told you nothing.
  console.log('\n\nCAN WE CALL THE v7-vs-v4 FORK AT 09:30?');
  const fork = r => (pnlAt('v7-20', r.i) >= pnlAt('v4-20', r.i)) ? 'v7' : 'v4';
  const baseH1 = H1.filter(r => fork(r) === 'v7').length / H1.length;
  const baseH2 = H2.filter(r => fork(r) === 'v7').length / H2.length;
  console.log(`  base rate (v7-20 beats v4-20): H1 ${pct(baseH1)}, H2 ${pct(baseH2)}, all ${pct(rows.filter(r => fork(r) === 'v7').length / rows.length)}`);
  console.log('  feature'.padEnd(20) + 'H1 best-bucket rule accuracy'.padEnd(30) + 'same rule on H2'.padEnd(20) + 'H2 base rate' + '   verdict');
  for (const [nm, kf] of SWITCHERS) {
    const g = new Map();
    for (const r of H1) { const k = kf(r); if (k == null) continue; if (!g.has(k)) g.set(k, []); g.get(k).push(r); }
    const map = new Map();
    for (const [k, gg] of g) map.set(k, gg.filter(r => fork(r) === 'v7').length / gg.length >= 0.5 ? 'v7' : 'v4');
    const accOn = set => { const s = set.filter(r => map.has(kf(r))); return s.length ? s.filter(r => map.get(kf(r)) === fork(r)).length / s.length : null; };
    const a1 = accOn(H1), a2 = accOn(H2);
    if (a1 == null || a2 == null) continue;
    // Beating the majority-class rate is the bar. Anything under it is worse than always picking v7.
    const better = a2 > Math.max(baseH2, 1 - baseH2) + 0.02;
    console.log('  ' + nm.padEnd(18) + pct(a1).padEnd(30) + pct(a2).padEnd(20) + pct(Math.max(baseH2, 1 - baseH2)) + '      ' + (better ? 'beats base rate' : 'no better than always-v7'));
  }

  switchTest(byWidth(20), 'the ten $20 strategies (width held fixed)');
  switchTest(names, 'all 30 capped variants (width free to change — the winner is partly a size choice)');
  console.log('\n  A switching rule that cannot beat the flat H1-best variant AND the null control out of sample is not a rule.');

  // ── TRYING TO BREAK THE ONE SURVIVING RULE ─────────────────────────────────────────────────────────
  // Only one start-of-day rule clears the null floor, and it reduces to a single bit: on high-BB-width
  // days, prefer v6-20 to v7-20. A two-way split agreeing twice is two observations. Cut the history into
  // FOUR chronological quarters and look at the PAIRED per-day difference (v6-20 minus v7-20) inside each
  // bucket: a real regime effect holds its sign in every quarter; a fitted one does not. The paired form
  // matters — both variants see the identical days, so the day-to-day market noise cancels and the t-stat
  // is on the difference itself rather than on two noisy means.
  function pairBreak(title, A, B, keyFn, order) {
    const g = bucketOf(keyFn);
    const keys = (order || [...g.keys()].sort()).filter(k => g.has(k));
    const Q = 4, qOf = r => Math.min(Q - 1, Math.floor(idx.get(r) / (rows.length / Q)));
    console.log(`\n\nROBUSTNESS — paired daily difference (${A} minus ${B}) by ${title}, split into ${Q} chronological quarters`);
    // The claim "bucket k favours A" is NOT "A beats B inside k" — A may beat B everywhere. The claim is
    // that the A-minus-B edge is DIFFERENT inside k than outside it, so the CONTRAST is the statistic
    // that has to carry the finding.
    console.log('  bucket'.padEnd(14) + 'n'.padEnd(6) + 'mean diff'.padEnd(12) + 'outside'.padEnd(11) + 'contrast t'.padEnd(18)
      + [...Array(Q)].map((_, q) => `Q${q + 1}`.padEnd(11)).join('') + 'sign holds?');
    for (const k of keys) {
      const gg = g.get(k), d = gg.map(r => pnlAt(A, r.i) - pnlAt(B, r.i));
      const out = rows.filter(r => keyFn(r) != null && keyFn(r) !== k).map(r => pnlAt(A, r.i) - pnlAt(B, r.i));
      const m = mean(d);
      const w = welch(d, out);
      const qm = [...Array(Q)].map((_, q) => { const s = gg.filter(r => qOf(r) === q); return s.length ? mean(s.map(r => pnlAt(A, r.i) - pnlAt(B, r.i))) : null; });
      const signs = qm.filter(x => x != null).map(x => Math.sign(x));
      const holds = signs.length && signs.every(s => s === signs[0]);
      console.log('  ' + String(k).padEnd(12) + String(gg.length).padEnd(6) + usd(m).padEnd(12) + usd(mean(out)).padEnd(11)
        + (w ? `${w.t.toFixed(2)} (p ${normP(w.t).toFixed(3)})` : 'n/a').padEnd(18)
        + qm.map(x => (x == null ? '—' : usd(x)).padEnd(11)).join('') + (holds ? 'YES' : 'NO — flips'));
    }
  }
  pairBreak('BB-WIDTH STATE', 'v6-20', 'v7-20', r => r.f.squeeze, ['squeeze', 'normal', 'expanded']);
  pairBreak('VOL STATE', 'v6-20', 'v7-20', r => r.f.volState, ['low-vol', 'mid-vol', 'high-vol']);
  pairBreak('REALIZED LABEL (hindsight — the effect the features are failing to reach)', 'v7-20', 'v4-20', r => r.l.label, ORDER);
})();
