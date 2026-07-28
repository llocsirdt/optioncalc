/**
 * Pure strategy logic functions
 * These functions contain the core decision logic without side effects
 * Used by both production (position-manager) and backtest (backtest-controller)
 */

/**
 * Calculate BB Score for a single candle
 * Production inverts the score: negative when above middle, positive when below
 */
function calculateBBScore(currentClose, upperBand, middleBand, lowerBand) {
  if (upperBand === null || middleBand === null || lowerBand === null) {
    return 0;
  }
  
  const upperDistance = upperBand - middleBand;
  const lowerDistance = middleBand - lowerBand;
  
  if (upperDistance === 0 || lowerDistance === 0) {
    return 0;
  }
  
  if (currentClose >= middleBand) {
    const priceDistanceFromMiddle = currentClose - middleBand;
    const score = -(priceDistanceFromMiddle / upperDistance);
    return score;
  } else {
    const priceDistanceFromMiddle = middleBand - currentClose;
    const score = priceDistanceFromMiddle / lowerDistance;
    return score;
  }
}

/**
 * Check if we should open a position based on both 15m and 60m BB scores
 * Requires both timeframes to agree on direction
 * Returns: {action: 'open_bull'|'open_bear'|'none', bbScore15m, bbScore60m}
 */
function strategySimple15and60mBBScoreOpen(position = {}, analysis = {}) {
  // Support legacy callers (like backtests) that only pass analysis
  if (!analysis || typeof analysis !== 'object' || Object.keys(analysis).length === 0 || analysis['1m'] || analysis['5m'] || analysis['15m'] || analysis['60m']) {
    if (!analysis || typeof analysis !== 'object' || !analysis['15m']) {
      // Heuristic: if first arg looks like analysis and second is empty, swap
      const maybeAnalysis = position;
      const hasTimeframeKeys = maybeAnalysis && (maybeAnalysis['1m'] || maybeAnalysis['5m'] || maybeAnalysis['15m'] || maybeAnalysis['60m']);
      if (hasTimeframeKeys && (!analysis || Object.keys(analysis).length === 0)) {
        analysis = maybeAnalysis;
        position = {};
      }
    }
  }
  
  const bbScore15m = analysis['15m']?.bbScore;
  const bbScore60m = analysis['60m']?.bbScore;
  
  if (
    bbScore15m === null || bbScore15m === undefined ||
    bbScore60m === null || bbScore60m === undefined
  ) {
    return { action: 'none', bbScore15m: bbScore15m ?? null, bbScore60m: bbScore60m ?? null };
  }
  
  if (bbScore15m > 1 && bbScore60m > 1) {
    return { action: 'open_bull', bbScore15m, bbScore60m };
  } else if (bbScore15m < -1 && bbScore60m < -1) {
    return { action: 'open_bear', bbScore15m, bbScore60m };
  } else {
    return { action: 'none', bbScore15m, bbScore60m };
  }
}

/**
 * Check if we should open a position based on 5m BB score
 * Returns: {action: 'open_bull'|'open_bear'|'none', bbScore5m: value}
 */
function strategySimple5mBBScoreOpen(position = {}, analysis = {}) {
  // Support legacy callers (like backtests) that only pass analysis
  if (!analysis || typeof analysis !== 'object' || Object.keys(analysis).length === 0 || analysis['1m'] || analysis['5m'] || analysis['15m'] || analysis['60m']) {
    if (!analysis || typeof analysis !== 'object' || !analysis['5m']) {
      // Heuristic: if first arg looks like analysis and second is empty, swap
      const maybeAnalysis = position;
      const hasTimeframeKeys = maybeAnalysis && (maybeAnalysis['1m'] || maybeAnalysis['5m'] || maybeAnalysis['15m'] || maybeAnalysis['60m']);
      if (hasTimeframeKeys && (!analysis || Object.keys(analysis).length === 0)) {
        analysis = maybeAnalysis;
        position = {};
      }
    }
  }
  
  const bbScore5m = analysis['5m']?.bbScore;
  
  if (bbScore5m === null || bbScore5m === undefined) {
    return { action: 'none', bbScore5m: null };
  }
  
  if (bbScore5m > 1) {
    return { action: 'open_bull', bbScore5m };
  } else if (bbScore5m < -1) {
    return { action: 'open_bear', bbScore5m };
  } else {
    return { action: 'none', bbScore5m };
  }
}

/**
 * Check if we should open a position based on 15m BB score
 * Returns: {action: 'open_bull'|'open_bear'|'none', bbScore15m: value}
 */
function strategySimple15mBBScoreOpen(position = {}, analysis = {}) {
  // Support legacy callers (like backtests) that only pass analysis
  if (!analysis || typeof analysis !== 'object' || Object.keys(analysis).length === 0 || analysis['1m'] || analysis['5m'] || analysis['15m'] || analysis['60m']) {
    if (!analysis || typeof analysis !== 'object' || !analysis['15m']) {
      // Heuristic: if first arg looks like analysis and second is empty, swap
      const maybeAnalysis = position;
      const hasTimeframeKeys = maybeAnalysis && (maybeAnalysis['1m'] || maybeAnalysis['5m'] || maybeAnalysis['15m'] || maybeAnalysis['60m']);
      if (hasTimeframeKeys && (!analysis || Object.keys(analysis).length === 0)) {
        analysis = maybeAnalysis;
        position = {};
      }
    }
  }
  
  const bbScore15m = analysis['15m']?.bbScore;
  
  if (bbScore15m === null || bbScore15m === undefined) {
    return { action: 'none', bbScore15m: null };
  }
  
  if (bbScore15m > 1) {
    return { action: 'open_bull', bbScore15m };
  } else if (bbScore15m < -1) {
    return { action: 'open_bear', bbScore15m };
  } else {
    return { action: 'none', bbScore15m };
  }
}

/**
 * Check if we should cover an existing position based on 5m BB score
 * Opposite logic from opening:
 * - Bull position: cover when BB score < -1 (price moved above middle, exit)
 * - Bear position: cover when BB score > 1 (price moved below middle, exit)
 * Returns: {action: 'cover'|'hold', bbScore5m: value}
 */
function strategySimple5mBBScoreCover(position, analysis) {
  const bbScore5m = analysis['5m'].bbScore;
  
  if (bbScore5m === null || bbScore5m === undefined) {
    return { action: 'hold', bbScore5m: null };
  }
  
  if (position.type === 'bull') {
    // Bull position: cover when BB score < -1 (price moved above middle)
    if (bbScore5m < -1) {
      return { action: 'cover', bbScore5m };
    }
  } else if (position.type === 'bear') {
    // Bear position: cover when BB score > 1 (price moved below middle)
    if (bbScore5m > 1) {
      return { action: 'cover', bbScore5m };
    }
  }
  
  return { action: 'hold', bbScore5m };
}

/**
 * Check if we should cover an existing position based on 15m BB score
 * Opposite logic from opening:
 * - Bull position: cover when BB score < -1 (price moved above middle, exit)
 * - Bear position: cover when BB score > 1 (price moved below middle, exit)
 * Returns: {action: 'cover'|'hold', bbScore15m: value}
 */
