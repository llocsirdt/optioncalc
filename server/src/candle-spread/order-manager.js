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
function unfillablePrice(payload, frac, spreadWidth, tick) {
  const t = tick || 0.05;
  const round = p => Math.round(Math.max(t, Math.round(p / t) * t) * 100) / 100; // tick-snap, 2dp clean
  if (payload.orderType === 'NET_CREDIT') {
    const demand = round(payload.price / frac);
    const cap = spreadWidth != null ? round(spreadWidth - t) : demand;
    return Math.min(demand, cap);
  }
  return round(payload.price * frac);
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

// Best-effort extraction of an average fill price from a Schwab orderById response.
function extractFillPrice(resp) {
  if (!resp) return null;
  const acts = resp.orderActivityCollection || [];
  for (const a of acts) {
    const legs = a.executionLegs || [];
    if (legs.length && legs[0].price != null) return Number(legs[0].price);
  }
  return resp.price != null ? Number(resp.price) : null;
}

// Poll + reconcile every non-terminal real order on a run. deps: { tradingClient, accountHash }.
// opts: { testCancelAfterMs, staleOpenCancelMs, now }. Appends order_* events and persists.
async function reconcile(record, deps, opts = {}) {
  const los = (record.state && record.state.liveOrders) || [];
  if (!los.length) return;
  if (!deps || !deps.tradingClient || !deps.accountHash) return;
  const now = opts.now || Date.now();
  const testCancelAfterMs = opts.testCancelAfterMs != null ? opts.testCancelAfterMs : 60000;
  const staleOpenCancelMs = opts.staleOpenCancelMs != null ? opts.staleOpenCancelMs : 15 * 60 * 1000;

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
      o.fillPrice = extractFillPrice(resp);
      store.appendEvent(record, { type: 'order_filled', orderId: o.orderId, kind: o.kind, positionId: o.positionId, fillPrice: o.fillPrice, note: `broker FILLED @ ${o.fillPrice}` });
      continue;
    }
    if (DEAD.has(String(resp && resp.status).toUpperCase())) {
      o.status = next === 'working' ? 'canceled' : next;
      store.appendEvent(record, { type: 'order_dead', orderId: o.orderId, kind: o.kind, status: o.status, note: `broker ${resp && resp.status}` });
      continue;
    }
    // 2) Still working — decide whether to cancel it.
    const age = now - (o.placedAt || now);
    const wantCancel = (o.testMode && age >= testCancelAfterMs)          // test order: pull it so nothing lingers
      || (!o.testMode && o.kind === 'open' && age >= staleOpenCancelMs);  // stale live OPEN that never filled
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

module.exports = { unfillablePrice, trackOrder, reconcile, isTerminal, mapStatus, extractFillPrice, TERMINAL, DEAD };
