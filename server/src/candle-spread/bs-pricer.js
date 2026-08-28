'use strict';
/**
 * Black–Scholes option pricer for the candle-spread HISTORICAL backtest.
 *
 * Why this exists: the live engine prices options off real Schwab chain snapshots. For historical
 * days we have no snapshots, so we model option marks analytically. NDX options are European and
 * cash-settled, so Black–Scholes is exact (no early-exercise fudge) — validated against captured
 * chains to ~1pt/leg mean error (see scripts/candle-spread/calibrate-iv.js).
 *
 * The engine consumes option quotes through a single seam — a `getLeg(type, strike)` accessor that
 * returns `{ mid, bid, ask }`. `makeSyntheticLegAccessor` produces exactly that from BS prices, so
 * the real strategy code (classifyOpen / shouldCover / the cover selectors / legsPayoff) runs
 * UNCHANGED on modeled prices — the backtest is the live strategy, just fed synthetic quotes.
 *
 * IV for historical days comes from a Bollinger-band-width → IV mapping calibrated on the captured
 * days (see calibrate-iv.js); this module only takes an IV (optionally strike-dependent for skew)
 * and prices with it.
 */

const YEAR_MS = 365 * 24 * 3600 * 1000;

// Standard normal CDF (Abramowitz–Stegun 7.1.26; ~1e-7 accuracy — ample for option pricing).
function ncdf(x) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + p * z);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-z * z);
  return 0.5 * (1 + sign * y);
}

// European Black–Scholes price. r defaults to 0 (0DTE carry is negligible and NDX quotes are
// effectively forward-priced intraday). tau in YEARS; vol annualized. tau<=0 or vol<=0 -> intrinsic.
function bsPrice(type, S, K, tau, vol, r = 0) {
  if (tau <= 0 || vol <= 0) return type === 'C' ? Math.max(S - K, 0) : Math.max(K - S, 0);
  const sqrtT = Math.sqrt(tau);
  const d1 = (Math.log(S / K) + (r + vol * vol / 2) * tau) / (vol * sqrtT);
  const d2 = d1 - vol * sqrtT;
  if (type === 'C') return S * ncdf(d1) - K * Math.exp(-r * tau) * ncdf(d2);
  return K * Math.exp(-r * tau) * ncdf(-d2) - S * ncdf(-d1);
}

// Implied vol from a price via bisection (robust; no vega/Newton edge cases near expiry).
function impliedVol(type, S, K, tau, price, r = 0) {
  const intrinsic = type === 'C' ? Math.max(S - K, 0) : Math.max(K - S, 0);
  if (!(price > intrinsic) || tau <= 0) return null;   // no extrinsic to solve for
  let lo = 1e-4, hi = 5, mid = 0;
  for (let i = 0; i < 80; i++) {
    mid = (lo + hi) / 2;
    (bsPrice(type, S, K, tau, mid, r) > price) ? (hi = mid) : (lo = mid);
  }
  return mid;
}

// Historical-day IV level from RELATIVE Bollinger band width (bandWidth / underlying) — the
// price-level-invariant vol proxy chosen for the backtest. Constants calibrated by
// scripts/candle-spread/calibrate-iv.js against the captured chains (PROVISIONAL: only 4 days so
// far, R²≈0.2 — but cover cost is insensitive to IV level, so this is low-stakes; re-run the
// calibrator as more live days accumulate and update these two numbers).
const IV_REL_INTERCEPT = 0.1733;
const IV_REL_SLOPE = 3.199;
function ivFromRelBandWidth(relWidth) {
  const iv = IV_REL_INTERCEPT + IV_REL_SLOPE * (relWidth || 0);
  return Math.max(0.05, Math.min(0.60, iv));   // clamp to a sane 5–60% range
}

// Years-to-expiry for a 0DTE PM-settled (16:00 ET) option, from an epoch-ms timestamp.
function tauFromTime(tsMs) {
  const et = new Date(new Date(tsMs).toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const close = new Date(et); close.setHours(16, 0, 0, 0);
  return Math.max(0, (close - et) / YEAR_MS);
}

/**
 * IV model: a base ATM vol plus an optional linear skew in log-moneyness.
 *   iv(K) = base + skew * ln(K / S)
 * (skew<0 = the usual equity-index shape: downside puts richer.) Calibrated per day in step C.
 */
function makeIvFn({ base, skew = 0 }, S) {
  return (K) => Math.max(1e-3, base + skew * Math.log(K / S));
}

// Bid/ask around the BS mid. Default models a proportional-plus-floor half-spread, tunable from the
// captured chains' observed bid/ask widths. Kept simple; covers/opens price off mid anyway.
function makeBidAsk({ relHalf = 0.06, absHalf = 0.5 } = {}) {
  return (mid) => {
    const half = Math.max(absHalf, mid * relHalf);
    return { bid: Math.max(0, mid - half), ask: mid + half };
  };
}

/**
 * Synthetic leg accessor with the engine's `getLeg(type, strike) -> { mid, bid, ask }` signature,
 * pricing each leg with BS at the given underlying / tau / IV(strike).
 */
function makeSyntheticLegAccessor({ underlying, tau, ivFn, bidAskFn = makeBidAsk(), r = 0 }) {
  return function getLeg(type, strike) {
    const vol = ivFn(strike);
    const mid = round2(bsPrice(type, underlying, strike, tau, vol, r));
    const { bid, ask } = bidAskFn(mid);
    return { mid, bid: round2(bid), ask: round2(ask), symbol: `${type}${strike}` };
  };
}

// Full synthetic chain in the captured-snapshot shape (for validation/inspection, not needed by the
// engine which only calls getLeg): { underlying, center, strikes:[{strike, call:{mid,bid,ask}, put}] }.
function buildSyntheticChain({ underlying, tau, ivFn, bidAskFn = makeBidAsk(), center, strikes, r = 0 }) {
  const get = makeSyntheticLegAccessor({ underlying, tau, ivFn, bidAskFn, r });
  return {
    underlying, center,
    strikes: strikes.map(K => ({ strike: K, call: strip(get('C', K)), put: strip(get('P', K)) })),
  };
}
function strip(q) { return { mid: q.mid, bid: q.bid, ask: q.ask }; }
function round2(n) { return Math.round(n * 100) / 100; }

module.exports = {
  ncdf, bsPrice, impliedVol, tauFromTime, ivFromRelBandWidth,
  makeIvFn, makeBidAsk, makeSyntheticLegAccessor, buildSyntheticChain,
  YEAR_MS,
};
