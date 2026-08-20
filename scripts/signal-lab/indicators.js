'use strict';
/**
 * Pure candle math for the signal lab: resampling 1m -> higher timeframes and Bollinger(20,2)
 * with %B. No I/O, unit-testable. Kept independent of the server/persistence code so the lab
 * is self-contained and its numbers are easy to reason about.
 */

// Resample ascending 1m candles into clock-aligned buckets of `periodMin` minutes. Bucketing
// is epoch-based (floor(datetime / bucketMs)), which matches the live engine's 15m boundaries
// (:00/:15/:30/:45). The 60m first-hour bucket therefore holds 09:30-10:00 (a 30-min partial),
// which is the conventional RTH first-hour bar.
function resample(candles1m, periodMin) {
  const ms = periodMin * 60 * 1000;
  const buckets = new Map();
  for (const c of candles1m) {
    const start = Math.floor(c.datetime / ms) * ms;
    const b = buckets.get(start);
    if (!b) buckets.set(start, { datetime: start, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 });
    else { b.high = Math.max(b.high, c.high); b.low = Math.min(b.low, c.low); b.close = c.close; b.volume += (c.volume || 0); }
  }
  return [...buckets.values()].sort((a, b) => a.datetime - b.datetime);
}

// Bollinger(period, mult) over closes, aligned to input; warmup entries are null. %B =
// (close - lower)/(upper - lower): < 0 below the lower band, > 1 above the upper band.
function bollinger(candles, period = 20, mult = 2) {
  const out = candles.map(() => ({ bbUpper: null, bbMiddle: null, bbLower: null, percentB: null }));
  for (let i = period - 1; i < candles.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += candles[j].close;
    const mean = sum / period;
    let v = 0;
    for (let j = i - period + 1; j <= i; j++) { const d = candles[j].close - mean; v += d * d; }
    const sd = Math.sqrt(v / period); // population stddev (standard for Bollinger)
    const upper = mean + mult * sd, lower = mean - mult * sd;
    out[i] = {
      bbUpper: r2(upper), bbMiddle: r2(mean), bbLower: r2(lower),
      percentB: upper === lower ? null : r4((candles[i].close - lower) / (upper - lower))
    };
  }
  return out;
}

// candles decorated with their Bollinger fields.
function withIndicators(candles, period = 20, mult = 2) {
  const bb = bollinger(candles, period, mult);
  return candles.map((c, i) => ({ ...c, ...bb[i] }));
}

// candle color by close-vs-open (matches the trader's simpleDirection).
function color(c) { return c.close > c.open ? 'green' : c.close < c.open ? 'red' : 'flat'; }

const r2 = n => Math.round(n * 100) / 100;
const r4 = n => Math.round(n * 10000) / 10000;

module.exports = { resample, bollinger, withIndicators, color };
