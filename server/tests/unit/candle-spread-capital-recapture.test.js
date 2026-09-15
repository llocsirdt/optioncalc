'use strict';
// CAPITAL RECAPTURE (deps.capitalRecapture) in the LIVE trader — phase 1, open alternation. Proves:
//  (A) with recap ON, every openAlternateEvery-th block of opens is SENT as a NET_CREDIT order (the
//      parity twin), the rest NET_DEBIT — while the position RECORD stays debit-canonical;
//  (B) the signed cash ledger (peakCashDeployed) is LOWER with recap on than all-debit;
//  (C) terminal settlement P&L is byte-IDENTICAL recap off vs on (parity — recap must not move P&L).
//
// Run: node server/tests/nogit/candle-spread-capital-recapture.test.js
const os = require('os'), path = require('path'), fs = require('fs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-recap-'));
process.env.CANDLE_SPREAD_RUNS_DIR = tmp;
const store = require('../../src/candle-spread/store');
const trader = require('../../src/candle-spread/trader');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const base = { symbol: 'NDX', expiration: '2026-08-30', spreadWidth: 20, strikeIncrement: 10, quantity: 1, tickIncrement: 0.05, coverSelector: 'fixed-mark', coverFillModel: 'resting', captureChain: false };

// Chain pricer: intrinsic + symmetric time value, so a bull call debit ≈ its bull put credit twin at ATM.
const legFor = U => (type, strike) => {
  const tv = 2.5 * Math.exp(-Math.abs(U - strike) / 25);
  const mid = (type === 'C' ? Math.max(0, U - strike) : Math.max(0, strike - U)) + tv;
  return { mid: Math.round(mid * 20) / 20, symbol: `NDX_${type}${strike}`, bid: mid - 0.05, ask: mid + 0.05 };
};
// Record the net of every placed order so we can see debit vs credit sends.
function recordingPlaceOrder(log) {
  return async (payload) => { log.push(payload.orderType); return { status: 'sim', filled: true }; };
}

let seq = 0;
async function run(variant, deps) {
  seq = 0;
  const sends = [];
  const rec = store.initRun({ ...base, variant }, '2026-08-30');
  const path = [22000, 22040, 22080, 22050, 22100, 22140, 22090, 22160, 22200, 22120]; // a wandering uptrend
  for (const U of path) {
    const A = { '5m': { close: U, open: U, high: U + 8, low: U - 8 }, '15m': { close: U } };
    const candle = { timeEST: `08/30 ${10 + seq++}:00`, open: U, high: U + 12, low: U - 12, close: U + 1 };
    await trader.processCandleClose(rec, candle, null, {
      getLeg: legFor(U), placeOrder: recordingPlaceOrder(sends), signalFn: () => ({ openSide: 'bull' }),
      A, priorA: null, underlying: U, isFifteen: true, ...deps
    });
  }
  const settle = 22120;
  const term = trader.computeTerminalPnl ? trader.computeTerminalPnl(rec.state, rec.config, settle) : null;
  return { rec, sends, peakCash: rec.state.peakCashDeployed || 0, term };
}

