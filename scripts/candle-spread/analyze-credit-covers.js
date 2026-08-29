#!/usr/bin/env node
'use strict';
/**
 * Q3 — cover with same-strike opposite-side CREDIT spreads instead of offsetting DEBIT spreads, to
 * free capital. Because an iron-fly (long call spread + long put spread on the shared short strike)
 * is SYNTHETICALLY IDENTICAL to a long butterfly (long call spread + short call spread above), the
 * P/L (floor + terminal) is UNCHANGED — the only thing that changes is capital deployed. This script
 * quantifies that: for each covered position it computes capital under
 *   • debit cover  : capital = openDebit + coverDebit            (cash for both verticals)
 *   • credit cover : capital = max(0, openDebit − creditRecv),   creditRecv = WIDTH − coverDebit
 *                    (you receive ~the box value back → the position becomes ~self-funding)
 * and reports totals under all-debit vs "credit for covers filled ≥ N pts ITM" (the user's rule:
 * debit near the money for fill quality, credit on the deep-ITM ones to recycle capital).
 *
 * Usage: node scripts/candle-spread/analyze-credit-covers.js [--dataDir D]
 */
const eng = require('./backtest-v4');
const W = eng.WIDTH, MULT = 100 * eng.QTY;

const di = process.argv.indexOf('--dataDir');
const dir = di >= 0 ? process.argv[di + 1] : eng.DATA_DIR;
const v4fn = (A, p, ctx) => eng.v4Signal(A, p, { ...ctx, cfg: eng.CFG });
const days = eng.loadDays(dir).map(d => eng.runDay(d.bars, v4fn));
const usd = n => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');

// Capital for a day's ledger under a credit-ITM threshold (Infinity = all-debit; 0 = all-credit).
function dayCapital(ledger, itmThresh) {
  let cap = 0, creditCovers = 0, freed = 0;
  for (const p of ledger) {
    const openCash = p.openLimit * MULT;
    if (!p.covered) { cap += openCash; continue; }          // naked: just the open debit
    const debitCap = openCash + p.coverLimit * MULT;
    const useCredit = p.coverITM != null && p.coverITM >= itmThresh;
    if (useCredit) {
      const creditRecv = (W - p.coverLimit) * MULT;         // box parity: credit ≈ WIDTH − debit-cover cost
      const creditCap = Math.max(0, openCash - creditRecv);
      cap += creditCap; creditCovers++; freed += (debitCap - creditCap);
    } else cap += debitCap;
  }
  return { cap, creditCovers, freed };
}

const scenarios = [
  ['all debit (current)', Infinity],
  ['credit if ≥30pt ITM', 30],
  ['credit if ≥20pt ITM', 20],
  ['credit if ≥10pt ITM', 10],
  ['credit ALL covers', 0],
];

const totalCovers = days.reduce((a, d) => a + d.filled, 0);
console.log(`Q3 CREDIT-COVER CAPITAL ANALYSIS — ${days.length} NDX days (QTY=${eng.QTY}, WIDTH=${W}; P/L unchanged — iron-fly ≡ butterfly)\n`);
console.log('scenario'.padEnd(24) + 'avg cap/day'.padEnd(14) + 'max cap/day'.padEnd(14) + 'total capital'.padEnd(16) + 'credit-covered   capital freed');
console.log('-'.repeat(96));
for (const [label, thr] of scenarios) {
  const per = days.map(d => dayCapital(d.ledger, thr));
  const caps = per.map(p => p.cap);
  const avg = caps.reduce((a, b) => a + b, 0) / caps.length, max = Math.max(...caps), tot = caps.reduce((a, b) => a + b, 0);
  const cc = per.reduce((a, b) => a + b.creditCovers, 0), fr = per.reduce((a, b) => a + b.freed, 0);
  console.log(label.padEnd(24) + usd(avg).padEnd(14) + usd(max).padEnd(14) + usd(tot).padEnd(16) +
    `${cc}/${totalCovers}`.padEnd(17) + usd(fr));
}
console.log('-'.repeat(96));
console.log(`\nopens-only floor (must be funded before covers/credits arrive): avg ${usd(days.reduce((a, d) => a + d.openCap, 0) / days.length)}/day, max ${usd(Math.max(...days.map(d => d.openCap)))}`);
console.log(`ASSUMPTION: broker recognizes the butterfly (margin = net debit). If legs are margined separately, a`);
console.log(`credit spread holds (WIDTH−credit) until the fly is recognized. P/L is identical to the debit cover either way.`);
