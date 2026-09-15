'use strict';
// End-to-end offline replay of the LIVE tick on REAL 24h NQ data, mirroring processGroup: build the
// multi-TF `A` from the full 24h Globex series, but ACT only at RTH 5m marks (9:35-15:55) with
// priorA=null at the day's first RTH mark — the live design (24h NQ signal → RTH-only trades). Uses a
// Black-Scholes NQ chain so covers can fill. Proves the 24h path runs end to end and that the signal
// sees overnight-informed bands at the open (60m is warm at 9:35 — impossible on RTH-only data).
//
// Run: node server/tests/nogit/candle-spread-nq-24h-tick.test.js
const os = require('os'), path = require('path'), fs = require('fs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-nq24-'));
process.env.CANDLE_SPREAD_RUNS_DIR = tmp;
const store = require('../../src/candle-spread/store');
const trader = require('../../src/candle-spread/trader');
const ab = require('../../src/candle-spread/analysis-builder');
const summary = require('../../src/candle-spread/summary');
const { v6Signal } = require('../../src/candle-spread/signals/v6-signals');
const eng = require('../../../scripts/candle-spread/backtest-v4'); // test-only BS pricer

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const RAW1 = path.join(__dirname, '..', '..', '..', 'signal-lab-data', 'raw-1m');
if (!fs.existsSync(RAW1) || !fs.readdirSync(RAW1).some(f => f.startsWith('NQ-'))) { console.log('SKIP: no NQ raw-1m cache'); process.exit(0); }

function loadNQ() {
  const files = fs.readdirSync(RAW1).filter(f => f.startsWith('NQ-') && f.endsWith('.json')).sort();
  let all = [];
  for (const f of files) all = all.concat(JSON.parse(fs.readFileSync(path.join(RAW1, f), 'utf8')).candles || []);
  const seen = new Set();
  all = all.filter(c => c.datetime != null && !seen.has(c.datetime) && seen.add(c.datetime));
  all.sort((a, b) => a.datetime - b.datetime);
  return all;
}
const etMin = ms => { const d = new Date(new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York' })); return d.getHours() * 60 + d.getMinutes(); };
const etDay = ms => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

const raw = loadNQ();
const series = ab.buildSeries(raw);                // for analysisAt(T) / analysisAt(T-5m), like processGroup
const bars = ab.buildBars(raw, 5);                 // all 5m marks across 24h (to enumerate + pick a day)
const STEP_MS = 5 * 60 * 1000;
ok(bars.some(b => { const m = etMin(b.datetime); return m < 570 || m >= 960; }), '24h data: overnight bars present in the series');

// Pick the ET day with the most RTH action bars.
const rthByDay = new Map();
for (const b of bars) { const m = etMin(b.datetime); if (m >= 575 && m <= 955) { const d = etDay(b.datetime); if (!rthByDay.has(d)) rthByDay.set(d, []); rthByDay.get(d).push(b); } }
const [day, rthBars] = [...rthByDay.entries()].sort((a, b) => b[1].length - a[1].length)[0];
ok(rthBars.length >= 60, `full RTH day ${day}: ${rthBars.length} action bars (9:35-15:55)`);
// THE 24h PROOF: at the first RTH mark (~9:35), 60m is already warm — only possible with overnight
// warmup; RTH-only data can't warm a 60m BB(20)+EMA(9) by the open.
const first = rthBars[0].analysis;
ok(first['60m'] && first['60m'].bbupper != null && first['60m'].ema != null, 'first RTH bar has a WARM 60m band (overnight-informed)');

function makeGetLeg(A, dt) {
  const c15 = A['15m'];
  const iv = eng.bs.ivFromRelBandWidth((c15.bbupper - c15.bblower) / c15.close);
  const tau = eng.bs.tauFromTime(dt), U = A['5m'].close;
  return (type, strike) => { const mid = Math.max(0.05, Math.round(eng.bs.bsPrice(type, U, strike, tau, iv) / 0.05) * 0.05); return { mid, symbol: `NQ_${type}${strike}`, bid: mid - 0.05, ask: mid + 0.05 }; };
}
const placeOrder = async () => ({ status: 'sim', filled: true });
const cfg = { symbol: 'NQ', variant: 'v6', variantLabel: '5m-harness', expiration: day, spreadWidth: 20, strikeIncrement: 10, quantity: 1, tickIncrement: 0.05, coverSelector: 'fixed-mark', coverFillModel: 'resting', captureChain: false };
const record = store.initRun(cfg, day);

// Continuity check: the first RTH mark's prior (via analysisAt at T-5m, exactly like processGroup)
// is a REAL bar (the ~9:30 candle), NOT null — because the 24h series is continuous overnight.
const firstPrev = ab.analysisAt(series, rthBars[0].datetime - STEP_MS);
ok(firstPrev.warm && firstPrev.A['15m'], 'first RTH mark has a REAL prior bar (24h continuity, not null)');

(async () => {
  for (let i = 0; i < rthBars.length; i++) {
    const A = rthBars[i].analysis, dt = rthBars[i].datetime;
    const prev = ab.analysisAt(series, dt - STEP_MS);        // TRUE continuity (mirrors processGroup)
    const priorA = prev.warm ? prev.A : null;
    const c5 = A['5m'];
    const candle = { timeEST: new Date(dt).toISOString(), open: c5.open, high: c5.high, low: c5.low, close: c5.close };
    await trader.processCandleClose(record, candle, null, {
      getLeg: makeGetLeg(A, dt), placeOrder, dryRun: true,
      signalFn: v6Signal, signalCfg: { fiveMin: true }, bidirectional: false,
      A, priorA, isFifteen: etMin(dt) % 15 === 0, underlying: c5.close, signalSymbol: 'NQ', priceSymbol: 'NQ'
    });
  }
  const settle = rthBars[rthBars.length - 1].analysis['5m'].close;
  const term = trader.computeTerminalPnl(record.state, cfg, settle);
  store.appendEvent(record, { type: 'eod_settlement', variant: 'v6', settle, terminalPnl: term.total, floorPnl: term.floor, positions: term.positions });

  ok(record.state.positions.length > 0, `pipeline opened positions on 24h NQ (${record.state.positions.length} opens, ${record.state.positions.filter(p => p.covered).length} covered)`);
  ok(typeof term.total === 'number' && !Number.isNaN(term.total), `terminal P/L computes ($${Math.round(term.total)})`);
  const text = summary.renderText(summary.buildDaySummary(record));
  ok(text.includes(record.runId) && /OPEN/.test(text), 'EOD summary renders');
  console.log('\n--- sample (24h NQ signal, RTH action) ---\n' + text.split('\n').slice(0, 6).join('\n') + '\n...');

  console.log(`\n${pass} passed, ${fail} failed`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 1 : 0);
})();
