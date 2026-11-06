'use strict';
/**
 * TRADABILITY — may the engine act on this tick at all?
 *
 * Discovered live on 2026-09-07 (Labor Day): NDX was closed, /NQ was open and moving, and the engine ran
 * all day on a FROZEN NDX price (29,542.6487 on every tick) while happily evaluating signals. Nothing
 * stopped it. Two 15-minute decision points fired and both happened to return `neutral` — so the only
 * reason no order was attempted is that the signal did not fire. That is luck, not a safety property.
 *
 * WHY NOT A HOLIDAY CALENDAR. shared/market-calendar.js exists and could answer "is today a holiday", but
 * gating on the schedule is the wrong instrument, for the reason the user raised earlier: if Schwab has an
 * outage the system must not conclude "the market is closed" and stop trading a market that is actually
 * open — and conversely a calendar cannot see a halt, an early close, or a dead data feed. So this gates on
 * EVIDENCE instead: can we see a live price, and is there a real two-sided market to trade? That single
 * rule covers holidays, half-days, halts, and feed failures identically, and it fails toward not trading
 * for the honest reason "we cannot price this right now" rather than a guess about the calendar.
 *
 * TWO INDEPENDENT CHECKS, because on 2026-09-07 each one alone would have missed something:
 *
 *   1. PRICE FRESHNESS. The pricing instrument (cash NDX) must have moved recently enough to be believable.
 *      A closed market returns its last session's close forever, which looks like a perfectly valid number.
 *      The tell is that it does not CHANGE while the signal instrument does.
 *
 *   2. CHAIN QUOTES. "Does a chain exist" is NOT sufficient and would have passed on the holiday: Schwab
 *      returned a chain with 17 enumerated strikes. Every single one had bid/ask/mark = null. The chain
 *      was structurally present and completely untradable. So the check is whether enough strikes NEAR THE
 *      MONEY carry real two-sided quotes — which is what "there is a market" actually means.
 *
 *      COUNT THE STRIKES THAT ARE LISTED, NOT A GRID WE ASSUME (2026-11-05). This sampled a 10-point grid of 17
 *      strikes around the money. NDX fell ~1,370 points that day and left the band where 10-point strikes are
 *      listed; on the 25/100-point strikes that remained the sample found 3-4 quoted, under the threshold of 4,
 *      and the gate skipped 49 of 78 ticks of an open market — positions included. Now the gate counts every
 *      quoted strike the chain actually lists within MAX_REACH points, at whatever spacing (strike-grid.js), and
 *      needs only MIN_QUOTED_STRIKES of them. A sparse grid is a placement problem the strategies handle
 *      (strike-grid.openWidthFor); it is never a reason to stop ticking. The holiday chain had zero quotes.
 *
 * Today the engine survived this only because getLeg() returns null for a null mid, so an open could not
 * be assembled. That is incidental crash-avoidance downstream, not a decision, and it would have surfaced
 * as a mysterious failed open rather than a clear "the market is closed" record.
 */

// A price this stale cannot be the current market. Two 5m marks: tolerant of one missed/late bar, but a
// closed session (hours or days stale) is caught immediately.
const MAX_PRICE_AGE_MS = 10 * 60 * 1000;
// How many listed strikes within MAX_REACH of the money must carry a real quote before we call it a market. Low on
// purpose: a closed market quotes NOTHING (2026-09-07: 0 of 17), while an open one far from its 10-point band may
// list only 100-point strikes — still a market, and positions there still need managing.
const MIN_QUOTED_STRIKES = 2;
const MAX_REACH = 300;

function isQuoted(leg) {
  if (!leg) return false;
  const bid = leg.bid, ask = leg.ask, mark = leg.mark;
  if (mark != null && mark > 0) return true;
  return bid != null && ask != null && ask > 0;   // two-sided is enough even with a 0 bid
}

/**
 * Count strikes near `underlying` that have a usable quote on either ladder.
 * `chainSnapshot` is the {underlying, strikes:[{strike, call, put}]} shape the engine already records.
 */
function quotedNearMoney(chainSnapshot, underlying, window) {
  if (!chainSnapshot || !Array.isArray(chainSnapshot.strikes)) return 0;
  const w = window != null ? window : MAX_REACH;   // points either side
  let n = 0;
  for (const s of chainSnapshot.strikes) {
    if (!(Math.abs(s.strike - underlying) <= w)) continue;
    if (isQuoted(s.call) || isQuoted(s.put)) n++;
  }
  return n;
}

/**
 * @param o.underlying      the pricing instrument's current value
 * @param o.priceAsOfMs     when that value was last actually observed to change/print (null = unknown)
 * @param o.nowMs           the tick's mark
 * @param o.quotedStrikes   every strike the chain lists with a usable quote (strike-grid.quotedStrikes) — preferred
 * @param o.chainSnapshot   legacy: a {strikes:[{strike,call,put}]} snapshot, used only when quotedStrikes is absent
 * @param o.lastUnderlying  the previous tick's underlying, for the frozen-price tell (optional)
 * @returns {ok, reason, detail} — ok:false means DO NOT open or send on this tick.
 */
function assess(o) {
  const now = o.nowMs != null ? o.nowMs : Date.now();

  if (!(o.underlying > 0)) return { ok: false, reason: 'no-underlying', detail: 'pricing instrument has no value' };

  if (o.priceAsOfMs != null) {
    const age = now - o.priceAsOfMs;
    if (age > MAX_PRICE_AGE_MS) {
      return { ok: false, reason: 'stale-price',
        detail: `pricing instrument last printed ${Math.round(age / 60000)}m ago (limit ${MAX_PRICE_AGE_MS / 60000}m) — closed session, halt, or dead feed` };
    }
  }

  const reach = o.strikeWindow != null ? o.strikeWindow : MAX_REACH;
  const byList = Array.isArray(o.quotedStrikes);
  const quoted = byList
    ? o.quotedStrikes.filter((k) => Math.abs(k - o.underlying) <= reach).length
    : quotedNearMoney(o.chainSnapshot, o.underlying, reach);
  if (quoted < MIN_QUOTED_STRIKES) {
    // Distinguish "no chain at all" from "a chain with no market" — they look identical downstream but
    // mean different things when reading the log later.
    const listed = byList ? (o.listedStrikes != null ? o.listedStrikes : o.quotedStrikes.length)
      : (o.chainSnapshot && Array.isArray(o.chainSnapshot.strikes) ? o.chainSnapshot.strikes.length : 0);
    return { ok: false, reason: listed ? 'chain-not-quoted' : 'no-chain',
      detail: listed
        ? `${listed} strikes listed but only ${quoted} within ${reach} pts of the money carry a quote (need ${MIN_QUOTED_STRIKES}) — the market is not open`
        : 'no option chain returned for this expiration' };
  }

  return { ok: true, reason: 'tradable', detail: `${quoted} quoted strikes within ${reach} pts of the money` };
}

module.exports = { assess, quotedNearMoney, isQuoted, MAX_PRICE_AGE_MS, MIN_QUOTED_STRIKES, MAX_REACH };
