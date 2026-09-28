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
    openFills: of((o) => o.status === 'filled' && o.kind === 'open'),
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

module.exports = { reconcileBook, engineBook, brokerBook, positionDiffs };
