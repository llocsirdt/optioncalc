#!/usr/bin/env node
'use strict';
/**
 * Per-date comparison CSV of the FULL strategy lineage v0-v9 on ONE 5m engine (realistic fills, QTY=1).
 * Each row = a date; each column = a variant; cell = terminal P/L with (opens/covered). Summary rows at
 * the top (total/floor/avg/best/worst/maxDD + the max-drawdown STRETCH), and the 10 variant summaries
 * are printed to the console.
 *
 * VARIANTS: v0-v3 = the CLASSIC signal with different COVER geometry (v0 fixed tent, v1 greedy, v2 joint,
 * v3 fixed-mark — via the server's pure cover selectors). v4-v8 = the SIGNAL lineage (multiTF → 5m-harness
 * → be-wrong → risk-capped). v9 = the separate mean-reversion engine. Plus ALL-PARALLEL (sum).
 *
 * NQ (24h) data auto-enables rthActionOnly: the multi-TF bands use the full 24h Globex session, but the
 * strategy only ACTS during RTH (9:35-16:00) — the faithful model of live (NQ signal → RTH NDX trades).
 * NDX (RTH-only) data is unaffected (no overnight bars → the flag is a no-op).
 *
 * Usage: node scripts/candle-spread/generate-strategy-csv.js --dataDir <5m dir> [--out file.csv] [--geo "w,shift"]
 */
const fs = require('fs');
const eng = require('./backtest-v4');
const { runDay5m, load5mDays } = require('./backtest-v6-5m');
const { runDay9 } = require('./backtest-v9-5m');
const { makeGeo } = require('./backtest-width');
const { v5Signal } = require('./v5-signals');
const { v6Signal } = require('./v6-signals');
const { v7Signal } = require('./v7-signals');

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const DIR = arg('--dataDir', eng.DATA_DIR);
const OUT = arg('--out', 'strategy-per-date-comparison.csv');
const gi = process.argv.indexOf('--geo');
const GEO = gi >= 0 ? (() => { const [w, s] = process.argv[gi + 1].split(',').map(Number); return makeGeo({ width: w, shift: s || 0 }); })() : null;
const GO = GEO ? { geo: GEO } : {};

