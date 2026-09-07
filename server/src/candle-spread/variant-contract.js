'use strict';
/**
 * VARIANT CONTRACT — fail loudly when a consumer silently drops a variant capability.
 *
 * The variant config in index.js is the single source of truth, but every consumer re-enumerates it BY
 * HAND: the live `deps` object, and each analysis script's optsFor. None of them fail when a newly added
 * field is missing from the list — the feature just quietly does nothing. That has now happened four times
 * in one day: floorOffset never reached live, two cover-arming flags never reached `deps`, exemptTrendStack
 * was dropped by a sweep, and all eleven wing flags were dropped by the baselines builder. Each looked like
 * a clean null result until the output turned out byte-identical to the control.
 *
 * assertForwarded() closes that: given a variant and the set of keys a consumer forwards, it throws naming
 * anything unaccounted for. A new capability therefore breaks the build the first time it is added, rather
 * than silently measuring nothing.
 */

// Fields that legitimately never reach the engine as opts — identity, plumbing, or handled by other means.
const NOT_ENGINE_OPTS = new Set([
  'variant', 'variantLabel', 'label', 'key', 'symbol', 'expiration', 'dryRun', 'quantity',
  'signalFn', 'signalCfg', 'testAtBase',            // signal is passed as a function, not an opt
  // signalSymbol/signalRth select the LIVE data source (/NQ 24h for signals, NDX for pricing). A backtest
  // dataset already carries both series, so the split is baked into the data rather than passed as an opt.
  'signalSymbol', 'signalRth',
  'coverTiming',                                    // parked placeholder; 'on-reversal' is the only implemented value
  'strikeIncrement', 'tickIncrement', 'snapshotStrikes', 'captureChain', 'coverStyle', 'coverFillModel',
  'spreadWidth', 'spreadShift', 'capFrac', 'adaptiveGeo', 'maxItmStrikes',   // consumed by the geo builder
  'comboOrders', 'comboSlip',                       // live order shape, no backtest equivalent
]);

/**
 * @param variant   one entry from buildRuns()
 * @param forwarded iterable of keys the consumer passes on (Object.keys of its opts/deps object)
 * @param where     label for the error message, e.g. 'build-backtest-baselines optsFor'
 * @param extraOk   consumer-specific keys handled under a different name (e.g. capitalRecapture ->
 *                  recaptureAlternate), which are accounted for but not literally forwarded
 */
function assertForwarded(variant, forwarded, where, extraOk) {
  const seen = new Set(forwarded);
  const ok = new Set(extraOk || []);
  const missing = [];
  for (const k of Object.keys(variant)) {
    if (variant[k] == null || variant[k] === false) continue;   // unset fields cannot be dropped
    if (NOT_ENGINE_OPTS.has(k) || seen.has(k) || ok.has(k)) continue;
    missing.push(k);
  }
  if (missing.length) {
    throw new Error(`${where}: variant ${variant.variant} carries ${missing.length} field(s) that are not `
      + `forwarded to the engine: ${missing.join(', ')}. Add them to the consumer, or to NOT_ENGINE_OPTS / `
      + `extraOk if they genuinely do not belong. Silently dropping them makes the feature a no-op.`);
  }
}

module.exports = { assertForwarded, NOT_ENGINE_OPTS };
