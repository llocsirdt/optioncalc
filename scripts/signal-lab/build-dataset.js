#!/usr/bin/env node
'use strict';
/**
 * Assemble the cached per-day 1m candles into one continuous RTH series, resample to
 * 5m/15m/60m, and decorate every timeframe with Bollinger(20,2) + %B. Bollinger is computed
 * across the concatenated multi-day series (warmup carries over day boundaries, matching how
 * the live engine's 15m BB spans prior sessions). Output feeds the hypothesis scorers (A/B/C).
 *
 * Usage: node scripts/signal-lab/build-dataset.js [SYMBOL=NDX]
 */
const path = require('path');
const fs = require('fs');
const { resample, withIndicators } = require('./indicators');

const DATA = path.join(__dirname, '../../signal-lab-data');
const RAW = path.join(DATA, 'raw-1m');
const symbol = (process.argv[2] || 'NDX').toUpperCase();

const files = fs.existsSync(RAW)
  ? fs.readdirSync(RAW).filter(f => f.startsWith(`${symbol}-`) && f.endsWith('.json')).sort()
  : [];
if (!files.length) { console.error(`No raw 1m data for ${symbol}. Run: node scripts/signal-lab/fetch-history.js ${symbol}`); process.exit(1); }

const days = [];
let all1m = [];
for (const f of files) {
  const j = JSON.parse(fs.readFileSync(path.join(RAW, f), 'utf8'));
  days.push(j.date);
  all1m = all1m.concat(j.candles);
}
all1m.sort((a, b) => a.datetime - b.datetime);

const timeframes = {
  '1m': withIndicators(all1m),
  '5m': withIndicators(resample(all1m, 5)),
  '15m': withIndicators(resample(all1m, 15)),
  '60m': withIndicators(resample(all1m, 60))
};

const out = {
  symbol,
  generatedAt: new Date().toISOString(),
  days,
  counts: Object.fromEntries(Object.entries(timeframes).map(([k, v]) => [k, v.length])),
  timeframes
};
fs.mkdirSync(DATA, { recursive: true });
const file = path.join(DATA, `dataset-${symbol}.json`);
fs.writeFileSync(file, JSON.stringify(out));

console.log(`dataset-${symbol}.json · ${days.length} days (${days[0]} .. ${days[days.length - 1]})`);
console.log(`candles: ${Object.entries(out.counts).map(([k, v]) => `${k}:${v}`).join('  ')}`);
console.log(`saved: ${file}`);
