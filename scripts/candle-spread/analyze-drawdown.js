#!/usr/bin/env node
'use strict';
/**
 * Best/worst days + drawdown profile for v4 (defaults, QTY=1). Reports the top/bottom days by
 * terminal P/L, the daily distribution, and the equity-curve max drawdown + losing streak — to
 * characterize normal vs possible drawdowns alongside the average/max-potential.
 *
 * Note the asymmetry: covered (tented) positions contribute >=0 to a day's terminal, so a losing day
 * is driven entirely by the still-NAKED positions giving back up to their debit. The floor is the
 * guaranteed-locked component and is never negative. Usage: node analyze-drawdown.js [--dataDir D]
 */
const eng = require('./backtest-v4');
const di = process.argv.indexOf('--dataDir');
const dir = di >= 0 ? process.argv[di + 1] : eng.DATA_DIR;
const v4fn = (A, p, c) => eng.v4Signal(A, p, { ...c, cfg: eng.CFG });

const days = eng.loadDays(dir).map(d => {
  const r = eng.runDay(d.bars, v4fn);
  return { date: eng.etDay(d.bars[0].dt), floor: r.floor, term: r.terminal, o: r.opens, f: r.filled, n: r.naked };
});
const usd = n => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');
const terms = days.map(d => d.term);
const sorted = [...days].sort((a, b) => b.term - a.term);
const sum = terms.reduce((a, b) => a + b, 0), avg = sum / days.length;
const sd = Math.sqrt(terms.reduce((a, b) => a + (b - avg) ** 2, 0) / days.length);
const med = [...terms].sort((a, b) => a - b)[Math.floor(days.length / 2)];
const neg = terms.filter(t => t < 0).length;

const line = d => `  ${d.date.padEnd(11)} term ${usd(d.term).padStart(9)}   floor ${usd(d.floor).padStart(8)}   (${d.o}o/${d.f}c/${d.n}n)`;
console.log(`BEST / WORST DAYS + DRAWDOWN — ${days.length} NDX days (v4 defaults, QTY=1, WIDTH=${eng.WIDTH})\n`);
console.log('TOP 10 DAYS (by terminal):'); sorted.slice(0, 10).forEach(d => console.log(line(d)));
console.log('\nWORST 10 DAYS (by terminal):'); sorted.slice(-10).reverse().forEach(d => console.log(line(d)));

console.log(`\nDAILY TERMINAL DISTRIBUTION:`);
console.log(`  mean ${usd(avg)} · median ${usd(med)} · stdev ${usd(sd)}`);
console.log(`  best ${usd(sorted[0].term)} · worst ${usd(sorted[sorted.length - 1].term)} · negative days ${neg}/${days.length} (${Math.round(neg / days.length * 100)}%)`);
console.log(`  floor (guaranteed-locked) never negative: min day floor ${usd(Math.min(...days.map(d => d.floor)))}, avg ${usd(days.reduce((a, b) => a + b.floor, 0) / days.length)}`);

// equity curve (chronological) → max peak-to-trough drawdown + worst losing streak
let cum = 0, peak = 0, maxDD = 0, streak = 0, worstStreak = 0, streakLoss = 0, worstStreakLoss = 0;
for (const d of days) {
  cum += d.term; peak = Math.max(peak, cum); maxDD = Math.max(maxDD, peak - cum);
  if (d.term < 0) { streak++; streakLoss += d.term; worstStreak = Math.max(worstStreak, streak); worstStreakLoss = Math.min(worstStreakLoss, streakLoss); }
  else { streak = 0; streakLoss = 0; }
}
console.log(`\nEQUITY CURVE (cumulative terminal, chronological):`);
console.log(`  final ${usd(cum)} · max peak-to-trough drawdown ${usd(maxDD)} · longest losing streak ${worstStreak} days (${usd(worstStreakLoss)})`);
console.log(`\nREADING IT: a bad day = naked positions giving back their debit; the tented (floor) piece can't lose.`);
console.log(`Max drawdown ${usd(maxDD)} at QTY=1 is the realistic buffer to ride out a rough stretch; scale by your size.`);
