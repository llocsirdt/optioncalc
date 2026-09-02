'use strict';
/**
 * FOUR-LEG COMBO (cover + open in ONE atomic order).
 *
 * CoverToStack normally rests a cover to free budget, THEN opens the new position — two separate orders, and
 * the open depends on the cover filling on a stressed day (a cap breach during a fast move, when fills are
 * least reliable). Bundling the cover spread (2 legs) + the new open spread (2 legs) into ONE net-limit order
 * makes them fill as a UNIT or not at all: no half-execution, no cap breach from a partial, and — because the
 * winner's cover is a CREDIT (reclaim ~width) while the new open is a DEBIT — the NET is small (sometimes a
 * credit), so a balanced defined-risk combo fills near mid and ties up little capital.
 *
 * This module is PURE and pricing-injected (BS mark in backtest, real chain live), isomorphic like
 * capital-legs / leg-ledger / risk-curve / risk-harvest. Leg shape = { side:'long'|'short', type:'C'|'P',
 * strike }. Net convention: net > 0 = NET_DEBIT (we pay); net < 0 = NET_CREDIT (we receive); limit = |net|.
 */

const round2 = n => Math.round(n * 100) / 100;
const legKey = l => `${l.type}${l.strike}`;                 // a contract identity (type+strike; ignores side)

// Signed net (per share) of a single spread: +long mid, −short mid. mark(type,strike) → mid (or null).
function spreadNet(legs, mark) {
  let n = 0;
  for (const l of legs) { const p = mark(l.type, l.strike); if (p == null) return null; n += (l.side === 'long' ? 1 : -1) * p; }
  return round2(n);
}

// Combined 4-leg set. `distinct` is false when any CONTRACT (type+strike) appears in BOTH spreads — those
// legs net at the broker, so the combo can't be a clean 4-legger (caller must fall back to the sequential
// cover-then-open, or shift a wing). `collisions` names the offending contracts.
function comboLegs(coverLegs, openLegs) {
  const legs = [...coverLegs, ...openLegs];
  const seen = new Set(), collisions = [];
  for (const l of legs) { const k = legKey(l); if (seen.has(k)) collisions.push(k); else seen.add(k); }
  return { legs, distinct: collisions.length === 0, collisions };
}

// Net cost of the whole combo, with the marketable haircut: every leg crosses toward the far side (buy the
// longs at ask, sell the shorts at bid), so a per-leg `slip` (price units, ~0.05–0.10) ADDS to the net in
// the worse-for-us direction regardless of sign (bigger debit / smaller credit). Returns { net, side, limit }
// (limit = |net|, the price to send), or null if any leg is unquotable. Economics-equivalent to sending the
// two spreads separately — comboNet === spreadNet(cover) + spreadNet(open) at slip 0 (proven in the test).
function comboNet(coverLegs, openLegs, mark, slip) {
  const cn = spreadNet(coverLegs, mark), on = spreadNet(openLegs, mark);
  if (cn == null || on == null) return null;
  const nLegs = coverLegs.length + openLegs.length;
  const net = round2(cn + on + (slip || 0) * nLegs);
  return { net, side: net >= 0 ? 'DEBIT' : 'CREDIT', limit: round2(Math.abs(net)), coverNet: cn, openNet: on };
}

// Merge legs by CONTRACT (type+strike) at `baseQty` per leg: same-direction duplicates sum into one leg at
// higher quantity, opposite-direction pairs net down. After proper per-spread leg-uniqueness resolution the
// opposite case shouldn't occur (that's the netting the resolver prevents) — but netting here keeps the
// order well-formed if it ever does. Result: ≤4 distinct legs, each with its own quantity. Preserves symbol.
function mergeLegs(legs, baseQty) {
  const q = baseQty || 1, by = new Map();
  for (const l of legs) {
    const k = legKey(l), cur = by.get(k) || { type: l.type, strike: l.strike, net: 0, symbol: l.symbol };
    cur.net += (l.side === 'long' ? 1 : -1) * q;
    if (l.symbol) cur.symbol = l.symbol;
    by.set(k, cur);
  }
  const out = [];
  for (const c of by.values()) if (c.net !== 0) out.push({ type: c.type, strike: c.strike, side: c.net > 0 ? 'long' : 'short', quantity: Math.abs(c.net), symbol: c.symbol });
  return out;
}

// Schwab CUSTOM multi-leg order for the combo. BOTH spreads are OPENING trades (the cover ADDS the offsetting
// tent; it does not close the original position — the original stays open and the pair settles as a locked
// tent), so every leg is BUY/SELL_TO_OPEN. resolvedLegs carry { side, symbol }; a per-leg `quantity` (from
// mergeLegs) wins over the flat `quantity` arg. netLimit is |net| (positive).
function buildComboPayload(resolvedLegs, netLimit, quantity, net /* 'DEBIT'|'CREDIT' */) {
  return {
    orderType: net === 'CREDIT' ? 'NET_CREDIT' : 'NET_DEBIT',
    session: 'NORMAL',
    price: netLimit,
    duration: 'DAY',
    orderStrategyType: 'SINGLE',
    complexOrderStrategyType: 'CUSTOM',                     // ≤4 arbitrary legs (not a named 2-leg VERTICAL)
    orderLegCollection: resolvedLegs.map(l => ({
      instruction: l.side === 'long' ? 'BUY_TO_OPEN' : 'SELL_TO_OPEN',
      quantity: l.quantity != null ? l.quantity : quantity,
      instrument: { symbol: l.symbol, assetType: 'OPTION' }
    }))
  };
}

module.exports = { spreadNet, comboLegs, comboNet, mergeLegs, buildComboPayload };
