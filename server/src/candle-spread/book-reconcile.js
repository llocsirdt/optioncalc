'use strict';
/**
 * BOOK RECONCILIATION — what the engine believes it holds, against what the broker says it holds.
 *
 * WHY THIS EXISTS. The state machine books a fill when `markFill` judges the chain mark to have reached
 * the limit. It has never consulted the broker: trader.js contains no reference to liveOrders at all. The
 * order-manager tracks real orders ALONGSIDE that, and the two have simply never been compared.
 *
 * In dry-run that is right — there is no broker. In TEST mode it is right by construction — orders are
 * sent at deliberately unfillable prices, so the broker book is empty on purpose while the strategy book
 * simulates the day. Measured on v7-10 for 2026-09-25: the engine believed 16 opens and 13 covers filled;
 * the broker reported 0 filled and 33 dead.
 *
 * With REAL fillable orders that divergence stops being a design choice and becomes a phantom book: the
 * engine would compute floors, caps, governor gates and covers against positions that are not at the
 * broker, place covers for things it does not hold, and leave real positions naked.
 *
 * This module does not fix that. It MEASURES it, in every mode, so the gap is a number before it is a
 * loss — and so "the two books agree" becomes a thing that can be asserted rather than assumed. It is the
 * acceptance test for the closed-loop work, and it is useful immediately: running it against test-mode
 * sessions says how far apart the books WOULD have been on real orders, with nothing at stake.
 *
 * Pure: takes a run record, returns a report. Writes nothing.
 */

const OM = require('./order-manager');   // isOpenKind — an open fills under 'open' or 'open-reprice'
const TERMINAL_DEAD = new Set(['canceled', 'rejected', 'expired']);

// What the STRATEGY believes, from its own positions.
function engineBook(record) {
  const ps = ((record && record.state) || {}).positions || [];
  const opens = ps.filter((p) => p && p.filled && !p.hedge && !p.wing && !p.fly);
  return {
    opensFilled: opens.length,
    opensWorking: ps.filter((p) => p && p.filled === false && !p.pendingHedge).length,
    coversFilled: ps.filter((p) => p && p.covered).length,
    coversResting: ps.filter((p) => p && !p.covered && p.pendingCover).length,
    hedgesFilled: ps.filter((p) => p && p.filled && (p.hedge || p.wing || p.fly)).length,
  };
}

// What the BROKER reports, from the orders actually sent.
function brokerBook(record) {
  const los = ((record && record.state) || {}).liveOrders || [];
  const of = (pred) => los.filter(pred).length;
  return {
    sent: los.length,
    filled: of((o) => o.status === 'filled'),
    working: of((o) => o.status === 'working'),
    dead: of((o) => TERMINAL_DEAD.has(o.status)),
    openFills: of((o) => o.status === 'filled' && OM.isOpenKind(o.kind)),
    coverFills: of((o) => o.status === 'filled' && /cover/.test(o.kind || '')),
  };
}

/**
 * Per-position disagreement. This is the part that matters: a COUNT can match by coincidence while the
 * individual positions disagree, so every discrepancy is named.
 *
 * Four kinds, and they are not equally dangerous:
 *   phantom-open    the engine holds a position the broker never filled  -> it is trading on nothing
 *   missing-open    the broker filled an order the engine did not book   -> an unmanaged real position
 *   phantom-cover   the engine booked a lock the broker never gave it    -> an overstated floor
 *   missing-cover   the broker filled a cover the engine did not book    -> a real hedge it ignores
 *   price-drift     both agree it filled, at materially different prices -> every downstream number is off
 */
