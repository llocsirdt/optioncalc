'use strict';
/**
 * STRIKE GRID — which strikes are actually listed and quoted near the money, and what width a variant may trade.
 *
 * Discovered live on 2026-11-05: NDX fell ~1,370 points and left the band where the exchange had listed 10-point 0DTE
 * strikes (every quoted non-50 strike that day sat in 27,260-28,070). Below it only 25-point strikes existed, and
 * further down only 100-point ones. Everything downstream assumed a fixed 10-point grid:
 *   - no 10/20/40-wide spread could be built, so every open after 10:15 was refused ("no chain quote/symbol for P27030");
 *   - the tradability gate sampled a 10-point grid of 17 strikes, found 3-4 quoted, and skipped 49 of 78 ticks —
 *     including the management of positions already open.
 *
 * THE RULE (user, 2026-11-05). Read the finest grid that is really there, then:
 *   grid <= 10  -> every variant trades its own width.
 *   grid == 25  -> 10W stops opening, 20W trades 25W, 40W trades 50W (both on the 25 grid).
 *   grid == 50  -> 40W trades 50W; 10W and 20W stop opening.
 *   coarser     -> no new opens ("I don't see us updating the strategies to work with 100pt spreads").
 * Positions already open keep their own width and are managed exactly as before. A thin grid never skips a tick.
 */

// The increments NDX strikes are listed on, finest first.
const GRIDS = [5, 10, 25, 50, 100];
// A grid counts as present when this many consecutive grid points on EACH side of the money are quoted, plus the one
// at the money. Three a side covers the adaptive placement walk (short leg up to 3 strikes ITM).
const SIDE_POINTS = 3;

function quotedContract(c) {
  if (!c) return false;
  if (c.mark != null && c.mark > 0) return true;
  return c.bid != null && c.ask != null && c.ask > 0;   // two-sided is enough even with a 0 bid
}

/**
 * Every strike in the chain for `expiration` with a usable quote on the call or the put, ascending.
 * `chainData` is the engine's {call:{expKey:{strikeKey:[contract]}}, put:{...}} shape.
 */
function quotedStrikes(chainData, expiration) {
  const out = new Set();
  if (!chainData) return [];
  for (const side of [chainData.call, chainData.put]) {
    if (!side) continue;
    const expKey = Object.keys(side).find((k) => !expiration || k.startsWith(expiration));
    if (!expKey || !side[expKey]) continue;
    for (const [k, arr] of Object.entries(side[expKey])) {
      if (quotedContract(Array.isArray(arr) ? arr[0] : null)) out.add(parseFloat(k));
    }
  }
  return [...out].filter((s) => Number.isFinite(s)).sort((a, b) => a - b);
}

/** How many strikes the chain lists for `expiration`, quoted or not (tells "no chain" from "a chain with no market"). */
function listedStrikeCount(chainData, expiration) {
  const out = new Set();
  for (const side of [chainData && chainData.call, chainData && chainData.put]) {
    if (!side) continue;
    const expKey = Object.keys(side).find((k) => !expiration || k.startsWith(expiration));
    if (expKey && side[expKey]) for (const k of Object.keys(side[expKey])) out.add(k);
  }
  return out.size;
}

/**
 * The finest grid present around `underlying`: the smallest g in GRIDS whose nearest grid point and SIDE_POINTS more
 * on each side are all quoted. null when even 100 is not (no market, or no chain).
 */
function localIncrement(strikes, underlying, opt = {}) {
  if (!(underlying > 0) || !strikes || !strikes.length) return null;
  const have = new Set(strikes);
  const n = opt.sidePoints != null ? opt.sidePoints : SIDE_POINTS;
  for (const g of GRIDS) {
    const c = Math.round(underlying / g) * g;
    let ok = true;
    for (let i = -n; i <= n && ok; i++) ok = have.has(c + i * g);
    if (ok) return g;
  }
  return null;
}

/** The grid reading for one tick: { incr, quoted (strikes within +-reach), near: [lo, hi] }. */
function assess(chainData, expiration, underlying, opt = {}) {
  const strikes = quotedStrikes(chainData, expiration);
  const reach = opt.reach != null ? opt.reach : 300;
  const near = strikes.filter((s) => Math.abs(s - underlying) <= reach);
  return { incr: localIncrement(strikes, underlying, opt), quoted: near.length, listed: listedStrikeCount(chainData, expiration),
    strikes, near: near.length ? [near[0], near[near.length - 1]] : null };
}

/**
 * The width and grid a variant of base width `baseW` (on base grid `baseIncr`) opens at, given the tick's grid.
 * Returns { width, incr, fallback } or { width: null, reason } when it must not open.
 */
function openWidthFor(baseW, baseIncr, gridIncr) {
  const b = baseIncr || 10;
  if (gridIncr == null) return { width: null, reason: 'no quoted strike grid near the money' };
  if (gridIncr <= b) return { width: baseW, incr: b, fallback: false };
  const alt = gridIncr === 25 ? { 20: 25, 40: 50 }[baseW]
    : gridIncr === 50 ? { 40: 50 }[baseW]
      : null;
  if (!alt) return { width: null, reason: `only ${gridIncr}-pt strikes near the money; no ${baseW}W fallback on that grid` };
  return { width: alt, incr: gridIncr, fallback: true };
}

module.exports = { GRIDS, SIDE_POINTS, quotedContract, quotedStrikes, listedStrikeCount, localIncrement, assess, openWidthFor };
