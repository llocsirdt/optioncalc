#!/usr/bin/env node
'use strict';
/**
 * Equity-curve context per variant: total, avg/day, MAX DRAWDOWN (peak→trough $ + date range + calendar
 * days + how long to RECOVER), and MAX RUN-UP (trough→peak $ + range + days) — so a big drawdown number
 * is judged against its timeframe (a $135k DD over 6 months recovered is very different from over a week).
 *
 * Usage: node scripts/candle-spread/report-equity.js --dataDir <5m dir>
 */
const eng = require('./backtest-v4');
const { runDay5m, load5mDays } = require('./backtest-v6-5m');
const { v5Signal } = require('./v5-signals');
const { v6Signal } = require('./v6-signals');
const { v7Signal } = require('./v7-signals');

const di = process.argv.indexOf('--dataDir');
const days = load5mDays(di >= 0 ? process.argv[di + 1] : eng.DATA_DIR);
const ymd = ms => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const dates = days.map(d => ymd(d.bars[0].dt));
const at15 = fn => (A, p, ctx) => ctx.isFifteen === false ? { openSide: null, cover: false } : fn(A, p, { ...ctx, cfg: {} });
const variants = [
  ['classic', d => runDay5m(d.bars, at15((A, p, c) => eng.classicSignal(A, p, c)), {}).terminal],
  ['v4', d => runDay5m(d.bars, at15((A, p, c) => eng.v4Signal(A, p, c)), {}).terminal],
  ['v5', d => runDay5m(d.bars, at15((A, p, c) => v5Signal(A, p, c)), {}).terminal],
  ['v6', d => runDay5m(d.bars, (A, p, c) => v6Signal(A, p, { ...c, cfg: { fiveMin: true } }), {}).terminal],
  ['v8-cap', d => runDay5m(d.bars, (A, p, c) => v6Signal(A, p, { ...c, cfg: { fiveMin: true } }), { softCap: 3000, hardCap: 9000, proactiveCoverFrac: 0.70, exemptTrendStack: true }).terminal],
  ['v7-be-wrong', d => runDay5m(d.bars, (A, p, c) => v7Signal(A, p, { ...c, cfg: { fiveMin: true, beWrong: true } }), { bidirectional: true }).terminal],
];
const usd = n => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');
const spanDays = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);

function curveStats(daily) {
  let cum = 0, peak = 0, peakDate = dates[0], mdd = 0, ddPeak = '', ddTrough = '', ddTroughLvl = 0;
  let trough = 0, troughDate = dates[0], mru = 0, ruTrough = '', ruPeak = '';
  for (let i = 0; i < daily.length; i++) {
    cum += daily[i];
    if (cum > peak) { peak = cum; peakDate = dates[i]; }
    if (peak - cum > mdd) { mdd = peak - cum; ddPeak = peakDate; ddTrough = dates[i]; ddTroughLvl = cum; }
    if (cum < trough) { trough = cum; troughDate = dates[i]; }
    if (cum - trough > mru) { mru = cum - trough; ruTrough = troughDate; ruPeak = dates[i]; }
  }
  // recovery: first date after the DD trough where cum climbs back to the pre-DD peak level
  let recDate = 'not yet', c2 = 0, ddPeakLvl = ddTroughLvl + mdd;
  for (let i = 0; i < daily.length; i++) { c2 += daily[i]; if (dates[i] > ddTrough && c2 >= ddPeakLvl) { recDate = dates[i]; break; } }
  return { total: cum, mdd, ddPeak, ddTrough, recDate, mru, ruTrough, ruPeak };
}

console.log(`EQUITY-CURVE CONTEXT — ${days.length} days (${dates[0]} .. ${dates[dates.length - 1]}), 5m engine, QTY=1\n`);
for (const [name, fn] of variants) {
  const daily = days.map(fn), s = curveStats(daily);
  console.log(name.padEnd(13) + 'total ' + usd(s.total).padEnd(12) + 'avg/day ' + usd(s.total / days.length).padEnd(9));
  console.log('   MAX DRAWDOWN  ' + usd(s.mdd).padEnd(11) + s.ddPeak + ' → ' + s.ddTrough + ' (' + spanDays(s.ddPeak, s.ddTrough) + 'd), recovered by ' + s.recDate + (s.recDate !== 'not yet' ? ' (' + spanDays(s.ddTrough, s.recDate) + 'd to recover)' : ''));
  console.log('   MAX RUN-UP    ' + usd(s.mru).padEnd(11) + s.ruTrough + ' → ' + s.ruPeak + ' (' + spanDays(s.ruTrough, s.ruPeak) + 'd)');
}
