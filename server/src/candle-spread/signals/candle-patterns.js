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

// GREEN-BREAKS-HIGH (2026-10-12, v4-v7 cfg.breakOpen, OFF by default) — the v0-v3 open rule as an EXTRA trigger
// for the multi-timeframe families: a green 15m candle that breaks the prior 15m high opens bull, a red one that
// breaks the prior low opens bear, regardless of where price sits against the midline. It is checked LAST, so
// every v4 rule (and its pause) still wins. mode 'flat' fires only when nothing is held against it (no
// opposite-side position); 'any' fires even then (a be-wrong style open, never covering the other side).
// User 2026-10-12: the 10:45-11:00 bar (green, broke the prior high, 100 pts under a falling midline) opened
// nothing on v7-10 while v0-v3 opened bull.
function breakOpen(c15, prior15, mode, heldBull, heldBear) {
  if (!mode || !c15 || !prior15 || prior15.high == null || prior15.low == null) return null;
  const green = c15.close >= (c15.open != null ? c15.open : c15.close);
  if (green && c15.high > prior15.high && (mode === 'any' || !heldBear)) return { openSide: 'bull', reason: 'green-breaks-high' };
  if (!green && c15.low < prior15.low && (mode === 'any' || !heldBull)) return { openSide: 'bear', reason: 'red-breaks-low' };
  return null;
}

module.exports = { breakOpen, parts, isDoji, isTopRejection, isBottomRejection, isBearishEngulfing, isBullishEngulfing, bearishReversalCandle, bullishReversalCandle };
