#!/usr/bin/env node
'use strict';
/**
 * Fetch a long daily $NDX history (daily frequency has multi-year lookback, unlike 1m's ~48 days)
 * for the Q4 regime analysis. Writes an array of {open,high,low,close,volume,datetime} to the given
 * path. Usage: node scripts/signal-lab/fetch-daily.js [out.json] [SYMBOL=NDX] [--days 400]
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { MarketApiClient } = require('schwab-client-js');
const fs = require('fs');

const args = process.argv.slice(2);
const out = args.find(a => !a.startsWith('--') && a.endsWith('.json')) || 'ndx-daily.json';
const sym = (args.find(a => !a.startsWith('--') && !a.endsWith('.json')) || 'NDX').toUpperCase();
const di = args.indexOf('--days'); const days = di >= 0 ? parseInt(args[di + 1], 10) : 400;
const apiSym = ['NDX', 'SPX', 'RUT', 'VIX'].includes(sym) ? `$${sym}` : sym;

(async () => {
  if (!process.env.SCHWAB_REFRESH_TOKEN) { console.error('Missing SCHWAB_* in .env'); process.exit(1); }
  const c = new MarketApiClient(process.env.SCHWAB_CLIENT_ID, process.env.SCHWAB_CLIENT_SECRET, process.env.SCHWAB_REFRESH_TOKEN);
  const end = Date.now(), start = end - days * 86400 * 1000;
  const r = await c.priceHistory(apiSym, { periodType: 'year', frequencyType: 'daily', frequency: 1, startDate: start, endDate: end });
  const cs = (r && r.candles) || [];
  fs.writeFileSync(out, JSON.stringify(cs));
  const f = ms => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  console.log(`${cs.length} daily ${sym} candles → ${out}` + (cs.length ? `  (${f(cs[0].datetime)} .. ${f(cs[cs.length - 1].datetime)})` : ''));
})();