function strategySimple15mBBScoreCover(position, analysis) {
  const bbScore15m = analysis['15m'].bbScore;
  
  if (bbScore15m === null || bbScore15m === undefined) {
    return { action: 'hold', bbScore15m: null };
  }
  
  if (position.type === 'bull') {
    // Bull position: cover when BB score < -1 (price moved above middle)
    if (bbScore15m < -1) {
      return { action: 'cover', bbScore15m };
    }
  } else if (position.type === 'bear') {
    // Bear position: cover when BB score > 1 (price moved below middle)
    if (bbScore15m > 1) {
      return { action: 'cover', bbScore15m };
    }
  }
  
  return { action: 'hold', bbScore15m };
}

/**
 * Check if we should cover based on both 15m and 60m BB scores
 * Returns: {action: 'cover'|'hold', bbScore15m, bbScore60m}
 */
function strategySimple15and60mBBScoreCover(position, analysis) {
  const bbScore15m = analysis['15m'].bbScore;
  const bbScore60m = analysis['60m'].bbScore;
  
  if (
    bbScore15m === null || bbScore15m === undefined ||
    bbScore60m === null || bbScore60m === undefined
  ) {
    return { action: 'hold', bbScore15m: bbScore15m ?? null, bbScore60m: bbScore60m ?? null };
  }
  
  if (position.type === 'bull') {
    if (bbScore15m < -1 && bbScore60m < -1) {
      return { action: 'cover', bbScore15m, bbScore60m };
    }
  } else if (position.type === 'bear') {
    if (bbScore15m > 1 && bbScore60m > 1) {
      return { action: 'cover', bbScore15m, bbScore60m };
    }
  }
  
  return { action: 'hold', bbScore15m, bbScore60m };
}

/**
 * Check if we should open a position based on 1m, 5m, and 15m signals
 * Uses both BB score and trend score for each timeframe
 */
function strategy1m5m15mOpen(position = {}, analysis = {}) {
  // Support legacy callers (like backtests) that only pass analysis
  if (!analysis || typeof analysis !== 'object' || Object.keys(analysis).length === 0 || analysis['1m'] || analysis['5m'] || analysis['15m'] || analysis['60m']) {
    if (!analysis || typeof analysis !== 'object' || !analysis['1m']) {
      // Heuristic: if first arg looks like analysis and second is empty, swap
      const maybeAnalysis = position;
      const hasTimeframeKeys = maybeAnalysis && (maybeAnalysis['1m'] || maybeAnalysis['5m'] || maybeAnalysis['15m'] || maybeAnalysis['60m']);
      if (hasTimeframeKeys && (!analysis || Object.keys(analysis).length === 0)) {
        analysis = maybeAnalysis;
        position = {};
      }
    }
  }
  
  const timeframes = ['1m', '5m', '15m', '60m'];
  const data = timeframes.map(tf => analysis[tf] || {});

  if (
    data.some(
      entry =>
        entry.bbScore === undefined ||
        entry.bbScore === null
    )
  ) {
    return { action: 'none', analysis: data };
  }

  const [oneMinute, fiveMinute, fifteenMinute, sixtyMinute] = data;
  const higherTimeframes = [fiveMinute, fifteenMinute, sixtyMinute];

  const anyHigherAboveOne = higherTimeframes.some(tf => tf.bbScore > .9);
  const anyHigherBelowNegativeOne = higherTimeframes.some(tf => tf.bbScore < -.9);

  const anyHigherAlmostTwo = higherTimeframes.some(tf => tf.bbScore > 1.8);
  const anyHigherAlmostNegativeTwo = higherTimeframes.some(tf => tf.bbScore < -1.8);

  const allDeltasNegative = [oneMinute, ...higherTimeframes].every(tf => tf.bbScoreDelta !== null && tf.bbScoreDelta !== undefined && tf.bbScoreDelta < -.1);
  const allDeltasPositive = [oneMinute, ...higherTimeframes].every(tf => tf.bbScoreDelta !== null && tf.bbScoreDelta !== undefined && tf.bbScoreDelta > .1);

  const bullish = anyHigherAlmostTwo || (anyHigherAboveOne || allDeltasNegative);
  const bearish = anyHigherAlmostNegativeTwo || (anyHigherBelowNegativeOne || allDeltasPositive);

  console.log(
    '[check1m5m15mOpen]',
    `1m bb=${oneMinute.bbScore?.toFixed?.(3) ?? oneMinute.bbScore} Δ=${oneMinute.bbScoreDelta?.toFixed?.(3) ?? oneMinute.bbScoreDelta}`,
    `5m bb=${fiveMinute.bbScore?.toFixed?.(3) ?? fiveMinute.bbScore} Δ=${fiveMinute.bbScoreDelta?.toFixed?.(3) ?? fiveMinute.bbScoreDelta}`,
    `15m bb=${fifteenMinute.bbScore?.toFixed?.(3) ?? fifteenMinute.bbScore} Δ=${fifteenMinute.bbScoreDelta?.toFixed?.(3) ?? fifteenMinute.bbScoreDelta}`,
    `60m bb=${sixtyMinute.bbScore?.toFixed?.(3) ?? sixtyMinute.bbScore} Δ=${sixtyMinute.bbScoreDelta?.toFixed?.(3) ?? sixtyMinute.bbScoreDelta}`,
    `| bullish=${bullish} bearish=${bearish}`
  );

  if (bullish) {
    return { action: 'open_bull', analysis: data };
  }
  if (bearish) {
    return { action: 'open_bear', analysis: data };
  }
  return { action: 'none', analysis: data };
}

/**
 * Check if we should cover an existing position based on 1m, 5m, and 15m signals
 */
function strategy1m5m15mCover(position, analysis) {
  const timeframes = ['1m', '5m', '15m', '60m'];
  const data = timeframes.map(tf => analysis[tf] || {});

  if (
    data.some(
      entry =>
        entry.bbScore === undefined ||
        entry.bbScore === null ||
        entry.bbScoreDelta === undefined ||
        entry.bbScoreDelta === null
    )
  ) {
    return { action: 'hold', analysis: data };
  }

  const [oneMinute, fiveMinute, fifteenMinute, sixtyMinute] = data;
  const allDeltasPositive = data.every(tf => tf.bbScoreDelta > .1);
  const allDeltasNegative = data.every(tf => tf.bbScoreDelta < -.1);

  console.log(
    `[check1m5m15mCover] position=${position.type}`,
    `1m bb=${oneMinute.bbScore?.toFixed?.(3) ?? oneMinute.bbScore} Δ=${oneMinute.bbScoreDelta?.toFixed?.(3) ?? oneMinute.bbScoreDelta}`,
    `5m bb=${fiveMinute.bbScore?.toFixed?.(3) ?? fiveMinute.bbScore} Δ=${fiveMinute.bbScoreDelta?.toFixed?.(3) ?? fiveMinute.bbScoreDelta}`,
    `15m bb=${fifteenMinute.bbScore?.toFixed?.(3) ?? fifteenMinute.bbScore} Δ=${fifteenMinute.bbScoreDelta?.toFixed?.(3) ?? fifteenMinute.bbScoreDelta}`,
    `60m bb=${sixtyMinute.bbScore?.toFixed?.(3) ?? sixtyMinute.bbScore} Δ=${sixtyMinute.bbScoreDelta?.toFixed?.(3) ?? sixtyMinute.bbScoreDelta}`
  );

  if (position.type === 'bull') {
    const coverBull = allDeltasPositive;
    console.log('[check1m5m15mCover] bull cover condition', { coverBull });
    if (coverBull) {
      return { action: 'cover', analysis: data };
    }
  } else if (position.type === 'bear') {
    const coverBear = allDeltasNegative;
    console.log('[check1m5m15mCover] bear cover condition', { coverBear });
    if (coverBear) {
      return { action: 'cover', analysis: data };
    }
  }

  return { action: 'hold', analysis: data };
}

