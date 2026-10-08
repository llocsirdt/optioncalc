'use strict';
/**
 * opts-for.js — the ONE mapping from a variant config to backtest engine opts.
 *
 * WHY THIS IS A MODULE. Every consumer of the roster used to re-enumerate this mapping BY HAND:
 * build-backtest-baselines, run-day-record, backtest-replay, reconcile-day, and a half-dozen sweep
 * scripts. Nothing makes them agree, so they drift, and a dropped field is a SILENT no-op — the feature
 * simply does nothing while the output still looks plausible. That has now bitten repeatedly:
 * floorOffset never reached live, two cover-arming flags never reached deps, eleven wing flags were
 * dropped by the baselines builder, the seven FLY flags were missing from run-day-record for two days
 * (every fly variant answered HTTP 500 on the on-demand endpoint), and the three floor-ratchet fields
 * broke the baselines build the hour they were added.
 *
 * VC.assertForwarded catches a dropped field only where someone remembered to call it. Sharing the
 * mapping removes the drift itself: add a capability here once and every consumer gets it.
 *
 * The two environment-dependent bits are explicit parameters rather than captured module state, because
 * that capture is what made the function impossible to import in the first place:
 *   intradayIV — reprice every leg with the calibrated time-of-day IV multiplier (canonical: on)
 *   hasPx      — the dataset carries a separate pricing series (NQ signals / NDX pricing), so priceOf
 *                must read it. FOUNDATIONAL: see feedback_nq_signals_ndx_pricing.
 *   where      — label used in the contract-guard error, so the message names the CALLER
 *   noWings    — build the WINGS-OFF control (--noWings). Wings are on for every variant, so the control
 *                has to be produced by stripping them here rather than by a variant that lacks them.
 */
const { makeGeo, makeAdaptiveGeo } = require('./backtest-width');
const VC = require('../variant-contract');

