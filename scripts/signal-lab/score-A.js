#!/usr/bin/env node
'use strict';
/**
 * Hypothesis A — OVEREXTENSION OPEN-GATE.
 * The strategy opens a continuation position on a strict directional candle (bull = green AND
 * breaks the prior candle's high; bear = red AND breaks the prior low — matching the trader's
 * classifyOpen normal-candle branch). A says: DON'T add that position when the candle closed
 * too far beyond the band in the trend direction, because the move is exhausted.
 *
 * We measure, for every open trigger, the forward move IN THE OPEN'S DIRECTION, bucketed by %B
 * at entry, so we can see where expectancy turns negative — the candidate gate threshold — and
 * whether the gate should be asymmetric (C suggested: gate the downside, not the upside).
 *
 *   fav ret = mean forward move in the open direction (index pts, + = continues favorably)
 *   hit%    = fraction that continued favorably after k candles
 *   vs-avg  = bucket fav ret minus this side's overall open average (the drag from that bucket)
 *
 * Usage: node scripts/signal-lab/score-A.js [SYMBOL=NDX] [--tf 5m,15m,60m]
 */
const path = require('path');
const fs = require('fs');

const DATA = path.join(__dirname, '../../signal-lab-data');
const symbol = (process.argv.find((a, i) => i >= 2 && !a.startsWith('--')) || 'NDX').toUpperCase();
const tfArgI = process.argv.indexOf('--tf');
const TFS = tfArgI >= 0 ? process.argv[tfArgI + 1].split(',') : ['5m', '15m', '60m'];
const HORIZONS = [1, 2, 4];

const ds = JSON.parse(fs.readFileSync(path.join(DATA, `dataset-${symbol}.json`), 'utf8'));

const green = c => c.close > c.open;
const red = c => c.close < c.open;
const etDate = ms => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const mean = a => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const pct = (n, d) => d ? Math.round((100 * n) / d) : 0;
const p1 = n => (n >= 0 ? '+' : '') + n.toFixed(1);
const fav = (series, i, k, dir) => { if (i + k >= series.length) return null; const d = series[i + k].close - series[i].close; return dir === 'up' ? d : -d; };

// %B buckets (ascending). The tails are the "overextended" zones: >1.0 = above upper band
// (relevant to bull opens), <0.0 = below lower band (relevant to bear opens).
const EDGES = [0, 0.2, 0.4, 0.6, 0.8, 1.0, 1.2];
const LABELS = ['< 0.0', '0.0-0.2', '0.2-0.4', '0.4-0.6', '0.6-0.8', '0.8-1.0', '1.0-1.2', '> 1.2'];
const bucketOf = pb => { let i = 0; while (i < EDGES.length && pb >= EDGES[i]) i++; return i; };

// Continuation-open triggers with a SAME-DAY prior candle (skip each day's first candle, which
// is the BB-gate branch, not a continuation).
function triggers(series, side) {
  const out = [];
  for (let i = 1; i < series.length; i++) {
    const c = series[i], prev = series[i - 1];
    if (c.percentB == null || etDate(c.datetime) !== etDate(prev.datetime)) continue;
    if (side === 'bull' && green(c) && c.high > prev.high) out.push(i);
    if (side === 'bear' && red(c) && c.low < prev.low) out.push(i);
  }
  return out;
}

function scoreSide(series, side, tf) {
  const dir = side === 'bull' ? 'up' : 'down';
  const idx = triggers(series, side);
  const overallK2 = idx.map(i => fav(series, i, 2, dir)).filter(f => f != null);
  const oAvg = mean(overallK2), oHit = pct(overallK2.filter(f => f > 0).length, overallK2.length);

  const buckets = LABELS.map(() => []);        // fav@k2 per bucket
  const hits = LABELS.map(() => ({ 1: [], 2: [], 4: [] }));
  for (const i of idx) {
    const b = bucketOf(series[i].percentB);
    for (const k of HORIZONS) { const f = fav(series, i, k, dir); if (f != null) hits[b][k].push(f); }
    const f2 = fav(series, i, 2, dir); if (f2 != null) buckets[b].push(f2);
  }

  const tag = side === 'bull' ? 'above upper band ↑ overextended' : 'below lower band ↓ overextended';
  console.log(`\n  ${side.toUpperCase()} opens (${side === 'bull' ? 'green + breaks prior high' : 'red + breaks prior low'}):  N=${idx.length}  overall fav k2 ${p1(oAvg)} pts, hit ${oHit}%   [tail = ${tag}]`);
  console.log(`     ${'%B bucket'.padEnd(9)} ${'n'.padStart(4)}  ${'hit% k1/k2/k4'.padEnd(14)} ${'favret k2'.padStart(9)} ${'vs-avg'.padStart(7)}`);
  for (let b = 0; b < LABELS.length; b++) {
    const n = buckets[b].length;
    if (!n) { continue; }
    const h = k => pct(hits[b][k].filter(f => f > 0).length, hits[b][k].length);
    const bAvg = mean(buckets[b]);
    const flag = bAvg < 0 ? ' ✗ neg' : bAvg < oAvg * 0.5 ? ' ⚠ weak' : '';
    console.log(`     ${LABELS[b].padEnd(9)} ${String(n).padStart(4)}  ${`${h(1)}/${h(2)}/${h(4)}`.padEnd(14)} ${p1(bAvg).padStart(9)} ${p1(bAvg - oAvg).padStart(7)}${flag}`);
  }
  // Gate takeaway: scan the overextended tail for negative-expectancy buckets.
  const tailOrder = side === 'bull' ? [7, 6] : [0, 1];             // >1.2,1.0-1.2  /  <0, 0-0.2
  const negTail = tailOrder.filter(b => buckets[b].length >= 5 && mean(buckets[b]) < 0);
  if (negTail.length) console.log(`     → GATE candidate: ${side} opens with %B in {${negTail.map(b => LABELS[b]).join(', ')}} show negative continuation.`);
  else console.log(`     → no negative-expectancy tail for ${side} opens (gate would not help this side).`);
}

console.log(`A SCORER — OVEREXTENSION OPEN-GATE — ${symbol}`);
console.log(`continuation opens' forward move in the open direction, bucketed by %B at entry. ✗=negative expectancy, ⚠=<half the side average.`);
for (const tf of TFS) {
  const series = ds.timeframes[tf] || [];
  const cov = ds.coverage[tf];
  console.log(`\n══ ${tf}  (${cov.days}d ${cov.from}..${cov.to}, ${series.length} candles${cov.derived ? ', resampled' : ''})`);
  scoreSide(series, 'bull', tf);
  scoreSide(series, 'bear', tf);
}
console.log('');
