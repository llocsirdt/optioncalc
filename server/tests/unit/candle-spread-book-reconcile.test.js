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

// ── THE FIELD NAMES THE ENGINE'S EVENT LOG READS ────────────────────────────────────────────────────
// index.js's book_reconcile event and its console warning read these off the report. I first wrote them as
// engine.opens / engine.covers, which are not fields — the event logged `undefined` for both and a replay
// over 967 archived records is what showed it. Naming them here means a rename breaks a test instead of
// quietly emptying the one alert that says the book is not real.
{
  const rep = BR.reconcileBook({ tradeDate: '2026-09-25', config: { variant: 'v', dryRun: false },
    state: { positions: [], liveOrders: [] } });
  for (const k of ['opensFilled', 'opensWorking', 'coversFilled', 'coversResting', 'hedgesFilled'])
    ok(typeof rep.engine[k] === 'number', `engine.${k} is a number the log can print`);
  for (const k of ['sent', 'filled', 'working', 'dead', 'openFills', 'coverFills'])
    ok(typeof rep.broker[k] === 'number', `broker.${k} is a number the log can print`);
  ok(rep.severity === 'clean' && rep.mode === 'LIVE', 'an empty live book is clean, not divergent');
}

// ── THE POSITION LOOP: WHAT DO WE ACTUALLY HOLD? ────────────────────────────────────────────────────
// The order loop cannot see a fill whose order id we lost, an assignment, or a position that outlived our
// record (the store.js durability gap). All three look like "nothing there" from the order rows.
{
  // The symbol format is NOT an assumption: these come from the real chain cache, where NDX options trade
  // under the root NDXP — so an engine-side symbol built from config.symbol ('NDX') would miss every leg
  // and read the whole book as phantom. That is why the broker's symbol is PARSED, never ours constructed.
  const o = BR.parseOccSymbol('NDXP  260430C24300000');
  ok(o && o.root === 'NDXP' && o.type === 'C' && o.strike === 24300 && o.yymmdd === '260430',
    `a real chain symbol parses (${JSON.stringify(o)})`);
  ok(BR.occDate('2026-04-30') === '260430', 'and our expiration maps into the same space');
  ok(BR.parseOccSymbol('NDX') === null && BR.parseOccSymbol('') === null,
    'an equity/index symbol is not an option symbol');

  const pos = (strikes, over = {}) => ({ id: 'p' + strikes[0], side: 'bull', filled: true, quantity: 2,
    legs: [{ side: 'long', type: 'C', strike: strikes[0] }, { side: 'short', type: 'C', strike: strikes[1] }],
    ...over });
  const rec = (positions, dryRun = false) => ({ tradeDate: '2026-04-30',
    config: { variant: 'v7-10', dryRun, symbol: 'NDX', expiration: '2026-04-30', quantity: 2 },
    state: { positions, liveOrders: [] } });
  const brk = (rows) => ({ securitiesAccount: { positions: rows } });
  const row = (sym, long, short) => ({ instrument: { symbol: sym, assetType: 'OPTION' },
    longQuantity: long || 0, shortQuantity: short || 0 });

  // AGREEMENT. A 2-lot long C24300 / short C24310 is +2 and -2 at the broker.
  {
    const r = BR.reconcilePositions(rec([pos([24300, 24310])]),
      brk([row('NDXP  260430C24300000', 2, 0), row('NDXP  260430C24310000', 0, 2)]));
    ok(r.agree === true && r.severity === 'clean', `matching books agree (${r.severity} ${JSON.stringify(r.byKind)})`);
    ok(r.brokerRoots.join() === 'NDXP', 'and the root actually seen is reported, not assumed');
  }
  // UNMANAGED — the broker holds something we have no record of. The dangerous one.
  {
    const r = BR.reconcilePositions(rec([pos([24300, 24310])]),
      brk([row('NDXP  260430C24300000', 2, 0), row('NDXP  260430C24310000', 0, 2),
           row('NDXP  260430P24000000', 5, 0)]));
    const d = r.diffs.find((x) => x.leg === 'P24000');
    ok(r.severity === 'DIVERGENT' && d && d.kind === 'unmanaged' && d.broker === 5 && d.engine === 0,
      `a position we do not know about is flagged unmanaged (${JSON.stringify(d)})`);
  }
  // MISSING — we believe in legs the broker does not hold. Our book is fiction.
  {
    const r = BR.reconcilePositions(rec([pos([24300, 24310])]), brk([]));
    ok(r.byKind.missing === 2 && r.severity === 'DIVERGENT',
      `both legs of a book the broker does not have are missing (${JSON.stringify(r.byKind)})`);
  }
  // QUANTITY — same leg, different size.
  {
    const r = BR.reconcilePositions(rec([pos([24300, 24310])]),
      brk([row('NDXP  260430C24300000', 1, 0), row('NDXP  260430C24310000', 0, 2)]));
    const d = r.diffs.find((x) => x.leg === 'C24300');
    ok(d && d.kind === 'quantity' && d.engine === 2 && d.broker === 1, `size mismatch is its own kind (${JSON.stringify(d)})`);
  }
  // A COVERED VERTICAL IS FOUR OPEN LEGS. Covers are opened, not closed, so every leg is still held.
  {
    const p = pos([24300, 24310], { covered: true,
      coverLegs: [{ side: 'short', type: 'P', strike: 24310 }, { side: 'long', type: 'P', strike: 24320 }] });
    const r = BR.reconcilePositions(rec([p]),
      brk([row('NDXP  260430C24300000', 2, 0), row('NDXP  260430C24310000', 0, 2),
           row('NDXP  260430P24310000', 0, 2), row('NDXP  260430P24320000', 2, 0)]));
    ok(r.agree === true && r.engineLegCount === 4, `a covered position expects all four legs (${r.engineLegCount})`);
  }
  // AN UNFILLED ORDER IS NOT A HOLDING.
  {
    const r = BR.reconcilePositions(rec([pos([24300, 24310], { filled: false })]), brk([]));
    ok(r.agree === true && r.engineLegCount === 0, 'an unfilled position expects nothing at the broker');
  }
  // ANOTHER EXPIRATION IS NOT OUR BOOK — counted and reported, never diffed against today.
  {
    const r = BR.reconcilePositions(rec([pos([24300, 24310])]),
      brk([row('NDXP  260430C24300000', 2, 0), row('NDXP  260430C24310000', 0, 2),
           row('NDXP  260501C24300000', 9, 0)]));
    ok(r.agree === true && r.brokerOtherExpiry === 1,
      `a different expiration is reported separately (${r.brokerOtherExpiry}), not called a divergence`);
  }
  // A SYMBOL WE CANNOT READ IS NOT A SYMBOL WE DO NOT HOLD — the false-clean shape this repo keeps hitting.
  {
    const r = BR.reconcilePositions(rec([pos([24300, 24310])]),
      brk([row('NDXP  260430C24300000', 2, 0), row('NDXP  260430C24310000', 0, 2),
           row('SOMETHING WEIRD', 3, 0)]));
    ok(r.severity === 'UNREADABLE' && r.agree === false && r.unparsedSymbols.length === 1,
      `an unparseable symbol refuses to report clean (${r.severity})`);
  }
  // A SIMULATED RUN HOLDS NOTHING, so a broker position under this expiration is someone else's.
  {
    const r = BR.reconcilePositions(rec([], true), brk([row('NDXP  260430C24300000', 2, 0)]));
    ok(r.severity === 'expected', 'a simulated run does not get called divergent for positions it never sent');
  }
  // The `quantity` fallback, for a response that omits longQuantity/shortQuantity.
  {
    const r = BR.reconcilePositions(rec([pos([24300, 24310])]),
      brk([{ instrument: { symbol: 'NDXP  260430C24300000', assetType: 'OPTION' }, quantity: 2 },
           { instrument: { symbol: 'NDXP  260430C24310000', assetType: 'OPTION' }, quantity: -2 }]));
    ok(r.agree === true, 'a signed `quantity` row is read when long/shortQuantity are absent');
  }
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
