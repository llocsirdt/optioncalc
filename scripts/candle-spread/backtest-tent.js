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
const round2 = n => Math.round(n * 100) / 100;

// Net-debit mark of a cover spread (Σ long−short leg prices) at underlying U, via the BS pricer.
function coverSpreadMark(coverLegs, U, tau, iv) {
  let v = 0;
  for (const l of coverLegs) v += (l.side === 'long' ? 1 : -1) * bs.bsPrice(l.type, U, l.strike, tau, iv);
  return v;
}

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
// Two fill regimes returned side by side:
//   assumeFill = the engine's instant-fill dry-run (every cover booked) — the old, optimistic number.
//   honest     = a cover only counts if a candle's WICK crosses the tent CENTER (the covered short
//                strike) at/after the cover candle (the agreed resting-order rule); covers that never
//                get a wick-through-center settle NAKED. Engine DECISIONS/cadence are unchanged
//                (Model B) — only the fill accounting becomes honest.
async function runDayVariant(dayBars, priorBar, variant) {
  const cfg = { ...CFG_BASE, ...variant };
  const record = store.initRun(cfg, etDay(dayBars[0].datetime).replace(/\//g, '-'));
  // reset state (initRun may have returned a stale record from the temp dir on a same-name reuse)
  record.state = { direction: 'none', positions: [], pendingOpenId: null, realizedPnl: 0, lastCandleTime: null };
  record.events = [];

  const placeOrder = () => ({ status: 'filled', filled: true });   // engine-side assume-fill (matches live dry-run)

  const coverAt = {};   // positionId -> candle index the engine covered it (when the resting order is placed)
  let prev = priorBar;
  for (let i = 0; i < dayBars.length; i++) {
    const candle = dayBars[i];
    const relWidth = (candle.indicators.bollinger20_2.upper - candle.indicators.bollinger20_2.lower) / candle.close;
    const iv = bs.ivFromRelBandWidth(relWidth);
    const tau = bs.tauFromTime(candle.datetime);
    const getLeg = bs.makeSyntheticLegAccessor({ underlying: candle.close, tau, ivFn: bs.makeIvFn({ base: iv, skew: 0 }, candle.close) });
    const before = new Set(record.state.positions.filter(p => p.covered).map(p => p.id));
    await trader.processCandleClose(record, candle, prev, { getLeg, placeOrder, dryRun: true, underlying: candle.close, signalSymbol: SYMBOL, priceSymbol: SYMBOL });
    for (const p of record.state.positions) if (p.covered && !before.has(p.id) && coverAt[p.id] == null) coverAt[p.id] = i;
    prev = candle;
  }
  const settle = dayBars[dayBars.length - 1].close;
  const qtyOf = p => p.quantity || cfg.quantity;

  // assume-fill baseline (all covers booked) — capture before reclassifying.
  const assumeFill = { floor: record.state.realizedPnl, terminal: trader.computeTerminalPnl(record.state, cfg, settle).total };

  // Resolve honest fills against the cover's actual (modeled) PRICE, not a strike proxy.
  // Two-mode order: ideal target = width − openCost. At each candle from the cover candle onward,
  // price the cover at the FAVORABLE wick extreme (high for a bull position's put-spread cover /
  // low for a bear position's call-spread cover — the cheapest the cover got that bar). It fills the
  // first bar that reaches ≤ target; fill price = min(target, closeMark+tick) → cross cheap when the
  // cover is already below target (deep-ITM lock), else rest and fill at the target. Never ≤ target
  // by EOD → settles naked. (Live: same, but with the real cover quote instead of the pricer.)
  const tick = cfg.tickIncrement;
  let filledCovers = 0, restedNaked = 0;
  for (const pos of record.state.positions.filter(p => p.filled && p.covered)) {
    const target = cfg.spreadWidth - pos.limit;               // ideal rest price = other-half − open cost
    const useHigh = pos.side === 'bull';                       // bull cover cheapens as U rises → bar high
    const from = coverAt[pos.id] != null ? coverAt[pos.id] : 0;
    let filled = false, fillPrice = null;
    for (let i = from; i < dayBars.length; i++) {
      const b = dayBars[i];
      const rel = (b.indicators.bollinger20_2.upper - b.indicators.bollinger20_2.lower) / b.close;
      const iv = bs.ivFromRelBandWidth(rel), tau = bs.tauFromTime(b.datetime);
      const markExt = coverSpreadMark(pos.coverLegs, useHigh ? b.high : b.low, tau, iv);
      if (markExt <= target) {
        const markClose = coverSpreadMark(pos.coverLegs, b.close, tau, iv);
        fillPrice = Math.max(tick, Math.round(Math.min(target, markClose + tick) / tick) * tick);
        filled = true; break;
      }
    }
    if (filled) { filledCovers++; pos.coverLimit = round2(fillPrice); }   // book at the actual fill price
    else { restedNaked++; pos.covered = false; pos.coverLegs = null; }    // never filled → settles naked
  }
  // Honest floor = guaranteed floor (width − open − cover) summed over covers that actually filled.
  let honestFloor = 0;
  for (const pos of record.state.positions.filter(p => p.filled && p.covered)) {
    honestFloor = Math.round((honestFloor + (cfg.spreadWidth - pos.limit - pos.coverLimit) * 100 * qtyOf(pos)) * 100) / 100;
  }
  const honestTerminal = trader.computeTerminalPnl(record.state, cfg, settle).total;

  const P = record.state.positions.filter(p => p.filled);
  return {
    settle, opens: P.length, coversFilled: filledCovers, coversNaked: restedNaked,
    open: P.filter(p => !p.covered).length,
    floor: honestFloor, terminal: honestTerminal,
    assumeFloor: assumeFill.floor, assumeTerminal: assumeFill.terminal,
  };
}

// --- 3. Main: group bars by day, replay every variant, aggregate --------------------------------
async function main() {
  const bars = buildSeries();
  // group into trading days (preserving a prior-bar handoff so day 1 bar isn't treated as first-of-day
  // unless it truly is — the engine's first-of-day path uses the Bollinger gate, which is fine).
  const byDay = new Map();
  for (const b of bars) { const d = etDay(b.datetime); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(b); }
  const days = [...byDay.keys()].sort((a, b) => new Date(a) - new Date(b));

  const rows = [];
  for (const d of days) {
    const dayBars = byDay.get(d);
    // prior bar = the bar immediately before this day's first (gives the engine a real priorCandle
    // so it doesn't take the first-of-day Bollinger-gate path mid-dataset).
    const firstIdx = bars.indexOf(dayBars[0]);
    const priorBar = firstIdx > 0 ? bars[firstIdx - 1] : null;
    const res = { date: d };
    for (const v of VARIANTS) res[v.variant] = await runDayVariant(dayBars, priorBar, v);
    rows.push(res);
  }

  // Per-day table (HONEST fills: cover counts only if wick crossed the tent center)
  console.log(`STEP B — historical tent backtest, HONEST FILLS (${days.length} NDX days, ${bars.length} 15m bars, modeled BS prices)\n`);
  console.log('cover fill rule: a cover counts only if a candle wick crossed the tent center; else it settles naked.\n');
  console.log('DATE         settle   opn/fill/naked  v0/cap          v3/fixed        v1/greedy       v2/joint');
  console.log('-'.repeat(108));
  const V4 = ['v0', 'v3', 'v1', 'v2'];
  const totals = { v0: { f: 0, t: 0, af: 0, at: 0 }, v3: { f: 0, t: 0, af: 0, at: 0 }, v1: { f: 0, t: 0, af: 0, at: 0 }, v2: { f: 0, t: 0, af: 0, at: 0 } };
  let coversFilled = 0, coversNaked = 0;
  let wins = { v3: 0, v1: 0, v2: 0 };
  // v0 stays the assume-fill CEILING (its fixed geometry would just equal v3 under the honest pricing);
  // v3/v1/v2 show the honest two-mode fills.
  const cv = (r, v) => v === 'v0' ? { f: r.v0.assumeFloor, t: r.v0.assumeTerminal } : { f: r[v].floor, t: r[v].terminal };
  for (const r of rows) {
    const any = r.v3;
    const oc = `${any.opens}/${any.coversFilled}/${any.coversNaked}`;
    coversFilled += any.coversFilled; coversNaked += any.coversNaked;
    const cell = v => { const c = cv(r, v); return `${money(c.f)}/${money(c.t)}`; };
    for (const v of V4) { const c = cv(r, v); totals[v].f += c.f; totals[v].t += c.t; totals[v].af += r[v].assumeFloor; totals[v].at += r[v].assumeTerminal; }
    const best = ['v3', 'v1', 'v2'].reduce((a, b) => r[b].terminal > r[a].terminal ? b : a);
    wins[best]++;
    console.log(r.date.padEnd(12) + String(Math.round(any.settle)).padEnd(9) + oc.padEnd(16) +
      cell('v0').padEnd(16) + cell('v3').padEnd(16) + cell('v1').padEnd(16) + cell('v2'));
  }
  console.log('-'.repeat(108));
  console.log('TOTALS'.padEnd(12) + ''.padEnd(9) + ''.padEnd(16) +
    V4.map(v => `${money(totals[v].f)}/${money(totals[v].t)}`.padEnd(16)).join('').trimEnd());
  console.log('\ncells = floor / terminal.  v0 = optimistic cap ceiling; v3 = honest fixed baseline.');
  console.log(`fill rate: ${coversFilled}/${coversFilled + coversNaked} covers filled (${(100 * coversFilled / (coversFilled + coversNaked)).toFixed(0)}%), ${coversNaked} settled naked.`);
  console.log(`honest daily wins (terminal, v3/v1/v2):  v3 ${wins.v3}  ·  v1 ${wins.v1}  ·  v2 ${wins.v2}`);

  // Impact: honest terminal vs the old assume-fill terminal, per variant.
  console.log('\nFILL-MODEL IMPACT (terminal totals):  assume-fill  →  honest-fill');
  for (const v of V4) console.log(`  ${v}: ${money(totals[v].at)}  →  ${money(totals[v].t)}   (Δ ${money(totals[v].t - totals[v].at)})`);

  if (process.argv.includes('--csv')) {
    const out = path.join(__dirname, '..', '..', 'backtest-tent-results.csv');
    const head = 'date,settle,opens,coversFilled,coversNaked,open,' + ['v0', 'v3', 'v1', 'v2'].flatMap(v => [`${v}_floor`, `${v}_terminal`]).join(',');
    const lines = rows.map(r => [r.date, Math.round(r.v3.settle), r.v3.opens, r.v3.coversFilled, r.v3.coversNaked, r.v3.open,
      ...['v0', 'v3', 'v1', 'v2'].flatMap(v => [r[v].floor, r[v].terminal])].join(','));
    fs.writeFileSync(out, [head, ...lines].join('\n'));
    console.log(`\nwrote ${out}`);
  }
}

main();   // async; top-level fire-and-forget (script exits when the promise chain settles)
