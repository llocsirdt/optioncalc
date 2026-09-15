'use strict';
// Ported-signal ROUTING test: with a signalFn injected (v4-v9 mode), processCandleClose must route
// openSide -> open, coverSide -> cover ONLY that side (v7 per-side), honor bidirectional opens, and
// evolve direction the way backtest-v6-5m.runDay5m does. Signal PARITY (identical decisions on a
// given A) is proven separately; here we script the decisions and check the engine's plumbing.
//
// Run: node server/tests/nogit/candle-spread-ported-routing.test.js
const os = require('os'), path = require('path'), fs = require('fs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-route-'));
process.env.CANDLE_SPREAD_RUNS_DIR = tmp;
const store = require('../../src/candle-spread/store');
const trader = require('../../src/candle-spread/trader');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

// Deterministic chain around underlying 22000: opens mark ~8, tent covers mark ~8 (fill < target 12).
function getLeg(type, strike) {
  const call = Math.max(0.5, (22050 - strike) * 0.4);
  const put = Math.max(0.5, (strike - 21950) * 0.4);
  return { mid: type === 'C' ? call : put, symbol: `NDX_${type}${strike}`, bid: 1, ask: 1.1 };
}
const placeOrder = async () => ({ status: 'sim', filled: true });
const cfg = {
  symbol: 'NDX', variant: 'v6', expiration: '2026-08-30', spreadWidth: 20, strikeIncrement: 10,
  quantity: 1, tickIncrement: 0.05, coverSelector: 'fixed-mark', coverFillModel: 'resting', captureChain: false
};
const record = store.initRun(cfg, '2026-08-30');
const A = { '5m': { close: 22000, open: 22000, high: 22005, low: 21995 }, '15m': { close: 22000 } };

// Drive one ported bar with a scripted decision. Returns after resting covers resolve.
let seq = 0;
async function bar(decision, opts = {}) {
  const candle = { timeEST: `08/30 ${10 + seq}:00`, open: 22000, high: 22010, low: 21990, close: 22001 };
  seq++;
  await trader.processCandleClose(record, candle, { close: 22000 }, {
    getLeg, placeOrder, signalFn: () => decision, A, priorA: null,
    underlying: 22000, isFifteen: true, bidirectional: !!opts.bidirectional, signalCfg: {}
  });
}
const uncov = side => record.state.positions.filter(p => p.side === side && p.filled && !p.covered).length;
const cov = side => record.state.positions.filter(p => p.side === side && p.covered).length;

(async () => {
  await bar({ openSide: 'bull', cover: false });
  ok(uncov('bull') === 1 && record.state.direction === 'bull', 'B1 open bull -> 1 uncovered bull, dir=bull');

  await bar({ openSide: 'bull', cover: false });
  ok(uncov('bull') === 2 && record.state.direction === 'bull', 'B2 stack bull -> 2 uncovered bulls');

  // Bidirectional open of the OPPOSITE side while holding bulls (v7 "be wrong").
  await bar({ openSide: 'bear', cover: false }, { bidirectional: true });
  ok(uncov('bear') === 1, 'B3 bidirectional -> opened a bear while holding bulls');
  ok(uncov('bull') === 2, 'B3 bulls untouched');
  ok(record.state.direction === 'bear', 'B3 dir now bear');

  // Per-side cover: coverSide 'bull' covers ONLY the bulls; bear stays; dir stays bear (partial other-side).
  await bar({ openSide: null, coverSide: 'bull' });
  ok(cov('bull') === 2 && uncov('bull') === 0, 'B4 coverSide bull -> both bulls covered (resting filled)');
  ok(uncov('bear') === 1, 'B4 bear NOT covered (per-side)');
  ok(record.state.direction === 'bear', 'B4 dir stays bear (covered the non-held side)');

  // coverSide 'both' clears the remaining bear and resets stance to flat.
  await bar({ openSide: null, coverSide: 'both' });
  ok(cov('bear') === 1 && uncov('bear') === 0, 'B5 coverSide both -> bear covered');
  ok(record.state.direction === 'none', 'B5 dir reset to none');

  // Flip: cover held bull AND open bear in one bar (v6 trend-flip -> {openSide:bear, cover:true}).
  await bar({ openSide: 'bull', cover: false });        // establish a bull first
  ok(record.state.direction === 'bull', 'B6 re-open bull');
  await bar({ openSide: 'bear', cover: true });          // legacy cover:true = cover ALL, then flip
  ok(cov('bull') >= 1 && uncov('bull') === 0, 'B7 flip covered the bull');
  ok(uncov('bear') === 1 && record.state.direction === 'bear', 'B7 flip opened a fresh bear, dir=bear');

  console.log(`\n${pass} passed, ${fail} failed`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 1 : 0);
})();
