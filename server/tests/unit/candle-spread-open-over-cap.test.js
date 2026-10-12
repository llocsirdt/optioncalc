'use strict';
// OVER-CAP OPENS REST AT THE CAP (cfg.openOverCapBelow, 2026-10-12). User: an order whose mark is over the cap is
// still placed — at the cap, or below it and walked up to it — never "no action". Pins both engines: off by default
// (the historical decline), and on, the CHEAPEST placement rests at cap - below.
//
// Run: node server/tests/unit/candle-spread-open-over-cap.test.js
process.env.CANDLE_SPREAD_RUNS_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'cs-oc-'));
const trader = require('../../src/candle-spread/trader');
const { makeAdaptiveGeo, makeGeo } = require('../../src/candle-spread/backtest/backtest-width');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

// A dear chain: every 10-wide put spread near 30,690 marks $6.00 (cap $5.50), monotonic, and at PARITY — the call
// spread at the same strikes marks W - 6 = $4.00, so the credit twin passes the engine's parity check.
const getLeg = (type, k) => {
  const mid = type === 'P' ? Math.max(0.5, 40 + (k - 30690) * 0.6) : Math.max(0.5, 40 - (k - 30690) * 0.4);
  return { mid, symbol: `NDX_${type}${k}`, bid: mid - 0.1, ask: mid + 0.1 };
};
const cfg = { symbol: 'NDX', spreadWidth: 10, strikeIncrement: 10, tickIncrement: 0.05, quantity: 1, capFrac: 0.55, openWalkCapFrac: 0.55, maxItmStrikes: 3 };
const off = trader.buildOpenAdaptive('bear', 30690, cfg, getLeg);
ok(off.declined === true, `off: declined as before (${off.reason})`);
const on = trader.buildOpenAdaptive('bear', 30690, { ...cfg, openOverCapBelow: 0.10 }, getLeg);
ok(!on.declined && on.overCap === true, 'on: placed instead of declined');
ok(on.limit === 5.4 && on.cap === 5.5, `on: rests at cap - $0.10 = 5.40, walks to 5.50 (limit ${on.limit}, cap ${on.cap})`);
ok(on.mark > 5.5, `the mark is still over the cap (${on.mark}) — it fills only if the market comes to it`);
const atCap = trader.buildOpenAdaptive('bear', 30690, { ...cfg, openOverCapBelow: 0 }, getLeg);
ok(atCap.limit === 5.5, `below 0 = rest AT the cap (${atCap.limit})`);
ok(trader.buildOpen('bear', 30690, { ...cfg, openOverCapBelow: 0.10 }, getLeg).limit === 5.4, 'fixed geometry: same rule');
const fits = trader.buildOpenAdaptive('bear', 30690, { ...cfg, capFrac: 0.65, openWalkCapFrac: 0.65, openOverCapBelow: 0.10 }, getLeg);
ok(!fits.overCap, 'a placement under the cap is taken normally (the rule only applies when nothing fits)');

// Backtest geometry: same contract.
const S = 30690, tau = 0.5 / 365, iv = 0.6;   // a high IV makes every placement dear
const geoOff = makeAdaptiveGeo({ width: 10, maxDebitFrac: 0.30 }).buildOpen('bear', S, tau, iv);
ok(geoOff.skip === true, 'backtest adaptive, off: skip');
const geoOn = makeAdaptiveGeo({ width: 10, maxDebitFrac: 0.30, overCapBelow: 0.10 }).buildOpen('bear', S, tau, iv);
ok(!geoOn.skip && geoOn.overCap && geoOn.limit === 2.9 && geoOn.legs.length === 2, `backtest adaptive, on: rests at 2.90 (${geoOn.limit})`);
const fixOn = makeGeo({ width: 10, capFrac: 0.30, overCapBelow: 0 }).buildOpen('bear', S, tau, iv);
ok(!fixOn.skip && fixOn.limit === 3, `backtest fixed, on: rests at the cap (${fixOn.limit})`);

