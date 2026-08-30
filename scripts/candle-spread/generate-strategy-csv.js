#!/usr/bin/env node
'use strict';
/**
 * Per-date comparison CSV of the FULL strategy lineage v0-v10 across a MATRIX of spread geometries
 * (width × positioning), on one 5m engine (realistic fills, QTY=1). Each row = a date; each column =
 * variant×geometry; cell = terminal P/L with (opens/covered). Comprehensive summary rows at the top:
 * total, avg/day, MAX DRAWDOWN (+ peak→trough span), MAX RUN-UP (+ trough→peak span = the inverse),
 * WORST day (+ date), BEST day (+ date), opens/day, neg-days, ret/maxDD.
 *
 * VARIANTS: v0-v3 = CLASSIC signal, cover geometry varies (v0 fixed tent, v1 greedy, v2 joint, v3
 * fixed-mark). v4-v6 = signal lineage (multiTF → trend-flip → 5m-harness). v7 = be-wrong. v8 = v6 +
 * caps. v9 = v7 + caps (tamed be-wrong). v10 = mean-reversion. Plus ALL-PARALLEL (sum) per geometry.
 *
 * GEOMETRY: --geos "W:SHIFT|MODE[:capFrac],..." or --matrix "10,20,40,60" (expands each width × the 4
 * positioning MODES). MODES: otm (long toward underlying, cheaper), atm (straddle), itm (short ~ATM),
 * deep (short a couple strikes ITM). Width 10 uses a 5-pt grid (ATM is off a 10-grid).
 *
 * NQ (24h) data auto-enables rthActionOnly: 24h bands, RTH-only action — the faithful live model.
 * Usage: node .../generate-strategy-csv.js --dataDir <5m dir> [--out f.csv] [--matrix "10,20,40,60"]
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

// Risk-cap layers, TUNED on the 922-day Kaggle NQ set (24h→RTH). v8 = aggressive caps on the v6 base;
// v9 = caps on the v7 "be-wrong" base tuned to keep the ceiling (hard $40k backstop + proactive
// deep-ITM cover, no soft cap — a soft cap gutted v7).
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
const baseNames = [...specs.map(s => s[0]), 'v10-meanrev'];

// --- geometry parsing: named positioning MODES (grid-aware) or numeric shift ---
const incrOf = w => (w === 10 ? 5 : 10);
const MODES = { otm: (w) => -incrOf(w), atm: () => 0, itm: (w) => w / 2, deep: (w) => w / 2 + 2 * incrOf(w) };
function geoFromSpec(spec) {
  const parts = String(spec).split(':');
  const w = Number(parts[0]);
  const incr = incrOf(w);
  let shift, label;
  if (MODES[parts[1]]) { shift = MODES[parts[1]](w); label = `$${w}-${parts[1]}`; }
  else { shift = Number(parts[1]) || 0; label = `$${w}${shift ? (shift > 0 ? `+${shift}` : `${shift}`) : ''}`; }
  const cf = parts[2] != null && parts[2] !== '' ? Number(parts[2]) : undefined;
  const opts = (w === 20 && shift === 0) ? {} : { geo: makeGeo({ width: w, incr, shift, capFrac: Number.isFinite(cf) ? cf : undefined }) };
  return { label, opts };
}
const matrixArg = arg('--matrix', null);
const specStrings = matrixArg
  ? matrixArg.split(',').flatMap(w => ['otm', 'atm', 'itm', 'deep'].map(m => `${w}:${m}`))
  : arg('--geos', '20:0,40:20').split(',');
const GEOS = specStrings.filter(Boolean).map(geoFromSpec);

// --- run every variant × geometry ---
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
for (const g of GEOS) {
  const col = `ALL-PARALLEL ${g.label}`; colNames.push(col);
  results[col] = days.map((d, i) => {
    let term = 0, floor = 0, opens = 0, filled = 0;
    for (const bn of baseNames) { const r = results[`${bn} ${g.label}`][i]; term += r.term; floor += r.floor; opens += r.opens; filled += r.filled; }
    return { date: ymd(d.bars[0].dt), term, floor, opens, filled };
  });
}

// --- per-column stats. RISK LENS: SHORT-TERM declines (what can hurt an account in days/weeks), not
// the multi-month peak-to-trough. We report the longest consecutive LOSING-day streak (+its $), the
// longest consecutive WINNING-day streak (the "run of profitable days"), and the worst rolling 5-day
// (~1wk) and 10-day (~2wk) losses. True max DD is kept only as a de-emphasized context column.
function summarize(rows) {
  const T = rows.map(r => r.term);
  let total = 0, worst = Infinity, worstDate = '', best = -Infinity, bestDate = '', neg = 0, opens = 0;
  let cl = 0, cl$ = 0, lossDays = 0, lossDays$ = 0, lossEnd = '';
  let cw = 0, cw$ = 0, winDays = 0, winDays$ = 0, winEnd = '';
  let cum = 0, peak = 0, mdd = 0;
  for (let i = 0; i < rows.length; i++) {
    const t = T[i], date = rows[i].date;
    total += t; opens += rows[i].opens; if (t < 0) neg++;
    if (t < worst) { worst = t; worstDate = date; }
    if (t > best) { best = t; bestDate = date; }
    if (t < 0) { cl++; cl$ += t; if (cl > lossDays) { lossDays = cl; lossDays$ = cl$; lossEnd = date; } cw = 0; cw$ = 0; }
    else if (t > 0) { cw++; cw$ += t; if (cw > winDays) { winDays = cw; winDays$ = cw$; winEnd = date; } cl = 0; cl$ = 0; }
    else { cl = 0; cl$ = 0; cw = 0; cw$ = 0; }
    cum += t; if (cum > peak) peak = cum; if (peak - cum > mdd) mdd = peak - cum;   // context only
  }
  // worst rolling K-day loss (sliding sum over any K consecutive days) — captures a sharp drop even if
  // a small green day interrupts the streak (the "$18k in a week or two" concern).
  const worstRoll = k => { if (T.length < k) return { v: 0, d: '' }; let w = Infinity, wd = '', s = 0; for (let i = 0; i < T.length; i++) { s += T[i]; if (i >= k) s -= T[i - k]; if (i >= k - 1 && s < w) { w = s; wd = rows[i].date; } } return { v: w, d: wd }; };
  return { total, avg: total / rows.length, worst, worstDate, best, bestDate, neg, opens,
    lossDays, lossDays$, lossEnd, winDays, winDays$, winEnd, w5: worstRoll(5), w10: worstRoll(10), mdd };
}
const sums = Object.fromEntries(colNames.map(n => [n, summarize(results[n])]));

// --- CSV: comprehensive summary rows on top, then per-date ---
const R2 = Math.round;
const lines = [['', ...colNames].join(',')];
const sRow = (label, fn) => lines.push([label, ...colNames.map(n => fn(sums[n]))].join(','));
sRow('TOTAL terminal $', s => R2(s.total));
sRow('AVG terminal/day $', s => R2(s.avg));
sRow('RETURN / worst-10day-loss', s => s.w10.v < 0 ? (s.total / -s.w10.v).toFixed(1) : '');   // short-term risk-reward
sRow('WORST 5-day loss $ (~1wk)', s => R2(s.w5.v));
sRow('  worst 5-day END date', s => s.w5.d);
sRow('WORST 10-day loss $ (~2wk)', s => R2(s.w10.v));
sRow('  worst 10-day END date', s => s.w10.d);
sRow('MAX LOSING STREAK (days)', s => s.lossDays);
sRow('  losing-streak $', s => R2(s.lossDays$));
sRow('  losing-streak END date', s => s.lossEnd);
sRow('MAX WINNING STREAK (days)', s => s.winDays);
sRow('  winning-streak $', s => R2(s.winDays$));
sRow('WORST single day $', s => R2(s.worst));
sRow('  worst day DATE', s => s.worstDate);
sRow('BEST single day $', s => R2(s.best));
sRow('  best day DATE', s => s.bestDate);
sRow('opens/day', s => (s.opens / days.length).toFixed(1));
sRow('NEG days', s => `${s.neg}/${days.length}`);
sRow('(context) true MAX DRAWDOWN $', s => R2(s.mdd));
lines.push('');
lines.push(['DATE', ...colNames].join(','));
for (let i = 0; i < days.length; i++) {
  const cells = colNames.map(n => { const r = results[n][i]; return `"${R2(r.term)} (${r.opens}/${r.filled})"`; });
  lines.push([results[colNames[0]][i].date, ...cells].join(','));
}
fs.writeFileSync(OUT, lines.join('\n'));

// --- console: one table per geometry, SHORT-TERM risk lens ---
const usd = n => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');
console.log(`\nwrote ${OUT} — ${days.length} dates × ${colNames.length} cols  [${is24h ? 'NQ 24h→RTH-action' : 'RTH data'}]`);
for (const g of GEOS) {
  console.log(`\n=== geometry ${g.label} ===`);
  console.log('VARIANT'.padEnd(15) + 'total'.padEnd(12) + 'loseStrk'.padEnd(14) + 'worst5d'.padEnd(11) + 'worst10d'.padEnd(11) + 'winStrk'.padEnd(14) + 'worstDay'.padEnd(11) + 'ret/w10');
  console.log('-'.repeat(98));
  for (const bn of [...baseNames, 'ALL-PARALLEL']) {
    const s = sums[`${bn} ${g.label}`];
    console.log(bn.padEnd(15) + usd(s.total).padEnd(12) + `${s.lossDays}d/${usd(s.lossDays$)}`.padEnd(14)
      + usd(s.w5.v).padEnd(11) + usd(s.w10.v).padEnd(11) + `${s.winDays}d/${usd(s.winDays$)}`.padEnd(14)
      + usd(s.worst).padEnd(11) + (s.w10.v < 0 ? (s.total / -s.w10.v).toFixed(1) : '—'));
  }
}
