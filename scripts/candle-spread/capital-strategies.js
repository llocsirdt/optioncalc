#!/usr/bin/env node
'use strict';
/**
 * Does a $CEILING account support each strategy? Runs each with the HARD GOVERNOR:
 *   - hardCap = ceiling  → throttle: skip an open if uncovered at-risk would exceed the ceiling.
 *   - capitalCeiling     → cash governor: default debit, credit-on-demand so cash stays <= ceiling.
 * Reports vs the ungoverned baseline: P&L retained, avg skipped opens/day, worst peak uncovered
 * (at-risk) and governed cash, and how many days hit the ceiling. P&L only changes via throttling
 * (the cash governor is P&L-neutral). Default ceiling $30k.
 *
 * Usage: node scripts/candle-spread/capital-strategies.js [--ceiling 30000]
 */
const { runDay5m, load5mDays } = require('./backtest-v6-5m');
const { v6Signal } = require('./v6-signals');
const { v7Signal } = require('./v7-signals');
const { makeGeo } = require('./backtest-width');

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const CEIL = Number(arg('--ceiling', '30000'));
const DIR = arg('--dataDir', 'tests/backtest/backtest-data-5m-nq');
const days = load5mDays(DIR);
const usd = n => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');
const v6 = (A, p, c) => v6Signal(A, p, { ...c, cfg: { fiveMin: true } });
const v7bw = (A, p, c) => v7Signal(A, p, { ...c, cfg: { fiveMin: true, beWrong: true } });

// [label, signalFn, base opts (non-capital)]
const strategies = [
  ['v6 $20-ATM', v6, {}],
  ['v6 $10-ATM', v6, { geo: makeGeo({ width: 10, incr: 5, shift: 0 }) }],
  ['v6 $40+20', v6, { geo: makeGeo({ width: 40, shift: 20 }) }],
  ['v9 $20-ATM', v7bw, { bidirectional: true, proactiveCoverFrac: 0.80 }],   // v7 be-wrong + proactive cover
];

console.log(`\nDOES A ${usd(CEIL)} ACCOUNT SUPPORT EACH STRATEGY? — ${days.length} NQ days, QTY=1. Governor = hardCap ${usd(CEIL)} (throttle) + cash-ceiling.\n`);
console.log('strategy'.padEnd(14) + 'base P&L'.padEnd(13) + 'gov P&L'.padEnd(13) + 'retained'.padEnd(10) + 'skips/day'.padEnd(11) + 'worst uncov'.padEnd(13) + 'worst cash'.padEnd(12) + 'days capped');
console.log('-'.repeat(96));
for (const [label, fn, base] of strategies) {
  let baseT = 0, govT = 0, skips = 0, worstUncov = 0, worstCash = 0, capped = 0;
  for (const d of days) {
    baseT += runDay5m(d.bars, fn, { rthActionOnly: true, ...base }).terminal;
    const g = runDay5m(d.bars, fn, { rthActionOnly: true, trackCapital: true, capitalCeiling: CEIL, hardCap: CEIL, ...base });
    govT += g.terminal; skips += g.capBlocked;
    worstUncov = Math.max(worstUncov, g.capital.peakUncov);
    worstCash = Math.max(worstCash, g.capital.peakGoverned);
    if (g.capBlocked > 0) capped++;
  }
  const retained = baseT !== 0 ? (100 * govT / baseT).toFixed(0) + '%' : '—';
  console.log(label.padEnd(14) + usd(baseT).padEnd(13) + usd(govT).padEnd(13) + retained.padEnd(10)
    + (skips / days.length).toFixed(1).padEnd(11) + usd(worstUncov).padEnd(13) + usd(worstCash).padEnd(12) + `${capped}/${days.length}`);
}
console.log(`\n(retained <100% = P&L given up to throttling under the ${usd(CEIL)} cap; skips = opens refused; worst uncov/cash should stay <= ${usd(CEIL)}.)`);
