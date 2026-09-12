'use strict';
/**
 * LEG-UNIQUENESS ledger + placement resolver. A leg = (type, strike). Intraday a leg may only be traded
 * ONE direction — every use bought-to-open, or every use sold-to-open — never both. The broker nets
 * same-symbol positions to a single net quantity, so shorting a strike you're already long silently closes
 * part of that long and entangles the intended book of spreads. The ledger records each committed leg's
 * side; the resolver finds a placement that respects it, preferring the PARITY TWIN at the SAME strikes
 * (keeps the tent's short strike + P&L; only moves to the other option ladder + flips debit/credit) before
 * SHIFTING strikes (which drags the tent off center). Pure + isomorphic; shared by backtest and live.
 */
const CL = require('./capital-legs');

// A per-day ledger. key = "<TYPE><strike>" e.g. "C29300". First use of a leg fixes its side; same-side
// re-use is fine (stacking / adding to the position). conflicts() = any leg would trade the opposite side.
// Backed by a plain object (`backing`) so it can live on the run state (JSON-serializable) and survive a
// restart mid-day; call makeLegLedger(state.legLedger || (state.legLedger = {})).
function makeLegLedger(backing) {
  const sides = backing || {};
  const key = (type, strike) => `${String(type).toUpperCase()}${strike}`;
  return {
    conflicts(legs) {
      for (const l of legs) { const s = sides[key(l.type, l.strike)]; if (s && s !== l.side) return true; }
      return false;
    },
    record(legs) { for (const l of legs) { const k = key(l.type, l.strike); if (!(k in sides)) sides[k] = l.side; } },
    sideOf(type, strike) { return sides[key(type, strike)] || null; },
    size() { return Object.keys(sides).length; },
  };
}

// Is a spread at these strikes NOT fully out of the money? A call is ITM when spot > strike, a put when
// spot < strike, so a bull (long C lo / short C hi) is fully OTM at spot <= lo and a bear (long P hi /
// short P lo) is fully OTM at spot >= hi. Shared so live and backtest cannot drift on the definition.
function notFullyOtm(side, lo, hi, underlying) {
  if (!(underlying > 0)) return true;                 // no price to judge against -> don't veto
  return side === 'bull' ? underlying > lo : underlying < hi;
}

// Resolve an OPEN. side 'bull'|'bear'; lo/hi the ideal strikes (hi = lo + width). preferStyle 'debit'|
// 'credit' = the cash-alternation preference. Order: preferred@ideal → other-style@ideal (parity twin,
// same strikes) → strike shifts ±incr, nearest first, both styles. Returns { legs (actual, style-specific),
// style, lo, hi, shift, resolution: 'ideal'|'twin'|'shift' } or { resolution: 'skip' }.
//
// opts.allow(lo, hi) — optional VETO on a placement. The opening rule is that an initial order never
// STARTS fully out of the money; adaptive placement already guarantees that, but a leg-uniqueness shift
// rebuilt at the shifted strikes without re-checking it, which is how 7 of 1,382 opens on 2026-09-08 went
// out (each exactly one increment past the boundary — a single shift). Passing `allow` closes that hole
// for both engines at once. It is deliberately a HARD veto, not a penalty: crossing OTM later while
// working an order is fine, starting there is not.
function resolveOpen(side, lo, hi, ledger, opts) {
  const incr = opts.incr, maxShift = opts.maxShift != null ? opts.maxShift : 6;
  const prefer = opts.preferStyle || 'debit';
  const allow = opts.allow || (() => true);
  const styles = prefer === 'credit' ? ['credit', 'debit'] : ['debit', 'credit'];
  const tryAt = (l, h, shift) => {
    if (!allow(l, h)) return null;
    for (const style of styles) {
      const legs = CL.openLegsFor(side, l, h, style);
      if (!ledger.conflicts(legs)) return { legs, style, lo: l, hi: h, shift, resolution: shift === 0 ? (style === prefer ? 'ideal' : 'twin') : 'shift' };
    }
    return null;
  };
  let r = tryAt(lo, hi, 0);
  if (r) return r;
  // Nearest-first, and +k (deeper in the money) BEFORE -k (back toward and past the money) at each
  // distance — so the resolver spends strikes toward the money-side the strategy wants before it spends
  // them the other way. With `allow` supplied the -k branch simply runs out of legal placements first.
  for (let k = 1; k <= maxShift; k++) {
    r = tryAt(lo + k * incr, hi + k * incr, k) || tryAt(lo - k * incr, hi - k * incr, -k);
    if (r) return r;
  }
  return { resolution: 'skip' };
}

