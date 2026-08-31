#!/usr/bin/env node
'use strict';
/**
 * COVER-TO-CONTINUE-STACKING vs plain SKIP, at a range of account ceilings. When a new open would
 * breach the ceiling mid-trend, cover-to-stack LOCKS the deepest-ITM winner (freeing its at-risk)
 * instead of skipping the trade. Hypothesis: at a tight ceiling (~the $5-10k/day risk tolerance),
 * cover-to-stack keeps far more P&L than skipping, because it doesn't miss the new opens.
 * Default: v6 @ $20-ATM.  Usage: node scripts/candle-spread/capital-cover-to-stack.js
 */
const { runDay5m, load5mDays } = require('./backtest-v6-5m');
const { v6Signal } = require('./v6-signals');
const days = load5mDays('tests/backtest/backtest-data-5m-nq');
const v6 = (A, p, c) => v6Signal(A, p, { ...c, cfg: { fiveMin: true } });
const usd = n => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');

function run(opts) {
  let t = 0, worst = 0, skips = 0, cts = 0, peakU = 0;
  for (const d of days) {
    const r = runDay5m(d.bars, v6, { rthActionOnly: true, trackCapital: true, ...opts });
    t += r.terminal; worst = Math.min(worst, r.terminal); skips += r.capSkipCeiling; cts += r.nCoverToStack;
    peakU = Math.max(peakU, r.capital.peakUncov);
  }
  return { t, worst, skips: skips / days.length, cts: cts / days.length, peakU };
}

const base = run({});
console.log(`\nCOVER-TO-STACK vs SKIP — v6 $20-ATM, ${days.length} NQ days, QTY=1.`);
console.log(`Uncapped baseline: ${usd(base.t)} total, worst day ${usd(base.worst)}, peak at-risk ${usd(base.peakU)}.\n`);
console.log('ceiling'.padEnd(9) + '| SKIP: total'.padEnd(15) + 'kept'.padEnd(7) + 'skip/d'.padEnd(8) + 'worst'.padEnd(11)
  + '| COVER-TO-STACK: total'.padEnd(24) + 'kept'.padEnd(7) + 'cover/d'.padEnd(9) + 'worst');
console.log('-'.repeat(104));
for (const ceil of [10000, 12000, 15000, 20000, 30000]) {
  const s = run({ capitalCeiling: ceil });
  const c = run({ capitalCeiling: ceil, coverToStack: true });
  const k = x => (100 * x.t / base.t).toFixed(0) + '%';
  console.log(usd(ceil).padEnd(9) + ('| ' + usd(s.t)).padEnd(15) + k(s).padEnd(7) + s.skips.toFixed(1).padEnd(8) + usd(s.worst).padEnd(11)
    + ('| ' + usd(c.t)).padEnd(24) + k(c).padEnd(7) + c.cts.toFixed(1).padEnd(9) + usd(c.worst));
}
console.log('\nkept = % of uncapped P&L retained. skip/d = opens refused (SKIP). cover/d = winners locked to make room (COVER-TO-STACK).');
