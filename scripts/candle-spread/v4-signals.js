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
  // VOLATILITY-RELATIVE reversal trigger: the wick must reach within `revFrac` of a 5m-BAND-WIDTH of
  // the 5m band (or beyond), so "well beyond" scales with the regime instead of a fixed point gap
  // that only fits one volatility. Calibrated on the 49 days: ~−0.1 to 0 band-widths discriminates
  // reversals ~1.7× baseline; the signal is the wick REACHING the band, not stabbing far past it.
  const revFrac = cfg.reversalFrac != null ? cfg.reversalFrac : -0.15;
  const pausePts = cfg.pausePts != null ? cfg.pausePts : 8;          // pts to a strong opposing cluster → pause opens
  const held = ctx.heldDir || 'none';

  const c15 = A && A['15m'];
  if (!c15 || c15.bbmiddle == null || c15.close == null) return { openSide: null, cover: false, reason: 'no-15m' };
  const { close, low, high, bbmiddle: mid, ema, open } = c15;
  const green = close >= (open != null ? open : close);

  const c5 = A['5m'];
  const bw5 = (c5 && c5.bbupper != null && c5.bblower != null) ? (c5.bbupper - c5.bblower) : null;

  // (1) OVEREXTENSION REVERSAL — wick reaches the 5m band (band-width-relative), gated by REJECTION:
  // the candle must CLOSE BACK INSIDE the band (a long-wick rejection). A stab that CLOSES beyond the
  // band is continuation, not a reversal — this filter kills the every-bar whipsaw of a raw stab.
  if (bw5 > 0) {
    const botNorm = (c5.bblower - low) / bw5;    // >0 = low beyond the 5m lower band (in band-widths)
    const topNorm = (high - c5.bbupper) / bw5;
    if (botNorm >= revFrac && close > c5.bblower) {
      return { openSide: 'bull', cover: held === 'bear', reason: `overext-bottom(${botNorm.toFixed(2)}bw, closed back in)` };
    }
    if (topNorm >= revFrac && close < c5.bbupper) {
      return { openSide: 'bear', cover: held === 'bull', reason: `overext-top(${topNorm.toFixed(2)}bw, closed back in)` };
    }
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
