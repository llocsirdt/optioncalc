'use strict';
/**
 * v6 = v5 + a FASTER trend read (v5 is frozen as the baseline). v5's trend-flip cover uses the 15m
 * midline (a ~5h/20-bar average) which LAGS badly on two-sided days (8/14: v5 kept opening bears into
 * the afternoon base because the 15m midline was still "down" long after price turned — see the 8/14
 * charts).
 *
 * FINDING (87 days): reading a faster trend but STILL sampling at 15m closes does NOT help — it just
 * adds noise at the same cadence. `trendTf='5m'` drops terminal to $96k (vs v5 $156k) by whipsawing
 * the flip; `trendTf='both'` $132k; the surgical `openGate5m` (veto opening into a 5m turn) helps
 * 8/14 (−$7.7k→−$6.8k) but hurts the aggregate ($142k). So these stay OPT-IN and v6 DEFAULTS TO v5
 * (trendTf='15m', gates off). The real lag fix needs the engine to STEP at 5m closes (act between 15m
 * bars) — a separate harness change; these knobs are the signal half of that build.
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

// Structural trend of one timeframe's candle: price AND 9EMA on the same side of that TF's midline.
function trendOf(c) {
  if (!c || c.bbmiddle == null || c.ema == null || c.close == null) return { up: false, down: false };
  return { up: c.close > c.bbmiddle && c.ema >= c.bbmiddle, down: c.close < c.bbmiddle && c.ema <= c.bbmiddle };
}

// ctx = { heldDir: 'bull'|'bear'|'none', cfg }.  Returns { openSide:'bull'|'bear'|null, cover:bool, reason }.
function v7Signal(A, prior, ctx = {}) {
  const cfg = ctx.cfg || {};
  const revFrac = cfg.reversalFrac != null ? cfg.reversalFrac : -0.15;
  const pausePts = cfg.pausePts != null ? cfg.pausePts : 8;          // pts to a strong opposing cluster → pause opens
  // PER-SIDE held state (uncovered positions on each side) — v7 can hold BOTH at once (be-wrong).
  // Returns { openSide, coverSide }: coverSide='bull'|'bear'|'both'|null covers just that side.
  const heldBull = ctx.heldBull != null ? ctx.heldBull : ctx.heldDir === 'bull';
  const heldBear = ctx.heldBear != null ? ctx.heldBear : ctx.heldDir === 'bear';
  const anyHeld = heldBull || heldBear;

  const c15 = A && A['15m'];
  if (!c15 || c15.bbmiddle == null || c15.close == null) return { openSide: null, coverSide: null, reason: 'no-15m' };
  const { close, low, high, bbmiddle: mid, ema } = c15;
  const green = close >= (c15.open != null ? c15.open : close);
  const prior15 = prior && prior['15m'];

  const c5 = A['5m'];
  const bw5 = (c5 && c5.bbupper != null && c5.bblower != null) ? (c5.bbupper - c5.bblower) : null;

  const trendTf = cfg.trendTf || '15m';           // '5m' | '15m' (default, == v5's stable flip) | 'both'
  const t5 = trendOf(c5), t15 = trendOf(c15);
  let up, down;
  if (trendTf === '5m') { up = t5.up; down = t5.down; }
  else if (trendTf === 'both') { up = t5.up && t15.up; down = t5.down && t15.down; }
  else { up = t15.up; down = t15.down; }
  const higherHigh = prior15 && prior15.high != null && high > prior15.high;
  const lowerLow = prior15 && prior15.low != null && low < prior15.low;

  // ===== 5m-STEP HARNESS HOOK ===== (intra-15m bars: act only on a 2-bar-confirmed 5m reversal against
  // the held side — cover early, flip only if 15m agrees). cfg.fiveMin off → intra-5m bars do nothing.
  const isFifteen = ctx.isFifteen !== false;
  if (!isFifteen) {
    if (cfg.fiveMin !== true || !anyHeld) return { openSide: null, coverSide: null, reason: 'intra-5m hold' };
    const p5 = trendOf(prior && prior['5m']);
    const flip = cfg.fiveMinFlip !== false;
    if (heldBull && t5.down && p5.down) return { openSide: (flip && t15.down) ? 'bear' : null, coverSide: 'bull', reason: (flip && t15.down) ? '5m+15m flip→bear' : '5m early-cover (2-bar down)' };
    if (heldBear && t5.up && p5.up) return { openSide: (flip && t15.up) ? 'bull' : null, coverSide: 'bear', reason: (flip && t15.up) ? '5m+15m flip→bull' : '5m early-cover (2-bar up)' };
    return { openSide: null, coverSide: null, reason: 'intra-5m hold' };
  }

  // (0a) FAST 5m COVER (cfg.fastCover5m, off by default — see v6 note; noise-frequent at 15m cadence).
  const fastCover5m = cfg.fastCover5m;
  const e5 = c5 && c5.ema;
  if (fastCover5m && anyHeld) {
    const lostBull = fastCover5m === 'trend' ? t5.down : (e5 != null && c5.close < e5);
    const lostBear = fastCover5m === 'trend' ? t5.up : (e5 != null && c5.close > e5);
    if (heldBull && lostBull) return { openSide: null, coverSide: 'bull', reason: `fast-cover (5m ${fastCover5m === 'trend' ? 'turned down' : 'lost 9EMA'})` };
    if (heldBear && lostBear) return { openSide: null, coverSide: 'bear', reason: `fast-cover (5m ${fastCover5m === 'trend' ? 'turned up' : 'reclaimed 9EMA'})` };
  }

  // (0) TREND-FLIP — hold AGAINST a confirmed opposite structural trend → cover the WRONG-WAY side
  //     (per-side; leaves any right-way positions) and open the opposite. flipMomentum default OFF.
  const flipMomentum = cfg.flipMomentum != null ? cfg.flipMomentum : false;
  if (cfg.trendFlip !== false && anyHeld) {
    if (heldBull && down && (!flipMomentum || lowerLow)) return { openSide: 'bear', coverSide: 'bull', reason: 'trend-flip→bear' };
    if (heldBear && up && (!flipMomentum || higherHigh)) return { openSide: 'bull', coverSide: 'bear', reason: 'trend-flip→bull' };
  }

  // (0b) BE WRONG (v7) — open the OPPOSITE side EARLY (before the full flip) on a confirmed opposite
  //      reversal candle + breaking the prior high/low, WITHOUT covering the underwater side (hedge).
  if (cfg.beWrong && anyHeld) {
    if (heldBull && lowerLow && pat.bearishReversalCandle(c15, prior15)) return { openSide: 'bear', coverSide: null, reason: 'be-wrong→bear (breaking lows + bearish candle)' };
    if (heldBear && higherHigh && pat.bullishReversalCandle(c15, prior15)) return { openSide: 'bull', coverSide: null, reason: 'be-wrong→bull (breaking highs + bullish candle)' };
  }

  // (1) OVEREXTENSION REVERSAL — wick reaches the 5m band + closes back inside → open, covering the
  //     opposite side if held. revTrendGate off by default (hurts — see v6 note).
  const revTrendGate = cfg.revTrendGate === true;
  if (bw5 > 0) {
    const botNorm = (c5.bblower - low) / bw5;
    const topNorm = (high - c5.bbupper) / bw5;
    if (botNorm >= revFrac && close > c5.bblower && !(revTrendGate && down)) {
      return { openSide: 'bull', coverSide: heldBear ? 'bear' : null, reason: `overext-bottom(${botNorm.toFixed(2)}bw, closed back in)` };
    }
    if (topNorm >= revFrac && close < c5.bbupper && !(revTrendGate && up)) {
      return { openSide: 'bear', coverSide: heldBull ? 'bull' : null, reason: `overext-top(${topNorm.toFixed(2)}bw, closed back in)` };
    }
  }

  // (2) GRIND top/bottom — 1m band beyond the slower channel + a reversal candle.
  const widenFrac = cfg.widenFrac != null ? cfg.widenFrac : 0.10;
  if (widenFrac != null) {
    const ext = conf.bandExtension(A);
    const upPct = (tf) => (ext.upper[tf] && ext.upper[tf].pctOfOneWidth != null) ? ext.upper[tf].pctOfOneWidth / 100 : -Infinity;
    const dnPct = (tf) => (ext.lower[tf] && ext.lower[tf].pctOfOneWidth != null) ? ext.lower[tf].pctOfOneWidth / 100 : -Infinity;
    const upExt = Math.max(upPct('5m'), upPct('15m'));
    const dnExt = Math.max(dnPct('5m'), dnPct('15m'));
    if (upExt >= widenFrac && close > mid && pat.bearishReversalCandle(c15, prior15)) {
      return { openSide: 'bear', coverSide: heldBull ? 'bull' : null, reason: `grind-top(1mUpExt ${(upExt * 100).toFixed(0)}%, bearish candle)` };
    }
    if (dnExt >= widenFrac && close < mid && pat.bullishReversalCandle(c15, prior15)) {
      return { openSide: 'bull', coverSide: heldBear ? 'bear' : null, reason: `grind-bottom(1mDnExt ${(dnExt * 100).toFixed(0)}%, bullish candle)` };
    }
  }

  // (3) CANDLE-AT-CONFLUENCE reversal (off by default).
  const ccRadius = cfg.candleConfluenceRadius != null ? cfg.candleConfluenceRadius : null;
  if (ccRadius != null) {
    if (close > mid && pat.bearishReversalCandle(c15, prior15)) {
      const res = conf.strongestClusterNear(A, high, { radius: ccRadius, minTf: 3 });
      if (res && res.mid >= close) return { openSide: 'bear', coverSide: heldBull ? 'bull' : null, reason: `candle-top @cluster ${res.mid}` };
    }
    if (close < mid && pat.bullishReversalCandle(c15, prior15)) {
      const sup = conf.strongestClusterNear(A, low, { radius: ccRadius, minTf: 3 });
      if (sup && sup.mid <= close) return { openSide: 'bull', coverSide: heldBear ? 'bear' : null, reason: `candle-bottom @cluster ${sup.mid}` };
    }
  }

  // (4) ACTIVE COVERING — a held side runs into a strong opposing confluence: cover just that side.
  const acRadius = cfg.activeCoverRadius != null ? cfg.activeCoverRadius : 8;
  if (acRadius != null && anyHeld) {
    if (heldBull && close > mid) {
      const res = conf.strongestClusterNear(A, close, { radius: acRadius, minTf: 3 });
      if (res && res.mid > close && res.mid - close <= acRadius) return { openSide: null, coverSide: 'bull', reason: `active-cover into resistance @${res.mid}` };
    }
    if (heldBear && close < mid) {
      const sup = conf.strongestClusterNear(A, close, { radius: acRadius, minTf: 3 });
      if (sup && sup.mid < close && close - sup.mid <= acRadius) return { openSide: null, coverSide: 'bear', reason: `active-cover into support @${sup.mid}` };
    }
  }

  // (5) GATED TREND CONTINUATION — open with the structural trend, unless holding the opposite side
  //     (that's the flip/be-wrong's job) or paused into a strong opposing cluster / 5m open-veto.
  const openGate5m = cfg.openGate5m === true;
  if (up && green && !heldBear) {
    if (openGate5m && t5.down) return { openSide: null, coverSide: null, reason: 'open-veto (5m turned down)' };
    const res = conf.strongestClusterNear(A, close, { radius: 25, minTf: 3 });
    if (res && res.mid > close && res.mid - close <= pausePts) return { openSide: null, coverSide: null, reason: `pause-into-resistance @${res.mid}` };
    return { openSide: 'bull', coverSide: null, reason: 'trend-cont-bull' };
  }
  if (down && !green && !heldBull) {
    if (openGate5m && t5.up) return { openSide: null, coverSide: null, reason: 'open-veto (5m turned up)' };
    const sup = conf.strongestClusterNear(A, close, { radius: 25, minTf: 3 });
    if (sup && sup.mid < close && close - sup.mid <= pausePts) return { openSide: null, coverSide: null, reason: `pause-into-support @${sup.mid}` };
    return { openSide: 'bear', coverSide: null, reason: 'trend-cont-bear' };
  }

  return { openSide: null, coverSide: null, reason: 'neutral' };
}

module.exports = { v7Signal };
