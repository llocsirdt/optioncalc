'use strict';
/**
 * Multi-timeframe line-state + confluence module for the v4 strategy (see
 * project_v4_multitimeframe_strategy in memory).
 *
 * The v4 substrate is the 16 lines — 1/5/15/60m × {BB upper, BB mid (20DMA), BB lower, 9EMA} —
 * mapped on one price axis. This module turns a per-candle multi-timeframe indicator snapshot into:
 *   • extractLines  — the 16 labeled lines (sorted by price)
 *   • clusterLines  — confluence clusters (lines within a price gap = one S/R zone; strength = count
 *                     / # of distinct timeframes)
 *   • bandExtension — how far the FAST (1m) BB channel extends BEYOND the slower channels (the key
 *                     "local top/bottom" extreme detector the user described — the 1m band pushing
 *                     OUTSIDE the 5m/15m channel, not merely price touching a band)
 *   • wickBeyond    — how far a candle's wick stabs beyond a timeframe's bands (the overextension
 *                     trigger)
 *
 * Pure functions, no I/O — used by the calibration analysis now and the v4 engine later. Input
 * `analysis` matches the backtest-data / candle-analyzer shape: { '1m': {open,high,low,close,
 * bbupper,bbmiddle,bblower,ema}, '5m': {...}, '15m': {...}, '60m': {...} }.
 */

const TFS = ['1m', '5m', '15m', '60m'];
const round2 = n => Math.round(n * 100) / 100;
const num = v => (typeof v === 'number' && isFinite(v)) ? v : null;

// The 16 lines as { tf, kind: 'upper'|'mid'|'lower'|'ema', value }, sorted ascending by price.
function extractLines(analysis, tfs = TFS) {
  const lines = [];
  for (const tf of tfs) {
    const A = analysis && analysis[tf];
    if (!A) continue;
    const push = (kind, v) => { if (num(v) != null) lines.push({ tf, kind, value: v }); };
    push('upper', A.bbupper);
    push('mid', A.bbmiddle);
    push('lower', A.bblower);
    push('ema', A.ema);
  }
  return lines.sort((a, b) => a.value - b.value);
}

// Group lines into confluence clusters: consecutive lines within `gapPts` of the running cluster top
// merge into one zone. A zone's strength = member count and, more meaningfully, # of DISTINCT
// timeframes (a cluster spanning 3 timeframes is stronger S/R than 3 lines from one timeframe).
function clusterLines(lines, gapPts) {
  const sorted = [...lines].sort((a, b) => a.value - b.value);
  const clusters = [];
  let cur = null;
  for (const L of sorted) {
    if (cur && L.value - cur.hi <= gapPts) { cur.members.push(L); cur.hi = L.value; }
    else { cur = { lo: L.value, hi: L.value, members: [L] }; clusters.push(cur); }
  }
  return clusters.map(c => ({
    lo: round2(c.lo), hi: round2(c.hi), mid: round2((c.lo + c.hi) / 2), width: round2(c.hi - c.lo),
    count: c.members.length,
    tfCount: new Set(c.members.map(m => m.tf)).size,
    tfs: [...new Set(c.members.map(m => m.tf))],
    kinds: c.members.map(m => `${m.tf}:${m.kind}`),
  }));
}

// How far the 1m BB channel extends BEYOND the slower channels — the local-extreme detector.
//   lowerExt_<tf> > 0  ⇒ 1m lower band is BELOW that tf's lower band (channel extended DOWN → bottom)
//   upperExt_<tf> > 0  ⇒ 1m upper band is ABOVE that tf's upper band (channel extended UP → top)
// Values are in points; also returned relative to the 1m band width so thresholds can be scale-free.
function bandExtension(analysis) {
  const one = analysis && analysis['1m'];
  const out = { lower: {}, upper: {}, oneWidth: null };
  if (!one || num(one.bblower) == null || num(one.bbupper) == null) return out;
  const oneLo = one.bblower, oneHi = one.bbupper, oneW = oneHi - oneLo;
  out.oneWidth = round2(oneW);
  for (const tf of ['5m', '15m', '60m']) {
    const A = analysis[tf];
    if (!A || num(A.bblower) == null || num(A.bbupper) == null) continue;
    out.lower[tf] = { pts: round2(A.bblower - oneLo), pctOfOneWidth: oneW ? round2((A.bblower - oneLo) / oneW * 100) : null };
    out.upper[tf] = { pts: round2(oneHi - A.bbupper), pctOfOneWidth: oneW ? round2((oneHi - A.bbupper) / oneW * 100) : null };
  }
  return out;
}

// How far a candle's WICK stabs beyond a timeframe's bands (overextension trigger).
//   lowBeyond > 0 ⇒ candle low is below that tf's lower band; highBeyond > 0 ⇒ high above upper band.
function wickBeyond(analysis, tf) {
  const A = analysis && analysis[tf];
  if (!A) return null;
  const lowBeyond = (num(A.low) != null && num(A.bblower) != null) ? round2(A.bblower - A.low) : null;
  const highBeyond = (num(A.high) != null && num(A.bbupper) != null) ? round2(A.high - A.bbupper) : null;
  return { lowBeyond, highBeyond };
}

// How far a given price extreme (a candle's low/high) stabs BEYOND timeframe `tf`'s band — the
// validated overextension trigger (calibration 2026-08-29: the wick reaching/exceeding the SLOWER
// timeframe's band marks reversals, unlike the 1m-vs-5m band comparison).
//   lowBeyond  > 0  ⇒ the low stabbed BELOW tf's lower band (bottom extreme)
//   highBeyond > 0  ⇒ the high stabbed ABOVE tf's upper band (top extreme)
function beyondBand(low, high, analysis, tf) {
  const A = analysis && analysis[tf];
  if (!A) return { lowBeyond: null, highBeyond: null };
  return {
    lowBeyond: (num(low) != null && num(A.bblower) != null) ? round2(A.bblower - low) : null,
    highBeyond: (num(high) != null && num(A.bbupper) != null) ? round2(high - A.bbupper) : null,
  };
}

// Strongest confluence cluster within ±radius of `price` (a support/resistance zone or retest
// target). Returns the cluster with the most distinct timeframes (ties → most lines), or null.
function strongestClusterNear(analysis, price, { radius = 25, gapPts = 12, minTf = 2 } = {}) {
  const clusters = clusterLines(extractLines(analysis), gapPts)
    .filter(c => c.tfCount >= minTf && Math.abs(c.mid - price) <= radius);
  if (!clusters.length) return null;
  return clusters.sort((a, b) => (b.tfCount - a.tfCount) || (b.count - a.count))[0];
}

// Convenience: full line-state at one candle (lines + clusters + extension), for inspection/logging.
function lineState(analysis, { gapPts = 12 } = {}) {
  const lines = extractLines(analysis);
  return { lines, clusters: clusterLines(lines, gapPts), extension: bandExtension(analysis) };
}

module.exports = { TFS, extractLines, clusterLines, bandExtension, wickBeyond, beyondBand, strongestClusterNear, lineState };