/**
 * State strategy open logic with optional config-driven features.
 *
 * Features controlled by options.config (merged with DEFAULT_STATE_STRATEGY_CONFIG):
 * - open.minConfirmations: consecutive minutes where 1m and 5m bbScoreDelta agree with the open direction
 *   • Bull open requires delta1m < 0 and delta5m < 0 (price rising toward middle from below)
 *   • Bear open requires delta1m > 0 and delta5m > 0 (price falling toward middle from above)
 * - open.enableTrendGate: blocks counter-trend opens during strong 5m trends
 *   • Uses 5m trendScore vs open.strongTrendThreshold; allows override if
 *     open.allowCounterTrendIfExtreme && |bbScore5m| >= open.counterTrendExtremeBB5m
 * - positionPatches: persists _confirmBull/_confirmBear counters across minutes
 */
function strategyStateOpen(position = {}, analysis = {}, options = {}) {
  // Support legacy callers (like backtests) that only pass analysis
  if (!analysis || typeof analysis !== 'object' || Object.keys(analysis).length === 0 || analysis['1m'] || analysis['5m'] || analysis['15m'] || analysis['60m']) {
    if (!analysis || typeof analysis !== 'object' || !analysis['1m']) {
      // Heuristic: if first arg looks like analysis and second is empty, swap
      const maybeAnalysis = position;
      const hasTimeframeKeys = maybeAnalysis && (maybeAnalysis['1m'] || maybeAnalysis['5m'] || maybeAnalysis['15m'] || maybeAnalysis['60m']);
      if (hasTimeframeKeys && (!analysis || Object.keys(analysis).length === 0)) {
        analysis = maybeAnalysis;
        position = {};
      }
    }
  }

  const currentState = position.state || 'new';
  const currentBias = position.bias || 'neutral';
  let nextState = currentState;
  let nextBias = currentBias;

  const cfg = { ...DEFAULT_STATE_STRATEGY_CONFIG, ...(options.config || {}) };

  const higherTimeframes = ['5m', '15m', '60m'];
  const hasBullSignal = higherTimeframes.some(tf => (analysis[tf]?.bbScore ?? null) > 1);
  const hasBearSignal = higherTimeframes.some(tf => (analysis[tf]?.bbScore ?? null) < -1);

  if (currentState === 'new') {
    if (hasBullSignal) {
      nextState = 'ready_open_bull';
      nextBias = 'bullish';
      return { action: 'hold', nextState, nextBias, reason: 'high_tf_bull_signal' };
    }
    if (hasBearSignal) {
      nextState = 'ready_open_bear';
      nextBias = 'bearish';
      return { action: 'hold', nextState, nextBias, reason: 'high_tf_bear_signal' };
    }
  }

  if (currentState === 'ready_open_bull') {
    const delta1m = analysis['1m']?.bbScoreDelta;
    const delta5m = analysis['5m']?.bbScoreDelta;
    const ts5m = analysis['5m']?.trendScore;
    const bb5m = analysis['5m']?.bbScore;

    // Optional trend gate: block counter-trend bull entries in strong downtrend unless extreme BB context allows it
    if (cfg.open.enableTrendGate && typeof ts5m === 'number') {
      const strongCounterTrend = ts5m <= -Math.abs(cfg.open.strongTrendThreshold);
      const extremeOK = cfg.open.allowCounterTrendIfExtreme && typeof bb5m === 'number' && Math.abs(bb5m) >= cfg.open.counterTrendExtremeBB5m;
      if (strongCounterTrend && !extremeOK) {
        const patches = { _confirmBull: 0 };
        return { action: 'hold', nextState, nextBias, positionStateUpdates: patches, reason: 'trend_gate_block' };
      }
    }

    // Track consecutive confirmation minutes for bull entries (both deltas negative)
    let confirmBull = typeof position._confirmBull === 'number' ? position._confirmBull : 0;
    const match = (delta1m !== undefined && delta5m !== undefined && delta1m < 0 && delta5m < 0);
    confirmBull = match ? (confirmBull + 1) : 0;
    const need = Math.max(1, cfg.open.minConfirmations || 1);
    const patches = { _confirmBull: confirmBull };

    if (match && confirmBull >= need) {
      return {
        action: 'open_bull',
        nextState: 'open',
        nextBias: 'bullish',
        reason: 'short_tf_confirmation',
        // Reset both counters on open
        positionStateUpdates: { _confirmBull: 0, _confirmBear: 0 }
      };
    }
    return { action: 'hold', nextState, nextBias, positionStateUpdates: patches };
  }

  if (currentState === 'ready_open_bear') {
    const delta1m = analysis['1m']?.bbScoreDelta;
    const delta5m = analysis['5m']?.bbScoreDelta;
    const ts5m = analysis['5m']?.trendScore;
    const bb5m = analysis['5m']?.bbScore;

    // Optional trend gate: block counter-trend bear entries in strong uptrend unless extreme BB context allows it
    if (cfg.open.enableTrendGate && typeof ts5m === 'number') {
      const strongCounterTrend = ts5m >= Math.abs(cfg.open.strongTrendThreshold);
      const extremeOK = cfg.open.allowCounterTrendIfExtreme && typeof bb5m === 'number' && Math.abs(bb5m) >= cfg.open.counterTrendExtremeBB5m;
      if (strongCounterTrend && !extremeOK) {
        const patches = { _confirmBear: 0 };
        return { action: 'hold', nextState, nextBias, positionStateUpdates: patches, reason: 'trend_gate_block' };
      }
    }

    // Track consecutive confirmation minutes for bear entries (both deltas positive)
    let confirmBear = typeof position._confirmBear === 'number' ? position._confirmBear : 0;
    const match = (delta1m !== undefined && delta5m !== undefined && delta1m > 0 && delta5m > 0);
    confirmBear = match ? (confirmBear + 1) : 0;
    const need = Math.max(1, cfg.open.minConfirmations || 1);
    const patches = { _confirmBear: confirmBear };

    if (match && confirmBear >= need) {
      return {
        action: 'open_bear',
        nextState: 'open',
        nextBias: 'bearish',
        reason: 'short_tf_confirmation',
        positionStateUpdates: { _confirmBull: 0, _confirmBear: 0 }
      };
    }
    return { action: 'hold', nextState, nextBias, positionStateUpdates: patches };
  }

  return { action: 'hold', nextState, nextBias };
}

