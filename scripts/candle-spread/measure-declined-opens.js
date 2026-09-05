#!/usr/bin/env node
'use strict';
/**
 * measure-declined-opens.js — of the opens the 65%-of-width ceiling turns down, HOW MANY WOULD ACTUALLY
 * HAVE FILLED if we had rested a bid at the ceiling instead?
 *
 * WHY: the engine has only ever had two behaviours for an over-ceiling open, and BOTH are assumptions.
 *   OLD: book it instantly at the capped price          -> assumes it always fills, and immediately
 *   NEW: decline it                                     -> assumes it never happens
 * Neither was measured. A debit limit below the mid is not a dead order — it is a RESTING BID that fills
 * if the spread later cheapens to that price. Covers already model exactly this (resolveRestingCovers
 * walks each 5m bar and fills when the mark reaches target); OPENS never have.
 *
 * The 5m dataset carries the whole price path, so this is answerable rather than arguable: for every
 * declined open, reprice THAT SPREAD on every later bar of the same day and see whether its mark ever
 * reaches the ceiling. Pricing is the engine's own (same iv/tau/intradayIV/ivSkew), so a fill here means
 * a fill under exactly the assumptions the backtest already trades on.
 *
 * FILL RULE: `close` (default) fills when a bar's CLOSE mark <= limit — the conservative reading, and the
 * one that matches the live engine (resolveRestingCovers books at the candle-close mark). `--extreme`
 * fills on the intrabar low instead — optimistic, the true resting-order behaviour, and the gap between
 * the two is itself worth seeing.
 *
 * Usage: node scripts/candle-spread/measure-declined-opens.js [--variant v6-20] [--extreme] [--dataDir <d>]
 */
const path = require('path');
const { runDay5m, load5mDays, ivMultAt, skewMultAt, etMinute } = require('./backtest-v6-5m');
const { makeGeo } = require('./backtest-width');
const { buildRuns } = require('../../server/src/candle-spread/index');
const eng = require('./backtest-v4');

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const DIR = arg('--dataDir', path.join(__dirname, '..', '..', 'tests', 'backtest', 'backtest-data-5m-nq'));
const ONLY = arg('--variant', null);
const EXTREME = process.argv.includes('--extreme');

const days = load5mDays(DIR);
const HAS_PX = !!(days[0] && days[0].bars && days[0].bars[0] && days[0].bars[0].px);
const bs = eng.bs, legsMark = eng.legsMark;
const usd = (n) => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');

// The engine's own per-bar inputs, replicated exactly (backtest-v6-5m.js ~line 445): base vol from the
// 15m band width, the intraday-IV multiplier, then the moneyness skew as a per-leg vol FUNCTION.
// Reprice on the ENGINE'S OWN vol surface — its ivMultAt/skewMultAt, not a local reimplementation, so a
// fill measured here is a fill under exactly the assumptions the backtest already trades on.
const ivOf = (A) => bs.ivFromRelBandWidth((A['15m'].bbupper - A['15m'].bblower) / A['15m'].close);
function volFor(bar, S, tau, useSkew) {
  const base = ivOf(bar.analysis) * ivMultAt(etMinute(bar.dt));
  if (!useSkew) return base;
  const band = S * base * Math.sqrt(tau);
  return band > 0 ? ((type, K) => base * skewMultAt((K - S) / band)) : base;
}

const priceOf = HAS_PX
  ? (b) => b.px
  : (b) => { const c = b.analysis['5m']; return { close: c.close, high: c.high, low: c.low }; };

