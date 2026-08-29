#!/usr/bin/env node
'use strict';
/**
 * v7 exploration — the two discretionary risk rules on top of v6 (5m engine):
 *   "be patient"  = a daily RISK CAP (pause opening new positions once uncovered debit hits the cap;
 *                   covers free risk and re-enable opens). opts.riskCap.
 *   "be wrong"    = BIDIRECTIONAL opens (trade the opposite side while holding an uncovered position
 *                   the other way, on strong opposite signals). opts.bidirectional + a v7 signal.
 *
 * This runner sweeps the risk cap on v6's signal and reports the drawdown profile, so we can see the
 * cap's effect on the big losing days AND whether it clips otherwise-profitable days.
 *
 * Usage: node scripts/candle-spread/backtest-v7-5m.js --dataDir <5m dir> [--bidir]
 */
const { runDay5m, load5mDays } = require('./backtest-v6-5m');
const { v6Signal } = require('./v6-signals');
const { v7Signal } = (() => { try { return require('./v7-signals'); } catch (e) { return {}; } })();

const di = process.argv.indexOf('--dataDir');
const DIR = di >= 0 ? process.argv[di + 1] : undefined;
const bidir = process.argv.includes('--bidir');
const usd = n => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');
const days = load5mDays(DIR);

const sigFn = (bidir && v7Signal)
  ? (A, p, ctx) => v7Signal(A, p, { ...ctx, cfg: { fiveMin: true, beWrong: true } })   // v7 "be wrong" opposite opens
  : (A, p, ctx) => v6Signal(A, p, { ...ctx, cfg: { fiveMin: true } });

function summarize(riskCap) {
  let floor = 0, terminal = 0, cum = 0, peak = 0, mdd = 0, worst = Infinity, neg = 0, day814 = null;
  for (const d of days) {
    const r = runDay5m(d.bars, sigFn, { riskCap, bidirectional: bidir });
    floor += r.floor; terminal += r.terminal; cum += r.terminal; peak = Math.max(peak, cum);
    mdd = Math.max(mdd, peak - cum); worst = Math.min(worst, r.terminal); if (r.terminal < 0) neg++;
    if (d.date === '8/14/2026') day814 = r.terminal;
  }
  return { floor, terminal, mdd, worst, neg, day814 };
}

console.log(`v7 RISK-CAP SWEEP on v6 signal — ${days.length} NDX days, 5m engine${bidir ? ', BIDIRECTIONAL' : ''} (QTY=1)\n`);
console.log('riskCap'.padEnd(11) + 'floor'.padEnd(12) + 'terminal'.padEnd(12) + 'maxDD'.padEnd(11) + 'worst day'.padEnd(12) + 'neg'.padEnd(8) + '8/14');
console.log('-'.repeat(78));
for (const cap of [Infinity, 5000, 4000, 3600, 3000, 2500, 2000]) {
  const s = summarize(cap);
  console.log((cap === Infinity ? 'none' : usd(cap)).padEnd(11) + usd(s.floor).padEnd(12) + usd(s.terminal).padEnd(12) +
    usd(s.mdd).padEnd(11) + usd(s.worst).padEnd(12) + `${s.neg}/${days.length}`.padEnd(8) + (s.day814 == null ? '-' : usd(s.day814)));
}
console.log('-'.repeat(78));
console.log('cap = max uncovered debit before pausing opens. 8/14 = the worst chop day (out-of-sample).');
