#!/usr/bin/env node
'use strict';
/**
 * Per-date comparison CSV of the strategy lineage on ONE 5m engine (realistic fills, QTY=1, uncapped
 * unless the variant carries opts). Each row = a date; each column = a variant; cell = terminal P/L
 * with (opensCovered) trades. Summary rows at the top (total/floor/avg/best/worst/maxDD) + the
 * max-drawdown STRETCH (peak→trough dates + span) so you can see whether a big drawdown is one bad
 * cluster or spread out with recovery between.
 *
 * Usage: node scripts/candle-spread/generate-strategy-csv.js --dataDir <5m dir> [--out file.csv]
 */
const fs = require('fs');
const eng = require('./backtest-v4');
const { runDay5m, load5mDays } = require('./backtest-v6-5m');
const { runDay9 } = require('./backtest-v9-5m');
const { makeGeo } = require('./backtest-width');
const { v5Signal } = require('./v5-signals');
const { v6Signal } = require('./v6-signals');
const { v7Signal } = require('./v7-signals');

const di = process.argv.indexOf('--dataDir');
const DIR = di >= 0 ? process.argv[di + 1] : eng.DATA_DIR;
const oi = process.argv.indexOf('--out');
const OUT = oi >= 0 ? process.argv[oi + 1] : 'strategy-per-date-comparison.csv';
// --geo "width,shift" (e.g. "40,20" = $40 spreads, short-ATM) applies a wider geometry to all
// runDay5m variants (v9 stays $20 — different engine). Default: the $20 ATM geometry.
const gi = process.argv.indexOf('--geo');
const GEO = gi >= 0 ? (() => { const [w, s] = process.argv[gi + 1].split(',').map(Number); return makeGeo({ width: w, shift: s || 0 }); })() : null;
const GO = GEO ? { geo: GEO } : {};

const at15 = fn => (A, p, ctx) => ctx.isFifteen === false ? { openSide: null, cover: false } : fn(A, p, { ...ctx, cfg: {} });
// each variant: name + a run(d) → { term, floor, opens, filled }. v9 uses its own engine (runDay9).
const norm = r => ({ term: r.terminal, floor: r.floor || 0, opens: r.opens, filled: r.filled || 0 });
const variants = [
  ['classic', d => norm(runDay5m(d.bars, at15((A, p, c) => eng.classicSignal(A, p, c)), { ...GO }))],
  ['v4', d => norm(runDay5m(d.bars, at15((A, p, c) => eng.v4Signal(A, p, c)), { ...GO }))],
  ['v5', d => norm(runDay5m(d.bars, at15((A, p, c) => v5Signal(A, p, c)), { ...GO }))],
  ['v6', d => norm(runDay5m(d.bars, (A, p, c) => v6Signal(A, p, { ...c, cfg: { fiveMin: true } }), { ...GO }))],
  ['v7-be-wrong', d => norm(runDay5m(d.bars, (A, p, c) => v7Signal(A, p, { ...c, cfg: { fiveMin: true, beWrong: true } }), { bidirectional: true, ...GO }))],
  ['v8-cap(soft3k/hard9k)', d => norm(runDay5m(d.bars, (A, p, c) => v6Signal(A, p, { ...c, cfg: { fiveMin: true } }), { softCap: 3000, hardCap: 9000, proactiveCoverFrac: 0.70, exemptTrendStack: true, ...GO }))],
  ['v9-meanrev(imb5)', d => norm(runDay9(d.bars, { maxImbalance: 5 }))],
];

const days = load5mDays(DIR);
const ymd = ms => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

// per-variant per-day results
const results = {};   // name -> [{date, term, floor, opens, filled}]
for (const [name, run] of variants) {
  results[name] = days.map(d => ({ date: ymd(d.bars[0].dt), ...run(d) }));
}
// ALL-PARALLEL = sum across every strategy for each day (winners offset losers).
const stratNames = variants.map(([n]) => n);
results['ALL-PARALLEL(sum)'] = days.map((d, i) => {
  let term = 0, floor = 0, opens = 0, filled = 0;
  for (const n of stratNames) { term += results[n][i].term; floor += results[n][i].floor; opens += results[n][i].opens; filled += results[n][i].filled; }
  return { date: ymd(d.bars[0].dt), term, floor, opens, filled };
});

// summary stats per column (incl. the max-drawdown STRETCH + best/worst DATES)
function summarize(rows) {
  let total = 0, floor = 0, best = -Infinity, worst = Infinity, bestDate = '', worstDate = '';
  let cum = 0, peak = 0, peakDate = rows[0].date, mdd = 0, ddPeakDate = '', ddTroughDate = '';
  for (const r of rows) {
    total += r.term; floor += r.floor;
    if (r.term > best) { best = r.term; bestDate = r.date; }
    if (r.term < worst) { worst = r.term; worstDate = r.date; }
    cum += r.term;
    if (cum > peak) { peak = cum; peakDate = r.date; }
    if (peak - cum > mdd) { mdd = peak - cum; ddPeakDate = peakDate; ddTroughDate = r.date; }
  }
  return { total, floor, avg: total / rows.length, best, bestDate, worst, worstDate, mdd, ddPeakDate, ddTroughDate };
}
// --- build CSV ---
const names = [...stratNames, 'ALL-PARALLEL(sum)'];
const sums = Object.fromEntries(names.map(n => [n, summarize(results[n])]));
const R2 = n => Math.round(n);
const lines = [];
lines.push(['', ...names].join(','));   // header (metric col blank, then variant names)
const sRow = (label, fn) => lines.push([label, ...names.map(n => fn(sums[n]))].join(','));
sRow('TOTAL terminal $', s => R2(s.total));
sRow('TOTAL floor (locked) $', s => R2(s.floor));
sRow('AVG terminal/day $', s => R2(s.avg));
sRow('BEST single day $ (date)', s => `"${R2(s.best)} (${s.bestDate})"`);
sRow('WORST single day $ (date)', s => `"${R2(s.worst)} (${s.worstDate})"`);
sRow('MAX DRAWDOWN (peak-to-trough) $', s => R2(s.mdd));
sRow('  drawdown span (peak->trough)', s => `"${s.ddPeakDate}..${s.ddTroughDate}"`);
lines.push('');   // blank separator
lines.push(['DATE', ...names].join(','));   // per-date header
for (let i = 0; i < days.length; i++) {
  const cells = names.map(n => { const r = results[n][i]; return `"${R2(r.term)} (${r.opens}/${r.filled})"`; });
  lines.push([results[names[0]][i].date, ...cells].join(','));
}

fs.writeFileSync(OUT, lines.join('\n'));
console.log(`wrote ${OUT} — ${days.length} dates × ${names.length} variants. cell = terminal$ (opens/covered).`);
console.log('\nMAX-DRAWDOWN STRETCH per variant (is the big DD one cluster or spread out?):');
for (const n of names) { const s = sums[n]; console.log(`  ${n.padEnd(24)} maxDD $${R2(s.mdd).toLocaleString()}  over ${s.ddPeakDate}..${s.ddTroughDate}  (worst single day $${R2(s.worst).toLocaleString()})`); }