// ── CREDIT TWIN (the user, 2026-10-12: credit spreads must be handled as carefully as debits). Live often SENDS
// the parity twin: a bear put debit at D is sent as the bear call credit at W - D. Over the cap, the debit rests
// at 5.40 (under the 5.50 cap), so the credit must ASK 4.60 (more credit = cheaper position = further from the
// market), and walking the debit UP to 5.50 must walk the ask DOWN to 4.50 — never past W - cap.
(async () => {
  const W = 10;
  const credit = trader.buildCreditOpenOrder('bear', on.lower, on.upper, { ...cfg, openOverCapBelow: 0.10 }, getLeg, on.mark, on.limit);
  ok(!credit.error, `the credit twin builds (${credit.error || 'ok'})`);
  ok(credit.limit === 4.6 && credit.payload.orderType === 'NET_CREDIT' && credit.payload.price === 4.6,
    `asks W - 5.40 = 4.60 credit (${credit.limit}, ${credit.payload.orderType} ${credit.payload.price})`);
  ok(credit.legs.every((l) => l.type === 'C') && credit.legs.find((l) => l.side === 'short').strike === on.lower,
    'bear twin = sell the lower call, buy the upper call');
  ok(W - on.mark < credit.limit, `the market credit (${(W - on.mark).toFixed(2)}) is under our ask — it rests, as the debit does`);

  // Walk it: a resting credit-sent open, placed long enough ago that the ladder has earned every step.
  const replaced = [];
  const pos = { id: 'pos-oc-1', side: 'bear', legs: [{ side: 'long', type: 'P', strike: on.upper }, { side: 'short', type: 'P', strike: on.lower }],
    sentLegs: credit.legs, quantity: 1, shortStrike: on.lower, cap: on.cap, limit: on.limit, ladderBase: on.limit,
    sentNet: 'CREDIT', sentLimit: credit.limit, orderStatus: 'sent', filled: false, covered: false, orderId: 'o-1',
    placedEpoch: 0, placedUnder: 30690, openedAt: '2026-10-12T17:00:00Z' };
  const st = { positions: [pos], pendingOpenId: pos.id, realizedPnl: 0, cashDeployed: 0, peakCashDeployed: 0, liveOrders: [] };
  const deps = { getLeg, openLadder: true, ladderStepDollars: 0.05, ladderStepSeconds: 120, ladderStepPoints: 10,
    nowMs: 60 * 60 * 1000, underlying: 30690, fillSource: 'broker',
    replaceOrder: async (id, payload, meta) => { replaced.push({ payload, meta }); return { status: 'replaced', orderId: 'o-' + (replaced.length + 1) }; } };
  const d = [];
  await trader.resolvePendingOpen(st, { ...cfg, openOverCapBelow: 0.10 }, deps, d);
  const rp = d.find((x) => x.action === 'open-reprice');
  ok(rp && rp.to === 5.5 && rp.sentTo === 4.5, `debit walks to the 5.50 cap, the credit ask to 4.50 (${rp && rp.to} / ${rp && rp.sentTo})`);
  ok(replaced.length === 1 && replaced[0].payload.orderType === 'NET_CREDIT' && replaced[0].payload.price === 4.5,
    `the broker gets NET_CREDIT 4.50 (${replaced[0] && replaced[0].payload.orderType} ${replaced[0] && replaced[0].payload.price})`);
  ok(pos.limit === 5.5 && pos.sentLimit === 4.5 && round(pos.limit + pos.sentLimit) === W, 'the record keeps limit + sentLimit = W');
  const d2 = [];
  deps.nowMs += 60 * 60 * 1000;
  await trader.resolvePendingOpen(st, { ...cfg, openOverCapBelow: 0.10 }, deps, d2);
  ok(!d2.some((x) => x.action === 'open-reprice') && pos.limit === 5.5 && pos.sentLimit === 4.5,
    'and never past the cap: the credit is never asked below W - cap');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
function round(x) { return Math.round(x * 100) / 100; }
