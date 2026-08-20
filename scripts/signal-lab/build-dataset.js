#!/usr/bin/env node
'use strict';
/**
 * Assemble cached per-day candles into continuous RTH series per timeframe, decorated with
 * Bollinger(20,2) + %B. Prefers DIRECTLY-fetched 5m/15m caches (deeper history, ~90d) over
 * 1m-derived resampling; 1m (~30d, for the B hypothesis) and 60m (resampled from 15m) round
 * it out. Bollinger warmup carries across the concatenated multi-day series, matching how the
 * live engine's 15m BB spans prior sessions. Output feeds the A/B/C hypothesis scorers.
 *
 * Usage: node scripts/signal-lab/build-dataset.js [SYMBOL=NDX]
 */
const path = require('path');
const fs = require('fs');
const { resample, withIndicators } = require('./indicators');

const DATA = path.join(__dirname, '../../signal-lab-data');
const symbol = (process.argv[2] || 'NDX').toUpperCase();

function loadDays(freq) {
  const dir = path.join(DATA, `raw-${freq}m`);
  if (!fs.existsSync(dir)) return { days: [], candles: [] };
  const files = fs.readdirSync(dir).filter(f => f.startsWith(`${symbol}-`) && f.endsWith('.json')).sort();
  const days = [];
  let all = [];
  for (const f of files) { const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); days.push(j.date); all = all.concat(j.candles); }
  all.sort((a, b) => a.datetime - b.datetime);
  return { days, candles: all };
}

const raw1 = loadDays(1), raw5 = loadDays(5), raw15 = loadDays(15);
if (!raw1.candles.length && !raw5.candles.length && !raw15.candles.length) {
  console.error(`No raw data for ${symbol}. Run: node scripts/signal-lab/fetch-history.js ${symbol} --freq 15 --days 90`);
  process.exit(1);
}

// Prefer directly-fetched series; fall back to resampling from 1m when a TF wasn't fetched.
const s1 = raw1.candles;
const s5 = raw5.candles.length ? raw5.candles : resample(s1, 5);
const s15 = raw15.candles.length ? raw15.candles : resample(s1, 15);
const s60 = resample(s15.length ? s15 : s1, 60);
const timeframes = { '1m': withIndicators(s1), '5m': withIndicators(s5), '15m': withIndicators(s15), '60m': withIndicators(s60) };
// Per-TF day coverage + whether the series was directly fetched or resampled.
const meta = {
  '1m': { days: raw1.days, derived: false },
  '5m': { days: raw5.days.length ? raw5.days : raw1.days, derived: !raw5.days.length },
  '15m': { days: raw15.days.length ? raw15.days : raw1.days, derived: !raw15.days.length },
  '60m': { days: raw15.days.length ? raw15.days : raw1.days, derived: true } // always resampled
};
const coverage = {};
for (const tf of Object.keys(timeframes)) {
  const d = meta[tf].days || [];
  coverage[tf] = { days: d.length, from: d[0] || null, to: d[d.length - 1] || null, candles: timeframes[tf].length, derived: meta[tf].derived };
}

const out = { symbol, generatedAt: new Date().toISOString(), coverage, timeframes };
fs.mkdirSync(DATA, { recursive: true });
const file = path.join(DATA, `dataset-${symbol}.json`);
fs.writeFileSync(file, JSON.stringify(out));

console.log(`dataset-${symbol}.json`);
for (const tf of ['1m', '5m', '15m', '60m']) {
  const c = coverage[tf];
  console.log(`  ${tf.padEnd(4)} ${String(c.days).padStart(3)} days (${c.from || '—'} .. ${c.to || '—'})  ${String(c.candles).padStart(5)} candles${c.derived ? '  [resampled from 1m/15m]' : ''}`);
}
console.log(`saved: ${file}`);
