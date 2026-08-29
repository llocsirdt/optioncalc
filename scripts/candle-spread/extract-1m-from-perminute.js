#!/usr/bin/env node
'use strict';
/**
 * Extract a clean 1m OHLC series from the Jan-Apr per-minute backtest-data (whose embedded analysis
 * uses a forming-candle shape — every TF's close = the current price each minute). We pull just the
 * 1m candle (analysis['1m']) per minute and write raw-1m-format day-files, so build-analysis-dataset
 * can rebuild it at any --step with the SAME completed-candle semantics as the Jul-Aug 5m dataset.
 *
 * Usage: node scripts/candle-spread/extract-1m-from-perminute.js <srcDir> <outRawDir> [SYMBOL=NDX]
 */
const fs = require('fs');
const path = require('path');
const src = process.argv[2], out = process.argv[3], sym = (process.argv[4] || 'NDX').toUpperCase();
if (!src || !out) { console.error('usage: extract-1m-from-perminute.js <srcDir> <outRawDir> [SYMBOL]'); process.exit(1); }
fs.mkdirSync(out, { recursive: true });

const ymd = ms => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const num = v => (typeof v === 'number' && isFinite(v)) ? v : null;
let days = 0, bars = 0;
for (const f of fs.readdirSync(src).filter(x => /^backtest-NDX-\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort()) {
  const arr = JSON.parse(fs.readFileSync(path.join(src, f), 'utf8'));
  const candles = [];
  for (const b of arr) {
    const one = b.analysis && b.analysis['1m'];
    if (!b.datetime || !one || num(one.close) == null) continue;
    candles.push({ datetime: b.datetime, open: num(one.open), high: num(one.high), low: num(one.low), close: num(one.close), volume: num(one.volume) || 0 });
  }
  if (candles.length < 50) continue;
  const date = ymd(candles[0].datetime);
  fs.writeFileSync(path.join(out, `${sym}-${date}.json`), JSON.stringify({ symbol: sym, date, freq: 1, candles }));
  days++; bars += candles.length;
}
console.log(`extracted ${bars} 1m candles across ${days} days → ${out}`);
