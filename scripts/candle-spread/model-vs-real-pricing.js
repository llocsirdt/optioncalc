#!/usr/bin/env node
'use strict';
/**
 * model-vs-real-pricing.js — is the engine's modelled spread price calibrated to the real chain?
 *
 * The whole adaptive-placement result rests on the model's view of what a spread costs at each ITM depth:
 * the engine takes the most ITM placement still under capFrac, so if the model prices ITM spreads cheaper
 * than the market does, it reaches for depth it could never actually buy and the backtest overstates the
 * gain. This checks that directly against the numbers parity-read.js measures on real captured chains.
 *
 * Run parity-read.js first; REAL below is its output. Uses the DUAL dataset (NQ signals, real NDX prices)
 * and the engine's own ivMultAt/skewMultAt, so the modelled side is the surface the backtest trades on.
 *
 * Usage: node scripts/candle-spread/model-vs-real-pricing.js
 */
// 71.5% of width. If the engine's model prices it materially cheaper, adaptive placement is reaching for
// depth it could not actually buy — and today's +90% headline is partly a modelling artifact.
const path = require('path');
const { runDay5m, load5mDays, ivMultAt, skewMultAt, etMinute } = require('./backtest-v6-5m');
const eng = require('./backtest-v4');
const bs = eng.bs, legsMark = eng.legsMark;
const W = 20, INCR = 10, MAX_ITM = 3;
const days = load5mDays('../../tests/backtest/backtest-data-5m-nq-ndx');   // NQ signals + REAL NDX prices
const ivOf = (A) => bs.ivFromRelBandWidth((A['15m'].bbupper - A['15m'].bblower) / A['15m'].close);
function volFor(bar, S, tau) {
  const base = ivOf(bar.analysis) * ivMultAt(etMinute(bar.dt));
  const band = S * base * Math.sqrt(tau);
  return band > 0 ? ((type, K) => base * skewMultAt((K - S) / band)) : base;
}
const byDepth = new Map();
for (const d of days) {
  for (const bar of d.bars) {
    const px = bar.px; if (!px || !(px.close > 0)) continue;
    const tau = bs.tauFromTime(bar.dt); if (!(tau > 0)) continue;
    const S = px.close, iv = volFor(bar, S, tau);
    const center = Math.floor(S / INCR) * INCR;
    for (let k = -MAX_ITM; k <= Math.floor((W / 2) / INCR); k++) {
      const short = center + k * INCR, lo = short - W;
      const legs = [{ side: 'long', type: 'C', strike: lo }, { side: 'short', type: 'C', strike: short }];
      const m = legsMark(legs, S, tau, iv);
      if (!(m > 0)) continue;
      const depth = -k;
      if (!byDepth.has(depth)) byDepth.set(depth, []);
      byDepth.get(depth).push(m / W);
    }
  }
}
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const REAL = { 3: 0.715, 2: 0.680, 1: 0.625, 0: 0.592, '-1': 0.552 };   // from parity-read.js on real chains
console.log('\nMODEL vs REAL cost by placement depth ($20 width)\n');
console.log('itm'.padEnd(6) + 'n'.padStart(9) + 'model'.padStart(9) + 'real'.padStart(9) + 'model−real'.padStart(12) + '  model under 0.60');
for (const depth of [...byDepth.keys()].sort((a, b) => b - a)) {
  const a = byDepth.get(depth), m = med(a), r = REAL[String(depth)];
  const u60 = a.filter((x) => x <= 0.60).length / a.length;
  console.log(String(depth).padEnd(6) + a.length.toLocaleString().padStart(9)
    + (m * 100).toFixed(1).padStart(8) + '%' + (r != null ? (r * 100).toFixed(1).padStart(8) + '%' : '—'.padStart(9))
    + (r != null ? (((m - r) * 100 >= 0 ? '+' : '') + ((m - r) * 100).toFixed(1) + ' pts').padStart(12) : ''.padStart(12))
    + ((u60 * 100).toFixed(0) + '%').padStart(18));
}
