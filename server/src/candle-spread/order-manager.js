'use strict';
/**
 * Live order lifecycle for the candle-spread trader.
 *
 * Records every REAL order sent to Schwab (on record.state.liveOrders), polls each one's status,
 * records fills, and auto-cancels (a) test-mode "unfillable" orders after a short delay and
 * (b) stale working OPEN orders that outlived their candle. This is the closed-loop broker layer;
 * it runs ONLY when a real order was actually sent (i.e. it produced an orderId). In dry-run/sim
 * there are no liveOrders and this module is inert — the state machine's assume-fill model is
 * completely untouched.
 *
 * DECOUPLING NOTE: today the trader's state machine still assumes fills for its OWN strategy
 * simulation/analysis (so the run record always reflects the intended strategy). This layer tracks
 * what actually happened at the broker ALONGSIDE that. Driving the next strategy decision off real
 * fills (full closed loop) is a deliberate later step; test mode (orders never fill by design) is
 * exactly the safe case where the two are meant to diverge.
 */

const store = require('./store');

// Schwab order statuses. Terminal = no longer working; DEAD = terminal-but-not-filled.
// PENDING_CANCEL IS NOT DEAD. It means the broker ACCEPTED a cancel request, not that the order stopped
// working — the exchange can still fill it. Treating it as terminal stopped polling the row, so a fill that
// beat the cancel was never seen (and a cover's pendingCover was cleared, inviting a second cover). It now
// maps to 'working' and keeps being polled until CANCELED or FILLED actually arrives.
const DEAD = new Set(['CANCELED', 'REJECTED', 'EXPIRED', 'REPLACED']);
const TERMINAL = new Set(['FILLED', ...DEAD]);

function isTerminal(o) { return o && (o.status === 'filled' || o.status === 'canceled' || o.status === 'rejected' || o.status === 'expired'); }

// Map a raw Schwab status string to our lowercase lifecycle state.
function mapStatus(schwabStatus) {
  const s = String(schwabStatus || '').toUpperCase();
  if (s === 'FILLED') return 'filled';
  if (s === 'CANCELED') return 'canceled';
  if (s === 'REJECTED') return 'rejected';
  if (s === 'EXPIRED') return 'expired';
  if (s === 'REPLACED') return 'canceled';
  return 'working';
}

// Transform an order payload's limit into an intentionally UNFILLABLE price for test mode.
//   DEBIT (we pay): offer far too little  -> price * frac (default 0.1) — nobody sells that cheap.
//   CREDIT (we receive): a cheaper credit is MORE likely to fill (wrong way), so INVERT and DEMAND
//     far too much credit -> price / frac, capped just under the spread width (the theoretical max,
//     already unfillable) so we never send an absurd number Schwab would reject.
//
// TEST MODE ALWAYS SENDS. The whole point of this mode is that a real order goes to Schwab and comes back
// through the real lifecycle — placed, polled, auto-cancelled — so the path is exercised and the broker's
// order list matches what the strategy wanted. An earlier version returned null when it could not PROVE
// the price unfillable and the caller then skipped the send, which suppressed exactly the case worth
// seeing (a broken chain) and made "orders sent" stop matching "orders intended".
//
// Two boundaries exist where the transform cannot go past the real price, and both are broken-quote
// territory rather than real markets:
//   NET_DEBIT  real == one tick        -> price * frac cannot round BELOW a tick
//   NET_CREDIT real >= spreadWidth - t -> the cap is already at or under the real price
// Measured against the 11,659 orders really sent over 2026-09-18/21/22/23: the cheapest debit was $0.50
// and the closest credit 94.5% of width, so neither has ever been reached.
//
// In those two cases we send at the EXTREME — one tick for a debit, width minus a tick for a credit —
// which is the least fillable price the instrument admits, and flag the order as not guaranteed. The
// residual exposure is ONE TICK either way: a debit filled at a tick pays $5/contract for a spread worth
// no more than that, and a credit filled at width-minus-a-tick receives within $5/contract of the most
// the structure can ever be worth. $5 of theoretical exposure is the right price for never going blind.
//
// Returns { price, guaranteed, why } — or NULL only when the payload carries no usable price at all, in
// which case there is no order to send in any mode.
//
// `frac` is clamped to (0,1): it MULTIPLIES a debit (must shrink it) and DIVIDES a credit (must grow it),
// so a value of 1 or more sends at, or through, the real price. CANDLE_SPREAD_TEST_FRAC=1 did exactly
// that while /status still reported "test (unfillable + auto-cancel)".
function unfillableOrder(payload, frac, spreadWidth, tick) {
  const t = tick || 0.05;
  const f = Number(frac);
  const safeFrac = Number.isFinite(f) && f > 0 && f < 1 ? f : 0.1;
  const round = p => Math.round(Math.max(t, Math.round(p / t) * t) * 100) / 100; // tick-snap, 2dp clean
  const real = Number(payload && payload.price);
  if (!Number.isFinite(real) || real <= 0) return null;   // nothing to send, in any mode
  if (payload.orderType === 'NET_CREDIT') {
    const cap = spreadWidth != null ? round(spreadWidth - t) : null;
    const demand = round(real / safeFrac);
    const price = cap != null ? Math.min(demand, cap) : demand;
    // We must DEMAND MORE credit than the market is offering. At or below the real ask it can fill.
    return price > real ? { price, guaranteed: true, why: null }
      : { price: cap != null ? cap : price, guaranteed: false,
          why: `credit ${real} is already at or above the width cap ${cap} — sending the cap, which is the most this structure can be worth` };
  }
  const price = round(real * safeFrac);
  // We must OFFER LESS than the real price. At or above it, it can fill.
  return price < real ? { price, guaranteed: true, why: null }
    : { price: round(t), guaranteed: false,
        why: `debit ${real} is already at the tick floor — sending one tick, the lowest price the book accepts` };
}

