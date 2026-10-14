'use strict';
// MANUAL ORDER ABSORPTION (2026-10-13, user: manually placed positions "should fill in where needed in the ledger,
// claiming slots if not previously claimed, and adding qty to spots already holding positions, and of course update
// the risk curve for the purposes of knowing where low spots are that still need to be repaired or how much room we
// still really have in the risk cap").
//
// Why: 2026-10-13 14:20 the user placed the iron condor P30520/P30530/C30540/C30550 by hand over the book's −$244 low
// spot. The account-check pass saw it (position_reconcile DIVERGENT, 1 unmanaged + 3 quantity) and the ledger was
// seeded with its sides, but it never became a position: the risk curve, floor, cap room and low-spot search all
// still showed the spot unrepaired.
//
// What it does, first pass (agreed with the user):
//   - every FILLED order in the account for this run's expiration that NO real-sending run sent becomes one position
//     { manual: true, hedge: true, side: 'manual' } at the real execution price and quantity
//   - it is treated LIKE A HEDGE: never covered, given up, rolled, or counted as an open; it simply joins the book,
//     so it moves the risk curve, the floor, the governor's cap room and the floor-raise low spots
//   - it COUNTS AGAINST THE RISK CAP (user decision)
//   - booked at the TRUE NET: a manual leg that offsets an engine leg is added as-is, so the book's net per leg is
//     what Schwab reports, and an alert is raised (the user does not expect it: Schwab rejects most such orders)
//   - idempotent on orderId, and self-healing: a manual position whose order the engine later claims (an adopted
//     manual edit of an engine order) is removed again, so nothing is ever booked twice
// Future iteration (user): 2-leg manual orders might be treated as opens to cover, 3/4-leg (flies, condors) as hedges.
//
// Pure apart from mutating record.state; the caller fetches the broker data and writes the record.
const AB = require('./account-book');
const RC = require('./risk-curve');

const r2 = (x) => Math.round(x * 100) / 100;
const gcd = (a, b) => (b ? gcd(b, a % b) : a);
const legKey = (l) => `${l.type}${l.strike}`;
// Same signed cash ledger as trader.noteCash (+paid debit, −received credit), restated so this module does not pull
// in the trader for one line.
function noteCash(st, dollars) {
  st.cashDeployed = r2((st.cashDeployed || 0) + dollars);
  st.peakCashDeployed = Math.max(st.peakCashDeployed || 0, st.cashDeployed);
}

// The order's legs as a position: unit quantity = gcd of the leg sizes, a leg with a larger size repeated (a
// 1x2 ratio is legs [long A, short B, short B] at quantity 1), and `limit` = net per unit, NEGATIVE for a credit —
// risk-curve's positionPnl is (payoff − limit) × 100 × qty, so a credit is simply a negative cost.
function positionFromOrder(row) {
  const sizes = row.legs.map((l) => Math.round(Math.abs(l.qty)));
  if (sizes.some((s) => !(s > 0))) return null;
  const q = sizes.reduce((a, b) => gcd(a, b));
  const legs = [];
  row.legs.forEach((l, i) => { for (let k = 0; k < sizes[i] / q; k++) legs.push({ side: l.qty > 0 ? 'long' : 'short', type: l.type, strike: l.strike }); });
  // Net per unit from the executions when every leg has one (the account book's own rule), else its order price.
  const haveExec = row.legs.every((l) => l.price != null);
  const total = haveExec
    ? row.legs.reduce((t, l) => t + (l.qty > 0 ? 1 : -1) * l.price * Math.abs(l.qty), 0)
    : (row.net === 'CREDIT' ? -1 : 1) * row.price * (row.contracts || q);
  const limit = r2(total / q);
  const pos = { id: `man-${row.orderId}`, manual: true, hedge: true, side: 'manual', shortStrike: null, legs, limit, quantity: q,
    filled: true, orderStatus: 'filled', orderId: String(row.orderId), covered: false, pendingCover: null, coverLegs: null, coverLimit: null,
    openedAt: row.time || null, openTime: row.time || null, openEpoch: row.epoch || null, priceFrom: haveExec ? 'executions' : 'order-price' };
  pos.maxLoss = maxLossPerUnit(pos);
  return pos;
}

