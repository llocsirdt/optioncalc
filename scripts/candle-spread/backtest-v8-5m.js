#!/usr/bin/env node
'use strict';
/**
 * v8 = v6 signal on the 5m engine + TWO risk caps + PROACTIVE DEEP-ITM COVER (runDay5m opts).
 *   • softCap ("churn cap") on AT-RISK debit (uncovered & not-deep-ITM), with exemptTrendStack:
 *     pure same-direction stacking (riding a trend) is EXEMPT — only chop/mixed books hit the soft cap.
 *   • hardCap: absolute ceiling on TOTAL uncovered debit — the black-swan backstop; the worst DAY ≈ hardCap.
 *   • proactiveCoverFrac: rest a cover on any leader whose opening spread marks >= frac×WIDTH (deep ITM),
 *     locking it (and dropping it from the caps). Fixes v7's flaw (the cap blocked trend-stacking).
 *
 * Sweeps the hard cap so you can see the worst-day/terminal dial. Usage:
 *   node scripts/candle-spread/backtest-v8-5m.js --dataDir <5m dir> [--soft 3000] [--deep 0.70] [--noExempt]
 */
const { runDay5m, load5mDays } = require('./backtest-v6-5m');
const { v6Signal } = require('./v6-signals');

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const di = process.argv.indexOf('--dataDir');
const DIR = di >= 0 ? process.argv[di + 1] : undefined;
const soft = arg('--soft', 3000), deep = arg('--deep', 0.70);
const exempt = !process.argv.includes('--noExempt');
const days = load5mDays(DIR);
const v6 = (A, p, ctx) => v6Signal(A, p, { ...ctx, cfg: { fiveMin: true } });
const usd = n => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');

function run(opts) {
  let t = 0, cum = 0, pk = 0, dd = 0, w = 1e9, o = 0, c = 0;
  for (const d of days) { const r = runDay5m(d.bars, v6, opts); t += r.terminal; cum += r.terminal; pk = Math.max(pk, cum); dd = Math.max(dd, pk - cum); w = Math.min(w, r.terminal); o += r.opens; c += r.filled; }
  return { t, dd, w, o: o / days.length, c: c / days.length };
}

console.log(`v8 — ${days.length} days, 5m engine, v6 signal. soft=$${soft}, deep=${deep}, exemptTrendStack=${exempt}\n`);
console.log('hard cap    terminal    maxDD      worst day   opens/d  covers/d  ret/maxDD');
console.log('-'.repeat(76));
console.log(('v7 (soft only)').padEnd(12) + (() => { const r = run({ riskCap: soft }); return usd(r.t).padEnd(12) + usd(r.dd).padEnd(11) + usd(r.w).padEnd(12) + r.o.toFixed(1).padEnd(9) + r.c.toFixed(1).padEnd(10) + (r.t / r.dd).toFixed(1); })());
for (const hard of [soft * 2, soft * 3, soft * 4]) {
  const r = run({ softCap: soft, hardCap: hard, proactiveCoverFrac: deep, exemptTrendStack: exempt });
  console.log(usd(hard).padEnd(12) + usd(r.t).padEnd(12) + usd(r.dd).padEnd(11) + usd(r.w).padEnd(12) + r.o.toFixed(1).padEnd(9) + r.c.toFixed(1).padEnd(10) + (r.t / r.dd).toFixed(1));
}
console.log('-'.repeat(76));
console.log('worst DAY ≈ the hard cap (the black-swan backstop). soft cap limits chop; trend-stacks are exempt.');
