#!/usr/bin/env node
'use strict';
/**
 * How much CAPITAL does a strategy need? Runs the strategy per day with the engine's capital tracker
 * (cash deployed intraday; does NOT affect P&L) and reports the per-day PEAK deployment — i.e. the
 * account size needed — for the average day, the median, the busy day (P95), and the worst day. Two
 * cover rules side by side: all-DEBIT vs CREDIT-cover-on-ITM (reclaims cash on ITM winners; 0DTE
 * P&L-identical, NDX cash-settled so safe). Default: v6 at $20-ATM.
 *
 * Usage: node scripts/candle-spread/capital-analysis.js [--dataDir D] [--creditFrac 0.65]
 */
const { runDay5m, load5mDays } = require('./backtest-v6-5m');
const { v6Signal } = require('./v6-signals');

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const DIR = arg('--dataDir', 'tests/backtest/backtest-data-5m-nq');
const creditFrac = Number(arg('--creditFrac', '0.65'));
const days = load5mDays(DIR);
const v6 = (A, p, c) => v6Signal(A, p, { ...c, cfg: { fiveMin: true } });
const usd = n => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');
const ymd = ms => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

const rows = days.map(d => {
  const r = runDay5m(d.bars, v6, { rthActionOnly: true, trackCapital: true, creditCoverFrac: creditFrac });
  return { date: ymd(d.bars[0].dt), opens: r.opens, filled: r.filled, ...r.capital };
});
const pctile = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const stat = key => ({
  avg: rows.reduce((a, r) => a + r[key], 0) / rows.length,
  p50: pctile(rows.map(r => r[key]), 0.50),
  p95: pctile(rows.map(r => r[key]), 0.95),
  max: Math.max(...rows.map(r => r[key])),
  maxDate: rows.reduce((a, r) => r[key] > a[key] ? r : a).date
});

const sD = stat('peakDebit'), sC = stat('peakCredit');
console.log(`\nCAPITAL NEED — v6 @ $20-ATM, ${days.length} NQ days (24h→RTH), QTY=1. PEAK cash deployed intraday = account size needed.\n`);
console.log('rule'.padEnd(22) + 'avg day'.padEnd(12) + 'median'.padEnd(12) + 'busy (P95)'.padEnd(13) + 'worst day'.padEnd(13) + 'worst date');
console.log('-'.repeat(84));
console.log('all-DEBIT covers'.padEnd(22) + usd(sD.avg).padEnd(12) + usd(sD.p50).padEnd(12) + usd(sD.p95).padEnd(13) + usd(sD.max).padEnd(13) + sD.maxDate);
console.log(`credit-cover ITM≥${creditFrac}w`.padEnd(22) + usd(sC.avg).padEnd(12) + usd(sC.p50).padEnd(12) + usd(sC.p95).padEnd(13) + usd(sC.max).padEnd(13) + sC.maxDate);
const avgOpens = rows.reduce((a, r) => a + r.opens, 0) / rows.length;
const avgCredit = rows.reduce((a, r) => a + r.nCredit, 0) / rows.length;
const avgDebitCov = rows.reduce((a, r) => a + r.nDebitCov, 0) / rows.length;
console.log(`\ncontext: ${avgOpens.toFixed(1)} opens/day · covers ${(avgCredit + avgDebitCov).toFixed(1)}/day (${avgCredit.toFixed(1)} credit ITM, ${avgDebitCov.toFixed(1)} debit)`);
console.log(`reduction from credit covers: worst day ${usd(sD.max)} → ${usd(sC.max)} (${Math.round(100 * (1 - sC.max / sD.max))}% less), avg ${usd(sD.avg)} → ${usd(sC.avg)}`);