/**
 * State strategy cover logic with optional strengthened 1m-threshold behavior.
 *
 * Features controlled by options.config (merged with DEFAULT_STATE_STRATEGY_CONFIG):
 * - cover.strengthen1mThreshold: when cover is triggered only by 1m threshold,
 *   require additional 5m context and a minimum hold time before allowing cover.
 * - cover.minAbsBB5mFor1mThreshold: minimum |bbScore5m| needed when only 1m threshold fires.
 * - cover.minHoldMinutesFor1mThreshold: minimum minutes the position must be open for the 1m-only cover.
 * - Tracks _elapsedOpen minutes on the position via positionPatches while holding.
 */
function strategyStateCover(position = {}, analysis = {}, context = {}, options = {}) {
  const positionType = context.positionType || position.type || inferPositionTypeFromBias(position.bias);
  const currentState = position.state || 'open';
  const bb1m = analysis['1m']?.bbScore;
  const bb5m = analysis['5m']?.bbScore;
  const delta1m = analysis['1m']?.bbScoreDelta;
  const delta5m = analysis['5m']?.bbScoreDelta;
  const cfg = { ...DEFAULT_STATE_STRATEGY_CONFIG, ...(options.config || {}) };

  if (position._elapsedOpen === undefined) position._elapsedOpen = 0;
  position._elapsedOpen++;

  if (positionType === 'bull') {
    const th5 = typeof bb5m === 'number' && bb5m <= -0.1;
    const th1 = typeof bb1m === 'number' && bb1m <= -0.8;
    const deltasConfirm = typeof delta1m === 'number' && typeof delta5m === 'number' && delta1m > 0 && delta5m > 0;
    if ((th5 || th1) && deltasConfirm) {
      // Optional strengthening: if only the 1m threshold is firing, require 5m context and min hold
      if (cfg.cover.strengthen1mThreshold && th1 && !th5) {
        const absBB5 = Math.abs(bb5m ?? 0);
        const ok5mContext = absBB5 >= (cfg.cover.minAbsBB5mFor1mThreshold || 0);
        const okHold = position._elapsedOpen >= (cfg.cover.minHoldMinutesFor1mThreshold || 0);
        if (!(ok5mContext && okHold)) {
          return { action: 'hold', nextState: currentState, positionStateUpdates: { _elapsedOpen: position._elapsedOpen }, reason: 'strengthened_1m_threshold_hold' };
        }
      }
      const reason = th1 ? '1m_threshold' : '5m_threshold';
      return { action: 'cover', nextState: 'covered', reason };
    }
  } else if (positionType === 'bear') {
    const th5 = typeof bb5m === 'number' && bb5m >= 0.1;
    const th1 = typeof bb1m === 'number' && bb1m >= 0.8;
    const deltasConfirm = typeof delta1m === 'number' && typeof delta5m === 'number' && delta1m < 0 && delta5m < 0;
    if ((th5 || th1) && deltasConfirm) {
      // Optional strengthening: if only the 1m threshold is firing, require 5m context and min hold
      if (cfg.cover.strengthen1mThreshold && th1 && !th5) {
        const absBB5 = Math.abs(bb5m ?? 0);
        const ok5mContext = absBB5 >= (cfg.cover.minAbsBB5mFor1mThreshold || 0);
        const okHold = position._elapsedOpen >= (cfg.cover.minHoldMinutesFor1mThreshold || 0);
        if (!(ok5mContext && okHold)) {
          return { action: 'hold', nextState: currentState, positionStateUpdates: { _elapsedOpen: position._elapsedOpen }, reason: 'strengthened_1m_threshold_hold' };
        }
      }
      const reason = th1 ? '1m_threshold' : '5m_threshold';
      return { action: 'cover', nextState: 'covered', reason };
    }
  }

  return { action: 'hold', nextState: currentState };
}

function inferPositionTypeFromBias(bias) {
  if (bias === 'bullish') return 'bull';
  if (bias === 'bearish') return 'bear';
  return 'unknown';
}

/**
 * Default configuration for the State strategy. All keys are optional when
 * provided via options.config and will be shallow-merged over these defaults.
 *
 * open:
 *   - minConfirmations: number of consecutive minutes the 1m/5m deltas must agree
 *   - enableTrendGate: enable/disable gating of counter-trend opens
 *   - strongTrendThreshold: |trendScore5m| value to consider a trend "strong"
 *   - allowCounterTrendIfExtreme: allow opens against strong trend if 5m BB is extreme
 *   - counterTrendExtremeBB5m: |bbScore5m| threshold considered extreme
 * cover:
 *   - strengthen1mThreshold: if true, 1m-only covers require 5m context + min hold time
 *   - minAbsBB5mFor1mThreshold: |bbScore5m| minimum when only 1m threshold fires
 *   - minHoldMinutesFor1mThreshold: minimum minutes open before 1m-only cover is allowed
 */
const DEFAULT_STATE_STRATEGY_CONFIG = {
  open: {
    minConfirmations: 5,
    enableTrendGate: false,
    strongTrendThreshold: 4,
    allowCounterTrendIfExtreme: false,
    counterTrendExtremeBB5m: 1.2
  },
  cover: {
    strengthen1mThreshold: false,
    minAbsBB5mFor1mThreshold: 0.3,
    minHoldMinutesFor1mThreshold: 0
  }
};

/**
 * Module-level state for price trail strategy direction tracking.
 * Tracks the last covered position type so the open function knows which direction to go.
 */
let _priceTrailLastDir = null;

/**
 * Reset price trail state between backtest days or at start of trading day.
 */
function resetPriceTrailState() {
  _priceTrailLastDir = null;
}

/**
 * Open function for price trail strategy.
 * First open of day: always opens bull.
 * After a cover: switches to opposite direction of the covered position.
 * Requires analysis['1m'].close to be present.
 */
