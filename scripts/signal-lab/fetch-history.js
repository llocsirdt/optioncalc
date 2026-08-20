#!/usr/bin/env node
'use strict';
/**
 * Fetch historical intraday candles from Schwab and cache them per trading day for the offline
 * signal lab. Reuses the backtest's path: schwab-client-js MarketApiClient.priceHistory($NDX,
 * {frequencyType:'minute', frequency, startDate, endDate}); creds from the repo-root .env.
 *
 * 1m history is ~48 days max at Schwab; 5m/15m reach much further back, so we can build a
 * deeper dataset for the A/C validations even though B (1m patterns) is limited to ~30 days.
 * Candles are pulled in multi-day CHUNKS (fewer calls), split by ET session day, and cached to
 * signal-lab-data/raw-<freq>m/<SYMBOL>-<date>.json. Re-runs skip days already on disk and stop
 * once Schwab starts returning empty windows (beyond the lookback limit).
 *
 * Usage: node scripts/signal-lab/fetch-history.js [SYMBOL=NDX] [--freq 1|5|15|30] [--days N=45]
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { MarketApiClient } = require('schwab-client-js');

const DATA = path.join(__dirname, '../../signal-lab-data');
const INDEX_SYMBOLS = new Set(['NDX', 'SPX', 'RUT', 'DJX', 'OEX', 'VIX']);
const CHUNK_DAYS = 10; // calendar days per priceHistory call

const args = process.argv.slice(2);
const symbol = (args.find(a => !a.startsWith('--')) || 'NDX').toUpperCase();
const freq = intArg('--freq', 1);
const days = intArg('--days', 45);
const apiSymbol = INDEX_SYMBOLS.has(symbol) ? `$${symbol}` : symbol;
const RAW = path.join(DATA, `raw-${freq}m`);

function intArg(flag, def) { const i = args.indexOf(flag); return i >= 0 ? parseInt(args[i + 1], 10) : def; }
const etDate = ms => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
function etMinute(ms) {
  const s = new Date(ms).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' });
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}
// Group a chunk's candles into ET trading days, RTH only (09:30-16:00), zeros dropped, sorted.
function groupByEtDayRth(candles) {
  const byDate = new Map();
  for (const c of candles) {
    if (!(c.open || c.high || c.low || c.close)) continue;
    const mn = etMinute(c.datetime);
    if (mn < 570 || mn >= 960) continue;
    const dt = etDate(c.datetime);
    if (!byDate.has(dt)) byDate.set(dt, []);
    byDate.get(dt).push(c);
  }
  for (const arr of byDate.values()) arr.sort((a, b) => a.datetime - b.datetime);
  return byDate;
}
const cachedCount = () => (fs.existsSync(RAW) ? fs.readdirSync(RAW).filter(f => f.startsWith(`${symbol}-`) && f.endsWith('.json')).length : 0);

(async () => {
  if (!process.env.SCHWAB_REFRESH_TOKEN) { console.error('Missing SCHWAB_* env in .env'); process.exit(1); }
  const client = new MarketApiClient(process.env.SCHWAB_CLIENT_ID, process.env.SCHWAB_CLIENT_SECRET, process.env.SCHWAB_REFRESH_TOKEN);
  fs.mkdirSync(RAW, { recursive: true });

  const today = new Date();
  let fetched = 0, emptyStreak = 0, errors = 0;
  const maxChunks = Math.ceil((days * 1.8) / CHUNK_DAYS) + 1;
  console.log(`Fetching ${symbol} (${apiSymbol}) ${freq}m history — target ${days} trading days, ${CHUNK_DAYS}-day chunks\n`);

  for (let c = 0; c < maxChunks && cachedCount() < days && emptyStreak < 2; c++) {
    const endD = new Date(today); endD.setDate(today.getDate() - c * CHUNK_DAYS);
    const startD = new Date(today); startD.setDate(today.getDate() - (c + 1) * CHUNK_DAYS);
    const startDate = new Date(startD.getFullYear(), startD.getMonth(), startD.getDate(), 0, 0, 0).getTime();
    const endDate = new Date(endD.getFullYear(), endD.getMonth(), endD.getDate(), 23, 59, 59, 999).getTime();
    try {
      const resp = await client.priceHistory(apiSymbol, { frequencyType: 'minute', frequency: freq, startDate, endDate });
      const byDate = groupByEtDayRth((resp && resp.candles) || []);
      if (byDate.size === 0) { emptyStreak++; continue; }
      emptyStreak = 0;
      for (const [date, arr] of [...byDate].sort((a, b) => (a[0] < b[0] ? 1 : -1))) {
        const file = path.join(RAW, `${symbol}-${date}.json`);
        if (fs.existsSync(file)) continue;
        fs.writeFileSync(file, JSON.stringify({ symbol, date, freq, candles: arr }));
        fetched++;
        process.stdout.write(`  ${date}: ${arr.length} ${freq}m candles\n`);
      }
    } catch (e) {
      errors++;
      process.stdout.write(`  chunk ending ${etDate(endDate)}: ERROR ${e.message}\n`);
      if (errors > 3) { console.error('\nToo many errors (token expired?), aborting.'); break; }
    }
    await new Promise(r => setTimeout(r, 300));
  }
  console.log(`\ndone: ${fetched} day-files written, ${cachedCount()} total cached, ${errors} errors`);
  console.log(`cache: ${RAW}`);
})();
