'use strict';
// WINGS PRICE OFF THE MID, NEVER THE ASK (2026-10-09, user: "paying the ask for anything invalidates the
// assumptions"). Live wings paid the ask on longs / took the bid on shorts — on 0DTE NDX about 2x a structure's
// mid — while every wing result came from a backtest pricing mid ± $0.25 per leg. A chain quoted $3 wide on every
// strike makes the difference unmistakable: the order must go at mid + slip, nowhere near the ask side.
//
// Run: node server/tests/unit/candle-spread-wing-mid-pricing.test.js
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
process.env.CANDLE_SPREAD_RUNS_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'wp-'));
const T = require('../../src/candle-spread/trader');
const bs = require('../../src/candle-spread/bs-pricer');
const S = 30900, nowMs = Date.parse('2026-10-09T17:00:00Z');
const tau = bs.tauFromTime(nowMs), iv = 0.2;
const getLeg = (type, k) => { const mid = Math.max(0.05, bs.bsPrice(type, S, k, tau, iv)); return { mid, bid: Math.max(0, mid - 1.5), ask: mid + 1.5, symbol: `X${type}${k}` }; };
// a covered bull call 30880/30890 tent + an uncovered one: a peak to bank
const st = { positions: [
  { id: 'p1', filled: true, side: 'bull', legs: [{ side: 'long', type: 'C', strike: 30880 }, { side: 'short', type: 'C', strike: 30890 }], limit: 5, quantity: 1,
    covered: true, coverLegs: [{ side: 'short', type: 'P', strike: 30890 }, { side: 'long', type: 'P', strike: 30900 }], coverLimit: 3 },
  { id: 'p2', filled: true, side: 'bull', legs: [{ side: 'long', type: 'C', strike: 30890 }, { side: 'short', type: 'C', strike: 30900 }], limit: 5, quantity: 1, covered: false },
] };
const sent = [];
const deps = { underlying: S, nowMs, A: { '15m': { bbupper: S * 1.004, bblower: S * 0.996, close: S } }, getLeg, wingConvert: true,
  wingMinRatio: 0.5, wingBudgetFrac: 1, wingNaked: true,
  placeOrder: async (payload, meta) => { sent.push(meta); return { orderId: 'o' + sent.length }; } };
const cfg = { tickIncrement: 0.05, strikeIncrement: 10, quantity: 1, spreadWidth: 10 };
(async () => {
  const decisions = [];
  const n = await T.convertWings(st, cfg, deps, decisions, '10/09 13:00');
  ok(n >= 1 && sent.length >= 1, `the fixture places a wing (${n})`);
  for (const m of sent) {
    let mid = 0, ask = 0, legs = 0;
    for (const l of m.legs) { const q = getLeg(l.type, l.strike); mid += (l.side === 'long' ? 1 : -1) * q.mid; ask += l.side === 'long' ? q.ask : -q.bid; legs++; }
    const expect = Math.ceil((mid + 0.25 * legs) / 0.05 - 1e-9) * 0.05;
    ok(Math.abs(m.limit - expect) < 1e-6, `limit = mid + $0.25/leg, tick-rounded (${m.limit} vs ${expect.toFixed(2)})`);
    ok(m.limit < ask - 1, `nowhere near the ask side (${m.limit} vs ask-side ${ask.toFixed(2)})`);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