function strategyPriceTrailOpen(position = {}, analysis = {}, hasExistingPositions = false) {
  // Support legacy callers (like backtests) that only pass analysis
  if (!analysis || typeof analysis !== 'object' || Object.keys(analysis).length === 0 || analysis['1m'] || analysis['5m'] || analysis['15m'] || analysis['60m']) {
    if (!analysis || typeof analysis !== 'object' || !analysis['1m']) {
      // Heuristic: if first arg looks like analysis and second is empty, swap
      const maybeAnalysis = position;
      const hasTimeframeKeys = maybeAnalysis && (maybeAnalysis['1m'] || maybeAnalysis['5m'] || maybeAnalysis['15m'] || maybeAnalysis['60m']);
      if (hasTimeframeKeys && (!analysis || Object.keys(analysis).length === 0)) {
        analysis = maybeAnalysis;
        position = {};
        // hasExistingPositions remains false for backtests
      }
    }
  }
  
  const close1m = analysis['1m'] ? analysis['1m'].close : null;

  if (close1m === null || close1m === undefined) {
    return { action: 'none' };
  }

  console.log(`[checkPriceTrailOpen] :: _priceTrailLastDir : ${_priceTrailLastDir}, hasExistingPositions: ${hasExistingPositions}`);

  // Only use auto-flip logic when the symbol/date already has positions
  // This prevents immediately opening a position on server start for empty symbol/dates
  if (_priceTrailLastDir && hasExistingPositions) {
    const action = _priceTrailLastDir === 'bull' ? 'open_bear' : 'open_bull';
    console.log(`[checkPriceTrailOpen] after cover of ${_priceTrailLastDir} -> ${action}`);
    return { action };
  }

  // First open of day - determine direction from BB position
  // Use 5m BB as primary (has seed data), fall back to 15m
  const bb5m = analysis['5m'] ? analysis['5m'].bbScore : null;
  const bb15m = analysis['15m'] ? analysis['15m'].bbScore : null;
  const ref = bb5m !== null && bb5m !== undefined ? bb5m : bb15m;

  if (ref !== null && ref !== undefined) {
    if (Math.abs(ref) > 1) {
      // Outside Bollinger Bands - expect mean reversion
      // bbScore > 1 = below lower band (oversold) -> expect bounce UP -> bull
      // bbScore < -1 = above upper band (overbought) -> expect pullback DOWN -> bear
      const action = ref > 1 ? 'open_bull' : 'open_bear';
      console.log(`[checkPriceTrailOpen] first open: outside BB (bb5m=${bb5m?.toFixed(3)}) -> mean reversion -> ${action}`);
      return { action };
    } else {
      // Inside Bollinger Bands (near MAs) - play the trend
      // Use 5m trendScore as trend direction indicator
      const ts5m = analysis['5m'] ? analysis['5m'].trendScore : 0;
      const action = ts5m >= 0 ? 'open_bull' : 'open_bear';
      console.log(`[checkPriceTrailOpen] first open: inside BB (bb5m=${bb5m?.toFixed(3)}, ts5m=${ts5m}) -> play trend -> ${action}`);
      return { action };
    }
  }

  // Fallback
  console.log('[checkPriceTrailOpen] first open: no BB data -> open_bull');
  return { action: 'open_bull' };
}

/**
 * Cover function for price trail strategy.
 * Uses a dual-threshold trailing stop on the 1m close price:
 *   - Soft threshold (20 pts): triggers when price drops from peak AND 1m bbScore confirms reversal
 *   - Hard threshold (40 pts): triggers unconditionally when price drops enough from peak
 * Tracks peak/trough close and elapsed minutes on the position object.
 * Minimum cooldown of 5 minutes between actions.
 */
function strategyPriceTrailCover(position, analysis, priorState = {}) {
  const close1m = analysis['1m'] ? analysis['1m'].close : null;
  const bbScore1m = analysis['1m'] ? analysis['1m'].bbScore : null;

  if (close1m === null || close1m === undefined) {
    return { action: 'hold' };
  }

  // Initialize tracking fields on position if not present
  if (position._peakClose === undefined) {
    position._peakClose = priorState._peakClose !== undefined ? priorState._peakClose : close1m;
  }
  if (position._troughClose === undefined) {
    position._troughClose = priorState._troughClose !== undefined ? priorState._troughClose : close1m;
  }
  if (position._elapsed === undefined) {
    position._elapsed = priorState._elapsed !== undefined ? priorState._elapsed : 0;
  }

  position._elapsed++;
  position._peakClose = Math.max(position._peakClose, close1m);
  position._troughClose = Math.min(position._troughClose, close1m);

  const SOFT_THRESHOLD = 20;
  const HARD_THRESHOLD = 40;

  if (position.type === 'bull') {
    const drop = position._peakClose - close1m;
    const hardTriggered = drop >= HARD_THRESHOLD;
    const softTriggered = drop >= SOFT_THRESHOLD && bbScore1m !== null && bbScore1m < 0;

    console.log(
      `[checkPriceTrailCover] bull elapsed=${position._elapsed}`,
      `close=${close1m.toFixed(2)} peak=${position._peakClose.toFixed(2)} drop=${drop.toFixed(2)}`,
      `bb1m=${bbScore1m?.toFixed(3)} | hard=${hardTriggered} soft=${softTriggered}`
    );

    if (hardTriggered || softTriggered) {
      _priceTrailLastDir = 'bull';
      return { action: 'cover', drop, peakClose: position._peakClose };
    }
  } else if (position.type === 'bear') {
    const rise = close1m - position._troughClose;
    const hardTriggered = rise >= HARD_THRESHOLD;
    const softTriggered = rise >= SOFT_THRESHOLD && bbScore1m !== null && bbScore1m > 0;

    console.log(
      `[checkPriceTrailCover] bear elapsed=${position._elapsed}`,
      `close=${close1m.toFixed(2)} trough=${position._troughClose.toFixed(2)} rise=${rise.toFixed(2)}`,
      `bb1m=${bbScore1m?.toFixed(3)} | hard=${hardTriggered} soft=${softTriggered}`
    );

    if (hardTriggered || softTriggered) {
      _priceTrailLastDir = 'bear';
      return { action: 'cover', rise, troughClose: position._troughClose };
    }
  }

  return { action: 'hold' };
}

/**
 * Reset price trail v2 state between backtest days or at start of trading day.
 */
function resetPriceTrailv2State() {
  // v2 is stateless between positions (no auto-flip), nothing to reset
}

/**
 * Open function for price trail v2 strategy.
 * Conservative entries: only open when price is at/beyond 5m BB bands
 * with 1m reversal confirmation. No auto-flip after cover.
 *
 * Bull setup: 5m bbScore > 0.8 (price near/below lower band) AND 1m bbScoreDelta < 0 (bouncing up)
 * Bear setup: 5m bbScore < -0.8 (price near/above upper band) AND 1m bbScoreDelta > 0 (falling back)
 */
function strategyPriceTrailv2Open(position = {}, analysis = {}) {
  // Support legacy callers (like backtests) that only pass analysis
  if (!analysis || typeof analysis !== 'object' || Object.keys(analysis).length === 0 || analysis['1m'] || analysis['5m'] || analysis['15m'] || analysis['60m']) {
    if (!analysis || typeof analysis !== 'object' || !analysis['1m']) {
      // Heuristic: if first arg looks like analysis and second is empty, swap
      const maybeAnalysis = position;
      const hasTimeframeKeys = maybeAnalysis && (maybeAnalysis['1m'] || maybeAnalysis['5m'] || maybeAnalysis['15m'] || maybeAnalysis['60m']);
      if (hasTimeframeKeys && (!analysis || Object.keys(analysis).length === 0)) {
        analysis = maybeAnalysis;
        position = {};
      }
    }
  }
  
  const close1m = analysis['1m'] ? analysis['1m'].close : null;
  const bb5m = analysis['5m'] ? analysis['5m'].bbScore : null;
  const bbDelta1m = analysis['1m'] ? analysis['1m'].bbScoreDelta : null;

  if (close1m === null || close1m === undefined || bb5m === null || bb5m === undefined) {
    return { action: 'none' };
  }

  const ENTRY_THRESHOLD = 0.8;

  // Bull setup: price near/below lower 5m BB, 1m showing bounce (bbScore decreasing = price rising)
  if (bb5m > ENTRY_THRESHOLD && bbDelta1m !== null && bbDelta1m < 0) {
    console.log(`[checkPriceTrailv2Open] bull setup: bb5m=${bb5m.toFixed(3)} bbDelta1m=${bbDelta1m.toFixed(3)} -> open_bull`);
    return { action: 'open_bull' };
  }

  // Bear setup: price near/above upper 5m BB, 1m showing pullback (bbScore increasing = price falling)
  if (bb5m < -ENTRY_THRESHOLD && bbDelta1m !== null && bbDelta1m > 0) {
    console.log(`[checkPriceTrailv2Open] bear setup: bb5m=${bb5m.toFixed(3)} bbDelta1m=${bbDelta1m.toFixed(3)} -> open_bear`);
    return { action: 'open_bear' };
  }

  // No setup - stay flat
  return { action: 'none' };
}

