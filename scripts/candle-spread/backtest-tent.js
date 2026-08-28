#!/usr/bin/env node
'use strict';
/**
 * STEP B — historical backtest of the candle-spread tent strategy across all available NDX days.
 *
 * Runs the REAL engine (server/src/candle-spread/trader.processCandleClose + the four cover
 * selectors) over historical 15m candles, feeding it MODELED option prices from the Black-Scholes
 * pricer (bs-pricer.js) instead of real chain snapshots. Because the only thing swapped is the
 * getLeg quote source, the opens/covers/geometry/settlement are identical to the live strategy.
 *
 * Data: tests/backtest/backtest-data/backtest-NDX-*.json (per-minute, ~49 populated days,
 * 2026-01-15 → 04-13). We extract the 1m series, concatenate ALL days, resample to 15m and compute
 * Bollinger(20,2) over the whole series (index-based, ignoring overnight gaps — matching the live
 * candle-analyzer) so bands are warm from each day's first bar. IV per candle comes from the
 * relative-band-width → IV mapping (bs-pricer.ivFromRelBandWidth); tau from time-to-16:00.
 *
 * NOTE: historical data is NDX only, so signal and pricing both use NDX here (the live engine
 * signals off NQ, prices off NDX — a split we can't reproduce without historical NQ). Fills follow
 * the same dry-run fill-at-limit assumption that generated the captured live runs.
 *
 * Usage:
 *   node scripts/candle-spread/backtest-tent.js            # full per-day table + aggregate
 *   node scripts/candle-spread/backtest-tent.js --csv      # also write backtest-tent-results.csv
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

// Route the engine's per-candle record writes to a throwaway temp dir (we use the in-memory record).
process.env.CANDLE_SPREAD_RUNS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-tent-'));

const ind = require('../../scripts/signal-lab/indicators');
const trader = require('../../server/src/candle-spread/trader');
const store = require('../../server/src/candle-spread/store');
const bs = require('../../server/src/candle-spread/bs-pricer');

const DATA_DIR = path.join(__dirname, '..', '..', 'tests', 'backtest', 'backtest-data');
const SYMBOL = 'NDX';
const CFG_BASE = { symbol: SYMBOL, signalSymbol: SYMBOL, expiration: 'HIST', spreadWidth: 20, strikeIncrement: 10, quantity: 1, tickIncrement: 0.05, coverTiming: 'reversal', coverStyle: 'debit', dryRun: true, captureChain: false };
const VARIANTS = [
  { variant: 'v0', variantLabel: 'fixed-cap',  coverSelector: 'fixed' },
  { variant: 'v3', variantLabel: 'fixed-mark', coverSelector: 'fixed-mark' },
  { variant: 'v1', variantLabel: 'greedy',     coverSelector: 'greedy' },
  { variant: 'v2', variantLabel: 'joint',      coverSelector: 'joint' },
];
const etDay = ms => new Date(ms).toLocaleDateString('en-US', { timeZone: 'America/New_York' });
const etHM = ms => new Date(ms).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' });
const money = n => n == null ? '—' : (n < 0 ? '-$' : '+$') + Math.abs(Math.round(n));

// --- 1. Build one continuous 15m series with warm Bollinger bands across ALL days ---------------
function buildSeries() {
  const files = fs.readdirSync(DATA_DIR).filter(f => /^backtest-NDX-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  let all1m = [];
  for (const f of files) {
    const arr = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
    for (const x of arr) {
      const c = x.analysis && x.analysis['1m'];
      if (c && c.close != null && c.high != null && c.low != null && c.open != null) {
        all1m.push({ datetime: x.datetime, open: c.open, high: c.high, low: c.low, close: c.close, volume: 0 });
      }
    }
  }
  all1m.sort((a, b) => a.datetime - b.datetime);
  const c15 = ind.resample(all1m, 15);
  const bb = ind.bollinger(c15, 20, 2);
  // Attach bands in the engine's expected shape + timeEST; drop warmup bars (no bands).
  const bars = [];
  for (let i = 0; i < c15.length; i++) {
    if (!bb[i] || bb[i].bbUpper == null) continue;
    const c = c15[i];
    bars.push({
      datetime: c.datetime, timeEST: etDay(c.datetime) + ' ' + etHM(c.datetime),
      open: c.open, high: c.high, low: c.low, close: c.close,
      indicators: { bollinger20_2: { upper: bb[i].bbUpper, middle: bb[i].bbMiddle, lower: bb[i].bbLower } },
    });
  }
  return bars;
}

// --- 2. Replay one day for one variant through the real engine with modeled prices --------------
function runDayVariant(dayBars, priorBar, variant) {
  const cfg = { ...CFG_BASE, ...variant };
  const record = store.initRun(cfg, etDay(dayBars[0].datetime).replace(/\//g, '-'));
  // reset state (initRun may have returned a stale record from the temp dir on a same-name reuse)
  record.state = { direction: 'none', positions: [], pendingOpenId: null, realizedPnl: 0, lastCandleTime: null };
  record.events = [];

  const placeOrder = () => ({ status: 'filled', filled: true });   // dry-run fill-at-limit (matches live runs)

  let prev = priorBar;
  for (const candle of dayBars) {
    const relWidth = (candle.indicators.bollinger20_2.upper - candle.indicators.bollinger20_2.lower) / candle.close;
    const iv = bs.ivFromRelBandWidth(relWidth);
    const tau = bs.tauFromTime(candle.datetime);
    const getLeg = bs.makeSyntheticLegAccessor({ underlying: candle.close, tau, ivFn: bs.makeIvFn({ base: iv, skew: 0 }, candle.close) });
    trader.processCandleClose(record, candle, prev, { getLeg, placeOrder, dryRun: true, underlying: candle.close, signalSymbol: SYMBOL, priceSymbol: SYMBOL });
    prev = candle;
  }
  // Settle at the day's final 15m close (0DTE intrinsic).
  const settle = dayBars[dayBars.length - 1].close;
  const term = trader.computeTerminalPnl(record.state, cfg, settle);
  const P = record.state.positions.filter(p => p.filled);
  return {
    floor: record.state.realizedPnl, terminal: term.total, settle,
    opens: P.length, covers: P.filter(p => p.covered).length, open: P.filter(p => !p.covered).length,
  };
}

// --- 3. Main: group bars by day, replay every variant, aggregate --------------------------------
function main() {
  const bars = buildSeries();
  // group into trading days (preserving a prior-bar handoff so day 1 bar isn't treated as first-of-day
  // unless it truly is — the engine's first-of-day path uses the Bollinger gate, which is fine).
  const byDay = new Map();
  for (const b of bars) { const d = etDay(b.datetime); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(b); }
  const days = [...byDay.keys()].sort((a, b) => new Date(a) - new Date(b));

  const rows = [];
  let flatBarIndex = 0;
  for (const d of days) {
    const dayBars = byDay.get(d);
    // prior bar = the bar immediately before this day's first (gives the engine a real priorCandle
    // so it doesn't take the first-of-day Bollinger-gate path mid-dataset).
    const firstIdx = bars.indexOf(dayBars[0]);
    const priorBar = firstIdx > 0 ? bars[firstIdx - 1] : null;
    const res = { date: d };
    for (const v of VARIANTS) res[v.variant] = runDayVariant(dayBars, priorBar, v);
    rows.push(res);
  }

  // Per-day table
  console.log(`STEP B — historical tent backtest (${days.length} NDX days, ${bars.length} 15m bars, modeled BS cover prices)\n`);
  console.log('DATE         settle   O/C/open   v0/cap          v3/fixed        v1/greedy       v2/joint');
  console.log('-'.repeat(104));
  const totals = { v0: { f: 0, t: 0 }, v3: { f: 0, t: 0 }, v1: { f: 0, t: 0 }, v2: { f: 0, t: 0 } };
  let wins = { v3: 0, v1: 0, v2: 0 };
  for (const r of rows) {
    const any = r.v3;
    const oc = `${any.opens}/${any.covers}/${any.open}`;
    const cell = v => `${money(r[v].floor)}/${money(r[v].terminal)}`;
    for (const v of ['v0', 'v3', 'v1', 'v2']) { totals[v].f += r[v].floor; totals[v].t += r[v].terminal; }
    // honest daily winner among v3/v1/v2 by terminal
    const best = ['v3', 'v1', 'v2'].reduce((a, b) => r[b].terminal > r[a].terminal ? b : a);
    wins[best]++;
    console.log(r.date.padEnd(12) + String(Math.round(any.settle)).padEnd(9) + oc.padEnd(11) +
      cell('v0').padEnd(16) + cell('v3').padEnd(16) + cell('v1').padEnd(16) + cell('v2'));
  }
  console.log('-'.repeat(104));
  console.log('TOTALS'.padEnd(12) + ''.padEnd(9) + ''.padEnd(11) +
    `${money(totals.v0.f)}/${money(totals.v0.t)}`.padEnd(16) +
    `${money(totals.v3.f)}/${money(totals.v3.t)}`.padEnd(16) +
    `${money(totals.v1.f)}/${money(totals.v1.t)}`.padEnd(16) +
    `${money(totals.v2.f)}/${money(totals.v2.t)}`);
  console.log('\ncells = floor / terminal.  v0 = optimistic cap ceiling; v3 = honest fixed baseline.');
  console.log(`honest daily wins (by terminal, among v3/v1/v2):  v3 ${wins.v3}  ·  v1 ${wins.v1}  ·  v2 ${wins.v2}`);

  if (process.argv.includes('--csv')) {
    const out = path.join(__dirname, '..', '..', 'backtest-tent-results.csv');
    const head = 'date,settle,opens,covers,open,' + ['v0', 'v3', 'v1', 'v2'].flatMap(v => [`${v}_floor`, `${v}_terminal`]).join(',');
    const lines = rows.map(r => [r.date, Math.round(r.v3.settle), r.v3.opens, r.v3.covers, r.v3.open,
      ...['v0', 'v3', 'v1', 'v2'].flatMap(v => [r[v].floor, r[v].terminal])].join(','));
    fs.writeFileSync(out, [head, ...lines].join('\n'));
    console.log(`\nwrote ${out}`);
  }
}

main();
