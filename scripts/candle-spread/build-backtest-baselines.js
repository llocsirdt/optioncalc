#!/usr/bin/env node
'use strict';
/**
 * BACKTEST BASELINES — the per-variant "expected daily P&L" the live runs are graded against.
 *
 * Runs every LIVE variant (imported straight from server/.../index.js VARIANTS, so the config the server
 * trades IS the config measured here) through the validated 5m engine over the full NQ 24h history with
 * rthActionOnly (the faithful live model: 24h signal bands, RTH-only action). Emits avg daily TERMINAL
 * P&L + dispersion per variant to server/src/candle-spread/backtest-baselines.json, which the status
 * endpoint diffs today's live terminal against (vsBacktest).
 *
 * Anchor: v6 $20 reproduces the known $1,412,935 total ($1,532/day) — the byte-identical baseline.
 *
 * Usage: node scripts/candle-spread/build-backtest-baselines.js [--dataDir <5m dir>] [--dry]
 */
const path = require('path');
const fs = require('fs');
const { runDay5m, load5mDays } = require('./backtest-v6-5m');
const { makeGeo } = require('./backtest-width');
const { buildRuns, VARIANTS } = require('../../server/src/candle-spread/index');
// Grade against the ACTUAL merged runs (BASE_RUNS defaults × VARIANTS) the server trades — so shared
// defaults like capital-recapture + leg-uniqueness are reflected in the baseline, not just per-variant knobs.
const RUNS = buildRuns();

const di = process.argv.indexOf('--dataDir');
const DIR = di >= 0 ? process.argv[di + 1] : path.join(__dirname, '..', '..', 'tests', 'backtest', 'backtest-data-5m-nq');
const DRY = process.argv.includes('--dry');
// INTRADAY-IV CORRECTION is now CANONICAL (2026-09-04). It reprices every leg with the calibrated
// time-of-day IV multiplier (data/intraday-iv-correction.json via runDay5m opts.intradayIV), measured off
// the REAL captured chains — band-IV runs ~30% below real ATM IV at the open. Validated on 765 NQ days ×
// 60 variants: Spearman rho 0.990 vs the plain-BS baselines, 59/60 variants gain (median +9.3%), worst-day
// unchanged. STANDING RULE (user): any change that improves BACKTEST ACCURACY becomes the new baseline,
// even if it lowers the headline numbers — accuracy is the point of the backtest. `--noIntradayIV` runs
// the legacy flat-band-IV pricing for A/B only, into a separate file.
const INTRADAY_IV = !process.argv.includes('--noIntradayIV');
// A NON-DEFAULT dataset writes its own baselines file. The NQ history is the canon the live runs are
// graded against; an NDX validation run must never overwrite it just because it was pointed elsewhere.
const DEFAULT_DIR = path.join(__dirname, '..', '..', 'tests', 'backtest', 'backtest-data-5m-nq');
const suffix = path.resolve(DIR) === path.resolve(DEFAULT_DIR) ? '' : '-' + path.basename(DIR).replace(/^backtest-data-5m-/, '');
const OUT = path.join(__dirname, '..', '..', 'server', 'src', 'candle-spread',
  (INTRADAY_IV ? 'backtest-baselines' : 'backtest-baselines-flativ') + suffix + '.json');
const usd = n => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');

