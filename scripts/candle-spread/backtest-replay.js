#!/usr/bin/env node
'use strict';
/**
 * backtest-replay.js — render ONE backtest day as run records in the LIVE format, so the
 * compare-strategies page can replay a historical day with its time-of-day slider exactly as it replays
 * today's live shadow runs.
 *
 * WHY THIS SHAPE: compare.html already knows how to (a) turn a run record's positions into legs as of an
 * epoch (strategyRunToOptionArray with asOfEpoch), (b) build the epoch↔underlying index off candle_close
 * events, and (c) drive all of it from the slider. Emitting the backtest in that same shape means the UI
 * needs no new curve logic — the backtest just becomes another source of run records. The aggregate
 * baselines answer "how did this variant do over 765 days"; this answers "what did the book actually LOOK
 * like, hour by hour, on this day" — which is the thing you cannot see in a table.
 *
 * Output: { date, symbol, generatedAt, model, runs: { <variant>: <runRecord> } }
 *   runRecord = { runId, tradeDate, config, state:{ positions[], lastUnderlying }, events:[candle_close…] }
 *
 * Usage:
 *   node scripts/candle-spread/backtest-replay.js --date 2024-04-11 [--dataDir <5m dir>] [--out <file>]
 *   node scripts/candle-spread/backtest-replay.js --list            # show available dates
 */
const fs = require('fs');
const path = require('path');
const { runDay5m, load5mDays } = require('./backtest-v6-5m');
const { makeGeo } = require('./backtest-width');
const { buildRuns } = require('../../server/src/candle-spread/index');

const arg = (flag, d) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : d; };
const OUTDIR = path.join(__dirname, '..', '..', 'data', 'backtest-replays');
// KNOWN DATASETS, searched in order. NQ is the 2022-2025 Kaggle history (large, local-only); NDX is the
// Schwab capture (2026, small enough to ship). Their date ranges do not overlap, so a requested date
// selects its dataset unambiguously — no flag needed, and asking for a date only one host has simply
// reports which datasets were searched instead of silently replaying the wrong instrument.
const DATASETS = [
  { name: 'backtest-data-5m-ndx', dir: path.join(__dirname, '..', '..', 'tests', 'backtest', 'backtest-data-5m-ndx') },
  { name: 'backtest-data-5m-nq', dir: path.join(__dirname, '..', '..', 'tests', 'backtest', 'backtest-data-5m-nq') },
];
const explicit = arg('--dataDir', null);
const pools = explicit ? [{ name: path.basename(explicit), dir: explicit }] : DATASETS.filter(d => fs.existsSync(d.dir));
const loaded = pools.map(p => ({ ...p, days: load5mDays(p.dir) }));
// load5mDays labels days as M/D/YYYY (ET); accept either that or ISO on the command line.
const iso = d => { const [m, dd, y] = d.split('/'); return `${y}-${String(m).padStart(2, '0')}-${String(dd).padStart(2, '0')}`; };

if (process.argv.includes('--list')) {
  for (const p of loaded) {
    const ds = p.days.map(d => iso(d.date)).sort();
    console.log(`${ds.length} days in ${p.name}: ${ds[0]} .. ${ds[ds.length - 1]}`);
  }
  process.exit(0);
}

const want = arg('--date', null);
if (!want) { console.error('need --date YYYY-MM-DD (or --list)'); process.exit(1); }
let day = null, DIR = null, poolName = null;
for (const p of loaded) {
  const hit = p.days.find(d => iso(d.date) === want || d.date === want);
  if (hit) { day = hit; DIR = p.dir; poolName = p.name; break; }
}
if (!day) { console.error(`no such day: ${want}. Searched: ${loaded.map(p => p.name).join(', ') || '(no datasets present)'}. Use --list.`); process.exit(1); }

