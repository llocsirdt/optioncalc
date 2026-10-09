'use strict';
// ACCOUNT BOOK — what the Schwab account ACTUALLY holds for one underlying + expiration, built from the broker's
// own records, never from the engine's. (User, 2026-10-09: "the pull in the UI should ALWAYS return the actual
// full positions set that schwab holds - NOT just what the engine thinks".)
//
// Why it exists: 2026-10-09 v7-10 held 6 filled orders (12 legs) while the engine's book — and therefore the UI's
// optionArray — showed 8 legs. One order was the user's edited cover that the engine adopted but never booked
// (numeric-id bug), one was a cover the user placed by hand. The risk curve on screen was the ENGINE's belief,
// not the account, on the one day it mattered.
//
// Two broker sources, cross-checked:
//   orders     — today's FILLED orders: legs, real execution prices, time, tag. These carry the structure and
//                the price, so the optionArray is built from them (one row per order, like the engine pull).
//   positions  — the account's net quantity per option. The ground truth for WHAT is held. Anything the
//                orders do not explain (an earlier fill, a fill outside the window) is added from here at its
//                average price and flagged, so the legs always net to exactly what the account holds.
// Each order is matched to the engine: `engine` (sent and booked), `engine-unbooked` (sent, filled at the broker,
// never booked), or `manual` (not sent by the engine). Pure: the caller passes the broker responses.

const r2 = (x) => Math.round(x * 100) / 100;
const OCC = /^([A-Z.$/]{1,6}) *(\d{6})([CP])(\d{8})$/;
function parseOcc(sym) {
  const m = OCC.exec(String(sym || '').trim());
  return m ? { root: m[1].trim(), yymmdd: m[2], type: m[3], strike: Number(m[4]) / 1000 } : null;
}
function occDate(expiration) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(expiration || ''));
  return m ? m[1].slice(2) + m[2] + m[3] : null;
}
// Roots an underlying's options trade under. NDX index options are NDXP (PM-settled 0DTE) and NDX.
const ROOTS = { NDX: ['NDXP', 'NDX'], SPX: ['SPXW', 'SPX'], RUT: ['RUTW', 'RUT'] };
const rootsFor = (symbol) => ROOTS[String(symbol || '').toUpperCase().replace(/^\$/, '')] || [String(symbol || '').toUpperCase()];
const legKey = (type, strike) => `${type}${strike}`;

// Average execution price per legId (quantity-weighted across partial executions).
function execPrices(order) {
  const acc = {};
  for (const a of order.orderActivityCollection || []) {
    for (const e of a.executionLegs || []) {
      const k = e.legId; if (k == null || !(e.price != null)) continue;
      const q = Number(e.quantity) || 1;
      acc[k] = acc[k] || { px: 0, q: 0 };
      acc[k].px += Number(e.price) * q; acc[k].q += q;
    }
  }
  const out = {};
  for (const [k, v] of Object.entries(acc)) out[k] = v.q ? v.px / v.q : null;
  return out;
}

/**
 * @param o.symbol       underlying ('NDX')
 * @param o.expiration   'YYYY-MM-DD'
 * @param o.orders       Schwab ordersByAccount response (any statuses; only FILLED / partially filled are used)
 * @param o.positions    Schwab accountsDetails(...).securitiesAccount.positions, or null if unavailable
 * @param o.engineOrders [{ orderId, variant, status, brokerApplied, adoptedFrom }] from the run records
 */
