#!/usr/bin/env node
'use strict';
/**
 * Q2 — how many trades/positions per day and how much CAPITAL the v4 strategy ties up, to size an
 * account. Runs v4 (current defaults) over a dataset and reports per-day opens / covers / orders /
 * contracts / debit-capital deployed, with averages, the worst (max-capital) day, and a distribution.
 *
 * Capital here = total debit paid that day (opens + debit covers) × 100. Since positions are held to
 * settle (nothing closes intraday), that sum IS the day's peak buying-power usage. All at QTY=1 —
 * multiply by your contract size. Usage: node scripts/candle-spread/analyze-capital.js [--dataDir D]
 */
const eng = require('./backtest-v4');

const di = process.argv.indexOf('--dataDir');
const dir = di >= 0 ? process.argv[di + 1] : eng.DATA_DIR;
const v4fn = (A, p, ctx) => eng.v4Signal(A, p, { ...ctx, cfg: eng.CFG });

const days = eng.loadDays(dir).map(d => ({ date: d.date, r: eng.runDay(d.bars, v4fn) }));
const usd = n => '$' + Math.round(n).toLocaleString('en-US');
const stat = (arr) => { const s = [...arr].sort((a, b) => a - b); const q = f => s[Math.min(s.length - 1, Math.floor(f * s.length))]; return { min: s[0], med: q(0.5), p90: q(0.9), max: s[s.length - 1], avg: s.reduce((a, b) => a + b, 0) / s.length }; };

const opens = days.map(d => d.r.opens), covers = days.map(d => d.r.filled), orders = days.map(d => d.r.orders);
const contracts = days.map(d => d.r.contracts), capital = days.map(d => d.r.capital);
const worst = days.reduce((a, b) => (b.r.capital > a.r.capital ? b : a));
const busiest = days.reduce((a, b) => (b.r.orders > a.r.orders ? b : a));

console.log(`v4 CAPITAL / TRADE-COUNT ANALYSIS — ${days.length} NDX days (defaults, QTY=1, WIDTH=${eng.WIDTH})\n`);
const row = (label, s, fmt = (x) => x.toFixed(1)) =>
  console.log(label.padEnd(24) + `avg ${fmt(s.avg)}`.padEnd(16) + `median ${fmt(s.med)}`.padEnd(16) + `p90 ${fmt(s.p90)}`.padEnd(15) + `max ${fmt(s.max)}`);
row('opens / day', stat(opens));
row('covers filled / day', stat(covers));
row('orders (tickets) / day', stat(orders));
row('option contracts / day', stat(contracts));
row('DEBIT CAPITAL / day', stat(capital), usd);
console.log();
console.log(`worst capital day:   ${worst.date} — ${usd(worst.r.capital)}  (${worst.r.opens} opens, ${worst.r.filled} covers)`);
console.log(`busiest order day:   ${busiest.date} — ${busiest.r.orders} tickets (${busiest.r.contracts} contracts)`);
console.log(`total debit paid over ${days.length} days: ${usd(capital.reduce((a, b) => a + b, 0))}  (opens ${usd(days.reduce((a, b) => a + b.r.openCap, 0))} + covers ${usd(days.reduce((a, b) => a + b.r.coverCap, 0))})`);
console.log(`\nFUNDING NOTE: capital = same-day debit outlay (defined-risk verticals: max loss = debit paid).`);
console.log(`A float covering the worst day + buffer at your QTY sizes the account; credit covers (Q3) cut the cover portion.`);
