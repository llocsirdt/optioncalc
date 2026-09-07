#!/usr/bin/env node
'use strict';
/**
 * TEST-BAND-PATTERNS — seven PRE-REGISTERED prior-day candle/band patterns, tested and only tested.
 *
 * WHY THIS SCRIPT EXISTS
 *   A brute-force mine of 18,013 conjunctions (mine-regime-rules.js PART 3) found nothing, and its own
 *   positive control put the detection floor at ~$15-20k/day on a 50-day rule. That is not a statement that
 *   no edge exists; it is a statement that a SEARCH cannot see one at this sample size. A pre-registered
 *   hypothesis pays no search penalty, so it is worth far more per unit of data. These seven come from the
 *   user's own chart reading and were written down BEFORE any number below was computed.
 *
 * THE STRUCTURAL DISTINCTION BEING TESTED
 *   A candle that CLOSES outside a Bollinger band is a different event from one that merely WICKS into or
 *   through it. A close outside the band is an accepted price beyond two standard deviations; a wick that is
 *   rejected back inside is the band holding. Every pattern here is phrased on the CLOSE, and P7 puts the
 *   two forms head to head on the one rule that already survived (prior-day green whose low touched the
 *   lower band, n=24, rotation p 0.0028).
 *
 * NO-LOOKAHEAD CONTRACT (inherited verbatim from classify-regimes.js / mine-regime-rules.js)
 *   - Every feature is a property of daily candle D[i-1] measured against IND[i-1] — the daily BB(20,2),
 *     EMA9 and ATR(14) AS OF YESTERDAY'S CLOSE. Nothing from day i's session can reach a feature. The
 *     multi-day trend terms for P5/P6 reach back to D[i-5]; still strictly prior days.
 *   - The realized outcome of day i (green/red, |close-open|, high-low range) and every P&L number are
 *     TARGETS ONLY and never feed a pattern definition.
 *   - Bands are read at i-1, which means yesterday's close is inside the 20-day SMA window used to build the
 *     bands yesterday's close is compared against. That is standard %B and is what a chart shows; it is not
 *     lookahead, because every input closed at or before yesterday's bell.
 *
 * BASELINE REPRODUCTION
 *   optsFor is COPIED VERBATIM from build-backtest-baselines.js (VC.assertForwarded guard included) and every
 *   per-variant total is asserted against server/src/candle-spread/backtest-baselines.json to the dollar. The
 *   script refuses to print a single pattern result if they disagree.
 *
 * THE NULL
 *   Circular rotation of the firing mask, exhaustive over all N offsets. Both the features and the daily
 *   P&L are autocorrelated and these patterns fire in calendar clusters, so an i.i.d. shuffle understates the
 *   noise floor. Two-sided p = share of the N rotations whose statistic is at least as far from the all-days
 *   mean as the real alignment. Exact and reproducible; no seed.
 *
 * Usage: node scripts/candle-spread/test-band-patterns.js [--dataDir D] [--workers N]
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
const CACHE = arg('--cache', path.join(os.tmpdir(), 'test-band-patterns-pnl-cache.json'));
// Sibling scripts compute the SAME 30-variant per-day P&L under the SAME key. Reading their cache is free
// and cannot change a number (the key encodes dataset, day count, variant list and the IV flag, and the
// blocking reproduction check below re-verifies every total against the committed baselines regardless).
const DONOR_CACHES = ['classify-regimes-pnl-cache.json', 'mine-regime-rules-pnl-cache.json']
  .map(f => path.join(os.tmpdir(), f));
const BASELINES = path.join(__dirname, '..', '..', 'server', 'src', 'candle-spread', 'backtest-baselines.json');
const INTRADAY_IV = true;

const usd = n => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');
const pct = n => (n * 100).toFixed(1) + '%';
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

const etMin = ms => { const d = new Date(new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York' })); return d.getHours() * 60 + d.getMinutes(); };
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

// ══ 3. PRIOR-DAY FEATURES (the pattern vocabulary; all read at i-1) ═════════════════════════════════
function featuresFor(i) {
  if (i < 60) return null;                 // same warm-up as the sibling scripts, so the day set matches
  const p = D[i - 1], pi = IND[i - 1];
  if (pi.bbupper == null || pi.atr14 == null || !pi.atr14) return null;
  const atr = pi.atr14;
  const f = { date: D[i].date, i, pdDate: p.date, atr };

  const pr = p.high - p.low, body = p.close - p.open;
  f.pdGreen = body > 0 ? 1 : 0;
  f.pdBodyFrac = pr > 0 ? Math.abs(body) / pr : 0;          // 1 = marubozu, ~0 = doji
  f.pdUpperWick = pr > 0 ? (p.high - Math.max(p.open, p.close)) / pr : 0;
  f.pdLowerWick = pr > 0 ? (Math.min(p.open, p.close) - p.low) / pr : 0;
  f.pdRangeAtr = pr / atr;
  f.pdBodyAtr = Math.abs(body) / atr;
  // %B of yesterday's CLOSE / LOW / HIGH inside yesterday's bands. 0 = exactly on the lower band, 1 = on
  // the upper band. CLOSED BELOW the lower band is pdPctB < 0; WICKED to/through it is pdLowPctB <= 0.
  // The whole point of this script is that those are different events.
  f.pdPctB = (p.close - pi.bblower) / (pi.bbupper - pi.bblower);
  f.pdLowPctB = (p.low - pi.bblower) / (pi.bbupper - pi.bblower);
  f.pdHighPctB = (p.high - pi.bblower) / (pi.bbupper - pi.bblower);
  f.pdClosedBelowLower = p.close < pi.bblower ? 1 : 0;
  f.pdClosedAboveUpper = p.close > pi.bbupper ? 1 : 0;
  f.pdWickedBelowLower = p.low <= pi.bblower ? 1 : 0;
  f.pdWickedAboveUpper = p.high >= pi.bbupper ? 1 : 0;
  f.pdInsideBands = (p.low > pi.bblower && p.high < pi.bbupper) ? 1 : 0;   // ENTIRE candle inside

  // Multi-day trend for P5/P6, measured over the three days ENDING THE DAY BEFORE the pattern candle, so
  // the pattern candle itself is not part of the trend it is supposed to interrupt. Expressed in ATR units
  // because 60 points is a trend in a quiet regime and noise in a loud one.
  f.trend3 = (D[i - 2].close - D[i - 5].close) / atr;
  // Consecutive same-colour days ending at D[i-2] — the robustness form of the same idea.
  let st = 0; const dir = D[i - 2].close > D[i - 2].open ? 1 : -1;
  for (let j = i - 2; j >= 0; j--) { const s = D[j].close > D[j].open ? 1 : -1; if (s !== dir) break; st++; }
  f.priorStreak = st * dir;
  return f;
}

// ══ 4. REALIZED OUTCOME OF DAY i (target only — never a feature) ════════════════════════════════════
function outcomeFor(i) {
  const d = D[i], rth = d.rth;
  if (rth.length < 30) return null;
  const O = d.open, C = d.close, H = d.high, L = d.low, R = H - L;
  if (!(R > 0)) return null;
  return { date: d.date, green: C > O ? 1 : 0, retPts: C - O, absRet: Math.abs(C - O), rangePts: R,
    closeLoc: (C - L) / R };
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
  if (v.enforceLegUniqueness) { o.enforceLegUniqueness = true; if (v.legMaxShift != null) o.legMaxShift = v.legMaxShift; if (v.legMaxWing != null) o.legMaxWing = v.legMaxWing; }
  const w = v.spreadWidth, sh = v.spreadShift || 0, cf = v.capFrac;
  o.geo = v.adaptiveGeo
    ? makeAdaptiveGeo({ width: w || 20, incr: 10, maxDebitFrac: cf != null ? cf : 0.65, maxItmStrikes: v.maxItmStrikes != null ? v.maxItmStrikes : 3 })
    : makeGeo({ width: w || 20, shift: sh, capFrac: cf != null ? cf : undefined });
  if (HAS_PX) o.priceOf = (b) => b.px || { close: b.analysis['5m'].close, high: b.analysis['5m'].high, low: b.analysis['5m'].low };
  VC.assertForwarded(v, Object.keys(o), 'test-band-patterns optsFor',
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
  for (const cf of [CACHE].concat(DONOR_CACHES)) {
    if (!fs.existsSync(cf)) continue;
    try { const c = JSON.parse(fs.readFileSync(cf, 'utf8')); if (c.key === key) { console.log(`(P&L from cache ${path.basename(cf)})`); return c.pnl; } } catch (e) {}
  }
  const pnl = {};
  if (WORKERS > 1) {
    const { spawn } = require('child_process');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'band-pnl-'));
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

// ══ 6. STATS HELPERS (verbatim from mine-regime-rules.js) ═══════════════════════════════════════════
const normP = z => { const t = 1 / (1 + 0.2316419 * Math.abs(z)); const d = 0.3989422804014327 * Math.exp(-z * z / 2); return 2 * d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429)))); };
function welch(a, b) {
  if (a.length < 3 || b.length < 3) return null;
  const ma = mean(a), mb = mean(b);
  const va = a.reduce((s, x) => s + (x - ma) ** 2, 0) / (a.length - 1);
  const vb = b.reduce((s, x) => s + (x - mb) ** 2, 0) / (b.length - 1);
  const se = Math.sqrt(va / a.length + vb / b.length);
  return se > 0 ? { t: (ma - mb) / se, ma, mb, se } : null;
}
function wilson(k, n, z = 1.96) {
  if (!n) return [0, 0];
  const p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d;
  const h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}
function propZ(k1, n1, k2, n2) {
  if (!n1 || !n2) return null;
  const p1 = k1 / n1, p2 = k2 / n2, p = (k1 + k2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  return se > 0 ? (p1 - p2) / se : null;
}

(async () => {
  console.log(`\n${'='.repeat(118)}`);
  console.log('PRE-REGISTERED BAND-PATTERN TEST — "closed outside the band" vs "wicked into it"');
  console.log('='.repeat(118));
  console.log(`dataset ${path.basename(DIR)} — ${allDays.length} calendar days -> ${days.length} trading days (RTH cash session present)`);
  console.log(`pricing series: ${HAS_PX ? 'cash NDX (px)' : 'signal series'}   signals: /NQ 24h (foundational rule)\n`);

  const rows = [];
  for (let i = 0; i < D.length; i++) {
    const f = featuresFor(i), l = outcomeFor(i);
    if (f && l) rows.push({ i, date: D[i].date, f, l });
  }
  const N = rows.length;
  console.log(`${N} testable days (first 60 skipped: daily BB/ATR warm-up), ${rows[0].date} .. ${rows[N - 1].date}`);

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
  for (const k of ['v7-10', 'v7-20', 'v4-20', 'v6-20']) {
    const t = Math.round(pnl[k].reduce((a, b) => a + b, 0));
    console.log(`  ${k.padEnd(8)} ${String(t).padStart(9)} == committed ${String(base.variants[k].total).padStart(9)}  ${t === base.variants[k].total ? 'OK' : 'MISMATCH'}`);
  }
  console.log(`  ${bad === 0 ? 'ALL ' + RUNS.length + ' CAPPED VARIANTS MATCH EXACTLY' : bad + ' MISMATCHES'}`);
  if (bad) { console.error('\nRefusing to report: opts do not reproduce the committed baseline.'); process.exit(1); }

  const P = (name, r) => pnl[name][r.i];
  const WATCH20 = ['v0-20', 'v4-20', 'v5-20', 'v6-20', 'v7-20', 'v9-20'];
  const WATCH10 = ['v0-10', 'v4-10', 'v5-10', 'v6-10', 'v7-10', 'v9-10'];
  const allAvg = {};
  for (const n of RUNS.map(r => r.variant)) allAvg[n] = mean(rows.map(r => P(n, r)));

  // ══ BODY-SIZE CALIBRATION ═════════════════════════════════════════════════════════════════════════
  // "Large body" and "small body" are set at MEASURED quantiles of body/range over the testable days, not
  // at round numbers picked by feel. Terciles rather than a tighter cut because every pattern here is
  // already gated on a rare band event; a p85 "large" cut would leave single-digit n and nothing to test.
  const bfAll = rows.map(r => r.f.pdBodyFrac).sort((a, b) => a - b);
  const Q = p => bfAll[Math.min(bfAll.length - 1, Math.floor(bfAll.length * p))];
  const BIG = Q(2 / 3), SMALL = Q(1 / 3);
  console.log('\n\nBODY-SIZE CALIBRATION — distribution of |close-open| / (high-low) over the ' + N + ' prior-day candles');
  console.log('  p10 ' + Q(0.10).toFixed(3) + '   p25 ' + Q(0.25).toFixed(3) + '   p33 ' + Q(1 / 3).toFixed(3)
    + '   p50 ' + Q(0.50).toFixed(3) + '   p67 ' + Q(2 / 3).toFixed(3) + '   p75 ' + Q(0.75).toFixed(3)
    + '   p90 ' + Q(0.90).toFixed(3));
  console.log(`  LARGE BODY := bodyFrac >= ${BIG.toFixed(3)} (top tercile, ${rows.filter(r => r.f.pdBodyFrac >= BIG).length} days)`);
  console.log(`  SMALL BODY := bodyFrac <= ${SMALL.toFixed(3)} (bottom tercile, ${rows.filter(r => r.f.pdBodyFrac <= SMALL).length} days) — "doji / hammer" in the user's vocabulary`);

  // ══ BAND-EVENT BASE RATES — how rare is each half of the close-vs-wick distinction? ════════════════
  console.log('\nBAND-EVENT FREQUENCY (prior-day candle vs the daily BB(20,2) as of its own close)');
  const bandEvents = [
    ['CLOSED below lower band', r => r.f.pdClosedBelowLower === 1],
    ['WICKED to/through lower band', r => r.f.pdWickedBelowLower === 1],
    ['WICKED lower but CLOSED inside', r => r.f.pdWickedBelowLower === 1 && r.f.pdClosedBelowLower === 0],
    ['CLOSED above upper band', r => r.f.pdClosedAboveUpper === 1],
    ['WICKED to/through upper band', r => r.f.pdWickedAboveUpper === 1],
    ['WICKED upper but CLOSED inside', r => r.f.pdWickedAboveUpper === 1 && r.f.pdClosedAboveUpper === 0],
    ['ENTIRE candle inside the bands', r => r.f.pdInsideBands === 1],
  ];
  for (const [nm, fn] of bandEvents) {
    const c = rows.filter(fn).length;
    console.log('  ' + nm.padEnd(34) + String(c).padStart(4) + ' days  ' + pct(c / N).padStart(7));
  }

  // ══ THE SEVEN PRE-REGISTERED PATTERNS ═════════════════════════════════════════════════════════════
  const PATTERNS = [
    ['P1', 'LARGE RED body CLOSING BELOW the lower daily band',
      r => r.f.pdGreen === 0 && r.f.pdBodyFrac >= BIG && r.f.pdClosedBelowLower === 1,
      'user: often followed by a big GREEN day up (directional + magnitude claim)'],
    ['P2', 'LARGE GREEN body CLOSING ABOVE the upper daily band',
      r => r.f.pdGreen === 1 && r.f.pdBodyFrac >= BIG && r.f.pdClosedAboveUpper === 1,
      'mirror of P1; user unsure what follows — exploratory'],
    ['P3', 'SMALL body (doji/hammer, either colour) CLOSING BELOW the lower band',
      r => r.f.pdBodyFrac <= SMALL && r.f.pdClosedBelowLower === 1,
      'exhaustion at the lower band without acceptance'],
    ['P4', 'SMALL body (doji/hammer, either colour) CLOSING ABOVE the upper band',
      r => r.f.pdBodyFrac <= SMALL && r.f.pdClosedAboveUpper === 1,
      'mirror of P3'],
    ['P5', 'GREEN candle inside a RED/down 3-day trend, ENTIRE candle inside the bands',
      r => r.f.pdGreen === 1 && r.f.trend3 <= -0.5 && r.f.pdInsideBands === 1,
      'counter-trend reversal candle away from the band edges'],
    ['P6', 'RED candle inside a GREEN/up 3-day trend, ENTIRE candle inside the bands',
      r => r.f.pdGreen === 0 && r.f.trend3 >= 0.5 && r.f.pdInsideBands === 1,
      'mirror of P5'],
    ['P7a', 'GREEN, low WICKED to/through the lower band, CLOSED back INSIDE',
      r => r.f.pdGreen === 1 && r.f.pdWickedBelowLower === 1 && r.f.pdClosedBelowLower === 0,
      'the WICK arm of the wick-vs-close contrast (the shipped H1a rule, minus its close-outside days)'],
    ['P7b', 'GREEN, CLOSED BELOW the lower band',
      r => r.f.pdGreen === 1 && r.f.pdClosedBelowLower === 1,
      'the CLOSE arm of the wick-vs-close contrast'],
  ];
  // Bonferroni. Seven pre-registered PATTERNS (P7 is one pattern tested as two arms) with TWO headline
  // statistics each — the directional claim (green rate) and the magnitude claim (|close-open|) — is a
  // family of 14 tests: bar = 0.05/14 = 0.0036. Every other number printed per pattern (range, per-variant
  // P&L) is DESCRIPTIVE, reported so the size of the thing is visible, and is not claimed as significant
  // unless it clears the far harsher per-variant bar stated at the summary.
  const BONF_N = 14, BONF = 0.05 / BONF_N;

  const baseGreen = rows.filter(r => r.l.green).length / N;
  const baseAbs = mean(rows.map(r => r.l.absRet));
  const baseRange = mean(rows.map(r => r.l.rangePts));
  const baseRet = mean(rows.map(r => r.l.retPts));
  console.log(`\nBASE RATES over the ${N} testable days:`);
  console.log(`  next-day GREEN ${pct(baseGreen)}   mean signed move ${baseRet.toFixed(1)} pts   mean |close-open| ${baseAbs.toFixed(1)} pts   mean high-low range ${baseRange.toFixed(1)} pts`);
  console.log(`  Bonferroni bar for ${BONF_N} pre-registered headline tests (7 patterns x {direction, magnitude}): p < ${BONF.toFixed(4)}`);

  // ── circular rotation null, exhaustive over all N offsets ────────────────────────────────────────
  const kIdx = new Map(rows.map((r, k) => [r, k]));
  function rotP(maskIdx, y) {
    const gm = mean(y), n = maskIdx.length;
    const obs = mean(maskIdx.map(k => y[k]));
    let ge = 0;
    for (let off = 0; off < N; off++) {
      let s = 0; for (const k of maskIdx) s += y[(k + off) % N];
      if (Math.abs(s / n - gm) >= Math.abs(obs - gm) - 1e-9) ge++;
    }
    return { p: ge / N, obs, gm };
  }
  const QN = 4, qOf = k => Math.min(QN - 1, Math.floor(k / (N / QN)));
  const MIDN = Math.floor(N / 2);

  const Y = {
    green: rows.map(r => r.l.green),
    ret: rows.map(r => r.l.retPts),
    abs: rows.map(r => r.l.absRet),
    range: rows.map(r => r.l.rangePts),
  };
  for (const n of WATCH20.concat(WATCH10)) Y[n] = rows.map(r => P(n, r));

  const summary = [];
  for (const [tag, desc, fn, note] of PATTERNS) {
    const S = rows.filter(fn), C = rows.filter(r => !fn(r));
    console.log(`\n\n${'='.repeat(118)}`);
    console.log(`${tag}  ${desc}`);
    console.log(`     (${note})`);
    console.log('='.repeat(118));
    console.log(`  FIRES on ${S.length} of ${N} days (${pct(S.length / N)})`);
    if (S.length < 15) {
      console.log(`  *** n = ${S.length} < 15. UNTESTABLE AT THIS SAMPLE SIZE. ***`);
      console.log('  Any statistic below is printed for completeness only and must NOT be read as evidence:');
      if (S.length) {
        console.log('    firing days: ' + S.map(r => `${r.f.pdDate}->${r.date}`).join(', '));
        console.log(`    next-day green ${S.filter(r => r.l.green).length}/${S.length}   mean |close-open| ${mean(S.map(r => r.l.absRet)).toFixed(1)} pts (base ${baseAbs.toFixed(1)})`);
      }
      summary.push({ tag, n: S.length, untestable: true });
      continue;
    }

    // ── DIRECTIONAL OUTCOME ──
    const g = S.filter(r => r.l.green).length;
    const [glo, ghi] = wilson(g, S.length);
    const zg = propZ(g, S.length, C.filter(r => r.l.green).length, C.length);
    const rg = rotP(S.map(r => kIdx.get(r)), Y.green);
    console.log('\n  DIRECTION');
    console.log(`    next-day GREEN     ${g}/${S.length} = ${pct(g / S.length)}  [95% CI ${pct(glo)}..${pct(ghi)}]   base ${pct(baseGreen)}   two-prop z ${zg == null ? 'n/a' : zg.toFixed(2)} (p ${zg == null ? '-' : normP(zg).toFixed(3)})`);
    console.log(`                       ROTATION p ${rg.p.toFixed(4)}  ${rg.p < BONF ? 'CLEARS the 0.0036 bar' : 'does not clear the 0.0036 bar'}`);
    const wr = welch(S.map(r => r.l.retPts), C.map(r => r.l.retPts));
    const rr = rotP(S.map(r => kIdx.get(r)), Y.ret);
    console.log(`    next-day SIGNED    mean ${mean(S.map(r => r.l.retPts)).toFixed(1)} pts vs ${mean(C.map(r => r.l.retPts)).toFixed(1)} elsewhere (base ${baseRet.toFixed(1)})   Welch t ${wr ? wr.t.toFixed(2) : 'n/a'}   ROTATION p ${rr.p.toFixed(4)}`);

    // ── MAGNITUDE OUTCOME ──
    const wa = welch(S.map(r => r.l.absRet), C.map(r => r.l.absRet));
    const ra = rotP(S.map(r => kIdx.get(r)), Y.abs);
    const wR = welch(S.map(r => r.l.rangePts), C.map(r => r.l.rangePts));
    const rR = rotP(S.map(r => kIdx.get(r)), Y.range);
    console.log('\n  MAGNITUDE');
    console.log(`    |close-open|       ${mean(S.map(r => r.l.absRet)).toFixed(1)} pts vs ${mean(C.map(r => r.l.absRet)).toFixed(1)} elsewhere (base ${baseAbs.toFixed(1)})   ratio ${(mean(S.map(r => r.l.absRet)) / baseAbs).toFixed(2)}x   Welch t ${wa ? wa.t.toFixed(2) : 'n/a'}`);
    console.log(`                       ROTATION p ${ra.p.toFixed(4)}  ${ra.p < BONF ? 'CLEARS the 0.0036 bar' : 'does not clear the 0.0036 bar'}`);
    console.log(`    high-low range     ${mean(S.map(r => r.l.rangePts)).toFixed(1)} pts vs ${mean(C.map(r => r.l.rangePts)).toFixed(1)} elsewhere (base ${baseRange.toFixed(1)})   ratio ${(mean(S.map(r => r.l.rangePts)) / baseRange).toFixed(2)}x   Welch t ${wR ? wR.t.toFixed(2) : 'n/a'}   ROTATION p ${rR.p.toFixed(4)}`);

    // ── PER-VARIANT P&L ──
    for (const [pool, label] of [[WATCH20, '$20 width'], [WATCH10, '$10 width']]) {
      const tab = pool.map(n => {
        const a = S.map(r => P(n, r)), b = C.map(r => P(n, r));
        const w = welch(a, b);
        return { n, avg: mean(a), lift: mean(a) - allAvg[n], t: w ? w.t : null,
          win: a.filter(x => x > 0).length / a.length, worst: Math.min(...a),
          rp: rotP(S.map(r => kIdx.get(r)), Y[n]).p };
      }).sort((a, b) => b.lift - a.lift);
      console.log(`\n  PER-VARIANT P&L on the ${S.length} firing days — ${label}  ("lift" = avg here minus that variant's own all-days avg)`);
      console.log('    ' + 'variant'.padEnd(9) + 'avg/day'.padEnd(11) + 'all-days'.padEnd(11) + 'lift'.padEnd(11)
        + 'contrast t'.padEnd(12) + 'rot p'.padEnd(9) + 'win%'.padEnd(8) + 'worst day');
      for (const x of tab) {
        console.log('    ' + x.n.padEnd(9) + usd(x.avg).padEnd(11) + usd(allAvg[x.n]).padEnd(11)
          + ((x.lift >= 0 ? '+' : '') + usd(x.lift)).padEnd(11) + (x.t == null ? 'n/a' : x.t.toFixed(2)).padEnd(12)
          + x.rp.toFixed(4).padEnd(9) + pct(x.win).padEnd(8) + usd(x.worst));
      }
      if (label === '$20 width') {
        const av = S.map(r => r.l.absRet).sort((a, b) => a - b);
        const big = S.slice().sort((a, b) => b.l.absRet - a.l.absRet)[0];
        summary.push({ tag, n: S.length, greenRate: g / S.length, pGreen: rg.p,
          abs: mean(S.map(r => r.l.absRet)), med: av[Math.floor(av.length / 2)], pAbs: ra.p,
          pAbsNoBig: rotP(S.filter(r => r !== big).map(r => kIdx.get(r)), Y.abs).p, best: tab[0] });
      }
    }

    // ── SPLIT-HALF AND QUARTERS (printed for every testable pattern, not only survivors, so a reader can
    //    see the instability of the ones that fail rather than having to take "fails" on trust) ──
    const idxs = S.map(r => kIdx.get(r));
    const H1 = S.filter(r => kIdx.get(r) < MIDN), H2 = S.filter(r => kIdx.get(r) >= MIDN);
    console.log('\n  STABILITY');
    console.log(`    split-half   H1 (${rows[0].date}..${rows[MIDN - 1].date}) n=${H1.length}: green ${H1.length ? pct(H1.filter(r => r.l.green).length / H1.length) : '-'}  |move| ${H1.length ? mean(H1.map(r => r.l.absRet)).toFixed(1) : '-'}  v7-20 ${H1.length ? usd(mean(H1.map(r => P('v7-20', r)))) : '-'}`);
    console.log(`                 H2 (${rows[MIDN].date}..${rows[N - 1].date}) n=${H2.length}: green ${H2.length ? pct(H2.filter(r => r.l.green).length / H2.length) : '-'}  |move| ${H2.length ? mean(H2.map(r => r.l.absRet)).toFixed(1) : '-'}  v7-20 ${H2.length ? usd(mean(H2.map(r => P('v7-20', r)))) : '-'}`);
    const qline = (fmt, sel) => [...Array(QN)].map((_, q) => {
      const s = S.filter(r => qOf(kIdx.get(r)) === q);
      return (s.length ? `n${s.length} ${fmt(sel(s))}` : 'n0 —').padEnd(20);
    }).join('');
    console.log('    quarters     Q1'.padEnd(20) + 'Q2'.padEnd(20) + 'Q3'.padEnd(20) + 'Q4');
    console.log('      green      ' + qline(v => pct(v), s => s.filter(r => r.l.green).length / s.length));
    console.log('      |move|     ' + qline(v => v.toFixed(0) + 'pts', s => mean(s.map(r => r.l.absRet))));
    console.log('      v7-20      ' + qline(v => usd(v), s => mean(s.map(r => P('v7-20', r)))));
    console.log('      v4-20      ' + qline(v => usd(v), s => mean(s.map(r => P('v4-20', r)))));

    // every firing day, so nobody has to wonder whether it is two enormous days
    // ── ADVERSARIAL BLOCK ──────────────────────────────────────────────────────────────────────────
    // Three attacks, run on every testable pattern, because the two that matter most (P1 and P7a) both
    // have a magnitude effect built out of very few very large days.
    console.log('\n  ADVERSARIAL');
    // (a) OUTLIER STRESS. A 2x magnitude ratio built by one 2,000-point day is not a 2x magnitude effect.
    {
      const av = S.map(r => r.l.absRet).sort((a, b) => a - b);
      const drop1 = av.slice(0, av.length - 1), trim = av.slice(1, av.length - 1);
      const big = S.slice().sort((a, b) => b.l.absRet - a.l.absRet)[0];
      const idxNoBig = S.filter(r => r !== big).map(r => kIdx.get(r));
      console.log(`    (a) outliers   |move| mean ${mean(av).toFixed(1)}  median ${av[Math.floor(av.length / 2)].toFixed(1)}  drop-largest ${mean(drop1).toFixed(1)}  trimmed(1 hi+1 lo) ${mean(trim).toFixed(1)}   base median ${[...Y.abs].sort((a, b) => a - b)[Math.floor(N / 2)].toFixed(1)}`);
      console.log(`                   largest single day ${big.date} at ${big.l.absRet.toFixed(0)} pts; without it the rotation p on |move| becomes ${rotP(idxNoBig, Y.abs).p.toFixed(4)}`);
      // leave-one-out worst case on the best variant's lift
      const bn = ['v7-20', 'v6-20', 'v4-20'];
      console.log('                   leave-one-out WORST lift: ' + bn.map(n => {
        let w = null;
        for (let k = 0; k < S.length; k++) { const m = mean(S.filter((_, j) => j !== k).map(r => P(n, r))) - allAvg[n]; if (w == null || m < w) w = m; }
        return `${n} ${(w >= 0 ? '+' : '') + usd(w)} (full ${(mean(S.map(r => P(n, r))) - allAvg[n] >= 0 ? '+' : '') + usd(mean(S.map(r => P(n, r))) - allAvg[n])})`;
      }).join('   '));
    }
    // (b) MARGINAL VALUE OF EACH CONJUNCT. If dropping a clause leaves the effect intact (or improves it),
    // that clause is decoration and the pattern as stated is over-specified.
    {
      const CONJ = {
        P1: [['drop "large body"', r => r.f.pdGreen === 0 && r.f.pdClosedBelowLower === 1],
          ['drop "red"', r => r.f.pdBodyFrac >= BIG && r.f.pdClosedBelowLower === 1],
          ['drop "closed below" -> wicked below', r => r.f.pdGreen === 0 && r.f.pdBodyFrac >= BIG && r.f.pdWickedBelowLower === 1]],
        P2: [['drop "large body"', r => r.f.pdGreen === 1 && r.f.pdClosedAboveUpper === 1],
          ['drop "green"', r => r.f.pdBodyFrac >= BIG && r.f.pdClosedAboveUpper === 1],
          ['drop "closed above" -> wicked above', r => r.f.pdGreen === 1 && r.f.pdBodyFrac >= BIG && r.f.pdWickedAboveUpper === 1]],
        P5: [['drop "inside bands"', r => r.f.pdGreen === 1 && r.f.trend3 <= -0.5],
          ['drop "down trend"', r => r.f.pdGreen === 1 && r.f.pdInsideBands === 1]],
        P6: [['drop "inside bands"', r => r.f.pdGreen === 0 && r.f.trend3 >= 0.5],
          ['drop "up trend"', r => r.f.pdGreen === 0 && r.f.pdInsideBands === 1]],
        P7a: [['drop "green"', r => r.f.pdWickedBelowLower === 1 && r.f.pdClosedBelowLower === 0],
          ['drop "closed inside"', r => r.f.pdGreen === 1 && r.f.pdWickedBelowLower === 1]],
      }[tag];
      if (CONJ) {
        console.log('    (b) marginal value of each clause — if dropping it does not hurt, the clause is decoration');
        console.log('        ' + 'form'.padEnd(38) + 'n'.padEnd(6) + 'green'.padEnd(9) + '|move|'.padEnd(10) + 'v7-20 lift'.padEnd(13) + 'v6-20 lift');
        const line = (nm, s) => console.log('        ' + nm.padEnd(38) + String(s.length).padEnd(6)
          + (s.length ? pct(s.filter(r => r.l.green).length / s.length) : '-').padEnd(9)
          + (s.length ? mean(s.map(r => r.l.absRet)).toFixed(1) : '-').padEnd(10)
          + (s.length ? ((mean(s.map(r => P('v7-20', r))) - allAvg['v7-20'] >= 0 ? '+' : '') + usd(mean(s.map(r => P('v7-20', r))) - allAvg['v7-20'])) : '-').padEnd(13)
          + (s.length ? ((mean(s.map(r => P('v6-20', r))) - allAvg['v6-20'] >= 0 ? '+' : '') + usd(mean(s.map(r => P('v6-20', r))) - allAvg['v6-20'])) : '-'));
        line('AS STATED', S);
        for (const [nm, f2] of CONJ) line(nm, rows.filter(f2));
      }
    }
    // (c) PRIOR-DAY VOLATILITY CONTROL. Any candle that closes outside a 2-sigma band is, by construction,
    // a day with an unusually large range — and daily range is strongly autocorrelated. So "tomorrow moves
    // more" may be nothing but "yesterday was volatile". Control by matching each firing day to the
    // NON-firing days in its own prior-day-range quintile and comparing within-quintile.
    {
      const rq = rows.map(r => r.f.pdRangeAtr).sort((a, b) => a - b);
      const cuts = [0.2, 0.4, 0.6, 0.8].map(p => rq[Math.floor(rq.length * p)]);
      const qOfR = v => { let q = 0; while (q < 4 && v > cuts[q]) q++; return q; };
      let num = 0, den = 0, matched = [];
      const dist = [0, 0, 0, 0, 0];
      for (const r of S) dist[qOfR(r.f.pdRangeAtr)]++;
      for (let q = 0; q < 5; q++) {
        if (!dist[q]) continue;
        const ctrl = C.filter(r => qOfR(r.f.pdRangeAtr) === q);
        if (!ctrl.length) continue;
        num += dist[q] * mean(ctrl.map(r => r.l.absRet)); den += dist[q];
        matched.push(`Q${q + 1}:${dist[q]}d/ctrl ${mean(ctrl.map(r => r.l.absRet)).toFixed(0)}`);
      }
      const ctrlMean = den ? num / den : NaN;
      console.log(`    (c) vol control  firing days sit in prior-day-range quintiles [${matched.join(' ')}]`);
      console.log(`                   pattern |move| ${mean(S.map(r => r.l.absRet)).toFixed(1)} vs QUINTILE-MATCHED control ${ctrlMean.toFixed(1)} (unmatched base ${baseAbs.toFixed(1)})  ->  ${(mean(S.map(r => r.l.absRet)) / ctrlMean).toFixed(2)}x after controlling for yesterday's range`);
    }

    console.log('\n  FIRING DAYS (pattern candle -> traded day)');
    console.log('    pattern day'.padEnd(15) + 'traded day'.padEnd(14) + 'bodyFrac'.padEnd(10) + 'close %B'.padEnd(10)
      + 'g/r'.padEnd(6) + 'move pts'.padEnd(11) + 'range'.padEnd(9) + 'v7-20'.padEnd(11) + 'v4-20'.padEnd(11) + 'v6-20');
    for (const r of S) console.log('    ' + r.f.pdDate.padEnd(15) + r.date.padEnd(14)
      + r.f.pdBodyFrac.toFixed(2).padEnd(10) + r.f.pdPctB.toFixed(2).padEnd(10)
      + (r.l.green ? 'G' : 'R').padEnd(6) + r.l.retPts.toFixed(0).padEnd(11) + r.l.rangePts.toFixed(0).padEnd(9)
      + usd(P('v7-20', r)).padEnd(11) + usd(P('v4-20', r)).padEnd(11) + usd(P('v6-20', r)));
  }

  // ══ P7 — THE WICK-VS-CLOSE CONTRAST, HEAD TO HEAD ═════════════════════════════════════════════════
  console.log(`\n\n${'='.repeat(118)}`);
  console.log('P7 — WICK vs CLOSE, COLOUR HELD CONSTANT. Does the surviving H1a effect live in the wick or in the close?');
  console.log('='.repeat(118));
  const ARMS = [
    ['H1a (shipped)  green, low touched band (wick OR close)', r => r.f.pdGreen === 1 && r.f.pdLowPctB <= 0],
    ['P7a  green, WICKED lower band, CLOSED inside', r => r.f.pdGreen === 1 && r.f.pdWickedBelowLower === 1 && r.f.pdClosedBelowLower === 0],
    ['P7b  green, CLOSED BELOW lower band', r => r.f.pdGreen === 1 && r.f.pdClosedBelowLower === 1],
    ['---  red, WICKED lower band, CLOSED inside', r => r.f.pdGreen === 0 && r.f.pdWickedBelowLower === 1 && r.f.pdClosedBelowLower === 0],
    ['---  red, CLOSED BELOW lower band', r => r.f.pdGreen === 0 && r.f.pdClosedBelowLower === 1],
    ['---  any colour, WICKED lower, CLOSED inside', r => r.f.pdWickedBelowLower === 1 && r.f.pdClosedBelowLower === 0],
    ['---  any colour, CLOSED BELOW lower band', r => r.f.pdClosedBelowLower === 1],
  ];
  console.log('  arm'.padEnd(56) + 'n'.padEnd(6) + 'green'.padEnd(9) + '|move|'.padEnd(10) + 'range'.padEnd(9)
    + 'v7-20 lift'.padEnd(13) + 'v4-20 lift'.padEnd(13) + 'v6-20 lift'.padEnd(13) + 'rot p(|move|)');
  for (const [nm, fn] of ARMS) {
    const S = rows.filter(fn);
    if (!S.length) { console.log('  ' + nm.padEnd(56) + '0'); continue; }
    const rp = S.length >= 5 ? rotP(S.map(r => kIdx.get(r)), Y.abs).p : null;
    const lf = n => { const v = mean(S.map(r => P(n, r))) - allAvg[n]; return ((v >= 0 ? '+' : '') + usd(v)); };
    console.log('  ' + nm.padEnd(56) + String(S.length).padEnd(6)
      + pct(S.filter(r => r.l.green).length / S.length).padEnd(9)
      + mean(S.map(r => r.l.absRet)).toFixed(1).padEnd(10)
      + mean(S.map(r => r.l.rangePts)).toFixed(1).padEnd(9)
      + lf('v7-20').padEnd(13) + lf('v4-20').padEnd(13) + lf('v6-20').padEnd(13)
      + (rp == null ? 'n<5' : rp.toFixed(4)) + (S.length < 15 ? '   << n<15, UNTESTABLE' : ''));
  }
  console.log(`\n  base: green ${pct(baseGreen)}  |move| ${baseAbs.toFixed(1)}  range ${baseRange.toFixed(1)}`);

  // How much of H1a is the wick arm vs the close arm — a decomposition, not a test.
  {
    const A = rows.filter(r => r.f.pdGreen === 1 && r.f.pdLowPctB <= 0);
    const wick = A.filter(r => r.f.pdClosedBelowLower === 0), close = A.filter(r => r.f.pdClosedBelowLower === 1);
    console.log(`\n  DECOMPOSITION of H1a (n=${A.length}): ${wick.length} days are the WICK form, ${close.length} the CLOSE form.`);
    console.log(`    H1a total |move| contribution: wick arm ${wick.length ? mean(wick.map(r => r.l.absRet)).toFixed(1) : '-'} pts x ${wick.length} days, close arm ${close.length ? mean(close.map(r => r.l.absRet)).toFixed(1) : '-'} pts x ${close.length} days`);
    console.log(`    H1a v7-20 avg ${usd(mean(A.map(r => P('v7-20', r))))} = wick ${wick.length ? usd(mean(wick.map(r => P('v7-20', r)))) : '-'} / close ${close.length ? usd(mean(close.map(r => P('v7-20', r)))) : '-'}`);
    // The threshold ladder that the shipped setup uses: does the effect sit AT the band or does it decay?
    console.log('\n  SHIPPED-THRESHOLD LADDER — "green and low within X band-widths of the lower band"');
    console.log('    pdLowPctB <='.padEnd(16) + 'n'.padEnd(6) + 'green'.padEnd(9) + '|move|'.padEnd(10)
      + 'v7-20 lift'.padEnd(13) + 'rot p(|move|)');
    for (const th of [-0.05, -0.02, 0, 0.02, 0.05, 0.10, 0.15, 0.20, 0.30]) {
      const S = rows.filter(r => r.f.pdGreen === 1 && r.f.pdLowPctB <= th);
      if (S.length < 5) { console.log('    ' + String(th).padEnd(16) + String(S.length).padEnd(6) + '(too few)'); continue; }
      const lift = mean(S.map(r => P('v7-20', r))) - allAvg['v7-20'];
      console.log('    ' + String(th).padEnd(16) + String(S.length).padEnd(6)
        + pct(S.filter(r => r.l.green).length / S.length).padEnd(9)
        + mean(S.map(r => r.l.absRet)).toFixed(1).padEnd(10)
        + ((lift >= 0 ? '+' : '') + usd(lift)).padEnd(13) + rotP(S.map(r => kIdx.get(r)), Y.abs).p.toFixed(4));
    }
  }

  // ══ P5/P6 ROBUSTNESS — the trend definition is a choice, so show the alternative ═══════════════════
  console.log(`\n\n${'='.repeat(118)}`);
  console.log('P5 / P6 ROBUSTNESS — the multi-day trend definition is a modelling CHOICE, so both forms are shown');
  console.log('='.repeat(118));
  console.log('  PRIMARY   : 3-day net move over the days ENDING THE DAY BEFORE the pattern candle, >= 0.5 ATR in magnitude.');
  console.log('              Three days is the shortest window that is honestly "multi-day"; the ATR gate stops "drifted');
  console.log('              20 points" from counting as a trend; ending at i-2 keeps the reversal candle out of its own trend.');
  console.log('  ALTERNATE : at least 2 consecutive same-colour days ending at i-2 (pure candle-colour definition).');
  const P56 = [
    ['P5 primary  green in down-3d(<=-0.5 ATR), inside bands', r => r.f.pdGreen === 1 && r.f.trend3 <= -0.5 && r.f.pdInsideBands === 1],
    ['P5 sign-only green in any down-3d, inside bands', r => r.f.pdGreen === 1 && r.f.trend3 < 0 && r.f.pdInsideBands === 1],
    ['P5 alternate green after 2+ red days, inside bands', r => r.f.pdGreen === 1 && r.f.priorStreak <= -2 && r.f.pdInsideBands === 1],
    ['P5 no-band   green in down-3d(<=-0.5 ATR), any location', r => r.f.pdGreen === 1 && r.f.trend3 <= -0.5],
    ['P6 primary  red in up-3d(>=+0.5 ATR), inside bands', r => r.f.pdGreen === 0 && r.f.trend3 >= 0.5 && r.f.pdInsideBands === 1],
    ['P6 sign-only red in any up-3d, inside bands', r => r.f.pdGreen === 0 && r.f.trend3 > 0 && r.f.pdInsideBands === 1],
    ['P6 alternate red after 2+ green days, inside bands', r => r.f.pdGreen === 0 && r.f.priorStreak >= 2 && r.f.pdInsideBands === 1],
    ['P6 no-band   red in up-3d(>=+0.5 ATR), any location', r => r.f.pdGreen === 0 && r.f.trend3 >= 0.5],
  ];
  console.log('\n  form'.padEnd(56) + 'n'.padEnd(6) + 'green'.padEnd(9) + 'rot p'.padEnd(9) + '|move|'.padEnd(10)
    + 'rot p'.padEnd(9) + 'v7-20 lift'.padEnd(13) + 'v4-20 lift'.padEnd(13) + 'v6-20 lift');
  for (const [nm, fn] of P56) {
    const S = rows.filter(fn);
    if (S.length < 5) { console.log('  ' + nm.padEnd(56) + String(S.length).padEnd(6) + '(too few)'); continue; }
    const mi = S.map(r => kIdx.get(r));
    const lf = n => { const v = mean(S.map(r => P(n, r))) - allAvg[n]; return ((v >= 0 ? '+' : '') + usd(v)); };
    console.log('  ' + nm.padEnd(56) + String(S.length).padEnd(6)
      + pct(S.filter(r => r.l.green).length / S.length).padEnd(9) + rotP(mi, Y.green).p.toFixed(4).padEnd(9)
      + mean(S.map(r => r.l.absRet)).toFixed(1).padEnd(10) + rotP(mi, Y.abs).p.toFixed(4).padEnd(9)
      + lf('v7-20').padEnd(13) + lf('v4-20').padEnd(13) + lf('v6-20'));
  }

  // ══ BODY-CUT SENSITIVITY — a quantile cut is a choice too ═════════════════════════════════════════
  console.log(`\n\n${'='.repeat(118)}`);
  console.log('BODY-CUT SENSITIVITY — P1..P4 under alternative "large"/"small" definitions (n is the whole story here)');
  console.log('='.repeat(118));
  const CUTS = [['tercile (primary)', BIG, SMALL], ['quartile p75/p25', Q(0.75), Q(0.25)],
    ['classify-regimes fixed 0.62 / 0.22', 0.62, 0.22], ['no body filter at all', 0, 1]];
  console.log('  cut'.padEnd(38) + 'P1 n'.padEnd(8) + 'P1 green'.padEnd(11) + 'P1 |move|'.padEnd(12)
    + 'P2 n'.padEnd(8) + 'P2 green'.padEnd(11) + 'P2 |move|'.padEnd(12) + 'P3 n'.padEnd(8) + 'P4 n');
  for (const [nm, big, small] of CUTS) {
    const p1 = rows.filter(r => r.f.pdGreen === 0 && r.f.pdBodyFrac >= big && r.f.pdClosedBelowLower === 1);
    const p2 = rows.filter(r => r.f.pdGreen === 1 && r.f.pdBodyFrac >= big && r.f.pdClosedAboveUpper === 1);
    const p3 = rows.filter(r => r.f.pdBodyFrac <= small && r.f.pdClosedBelowLower === 1);
    const p4 = rows.filter(r => r.f.pdBodyFrac <= small && r.f.pdClosedAboveUpper === 1);
    const cell = s => [String(s.length).padEnd(8), (s.length ? pct(s.filter(r => r.l.green).length / s.length) : '-').padEnd(11),
      (s.length ? mean(s.map(r => r.l.absRet)).toFixed(1) : '-').padEnd(12)].join('');
    console.log('  ' + nm.padEnd(36) + cell(p1) + cell(p2) + String(p3.length).padEnd(8) + String(p4.length));
  }

  // ══ SUMMARY ═══════════════════════════════════════════════════════════════════════════════════════
  console.log(`\n\n${'='.repeat(118)}`);
  console.log('SUMMARY — every pre-registered pattern, one line each');
  console.log('='.repeat(118));
  console.log(`  Bonferroni bar p < ${BONF.toFixed(4)} (0.05 / ${BONF_N} headline tests). n < 15 = UNTESTABLE, reported as such.`);
  console.log('\n  ' + 'pat'.padEnd(6) + 'n'.padEnd(6) + '%days'.padEnd(8) + 'green'.padEnd(9) + 'rot p'.padEnd(9) + 'dir?'.padEnd(7)
    + '|move|'.padEnd(9) + 'median'.padEnd(9) + 'vs base'.padEnd(9) + 'rot p'.padEnd(9) + 'rot p -1 big'.padEnd(14) + 'mag?'.padEnd(7) + 'best $20 variant (lift)');
  for (const s of summary) {
    if (s.untestable) { console.log('  ' + s.tag.padEnd(6) + String(s.n).padEnd(6) + '—    UNTESTABLE (n < 15)'); continue; }
    console.log('  ' + s.tag.padEnd(6) + String(s.n).padEnd(6) + pct(s.n / N).padEnd(8)
      + pct(s.greenRate).padEnd(9) + s.pGreen.toFixed(4).padEnd(9) + (s.pGreen < BONF ? 'YES' : 'no').padEnd(7)
      + s.abs.toFixed(1).padEnd(9) + s.med.toFixed(1).padEnd(9) + ((s.abs / baseAbs).toFixed(2) + 'x').padEnd(9)
      + s.pAbs.toFixed(4).padEnd(9) + s.pAbsNoBig.toFixed(4).padEnd(14) + (s.pAbs < BONF ? 'YES' : 'no').padEnd(7)
      + `${s.best.n} ${(s.best.lift >= 0 ? '+' : '') + usd(s.best.lift)}/day (rot p ${s.best.rp.toFixed(4)})`);
  }
  console.log(`  base   ${N}   —       ${pct(baseGreen).padEnd(9)}—        —      ${baseAbs.toFixed(1).padEnd(9)}${[...Y.abs].sort((a, b) => a - b)[Math.floor(N / 2)].toFixed(1)}`);
  console.log('\n  "rot p -1 big" re-runs the magnitude rotation test with the single largest-move day removed. A magnitude');
  console.log('  claim that only exists with one day in it is a claim about that day, not about the pattern.');
  console.log(`\n  Per-variant P&L is DESCRIPTIVE. If a variant claim is to be made it owes a bar of 0.05/(7x6) = ${(0.05 / 42).toFixed(4)},`);
  console.log('  and those six variants are heavily correlated day to day, so that bar is conservative but not absurd.');
  console.log('  Nothing here is a recommendation; a pattern that clears its bar is a candidate for a shadow variant, not a switch.');
})();
