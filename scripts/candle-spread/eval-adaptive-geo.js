#!/usr/bin/env node
'use strict';
/**
 * eval-adaptive-geo.js — VARIABLE strike placement vs the fixed short-ATM geometry.
 *
 * The fixed geometry always puts the short leg at the same offset from spot. The user's actual discretion
 * is different: early in the session, when a $20 spread is cheap, put the short leg AT or INSIDE the money
 * (a higher-probability structure); as the day burns and everything gets cheap in absolute terms, walk it
 * back out toward straddle. The binding constraint in both cases is price — "I'm almost never going to buy
 * a long debit spread for more than 65% of the spread width."
 *
 * makeAdaptiveGeo encodes exactly that: pick the MOST ITM placement (up to maxItmStrikes) whose real mark
 * is <= maxDebitFrac x width, floored at straddle, and DECLINE the open if even the straddle is too rich.
 * That declining is the point — it is a price discipline, not a placement rule, so it also skips opens the
 * fixed geometry would have taken at a bad price. `declined` counts those; `floor>=0` counts days whose
 * worst terminal outcome was non-negative.
 *
 * maxDebitFrac is swept around 0.65 because that threshold is a stated rule of thumb rather than a
 * measured optimum, and it is worth knowing how sensitive the result is to it.
 *
 * Usage: node scripts/candle-spread/eval-adaptive-geo.js [v6-20,v6-40,...]   env NDAYS=200
 */
const path = require('path');
const { runDay5m, load5mDays } = require('./backtest-v6-5m');
const { buildRuns } = require('../../server/src/candle-spread/index');
const { makeGeo, makeAdaptiveGeo } = require('./backtest-width');

const ROOT = path.join(__dirname, '..', '..');
const days = load5mDays(path.join(ROOT, 'tests', 'backtest', 'backtest-data-5m-nq'));
const etMin = ms => { const d = new Date(new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York' })); return d.getHours() * 60 + d.getMinutes(); };
const D = days.filter(d => d.bars.some(b => { const m = etMin(b.dt); return m >= 570 && m < 960; })).slice(0, Number(process.env.NDAYS || 200));

const usd = n => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');
// rolling 30-day max drawdown of the cumulative curve
const dd = a => { const c = [0]; a.forEach((x, i) => c.push(c[i] + x)); let m = 0; for (let b = 1; b < c.length; b++) { let pk = -Infinity; for (let q = Math.max(0, b - 30); q < b; q++) if (c[q] > pk) pk = c[q]; if (pk - c[b] > m) m = pk - c[b]; } return -m; };

console.log(`adaptive strike placement vs fixed — ${D.length} days, shipped config\n`);
console.log('variant  geometry           total    maxDD30   worst   ret/DD  opens  declined  floor>=0');
for (const name of (process.argv[2] || 'v6-20,v6-40,v4-20,v9-20').split(',')) {
  const v = buildRuns().find(r => r.variant === name);
  if (!v) { console.log(`${name}: not a current variant`); continue; }
  const W = v.spreadWidth;
  const fn = (A, p, ctx) => v.signalFn(A, p, { ...ctx, cfg: v.signalCfg || {} });
  const mk = geo => {
    const o = { rthActionOnly: true, intradayIV: true, ivSkew: true, coverToStack: true, coverToStackVsRisk: true,
      coverToStackMinFrac: 0.65, recaptureAlternate: true, openAlternateEvery: 3, creditCoverFrac: 0.65,
      enforceLegUniqueness: true, legMaxShift: 6, legMaxWing: 8, geo, lossTarget: v.lossTarget, lossMax: v.lossMax,
      floorOffset: true, continuousCover: true, continuousCoverMinLockFrac: v.continuousCoverMinLockFrac, lockCoverMode: 'rest' };
    if (v.bidirectional) o.bidirectional = true;
    if (v.exemptTrendStack) o.exemptTrendStack = true;
    if (v.proactiveCoverFrac != null) o.proactiveCoverFrac = v.proactiveCoverFrac;
    return o;
  };
  const cfgs = [
    ['fixed short-ATM', makeGeo({ width: W, shift: W / 2, capFrac: 0.8 })],
    ['adaptive 0.65', makeAdaptiveGeo({ width: W, incr: 10, maxDebitFrac: 0.65, maxItmStrikes: 3 })],
    ['adaptive 0.60', makeAdaptiveGeo({ width: W, incr: 10, maxDebitFrac: 0.60, maxItmStrikes: 3 })],
    ['adaptive 0.70', makeAdaptiveGeo({ width: W, incr: 10, maxDebitFrac: 0.70, maxItmStrikes: 3 })],
  ];
  let base = null;
  for (const [lbl, geo] of cfgs) {
    const res = D.map(d => runDay5m(d.bars, fn, mk(geo)));
    const dl = res.map(r => r.terminal), tot = dl.reduce((a, b) => a + b, 0), m = dd(dl);
    if (base === null) base = tot;
    console.log(name.padEnd(9) + lbl.padEnd(19) + usd(tot).padStart(10) + usd(m).padStart(10) + usd(Math.min(...dl)).padStart(9)
      + (m ? (tot / Math.abs(m)).toFixed(1) : '—').padStart(8) + String(res.reduce((s, r) => s + r.opens, 0)).padStart(7)
      + String(res.reduce((s, r) => s + (r.geoSkip || 0), 0)).padStart(10)
      + (res.filter(r => r.worstCase >= 0).length + '/' + D.length).padStart(10)
      + (lbl === 'fixed short-ATM' ? '' : '   ' + (tot - base >= 0 ? '+' : '') + usd(tot - base)));
  }
  console.log('');
}