function positionDiffs(record, opts) {
  const o = opts || {};
  const tol = o.priceTolerance != null ? o.priceTolerance : 0.05;   // one tick
  const st = (record && record.state) || {};
  const ps = st.positions || [];
  const los = st.liveOrders || [];
  // LINK THE TWO BOOKS FROM BOTH ENDS, because neither end knows the whole relationship.
  //
  // A COVER order carries `positionId`: the position already exists when the cover is placed. An OPEN
  // order does NOT — the order is sent BEFORE the position is created, so trackOrder receives null and
  // the only link is `pos.orderId`, written afterwards from the send result. Matching on positionId alone
  // therefore reconciles covers and silently skips every open, which is exactly what the first run of
  // this module did: 13 phantom-covers found and 0 phantom-opens, on a session where the engine believed
  // 16 opens filled and the broker reported none. A reconciliation blind to half the book is worse than
  // none, because it reads as a partial all-clear.
  const byId = new Map(los.filter((o) => o && o.orderId).map((o) => [o.orderId, o]));
  const byPos = new Map();
  const attach = (pid, lo) => {
    if (!pid || !lo) return;
    const g = byPos.get(pid) || { open: [], cover: [] };
    const bucket = /cover/.test(lo.kind || '') ? g.cover : g.open;
    if (!bucket.includes(lo)) bucket.push(lo);
    byPos.set(pid, g);
  };
  for (const lo of los) attach(lo && lo.positionId, lo);           // covers, and anything explicitly tagged
  for (const p of ps) {                                            // opens, via the link on the position
    if (!p || !p.id) continue;
    if (p.orderId) attach(p.id, byId.get(p.orderId));
    if (p.pendingCover && p.pendingCover.orderId) attach(p.id, byId.get(p.pendingCover.orderId));
    if (p.coverOrderId) attach(p.id, byId.get(p.coverOrderId));
  }
  const diffs = [];
  for (const p of ps) {
    if (!p || !p.id) continue;
    const g = byPos.get(p.id);
    // NO REAL ORDER WAS EVER SENT FOR THIS POSITION. That is not a disagreement — it is a simulated
    // variant, or a position opened before arming. Silence here is what keeps the report readable.
    if (!g) continue;
    const openFilled = g.open.some((x) => x.status === 'filled');
    const coverFilled = g.cover.some((x) => x.status === 'filled');
    if (p.filled && g.open.length && !openFilled) {
      diffs.push({ kind: 'phantom-open', positionId: p.id, engine: 'filled',
        broker: g.open.map((x) => x.status).join('/'), limit: p.limit });
    }
    if (!p.filled && openFilled) {
      const f = g.open.find((x) => x.status === 'filled');
      diffs.push({ kind: 'missing-open', positionId: p.id, engine: 'not filled',
        broker: 'FILLED', brokerPrice: f.fillPrice });
    }
    if (p.covered && g.cover.length && !coverFilled) {
      diffs.push({ kind: 'phantom-cover', positionId: p.id, engine: 'covered',
        broker: g.cover.map((x) => x.status).join('/'), coverLimit: p.coverLimit });
    }
    if (!p.covered && coverFilled) {
      const f = g.cover.find((x) => x.status === 'filled');
      diffs.push({ kind: 'missing-cover', positionId: p.id, engine: 'uncovered',
        broker: 'FILLED', brokerPrice: f.fillPrice });
    }
    // PRICE DRIFT, only where both agree the thing filled. The engine books its own limit; the broker
    // reports what was actually paid. Compared in the space the order was SENT in, because a credit twin's
    // fill is a credit and the position's `limit` is debit-canonical.
    if (p.filled && openFilled) {
      const f = g.open.find((x) => x.status === 'filled');
      const mine = p.sentNet === 'CREDIT' && p.sentLimit != null ? p.sentLimit : p.limit;
      if (f.fillPrice != null && mine != null && Math.abs(f.fillPrice - mine) > tol) {
        diffs.push({ kind: 'price-drift', positionId: p.id, what: 'open',
          engine: mine, broker: f.fillPrice, delta: Math.round((f.fillPrice - mine) * 100) / 100 });
      }
    }
  }
  return diffs;
}