function optsFor(v, env) {
  const { intradayIV = true, hasPx = true, noWings = false } = env || {};
  // trackCapital: pure cash accounting (peakReal/avgReal); it never touches terminal/floor, so the graded
  // P&L stays byte-identical — it just populates the capital object for the deployed-capital metrics.
  const o = { rthActionOnly: true, trackCapital: true };
  if (intradayIV) o.intradayIV = true;   // canonical: reprice every leg with the calibrated time-of-day IV mult
  if (v.ivSkew) o.ivSkew = true;          // canonical: per-leg moneyness (smile) correction on top of it
  if (v.bidirectional) o.bidirectional = true;
  // DAY-LOSS GOVERNOR: lossTarget/lossMax bound the BOOK FLOOR (the day's true max loss); floorOffset
  // enables the low-cost risk-offsetting buys. The `-unc` twins null these out → ungoverned.
  for (const k of ['riskCap', 'softCap', 'hardCap', 'capitalCeiling', 'proactiveCoverFrac', 'lossTarget', 'lossMax']) if (v[k] != null) o[k] = v[k];
  if (v.floorOffset) o.floorOffset = true;
  // FLOOR RATCHET: caps the RETREAT from the day's peak floor, which the governor above cannot see
  // (lossMax bounds the absolute floor, not the give-back). Gates OPENS only.
  if (v.floorRatchet) o.floorRatchet = true;
  for (const k of ['floorGiveBackFrac', 'floorRatchetMinPeak']) if (v[k] != null) o[k] = v[k];
  // CONTINUOUS COVERING: a standing resting cover on every position at its profit-locking price. Not a
  // risk cap — it applies to the `-unc` twins too, so those isolate the CAPS rather than the policy.
  if (v.continuousCover) o.continuousCover = true;
  if (v.continuousCoverMinLockFrac != null) o.continuousCoverMinLockFrac = v.continuousCoverMinLockFrac;
  // CAPITAL TRIGGER — credit orders fire to RECLAIM deployed capital rather than on a counter
  // (openAlternateEvery) or a depth (creditCoverFrac). Added to the live deps and the backtest engine in
  // c6e9c24 but NOT here, which took the whole on-demand backtest endpoint down with a 500: the variant
  // contract refuses to run a variant carrying a field the consumer would silently drop. The guard was
  // right — dropping it would have made every on-demand backtest model a DIFFERENT credit policy than the
  // live engine trades, under the same variant name.
  if (v.creditCapitalTrigger != null) o.creditCapitalTrigger = v.creditCapitalTrigger;
  // Cover POLICY (when to arm) + GEOMETRY (where the offsetting spread sits) — the v0-v3 axis.
  if (v.coverGeometry) o.coverGeometry = v.coverGeometry;
  if (v.continuousCoverArmFrac != null) o.continuousCoverArmFrac = v.continuousCoverArmFrac;
  if (v.continuousCoverOppRatio != null) o.continuousCoverOppRatio = v.continuousCoverOppRatio;
  // WING CONVERSION (peak->floor). Enumerated like everything else here, which is precisely why enabling
  // it on 20 variants produced BYTE-IDENTICAL baselines until these lines existed — the variant config
  // said wingConvert:true and nothing carried it into the engine.
  if (v.wingConvert) o.wingConvert = true;
  // FLY / CONDOR VALLEY REPAIR — the backtest has always had opts.flyConvert; until 2026-09-14 no variant
  // set it, so it was dormant. Now that variants declare it, it has to be carried in here or the contract
  // guard (correctly) refuses the build rather than let the feature be a silent no-op.
  if (v.flyConvert) o.flyConvert = true;
  for (const k of ['flyMinRatio', 'flyBandSig', 'flyBudget', 'flyMaxPerDay', 'flyWidths', 'flyCondors', 'flyAfterMin', 'flyBeforeMin']) {
    if (v[k] != null) o[k] = v[k];
  }
  for (const k of ['wingMinRatio', 'wingAfterMin', 'wingBudgetFrac', 'wingBudget', 'wingMaxPerDay',
    'wingBandSigmas', 'wingOutSteps', 'wingUpsideLambda', 'wingTailSigmas']) if (v[k] != null) o[k] = v[k];
  if (v.wingNaked) o.wingNaked = true;
  if (v.lockCoverMode) o.lockCoverMode = v.lockCoverMode;
  if (v.exemptTrendStack) o.exemptTrendStack = true;
  if (v.coverSelector) o.coverSelector = v.coverSelector;
  if (v.coverToStack) { o.coverToStack = true; o.coverToStackVsRisk = true; if (v.coverToStackMinFrac != null) o.coverToStackMinFrac = v.coverToStackMinFrac; }
  // capital-recapture cash is P&L-neutral (parity), but its debit/credit ALTERNATION spreads legs across
  // both ladders, so under leg-uniqueness it changes which opens shift/skip → must be modeled to match live.
  if (v.capitalRecapture) { o.recaptureAlternate = true; if (v.openAlternateEvery != null) o.openAlternateEvery = v.openAlternateEvery; if (v.creditCoverFrac != null) o.creditCoverFrac = v.creditCoverFrac; }
  if (v.openNeverOtm) o.openNeverOtm = true;
  // COVER GIVE-UP: once the underlying has run `giveUpPoints` through the short strike, stop asking for the
  // profit-lock price and take the exit at a capped loss (`giveUpMaxLoss` x width). Shipped live 2026-09-10,
  // one day AFTER the committed baselines were last generated — so the CSV never carried it and the
  // contract guard had nothing to catch, since the variants did not yet declare the field. Regenerating
  // without these lines would have thrown; that is the guard working.
  if (v.coverGiveUp) {
    o.coverGiveUp = true;
    if (v.giveUpPoints != null) o.giveUpPoints = v.giveUpPoints;
    if (v.giveUpMaxLoss != null) o.giveUpMaxLoss = v.giveUpMaxLoss;
    if (v.giveUpTrigger != null) o.giveUpTrigger = v.giveUpTrigger;   // 'points' | 'rev5' | 'rev5c' | 'rev15' | 'rev15c'
    if (v.giveUpTrend != null) o.giveUpTrend = v.giveUpTrend;   // trend-state definition: urgent cover when fighting it
  }
  if (v.openTrendBlock != null) o.openTrendBlock = v.openTrendBlock;   // backtest-only control arm (trend-state definition)
  if (v.stallCoverMin != null) o.stallCoverMin = v.stallCoverMin;       // backtest-only study: cover a stalled position at break-even
  if (v.stallCoverPts != null) o.stallCoverPts = v.stallCoverPts;
  for (const k of ['lateFloorAfterMin', 'lateFloorGiveW', 'lateFloorKeepLocked']) if (v[k] != null) o[k] = v[k];   // late-day floor guard (live: trader.lateFloorLimit)
  // COVER LADDER: walk a resting cover's price up in steps as it goes stale, instead of leaving it parked
  // at the original target. Shipped live 2026-09-10 in the same batch as give-up, and likewise absent from
  // the 2026-09-09 CSV — the contract guard caught it on the first regeneration after the fact.
  // OPEN FILL MODEL — 'ladder' models the live resting open (one working order, walked like the cover
  // ladder, cancelled on a reversal). Set by the CALLER (env), not the roster, until baselines adopt it.
  if (env && env.openFillModel) o.openFillModel = env.openFillModel;
  // FILL-THROUGH. The roster's coverFillThroughTicks (live mark path: a simulated cover needs the market a
  // tick THROUGH its price) is the backtest's fillThroughTicksCover — same rule, both engines. A caller's
  // env wins: a generic env.fillThroughTicks sets BOTH sides explicitly (the engine prefers the per-side
  // value, so leaving the roster's cover value in place would silently override a sweep's generic one).
  if (v.coverFillThroughTicks != null) o.fillThroughTicksCover = v.coverFillThroughTicks;
  if (v.simFillAtLimit != null) o.simFillAtLimit = v.simFillAtLimit;   // covers book AT their limit
  // A floor raise is a resting order everywhere a backtest models the live roster (no live analogue knob:
  // live hedges always rest). env.floorRaiseResting === false reproduces the instant-fill model.
  if (v.floorRaise) o.floorRaiseResting = !(env && env.floorRaiseResting === false);
  if (env && env.fillThroughTicks != null) {
    o.fillThroughTicks = env.fillThroughTicks;
    o.fillThroughTicksOpen = env.fillThroughTicks; o.fillThroughTicksCover = env.fillThroughTicks;
  }
  if (env && env.fillThroughTicksOpen != null) o.fillThroughTicksOpen = env.fillThroughTicksOpen;
  if (env && env.fillThroughTicksCover != null) o.fillThroughTicksCover = env.fillThroughTicksCover;
  if (v.openLadder != null) o.openLadder = v.openLadder;
  if (v.openLadderStepDollars != null) o.openLadderStepDollars = v.openLadderStepDollars;
  if (v.openWalkCapFrac != null) o.openWalkCapFrac = v.openWalkCapFrac;   // ladder walk limit, above the placement ceiling
  if (v.openRestrikeMin != null) o.openRestrikeMin = v.openRestrikeMin;   // re-strike timeout at the cap (minutes)
  if (env && env.openRestrikeMin != null) o.openRestrikeMin = env.openRestrikeMin;
  // FLOOR RAISE (backtest-v6-5m.js, opts.floorRaise): always-on near-money floor lifting.
  for (const k of ['floorRaise', 'floorRaiseBudgetFrac', 'floorRaiseMinRatio', 'floorRaiseSigmas', 'floorRaiseEveryBars',
    'floorRaiseMaxPerDay', 'floorRaiseSlipTicks', 'floorRaiseAfterMin', 'floorRaiseObjective', 'floorRaiseMinRatioFar', 'floorRaiseFarSigmas', 'floorRaiseLiftMetric',
    'floorRaiseTrend', 'floorRaiseTrendPermit', 'floorRaiseNearCapFrac', 'floorRaiseNearCapRatio']) if (v[k] != null) o[k] = v[k];
  if (v.coverLadder) {
    o.coverLadder = true;
    for (const k of ['ladderStepSeconds', 'ladderStepPoints', 'ladderSteps', 'ladderLossCapFrac',
      'ladderStepDollars']) if (v[k] != null) o[k] = v[k];
  }
  // DYNAMIC minLock RAMP — paired with the tight day-loss cap on the capital-preservation variant (see
  // CAPPRES_LIVE in index.js). Only pays under that cap, so it is a per-variant pairing, not a default.
  if (v.minLockRamp) {
    o.minLockRamp = true;
    for (const k of ['minLockRampStart', 'minLockRampEnd', 'minLockRampFrom', 'minLockRampTo']) if (v[k] != null) o[k] = v[k];
  }
  if (v.enforceLegUniqueness) { o.enforceLegUniqueness = true; if (v.legMaxShift != null) o.legMaxShift = v.legMaxShift; if (v.legMaxWing != null) o.legMaxWing = v.legMaxWing; }
  const w = v.spreadWidth, sh = v.spreadShift || 0, cf = v.capFrac;
  // ALWAYS build the geo explicitly. This used to be conditional ((w && w !== 20) || sh || cf != null),
  // so a $20 shift-0 capFrac-unset variant — i.e. every `-20-cATM` — silently fell through to the base
  // engine's own buildOpen instead of makeGeo, and quietly missed geometry changes made here. The two are
  // numerically identical for that case; passing it explicitly keeps them from drifting apart again.
  // ADAPTIVE PLACEMENT is the shipped default: walk to the most ITM placement still inside the
  // ceiling instead of always taking one fixed offset. `-cATM` controls keep the fixed geometry.
  // ORDER SLIP — mirrors trader.buildOpenAtStrikes: ceil the mark to the tick, then pay `orderSlipTicks`
  // over it, bounded by the ceiling. `env.orderSlipTicks` lets a SWEEP set it for every variant at once
  // without touching the roster; a per-variant value wins. Absent on both = this engine's historical
  // rounding, so every committed baseline still reproduces exactly.
  // Default 0 = THE LIVE RULE (ceil the mark, add nothing), adopted as the baseline 2026-09-24.
  // `env.legacyRounding` restores the pre-adoption rounding for reproducing a historical baseline.
  const slip = v.orderSlipTicks != null ? v.orderSlipTicks
    : (env && env.orderSlipTicks != null) ? env.orderSlipTicks
    : (env && env.legacyRounding === true) ? null : 0;
  o.geo = v.adaptiveGeo
    ? makeAdaptiveGeo({ width: w || 20, incr: 10, maxDebitFrac: cf != null ? cf : 0.65, maxItmStrikes: v.maxItmStrikes != null ? v.maxItmStrikes : 3, orderSlipTicks: slip, minDebitFrac: v.minDebitFrac || 0, maxOtmStrikes: v.maxOtmStrikes || 0 })
    : makeGeo({ width: w || 20, shift: sh, capFrac: cf != null ? cf : undefined, orderSlipTicks: slip, minDebitFrac: v.minDebitFrac || 0 });
  o.orderSlipTicks = slip;   // recorded on the run so a result can say what produced it (null = legacy)
  // FOUNDATIONAL: signals from /NQ, pricing and settlement from cash NDX. A dataset carrying an NDX price
  // series (`px`) MUST be priced off it — otherwise runDay5m falls back to the SIGNAL series and the run
  // silently prices NDX options off NQ. Set from the data, so it cannot be forgotten per-dataset.
  if (hasPx) o.priceOf = (b) => b.px || { close: b.analysis['5m'].close, high: b.analysis['5m'].high, low: b.analysis['5m'].low };
  // Fail loudly if this variant carries a capability optsFor does not forward — the failure mode that made
  // wings, floorOffset and exemptTrendStack silent no-ops. extraOk lists fields handled under another name.
  // In the wings-off control the wing flags are deliberately NOT forwarded; declare that to the guard
  // rather than letting it pass silently, so the omission stays an explicit choice.
  const WING_KEYS = ['wingConvert', 'wingMinRatio', 'wingAfterMin', 'wingBudgetFrac', 'wingBudget',
    'wingMaxPerDay', 'wingBandSigmas', 'wingOutSteps', 'wingNaked', 'wingUpsideLambda', 'wingTailSigmas'];
  if (noWings) for (const k of WING_KEYS) delete o[k];
  VC.assertForwarded(v, Object.keys(o), `${(env && env.where) || 'optsFor'}`,
    ['capitalRecapture', 'openAlternateEvery', 'creditCoverFrac', 'coverToStackMinFrac',
      // coverFillThroughTicks -> fillThroughTicksCover (above). simOpenFillMinLooks has no backtest analogue
      // on purpose: the backtest's open models are bar-granular, and the ladder model already cannot fill
      // an open before the NEXT bar — stricter than "one more 30s look".
      'coverFillThroughTicks', 'simOpenFillMinLooks',
      // minDebitFrac is consumed by the geo builders above (a price floor under capFrac).
      'minDebitFrac', 'maxOtmStrikes']
      .concat(noWings ? WING_KEYS : []));
  return o;
}

module.exports = { optsFor };