// Price-only shim. Kept because it reads naturally at a call site that does not care about the flag.
function unfillablePrice(payload, frac, spreadWidth, tick) {
  const u = unfillableOrder(payload, frac, spreadWidth, tick);
  return u ? u.price : null;
}

// Drop an order the broker has superseded, so the poller stops chasing an id that no longer exists.
//
// A Schwab replace CANCELS the old order and creates a new one. Without this the old id stayed in
// liveOrders, polled to REPLACED -> 'canceled' -> terminal, and the record ended the day claiming a dead
// order while the live replacement was tracked by nothing at all.
function retireOrder(record, orderId, why) {
  const live = (record.state && record.state.liveOrders) || [];
  const i = live.findIndex((o) => o && o.orderId === orderId);
  if (i < 0) return false;
  const [gone] = live.splice(i, 1);
  record.state.liveOrders = live;
  store.appendEvent(record, { type: 'order_retired', orderId, why: why || 'superseded',
    kind: gone && gone.kind, note: `stopped tracking #${orderId} (${why || 'superseded'})` });
  return true;
}

// Record a freshly-sent real order so the poller can track it.
function trackOrder(record, o) {
  record.state.liveOrders = record.state.liveOrders || [];
  record.state.liveOrders.push({
    orderId: o.orderId,
    kind: o.kind || 'order',            // 'open' | 'cover' | 'cover-rest'
    positionId: o.positionId || null,
    net: o.net || null,                 // 'NET_DEBIT' | 'NET_CREDIT'
    requestedPrice: o.requestedPrice,   // the strategy's intended limit
    sentPrice: o.sentPrice,             // what we actually sent (unfillable in test mode)
    testMode: !!o.testMode,
    legs: o.legs || null,
    placedAt: o.placedAt || Date.now(),
    placedAtEST: new Date(o.placedAt || Date.now()).toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false }),
    status: 'working',
    fillPrice: null,
    lastPolledAt: null,
    canceledReason: null,
    ...(o.replaces ? { replaces: o.replaces } : {}),  // the order this one replaced, while that is unconfirmed
    ...(o.prior ? { prior: o.prior } : {})             // the engine's price before this replace, for a refused-replace restore
  });
}

