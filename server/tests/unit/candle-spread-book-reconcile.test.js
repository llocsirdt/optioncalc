'use strict';
// WHAT THE ENGINE BELIEVES vs WHAT THE BROKER SAYS.
//
// trader.js contains no reference to liveOrders: the state machine books a fill when markFill judges the
// chain mark to have reached the limit, and has never asked the broker. In dry-run that is right (there
// is no broker) and in TEST mode it is right by construction (orders are priced never to fill). With real
// fillable orders it becomes a phantom book — floors, caps, governor gates and covers computed against
// positions that are not there.
//
// This suite pins the MEASUREMENT of that gap, which is the acceptance test for the closed-loop work.
//
// Run: node server/tests/unit/candle-spread-book-reconcile.test.js
const BR = require('../../src/candle-spread/book-reconcile');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

const rec = (dryRun, positions, liveOrders) => ({
  tradeDate: '2026-09-28', config: { variant: 't', dryRun }, events: [],
  state: { positions, liveOrders },
});

// ── A SIMULATED RUN SENDS NOTHING, SO THERE IS NOTHING TO DISAGREE WITH ─────────────────────────────
{
  const r = BR.reconcileBook(rec(true, [{ id: 'p1', filled: true, covered: true }], []));
  ok(r.diffs.length === 0, 'a simulated run reports no disagreement');
  ok(r.severity === 'expected', `and is not called a failure (${r.severity})`);
  ok(r.engine.opensFilled === 1, 'while still reporting what the engine believes');
}

// ── AN OPEN IS LINKED BY pos.orderId, NOT BY the order's positionId ─────────────────────────────────
// The order is SENT before the position exists, so trackOrder gets positionId null and the only link is
// written afterwards onto the position. Matching on positionId alone reconciles covers and silently skips
// every open — the first run of this module found 13 phantom-covers and 0 phantom-opens on a session
// where the engine believed 16 opens filled and the broker reported none. A half-blind reconciliation
// reads as a partial all-clear, which is worse than none.
{
  const positions = [{ id: 'p1', filled: true, covered: false, limit: 5.2, orderId: 'o1' }];
  const liveOrders = [{ orderId: 'o1', kind: 'open', positionId: null, status: 'canceled' }];
  const r = BR.reconcileBook(rec('test', positions, liveOrders));
  ok(r.diffs.length === 1, `the open is reconciled despite positionId being null (${r.diffs.length} diff)`);
  ok(r.byKind['phantom-open'] === 1, 'and is reported as a phantom open');
}

// ── THE FOUR DISAGREEMENTS ──────────────────────────────────────────────────────────────────────────
{
  const positions = [
    { id: 'a', filled: true,  covered: false, limit: 5, orderId: 'oa' },                       // phantom-open
    { id: 'b', filled: false, covered: false, orderId: 'ob' },                                  // missing-open
    { id: 'c', filled: true,  covered: true,  limit: 5, coverLimit: 4, orderId: 'oc',
      pendingCover: { orderId: 'occ' } },                                                       // phantom-cover
    { id: 'd', filled: true,  covered: false, limit: 5, orderId: 'od',
      pendingCover: { orderId: 'odc' } },                                                       // missing-cover
  ];
  const liveOrders = [
    { orderId: 'oa', kind: 'open', status: 'rejected' },
    { orderId: 'ob', kind: 'open', status: 'filled', fillPrice: 5.1 },
    { orderId: 'oc', kind: 'open', status: 'filled', fillPrice: 5 },
    { orderId: 'occ', kind: 'cover-rest', positionId: 'c', status: 'canceled' },
    { orderId: 'od', kind: 'open', status: 'filled', fillPrice: 5 },
    { orderId: 'odc', kind: 'cover-rest', positionId: 'd', status: 'filled', fillPrice: 4.2 },
  ];
  const r = BR.reconcileBook(rec(false, positions, liveOrders));
  ok(r.byKind['phantom-open'] === 1, `phantom-open: engine holds what the broker refused (${r.byKind['phantom-open']})`);
  ok(r.byKind['missing-open'] === 1, `missing-open: the broker filled what the engine did not book (${r.byKind['missing-open']})`);
  ok(r.byKind['phantom-cover'] === 1, `phantom-cover: a lock the broker never gave (${r.byKind['phantom-cover']})`);
  ok(r.byKind['missing-cover'] === 1, `missing-cover: a real hedge the engine ignores (${r.byKind['missing-cover']})`);
  ok(r.severity === 'DIVERGENT', `a LIVE run with disagreements is DIVERGENT (${r.severity})`);
  ok(r.agree === false, 'and does not claim the books agree');
  const mo = r.diffs.find((d) => d.kind === 'missing-open');
  ok(mo && mo.brokerPrice === 5.1, 'a missing open carries the price the broker actually paid');
}

// ── PRICE DRIFT, COMPARED IN THE SPACE THE ORDER WAS SENT IN ────────────────────────────────────────
// A credit twin's fill is a CREDIT; the position's `limit` is debit-canonical. Comparing the broker's
// credit against a debit would flag every credit-sent open as drifting by the width.
{
  const positions = [{ id: 'p', filled: true, covered: false, limit: 6, sentNet: 'CREDIT',
    sentLimit: 14, orderId: 'o' }];
  const liveOrders = [{ orderId: 'o', kind: 'open', status: 'filled', fillPrice: 14 }];
  const r = BR.reconcileBook(rec(false, positions, liveOrders));
  ok(!r.byKind['price-drift'], 'a credit twin filled at its asked credit is NOT drift');

  const drifted = BR.reconcileBook(rec(false, positions,
    [{ orderId: 'o', kind: 'open', status: 'filled', fillPrice: 13.5 }]));
  const d = drifted.diffs.find((x) => x.kind === 'price-drift');
  ok(d && d.delta === -0.5, `but half a point less credit IS drift (${d && d.delta})`);
}

// ── A CLEAN LIVE BOOK SAYS SO ───────────────────────────────────────────────────────────────────────
{
  const r = BR.reconcileBook(rec(false,
    [{ id: 'p', filled: true, covered: true, limit: 5, coverLimit: 4, orderId: 'o', pendingCover: { orderId: 'oc' } }],
    [{ orderId: 'o', kind: 'open', status: 'filled', fillPrice: 5 },
     { orderId: 'oc', kind: 'cover-rest', positionId: 'p', status: 'filled', fillPrice: 4 }]));
  ok(r.agree === true && r.severity === 'clean', `agreement is reportable, not just disagreement (${r.severity})`);
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
