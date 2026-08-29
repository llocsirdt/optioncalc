'use strict';
/**
 * v4 open/cover signal logic — the multi-timeframe precision layer (see
 * project_v4_multitimeframe_strategy). Consumes a per-candle multi-TF snapshot (the 16 lines via
 * confluence.js) and returns an open/cover decision, replacing v0-v3's single-timeframe
 * green-breaks-high / any-reversal rules.
 *
 * v1 scope (the validated core):
 *   • OVEREXTENSION REVERSAL (primary, calibrated): the candle wick stabs beyond the slower-timeframe
 *     (5m) band → reverse. Low beyond 5m lower ⇒ bottom → open bull (+ cover held bears); high beyond
 *     5m upper ⇒ top → open bear (+ cover held bulls). Threshold from calibration (~15-40pt beyond).
 *   • GATED TREND CONTINUATION: in a confirmed trend (price + 9EMA vs the 15m midline), open with the
 *     trend on a same-color candle — UNLESS price is right into a strong opposing confluence zone
 *     (≥3 timeframes) → pause. This is the key difference from v0-v3, which open blindly every trend
 *     candle and cover on every reversal; v4 HOLDS through minor pullbacks and only covers at the
 *     opposite overextension.
 *
 * Not yet (later passes): intra-candle 5m early reads, breakout-continuation on close-through,
 * 9EMA-as-S/R sizing, confluence-strength position sizing, 60m gating.
 */
const conf = require('./confluence');

// ctx = { heldDir: 'bull'|'bear'|'none', cfg }.  Returns { openSide:'bull'|'bear'|null, cover:bool, reason }.
function v4Signal(A, prior, ctx = {}) {
  const cfg = ctx.cfg || {};
  const T_rev = cfg.reversalStab != null ? cfg.reversalStab : 15;    // pts the wick must stab beyond the 5m band
  const pausePts = cfg.pausePts != null ? cfg.pausePts : 8;          // pts to a strong opposing cluster → pause opens
  const held = ctx.heldDir || 'none';

  const c15 = A && A['15m'];
  if (!c15 || c15.bbmiddle == null || c15.close == null) return { openSide: null, cover: false, reason: 'no-15m' };
  const { close, low, high, bbmiddle: mid, ema, open } = c15;
  const green = close >= (open != null ? open : close);

  const c5 = A['5m'];
  const b5 = conf.beyondBand(low, high, A, '5m');
  const bot = b5.lowBeyond;    // >0 = 15m low stabbed below the 5m lower band  (bottom extreme)
  const top = b5.highBeyond;   // >0 = 15m high stabbed above the 5m upper band (top extreme)

  // (1) OVEREXTENSION REVERSAL — the validated wick-beyond trigger, gated by REJECTION: the wick
  // must stab beyond the 5m band AND the candle must CLOSE BACK INSIDE it (a long-wick rejection).
  // A stab that CLOSES beyond the band is continuation, not a reversal — this filter kills the
  // every-bar whipsaw the raw stab produced in a strong move.
  if (c5 && c5.bblower != null && bot != null && bot >= T_rev && close > c5.bblower) {
    return { openSide: 'bull', cover: held === 'bear', reason: `overext-bottom(+${bot} beyond 5m, closed back in)` };
  }
  if (c5 && c5.bbupper != null && top != null && top >= T_rev && close < c5.bbupper) {
    return { openSide: 'bear', cover: held === 'bull', reason: `overext-top(+${top} beyond 5m, closed back in)` };
  }

  // (2) GATED TREND CONTINUATION. Trend = price AND 9EMA on the same side of the 15m midline.
  const up = close > mid && ema != null && ema >= mid;
  const down = close < mid && ema != null && ema <= mid;
  if (up && green && (held === 'bull' || held === 'none')) {
    const res = conf.strongestClusterNear(A, close, { radius: 25, minTf: 3 });   // strong overhead zone within reach
    if (res && res.mid > close && res.mid - close <= pausePts) return { openSide: null, cover: false, reason: `pause-into-resistance @${res.mid}` };
    return { openSide: 'bull', cover: false, reason: 'trend-cont-bull' };
  }
  if (down && !green && (held === 'bear' || held === 'none')) {
    const sup = conf.strongestClusterNear(A, close, { radius: 25, minTf: 3 });
    if (sup && sup.mid < close && close - sup.mid <= pausePts) return { openSide: null, cover: false, reason: `pause-into-support @${sup.mid}` };
    return { openSide: 'bear', cover: false, reason: 'trend-cont-bear' };
  }

  return { openSide: null, cover: false, reason: 'neutral' };
}

module.exports = { v4Signal };
