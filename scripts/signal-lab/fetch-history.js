#!/usr/bin/env node
'use strict';
/**
 * Fetch historical 1-minute candles from Schwab and cache them per trading day, so the offline
 * signal lab has a stable local dataset. Reuses the same path as the backtest work:
 * schwab-client-js MarketApiClient.priceHistory($NDX, {frequencyType:'minute', frequency:1,
 * startDate, endDate}), creds from the repo-root .env. 1m history is ~48 days max at Schwab, so
 * we pull per-day and cache; re-runs skip days already on disk.
 *
 * Usage: node scripts/signal-lab/fetch-history.js [SYMBOL=NDX] [--days N=45]
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { MarketApiClient } = require('schwab-client-js');

const DATA = path.join(__dirname, '../../signal-lab-data');
const RAW = path.join(DATA, 'raw-1m');
const INDEX_SYMBOLS = new Set(['NDX', 'SPX', 'RUT', 'DJX', 'OEX', 'VIX']);

const args = process.argv.slice(2);
const symbol = (args.find(a => !a.startsWith('--')) || 'NDX').toUpperCase();
const di = args.indexOf('--days');
const days = di >= 0 ? parseInt(args[di + 1], 10) : 45;
const apiSymbol = INDEX_SYMBOLS.has(symbol) ? `$${symbol}` : symbol;

const ymd = d => d.toLocaleDateString('en-CA');                    // machine-local YYYY-MM-DD
const isWeekday = d => d.getDay() >= 1 && d.getDay() <= 5;
const etDate = ms => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
function etMinute(ms) {
  const s = new Date(ms).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' });
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}
// Keep only the target ET day's RTH (09:30-16:00), drop zero/placeholder candles. Robust to the
// machine's own timezone because we filter by ET wall-clock, not local epoch-day boundaries.
function rthOf(candles, targetDate) {
  return candles
    .filter(c => (c.open || c.high || c.low || c.close))
    .filter(c => etDate(c.datetime) === targetDate && etMinute(c.datetime) >= 570 && etMinute(c.datetime) < 960)
    .sort((a, b) => a.datetime - b.datetime);
}

(async () => {
  if (!process.env.SCHWAB_REFRESH_TOKEN) { console.error('Missing SCHWAB_* env in .env'); process.exit(1); }
  const client = new MarketApiClient(process.env.SCHWAB_CLIENT_ID, process.env.SCHWAB_CLIENT_SECRET, process.env.SCHWAB_REFRESH_TOKEN);
  fs.mkdirSync(RAW, { recursive: true });

  const today = new Date();
  let fetched = 0, cached = 0, holidays = 0, errors = 0;
  console.log(`Fetching ${symbol} (${apiSymbol}) 1m history — target ${days} trading days\n`);

  for (let back = 1; back <= Math.ceil(days * 1.7) && (fetched + cached) < days; back++) {
    const d = new Date(today); d.setDate(today.getDate() - back);
    if (!isWeekday(d)) continue;
    const date = ymd(d);
    const file = path.join(RAW, `${symbol}-${date}.json`);
    if (fs.existsSync(file)) { cached++; continue; }

    // Widen the fetch window ±12h around the local day and let rthOf() pin the ET session,
    // so a non-ET machine can't clip the early/late candles.
    const startDate = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1, 12, 0, 0).getTime();
    const endDate = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 12, 0, 0).getTime();
    try {
      const resp = await client.priceHistory(apiSymbol, { frequencyType: 'minute', frequency: 1, startDate, endDate });
      const candles = rthOf((resp && resp.candles) || [], date);
      if (!candles.length) { holidays++; continue; } // holiday / no session
      fs.writeFileSync(file, JSON.stringify({ symbol, date, candles }));
      fetched++;
      process.stdout.write(`  ${date}: ${candles.length} 1m candles\n`);
    } catch (e) {
      errors++;
      process.stdout.write(`  ${date}: ERROR ${e.message}\n`);
      if (errors > 3) { console.error('\nToo many errors (token expired?), aborting.'); break; }
    }
    await new Promise(r => setTimeout(r, 300)); // pace the API
  }
  console.log(`\ndone: ${fetched} fetched, ${cached} cached, ${holidays} skipped (holiday/none), ${errors} errors`);
  console.log(`cache: ${RAW}`);
})();