function buildAccountBook({ symbol, expiration, orders, positions, engineOrders }) {
  const yymmdd = occDate(expiration);
  const roots = rootsFor(symbol);
  const mine = (sym) => { const p = parseOcc(sym); return p && p.yymmdd === yymmdd && roots.includes(p.root) ? p : null; };
  const known = new Map();
  for (const e of engineOrders || []) {
    if (e && e.orderId != null) known.set(String(e.orderId), e);
  }

  // ── orders ─────────────────────────────────────────────────────────────────────────────────────────────
  const rows = [];
  for (const o of orders || []) {
    const filledQty = Number(o.filledQuantity) || (String(o.status).toUpperCase() === 'FILLED' ? Number(o.quantity) || 0 : 0);
    if (!(filledQty > 0)) continue;
    const legsIn = (o.orderLegCollection || []).map((l) => ({ l, p: mine(l.instrument && l.instrument.symbol) }));
    if (!legsIn.length || legsIn.some((x) => !x.p)) continue;          // another underlying / expiry (or mixed)
    const px = execPrices(o);
    const scale = filledQty / (Number(o.quantity) || filledQty);
    const legs = legsIn.map(({ l, p }) => {
      const buy = /^BUY/.test(String(l.instruction || ''));
      const qty = (buy ? 1 : -1) * (Number(l.quantity) || 1) * scale;
      return { side: buy ? 'long' : 'short', type: p.type, strike: p.strike, qty, price: px[l.legId] != null ? r2(px[l.legId]) : null,
        instruction: l.instruction };
    });
    // Net per contract from the EXECUTIONS; the order's own limit only when Schwab gave no execution prices.
    const haveExec = legs.every((x) => x.price != null);
    const unitQty = Math.abs(legs[0].qty) || 1;
    const net = haveExec
      ? r2(legs.reduce((t, x) => t + (x.qty > 0 ? 1 : -1) * x.price * Math.abs(x.qty), 0) / unitQty)
      : r2((String(o.orderType).toUpperCase() === 'NET_CREDIT' ? -1 : 1) * Number(o.price || 0));
    const eng = known.get(String(o.orderId));
    const origin = !eng ? 'manual' : eng.brokerApplied === true ? 'engine' : 'engine-unbooked';
    rows.push({ orderId: String(o.orderId), time: o.closeTime || o.enteredTime || null, epoch: Date.parse(o.closeTime || o.enteredTime || '') || null,
      net: net >= 0 ? 'DEBIT' : 'CREDIT', price: Math.abs(net), contracts: unitQty, priceFrom: haveExec ? 'executions' : 'order-limit',
      legs, origin, variant: eng ? eng.variant : null, adoptedFrom: eng && eng.adoptedFrom ? String(eng.adoptedFrom) : undefined,
      tag: o.tag ? String(o.tag).slice(0, 4) : null });
  }
  rows.sort((a, b) => (a.epoch || 0) - (b.epoch || 0));

  // ── net by leg: orders vs the account's own positions ─────────────────────────────────────────────────
  const fromOrders = new Map();
  for (const r of rows) for (const l of r.legs) fromOrders.set(legKey(l.type, l.strike), (fromOrders.get(legKey(l.type, l.strike)) || 0) + l.qty);
  const held = new Map(), avg = new Map();
  const positionsKnown = Array.isArray(positions);
  for (const p of positions || []) {
    const s = p && p.instrument && p.instrument.symbol; const q = mine(s);
    if (!q) continue;
    const n = (Number(p.longQuantity) || 0) - (Number(p.shortQuantity) || 0);
    held.set(legKey(q.type, q.strike), (held.get(legKey(q.type, q.strike)) || 0) + n);
    avg.set(legKey(q.type, q.strike), Number(p.averagePrice) || 0);
  }
  // RESIDUAL: held by the account but not explained by today's fills (or the reverse). Added from the
  // positions at their average price so the legs always net to EXACTLY what the account holds.
  const residual = [];
  if (positionsKnown) {
    const keys = new Set([...fromOrders.keys(), ...held.keys()]);
    for (const k of keys) {
      const d = r2((held.get(k) || 0) - (fromOrders.get(k) || 0));
      if (Math.abs(d) < 1e-9) continue;
      const type = k[0], strike = Number(k.slice(1));
      residual.push({ type, strike, qty: d, price: held.has(k) ? r2(avg.get(k)) : null });
    }
  }

  // ── optionArray: one entry per leg, the order's NET cost on its first long leg (strategy-positions.js
  // convention), negative for a credit. Residual legs carry their own average-price cost. ─────────────────
  const legs = [], legEpochs = [];
  for (const r of rows) {
    const netDollars = Math.round((r.net === 'CREDIT' ? -1 : 1) * r.price * 100 * r.contracts);
    let assigned = false;
    for (const l of r.legs) {
      const cost = (l.qty > 0 && !assigned) ? (assigned = true, netDollars) : 0;
      legs.push({ qty: l.qty, type: l.type.toLowerCase(), strike: l.strike, cost });
      legEpochs.push(r.epoch);
    }
    if (!assigned && legs.length) legs[legs.length - r.legs.length].cost = netDollars;   // all-short order
  }
  for (const x of residual) {
    legs.push({ qty: x.qty, type: x.type.toLowerCase(), strike: x.strike, cost: x.price != null ? Math.round(x.qty * x.price * 100) : 0 });
    legEpochs.push(null);
  }
  const optionArrayString = legs.map((l) => `${l.qty}${l.type}${l.strike}@${l.cost}`).join(',');

  // ── flags: everything the engine does not know, said plainly ───────────────────────────────────────────
  const flags = [];
  const manual = rows.filter((r) => r.origin === 'manual'), unbooked = rows.filter((r) => r.origin === 'engine-unbooked');
  for (const r of manual) flags.push({ kind: 'manual', orderId: r.orderId, note: `order ${r.orderId} (${legStr(r.legs)} ${r.net} ${r.price}) was not sent by the engine — the engine's book does not include it` });
  for (const r of unbooked) flags.push({ kind: 'engine-unbooked', orderId: r.orderId, variant: r.variant, note: `order ${r.orderId} (${legStr(r.legs)} ${r.net} ${r.price}) filled at Schwab but ${r.variant} never booked it` });
  for (const x of residual) flags.push({ kind: 'residual', leg: legKey(x.type, x.strike), qty: x.qty, note: `account holds ${x.qty > 0 ? '+' : ''}${x.qty} ${x.type}${x.strike} that today's fills do not explain` });
  if (!positionsKnown) flags.push({ kind: 'positions-unavailable', note: 'account positions could not be read — legs are from filled orders only' });

  return {
    source: 'account', symbol, expiration, asOf: new Date().toISOString(),
    orders: rows, residual,
    netByLeg: [...(positionsKnown ? held : fromOrders).entries()].filter(([, n]) => n !== 0).sort((a, b) => a[0].localeCompare(b[0])).map(([k, n]) => ({ leg: k, qty: n })),
    optionArrayString, legs, legEpochs, flags,
    counts: { orders: rows.length, legs: legs.length, engine: rows.length - manual.length - unbooked.length, manual: manual.length, engineUnbooked: unbooked.length, residualLegs: residual.length },
  };
}
const legStr = (legs) => legs.slice().sort((a, b) => a.strike - b.strike).map((l) => `${l.qty > 0 ? '+' : ''}${l.qty}${l.type.toLowerCase()}${l.strike}`).join(' ');

module.exports = { buildAccountBook, parseOcc, occDate, rootsFor };