/**
 * Cover function for price trail v2 strategy.
 * Mean reversion cover: close when price reverts to the 20 SMA (5m bbScore crosses zero).
 * Also keeps dual-threshold trailing stop as safety net.
 *
 * Primary exit: 5m bbScore crosses zero (price reached middle BB / 20 SMA)
 * Safety: trailing stop hard (40 pts) and soft (20 pts + 1m bb confirmation)
 */
function strategyPriceTrailv2Cover(position, analysis) {
  const close1m = analysis['1m'] ? analysis['1m'].close : null;
  const bbScore1m = analysis['1m'] ? analysis['1m'].bbScore : null;
  const bbScore5m = analysis['5m'] ? analysis['5m'].bbScore : null;

  if (close1m === null || close1m === undefined) {
    return { action: 'hold' };
  }

  // Initialize tracking fields on position if not present
  if (position._peakClose === undefined) {
    position._peakClose = close1m;
    position._troughClose = close1m;
    position._elapsed = 0;
  }

  position._elapsed++;
  position._peakClose = Math.max(position._peakClose, close1m);
  position._troughClose = Math.min(position._troughClose, close1m);

  const SOFT_THRESHOLD = 20;
  const HARD_THRESHOLD = 40;
  const COOLDOWN = 5;

  if (position._elapsed < COOLDOWN) {
    return { action: 'hold' };
  }

  if (position.type === 'bull') {
    const drop = position._peakClose - close1m;
    const hardTriggered = drop >= HARD_THRESHOLD;
    const softTriggered = drop >= SOFT_THRESHOLD && bbScore1m !== null && bbScore1m < 0;
    // Primary exit: price crossed above 20 SMA (bbScore went from positive to zero/negative)
    const bbCrossed = bbScore5m !== null && bbScore5m <= 0;

    console.log(
      `[checkPriceTrailv2Cover] bull elapsed=${position._elapsed}`,
      `close=${close1m.toFixed(2)} peak=${position._peakClose.toFixed(2)} drop=${drop.toFixed(2)}`,
      `bb1m=${bbScore1m?.toFixed(3)} bb5m=${bbScore5m?.toFixed(3)}`,
      `| hard=${hardTriggered} soft=${softTriggered} bbCross=${bbCrossed}`
    );

    if (bbCrossed || hardTriggered || softTriggered) {
      return { action: 'cover', reason: bbCrossed ? 'bb_cross' : (hardTriggered ? 'hard_stop' : 'soft_stop'), drop, peakClose: position._peakClose };
    }
  } else if (position.type === 'bear') {
    const rise = close1m - position._troughClose;
    const hardTriggered = rise >= HARD_THRESHOLD;
    const softTriggered = rise >= SOFT_THRESHOLD && bbScore1m !== null && bbScore1m > 0;
    // Primary exit: price crossed below 20 SMA (bbScore went from negative to zero/positive)
    const bbCrossed = bbScore5m !== null && bbScore5m >= 0;

    console.log(
      `[checkPriceTrailv2Cover] bear elapsed=${position._elapsed}`,
      `close=${close1m.toFixed(2)} trough=${position._troughClose.toFixed(2)} rise=${rise.toFixed(2)}`,
      `bb1m=${bbScore1m?.toFixed(3)} bb5m=${bbScore5m?.toFixed(3)}`,
      `| hard=${hardTriggered} soft=${softTriggered} bbCross=${bbCrossed}`
    );

    if (bbCrossed || hardTriggered || softTriggered) {
      return { action: 'cover', reason: bbCrossed ? 'bb_cross' : (hardTriggered ? 'hard_stop' : 'soft_stop'), rise, troughClose: position._troughClose };
    }
  }

  return { action: 'hold' };
}

/**
 * Module-level state for price trail v3 strategy.
 * Tracks rolling 5m bbScore history for regime detection (choppy vs trending).
 */
let _v3BbScore5mHistory = [];  // rolling window of recent 5m bbScores
let _v3LastDir = null;         // last covered direction for trending re-entry
let _v3LastRegime = null;      // 'choppy' or 'trending'

const V3_ROLLING_WINDOW = 60;        // minutes of history for regime detection
const V3_CROSSING_THRESHOLD = 4;     // zero crossings per window: >4 = choppy, <=4 = trending
const V3_ENTRY_THRESHOLD = 0.8;      // bbScore threshold for band-edge entry (choppy mode)
const V3_SOFT_THRESHOLD = 20;
const V3_HARD_THRESHOLD = 40;
const V3_COOLDOWN = 5;

/**
 * Reset price trail v3 state between backtest days or at start of trading day.
 */
function resetPriceTrailv3State() {
  _v3BbScore5mHistory = [];
  _v3LastDir = null;
  _v3LastRegime = null;
}

/**
 * Count zero crossings in a bbScore history array.
 */
function countZeroCrossings(history) {
  let crossings = 0;
  for (let i = 1; i < history.length; i++) {
    if ((history[i] > 0 && history[i-1] < 0) || (history[i] < 0 && history[i-1] > 0)) {
      crossings++;
    }
  }
  return crossings;
}

/**
 * Detect market regime from rolling 5m bbScore history.
 * Returns 'choppy' if many zero crossings (mean-reverting), 'trending' otherwise.
 */
function detectRegime() {
  if (_v3BbScore5mHistory.length < 10) {
    return 'choppy'; // default to conservative until we have data
  }
  const crossings = countZeroCrossings(_v3BbScore5mHistory);
  const regime = crossings > V3_CROSSING_THRESHOLD ? 'choppy' : 'trending';
  if (regime !== _v3LastRegime) {
    console.log(`[v3 regime] ${_v3LastRegime || 'init'} -> ${regime} (${crossings} crossings in ${_v3BbScore5mHistory.length}min window)`);
    _v3LastRegime = regime;
  }
  return regime;
}

/**
 * Open function for price trail v3 strategy.
 * Adapts entry logic based on detected market regime:
 *   - Choppy: conservative band-edge entries with 1m reversal confirmation (v2 style)
 *   - Trending: auto-flip after cover to stay in the market (v1 style)
 */
