#!/usr/bin/env node
'use strict';
/**
 * build-dual-dataset.js — build the dataset that actually matches the LIVE model:
 *   SIGNALS from /NQ over the full 24h session (bands carry the overnight, signalRth:false)
 *   PRICING from cash NDX (the options we trade settle on NDX)
 *
 * WHY THIS EXISTS: neither existing dataset reproduces that split, and each is wrong in the opposite
 * direction. The 922-day NQ history has the right signal but prices options off NQ. The NDX Schwab set
 * has the right pricing but derives its signals from NDX, which trades RTH only — so its Bollinger bands
 * and EMAs have no overnight component at all, while the live engine's explicitly do. Backtesting the
 * strategy on either one answers a slightly different question than "what would the live engine have done".
 *
 * The engine has supported this since the priceOf option was added; it just had no dataset to use it with.
 * Output bars carry BOTH series:  { datetime, analysis: <NQ multi-TF>, px: { open, high, low, close } <NDX> }
 * and runDay5m is driven with `opts.priceOf = b => b.px`.
 *
 * Only dates present in BOTH raw captures can be built — NDX is RTH-only and NQ starts later.
 * Usage: node scripts/candle-spread/build-dual-dataset.js [--raw <dir>] [--out <dir>] [--step 5]
 */
const fs = require('fs');
const path = require('path');
const { resample, withIndicators } = require('../signal-lab/indicators');

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const RAW = arg('--raw', path.join(__dirname, '..', '..', 'signal-lab-data', 'raw-1m'));
const OUT = arg('--out', path.join(__dirname, '..', '..', 'tests', 'backtest', 'backtest-data-5m-nq-ndx'));
const STEP = Number(arg('--step', 5));

const readRaw = (sym, date) => {
  const f = path.join(RAW, `${sym}-${date}.json`);
  if (!fs.existsSync(f)) return null;
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  const arr = Array.isArray(j) ? j : (j.candles || j.bars || []);
  return arr.map(c => ({ datetime: c.datetime || c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 }))
    .filter(c => c.datetime && c.close != null).sort((a, b) => a.datetime - b.datetime);
};

const datesFor = (sym) => fs.readdirSync(RAW).map(f => (f.match(new RegExp('^' + sym + '-(\\d{4}-\\d{2}-\\d{2})\\.json$')) || [])[1]).filter(Boolean);
const nqDates = new Set(datesFor('NQ'));
const dates = datesFor('NDX').filter(d => nqDates.has(d)).sort();
if (!dates.length) { console.error('no dates present in BOTH NDX and NQ raw captures'); process.exit(1); }

// The signal series needs multi-day warmup: BB(20,2)/EMA(9) on the 60m TF need many hours of history, and
// the live engine carries that across days. Concatenate ALL NQ days, compute indicators once, then slice.
const allNq = [];
for (const d of dates) { const r = readRaw('NQ', d); if (r) allNq.push(...r); }
allNq.sort((a, b) => a.datetime - b.datetime);
const TFS = { '1m': 1, '5m': 5, '15m': 15, '60m': 60 };
const series = {};
for (const [tf, mins] of Object.entries(TFS)) series[tf] = withIndicators(resample(allNq, mins));

// most-recently-COMPLETED candle of `tf` as of time T — the state a live decision at T actually sees
function slotAt(tf, T) {
  const s = series[tf], per = TFS[tf] * 60000;
  let lo = 0, hi = s.length - 1, best = null;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (s[m].datetime + per <= T) { best = s[m]; lo = m + 1; } else hi = m - 1; }
  return best;
}
// indicators.js emits camelCase (bbUpper/bbMiddle/bbLower/ema9); the analysis format the engine consumes
// uses lowercase (bbupper/bbmiddle/bblower/ema). Map, don't assume.
const warm = c => c && c.bbUpper != null && c.bbLower != null && c.bbMiddle != null && c.ema9 != null;

fs.mkdirSync(OUT, { recursive: true });
let files = 0, bars = 0, skippedCold = 0, skippedNoPx = 0;
for (const date of dates) {
  const ndx = readRaw('NDX', date);
  if (!ndx || !ndx.length) continue;
  const ndx5 = resample(ndx, STEP);
  // LOOKAHEAD GUARD. A bar labelled T covers [T, T+STEP) and closes at T+STEP, so its close is in the
  // FUTURE relative to a decision made at T. The live engine at mark T uses the price AT T — the close of
  // the bar that just COMPLETED, i.e. the one labelled T-STEP. Keying px by the bar's own label gave the
  // backtest a 5-minute lookahead on pricing and strike selection; measured against the live run it moved
  // the centre strike on 64% of bars. The `analysis` side was already built as "most recently completed
  // candle as of T"; this applies the same rule to the price series.
  const stepMs = STEP * 60000;
  const byT = new Map(ndx5.map(c => [c.datetime + stepMs, c]));   // key by the time the bar CLOSES
  const out = [];
  for (const c of ndx5) {
    const T = c.datetime;
    const analysis = {};
    let ok = true;
    for (const tf of Object.keys(TFS)) {
      const slot = slotAt(tf, T);
      if (!warm(slot)) { ok = false; break; }
      analysis[tf] = { open: slot.open, high: slot.high, low: slot.low, close: slot.close,
        bbupper: slot.bbUpper, bbmiddle: slot.bbMiddle, bblower: slot.bbLower, ema: slot.ema9 };
    }
    if (!ok) { skippedCold++; continue; }
    const px = byT.get(T);
    if (!px) { skippedNoPx++; continue; }
    // analysis = NQ (the signal), px = NDX (what the options are priced and settled on)
    out.push({ datetime: T, analysis, px: { open: px.open, high: px.high, low: px.low, close: px.close } });
  }
  if (out.length < 5) continue;
  fs.writeFileSync(path.join(OUT, `backtest-NDX-${date}.json`), JSON.stringify(out), 'utf8');
  files++; bars += out.length;
}
console.log(`built ${files} day-files (${bars} bars) — signals from /NQ 24h, pricing from cash NDX`);
console.log(`  ${dates.length} dates had both captures · dropped ${skippedCold} cold-indicator bars, ${skippedNoPx} without an NDX price`);
console.log(`  -> ${path.relative(process.cwd(), OUT)}`);
