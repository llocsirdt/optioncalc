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
function makeLegLedger() {
  const sides = new Map();
  const key = (type, strike) => `${String(type).toUpperCase()}${strike}`;
  return {
    conflicts(legs) {
      for (const l of legs) { const s = sides.get(key(l.type, l.strike)); if (s && s !== l.side) return true; }
      return false;
    },
    record(legs) { for (const l of legs) { const k = key(l.type, l.strike); if (!sides.has(k)) sides.set(k, l.side); } },
    sideOf(type, strike) { return sides.get(key(type, strike)) || null; },
    size() { return sides.size; },
  };
}

// Resolve an OPEN. side 'bull'|'bear'; lo/hi the ideal strikes (hi = lo + width). preferStyle 'debit'|
// 'credit' = the cash-alternation preference. Order: preferred@ideal → other-style@ideal (parity twin,
// same strikes) → strike shifts ±incr, nearest first, both styles. Returns { legs (actual, style-specific),
// style, lo, hi, shift, resolution: 'ideal'|'twin'|'shift' } or { resolution: 'skip' }.
function resolveOpen(side, lo, hi, ledger, opts) {
  const incr = opts.incr, maxShift = opts.maxShift != null ? opts.maxShift : 6;
  const prefer = opts.preferStyle || 'debit';
  const styles = prefer === 'credit' ? ['credit', 'debit'] : ['debit', 'credit'];
  const tryAt = (l, h, shift) => {
    for (const style of styles) {
      const legs = CL.openLegsFor(side, l, h, style);
      if (!ledger.conflicts(legs)) return { legs, style, lo: l, hi: h, shift, resolution: shift === 0 ? (style === prefer ? 'ideal' : 'twin') : 'shift' };
    }
    return null;
  };
  let r = tryAt(lo, hi, 0);
  if (r) return r;
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
  const maxWing = opts.maxWingShift != null ? opts.maxWingShift : 8;
  const styles = prefer === 'credit' ? ['credit', 'debit'] : ['debit', 'credit'];
  for (const style of styles) {   // ideal / twin: tent-width wing
    const legs = CL.coverLegsFor(coveredSide, shortStrike, width, style);
    if (!ledger.conflicts(legs)) return { legs, style, wing: width, resolution: style === prefer ? 'ideal' : 'twin' };
  }
  for (let w = width + incr; w <= width + maxWing * incr; w += incr) {   // wing-shift out to a free strike
    for (const style of styles) {
      const legs = CL.coverLegsFor(coveredSide, shortStrike, w, style);
      if (!ledger.conflicts(legs)) return { legs, style, wing: w, resolution: 'wingShift' };
    }
  }
  return { resolution: 'skip' };
}

module.exports = { makeLegLedger, resolveOpen, resolveCover };
