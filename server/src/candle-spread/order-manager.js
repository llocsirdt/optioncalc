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
const DEAD = new Set(['CANCELED', 'REJECTED', 'EXPIRED', 'REPLACED', 'PENDING_CANCEL']);
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
// Never returns below one tick.
//
// RETURNS null WHEN IT CANNOT GUARANTEE UNFILLABILITY, and the caller must then not send at all. This is
// the single safety property protecting a funded account while the engine runs in 'test' mode, and it had
// two holes at the boundaries — both verified against the real module:
//
//   NET_DEBIT  $0.05            -> $0.05   the Math.max(t, ...) floor returned the REAL price
//   NET_CREDIT $19.95 on W=20   -> $19.95  the (spreadWidth - tick) cap returned the REAL price
//
// Neither was reachable in the 11,659 orders actually sent over 2026-09-18/21/22/23 (cheapest debit $0.50,
// closest credit 94.5% of width). But a broken chain pricing a 40-wide fly at $0.05 is a documented
// failure of this system, and that is precisely the input that lands on the debit floor. An order that
// cannot be made unfillable must not be sent in test mode — silence is the safe answer, a fillable "test"
// order is not.
//
// `frac` is clamped to (0,1): it MULTIPLIES a debit (must shrink it) and DIVIDES a credit (must grow it),
// so a value of 1 or more sends at, or through, the real price. CANDLE_SPREAD_TEST_FRAC=1 did exactly
// that while /status still reported "test (unfillable + auto-cancel)".
function unfillablePrice(payload, frac, spreadWidth, tick) {
  const t = tick || 0.05;
  const f = Number(frac);
  const safeFrac = Number.isFinite(f) && f > 0 && f < 1 ? f : 0.1;
  const round = p => Math.round(Math.max(t, Math.round(p / t) * t) * 100) / 100; // tick-snap, 2dp clean
  const real = Number(payload && payload.price);
  if (!Number.isFinite(real) || real <= 0) return null;
  if (payload.orderType === 'NET_CREDIT') {
    const demand = round(real / safeFrac);
    const cap = spreadWidth != null ? round(spreadWidth - t) : demand;
    const sent = Math.min(demand, cap);
    // We must DEMAND MORE credit than the market is offering. At or below the real ask it can fill.
    return sent > real ? sent : null;
  }
  const sent = round(real * safeFrac);
  // We must OFFER LESS than the real price. At or above it, it can fill.
  return sent < real ? sent : null;
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
    canceledReason: null
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
    // 1) Read current broker status.
    let resp;
    try {
      resp = await deps.tradingClient.orderById(deps.accountHash, o.orderId);
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
      continue;
    }
    if (DEAD.has(String(resp && resp.status).toUpperCase())) {
      o.status = next === 'working' ? 'canceled' : next;
      store.appendEvent(record, { type: 'order_dead', orderId: o.orderId, kind: o.kind, status: o.status, note: `broker ${resp && resp.status}` });
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
    const wantCancel = (o.testMode && age >= testCancelAfterMs)          // test order: pull it so nothing lingers
      || (!o.testMode && o.kind === 'open' && age >= staleOpenCancelMs);  // orphan backstop, not a schedule
    if (wantCancel) {
      try {
        await deps.tradingClient.orderDelete(deps.accountHash, o.orderId);
        o.status = 'canceled';
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

module.exports = { unfillablePrice, trackOrder, retireOrder, reconcile, isTerminal, mapStatus, extractFillPrice, extractFillNet, TERMINAL, DEAD };
