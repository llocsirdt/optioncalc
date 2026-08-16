/**
 * Candle-spread trader engine.
 *
 * On each 15-min candle close during RTH it runs the per-tick sequence:
 *   (1) cancel any unfilled prior OPEN order
 *   (2) classify the candle
 *   (3) COVER uncovered spreads if the candle's simple direction reversed
 *   (4) OPEN a new centered spread if the candle strictly qualifies
 * See spread-logic.js for the pure pieces and the project spec for the "why".
 *
 * SAFETY: order placement is INTERNAL (never via the dev-gated HTTP proxy) and is
 * gated by config.dryRun. While dryRun is true we build + log the full Schwab order
 * payload but DO NOT send it, and we assume the order fills at its limit so the day's
 * state machine and log play out and can be reviewed. Flipping real sending on is a
 * deliberate future step (see placeOrder()).
 */
const L = require('./spread-logic');
const store = require('./store');

let nextPositionSeq = 1;
function nextId(prefix) { return `${prefix}-${Date.now()}-${nextPositionSeq++}`; }

// --- Chain quote accessor --------------------------------------------------
// Returns { mid, symbol, bid, ask } for an option leg from a Schwab {call,put} chain,
// or null if not present. mid uses Schwab's `mark` (its mid/mark), matching the rest of
// the app. The exact contract `symbol` is read from the chain so we never hand-build
// OCC symbols.
function makeLegAccessor(chainData, expiration) {
  return function getLeg(type, strike) {
    if (!chainData) return null;
    const map = type === 'C' ? chainData.call : chainData.put;
    if (!map) return null;
    const expKey = Object.keys(map).find(k => k.startsWith(expiration));
    if (!expKey) return null;
    const strikeMap = map[expKey];
    const strikeKey = Object.keys(strikeMap).find(k => parseFloat(k) === strike);
    if (!strikeKey) return null;
    const c = strikeMap[strikeKey][0];
    if (!c) return null;
    const mid = c.mark != null ? c.mark : (c.bid != null && c.ask != null ? (c.bid + c.ask) / 2 : null);
    return mid == null ? null : { mid, symbol: c.symbol, bid: c.bid, ask: c.ask };
  };
}

// --- Order payload (Schwab shape) -----------------------------------------
function buildOrderPayload(resolvedLegs, limit, quantity, net /* 'DEBIT'|'CREDIT' */) {
  return {
    orderType: net === 'CREDIT' ? 'NET_CREDIT' : 'NET_DEBIT',
    session: 'NORMAL',
    price: limit,
    duration: 'DAY',
    orderStrategyType: 'SINGLE',
    complexOrderStrategyType: 'VERTICAL',
    orderLegCollection: resolvedLegs.map(l => ({
      instruction: l.side === 'long' ? 'BUY_TO_OPEN' : 'SELL_TO_OPEN',
      quantity,
      instrument: { symbol: l.symbol, assetType: 'OPTION' }
    }))
  };
}

// Resolve abstract legs ({side,type,strike}) to order legs with chain symbols + mids.
// Returns { resolved, longMid, shortMid } or { error }.
function resolveLegs(legs, getLeg) {
  const resolved = [];
  let longMid = null, shortMid = null;
  for (const leg of legs) {
    const q = getLeg(leg.type, leg.strike);
    if (!q || !q.symbol) return { error: `no chain quote/symbol for ${leg.type}${leg.strike}` };
    resolved.push({ ...leg, symbol: q.symbol, mid: q.mid });
    if (leg.side === 'long') longMid = q.mid; else shortMid = q.mid;
  }
  return { resolved, longMid, shortMid };
}