// Live variant config -> 5m-engine opts. The engine reads caps/flags directly; width/shift/capFrac go
// through makeGeo; the signal's cfg (fiveMin/beWrong) is merged into ctx exactly as the live trader does.
function optsFor(v) {
  // trackCapital: pure cash accounting (peakReal/avgReal); it never touches terminal/floor, so the graded
  // P&L stays byte-identical — it just populates the capital object for the deployed-capital metrics.
  const o = { rthActionOnly: true, trackCapital: true };
  if (INTRADAY_IV) o.intradayIV = true;   // canonical: reprice every leg with the calibrated time-of-day IV mult
  if (v.bidirectional) o.bidirectional = true;
  // DAY-LOSS GOVERNOR: lossTarget/lossMax bound the BOOK FLOOR (the day's true max loss); floorOffset
  // enables the low-cost risk-offsetting buys. The `-unc` twins null these out → ungoverned.
  for (const k of ['riskCap', 'softCap', 'hardCap', 'capitalCeiling', 'proactiveCoverFrac', 'lossTarget', 'lossMax']) if (v[k] != null) o[k] = v[k];
  if (v.floorOffset) o.floorOffset = true;
  // CONTINUOUS COVERING: a standing resting cover on every position at its profit-locking price. Not a
  // risk cap — it applies to the `-unc` twins too, so those isolate the CAPS rather than the policy.
  if (v.continuousCover) o.continuousCover = true;
  if (v.continuousCoverMinLockFrac != null) o.continuousCoverMinLockFrac = v.continuousCoverMinLockFrac;
  if (v.lockCoverMode) o.lockCoverMode = v.lockCoverMode;
  if (v.exemptTrendStack) o.exemptTrendStack = true;
  if (v.coverSelector) o.coverSelector = v.coverSelector;
  if (v.coverToStack) { o.coverToStack = true; o.coverToStackVsRisk = true; if (v.coverToStackMinFrac != null) o.coverToStackMinFrac = v.coverToStackMinFrac; }
  // capital-recapture cash is P&L-neutral (parity), but its debit/credit ALTERNATION spreads legs across
  // both ladders, so under leg-uniqueness it changes which opens shift/skip → must be modeled to match live.
  if (v.capitalRecapture) { o.recaptureAlternate = true; if (v.openAlternateEvery != null) o.openAlternateEvery = v.openAlternateEvery; if (v.creditCoverFrac != null) o.creditCoverFrac = v.creditCoverFrac; }
  if (v.enforceLegUniqueness) { o.enforceLegUniqueness = true; if (v.legMaxShift != null) o.legMaxShift = v.legMaxShift; if (v.legMaxWing != null) o.legMaxWing = v.legMaxWing; }
  const w = v.spreadWidth, sh = v.spreadShift || 0, cf = v.capFrac;
  if ((w && w !== 20) || sh || cf != null) o.geo = makeGeo({ width: w || 20, shift: sh, capFrac: cf });
  // FOUNDATIONAL: signals from /NQ, pricing and settlement from cash NDX. A dataset carrying an NDX price
  // series (`px`) MUST be priced off it — otherwise runDay5m falls back to the SIGNAL series and the run
  // silently prices NDX options off NQ. Set from the data, so it cannot be forgotten per-dataset.
  if (HAS_PX) o.priceOf = (b) => b.px || { close: b.analysis['5m'].close, high: b.analysis['5m'].high, low: b.analysis['5m'].low };
  return o;
}

const wrap = (v) => (A, p, ctx) => v.signalFn(A, p, { ...ctx, cfg: v.signalCfg || {} });

function stats(vals) {
  const n = vals.length, total = vals.reduce((a, b) => a + b, 0), avg = total / n;
  const variance = vals.reduce((a, b) => a + (b - avg) * (b - avg), 0) / n;
  const sorted = [...vals].sort((a, b) => a - b);
  return {
    days: n, total: Math.round(total), avgDaily: Math.round(avg), stdevDaily: Math.round(Math.sqrt(variance)),
    median: Math.round(sorted[Math.floor(n / 2)]), worst: Math.round(sorted[0]), best: Math.round(sorted[n - 1]),
    negDays: vals.filter(x => x < 0).length, winRate: Math.round(vals.filter(x => x > 0).length / n * 100) / 100
  };
}