// The whole report. `mode` is the run's dryRun, because what counts as a PROBLEM depends on it.
function reconcileBook(record, opts) {
  const cfg = (record && record.config) || {};
  const engine = engineBook(record);
  const broker = brokerBook(record);
  const diffs = positionDiffs(record, opts);
  const mode = cfg.dryRun;
  // EXPECTED DIVERGENCE IS NOT A FAILURE. A simulated variant sends nothing, and a test-mode order is
  // priced never to fill — in both the books are meant to differ, and saying so is the difference between
  // a report you read and one you learn to ignore.
  const expectDivergence = mode === true || mode === 'test';
  const byKind = {};
  for (const d of diffs) byKind[d.kind] = (byKind[d.kind] || 0) + 1;
  return {
    variant: cfg.variant || null,
    tradeDate: record && record.tradeDate,
    mode: mode === true ? 'simulate' : mode === 'test' ? 'test (unfillable by design)' : 'LIVE',
    expectDivergence,
    engine,
    broker,
    diffs,
    byKind,
    agree: diffs.length === 0,
    // The number that matters when this is armed for real: disagreements that would mean trading on a
    // book that is not there. In test mode every position is one of these by design.
    severity: expectDivergence ? 'expected' : diffs.length ? 'DIVERGENT' : 'clean',
  };
}



// ── THE SECOND LOOP: WHAT DO WE ACTUALLY HOLD? ──────────────────────────────────────────────────────
//
// The order loop above asks "did the orders we sent fill?". That question cannot see:
//   - a fill whose order id we lost (a crash between send and record, a replace whose new id never landed)
//   - an assignment or early exercise
//   - a position that survived from a PRIOR session while our record did not — the local-disk durability
//     gap in store.js, which is the one that turns catastrophic with real money
// All three look identical from the order rows: nothing there at all. Only the broker's POSITION list has
// them, so this compares the legs we believe we hold against the legs the broker says we hold.
//
// REPORT ONLY. It never mutates a book. A position-level disagreement can mean our record is wrong OR that
// we are reading the wrong account, and repairing a book from a source you have not validated is worse
// than knowing it disagrees.
//
// *** THE RESPONSE SHAPE HERE IS UNVALIDATED. *** Every order this system has ever sent was test-mode
// unfillable against an unfunded account, so no real position has ever existed to read. The Schwab
// position shape (securitiesAccount.positions[] with longQuantity/shortQuantity/instrument.symbol) is from
// the documentation, not from a response this code has seen. Until a real position exists, treat a
// disagreement reported here as "the reconciler or the account is wrong" first.
//
// SYMBOLS ARE PARSED, NEVER CONSTRUCTED. The engine stores legs as {side, type, strike} with no symbol,
// and the obvious repair — build one from config.symbol — is wrong: NDX options trade under the root
// `NDXP` ("NDXP  260430C24300000" in the chain cache), so every leg we built would have missed and the
// whole book would have read as phantom. Parsing their symbol needs no assumption about our root.
const OCC = /^([A-Z.$/]{1,6}) *(\d{6})([CP])(\d{8})$/;
function parseOccSymbol(sym) {
  // "NDXP  260430C24300000" — root, padding spaces, YYMMDD, C/P, strike x 1000 in 8 digits. The regex
  // reads that directly; an earlier version re-padded the root first, which was machinery for nothing.
  const m = OCC.exec(String(sym || ''));
  if (!m) return null;
  return { root: m[1].trim(), yymmdd: m[2], type: m[3], strike: Number(m[4]) / 1000 };
}

// yyyy-mm-dd -> the yymmdd an OCC symbol carries.
function occDate(expiration) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(expiration || ''));
  return m ? m[1].slice(2) + m[2] + m[3] : null;
}

// Net contracts per leg, signed: long positive, short negative. A covered vertical is FOUR open legs at
// the broker (covers are opened, not closed), so every filled leg counts — including hedges.
function engineLegs(record) {
  const st = (record && record.state) || {};
  const cfg = (record && record.config) || {};
  const net = new Map();
  const add = (leg, qty) => {
    if (!leg || !leg.type || leg.strike == null) return;
    const k = `${leg.type}${leg.strike}`;
    net.set(k, (net.get(k) || 0) + (leg.side === 'short' ? -qty : qty));
  };
  for (const p of st.positions || []) {
    if (!p || !p.filled) continue;                       // an unfilled order is not a holding
    const q = p.quantity || cfg.quantity || 1;
    for (const l of p.legs || []) add(l, q);
    if (p.covered) for (const l of p.coverLegs || []) add(l, q);
  }
  return net;
}