// Resolve a COVER. The short leg stays at the position's shortStrike (that's the tent floor); we try the
// ideal tent-width wing in both styles (parity-neutral pair) first, then WING-SHIFT — move the long wing
// out to a free strike (an "anchor cover", already in the strategy's geometry). Returns { legs, style,
// wing, resolution: 'ideal'|'twin'|'wingShift' } or { resolution: 'skip' }. wing !== width means the P&L
// must be repriced from the actual legs. maxWingShift bounds how far the wing may move (in incr).
function resolveCover(coveredSide, shortStrike, width, ledger, opts) {
  opts = opts || {};
  const prefer = opts.preferStyle || 'debit';
  const incr = opts.incr || 10;
  // maxWingShift is kept as the option name for compatibility; it now bounds the ITM SLIDE, not a width change.
  const maxShift = opts.maxCoverShift != null ? opts.maxCoverShift : (opts.maxWingShift != null ? opts.maxWingShift : 8);
  const styles = prefer === 'credit' ? ['credit', 'debit'] : ['debit', 'credit'];
  for (const style of styles) {   // ideal / twin: tent-width wing
    const legs = CL.coverLegsFor(coveredSide, shortStrike, width, style);
    if (!ledger.conflicts(legs)) return { legs, style, wing: width, shift: 0, anchor: shortStrike, resolution: style === prefer ? 'ideal' : 'twin' };
  }
  // SLIDE THE WHOLE SPREAD, WIDTH UNCHANGED. The old behaviour moved only the LONG leg out to a free
  // strike, which changed the cover's WIDTH — and a different-width spread does not cover the original:
  // it re-introduces risk on the opposite side that nothing in the book is tracking, and it broke the
  // `W - open - cover` lock arithmetic that assumes value >= W everywhere. Measured on 2026-09-11 prod,
  // 98 of 103 wing-shifted covers (95%) locked a GUARANTEED LOSS totalling -$136,080, against 4% on the
  // unshifted path.
  //
  // Instead translate BOTH legs together, deeper in the money, keeping the width equal to the position's.
  // A parallel shift preserves the tent: for a bull open the cover is a put spread whose payoff is
  // clamp((anchor+W)-S, 0, W), and summed with the call spread's clamp(S-(K-W), 0, W) the minimum stays
  // exactly W for any ITM offset — so the lock price is unchanged and `W - open - cover` stays true.
  // (Shifting the other way, OTM, eventually breaks that: once the cover stops paying where the open pays
  // nothing the floor collapses to 0, which is why only the ITM direction is searched.)
  //
  // Different-width covers are a real strategy, but they need continuous per-side risk tracking that does
  // not exist yet — so they are deliberately NOT generated here.
  for (let s = 1; s <= maxShift; s++) {
    const anchor = coveredSide === 'bull' ? shortStrike + s * incr : shortStrike - s * incr;
    for (const style of styles) {
      const legs = CL.coverLegsFor(coveredSide, anchor, width, style);
      if (!ledger.conflicts(legs)) return { legs, style, wing: width, shift: s * incr, anchor, resolution: 'shift' };
    }
  }
  return { resolution: 'skip' };
}

module.exports = { makeLegLedger, resolveOpen, resolveCover, notFullyOtm };
