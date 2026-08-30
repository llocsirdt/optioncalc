#!/usr/bin/env node
'use strict';
/**
 * Per-date comparison CSV of the FULL strategy lineage v0-v10 at TWO spread widths ($20 and $40
 * short-ATM), on one 5m engine (realistic fills, QTY=1). Each row = a date; each column =
 * variant×width; cell = terminal P/L with (opens/covered). Summary rows at the top; the variant
 * summaries ($20 vs $40 side by side) are printed to the console.
 *
 * VARIANTS: v0-v3 = CLASSIC signal, cover geometry varies (v0 fixed tent, v1 greedy, v2 joint, v3
 * fixed-mark — via the server's pure cover selectors). v4-v6 = signal lineage (multiTF → trend-flip →
 * 5m-harness). v7 = be-wrong (bidirectional). v8 = v6 + risk caps. v9 = v7 + risk caps (the tamed
 * be-wrong). v10 = mean-reversion (separate engine). Plus ALL-PARALLEL (sum) per width.
 *
 * NQ (24h) data auto-enables rthActionOnly: 24h bands, RTH-only action — the faithful live model.
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

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const DIR = arg('--dataDir', eng.DATA_DIR);
const OUT = arg('--out', 'strategy-per-date-comparison.csv');

// Risk-cap layers, TUNED on the 922-day Kaggle NQ set (24h→RTH; see the sweep in the commit).
// v8 = aggressive caps on the v6 base (soft $3k/hard $9k — illustrates hard throttling).
// v9 = the caps on the v7 "be-wrong" base, tuned to KEEP the ceiling while bounding the tail: a hard
//   $40k single-day uncovered backstop + proactive deep-ITM covering (0.8×width), NO soft cap (a soft
//   cap gutted v7 — $2.66M→$0.96M). Result ≈ v6's risk-efficiency (~27.7 ret/maxDD) at ~2× the scale.
const V8CAPS = { softCap: 3000, hardCap: 9000, proactiveCoverFrac: 0.70, exemptTrendStack: true };
const V9CAPS = { hardCap: 40000, proactiveCoverFrac: 0.80 };

const days = load5mDays(DIR);
const ymd = ms => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const etMin = ms => { const d = new Date(new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York' })); return d.getHours() * 60 + d.getMinutes(); };
const inRth = ms => { const m = etMin(ms); return m >= 575 && m <= 955; };
const is24h = days.length && days[0].bars.some(b => { const m = etMin(b.dt); return m < 570 || m >= 960; });
const BASE = is24h ? { rthActionOnly: true } : {};

const at15 = fn => (A, p, ctx) => ctx.isFifteen === false ? { openSide: null, cover: false } : fn(A, p, { ...ctx, cfg: {} });
const norm = r => ({ term: r.terminal, floor: r.floor || 0, opens: r.opens, filled: r.filled || 0 });
const classic = (A, p, c) => eng.classicSignal(A, p, c);
const v4 = (A, p, c) => eng.v4Signal(A, p, c);
const v6fn = (A, p, c) => v6Signal(A, p, { ...c, cfg: { fiveMin: true } });
const v7fn = (A, p, c) => v7Signal(A, p, { ...c, cfg: { fiveMin: true, beWrong: true } });

// [name, signalFn, non-geo opts]. v10 (mean-rev) is a separate engine, handled below.
const specs = [
  ['v0-classic', at15(classic), {}],
  ['v1-greedy', at15(classic), { coverSelector: 'greedy' }],
  ['v2-joint', at15(classic), { coverSelector: 'joint' }],
  ['v3-fixedmark', at15(classic), { coverSelector: 'fixed-mark' }],
  ['v4-multiTF', at15(v4), {}],
  ['v5-trendflip', at15(v5Signal), {}],
  ['v6-5mharness', v6fn, {}],
  ['v7-bewrong', v7fn, { bidirectional: true }],
  ['v8-v6caps', v6fn, V8CAPS],
  ['v9-v7caps', v7fn, { bidirectional: true, ...V9CAPS }],
];
// GEOMETRIES to compare: --geos "W:SHIFT[:capFrac],..." (default 20 ATM + 40 short-ATM). SHIFT is the
// positioning axis: <0 OTM, 0 ATM, W/2 short-ATM/just-ITM, >W/2 deeper-ITM. Widths 10/20/40/60 etc.
// $20 ATM uses the built-in engine geometry (preserves validated numbers); everything else via makeGeo.
const geosArg = arg('--geos', '20:0,40:20');
const GEOS = geosArg.split(',').filter(Boolean).map(spec => {
  const [w, sh, cf] = spec.split(':').map(Number);
  const shift = sh || 0;
  const label = `$${w}${shift ? (shift > 0 ? `+${shift}` : `${shift}`) : ''}`;
  const opts = (w === 20 && shift === 0) ? {} : { geo: makeGeo({ width: w, shift, capFrac: Number.isFinite(cf) ? cf : undefined }) };
  return { label, opts };
});
const baseNames = [...specs.map(s => s[0]), 'v10-meanrev'];

const results = {}, colNames = [];
for (const [name, sig, extra] of specs) {
  for (const g of GEOS) {
    const col = `${name} ${g.label}`; colNames.push(col);
    results[col] = days.map(d => ({ date: ymd(d.bars[0].dt), ...norm(runDay5m(d.bars, sig, { ...BASE, ...extra, ...g.opts })) }));
  }
}
for (const g of GEOS) {
  const col = `v10-meanrev ${g.label}`; colNames.push(col);
  results[col] = days.map(d => { const b = is24h ? d.bars.filter(x => inRth(x.dt)) : d.bars; return { date: ymd(d.bars[0].dt), ...(b.length ? norm(runDay9(b, { maxImbalance: 5, ...g.opts })) : { term: 0, floor: 0, opens: 0, filled: 0 }) }; });
}
// ALL-PARALLEL per geometry = sum across variants of that geometry.
for (const g of GEOS) {
  const col = `ALL-PARALLEL ${g.label}`; colNames.push(col);
  results[col] = days.map((d, i) => {
    let term = 0, floor = 0, opens = 0, filled = 0;
    for (const bn of baseNames) { const r = results[`${bn} ${g.label}`][i]; term += r.term; floor += r.floor; opens += r.opens; filled += r.filled; }
    return { date: ymd(d.bars[0].dt), term, floor, opens, filled };
  });
}

function summarize(rows) {
  let total = 0, worst = Infinity, cum = 0, peak = 0, mdd = 0, neg = 0, opens = 0;
  for (const r of rows) {
    total += r.term; opens += r.opens; if (r.term < 0) neg++;
    if (r.term < worst) worst = r.term;
    cum += r.term; if (cum > peak) peak = cum; if (peak - cum > mdd) mdd = peak - cum;
  }
  return { total, avg: total / rows.length, worst, mdd, neg, opens };
}
const sums = Object.fromEntries(colNames.map(n => [n, summarize(results[n])]));

// --- CSV: summary rows on top, then per-date ---
const R2 = Math.round;
const lines = [['', ...colNames].join(',')];
const sRow = (label, fn) => lines.push([label, ...colNames.map(n => fn(sums[n]))].join(','));
sRow('TOTAL terminal $', s => R2(s.total));
sRow('AVG terminal/day $', s => R2(s.avg));
sRow('MAX DRAWDOWN $', s => R2(s.mdd));
sRow('WORST day $', s => R2(s.worst));
sRow('opens/day', s => (s.opens / days.length).toFixed(1));
sRow('NEG days', s => `${s.neg}/${days.length}`);
lines.push('');
lines.push(['DATE', ...colNames].join(','));
for (let i = 0; i < days.length; i++) {
  const cells = colNames.map(n => { const r = results[n][i]; return `"${R2(r.term)} (${r.opens}/${r.filled})"`; });
  lines.push([results[colNames[0]][i].date, ...cells].join(','));
}
fs.writeFileSync(OUT, lines.join('\n'));

// --- console: one table per geometry (scales to any --geos list) ---
const usd = n => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');
console.log(`\nwrote ${OUT} — ${days.length} dates × ${colNames.length} cols  [${is24h ? 'NQ 24h→RTH-action' : 'RTH data'}]`);
for (const g of GEOS) {
  console.log(`\n=== geometry ${g.label} ===`);
  console.log('VARIANT'.padEnd(16) + 'total'.padEnd(13) + 'avg/day'.padEnd(10) + 'maxDD'.padEnd(12) + 'worstDay'.padEnd(12) + 'ret/maxDD'.padEnd(11) + 'opens/d');
  console.log('-'.repeat(84));
  for (const bn of [...baseNames, 'ALL-PARALLEL']) {
    const s = sums[`${bn} ${g.label}`];
    console.log(bn.padEnd(16) + usd(s.total).padEnd(13) + usd(s.avg).padEnd(10) + usd(s.mdd).padEnd(12) + usd(s.worst).padEnd(12)
      + (s.mdd > 0 ? (s.total / s.mdd).toFixed(1) : '—').padEnd(11) + (s.opens / days.length).toFixed(1));
  }
}
