#!/usr/bin/env node
'use strict';
/**
 * sweep-wing-convert.js — the FIRST measurement of peak->floor wing conversion over the full history.
 *
 * The backlog calls this "the biggest measured opportunity", but that came from a point-in-time read of
 * the real 2026-09-04 15:30 books (floors +$1.6k..$3.3k against a $36k peak, cheap OTM wings lifting the
 * floor at ~20:1). That shows the OPPORTUNITY exists at a moment; it is not evidence the strategy pays.
 * The engine has implemented wingConvert for a while and no baseline or sweep has ever turned it on.
 *
 * What it does: late in a good day the book is a tall narrow tent — big peak near spot, much lower floor
 * in the wings. A cheap OTM debit spread on the declining side lifts that wing for a premium that costs
 * NOTHING at the peak (the wing is OTM there), converting unrealised peak into locked floor. So it RAISES
 * THE FLOOR BY SPENDING PEAK — a real give-up, not free.
 *
 * Why it matters beyond its own P&L: it is the constructive version of the shelved freeze idea. Freezing
 * banks the floor by stopping, which loses money because 69% of locking days keep the lock AND add to it.
 * Wings bank the floor WITHOUT stopping, so they target the ~31% that regress without taxing the rest.
 * The metrics below therefore report the floor/lock effect, not just totals.
 *
 * Levers: minRatio (floor lift per dollar demanded), afterMin (don't convert before this ET minute — the
 * tent has to exist first), budgetFrac (share of the CURRENT peak spendable).
 *
 * Usage: node scripts/candle-spread/sweep-wing-convert.js [--variants v7-10,v6-20]
 */
const path = require('path');
const { runDay5m, load5mDays } = require('./backtest-v6-5m');
const { makeGeo, makeAdaptiveGeo } = require('./backtest-width');
const { buildRuns } = require('../../server/src/candle-spread/index');
const VC = require('../../server/src/candle-spread/variant-contract');

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const DIR = arg('--dataDir', path.join(__dirname, '..', '..', 'tests', 'backtest', 'backtest-data-5m-nq'));
const ONLY = arg('--variants', 'v7-10,v6-20,v1-10');

