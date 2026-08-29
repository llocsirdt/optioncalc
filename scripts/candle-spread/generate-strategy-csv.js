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
const { v5Signal } = require('./v5-signals');
const { v6Signal } = require('./v6-signals');
const { v7Signal } = require('./v7-signals');

const di = process.argv.indexOf('--dataDir');
const DIR = di >= 0 ? process.argv[di + 1] : eng.DATA_DIR;
const oi = process.argv.indexOf('--out');
const OUT = oi >= 0 ? process.argv[oi + 1] : 'strategy-per-date-comparison.csv';

const at15 = fn => (A, p, ctx) => ctx.isFifteen === false ? { openSide: null, cover: false } : fn(A, p, { ...ctx, cfg: {} });
// column order + how each variant runs
const variants = [
  ['classic', { fn: at15((A, p, c) => eng.classicSignal(A, p, c)) }],
  ['v4', { fn: at15((A, p, c) => eng.v4Signal(A, p, c)) }],
  ['v5', { fn: at15((A, p, c) => v5Signal(A, p, c)) }],
  ['v6', { fn: (A, p, c) => v6Signal(A, p, { ...c, cfg: { fiveMin: true } }) }],
  ['v7-be-wrong', { fn: (A, p, c) => v7Signal(A, p, { ...c, cfg: { fiveMin: true, beWrong: true } }), opts: { bidirectional: true } }],
  ['v8-cap(soft3k/hard9k)', { fn: (A, p, c) => v6Signal(A, p, { ...c, cfg: { fiveMin: true } }), opts: { softCap: 3000, hardCap: 9000, proactiveCoverFrac: 0.70, exemptTrendStack: true } }],
];

const days = load5mDays(DIR);
const ymd = ms => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

// per-variant per-day results
const results = {};   // name -> [{date, term, floor, opens, filled}]
for (const [name, v] of variants) {
  results[name] = days.map(d => {
    const r = runDay5m(d.bars, v.fn, v.opts || {});
    return { date: ymd(d.bars[0].dt), term: r.terminal, floor: r.floor, opens: r.opens, filled: r.filled };
  });
}

// summary stats per variant (incl. the max-drawdown STRETCH)
function summarize(rows) {
  let total = 0, floor = 0, best = -Infinity, worst = Infinity;
  let cum = 0, peak = 0, peakDate = rows[0].date, mdd = 0, ddPeakDate = '', ddTroughDate = '';
  for (const r of rows) {
    total += r.term; floor += r.floor; best = Math.max(best, r.term); worst = Math.min(worst, r.term);
    cum += r.term;
    if (cum > peak) { peak = cum; peakDate = r.date; }
    if (peak - cum > mdd) { mdd = peak - cum; ddPeakDate = peakDate; ddTroughDate = r.date; }
  }
  return { total, floor, avg: total / rows.length, best, worst, mdd, ddPeakDate, ddTroughDate };
}
const sums = Object.fromEntries(variants.map(([n]) => [n, summarize(results[n])]));

// --- build CSV ---
const names = variants.map(([n]) => n);
const R2 = n => Math.round(n);
const lines = [];
lines.push(['', ...names].join(','));   // header (metric col blank, then variant names)
const sRow = (label, fn) => lines.push([label, ...names.map(n => fn(sums[n]))].join(','));
sRow('TOTAL terminal $', s => R2(s.total));
sRow('TOTAL floor (locked) $', s => R2(s.floor));
sRow('AVG terminal/day $', s => R2(s.avg));
sRow('BEST single day $', s => R2(s.best));
sRow('WORST single day $', s => R2(s.worst));
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
