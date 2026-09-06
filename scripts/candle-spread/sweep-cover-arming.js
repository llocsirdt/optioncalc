#!/usr/bin/env node
'use strict';
/**
 * sweep-cover-arming.js — can RISK-ARMED covering beat covering everything immediately?
 *
 * v0 rests a cover on every position the moment it opens: maximum locking, but every position's outcome
 * is decided at birth. v1-v3 arm instead on (a) the book floor reaching armFrac x lossTarget, or (b) a
 * cover cheap enough to lock oppRatio x its own cost. At the first-pass settings (0.60 / 2.0) that cost
 * ~28% of total on v0-10, but those numbers were never swept — one point is not a verdict.
 *
 * This sweeps the grid. armFrac null = the v0 control (cover immediately); with it set, oppRatio null
 * means risk-only arming and a value means the opportunity trigger is also live. Geometry is held at
 * TENT throughout, because the geometry axis has already been measured and the tent won.
 *
 * ONE PROCESS, days loaded ONCE — a fan-out over this many combinations does not fit in memory
 * alongside anything else, and competing processes are what made earlier runs crawl.
 *
 * Usage: node scripts/candle-spread/sweep-cover-arming.js [--variant v0-20] [--dataDir <d>]
 */
const path = require('path');
const { runDay5m, load5mDays } = require('./backtest-v6-5m');
const { makeGeo, makeAdaptiveGeo } = require('./backtest-width');
const { buildRuns } = require('../../server/src/candle-spread/index');

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const DIR = arg('--dataDir', path.join(__dirname, '..', '..', 'tests', 'backtest', 'backtest-data-5m-nq'));
const NAMES = arg('--variant', 'v0-10,v0-20').split(',');

const days = load5mDays(DIR);
const HAS_PX = !!(days[0] && days[0].bars && days[0].bars[0] && days[0].bars[0].px);
const usd = (n) => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');

const ARM = [null, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1.0];
const OPP = [null, 1.0, 1.5, 2.0, 3.0];

function optsFor(v) {
  const o = { rthActionOnly: true, intradayIV: true };
  if (v.ivSkew) o.ivSkew = true;
  if (v.bidirectional) o.bidirectional = true;
  for (const k of ['riskCap', 'softCap', 'hardCap', 'capitalCeiling', 'proactiveCoverFrac', 'lossTarget', 'lossMax']) if (v[k] != null) o[k] = v[k];
  if (v.floorOffset) o.floorOffset = true;
  if (v.continuousCover) o.continuousCover = true;
  if (v.continuousCoverMinLockFrac != null) o.continuousCoverMinLockFrac = v.continuousCoverMinLockFrac;
  if (v.lockCoverMode) o.lockCoverMode = v.lockCoverMode;
  if (v.coverSelector) o.coverSelector = v.coverSelector;
  if (v.coverToStack) { o.coverToStack = true; o.coverToStackVsRisk = true; if (v.coverToStackMinFrac != null) o.coverToStackMinFrac = v.coverToStackMinFrac; }
  if (v.capitalRecapture) { o.recaptureAlternate = true; if (v.openAlternateEvery != null) o.openAlternateEvery = v.openAlternateEvery; if (v.creditCoverFrac != null) o.creditCoverFrac = v.creditCoverFrac; }
  if (v.enforceLegUniqueness) { o.enforceLegUniqueness = true; if (v.legMaxShift != null) o.legMaxShift = v.legMaxShift; if (v.legMaxWing != null) o.legMaxWing = v.legMaxWing; }
  o.geo = v.adaptiveGeo
    ? makeAdaptiveGeo({ width: v.spreadWidth || 20, incr: 10, maxDebitFrac: v.capFrac != null ? v.capFrac : 0.65, maxItmStrikes: v.maxItmStrikes != null ? v.maxItmStrikes : 3 })
    : makeGeo({ width: v.spreadWidth || 20, shift: v.spreadShift || 0, capFrac: v.capFrac != null ? v.capFrac : undefined });
  if (HAS_PX) o.priceOf = (b) => b.px || { close: b.analysis['5m'].close, high: b.analysis['5m'].high, low: b.analysis['5m'].low };
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
  const opts = { ...optsFor(v), coverGeometry: 'tent', ...extra };
  const fn = wrap(v);
  const daily = days.map((d) => runDay5m(d.bars, fn, opts).terminal);
  const total = daily.reduce((a, b) => a + b, 0);
  const dd = rollingDD(daily, 30);
  return { total: Math.round(total), worst: Math.round(Math.min(...daily)), dd,
    retDD: dd < 0 ? Math.round(total / -dd * 10) / 10 : Infinity,
    win: Math.round(daily.filter((x) => x > 0).length / daily.length * 100) };
}

const RUNS = buildRuns();
console.log(`\nCOVER-ARMING SWEEP — ${days.length} days · geometry held at TENT`);
console.log('armFrac null = cover immediately (the v0 control). oppRatio null = risk-only arming.\n');

for (const name of NAMES) {
  const v = RUNS.find((r) => r.variant === name);
  if (!v) { console.log(`${name}: not a current variant`); continue; }
  // Control: cover everything immediately, exactly as v0 does.
  const ctl = measure(v, { continuousCoverArmFrac: null, continuousCoverOppRatio: null });
  console.log(`═══ ${name} ═══   CONTROL (instant): ${usd(ctl.total)} · ret/DD ${ctl.retDD} · worst ${usd(ctl.worst)} · maxDD30 ${usd(ctl.dd)} · win ${ctl.win}%`);
  console.log('armFrac'.padEnd(9) + 'oppRatio'.padStart(9) + 'total'.padStart(13) + 'vs ctl'.padStart(12) + 'worst'.padStart(10) + 'maxDD30'.padStart(11) + 'ret/DD'.padStart(8) + 'win'.padStart(6));
  const rows = [];
  for (const a of ARM) {
    if (a == null) continue;                    // the control above IS armFrac null
    for (const o of OPP) {
      const m = measure(v, { continuousCoverArmFrac: a, continuousCoverOppRatio: o });
      rows.push({ a, o, ...m });
      console.log(String(a).padEnd(9) + String(o == null ? '—' : o).padStart(9) + usd(m.total).padStart(13)
        + ((m.total >= ctl.total ? '+' : '') + usd(m.total - ctl.total).replace('$', '$')).padStart(12)
        + usd(m.worst).padStart(10) + usd(m.dd).padStart(11) + String(m.retDD).padStart(8) + (m.win + '%').padStart(6));
    }
  }
  const beatTotal = rows.filter((r) => r.total > ctl.total);
  const beatRet = rows.filter((r) => r.retDD > ctl.retDD);
  console.log(`\n  beats control on TOTAL:  ${beatTotal.length}/${rows.length}` + (beatTotal.length ? ` — best ${usd(Math.max(...beatTotal.map(r => r.total)))}` : ''));
  console.log(`  beats control on ret/DD: ${beatRet.length}/${rows.length}`
    + (beatRet.length ? ` — best ${Math.max(...beatRet.map(r => r.retDD))} at armFrac ${beatRet.sort((x, y) => y.retDD - x.retDD)[0].a}/opp ${beatRet[0].o ?? '—'}` : ''));
  console.log('');
}
