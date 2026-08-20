#!/usr/bin/env node
'use strict';
/**
 * Hypothesis B — EARLIER REVERSAL FROM LOWER TIMEFRAMES.
 *   B1: 3 consecutive BULLISH 1m candles (green, or higher-high without a lower-low) hint a bear
 *       trend is reversing up; mirror for 3 bearish 1m candles vs a bull trend.
 *   B2: 2 consecutive opposing 5m candles.
 * The point is to cover/flip EARLIER than the 15m confirmation the strategy uses today. So the
 * real test is the COUNTER-TREND case (a bullish pattern while the last 15m candle was bearish),
 * and whether acting at the pattern beats waiting — net of false positives.
 *
 *   fav ret   = forward move in the REVERSAL direction (index pts, + = reversal materialized)
 *   base/lift = vs unconditional forward move (same dir/horizon)
 *   head-start = reversal-dir move from the signal to the in-progress 15m candle's close
 *               (+ = price already moved the reversal way before the 15m confirmed -> acting
 *                early captured it; this is the timing edge, the whole reason to use B)
 *
 * Usage: node scripts/signal-lab/score-B.js [SYMBOL=NDX]
 */
const path = require('path');
const fs = require('fs');

const DATA = path.join(__dirname, '../../signal-lab-data');
const symbol = (process.argv.find((a, i) => i >= 2 && !a.startsWith('--')) || 'NDX').toUpperCase();
const ds = JSON.parse(fs.readFileSync(path.join(DATA, `dataset-${symbol}.json`), 'utf8'));
const S1 = ds.timeframes['1m'], S5 = ds.timeframes['5m'], S15 = ds.timeframes['15m'];

const etDate = ms => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const mean = a => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const pct = (n, d) => d ? Math.round((100 * n) / d) : 0;
const p1 = n => (n >= 0 ? '+' : '') + n.toFixed(1);
const fav = (s, i, k, dir) => { if (i + k >= s.length) return null; const d = s[i + k].close - s[i].close; return dir === 'up' ? d : -d; };
const FIFTEEN = 15 * 60 * 1000;

// last CLOSED 15m candle's direction at a given time (same ET day), else 'none'.
function trend15(timeMs) {
  let lo = 0, hi = S15.length - 1, res = null;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (S15[mid].datetime + FIFTEEN <= timeMs) { res = mid; lo = mid + 1; } else hi = mid - 1; }
  if (res == null) return 'none';
  const c = S15[res];
  if (etDate(c.datetime) !== etDate(timeMs)) return 'none';
  return c.close > c.open ? 'bull' : c.close < c.open ? 'bear' : 'flat';
}
// close of the 15m candle in progress at `timeMs` (the price the strategy would act at).
function inProgress15Close(timeMs) {
  for (const c of S15) if (c.datetime + FIFTEEN > timeMs && etDate(c.datetime) === etDate(timeMs)) return c.close;
  return null;
}

// bullish/bearish 1m per the user's definition (needs same-day prior for the high/low test).
const bull1mAt = (s, k) => k >= 1 && etDate(s[k].datetime) === etDate(s[k - 1].datetime) && (s[k].close > s[k].open || (s[k].high > s[k - 1].high && s[k].low >= s[k - 1].low));
const bear1mAt = (s, k) => k >= 1 && etDate(s[k].datetime) === etDate(s[k - 1].datetime) && (s[k].close < s[k].open || (s[k].low < s[k - 1].low && s[k].high <= s[k - 1].high));
function run1m(s, i, atFn) { let n = 0; for (let k = i; k >= 1; k--) { if (k < i && etDate(s[k].datetime) !== etDate(s[i].datetime)) break; if (!atFn(s, k)) break; n++; } return n; }
function runColor5m(s, i, wantGreen) { let n = 0; for (let k = i; k >= 0; k--) { if (k < i && etDate(s[k].datetime) !== etDate(s[i].datetime)) break; const g = s[k].close > s[k].open; if (g === wantGreen && s[k].close !== s[k].open) n++; else break; } return n; }

