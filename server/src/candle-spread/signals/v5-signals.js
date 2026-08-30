'use strict';
/**
 * v5 = v4 + a TREND-FLIP COVER and momentum-gated reversals (v4 is frozen as the baseline). The v4
 * traps (see the 3/26 and 8/14 traces): v4 only covers/flips on mean-reversion wick-stabs, so it
 * (a) whipsaws off the correct trend on tiny counter-bounces and (b) gets stuck holding against a
 * clean trend with no exit. v5 fixes both by reading the STRUCTURAL trend (15m midline + 9EMA) plus
 * MOMENTUM (breaking the prior high/low — the v1-v3 "trend persists while it keeps making new
 * highs/lows" rule), and covering the whole book when the trend flips against it.
 *
 * SIGNALS (evaluated in priority order):
 *   (1) OVEREXTENSION REVERSAL (primary, calibrated): the wick stabs to/through the slower-TF (5m)
 *       band AND closes back inside (rejection) → reverse. Volatility-relative via `reversalFrac`.
 *   (2) GRIND top/bottom: in a grind the 5m band rises WITH price so the wick never stabs beyond.
 *       Detect the turn via the 1m band pushing beyond the slower channel (volatility expansion),
 *       CONFIRMED by a reversal candle formation. Gated by `widenFrac`.
 *   (3) CANDLE-AT-CONFLUENCE reversal: a bearish (top) / bullish (bottom) reversal candle right at a
 *       strong opposing confluence zone — catches grind tops that just stall at a line cluster.
 *       Gated by `candleConfluenceRadius`.
 *   (4) ACTIVE COVERING: lock the tent when a HELD trend runs into a strong opposing confluence,
 *       without a full reversal (cover all held, go flat, re-engage next signal). Gated by
 *       `activeCoverRadius`. This is what the user does discretionarily — cover uncovered positions
 *       as the trend hits overhead resistance, rather than only at the rare opposite extreme.
 *   (5) GATED TREND CONTINUATION: open with the trend on a same-color candle, unless right into a
 *       strong opposing confluence (pause).
 *
 * Signals (2)-(4) are OFF unless their cfg gate is set, so the calibrated (1)+(5) baseline is
 * unchanged and each new trigger can be A/B'd independently in the backtest.
 */
const conf = require('./confluence');
const pat = require('./candle-patterns');

