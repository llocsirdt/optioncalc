#!/usr/bin/env node
'use strict';
/**
 * Build backtest-v4-compatible per-15m-close `analysis` bars from the signal-lab raw 1m cache
 * (signal-lab-data/raw-1m/<SYM>-*.json), so v4 can be backtested on MORE days than the original
 * Jan-Apr backtest-data set. Output shape matches what backtest-v4 / confluence.js consume:
 *   { datetime: T, analysis: { '1m':{o,h,l,c,bbupper,bbmiddle,bblower,ema}, '5m':{...}, '15m', '60m' } }
 *
 * Convention: one bar per 15-minute wall-clock mark T (RTH). At T, each timeframe's slot is that
 * TF's most-recently-COMPLETED candle as of T (a [start,start+period) bucket with start+period<=T),
 * decorated with Bollinger(20,2)+EMA(9) computed over the full multi-day concatenated series per TF
 * (warmup carries across days, matching the live engine). This is exactly the state a live 15m-close
 * decision sees. Bars missing warm BB/EMA on any TF are dropped (warm gate, same as backtest-v4).
 *
 * Usage: node scripts/candle-spread/build-analysis-dataset.js [SYMBOL=NDX] [--out <dir>]
 */
const fs = require('fs');
const path = require('path');
const { resample, withIndicators } = require('../signal-lab/indicators');

const args = process.argv.slice(2);
const symbol = (args.find(a => !a.startsWith('--')) || 'NDX').toUpperCase();
const outDir = (() => { const i = args.indexOf('--out'); return i >= 0 ? args[i + 1] : path.join(__dirname, '..', '..', 'tests', 'backtest', 'backtest-data-v2'); })();
const RAW1 = (() => { const i = args.indexOf('--raw'); return i >= 0 ? args[i + 1] : path.join(__dirname, '..', '..', 'signal-lab-data', 'raw-1m'); })();
const MS = 60 * 1000;
const etDay = ms => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD

// Load + concatenate all cached raw 1m days for the symbol.
function loadRaw1() {
  const files = fs.readdirSync(RAW1).filter(f => f.startsWith(`${symbol}-`) && f.endsWith('.json')).sort();
  let all = [];
  for (const f of files) all = all.concat(JSON.parse(fs.readFileSync(path.join(RAW1, f), 'utf8')).candles || []);
  const seen = new Set();
  all = all.filter(c => (c.datetime != null && !seen.has(c.datetime)) && seen.add(c.datetime));
  all.sort((a, b) => a.datetime - b.datetime);
  return all;
}

// Decorate a TF series with lowercase BB/EMA field names the backtest expects, keyed by bucket start.
function tfSeries(s1, periodMin) {
  const raw = periodMin === 1 ? s1 : resample(s1, periodMin);
  const dec = withIndicators(raw);
  const byStart = new Map();
  const starts = [];
  for (const c of dec) {
    byStart.set(c.datetime, {
      open: c.open, high: c.high, low: c.low, close: c.close,
      bbupper: c.bbUpper, bbmiddle: c.bbMiddle, bblower: c.bbLower, ema: c.ema9,
    });
    starts.push(c.datetime);
  }
  return { periodMs: periodMin * MS, byStart, starts };
}

// Most-recently-completed candle of a TF as of time T: greatest bucket start with start+period <= T.
function completedAsOf(tf, T) {
  const lim = T - tf.periodMs;               // start must be <= lim to be complete by T
  let lo = 0, hi = tf.starts.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (tf.starts[m] <= lim) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans < 0 ? null : tf.byStart.get(tf.starts[ans]);
}

const warm = a => ['1m', '5m', '15m', '60m'].every(tf => a[tf] && a[tf].bbupper != null && a[tf].bblower != null && a[tf].ema != null);

function main() {
  if (!fs.existsSync(RAW1)) { console.error(`No raw 1m cache at ${RAW1}. Run fetch-history.js first.`); process.exit(1); }
  const s1 = loadRaw1();
  if (s1.length < 100) { console.error(`Only ${s1.length} 1m candles cached — nothing to build.`); process.exit(1); }
  const tfs = { '1m': tfSeries(s1, 1), '5m': tfSeries(s1, 5), '15m': tfSeries(s1, 15), '60m': tfSeries(resample(s1, 15), 60) };

  // 15m wall-clock marks present in the 1m data (every 15m bucket start that has 1m data), + one mark
  // at each bucket END so the last completed 15m candle is captured.
  // Emit one bar per `step`-minute mark (default 15). --step 5 gives 5m-resolution bars for the
  // 5m-step engine; each bar still carries the LAST-COMPLETED 1m/5m/15m/60m candle as of that mark,
  // so the 15m subset (mark % 15 === 0) is identical to a 15m-only build.
  const stepMin = (() => { const i = args.indexOf('--step'); return i >= 0 ? Number(args[i + 1]) : 15; })();
  const stepMs = stepMin * MS;
  const marks = new Set();
  for (const c of s1) { const b = Math.floor(c.datetime / stepMs) * stepMs; marks.add(b + stepMs); }
  const sortedMarks = [...marks].sort((a, b) => a - b);

  const byDay = new Map();
  for (const T of sortedMarks) {
    const analysis = {};
    for (const tf of ['1m', '5m', '15m', '60m']) { const c = completedAsOf(tfs[tf], T); if (c) analysis[tf] = c; }
    if (!warm(analysis)) continue;
    const day = etDay(T);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push({ datetime: T, analysis });
  }

  fs.mkdirSync(outDir, { recursive: true });
  let written = 0, totBars = 0;
  for (const [day, bars] of [...byDay].sort()) {
    if (bars.length < 5) continue;
    fs.writeFileSync(path.join(outDir, `backtest-${symbol}-${day}.json`), JSON.stringify(bars));
    written++; totBars += bars.length;
  }
  console.log(`built ${written} day-files (${totBars} bars) from ${s1.length} 1m candles → ${outDir}`);
  const days = [...byDay.keys()].sort();
  console.log(`date range: ${days[0]} .. ${days[days.length - 1]}`);
}

main();