// Same opts mapping the baseline builder uses, so a replay is the SAME run the baselines measured.
function optsFor(v) {
  const o = { rthActionOnly: true, trackCapital: true, intradayIV: true, recordReplay: true };
  if (v.bidirectional) o.bidirectional = true;
  for (const k of ['riskCap', 'softCap', 'hardCap', 'capitalCeiling', 'proactiveCoverFrac', 'lossTarget', 'lossMax']) if (v[k] != null) o[k] = v[k];
  if (v.floorOffset) o.floorOffset = true;
  if (v.continuousCover) o.continuousCover = true;
  if (v.continuousCoverMinLockFrac != null) o.continuousCoverMinLockFrac = v.continuousCoverMinLockFrac;
  if (v.lockCoverMode) o.lockCoverMode = v.lockCoverMode;
  if (v.exemptTrendStack) o.exemptTrendStack = true;
  if (v.coverSelector) o.coverSelector = v.coverSelector;
  if (v.coverToStack) { o.coverToStack = true; o.coverToStackVsRisk = true; if (v.coverToStackMinFrac != null) o.coverToStackMinFrac = v.coverToStackMinFrac; }
  if (v.capitalRecapture) { o.recaptureAlternate = true; if (v.openAlternateEvery != null) o.openAlternateEvery = v.openAlternateEvery; if (v.creditCoverFrac != null) o.creditCoverFrac = v.creditCoverFrac; }
  if (v.enforceLegUniqueness) { o.enforceLegUniqueness = true; if (v.legMaxShift != null) o.legMaxShift = v.legMaxShift; if (v.legMaxWing != null) o.legMaxWing = v.legMaxWing; }
  const w = v.spreadWidth, sh = v.spreadShift || 0, cf = v.capFrac;
  if ((w && w !== 20) || sh || cf != null) o.geo = makeGeo({ width: w || 20, shift: sh, capFrac: cf });
  return o;
}

const RUNS = buildRuns();
const date = iso(day.date);
const out = {
  date, symbol: 'NDX', generatedAt: new Date().toISOString(),
  source: 'backtest', dataDir: poolName,
  model: 'rthActionOnly, QTY=1, live config (governor + continuous covering + resting locks)',
  runs: {},
};

for (const run of RUNS) {
  const fn = (A, p, ctx) => run.signalFn(A, p, { ...ctx, cfg: run.signalCfg || {} });
  const r = runDay5m(day.bars, fn, optsFor(run));
  // Positions in the LIVE record shape. `filled: true` because a backtest position exists only if it
  // was taken; pendingCover is dropped (an unfilled resting order is not part of the book).
  const positions = (r.positions || []).map((p, i) => ({
    id: `bt-${i}`, side: p.side, legs: p.legs, quantity: 1, shortStrike: p.shortStrike,
    limit: p.limit, mark: p.limit, filled: true, orderStatus: 'backtest',
    openEpoch: p.openEpoch, openTime: p.openTime,
    covered: !!p.covered, coverLegs: p.coverLegs || null, coverLimit: p.coverLimit != null ? p.coverLimit : null,
    coverStatus: p.covered ? 'filled' : null, coverEpoch: p.coverEpoch || null, coverTime: p.coverTime || null,
    hedge: p.hedge || undefined, wing: p.wing || undefined,
  }));
  const events = (r.replay || []).map(b => ({
    type: 'candle_close', time: new Date(b.epoch).toISOString(),
    candle: { time: b.time, epoch: b.epoch, close: b.underlying },
    underlying: b.underlying, variant: run.variant,
  }));
  events.push({ type: 'eod_settlement', variant: run.variant, settle: r.settle, terminalPnl: r.terminal, floorPnl: r.floor });
  out.runs[run.variant] = {
    runId: `BT_${out.symbol}_${date}_${run.variant}`, tradeDate: date, variant: run.variant,
    config: { symbol: out.symbol, spreadWidth: run.spreadWidth, spreadShift: run.spreadShift, quantity: 1,
      variant: run.variant, variantLabel: run.variantLabel, lossTarget: run.lossTarget, lossMax: run.lossMax,
      continuousCoverMinLockFrac: run.continuousCoverMinLockFrac },
    summary: { terminal: r.terminal, floor: r.floor, opens: r.opens, filled: r.filled, naked: r.naked,
      bestCase: r.bestCase, worstCase: r.worstCase, governor: r.governor || null },
    state: { positions, lastUnderlying: r.settle, realizedPnl: 0 },
    events,
  };
}

fs.mkdirSync(OUTDIR, { recursive: true });
const file = arg('--out', path.join(OUTDIR, `${date}.json`));
fs.writeFileSync(file, JSON.stringify(out), 'utf8');
const vs = Object.values(out.runs);
const usd = n => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');
console.log(`replay ${date} — ${vs.length} variants · ${(vs[0].events.length - 1)} bars · ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
console.log(`  settle ${vs[0].events[vs[0].events.length - 1].settle.toFixed(0)}  ·  terminal range ${usd(Math.min(...vs.map(v => v.summary.terminal)))} .. ${usd(Math.max(...vs.map(v => v.summary.terminal)))}`);
console.log(`wrote ${path.relative(process.cwd(), file)}`);
