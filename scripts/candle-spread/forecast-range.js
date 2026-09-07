#!/usr/bin/env node
'use strict';
/**
 * FORECAST-RANGE — can we forecast TOMORROW'S RANGE, and does a range forecast pick the variant?
 *
 * WHY THIS QUESTION. Two prior studies (classify-regimes.js, mine-regime-rules.js) established that the
 * variant roster splits on MAGNITUDE, not direction: Spearman rho of daily P&L vs |close-open| is +0.490
 * for v7-10 and -0.312 for v4-20. v7 is structurally LONG the day's movement, v4 is structurally SHORT it.
 * So "which variant today" is really "how big is today". That reframes a 6-way classification (which sank
 * the last attempt on 704 days — argmax over buckets has almost no power) into a REGRESSION on a
 * continuous target, which has far more.
 *
 * THE BAR THAT MATTERS. Volatility is strongly autocorrelated, so a range "forecast" that merely restates
 * trailing ATR is not a finding — it is a restatement of the input. Every model here is therefore scored
 * two ways:
 *   (a) R^2 on the target in POINTS, where the ATR baseline already earns a large R^2, and
 *   (b) R^2 on the target in ATR UNITS (target / ATR14 as of yesterday) against the CONSTANT mean. In (b)
 *       the proportional-ATR forecast IS the constant, so any R^2 above zero is information the ATR
 *       baseline does not already contain. (b) is the honest headline.
 * Everything is also reported OUT OF SAMPLE: fit on the chronological first half (H1), predict the second
 * half (H2), never refit. And separately as a WALK-FORWARD expanding-window forecast so the strategy test
 * has an out-of-sample prediction on every day it can.
 *
 * NO-LOOKAHEAD CONTRACT (inherited verbatim from classify-regimes.js / mine-regime-rules.js)
 *   - prior-day candle + daily BB(20,2)/EMA9/ATR(14) are READ AT INDEX i-1: the bands as of yesterday's
 *     close, which is what is in hand at 09:30 today.
 *   - multi-day / channel / acceleration features read D[i-1], D[i-2], ... only.
 *   - premarket features use bars with ET minute < 570 on day i; the open feature uses ONLY the 09:30
 *     bar's `open` field (bars are stamped at candle START, so that print is the bell).
 *   - trailing percentiles use a trailing window ENDING at i-1, never full-history (a full-history
 *     percentile ranks the past using the future).
 *   - the TARGETS (today's |close-open| and high-low) are session data and never feed a feature.
 *   - the walk-forward model is refit on days STRICTLY BEFORE i, and the H1/H2 split is chronological.
 *
 * PRE-REGISTERED HYPOTHESES (the user's, tested first and separately — a handful of comparisons, not
 * thousands, so they carry almost no multiple-testing burden and are never pooled with the screen below)
 *   R1  MULTI-DAY LOOKBACK: what do the prior 2/3/5 days add over the prior 1 day and over ATR?
 *   R2  CHANNEL / SLOPE CONSISTENCY: regression slope of the highs and of the lows over 3-5 days, the
 *       R^2 of those fits (how CLEAN the channel is), the dispersion of the day-to-day increments, and
 *       whether the two rails are parallel. Does a tight consistent channel forecast a different range
 *       than a ragged one?
 *   R3  ACCELERATION: second difference of the highs / lows / closes — are the increments GROWING? Tested
 *       as a block DISTINCT from slope, and also nested on top of R2 so it has to earn its keep after
 *       slope is already in the model.
 *   R4  (a) BB-width DYNAMICS (expansion/contraction rate, not just level) — a squeeze is the textbook
 *           range-expansion precursor and the RATE is the part the level cannot express.
 *       (b) COMPRESSION / inside-outside / NR7-WR7 — the classic range-contraction-precedes-expansion
 *           family, phrased as rank-within-last-7 so it is scale free.
 *       (c) GAP + PREMARKET — the only features that carry information from the day BEING PREDICTED. The
 *           overnight range is literally the market's own forecast of today's range, so it is the single
 *           most direct candidate available at 09:30 and must be tested apart from the prior-day blocks.
 *       (d) CALENDAR — day-of-week, monthly opex (3rd Friday), month end. Free and estimation-error-free.
 *
 * NULL MODEL. Days are not independent: volatility regimes make both the features and the target strongly
 * autocorrelated, so the nominal F/t p-value on an incremental R^2 is optimistic. Each block therefore
 * also gets an EXACT CIRCULAR-ROTATION null: slide the block's feature rows through all N offsets against
 * the (unrotated) target and baseline, refit, and ask where the real alignment's incremental R^2 ranks.
 * That null preserves the autocorrelation of both sides and destroys only the alignment.
 *
 * BASELINE REPRODUCTION. optsFor() is COPIED VERBATIM from build-backtest-baselines.js, VC.assertForwarded
 * guard included, and every per-variant total is asserted against backtest-baselines.json to the dollar.
 * The script refuses to report anything if they disagree.
 *
 * Usage: node scripts/candle-spread/forecast-range.js [--dataDir D] [--workers N] [--cache F]
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
// Default to the SHARED cache path used by mine-regime-rules.js. The key encodes dataset|days|variants|iv,
// so it can only hit when the P&L is byte-identical anyway, and the reproduction check below is a second
// gate on top of that. Recomputing 30 variants x 765 days takes minutes; the regression iterates far more.
const CACHE = arg('--cache', path.join(os.tmpdir(), 'mine-regime-rules-pnl-cache.json'));
const BASELINES = path.join(__dirname, '..', '..', 'server', 'src', 'candle-spread', 'backtest-baselines.json');
const INTRADAY_IV = true;   // canonical in the committed baselines; required for the dollar match

const usd = n => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');
const pct = n => (n * 100).toFixed(1) + '%';
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const sd = a => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) * (x - m)))); };

const etMin = ms => { const d = new Date(new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York' })); return d.getHours() * 60 + d.getMinutes(); };
const etParts = ms => { const d = new Date(new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York' })); return { dow: d.getDay(), dom: d.getDate(), mon: d.getMonth() }; };
const RTH_OPEN = 570, RTH_CLOSE = 960;

// ══ 1. LOAD + TRADING-DAY FILTER (identical rule to build-backtest-baselines) ═══════════════════════
const allDays = load5mDays(DIR);
if (!allDays.length) { console.error('no days loaded from', DIR); process.exit(1); }
const hasRth = d => d.bars.some(b => { const m = etMin(b.dt); return m >= RTH_OPEN && m < RTH_CLOSE; });
const days = allDays.filter(hasRth);
const HAS_PX = allDays.some(d => d.bars.some(b => b.px));

// ══ 2. DAILY CANDLES + INDICATORS (verbatim from classify-regimes.js) ══════════════════════════════
function dailyCandle(day) {
  const rth = day.bars.filter(b => { const m = etMin(b.dt); return m >= RTH_OPEN && m < RTH_CLOSE; });
  if (!rth.length) return null;
  let hi = -Infinity, lo = Infinity;
  for (const b of rth) { const a = b.analysis['5m']; if (a.high > hi) hi = a.high; if (a.low < lo) lo = a.low; }
  return { date: day.date, dt: rth[0].dt, rth,
    open: rth[0].analysis['5m'].open, high: hi, low: lo, close: rth[rth.length - 1].analysis['5m'].close };
}
const D = days.map(dailyCandle);

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
      const sdv = Math.sqrt(v / 20);
      out[i].bbmiddle = m; out[i].bbupper = m + 2 * sdv; out[i].bblower = m - 2 * sdv; out[i].bbwidth = 4 * sdv;
    }
    out[i].ema9 = ema[i];
    const tr = i === 0 ? D[i].high - D[i].low
      : Math.max(D[i].high - D[i].low, Math.abs(D[i].high - D[i - 1].close), Math.abs(D[i].low - D[i - 1].close));
    out[i].tr = tr;
    if (i >= 13) { let s = 0; for (let j = i - 13; j <= i; j++) s += out[j].tr; out[i].atr14 = s / 14; }
  }
  return out;
}
const IND = dailyIndicators(D);

function trailingPct(arr, i, win) {
  const lo = Math.max(0, i - win + 1);
  const vals = []; for (let j = lo; j <= i; j++) if (arr[j] != null && isFinite(arr[j])) vals.push(arr[j]);
  if (vals.length < 30 || arr[i] == null) return null;
  let c = 0; for (const v of vals) if (v <= arr[i]) c++;
  return c / vals.length;
}
const atrSeries = IND.map(x => x.atr14 == null ? null : x.atr14);
const bbwSeries = IND.map((x, i) => (x.bbwidth == null || !D[i].close) ? null : x.bbwidth / D[i].close);

// OLS slope + R^2 of y on t = 0..k-1. Used for the CHANNEL features: the slope is the rail's advance per
// day and the R^2 is how CONSISTENT that advance is, which is precisely the user's "tight channel vs
// ragged" distinction and cannot be read off the slope alone.
function lineFit(ys) {
  const k = ys.length; if (k < 2) return { slope: 0, r2: 0 };
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let t = 0; t < k; t++) { sx += t; sy += ys[t]; sxx += t * t; sxy += t * ys[t]; }
  const den = k * sxx - sx * sx;
  const slope = den ? (k * sxy - sx * sy) / den : 0;
  const b = (sy - slope * sx) / k;
  let ss = 0, st = 0; const my = sy / k;
  for (let t = 0; t < k; t++) { const e = ys[t] - (b + slope * t); ss += e * e; st += (ys[t] - my) * (ys[t] - my); }
  return { slope, r2: st > 0 ? 1 - ss / st : 0 };
}

// ══ 3. START-OF-DAY FEATURES ═══════════════════════════════════════════════════════════════════════
// Everything below is a function of indices < i, of premarket bars of day i, or of the 09:30 OPEN print.
function featuresFor(i) {
  if (i < 60) return null;                        // daily BB/ATR/percentile warm-up
  const p = D[i - 1], pi = IND[i - 1];
  if (pi.bbupper == null || pi.atr14 == null || !pi.atr14) return null;
  const atr = pi.atr14;
  const f = { date: D[i].date, i, atr };

  // ── the two BASELINE regressors ────────────────────────────────────────────────────────────────
  // atr14 as of yesterday, and yesterday's own range. These two ARE the benchmark every block must beat.
  f.atr14 = atr;
  f.pdRange = p.high - p.low;
  f.pdRangeAtr = f.pdRange / atr;
  f.pdAbsMoveAtr = Math.abs(p.close - p.open) / atr;

  // ── R1  MULTI-DAY LOOKBACK ─────────────────────────────────────────────────────────────────────
  // Mean range and mean |body| over the prior 2/3/5 days, plus the ABSOLUTE net displacement over those
  // windows and the dispersion of daily close-to-close returns. Magnitude question, so everything that
  // could carry a sign is taken in absolute value — a -2 ATR week and a +2 ATR week are the same input to
  // a range forecast, and leaving the sign in would let the fit spend a degree of freedom on direction.
  for (const n of [2, 3, 5]) {
    let sr = 0, sb = 0;
    for (let j = i - n; j <= i - 1; j++) { sr += D[j].high - D[j].low; sb += Math.abs(D[j].close - D[j].open); }
    f['rangeMean' + n] = sr / n / atr;
    f['bodyMean' + n] = sb / n / atr;
    f['absRet' + n] = Math.abs(p.close - D[i - n].close) / atr;
  }
  {
    const rets = []; for (let j = i - 5; j <= i - 1; j++) rets.push(D[j].close - D[j - 1].close);
    f.retSd5 = sd(rets) / atr;
    const rr = []; for (let j = i - 5; j <= i - 1; j++) rr.push(D[j].high - D[j].low);
    f.rangeMax5 = Math.max(...rr) / atr;
    f.rangeMin5 = Math.min(...rr) / atr;
    f.rangeSd5 = sd(rr) / atr;               // how VARIABLE the recent ranges have been
  }

  // ── R2  CHANNEL / SLOPE CONSISTENCY ────────────────────────────────────────────────────────────
  for (const n of [3, 5]) {
    const hs = [], ls = [], cw = [];
    for (let j = i - n; j <= i - 1; j++) { hs.push(D[j].high); ls.push(D[j].low); cw.push(D[j].high - D[j].low); }
    const fh = lineFit(hs), fl = lineFit(ls), fc = lineFit(cw);
    f['slopeHigh' + n] = fh.slope / atr;     // per-day advance of the upper rail, in ATR
    f['slopeLow' + n] = fl.slope / atr;
    f['r2High' + n] = fh.r2;                 // CONSISTENCY of that advance (1 = perfect channel)
    f['r2Low' + n] = fl.r2;
    f['slopeAbs' + n] = Math.abs((fh.slope + fl.slope) / 2) / atr;   // channel speed, sign-free
    f['r2Mean' + n] = (fh.r2 + fl.r2) / 2;                            // channel tightness, sign-free
    f['parallel' + n] = Math.abs(fh.slope - fl.slope) / atr;          // 0 = rails parallel
    f['cwSlope' + n] = fc.slope / atr;                                // is the channel WIDENING day over day
    // Dispersion of the day-to-day INCREMENTS: the ragged-vs-clean measure that is not the regression R^2
    // (R^2 is scale-free and saturates; the dispersion keeps the units and does not).
    const dh = [], dl = [];
    for (let t = 1; t < hs.length; t++) { dh.push(hs[t] - hs[t - 1]); dl.push(ls[t] - ls[t - 1]); }
    f['dispHigh' + n] = sd(dh) / atr;
    f['dispLow' + n] = sd(dl) / atr;
  }

  // ── R3  ACCELERATION (second differences — distinct from slope) ────────────────────────────────
  // Are the increments GROWING bar to bar? accX3 is the plain second difference over the last three days;
  // accX5 is the OLS slope OF THE INCREMENTS over five days, which is the same idea with less noise. Both
  // are also taken in absolute value, because "the moves are getting bigger in either direction" is the
  // range-relevant statement and the signed version is a direction bet.
  {
    const dHi = [], dLo = [], dCl = [];
    for (let j = i - 5; j <= i - 1; j++) { dHi.push(D[j].high - D[j - 1].high); dLo.push(D[j].low - D[j - 1].low); dCl.push(D[j].close - D[j - 1].close); }
    const last = a => a[a.length - 1], prev = a => a[a.length - 2];
    f.accHigh3 = (last(dHi) - prev(dHi)) / atr;
    f.accLow3 = (last(dLo) - prev(dLo)) / atr;
    f.accClose3 = (last(dCl) - prev(dCl)) / atr;
    f.accHigh5 = lineFit(dHi).slope / atr;
    f.accLow5 = lineFit(dLo).slope / atr;
    f.accAbsHigh5 = lineFit(dHi.map(Math.abs)).slope / atr;   // are the moves getting BIGGER (unsigned)
    f.accAbsLow5 = lineFit(dLo.map(Math.abs)).slope / atr;
    // Last increment vs the typical recent increment: >1 means the tape just took a bigger step than usual.
    const m4 = mean(dCl.slice(0, 4).map(Math.abs));
    f.incrRatio = m4 > 0 ? Math.abs(last(dCl)) / m4 : 1;
    // Range momentum: yesterday's range relative to the 5-day mean range. Expansion already under way.
    const rr = []; for (let j = i - 5; j <= i - 1; j++) rr.push(D[j].high - D[j].low);
    f.rangeAccel = mean(rr) > 0 ? (D[i - 1].high - D[i - 1].low) / mean(rr) : 1;
  }

  // ── R4a  BB-WIDTH DYNAMICS ─────────────────────────────────────────────────────────────────────
  f.bbwPct = trailingPct(bbwSeries, i - 1, 252);          // LEVEL (squeeze vs expanded)
  f.bbwChg1 = (bbwSeries[i - 1] != null && bbwSeries[i - 2]) ? bbwSeries[i - 1] / bbwSeries[i - 2] - 1 : null;
  f.bbwChg5 = (bbwSeries[i - 1] != null && bbwSeries[i - 6]) ? bbwSeries[i - 1] / bbwSeries[i - 6] - 1 : null;
  f.bbwChg10 = (bbwSeries[i - 1] != null && bbwSeries[i - 11]) ? bbwSeries[i - 1] / bbwSeries[i - 11] - 1 : null;
  f.atrPct = trailingPct(atrSeries, i - 1, 252);
  f.atrChg5 = (atrSeries[i - 1] != null && atrSeries[i - 6]) ? atrSeries[i - 1] / atrSeries[i - 6] - 1 : null;
  // Where yesterday's close sat inside the bands, and how far outside the rails the day traded. Both are
  // sign-free here on purpose: |%B - 0.5| is "how extended", which is the magnitude-relevant part.
  f.pdPctB = (p.close - pi.bblower) / (pi.bbupper - pi.bblower);
  f.pdExtend = Math.abs(f.pdPctB - 0.5);
  f.pdOutside = Math.max(0, p.high - pi.bbupper, pi.bblower - p.low) / atr;

  // ── R4b  COMPRESSION / INSIDE-OUTSIDE / NR7 ────────────────────────────────────────────────────
  {
    const rr = []; for (let j = i - 7; j <= i - 1; j++) rr.push(D[j].high - D[j].low);
    const y = D[i - 1].high - D[i - 1].low;
    f.nr7 = rr.every(v => y <= v) ? 1 : 0;                 // yesterday was the narrowest of the last 7
    f.wr7 = rr.every(v => y >= v) ? 1 : 0;                 // ... or the widest
    let rank = 0; for (const v of rr) if (v <= y) rank++;
    f.rangeRank7 = rank / rr.length;                        // continuous version of NR7/WR7
    f.insideDay = (p.high <= D[i - 2].high && p.low >= D[i - 2].low) ? 1 : 0;
    f.outsideDay = (p.high > D[i - 2].high && p.low < D[i - 2].low) ? 1 : 0;
    // Consecutive contraction: how many of the last 4 days had a smaller range than the day before.
    let contract = 0;
    for (let j = i - 4; j <= i - 1; j++) if ((D[j].high - D[j].low) < (D[j - 1].high - D[j - 1].low)) contract++;
    f.contract4 = contract / 4;
  }

  // ── R4c  GAP + PREMARKET (the only day-i information) ──────────────────────────────────────────
  const pm = days[i].bars.filter(b => etMin(b.dt) < RTH_OPEN);
  f.pmRangeAtr = null; f.pmRangeRel = null; f.pmAbsDrift = null; f.pmLateAbsDrift = null; f.pmPath = null;
  if (pm.length >= 6) {
    let hi = -Infinity, lo = Infinity;
    for (const b of pm) { const a = b.analysis['5m']; if (a.high > hi) hi = a.high; if (a.low < lo) lo = a.low; }
    const pmRange = hi - lo, pmClose = pm[pm.length - 1].analysis['5m'].close;
    f.pmRangeAtr = pmRange / atr;
    f.pmAbsDrift = Math.abs(pmClose - p.close) / atr;
    const at8 = pm.filter(b => etMin(b.dt) <= 480).pop();
    f.pmLateAbsDrift = at8 ? Math.abs(pmClose - at8.analysis['5m'].close) / atr : null;
    // Overnight PATH length (sum of |close-to-close| across the overnight 5m bars): distinguishes a
    // session that ground out its range from one that gapped once and sat still. The range alone cannot.
    let pth = 0;
    for (let k = 1; k < pm.length; k++) pth += Math.abs(pm[k].analysis['5m'].close - pm[k - 1].analysis['5m'].close);
    f.pmPath = pth / atr;
    // Relative to its OWN trailing 20-day average — "is tonight unusually busy" is a relative question;
    // the raw overnight range just re-reads the vol regime that ATR already carries.
    const hist = [];
    for (let j = i - 1; j >= 0 && hist.length < 20; j--) {
      const q = days[j].bars.filter(b => etMin(b.dt) < RTH_OPEN);
      if (q.length < 6) continue;
      let h2 = -Infinity, l2 = Infinity;
      for (const b of q) { const a = b.analysis['5m']; if (a.high > h2) h2 = a.high; if (a.low < l2) l2 = a.low; }
      hist.push(h2 - l2);
    }
    if (hist.length >= 10) f.pmRangeRel = pmRange / mean(hist);
  }
  f.open = D[i].open;
  f.gapAbsAtr = Math.abs(f.open - p.close) / atr;          // sign-free: magnitude question
  f.openExtend = Math.abs((f.open - pi.bblower) / (pi.bbupper - pi.bblower) - 0.5);

  // ── R4d  CALENDAR ──────────────────────────────────────────────────────────────────────────────
  const ep = etParts(D[i].dt);
  f.dow = ep.dow;
  for (let d2 = 1; d2 <= 5; d2++) f['dow' + d2] = ep.dow === d2 ? 1 : 0;
  f.opex = (ep.dow === 5 && ep.dom >= 15 && ep.dom <= 21) ? 1 : 0;      // monthly 3rd-Friday expiry
  f.monthEnd = (D[i + 1] && etParts(D[i + 1].dt).mon !== ep.mon) ? 1 : 0;
  // monthEnd peeks at the CALENDAR DATE of the next trading day only — no price, no session data. It is
  // knowable from a calendar at 09:30 today. Kept explicit so the contract stays auditable.
  return f;
}

// ══ 4. TARGETS (session data of day i — never a feature) ═══════════════════════════════════════════
function targetFor(i) {
  const d = D[i], rth = d.rth;
  if (rth.length < 30) return null;
  const O = d.open, C = d.close, H = d.high, L = d.low, R = H - L;
  if (!(R > 0)) return null;
  const closes = rth.map(b => b.analysis['5m'].close);
  let path = 0; for (let k = 1; k < closes.length; k++) path += Math.abs(closes[k] - closes[k - 1]);
  return { absMove: Math.abs(C - O), range: R, path, net: C - O, green: C > O ? 1 : 0 };
}

// ══ 5. STRATEGY P&L — optsFor COPIED VERBATIM from build-backtest-baselines.js ═════════════════════
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
  if (v.enforceLegUniqueness) { o.enforceLegUniqueness = true; if (v.legMaxShift != null) o.legMaxShift = v.legMaxShift; if (v.legMaxWing != null) o.legMaxWing = v.legMaxWing; }
  const w = v.spreadWidth, sh = v.spreadShift || 0, cf = v.capFrac;
  o.geo = v.adaptiveGeo
    ? makeAdaptiveGeo({ width: w || 20, incr: 10, maxDebitFrac: cf != null ? cf : 0.65, maxItmStrikes: v.maxItmStrikes != null ? v.maxItmStrikes : 3 })
    : makeGeo({ width: w || 20, shift: sh, capFrac: cf != null ? cf : undefined });
  if (HAS_PX) o.priceOf = (b) => b.px || { close: b.analysis['5m'].close, high: b.analysis['5m'].high, low: b.analysis['5m'].low };
  VC.assertForwarded(v, Object.keys(o), 'forecast-range optsFor',
    ['capitalRecapture', 'openAlternateEvery', 'creditCoverFrac', 'coverToStackMinFrac']);
  return o;
}
const wrap = (v) => (A, p, ctx) => v.signalFn(A, p, { ...ctx, cfg: v.signalCfg || {} });
const RUNS = buildRuns().filter(v => /^v\d+-(10|20|40)$/.test(v.variant));

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
  const key = `${path.basename(DIR)}|${days.length}|${RUNS.map(r => r.variant).join(',')}|iv${INTRADAY_IV}`;
  if (fs.existsSync(CACHE)) {
    try { const c = JSON.parse(fs.readFileSync(CACHE, 'utf8')); if (c.key === key) { console.log('(P&L from cache ' + CACHE + ')'); return c.pnl; } } catch (e) {}
  }
  const pnl = {};
  if (WORKERS > 1) {
    const { spawn } = require('child_process');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forecast-range-pnl-'));
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

// ══ 6. LINEAR ALGEBRA — OLS with a tiny ridge for conditioning ═════════════════════════════════════
// Normal equations on STANDARDIZED columns plus a 1e-8*trace ridge. The ridge is numerical hygiene, not
// regularization: the channel block contains near-collinear pairs (slopeHigh5 / slopeLow5 in a clean
// trend), and without it a singular X'X silently returns garbage coefficients that still produce a
// plausible-looking R^2. Standardizing first is what makes a single fixed ridge constant meaningful
// across blocks whose columns differ in scale by orders of magnitude.
function olsFit(X, y) {
  const n = X.length, k = X[0].length;
  const mu = [], sg = [];
  for (let j = 0; j < k; j++) {
    const col = X.map(r => r[j]); const m = mean(col); const s = sd(col) || 1;
    mu.push(m); sg.push(s);
  }
  const Z = X.map(r => [1].concat(r.map((v, j) => (v - mu[j]) / sg[j])));
  const kk = k + 1;
  const A = Array.from({ length: kk }, () => new Array(kk).fill(0));
  const b = new Array(kk).fill(0);
  for (let t = 0; t < n; t++) {
    const z = Z[t];
    for (let a = 0; a < kk; a++) { b[a] += z[a] * y[t]; for (let c = a; c < kk; c++) A[a][c] += z[a] * z[c]; }
  }
  for (let a = 0; a < kk; a++) for (let c = 0; c < a; c++) A[a][c] = A[c][a];
  let tr = 0; for (let a = 0; a < kk; a++) tr += A[a][a];
  for (let a = 1; a < kk; a++) A[a][a] += 1e-8 * tr / kk;
  // Gaussian elimination with partial pivoting.
  const M = A.map((row, a) => row.concat([b[a]]));
  for (let c = 0; c < kk; c++) {
    let piv = c; for (let r2 = c + 1; r2 < kk; r2++) if (Math.abs(M[r2][c]) > Math.abs(M[piv][c])) piv = r2;
    if (Math.abs(M[piv][c]) < 1e-12) continue;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r2 = 0; r2 < kk; r2++) {
      if (r2 === c) continue;
      const fct = M[r2][c] / M[c][c];
      if (!fct) continue;
      for (let c2 = c; c2 <= kk; c2++) M[r2][c2] -= fct * M[c][c2];
    }
  }
  const beta = new Array(kk).fill(0);
  for (let a = 0; a < kk; a++) beta[a] = Math.abs(M[a][a]) < 1e-12 ? 0 : M[a][kk] / M[a][a];
  return { beta, mu, sg, k };
}
function olsPredict(m, row) {
  let s = m.beta[0];
  for (let j = 0; j < m.k; j++) s += m.beta[j + 1] * ((row[j] - m.mu[j]) / m.sg[j]);
  return s;
}
// R^2 against the mean of the SAME sample. For out-of-sample this is the standard "OOS R^2" and CAN be
// negative, which is the point — a model that is worse than the test period's own mean should be shown as
// worse, not floored at zero.
function r2Of(yTrue, yPred) {
  const m = mean(yTrue);
  let ss = 0, st = 0;
  for (let t = 0; t < yTrue.length; t++) { const e = yTrue[t] - yPred[t]; ss += e * e; st += (yTrue[t] - m) * (yTrue[t] - m); }
  return st > 0 ? 1 - ss / st : 0;
}
// Skill against a NAMED benchmark's errors rather than against the mean: 1 - SSE_model/SSE_bench. This is
// the number the brief asks for — "does it beat trailing ATR, and by how much" — and it is not the same
// as comparing two R^2 values when the benchmark is not the mean.
function skillOf(yTrue, yPred, yBench) {
  let ss = 0, sb = 0;
  for (let t = 0; t < yTrue.length; t++) { const e = yTrue[t] - yPred[t], eb = yTrue[t] - yBench[t]; ss += e * e; sb += eb * eb; }
  return sb > 0 ? 1 - ss / sb : 0;
}
function spearman(a, b) {
  const rank = v => { const ix = v.map((x, k) => [x, k]).sort((p, q) => p[0] - q[0]); const r = new Array(v.length);
    for (let k = 0; k < ix.length;) { let j = k; while (j + 1 < ix.length && ix[j + 1][0] === ix[k][0]) j++;
      const avg = (k + j) / 2 + 1; for (let m = k; m <= j; m++) r[ix[m][1]] = avg; k = j + 1; } return r; };
  const ra = rank(a), rb = rank(b), ma = mean(ra), mb = mean(rb);
  let num = 0, da = 0, db = 0;
  for (let k = 0; k < a.length; k++) { num += (ra[k] - ma) * (rb[k] - mb); da += (ra[k] - ma) ** 2; db += (rb[k] - mb) ** 2; }
  return num / Math.sqrt(da * db);
}
function rollingDD(daily, W) {          // verbatim from build-backtest-baselines.js
  const cum = [0];
  for (let i = 0; i < daily.length; i++) cum.push(cum[i] + daily[i]);
  let maxDrop = 0;
  for (let b = 1; b < cum.length; b++) {
    let peak = -Infinity;
    for (let a = Math.max(0, b - W); a < b; a++) if (cum[a] > peak) peak = cum[a];
    if (peak - cum[b] > maxDrop) maxDrop = peak - cum[b];
  }
  return -Math.round(maxDrop);
}

// ══ 7. REPORT ══════════════════════════════════════════════════════════════════════════════════════
(async () => {
  console.log(`\n${'='.repeat(118)}`);
  console.log('FORECAST-RANGE — can tomorrow\'s RANGE be forecast, and does the forecast pick the variant?');
  console.log('='.repeat(118));
  console.log(`dataset ${path.basename(DIR)} — ${allDays.length} calendar days -> ${days.length} trading days`);
  console.log(`pricing series: ${HAS_PX ? 'cash NDX (px)' : 'signal series'}`);

  const rows = [];
  for (let i = 0; i < D.length; i++) {
    const f = featuresFor(i), t = targetFor(i);
    if (f && t) rows.push({ i, date: D[i].date, f, t });
  }
  const N = rows.length;
  console.log(`${N} forecastable days (first 60 skipped: daily BB/ATR/percentile warm-up), ${rows[0].date} .. ${rows[N - 1].date}`);

  const pnl = await computePnl();

  // ── REPRODUCTION CHECK (blocking) ──
  const base = JSON.parse(fs.readFileSync(BASELINES, 'utf8'));
  console.log('\nBASELINE REPRODUCTION CHECK (must match backtest-baselines.json to the dollar)');
  let bad = 0;
  for (const name of RUNS.map(r => r.variant)) {
    const mineTot = Math.round(pnl[name].reduce((a, b) => a + b, 0));
    const ref = base.variants[name] ? base.variants[name].total : null;
    if (ref == null) continue;
    if (mineTot !== ref) { bad++; console.log(`  ${name.padEnd(10)} mine ${mineTot}  committed ${ref}  delta ${mineTot - ref}  <<< MISMATCH`); }
  }
  for (const k of ['v7-10', 'v7-20', 'v4-20', 'v4-10']) {
    const t = Math.round(pnl[k].reduce((a, b) => a + b, 0));
    console.log(`  ${k.padEnd(8)} ${String(t).padStart(9)} == committed ${String(base.variants[k].total).padStart(9)}  ${t === base.variants[k].total ? 'OK' : 'MISMATCH'}`);
  }
  console.log(`  ${bad === 0 ? 'ALL ' + RUNS.length + ' CAPPED VARIANTS MATCH EXACTLY' : bad + ' MISMATCHES'}`);
  if (bad) { console.error('\nRefusing to report: opts do not reproduce the committed baseline.'); process.exit(1); }
  const P = (name, r) => pnl[name][r.i];

  // ── FEATURE MATRIX: impute missing with the FULL-SAMPLE median, count what was imputed ──
  // Imputation (rather than row-dropping) so every model is fitted on the SAME N and the R^2 values are
  // directly comparable; a block that quietly loses 40 rows would otherwise show a different R^2 for a
  // reason that has nothing to do with its predictive content. The medians are reported so the reader can
  // see how much of any block is imputation.
  const ALLF = Object.keys(rows[0].f).filter(k => k !== 'date' && k !== 'i');
  const MED = {}, MISS = {};
  for (const k of ALLF) {
    const v = rows.map(r => r.f[k]).filter(x => x != null && isFinite(x)).sort((a, b) => a - b);
    MED[k] = v.length ? v[Math.floor(v.length / 2)] : 0;
    MISS[k] = N - v.length;
  }
  const val = (r, k) => { const v = r.f[k]; return (v == null || !isFinite(v)) ? MED[k] : v; };
  const missy = Object.entries(MISS).filter(([, c]) => c > 0);
  console.log(`\nfeature availability: ${ALLF.length} features, ${missy.length} with any missing values` +
    (missy.length ? ' — ' + missy.map(([k, c]) => `${k}:${c}`).join(', ') : ''));

  // ── TARGETS ──
  // Two targets, each in two units. POINTS is the tradeable quantity; ATR UNITS is the same quantity with
  // the trailing-vol level divided out, so a model's R^2 on it is by construction the information the
  // trailing-ATR forecast does not already have.
  const atrV = rows.map(r => r.f.atr14);
  const TARGETS = {
    absMovePts: rows.map(r => r.t.absMove),
    rangePts: rows.map(r => r.t.range),
    absMoveAtr: rows.map((r, t) => r.t.absMove / atrV[t]),
    rangeAtr: rows.map((r, t) => r.t.range / atrV[t]),
  };
  console.log('\nTARGET DISTRIBUTIONS');
  console.log('  target'.padEnd(16) + 'n'.padEnd(7) + 'mean'.padEnd(11) + 'sd'.padEnd(11) + 'p10'.padEnd(11) + 'p50'.padEnd(11) + 'p90'.padEnd(11) + 'lag-1 autocorr (Spearman)');
  for (const [k, y] of Object.entries(TARGETS)) {
    const s = [...y].sort((a, b) => a - b);
    const q = p => s[Math.floor(p * (s.length - 1))];
    const ac = spearman(y.slice(1), y.slice(0, -1));
    console.log('  ' + k.padEnd(14) + String(y.length).padEnd(7) + mean(y).toFixed(2).padEnd(11) + sd(y).toFixed(2).padEnd(11)
      + q(0.10).toFixed(2).padEnd(11) + q(0.50).toFixed(2).padEnd(11) + q(0.90).toFixed(2).padEnd(11) + ac.toFixed(3));
  }

  // ══ SECTION 1 — THE BENCHMARKS ═══════════════════════════════════════════════════════════════════
  const H1 = Math.floor(N / 2);                       // chronological split; H1 = [0,H1), H2 = [H1,N)
  const IDX1 = Array.from({ length: H1 }, (_, t) => t), IDX2 = Array.from({ length: N - H1 }, (_, t) => t + H1);
  const sub = (arr, ix) => ix.map(t => arr[t]);
  const mat = (keys) => rows.map(r => keys.map(k => val(r, k)));

  function evalModel(keys, y) {
    const X = mat(keys);
    const full = olsFit(X, y);
    const inPred = X.map(x => olsPredict(full, x));
    const m1 = olsFit(sub(X, IDX1), sub(y, IDX1));
    const oosPred = sub(X, IDX2).map(x => olsPredict(m1, x));
    return { r2In: r2Of(y, inPred), r2Oos: r2Of(sub(y, IDX2), oosPred), oosPred, inPred, k: keys.length };
  }

  console.log(`\n\n${'='.repeat(118)}`);
  console.log('SECTION 1 — THE BENCHMARKS. Does anything beat trailing ATR?');
  console.log('='.repeat(118));
  console.log(`chronological split: H1 = ${rows[0].date}..${rows[H1 - 1].date} (${H1} days), H2 = ${rows[H1].date}..${rows[N - 1].date} (${N - H1} days)`);
  console.log('models are fit on H1 ONLY and applied blind to H2. "R2 in" is the full-sample fit (optimistic by construction).\n');

  // The naive benchmarks need NO fitting at all, which is what makes them honest reference points.
  const BENCH = {
    'B0 constant (H1 mean)': null,          // handled specially
    'B1 yesterday range': ['pdRangeAtr'],
    'B2 ATR14 only': ['atr14'],
    'B3 ATR + yest range': ['atr14', 'pdRangeAtr'],
    'B4 ATR + yest range + 5d mean range': ['atr14', 'pdRangeAtr', 'rangeMean5'],
  };
  const benchOos = {};   // per target: the OOS prediction vector of the reference benchmark
  for (const tname of ['rangePts', 'absMovePts', 'rangeAtr', 'absMoveAtr']) {
    const y = TARGETS[tname];
    console.log(`  TARGET = ${tname}`);
    console.log('    model'.padEnd(40) + 'k'.padEnd(4) + 'R2 in'.padEnd(11) + 'R2 OOS(H2)'.padEnd(13) + 'OOS RMSE'.padEnd(12) + 'skill vs B2-OOS');
    // B0
    {
      const mu1 = mean(sub(y, IDX1));
      const p2 = IDX2.map(() => mu1);
      const rm = Math.sqrt(mean(IDX2.map((t, q) => (y[t] - p2[q]) ** 2)));
      console.log('    ' + 'B0 constant (H1 mean)'.padEnd(38) + '0'.padEnd(4) + '0.000'.padEnd(11)
        + r2Of(sub(y, IDX2), p2).toFixed(4).padEnd(13) + rm.toFixed(2).padEnd(12) + '—');
      benchOos[tname + '|B0'] = p2;
    }
    let b2p = null;
    for (const [nm, keys] of Object.entries(BENCH)) {
      if (!keys) continue;
      const e = evalModel(keys, y);
      if (nm.startsWith('B2')) b2p = e.oosPred;
      const rm = Math.sqrt(mean(IDX2.map((t, q) => (y[t] - e.oosPred[q]) ** 2)));
      const sk = b2p ? skillOf(sub(y, IDX2), e.oosPred, b2p) : 0;
      console.log('    ' + nm.padEnd(38) + String(e.k).padEnd(4) + e.r2In.toFixed(4).padEnd(11)
        + e.r2Oos.toFixed(4).padEnd(13) + rm.toFixed(2).padEnd(12) + (nm.startsWith('B2') ? '(reference)' : sk.toFixed(4)));
    }
    benchOos[tname] = b2p;
    console.log('');
  }

  // ══ SECTION 2 — PRE-REGISTERED BLOCKS ════════════════════════════════════════════════════════════
  // Each block is added ON TOP of the B3 baseline (ATR + yesterday's range). The question is never "does
  // this block predict range" — almost anything correlated with vol does — it is "does it add anything
  // the trailing-vol benchmark does not already have". So the reported numbers are DELTAS.
  // BASELINE, PER TARGET. Section 1 shows why this cannot be one list: raw `atr14` is a LEVEL regressor in
  // points, and on an ATR-NORMALIZED target it is not just useless but actively harmful out of sample
  // (rangeAtr OOS R2 -0.307 for B2 vs -0.001 for the constant) — H2's ATR level sits outside H1's range, so
  // the fitted level coefficient extrapolates. On the ATR-unit targets the honest baseline is therefore the
  // scale-free one: yesterday's range measured in ATR. On the points targets it is ATR + yesterday's range.
  const BASE_FOR = t => (t.endsWith('Atr') ? ['pdRangeAtr'] : ['atr14', 'pdRangeAtr']);
  const BLOCKS = {
    'R1 multi-day (2/3/5d)': ['rangeMean2', 'rangeMean3', 'rangeMean5', 'bodyMean3', 'bodyMean5', 'absRet2', 'absRet3', 'absRet5', 'retSd5', 'rangeSd5', 'rangeMax5', 'rangeMin5'],
    'R2 channel slope+consistency': ['slopeAbs3', 'slopeAbs5', 'r2Mean3', 'r2Mean5', 'r2High5', 'r2Low5', 'parallel5', 'cwSlope5', 'dispHigh5', 'dispLow5'],
    'R3 acceleration': ['accHigh3', 'accLow3', 'accClose3', 'accHigh5', 'accLow5', 'accAbsHigh5', 'accAbsLow5', 'incrRatio', 'rangeAccel'],
    'R4a BB-width dynamics': ['bbwPct', 'bbwChg1', 'bbwChg5', 'bbwChg10', 'atrPct', 'atrChg5', 'pdExtend', 'pdOutside'],
    'R4b compression / inside-outside': ['nr7', 'wr7', 'rangeRank7', 'insideDay', 'outsideDay', 'contract4'],
    'R4c gap + premarket (day-i info)': ['gapAbsAtr', 'pmRangeAtr', 'pmRangeRel', 'pmAbsDrift', 'pmLateAbsDrift', 'pmPath', 'openExtend'],
    // Friday (dow5) is the omitted reference level — dow1..dow5 plus the intercept is EXACTLY rank
    // deficient, and a rank-deficient normal-equations solve with only a numerical ridge returns
    // plausible-looking garbage rather than failing.
    'R4d calendar': ['dow1', 'dow2', 'dow3', 'dow4', 'opex', 'monthEnd'],
  };
  console.log(`\n${'='.repeat(118)}`);
  console.log('SECTION 2 — PRE-REGISTERED HYPOTHESIS BLOCKS, each added ON TOP of the target-appropriate baseline');
  console.log('='.repeat(118));
  console.log('  BASE for the *Pts targets = ATR14 + yesterday\'s range (= B3). BASE for the *Atr targets =');
  console.log('  yesterday\'s range in ATR units only (see Section 1: a raw points-scale ATR regressor on an');
  console.log('  ATR-normalized target extrapolates badly out of sample and is worse than the constant).');
  console.log('  dR2 in   = full-sample R2 gain over B3 (always >= 0 by construction — a block with k features');
  console.log('             cannot lower the in-sample R2, so this number is NOT evidence of anything on its own).');
  console.log('  dR2 OOS  = H2 R2 gain over B3, both fit on H1 only. THIS is the number that counts.');
  console.log('  rot p    = exact circular-rotation null on the FULL-SAMPLE dR2: all N offsets of the block\'s');
  console.log('             feature rows against the unrotated target; p = share with dR2 >= observed. The null');
  console.log('             preserves the autocorrelation of features AND target and destroys only alignment.');
  console.log('  Bonferroni bar for 7 pre-registered blocks: p < 0.0071.\n');

  const ROT_STRIDE = 1;   // exact: every offset
  function makeRotR2(keys, y, baseKeys) {
    const XB = mat(baseKeys);                    // hoisted: rebuilt per rotation it dominates the runtime
    const XK = mat(keys);
    const X = XB.map(b => b.slice().concat(new Array(keys.length).fill(0)));   // reused buffer
    const nb = baseKeys.length;
    return (offset) => {
      for (let t = 0; t < N; t++) { const src = XK[(t + offset) % N]; for (let j = 0; j < keys.length; j++) X[t][nb + j] = src[j]; }
      const m = olsFit(X, y);
      return r2Of(y, X.map(x => olsPredict(m, x)));
    };
  }

  for (const tname of ['rangeAtr', 'absMoveAtr', 'rangePts', 'absMovePts']) {
    const y = TARGETS[tname];
    const BASE_KEYS = BASE_FOR(tname);
    const b3 = evalModel(BASE_KEYS, y);
    const b3r2In = b3.r2In, b3r2Oos = b3.r2Oos;
    console.log(`  TARGET = ${tname}   BASE = [${BASE_KEYS.join(', ')}]   (R2 in ${b3r2In.toFixed(4)}, R2 OOS ${b3r2Oos.toFixed(4)})`);
    console.log('    block'.padEnd(38) + 'k'.padEnd(4) + 'R2 in'.padEnd(10) + 'dR2 in'.padEnd(10) + 'R2 OOS'.padEnd(11) + 'dR2 OOS'.padEnd(11) + 'skill vs BASE-OOS'.padEnd(19) + 'rot p'.padEnd(9) + 'clears .0071?');
    for (const [nm, keys] of Object.entries(BLOCKS)) {
      const e = evalModel(BASE_KEYS.concat(keys), y);
      const obs = e.r2In - b3r2In;
      const rotR2 = makeRotR2(keys, y, BASE_KEYS);
      let ge = 0, tot = 0;
      for (let off = 0; off < N; off += ROT_STRIDE) { tot++; if (rotR2(off) - b3r2In >= obs - 1e-12) ge++; }
      const p = ge / tot;
      const sk = skillOf(sub(y, IDX2), e.oosPred, b3.oosPred);
      console.log('    ' + nm.padEnd(36) + String(keys.length).padEnd(4) + e.r2In.toFixed(4).padEnd(10) + obs.toFixed(4).padEnd(10)
        + e.r2Oos.toFixed(4).padEnd(11) + ((e.r2Oos - b3r2Oos >= 0 ? '+' : '') + (e.r2Oos - b3r2Oos).toFixed(4)).padEnd(11)
        + sk.toFixed(4).padEnd(19) + p.toFixed(4).padEnd(9) + (p < 0.0071 ? 'YES' : 'no'));
    }
    // R3 nested on top of R2 — the brief asks explicitly whether acceleration is distinct from slope.
    {
      const r2keys = BLOCKS['R2 channel slope+consistency'], r3keys = BLOCKS['R3 acceleration'];
      const a = evalModel(BASE_KEYS.concat(r2keys), y);
      const b = evalModel(BASE_KEYS.concat(r2keys, r3keys), y);
      console.log('    ' + '  (R3 nested ON TOP of R2)'.padEnd(36) + String(r3keys.length).padEnd(4) + b.r2In.toFixed(4).padEnd(10)
        + (b.r2In - a.r2In).toFixed(4).padEnd(10) + b.r2Oos.toFixed(4).padEnd(11) + ((b.r2Oos - a.r2Oos >= 0 ? '+' : '') + (b.r2Oos - a.r2Oos).toFixed(4)).padEnd(11)
        + skillOf(sub(y, IDX2), b.oosPred, a.oosPred).toFixed(4));
    }
    // ALL blocks together — the kitchen sink, shown to expose the overfitting gap between in and OOS.
    // And ALL-BUT-R4c, which is the question the kitchen sink cannot answer: is anything in the six
    // PRIOR-DAY blocks doing work once the premarket block is removed, or is R4c carrying the whole thing?
    for (const [lbl, allk] of [
      ['ALL BLOCKS (kitchen sink)', [].concat(...Object.values(BLOCKS))],
      ['ALL BLOCKS except R4c (prior-day only)', [].concat(...Object.entries(BLOCKS).filter(([k]) => !k.startsWith('R4c')).map(([, v]) => v))],
      ['R4c ALONE, no other block', BLOCKS['R4c gap + premarket (day-i info)']],
    ]) {
      const e = evalModel(BASE_KEYS.concat(allk), y);
      console.log('    ' + lbl.padEnd(36) + String(allk.length).padEnd(4) + e.r2In.toFixed(4).padEnd(10)
        + (e.r2In - b3r2In).toFixed(4).padEnd(10) + e.r2Oos.toFixed(4).padEnd(11) + ((e.r2Oos - b3r2Oos >= 0 ? '+' : '') + (e.r2Oos - b3r2Oos).toFixed(4)).padEnd(11)
        + skillOf(sub(y, IDX2), e.oosPred, b3.oosPred).toFixed(4));
    }
    console.log('');
  }

  // ══ SECTION 3 — UNIVARIATE SCREEN (searched — read with the multiplicity in mind) ════════════════
  console.log(`${'='.repeat(118)}`);
  console.log('SECTION 3 — UNIVARIATE SCREEN: partial Spearman of each feature with rangeAtr AFTER removing B3');
  console.log('='.repeat(118));
  console.log('  This is a SEARCH over ' + ALLF.length + ' features, so no single row here is a finding on its own; it is a map of');
  console.log('  where the signal in Section 2 is concentrated. Partial = correlation of the feature with the BASE');
  console.log('  RESIDUAL, so anything that is merely a restatement of yesterday\'s range scores ~0. Pearson is shown');
  console.log('  next to Spearman because the OLS blocks above are LINEAR: a feature with a large rank correlation');
  console.log('  and a small Pearson is signal the linear model in Section 2 cannot pick up.\n');
  {
    const y = TARGETS.rangeAtr;
    const b3 = evalModel(BASE_FOR('rangeAtr'), y);
    const resid = y.map((v, t) => v - b3.inPred[t]);
    const pearson = (a, b) => { const ma = mean(a), mb = mean(b); let n2 = 0, da = 0, db = 0;
      for (let k = 0; k < a.length; k++) { n2 += (a[k] - ma) * (b[k] - mb); da += (a[k] - ma) ** 2; db += (b[k] - mb) ** 2; }
      return da > 0 && db > 0 ? n2 / Math.sqrt(da * db) : 0; };
    const scored = ALLF.filter(k => !['atr14', 'open', 'date', 'i', 'dow'].includes(k)).map(k => {
      const x = rows.map(r => val(r, k));
      return { k, rho: spearman(x, resid), rhoRaw: spearman(x, y), pr: pearson(x, resid) };
    }).filter(r => isFinite(r.rho)).sort((a, b) => Math.abs(b.rho) - Math.abs(a.rho));
    console.log('    rank  feature'.padEnd(38) + 'partial Spearman'.padEnd(19) + 'partial Pearson'.padEnd(18) + 'raw Spearman'.padEnd(15) + '|z| = rho*sqrt(n-1)');
    scored.slice(0, 20).forEach((r, ix) => console.log('    ' + String(ix + 1).padEnd(6) + r.k.padEnd(30)
      + r.rho.toFixed(4).padEnd(19) + r.pr.toFixed(4).padEnd(18) + r.rhoRaw.toFixed(4).padEnd(15) + Math.abs(r.rho * Math.sqrt(N - 1)).toFixed(2)));
    console.log('    ... ' + (scored.length - 20) + ' more features below |rho| ' + Math.abs(scored[20].rho).toFixed(4));
    console.log('\n    Bonferroni |z| bar for ' + scored.length + ' screened features at 0.05: ' +
      (2.807 + 0.5 * Math.log(scored.length / 10)).toFixed(2) + ' (approx two-sided normal quantile of 0.05/' + scored.length + ')');
  }

  // ══ SECTION 4 — DOES IT PAY? ═════════════════════════════════════════════════════════════════════
  console.log(`\n${'='.repeat(118)}`);
  console.log('SECTION 4 — DOES A RANGE FORECAST SELECT THE VARIANT?');
  console.log('='.repeat(118));

  // MECHANISM (re-derived here rather than quoted, so this script stands alone).
  {
    const absMove = rows.map(r => r.t.absMove), rng = rows.map(r => r.t.range);
    console.log('\n  MECHANISM CHECK — Spearman of daily P&L vs the day\'s realized magnitude (re-derived, not quoted)');
    console.log('    variant'.padEnd(12) + 'rho vs |close-open|'.padEnd(23) + 'rho vs high-low range');
    for (const n of ['v7-10', 'v7-20', 'v9-20', 'v0-20', 'v5-20', 'v6-20', 'v4-10', 'v4-20'])
      console.log('    ' + n.padEnd(10) + spearman(rows.map(r => P(n, r)), absMove).toFixed(3).padEnd(23) + spearman(rows.map(r => P(n, r)), rng).toFixed(3));
  }

  // WALK-FORWARD FORECAST. Expanding window, refit every day on days STRICTLY BEFORE t, minimum 250 days
  // of history. This gives an honest out-of-sample prediction on ~2/3 of the sample rather than only on
  // H2, which matters because the strategy comparison is dollar-weighted and 350 days is thin.
  const WF_MIN = 250;
  function walkForward(keys, y) {
    const X = mat(keys);
    const pred = new Array(N).fill(null);
    for (let t = WF_MIN; t < N; t++) {
      const m = olsFit(X.slice(0, t), y.slice(0, t));
      pred[t] = olsPredict(m, X[t]);
    }
    return pred;
  }
  const yRP = TARGETS.rangePts, yAP = TARGETS.absMovePts;
  const PTS_BASE = ['atr14', 'pdRangeAtr'];
  const ALLK = [].concat(...Object.values(BLOCKS));
  const R4C = BLOCKS['R4c gap + premarket (day-i info)'];
  // TWO forecast families, because they are NOT the same question. The RANGE (high-low) is the quantity
  // the brief asks about; |close-open| is the quantity the mechanism check says the variants actually
  // trade (v7-10 rho +0.490 vs |close-open| but only +0.271 vs range). If range turns out to be far more
  // forecastable than |close-open|, then the forecastable quantity is not the payoff-relevant one, and
  // that gap is the answer to "does it pay" — so both must be measured side by side.
  const FORECASTS = {
    'RANGE: ATR only (control)': walkForward(['atr14'], yRP),
    'RANGE: B3 (ATR+yest rng)': walkForward(PTS_BASE, yRP),
    'RANGE: B3 + R4c premkt': walkForward(PTS_BASE.concat(R4C), yRP),
    'RANGE: B3 + all blocks': walkForward(PTS_BASE.concat(ALLK), yRP),
    '|C-O|: ATR only (control)': walkForward(['atr14'], yAP),
    '|C-O|: B3 + R4c premkt': walkForward(PTS_BASE.concat(R4C), yAP),
    '|C-O|: B3 + all blocks': walkForward(PTS_BASE.concat(ALLK), yAP),
  };
  const WFIDX = Array.from({ length: N - WF_MIN }, (_, t) => t + WF_MIN);
  console.log(`\n  WALK-FORWARD FORECAST QUALITY (expanding window, refit daily, min ${WF_MIN} days history)`);
  console.log(`  evaluated on the ${WFIDX.length} days ${rows[WF_MIN].date} .. ${rows[N - 1].date}`);
  console.log('    forecast'.padEnd(30) + 'target'.padEnd(12) + 'R2'.padEnd(11) + 'RMSE (pts)'.padEnd(13) + 'skill vs its ATR-only'.padEnd(23) + 'Spearman(pred, actual)');
  for (const [nm, pr] of Object.entries(FORECASTS)) {
    const isRange = nm.startsWith('RANGE');
    const yv = isRange ? yRP : yAP;
    const ctl = FORECASTS[isRange ? 'RANGE: ATR only (control)' : '|C-O|: ATR only (control)'];
    const yt = WFIDX.map(t => yv[t]), yp = WFIDX.map(t => pr[t]), yb = WFIDX.map(t => ctl[t]);
    console.log('    ' + nm.padEnd(28) + (isRange ? 'rangePts' : 'absMovePts').padEnd(12) + r2Of(yt, yp).toFixed(4).padEnd(11)
      + Math.sqrt(mean(yt.map((v, q) => (v - yp[q]) ** 2))).toFixed(1).padEnd(13)
      + (nm.includes('ATR only') ? '(reference)' : skillOf(yt, yp, yb).toFixed(4)).padEnd(23)
      + spearman(yp, yt).toFixed(3));
  }

  // ── QUINTILE VIEW: the descriptive question, before any rule is fitted ──
  console.log('\n  DOES THE FORECAST SEPARATE THE VARIANTS? — walk-forward days split into quintiles of the');
  console.log('  PREDICTED range, then each variant\'s realized avg P&L/day inside each quintile.');
  function quintileTable(pred, variants, label) {
    const ix = [...WFIDX].sort((a, b) => pred[a] - pred[b]);
    const Q = 5, per = Math.floor(ix.length / Q);
    console.log(`\n    [${label}]`);
    console.log('      quintile'.padEnd(12) + 'n'.padEnd(6) + 'pred range'.padEnd(13) + 'actual range'.padEnd(14)
      + variants.map(v => v.padEnd(12)).join('') + 'v7 minus v4');
    for (let q = 0; q < Q; q++) {
      const g = ix.slice(q * per, q === Q - 1 ? ix.length : (q + 1) * per);
      const line = '      Q' + (q + 1) + (q === 0 ? ' (low)' : q === Q - 1 ? ' (high)' : '     ');
      const v7 = mean(g.map(t => P(variants[0], rows[t]))), v4 = mean(g.map(t => P(variants[1], rows[t])));
      console.log(line.padEnd(12) + String(g.length).padEnd(6) + Math.round(mean(g.map(t => pred[t]))).toString().padEnd(13)
        + Math.round(mean(g.map(t => yRP[t]))).toString().padEnd(14)
        + variants.map(v => usd(mean(g.map(t => P(v, rows[t])))).padEnd(12)).join('') + usd(v7 - v4));
    }
  }
  quintileTable(FORECASTS['RANGE: B3 + all blocks'], ['v7-20', 'v4-20', 'v6-20', 'v0-20'], '$20 width, forecast = RANGE, B3 + all blocks');
  quintileTable(FORECASTS['RANGE: B3 + all blocks'], ['v7-10', 'v4-10', 'v6-10', 'v0-10'], '$10 width, forecast = RANGE, B3 + all blocks');
  quintileTable(FORECASTS['|C-O|: B3 + all blocks'], ['v7-20', 'v4-20', 'v6-20', 'v0-20'], '$20 width, forecast = |CLOSE-OPEN|, B3 + all blocks');
  quintileTable(FORECASTS['|C-O|: B3 + all blocks'], ['v7-10', 'v4-10', 'v6-10', 'v0-10'], '$10 width, forecast = |CLOSE-OPEN|, B3 + all blocks');
  quintileTable(FORECASTS['RANGE: ATR only (control)'], ['v7-20', 'v4-20', 'v6-20', 'v0-20'], '$20 width, forecast = ATR ONLY (the control)');
  // ORACLE: the same tables on the ACTUAL realized quantities. Not tradeable — they are the CEILING, and
  // they are the only way to separate "the forecast is too weak" from "there is no money in the question".
  quintileTable(rows.map(r => r.t.range), ['v7-20', 'v4-20', 'v6-20', 'v0-20'], '$20 width, ORACLE on actual RANGE — NOT TRADEABLE, this is the ceiling');
  quintileTable(rows.map(r => r.t.absMove), ['v7-20', 'v4-20', 'v6-20', 'v0-20'], '$20 width, ORACLE on actual |CLOSE-OPEN| — NOT TRADEABLE, this is the ceiling');
  quintileTable(rows.map(r => r.t.absMove), ['v7-10', 'v4-10', 'v6-10', 'v0-10'], '$10 width, ORACLE on actual |CLOSE-OPEN| — NOT TRADEABLE, this is the ceiling');

  // ── THE SWITCHER ──
  // Rule: predicted range above a threshold -> the range-LONG variant (v7), else the range-SHORT one (v4).
  // The threshold is chosen ON TRAINING DATA ONLY, walk-forward: at each day t it is the median of the
  // predictions made for days < t. A fixed threshold picked over the whole sample would be a third free
  // parameter fitted on the test set.
  // The running threshold is maintained by INSERTION into a kept-sorted array rather than re-sorting the
  // history at every step: the rotation null below re-runs this ~450 times per width, and the re-sort
  // version made that the slowest thing in the script by an order of magnitude. Numerically identical.
  function switcher(pred, longV, shortV, qCut) {
    const out = []; const s = [];
    for (const t of WFIDX) {
      let pick;
      if (s.length < 50) pick = longV;
      else pick = pred[t] >= s[Math.floor(qCut * (s.length - 1))] ? longV : shortV;
      out.push({ t, pick, pnl: P(pick, rows[t]) });
      const v = pred[t];                                  // insert AFTER deciding: strictly prior days only
      let lo = 0, hi = s.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (s[mid] < v) lo = mid + 1; else hi = mid; }
      s.splice(lo, 0, v);
    }
    return out;
  }
  function summarize(daily, label) {
    const tot = daily.reduce((a, b) => a + b, 0);
    const dd = rollingDD(daily, 30);
    const s = sd(daily);
    // `eff` is the repo's headline (total/|maxDD30|) and is kept for comparability, but maxDD30 is a
    // SINGLE-WINDOW extremum estimated from one path: it moves a long way on one bad month and is the
    // least stable statistic in this table. `ret/vol` (avg per day over sd per day) uses all 454 days and
    // is reported beside it precisely so a ranking that flips between the two can be spotted as noise.
    return { label, tot, avg: tot / daily.length, dd, eff: dd ? Math.round(tot / Math.abs(dd) * 10) / 10 : null,
      win: daily.filter(x => x > 0).length / daily.length, sd: s, rv: s > 0 ? (tot / daily.length) / s : 0 };
  }
  // The tilted blend, factored out so the rotation null can re-run the exact same rule on a rotated
  // forecast. w = 0.5 + k*z with z standardized against PRIOR predictions only.
  function tiltBlend(pred, L, S, k) {
    const daily = []; const seen = [];
    for (const t of WFIDX) {
      let w = 0.5;
      if (seen.length >= 50) { const m = mean(seen), s = sd(seen) || 1; w = Math.max(0, Math.min(1, 0.5 + k * (pred[t] - m) / s)); }
      daily.push(w * P(L, rows[t]) + (1 - w) * P(S, rows[t]));
      seen.push(pred[t]);
    }
    return daily;
  }
  function payTable(width, pred, predLabel) {
    const L = `v7-${width}`, S = `v4-${width}`;
    console.log(`\n  [$${width} WIDTH]  forecast = ${predLabel}   (${WFIDX.length} walk-forward days, ${rows[WF_MIN].date}..${rows[N - 1].date})`);
    const cands = [];
    cands.push(summarize(WFIDX.map(t => P(L, rows[t])), `always ${L}`));
    cands.push(summarize(WFIDX.map(t => P(S, rows[t])), `always ${S}`));
    cands.push(summarize(WFIDX.map(t => 0.5 * P(L, rows[t]) + 0.5 * P(S, rows[t])), `50/50 blend ${L}+${S}`));
    for (const q of [0.3, 0.4, 0.5, 0.6, 0.7]) {
      const sw = switcher(pred, L, S, q);
      cands.push(Object.assign(summarize(sw.map(x => x.pnl), `switch at q${(q * 100).toFixed(0)} (${sw.filter(x => x.pick === L).length}/${sw.length} days ${L})`), { sw }));
    }
    // CONTINUOUS TILT of the 50/50 blend instead of a hard switch. The blend is the current best known
    // approach, so the fair question is not "switch or not" but "can the forecast improve the WEIGHT".
    // w = 0.5 + k*z, clipped to [0,1], where z is the prediction standardized against PRIOR predictions
    // only (so the standardization is itself walk-forward and cannot see the test day's own distribution).
    for (const k of [0.15, 0.30, 0.50]) cands.push(summarize(tiltBlend(pred, L, S, k), `blend TILTED by forecast, k=${k.toFixed(2)}`));
    // ORACLE switches on the ACTUAL realized quantities — the ceilings of this idea.
    for (const [onm, ov] of [['range', yRP], ['|C-O|', yAP]]) {
      const hist = WFIDX.map(t => ov[t]).sort((a, b) => a - b);
      const cut = hist[Math.floor(0.5 * (hist.length - 1))];
      cands.push(summarize(WFIDX.map(t => P(ov[t] >= cut ? L : S, rows[t])), `ORACLE switch on actual ${onm} (NOT tradeable)`));
    }
    // ORACLE per-day pick — the absolute ceiling of variant selection, tradeable by nobody. It exists to
    // put the switchers' gains on a scale: a rule that captures 2% of this gap is not a strategy.
    cands.push(summarize(WFIDX.map(t => Math.max(P(L, rows[t]), P(S, rows[t]))), 'ORACLE per-day best-of-2 (NOT tradeable)'));
    console.log('    strategy'.padEnd(52) + 'total'.padEnd(14) + 'avg/day'.padEnd(11) + 'sd/day'.padEnd(10) + 'win%'.padEnd(8) + 'maxDD30'.padEnd(12) + 'efficiency'.padEnd(13) + 'ret/vol (stable)');
    for (const c of cands)
      console.log('    ' + c.label.padEnd(50) + usd(c.tot).padEnd(14) + usd(c.avg).padEnd(11) + usd(c.sd).padEnd(10)
        + pct(c.win).padEnd(8) + usd(c.dd).padEnd(12) + (c.eff == null ? '—' : c.eff.toFixed(1)).padEnd(13) + c.rv.toFixed(3));
    return cands;
  }
  console.log(`\n  STRATEGY SELECTION. "efficiency" is the repo's Calmar-like total/|maxDD30|, computed here over the`);
  console.log('  walk-forward window only, so it is NOT comparable to the full-history numbers in backtest-baselines.json.');
  console.log('  Width is held fixed inside each block: it is a size dial (lossMax $6k/$7k/$9k at $10/$20/$40).');
  // ANCHOR the blend construction against the number the user already has, on the FULL history, so the
  // shorter walk-forward efficiencies below can be read as a window effect rather than a different rule.
  console.log('\n  ANCHOR — the 50/50 blend on the FULL ' + N + '-day history (same construction, no walk-forward window):');
  for (const [L, S] of [['v7-10', 'v4-10'], ['v7-20', 'v4-20']]) {
    const d = rows.map(r => 0.5 * P(L, r) + 0.5 * P(S, r));
    const t = d.reduce((a, b) => a + b, 0), dd = rollingDD(d, 30);
    console.log(`    50/50 ${L}+${S}: total ${usd(t)}, maxDD30 ${usd(dd)}, efficiency ${(t / Math.abs(dd)).toFixed(1)}`);
  }
  for (const w of [10, 20]) {
    payTable(w, FORECASTS['RANGE: B3 + all blocks'], 'RANGE forecast (B3 + all blocks)');
    payTable(w, FORECASTS['|C-O|: B3 + all blocks'], '|CLOSE-OPEN| forecast (B3 + all blocks) — the payoff-relevant target');
    payTable(w, FORECASTS['RANGE: ATR only (control)'], 'ATR ONLY (control — is the forecast adding anything?)');
  }

  // ── ROTATION NULL ON THE SWITCHER ──
  // The switcher has free choices (which variant is "long", the threshold grid). The honest control is to
  // keep the forecast series EXACTLY as it is — same distribution, same autocorrelation, same switch
  // frequency — and rotate it against the P&L, then ask where the real alignment ranks. Anything the
  // rotated version reproduces is what noise produces from a rule of this shape.
  console.log(`\n  ROTATION NULL ON THE SWITCHER — the forecast series is circularly rotated against the P&L`);
  console.log('  (preserving its own distribution and autocorrelation) and the whole switch rule is re-run.');
  console.log('  All ' + WFIDX.length + ' offsets are evaluated, so this is exact.');
  console.log('  BOTH rules are tested: the q50 SWITCH and the k=0.30 TILT (the tilt is the only variant that beats');
  console.log('  the flat 50/50 blend on the repo\'s efficiency metric, so it is the one that most needs a control).');
  console.log('    width  rule              forecast   real total       real eff   null mean total   null p(total)  null p(eff)');
  for (const [w, fname] of [[10, 'RANGE: B3 + all blocks'], [10, '|C-O|: B3 + all blocks'], [20, 'RANGE: B3 + all blocks'], [20, '|C-O|: B3 + all blocks']]) {
    const L = `v7-${w}`, S = `v4-${w}`;
    const pred = FORECASTS[fname];
    const M = WFIDX.length;
    const pv = WFIDX.map(t => pred[t]);
    for (const [rname, run] of [
      ['switch q50', p => switcher(p, L, S, 0.5).map(x => x.pnl)],
      ['tilt k=0.30', p => tiltBlend(p, L, S, 0.30)],
    ]) {
      const real = run(pred);
      const realTot = real.reduce((a, b) => a + b, 0), realDD = rollingDD(real, 30);
      const realEff = realDD ? realTot / Math.abs(realDD) : 0;
      let geT = 0, geE = 0, sumT = 0;
      for (let off = 0; off < M; off++) {
        const rot = {};
        for (let q = 0; q < M; q++) rot[WFIDX[q]] = pv[(q + off) % M];
        const d2 = run(rot);
        const tt = d2.reduce((a, b) => a + b, 0);
        const dd2 = rollingDD(d2, 30);
        sumT += tt;
        if (tt >= realTot) geT++;
        if (dd2 && tt / Math.abs(dd2) >= realEff) geE++;
      }
      console.log('    $' + String(w).padEnd(6) + rname.padEnd(18) + fname.split(':')[0].padEnd(11) + usd(realTot).padEnd(17) + realEff.toFixed(1).padEnd(11)
        + usd(sumT / M).padEnd(18) + (geT / M).toFixed(4).padEnd(15) + (geE / M).toFixed(4));
    }
  }

  console.log(`\n${'='.repeat(118)}\n`);
})();
