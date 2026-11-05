'use strict';
/**
 * OPENS-ONLY engine opts (v20 / v21 BB-fade, 2026-10-21). Since 2026-10-23 the rostered v20 / v21 (SIMULATE-ONLY live
 * runs) are built here too (opensOnlyVariant), and backtest/opts-for.js applies opensOnlyOpts to any variant carrying
 * `opensOnly`, so the live roster, the baselines and the sweep share ONE definition of what an opens-only run keeps.
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
  // THE OPEN WALK IS KEPT, so its switch must survive the whitelist. The engine walks an open when opts.openLadder is
  // set, else when opts.coverLadder is (runDay5m `openWalk`), and coverLadder — a cover feature — is rightly stripped
  // above. The 2026-10-21 opens-only run had exactly that hole: the ladder clock was kept but the walk was OFF, so no
  // open was ever walked (walk/d 0 in its table). Fixed 2026-10-23 with the live port: the parent's effective walk is
  // carried over explicitly.
  out.openLadder = o.openLadder != null ? o.openLadder === true : o.coverLadder === true;
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

// ── LIVE ROSTER CONFIG (2026-10-23) ──────────────────────────────────────────────────────────────────────────────
// The rostered opens-only variant, built from a FINISHED parent roster variant (v9-W / v9-W-cATM, after every builder
// and applyExperiments). The roster-level counterpart of KEEP: only the fields that produce a kept engine opt (or are
// the live mark path's fill realism) are carried over; everything else is ABSENT, and the four BASE_RUNS defaults that
// switch machinery ON for every run are switched OFF explicitly (buildRuns merges BASE_RUNS under each variant):
// capital recapture, the governor's lossTarget + floor offsets, cover-to-stack and continuous covering.
const ROSTER_KEEP = [
  // placement (backtest: geo)
  'spreadWidth', 'spreadShift', 'adaptiveGeo', 'maxItmStrikes', 'capFrac', 'minDebitFrac', 'maxOtmStrikes', 'openOverCapBelow', 'orderSlipTicks',
  // open ladder (walk cap, re-strike, fallback, clock)
  'openLadderStepDollars', 'openWalkCapFrac', 'openRestrikeMin', 'openRestrikeReplace', 'openRestrikeReplaceMax',
  'openFallbackUntilMin', 'openFallbackBull', 'openFallbackBear', 'openFallbackOpenUntilMin',
  'ladderStepSeconds', 'ladderStepPoints', 'ladderSteps', 'ladderStepDollars',
  'bidirectional', 'firstActionMin', 'lossMax',
  // live mark-path fill realism (simulated fills only; the backtest's counterpart is its open fill model)
  'simOpenFillMinLooks', 'simFillAtLimit',
  // the cover plumbing names (inert: an opens-only run never places a cover)
  'coverSelector', 'coverFillModel',
];
const ROSTER_OFF = { capitalRecapture: false, openAlternateEvery: null, creditCoverFrac: null,
  lossTarget: null, floorOffset: false, coverToStack: false, coverToStackMinFrac: null, continuousCover: false };

// parent: finished roster variant. capped=false -> the -unc twin (no lossMax). extra: per-family fields (v21's price
// target). signalFn: the shared fade (bb-fade.OPENS_ONLY_SIGNAL), passed in so this module stays free of signal code.
function opensOnlyVariant(parent, { name, label, capped = true, signalFn, extra = {} }) {
  const v = { variant: name, variantLabel: label, signalFn, signalCfg: { fiveMin: true } };
  for (const k of ROSTER_KEEP) {
    if (parent[k] === undefined) continue;
    v[k] = Array.isArray(parent[k]) ? parent[k].slice() : parent[k];
  }
  // the parent's EFFECTIVE open walk (trader.resolvePendingOpen: openLadder, else coverLadder), made explicit
  v.openLadder = parent.openLadder != null ? parent.openLadder === true : parent.coverLadder === true;
  Object.assign(v, ROSTER_OFF);
  if (!capped) { v.lossMax = null; v.softCap = null; v.hardCap = null; v.riskCap = null; }
  v.opensOnly = true;
  // SIMULATE-ONLY: never armed, never test (index.js: effectiveDryRun / applyArmedSelection / armableReason / deps).
  v.simulateOnly = true;
  v.dryRun = true;
  return Object.assign(v, extra);
}

module.exports = { opensOnlyOpts, guardsFor, KEEP, ROSTER_KEEP, ROSTER_OFF, opensOnlyVariant };