// Worst settlement loss per unit (in price points, like `limit`) — a terminal payoff is piecewise-linear with kinks
// only at strikes, so its minimum is at a strike or out on a tail. Used where the engine sums dollars at risk
// (trader capState), so a credit structure counts its real risk rather than a negative "cost".
function maxLossPerUnit(pos) {
  const ks = pos.legs.map((l) => l.strike);
  const lo = Math.min(...ks), hi = Math.max(...ks);
  const unit = { ...pos, quantity: 1 };
  let worst = Infinity;
  for (const S of [lo - 1000, ...ks, hi + 1000]) worst = Math.min(worst, RC.positionPnl(unit, S) / 100);
  // An open-ended short tail is unbounded; cap it at the far point evaluated (still very large), never Infinity.
  return r2(Math.max(0, -worst));
}

// Engine net per leg, signed, from the engine's own filled positions (manual ones excluded).
function engineNet(st) {
  const BR = require('./book-reconcile');
  const own = { state: { ...st, positions: (st.positions || []).filter((p) => !p.manual) } };
  return BR.engineLegs(own);
}

/**
 * @param record        the run record (mutated: state.positions, state.absorbedOrderIds)
 * @param o.orders      Schwab ordersByAccount response
 * @param o.knownOrderIds every order id any real-sending run has in its liveOrders (incl. adopted successors)
 * @param o.adoptionPending true while an engine order is REPLACED-by-someone and its successor not yet adopted:
 *                      the successor would look manual for that window, so absorbing waits
 * @returns { added:[pos], removed:[pos], nets:[{leg, engine, manual}] }
 */
function absorbManualOrders(record, { orders, knownOrderIds, adoptionPending, symbol }) {
  const st = record.state;
  const cfg = record.config || {};
  const known = new Set([...(knownOrderIds || [])].map(String));
  st.positions = st.positions || [];
  st.absorbedOrderIds = st.absorbedOrderIds || [];
  const out = { added: [], removed: [], nets: [] };

  // SELF-HEAL FIRST: a manual position whose order the engine now owns is the engine's — drop ours.
  const keep = [];
  for (const p of st.positions) {
    if (p && p.manual && known.has(String(p.orderId))) out.removed.push(p);
    else keep.push(p);
  }
  if (out.removed.length) {
    st.positions = keep;
    for (const p of out.removed) noteCash(st, -p.limit * 100 * p.quantity);
    const gone = new Set(out.removed.map((p) => String(p.orderId)));
    st.absorbedOrderIds = st.absorbedOrderIds.filter((id) => !gone.has(String(id)));
  }
  if (adoptionPending) return out;

  const book = AB.buildAccountBook({ symbol: symbol || cfg.symbol || 'NDX', expiration: cfg.expiration, orders, positions: null,
    engineOrders: [...known].map((orderId) => ({ orderId, brokerApplied: true })) });
  const done = new Set(st.absorbedOrderIds.map(String));
  for (const row of book.orders) {
    if (row.origin !== 'manual' || done.has(row.orderId)) continue;
    const pos = positionFromOrder(row);
    if (!pos) continue;
    // TRUE NET, AND SAY SO when a manual leg works against an engine leg (sells what the engine is long, or buys
    // what it is short). Booked as-is: the sum of the positions is then exactly what the account holds.
    const net = engineNet(st);
    for (const l of row.legs) {
      const e = net.get(legKey(l)) || 0;
      if (e && Math.sign(e) !== Math.sign(l.qty)) out.nets.push({ leg: legKey(l), engine: e, manual: l.qty, orderId: row.orderId });
    }
    st.positions.push(pos);
    noteCash(st, pos.limit * 100 * pos.quantity);   // real money moved: the capital view (cashDeployed) includes it
    st.absorbedOrderIds.push(row.orderId);
    done.add(row.orderId);
    out.added.push(pos);
  }
  return out;
}

module.exports = { absorbManualOrders, positionFromOrder, maxLossPerUnit };
