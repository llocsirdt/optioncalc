// End-to-end state-machine test for processCandleClose (fake candles + fake chain).
// Run: node tests/nogit/candle-spread-engine.test.js
const os = require('os');
const path = require('path');
const fs = require('fs');

// Isolate the store's runs dir to a temp dir for the test. This MUST be set before
// requiring the store, because store-internal reads/writes bind RUNS_DIR at load time
// (monkey-patching the exported runFilePath does NOT affect those internal calls, which
// previously let a real run file accumulate positions across test runs).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-test-'));
process.env.CANDLE_SPREAD_RUNS_DIR = tmp;
const store = require('../../src/candle-spread/store');

const trader = require('../../src/candle-spread/trader');

let pass = 0, fail = 0;
function ok(cond, label) { if (cond) pass++; else { fail++; console.log('FAIL:', label); } }

// Fake chain: mids chosen so a 20-wide spread marks well under the 10.5 cap.
// Every strike/type returns a mid such that (longMid - shortMid) ~ 8.00 for a 20 spread.
function fakeGetLeg(type, strike) {
  // price a call/put by distance; just needs to yield a plausible net-debit ~8 for width 20.
  // Give long leg ~ +8 more than short leg.
  return { mid: 100 - (strike % 1000) * 0.001, symbol: `NDX_${type}${strike}` , bid: 1, ask: 1.1 };
}
// Simpler: deterministic mids so long-short = 8.00 exactly for adjacent-by-20 strikes.
// Deterministic mids: a 20-wide spread marks 8.00 exactly, and the chain obeys the arbitrage invariant
// the engine now checks (call mids fall as the strike rises, put mids rise).
//
// The previous version mixed an explicit lookup table with a generic fallback on a DIFFERENT SCALE —
// P28260 was 22.0 from the table while its neighbour P28270 came out at 2.70 from the formula — so every
// leg sat in a wildly non-monotonic neighbourhood. That is a fixture artifact, not a market: real chains
// managed 0 violations in 94,656 adjacent pairs across five healthy hours of 2026-09-16, and the one hour
// that did violate it produced every bad fill of that session.
//
// Slope 0.4/point gives exactly 8.00 across 20 strikes. The intercept is deliberately far above any mid a
// real 0DTE leg carries: a small one would floor out, and once two adjacent strikes both sit ON the floor
// the SPREAD marks 0.00 and nothing fills — which is what broke the split-series cases below, whose
// underlying (28673) is ~400 points off this anchor. Only the difference between legs is asserted, so the
// intercept is free, and a large one keeps every strike these tests touch inside the linear region.
function getLeg(type, strike) {
  const d = (strike - 28280) * 0.4;
  const mid = type === 'C' ? 400 - d : 400 + d;
  return { mid: Math.round(mid * 100) / 100, symbol: `NDX ${type}${strike}`, bid: 1, ask: 1.1 };
}

const cfg = {
  symbol: 'NDX', expiration: '2026-08-11', spreadWidth: 20, strikeIncrement: 10,
  quantity: 1, tickIncrement: 0.05, coverTiming: 'on-reversal', coverStyle: 'debit-offset', dryRun: true
};
const record = store.initRun(cfg, '2026-08-11');

const orders = [];
const placeOrder = (payload, meta) => { orders.push({ payload, meta }); return { status: 'dry-run-assumed-fill', filled: true }; };
const deps = { getLeg, placeOrder, dryRun: true };