// THE NET PRICE OF THE SPREAD, not the price of one of its legs.
//
// This used to return `executionLegs[0].price` — the execution price of whichever leg Schwab happened to
// list first. Every order this engine sends is a NET order on 2, 3 or 4 legs, so leg 0's price is the
// price of a single option (say $76.00 for a deep-ITM call) while the spread filled at $8.05. That number
// was written to o.fillPrice and logged as "broker FILLED @ 76" — the one figure that says what a real
// order actually cost, off by an order of magnitude and in a direction that flatters nothing
// consistently. It is inert while sends are unfillable test orders; it is the record of record the moment
// the account is funded.
//
// The net is Σ ±price × legQty over the execution legs, signed by each leg's INSTRUCTION (a buy pays, a
// sell receives) and divided by the ORDER's quantity — per-leg quantity is not the order quantity when a
// leg carries a ratio, which a butterfly's double body does. Instructions live on orderLegCollection and
// join to executionLegs by legId.
//
// Returns { net, price, side } — `price` is the magnitude, to compare against the limit we sent, and
// `side` says which direction it actually filled. Falls back to the ORDER's own net price (resp.price,
// which for a NET_DEBIT/NET_CREDIT order is exactly this quantity) and only then gives up. It no longer
// falls back to a leg price at all: a wrong number here is worse than none.
function extractFillNet(resp) {
  if (!resp) return null;
  const orderQty = Number(resp.quantity) > 0 ? Number(resp.quantity) : 1;
  const sideOf = {};
  for (const l of resp.orderLegCollection || []) {
    if (l && l.legId != null) sideOf[String(l.legId)] = /^BUY/i.test(String(l.instruction || '')) ? 1 : -1;
  }
  let net = 0, seen = 0, unknown = 0;
  for (const a of resp.orderActivityCollection || []) {
    for (const l of a.executionLegs || []) {
      if (!l || l.price == null) continue;
      const sgn = sideOf[String(l.legId)];
      if (sgn == null) { unknown++; continue; }          // cannot sign it -> cannot net it
      const q = Number(l.quantity);
      net += sgn * Number(l.price) * (Number.isFinite(q) && q > 0 ? q : orderQty);
      seen++;
    }
  }
  // Every executed leg must be signable, or the sum is a partial one dressed as a total.
  if (seen && !unknown) {
    const per = Math.round((net / orderQty) * 100) / 100;
    return { net: per, price: Math.abs(per), side: per < 0 ? 'CREDIT' : 'DEBIT', from: 'executionLegs' };
  }
  if (resp.price != null && Number.isFinite(Number(resp.price))) {
    const p = Math.abs(Number(resp.price));
    const side = /CREDIT/i.test(String(resp.orderType || '')) ? 'CREDIT' : 'DEBIT';
    return { net: side === 'CREDIT' ? -p : p, price: p, side, from: 'orderPrice' };
  }
  return null;
}

// Back-compat shim: the magnitude alone, which is what the record has always stored.
function extractFillPrice(resp) {
  const f = extractFillNet(resp);
  return f ? f.price : null;
}


// A REJECTED ORDER IS NOT A RESTING ONE — TELL THE STRATEGY.
//
// The poller marked a dead order dead on its own liveOrders row and stopped there. Nothing reached the
// POSITION, so the state machine went on believing it held a working cover (or a working open) that the
// broker had refused, and the ladder kept calling replace on a dead id. Measured on prod 2026-09-24:
// 28 orders rejected (16 opens, 12 cover-rests) producing 53 "Order in status REJECTED cannot be
// replaced" 400s across 19 positions, one of them retried six times — and 4 positions were still
// "resting" on a rejected cover at the close.
//
// The wasted API calls are the visible half. The dangerous half is the belief: resolveRestingCovers books
// a fill from the MARK and has no idea the order behind it does not exist, so a rejected cover whose mark
// reached target would have booked a lock that was never placed. It did not happen on those two days
// (0 of 12), but it is the same shape as the unsent-cover bug that `cover-not-sent` was written to close.
//
// Clearing the pending state is what makes the position honest: it becomes visibly uncovered, the cap and
// the governor count its risk again, and the next bar places a FRESH order instead of repricing a ghost.
// Leg-ledger entries are deliberately NOT released — same reasoning as the hedge expiry: the backing map
// has no refcount, so freeing a strike another live order still holds is the worse failure.
// EVERY PRICE LEAVES AS CENTS. `roundToTick` is Math.round(x/tick)*tick, which is not exact in binary:
// 66 ticks of 0.05 is 3.3000000000000003. Schwab rejects that as an invalid price — on 2026-10-02 v7-10's
// cover for pos-...-122 was refused nine times in a row (14:40-15:20), leaving a real position uncovered
// while the engine retried the same unsendable number every bar. Callers round in some paths and not
// others; this is the one place every place and replace passes through, so it is fixed here for all.
function wirePrice(payload) {
  if (!payload || typeof payload.price !== 'number' || !Number.isFinite(payload.price)) return payload;
  const cents = Math.round(payload.price * 100) / 100;
  return cents === payload.price ? payload : { ...payload, price: cents };
}

