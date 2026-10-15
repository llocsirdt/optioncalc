'use strict';
// FUNDS GUARD (2026-10-14). Live v7-10 drew 50 "not enough available cash/buying power" rejections in an hour, each
// retried in the same form. Rules: assume only the risk max (lossMax) is available, send the credit twin when a
// debit would overrun it, and after a funds rejection send the other form.
//
// Run: node server/tests/unit/candle-spread-funds-guard.test.js
const FG = require('../../src/candle-spread/funds-guard');
const FR = require('../../src/candle-spread/floor-raise');
const OM = require('../../src/candle-spread/order-manager');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const REASON = 'You do not have enough available cash/buying power for this order.';

// ── reason matching ─────────────────────────────────────────────────────────────────────────────────
ok(FG.isFundsReject(REASON), 'the 10/14 Schwab text is a funds rejection');
ok(!FG.isFundsReject('The order is not an opening transaction'), 'the leg-direction rejection is not');
ok(!FG.isFundsReject(null), 'no reason is not');

// ── net spend: filled cash + working debits, never working credits ──────────────────────────────────
{
  const st = { cashDeployed: 1200, positions: [
    { filled: false, orderId: 'a', sentNet: 'DEBIT', sentLimit: 5.4, quantity: 1 },                 // working debit open
    { filled: false, orderId: 'b', sentNet: 'CREDIT', sentLimit: 4.6, quantity: 1 },                // working credit open
    { filled: false, orderId: 'c', expired: true, sentNet: 'DEBIT', sentLimit: 3 },                // dead
    { filled: false, orderId: 'd', raise: true, pendingHedge: { limit: 0.95 } },                   // working debit raise
    { filled: true, covered: false, pendingCover: { limit: 4 }, coverSentNet: 'DEBIT' },           // working debit cover
    { filled: true, covered: false, pendingCover: { limit: 5.9 }, coverSentNet: 'CREDIT' },        // working credit cover
  ] };
  ok(FG.netSpend(st) === 1200 + 540 + 95 + 400, `net spend counts working debits only (got ${FG.netSpend(st)})`);
  const cfg = { lossMax: 2000 };
  ok(FG.fundsBudget(cfg) === 2000, 'budget defaults to lossMax');
  ok(FG.fundsBudget({ lossMax: 2000, fundsBudget: 3000 }) === 3000, 'fundsBudget overrides');
  ok(FG.fundsBudget({ lossMax: 2000, fundsBudget: 0 }) === null, 'fundsBudget 0 turns the budget off');
  ok(!FG.debitFits(st, cfg, 540), '2,235 + 540 > 2,000: does not fit');
  ok(FG.debitFits({ cashDeployed: 500, positions: [] }, cfg, 540), '500 + 540 fits');
  const f = FG.fundsStyle(st, cfg, { key: 'open:slot', debitDollars: 540, wantCredit: false });
  ok(f && f.credit === true && f.why === 'funds-budget', 'an over-budget debit goes as credit');
  ok(FG.fundsStyle(st, cfg, { key: 'open:slot', debitDollars: 540, wantCredit: true }) === null, 'a credit is left alone');
  ok(FG.fundsStyle({ cashDeployed: 0, positions: [] }, cfg, { key: 'open:slot', debitDollars: 540, wantCredit: false }) === null,
    'a debit within budget is left alone');
}

// ── the flip after a funds rejection ────────────────────────────────────────────────────────────────
{
  const cfg = { lossMax: 2000 };
  const st = { cashDeployed: 0, positions: [], rejectStreaks: { 'cover:p1': { count: 1, lastReason: REASON, net: 'CREDIT' } } };
  const f = FG.fundsStyle(st, cfg, { key: 'cover:p1', debitDollars: 400, wantCredit: true });
  ok(f && f.credit === false && f.why === 'funds-reject', 'a rejected CREDIT cover is resent as DEBIT');
  st.rejectStreaks['cover:p1'] = { count: 2, lastReason: REASON, net: 'DEBIT' };
  ok(FG.fundsStyle(st, cfg, { key: 'cover:p1', debitDollars: 400, wantCredit: false }).credit === true, 'a rejected DEBIT cover is resent as CREDIT');
  st.rejectStreaks['cover:p1'] = { count: 1, lastReason: 'The order is not an opening transaction', net: 'DEBIT' };
  ok(FG.fundsStyle(st, cfg, { key: 'cover:p1', debitDollars: 400, wantCredit: false }) === null, 'other rejections are not funds flips');
  st.rejectStreaks['open:slot'] = { count: 1, lastReason: REASON };
  ok(FG.fundsStyle(st, cfg, { key: 'open:slot', debitDollars: 400, wantCredit: false }).credit === true, 'no recorded side: flips on an odd count');
}

// ── the reject streak keeps the refused side ────────────────────────────────────────────────────────
{
  const record = { state: {}, events: [] };
  OM.noteReject(record, 'cover:p1', REASON, { kind: 'cover-rest', price: 5.9, net: 'NET_CREDIT' });
  ok(record.state.rejectStreaks['cover:p1'].net === 'CREDIT', 'noteReject records the side as DEBIT/CREDIT');
}

// ── vertical twins: same payoff less the width ──────────────────────────────────────────────────────
{
  const bullCall = [{ side: 'long', type: 'C', strike: 30240 }, { side: 'short', type: 'C', strike: 30260 }];
  const bearPut = [{ side: 'long', type: 'P', strike: 30070 }, { side: 'short', type: 'P', strike: 30050 }];
  for (const legs of [bullCall, bearPut]) {
    const tw = FG.verticalTwin(legs);
    ok(tw && tw.offset === 20 && tw.legs[0].type !== legs[0].type, `twin of ${JSON.stringify(legs)}`);
    let same = true;
    for (let x = 29900; x <= 30400; x += 5) {
      if (Math.abs(FR.payoff(legs, x, 1) - FR.payoff(tw.legs, x, 1) - tw.offset * 100) > 1e-6) same = false;
    }
    ok(same, 'payoff(debit) = payoff(twin) + width at every settle');
  }
  ok(FG.verticalTwin([{ side: 'short', type: 'C', strike: 30240 }, { side: 'long', type: 'C', strike: 30260 }]) === null, 'a credit vertical has no credit twin');
  ok(FG.verticalTwin([{ side: 'long', type: 'C', strike: 30240 }, { side: 'short', type: 'P', strike: 30260 }]) === null, 'mixed types: none');
}

console.log(`funds guard: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
