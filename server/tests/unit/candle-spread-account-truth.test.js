'use strict';
// THE ACCOUNT IS THE TRUTH (2026-10-12). On v7-10 the 14:25 bear was covered by the 30s worker (cover on fill)
// as sell P30650 / buy P30640. The worker never attached the leg ledger, so nothing checked or recorded those
// legs; the 15:15 bear's cover then tried to SELL P30640 to open while the account was long it, and Schwab
// rejected it until the close. The user: "there should be no chance of the engine ledger having positions
// listed that schwab disagrees with ... if they ever disagree the UI should indicate so loudly", and "any
// order sent needs to be captured exactly by the engine/ledger and displayed exactly in the UI".
//
// Pins:
//   1. placeContinuousCovers (the worker's entry point) resolves against AND records into the ledger
//   2. seedLedgerFromAccount: the account's legs set the ledger's sides, and corrections are reported
//   3. applyBrokerFills stamps the broker's filled order (legs, net, price) on the position, open and cover
//   4. the UI's trade rows and optionArray use that order literally
//   5. the banner fires on account divergence and recent repeated rejections, only for live runs, and never
//      merely because a position is uncovered
//
// Run: node server/tests/unit/candle-spread-account-truth.test.js
const os = require('os'), path = require('path'), fs = require('fs');
process.env.CANDLE_SPREAD_RUNS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-acct-'));
const trader = require('../../src/candle-spread/trader');
const BR = require('../../src/candle-spread/book-reconcile');
const SP = require('../../../client/lib/strategy-positions');
const DB = require('../../../client/lib/divergence-banner');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

const W = 10;
const cfg = { symbol: 'NDX', expiration: '2026-10-12', spreadWidth: W, strikeIncrement: 10, quantity: 1,
  tickIncrement: 0.05, coverSelector: 'fixed-mark', coverFillModel: 'resting', coverGeometry: 'tent', variant: 'acct' };
// Parity-consistent around 30645: calls fall 0.5/pt, puts rise 0.5/pt.
const getLeg = (type, strike) => {
  const mid = type === 'C' ? 30 - (strike - 30640) * 0.5 : 25 + (strike - 30640) * 0.5;
  return { mid, symbol: `NDXP_${type}${strike}`, bid: mid - 0.1, ask: mid + 0.1 };
};
const leg = (side, type, strike) => ({ side, type, strike });
const has = (legs, side, type, strike) => (legs || []).some((l) => l.side === side && l.type === type && l.strike === strike);

