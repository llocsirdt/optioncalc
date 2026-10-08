#!/usr/bin/env node
'use strict';
/**
 * LOSS-CAP SWEEP — what is the LOWEST day-loss governor cap each variant can carry without meaningfully
 * degrading the metrics we care about?
 *
 * The knob is the day-loss governor's `lossMax` (a hard bound on the BOOK FLOOR — every open is gated on
 * it), paired with the soft `lossTarget`. Today the fleet inherits a width-relative generic default,
 * `maxCapFor(w) = max(2*w*100, 5000 + w*100)`  →  $6,000 at W=10, $7,000 at W=20, $9,000 at W=40.
 * Four variants (CANDLE_SPREAD_CAPPRES) instead carry the tight capital-preservation preset,
 * `lossMax = 1 x W x 100`, `lossTarget = 0.7 x lossMax`.
 *
 * This script re-runs the LIVE roster (buildRuns(), so the config the server trades IS what is measured)
 * through the same validated 5m engine the baselines builder uses, once per cap rung, and reports the
 * risk/activity metrics side by side. It is MEASUREMENT ONLY: it overrides lossMax/lossTarget on a COPY
 * of each run and never writes to the roster or to backtest-baselines.*.
 *
 * Rungs are multiples of W x 100 (the CAPPRES convention), with lossTarget = 0.7 x lossMax; rungs at or
 * above the variant's current cap are skipped, and the variant's UNTOUCHED current config is always run
 * as the `current` row so before/after comes from one execution rather than two builds.
 *
 * `-unc` twins are excluded by construction: they have no governor, which is the point of the twin.
 *
 * Usage:
 *   node scripts/candle-spread/sweep-loss-cap.js [--workers 6] [--out <dir>]
 *                                                [--variants v7-10,v6-20] [--rungs 1,1.5,2,3,4]
 *                                                [--dataDir <5m dir>] [--openFillModel ladder]
 *                                                [--capFracs 0.5,0.525,0.55,0.6]   (sweep the open-price ceiling instead)
 * Emits <out>/loss-cap-sweep.json and <out>/loss-cap-sweep.csv (default out = cwd).
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { runDay5m, load5mDays } = require('./backtest-v6-5m');
const CS = require('../../server/src/candle-spread/index');
const { buildRuns } = CS;
const { optsFor } = require('../../server/src/candle-spread/backtest/opts-for');

const argVal = (flag, dflt) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : dflt; };
const DIR = argVal('--dataDir', path.join(__dirname, '..', '..', 'tests', 'backtest', 'backtest-data-5m-nq'));
const OUTDIR = argVal('--out', process.cwd());
// --openFillModel ladder: opens rest as ONE working order walked by the live ladder (the 2026-10-03 port),
// so the governor counts the working open as filled exactly as live does. Default = the historical
// instant-at-the-bar assumption the 10-01 cap sweep used.
const OPEN_FILL = argVal('--openFillModel', null);
// --fillThroughTicks N: a working order fills only when the bar's best price is N ticks BETTER than its limit.
const FILL_THRU = argVal('--fillThroughTicks', null) != null ? Number(argVal('--fillThroughTicks', null)) : null;
const numArg = (f) => (argVal(f, null) != null ? Number(argVal(f, null)) : null);
// --restrikeMins 5,10,15,30: re-strike timeout study — one job per variant per value (0 = off, the 90-min
// backstop only), at the variant's current config.
const RESTRIKE = (argVal('--restrikeMins', '') || '').split(',').filter((x) => x !== '').map(Number);
const FILL_THRU_OPEN = numArg('--fillThroughTicksOpen'), FILL_THRU_COVER = numArg('--fillThroughTicksCover');
const WORKERS = Math.max(1, Math.min(16, Number(argVal('--workers', '1')) || 1));
const ONLY = (argVal('--variants', '') || '').split(',').map(s => s.trim()).filter(Boolean);
const BUMP = Number(argVal('--bump', '0')) || 0;
const RUNGS = (argVal('--rungs', '1,1.5,2,3,4')).split(',').map(Number).filter(Number.isFinite);
// --capFracs 0.5,0.55,0.6: sweep the OPEN-PRICE CEILING instead of the loss cap. Adaptive placement takes the
// most-ITM strikes whose price fits under capFrac x W, so this is "how much do we let an open cost": at 0.60
// a 10-wide opens at up to $6.00, at 0.55 up to $5.50. Every job keeps the variant's CURRENT lossMax.
const CAP_FRACS = (argVal('--capFracs', '') || '').split(',').map(Number).filter((x) => x > 0 && x < 1);
const SLICE = process.argv.indexOf('--_slice') >= 0 ? Number(process.argv[process.argv.indexOf('--_slice') + 1]) : null;
const SLICE_OF = SLICE != null ? Number(process.argv[process.argv.indexOf('--_slice') + 2]) : null;
const SLICE_OUT = process.argv.indexOf('--_out') >= 0 ? process.argv[process.argv.indexOf('--_out') + 1] : null;

const allDays = load5mDays(DIR);
if (!allDays.length) { console.error('no days loaded from', DIR); process.exit(1); }
const HAS_PX = allDays.some(d => d.bars.some(b => b.px));
// Same tradeable-day filter as build-backtest-baselines.js: a real RTH cash session must exist.
const etMin = ms => { const d = new Date(new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York' })); return d.getHours() * 60 + d.getMinutes(); };
const days = allDays.filter(d => d.bars.some(b => { const m = etMin(b.dt); return m >= 570 && m < 960; }));

const RUNS = buildRuns().filter(r => r.lossMax != null && (!ONLY.length || ONLY.includes(r.variant)));

// THE GENERIC DEFAULT, read off the roster rather than re-derived. maxCapFor()/LOSS_TARGET are private to
// index.js, and a hand-copied formula here is exactly the kind of silent drift opts-for.js exists to stop.
// The generic cap is the one the MAJORITY of variants at a width carry (the CAPPRES preset is the minority
// override), and its lossTarget is whatever a variant sitting at that cap actually uses.
const GENERIC = new Map();
for (const run of buildRuns().filter(r => r.lossMax != null)) {
  const W = run.spreadWidth;
  const g = GENERIC.get(W) || (GENERIC.set(W, new Map()), GENERIC.get(W));
  const cur = g.get(run.lossMax) || { n: 0, lossTarget: run.lossTarget };
  cur.n++; g.set(run.lossMax, cur);
}
// THE REFERENCE ARM SILENTLY BECAME THE TREATMENT. Reading "the most common cap at this width" off the
// roster was a fair proxy for the pre-tightening default while only four variants carried an override.
// Once TUNED_CAPS tightened all 50, the MODE IS THE TIGHTENED VALUE — so `generic` stopped being a
// counterfactual and started being a second copy of `current`. Measured: 29 of 50 variants had no rung
// looser than their own cap, which is precisely the question the sweep is asked when someone suspects the
// caps are too tight. It answered by not testing.
//
// maxCapFor is now exported from index.js, so the counterfactual is the REAL documented default rather
// than either a hand-copied formula (the drift this comment originally warned about) or an inference from
// data the treatment has already moved. The roster mode is kept as a second arm where it differs: it is
// still a meaningful "what the fleet mostly carries" reference.
const genericFor = (W) => {
  const g = GENERIC.get(W);
  let mode = null;
  for (const [lossMax, v] of g) if (!mode || v.n > mode.n || (v.n === mode.n && lossMax > mode.lossMax)) mode = { lossMax, lossTarget: v.lossTarget, n: v.n };
  const formula = CS.maxCapFor ? CS.maxCapFor(W) : null;
  if (!(formula > 0)) return mode;
  return { lossMax: formula, lossTarget: Math.round(0.7 * formula), n: mode ? mode.n : 0, mode };
};

// One JOB = one (variant, cap rung). `current` keeps the run's own lossMax/lossTarget untouched; `generic`
// is the fleet default at that width (for a variant already on the tight preset, this is the counterfactual
// "what if it had never been tightened"). Rungs use the CAPPRES convention lossTarget = 0.7 x lossMax.
// Deduped by lossMax so a rung that coincides with current/generic is not run twice.
const JOBS = [];
// --currentOnly: one job per variant at its CURRENT config (cap, ceiling) — for sweeping a fill model
// (--openFillModel / --fillThroughTicks) across the roster rather than a knob.
// --placementModes: strike/price placement study (2026-10-05). Per variant (fixed-geometry -cATM controls
// excluded), at its CURRENT cap:
//   A current  — adaptive, deepest ITM priced <= capFrac x W (as shipped)
//   B band     — adaptive, deepest ITM priced inside the user's band
//   C sATM-band — fixed short-at-the-money, taken only inside the band
//   D sATM-wide — fixed short-at-the-money, up to the old 65% ceiling
//   E band+1OTM — B, but may step the short leg ONE strike out of the money to meet the band
//   F band+walk — B for strike choice, then the ladder may walk the price up to WALK x W
//   G — E and F together
// Bands = the user's real limits: 10W $4.80-5.30, 20W $9.50-11.00, 40W $19-23.
const BANDS = { 10: [0.48, 0.53], 20: [0.475, 0.55], 40: [0.475, 0.575] };
// How far the open ladder may then walk the price to get the fill (user: "step the price up to 5.5 or so"):
// 10W $5.50, 20W $11.50, 40W $24.
const WALK = { 10: 0.55, 20: 0.575, 40: 0.60 };
// --floorRaiseArms: the always-on floor-raise pass. Arms = off, then minRatio {1,2,3} with no budget cap (the
// user's "any amount with at least 1:1"), and ratio 1 capped at 25% / 50% of peak for comparison. Every arm
// keeps the hard rule: a locked profit (global floor >= 0) is never pushed below zero.
// Valley objective, flat vs distance-scaled ratio (near -> far at 2 sigma). 'band r2' = the measured original.
// --floorRaiseFinal (2026-10-06): the roster's spreads-first rule vs off, under resting raises + at-limit fills,
// plus a stricter 3:1 — decides whether the armed v7-10 trades floor raises.
const FR_ARMS = process.argv.includes('--floorRaiseFinal') ? [
  ['off', null], ['B spreadFirst r2', { floorRaiseMinRatio: 2, floorRaiseObjective: 'spreadFirst' }],
  ['B spreadFirst r3', { floorRaiseMinRatio: 3, floorRaiseObjective: 'spreadFirst' }]]
  : process.argv.includes('--floorRaiseMulti') ? [
  ['off', null], ['A band r2', { floorRaiseMinRatio: 2, floorRaiseObjective: 'band' }],
  ['B spreadFirst r2', { floorRaiseMinRatio: 2, floorRaiseObjective: 'spreadFirst' }],
  ['C pair r2', { floorRaiseMinRatio: 2, floorRaiseObjective: 'pair' }],
  ['C pair r1.5', { floorRaiseMinRatio: 1.5, floorRaiseObjective: 'pair' }],
  ['C pair r1.25', { floorRaiseMinRatio: 1.25, floorRaiseObjective: 'pair' }]]
  : process.argv.includes('--floorRaiseValley') ? [
  ['off', null], ['band r2', { floorRaiseMinRatio: 2, floorRaiseObjective: 'band' }],
  ['valley-min r2', { floorRaiseMinRatio: 2, floorRaiseLiftMetric: 'min' }],
  ['valley-avg r2', { floorRaiseMinRatio: 2, floorRaiseLiftMetric: 'avg' }], ['valley-avg r3', { floorRaiseMinRatio: 3, floorRaiseLiftMetric: 'avg' }],
  ['valley-avg 2->4', { floorRaiseMinRatio: 2, floorRaiseMinRatioFar: 4, floorRaiseLiftMetric: 'avg' }],
  ['valley-avg 2->5', { floorRaiseMinRatio: 2, floorRaiseMinRatioFar: 5, floorRaiseLiftMetric: 'avg' }],
  ['valley-avg 3->5', { floorRaiseMinRatio: 3, floorRaiseMinRatioFar: 5, floorRaiseLiftMetric: 'avg' }]]
  : process.argv.includes('--floorRaiseArms') ? [
  ['off', null], ['r1 unlimited', { floorRaiseMinRatio: 1 }], ['r2 unlimited', { floorRaiseMinRatio: 2 }],
  ['r3 unlimited', { floorRaiseMinRatio: 3 }], ['r1 25% peak', { floorRaiseMinRatio: 1, floorRaiseBudgetFrac: 0.25 }],
  ['r1 50% peak', { floorRaiseMinRatio: 1, floorRaiseBudgetFrac: 0.5 }]] : [];
// --giveUpCaps 0.05,0.075,0.1,0.15,0.2: give-up loss allowance (fraction of width over break-even that a
// give-up cover may pay once the position has run giveUpPoints back through its short strike).
const GU_CAPS = (argVal('--giveUpCaps', '') || '').split(',').filter((x) => x !== '').map(Number);
// --giveUpTriggers: the trigger itself. points10 (shipped) / points20 / reversal of the prior signal candle on
// 5m or 15m, by a trade through (rev5, rev15) or a close through (rev5c, rev15c) the prior extreme.
const GU_TRIGS = process.argv.includes('--giveUpTriggers') ? [
  ['points 10', { giveUpTrigger: 'points', giveUpPoints: 10 }], ['points 20', { giveUpTrigger: 'points', giveUpPoints: 20 }],
  ['rev 5m', { giveUpTrigger: 'rev5' }], ['rev 5m close', { giveUpTrigger: 'rev5c' }],
  ['rev 15m', { giveUpTrigger: 'rev15' }], ['rev 15m close', { giveUpTrigger: 'rev15c' }],
  ['signal reversal', { giveUpTrigger: 'signal' }], ['be-wrong only', { giveUpTrigger: 'beWrong' }]] : [];
// --trendArms (2026-10-07): NEVER FIGHT THE TREND. Every arm runs the current roster (floor raise B 3:1, give-up
// points-10 with the by-width allowance) plus: the floor-raise side guard under each trend definition; the
// guard + a be-wrong permit; urgent cover for a position fighting the trend (allowance as rostered, +2.5%, 10%);
// both together; and the strict open block as a control. Definitions: A = 15m + completed hourly (the user's),
// AHH (+ hourly higher high), Af (+ forming hourly), 15m, H (hourly only).
const GU_BUMP = (w, add) => Math.min(0.2, (w >= 40 ? 0.10 : w >= 20 ? 0.075 : 0.05) + add);
const TREND_ARMS = process.argv.includes('--trendArms') ? [
  ['base', () => ({})],
  ['hedge A', () => ({ floorRaiseTrend: 'A' })], ['hedge AHH', () => ({ floorRaiseTrend: 'AHH' })],
  ['hedge Af', () => ({ floorRaiseTrend: 'Af' })], ['hedge 15m', () => ({ floorRaiseTrend: '15m' })],
  ['hedge H', () => ({ floorRaiseTrend: 'H' })],
  ['hedge A +bw permit', () => ({ floorRaiseTrend: 'A', floorRaiseTrendPermit: 'beWrong' })],
  ['cover A', () => ({ giveUpTrend: 'A' })], ['cover A +2.5%', (r) => ({ giveUpTrend: 'A', giveUpMaxLoss: GU_BUMP(r.spreadWidth, 0.025) })],
  ['cover A 10%', () => ({ giveUpTrend: 'A', giveUpMaxLoss: 0.10 })],
  ['cover Af', () => ({ giveUpTrend: 'Af' })], ['cover 15m', () => ({ giveUpTrend: '15m' })],
  ['hedge A + cover A', () => ({ floorRaiseTrend: 'A', giveUpTrend: 'A' })],
  ['hedge Af + cover Af', () => ({ floorRaiseTrend: 'Af', giveUpTrend: 'Af' })],
  ['open-block A (control)', () => ({ openTrendBlock: 'A' })],
] : [];
// --nearCapArms (2026-10-07): floor raise NEAR THE CAP. Within nearCapFrac x W of -lossMax the governor is blocking
// opens, so a hedge is judged on GLOBAL-floor lift per dollar at nearCapRatio and may not lower that floor.
// Off = today's 3:1 everywhere. Run on the current roster (valley-sized menu, 10W caps 2,000).
const NEARCAP_ARMS = process.argv.includes('--nearCapArms') ? [
  ['off', () => ({})],
  ['0.5W 1:1', () => ({ floorRaiseNearCapFrac: 0.5, floorRaiseNearCapRatio: 1 })],
  ['0.5W 0.75:1', () => ({ floorRaiseNearCapFrac: 0.5, floorRaiseNearCapRatio: 0.75 })],
  ['0.5W 1.5:1', () => ({ floorRaiseNearCapFrac: 0.5, floorRaiseNearCapRatio: 1.5 })],
  ['1W 1:1', () => ({ floorRaiseNearCapFrac: 1, floorRaiseNearCapRatio: 1 })],
  ['0.25W 1:1', () => ({ floorRaiseNearCapFrac: 0.25, floorRaiseNearCapRatio: 1 })],
] : [];
// --stallArms (2026-10-07): STALL COVER — a position that has not moved our way by P points within M minutes of
// filling covers at break-even (or the market if better). Arms: off, M = 3/5/10/15/30 at P = 0, and M = 5 / 10 at
// P = 10 (must have moved 10 points our way, else stall).
const STALL_ARMS = process.argv.includes('--stallArms') ? [
  ['off', () => ({})], ['3m 0p', () => ({ stallCoverMin: 3 })], ['5m 0p', () => ({ stallCoverMin: 5 })],
  ['10m 0p', () => ({ stallCoverMin: 10 })], ['15m 0p', () => ({ stallCoverMin: 15 })], ['30m 0p', () => ({ stallCoverMin: 30 })],
  ['5m 10p', () => ({ stallCoverMin: 5, stallCoverPts: 10 })], ['10m 10p', () => ({ stallCoverMin: 10, stallCoverPts: 10 })],
] : [];
if (STALL_ARMS.length) {
  for (const run of RUNS) for (const [name, over] of STALL_ARMS) JOBS.push({ variant: run.variant, rung: `stall ${name}`,
    k: Math.round(run.lossMax / (run.spreadWidth * 100) * 100) / 100, lossMax: run.lossMax, lossTarget: run.lossTarget, over: over(run) });
} else if (NEARCAP_ARMS.length) {
  for (const run of RUNS) for (const [name, over] of NEARCAP_ARMS) JOBS.push({ variant: run.variant, rung: `nearCap ${name}`,
    k: Math.round(run.lossMax / (run.spreadWidth * 100) * 100) / 100, lossMax: run.lossMax, lossTarget: run.lossTarget, over: over(run) });
} else if (TREND_ARMS.length) {
  for (const run of RUNS) for (const [name, over] of TREND_ARMS) JOBS.push({ variant: run.variant, rung: `trend ${name}`,
    k: Math.round(run.lossMax / (run.spreadWidth * 100) * 100) / 100, lossMax: run.lossMax, lossTarget: run.lossTarget, over: over(run) });
} else if (GU_TRIGS.length) {
  for (const run of RUNS) for (const [name, over] of GU_TRIGS) JOBS.push({ variant: run.variant, rung: `giveUp ${name}`,
    // floorRaise OFF explicitly: the roster turns it on by default, and this sweep measures give-up alone.
    k: Math.round(run.lossMax / (run.spreadWidth * 100) * 100) / 100, lossMax: run.lossMax, lossTarget: run.lossTarget, over: { floorRaise: false, ...over } });
} else if (GU_CAPS.length) {
  for (const run of RUNS) for (const c of GU_CAPS) JOBS.push({ variant: run.variant, rung: `giveUp ${c}`,
    k: Math.round(run.lossMax / (run.spreadWidth * 100) * 100) / 100, lossMax: run.lossMax, lossTarget: run.lossTarget,
    over: { giveUpMaxLoss: c } });
} else if (FR_ARMS.length) {
  for (const run of RUNS) for (const [name, over] of FR_ARMS) JOBS.push({ variant: run.variant, rung: `floorRaise ${name}`,
    k: Math.round(run.lossMax / (run.spreadWidth * 100) * 100) / 100, lossMax: run.lossMax, lossTarget: run.lossTarget,
    // 'off' must SET it off: the roster now turns floor raising on by default (applyFloorRaise).
    over: over ? { floorRaise: true, ...over } : { floorRaise: false } });
} else if (RESTRIKE.length) {
  for (const run of RUNS) for (const m of RESTRIKE) JOBS.push({ variant: run.variant, rung: m ? `restrike ${m}m` : 'restrike off',
    k: Math.round(run.lossMax / (run.spreadWidth * 100) * 100) / 100, lossMax: run.lossMax, lossTarget: run.lossTarget,
    over: { openRestrikeMin: m || null } });
} else if (process.argv.includes('--placementModes')) {
  for (const run of RUNS) {
    if (/-cATM$/.test(run.variant)) continue;
    const W = run.spreadWidth, [lo, hi] = BANDS[W] || [0, run.capFrac || 0.65];
    const k = Math.round(run.lossMax / (W * 100) * 100) / 100;
    const j = (rung, over) => JOBS.push({ variant: run.variant, rung, k, lossMax: run.lossMax, lossTarget: run.lossTarget, over });
    j('A current', {});
    j('B band', { adaptiveGeo: true, capFrac: hi, minDebitFrac: lo });
    j('C sATM-band', { adaptiveGeo: false, spreadShift: W / 2, capFrac: hi, minDebitFrac: lo });
    j('D sATM-wide', { adaptiveGeo: false, spreadShift: W / 2, capFrac: 0.65 });
    const walk = WALK[W] || hi;
    j('E band+1OTM', { adaptiveGeo: true, capFrac: hi, minDebitFrac: lo, maxOtmStrikes: 1 });
    j('F band+walk', { adaptiveGeo: true, capFrac: hi, minDebitFrac: lo, openWalkCapFrac: walk });
    j('G band+1OTM+walk', { adaptiveGeo: true, capFrac: hi, minDebitFrac: lo, maxOtmStrikes: 1, openWalkCapFrac: walk });
  }
} else if (process.argv.includes('--currentOnly')) {
  for (const run of RUNS) JOBS.push({ variant: run.variant, rung: 'current',
    k: Math.round(run.lossMax / (run.spreadWidth * 100) * 100) / 100, lossMax: run.lossMax, lossTarget: run.lossTarget });
} else if (CAP_FRACS.length) {
  for (const run of RUNS) {
    const cur = run.capFrac != null ? run.capFrac : 0.65;
    const fr = [...new Set(CAP_FRACS.concat([cur]))].sort((a, b) => a - b);
    for (const cf of fr) JOBS.push({ variant: run.variant, rung: cf === cur ? `capFrac ${cf} (current)` : `capFrac ${cf}`,
      k: Math.round(run.lossMax / (run.spreadWidth * 100) * 100) / 100, lossMax: run.lossMax, lossTarget: run.lossTarget, capFrac: cf });
  }
} else
for (const run of RUNS) {
  const W = run.spreadWidth;
  const gen = genericFor(W);
  const seen = new Map();
  const add = (rung, lossMax, lossTarget) => {
    if (seen.has(lossMax)) { seen.get(lossMax).rung += '/' + rung; return; }
    const j = { variant: run.variant, rung, k: Math.round(lossMax / (W * 100) * 100) / 100, lossMax, lossTarget };
    seen.set(lossMax, j); JOBS.push(j);
  };
  add('current', run.lossMax, run.lossTarget);
  add('generic', gen.lossMax, gen.lossTarget);
  // --bump N adds one arm at THIS VARIANT'S CURRENT CAP + N. The rung ladder is multiples of W x 100, so a
  // flat dollar bump is not expressible on it — and "what does +$500 everywhere actually cost" is a
  // question about the fleet as it stands, not about a width-relative grid. Never allowed past the
  // original generic default: the point of the question is to land BETWEEN the tuned caps and the old
  // ones, and a bump that sails past the old cap is answering a different question.
  if (BUMP > 0 && run.lossMax != null) {
    const bumped = Math.min(run.lossMax + BUMP, gen.lossMax);
    if (bumped > run.lossMax) add(`+${BUMP}`, bumped, Math.round(0.7 * bumped));
  }
  for (const k of RUNGS) {
    const lm = Math.round(k * W * 100);
    if (lm > gen.lossMax) continue;                     // never LOOSER than the fleet default
    add(String(k), lm, Math.round(0.7 * lm));
  }
}

function measure(job) {
  const run = RUNS.find(r => r.variant === job.variant);
  const cfg = { ...run, lossMax: job.lossMax, lossTarget: job.lossTarget, ...(job.capFrac != null ? { capFrac: job.capFrac } : {}), ...(job.over || {}) };
  const fn = (A, p, ctx) => cfg.signalFn(A, p, { ...ctx, cfg: cfg.signalCfg || {} });
  const o = optsFor(cfg, { intradayIV: true, hasPx: HAS_PX, where: 'sweep-loss-cap', openFillModel: OPEN_FILL, fillThroughTicks: FILL_THRU,
    fillThroughTicksOpen: FILL_THRU_OPEN, fillThroughTicksCover: FILL_THRU_COVER });
  const PLACEMENT = process.argv.includes('--placementModes');
  if (CAP_FRACS.length || PLACEMENT) o.recordReplay = true;   // positions, for the open-price and per-open cover stats
  const res = days.map(d => runDay5m(d.bars, fn, o));
  // Per-OPEN stats (capFrac mode): what the opens actually cost and how often each got covered — the
  // question behind the ceiling is "does a $6 open cover less often than a $5 one".
  let openStats = {};
  if (CAP_FRACS.length || PLACEMENT) {
    const ps = [];
    for (const r of res) for (const p of (r.positions || [])) if (!p.hedge && p.filled !== false && p.limit != null) ps.push(p);
    const W = run.spreadWidth;
    const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length * 100) / 100 : null);
    const cov = (a) => (a.length ? Math.round(a.filter((p) => p.covered).length / a.length * 1000) / 10 : null);
    const lo = ps.filter((p) => p.limit <= 0.525 * W), hi = ps.filter((p) => p.limit >= 0.55 * W);
    openStats = { capFrac: cfg.capFrac, mode: job.rung, avgOpen: avg(ps.map((p) => p.limit)), coveredPct: cov(ps),
      nOpenLE525: lo.length, coveredLE525: cov(lo), nOpenGE55: hi.length, coveredGE55: cov(hi) };
    for (const r of res) r.positions = null;
  }
  const daily = res.map(r => r.terminal);
  const total = daily.reduce((a, b) => a + b, 0);
  const sorted = [...daily].sort((a, b) => a - b);
  // true peak-to-trough drawdown over the whole equity curve
  const cum = [0]; daily.forEach((x, i) => cum.push(cum[i] + x));
  let peak = -Infinity, mdd = 0, ddDays = 0, curStart = 0, worstStart = 0, worstEnd = 0;
  for (let i = 0; i < cum.length; i++) {
    if (cum[i] > peak) { peak = cum[i]; curStart = i; }
    if (peak - cum[i] > mdd) { mdd = peak - cum[i]; worstStart = curStart; worstEnd = i; }
  }
  ddDays = worstEnd - worstStart;
  const filled = res.reduce((a, r) => a + r.filled, 0), naked = res.reduce((a, r) => a + r.naked, 0);
  const wins = daily.filter(x => x > 0);
  return {
    variant: job.variant, rung: job.rung, k: job.k, lossMax: job.lossMax, lossTarget: job.lossTarget,
    days: days.length, total: Math.round(total), avgDaily: Math.round(total / days.length),
    median: Math.round(sorted[Math.floor(days.length / 2)]),
    worst: Math.round(sorted[0]), best: Math.round(sorted[sorted.length - 1]),
    daysUnder1k: daily.filter(x => x <= -1000).length,
    daysUnder2k: daily.filter(x => x <= -2000).length,
    daysUnder5k: daily.filter(x => x <= -5000).length,
    negDays: daily.filter(x => x < 0).length,
    winRate: Math.round(wins.length / days.length * 100),
    maxDD: -Math.round(mdd), ddSpanDays: ddDays,
    retDD: mdd ? Math.round(total / mdd * 10) / 10 : null,
    opens: Math.round(res.reduce((a, r) => a + r.opens, 0) / days.length * 100) / 100,
    coverFillRate: (filled + naked) ? Math.round(filled / (filled + naked) * 1000) / 10 : null,
    coverPending: res.reduce((a, r) => a + r.coverPending, 0),
    worstHeldFloor: Math.round(Math.min(...res.map(r => r.governor.worstFloor))),
    capExceeded: daily.filter(x => x < -job.lossMax).length,
    opensBlocked: res.reduce((a, r) => a + r.governor.blocked, 0),
    offsets: res.reduce((a, r) => a + r.governor.offsets, 0),
    floorRaisePerDay: res[0] && res[0].floorRaise ? Math.round(res.reduce((a, r) => a + r.floorRaise.count, 0) / days.length * 100) / 100 : null,
    floorRaiseSpentPerDay: res[0] && res[0].floorRaise ? Math.round(res.reduce((a, r) => a + r.floorRaise.spent, 0) / days.length) : null,
    floorRaiseBlockedLocked: res[0] && res[0].floorRaise ? res.reduce((a, r) => a + r.floorRaise.blockedLocked, 0) : null,
    // FLOOR METRICS — what a floor-raising feature is FOR (the user, 2026-10-06: drawdown/worst days belong to
    // the caps; floor raising is judged on the floor). From the engine's lock telemetry and the closing
    // book's risk-curve extremes, over days that traded. (r.floor is realized covered P&L, NOT the book
    // floor — an earlier 'lockedDays' column read it by mistake.)
    ...(() => {
      const t = res.filter((r) => r.lock && r.lock.traded);
      const n = Math.max(1, t.length);
      const ef = t.map((r) => r.lock.endBookFloor).sort((a, b) => a - b);
      const mean = (f) => Math.round(t.reduce((a, r) => a + f(r), 0) / n);
      return {
        tradedDays: t.length,
        eodFloorAvg: mean((r) => r.lock.endBookFloor),
        eodFloorMedian: ef.length ? ef[Math.floor(ef.length / 2)] : null,
        eodLockedPct: Math.round(t.filter((r) => r.lock.endFloorNoLoss).length / n * 1000) / 10,
        eodProfitPct: Math.round(t.filter((r) => r.lock.endFloorProfit).length / n * 1000) / 10,
        bestFloorAvg: mean((r) => (r.lock.bestFloor != null ? r.lock.bestFloor : 0)),
        everLockedPct: Math.round(t.filter((r) => r.lock.everPositive).length / n * 1000) / 10,
        eodPeakAvg: mean((r) => r.bestCase || 0),
        eodRangeAvg: mean((r) => (r.bestCase || 0) - (r.worstCase || 0)),
      };
    })(),
    giveUpPosPerDay: Math.round(res.reduce((a, r) => a + (r.giveUpPos || 0), 0) / days.length * 100) / 100,
    stallFiresPerDay: Math.round(res.reduce((a, r) => a + (r.stallFires || 0), 0) / days.length * 100) / 100,
    nearCapPassesPerDay: Math.round(res.reduce((a, r) => a + ((r.floorRaise && r.floorRaise.nearCapPasses) || 0), 0) / days.length * 100) / 100,
    raiseTrendBlockedPerDay: Math.round(res.reduce((a, r) => a + ((r.floorRaise && r.floorRaise.trendBlocked) || 0), 0) / days.length * 100) / 100,
    giveUpTrendFiresPerDay: Math.round(res.reduce((a, r) => a + (r.giveUpTrendFires || 0), 0) / days.length * 100) / 100,
    openTrendBlockedPerDay: Math.round(res.reduce((a, r) => a + (r.openTrendBlocked || 0), 0) / days.length * 100) / 100,
    giveUpCoveredPerDay: Math.round(res.reduce((a, r) => a + (r.giveUpCovered || 0), 0) / days.length * 100) / 100,
    giveUpsPerDay: Math.round(res.reduce((a, r) => a + (r.giveUps || 0), 0) / days.length * 100) / 100,
    nakedPerDay: Math.round(res.reduce((a, r) => a + (r.naked || 0), 0) / days.length * 100) / 100,
    skipPendingPerDay: res[0] && res[0].openLadder ? Math.round(res.reduce((a, r) => a + (r.openLadder.skipPending || 0), 0) / days.length * 100) / 100 : null,
    restruckPerDay: res[0] && res[0].openLadder ? Math.round(res.reduce((a, r) => a + (r.openLadder.restruck || 0), 0) / days.length * 100) / 100 : null,
    stalePerDay: res[0] && res[0].openLadder ? Math.round(res.reduce((a, r) => a + (r.openLadder.stale || 0), 0) / days.length * 100) / 100 : null,
    openFillRate: res[0] && res[0].openLadder ? Math.round(res.reduce((a, r) => a + r.openLadder.filled, 0) / Math.max(1, res.reduce((a, r) => a + r.openLadder.placed, 0)) * 1000) / 10 : null,
    ...openStats,
  };
}

if (SLICE != null) {
  const mine = JOBS.filter((_, i) => i % SLICE_OF === SLICE);
  const out = [];
  for (const j of mine) { out.push(measure(j)); process.stderr.write(`  [w${SLICE}] ${j.variant} @ ${j.rung}\n`); }
  fs.writeFileSync(SLICE_OUT, JSON.stringify(out), 'utf8');
  process.exit(0);
}

(async () => {
  console.log(`LOSS-CAP SWEEP — ${RUNS.length} governed variants × ${JOBS.length} jobs over ${days.length} trading days (${allDays.length - days.length} non-trading excluded)`);
  console.log(`  dates ${days[0].date} .. ${days[days.length - 1].date} · rungs ${RUNGS.join(', ')} × W×100 (+ current) · ${WORKERS} workers · opens ${OPEN_FILL || 'immediate'} · fill-through ${FILL_THRU || 0} tick(s) (open ${FILL_THRU_OPEN != null ? FILL_THRU_OPEN : '='}, cover ${FILL_THRU_COVER != null ? FILL_THRU_COVER : '='})`);
  let rows = [];
  if (WORKERS > 1) {
    const { spawn } = require('child_process');
    const base = process.argv.slice(2).filter((a, i, arr) => a !== '--workers' && arr[i - 1] !== '--workers');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loss-cap-sweep-'));
    try {
      await Promise.all(Array.from({ length: WORKERS }, (_, k) => new Promise((resolve, reject) => {
        const f = path.join(tmp, `slice-${k}.json`);
        const ch = spawn(process.execPath, [__filename, ...base, '--_slice', String(k), String(WORKERS), '--_out', f], { stdio: ['ignore', 'inherit', 'inherit'] });
        ch.on('error', reject);
        ch.on('close', (code) => {
          if (code !== 0) return reject(new Error(`worker ${k} exited ${code}`));
          rows = rows.concat(JSON.parse(fs.readFileSync(f, 'utf8')));
          resolve();
        });
      })));
    } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} }
  } else {
    for (const j of JOBS) rows.push(measure(j));
  }
  // canonical order: roster order, then cap descending
  const order = new Map(RUNS.map((r, i) => [r.variant, i]));
  rows.sort((a, b) => (order.get(a.variant) - order.get(b.variant)) || (b.lossMax - a.lossMax) || ((a.capFrac || 0) - (b.capFrac || 0)));
  fs.mkdirSync(OUTDIR, { recursive: true });
  fs.writeFileSync(path.join(OUTDIR, 'loss-cap-sweep.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), days: days.length, from: days[0].date, to: days[days.length - 1].date, rows }, null, 1), 'utf8');
  const cols = Object.keys(rows[0]);
  fs.writeFileSync(path.join(OUTDIR, 'loss-cap-sweep.csv'),
    [cols.join(','), ...rows.map(r => cols.map(c => r[c]).join(','))].join('\n') + '\n', 'utf8');
  const usd = n => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');
  console.log('\n' + 'variant'.padEnd(14) + 'cap'.padEnd(9) + 'total'.padEnd(12) + 'worst'.padEnd(10) + 'maxDD'.padEnd(11) + 'ret/DD'.padEnd(8) + '<-1k'.padEnd(6) + '<-2k'.padEnd(6) + 'opens'.padEnd(8) + 'fill%');
  for (const r of rows) console.log(r.variant.padEnd(14) + usd(-r.lossMax).padEnd(9) + usd(r.total).padEnd(12) + usd(r.worst).padEnd(10) + usd(r.maxDD).padEnd(11) + String(r.retDD).padEnd(8) + String(r.daysUnder1k).padEnd(6) + String(r.daysUnder2k).padEnd(6) + String(r.opens).padEnd(8) + r.coverFillRate);
  console.log(`\nwrote ${path.join(OUTDIR, 'loss-cap-sweep.csv')}`);
})();
