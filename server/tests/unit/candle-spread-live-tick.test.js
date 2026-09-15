'use strict';
// End-to-end offline replay of the LIVE 5m tick pipeline (Step 2b): raw 1m -> analysis-builder `A`
// -> v6 signalFn -> ported processCandleClose (seam) -> orders (dry) -> resting-cover fills ->
// terminal P/L + EOD summary. Uses a Black-Scholes chain (backtest pricer) as the getLeg so covers
// can fill. Proves the wired pipeline runs a full real day and produces coherent output; signal
// parity and routing are proven separately.
//
// Run: node server/tests/nogit/candle-spread-live-tick.test.js
const os = require('os'), path = require('path'), fs = require('fs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-tick-'));
process.env.CANDLE_SPREAD_RUNS_DIR = tmp;
const store = require('../../src/candle-spread/store');
const trader = require('../../src/candle-spread/trader');
const ab = require('../../src/candle-spread/analysis-builder');
const summary = require('../../src/candle-spread/summary');
const { v6Signal } = require('../../src/candle-spread/signals/v6-signals');
const eng = require('../../../scripts/candle-spread/backtest-v4'); // test-only: BS pricer for the chain

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

// Load all NDX raw 1m, build live-style 5m bars, take the day with the most bars.
const RAW1 = path.join(__dirname, '..', '..', '..', 'signal-lab-data', 'raw-1m');
function loadRaw1() {
  const files = fs.readdirSync(RAW1).filter(f => f.startsWith('NDX-') && f.endsWith('.json')).sort();
  let all = [];
  for (const f of files) all = all.concat(JSON.parse(fs.readFileSync(path.join(RAW1, f), 'utf8')).candles || []);
  const seen = new Set();
  all = all.filter(c => c.datetime != null && !seen.has(c.datetime) && seen.add(c.datetime));
  all.sort((a, b) => a.datetime - b.datetime);
  return all;
}
const etDay = ms => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const bars = ab.buildBars(loadRaw1(), 5);
const byDay = new Map();
for (const b of bars) { const d = etDay(b.datetime); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(b); }
const day = [...byDay.entries()].sort((a, b) => b[1].length - a[1].length)[0];
ok(day && day[1].length >= 20, `picked a full 5m day: ${day && day[0]} (${day && day[1].length} bars)`);
const dayBars = day[1];

// A Black-Scholes chain accessor for the current bar (so tent covers can mark/fill realistically).
function makeGetLeg(A, dt) {
  const c15 = A['15m'];
  const iv = eng.bs.ivFromRelBandWidth((c15.bbupper - c15.bblower) / c15.close);
  const tau = eng.bs.tauFromTime(dt);
  const U = A['5m'].close;
  return (type, strike) => {
    const mid = Math.max(0.05, Math.round(eng.bs.bsPrice(type, U, strike, tau, iv) / 0.05) * 0.05);
    return { mid, symbol: `NDX_${type}${strike}`, bid: mid - 0.05, ask: mid + 0.05 };
  };
}
const placeOrder = async () => ({ status: 'sim', filled: true });
const cfg = {
  symbol: 'NDX', variant: 'v6', variantLabel: '5m-harness', expiration: day[0], spreadWidth: 20,
  strikeIncrement: 10, quantity: 1, tickIncrement: 0.05, coverSelector: 'fixed-mark',
  coverFillModel: 'resting', captureChain: false
};
const record = store.initRun(cfg, day[0]);

(async () => {
  for (let i = 0; i < dayBars.length; i++) {
    const A = dayBars[i].analysis;
    const priorA = i > 0 ? dayBars[i - 1].analysis : null;    // null on first bar of day
    const dt = dayBars[i].datetime;
    const isFifteen = new Date(dt).getMinutes() % 15 === 0;
    const c5 = A['5m'];
    const candle = { timeEST: new Date(dt).toISOString(), open: c5.open, high: c5.high, low: c5.low, close: c5.close };
    await trader.processCandleClose(record, candle, null, {
      getLeg: makeGetLeg(A, dt), placeOrder, dryRun: true,
      signalFn: v6Signal, signalCfg: { fiveMin: true }, bidirectional: false,
      A, priorA, isFifteen, underlying: c5.close, signalSymbol: 'NDX', priceSymbol: 'NDX'
    });
  }
  // Settle + summary, exactly as eodSettlement would.
  const settle = dayBars[dayBars.length - 1].analysis['5m'].close;
  const term = trader.computeTerminalPnl(record.state, cfg, settle);
  store.appendEvent(record, { type: 'eod_settlement', variant: 'v6', settle, terminalPnl: term.total, floorPnl: term.floor, positions: term.positions });

  const opens = record.state.positions.length;
  const covered = record.state.positions.filter(p => p.covered).length;
  ok(opens > 0, `pipeline opened positions over the day (${opens} opens, ${covered} covered)`);
  ok(typeof term.total === 'number' && !Number.isNaN(term.total), `terminal P/L computes ($${Math.round(term.total)})`);
  ok(record.state.positions.every(p => p.filled), 'all opened positions marked filled (dry-run assume-fill)');

  const text = summary.renderText(summary.buildDaySummary(record));
  ok(text.includes(record.runId) && /OPEN/.test(text), 'EOD summary renders with orders');
  console.log('\n--- sample EOD summary ---\n' + text.split('\n').slice(0, 8).join('\n') + '\n...');

  console.log(`\n${pass} passed, ${fail} failed`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 1 : 0);
})();
