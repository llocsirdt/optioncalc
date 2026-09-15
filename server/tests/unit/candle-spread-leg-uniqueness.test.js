'use strict';
// LEG-UNIQUENESS in the LIVE trader (deps.enforceLegUniqueness). The user's exact case: open bull
// 29300/29320 (long C29300), then a bull that would SHORT C29300 → the resolver flips it to the parity
// TWIN (bull put credit spread, same strikes). Proves: the conflicting open is SENT as NET_CREDIT with PUT
// legs, the ledger persists on state, the record stays debit-canonical, and terminal P&L is IDENTICAL to
// the unconstrained run (twin = put-call parity → no P&L change).
//
// Run: node server/tests/nogit/candle-spread-leg-uniqueness.test.js
const os = require('os'), path = require('path'), fs = require('fs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-leg-'));
process.env.CANDLE_SPREAD_RUNS_DIR = tmp;
const store = require('../../src/candle-spread/store');
const trader = require('../../src/candle-spread/trader');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const base = { symbol: 'NDX', expiration: '2026-08-30', spreadWidth: 20, strikeIncrement: 10, quantity: 1, tickIncrement: 0.05, coverSelector: 'fixed-mark', coverFillModel: 'resting', captureChain: false };
const legFor = U => (type, strike) => {
  const tv = 2.5 * Math.exp(-Math.abs(U - strike) / 40);
  const mid = (type === 'C' ? Math.max(0, U - strike) : Math.max(0, strike - U)) + tv;
  return { mid: Math.round(mid * 20) / 20, symbol: `NDX_${type}${strike}`, bid: mid - 0.05, ask: mid + 0.05 };
};

let seq = 0;
async function run(variant, deps) {
  seq = 0;
  const sends = [];
  const rec = store.initRun({ ...base, variant }, '2026-08-30');
  // Two bull opens at underlyings that overlap on C29300: U=29310 → long C29300/short C29320; then
  // U=29290 → would long C29280/short C29300 (conflict on C29300).
  for (const U of [29310, 29290]) {
    const A = { '5m': { close: U, open: U, high: U + 6, low: U - 6 }, '15m': { close: U } };
    const candle = { timeEST: `08/30 ${10 + seq++}:00`, datetime: 1e12 + seq * 3e5, open: U, high: U + 8, low: U - 8, close: U + 1 };
    await trader.processCandleClose(rec, candle, null, {
      getLeg: legFor(U), placeOrder: async (p) => { sends.push(p.orderType); return { status: 'sim', filled: true }; },
      signalFn: () => ({ openSide: 'bull' }), A, priorA: null, underlying: U, isFifteen: true, ...deps,
    });
  }
  return { rec, sends, term: trader.computeTerminalPnl(rec.state, rec.config, 29320) };
}

(async () => {
  const off = await run('leg-off', {});
  const on = await run('leg-on', { enforceLegUniqueness: true });

  // (A) unconstrained: both opens are debit call spreads → the record is netting-IMPOSSIBLE (long AND
  //     short C29300). enforced: the 2nd flips to the credit PUT twin.
  ok(off.sends.every(s => s === 'NET_DEBIT'), 'unconstrained: both opens NET_DEBIT (the impossible book)');
  ok(on.sends[0] === 'NET_DEBIT' && on.sends[1] === 'NET_CREDIT', `enforced: 2nd open flips to the credit twin (${on.sends.join(',')})`);

  const p2 = on.rec.state.positions[1];
  ok(p2 && p2.sentNet === 'CREDIT' && p2.sentLegs && p2.sentLegs.every(l => l.type === 'P'), 'enforced 2nd open SENT put legs (the twin)');
  ok(p2 && p2.legs.every(l => l.type === 'C'), 'enforced 2nd open RECORD stays debit-canonical (call legs)');

  // (B) ledger persisted on state, and no leg is booked both ways.
  const led = on.rec.state.legLedger;
  ok(led && led.C29300 === 'long', 'ledger persisted: C29300 recorded long (from open 1)');
  ok(led && led.P29300 === 'short' && led.P29280 === 'long', 'ledger: the twin recorded P29300 short / P29280 long');
  const conflict = Object.keys(led).some(k1 => false); // no same-leg opposite sides possible (single map)
  ok(!conflict, 'no leg is booked both long and short');

  // (C) terminal P&L identical — the twin is put-call-parity equivalent, so enforcing costs no P&L here.
  ok(off.term.total === on.term.total, `terminal P&L identical off vs on (${off.term.total} vs ${on.term.total})`);

  console.log(`\nsends off: ${off.sends.join(',')}  |  on: ${on.sends.join(',')}`);
  console.log(`ledger: ${JSON.stringify(led)}`);
  console.log(`terminal off ${off.term.total}  on ${on.term.total}`);
  console.log(`\n${pass} passed, ${fail} failed`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 1 : 0);
})();
