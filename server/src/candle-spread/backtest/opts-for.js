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
  }
  // COVER LADDER: walk a resting cover's price up in steps as it goes stale, instead of leaving it parked
  // at the original target. Shipped live 2026-09-10 in the same batch as give-up, and likewise absent from
  // the 2026-09-09 CSV — the contract guard caught it on the first regeneration after the fact.
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
  o.geo = v.adaptiveGeo
    ? makeAdaptiveGeo({ width: w || 20, incr: 10, maxDebitFrac: cf != null ? cf : 0.65, maxItmStrikes: v.maxItmStrikes != null ? v.maxItmStrikes : 3 })
    : makeGeo({ width: w || 20, shift: sh, capFrac: cf != null ? cf : undefined });
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
    ['capitalRecapture', 'openAlternateEvery', 'creditCoverFrac', 'coverToStackMinFrac']
      .concat(noWings ? WING_KEYS : []));
  return o;
}

module.exports = { optsFor };
