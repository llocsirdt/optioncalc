#!/usr/bin/env node
'use strict';
/**
 * ablate-v8.js — WHICH of v8's three add-ons is destroying it, and is it really "double-capping"?
 *
 * v8 is the v6 signal plus THREE things layered on the shared day-loss governor:
 *   softCap 3000        — a soft ceiling on at-risk debit. This is a LEGACY GOVERNOR: it was v8's answer
 *                         to the old hardCap being unable to tell trend-stacking from chop, and the
 *                         day-loss governor has since superseded that job.
 *   proactiveCoverFrac 0.70 — cover a leader once its spread marks >= 70% of width.
 *   exemptTrendStack    — let a same-side trend stack through the soft cap.
 * The 2026-09-04 baselines showed v8 keeping only 45/28/13% of its uncapped self at widths 10/20/40 —
 * the worst of any family — and the call was "v8 is being double-capped".
 *
 * ONE AGGREGATE NUMBER CANNOT SETTLE THAT, so this ablates each add-on independently, AND runs every arm
 * both GOVERNED and UNGOVERNED. That second axis is the actual test of the double-cap claim:
 *   - if softCap is fine ungoverned but ruinous governed  -> genuinely double-capped (the two caps fight)
 *   - if softCap is ruinous either way                    -> softCap is simply bad, not double-capping
 * Configs come from buildRuns() so every shared default (governor sizing, continuous covering, leg
 * uniqueness, recapture, ivSkew) matches what the server actually trades — only the ablated flag differs.
 *
 * Usage: node scripts/candle-spread/ablate-v8.js [--widths 10,20,40] [--dataDir <5m dir>]
 */
const path = require('path');
const { runDay5m, load5mDays } = require('./backtest-v6-5m');
const { makeGeo } = require('./backtest-width');
const { buildRuns } = require('../../server/src/candle-spread/index');

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const DIR = arg('--dataDir', path.join(__dirname, '..', '..', 'tests', 'backtest', 'backtest-data-5m-nq'));
const WIDTHS = arg('--widths', '10,20,40').split(',').map(Number);

const days = load5mDays(DIR);
const HAS_PX = !!(days[0] && days[0].bars && days[0].bars[0] && days[0].bars[0].px);
const usd = (n) => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');

// Faithful copy of build-backtest-baselines.js optsFor — same flags, same order, so an arm here is
// directly comparable to the shipped baseline for the same variant.
function optsFor(v) {
  const o = { rthActionOnly: true, trackCapital: true, intradayIV: true };
  if (v.ivSkew) o.ivSkew = true;
  if (v.bidirectional) o.bidirectional = true;
  for (const k of ['riskCap', 'softCap', 'hardCap', 'capitalCeiling', 'proactiveCoverFrac', 'lossTarget', 'lossMax']) if (v[k] != null) o[k] = v[k];
  if (v.floorOffset) o.floorOffset = true;
  if (v.continuousCover) o.continuousCover = true;
  if (v.continuousCoverMinLockFrac != null) o.continuousCoverMinLockFrac = v.continuousCoverMinLockFrac;
  if (v.lockCoverMode) o.lockCoverMode = v.lockCoverMode;
  if (v.exemptTrendStack) o.exemptTrendStack = true;
  if (v.coverSelector) o.coverSelector = v.coverSelector;
  if (v.coverToStack) { o.coverToStack = true; o.coverToStackVsRisk = true; if (v.coverToStackMinFrac != null) o.coverToStackMinFrac = v.coverToStackMinFrac; }
  if (v.capitalRecapture) { o.recaptureAlternate = true; if (v.openAlternateEvery != null) o.openAlternateEvery = v.openAlternateEvery; if (v.creditCoverFrac != null) o.creditCoverFrac = v.creditCoverFrac; }
  if (v.enforceLegUniqueness) { o.enforceLegUniqueness = true; if (v.legMaxShift != null) o.legMaxShift = v.legMaxShift; if (v.legMaxWing != null) o.legMaxWing = v.legMaxWing; }
  o.geo = makeGeo({ width: v.spreadWidth || 20, shift: v.spreadShift || 0, capFrac: v.capFrac != null ? v.capFrac : undefined });
  if (HAS_PX) o.priceOf = (b) => b.px || { close: b.analysis['5m'].close, high: b.analysis['5m'].high, low: b.analysis['5m'].low };
  return o;
}
const wrap = (v) => (A, p, ctx) => v.signalFn(A, p, { ...ctx, cfg: v.signalCfg || {} });

