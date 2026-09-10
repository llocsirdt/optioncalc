#!/usr/bin/env node
'use strict';
/**
 * backtest-open-only.js — measure the two OPEN-ONLY entry strategies (see open-only-signals.js):
 *
 *   A) 60m Bollinger outer-band break / near-touch  →  first matching 5m reversal candle = ENTRY
 *   B) same, on the 15m bands
 *
 * ── WHAT THIS IS AND IS NOT ─────────────────────────────────────────────────────────────────────
 * This is a PURE SIGNAL READ. Every cover mechanism and the day-loss governor are OFF:
 * no continuousCover, no coverToStack, no proactiveCoverFrac, no coverPriorOnOpen, no
 * lossTarget/lossMax, no risk/soft/hard cap, no capital ceiling, no wings. Positions open and ride
 * to settlement. These numbers therefore say whether the ENTRY has an edge; they are NOT a
 * risk-managed strategy and must not be compared like-for-like with the governed v0-v7 baselines.
 *
 * `bidirectional: true` is set so a bull setup earlier in the day cannot lock out a bear setup later
 * (without it the engine's stance gate would silently discard the second side, which would be an
 * artefact of the harness rather than a property of the signal).
 *
 * Everything else matches the existing scripts exactly: rthActionOnly, intradayIV, QTY=1, and the
 * FOUNDATIONAL /NQ-signal / NDX-pricing split via opts.priceOf whenever the dataset carries `px`.
 *
 * Usage:
 *   node scripts/candle-spread/backtest-open-only.js [--dataDir <d>] [--workers 6] [--quick]
 *   node scripts/candle-spread/backtest-open-only.js --worker <jobsFile> <outFile>     (internal)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');
const { runDay5m, load5mDays } = require('./backtest-v6-5m');
const { makeGeo } = require('./backtest-width');
const { makeOpenOnlySignal } = require('./open-only-signals');
const P = require('./candle-patterns-lab');

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const DIR = arg('--dataDir', path.join(__dirname, '..', '..', 'tests', 'backtest', 'backtest-data-5m-nq'));
const ARM_BARS = Number(arg('--armBars', 12));

// ── GEOMETRY ────────────────────────────────────────────────────────────────────────────────────
// sATM = the live short-at-the-money placement. server/src/candle-spread/index.js WIDTHS is
//   [{w:10,shift:5,capFrac:0.60},{w:20,shift:10,capFrac:0.60},{w:40,shift:20,capFrac:0.60}]
//   → shift = width/2, capFrac 0.60. Matched exactly.
// cATM = the ATM-CENTERED control: shift 0, capFrac left unset → makeGeo's 0.65 default, which is
//   what the live `-cATM` comparators do. NOTE: live only builds cATM at $20/$40 because a $10
//   centered spread lands OFF the 10-pt strike grid (strikes at x5). It is included here for
//   completeness and flagged in the table; treat $10-cATM as indicative only.
const GEOS = [
  { key: '10-sATM', width: 10, geo: () => makeGeo({ width: 10, shift: 5, capFrac: 0.60 }) },
  { key: '20-sATM', width: 20, geo: () => makeGeo({ width: 20, shift: 10, capFrac: 0.60 }) },
  { key: '40-sATM', width: 40, geo: () => makeGeo({ width: 40, shift: 20, capFrac: 0.60 }) },
  { key: '10-cATM', width: 10, geo: () => makeGeo({ width: 10, shift: 0 }), offGrid: true },
  { key: '20-cATM', width: 20, geo: () => makeGeo({ width: 20, shift: 0 }) },
  { key: '40-cATM', width: 40, geo: () => makeGeo({ width: 40, shift: 0 }) },
];
const GEO_BY_KEY = Object.fromEntries(GEOS.map(g => [g.key, g]));

// Proximity arms. `null` = the control (no band condition at all).
const PROX = [
  { key: '0% (break)', prox: 0 },
  { key: '5%', prox: 0.05 },
  { key: '10%', prox: 0.10 },
  { key: '25%', prox: 0.25 },
  { key: 'none (ctl)', prox: null },
];
const STRATS = [{ key: 'A', tf: '60m', label: 'Strategy A — 60m bands' }, { key: 'B', tf: '15m', label: 'Strategy B — 15m bands' }];

// ── DAY LOADING (identical filter to build-backtest-baselines.js) ───────────────────────────────
const etMin = ms => { const d = new Date(new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York' })); return d.getHours() * 60 + d.getMinutes(); };
function loadTradeableDays(dir) {
  const all = load5mDays(dir);
  // TRADEABLE = has a real RTH cash session. The 24h /NQ feed carries Sunday-evening and holiday
  // futures sessions with no cash session; they are untradeable for 0DTE NDX and would dilute
  // every per-day average with guaranteed $0.
  const days = all.filter(d => d.bars.some(b => { const m = etMin(b.dt); return m >= 570 && m < 960; }));
  return { days, calendar: all.length };
}

// ── METRICS ─────────────────────────────────────────────────────────────────────────────────────
// Rolling drawdown, copied from build-backtest-baselines.js so the numbers are comparable: worst
// peak-to-trough on the cumulative curve inside any W-day window.
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

function optsFor(geoKey, HAS_PX) {
  const g = GEO_BY_KEY[geoKey];
  // Deliberately minimal: rthActionOnly + intradayIV + geometry + the price series. Every cover and
  // governor option is left at its default (off / Infinity) — that is the whole point of the study.
  const o = { rthActionOnly: true, intradayIV: true, bidirectional: true, geo: g.geo() };
  if (HAS_PX) o.priceOf = (b) => b.px || { close: b.analysis['5m'].close, high: b.analysis['5m'].high, low: b.analysis['5m'].low };
  return o;
}

// ── DRIFT BENCHMARK ─────────────────────────────────────────────────────────────────────────────
// A SIGNAL-FREE control: open on a fixed cadence (every k-th action bar) with no reference to price,
// bands or candles at all. Every directional strategy on a 765-day sample that RALLIED will look
// profitable on its bull leg and unprofitable on its bear leg; the only way to tell signal from that
// drift is to price the drift. `dir` is 'bull', 'bear' or 'alt' (alternate). Same stats shape as a
// real arm so it can be read in the same table.
function makeDriftSignal(dir, k) {
  let n = -1, flip = 0;
  const stats = { setupBull: 0, setupBear: 0, barsBull: 0, barsBear: 0, entryBull: 0, entryBear: 0, byPattern: {} };
  const fn = (A) => {
    n++;
    if (n % k !== 0) return { openSide: null, cover: false, reason: 'off-cadence' };
    const side = dir === 'alt' ? (flip++ % 2 === 0 ? 'bull' : 'bear') : dir;
    if (side === 'bull') stats.entryBull++; else stats.entryBear++;
    return { openSide: side, cover: false, reason: `drift-${side}` };
  };
  fn.stats = stats;
  return fn;
}

function runJob(job, days, HAS_PX) {
  const opts = optsFor(job.geo, HAS_PX);
  const daily = [];
  let opens = 0, daysTraded = 0, worstCaseSum = 0;
  const S = { setupBull: 0, setupBear: 0, barsBull: 0, barsBear: 0, entryBull: 0, entryBear: 0, daysWithSetup: 0, byPattern: {} };
  for (const d of days) {
    const fn = job.kind === 'drift'
      ? makeDriftSignal(job.dir, job.cadence)
      : makeOpenOnlySignal({ tf: job.tf, prox: job.prox, patterns: job.patterns, armBars: job.armBars });
    const r = runDay5m(d.bars, fn, opts);
    daily.push(r.terminal);
    opens += r.opens;
    if (r.opens > 0) { daysTraded++; worstCaseSum += r.worstCase; }
    if (fn.stats.setupBull + fn.stats.setupBear > 0) S.daysWithSetup++;
    S.setupBull += fn.stats.setupBull; S.setupBear += fn.stats.setupBear;
    S.barsBull += fn.stats.barsBull; S.barsBear += fn.stats.barsBear;
    S.entryBull += fn.stats.entryBull; S.entryBear += fn.stats.entryBear;
    for (const [k, v] of Object.entries(fn.stats.byPattern)) S.byPattern[k] = (S.byPattern[k] || 0) + v;
  }
  const total = daily.reduce((a, b) => a + b, 0);
  const losses = daily.filter(x => x < 0);
  // win% is measured over DAYS THAT TRADED (`dTrade` carries the denominator) — an arm that fires on
  // 4 days out of 765 must not be credited with a 99% "win rate" earned by 761 flat days. A day with
  // no opens settles at exactly $0, so every positive day is by construction a traded day.
  return {
    id: job.id, total: Math.round(total),
    dd: rollingDD(daily, 30),
    worst: Math.round(Math.min(...daily)),
    nLoss: losses.length,
    avgLoss: losses.length ? Math.round(losses.reduce((a, b) => a + b, 0) / losses.length) : 0,
    avgLossPot: daysTraded ? Math.round(worstCaseSum / daysTraded) : 0,
    opens, daysTraded, nDays: days.length,
    dailyPos: daily.filter(x => x > 0).length,
    stats: S,
    daily: job.keepDaily ? daily.map(x => Math.round(x)) : undefined,
  };
}

// ── WORKER MODE ─────────────────────────────────────────────────────────────────────────────────
if (process.argv.includes('--worker')) {
  const wi = process.argv.indexOf('--worker');
  const jobsFile = process.argv[wi + 1], outFile = process.argv[wi + 2];
  const jobs = JSON.parse(fs.readFileSync(jobsFile, 'utf8'));
  const { days } = loadTradeableDays(DIR);
  const HAS_PX = days.some(d => d.bars.some(b => b.px));
  const out = jobs.map(j => runJob(j, days, HAS_PX));
  fs.writeFileSync(outFile, JSON.stringify(out));
  process.exit(0);
}

// ── PARENT ──────────────────────────────────────────────────────────────────────────────────────
const usd = n => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');
const pad = (s, n) => String(s).padStart(n);
const padr = (s, n) => String(s).padEnd(n);

function buildJobs(quick) {
  const jobs = [];
  const geos = quick ? ['20-sATM'] : GEOS.map(g => g.key);
  const proxes = quick ? PROX.slice(0, 2) : PROX;
  for (const s of STRATS) for (const p of proxes) for (const g of geos) {
    jobs.push({ id: `main|${s.key}|${p.key}|${g}`, kind: 'main', tf: s.tf, prox: p.prox, geo: g, armBars: ARM_BARS, patterns: P.CORE });
  }
  if (!quick) {
    // PER-PATTERN CONTRIBUTION — every pattern on its own, at one fixed geometry ($20 sATM) and one
    // fixed proximity arm (10%), so a pattern that never fires or that loses money is visible rather
    // than buried inside the core aggregate.
    for (const s of STRATS) for (const k of P.ALL) {
      jobs.push({ id: `pat|${s.key}|${k}`, kind: 'pat', tf: s.tf, prox: 0.10, geo: '20-sATM', armBars: ARM_BARS, patterns: [k] });
    }
    // ...and the same per pattern with NO band condition, which isolates the pattern alone.
    for (const k of P.ALL) {
      jobs.push({ id: `patctl||${k}`, kind: 'patctl', tf: '60m', prox: null, geo: '20-sATM', armBars: ARM_BARS, patterns: [k] });
    }
    // DRIFT BENCHMARK — signal-free, fixed-cadence opens at two cadences chosen to bracket the real
    // arms' trade rates (every 4th action bar ≈ 19/day ≈ the no-band control; every 13th ≈ 6/day ≈ a
    // banded arm). This is the number every arm above has to beat to be a signal rather than a bet
    // on the sample's direction.
    for (const dir of ['bull', 'bear', 'alt']) for (const cad of [4, 13]) for (const g of GEOS.map(x => x.key)) {
      jobs.push({ id: `drift|${dir}|${cad}|${g}`, kind: 'drift', dir, cadence: cad, geo: g });
    }
  }
  // --only <substring>: run just the arms whose id contains it (e.g. `--only drift`). Combine with
  // --merge <prior.json> to add a section to an already-computed sweep instead of recomputing it.
  const only = arg('--only', null);
  return only ? jobs.filter(j => j.id.includes(only)) : jobs;
}

function runParallel(jobs, workers, tmpDir) {
  return new Promise((resolve, reject) => {
    const chunks = Array.from({ length: workers }, () => []);
    jobs.forEach((j, i) => chunks[i % workers].push(j));
    const results = [];
    let done = 0, failed = false;
    chunks.forEach((chunk, w) => {
      if (!chunk.length) { done++; if (done === workers) resolve(results); return; }
      const jf = path.join(tmpDir, `jobs-${w}.json`), of = path.join(tmpDir, `out-${w}.json`);
      fs.writeFileSync(jf, JSON.stringify(chunk));
      const child = fork(__filename, ['--worker', jf, of, '--dataDir', DIR, '--armBars', String(ARM_BARS)], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      child.on('exit', (code) => {
        if (code !== 0) { if (!failed) { failed = true; reject(new Error(`worker ${w} exited ${code}`)); } return; }
        results.push(...JSON.parse(fs.readFileSync(of, 'utf8')));
        process.stderr.write(`  worker ${w} done (${chunk.length} jobs)\n`);
        if (++done === workers && !failed) resolve(results);
      });
    });
  });
}

async function main() {
  const quick = process.argv.includes('--quick');
  const workers = Number(arg('--workers', Math.min(6, Math.max(1, os.cpus().length - 2))));
  const tmpDir = arg('--tmp', fs.mkdtempSync(path.join(os.tmpdir(), 'open-only-')));
  fs.mkdirSync(tmpDir, { recursive: true });

  const { days, calendar } = loadTradeableDays(DIR);
  const HAS_PX = days.some(d => d.bars.some(b => b.px));
  const jobs = buildJobs(quick);
  console.log(`\nOPEN-ONLY ENTRY STUDY — ${days.length} tradeable days of ${calendar} calendar days in ${path.basename(DIR)}`);
  console.log(`pricing series: ${HAS_PX ? 'NDX (bars[].px via opts.priceOf)' : '/NQ (this dataset carries no separate NDX px series)'}`);
  console.log(`setup arm window: ${ARM_BARS} × 5m bars · QTY=1 · rthActionOnly · intradayIV · bidirectional`);
  console.log(`ALL COVER LOGIC AND THE DAY-LOSS GOVERNOR ARE OFF — this is a pure signal read, not a risk-managed strategy.`);
  console.log(`\nrunning ${jobs.length} full-dataset arms on ${workers} workers...`);

  const t0 = Date.now();
  // --from <json>: re-print the tables from a saved sweep without recomputing anything.
  const fromFile = arg('--from', null);
  const raw = fromFile ? JSON.parse(fs.readFileSync(fromFile, 'utf8')).results : await runParallel(jobs, workers, tmpDir);
  if (!fromFile) console.log(`  ...${Math.round((Date.now() - t0) / 1000)}s\n`);
  else console.log(`  (re-printed from ${path.basename(fromFile)}, ${raw.length} arms)\n`);
  const mergeFile = arg('--merge', null);
  if (mergeFile) {
    const prior = JSON.parse(fs.readFileSync(mergeFile, 'utf8')).results || [];
    const have = new Set(raw.map(r => r.id));
    for (const r of prior) if (!have.has(r.id)) raw.push(r);
    console.log(`merged ${prior.length} prior arms from ${path.basename(mergeFile)}\n`);
  }

  const byId = Object.fromEntries(raw.map(r => [r.id, r]));
  const D = days.length;

  const fmt = (r) => {
    const winPct = r.daysTraded ? Math.round(r.dailyPos / r.daysTraded * 1000) / 10 : 0;
    const retDD = r.dd < 0 ? Math.round(r.total / -r.dd * 10) / 10 : (r.total > 0 ? Infinity : 0);
    return {
      total: usd(r.total), win: r.daysTraded ? winPct + '%' : '—',
      avgLoss: r.nLoss ? usd(r.avgLoss) : '—', nLoss: r.nLoss,
      avgLossPot: r.daysTraded ? usd(r.avgLossPot) : '—',
      worst: usd(r.worst), retDD: r.dd < 0 ? String(retDD) : (r.total > 0 ? '∞' : '—'),
      tpd: Math.round(r.opens / D * 100) / 100,
      dTrade: r.daysTraded,
    };
  };

  const HDR = padr('prox arm', 13) + padr('geo', 10) + pad('total', 12) + pad('win%', 8) + pad('avgLoss', 11)
    + pad('nLoss', 7) + pad('avgLossPot', 12) + pad('worst', 11) + pad('ret/DD', 9) + pad('trd/day', 9) + pad('dTrade', 8);

  for (const s of STRATS) {
    console.log('═'.repeat(HDR.length));
    console.log(`${s.label}  —  band break/near-touch on ${s.tf}, entry = first matching 5m reversal candle`);
    console.log('═'.repeat(HDR.length));
    console.log(HDR);
    console.log('─'.repeat(HDR.length));
    for (const p of PROX) {
      let first = true;
      for (const g of GEOS) {
        const r = byId[`main|${s.key}|${p.key}|${g.key}`];
        if (!r) continue;
        const f = fmt(r);
        const lbl = first ? p.key : ''; first = false;
        console.log(padr(lbl, 13) + padr(g.key + (g.offGrid ? '*' : ''), 10) + pad(f.total, 12) + pad(f.win, 8)
          + pad(f.avgLoss, 11) + pad(f.nLoss, 7) + pad(f.avgLossPot, 12) + pad(f.worst, 11) + pad(f.retDD, 9) + pad(f.tpd, 9) + pad(f.dTrade, 8));
      }
      console.log('─'.repeat(HDR.length));
    }
    // setup / entry frequency for this strategy (geometry-independent — the signal is the same)
    console.log(`\n  SETUP FREQUENCY (${s.tf} bands) — the signal is geometry-independent; taken from the 20-sATM arm.`);
    console.log(`  A SETUP EPISODE is one contiguous run of bars over which the band condition holds. One long`);
    console.log(`  band-hug can legitimately produce several entries, so entries/episode can exceed 1.`);
    console.log('  ' + padr('prox arm', 13) + pad('episodes', 10) + pad('setupBars', 11) + pad('days w/setup', 14) + pad('entries', 9)
      + pad('ent/epi', 9) + pad('epi/day', 9) + pad('ent/day', 9) + pad('opens', 9) + pad('bull/bear', 13));
    for (const p of PROX) {
      const r = byId[`main|${s.key}|${p.key}|20-sATM`];
      if (!r) continue;
      const st = r.stats;
      const setups = st.setupBull + st.setupBear, entries = st.entryBull + st.entryBear, bars = st.barsBull + st.barsBear;
      const na = p.prox === null;
      console.log('  ' + padr(p.key, 13) + pad(na ? 'n/a (ctl)' : setups.toLocaleString(), 10) + pad(na ? '—' : bars.toLocaleString(), 11)
        + pad(na ? '—' : `${st.daysWithSetup}/${D}`, 14) + pad(entries.toLocaleString(), 9)
        + pad(na ? '—' : (setups ? Math.round(entries / setups * 100) / 100 : '—'), 9)
        + pad(na ? '—' : Math.round(setups / D * 100) / 100, 9) + pad(Math.round(entries / D * 100) / 100, 9)
        + pad(r.opens.toLocaleString(), 9) + pad(`${st.entryBull}/${st.entryBear}`, 13));
    }
    console.log(`  (opens < entries wherever the $20/0.60 price ceiling DECLINED the spread — a real strategy rule, not a loss of signal.)`);
    console.log('');
  }

  // ── PER-PATTERN CONTRIBUTION ──────────────────────────────────────────────────────────────────
  const PH = '  ' + padr('pattern', 18) + padr('dir', 6) + pad('entries', 9) + pad('total', 12) + pad('win%', 8) + pad('avgLoss', 11) + pad('worst', 11) + pad('$/trade', 10);
  const patRow = (k, r) => {
    const f = fmt(r);
    const e = r.stats.entryBull + r.stats.entryBear;
    return '  ' + padr(k, 18) + padr(P.PATTERNS[k].dir, 6) + pad(e.toLocaleString(), 9) + pad(f.total, 12) + pad(f.win, 8)
      + pad(f.avgLoss, 11) + pad(f.worst, 11) + pad(e ? usd(Math.round(r.total / e)) : '—', 10);
  };
  for (const s of STRATS) {
    console.log('═'.repeat(PH.length));
    console.log(`PER-PATTERN CONTRIBUTION — Strategy ${s.key} (${s.tf} bands, 10% proximity arm, $20 sATM, each pattern ALONE)`);
    console.log('═'.repeat(PH.length));
    console.log(PH); console.log('  ' + '─'.repeat(PH.length - 2));
    for (const k of P.ALL) { const r = byId[`pat|${s.key}|${k}`]; if (r) console.log(patRow(k, r)); }
    console.log('');
  }
  console.log('═'.repeat(PH.length));
  console.log(`PER-PATTERN CONTRIBUTION — NO BAND CONDITION (the pattern entirely on its own, $20 sATM)`);
  console.log('═'.repeat(PH.length));
  console.log(PH); console.log('  ' + '─'.repeat(PH.length - 2));
  for (const k of P.ALL) { const r = byId[`patctl||${k}`]; if (r) console.log(patRow(k, r)); }
  console.log('');

  // ── DRIFT BENCHMARK ───────────────────────────────────────────────────────────────────────────
  if (byId['drift|bull|4|20-sATM']) {
    console.log('═'.repeat(HDR.length));
    console.log('DRIFT BENCHMARK — SIGNAL-FREE fixed-cadence opens (no bands, no candles, no price read at all).');
    console.log('Any directional program run over a sample that trended will earn on one side and lose on the');
    console.log('other. This is the number the strategies above have to beat to be a SIGNAL rather than a bet');
    console.log('on the sample\'s direction. cad 4 ≈ 19 opens/day (matches the no-band control); cad 13 ≈ 6/day.');
    console.log('═'.repeat(HDR.length));
    console.log(padr('arm', 13) + padr('geo', 10) + pad('total', 12) + pad('win%', 8) + pad('avgLoss', 11)
      + pad('nLoss', 7) + pad('avgLossPot', 12) + pad('worst', 11) + pad('ret/DD', 9) + pad('trd/day', 9) + pad('dTrade', 8));
    console.log('─'.repeat(HDR.length));
    for (const dir of ['bull', 'bear', 'alt']) for (const cad of [4, 13]) {
      let first = true;
      for (const g of GEOS) {
        const r = byId[`drift|${dir}|${cad}|${g.key}`]; if (!r) continue;
        const f = fmt(r);
        const lbl = first ? `${dir} cad${cad}` : ''; first = false;
        console.log(padr(lbl, 13) + padr(g.key + (g.offGrid ? '*' : ''), 10) + pad(f.total, 12) + pad(f.win, 8)
          + pad(f.avgLoss, 11) + pad(f.nLoss, 7) + pad(f.avgLossPot, 12) + pad(f.worst, 11) + pad(f.retDD, 9) + pad(f.tpd, 9) + pad(f.dTrade, 8));
      }
      console.log('─'.repeat(HDR.length));
    }
    console.log('');
  }
  if (GEOS.some(g => g.offGrid)) console.log('* $10 ATM-centered lands OFF the 10-pt strike grid (strikes at x5) — live builds cATM only at $20/$40. Indicative only.');

  // ── DRIFT-ADJUSTED ALPHA ──────────────────────────────────────────────────────────────────────
  // The drift benchmark measures, per geometry, what ONE signal-free bull open and ONE signal-free
  // bear open were worth on this sample (cadence 13 ≈ the strategies' own trade rate). A directional
  // book's expected P&L from drift alone is then
  //     driftPnL = entriesBull × $/bullTrade  +  entriesBear × $/bearTrade
  // and ALPHA = actual total − driftPnL is what the ENTRY TIMING contributed. Alpha ≈ 0 means the
  // arm is a bet on the sample's direction; alpha < 0 means the signal actively hurt.
  const driftPer = {};
  for (const g of GEOS) {
    const b = byId[`drift|bull|13|${g.key}`], s = byId[`drift|bear|13|${g.key}`];
    if (b && s && b.opens && s.opens) driftPer[g.key] = { bull: b.total / b.opens, bear: s.total / s.opens };
  }
  if (Object.keys(driftPer).length) {
    const AH = padr('strategy', 11) + padr('prox arm', 13) + padr('geo', 10) + pad('opens', 8) + pad('bull/bear', 13)
      + pad('actual', 12) + pad('drift P&L', 12) + pad('ALPHA', 12) + pad('alpha/trade', 13);
    console.log('═'.repeat(AH.length));
    console.log('DRIFT-ADJUSTED ALPHA — actual total MINUS what the same bull/bear mix would have earned from');
    console.log('the sample\'s raw drift alone (per-trade drift measured by the cadence-13 benchmark, per geometry).');
    console.log('ALPHA is the part the ENTRY SIGNAL is responsible for. Near zero = the arm is a direction bet.');
    console.log('═'.repeat(AH.length));
    console.log(AH); console.log('─'.repeat(AH.length));
    for (const s of STRATS) {
      for (const p of PROX) {
        for (const g of GEOS) {
          const r = byId[`main|${s.key}|${p.key}|${g.key}`], dp = driftPer[g.key];
          if (!r || !dp) continue;
          const st = r.stats, e = st.entryBull + st.entryBear;
          // scale entries to actual opens (declined spreads never traded), keeping the bull/bear mix
          const k = e ? r.opens / e : 0;
          const drift = st.entryBull * k * dp.bull + st.entryBear * k * dp.bear;
          const alpha = r.total - drift;
          console.log(padr(s.key === STRATS[0].key && p === PROX[0] && g === GEOS[0] ? `Strat ${s.key}` : (g === GEOS[0] ? `Strat ${s.key}` : ''), 11)
            + padr(g === GEOS[0] ? p.key : '', 13) + padr(g.key, 10) + pad(r.opens.toLocaleString(), 8)
            + pad(`${st.entryBull}/${st.entryBear}`, 13) + pad(usd(r.total), 12) + pad(usd(drift), 12) + pad(usd(alpha), 12)
            + pad(r.opens ? usd(alpha / r.opens) : '—', 13));
        }
      }
      console.log('─'.repeat(AH.length));
    }
    console.log('');
  }

  const jsonOut = arg('--json', null);
  if (jsonOut) { fs.writeFileSync(jsonOut, JSON.stringify({ days: D, dataDir: path.basename(DIR), results: raw }, null, 1)); console.log(`\nwrote ${jsonOut}`); }
}

main().catch(e => { console.error(e); process.exit(1); });