// The broker's side, filtered to this run's expiration.
function brokerLegs(details, expiration) {
  const acct = (details && (details.securitiesAccount || details)) || {};
  const rows = acct.positions || [];
  const net = new Map();
  const want = occDate(expiration);
  const roots = new Set();
  const unparsed = [];
  let otherExpiry = 0;
  for (const r of rows) {
    const inst = (r && r.instrument) || {};
    if (inst.assetType && inst.assetType !== 'OPTION') continue;
    const o = parseOccSymbol(inst.symbol);
    if (!o) { if (inst.symbol) unparsed.push(inst.symbol); continue; }
    roots.add(o.root);
    if (want && o.yymmdd !== want) { otherExpiry++; continue; }
    // longQuantity/shortQuantity is the documented shape; `quantity` is the fallback, and a short row
    // there may already be negative — hence the sign guard rather than a blind negate.
    const lq = Number(r.longQuantity || 0), sq = Number(r.shortQuantity || 0);
    let q = lq - sq;
    if (!lq && !sq && r.quantity != null) q = Number(r.quantity);
    if (!q) continue;
    const k = `${o.type}${o.strike}`;
    net.set(k, (net.get(k) || 0) + q);
  }
  return { net, roots: [...roots], unparsed, otherExpiry, rows: rows.length };
}

/**
 * Per-leg disagreement between our book and the broker's positions.
 *
 * Kinds, in the order they should worry you:
 *   unmanaged   the broker holds contracts we have no record of  -> real risk nothing is watching
 *   missing     we believe we hold contracts the broker does not -> our book is fiction
 *   quantity    both hold it, in different size
 */
function legDiffs(record, details) {
  const cfg = (record && record.config) || {};
  const mine = engineLegs(record);
  const theirs = brokerLegs(details, cfg.expiration);
  const out = [];
  for (const k of new Set([...mine.keys(), ...theirs.net.keys()])) {
    const a = mine.get(k) || 0, b = theirs.net.get(k) || 0;
    if (a === b) continue;
    const kind = a === 0 ? 'unmanaged' : b === 0 ? 'missing' : 'quantity';
    out.push({ leg: k, engine: a, broker: b, kind });
  }
  out.sort((x, y) => (x.kind === y.kind ? x.leg.localeCompare(y.leg) : x.kind.localeCompare(y.kind)));
  return { diffs: out, broker: theirs, engineLegCount: mine.size };
}

function reconcilePositions(record, details) {
  const cfg = (record && record.config) || {};
  const { diffs, broker, engineLegCount } = legDiffs(record, details);
  const mode = cfg.dryRun;
  // A run that sends nothing cannot hold anything, so any broker position under this expiration belongs to
  // something else — worth SAYING, never worth calling this run's divergence.
  const expectDivergence = mode === true || mode === 'test';
  const byKind = {};
  for (const d of diffs) byKind[d.kind] = (byKind[d.kind] || 0) + 1;
  return {
    variant: cfg.variant || null,
    tradeDate: record && record.tradeDate,
    expiration: cfg.expiration || null,
    mode: mode === true ? 'simulate' : mode === 'test' ? 'test (unfillable by design)' : 'LIVE',
    expectDivergence,
    engineLegCount,
    brokerRows: broker.rows,
    brokerRoots: broker.roots,
    brokerOtherExpiry: broker.otherExpiry,
    // A SYMBOL WE COULD NOT PARSE IS NOT A SYMBOL WE DO NOT HOLD. Dropping it silently is how a
    // reconciler reports clean on a book it never read.
    unparsedSymbols: broker.unparsed,
    diffs,
    byKind,
    agree: diffs.length === 0 && !broker.unparsed.length,
    severity: broker.unparsed.length ? 'UNREADABLE'
      : expectDivergence ? 'expected'
      : diffs.length ? 'DIVERGENT' : 'clean',
  };
}

module.exports = { reconcileBook, engineBook, brokerBook, positionDiffs,
  // the POSITION loop (report-only; response shape unvalidated — see the note above)
  reconcilePositions, legDiffs, engineLegs, brokerLegs, parseOccSymbol, occDate };