function rollingDD(daily, W) {
  const cum = [0];
  for (let i = 0; i < daily.length; i++) cum.push(cum[i] + daily[i]);
  let worst = 0;
  for (let i = 0; i < cum.length; i++) {
    for (let j = i + 1; j < Math.min(cum.length, i + W + 1); j++) worst = Math.min(worst, cum[j] - cum[i]);
  }
  return Math.round(worst);
}

function measure(v) {
  const opts = optsFor(v), fn = wrap(v);
  const daily = days.map((d) => runDay5m(d.bars, fn, opts).terminal);
  const total = daily.reduce((a, b) => a + b, 0);
  const dd = rollingDD(daily, 30);
  return {
    total: Math.round(total),
    avg: Math.round(total / daily.length),
    worst: Math.round(Math.min(...daily)),
    dd30: dd,
    retDD: dd < 0 ? Math.round(total / -dd * 10) / 10 : Infinity,
    win: Math.round(daily.filter((x) => x > 0).length / daily.length * 100),
  };
}

const RUNS = buildRuns();
// One arm = a label + the mutation applied to the base v8 config for that width.
const ARMS = [
  ['v6  (signal only)', (v, v6) => ({ ...v6 })],
  ['v8  (as shipped)', (v) => ({ ...v })],
  ['v8 −softCap', (v) => { const o = { ...v }; delete o.softCap; delete o.exemptTrendStack; return o; }],
  ['v8 −proactive', (v) => { const o = { ...v }; delete o.proactiveCoverFrac; return o; }],
  ['v8 −exemptTrend', (v) => { const o = { ...v }; delete o.exemptTrendStack; return o; }],
  ['v8 −both (=v6+gov)', (v, v6) => { const o = { ...v }; delete o.softCap; delete o.exemptTrendStack; delete o.proactiveCoverFrac; return o; }],
  // Does the CAP CONCEPT survive if it scales with width? softCap 3000 is a FIXED dollar cap, but a
  // spread's cost scales with width (0.65 x W x 100), so the same $3,000 buys ~4.6 positions at $10 and
  // barely 1 at $40 — the matrix finding "caps MUST scale with width". These arms give the cap the same
  // POSITION headroom at every width instead of the same dollars.
  ['v8 softCap=6x spread', (v) => ({ ...v, softCap: Math.round(0.65 * v.spreadWidth * 100 * 6) })],
  ['v8 softCap=12x spread', (v) => ({ ...v, softCap: Math.round(0.65 * v.spreadWidth * 100 * 12) })],
  ['v8 softCap=20x spread', (v) => ({ ...v, softCap: Math.round(0.65 * v.spreadWidth * 100 * 20) })],
];

console.log(`\nV8 ABLATION — ${days.length} days · ${path.basename(DIR)} · governed vs ungoverned\n`);
console.log('softCap is v8\'s LEGACY governor; the day-loss governor (lossTarget/lossMax) is the current one.');
console.log('"keep%" = governed total / ungoverned total for the SAME arm.\n');

for (const w of WIDTHS) {
  const v8 = RUNS.find((r) => r.variant === `v8-${w}`);
  const v6 = RUNS.find((r) => r.variant === `v6-${w}`);
  if (!v8 || !v6) { console.log(`(no v8-${w}/v6-${w} in the roster — skipped)`); continue; }
  console.log(`═══ WIDTH $${w} ═══`);
  console.log('arm'.padEnd(22) + 'GOVERNED total'.padStart(15) + 'worst'.padStart(11) + 'dd30'.padStart(10) + 'ret/DD'.padStart(8)
    + '   |' + 'UNGOVERNED total'.padStart(17) + 'worst'.padStart(11) + 'ret/DD'.padStart(8) + 'keep%'.padStart(7));
  for (const [label, mutate] of ARMS) {
    const base = mutate(v8, v6);
    const gov = measure(base);
    // Ungoverned twin: the day-loss governor nulled out, everything else identical.
    const unc = measure({ ...base, lossTarget: null, lossMax: null });
    const keep = unc.total ? Math.round(gov.total / unc.total * 100) : 0;
    console.log(label.padEnd(22) + usd(gov.total).padStart(15) + usd(gov.worst).padStart(11) + usd(gov.dd30).padStart(10) + String(gov.retDD).padStart(8)
      + '   |' + usd(unc.total).padStart(17) + usd(unc.worst).padStart(11) + String(unc.retDD).padStart(8) + (keep + '%').padStart(7));
  }
  console.log('');
}