// REPEATED REJECTIONS MUST BE LOUD. On 2026-10-02 the same cover was rejected every bar for 40 minutes and
// the only trace was 'broker REJECTED' — no reason, no count, no alarm — while a real position sat
// uncovered. The engine rebuilds an identical order after each rejection, so ANY rejection that will always
// happen (a bad price, buying power, an account restriction) loops silently all day. This counts rejections
// per position (opens: per working slot; hedges: per kind), keeps Schwab's own reason, alarms at 3 and
// every 5 after, and resets when that position or slot actually fills. Published on status().
// THE SIDE OF AN ORDER, as NET_DEBIT / NET_CREDIT, whatever orderType it was sent with. A single-leg order
// goes out as LIMIT; recording 'LIMIT' as its side would make applyBrokerFills' wrong-side guard refuse
// every fill on it. A LIMIT buy is a debit, a LIMIT sell a credit.
function netOfPayload(p) {
  if (!p) return null;
  if (p.orderType !== 'LIMIT') return p.orderType || null;
  const legs = p.orderLegCollection || [];
  return legs.length && /^SELL/i.test(String(legs[0].instruction || '')) ? 'NET_CREDIT' : 'NET_DEBIT';
}
function rejectKey(kind, positionId) {
  const fam = isOpenKind(kind) ? 'open' : /cover/.test(kind || '') ? 'cover' : HEDGE_KINDS.has(kind) ? 'hedge' : (kind || 'order');
  if (fam === 'open') return `open:${positionId || 'slot'}`;
  if (fam === 'hedge') return `hedge:${kind}`;
  return `${fam}:${positionId || '?'}`;
}
function noteReject(record, key, reason, detail) {
  const st = (record && record.state) || {};
  st.rejectStreaks = st.rejectStreaks || {};
  const r = st.rejectStreaks[key] || { count: 0 };
  r.count++; r.lastReason = reason || null; r.lastAt = new Date().toISOString();
  if (detail) { r.kind = detail.kind || r.kind || null; r.price = detail.price != null ? detail.price : (r.price != null ? r.price : null); }
  st.rejectStreaks[key] = r;
  if (r.count === 3 || (r.count > 3 && (r.count - 3) % 5 === 0)) {
    store.appendEvent(record, { type: 'order_reject_streak', key, count: r.count, reason: r.lastReason, kind: r.kind, price: r.price,
      note: `rejected ${r.count} times in a row — the order is being rebuilt the same way; a position may be unprotected` });
    console.error(`[candle-spread] REPEATED REJECTION x${r.count} (${key}, ${r.kind || '?'} @ ${r.price}): `
      + `${r.lastReason || 'no reason given'} — rebuilt identically each time; a real position may be unprotected`);
  }
  return r.count;
}
function clearReject(st, key) { if (st && st.rejectStreaks && st.rejectStreaks[key]) delete st.rejectStreaks[key]; }

// EVERY KIND AN OPEN'S ORDER ROW CAN CARRY. The open ladder replaces the resting order, and the
// replacement row is tagged 'open-reprice' — so an open that fills after being worked fills under THAT
// kind. Matching 'open' alone is how the first live fill (v7-10, 2026-10-02, #1008147955066 @ 6.00) went
// unbooked: the broker owned the spread and the engine still thought the order was working.
// 'combo-lock-open' is deliberately NOT here — it is a 4-leg cover+open with its own booking.
const OPEN_KINDS = new Set(['open', 'open-reprice']);
const isOpenKind = (kind) => OPEN_KINDS.has(kind);
const HEDGE_KINDS = new Set(['floor-offset', 'wing', 'fly', 'raise']);

function clearDeadOrderState(record, o) {
  const st = (record && record.state) || {};
  if (HEDGE_KINDS.has(o.kind)) {
    // A HEDGE THE BROKER REFUSED OR CANCELLED IS NOT A HEDGE WE HOLD. This had no branch at all: hedge rows
    // carry no positionId, so the positionId lookup found nothing and pendingHedge stayed set. Under the broker a
    // hedge's mark usually reads fillable, which skips its expiry, so a refused hedge held its budget slot
    // all day — and an unfilled floor-offset blocks every later one (`pend.n > 0 -> break`).
    // Flagged expired rather than spliced so resolvePendingHedges drops it on its next pass, exactly as it
    // drops one it expired itself. Leg-ledger strikes stay held, the same deliberate call as expiry.
    const hp = (st.positions || []).find((p) => p && (p.orderId === o.orderId
      || (p.pendingHedge && p.pendingHedge.orderId === o.orderId)));
    if (!hp || hp.filled || !hp.pendingHedge) return null;
    hp.pendingHedge = null;
    hp.orderStatus = o.status || 'canceled';
    hp.expired = true;
    return 'hedge';
  }
  // An OPEN row carries no positionId (the order is sent before the position exists); its only link is
  // pos.orderId. Without this a canceled open never retired, which matters now that a reversal keeps the
  // position until the broker answers (trader.js, cancel-open).
  const pos = (st.positions || []).find((p) => p && p.id === o.positionId)
    || (isOpenKind(o.kind) ? (st.positions || []).find((p) => p && p.orderId === o.orderId) : null);
  if (!pos) return null;
  if (/cover/.test(o.kind || '')) {
    const pc = pos.pendingCover;
    if (!pc || pos.covered || (pc.orderId && pc.orderId !== o.orderId)) return null;
    pos.pendingCover = null;
    pos.coverStatus = 'rejected';
    return 'cover';
  }
  if (isOpenKind(o.kind)) {
    // An open that never filled and was refused is not a position we hold. Leave the record in place —
    // it is evidence, and the day summary counts it — but stop it occupying the one-working-open slot.
    if (pos.filled) return null;
    pos.orderStatus = 'rejected';
    if (st.pendingOpenId === pos.id) st.pendingOpenId = null;
    return 'open';
  }
  return null;
}

