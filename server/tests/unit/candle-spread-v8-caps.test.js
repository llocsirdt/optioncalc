'use strict';
// v8 risk-cap tests: (A) the hard cap blocks opens once uncovered debit would breach it; (B) a
// leader that marks deep-ITM gets a proactive resting cover (which then locks). Uses per-bar getLeg
// so a position can move from cheap to deep-ITM between bars.
//
// Run: node server/tests/nogit/candle-spread-v8-caps.test.js
const os = require('os'), path = require('path'), fs = require('fs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-v8-'));
process.env.CANDLE_SPREAD_RUNS_DIR = tmp;
const store = require('../../src/candle-spread/store');
const trader = require('../../src/candle-spread/trader');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const placeOrder = async () => ({ status: 'sim', filled: true });
const A = { '5m': { close: 22000, open: 22000, high: 22005, low: 21995 }, '15m': { close: 22000 } };
const base = { symbol: 'NDX', expiration: '2026-08-30', spreadWidth: 20, strikeIncrement: 10, quantity: 1, tickIncrement: 0.05, coverSelector: 'fixed-mark', coverFillModel: 'resting', captureChain: false };

let seq = 0;
async function bar(record, decision, getLeg, deps = {}) {
  const candle = { timeEST: `08/30 ${10 + seq++}:00`, open: 22000, high: 22010, low: 21990, close: 22001 };
  await trader.processCandleClose(record, candle, null, {
    getLeg, placeOrder, signalFn: () => decision, A, priorA: null,
    underlying: 22000, isFifteen: true, ...deps
  });
}

// Cheap chain: bull spread (long C21990 / short C22010) marks ~8; deep chain: marks ~18.
const cheapCall = { C21990: 30, C22010: 22 };
const deepCall = { C21990: 19, C22010: 1 };
const put = strike => Math.max(0.5, (strike - 22000) * 0.5); // for cover tent legs
const mkGetLeg = calls => (type, strike) => {
  const mid = type === 'C' ? (calls[`C${strike}`] != null ? calls[`C${strike}`] : Math.max(0.5, (22050 - strike) * 0.4)) : put(strike);
  return { mid, symbol: `NDX_${type}${strike}`, bid: mid - 0.05, ask: mid + 0.05 };
};

(async () => {
  // --- Scenario A: hard cap blocks the 3rd open (2 x $8 debit = $1600 hits the $1600 cap) ---
  const recA = store.initRun({ ...base, variant: 'v8cap', hardCap: 1600 }, '2026-08-30');
  const capDeps = { hardCap: 1600 };
  await bar(recA, { openSide: 'bull' }, mkGetLeg(cheapCall), capDeps);
  await bar(recA, { openSide: 'bull' }, mkGetLeg(cheapCall), capDeps);
  await bar(recA, { openSide: 'bull' }, mkGetLeg(cheapCall), capDeps);
  const opensA = recA.state.positions.length;
  const capped = recA.events.some(e => (e.decisions || []).some(d => d.action === 'open-skip-cap'));
  ok(opensA === 2, `A: hard cap held opens to 2 (got ${opensA})`);
  ok(capped, 'A: 3rd open logged open-skip-cap');

  // --- Scenario B: a leader that marks deep-ITM gets a proactive cover that locks ---
  seq = 0;
  const recB = store.initRun({ ...base, variant: 'v8pro', proactiveCoverFrac: 0.70 }, '2026-08-30');
  const proDeps = { proactiveCoverFrac: 0.70 };
  await bar(recB, { openSide: 'bull' }, mkGetLeg(cheapCall), proDeps);   // open a bull (marks ~8)
  ok(recB.state.positions.length === 1 && !recB.state.positions[0].covered, 'B: opened a bull, not yet covered');
  await bar(recB, { openSide: null }, mkGetLeg(deepCall), proDeps);      // now marks ~18 (>=0.7*20=14)
  const pos = recB.state.positions[0];
  ok(pos.covered, 'B: deep-ITM leader was proactively covered (locked)');
  const proEv = recB.events.some(e => (e.decisions || []).some(d => d.note === 'proactive-deep-itm'));
  ok(proEv, 'B: logged a proactive-deep-itm cover');

  console.log(`\n${pass} passed, ${fail} failed`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 1 : 0);
})();