// processCandleClose is async (it may await a real order send), so the sequential state-machine
// assertions run inside an async IIFE.
(async () => {
// Candle 1 (first of day): green, close 28273 -> center 28270 -> bull call 28260/28280.
// pass prior=null (first candle) with bands allowing it (close below upper band).
const c1 = { timeEST: '08/11 09:30', open: 28250, high: 28280, low: 28245, close: 28273,
  indicators: { bollinger20_2: { upper: 28400, lower: 28100, middle: 28250 } } };
await trader.processCandleClose(record, c1, null, deps);
ok(record.state.direction === 'bull', 'C1 opened bull, direction=bull');
ok(record.state.positions.length === 1 && record.state.positions[0].filled, 'C1 one filled position');
ok(record.state.positions[0].shortStrike === 28280, 'C1 short strike 28280');
ok(Math.abs(record.state.positions[0].limit - 8.0) < 0.6, `C1 open limit ~ net mid (got ${record.state.positions[0].limit})`);

// Candle 2: green again (strict: close>open AND high>prior high) -> stack a 2nd bull.
const c2 = { timeEST: '08/11 09:45', open: 28275, high: 28300, low: 28270, close: 28288 };
await trader.processCandleClose(record, c2, c1, deps);
ok(record.state.positions.filter(p => p.filled && !p.covered).length === 2, 'C2 stacked -> 2 uncovered bulls');
ok(record.state.direction === 'bull', 'C2 still bull');

// Candle 3: red simple (close<open) AND broke prior low -> cover BOTH bulls + open a bear.
const c3 = { timeEST: '08/11 10:00', open: 28288, high: 28290, low: 28250, close: 28262 };
await trader.processCandleClose(record, c3, c2, deps);
const covered = record.state.positions.filter(p => p.covered).length;
ok(covered === 2, `C3 covered both bulls (got ${covered})`);
ok(record.state.direction === 'bear', 'C3 flipped to bear (opened a new bear)');
ok(record.state.positions.some(p => p.side === 'bear' && p.filled && !p.covered), 'C3 has a new uncovered bear');
ok(typeof record.state.realizedPnl === 'number', 'realizedPnl tracked (number)');

// Candle 4: green but did NOT break prior high -> neutral for OPEN, but simple-bull opposite
// our bear direction -> cover the bear; direction -> none; no new open.
const c4 = { timeEST: '08/11 10:15', open: 28262, high: 28270, low: 28260, close: 28268 };
await trader.processCandleClose(record, c4, c3, deps);
ok(record.state.positions.filter(p => p.side === 'bear' && p.covered).length === 1, 'C4 covered the bear');
ok(record.state.direction === 'none', 'C4 cover-only -> direction none');

// --- signal/pricing split: signal candle (NQ) drives direction; deps.underlying (NDX) drives strikes ---
const splitCfg = { ...cfg, variant: 'split', signalSymbol: '/NQ' };
const splitRec = store.initRun(splitCfg, '2026-08-11');
const splitOrders = [];
const splitPlace = (payload, meta) => { splitOrders.push({ payload, meta }); return { status: 'dry', filled: true }; };
// First candle: green NQ signal (close 28773) but price the strikes off an NDX underlying 100 pts lower.
const sig1 = { timeEST: '08/11 09:30', open: 28750, high: 28780, low: 28745, close: 28773,
  indicators: { bollinger20_2: { upper: 29000, lower: 28500, middle: 28750 } } };
await trader.processCandleClose(splitRec, sig1, null, { getLeg, placeOrder: splitPlace, dryRun: true, underlying: 28673, signalSymbol: '/NQ', priceSymbol: 'NDX' });
const splitPos = splitRec.state.positions[0];
ok(splitRec.state.direction === 'bull', 'split: NQ green signal -> bull');
// strikes centered on the NDX underlying (28673 -> center 28670 -> short 28680), NOT the NQ close (28773).
ok(splitPos && splitPos.shortStrike === 28680, `split: strikes off NDX underlying not NQ close (got ${splitPos && splitPos.shortStrike})`);
const ev = splitRec.events.find(e => e.type === 'candle_close');
ok(ev && ev.underlying === 28673 && ev.candle.close === 28773 && ev.signalSymbol === '/NQ', 'split: event logs both NQ signal close and NDX underlying');

console.log(`\norders placed (dry-run): ${orders.length}`);
console.log(`${pass} passed, ${fail} failed`);
// cleanup
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
process.exit(fail ? 1 : 0);
})();