const days = load5mDays(DIR);
const HAS_PX = !!(days[0] && days[0].bars && days[0].bars[0] && days[0].bars[0].px);
const usd = (n) => (n == null ? '—' : (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US'));

function optsFor(v) {
  const o = { rthActionOnly: true, intradayIV: true };
  if (v.ivSkew) o.ivSkew = true;
  if (v.bidirectional) o.bidirectional = true;
  // exemptTrendStack and capitalCeiling belong here too: v8 is the ONLY family carrying
  // exemptTrendStack, and omitting it applies its softCap WITHOUT the escape hatch, so the control
  // stopped reproducing v8's committed baseline ($880,590 vs $956,024) while every other variant
  // matched. Caught by the standing check that an analysis script must reproduce the baseline.
  for (const k of ['riskCap', 'softCap', 'hardCap', 'capitalCeiling', 'proactiveCoverFrac', 'lossTarget', 'lossMax']) if (v[k] != null) o[k] = v[k];
  if (v.exemptTrendStack) o.exemptTrendStack = true;
  if (v.floorOffset) o.floorOffset = true;
  if (v.continuousCover) o.continuousCover = true;
  if (v.continuousCoverMinLockFrac != null) o.continuousCoverMinLockFrac = v.continuousCoverMinLockFrac;
  if (v.lockCoverMode) o.lockCoverMode = v.lockCoverMode;
  if (v.coverGeometry) o.coverGeometry = v.coverGeometry;
  if (v.continuousCoverArmFrac != null) o.continuousCoverArmFrac = v.continuousCoverArmFrac;
  if (v.continuousCoverOppRatio != null) o.continuousCoverOppRatio = v.continuousCoverOppRatio;
  if (v.coverSelector) o.coverSelector = v.coverSelector;
  if (v.coverToStack) { o.coverToStack = true; o.coverToStackVsRisk = true; if (v.coverToStackMinFrac != null) o.coverToStackMinFrac = v.coverToStackMinFrac; }
  if (v.capitalRecapture) { o.recaptureAlternate = true; if (v.openAlternateEvery != null) o.openAlternateEvery = v.openAlternateEvery; if (v.creditCoverFrac != null) o.creditCoverFrac = v.creditCoverFrac; }
  if (v.openNeverOtm) o.openNeverOtm = true;
  if (v.enforceLegUniqueness) { o.enforceLegUniqueness = true; if (v.legMaxShift != null) o.legMaxShift = v.legMaxShift; if (v.legMaxWing != null) o.legMaxWing = v.legMaxWing; }
  o.geo = v.adaptiveGeo
    ? makeAdaptiveGeo({ width: v.spreadWidth || 20, incr: 10, maxDebitFrac: v.capFrac != null ? v.capFrac : 0.65, maxItmStrikes: v.maxItmStrikes != null ? v.maxItmStrikes : 3 })
    : makeGeo({ width: v.spreadWidth || 20, shift: v.spreadShift || 0, capFrac: v.capFrac != null ? v.capFrac : undefined });
  if (HAS_PX) o.priceOf = (b) => b.px || { close: b.analysis['5m'].close, high: b.analysis['5m'].high, low: b.analysis['5m'].low };
  // Guard: fail loudly if this variant carries a capability optsFor does not forward. extraOk
  // lists what this script deliberately controls itself (its swept dimension) or handles under
  // another name — everything else missing here would be a silent no-op, not a null result.
  VC.assertForwarded(v, Object.keys(o), 'sweep-wing-convert optsFor',
    ['capitalRecapture', 'openAlternateEvery', 'creditCoverFrac', 'coverToStackMinFrac', 'wingConvert', 'wingMinRatio', 'wingAfterMin', 'wingBudgetFrac', 'wingNaked', 'wingUpsideLambda', 'wingOutSteps', 'wingMaxWings', 'wingQty', 'wingStep', 'wingBandSig']);
  return o;
}
const wrap = (v) => (A, p, ctx) => v.signalFn(A, p, { ...ctx, cfg: v.signalCfg || {} });

function rollingDD(daily, W) {
  const cum = [0];
  for (let i = 0; i < daily.length; i++) cum.push(cum[i] + daily[i]);
  let worst = 0;
  for (let i = 0; i < cum.length; i++) for (let j = i + 1; j < Math.min(cum.length, i + W + 1); j++) worst = Math.min(worst, cum[j] - cum[i]);
  return Math.round(worst);
}

function measure(v, extra) {
  const opts = { ...optsFor(v), ...extra };
  const fn = wrap(v);
  let total = 0, traded = 0, endPos = 0, wings = 0, spent = 0;
  const daily = [];
  for (const d of days) {
    const r = runDay5m(d.bars, fn, opts);
    daily.push(r.terminal); total += r.terminal;
    if (r.lock && r.lock.traded) { traded++; if (r.lock.endFloorProfit) endPos++; }
    if (r.governor) { wings += r.governor.wings || 0; spent += r.governor.wingSpent || 0; }
  }
  const dd = rollingDD(daily, 30);
  return { total: Math.round(total), worst: Math.round(Math.min(...daily)), dd,
    retDD: dd < 0 ? Math.round(total / -dd * 10) / 10 : Infinity,
    endPosPct: traded ? Math.round(endPos / traded * 100) : 0, wings, spent: Math.round(spent) };
}

const RUNS = buildRuns().filter((v) => ONLY.split(',').includes(v.variant));
const W = { wingConvert: true, wingMinRatio: 3, wingAfterMin: 0, wingBudgetFrac: 0.10 };
const ARMS = [
  ['OFF (control)', {}],
  ['ratio3 14:00 10%', { wingConvert: true, wingMinRatio: 3, wingAfterMin: 840, wingBudgetFrac: 0.10 }],
  ['ratio3 14:00 25%', { wingConvert: true, wingMinRatio: 3, wingAfterMin: 840, wingBudgetFrac: 0.25 }],
  ['ratio5 14:00 10%', { wingConvert: true, wingMinRatio: 5, wingAfterMin: 840, wingBudgetFrac: 0.10 }],
  ['ratio10 14:00 10%', { wingConvert: true, wingMinRatio: 10, wingAfterMin: 840, wingBudgetFrac: 0.10 }],
  ['ratio3 12:00 10%', { wingConvert: true, wingMinRatio: 3, wingAfterMin: 720, wingBudgetFrac: 0.10 }],
  ['ratio3 15:00 10%', { wingConvert: true, wingMinRatio: 3, wingAfterMin: 900, wingBudgetFrac: 0.10 }],
  ['ratio3 anytime 10%', { ...W }],
  // SHAPE OF THE WING. Pinning the short leg at the anchor caps the wing exactly where the book stops
  // profiting; sweeping it outward raises that cap, and a naked long removes it entirely. But floor-lift
  // per dollar cannot SEE upside, so naked longs need the lambda term to ever be selected.
  ['  + short out 3', { ...W, wingOutSteps: 3 }],
  ['  + naked, lambda 0', { ...W, wingOutSteps: 3, wingNaked: true }],
  ['  + naked, lambda 0.25', { ...W, wingOutSteps: 3, wingNaked: true, wingUpsideLambda: 0.25 }],
  ['  + naked, lambda 0.5', { ...W, wingOutSteps: 3, wingNaked: true, wingUpsideLambda: 0.5 }],
  ['  + naked, lambda 1.0', { ...W, wingOutSteps: 3, wingNaked: true, wingUpsideLambda: 1.0 }],
  ['  naked only, lambda 1', { ...W, wingNaked: true, wingUpsideLambda: 1.0 }],
];

console.log(`\nWING CONVERSION SWEEP — ${days.length} days · first full-history measurement`);
console.log('endFloor+ = share of traded days finishing with a GUARANTEED profit (the metric wings target)\n');
for (const v of RUNS) {
  const ctl = measure(v, {});
  console.log(`═══ ${v.variant} ═══  control: ${usd(ctl.total)} · ret/DD ${ctl.retDD} · worst ${usd(ctl.worst)} · endFloor+ ${ctl.endPosPct}%`);
  console.log('  arm'.padEnd(23) + 'total'.padStart(13) + 'vs ctl'.padStart(12) + 'worst'.padStart(10) + 'maxDD30'.padStart(11) + 'ret/DD'.padStart(8) + 'endFloor+'.padStart(11) + 'wings'.padStart(8) + 'spent'.padStart(12));
  for (const [label, extra] of ARMS) {
    const m = measure(v, extra);
    console.log('  ' + label.padEnd(21) + usd(m.total).padStart(13) + ((m.total >= ctl.total ? '+' : '') + usd(m.total - ctl.total)).padStart(12)
      + usd(m.worst).padStart(10) + usd(m.dd).padStart(11) + String(m.retDD).padStart(8)
      + ((m.endPosPct + '%') + (m.endPosPct > ctl.endPosPct ? '↑' : m.endPosPct < ctl.endPosPct ? '↓' : ' ')).padStart(11)
      + m.wings.toLocaleString().padStart(8) + usd(m.spent).padStart(12));
  }
  console.log('');
}