// pattern signal indices: fresh completions only (run length hits the trigger exactly).
function signals(series, kind) {
  const out = [];
  for (let i = 0; i < series.length; i++) {
    if (kind === 'b1bull' && run1m(series, i, bull1mAt) === 3) out.push(i);
    if (kind === 'b1bear' && run1m(series, i, bear1mAt) === 3) out.push(i);
    if (kind === 'b2bull' && runColor5m(series, i, true) === 2) out.push(i);
    if (kind === 'b2bear' && runColor5m(series, i, false) === 2) out.push(i);
  }
  return out;
}

function baseStats(series, dir, horizons) {
  const out = {};
  for (const k of horizons) { const f = []; for (let i = 0; i < series.length; i++) { const v = fav(series, i, k, dir); if (v != null) f.push(v); } out[k] = { hit: pct(f.filter(x => x > 0).length, f.length), mean: mean(f) }; }
  return out;
}

function report(name, series, kind, dir, horizons, tfDays) {
  const idx = signals(series, kind);
  const base = baseStats(series, dir, horizons);
  const counterTrend = dir === 'up' ? 'bear' : 'bull';   // reversal fires against this 15m trend
  const kMid = horizons[1];

  console.log(`\n── ${name}  (predict ${dir.toUpperCase()}, ${tfDays})   occurrences: ${idx.length}`);
  const line = (label, ids) => {
    if (!ids.length) { console.log(`   ${label.padEnd(28)} n=0`); return; }
    const parts = horizons.map(k => { const f = ids.map(i => fav(series, i, k, dir)).filter(v => v != null); return `${pct(f.filter(x => x > 0).length, f.length)}%/${p1(mean(f))}`; });
    const liftMid = (() => { const f = ids.map(i => fav(series, i, kMid, dir)).filter(v => v != null); return mean(f) - base[kMid].mean; })();
    console.log(`   ${label.padEnd(28)} n=${String(ids.length).padStart(4)}  hit/ret ${parts.join('  ')}  lift@${kMid} ${p1(liftMid)}`);
  };

  console.log(`   base hit/ret: ${horizons.map(k => `${base[k].hit}%/${p1(base[k].mean)}`).join('  ')}   (horizons=${horizons.join('/')} candles)`);
  line('ALL contexts', idx);
  const counter = idx.filter(i => trend15(series[i].datetime) === counterTrend);
  const withT = idx.filter(i => trend15(series[i].datetime) === (dir === 'up' ? 'bull' : 'bear'));
  line(`counter-trend (vs 15m ${counterTrend})`, counter);
  line('with-trend', withT);

  // timing head-start for the counter-trend (the actual use case)
  const hs = counter.map(i => { const c = inProgress15Close(series[i].datetime); if (c == null) return null; const d = c - series[i].close; return dir === 'up' ? d : -d; }).filter(v => v != null);
  if (hs.length) console.log(`   head-start to next 15m close (counter-trend): avg ${p1(mean(hs))} pts  (>0 = price already reversed before the 15m confirmed)`);
}

console.log(`B SCORER — EARLY REVERSAL FROM LOWER TIMEFRAMES — ${symbol}`);
console.log(`hit%=reversal materialized after k candles · ret=mean fav pts · lift=vs base · counter-trend = the real use (pattern opposes the last 15m candle)`);
report('B1  3 bullish 1m', S1, 'b1bull', 'up', [5, 10, 15], `1m ${ds.coverage['1m'].days}d`);
report('B1  3 bearish 1m', S1, 'b1bear', 'down', [5, 10, 15], `1m ${ds.coverage['1m'].days}d`);
report('B2  2 green 5m', S5, 'b2bull', 'up', [2, 3, 4], `5m ${ds.coverage['5m'].days}d`);
report('B2  2 red 5m', S5, 'b2bear', 'down', [2, 3, 4], `5m ${ds.coverage['5m'].days}d`);
console.log('');
