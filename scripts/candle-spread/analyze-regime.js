#!/usr/bin/env node
'use strict';
/**
 * Q4 — how does v4 perform in different DAILY regimes? Classifies each backtest day by (a) the daily
 * trend (up/down/choppy, from the 20DMA's 5-day slope in daily-band-widths) and (b) where the day's
 * close sits in the daily Bollinger band (lower-band ride / below center / at center / above center /
 * upper-band ride), then buckets v4's floor + terminal (and win-rate vs classic) by regime.
 *
 * Daily context comes from a fetched daily $NDX series (scratchpad/ndx-daily.json) with BB(20,2).
 * Usage: node scripts/candle-spread/analyze-regime.js --daily <ndx-daily.json> [--dataDir D]
 */
const fs = require('fs');
const eng = require('./backtest-v4');
const { bollinger } = require('../signal-lab/indicators');

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const dailyPath = arg('--daily', null);
const dir = arg('--dataDir', eng.DATA_DIR);
if (!dailyPath || !fs.existsSync(dailyPath)) { console.error('need --daily <ndx-daily.json>'); process.exit(1); }

// --- daily context: BB(20,2) + %B + 20DMA(mid) slope trend ---
const daily = JSON.parse(fs.readFileSync(dailyPath, 'utf8')).sort((a, b) => a.datetime - b.datetime);
const bb = bollinger(daily, 20, 2);
const ymd = ms => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const ctx = new Map();
for (let i = 0; i < daily.length; i++) {
  const b = bb[i]; if (!b || b.bbUpper == null || i < 25) continue;
  const width = b.bbUpper - b.bbLower;
  const pctB = width > 0 ? (daily[i].close - b.bbLower) / width : 0.5;
  const slope5 = (b.bbMiddle - bb[i - 5].bbMiddle) / width;         // 20DMA move over 5d, in band-widths
  const trend = slope5 > 0.10 ? 'up' : slope5 < -0.10 ? 'down' : 'choppy';
  const band = pctB <= 0.20 ? 'lower-band' : pctB < 0.45 ? 'below-center' : pctB <= 0.55 ? 'at-center'
    : pctB <= 0.80 ? 'above-center' : 'upper-band';
  ctx.set(ymd(daily[i].datetime), { pctB, trend, band, aboveCenter: daily[i].close > b.bbMiddle });
}

// --- run v4 + classic per backtest day, attach regime ---
const v4fn = (A, p, c) => eng.v4Signal(A, p, { ...c, cfg: eng.CFG });
const rows = [];
for (const d of eng.loadDays(dir)) {
  const key = ymd(d.bars[0].dt);
  const cx = ctx.get(key); if (!cx) continue;
  const v4 = eng.runDay(d.bars, v4fn), classic = eng.runDay(d.bars, eng.classicSignal);
  rows.push({ key, ...cx, floor: v4.floor, term: v4.terminal, win: v4.terminal > classic.terminal });
}

const usd = n => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');
function report(title, keyFn, order) {
  const groups = new Map();
  for (const r of rows) { const k = keyFn(r); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  console.log(`\n${title}`);
  console.log('  ' + 'regime'.padEnd(16) + 'days'.padEnd(7) + 'avg floor'.padEnd(13) + 'avg terminal'.padEnd(14) + 'wins vs classic');
  for (const k of order.filter(k => groups.has(k))) {
    const g = groups.get(k), n = g.length;
    const af = g.reduce((a, b) => a + b.floor, 0) / n, at = g.reduce((a, b) => a + b.term, 0) / n, w = g.filter(r => r.win).length;
    console.log('  ' + k.padEnd(16) + String(n).padEnd(7) + usd(af).padEnd(13) + usd(at).padEnd(14) + `${w}/${n}`);
  }
}

console.log(`Q4 REGIME ANALYSIS — ${rows.length} NDX days classified by DAILY context (per-day avg floor/terminal, QTY=1)`);
report('BY DAILY TREND (20DMA 5-day slope):', r => r.trend, ['up', 'choppy', 'down']);
report('BY POSITION IN DAILY BOLLINGER BAND (close %B):', r => r.band, ['lower-band', 'below-center', 'at-center', 'above-center', 'upper-band']);
report('BY CENTERLINE SIDE:', r => (r.aboveCenter ? 'above-centerline' : 'below-centerline'), ['above-centerline', 'below-centerline']);
