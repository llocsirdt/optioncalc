'use strict';
/**
 * Live multi-timeframe analysis (`A`) builder for the candle-spread SIGNALS (v4-v9).
 *
 * Reproduces scripts/candle-spread/build-analysis-dataset.js EXACTLY — same resample + BB(20,2) +
 * EMA9 (from the shared ./signals/indicators module) + lowercase field mapping + "most-recently-
 * completed candle as of mark T" slotting — but as reusable functions the live server calls each
 * step from a rolling window of raw 1m candles. Sharing the indicators module with the backtest is
 * what guarantees the live `A` is byte-identical to the backtested `A`, so a ported signal makes the
 * same decisions live as in its backtest.
 *
 * A = { '1m':C, '5m':C, '15m':C, '60m':C }, where
 * C = { open, high, low, close, bbupper, bbmiddle, bblower, ema }.
 */
const { resample, withIndicators } = require('./signals/indicators');

const MS = 60 * 1000;
const TFS = ['1m', '5m', '15m', '60m'];

// Decorate a TF series with the lowercase BB/EMA field names the signals expect, keyed by bucket
// start. periodMin===1 uses the input as-is; otherwise it is resampled to periodMin buckets.
function tfSeries(s1, periodMin) {
  const raw = periodMin === 1 ? s1 : resample(s1, periodMin);
  const dec = withIndicators(raw);
  const byStart = new Map();
  const starts = [];
  for (const c of dec) {
    byStart.set(c.datetime, {
      open: c.open, high: c.high, low: c.low, close: c.close,
      bbupper: c.bbUpper, bbmiddle: c.bbMiddle, bblower: c.bbLower, ema: c.ema9
    });
    starts.push(c.datetime);
  }
  return { periodMs: periodMin * MS, byStart, starts };
}

// Most-recently-completed candle of a TF as of time T: greatest bucket start with start+period <= T.
function completedAsOf(tf, T) {
  const lim = T - tf.periodMs;
  let lo = 0, hi = tf.starts.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (tf.starts[m] <= lim) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans < 0 ? null : tf.byStart.get(tf.starts[ans]);
}

function isWarm(A) { return TFS.every(tf => A[tf] && A[tf].bbupper != null && A[tf].bblower != null && A[tf].ema != null); }

// Build the per-TF series ONCE from a raw-1m window; A can then be slotted at any mark cheaply.
// 60m is resampled FROM the 15m series (matches build-analysis-dataset's tfSeries(resample(s1,15),60)).
function buildSeries(raw1m) {
  const s1 = raw1m;
  const s15 = resample(s1, 15);
  return { '1m': tfSeries(s1, 1), '5m': tfSeries(s1, 5), '15m': tfSeries(s1, 15), '60m': tfSeries(s15, 60) };
}

// A snapshot at mark T (epoch ms). Returns { A, warm }.
function analysisAt(series, T) {
  const A = {};
  for (const tf of TFS) { const c = completedAsOf(series[tf], T); if (c) A[tf] = c; }
  return { A, warm: isWarm(A) };
}

// Convenience: build A directly from a raw-1m window as of T (rebuilds the series each call — fine
// for tests / occasional use; a live tick should buildSeries() once and slot several marks).
function buildA(raw1m, T) { return analysisAt(buildSeries(raw1m), T); }

// Full per-step bar list for a raw-1m window (mirrors build-analysis-dataset --step): one
// { datetime, analysis } bar per stepMin mark that is warm on all 4 TFs. Used by the parity test
// and by any offline replay. stepMin 5 = the 5m-step engine cadence; 15 = 15m-only.
function buildBars(raw1m, stepMin = 5) {
  const series = buildSeries(raw1m);
  const stepMs = stepMin * MS;
  const marks = new Set();
  for (const c of raw1m) marks.add(Math.floor(c.datetime / stepMs) * stepMs + stepMs);
  const bars = [];
  for (const T of [...marks].sort((a, b) => a - b)) {
    const { A, warm } = analysisAt(series, T);
    if (warm) bars.push({ datetime: T, analysis: A });
  }
  return bars;
}

module.exports = { buildSeries, analysisAt, buildA, buildBars, tfSeries, completedAsOf, isWarm, TFS };