function strategyPriceTrailv3Open(position = {}, analysis = {}) {
  // Support legacy callers (like backtests) that only pass analysis
  if (!analysis || typeof analysis !== 'object' || Object.keys(analysis).length === 0 || analysis['1m'] || analysis['5m'] || analysis['15m'] || analysis['60m']) {
    if (!analysis || typeof analysis !== 'object' || !analysis['1m']) {
      // Heuristic: if first arg looks like analysis and second is empty, swap
      const maybeAnalysis = position;
      const hasTimeframeKeys = maybeAnalysis && (maybeAnalysis['1m'] || maybeAnalysis['5m'] || maybeAnalysis['15m'] || maybeAnalysis['60m']);
      if (hasTimeframeKeys && (!analysis || Object.keys(analysis).length === 0)) {
        analysis = maybeAnalysis;
        position = {};
      }
    }
  }
  
  const close1m = analysis['1m'] ? analysis['1m'].close : null;
  const bb5m = analysis['5m'] ? analysis['5m'].bbScore : null;
  const bbDelta1m = analysis['1m'] ? analysis['1m'].bbScoreDelta : null;

  if (close1m === null || close1m === undefined || bb5m === null || bb5m === undefined) {
    return { action: 'none' };
  }

  // Update rolling history
  _v3BbScore5mHistory.push(bb5m);
  if (_v3BbScore5mHistory.length > V3_ROLLING_WINDOW) {
    _v3BbScore5mHistory.shift();
  }

  const regime = detectRegime();

  // In TRENDING mode after a cover: auto-flip direction (v1 style) to stay in market
  if (regime === 'trending' && _v3LastDir) {
    const action = _v3LastDir === 'bull' ? 'open_bear' : 'open_bull';
    console.log(`[checkPriceTrailv3Open] trending auto-flip: covered ${_v3LastDir} -> ${action} (regime=${regime})`);
    _v3LastDir = null;
    return { action };
  }

  // In CHOPPY mode (or no prior cover): conservative band-edge entry with 1m confirmation (v2 style)
  if (bb5m > V3_ENTRY_THRESHOLD && bbDelta1m !== null && bbDelta1m < 0) {
    console.log(`[checkPriceTrailv3Open] bull setup: bb5m=${bb5m.toFixed(3)} bbDelta1m=${bbDelta1m.toFixed(3)} regime=${regime} -> open_bull`);
    _v3LastDir = null;
    return { action: 'open_bull' };
  }

  if (bb5m < -V3_ENTRY_THRESHOLD && bbDelta1m !== null && bbDelta1m > 0) {
    console.log(`[checkPriceTrailv3Open] bear setup: bb5m=${bb5m.toFixed(3)} bbDelta1m=${bbDelta1m.toFixed(3)} regime=${regime} -> open_bear`);
    _v3LastDir = null;
    return { action: 'open_bear' };
  }

  return { action: 'none' };
}

/**
 * Cover function for price trail v3 strategy.
 * Adaptive cover based on detected market regime:
 *   - Choppy: cover at BB middle crossing (5m bbScore crosses zero) + trailing stop safety
 *   - Trending: trailing stop only (soft + hard), skip BB-crossing exit to ride the trend
 */
function strategyPriceTrailv3Cover(position, analysis) {
  const close1m = analysis['1m'] ? analysis['1m'].close : null;
  const bbScore1m = analysis['1m'] ? analysis['1m'].bbScore : null;
  const bbScore5m = analysis['5m'] ? analysis['5m'].bbScore : null;

  if (close1m === null || close1m === undefined) {
    return { action: 'hold' };
  }

  // Update rolling history (also update here in case open returned 'none' and skipped)
  if (bbScore5m !== null && bbScore5m !== undefined) {
    // Only push if the open function didn't already push this minute
    // We track by checking if the last value is different (simple dedup)
    if (_v3BbScore5mHistory.length === 0 || _v3BbScore5mHistory[_v3BbScore5mHistory.length - 1] !== bbScore5m) {
      _v3BbScore5mHistory.push(bbScore5m);
      if (_v3BbScore5mHistory.length > V3_ROLLING_WINDOW) {
        _v3BbScore5mHistory.shift();
      }
    }
  }

  // Initialize tracking fields on position if not present
  if (position._peakClose === undefined) {
    position._peakClose = close1m;
    position._troughClose = close1m;
    position._elapsed = 0;
  }

  position._elapsed++;
  position._peakClose = Math.max(position._peakClose, close1m);
  position._troughClose = Math.min(position._troughClose, close1m);

  if (position._elapsed < V3_COOLDOWN) {
    return { action: 'hold' };
  }

  const regime = detectRegime();

  if (position.type === 'bull') {
    const drop = position._peakClose - close1m;
    const hardTriggered = drop >= V3_HARD_THRESHOLD;
    const softTriggered = drop >= V3_SOFT_THRESHOLD && bbScore1m !== null && bbScore1m < 0;
    // BB-crossing: only used in choppy regime
    const bbCrossed = regime === 'choppy' && bbScore5m !== null && bbScore5m <= 0;

    console.log(
      `[checkPriceTrailv3Cover] bull elapsed=${position._elapsed}`,
      `close=${close1m.toFixed(2)} peak=${position._peakClose.toFixed(2)} drop=${drop.toFixed(2)}`,
      `bb1m=${bbScore1m?.toFixed(3)} bb5m=${bbScore5m?.toFixed(3)} regime=${regime}`,
      `| hard=${hardTriggered} soft=${softTriggered} bbCross=${bbCrossed}`
    );

    if (bbCrossed || hardTriggered || softTriggered) {
      _v3LastDir = 'bull';
      const reason = bbCrossed ? 'bb_cross' : (hardTriggered ? 'hard_stop' : 'soft_stop');
      return { action: 'cover', reason, regime, drop, peakClose: position._peakClose };
    }
  } else if (position.type === 'bear') {
    const rise = close1m - position._troughClose;
    const hardTriggered = rise >= V3_HARD_THRESHOLD;
    const softTriggered = rise >= V3_SOFT_THRESHOLD && bbScore1m !== null && bbScore1m > 0;
    // BB-crossing: only used in choppy regime
    const bbCrossed = regime === 'choppy' && bbScore5m !== null && bbScore5m >= 0;

    console.log(
      `[checkPriceTrailv3Cover] bear elapsed=${position._elapsed}`,
      `close=${close1m.toFixed(2)} trough=${position._troughClose.toFixed(2)} rise=${rise.toFixed(2)}`,
      `bb1m=${bbScore1m?.toFixed(3)} bb5m=${bbScore5m?.toFixed(3)} regime=${regime}`,
      `| hard=${hardTriggered} soft=${softTriggered} bbCross=${bbCrossed}`
    );

    if (bbCrossed || hardTriggered || softTriggered) {
      _v3LastDir = 'bear';
      const reason = bbCrossed ? 'bb_cross' : (hardTriggered ? 'hard_stop' : 'soft_stop');
      return { action: 'cover', reason, regime, rise, troughClose: position._troughClose };
    }
  }

  return { action: 'hold' };
}