// Largest drawdown (peak-to-trough equity decline) confined to any rolling window of <= W consecutive days
// — i.e. the worst loss you could take over any W-day stretch. Returned NEGATIVE (a loss), 0 if never down.
// `daily` must be chronological (load5mDays sorts files by YYYY-MM-DD date).
function rollingDD(daily, W) {
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

const allDays = load5mDays(DIR);
if (!allDays.length) { console.error('no days loaded from', DIR); process.exit(1); }
// Does this dataset carry a separate NDX price series? (the dual NQ-signal/NDX-priced set does)
const HAS_PX = allDays.some(d => d.bars.some(b => b.px));

// A day is TRADEABLE only if it has a real RTH cash session (a bar in 09:30–16:00 ET). The 24h NQ feed
// includes Sunday-evening/holiday futures sessions with no cash session — untradeable for 0DTE NDX, they
// contribute $0 and would dilute the per-day average. Grade only against real trading days.
const etMin = ms => { const d = new Date(new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York' })); return d.getHours() * 60 + d.getMinutes(); };
const hasRth = d => d.bars.some(b => { const m = etMin(b.dt); return m >= 570 && m < 960; });
const days = allDays.filter(hasRth);
const excluded = allDays.length - days.length;

const out = { generatedAt: new Date().toISOString(), dataDir: path.basename(DIR), days: days.length, calendarDays: allDays.length, nonTradingDays: excluded, model: 'rthActionOnly (24h bands, RTH action), QTY=1, tradeable days only, live config (recapture + leg-uniqueness)', variants: {} };
const mean = arr => Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
const mean2 = arr => Math.round(arr.reduce((a, b) => a + b, 0) / arr.length * 100) / 100;

// ── PARALLELISM (--workers N) ───────────────────────────────────────────────────────────────────────
// The variants are completely independent and runDay5m is pure given (bars, opts), so splitting them
// across processes yields BYTE-IDENTICAL results — only the wall clock changes. Node is single-threaded
// for this workload, so one process pins one core; the dataset is ~0.35 GB resident per process, which is
// what makes forking cheap enough to be worth it. Default 1 = the original sequential behaviour.
// A worker computes a strided slice (i, i+N, i+2N…) so the widths — and therefore the cost per variant —
// spread evenly across workers instead of one worker landing all the slow $40s.
const wi = process.argv.indexOf('--workers');
const WORKERS = wi >= 0 ? Math.max(1, Math.min(16, Number(process.argv[wi + 1]) || 1)) : 1;
const si = process.argv.indexOf('--_slice');
const SLICE = si >= 0 ? Number(process.argv[si + 1]) : null;      // set only in a forked worker
const SLICE_OF = si >= 0 ? Number(process.argv[si + 2]) : null;
const soi = process.argv.indexOf('--_out');
const SLICE_OUT = soi >= 0 ? process.argv[soi + 1] : null;

function computeVariant(run) {
  const fn = wrap(run), opts = optsFor(run);
  const results = days.map(d => runDay5m(d.bars, fn, opts));
  const daily = results.map(r => r.terminal);
  const s = stats(daily);
  // RISK/POTENTIAL metrics averaged across days: risk-curve extremes + trades/day + real capital deployed.
  const avgBestCase = mean(results.map(r => r.bestCase));
  const avgWorstCase = mean(results.map(r => r.worstCase));
  const avgTerminalPotential = mean(results.map(r => r.avgTerminalPotential));
  const avgTradesPerDay = mean2(results.map(r => r.opens));
  const avgPeakCapital = mean(results.map(r => (r.capital ? r.capital.peakReal : 0)));
  const avgDeployedCapital = mean(results.map(r => (r.capital ? r.capital.avgReal : 0)));
  const maxDD7 = rollingDD(daily, 7), maxDD30 = rollingDD(daily, 30);
  // SIZE-NORMALIZED / SIZE-INDEPENDENT scores so strategy quality can be separated from position size
  // (the 10/20/40 width dial). widthNorm = 20/W puts $-metrics on a $20-equivalent basis (exact here — all
  // sweep widths share capFrac 0.8, so per-spread risk scales linearly with width). Efficiency & ret-on-cap
  // are ratios (width cancels). profitScore/riskScore = the $20-normalized avgDaily / worst-month drawdown.
  const W = run.spreadWidth || 20, widthNorm = Math.round(20 / W * 1000) / 1000;
  const profitScore = Math.round(s.avgDaily * widthNorm);
  const riskScore = Math.round(maxDD30 * widthNorm);
  const efficiency = maxDD30 ? Math.round(s.total / Math.abs(maxDD30) * 10) / 10 : null;   // Calmar-like return/DD
  const returnOnCapital = avgPeakCapital > 0 ? Math.round(s.avgDaily / avgPeakCapital * 1000) / 1000 : null; // daily $/$ peak cap
  // GOVERNOR telemetry + the BOUND CHECK that matters: `capExceeded` counts days whose REALIZED terminal
  // came in worse than −lossMax. It must be 0 — that is the whole claim of the governor (the old hardCap
  // could not make it, routinely realizing ~2× the cap). worstHeldFloor = the worst book floor actually
  // held intraday across all days; it should sit at or inside −lossMax.
  const gov = run.lossMax != null ? {
    lossTarget: run.lossTarget, lossMax: run.lossMax,
    worstHeldFloor: Math.min(...results.map(r => r.governor.worstFloor)),
    worstFloorPreReduction: Math.min(...results.map(r => r.governor.worstFloorPre)),
    capExceeded: daily.filter(x => x < -run.lossMax).length,
    avgBreachBars: mean2(results.map(r => r.governor.breaches)),
    floorCovers: results.reduce((a, r) => a + r.governor.covers, 0),
    coversDeferred: results.reduce((a, r) => a + r.governor.coverDeferred, 0),
    offsets: results.reduce((a, r) => a + r.governor.offsets, 0),
    offsetSpent: results.reduce((a, r) => a + r.governor.offsetSpent, 0),
    opensBlocked: results.reduce((a, r) => a + r.governor.blocked, 0),
  } : null;
  return { label: run.variantLabel, daily, dates: days.map(d => d.date), ...s, avgBestCase, avgWorstCase, avgTerminalPotential, avgTradesPerDay, avgPeakCapital, avgDeployedCapital, maxDD7, maxDD30, widthNorm, profitScore, riskScore, efficiency, returnOnCapital, governor: gov };
}

function printRow(run, v) {
  const s = v, avgWorstCase = v.avgWorstCase, gov = v.governor;
  console.log(run.variant.padEnd(16) + usd(s.avgDaily).padEnd(11) + usd(s.median).padEnd(11) + usd(s.stdevDaily).padEnd(11) + usd(s.worst).padEnd(12) + usd(avgWorstCase).padEnd(12) + `${s.negDays}/${days.length} · ${Math.round(s.winRate * 100)}%` + (gov ? `  gov held ${usd(gov.worstHeldFloor)}/${usd(-gov.lossMax)}${gov.capExceeded ? "  ✗ EXCEEDED x" + gov.capExceeded : "  ✓"}` : "  (uncapped)"));
}

// ── WORKER MODE: compute this slice, hand the results back via a FILE, done. ─────────────────────────
// NOT via stdout: process.exit() truncates a pending async write, so a payload past the ~64KB pipe buffer
// arrives as invalid JSON. That is exactly what happened once the per-day series was added to the result
// (765 numbers x 80 variants) — the parent died on `Expected ',' or ']' at position 65529`. A file has no
// such boundary and the failure mode if it goes wrong is a missing file, which is obvious.
if (SLICE != null) {
  const mine = RUNS.filter((_, i) => i % SLICE_OF === SLICE);
  const res = {};
  for (const run of mine) { const v = computeVariant(run); delete v.dates; res[run.variant] = v; }   // dates are identical for every variant; the parent holds them once
  fs.writeFileSync(SLICE_OUT, JSON.stringify(res), 'utf8');
  process.exit(0);
}

console.log(`  pricing: ${HAS_PX ? 'cash NDX (px series) — signals off /NQ' : 'the signal series itself (single-instrument dataset)'}`);
console.log(`BACKTEST BASELINES — ${RUNS.length} variants × ${days.length} trading days (${excluded} non-trading calendar entries excluded)${WORKERS > 1 ? ` · ${WORKERS} workers` : ''}\n`);
console.log('variant'.padEnd(16) + 'avg/day'.padEnd(11) + 'median'.padEnd(11) + 'stdev'.padEnd(11) + 'worstDay'.padEnd(12) + 'avgWorst'.padEnd(12) + 'neg/win');
console.log('-'.repeat(78));

(async () => {
if (WORKERS > 1) {
  // Fan out, then print rows in the CANONICAL order once everything is back — workers finish out of
  // order, and a table whose row order depends on scheduling is not comparable between runs.
  const { spawn } = require('child_process');
  const os = require('os');
  const base = process.argv.slice(2).filter((a, i, arr) => a !== '--workers' && arr[i - 1] !== '--workers');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-baselines-'));
  const merged = {};
  try {
    await Promise.all(Array.from({ length: WORKERS }, (_, k) => new Promise((resolve, reject) => {
      const outFile = path.join(tmp, `slice-${k}.json`);
      const ch = spawn(process.execPath, [__filename, ...base, '--_slice', String(k), String(WORKERS), '--_out', outFile], { stdio: ['ignore', 'inherit', 'inherit'] });
      ch.on('error', reject);
      ch.on('close', (code) => {
        if (code !== 0) return reject(new Error(`worker ${k} exited ${code}`));
        if (!fs.existsSync(outFile)) return reject(new Error(`worker ${k} produced no result file`));
        Object.assign(merged, JSON.parse(fs.readFileSync(outFile, 'utf8')));
        resolve();
      });
    })));
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} }
  const allDates = days.map(d => d.date);
  for (const v of Object.values(merged)) if (!v.dates) v.dates = allDates;
  for (const run of RUNS) { out.variants[run.variant] = merged[run.variant]; printRow(run, merged[run.variant]); }
} else {
  for (const run of RUNS) { const v = computeVariant(run); out.variants[run.variant] = v; printRow(run, v); }
}

// ── SUMMARY CSV ─────────────────────────────────────────────────────────────────────────────────────
// Emitted on EVERY build, from the SAME run as the JSON, so the table we review can never drift from the
// baselines. (It used to live in generate-strategy-csv.js, which carried its own hardcoded caps/variants
// and silently went stale once the governor + continuous covering landed.) Aggregate block on top, then
// one row per date. Windowed losses/streaks need the per-day series, which is why they live here.
function writeSummaryCsv(file) {
  const names = RUNS.map(r => r.variant).filter(n => out.variants[n] && out.variants[n].daily);
  const S = {};
  for (const n of names) {
    const d = out.variants[n].daily, dates = out.variants[n].dates;
    const cum = [0]; d.forEach((x, i) => cum.push(cum[i] + x));
    // worst N-day window (rolling sum), with the date it ENDS on
    const worstWin = (N) => { let v = Infinity, at = ''; for (let i = N; i < cum.length; i++) { const s2 = cum[i] - cum[i - N]; if (s2 < v) { v = s2; at = dates[i - 1]; } } return { v: v === Infinity ? 0 : v, d: at }; };
    // longest consecutive losing / winning streak
    let ls = 0, lsBest = 0, ls$ = 0, lsEnd = '', cur$ = 0, ws = 0, wsBest = 0, ws$ = 0, cw$ = 0;
    for (let i = 0; i < d.length; i++) {
      if (d[i] < 0) { ls++; cur$ += d[i]; if (ls > lsBest) { lsBest = ls; ls$ = cur$; lsEnd = dates[i]; } } else { ls = 0; cur$ = 0; }
      if (d[i] > 0) { ws++; cw$ += d[i]; if (ws > wsBest) { wsBest = ws; ws$ = cw$; } } else { ws = 0; cw$ = 0; }
    }
    // true max drawdown (peak-to-trough over the whole series, unwindowed)
    let peak = -Infinity, mdd = 0;
    for (const c of cum) { if (c > peak) peak = c; if (peak - c > mdd) mdd = peak - c; }
    const wi2 = d.indexOf(Math.min(...d)), bi = d.indexOf(Math.max(...d));
    S[n] = { ...out.variants[n], w5: worstWin(5), w10: worstWin(10), lsBest, ls$, lsEnd, wsBest, ws$, mdd: -mdd,
      worstDate: dates[wi2], bestDate: dates[bi] };
  }
  const R2 = Math.round;
  const lines = [['', ...names].join(',')];
  const row = (label, fn) => lines.push([label, ...names.map(n => fn(S[n]))].join(','));
  row('TOTAL terminal $', s2 => R2(s2.total));
  row('AVG terminal/day $', s2 => R2(s2.avgDaily));
  row('MEDIAN terminal/day $', s2 => R2(s2.median));
  row('RETURN / worst-10day-loss', s2 => s2.w10.v < 0 ? (s2.total / -s2.w10.v).toFixed(1) : '');
  row('WORST 5-day loss $ (~1wk)', s2 => R2(s2.w5.v));
  row('  worst 5-day END date', s2 => s2.w5.d);
  row('WORST 10-day loss $ (~2wk)', s2 => R2(s2.w10.v));
  row('  worst 10-day END date', s2 => s2.w10.d);
  row('MAX LOSING STREAK (days)', s2 => s2.lsBest);
  row('  losing-streak $', s2 => R2(s2.ls$));
  row('  losing-streak END date', s2 => s2.lsEnd);
  row('MAX WINNING STREAK (days)', s2 => s2.wsBest);
  row('  winning-streak $', s2 => R2(s2.ws$));
  row('WORST single day $', s2 => R2(s2.worst));
  row('  worst day DATE', s2 => s2.worstDate);
  row('BEST single day $', s2 => R2(s2.best));
  row('  best day DATE', s2 => s2.bestDate);
  row('opens/day', s2 => s2.avgTradesPerDay);
  row('NEG days', s2 => `${s2.negDays}/${days.length}`);
  row('WIN %', s2 => Math.round(s2.winRate * 100) + '%');
  row('(context) true MAX DRAWDOWN $', s2 => R2(s2.mdd));
  row('maxDD 7-day $', s2 => R2(s2.maxDD7));
  row('maxDD 30-day $', s2 => R2(s2.maxDD30));
  row('ret / maxDD30', s2 => s2.maxDD30 ? (s2.total / Math.abs(s2.maxDD30)).toFixed(1) : '');
  row('avg peak capital $', s2 => R2(s2.avgPeakCapital));
  row('ret on capital (daily $/$)', s2 => s2.returnOnCapital != null ? s2.returnOnCapital : '');
  row('profitScore ($20-norm)', s2 => R2(s2.profitScore));
  row('riskScore ($20-norm)', s2 => R2(s2.riskScore));
  // GOVERNOR block — the cap and whether it actually held. capExceeded MUST be 0.
  row('GOV lossMax $', s2 => s2.governor ? -s2.governor.lossMax : '');
  row('GOV worst floor HELD $', s2 => s2.governor ? s2.governor.worstHeldFloor : '');
  row('GOV days over cap', s2 => s2.governor ? s2.governor.capExceeded : '');
  row('GOV covers deferred', s2 => s2.governor ? s2.governor.coversDeferred : '');
  row('GOV offsets bought', s2 => s2.governor ? s2.governor.offsets : '');
  row('GOV offset spend $', s2 => s2.governor ? s2.governor.offsetSpent : '');
  row('GOV opens blocked', s2 => s2.governor ? s2.governor.opensBlocked : '');
  lines.push('');
  lines.push(['DATE', ...names].join(','));
  const dates = out.variants[names[0]].dates;
  for (let i = 0; i < dates.length; i++) lines.push([dates[i], ...names.map(n => R2(out.variants[n].daily[i]))].join(','));
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  return file;
}

// ENGINE-INTEGRITY anchor: the PURE v6 signal (no recapture/leg-uniqueness) must still reproduce the known
// $1,412,935 total — proves the engine + signal are unchanged. The graded v6 above carries the ~0.6% leg-
// uniqueness cost now that it's a live default, so the anchor is checked separately on the pure config.
// The v6 family was renamed to per-width variants (v6-10/-20/-40); they all share the same v6 signalFn +
// signalCfg, and the anchor forces the DEFAULT $20 ATM geometry (no geo opt) regardless, so any v6-family
// member reproduces the pure anchor. Use v6-20.
// The anchor is a FINGERPRINT OF THE ENGINE, not a performance figure: the pure v6 signal with almost no
// config, summed over the dataset. The expected value is a constant for ONE dataset — the 765-day NQ set —
// so it is only meaningful there. Run it on any other dataset and you are comparing a different instrument
// over a different number of days to a hardcoded NQ number, which fails every time and means nothing (the
// 34-day NDX set gives $72,600). Skip it, say so, and do not fail the build over it.
const pureV6 = VARIANTS.find(v => v.variant === 'v6-20');
const isCanonical = path.resolve(DIR) === path.resolve(DEFAULT_DIR);
let anchorOK = true, anchorTotal = null;
if (isCanonical) {
  anchorTotal = Math.round(days.reduce((a, d) => a + runDay5m(d.bars, wrap(pureV6), { rthActionOnly: true }).terminal, 0));
  anchorOK = anchorTotal === 1412935;
  console.log(`\nengine anchor (pure v6, no recap/leg-uniq) = ${usd(anchorTotal)}  ${anchorOK ? '✓ matches $1,412,935' : '✗ EXPECTED $1,412,935 — the engine\'s core math has changed'}`);
} else {
  console.log(`\nengine anchor: SKIPPED — it is a constant for ${path.basename(DEFAULT_DIR)} only, so it says nothing about ${path.basename(DIR)}.`);
}
console.log(`graded v6-20 (live config) total = ${usd(out.variants['v6-20'].total)}  avg/day ${usd(out.variants['v6-20'].avgDaily)}`);
if (anchorTotal != null) out.engineAnchorPureV6Total = anchorTotal;

if (DRY) { console.log('\n--dry: not written'); process.exit(anchorOK ? 0 : 2); }
const CSV = OUT.replace(/\.json$/, '.csv');
writeSummaryCsv(CSV);
for (const v of Object.values(out.variants)) { delete v.daily; delete v.dates; }   // keep the JSON lean
fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log('\nwrote', path.relative(process.cwd(), OUT));
console.log('wrote', path.relative(process.cwd(), CSV), '(aggregate summary block + per-date rows)');
process.exit(anchorOK ? 0 : 2);
})().catch(e => { console.error('baseline build failed:', e.message); process.exit(1); });
