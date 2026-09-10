'use strict';
/**
 * regime-buckets.js — REGIME CLASSIFICATION for the pattern/regime study.
 *
 * The question this exists to serve: the open-only study found EVERY bullish 5m reversal pattern
 * profitable and EVERY bearish one unprofitable over 765 days, and proved with a signal-free drift
 * benchmark that this is DIRECTION (the sample roughly doubled while the BS pricer assumes zero drift),
 * not pattern quality. If the patterns carry anything at all, the bearish ones should earn their keep
 * in DOWN regimes. So: partition, and re-measure inside each partition against that partition's OWN
 * drift.
 *
 * ── NO-LOOKAHEAD CONTRACT ───────────────────────────────────────────────────────────────────────
 * Every feature here is computable at the moment of the entry decision. This codebase has already
 * shipped one 5-minute lookahead bug (build-dual-dataset.js), so the rules are stated, not assumed:
 *
 *   DAY-LEVEL features use only days STRICTLY BEFORE the classified day. The daily series is built
 *   from each day's RTH settle close; day i's bucket reads closes at i-1, i-2, ... and never i.
 *   The daily BB(20,2) is likewise READ AT INDEX i-1 — the bands as they stood at yesterday's close,
 *   which is what a trader has in hand at this morning's bell.
 *
 *   BAR-LEVEL features read `bar.analysis`, which the dataset builder defines as "the most recently
 *   COMPLETED candle of that timeframe as of the bar's timestamp" (slotAt() in build-dual-dataset.js:
 *   the newest slot with slot.datetime + period <= T). So A['5m'] at bar T is the candle covering
 *   [T-5m, T) and A['60m'] is the last fully closed hour. Both are strictly past information. This is
 *   the same data the pattern detectors and the existing band setups already read, so the regime tag
 *   and the signal see exactly the same world.
 *
 * ── DAY-LEVEL BUCKETS ───────────────────────────────────────────────────────────────────────────
 *   t1     prior day's close-to-close sign                          up | down
 *   t5     5-day return through yesterday, +/-1%                    up | flat | down
 *   t20    20-day return through yesterday, +/-2%                   up | flat | down
 *   t50    50-day return through yesterday, +/-4%                   up | flat | down
 *   ma20   yesterday's close vs the 20-day SMA                      above | below
 *   stretch  BOTH the 20d and 50d returns negative = a genuine multi-week bearish STRETCH, which is
 *            the regime the hypothesis is actually about (a single red day is noise).
 *   dd50   yesterday's close vs the trailing 50-day high            drawdown(<=-5%) | near-high
 *   dband  yesterday's close inside the DAILY BB(20,2) computed through i-1
 *
 * Thresholds are round numbers chosen to split the sample into usable pieces rather than tuned; the
 * printed bucket counts show what each one actually caught, and the study refuses to read thin cells.
 *
 * ── BAR-LEVEL BUCKETS ───────────────────────────────────────────────────────────────────────────
 *   b60 / b15   where the entry bar's 5m CLOSE sits inside the 60m / 15m Bollinger band:
 *               belowLower (%B < 0) | lowerHalf (0..0.5) | upperHalf (0.5..1) | aboveUpper (%B > 1)
 *   tod         time-of-day bin (30-minute), used ONLY to build a time-matched drift baseline —
 *               0DTE P&L is violently time-dependent, so a pattern that happens to fire at 09:35
 *               would otherwise be credited with the difference between 09:35 and 15:30.
 */
const { bollinger } = require('../signal-lab/indicators');

