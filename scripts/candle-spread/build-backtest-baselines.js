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
const OUT = path.join(__dirname, '..', '..', 'server', 'src', 'candle-spread', 'backtest-baselines.json');
const usd = n => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');

// Live variant config -> 5m-engine opts. The engine reads caps/flags directly; width/shift/capFrac go
// through makeGeo; the signal's cfg (fiveMin/beWrong) is merged into ctx exactly as the live trader does.
function optsFor(v) {
  const o = { rthActionOnly: true };
  if (v.bidirectional) o.bidirectional = true;
  for (const k of ['riskCap', 'softCap', 'hardCap', 'capitalCeiling', 'proactiveCoverFrac']) if (v[k] != null) o[k] = v[k];
  if (v.exemptTrendStack) o.exemptTrendStack = true;
  if (v.coverSelector) o.coverSelector = v.coverSelector;
  if (v.coverToStack) { o.coverToStack = true; o.coverToStackVsRisk = true; if (v.coverToStackMinFrac != null) o.coverToStackMinFrac = v.coverToStackMinFrac; }
  // capital-recapture cash is P&L-neutral (parity), but its debit/credit ALTERNATION spreads legs across
  // both ladders, so under leg-uniqueness it changes which opens shift/skip → must be modeled to match live.
  if (v.capitalRecapture) { o.recaptureAlternate = true; if (v.openAlternateEvery != null) o.openAlternateEvery = v.openAlternateEvery; if (v.creditCoverFrac != null) o.creditCoverFrac = v.creditCoverFrac; }
  if (v.enforceLegUniqueness) { o.enforceLegUniqueness = true; if (v.legMaxShift != null) o.legMaxShift = v.legMaxShift; if (v.legMaxWing != null) o.legMaxWing = v.legMaxWing; }
  const w = v.spreadWidth, sh = v.spreadShift || 0, cf = v.capFrac;
  if ((w && w !== 20) || sh || cf != null) o.geo = makeGeo({ width: w || 20, shift: sh, capFrac: cf });
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

const allDays = load5mDays(DIR);
if (!allDays.length) { console.error('no days loaded from', DIR); process.exit(1); }

// A day is TRADEABLE only if it has a real RTH cash session (a bar in 09:30–16:00 ET). The 24h NQ feed
// includes Sunday-evening/holiday futures sessions with no cash session — untradeable for 0DTE NDX, they
// contribute $0 and would dilute the per-day average. Grade only against real trading days.
const etMin = ms => { const d = new Date(new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York' })); return d.getHours() * 60 + d.getMinutes(); };
const hasRth = d => d.bars.some(b => { const m = etMin(b.dt); return m >= 570 && m < 960; });
const days = allDays.filter(hasRth);
const excluded = allDays.length - days.length;

const out = { generatedAt: new Date().toISOString(), dataDir: path.basename(DIR), days: days.length, calendarDays: allDays.length, nonTradingDays: excluded, model: 'rthActionOnly (24h bands, RTH action), QTY=1, tradeable days only, live config (recapture + leg-uniqueness)', variants: {} };
console.log(`BACKTEST BASELINES — ${RUNS.length} variants × ${days.length} trading days (${excluded} non-trading calendar entries excluded)\n`);
console.log('variant'.padEnd(16) + 'avg/day'.padEnd(11) + 'median'.padEnd(11) + 'stdev'.padEnd(11) + 'worst'.padEnd(12) + 'neg/win');
console.log('-'.repeat(78));
for (const run of RUNS) {
  const fn = wrap(run), opts = optsFor(run);
  const daily = days.map(d => runDay5m(d.bars, fn, opts).terminal);
  const s = stats(daily);
  out.variants[run.variant] = { label: run.variantLabel, ...s };
  console.log(run.variant.padEnd(16) + usd(s.avgDaily).padEnd(11) + usd(s.median).padEnd(11) + usd(s.stdevDaily).padEnd(11) + usd(s.worst).padEnd(12) + `${s.negDays}/${days.length} · ${Math.round(s.winRate * 100)}%`);
}

// ENGINE-INTEGRITY anchor: the PURE v6 signal (no recapture/leg-uniqueness) must still reproduce the known
// $1,412,935 total — proves the engine + signal are unchanged. The graded v6 above carries the ~0.6% leg-
// uniqueness cost now that it's a live default, so the anchor is checked separately on the pure config.
const pureV6 = VARIANTS.find(v => v.variant === 'v6');
const anchorTotal = Math.round(days.reduce((a, d) => a + runDay5m(d.bars, wrap(pureV6), { rthActionOnly: true }).terminal, 0));
const anchorOK = anchorTotal === 1412935;
console.log(`\nengine anchor (pure v6, no recap/leg-uniq) = ${usd(anchorTotal)}  ${anchorOK ? '✓ matches $1,412,935' : '✗ EXPECTED $1,412,935'}`);
console.log(`graded v6 (live config) total = ${usd(out.variants.v6.total)}  avg/day ${usd(out.variants.v6.avgDaily)}`);
out.engineAnchorPureV6Total = anchorTotal;

if (DRY) { console.log('\n--dry: not written'); process.exit(anchorOK ? 0 : 2); }
fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log('\nwrote', path.relative(process.cwd(), OUT));
process.exit(anchorOK ? 0 : 2);
