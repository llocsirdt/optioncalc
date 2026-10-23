'use strict';
/**
 * PRICE-TARGET STRIKE PICK (v21, 2026-10-21; live port 2026-10-23) — ONE selection rule for both engines.
 *
 * Of every vertical of width W on the strike grid (short strike within ±span strikes of the money), take the one
 * whose mark is closest to f x W; on a tie, the one nearest the money (spread centre closest to S). No decline:
 * the price is the decision. Pure — the caller supplies the marks:
 *   backtest  backtest-width.makePriceTargetGeo: Black-Scholes on band IV x intraday mult x skew (legsMark)
 *   live      trader.buildOpenPriceTarget: the REAL chain, the same quotes and quote gates the live open pricer uses
 *             (a candidate the gates refuse has no mark and is skipped, like a missing quote)
 *
 * WALK CAP (the same rule in both engines): the open is placed at its mark ceiled to the tick and the ladder may walk it
 * to max(limit, walkCapFrac x W), walkCapFrac = f + (parent capFrac - 0.50) — the parent family's room above the 50%
 * band centre, carried over to the price target.
 */
const SPAN = 12;

// Legs of the vertical with short strike `shortStrike` (debit-canonical: bull call / bear put).
function legsAt(side, shortStrike, width) {
  const lo = side === 'bull' ? shortStrike - width : shortStrike;
  const hi = side === 'bull' ? shortStrike : shortStrike + width;
  const legs = side === 'bull'
    ? [{ side: 'long', type: 'C', strike: lo }, { side: 'short', type: 'C', strike: hi }]
    : [{ side: 'long', type: 'P', strike: hi }, { side: 'short', type: 'P', strike: lo }];
  return { legs, lo, hi };
}

// -> { legs, shortStrike, lo, hi, mark, err, dist, tried } | null (no candidate had a positive mark)
function pickByPrice(side, S, width, f, markOf, { incr = 10, span = SPAN } = {}) {
  const center = Math.floor(S / incr) * incr, target = f * width;
  let best = null, tried = 0;
  for (let k = -span; k <= span; k++) {
    const shortStrike = side === 'bull' ? center + k * incr : center - k * incr;
    const { legs, lo, hi } = legsAt(side, shortStrike, width);
    const mark = markOf(legs);
    if (!(mark > 0)) continue;
    tried++;
    const err = Math.round(Math.abs(mark - target) * 1e6), dist = Math.abs((lo + hi) / 2 - S);
    if (!best || err < best.err || (err === best.err && dist < best.dist)) best = { legs, shortStrike, lo, hi, mark, err, dist };
  }
  if (best) best.tried = tried;
  return best;
}

// The walk cap fraction for price target f on a parent whose placement ceiling is parentCapFrac.
function walkCapFracFor(f, parentCapFrac) {
  return Math.round((f + ((parentCapFrac != null ? parentCapFrac : 0.55) - 0.5)) * 10000) / 10000;
}

module.exports = { pickByPrice, walkCapFracFor, legsAt, SPAN };
