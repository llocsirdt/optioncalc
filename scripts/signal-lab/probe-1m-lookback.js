#!/usr/bin/env node
'use strict';
/**
 * Probe how far back Schwab priceHistory serves 1-minute $NDX candles. Fetches a small window at
 * increasing lookback offsets and reports the candle count returned, so we can see where minute data
 * stops being available. Read-only. Usage: node scripts/signal-lab/probe-1m-lookback.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { MarketApiClient } = require('schwab-client-js');

const DAY = 86400 * 1000;
const OFFSETS = [5, 20, 35, 50, 65, 80, 95, 110, 140, 170, 200, 240]; // trading-ish days back (calendar)

(async () => {
  if (!process.env.SCHWAB_REFRESH_TOKEN) { console.error('Missing SCHWAB_* in .env'); process.exit(1); }
  const client = new MarketApiClient(process.env.SCHWAB_CLIENT_ID, process.env.SCHWAB_CLIENT_SECRET, process.env.SCHWAB_REFRESH_TOKEN);
  const now = Date.now();
  console.log('offset(cal.days)  window(ET)                     1m candles  first→last');
  for (const off of OFFSETS) {
    const endDate = now - off * DAY;
    const startDate = endDate - 3 * DAY; // 3-day window
    try {
      const resp = await client.priceHistory('$NDX', { frequencyType: 'minute', frequency: 1, startDate, endDate });
      const c = (resp && resp.candles) || [];
      const fmt = ms => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      const span = c.length ? `${fmt(c[0].datetime)} → ${fmt(c[c.length - 1].datetime)}` : '(none)';
      console.log(`${String(off).padStart(6)}            ${fmt(startDate)}..${fmt(endDate)}      ${String(c.length).padStart(6)}     ${span}`);
    } catch (e) {
      console.log(`${String(off).padStart(6)}            ERROR ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 400));
  }
})();
