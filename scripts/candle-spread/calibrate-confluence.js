#!/usr/bin/env node
'use strict';
/**
 * Calibrate the v4 confluence/extension thresholds from history.
 *
 * The user's discretionary "the 1m band well beyond the 5/15 band" and "2+ lines aligned in the same
 * area" need concrete numbers. This finds real REVERSAL points (V-shaped swing lows / inverted-V
 * highs) across the 49 backtest days and measures, AT those points:
 *   • band extension — how far the 1m BB channel extended BEYOND the 5m/15m channel, and
 *   • confluence — how many of the 16 lines sit within a small window of the reversal price,
 * then compares each to a BASELINE (all fully-warm minutes) to see how discriminating they are and
 * where the thresholds sit.
 *
 * Usage: node scripts/candle-spread/calibrate-confluence.js
 */
const fs = require('fs');
const path = require('path');
const { extractLines, bandExtension } = require('./confluence');

const DATA_DIR = path.join(__dirname, '..', '..', 'tests', 'backtest', 'backtest-data');
const TFS = ['1m', '5m', '15m', '60m'];

// swing detection (on the 1m close series): a swing LOW at i needs close[i] to be the window min AND
// a real V (dropped `minMove` into it and rose `minMove` out of it within ±W). Mirror for highs.
const W = 15, MIN_MOVE = 10;

function fullyWarm(a) { return a && TFS.every(tf => a[tf] && a[tf].bbupper != null && a[tf].bblower != null && a[tf].ema != null); }
const pct = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((x, y) => x - y); return Math.round(s[Math.floor((s.length - 1) * p)] * 10) / 10; };
const mean = a => a.length ? Math.round(a.reduce((s, x) => s + x, 0) / a.length * 10) / 10 : null;

// count how many of the 16 lines are within ±win pts of price
function linesNear(analysis, price, win) {
  return extractLines(analysis).filter(L => Math.abs(L.value - price) <= win).length;
}

function main() {
  const files = fs.readdirSync(DATA_DIR).filter(f => /^backtest-NDX-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();

  // collectors
  const atLow = { ext5: [], ext15: [], near12: [], near15: [], wick1: [] };   // 1m LOWER extension below 5m/15m
  const atHigh = { ext5: [], ext15: [], near12: [], near15: [], wick1: [] };   // 1m UPPER extension above 5m/15m
  const base = { extLo5: [], extLo15: [], extHi5: [], extHi15: [], near12: [] };
  let nLows = 0, nHighs = 0, nBase = 0, days = 0;

  for (const f of files) {
    const arr = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
    const rows = arr.filter(x => fullyWarm(x.analysis));
    if (rows.length < 2 * W + 5) continue;
    days++;
    const close = rows.map(x => x.analysis['1m'].close);

    for (let i = 0; i < rows.length; i++) {
      const A = rows[i].analysis;
      const ext = bandExtension(A);
      // baseline sample (every fully-warm minute)
      if (ext.lower['5m']) { base.extLo5.push(ext.lower['5m'].pts); base.extLo15.push(ext.lower['15m'] ? ext.lower['15m'].pts : 0); base.extHi5.push(ext.upper['5m'].pts); base.extHi15.push(ext.upper['15m'] ? ext.upper['15m'].pts : 0); base.near12.push(linesNear(A, close[i], 12)); nBase++; }

      if (i < W || i >= rows.length - W) continue;
      const lo = Math.min(...close.slice(i - W, i + W + 1));
      const hi = Math.max(...close.slice(i - W, i + W + 1));
      const leftMax = Math.max(...close.slice(i - W, i + 1)), rightMax = Math.max(...close.slice(i, i + W + 1));
      const leftMin = Math.min(...close.slice(i - W, i + 1)), rightMin = Math.min(...close.slice(i, i + W + 1));

      // swing LOW
      if (close[i] === lo && (leftMax - close[i]) >= MIN_MOVE && (rightMax - close[i]) >= MIN_MOVE) {
        nLows++;
        if (ext.lower['5m']) atLow.ext5.push(ext.lower['5m'].pts);
        if (ext.lower['15m']) atLow.ext15.push(ext.lower['15m'].pts);
        atLow.near12.push(linesNear(A, close[i], 12));
        atLow.near15.push(linesNear(A, close[i], 15));
        if (A['1m'].bblower != null) atLow.wick1.push(Math.round((A['1m'].bblower - A['1m'].low) * 10) / 10);
      }
      // swing HIGH
      if (close[i] === hi && (close[i] - leftMin) >= MIN_MOVE && (close[i] - rightMin) >= MIN_MOVE) {
        nHighs++;
        if (ext.upper['5m']) atHigh.ext5.push(ext.upper['5m'].pts);
        if (ext.upper['15m']) atHigh.ext15.push(ext.upper['15m'].pts);
        atHigh.near12.push(linesNear(A, close[i], 12));
        atHigh.near15.push(linesNear(A, close[i], 15));
        if (A['1m'].bbupper != null) atHigh.wick1.push(Math.round((A['1m'].high - A['1m'].bbupper) * 10) / 10);
      }
    }
  }

  const row = (label, a) => `  ${label.padEnd(30)} p25 ${String(pct(a, .25)).padStart(6)}  median ${String(pct(a, .5)).padStart(6)}  p75 ${String(pct(a, .75)).padStart(6)}  mean ${String(mean(a)).padStart(6)}  (n=${a.length})`;

  console.log(`v4 CONFLUENCE/EXTENSION CALIBRATION — ${days} days, swing W=±${W}min, minMove=${MIN_MOVE}pt\n`);
  console.log(`reversal points found: ${nLows} swing lows, ${nHighs} swing highs  |  baseline minutes: ${nBase}\n`);

  console.log('=== 1m BB channel EXTENSION beyond slower channels (points; >0 = extended past) ===');
  console.log('AT SWING LOWS — how far 1m LOWER band is BELOW the slower lower band:');
  console.log(row('1m lower vs 5m lower', atLow.ext5));
  console.log(row('1m lower vs 15m lower', atLow.ext15));
  console.log('  baseline (all minutes):');
  console.log(row('  1m lower vs 5m lower', base.extLo5));
  console.log(row('  1m lower vs 15m lower', base.extLo15));
  console.log('\nAT SWING HIGHS — how far 1m UPPER band is ABOVE the slower upper band:');
  console.log(row('1m upper vs 5m upper', atHigh.ext5));
  console.log(row('1m upper vs 15m upper', atHigh.ext15));
  console.log('  baseline (all minutes):');
  console.log(row('  1m upper vs 5m upper', base.extHi5));
  console.log(row('  1m upper vs 15m upper', base.extHi15));

  console.log('\n=== WICK beyond the 1m band at reversals (points past the 1m band) ===');
  console.log(row('swing-low: 1m band − low', atLow.wick1));
  console.log(row('swing-high: high − 1m band', atHigh.wick1));

  console.log('\n=== CONFLUENCE: # of the 16 lines within ±window of the reversal price ===');
  console.log(row('swing lows: lines within ±12pt', atLow.near12));
  console.log(row('swing lows: lines within ±15pt', atLow.near15));
  console.log(row('swing highs: lines within ±12pt', atHigh.near12));
  console.log(row('swing highs: lines within ±15pt', atHigh.near15));
  console.log(row('baseline: lines within ±12pt', base.near12));

  console.log('\nRead: if the reversal distributions sit clearly ABOVE baseline, the signal discriminates;');
  console.log('the p25→median band of the extension at reversals is the candidate "extended beyond" threshold.');
}

main();
