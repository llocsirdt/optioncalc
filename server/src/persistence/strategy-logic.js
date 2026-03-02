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
 * Check if we should open a position based on 5m BB score
 * Returns: {action: 'open_bull'|'open_bear'|'none', bbScore5m: value}
 */
function checkSimple5mBBScoreOpen(analysis) {
  const bbScore5m = analysis['5m'].bbScore;
  
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
function checkSimple15mBBScoreOpen(analysis) {
  const bbScore15m = analysis['15m'].bbScore;
  
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
function checkSimple5mBBScoreCover(position, analysis) {
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
function checkSimple15mBBScoreCover(position, analysis) {
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

module.exports = {
  calculateBBScore,
  checkSimple5mBBScoreOpen,
  checkSimple15mBBScoreOpen,
  checkSimple5mBBScoreCover,
  checkSimple15mBBScoreCover
};