(async () => {
  // ── 1. THE WORKER PATH SEES AND RECORDS THE LEDGER ──────────────────────────────────────────────────
  {
    // The 15:15 bear: long P30650 / short P30640. The account is long P30640 (the 14:25 cover).
    const pos = { id: 'p-1992', side: 'bear', legs: [leg('long', 'P', 30650), leg('short', 'P', 30640)], quantity: 1,
      limit: 5.5, shortStrike: 30640, filled: true, covered: false, pendingCover: null, openTime: '10/12 15:15' };
    const st = { positions: [pos], cashDeployed: 0, legLedger: { P30640: 'long' } };
    const sent = [];
    // deps exactly as the worker builds them: enforceLegUniqueness on, NO _ledger attached by the caller
    const deps = { getLeg, enforceLegUniqueness: true, continuousCoverMinLockFrac: 0.10,
      placeOrder: async (payload, meta) => { sent.push(meta); return { status: 'sent', filled: true, orderId: `o${sent.length}` }; } };
    await trader.placeContinuousCovers(st, cfg, deps, [], '10/12 15:19', 30645);
    ok(sent.length === 1, `the cover was sent (${sent.length})`);
    const m = sent[0] || {};
    ok(!has(m.legs, 'short', 'P', 30640), `never SELL P30640 while the account is long it (${JSON.stringify(m.legs)})`);
    ok(st.legLedger.C30630 === 'long' && st.legLedger.C30640 === 'short',
      `the legs actually sent are recorded in the ledger (${JSON.stringify(st.legLedger)})`);
    ok(pos.pendingCover && has(pos.pendingCover.sentLegs, 'short', 'C', 30640), 'the resting cover carries the legs sent');
  }

  // ── 2. THE ACCOUNT SEEDS THE LEDGER ─────────────────────────────────────────────────────────────────
  {
    const details = { securitiesAccount: { positions: [
      { instrument: { assetType: 'OPTION', symbol: 'NDXP  261012P30640000' }, longQuantity: 1, shortQuantity: 0 },
      { instrument: { assetType: 'OPTION', symbol: 'NDXP  261012C30640000' }, longQuantity: 0, shortQuantity: 4 },
      { instrument: { assetType: 'OPTION', symbol: 'NDXP  261012C30650000' }, longQuantity: 3, shortQuantity: 0 },
    ] } };
    const backing = { C30640: 'short', C30650: 'short' };   // C30650 wrong, P30640 missing
    const r = BR.seedLedgerFromAccount(backing, details, '2026-10-12');
    ok(backing.P30640 === 'long', 'a leg the account holds and the ledger lacked is added');
    ok(backing.C30650 === 'long', 'a leg the ledger had on the wrong side is set to the account\'s side');
    ok(r.added.length === 1 && r.added[0].leg === 'P30640', `reported as added (${JSON.stringify(r.added)})`);
    ok(r.corrected.length === 1 && r.corrected[0].leg === 'C30650' && r.corrected[0].engine === 'short',
      `reported as corrected (${JSON.stringify(r.corrected)})`);
    const again = BR.seedLedgerFromAccount(backing, details, '2026-10-12');
    ok(!again.added.length && !again.corrected.length, 'an agreeing ledger reports nothing');
  }

  // ── 3 + 4. THE FILLED ORDER, LITERALLY, AND THE UI SHOWS IT ─────────────────────────────────────────
  {
    // The 14:25 bear: open DEBIT buy P30660 / sell P30650 @ 4.95; cover CREDIT sell P30650 / buy P30640 @ 4.95.
    const pos = { id: 'pos-1791829509740-1733', side: 'bear', legs: [leg('long', 'P', 30660), leg('short', 'P', 30650)],
      quantity: 1, limit: 4.9, shortStrike: 30650, filled: false, covered: false, orderId: 'O1', sentNet: 'DEBIT',
      sentLimit: 4.9, sentLegs: [leg('long', 'P', 30660), leg('short', 'P', 30650)], openTime: '10/12 14:25', openEpoch: 1791829500000 };
    const st = { positions: [pos], realizedPnl: 0, cashDeployed: 0, peakCashDeployed: 0, lastCandleTime: '10/12 14:45', lastCandleEpoch: 1791830700000,
      liveOrders: [{ orderId: 'O1', kind: 'open', net: 'NET_DEBIT', status: 'filled', fillPrice: 4.95, fillSide: 'DEBIT',
        legs: [leg('long', 'P', 30660), leg('short', 'P', 30650)] }] };
    const deps = { fillSource: 'broker' };
    trader.applyBrokerFills(st, cfg, deps, []);
    ok(pos.openOrder && pos.openOrder.orderId === 'O1' && pos.openOrder.net === 'DEBIT' && pos.openOrder.price === 4.95
      && has(pos.openOrder.legs, 'long', 'P', 30660), `the open's filled order is on the position (${JSON.stringify(pos.openOrder)})`);
    // the cover rests as the credit put twin; booked debit-canonical as calls
    pos.pendingCover = { legs: [leg('short', 'C', 30650), leg('long', 'C', 30640)], target: 5.05, sentNet: 'CREDIT', sentCredit: 4.95,
      sentLegs: [leg('short', 'P', 30650), leg('long', 'P', 30640)], orderId: 'O2', geometry: 'tent' };
    st.liveOrders.push({ orderId: 'O2', kind: 'cover-rest', positionId: pos.id, net: 'NET_CREDIT', status: 'filled', fillPrice: 4.95,
      fillSide: 'CREDIT', legs: [leg('short', 'P', 30650), leg('long', 'P', 30640)] });
    trader.applyBrokerFills(st, cfg, deps, []);
    ok(pos.covered && pos.coverOrder && pos.coverOrder.net === 'CREDIT' && pos.coverOrder.price === 4.95
      && has(pos.coverOrder.legs, 'long', 'P', 30640), `the cover's filled order is on the position (${JSON.stringify(pos.coverOrder)})`);
    ok(has(pos.coverSentLegs, 'long', 'P', 30640), 'and the sent legs are kept beside the canonical booking');

    const out = SP.strategyRunToOptionArray({ config: cfg, state: st, events: [] });
    const row = out.positions[0];
    ok(row.openLegs === '-1p30650 +1p30660' && row.openNet === 'DEBIT' && row.openLimit === 4.95, `open row = Schwab's order (${row.openLegs} ${row.openNet} ${row.openLimit})`);
    ok(row.coverLegs === '+1p30640 -1p30650' && row.coverNet === 'CREDIT' && row.coverLimit === 4.95,
      `cover row = Schwab's order: puts, credit, 4.95 (${row.coverLegs} ${row.coverNet} ${row.coverLimit})`);
    ok(/1p30640@-495/.test(out.optionArrayString), `the risk-curve string carries the real put legs and credit (${out.optionArrayString})`);

    // the engine's leg book used for the account comparison reads the same orders
    const eng = BR.engineLegs({ config: cfg, state: st });
    ok(eng.get('P30640') === 1 && eng.get('P30650') === -2 && !eng.get('C30640'), `engine legs = the account's (${JSON.stringify([...eng])})`);
  }

  // ── 5. THE BANNER ───────────────────────────────────────────────────────────────────────────────────
  {
    const now = Date.parse('2026-10-12T19:26:00Z');
    const live = (state) => ({ config: { dryRun: false }, state });
    ok(DB.divergenceAlerts(live({ positions: [{ filled: true, covered: false }] }), now).length === 0,
      'an uncovered position alone is not an alert');
    const rej = { 'cover:pos-1992': { count: 11, lastReason: 'The order is not an opening transaction.', lastAt: '2026-10-12T19:25:11Z', kind: 'cover-rest' } };
    const a = DB.divergenceAlerts(live({ rejectStreaks: rej }), now);
    ok(a.length === 1 && /REJECTED COVER-REST ×11/.test(a[0]) && /opening transaction/.test(a[0]), `repeated rejection alerts (${a[0]})`);
    ok(DB.divergenceAlerts(live({ rejectStreaks: rej }), now + 11 * 60000).length === 0, 'a streak that stopped 10+ minutes ago does not');
    ok(DB.divergenceAlerts(live({ rejectStreaks: { 'cover:x': { count: 2, lastAt: '2026-10-12T19:25:11Z' } } }), now).length === 0, 'two rejections do not');
    const div = DB.divergenceAlerts(live({ positionReconcile: { severity: 'DIVERGENT', diffs: 2, byKind: { unmanaged: 2 } } }), now);
    ok(div.length === 1 && /ENGINE ≠ SCHWAB ACCOUNT/.test(div[0]), `account divergence alerts (${div[0]})`);
    ok(DB.divergenceAlerts({ config: { dryRun: true }, state: { rejectStreaks: rej, positionReconcile: { severity: 'DIVERGENT', diffs: 2 } } }, now).length === 0,
      'a simulated run never alerts');
    const fresh = { severity: 'DIVERGENT', diffs: 1, byKind: { 'missing-cover': 1 }, at: '2026-10-12T19:25:40Z' };
    ok(DB.divergenceAlerts(live({ bookReconcile: fresh }), now).length === 0, 'a fill landing between two passes (<60s) does not');
    ok(DB.divergenceAlerts(live({ bookReconcile: fresh }), now + 60000).length === 1, 'the same disagreement persisting does');
    const st = DB.alertsFromStatus({ runs: [{ variant: 'v7-10', mode: 'live', rejectStreaks: rej }, { variant: 'v4-10', mode: 'simulate', rejectStreaks: rej }] }, now);
    ok(st.length === 1 && /^v7-10: /.test(st[0]), `the status feed alerts for live runs only, labelled (${st})`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