// ctx = { heldDir: 'bull'|'bear'|'none', cfg }.  Returns { openSide:'bull'|'bear'|null, cover:bool, reason }.
function v5Signal(A, prior, ctx = {}) {
  const cfg = ctx.cfg || {};
  const revFrac = cfg.reversalFrac != null ? cfg.reversalFrac : -0.15;
  const pausePts = cfg.pausePts != null ? cfg.pausePts : 8;          // pts to a strong opposing cluster → pause opens
  const held = ctx.heldDir || 'none';

  const c15 = A && A['15m'];
  if (!c15 || c15.bbmiddle == null || c15.close == null) return { openSide: null, cover: false, reason: 'no-15m' };
  const { close, low, high, bbmiddle: mid, ema } = c15;
  const green = close >= (c15.open != null ? c15.open : close);
  const prior15 = prior && prior['15m'];

  const c5 = A['5m'];
  const bw5 = (c5 && c5.bbupper != null && c5.bblower != null) ? (c5.bbupper - c5.bblower) : null;

  // STRUCTURAL trend (slow, stable) = price AND 9EMA on the same side of the 15m midline.
  const up = close > mid && ema != null && ema >= mid;
  const down = close < mid && ema != null && ema <= mid;
  // MOMENTUM (fast) = did this candle break the prior candle's high/low (the v1-v3 trend-persistence read).
  const higherHigh = prior15 && prior15.high != null && high > prior15.high;
  const lowerLow = prior15 && prior15.low != null && low < prior15.low;

  // (0) TREND-FLIP COVER — when we hold AGAINST a now-confirmed opposite structural trend, cover the
  //     whole book (and take the new side) WITHOUT waiting for an opposite overextension. This is the
  //     exit v4 lacked (3/26 stuck-bull, 8/14 bears-into-a-rising-close).
  //     CALIBRATION (87 days): the PURE structural flip (close + 9EMA cross the midline) wins. Adding
  //     a single-bar momentum confirm (flipMomentum) or suppressing counter-trend reversals
  //     (revTrendGate) both HURT — they only DELAY good exits / drop reversal covers whose tents still
  //     lock floor. The slow midline+9EMA cross already encodes "trend persistence"; the fast
  //     single-bar high/low break is too noisy a proxy. So flipMomentum defaults OFF.
  const flipMomentum = cfg.flipMomentum != null ? cfg.flipMomentum : false;
  if (cfg.trendFlip !== false && held !== 'none') {
    if (held === 'bull' && down && (!flipMomentum || lowerLow)) return { openSide: 'bear', cover: true, reason: 'trend-flip→bear' };
    if (held === 'bear' && up && (!flipMomentum || higherHigh)) return { openSide: 'bull', cover: true, reason: 'trend-flip→bull' };
  }

  // (1) OVEREXTENSION REVERSAL — wick reaches the 5m band (band-width-relative), gated by REJECTION
  //     (must close back inside). revTrendGate (optional, DEFAULT OFF) suppresses the counter-trend
  //     dip-buy/rip-sell inside a confirmed trend — the user's v1-v3 "don't fight the trend" rule.
  //     CALIBRATION (87 days): it HURTS (terminal +$111k vs +$156k, drawdown doubles). Counter to
  //     directional intuition, because in the TENT strategy the "whipsaw" churns out COVERED tents
  //     that lock floor, and some dips are real bottoms — suppressing the churn drops profitable
  //     covers and misses turns. The trend-flip cover (0) already bails out the naked exposure, which
  //     is the part that actually needed fixing. Kept as a flag; the real fix for lag on two-sided
  //     days (e.g. 8/14) is a FASTER trend read (5m + 5m-9EMA), not suppressing entries.
  const revTrendGate = cfg.revTrendGate === true;
  if (bw5 > 0) {
    const botNorm = (c5.bblower - low) / bw5;    // >0 = low beyond the 5m lower band (in band-widths)
    const topNorm = (high - c5.bbupper) / bw5;
    const suppressBull = revTrendGate && down;   // confirmed downtrend → don't buy the dip (let it ride / trend-flip catches the real turn)
    const suppressBear = revTrendGate && up;     // confirmed uptrend → don't sell the rip
    if (botNorm >= revFrac && close > c5.bblower && !suppressBull) {
      return { openSide: 'bull', cover: held === 'bear', reason: `overext-bottom(${botNorm.toFixed(2)}bw, closed back in)` };
    }
    if (topNorm >= revFrac && close < c5.bbupper && !suppressBear) {
      return { openSide: 'bear', cover: held === 'bull', reason: `overext-top(${topNorm.toFixed(2)}bw, closed back in)` };
    }
  }

  // (2) GRIND top/bottom — the 1m band pushes beyond the slower channel (as a % of its own width) AND
  //     a reversal candle prints, while price is on the extended side of the 15m midline. Default 0.10
  //     (1m band 10% of its own width beyond the 5m/15m band) — calibrated on the 49 days: raises the
  //     guaranteed floor ~$10k (catches the grind tops the wick-stab reversal misses) at ~flat terminal.
  const widenFrac = cfg.widenFrac != null ? cfg.widenFrac : 0.10;
  if (widenFrac != null) {
    const ext = conf.bandExtension(A);
    const upPct = (tf) => (ext.upper[tf] && ext.upper[tf].pctOfOneWidth != null) ? ext.upper[tf].pctOfOneWidth / 100 : -Infinity;
    const dnPct = (tf) => (ext.lower[tf] && ext.lower[tf].pctOfOneWidth != null) ? ext.lower[tf].pctOfOneWidth / 100 : -Infinity;
    const upExt = Math.max(upPct('5m'), upPct('15m'));
    const dnExt = Math.max(dnPct('5m'), dnPct('15m'));
    if (upExt >= widenFrac && close > mid && pat.bearishReversalCandle(c15, prior15)) {
      return { openSide: 'bear', cover: held === 'bull', reason: `grind-top(1mUpExt ${(upExt * 100).toFixed(0)}%, bearish candle)` };
    }
    if (dnExt >= widenFrac && close < mid && pat.bullishReversalCandle(c15, prior15)) {
      return { openSide: 'bull', cover: held === 'bear', reason: `grind-bottom(1mDnExt ${(dnExt * 100).toFixed(0)}%, bullish candle)` };
    }
  }

  // (3) CANDLE-AT-CONFLUENCE reversal — a reversal candle right at a strong (≥3-TF) opposing cluster.
  const ccRadius = cfg.candleConfluenceRadius != null ? cfg.candleConfluenceRadius : null;
  if (ccRadius != null) {
    if (close > mid && pat.bearishReversalCandle(c15, prior15)) {
      const res = conf.strongestClusterNear(A, high, { radius: ccRadius, minTf: 3 });
      if (res && res.mid >= close) return { openSide: 'bear', cover: held === 'bull', reason: `candle-top @cluster ${res.mid}` };
    }
    if (close < mid && pat.bullishReversalCandle(c15, prior15)) {
      const sup = conf.strongestClusterNear(A, low, { radius: ccRadius, minTf: 3 });
      if (sup && sup.mid <= close) return { openSide: 'bull', cover: held === 'bear', reason: `candle-bottom @cluster ${sup.mid}` };
    }
  }

  // (4) ACTIVE COVERING — a held trend runs into a strong opposing confluence: cover all, go flat.
  //     Default radius 8pt — calibrated on the 49 days: the single biggest win, improving BOTH floor
  //     (+$9k) and terminal (+$4k) by locking the tent when price sits on overhead resistance (the
  //     short spread is deep-ITM there, so the cover is cheap — "let the move fund the offset").
  const acRadius = cfg.activeCoverRadius != null ? cfg.activeCoverRadius : 8;
  if (acRadius != null && held !== 'none') {
    if (held === 'bull' && close > mid) {
      const res = conf.strongestClusterNear(A, close, { radius: acRadius, minTf: 3 });
      if (res && res.mid > close && res.mid - close <= acRadius) return { openSide: null, cover: true, reason: `active-cover into resistance @${res.mid}` };
    }
    if (held === 'bear' && close < mid) {
      const sup = conf.strongestClusterNear(A, close, { radius: acRadius, minTf: 3 });
      if (sup && sup.mid < close && close - sup.mid <= acRadius) return { openSide: null, cover: true, reason: `active-cover into support @${sup.mid}` };
    }
  }

  // (5) GATED TREND CONTINUATION (up/down computed above from the midline + 9EMA).
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

module.exports = { v5Signal };