// ── MANUAL-EDIT ADOPTION ──────────────────────────────────────────────────────────────────────────────
const legSig = (o) => (o && o.orderLegCollection || []).map((l) => `${l.instruction}:${l.instrument && l.instrument.symbol}:${l.quantity}`).sort().join('|');
const ADOPT_WINDOW_MS = 5000;         // the successor is entered in the same second the original closed (observed: 0 s)
const ADOPT_GRACE_MS = 20000;         // give the successor time to appear in the account listing before giving up
// Successor of a hand-edited order: a broker order on the identical legs/quantity, not already tracked,
// entered within ADOPT_WINDOW_MS of the original's closeTime. An edited order edited AGAIN is itself REPLACED;
// follow that chain to the live end (bounded). Returns the order, or null.
function findSuccessor(orders, orig, known) {
  let cur = orig;
  for (let hop = 0; hop < 5; hop++) {
    const closed = Date.parse(cur.closeTime || '');
    if (!Number.isFinite(closed)) return null;
    const sig = legSig(cur);
    const cands = (orders || []).filter((x) => x && legSig(x) === sig && Number(x.quantity) === Number(cur.quantity)
      && !known.has(String(x.orderId)) && String(x.orderId) !== String(cur.orderId)
      && Math.abs(Date.parse(x.enteredTime || '') - closed) <= ADOPT_WINDOW_MS);
    if (!cands.length) return null;
    cands.sort((a, b) => Math.abs(Date.parse(a.enteredTime) - closed) - Math.abs(Date.parse(b.enteredTime) - closed));
    const nx = cands[0];
    if (String(nx.status).toUpperCase() !== 'REPLACED') return nx;
    known.add(String(nx.orderId));
    cur = nx;
  }
  return null;
}
// Re-point whatever the engine was working under the old id at the adopted order, at its price.
function repointPosition(record, o, nu) {
  const st = record.state || {};
  const nuId = String(nu.orderId);   // the listing's ids are NUMBERS; every engine-held id is a string
  const price = Number(nu.price);
  const credit = String(nu.orderType || '').toUpperCase() === 'NET_CREDIT';
  const width = (legs) => { const ks = (legs || []).map((l) => l.strike).filter((k) => k != null); return ks.length ? Math.max(...ks) - Math.min(...ks) : null; };
  const r2 = (x) => Math.round(x * 100) / 100;
  for (const p of st.positions || []) {
    if (!p) continue;
    const pc = p.pendingCover;
    if (pc && String(pc.orderId) === String(o.orderId)) {
      pc.orderId = nuId;
      if (credit) { pc.sentCredit = price; const w = width(pc.legs); if (w != null) pc.target = r2(w - price); }
      else pc.target = price;
      pc.ladderStep = null;            // the ladder re-takes its step from the price the user set
      pc.adoptedManualEdit = true;
      return 'cover';
    }
    if (String(p.orderId) === String(o.orderId) && !p.filled && !p.hedge) {
      p.orderId = nuId;
      if (credit && p.sentNet === 'CREDIT') { p.sentLimit = price; const w = width(p.legs); if (w != null) p.limit = r2(w - price); }
      else p.limit = price;
      p.openLadderStep = null;
      return 'open';
    }
    if (p.pendingHedge && String(p.pendingHedge.orderId) === String(o.orderId)) {
      p.pendingHedge.orderId = nuId; p.pendingHedge.limit = price; p.limit = price;
      return 'hedge';
    }
  }
  return null;
}
async function adoptManualReplacement(record, deps, o, resp, now) {
  if (!deps.tradingClient.ordersByAccount) return 'none';
  const closed = Date.parse(resp.closeTime || '') || now;
  let orders = null;
  try {
    orders = await deps.tradingClient.ordersByAccount(deps.accountHash,
      new Date(closed - 60 * 60 * 1000).toISOString(), new Date(now + 60 * 1000).toISOString());
  } catch (e) {
    store.appendEvent(record, { type: 'order_poll_error', orderId: o.orderId, note: `manual-edit lookup failed: ${e && e.message}` });
  }
  const los = record.state.liveOrders || [];
  const known = new Set(los.map((x) => String(x.orderId)));
  const nu = orders ? findSuccessor(orders, resp, known) : null;
  if (!nu) {
    // Not listed yet? Wait briefly before letting the engine re-create its order.
    if (!o.manualReplaceSeenAt) o.manualReplaceSeenAt = now;
    if (now - o.manualReplaceSeenAt < ADOPT_GRACE_MS) return 'waiting';
    store.appendEvent(record, { type: 'order_manual_replace_unmatched', orderId: o.orderId, kind: o.kind, positionId: o.positionId || undefined,
      note: 'REPLACED by someone else and no successor on the same legs was found — the engine will re-create its order' });
    return 'none';
  }
  const what = repointPosition(record, o, nu);
  o.status = 'canceled';
  o.canceledReason = 'manual-edit';
  o.replacedBy = String(nu.orderId);
  trackOrder(record, { orderId: String(nu.orderId), kind: o.kind, positionId: o.positionId, legs: o.legs,
    net: nu.orderType, requestedPrice: Number(nu.price), sentPrice: Number(nu.price), placedAt: Date.parse(nu.enteredTime) || now });
  const row = los[los.length - 1];
  row.adoptedFrom = String(o.orderId);
  if (String(nu.status).toUpperCase() === 'FILLED') row.status = 'working';   // polled next in this same pass, which books it
  store.appendEvent(record, { type: 'order_adopted_manual_edit', orderId: String(nu.orderId), from: o.orderId, kind: o.kind,
    positionId: o.positionId || undefined, price: Number(nu.price), net: nu.orderType, status: nu.status, repointed: what || undefined,
    note: `order ${o.orderId} was edited outside the engine (REPLACED, no replace of ours); adopted ${nu.orderId} @ ${nu.price}${what ? ` — ${what} now works it` : ' — no engine state pointed at it'}` });
  console.warn(`[candle-spread] ${record.config && record.config.variant}: adopted manual edit ${o.orderId} -> ${nu.orderId} @ ${nu.price}`);
  return 'adopted';
}