function optsFor(v, onDecline) {
  const o = { rthActionOnly: true, intradayIV: true, onDecline };
  if (v.ivSkew) o.ivSkew = true;
  if (v.bidirectional) o.bidirectional = true;
  for (const k of ['riskCap', 'softCap', 'hardCap', 'capitalCeiling', 'proactiveCoverFrac', 'lossTarget', 'lossMax']) if (v[k] != null) o[k] = v[k];
  if (v.floorOffset) o.floorOffset = true;
  if (v.continuousCover) o.continuousCover = true;
  if (v.continuousCoverMinLockFrac != null) o.continuousCoverMinLockFrac = v.continuousCoverMinLockFrac;
  if (v.lockCoverMode) o.lockCoverMode = v.lockCoverMode;
  if (v.exemptTrendStack) o.exemptTrendStack = true;
  if (v.coverSelector) o.coverSelector = v.coverSelector;
  if (v.capitalRecapture) { o.recaptureAlternate = true; if (v.openAlternateEvery != null) o.openAlternateEvery = v.openAlternateEvery; if (v.creditCoverFrac != null) o.creditCoverFrac = v.creditCoverFrac; }
  if (v.enforceLegUniqueness) { o.enforceLegUniqueness = true; if (v.legMaxShift != null) o.legMaxShift = v.legMaxShift; if (v.legMaxWing != null) o.legMaxWing = v.legMaxWing; }
  o.geo = makeGeo({ width: v.spreadWidth || 20, shift: v.spreadShift || 0, capFrac: v.capFrac != null ? v.capFrac : undefined });
  if (HAS_PX) o.priceOf = priceOf;
  return o;
}
const wrap = (v) => (A, p, ctx) => v.signalFn(A, p, { ...ctx, cfg: v.signalCfg || {} });

const RUNS = buildRuns().filter((v) => (ONLY ? v.variant === ONLY : /^v[0-9]-(10|20|40)$/.test(v.variant)));
console.log(`\nDECLINED OPENS — would a resting bid at the ceiling have filled?`);
console.log(`${days.length} days · ${path.basename(DIR)} · fill rule: ${EXTREME ? 'INTRABAR LOW (optimistic)' : 'BAR CLOSE (conservative, matches live)'}\n`);
console.log('variant'.padEnd(10) + 'declined'.padStart(10) + 'wouldFill'.padStart(11) + 'fill%'.padStart(8)
  + 'medWaitMin'.padStart(12) + 'medMarkAtDecline'.padStart(18) + 'medFillDiscount'.padStart(17));

for (const v of RUNS) {
  const width = v.spreadWidth || 20;
  let declined = 0, filled = 0;
  const waits = [], marks = [], discounts = [];
  for (const day of days) {
    const pending = [];
    const opts = optsFor(v, (d) => pending.push(d));
    runDay5m(day.bars, wrap(v), opts);
    for (const d of pending) {
      declined++;
      marks.push(d.markAtDecline / width);
      // Reprice THIS spread forward through the rest of the session.
      let hit = null;
      for (let j = d.i + 1; j < day.bars.length; j++) {
        const bar = day.bars[j], px = priceOf(bar);
        if (!px || !(px.close > 0)) continue;
        const tau = bs.tauFromTime(bar.dt);
        if (!(tau > 0)) break;
        const S = EXTREME ? px.low : px.close;   // low = cheapest the spread got intrabar (bull debit)
        const m = legsMark(d.legs, S, tau, volFor(bar, px.close, tau, !!v.ivSkew));
        if (m <= d.restLimit) { hit = { j, m }; break; }
      }
      if (hit) {
        filled++;
        waits.push((hit.j - d.i) * 5);
        discounts.push(d.markAtDecline - hit.m);
      }
    }
  }
  const med = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);
  console.log(v.variant.padEnd(10) + String(declined).padStart(10) + String(filled).padStart(11)
    + ((declined ? Math.round(filled / declined * 100) : 0) + '%').padStart(8)
    + String(med(waits)).padStart(12)
    + (Math.round(med(marks) * 100) + '% of W').padStart(18)
    + usd(med(discounts) * 100).padStart(17));
}
console.log('\nfill% = declined opens whose spread later reached the ceiling price in the SAME session.');
console.log('medFillDiscount = how much cheaper (per contract) it got vs the mark when we declined.');
