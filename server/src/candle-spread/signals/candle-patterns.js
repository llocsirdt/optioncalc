'use strict';
/**
 * Candle-formation detectors for the v4 strategy (see project_v4_multitimeframe_strategy).
 * The user confirms reversals with 15m (and 5m) candle shape — doji, hammer/dragonfly (bullish
 * bottoms), gravestone/tombstone doji (bearish tops), engulfing, and long-wick rejections. These
 * are the "candle read" that gates the multi-timeframe line signals.
 *
 * A candle = { open, high, low, close }. Pure, no I/O.
 */

function parts(c) {
  const body = Math.abs(c.close - c.open);
  const range = Math.max(c.high - c.low, 1e-9);
  const upWick = c.high - Math.max(c.open, c.close);
  const loWick = Math.min(c.open, c.close) - c.low;
  return { body, range, upWick, loWick, green: c.close >= c.open, bodyFrac: body / range, upFrac: upWick / range, loFrac: loWick / range };
}

// Small-body indecision candle (doji-ish): body < 25% of range.
function isDoji(c) { return parts(c).bodyFrac < 0.25; }

// Bearish rejection at a HIGH: long upper wick, small-ish body, closes in the lower part of the
// range (gravestone/tombstone-ish, or a bearish pin). The classic "trend likely still/again bearish".
function isTopRejection(c) {
  const p = parts(c);
  return p.upFrac >= 0.5 && p.bodyFrac <= 0.4 && (c.close - c.low) <= 0.5 * p.range;
}

// Bullish rejection at a LOW: long lower wick (hammer/dragonfly), small-ish body, closes in the
// upper part of the range.
function isBottomRejection(c) {
  const p = parts(c);
  return p.loFrac >= 0.5 && p.bodyFrac <= 0.4 && (c.high - c.close) <= 0.5 * p.range;
}

// Engulfing: current body fully engulfs the prior body and flips color.
function isBearishEngulfing(c, prior) {
  if (!prior) return false;
  const p = parts(c), pp = parts(prior);
  return !p.green && pp.green && c.close < prior.open && c.open > prior.close && p.body > pp.body;
}
function isBullishEngulfing(c, prior) {
  if (!prior) return false;
  const p = parts(c), pp = parts(prior);
  return p.green && !pp.green && c.close > prior.open && c.open < prior.close && p.body > pp.body;
}

// Aggregate: does this candle (with its prior) look like a BEARISH reversal (top) / BULLISH (bottom)?
function bearishReversalCandle(c, prior) {
  return isTopRejection(c) || isBearishEngulfing(c, prior) || (isDoji(c) && !parts(c).green);
}
function bullishReversalCandle(c, prior) {
  return isBottomRejection(c) || isBullishEngulfing(c, prior) || (isDoji(c) && parts(c).green);
}

module.exports = { parts, isDoji, isTopRejection, isBottomRejection, isBearishEngulfing, isBullishEngulfing, bearishReversalCandle, bullishReversalCandle };