(async () => {
  const debit = await run('recap-off', {});                                     // all-debit baseline
  const recap = await run('recap-on', { capitalRecapture: true, openAlternateEvery: 3 });

  // (A) recap sends a mix of DEBIT and CREDIT; baseline is all DEBIT.
  const recapCredits = recap.sends.filter(s => s === 'NET_CREDIT').length;
  const recapDebits = recap.sends.filter(s => s === 'NET_DEBIT').length;
  ok(debit.sends.every(s => s === 'NET_DEBIT'), 'baseline sends are all NET_DEBIT');
  ok(recapCredits > 0 && recapDebits > 0, `recap sends a mix (debit ${recapDebits}, credit ${recapCredits})`);

  // (A2) the position RECORD stays debit-canonical (calls for a bull), even for credit-sent opens.
  const allCanonicalCalls = recap.rec.state.positions.every(p => p.legs.every(l => l.type === 'C'));
  ok(allCanonicalCalls, 'recap positions keep debit-canonical CALL legs (record unchanged)');
  const someCreditSent = recap.rec.state.positions.some(p => p.sentNet === 'CREDIT' && p.sentLegs && p.sentLegs.every(l => l.type === 'P'));
  ok(someCreditSent, 'credit-sent opens record their actual PUT legs in sentLegs');

  // (B) recap deploys LESS peak cash than all-debit.
  ok(recap.peakCash < debit.peakCash, `recap peak cash < all-debit (${recap.peakCash} < ${debit.peakCash})`);

  // (C) terminal P&L is byte-identical (parity — recap moves cash, not P&L).
  ok(debit.term && recap.term && debit.term.total === recap.term.total,
    `terminal P&L identical recap off vs on (${debit.term && debit.term.total} vs ${recap.term && recap.term.total})`);

  console.log(`\nsends       debit-only: ${debit.sends.length}x DEBIT`);
  console.log(`            recap:      ${recapDebits}x DEBIT + ${recapCredits}x CREDIT`);
  console.log(`peak cash   debit-only: $${debit.peakCash}   recap: $${recap.peakCash}`);
  console.log(`terminal    debit-only: $${debit.term && debit.term.total}   recap: $${recap.term && recap.term.total}`);

  // ---- PHASE 2: ITM-credit COVERS ----
  // Open a bull, ramp price deep ITM, then emit a cover signal. With recap the cover must be SENT as
  // NET_CREDIT, its floor booked debit-canonically (identical to recap-off), and cash reclaimed.
  async function coverRun(variant, deps) {
    seq = 0;
    const sends = [];
    const rec = store.initRun({ ...base, variant }, '2026-08-30');
    const script = [                                   // (price, signal)
      [22000, { openSide: 'bull' }], [22050, {}], [22120, {}], [22200, {}],   // open, ramp deep ITM
      [22240, { coverSide: 'bull' }], [22240, {}]                              // cover the winner, then settle-ready
    ];
    for (const [U, sig] of script) {
      const A = { '5m': { close: U, open: U, high: U + 8, low: U - 8 }, '15m': { close: U } };
      const candle = { timeEST: `08/30 ${10 + seq++}:00`, open: U, high: U + 12, low: U - 12, close: U + 1 };
      await trader.processCandleClose(rec, candle, null, {
        getLeg: legFor(U), placeOrder: recordingPlaceOrder(sends), signalFn: () => sig,
        A, priorA: null, underlying: U, isFifteen: true, ...deps
      });
    }
    return { rec, sends, term: trader.computeTerminalPnl(rec.state, rec.config, 22240), cash: rec.state.cashDeployed };
  }
  const cvDebit = await coverRun('cov-off', {});
  const cvRecap = await coverRun('cov-on', { capitalRecapture: true, creditCoverFrac: 0.65, openAlternateEvery: 99 }); // altEvery 99 → open stays debit; isolate the COVER
  const coverSentCredit = cvRecap.sends.filter(s => s === 'NET_CREDIT').length;
  const covPos = cvRecap.rec.state.positions[0];
  ok(coverSentCredit > 0, `phase2: ITM cover sent as NET_CREDIT (credits=${coverSentCredit})`);
  ok(covPos && covPos.covered && covPos.coverLegs.every(l => l.type === 'P'),
    'phase2: cover booked debit-canonical (PUT tent legs) despite credit send');
  ok(cvDebit.term.total === cvRecap.term.total, `phase2: terminal P&L identical (${cvDebit.term.total} vs ${cvRecap.term.total})`);
  ok(cvRecap.cash < cvDebit.cash, `phase2: credit cover reclaims cash vs debit (${cvRecap.cash} < ${cvDebit.cash})`);
  console.log(`\nphase2 cover  debit: ${cvDebit.sends.filter(s=>s==='NET_CREDIT').length} credit-sends, cash $${cvDebit.cash}, P&L $${cvDebit.term.total}`);
  console.log(`              recap: ${coverSentCredit} credit-sends, cash $${cvRecap.cash}, P&L $${cvRecap.term.total}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 1 : 0);
})();