const days = load5mDays(DIR);
const ymd = ms => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const etMin = ms => { const d = new Date(new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York' })); return d.getHours() * 60 + d.getMinutes(); };
const inRth = ms => { const m = etMin(ms); return m >= 575 && m <= 955; };

// Auto-detect NQ/24h data (has overnight bars) → act RTH-only, the faithful live model.
const is24h = days.length && days[0].bars.some(b => { const m = etMin(b.dt); return m < 570 || m >= 960; });
const BASE = { ...GO, ...(is24h ? { rthActionOnly: true } : {}) };

const at15 = fn => (A, p, ctx) => ctx.isFifteen === false ? { openSide: null, cover: false } : fn(A, p, { ...ctx, cfg: {} });
const norm = r => ({ term: r.terminal, floor: r.floor || 0, opens: r.opens, filled: r.filled || 0 });
const r5 = (sig, extra) => d => norm(runDay5m(d.bars, sig, { ...BASE, ...extra }));
const classic = (A, p, c) => eng.classicSignal(A, p, c);
const v4 = (A, p, c) => eng.v4Signal(A, p, c);
// v0-v3: classic signal, cover geometry varies. v4-v8: signal varies. v9: separate engine.
const variants = [
  ['v0-classic',   r5(at15(classic))],
  ['v1-greedy',    r5(at15(classic), { coverSelector: 'greedy' })],
  ['v2-joint',     r5(at15(classic), { coverSelector: 'joint' })],
  ['v3-fixedmark', r5(at15(classic), { coverSelector: 'fixed-mark' })],
  ['v4-multiTF',   r5(at15(v4))],
  ['v5-trendflip', r5(at15(v5Signal))],
  ['v6-5mharness', r5((A, p, c) => v6Signal(A, p, { ...c, cfg: { fiveMin: true } }))],
  ['v7-bewrong',   r5((A, p, c) => v7Signal(A, p, { ...c, cfg: { fiveMin: true, beWrong: true } }), { bidirectional: true })],
  ['v8-riskcapped', r5((A, p, c) => v6Signal(A, p, { ...c, cfg: { fiveMin: true } }), { softCap: 3000, hardCap: 9000, proactiveCoverFrac: 0.70, exemptTrendStack: true })],
  ['v9-meanrev',   d => { const b = is24h ? d.bars.filter(x => inRth(x.dt)) : d.bars; return b.length ? norm(runDay9(b, { maxImbalance: 5 })) : { term: 0, floor: 0, opens: 0, filled: 0 }; }],
];

const results = {};
for (const [name, run] of variants) results[name] = days.map(d => ({ date: ymd(d.bars[0].dt), ...run(d) }));
// ALL-PARALLEL = sum across every variant per day.
const stratNames = variants.map(([n]) => n);
results['ALL-PARALLEL'] = days.map((d, i) => {
  let term = 0, floor = 0, opens = 0, filled = 0;
  for (const n of stratNames) { term += results[n][i].term; floor += results[n][i].floor; opens += results[n][i].opens; filled += results[n][i].filled; }
  return { date: ymd(d.bars[0].dt), term, floor, opens, filled };
});

function summarize(rows) {
  let total = 0, floor = 0, best = -Infinity, worst = Infinity, bestDate = '', worstDate = '', neg = 0, opens = 0;
  let cum = 0, peak = 0, peakDate = rows[0] ? rows[0].date : '', mdd = 0, ddPeakDate = '', ddTroughDate = '';
  for (const r of rows) {
    total += r.term; floor += r.floor; opens += r.opens; if (r.term < 0) neg++;
    if (r.term > best) { best = r.term; bestDate = r.date; }
    if (r.term < worst) { worst = r.term; worstDate = r.date; }
    cum += r.term;
    if (cum > peak) { peak = cum; peakDate = r.date; }
    if (peak - cum > mdd) { mdd = peak - cum; ddPeakDate = peakDate; ddTroughDate = r.date; }
  }
  return { total, floor, avg: total / rows.length, best, bestDate, worst, worstDate, mdd, ddPeakDate, ddTroughDate, neg, opens };
}

const names = [...stratNames, 'ALL-PARALLEL'];
const sums = Object.fromEntries(names.map(n => [n, summarize(results[n])]));
const R2 = n => Math.round(n);
const lines = [];
lines.push(['', ...names].join(','));
const sRow = (label, fn) => lines.push([label, ...names.map(n => fn(sums[n]))].join(','));
sRow('TOTAL terminal $', s => R2(s.total));
sRow('TOTAL floor (locked) $', s => R2(s.floor));
sRow('AVG terminal/day $', s => R2(s.avg));
sRow('BEST single day $ (date)', s => `"${R2(s.best)} (${s.bestDate})"`);
sRow('WORST single day $ (date)', s => `"${R2(s.worst)} (${s.worstDate})"`);
sRow('MAX DRAWDOWN (peak-to-trough) $', s => R2(s.mdd));
sRow('  drawdown span (peak->trough)', s => `"${s.ddPeakDate}..${s.ddTroughDate}"`);
sRow('NEGATIVE days', s => `${s.neg}/${days.length}`);
lines.push('');
lines.push(['DATE', ...names].join(','));
for (let i = 0; i < days.length; i++) {
  const cells = names.map(n => { const r = results[n][i]; return `"${R2(r.term)} (${r.opens}/${r.filled})"`; });
  lines.push([results[names[0]][i].date, ...cells].join(','));
}
fs.writeFileSync(OUT, lines.join('\n'));

const usd = n => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');
console.log(`\nwrote ${OUT} — ${days.length} dates × ${names.length} variants  [${is24h ? 'NQ 24h → RTH-action' : 'RTH data'}${GEO ? `, geo $${GEO.WIDTH}` : ''}]\n`);
console.log('VARIANT'.padEnd(15) + 'total'.padEnd(13) + 'avg/day'.padEnd(10) + 'maxDD'.padEnd(12) + 'worstDay'.padEnd(12) + 'opens/d'.padEnd(9) + 'neg-days');
console.log('-'.repeat(88));
for (const n of names) {
  const s = sums[n];
  console.log(n.padEnd(15) + usd(s.total).padEnd(13) + usd(s.avg).padEnd(10) + usd(s.mdd).padEnd(12) + usd(s.worst).padEnd(12) + (s.opens / days.length).toFixed(1).padEnd(9) + `${s.neg}/${days.length}`);
}
