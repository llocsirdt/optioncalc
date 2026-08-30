#!/usr/bin/env node
'use strict';
/**
 * Convert the Kaggle NQ 1-min CSV (columns: "timestamp ET,open,high,low,close,volume,Vwap_RTH,Vwap_ETH"
 * — ET wall-clock, back-adjusted continuous contract, ETH+RTH) into raw-1m day-files that
 * build-analysis-dataset.js can consume. NQ is a FUTURES signal instrument → keep the full 24h Globex
 * session (drop only the 17:00-18:00 ET maintenance break); an RTH-truncated NQ series would corrupt
 * the multi-TF signal bands. Converts ET→real-UTC ms (DST-aware) so the downstream ET-day/resample
 * logic is correct.
 *
 * Usage: node scripts/candle-spread/extract-nq-csv.js <in.csv> <outRawDir> [SYMBOL=NQ]
 */
const fs = require('fs');
const path = require('path');
const src = process.argv[2], out = process.argv[3], sym = (process.argv[4] || 'NQ').toUpperCase();
if (!src || !out) { console.error('usage: extract-nq-csv.js <in.csv> <outRawDir> [SYMBOL]'); process.exit(1); }
fs.mkdirSync(out, { recursive: true });

// real UTC ms for an ET wall-clock (DST-aware): compute the ET offset AT that instant and correct.
function etOffsetMs(utcMs) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(utcMs));
  const o = {}; for (const x of p) o[x.type] = x.value;
  return Date.UTC(+o.year, +o.month - 1, +o.day, +(o.hour === '24' ? 0 : o.hour), +o.minute, +o.second) - utcMs;   // ET behind UTC → negative
}
function etToUtc(y, mo, d, h, mi) { const guess = Date.UTC(y, mo - 1, d, h, mi); return guess - etOffsetMs(guess); }
const ymd = (y, mo, d) => `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

const lines = fs.readFileSync(src, 'utf8').split('\n');
const byDay = new Map();   // 'YYYY-MM-DD' -> candles[]
let kept = 0, skipped = 0;
for (let i = 1; i < lines.length; i++) {
  const l = lines[i].trim(); if (!l) continue;
  const p = l.split(',');
  const m = p[0].match(/^(\d+)\/(\d+)\/(\d+) (\d+):(\d+)/);
  if (!m) { skipped++; continue; }
  const mo = +m[1], d = +m[2], y = +m[3], hh = +m[4], mm = +m[5];
  const min = hh * 60 + mm;
  if (min >= 1020 && min < 1080) { skipped++; continue; }   // futures: keep 24h Globex, drop only 17:00-18:00 ET maintenance
  const o = +p[1], h = +p[2], lo = +p[3], c = +p[4], v = +p[5] || 0;
  if (!(o > 0 && h > 0 && lo > 0 && c > 0)) { skipped++; continue; }
  const key = ymd(y, mo, d);
  if (!byDay.has(key)) byDay.set(key, []);
  byDay.get(key).push({ datetime: etToUtc(y, mo, d, hh, mm), open: o, high: h, low: lo, close: c, volume: v });
  kept++;
}

let files = 0;
for (const [date, candles] of byDay) {
  if (candles.length < 50) continue;   // drop half-days / holidays
  candles.sort((a, b) => a.datetime - b.datetime);
  fs.writeFileSync(path.join(out, `${sym}-${date}.json`), JSON.stringify({ symbol: sym, date, freq: 1, candles }));
  files++;
}
console.log(`extracted ${kept} 24h 1m bars (skipped ${skipped} maintenance-hr/bad) → ${files} day-files in ${out}`);
const dates = [...byDay.keys()].sort();
console.log(`date range: ${dates[0]} .. ${dates[dates.length - 1]}`);
