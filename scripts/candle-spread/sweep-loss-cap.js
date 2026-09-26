#!/usr/bin/env node
'use strict';
/**
 * LOSS-CAP SWEEP — what is the LOWEST day-loss governor cap each variant can carry without meaningfully
 * degrading the metrics we care about?
 *
 * The knob is the day-loss governor's `lossMax` (a hard bound on the BOOK FLOOR — every open is gated on
 * it), paired with the soft `lossTarget`. Today the fleet inherits a width-relative generic default,
 * `maxCapFor(w) = max(2*w*100, 5000 + w*100)`  →  $6,000 at W=10, $7,000 at W=20, $9,000 at W=40.
 * Four variants (CANDLE_SPREAD_CAPPRES) instead carry the tight capital-preservation preset,
 * `lossMax = 1 x W x 100`, `lossTarget = 0.7 x lossMax`.
 *
 * This script re-runs the LIVE roster (buildRuns(), so the config the server trades IS what is measured)
 * through the same validated 5m engine the baselines builder uses, once per cap rung, and reports the
 * risk/activity metrics side by side. It is MEASUREMENT ONLY: it overrides lossMax/lossTarget on a COPY
 * of each run and never writes to the roster or to backtest-baselines.*.
 *
 * Rungs are multiples of W x 100 (the CAPPRES convention), with lossTarget = 0.7 x lossMax; rungs at or
 * above the variant's current cap are skipped, and the variant's UNTOUCHED current config is always run
 * as the `current` row so before/after comes from one execution rather than two builds.
 *
 * `-unc` twins are excluded by construction: they have no governor, which is the point of the twin.
 *
 * Usage:
 *   node scripts/candle-spread/sweep-loss-cap.js [--workers 6] [--out <dir>]
 *                                                [--variants v7-10,v6-20] [--rungs 1,1.5,2,3,4]
 *                                                [--dataDir <5m dir>]
 * Emits <out>/loss-cap-sweep.json and <out>/loss-cap-sweep.csv (default out = cwd).
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { runDay5m, load5mDays } = require('./backtest-v6-5m');
const CS = require('../../server/src/candle-spread/index');
const { buildRuns } = CS;
const { optsFor } = require('../../server/src/candle-spread/backtest/opts-for');

const argVal = (flag, dflt) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : dflt; };
const DIR = argVal('--dataDir', path.join(__dirname, '..', '..', 'tests', 'backtest', 'backtest-data-5m-nq'));
const OUTDIR = argVal('--out', process.cwd());
const WORKERS = Math.max(1, Math.min(16, Number(argVal('--workers', '1')) || 1));
const ONLY = (argVal('--variants', '') || '').split(',').map(s => s.trim()).filter(Boolean);
const RUNGS = (argVal('--rungs', '1,1.5,2,3,4')).split(',').map(Number).filter(Number.isFinite);
const SLICE = process.argv.indexOf('--_slice') >= 0 ? Number(process.argv[process.argv.indexOf('--_slice') + 1]) : null;
const SLICE_OF = SLICE != null ? Number(process.argv[process.argv.indexOf('--_slice') + 2]) : null;
const SLICE_OUT = process.argv.indexOf('--_out') >= 0 ? process.argv[process.argv.indexOf('--_out') + 1] : null;

const allDays = load5mDays(DIR);
if (!allDays.length) { console.error('no days loaded from', DIR); process.exit(1); }
const HAS_PX = allDays.some(d => d.bars.some(b => b.px));
// Same tradeable-day filter as build-backtest-baselines.js: a real RTH cash session must exist.
const etMin = ms => { const d = new Date(new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York' })); return d.getHours() * 60 + d.getMinutes(); };
const days = allDays.filter(d => d.bars.some(b => { const m = etMin(b.dt); return m >= 570 && m < 960; }));

const RUNS = buildRuns().filter(r => r.lossMax != null && (!ONLY.length || ONLY.includes(r.variant)));

// THE GENERIC DEFAULT, read off the roster rather than re-derived. maxCapFor()/LOSS_TARGET are private to
// index.js, and a hand-copied formula here is exactly the kind of silent drift opts-for.js exists to stop.
// The generic cap is the one the MAJORITY of variants at a width carry (the CAPPRES preset is the minority
// override), and its lossTarget is whatever a variant sitting at that cap actually uses.
const GENERIC = new Map();
for (const run of buildRuns().filter(r => r.lossMax != null)) {
  const W = run.spreadWidth;
  const g = GENERIC.get(W) || (GENERIC.set(W, new Map()), GENERIC.get(W));
  const cur = g.get(run.lossMax) || { n: 0, lossTarget: run.lossTarget };
  cur.n++; g.set(run.lossMax, cur);
}
// THE REFERENCE ARM SILENTLY BECAME THE TREATMENT. Reading "the most common cap at this width" off the
// roster was a fair proxy for the pre-tightening default while only four variants carried an override.
// Once TUNED_CAPS tightened all 50, the MODE IS THE TIGHTENED VALUE — so `generic` stopped being a
// counterfactual and started being a second copy of `current`. Measured: 29 of 50 variants had no rung
// looser than their own cap, which is precisely the question the sweep is asked when someone suspects the
// caps are too tight. It answered by not testing.
//
// maxCapFor is now exported from index.js, so the counterfactual is the REAL documented default rather
// than either a hand-copied formula (the drift this comment originally warned about) or an inference from
// data the treatment has already moved. The roster mode is kept as a second arm where it differs: it is
// still a meaningful "what the fleet mostly carries" reference.
const genericFor = (W) => {
  const g = GENERIC.get(W);
  let mode = null;
  for (const [lossMax, v] of g) if (!mode || v.n > mode.n || (v.n === mode.n && lossMax > mode.lossMax)) mode = { lossMax, lossTarget: v.lossTarget, n: v.n };
  const formula = CS.maxCapFor ? CS.maxCapFor(W) : null;
  if (!(formula > 0)) return mode;
  return { lossMax: formula, lossTarget: Math.round(0.7 * formula), n: mode ? mode.n : 0, mode };
};

// One JOB = one (variant, cap rung). `current` keeps the run's own lossMax/lossTarget untouched; `generic`
// is the fleet default at that width (for a variant already on the tight preset, this is the counterfactual
// "what if it had never been tightened"). Rungs use the CAPPRES convention lossTarget = 0.7 x lossMax.
// Deduped by lossMax so a rung that coincides with current/generic is not run twice.
const JOBS = [];
for (const run of RUNS) {
  const W = run.spreadWidth;
  const gen = genericFor(W);
  const seen = new Map();
  const add = (rung, lossMax, lossTarget) => {
    if (seen.has(lossMax)) { seen.get(lossMax).rung += '/' + rung; return; }
    const j = { variant: run.variant, rung, k: Math.round(lossMax / (W * 100) * 100) / 100, lossMax, lossTarget };
    seen.set(lossMax, j); JOBS.push(j);
  };
  add('current', run.lossMax, run.lossTarget);
  add('generic', gen.lossMax, gen.lossTarget);
  for (const k of RUNGS) {
    const lm = Math.round(k * W * 100);
    if (lm > gen.lossMax) continue;                     // never LOOSER than the fleet default
    add(String(k), lm, Math.round(0.7 * lm));
  }
}

function measure(job) {
  const run = RUNS.find(r => r.variant === job.variant);
  const cfg = { ...run, lossMax: job.lossMax, lossTarget: job.lossTarget };
  const fn = (A, p, ctx) => cfg.signalFn(A, p, { ...ctx, cfg: cfg.signalCfg || {} });
  const o = optsFor(cfg, { intradayIV: true, hasPx: HAS_PX, where: 'sweep-loss-cap' });
  const res = days.map(d => runDay5m(d.bars, fn, o));
  const daily = res.map(r => r.terminal);
  const total = daily.reduce((a, b) => a + b, 0);
  const sorted = [...daily].sort((a, b) => a - b);
  // true peak-to-trough drawdown over the whole equity curve
  const cum = [0]; daily.forEach((x, i) => cum.push(cum[i] + x));
  let peak = -Infinity, mdd = 0, ddDays = 0, curStart = 0, worstStart = 0, worstEnd = 0;
  for (let i = 0; i < cum.length; i++) {
    if (cum[i] > peak) { peak = cum[i]; curStart = i; }
    if (peak - cum[i] > mdd) { mdd = peak - cum[i]; worstStart = curStart; worstEnd = i; }
  }
  ddDays = worstEnd - worstStart;
  const filled = res.reduce((a, r) => a + r.filled, 0), naked = res.reduce((a, r) => a + r.naked, 0);
  const wins = daily.filter(x => x > 0);
  return {
    variant: job.variant, rung: job.rung, k: job.k, lossMax: job.lossMax, lossTarget: job.lossTarget,
    days: days.length, total: Math.round(total), avgDaily: Math.round(total / days.length),
    median: Math.round(sorted[Math.floor(days.length / 2)]),
    worst: Math.round(sorted[0]), best: Math.round(sorted[sorted.length - 1]),
    daysUnder1k: daily.filter(x => x <= -1000).length,
    daysUnder2k: daily.filter(x => x <= -2000).length,
    daysUnder5k: daily.filter(x => x <= -5000).length,
    negDays: daily.filter(x => x < 0).length,
    winRate: Math.round(wins.length / days.length * 100),
    maxDD: -Math.round(mdd), ddSpanDays: ddDays,
    retDD: mdd ? Math.round(total / mdd * 10) / 10 : null,
    opens: Math.round(res.reduce((a, r) => a + r.opens, 0) / days.length * 100) / 100,
    coverFillRate: (filled + naked) ? Math.round(filled / (filled + naked) * 1000) / 10 : null,
    coverPending: res.reduce((a, r) => a + r.coverPending, 0),
    worstHeldFloor: Math.round(Math.min(...res.map(r => r.governor.worstFloor))),
    capExceeded: daily.filter(x => x < -job.lossMax).length,
    opensBlocked: res.reduce((a, r) => a + r.governor.blocked, 0),
    offsets: res.reduce((a, r) => a + r.governor.offsets, 0),
  };
}

if (SLICE != null) {
  const mine = JOBS.filter((_, i) => i % SLICE_OF === SLICE);
  const out = [];
  for (const j of mine) { out.push(measure(j)); process.stderr.write(`  [w${SLICE}] ${j.variant} @ ${j.rung}\n`); }
  fs.writeFileSync(SLICE_OUT, JSON.stringify(out), 'utf8');
  process.exit(0);
}

(async () => {
  console.log(`LOSS-CAP SWEEP — ${RUNS.length} governed variants × ${JOBS.length} jobs over ${days.length} trading days (${allDays.length - days.length} non-trading excluded)`);
  console.log(`  dates ${days[0].date} .. ${days[days.length - 1].date} · rungs ${RUNGS.join(', ')} × W×100 (+ current) · ${WORKERS} workers`);
  let rows = [];
  if (WORKERS > 1) {
    const { spawn } = require('child_process');
    const base = process.argv.slice(2).filter((a, i, arr) => a !== '--workers' && arr[i - 1] !== '--workers');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loss-cap-sweep-'));
    try {
      await Promise.all(Array.from({ length: WORKERS }, (_, k) => new Promise((resolve, reject) => {
        const f = path.join(tmp, `slice-${k}.json`);
        const ch = spawn(process.execPath, [__filename, ...base, '--_slice', String(k), String(WORKERS), '--_out', f], { stdio: ['ignore', 'inherit', 'inherit'] });
        ch.on('error', reject);
        ch.on('close', (code) => {
          if (code !== 0) return reject(new Error(`worker ${k} exited ${code}`));
          rows = rows.concat(JSON.parse(fs.readFileSync(f, 'utf8')));
          resolve();
        });
      })));
    } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} }
  } else {
    for (const j of JOBS) rows.push(measure(j));
  }
  // canonical order: roster order, then cap descending
  const order = new Map(RUNS.map((r, i) => [r.variant, i]));
  rows.sort((a, b) => (order.get(a.variant) - order.get(b.variant)) || (b.lossMax - a.lossMax));
  fs.mkdirSync(OUTDIR, { recursive: true });
  fs.writeFileSync(path.join(OUTDIR, 'loss-cap-sweep.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), days: days.length, from: days[0].date, to: days[days.length - 1].date, rows }, null, 1), 'utf8');
  const cols = Object.keys(rows[0]);
  fs.writeFileSync(path.join(OUTDIR, 'loss-cap-sweep.csv'),
    [cols.join(','), ...rows.map(r => cols.map(c => r[c]).join(','))].join('\n') + '\n', 'utf8');
  const usd = n => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');
  console.log('\n' + 'variant'.padEnd(14) + 'cap'.padEnd(9) + 'total'.padEnd(12) + 'worst'.padEnd(10) + 'maxDD'.padEnd(11) + 'ret/DD'.padEnd(8) + '<-1k'.padEnd(6) + '<-2k'.padEnd(6) + 'opens'.padEnd(8) + 'fill%');
  for (const r of rows) console.log(r.variant.padEnd(14) + usd(-r.lossMax).padEnd(9) + usd(r.total).padEnd(12) + usd(r.worst).padEnd(10) + usd(r.maxDD).padEnd(11) + String(r.retDD).padEnd(8) + String(r.daysUnder1k).padEnd(6) + String(r.daysUnder2k).padEnd(6) + String(r.opens).padEnd(8) + r.coverFillRate);
  console.log(`\nwrote ${path.join(OUTDIR, 'loss-cap-sweep.csv')}`);
})();
