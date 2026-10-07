'use strict';
// TREND STATE — "never fight the trend" (user, 2026-10-07). Shared by the live trader and the backtest so
// both read the trend identically.
//
// The user's read: the trend is the 15m AND the hourly. Bias risk in favour of it: in a bull trend never
// lower the floor to the RIGHT of the risk curve (higher strikes), in a bear trend never to the LEFT; hedge
// the other side only when the trend flips or a reversal signal fires — not just because a hedge clears
// its ratio. A position fighting the trend is covered urgently (break-even + allowance at once), one riding
// it keeps the patient ladder.
//
// CONTEXT (from the SIGNAL series, /NQ):
//   t15     15m structural trend (close and 9 EMA on the same side of the BB midline): +1 / -1 / 0
//   hc      last COMPLETED hourly candle: +1 green / -1 red
//   hcHH    that hourly vs the one before: +1 higher high, -1 lower low, 0 inside
//   hf      the FORMING hourly (open of the hour to now): +1 green / -1 red / 0 flat
//   hfBreak forming hourly vs the last completed one: +1 above its high, -1 below its low, 0 inside
//
// WHY NOT the 60m structural trend: on 2026-10-07 it read DOWN all day (it lags — NQ came in off a down
// move) while the hourly candles closed green and broke highs from 11:00. The user's read is the candles.
const trendOf = (c) => (!c || c.bbmiddle == null || c.ema == null || c.close == null) ? 0
  : (c.close > c.bbmiddle && c.ema >= c.bbmiddle ? 1 : c.close < c.bbmiddle && c.ema <= c.bbmiddle ? -1 : 0);
const colour = (c) => (!c ? 0 : c.close > c.open ? 1 : c.close < c.open ? -1 : 0);

// Definitions swept 2026-10-07. 'A' = the user's choice (15m + completed hourly); the rest are the controls.
const DEFS = {
  '15m': (x) => x.t15,
  A: (x) => (x.t15 !== 0 && x.t15 === x.hc ? x.t15 : 0),
  AHH: (x) => (x.t15 !== 0 && x.t15 === x.hc && x.hcHH === x.t15 ? x.t15 : 0),
  Af: (x) => (x.t15 !== 0 && x.t15 === x.hf ? x.t15 : 0),
  AfBreak: (x) => (x.t15 !== 0 && x.t15 === x.hf && x.hfBreak === x.t15 ? x.t15 : 0),
  H: (x) => x.hc,
};
// +1 bull / -1 bear / 0 neutral (not aligned). Unknown definition or no context -> 0 (no bias).
function state(ctx, def) {
  if (!ctx || !def || !DEFS[def]) return 0;
  return DEFS[def](ctx) || 0;
}

// LIVE: build the context statelessly from the analysis-builder series at mark T, so a restart mid-hour
// loses nothing. The forming hourly is the 1m candles since the last completed hourly closed.
function contextFromSeries(series, T) {
  const ab = require('./analysis-builder');
  const c15 = ab.completedAsOf(series['15m'], T);
  const s60 = series['60m'];
  const starts = s60.starts.filter((s) => s + s60.periodMs <= T);
  const h = starts.length ? s60.byStart.get(starts[starts.length - 1]) : null;
  const hp = starts.length > 1 ? s60.byStart.get(starts[starts.length - 2]) : null;
  const formFrom = starts.length ? starts[starts.length - 1] + s60.periodMs : -Infinity;
  const s1 = series['1m'];
  let form = null;
  for (const st of s1.starts) {
    if (st < formFrom || st + s1.periodMs > T) continue;
    const c = s1.byStart.get(st);
    if (!form) form = { open: c.open, high: c.high, low: c.low, close: c.close };
    else { form.high = Math.max(form.high, c.high); form.low = Math.min(form.low, c.low); form.close = c.close; }
  }
  return ctxOf(c15, h, hp, form);
}

function ctxOf(c15, h, hp, form) {
  return {
    t15: trendOf(c15),
    hc: colour(h),
    hcHH: h && hp ? (h.high > hp.high ? 1 : h.low < hp.low ? -1 : 0) : 0,
    hf: colour(form),
    hfBreak: form && h ? (form.high > h.high ? 1 : form.low < h.low ? -1 : 0) : 0,
  };
}

// BACKTEST: the dataset carries one analysis snapshot per 5m bar (completed candles only), so the
// tracker follows it bar by bar — the hourly that changed is the new completed one, and the forming hour
// is accumulated from the completed 5m candles since. Same OHLC as the live 1m build: an hour is a
// whole number of 5m candles and a 5m candle's high/low are its 1m extremes.
function makeTracker() {
  let curH = null, prevH = null, form = null, formFrom = null;
  return function step(A, epochMs) {
    const h = A && A['60m'];
    if (h && (!curH || h.open !== curH.open || h.close !== curH.close || h.high !== curH.high)) {
      prevH = curH; curH = h; form = null; formFrom = epochMs;
    }
    const c5 = A && A['5m'];
    if (c5 && formFrom != null && epochMs > formFrom) {
      if (!form) form = { open: c5.open, high: c5.high, low: c5.low, close: c5.close };
      else { form.high = Math.max(form.high, c5.high); form.low = Math.min(form.low, c5.low); form.close = c5.close; }
    }
    return ctxOf(A && A['15m'], curH, prevH, form);
  };
}

// Does a position fight the trend? (bull position in a bear trend or vice versa)
const against = (side, st) => (st === 1 && side === 'bear') || (st === -1 && side === 'bull');

module.exports = { trendOf, state, contextFromSeries, makeTracker, against, DEFS };
