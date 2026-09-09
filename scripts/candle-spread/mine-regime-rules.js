#!/usr/bin/env node
'use strict';
/**
 * MINE-REGIME-RULES — conjunctions of start-of-day clues that pick a VARIANT, honestly corrected.
 *
 * The predecessor (classify-regimes.js) concluded "no start-of-day feature predicts the regime". It tested
 * features ONE AT A TIME and only ever fitted a FULL-COVERAGE bucket->variant map. This script asks the
 * question it could not: are there COMBINATIONS of 2-3 clues that, when they fire together, say one
 * strategy will beat another — on a SUBSET of days? We do not need a recommendation every day. A rule that
 * fires on 40 of 705 days with a stable effect is a win.
 *
 * Structure
 *   PART 1  The user's four PRE-REGISTERED hypotheses, tested first and separately (4 comparisons of
 *           multiple-testing burden, not thousands — so they are held to a completely different bar and
 *           are NEVER pooled into the mined-rule corrections).
 *   PART 2  REVERSE: outcome -> features. Take the days where one variant clearly beat another and ask
 *           which start-of-day feature values are over-represented vs their base rate (lift + Wilson CI).
 *   PART 3  Systematic 1/2/3-way conjunction mining with a max-T PERMUTATION TEST THAT INCLUDES THE
 *           SEARCH, plus a quarter-by-quarter sign check on everything that survives.
 *
 * NO-LOOKAHEAD CONTRACT (inherited verbatim from classify-regimes.js, extended for the new features)
 *   - prior-day candle + daily BB(20,2)/EMA9/ATR are READ AT INDEX i-1: the bands as of yesterday's close.
 *   - premarket = bars with ET minute < 570 on day i; the open feature uses ONLY the 09:30 bar's `open`.
 *   - the realized label and every P&L number are TARGETS ONLY and never feed a feature.
 *   NEW FEATURES ADDED HERE (all prior-day, all from D[i-1] and IND[i-1]):
 *     pdLowPctB / pdHighPctB  — where yesterday's LOW / HIGH sat inside yesterday's bands (%B terms)
 *     pdTradedBelowMid        — yesterday's low < yesterday's BB midline (the 20DMA)
 *     pdTradedAboveUpper      — yesterday's high > yesterday's upper band
 *     pdClosedAboveMid        — yesterday's close > that midline
 *   These are exactly the quantities the user's four hypotheses are phrased in.
 *
 * BASELINE REPRODUCTION — optsFor is COPIED VERBATIM from build-backtest-baselines.js (VC.assertForwarded
 * guard included) and every per-variant total is asserted against server/src/candle-spread/
 * backtest-baselines.json to the dollar. The script refuses to report anything if they disagree.
 *
 * Usage: node scripts/candle-spread/mine-regime-rules.js [--dataDir D] [--workers N] [--perms 200]
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
const CACHE = arg('--cache', path.join(os.tmpdir(), 'mine-regime-rules-pnl-cache.json'));
const PERMS = Math.max(50, Number(arg('--perms', '200')) || 200);
const MIN_SUPPORT = Math.max(10, Number(arg('--minSupport', '30')) || 30);
const BASELINES = path.join(__dirname, '..', '..', 'server', 'src', 'candle-spread', 'backtest-baselines.json');
const INTRADAY_IV = true;

const usd = n => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');
const pct = n => (n * 100).toFixed(1) + '%';
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

const etMin = ms => { const d = new Date(new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York' })); return d.getHours() * 60 + d.getMinutes(); };
const etDow = ms => new Date(new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York' })).getDay();
const RTH_OPEN = 570, RTH_CLOSE = 960;

// ══ 1. LOAD + TRADING-DAY FILTER (identical rule to build-backtest-baselines) ═══════════════════════
const allDays = load5mDays(DIR);
if (!allDays.length) { console.error('no days loaded from', DIR); process.exit(1); }
const hasRth = d => d.bars.some(b => { const m = etMin(b.dt); return m >= RTH_OPEN && m < RTH_CLOSE; });
const days = allDays.filter(hasRth);
const HAS_PX = allDays.some(d => d.bars.some(b => b.px));

// ══ 2. DAILY CANDLES + INDICATORS (verbatim from classify-regimes.js) ═══════════════════════════════
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
      const sd = Math.sqrt(v / 20);
      out[i].bbmiddle = m; out[i].bbupper = m + 2 * sd; out[i].bblower = m - 2 * sd; out[i].bbwidth = 4 * sd;
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

// ══ 3. START-OF-DAY FEATURES (verbatim + the four hypothesis quantities) ════════════════════════════
function featuresFor(i) {
  if (i < 60) return null;
  const p = D[i - 1], pi = IND[i - 1];
  if (pi.bbupper == null || pi.atr14 == null || !pi.atr14) return null;
  const atr = pi.atr14;
  const f = { date: D[i].date, i };

  const pr = p.high - p.low, body = p.close - p.open;
  f.pdGreen = body > 0 ? 1 : 0;
  f.pdBodyFrac = pr > 0 ? Math.abs(body) / pr : 0;
  f.pdUpperWick = pr > 0 ? (p.high - Math.max(p.open, p.close)) / pr : 0;
  f.pdLowerWick = pr > 0 ? (Math.min(p.open, p.close) - p.low) / pr : 0;
  f.pdRangeAtr = pr / atr;
  f.pdShape = f.pdBodyFrac >= 0.62 ? 'large-body'
    : f.pdBodyFrac <= 0.22 ? (f.pdLowerWick > 0.45 ? 'hammer' : f.pdUpperWick > 0.45 ? 'star' : 'doji')
      : (f.pdLowerWick > 0.5 ? 'hammer' : f.pdUpperWick > 0.5 ? 'star' : 'mid-body');
  f.pdPctB = (p.close - pi.bblower) / (pi.bbupper - pi.bblower);
  f.pdBandZone = f.pdPctB > 1 ? 'above-upper' : f.pdPctB >= 0.5 ? 'upper-half'
    : f.pdPctB >= 0 ? 'lower-half' : 'below-lower';
  f.pdVsEma9 = (p.close - pi.ema9) / atr;

  // ── NEW: the quantities the four pre-registered hypotheses are phrased in ──
  // %B of yesterday's LOW and HIGH inside yesterday's bands: 0 = exactly on the lower band, 1 = on the
  // upper band. "Touched the lower band" is pdLowPctB <= 0; "within 10% of it" is pdLowPctB <= 0.10, i.e.
  // the low came within a tenth of the FULL band width of the band. Both strengths are reported.
  f.pdLowPctB = (p.low - pi.bblower) / (pi.bbupper - pi.bblower);
  f.pdHighPctB = (p.high - pi.bblower) / (pi.bbupper - pi.bblower);
  f.pdTradedBelowMid = p.low < pi.bbmiddle ? 1 : 0;
  f.pdClosedAboveMid = p.close > pi.bbmiddle ? 1 : 0;
  f.pdTradedAboveUpper = p.high > pi.bbupper ? 1 : 0;
  f.pdClosedInsideUpper = p.close <= pi.bbupper ? 1 : 0;

  for (const n of [2, 3, 5]) f['ret' + n] = (p.close - D[i - n].close) / atr;
  const hh = D[i - 1].high > D[i - 2].high && D[i - 2].high > D[i - 3].high;
  const hl = D[i - 1].low > D[i - 2].low && D[i - 2].low > D[i - 3].low;
  const lh = D[i - 1].high < D[i - 2].high && D[i - 2].high < D[i - 3].high;
  const ll = D[i - 1].low < D[i - 2].low && D[i - 2].low < D[i - 3].low;
  f.struct = (hh && hl) ? 'HH-HL' : (lh && ll) ? 'LH-LL' : 'mixed';
  let streak = 0;
  const dir = D[i - 1].close > D[i - 1].open ? 1 : -1;
  for (let j = i - 1; j >= 0; j--) { const s = D[j].close > D[j].open ? 1 : -1; if (s !== dir) break; streak++; }
  f.streak = streak * dir;

  f.atrPct = trailingPct(atrSeries, i - 1, 252);
  f.bbwPct = trailingPct(bbwSeries, i - 1, 252);
  f.volState = f.atrPct == null ? null : f.atrPct >= 0.70 ? 'high-vol' : f.atrPct <= 0.30 ? 'low-vol' : 'mid-vol';
  f.squeeze = f.bbwPct == null ? null : f.bbwPct <= 0.25 ? 'squeeze' : f.bbwPct >= 0.75 ? 'expanded' : 'normal';

  const pm = days[i].bars.filter(b => etMin(b.dt) < RTH_OPEN);
  if (pm.length >= 6) {
    let hi = -Infinity, lo = Infinity;
    for (const b of pm) { const a = b.analysis['5m']; if (a.high > hi) hi = a.high; if (a.low < lo) lo = a.low; }
    f.pmRange = hi - lo;
    f.pmRangeAtr = f.pmRange / atr;
    f.pmClose = pm[pm.length - 1].analysis['5m'].close;
    f.pmDrift = (f.pmClose - p.close) / atr;
    f.pmPctB = (f.pmClose - pi.bblower) / (pi.bbupper - pi.bblower);
    const at8 = pm.filter(b => etMin(b.dt) <= 480).pop();
    f.pm08Drift = at8 ? (at8.analysis['5m'].close - p.close) / atr : null;
    f.pmLateDrift = at8 ? (f.pmClose - at8.analysis['5m'].close) / atr : null;
  } else { f.pmRangeAtr = null; f.pmDrift = null; f.pmPctB = null; f.pm08Drift = null; f.pmLateDrift = null; }
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

  f.open = D[i].open;
  f.gapPts = f.open - p.close;
  f.gapAtr = f.gapPts / atr;
  f.gapBucket = f.gapAtr >= 0.5 ? 'gap-up-big' : f.gapAtr >= 0.15 ? 'gap-up'
    : f.gapAtr <= -0.5 ? 'gap-dn-big' : f.gapAtr <= -0.15 ? 'gap-dn' : 'flat-open';
  f.openPctB = (f.open - pi.bblower) / (pi.bbupper - pi.bblower);
  f.openZone = f.openPctB > 1 ? 'above-upper' : f.openPctB >= 0.5 ? 'upper-half'
    : f.openPctB >= 0 ? 'lower-half' : 'below-lower';
  f.openVsEma9 = (f.open - pi.ema9) / atr;
  f.dow = etDow(D[i].dt);
  return f;
}

// ══ 4. REALIZED LABEL (target only) — verbatim ══════════════════════════════════════════════════════
function labelFor(i) {
  const d = D[i], rth = d.rth;
  if (rth.length < 30) return null;
  const O = d.open, C = d.close, H = d.high, L = d.low, R = H - L;
  if (!(R > 0)) return null;
  const closes = rth.map(b => b.analysis['5m'].close);
  let path = 0; for (let k = 1; k < closes.length; k++) path += Math.abs(closes[k] - closes[k - 1]);
  const net = C - O, eff = path > 0 ? Math.abs(net) / path : 0;
  const closeLoc = (C - L) / R;
  const dir = net >= 0 ? 1 : -1;
  const adverse = dir > 0 ? (O - L) : (H - O);
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
    eff, closeLoc, netAtr: net, rangePts: R, adverseFrac: adverse / R, earlyFrac, pmRangeFrac, dir,
    green: C > O ? 1 : 0, retPts: C - O };
}

// ══ 5. STRATEGY P&L — optsFor COPIED VERBATIM from build-backtest-baselines.js ══════════════════════
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
  VC.assertForwarded(v, Object.keys(o), 'mine-regime-rules optsFor',
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
    try { const c = JSON.parse(fs.readFileSync(CACHE, 'utf8')); if (c.key === key) { console.log('(P&L from this script\'s own cache)'); return c.pnl; } } catch (e) {}
  }
  const pnl = {};
  if (WORKERS > 1) {
    const { spawn } = require('child_process');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mine-pnl-'));
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

// ══ 6. STATS HELPERS ════════════════════════════════════════════════════════════════════════════════
const normP = z => { const t = 1 / (1 + 0.2316419 * Math.abs(z)); const d = 0.3989422804014327 * Math.exp(-z * z / 2); return 2 * d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429)))); };
function welch(a, b) {
  if (a.length < 3 || b.length < 3) return null;
  const ma = mean(a), mb = mean(b);
  const va = a.reduce((s, x) => s + (x - ma) ** 2, 0) / (a.length - 1);
  const vb = b.reduce((s, x) => s + (x - mb) ** 2, 0) / (b.length - 1);
  const se = Math.sqrt(va / a.length + vb / b.length);
  return se > 0 ? { t: (ma - mb) / se, ma, mb, se } : null;
}
// Wilson score interval — the honest binomial CI at small n (normal approximation collapses there).
function wilson(k, n, z = 1.96) {
  if (!n) return [0, 0];
  const p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d;
  const h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}
// Two-proportion z test — "does this subset's rate differ from the complement's?"
function propZ(k1, n1, k2, n2) {
  if (!n1 || !n2) return null;
  const p1 = k1 / n1, p2 = k2 / n2, p = (k1 + k2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  return se > 0 ? (p1 - p2) / se : null;
}
// mulberry32 — a seeded PRNG so every permutation result in this report is reproducible.
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

(async () => {
  console.log(`\n${'='.repeat(110)}`);
  console.log('MINING START-OF-DAY CONJUNCTIONS THAT PICK A VARIANT');
  console.log('='.repeat(110));
  console.log(`dataset ${path.basename(DIR)} — ${allDays.length} calendar days -> ${days.length} trading days`);
  console.log(`pricing series: ${HAS_PX ? 'cash NDX (px)' : 'signal series'}\n`);

  const rows = [];
  for (let i = 0; i < D.length; i++) {
    const f = featuresFor(i), l = labelFor(i);
    if (f && l) rows.push({ i, date: D[i].date, f, l });
  }
  const N = rows.length;
  console.log(`${N} classified days (first 60 skipped: daily BB/ATR/percentile warm-up), ${rows[0].date} .. ${rows[N - 1].date}`);

  const pnl = await computePnl();

  // ── REPRODUCTION CHECK (blocking) ──
  const base = JSON.parse(fs.readFileSync(BASELINES, 'utf8'));
  console.log('\nBASELINE REPRODUCTION CHECK (must match backtest-baselines.json to the dollar)');
  let bad = 0;
  const KEYCHECK = ['v7-10', 'v7-20', 'v4-20', 'v6-20'];
  for (const name of RUNS.map(r => r.variant)) {
    const mineTot = Math.round(pnl[name].reduce((a, b) => a + b, 0));
    const ref = base.variants[name] ? base.variants[name].total : null;
    if (ref == null) continue;
    if (mineTot !== ref) { bad++; console.log(`  ${name.padEnd(10)} mine ${mineTot}  committed ${ref}  delta ${mineTot - ref}  <<< MISMATCH`); }
  }
  for (const k of KEYCHECK) console.log(`  ${k.padEnd(8)} ${String(Math.round(pnl[k].reduce((a, b) => a + b, 0))).padStart(9)} == committed ${String(base.variants[k].total).padStart(9)}  ${Math.round(pnl[k].reduce((a, b) => a + b, 0)) === base.variants[k].total ? 'OK' : 'MISMATCH'}`);
  console.log(`  ${bad === 0 ? 'ALL ' + RUNS.length + ' CAPPED VARIANTS MATCH EXACTLY' : bad + ' MISMATCHES'}`);
  if (bad) { console.error('\nRefusing to report: opts do not reproduce the committed baseline.'); process.exit(1); }

  const P = (name, r) => pnl[name][r.i];

  // The WATCHLIST. The repo has no object called a "watchlist", so it is DEFINED here and stated: the six
  // $20-width variants spanning the distinct signal/cover families — classic tent (v0), multiTF-overext
  // (v4), trend-flip (v5), 5m-harness (v6), be-wrong (v7), be-wrong+proactive-cover (v9). Width is held at
  // $20 throughout because width is a SIZE dial (lossMax $6k/$7k/$9k at $10/$20/$40), so a cross-width
  // dollar comparison is a position-size comparison wearing a strategy costume.
  const WATCH = ['v0-20', 'v4-20', 'v5-20', 'v6-20', 'v7-20', 'v9-20'];
  const W20 = RUNS.filter(r => r.spreadWidth === 20).map(r => r.variant);
  const W10 = RUNS.filter(r => r.spreadWidth === 10).map(r => r.variant);
  const allAvg = {};
  for (const n of RUNS.map(r => r.variant)) allAvg[n] = mean(rows.map(r => P(n, r)));

  console.log(`\nWATCHLIST (defined here; $20 width held fixed): ${WATCH.join(', ')}`);
  console.log('  variant   all-days avg/day   total over the ' + N + ' classified days   win%');
  for (const n of WATCH.concat(['v7-10'])) {
    const v = rows.map(r => P(n, r));
    console.log('  ' + n.padEnd(10) + usd(mean(v)).padEnd(19) + usd(v.reduce((a, b) => a + b, 0)).padEnd(38) + pct(v.filter(x => x > 0).length / v.length));
  }

  // MECHANISM CHECK — which variants are actually long or short the day's RANGE. If a start-of-day clue
  // turns out to predict SIZE OF MOVE rather than direction, this table is what says which variant that
  // helps. Spearman (rank) rather than Pearson: daily P&L is heavy-tailed and one $48k day would otherwise
  // set the correlation by itself.
  function spearman(a, b) {
    const rank = v => { const ix = v.map((x, k) => [x, k]).sort((p, q) => p[0] - q[0]); const r = new Array(v.length);
      for (let k = 0; k < ix.length;) { let j = k; while (j + 1 < ix.length && ix[j + 1][0] === ix[k][0]) j++;
        const avg = (k + j) / 2 + 1; for (let m = k; m <= j; m++) r[ix[m][1]] = avg; k = j + 1; } return r; };
    const ra = rank(a), rb = rank(b), ma = mean(ra), mb = mean(rb);
    let num = 0, da = 0, db = 0;
    for (let k = 0; k < a.length; k++) { num += (ra[k] - ma) * (rb[k] - mb); da += (ra[k] - ma) ** 2; db += (rb[k] - mb) ** 2; }
    return num / Math.sqrt(da * db);
  }
  {
    const absMove = rows.map(r => Math.abs(r.l.retPts)), rng = rows.map(r => r.l.rangePts);
    console.log('\nMECHANISM — Spearman rank correlation of each variant\'s daily P&L with the day\'s realized move/range');
    console.log('  variant'.padEnd(11) + 'rho vs |close-open|'.padEnd(22) + 'rho vs high-low range');
    for (const n of WATCH.concat(['v7-10']))
      console.log('  ' + n.padEnd(9) + spearman(rows.map(r => P(n, r)), absMove).toFixed(3).padEnd(22) + spearman(rows.map(r => P(n, r)), rng).toFixed(3));
  }

  // ══ PART 1 — THE FOUR PRE-REGISTERED HYPOTHESES ═══════════════════════════════════════════════════
  console.log(`\n\n${'='.repeat(110)}`);
  console.log('PART 1 — THE USER\'S FOUR PRE-REGISTERED HYPOTHESES (tested first, separately, 4 comparisons only)');
  console.log('='.repeat(110));

  const HYP = [
    ['H1a', 'prior day GREEN and its LOW TOUCHED the lower daily band (pdLowPctB <= 0)',
      r => r.f.pdGreen === 1 && r.f.pdLowPctB <= 0],
    ['H1b', 'prior day GREEN and its LOW came within 10% of band width of the lower band (pdLowPctB <= 0.10)',
      r => r.f.pdGreen === 1 && r.f.pdLowPctB <= 0.10],
    ['H2', 'prior day TRADED BELOW the BB midline (20DMA) but CLOSED ABOVE it',
      r => r.f.pdTradedBelowMid === 1 && r.f.pdClosedAboveMid === 1],
    ['H3', 'prior day GREEN, LARGE BODY (>=0.62 of range), closed between midline and upper band',
      r => r.f.pdGreen === 1 && r.f.pdBodyFrac >= 0.62 && r.f.pdPctB >= 0.5 && r.f.pdPctB <= 1],
    ['H4', 'prior day RED, traded BEYOND the upper band, closed RED back INSIDE the bands',
      r => r.f.pdGreen === 0 && r.f.pdTradedAboveUpper === 1 && r.f.pdClosedInsideUpper === 1],
  ];

  const baseGreen = rows.filter(r => r.l.green).length / N;
  const baseTrendUp = rows.filter(r => r.l.label === 'trend-up').length / N;
  const baseTrendDn = rows.filter(r => r.l.label === 'trend-dn').length / N;
  console.log(`\nBASE RATES over all ${N} days:  green ${pct(baseGreen)}   trend-up ${pct(baseTrendUp)}   trend-dn ${pct(baseTrendDn)}   mean day move ${(mean(rows.map(r => r.l.retPts))).toFixed(1)} pts`);
  console.log('LABEL base rates: ' + ['trend-up', 'trend-dn', 'reversal', 'early-move', 'drift', 'chop']
    .map(k => `${k} ${pct(rows.filter(r => r.l.label === k).length / N)}`).join('  '));

  const QN = 4, qOf = k => Math.min(QN - 1, Math.floor(k / (N / QN)));
  const qIdx = new Map(rows.map((r, k) => [r, k]));

  function directionBlock(tag, desc, fn) {
    const S = rows.filter(fn), C = rows.filter(r => !fn(r));
    console.log(`\n${'-'.repeat(110)}\n${tag}  ${desc}`);
    if (!S.length) { console.log('  fires on 0 days — untestable.'); return null; }
    const g = S.filter(r => r.l.green).length;
    const [lo, hi] = wilson(g, S.length);
    const z = propZ(g, S.length, C.filter(r => r.l.green).length, C.length);
    console.log(`  FIRES on ${S.length} of ${N} days (${pct(S.length / N)})`);
    console.log(`  next-day GREEN: ${g}/${S.length} = ${pct(g / S.length)}  [95% CI ${pct(lo)}..${pct(hi)}]   base rate ${pct(baseGreen)}   `
      + `lift ${((g / S.length) / baseGreen).toFixed(2)}x   two-prop z ${z == null ? 'n/a' : z.toFixed(2)} (p ${z == null ? '-' : normP(z).toFixed(3)})`);
    const mv = mean(S.map(r => r.l.retPts)), mvC = mean(C.map(r => r.l.retPts));
    const w = welch(S.map(r => r.l.retPts), C.map(r => r.l.retPts));
    console.log(`  next-day move: mean ${mv.toFixed(1)} pts vs ${mvC.toFixed(1)} elsewhere   Welch t ${w ? w.t.toFixed(2) : 'n/a'} (p ${w ? normP(w.t).toFixed(3) : '-'})`);
    // TREND EITHER WAY. The user's hypotheses are phrased directionally, but the variants that win here are
    // bidirectional, so the rate of "today TRENDS, sign irrelevant" is a separate, and possibly the real,
    // question. Reported with its own base rate so it cannot be read as a directional claim.
    const tr = S.filter(r => r.l.coarse === 'trend').length;
    const baseTrend = rows.filter(r => r.l.coarse === 'trend').length / N;
    const ztr = propZ(tr, S.length, C.filter(r => r.l.coarse === 'trend').length, C.length);
    const [tlo, thi] = wilson(tr, S.length);
    console.log(`  TREND day either direction: ${tr}/${S.length} = ${pct(tr / S.length)}  [95% CI ${pct(tlo)}..${pct(thi)}]   base rate ${pct(baseTrend)}   `
      + `lift ${((tr / S.length) / baseTrend).toFixed(2)}x   two-prop z ${ztr == null ? 'n/a' : ztr.toFixed(2)} (p ${ztr == null ? '-' : normP(ztr).toFixed(3)})`);
    const absS = mean(S.map(r => Math.abs(r.l.retPts))), absC = mean(C.map(r => Math.abs(r.l.retPts)));
    const wAbs = welch(S.map(r => Math.abs(r.l.retPts)), C.map(r => Math.abs(r.l.retPts)));
    console.log(`  |next-day move|: ${absS.toFixed(1)} pts vs ${absC.toFixed(1)} elsewhere   Welch t ${wAbs ? wAbs.t.toFixed(2) : 'n/a'} (p ${wAbs ? normP(wAbs.t).toFixed(3) : '-'})`);
    const labs = ['trend-up', 'trend-dn', 'reversal', 'early-move', 'drift', 'chop'];
    console.log('  realized label:  ' + labs.map(k => {
      const c = S.filter(r => r.l.label === k).length;
      return `${k} ${c} (${pct(c / S.length)} vs ${pct(rows.filter(r => r.l.label === k).length / N)})`;
    }).join('  '));
    // quarter-by-quarter green rate — a directional claim that only works in one regime is not a claim
    const qs = [...Array(QN)].map((_, q) => { const s = S.filter(r => qOf(qIdx.get(r)) === q); return s.length ? `${s.filter(x => x.l.green).length}/${s.length}=${pct(s.filter(x => x.l.green).length / s.length)}` : '—'; });
    console.log('  green rate by chronological quarter: ' + qs.join('   '));
    return S;
  }

  function variantBlock(S, pool, poolName) {
    if (!S || S.length < 8) return;
    const C = rows.filter(r => !S.includes(r));
    const tab = pool.map(n => {
      const a = S.map(r => P(n, r)), b = C.map(r => P(n, r));
      const w = welch(a, b);
      const qs = [...Array(QN)].map((_, q) => { const s = S.filter(r => qOf(qIdx.get(r)) === q); return s.length ? mean(s.map(r => P(n, r))) - allAvg[n] : null; });
      const signs = qs.filter(x => x != null).map(Math.sign);
      return { n, avg: mean(a), lift: mean(a) - allAvg[n], t: w ? w.t : null, win: a.filter(x => x > 0).length / a.length, qs,
        holds: signs.length === QN && signs.every(s => s === signs[0]) };
    }).sort((a, b) => b.lift - a.lift);
    console.log(`  VARIANT PERFORMANCE on the ${S.length} firing days (${poolName}) — "lift" = avg here minus that variant's own all-days avg`);
    console.log('    variant'.padEnd(12) + 'avg/day'.padEnd(11) + 'all-days avg'.padEnd(15) + 'lift'.padEnd(11) + 'contrast t'.padEnd(13) + 'win%'.padEnd(8)
      + 'Q1 lift'.padEnd(11) + 'Q2 lift'.padEnd(11) + 'Q3 lift'.padEnd(11) + 'Q4 lift'.padEnd(11) + 'sign holds');
    for (const x of tab) {
      console.log('    ' + x.n.padEnd(10) + usd(x.avg).padEnd(11) + usd(allAvg[x.n]).padEnd(15)
        + ((x.lift >= 0 ? '+' : '') + usd(x.lift)).padEnd(11) + (x.t == null ? 'n/a' : x.t.toFixed(2) + ` (p${normP(x.t).toFixed(2)})`).padEnd(13)
        + pct(x.win).padEnd(8) + x.qs.map(q => (q == null ? '—' : (q >= 0 ? '+' : '') + usd(q)).padEnd(11)).join('') + (x.holds ? 'YES' : 'no'));
    }
    // the paired fork the predecessor cared about
    const d74 = S.map(r => P('v7-20', r) - P('v4-20', r)), o74 = C.map(r => P('v7-20', r) - P('v4-20', r));
    const w74 = welch(d74, o74);
    const d76 = S.map(r => P('v7-20', r) - P('v6-20', r)), o76 = C.map(r => P('v7-20', r) - P('v6-20', r));
    const w76 = welch(d76, o76);
    console.log(`    PAIRED  v7-20 - v4-20: ${usd(mean(d74))}/day here vs ${usd(mean(o74))} elsewhere (contrast t ${w74 ? w74.t.toFixed(2) : 'n/a'})`);
    console.log(`    PAIRED  v7-20 - v6-20: ${usd(mean(d76))}/day here vs ${usd(mean(o76))} elsewhere (contrast t ${w76 ? w76.t.toFixed(2) : 'n/a'})`);
  }

  for (const [tag, desc, fn] of HYP) {
    const S = directionBlock(tag, desc, fn);
    variantBlock(S, WATCH, 'watchlist, $20 width');
    if (S && S.length >= 8) variantBlock(S, ['v7-10', 'v4-10', 'v6-10', 'v0-10'], '$10 width cross-check');
  }

  // ── EXACT ROTATION TEST FOR THE FIVE PRE-REGISTERED RULES ────────────────────────────────────────
  // Every Welch t and two-proportion z above assumes the days are independent. They are not: volatility
  // regimes, and therefore both the features AND the daily P&L, are strongly autocorrelated, and each of
  // these rules fires in calendar CLUSTERS (H1a puts 5 of its 24 days inside one week of March 2025). The
  // fix is a test whose null preserves that clustering: slide the rule's firing mask through all N circular
  // offsets and ask where the real alignment ranks. It is exhaustive (all 704 rotations), so it is exact
  // and reproducible, and it is the number these five hypotheses should be judged on.
  console.log(`\n\n${'='.repeat(110)}`);
  console.log('PRE-REGISTERED HYPOTHESES — EXACT CIRCULAR-ROTATION TEST (preserves calendar clustering)');
  console.log('='.repeat(110));
  console.log('  Two-sided p = share of the 704 rotations of the firing mask whose statistic is at least as far');
  console.log('  from the all-days mean as the real alignment. Bonferroni bar for 5 pre-registered rules: p < 0.010.');
  console.log('\n  rule'.padEnd(8) + 'n'.padEnd(6) + 'statistic'.padEnd(22) + 'observed'.padEnd(13) + 'all-days'.padEnd(13) + 'rotation p'.padEnd(13) + 'clears 0.010?');
  {
    const stats = [
      ['|next-day move| (pts)', r => Math.abs(r.l.retPts), v => v.toFixed(1)],
      ['green rate', r => r.l.green, v => pct(v)],
      ['trend-day rate', r => (r.l.coarse === 'trend' ? 1 : 0), v => pct(v)],
      ['v7-20 P&L/day', r => P('v7-20', r), usd],
      ['v4-20 P&L/day', r => P('v4-20', r), usd],
      ['v7-20 minus v4-20', r => P('v7-20', r) - P('v4-20', r), usd],
    ];
    for (const [tag, , fn] of HYP) {
      const mask = rows.filter(fn).map(r => qIdx.get(r));
      if (mask.length < 5) continue;
      for (const [sname, sfn, fmt] of stats) {
        const y = rows.map(sfn), gm = mean(y);
        const obs = mean(mask.map(k => y[k]));
        let ge = 0;
        for (let off = 0; off < N; off++) {
          let s = 0; for (const k of mask) s += y[(k + off) % N];
          if (Math.abs(s / mask.length - gm) >= Math.abs(obs - gm) - 1e-9) ge++;
        }
        const p = ge / N;
        console.log('  ' + tag.padEnd(6) + String(mask.length).padEnd(6) + sname.padEnd(22) + fmt(obs).padEnd(13)
          + fmt(gm).padEnd(13) + p.toFixed(4).padEnd(13) + (p < 0.010 ? 'YES' : 'no'));
      }
      console.log('');
    }
  }

  // ── H1a DEEP DIVE ────────────────────────────────────────────────────────────────────────────────
  // H1a is the only pre-registered rule with a large variant lift whose sign holds in every quarter, so it
  // gets the adversarial treatment the rest do not need. Four attacks: (1) is it a cliff at exactly the
  // band or does it decay smoothly with the threshold — a cliff that vanishes one step out is a fitted
  // edge; (2) is it one or two enormous days; (3) does the GREEN half of the condition do any work; and
  // (4) how often does a RANDOM subset of the same size produce a lift this large? Attack (4) is run two
  // ways: i.i.d. random subsets, and CIRCULAR ROTATIONS of the real firing mask, which keeps the calendar
  // clustering of the real rule and is therefore the harder null to beat.
  console.log(`\n\n${'='.repeat(110)}`);
  console.log('H1a STRESS TEST — trying to break the one pre-registered rule with a large, sign-stable lift');
  console.log('='.repeat(110));
  const H1AFN = r => r.f.pdGreen === 1 && r.f.pdLowPctB <= 0;
  const H1A = rows.filter(H1AFN);
  console.log('\n(1) THRESHOLD LADDER — "within X of the lower band", prior day green. A real effect decays smoothly.');
  console.log('  pdLowPctB <='.padEnd(16) + 'days'.padEnd(7) + 'v7-20 avg'.padEnd(12) + 'lift'.padEnd(11) + 'v4-20 avg'.padEnd(12) + 'lift'.padEnd(11) + 'v6-20 lift'.padEnd(12) + 'green rate');
  for (const th of [-0.05, -0.02, 0, 0.02, 0.05, 0.10, 0.15, 0.20, 0.30]) {
    const S = rows.filter(r => r.f.pdGreen === 1 && r.f.pdLowPctB <= th);
    if (!S.length) { console.log('  ' + String(th).padEnd(16) + '0'); continue; }
    const a7 = mean(S.map(r => P('v7-20', r))), a4 = mean(S.map(r => P('v4-20', r))), a6 = mean(S.map(r => P('v6-20', r)));
    console.log('  ' + String(th).padEnd(16) + String(S.length).padEnd(7) + usd(a7).padEnd(12) + ((a7 - allAvg['v7-20'] >= 0 ? '+' : '') + usd(a7 - allAvg['v7-20'])).padEnd(11)
      + usd(a4).padEnd(12) + ((a4 - allAvg['v4-20'] >= 0 ? '+' : '') + usd(a4 - allAvg['v4-20'])).padEnd(11)
      + ((a6 - allAvg['v6-20'] >= 0 ? '+' : '') + usd(a6 - allAvg['v6-20'])).padEnd(12) + pct(S.filter(r => r.l.green).length / S.length));
  }
  console.log('\n(2) IS IT A HANDFUL OF DAYS? every firing day, v7-20 and v4-20 terminal P&L');
  console.log('  date'.padEnd(13) + 'label'.padEnd(12) + 'v7-20'.padEnd(11) + 'v4-20'.padEnd(11) + 'v6-20');
  for (const r of H1A) console.log('  ' + r.date.padEnd(13) + r.l.label.padEnd(12) + usd(P('v7-20', r)).padEnd(11) + usd(P('v4-20', r)).padEnd(11) + usd(P('v6-20', r)));
  {
    const v = H1A.map(r => P('v7-20', r)).sort((a, b) => a - b);
    const trim = v.slice(2, v.length - 2);
    console.log(`  v7-20 on the ${v.length} days: mean ${usd(mean(v))}  median ${usd(v[Math.floor(v.length / 2)])}  `
      + `trimmed mean (drop 2 best + 2 worst) ${usd(mean(trim))}  vs all-days mean ${usd(allAvg['v7-20'])} / median ${usd([...rows.map(r => P('v7-20', r))].sort((a, b) => a - b)[Math.floor(N / 2)])}`);
    // leave-one-out: the largest single-day influence on the lift
    let worstDrop = null;
    for (let k = 0; k < H1A.length; k++) {
      const m = mean(H1A.filter((_, j) => j !== k).map(r => P('v7-20', r))) - allAvg['v7-20'];
      if (worstDrop == null || m < worstDrop.m) worstDrop = { m, date: H1A[k].date };
    }
    console.log(`  leave-one-out WORST case: dropping ${worstDrop.date} leaves a lift of ${usd(worstDrop.m)} (full-sample lift ${usd(mean(v) - allAvg['v7-20'])})`);
  }
  console.log('\n(3) DOES THE "PRIOR DAY GREEN" HALF DO ANY WORK?');
  for (const [nm, fn] of [['green + low touched band', H1AFN],
    ['RED + low touched band', r => r.f.pdGreen === 0 && r.f.pdLowPctB <= 0],
    ['ANY colour + low touched band', r => r.f.pdLowPctB <= 0]]) {
    const S = rows.filter(fn);
    console.log('  ' + nm.padEnd(32) + `n=${S.length}`.padEnd(8) + 'v7-20 lift ' + ((mean(S.map(r => P('v7-20', r))) - allAvg['v7-20'] >= 0 ? '+' : '') + usd(mean(S.map(r => P('v7-20', r))) - allAvg['v7-20'])).padEnd(11)
      + 'v4-20 lift ' + ((mean(S.map(r => P('v4-20', r))) - allAvg['v4-20'] >= 0 ? '+' : '') + usd(mean(S.map(r => P('v4-20', r))) - allAvg['v4-20'])).padEnd(11)
      + 'green rate ' + pct(S.filter(r => r.l.green).length / S.length));
  }
  console.log('\n(3b) IS H1a JUST "TREND DAYS"? — if the whole edge is the elevated trend rate, then inside');
  console.log('     each realized-label class H1a days should look ordinary. If v7-20 still outperforms inside');
  console.log('     the classes, H1a is marking something the label taxonomy does not capture.');
  {
    const cls = r => (r.l.coarse === 'trend' ? 'trend' : 'non-trend');
    console.log('  class'.padEnd(12) + 'H1a days'.padEnd(11) + 'v7-20 on H1a'.padEnd(15) + 'v7-20 on the same class elsewhere'.padEnd(36) + 'difference');
    for (const k of ['trend', 'non-trend']) {
      const A = H1A.filter(r => cls(r) === k), B = rows.filter(r => cls(r) === k && !H1AFN(r));
      if (!A.length) continue;
      console.log('  ' + k.padEnd(10) + String(A.length).padEnd(11) + usd(mean(A.map(r => P('v7-20', r)))).padEnd(15)
        + `${usd(mean(B.map(r => P('v7-20', r))))} (n=${B.length})`.padEnd(36)
        + (mean(A.map(r => P('v7-20', r))) - mean(B.map(r => P('v7-20', r))) >= 0 ? '+' : '') + usd(mean(A.map(r => P('v7-20', r))) - mean(B.map(r => P('v7-20', r)))));
    }
  }
  console.log('\n(4) SUBSET NULL — how often does a subset of the SAME SIZE produce a v7-20 lift this big?');
  {
    const obsLift = mean(H1A.map(r => P('v7-20', r))) - allAvg['v7-20'];
    const y7 = rows.map(r => P('v7-20', r));
    const rnd = mulberry32(0x5EED);
    const REPS = 20000;
    let geIid = 0, geRot = 0, holdRot = 0;
    const maskIdx = H1A.map(r => qIdx.get(r));
    for (let p = 0; p < REPS; p++) {
      // i.i.d. subset of the same size
      const pick = new Set();
      while (pick.size < H1A.length) pick.add(Math.floor(rnd() * N));
      let s = 0; for (const k of pick) s += y7[k];
      if (s / H1A.length - allAvg['v7-20'] >= obsLift) geIid++;
      // circular rotation of the REAL firing mask — preserves its calendar clustering
      const off = Math.floor(rnd() * N);
      let s2 = 0; const rotIdx = maskIdx.map(k => (k + off) % N);
      for (const k of rotIdx) s2 += y7[k];
      const lift2 = s2 / H1A.length - allAvg['v7-20'];
      if (lift2 >= obsLift) geRot++;
      const qs = [...Array(QN)].map((_, q) => { const s3 = rotIdx.filter(k => qOf(k) === q); return s3.length ? mean(s3.map(k => y7[k])) - allAvg['v7-20'] : null; });
      const sg = qs.filter(x => x != null).map(Math.sign);
      if (sg.length === QN && sg.every(x => x === sg[0]) && lift2 >= obsLift) holdRot++;
    }
    console.log(`  observed v7-20 lift on the ${H1A.length} H1a days: ${usd(obsLift)}`);
    console.log(`  P(random ${H1A.length}-day subset gives a lift >= that)              = ${geIid}/${REPS} = ${(geIid / REPS).toFixed(4)}`);
    console.log(`  P(rotated real mask gives a lift >= that)                    = ${geRot}/${REPS} = ${(geRot / REPS).toFixed(4)}`);
    console.log(`  P(rotated mask gives a lift >= that AND holds sign in all 4Q) = ${holdRot}/${REPS} = ${(holdRot / REPS).toFixed(4)}`);
    console.log('  NOTE: H1a was PRE-REGISTERED, so the only correction it owes is for the 5 hypotheses tested');
    console.log('  (H1a/H1b/H2/H3/H4) — not for the 18k mined rules. A p of ~0.05/5 = 0.010 is the honest bar.');
  }

  // ══ FEATURE PREDICATES (shared by parts 2 and 3) ══════════════════════════════════════════════════
  // Numeric features are binarized at their FULL-SAMPLE terciles. That uses the feature distribution (not
  // the outcome), so it cannot leak P&L, but it IS a mild in-sample convenience — a live rule would need a
  // trailing quantile. Stated rather than hidden.
  const NUM = ['pdBodyFrac', 'pdUpperWick', 'pdLowerWick', 'pdRangeAtr', 'pdPctB', 'pdLowPctB', 'pdHighPctB',
    'pdVsEma9', 'ret2', 'ret3', 'ret5', 'streak', 'atrPct', 'bbwPct', 'pmRangeAtr', 'pmRangeRel',
    'pm08Drift', 'pmLateDrift', 'gapAtr', 'openPctB', 'openVsEma9'];
  const CAT = { pdShape: null, pdBandZone: null, struct: null, volState: null, squeeze: null, gapBucket: null, openZone: null, dow: null };
  const preds = [];
  const addPred = (name, fn) => { const m = new Uint8Array(N); let c = 0; for (let k = 0; k < N; k++) { const v = fn(rows[k]) ? 1 : 0; m[k] = v; c += v; } if (c >= MIN_SUPPORT && c <= N - MIN_SUPPORT) preds.push({ name, m, sup: c }); };
  for (const nf of NUM) {
    const vals = rows.map(r => r.f[nf]).filter(v => v != null && isFinite(v)).sort((a, b) => a - b);
    if (vals.length < N * 0.5) continue;
    const q1 = vals[Math.floor(vals.length / 3)], q2 = vals[Math.floor(2 * vals.length / 3)];
    addPred(`${nf}<=${q1.toFixed(3)}`, r => r.f[nf] != null && isFinite(r.f[nf]) && r.f[nf] <= q1);
    addPred(`${nf}>=${q2.toFixed(3)}`, r => r.f[nf] != null && isFinite(r.f[nf]) && r.f[nf] >= q2);
  }
  for (const cf of Object.keys(CAT)) {
    const keys = [...new Set(rows.map(r => r.f[cf]).filter(v => v != null))];
    for (const k of keys) addPred(`${cf}=${k}`, r => String(r.f[cf]) === String(k));
  }
  addPred('pdGreen', r => r.f.pdGreen === 1);
  addPred('pdRed', r => r.f.pdGreen === 0);
  addPred('pdTradedBelowMid', r => r.f.pdTradedBelowMid === 1);
  addPred('pdClosedAboveMid', r => r.f.pdClosedAboveMid === 1);
  addPred('pdTradedAboveUpper', r => r.f.pdTradedAboveUpper === 1);
  addPred('pdLowTouchedLowerBand', r => r.f.pdLowPctB <= 0);
  addPred('pdLowNearLowerBand10pct', r => r.f.pdLowPctB <= 0.10);
  console.log(`\n\n${preds.length} binary predicates built (min support ${MIN_SUPPORT} and at most ${N - MIN_SUPPORT}).`);

  // ══ PART 2 — REVERSE: OUTCOME -> FEATURES ═════════════════════════════════════════════════════════
  console.log(`\n${'='.repeat(110)}`);
  console.log('PART 2 — REVERSE ANALYSIS: take the days one strategy CLEARLY beat another, ask what preceded them');
  console.log('='.repeat(110));
  console.log('  Method: define an outcome subset FIRST (deciles / dollar thresholds of a paired daily difference),');
  console.log('  then for every predicate compute P(pred | subset) vs P(pred | complement). Lift = ratio of rates.');
  console.log(`  With ${preds.length} predicates scanned per subset, a single lift needs Bonferroni p < ${(0.05 / preds.length).toFixed(5)} to mean anything.`);

  function reverse(title, diffFn, subsetDefs) {
    const d = rows.map(diffFn);
    const srt = [...d].sort((a, b) => a - b);
    const p10 = srt[Math.floor(N * 0.10)], p90 = srt[Math.floor(N * 0.90)];
    console.log(`\n${'-'.repeat(110)}\n${title}`);
    console.log(`  daily diff: mean ${usd(mean(d))}  median ${usd(srt[Math.floor(N / 2)])}  p10 ${usd(p10)}  p90 ${usd(p90)}  min ${usd(srt[0])}  max ${usd(srt[N - 1])}`);
    for (const [nm, sel] of subsetDefs(p10, p90)) {
      const inSet = []; for (let k = 0; k < N; k++) if (sel(d[k])) inSet.push(k);
      if (inSet.length < 20) { console.log(`  ${nm}: only ${inSet.length} days — skipped (too few to characterize)`); continue; }
      const inMask = new Uint8Array(N); for (const k of inSet) inMask[k] = 1;
      const res = [];
      for (const p of preds) {
        let a = 0; for (const k of inSet) a += p.m[k];
        const b = p.sup - a, nIn = inSet.length, nOut = N - nIn;
        if (a < 5) continue;
        const z = propZ(a, nIn, b, nOut);
        res.push({ name: p.name, a, nIn, rIn: a / nIn, rOut: b / nOut, lift: (a / nIn) / (b / nOut || 1e-9), z, ci: wilson(a, nIn) });
      }
      res.sort((x, y) => Math.abs(y.z) - Math.abs(x.z));
      console.log(`\n  SUBSET ${nm} — ${inSet.length} days (${pct(inSet.length / N)}), mean diff ${usd(mean(inSet.map(k => d[k])))}`);
      console.log('    predicate'.padEnd(34) + 'in subset'.padEnd(18) + 'elsewhere'.padEnd(12) + 'lift'.padEnd(8) + '95% CI on subset rate'.padEnd(24) + 'z'.padEnd(8) + 'p'.padEnd(9) + 'survives Bonferroni?');
      for (const x of res.slice(0, 8)) {
        console.log('    ' + x.name.padEnd(32) + `${x.a}/${x.nIn} = ${pct(x.rIn)}`.padEnd(18) + pct(x.rOut).padEnd(12)
          + x.lift.toFixed(2).padEnd(8) + `${pct(x.ci[0])}..${pct(x.ci[1])}`.padEnd(24)
          + (x.z == null ? '-' : x.z.toFixed(2)).padEnd(8) + (x.z == null ? '-' : normP(x.z).toFixed(4)).padEnd(9)
          + (x.z != null && normP(x.z) < 0.05 / preds.length ? 'YES' : 'no'));
      }
    }
  }
  const subs = (p10, p90) => ([
    ['TOP decile (A beat B by most)', v => v >= p90],
    ['BOTTOM decile (B beat A by most)', v => v <= p10],
    ['A beat B by > $2,000', v => v > 2000],
    ['B beat A by > $2,000', v => v < -2000],
  ]);
  reverse('v7-20 minus v4-20 (be-wrong vs multiTF-overext, width held at $20)', r => P('v7-20', r) - P('v4-20', r), subs);
  reverse('v7-20 minus v6-20 (be-wrong vs 5m-harness, width held at $20)', r => P('v7-20', r) - P('v6-20', r), subs);
  // best-of-watchlist vs the rest: on each day, how much the best watchlist variant beat the watchlist mean
  reverse('best watchlist variant minus watchlist average (dispersion: does the CHOICE matter today?)',
    r => Math.max(...WATCH.map(n => P(n, r))) - mean(WATCH.map(n => P(n, r))), subs);

  // Which watchlist variant is best, as a categorical outcome, and whether any predicate shifts it.
  console.log(`\n${'-'.repeat(110)}\nWHICH WATCHLIST VARIANT IS BEST — categorical outcome, base rates first`);
  const bestOf = r => WATCH.reduce((a, b) => (P(b, r) > P(a, r) ? b : a), WATCH[0]);
  const bestCounts = new Map();
  for (const r of rows) bestCounts.set(bestOf(r), (bestCounts.get(bestOf(r)) || 0) + 1);
  console.log('  base rate of "is the single best variant that day": ' + WATCH.map(n => `${n} ${pct((bestCounts.get(n) || 0) / N)}`).join('  '));

  // ══ PART 3 — SYSTEMATIC CONJUNCTION MINING ════════════════════════════════════════════════════════
  console.log(`\n\n${'='.repeat(110)}`);
  console.log('PART 3 — SYSTEMATIC 1/2/3-WAY CONJUNCTION MINING, WITH A PERMUTATION TEST THAT INCLUDES THE SEARCH');
  console.log('='.repeat(110));

  // Build the candidate rule set ONCE. It depends only on the FEATURES, never on the outcome — which is
  // exactly what makes the max-T permutation valid: under a shuffled outcome the same rules are searched.
  console.log('\nbuilding candidate rule set (support floor ' + MIN_SUPPORT + ')...');
  const t0 = Date.now();
  const rules = [];
  const seen = new Set();          // dedupe by exact firing-set signature: two rules that fire on the same
  const sig = (idx) => {           // days are ONE hypothesis, not two, and counting them twice inflates the
    let h1 = 2166136261, h2 = 5381;// search burden while adding nothing.
    for (const k of idx) { h1 ^= k; h1 = Math.imul(h1, 16777619); h2 = (h2 * 33 + k) >>> 0; }
    return (h1 >>> 0) + ':' + (h2 >>> 0) + ':' + idx.length;
  };
  const push = (name, idx) => {
    if (idx.length < MIN_SUPPORT || idx.length > N - MIN_SUPPORT) return false;
    const s = sig(idx); if (seen.has(s)) return false;
    seen.add(s); rules.push({ name, idx: Int32Array.from(idx) }); return true;
  };
  const idxOf = m => { const a = []; for (let k = 0; k < N; k++) if (m[k]) a.push(k); return a; };
  for (const p of preds) push(p.name, idxOf(p.m));
  let tried1 = preds.length, tried2 = 0, tried3 = 0;
  const two = [];
  for (let a = 0; a < preds.length; a++) for (let b = a + 1; b < preds.length; b++) {
    tried2++;
    const idx = []; const ma = preds[a].m, mb = preds[b].m;
    for (let k = 0; k < N; k++) if (ma[k] && mb[k]) idx.push(k);
    if (idx.length < MIN_SUPPORT) continue;                       // ANTIMONOTONE: no 3-way child can be bigger
    two.push({ a, b, idx });
    push(preds[a].name + ' AND ' + preds[b].name, idx);
  }
  for (const { a, b, idx } of two) for (let c = b + 1; c < preds.length; c++) {
    tried3++;
    const mc = preds[c].m; const out = [];
    for (const k of idx) if (mc[k]) out.push(k);
    if (out.length < MIN_SUPPORT) continue;
    push(preds[a].name + ' AND ' + preds[b].name + ' AND ' + preds[c].name, out);
  }
  console.log(`  candidates enumerated: ${tried1} singles + ${tried2} pairs + ${tried3} triples = ${(tried1 + tried2 + tried3).toLocaleString()}`);
  console.log(`  passing the support floor and distinct as firing-sets: ${rules.length.toLocaleString()} rules  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  // Statistic: Welch t of the CONTRAST — mean of y inside the rule vs mean of y outside it. The contrast
  // (not the level) is the claim: "this rule marks days that are DIFFERENT", not "A beats B here" when A
  // beats B everywhere.
  function scoreAll(y) {
    let sum = 0, sq = 0;
    for (let k = 0; k < N; k++) { sum += y[k]; sq += y[k] * y[k]; }
    let bestT = 0, best = null;
    for (const R of rules) {
      const n1 = R.idx.length; let s1 = 0, q1 = 0;
      for (let j = 0; j < n1; j++) { const v = y[R.idx[j]]; s1 += v; q1 += v * v; }
      const n2 = N - n1, s2 = sum - s1, q2 = sq - q1;
      const m1 = s1 / n1, m2 = s2 / n2;
      const v1 = (q1 - n1 * m1 * m1) / (n1 - 1), v2 = (q2 - n2 * m2 * m2) / (n2 - 1);
      const se = Math.sqrt(v1 / n1 + v2 / n2);
      if (!(se > 0)) continue;
      const t = (m1 - m2) / se;
      if (Math.abs(t) > Math.abs(bestT)) { bestT = t; best = { R, t, m1, m2, n1 }; }
    }
    return { bestT, best };
  }
  // Full ranked list for the observed data (needed to report the top few, not just the max).
  function rankAll(y) {
    let sum = 0, sq = 0;
    for (let k = 0; k < N; k++) { sum += y[k]; sq += y[k] * y[k]; }
    const out = [];
    for (const R of rules) {
      const n1 = R.idx.length; let s1 = 0, q1 = 0;
      for (let j = 0; j < n1; j++) { const v = y[R.idx[j]]; s1 += v; q1 += v * v; }
      const n2 = N - n1, s2 = sum - s1, q2 = sq - q1;
      const m1 = s1 / n1, m2 = s2 / n2;
      const v1 = (q1 - n1 * m1 * m1) / (n1 - 1), v2 = (q2 - n2 * m2 * m2) / (n2 - 1);
      const se = Math.sqrt(v1 / n1 + v2 / n2);
      if (!(se > 0)) continue;
      out.push({ R, t: (m1 - m2) / se, m1, m2, n1 });
    }
    out.sort((a, b) => Math.abs(b.t) - Math.abs(a.t));
    return out;
  }

  // Sign-stability of a rule's CONTRAST across the 4 chronological quarters and the 2 halves, for an
  // arbitrary outcome vector. Used both to grade the real rules and — crucially — to measure how much the
  // stability check is actually worth, by running it on rules mined from PERMUTED data.
  const memb = new Uint8Array(N);
  function signHolds(idx, y) {
    memb.fill(0); for (let j = 0; j < idx.length; j++) memb[idx[j]] = 1;
    const segs = [[0, 0], [0, 1], [0, 2], [0, 3], [1, 0], [1, 1]];   // [mode 0=quarter,1=half][which]
    const MIDN = Math.floor(N / 2);
    let s0 = 0;
    for (let si = 0; si < segs.length; si++) {
      const [mode, w] = segs[si];
      let sIn = 0, nIn = 0, sOut = 0, nOut = 0;
      for (let k = 0; k < N; k++) {
        const ok = mode === 0 ? qOf(k) === w : (w === 0 ? k < MIDN : k >= MIDN);
        if (!ok) continue;
        if (memb[k]) { sIn += y[k]; nIn++; } else { sOut += y[k]; nOut++; }
      }
      if (nIn < 3 || nOut < 3) return false;
      const c = Math.sign(sIn / nIn - sOut / nOut);
      if (si === 0) s0 = c; else if (c !== s0) return false;
    }
    return true;
  }

  const TARGETS = [
    ['v7-20 minus v4-20', rows.map(r => P('v7-20', r) - P('v4-20', r))],
    ['v7-20 minus v6-20', rows.map(r => P('v7-20', r) - P('v6-20', r))],
    ['v6-20 minus v4-20', rows.map(r => P('v6-20', r) - P('v4-20', r))],
    ['v7-10 daily P&L (beat its own average?)', rows.map(r => P('v7-10', r))],
    ['v7-20 daily P&L (beat its own average?)', rows.map(r => P('v7-20', r))],
    ['best-of-watchlist minus watchlist mean', rows.map(r => Math.max(...WATCH.map(n => P(n, r))) - mean(WATCH.map(n => P(n, r))))],
  ];

  console.log(`\nPERMUTATION PROTOCOL — ${PERMS} replicates per target, TWO nulls:`);
  console.log('  (a) SHUFFLE: the outcome vector is randomly permuted across days. Standard, but it destroys the');
  console.log('      serial correlation in both the outcome and the features, which can make the noise floor');
  console.log('      look tighter than it really is.');
  console.log('  (b) ROTATE: the outcome vector is circularly shifted by a random offset. This preserves the');
  console.log('      autocorrelation of BOTH series while destroying their alignment — the conservative null,');
  console.log('      and the one a rule has to clear to be believed here.');
  console.log('  In each replicate the ENTIRE search is re-run and the single best |t| over all ' + rules.length.toLocaleString() + ' rules is');
  console.log('  recorded. That max-|t| distribution IS the multiple-testing correction (Westfall-Young max-T).');

  const survivors = [];
  for (const [tname, y0] of TARGETS) {
    const y = Float64Array.from(y0);
    const ranked = rankAll(y);
    const obsT = Math.abs(ranked[0].t);
    // SELF-CHECK: the observed statistic and the null statistic MUST come out of the same code path, or the
    // comparison is meaningless. scoreAll (used for every permutation) is run on the UNPERMUTED data here
    // and must reproduce rankAll's top |t| exactly.
    const selfT = Math.abs(scoreAll(y).bestT);
    if (Math.abs(selfT - obsT) > 1e-9) { console.error(`SELF-CHECK FAILED: rankAll ${obsT} vs scoreAll ${selfT}`); process.exit(1); }
    const rnd = mulberry32(0xC0FFEE);
    const nullsShuf = [], nullsRot = [];
    const tmp = new Float64Array(N);
    let nullHeld = 0;                        // how often the NULL's best rule also passes the sign check
    for (let p = 0; p < PERMS; p++) {
      // (a) shuffle
      const perm = Array.from({ length: N }, (_, k) => k);
      for (let k = N - 1; k > 0; k--) { const j = Math.floor(rnd() * (k + 1)); const t = perm[k]; perm[k] = perm[j]; perm[j] = t; }
      for (let k = 0; k < N; k++) tmp[k] = y[perm[k]];
      nullsShuf.push(Math.abs(scoreAll(tmp).bestT));
      // (b) rotate
      const off = 1 + Math.floor(rnd() * (N - 1));
      for (let k = 0; k < N; k++) tmp[k] = y[(k + off) % N];
      const rr = scoreAll(tmp);
      nullsRot.push(Math.abs(rr.bestT));
      if (rr.best && signHolds(rr.best.R.idx, tmp)) nullHeld++;
    }
    nullsShuf.sort((a, b) => a - b); nullsRot.sort((a, b) => a - b);
    const q = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
    const pShuf = (nullsShuf.filter(x => x >= obsT).length + 1) / (PERMS + 1);
    const pRot = (nullsRot.filter(x => x >= obsT).length + 1) / (PERMS + 1);
    console.log(`\n${'-'.repeat(110)}\nTARGET: ${tname}`);
    console.log(`  observed best |t| over the whole search: ${obsT.toFixed(2)}`);
    console.log(`  SHUFFLE null max-|t|: median ${q(nullsShuf, 0.5).toFixed(2)}  p90 ${q(nullsShuf, 0.90).toFixed(2)}  p95 ${q(nullsShuf, 0.95).toFixed(2)}  max ${nullsShuf[PERMS - 1].toFixed(2)}   => family-wise p = ${pShuf.toFixed(3)}`);
    console.log(`  ROTATE  null max-|t|: median ${q(nullsRot, 0.5).toFixed(2)}  p90 ${q(nullsRot, 0.90).toFixed(2)}  p95 ${q(nullsRot, 0.95).toFixed(2)}  max ${nullsRot[PERMS - 1].toFixed(2)}   => family-wise p = ${pRot.toFixed(3)}`);
    const verdict = pRot <= 0.05 ? 'SURVIVES both nulls' : pShuf <= 0.05 ? 'survives the SHUFFLE null only — fails the conservative ROTATE null' : 'DOES NOT SURVIVE — indistinguishable from the search noise floor';
    console.log(`  VERDICT: ${verdict}`);
    console.log(`  POWER AUDIT of the stability check: the best rule mined from PERMUTED data also held its sign`);
    console.log(`  across all 4 quarters AND both halves in ${nullHeld}/${PERMS} = ${pct(nullHeld / PERMS)} of replicates. A max-selected rule`);
    console.log(`  passes the quarter test almost automatically, so "sign holds" is NOT evidence on its own here.`);
    console.log('\n  top 6 rules by |contrast t| (reported so the reader can see what the search WANTED to find):');
    console.log('    n'.padEnd(7) + 'mean in'.padEnd(12) + 'mean out'.padEnd(12) + 't'.padEnd(9)
      + 'Q1'.padEnd(11) + 'Q2'.padEnd(11) + 'Q3'.padEnd(11) + 'Q4'.padEnd(11) + 'H1'.padEnd(11) + 'H2'.padEnd(11) + 'sign holds  rule');
    for (const x of ranked.slice(0, 6)) {
      const contrastIn = k => y[k];
      const qv = [...Array(QN)].map((_, qq) => {
        const inQ = [...x.R.idx].filter(k => qOf(k) === qq);
        const outQ = []; for (let k = 0; k < N; k++) if (qOf(k) === qq && !x.R.idx.includes(k)) outQ.push(k);
        return inQ.length >= 3 ? mean(inQ.map(contrastIn)) - mean(outQ.map(contrastIn)) : null;
      });
      const MIDN = Math.floor(N / 2);
      const halves = [[0, MIDN], [MIDN, N]].map(([lo, hi]) => {
        const inH = [...x.R.idx].filter(k => k >= lo && k < hi);
        const outH = []; for (let k = lo; k < hi; k++) if (!x.R.idx.includes(k)) outH.push(k);
        return inH.length >= 5 ? mean(inH.map(contrastIn)) - mean(outH.map(contrastIn)) : null;
      });
      const sg = qv.concat(halves).filter(v => v != null).map(Math.sign);
      const holds = sg.length === 6 && sg.every(s => s === sg[0]);
      console.log('    ' + String(x.n1).padEnd(7) + usd(x.m1).padEnd(12) + usd(x.m2).padEnd(12) + x.t.toFixed(2).padEnd(9)
        + qv.concat(halves).map(v => (v == null ? '—' : (v >= 0 ? '+' : '') + usd(v)).padEnd(11)).join('')
        + (holds ? 'YES' : 'NO ').padEnd(12) + x.R.name);
      if (holds && pRot <= 0.05) survivors.push({ tname, rule: x.R.name, n: x.n1, t: x.t, m1: x.m1, m2: x.m2 });
    }
  }

  // ── POSITIVE CONTROL / POWER CURVE ────────────────────────────────────────────────────────────────
  // "We found nothing" is worthless unless the pipeline can find something. So: take the real
  // v7-20-minus-v4-20 series, INJECT a known per-day edge on the firing days of a real 2-way rule, and
  // re-run the entire mine + permutation. This answers the only question that makes a null result useful —
  // HOW BIG an effect would have had to be for this search to see it.
  console.log(`\n\n${'='.repeat(110)}`);
  console.log('POSITIVE CONTROL — how big an effect would this search have detected?');
  console.log('='.repeat(110));
  {
    const yBase = Float64Array.from(rows.map(r => P('v7-20', r) - P('v4-20', r)));
    let sd = 0; { const m = mean([...yBase]); for (const v of yBase) sd += (v - m) ** 2; sd = Math.sqrt(sd / (N - 1)); }
    // pick a real 2-way rule with a mid-sized support to carry the injected effect
    const carrier = rules.filter(r => r.name.split(' AND ').length === 2 && r.idx.length >= 45 && r.idx.length <= 60)[0]
      || rules.find(r => r.idx.length >= 40);
    console.log(`  daily sd of (v7-20 - v4-20): ${usd(sd)}`);
    console.log(`  carrier rule (a real 2-way conjunction in the searched set), n=${carrier.idx.length}: ${carrier.name}`);
    console.log('\n  injected edge/day'.padEnd(22) + 'best |t| found'.padEnd(17) + 'ROTATE null p90'.padEnd(18) + 'family-wise p'.padEnd(16) + 'detected?'.padEnd(12) + 'was it the carrier rule?');
    const PC_PERMS = Math.min(PERMS, 100);
    for (const eff of [2500, 5000, 10000, 20000, 40000]) {
      const y = Float64Array.from(yBase);
      for (let j = 0; j < carrier.idx.length; j++) y[carrier.idx[j]] += eff;
      const top = rankAll(y)[0];
      const obsT = Math.abs(top.t);
      const rnd2 = mulberry32(0xBEEF);
      const tmp = new Float64Array(N); const nulls = [];
      for (let p = 0; p < PC_PERMS; p++) {
        const off = 1 + Math.floor(rnd2() * (N - 1));
        for (let k = 0; k < N; k++) tmp[k] = y[(k + off) % N];
        nulls.push(Math.abs(scoreAll(tmp).bestT));
      }
      nulls.sort((a, b) => a - b);
      const pfw = (nulls.filter(x => x >= obsT).length + 1) / (PC_PERMS + 1);
      const isCarrier = top.R.name === carrier.name;
      console.log('  ' + ('+' + usd(eff)).padEnd(20) + obsT.toFixed(2).padEnd(17)
        + nulls[Math.floor(PC_PERMS * 0.9)].toFixed(2).padEnd(18) + pfw.toFixed(3).padEnd(16)
        + (pfw <= 0.05 ? 'YES' : 'no').padEnd(12) + (isCarrier ? 'YES — exact rule recovered' : 'no — top rule was: ' + top.R.name));
    }
    console.log('\n  READ THIS AS THE DETECTION FLOOR: any conjunction-shaped edge at or above the smallest injected');
    console.log('  size marked "detected" WOULD have been found. Nothing at that size exists in the real data.');
  }

  console.log(`\n\n${'='.repeat(110)}`);
  console.log('MINED-RULE SURVIVORS (cleared the ROTATE permutation null AND held their sign in all 4 quarters + both halves)');
  console.log('='.repeat(110));
  if (!survivors.length) console.log('  NONE. Every mined conjunction is inside the noise floor of the search that found it.');
  else for (const s of survivors) console.log(`  [${s.tname}] n=${s.n} t=${s.t.toFixed(2)} in ${usd(s.m1)} vs out ${usd(s.m2)} :: ${s.rule}`);
})();