// Poll + reconcile every non-terminal real order on a run. deps: { tradingClient, accountHash }.
// opts: { testCancelAfterMs, staleOpenCancelMs, now }. Appends order_* events and persists.
async function reconcile(record, deps, opts = {}) {
  const los = (record.state && record.state.liveOrders) || [];
  if (!los.length) return;
  if (!deps || !deps.tradingClient || !deps.accountHash) return;
  const now = opts.now || Date.now();
  const testCancelAfterMs = opts.testCancelAfterMs != null ? opts.testCancelAfterMs : 60000;
  // Was 15 minutes, which is SHORTER than a normal open's working life and so fought the strategy. As an
  // orphan backstop it only needs to be shorter than the session.
  const staleOpenCancelMs = opts.staleOpenCancelMs != null ? opts.staleOpenCancelMs : 90 * 60 * 1000;

  for (const o of los) {
    if (isTerminal(o)) continue;
    // A REPLACEMENT PULLED BECAUSE ITS ORIGINAL FILLED must actually be cancelled. The pull below is
    // attempted once, at the moment the fill is seen; if that DELETE failed, nothing retried it and the
    // replacement could fill as a second real order. Retry until the broker accepts the cancel.
    if (o.supersededByFill && !o.cancelRequestedAt) {
      try { await deps.tradingClient.orderDelete(deps.accountHash, String(o.orderId)); o.cancelRequestedAt = now; }
      catch (e) { store.appendEvent(record, { type: 'order_cancel_error', orderId: o.orderId, note: `retrying pull of superseded replacement: ${e && e.message}` }); }
    }
    // 1) Read current broker status.
    let resp;
    try {
      // String(): the Schwab client .trim()s the id, and the account LISTING returns ids as numbers (2026-10-09:
      // an adopted manual edit carried a numeric id, every poll threw, and its FILLED cover was never booked).
      resp = await deps.tradingClient.orderById(deps.accountHash, String(o.orderId));
    } catch (e) {
      store.appendEvent(record, { type: 'order_poll_error', orderId: o.orderId, note: e && e.message });
      continue;
    }
    o.lastPolledAt = now;
    const next = mapStatus(resp && resp.status);
    if (next === 'filled' && o.status !== 'filled') {
      o.status = 'filled';
      const f = extractFillNet(resp);
      o.fillPrice = f ? f.price : null;
      o.fillSide = f ? f.side : null;                 // DEBIT/CREDIT as it really filled
      o.fillFrom = f ? f.from : null;                 // netted from the legs, or the order's own price
      // A FILL ON THE WRONG SIDE IS NOT A DETAIL. The limit we sent has a side; if the broker reports the
      // other one, the position's cash sign is inverted and nothing downstream would notice.
      const wrongSide = f && o.net && f.side !== String(o.net).replace(/^NET_/, '');
      store.appendEvent(record, { type: 'order_filled', orderId: o.orderId, kind: o.kind, positionId: o.positionId,
        fillPrice: o.fillPrice, fillSide: o.fillSide, fillFrom: o.fillFrom, requestedPrice: o.requestedPrice,
        sentPrice: o.sentPrice, wrongSide: wrongSide || undefined,
        note: `broker FILLED ${o.fillSide || ''} @ ${o.fillPrice}${wrongSide ? ` — SENT AS ${o.net}` : ''}` });
      // THE OLD ORDER WON THE RACE. It filled while its replacement was pending, so the replacement is a
      // second live order for the same position. Pull it, and mark it so its death does not clear the
      // position's pending state before applyBrokerFills books this fill (same pass ordering is not
      // guaranteed: the worker may run between this poll and the next).
      if (o.replacedBy) {
        const nu = los.find((x) => x && x.orderId === o.replacedBy);
        if (nu && !isTerminal(nu)) {
          nu.supersededByFill = o.orderId;
          if (!nu.cancelRequestedAt) {
            try { await deps.tradingClient.orderDelete(deps.accountHash, String(nu.orderId)); nu.cancelRequestedAt = now; }
            catch (e) { store.appendEvent(record, { type: 'order_cancel_error', orderId: nu.orderId, note: e && e.message }); }
          }
        }
        store.appendEvent(record, { type: 'order_replace_race', orderId: o.orderId, replacement: o.replacedBy,
          kind: o.kind, positionId: o.positionId,
          note: `the ORIGINAL order filled while its replacement #${o.replacedBy} was pending — replacement pulled` });
        console.error(`[candle-spread] REPLACE RACE: #${o.orderId} (${o.kind}) FILLED before its replacement `
          + `#${o.replacedBy} took over — the replacement has been cancelled`);
      }
      continue;
    }
    // A REPLACE PAIR SETTLES WITHOUT TOUCHING THE POSITION. These rows' deaths are bookkeeping, not "the
    // order we were relying on is gone": the old order confirming REPLACED is the replace completing, a
    // replacement pulled because the original filled must not clear what that fill is about to book, and
    // an unknown-id replace must not invite a second order. Each is recorded and the pending state kept.
    if (DEAD.has(String(resp && resp.status).toUpperCase()) && (o.replacedBy || o.supersededByFill || o.replaceIdUnknown)) {
      o.status = next === 'working' ? 'canceled' : next;
      o.canceledReason = o.supersededByFill ? 'superseded-by-fill' : o.replacedBy ? 'replaced' : 'replaced-id-unknown';
      store.appendEvent(record, { type: 'order_dead', orderId: o.orderId, kind: o.kind, status: o.status,
        positionId: o.positionId || undefined, reason: o.canceledReason,
        note: `broker ${resp && resp.status} — ${o.canceledReason}; position state kept` });
      if (o.replaceIdUnknown) {
        console.error(`[candle-spread] #${o.orderId} is REPLACED and its replacement id was never returned — `
          + 'a live order is untracked');
      }
      continue;
    }
    // THE REPLACEMENT WAS REFUSED but the original never left: Schwab rejects the replace and the old
    // order keeps working. Point the position back at the order that is actually live instead of clearing
    // it (which would place a second one next bar while the original still rests).
    if (DEAD.has(String(resp && resp.status).toUpperCase()) && o.replaces) {
      const prev = los.find((x) => x && x.orderId === o.replaces);
      if (prev && !isTerminal(prev)) {
        o.status = next === 'working' ? 'canceled' : next;
        o.canceledReason = 'replace-refused';
        prev.replacedBy = null;
        const st = record.state || {};
        // THE PRICE GOES BACK WITH THE ID. Restoring only the id left the engine believing the refused price
        // was working while the broker still held the original one — and give-up, which re-sends only when its
        // price differs from the working one, then never re-sent. The prior values ride on the row.
        const pr = o.prior || null;
        for (const p of st.positions || []) {
          if (p && p.pendingCover && p.pendingCover.orderId === o.orderId) {
            p.pendingCover.orderId = prev.orderId;
            if (pr && pr.target != null) p.pendingCover.target = pr.target;
            if (pr && 'sentCredit' in pr) p.pendingCover.sentCredit = pr.sentCredit;
            p.pendingCover.ladderStep = null;          // let the ladder re-take its step against the real price
            p.pendingCover.gaveUp = false;
          }
          if (p && p.orderId === o.orderId) {
            p.orderId = prev.orderId;
            if (pr && pr.limit != null) { p.limit = pr.limit; p.sentLimit = pr.sentLimit; p.openLadderStep = pr.openLadderStep; }
          }
          if (p && p.pendingHedge && p.pendingHedge.orderId === o.orderId) p.pendingHedge.orderId = prev.orderId;
        }
        store.appendEvent(record, { type: 'order_dead', orderId: o.orderId, kind: o.kind, status: o.status,
          reason: 'replace-refused', restoredTo: prev.orderId,
          note: `broker ${resp && resp.status} on a replacement — the original #${prev.orderId} is still working; tracking restored to it` });
        continue;
      }
    }
    // A REPLACE WE DID NOT ASK FOR = SOMEONE EDITED THE ORDER BY HAND (Schwab app/website). Verified 2026-10-07
    // (probe-manual-replace.js): an app edit retires the original as REPLACED and a NEW id carries the order —
    // same legs and quantity, entered in the same second the original closed, tag prefix API_ instead of our
    // TA_, and no field linking the two. Left to the generic path below, the engine read that as "my order
    // died", cleared it, and sent a SECOND order next step: a double cover. So: find the successor and ADOPT
    // it — the position now works (and books the fill of) the order the user set. If none matches, fall
    // through: the engine re-creates its order exactly as before (the user wants that behaviour kept).
    if (String(resp && resp.status).toUpperCase() === 'REPLACED' && !o.replacedBy && !o.supersededByFill && !o.replaceIdUnknown) {
      const adopted = await adoptManualReplacement(record, deps, o, resp, now);
      if (adopted === 'adopted' || adopted === 'waiting') continue;
    }
    if (DEAD.has(String(resp && resp.status).toUpperCase())) {
      o.status = next === 'working' ? 'canceled' : next;
      // Schwab says WHY in statusDescription; it was never kept.
      if (resp && resp.statusDescription) o.statusReason = String(resp.statusDescription).slice(0, 300);
      if (o.status === 'rejected') noteReject(record, rejectKey(o.kind, o.positionId), o.statusReason, { kind: o.kind, price: o.sentPrice });
      const cleared = clearDeadOrderState(record, o);
      store.appendEvent(record, { type: 'order_dead', orderId: o.orderId, kind: o.kind, status: o.status,
        positionId: o.positionId || undefined, cleared: cleared || undefined,
        reason: o.statusReason || undefined,
        note: `broker ${resp && resp.status}` + (o.statusReason ? ` (${o.statusReason})` : '')
          + (cleared === 'cover' ? ' — pendingCover cleared, the position is uncovered again'
            : cleared === 'open' ? ' — open slot released, it never filled' : '') });
      continue;
    }
    // 2) Still working — decide whether to cancel it.
    const age = now - (o.placedAt || now);
    // THE SWEEP IS A BACKSTOP, NOT A POLICY. The strategy's design is that an open RESTS all day and is
    // cancelled only on a reversal (trader.js), and the strategy now sends that cancel itself. This swept
    // a live open at 15 minutes regardless, so the engine went on laddering an order the order manager had
    // already killed and eventually booked a phantom fill against it — two components with opposite
    // beliefs about the same order and no way for either to notice.
    //
    // It still exists, because it is the ONLY thing that catches an order orphaned by a crash, a failed
    // strategy cancel, or a replace whose new id was lost. The horizon is long enough not to contradict a
    // strategy that is still actively working the order. Test orders are untouched: those must be pulled
    // quickly and nothing else is watching them.
    // A row awaiting its replace confirmation is not an orphan: the strategy is working it under a new id.
    const wantCancel = !o.cancelRequestedAt && !o.replacedBy && ((o.testMode && age >= testCancelAfterMs)  // test order: pull it so nothing lingers
      || (!o.testMode && isOpenKind(o.kind) && age >= staleOpenCancelMs));  // orphan backstop, not a schedule
    if (wantCancel) {
      try {
        await deps.tradingClient.orderDelete(deps.accountHash, String(o.orderId));
        if (o.testMode) {
          // Test orders keep the old shortcut: nothing real can fill at an unfillable price, and the
          // strategy is simulating these positions, so clearing their pending state would break the run.
          o.status = 'canceled';
        } else {
          // A REAL ORDER IS CANCELLED WHEN THE BROKER SAYS SO. Marking it 'canceled' here stopped the
          // polling, so clearDeadOrderState never ran — the open slot stayed taken by a dead order and every
          // same-side signal logged open-skip-pending until a reversal — and a fill that beat the cancel was
          // never seen. Keep polling; the DEAD branch above retires it and frees the slot.
          o.cancelRequestedAt = now;
        }
        o.canceledReason = o.testMode ? 'test-auto-cancel' : 'stale-open';
        store.appendEvent(record, { type: 'order_canceled', orderId: o.orderId, kind: o.kind, reason: o.canceledReason, note: `canceled after ${Math.round(age / 1000)}s` });
      } catch (e) {
        store.appendEvent(record, { type: 'order_cancel_error', orderId: o.orderId, note: e && e.message });
      }
    } else {
      store.writeRun(record); // persist lastPolledAt
    }
  }
}

module.exports = { netOfPayload, rejectKey, noteReject, clearReject, wirePrice, isOpenKind, OPEN_KINDS, HEDGE_KINDS, unfillablePrice, unfillableOrder, clearDeadOrderState, trackOrder, retireOrder, reconcile, isTerminal, mapStatus, extractFillPrice, extractFillNet, TERMINAL, DEAD };