const RTH_LO = 575, RTH_HI = 955;   // the engine's action window (backtest-v6-5m inRth)
const etMin = ms => { const d = new Date(new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York' })); return d.getHours() * 60 + d.getMinutes(); };

// The action bars the engine will actually call signalFn on, in order. Must match runDay5m's
// `if (rthOnly && !inRth(bars[i].dt)) continue;` exactly or every index mapping below is off by n.
const actionBars = bars => bars.filter(b => { const m = etMin(b.dt); return m >= RTH_LO && m <= RTH_HI; });

// The day's settle close, by the same rule runDay5m uses for rthOnly settlement: the LAST bar in
// [575, 960]. /NQ here — this dataset carries no separate NDX series, and regime is a SIGNAL feature,
// which is /NQ's job under the foundational split.
function dayClose(bars) {
  for (let k = bars.length - 1; k >= 0; k--) { const m = etMin(bars[k].dt); if (m >= RTH_LO && m <= 960) return bars[k].analysis['5m'].close; }
  return null;
}

const pct = (a, b) => (b > 0 ? a / b - 1 : null);

/**
 * @param {Array<{date,bars}>} days  tradeable days, chronological
 * @returns {Map<string, object>} date -> day-level regime tags (null-valued where warmup is short)
 */
function classifyDays(days) {
  const C = days.map(d => dayClose(d.bars));
  const daily = C.map(c => ({ close: c }));
  const bb = bollinger(daily, 20, 2);
  const out = new Map();
  for (let i = 0; i < days.length; i++) {
    const p = k => (i - k >= 0 ? C[i - k] : null);            // close k days back (k>=1 => strictly prior)
    const c1 = p(1);
    const tag = { t1: null, t5: null, t20: null, t50: null, ma20: null, stretch: null, dd50: null, dband: null, r20: null, r50: null };
    if (c1 != null && p(2) != null) tag.t1 = c1 > p(2) ? 'up' : c1 < p(2) ? 'down' : 'flat';
    const r = k => (c1 != null && p(k + 1) != null ? pct(c1, p(k + 1)) : null);
    const r5 = r(5), r20 = r(20), r50 = r(50);
    tag.r20 = r20; tag.r50 = r50;
    if (r5 != null) tag.t5 = r5 > 0.01 ? 'up' : r5 < -0.01 ? 'down' : 'flat';
    if (r20 != null) tag.t20 = r20 > 0.02 ? 'up' : r20 < -0.02 ? 'down' : 'flat';
    if (r50 != null) tag.t50 = r50 > 0.04 ? 'up' : r50 < -0.04 ? 'down' : 'flat';
    if (r20 != null && r50 != null) tag.stretch = (r20 < 0 && r50 < 0) ? 'bear' : (r20 > 0 && r50 > 0) ? 'bull' : 'mixed';
    if (i >= 20 && c1 != null) {
      const b = bb[i - 1];                                    // bands AS OF YESTERDAY'S CLOSE
      if (b && b.bbMiddle != null) {
        tag.ma20 = c1 > b.bbMiddle ? 'above' : 'below';
        const W = b.bbUpper - b.bbLower;
        if (W > 0) tag.dband = bandBucket((c1 - b.bbLower) / W);
      }
    }
    if (i >= 51) {
      let hi = -Infinity;
      for (let j = i - 50; j <= i - 1; j++) if (C[j] > hi) hi = C[j];
      if (hi > 0 && c1 != null) tag.dd50 = (c1 / hi - 1) <= -0.05 ? 'drawdown' : 'near-high';
    }
    out.set(days[i].date, tag);
  }
  return out;
}

// %B bucketing, shared by the 15m/60m intraday bands and the daily band.
function bandBucket(pctB) {
  if (pctB == null || !Number.isFinite(pctB)) return null;
  if (pctB < 0) return 'belowLower';
  if (pctB < 0.5) return 'lowerHalf';
  if (pctB <= 1) return 'upperHalf';
  return 'aboveUpper';
}

// %B of the entry bar's 5m close inside timeframe `tf`'s last-closed Bollinger band.
function pctBAt(A, tf) {
  const b = A && A[tf], c5 = A && A['5m'];
  if (!b || !c5 || b.bbupper == null || b.bblower == null) return null;
  const W = b.bbupper - b.bblower;
  return W > 0 ? (c5.close - b.bblower) / W : null;
}

// 30-minute time-of-day bin label, e.g. '09:30'. Used only for the time-matched drift baseline.
function todBin(ms) {
  const m = etMin(ms), s = Math.floor(m / 30) * 30;
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}

module.exports = { etMin, actionBars, dayClose, classifyDays, bandBucket, pctBAt, todBin, RTH_LO, RTH_HI };
