#!/usr/bin/env node
'use strict';
/**
 * Which strategy works best in which DAILY REGIME — using only context knowable AT/BEFORE the open
 * (so it's actionable): the PRIOR day's daily-Bollinger position + trend + direction, and where TODAY
 * OPENS relative to the prior day's band. Buckets each strategy's per-day terminal P/L by regime.
 *
 * Daily candles + BB(20,2) are built from the dataset itself (per-day RTH OHLC). Strategies run at
 * $20-ATM (the live geometry), QTY=1; NQ 24h data → rthActionOnly. Reports, per regime feature, each
 * strategy's avg P/L (and win-rate) per bucket + the winner — so we can see e.g. "prior day rode the
 * upper band → v6 leads" vs "prior day mid-band uptrend → v9 leads".
 *
 * Usage: node scripts/candle-spread/regime-lineage-analysis.js --dataDir <5m dir>
 */
const eng = require('./backtest-v4');
const { runDay5m, load5mDays } = require('./backtest-v6-5m');
const { v5Signal } = require('./v5-signals');
const { v6Signal } = require('./v6-signals');
const { v7Signal } = require('./v7-signals');
const { bollinger } = require('../signal-lab/indicators');

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const DIR = arg('--dataDir', eng.DATA_DIR);
const days = load5mDays(DIR);
const etMin = ms => { const d = new Date(new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York' })); return d.getHours() * 60 + d.getMinutes(); };
const inRth = ms => { const m = etMin(ms); return m >= 575 && m <= 955; };
const ymd = ms => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const is24h = days.length && days[0].bars.some(b => { const m = etMin(b.dt); return m < 570 || m >= 960; });
const BASE = is24h ? { rthActionOnly: true } : {};

// --- per-day RTH daily candle (open/high/low/close) from the 5m bars ---
const daily = days.map(d => {
  const rth = (is24h ? d.bars.filter(b => inRth(b.dt)) : d.bars).map(b => b.analysis['5m']).filter(Boolean);
  const src = rth.length ? rth : d.bars.map(b => b.analysis['5m']);
  return { date: ymd(d.bars[0].dt), open: src[0].open, close: src[src.length - 1].close, high: Math.max(...src.map(c => c.high)), low: Math.min(...src.map(c => c.low)) };
});
const bb = bollinger(daily, 20, 2);   // daily BB(20,2) over daily closes

const zoneOf = pctB => pctB <= 0.20 ? 'lower-band' : pctB < 0.45 ? 'below-center' : pctB <= 0.55 ? 'at-center' : pctB <= 0.80 ? 'above-center' : 'upper-band';

// --- strategies at $20-ATM (built-in geometry) ---
const at15 = fn => (A, p, ctx) => ctx.isFifteen === false ? { openSide: null, cover: false } : fn(A, p, { ...ctx, cfg: {} });
const v6fn = (A, p, c) => v6Signal(A, p, { ...c, cfg: { fiveMin: true } });
const v7fn = (A, p, c) => v7Signal(A, p, { ...c, cfg: { fiveMin: true, beWrong: true } });
const V9CAPS = { hardCap: 40000, proactiveCoverFrac: 0.80 };
const strategies = [
  ['v0', at15((A, p, c) => eng.classicSignal(A, p, c)), {}],
  ['v5', at15(v5Signal), {}],
  ['v6', v6fn, {}],
  ['v7', v7fn, { bidirectional: true }],
  ['v9', v7fn, { bidirectional: true, ...V9CAPS }],
];
const stratNames = strategies.map(s => s[0]);

// --- classify each day by PRIOR-day regime + TODAY's open; attach each strategy's terminal ---
const rows = [];
for (let i = 26; i < days.length; i++) {
  const pb = bb[i - 1]; if (!pb || pb.bbUpper == null) continue;
  const width = pb.bbUpper - pb.bbLower; if (!(width > 0)) continue;
  const prev = daily[i - 1], today = daily[i];
  const priorPctB = (prev.close - pb.bbLower) / width;
  const slope5 = bb[i - 6] ? (pb.bbMiddle - bb[i - 6].bbMiddle) / width : 0;   // 20DMA 5d slope, band-widths
  const priorTrend = slope5 > 0.10 ? 'up' : slope5 < -0.10 ? 'down' : 'choppy';
  const priorDir = prev.close >= prev.open ? 'green' : 'red';
  const openPctB = (today.open - pb.bbLower) / width;   // today's open in the PRIOR band (knowable at open)
  const gap = (today.open - prev.close) / width;
  const openGap = gap > 0.05 ? 'gap-up' : gap < -0.05 ? 'gap-down' : 'flat';
  const terms = {};
  for (const [name, fn, opts] of strategies) terms[name] = runDay5m(days[i].bars, fn, { ...BASE, ...opts }).terminal;
  rows.push({ priorTrend, priorZone: zoneOf(priorPctB), priorDir, openGap, openZone: zoneOf(openPctB), terms });
}

// --- report: per regime feature, each strategy's avg P/L per bucket + the winner ---
const usd = n => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');
// Per regime bucket, per strategy: avg P/L AND win-rate (% positive days) — the risk-relevant pair for
// scattered (non-consecutive) days, since rolling-window/streak metrics don't apply within a bucket.
// Also flags the best by avg and, separately, the most consistent (win-rate).
function report(title, keyFn, order) {
  const groups = new Map();
  for (const r of rows) { const k = keyFn(r); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  console.log(`\n${title}   [cell = avg/win% ; BEST-avg | BEST-win]`);
  console.log('  ' + 'regime'.padEnd(13) + 'days'.padEnd(6) + stratNames.map(n => n.padEnd(15)).join('') + 'BEST');
  for (const k of order.filter(k => groups.has(k))) {
    const g = groups.get(k), n = g.length;
    const cells = stratNames.map(s => ({ s, avg: g.reduce((a, r) => a + r.terms[s], 0) / n, win: Math.round(100 * g.filter(r => r.terms[s] > 0).length / n) }));
    const bestAvg = cells.reduce((a, b) => b.avg > a.avg ? b : a).s;
    const bestWin = cells.reduce((a, b) => b.win > a.win ? b : a).s;
    console.log('  ' + k.padEnd(13) + String(n).padEnd(6) + cells.map(c => `${usd(c.avg)}/${c.win}%`.padEnd(15)).join('') + `${bestAvg} | ${bestWin}`);
  }
}

console.log(`REGIME → STRATEGY (predictive: prior-day + open context) — ${rows.length} days, $20-ATM, QTY=1, avg terminal $/day`);
report('BY PRIOR-DAY TREND (20DMA 5d slope):', r => r.priorTrend, ['up', 'choppy', 'down']);
report('BY PRIOR-DAY BAND ZONE (prior close %B):', r => r.priorZone, ['lower-band', 'below-center', 'at-center', 'above-center', 'upper-band']);
report('BY PRIOR-DAY DIRECTION (green/red):', r => r.priorDir, ['green', 'red']);
report("BY TODAY'S OPEN vs PRIOR BAND:", r => r.openZone, ['lower-band', 'below-center', 'at-center', 'above-center', 'upper-band']);
report("BY TODAY'S OPENING GAP:", r => r.openGap, ['gap-up', 'flat', 'gap-down']);
