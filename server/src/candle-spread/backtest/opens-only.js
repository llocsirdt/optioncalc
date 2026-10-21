'use strict';
/**
 * OPENS-ONLY engine opts (v20 / v21 BB-fade, 2026-10-21, BACKTEST ONLY; nothing calls this unless a sweep asks).
 *
 * User (2026-10-21): v20/v21 carry NO v9/v7 machinery. Every open is held to expiry and settles at the NDX close.
 * No covers of any kind (signal covers, continuous / plateau tent, give-up, cover ladder, stall, proactive, c2o,
 * cover-to-stack locks), no hedges (floor raise, wings, offsets, flies), no late-floor / ratchet gates.
 * KEPT: the risk cap (governor lossMax on the projected book floor; dropped on the -unc twin), the open walk ladder
 * (one working open, walked up to the ceiling, cancelled on a reversal, re-struck after openRestrikeMin at the cap),
 * the placement rules (geometry, open fallback, never-start-OTM) and the leg-uniqueness ledger.
 *
 * Built as a WHITELIST over optsFor()'s output: anything not listed is absent, i.e. off at the engine default. Two
 * engine defaults are ON when unset and are switched off explicitly: cover-to-stack (governed path locks deep winners
 * unless coverToStack === false) and the per-position cover paths (perPositionCovers === false).
 */
const KEEP = ['rthActionOnly', 'trackCapital', 'intradayIV', 'ivSkew', 'bidirectional', 'geo', 'orderSlipTicks', 'priceOf',
  'openFillModel', 'subBarFill', 'openLadder', 'openLadderStepDollars', 'openWalkCapFrac', 'openRestrikeMin', 'openRestrikeReplace',
  'openRestrikeReplaceMax', 'openFallbackUntilMin', 'openFallbackBull', 'openFallbackBear', 'openFallbackOpenUntilMin',
  // the open walk is paced by the shared ladder clock (ladderStepSeconds / Points / Dollars); coverLadder itself is NOT kept
  'ladderStepSeconds', 'ladderStepPoints', 'ladderSteps', 'ladderStepDollars',
  'enforceLegUniqueness', 'legMaxShift', 'legMaxWing', 'openNeverOtm', 'firstActionMin', 'fillThroughTicks', 'fillThroughTicksOpen'];

// o = optsFor(v9 run, env). capped=false -> the -unc twin (no governor). Returns new opts; o is not mutated.
function opensOnlyOpts(o, { capped = true } = {}) {
  const out = {};
  for (const k of KEEP) if (o[k] !== undefined) out[k] = o[k];
  out.perPositionCovers = false;
  out.coverToStack = false;
  if (capped && o.lossMax != null && o.lossMax < Infinity) out.lossMax = o.lossMax;   // no lossTarget -> no reduce-risk actions
  return out;
}

// Every gate that can stop a qualifying signal from becoming a placed open, and its state under opensOnlyOpts.
function guardsFor(out) {
  return [
    ['action window 09:30-15:55 ET (rthActionOnly)', !!out.rthActionOnly],
    ['one working open at a time (open ladder: a signal while an open works is skipped)', out.openFillModel === 'ladder'],
    ['working open cancelled by an opposite-side signal', out.openFillModel === 'ladder'],
    ['risk cap: governor lossMax on the projected book floor (incl. the working open)', out.lossMax != null],
    ['risk cap on the ladder WALK (a price step that takes the floor through lossMax is refused)', out.lossMax != null],
    ['leg-uniqueness ledger (twin / shift / skip a conflicting open)', !!out.enforceLegUniqueness],
    ['placement decline (no strikes inside the price band) -> open fallback until 15:55', !!(out.geo && out.geo.adaptive)],
    ['never start fully OTM (openNeverOtm)', !!out.openNeverOtm],
    ['direction stance (one side at a time) — off because bidirectional', !out.bidirectional],
    ['riskCap / softCap / hardCap / capitalCeiling', false], ['floor ratchet', false], ['late-day floor guard', false],
    ['openCutoffMin / openFloorGate / noAddUnderwater', false], ['cover-to-open wait', false], ['stack gate / open trend block / touch filter', false],
  ];
}

module.exports = { opensOnlyOpts, guardsFor, KEEP };