/**
 * Aggregate Scores Strategy - Open Logic
 * 
 * Uses aggregated BB score sum to determine entry points with peak tracking.
 * 
 * States:
 * - 'new' -> 'ready_open_bull' when bbSum > 2.5
 * - 'new' -> 'ready_open_bear' when bbSum < -2.5
 * - 'ready_open_bull' -> 'open' when bbSum falls 20% from peak (e.g., peak 4.0 -> trigger at 3.2)
 * - 'ready_open_bear' -> 'open' when bbSum rises 20% from trough (e.g., trough -4.0 -> trigger at -3.2)
 * 
 * Tracks:
 * - _aggPeak: highest bbSum seen while in ready_open_bull
 * - _aggTrough: lowest bbSum seen while in ready_open_bear
 */
function strategyAggregateScoresOpen(position = {}, analysis = {}, context = {}, options = {}) {
  const currentState = position.state || 'new';
  const aggregated = analysis.aggregated;
  
  if (!aggregated || !aggregated.candles || aggregated.candles.length === 0) {
    return { action: 'hold', nextState: currentState, reason: 'no_aggregated_data' };
  }
  
  const latestCandle = aggregated.candles[0]; // newest first
  const bbSum = latestCandle?.bbSum;
  
  if (typeof bbSum !== 'number') {
    return { action: 'hold', nextState: currentState, reason: 'no_bbSum' };
  }
  
  const positionPatches = {};
  
  // State: new -> check for ready conditions
  if (currentState === 'new') {
    if (bbSum > 2.5) {
      positionPatches._aggPeak = bbSum;
      return { 
        action: 'hold', 
        nextState: 'ready_open_bull', 
        positionStateUpdates: positionPatches,
        reason: `bbSum=${bbSum.toFixed(2)} > 2.5, ready for bull entry` 
      };
    }
    
    if (bbSum < -2.5) {
      positionPatches._aggTrough = bbSum;
      return { 
        action: 'hold', 
        nextState: 'ready_open_bear', 
        positionStateUpdates: positionPatches,
        reason: `bbSum=${bbSum.toFixed(2)} < -2.5, ready for bear entry` 
      };
    }
    
    return { action: 'hold', nextState: 'new', reason: `bbSum=${bbSum.toFixed(2)} not ready` };
  }
  
  // State: ready_open_bull -> track peak and check for 20% pullback
  if (currentState === 'ready_open_bull') {
    const currentPeak = position._aggPeak || bbSum;
    
    // Update peak if we've gone higher
    if (bbSum > currentPeak) {
      positionPatches._aggPeak = bbSum;
      return { 
        action: 'hold', 
        nextState: 'ready_open_bull', 
        positionStateUpdates: positionPatches,
        reason: `new peak: ${bbSum.toFixed(2)}` 
      };
    }
    
    // Check for 20% pullback from peak
    const pullbackThreshold = currentPeak * 0.8; // 20% below peak
    if (bbSum <= pullbackThreshold) {
      return { 
        action: 'open_bull', 
        nextState: 'open', 
        positionStateUpdates: { type: 'bull' },
        reason: `bbSum=${bbSum.toFixed(2)} pulled back 20% from peak ${currentPeak.toFixed(2)}` 
      };
    }
    
    // If bbSum goes negative, reset to new
    if (bbSum < 0) {
      return { 
        action: 'hold', 
        nextState: 'new', 
        positionStateUpdates: { _aggPeak: undefined, _aggTrough: undefined },
        reason: `bbSum went negative, resetting` 
      };
    }
    
    return { action: 'hold', nextState: 'ready_open_bull', reason: `waiting for pullback from ${currentPeak.toFixed(2)}` };
  }
  
  // State: ready_open_bear -> track trough and check for 20% bounce
  if (currentState === 'ready_open_bear') {
    const currentTrough = position._aggTrough || bbSum;
    
    // Update trough if we've gone lower
    if (bbSum < currentTrough) {
      positionPatches._aggTrough = bbSum;
      return { 
        action: 'hold', 
        nextState: 'ready_open_bear', 
        positionStateUpdates: positionPatches,
        reason: `new trough: ${bbSum.toFixed(2)}` 
      };
    }
    
    // Check for 20% bounce from trough (trough is negative, so 20% toward zero)
    const bounceThreshold = currentTrough * 0.8; // 20% above trough (less negative)
    if (bbSum >= bounceThreshold) {
      return { 
        action: 'open_bear', 
        nextState: 'open', 
        positionStateUpdates: { type: 'bear' },
        reason: `bbSum=${bbSum.toFixed(2)} bounced 20% from trough ${currentTrough.toFixed(2)}` 
      };
    }
    
    // If bbSum goes positive, reset to new
    if (bbSum > 0) {
      return { 
        action: 'hold', 
        nextState: 'new', 
        positionStateUpdates: { _aggPeak: undefined, _aggTrough: undefined },
        reason: `bbSum went positive, resetting` 
      };
    }
    
    return { action: 'hold', nextState: 'ready_open_bear', reason: `waiting for bounce from ${currentTrough.toFixed(2)}` };
  }
  
  return { action: 'hold', nextState: currentState, reason: 'unknown_state' };
}

/**
 * Aggregate Scores Strategy - Cover Logic
 * 
 * Covers position when bbSum gets within 0.2 of zero (between -0.2 and +0.2)
 */
function strategyAggregateScoresCover(position = {}, analysis = {}, context = {}, options = {}) {
  const currentState = position.state || 'open';
  const aggregated = analysis.aggregated;
  
  if (!aggregated || !aggregated.candles || aggregated.candles.length === 0) {
    return { action: 'hold', nextState: currentState, reason: 'no_aggregated_data' };
  }
  
  const latestCandle = aggregated.candles[0]; // newest first
  const bbSum = latestCandle?.bbSum;
  
  if (typeof bbSum !== 'number') {
    return { action: 'hold', nextState: currentState, reason: 'no_bbSum' };
  }
  
  // Cover when bbSum is between -0.2 and +0.2
  if (bbSum >= -0.2 && bbSum <= 0.2) {
    return { 
      action: 'cover', 
      nextState: 'covered', 
      reason: `bbSum=${bbSum.toFixed(2)} near zero (within ±0.2)` 
    };
  }
  
  return { action: 'hold', nextState: currentState, reason: `bbSum=${bbSum.toFixed(2)} not near zero` };
}

module.exports = {
  calculateBBScore,
  strategySimple5mBBScoreOpen,
  strategySimple15mBBScoreOpen,
  strategySimple5mBBScoreCover,
  strategySimple15mBBScoreCover,
  strategySimple15and60mBBScoreOpen,
  strategySimple15and60mBBScoreCover,
  strategy1m5m15mOpen,
  strategy1m5m15mCover,
  strategyPriceTrailOpen,
  strategyPriceTrailCover,
  resetPriceTrailState,
  strategyPriceTrailv2Open,
  strategyPriceTrailv2Cover,
  resetPriceTrailv2State,
  strategyPriceTrailv3Open,
  strategyPriceTrailv3Cover,
  resetPriceTrailv3State,
  strategyStateOpen,
  strategyStateCover,
  strategyAggregateScoresOpen,
  strategyAggregateScoresCover
};