// --- Core per-tick sequence (testable) ------------------------------------
// deps: { getLeg(type,strike), placeOrder(payload, meta)->{status,filled}, dryRun }
function processCandleClose(record, candle, priorCandle, deps) {
  const cfg = record.config;
  const st = record.state;
  const decisions = [];

  const candleTime = candle.timeEST || String(candle.datetime);
  // De-dupe: never act twice on the same candle.
  if (st.lastCandleTime === candleTime) return { skipped: 'already-processed' };
  st.lastCandleTime = candleTime;

  const firstOfDay = !priorCandle;
  const bands = firstOfDay ? bandsFor(candle) : null;
  const simpleDir = L.simpleDirection(candle);
  const openSide = L.classifyOpen(candle, priorCandle, bands);

  // (1) Cancel any unfilled prior OPEN order before doing anything else.
  if (st.pendingOpenId) {
    const pos = st.positions.find(p => p.id === st.pendingOpenId);
    if (pos && !pos.filled) {
      deps.placeOrder && null; // (cancel path is internal; dry-run just logs)
      pos.orderStatus = 'cancelled';
      decisions.push({ action: 'cancel-open', positionId: pos.id, reason: 'unfilled at next candle' });
      // Remove the never-filled position from the working list.
      st.positions = st.positions.filter(p => p.id !== pos.id);
    }
    st.pendingOpenId = null;
  }

  // (3) COVER — uses SIMPLE direction only (ignores the high/low break): if the candle
  // closed opposite our held direction, cover every filled, uncovered spread 1:1. This
  // can happen in the same candle that also opens a new spread (step 4).
  if (st.direction !== 'none' && simpleDir !== 'flat' && simpleDir !== st.direction) {
    const uncovered = st.positions.filter(p => p.filled && !p.covered);
    for (const pos of uncovered) {
      const res = buildCover(pos, cfg, deps.getLeg);
      if (res.error) { decisions.push({ action: 'cover-skip', positionId: pos.id, error: res.error }); continue; }
      const placed = deps.placeOrder(res.payload, { kind: 'cover', of: pos.id, legs: res.legs, limit: res.limit, mark: res.mark });
      pos.covered = true;
      pos.coverId = nextId('cov');
      pos.coverLimit = res.limit;
      pos.coverStatus = placed.status;
      // Running LOCKED P&L: the covered debit-offset pair is a "tent" whose guaranteed
      // floor value = spreadWidth. So the locked floor = (width - openDebit - coverDebit)
      // * 100 * qty. (It can end higher near the shared strike; this is the floor.)
      const lockedFloor = (cfg.spreadWidth - pos.limit - res.limit) * 100 * cfg.quantity;
      st.realizedPnl = round2(st.realizedPnl + lockedFloor);
      decisions.push({ action: 'cover', positionId: pos.id, coverId: pos.coverId, legs: res.legs, mark: res.mark, cap: res.cap, limit: res.limit, lockedFloor });
    }
    // Cover-only reversal leaves us flat unless step 4 opens a new side below.
    st.direction = 'none';
  }

  // (4) OPEN — if the candle strictly qualifies. Neutral (openSide === null) intentionally
  // does nothing for now; this is the isolated branch to extend later.
  if (openSide) {
    const res = buildOpen(openSide, candle, cfg, deps.getLeg);
    if (res.error) {
      decisions.push({ action: 'open-skip', side: openSide, error: res.error });
    } else if (!(res.limit > 0)) {
      decisions.push({ action: 'open-skip', side: openSide, error: `non-positive limit (${res.limit}) — bad quotes`, mark: res.mark });
    } else {
      const placed = deps.placeOrder(res.payload, { kind: 'open', side: openSide, legs: res.legs, limit: res.limit, mark: res.mark });
      const pos = {
        id: nextId('pos'), side: openSide, legs: res.legs, quantity: cfg.quantity,
        shortStrike: res.shortStrike, mark: res.mark, cap: res.cap, limit: res.limit,
        orderStatus: placed.status, filled: !!placed.filled, covered: false, coverId: null,
        openedAt: new Date().toISOString()
      };
      st.positions.push(pos);
      // In dry-run we assume the fill; a filled open is NOT pending-cancel. If a real
      // (future) fill hasn't happened, it stays pending so the next candle cancels it.
      st.pendingOpenId = pos.filled ? null : pos.id;
      st.direction = openSide;
      decisions.push({ action: 'open', positionId: pos.id, side: openSide, legs: res.legs, mark: res.mark, cap: res.cap, limit: res.limit, filled: pos.filled });
    }
  } else {
    // PLACEHOLDER: neutral candle handling — no trade today; likely to add logic here.
    decisions.push({ action: 'neutral', simpleDir });
  }

  // PLACEHOLDER: coverTiming === 'each-candle' — cover the prior uncovered position on every
  // candle (not just reversals). Exact semantics (which side, continuing vs reversing) TBD.
  // if (cfg.coverTiming === 'each-candle') { ... }

  store.appendEvent(record, {
    type: 'candle_close',
    candle: { time: candle.timeEST, open: candle.open, high: candle.high, low: candle.low, close: candle.close },
    bands,
    classification: { simpleDir, openSide, firstOfDay },
    direction: st.direction,
    realizedPnl: st.realizedPnl,
    decisions
  });
  return { decisions };
}

// Bollinger bands for the first candle of the day from its own indicator payload.
function bandsFor(candle) {
  const bb = candle.indicators && candle.indicators.bollinger20_2;
  if (!bb) return null;
  return { upper: bb.upper, lower: bb.lower, middle: bb.middle };
}

function buildOpen(side, candle, cfg, getLeg) {
  const center = L.centerStrike(candle.close, cfg.strikeIncrement);
  const { lower, upper } = L.spreadStrikes(center, cfg.spreadWidth);
  const legs = L.openLegs(side, lower, upper);
  const { resolved, longMid, shortMid, error } = resolveLegs(legs, getLeg);
  if (error) return { error };
  const { mark, cap, limit } = L.debitLimit(longMid, shortMid, cfg.spreadWidth, cfg.tickIncrement);
  return {
    legs, lower, upper, shortStrike: L.shortStrikeOf(side, lower, upper),
    mark, cap, limit, payload: buildOrderPayload(resolved, limit, cfg.quantity, 'DEBIT')
  };
}

function buildCover(pos, cfg, getLeg) {
  // Default debit-offset cover. (credit style parked — needs its own pricing rule.)
  const legs = L.coverLegs(pos.side, pos.shortStrike, cfg.spreadWidth, cfg.coverStyle || 'debit-offset');
  const { resolved, longMid, shortMid, error } = resolveLegs(legs, getLeg);
  if (error) return { error };
  const { mark, cap, limit } = L.debitLimit(longMid, shortMid, cfg.spreadWidth, cfg.tickIncrement);
  return { legs, mark, cap, limit, payload: buildOrderPayload(resolved, limit, cfg.quantity, 'DEBIT') };
}

function round2(n) { return Math.round(n * 100) / 100; }

module.exports = {
  processCandleClose,
  makeLegAccessor,
  buildOrderPayload,
  buildOpen,
  buildCover,
  resolveLegs
};
