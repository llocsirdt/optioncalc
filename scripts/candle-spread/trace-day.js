#!/usr/bin/env node
'use strict';
/**
 * Trace v4's bar-by-bar decisions for ONE day — to see exactly which rule fired (or didn't) and why
 * a cover/flip did or didn't happen. Prints, per 15m close: price, 15m candle color, the 5m
 * overextension read (botNorm/topNorm in band-widths + whether it closed back inside), the 1m
 * band-extension (grind read), the held direction, and the decision + any fills/placements/opens.
 *
 * Usage: node scripts/candle-spread/trace-day.js <M/D/YYYY | YYYY-MM-DD> [--dataDir D]
 */
const fs = require('fs');
const path = require('path');
const eng = require('./backtest-v4');
const conf = require('./confluence');

const dateArg = process.argv[2];
if (!dateArg) { console.error('usage: trace-day.js <date> [--dataDir D]'); process.exit(1); }
const di = process.argv.indexOf('--dataDir');
const dirs = di >= 0 ? [process.argv[di + 1]]
  : [eng.DATA_DIR, path.join(__dirname, '..', '..', 'tests', 'backtest', 'backtest-data-v2')];

// normalize the requested date to YYYY-MM-DD
const ymdOf = s => { const d = new Date(s); return isNaN(d) ? s : d.toLocaleDateString('en-CA'); };
const want = /^\d{4}-\d{2}-\d{2}$/.test(dateArg) ? dateArg : ymdOf(dateArg);

let found = null;
for (const dir of dirs) {
  if (!fs.existsSync(dir)) continue;
  for (const d of eng.loadDays(dir)) {
    if (new Date(d.bars[0].dt).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) === want) { found = { dir, d }; break; }
  }
  if (found) break;
}
if (!found) { console.error(`no data for ${want} in ${dirs.join(', ')}`); process.exit(1); }

const hhmm = ms => new Date(ms).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false });
const f0 = n => (n == null ? ' -- ' : String(Math.round(n)));
const f2 = n => (n == null ? ' -- ' : n.toFixed(2));

console.log(`TRACE ${want}  (${path.basename(found.dir)})  — v4 defaults\n`);
console.log('time   15m O/H/L/C            col  5m[lo..up]        botNorm topNorm  in?  1mExtUp/Dn   held  → decision                       action');
console.log('-'.repeat(150));

const v4fn = (A, p, ctx) => eng.v4Signal(A, p, { ...ctx, cfg: eng.CFG });
const r = eng.runDay(found.d.bars, v4fn, evt => {
  const A = evt.A, c = A['15m'], c5 = A['5m'];
  const col = c.close >= c.open ? 'grn' : 'red';
  const bw5 = c5 && c5.bbupper != null ? c5.bbupper - c5.bblower : null;
  const botNorm = bw5 > 0 ? (c5.bblower - c.low) / bw5 : null;   // >0 = 15m low beyond 5m lower band
  const topNorm = bw5 > 0 ? (c.high - c5.bbupper) / bw5 : null;
  const closedIn = c.close > (c5 ? c5.bblower : -Infinity) && c.close < (c5 ? c5.bbupper : Infinity);
  const ext = conf.bandExtension(A);
  const upExt = Math.max(ext.upper['5m'] ? ext.upper['5m'].pctOfOneWidth : -999, ext.upper['15m'] ? ext.upper['15m'].pctOfOneWidth : -999);
  const dnExt = Math.max(ext.lower['5m'] ? ext.lower['5m'].pctOfOneWidth : -999, ext.lower['15m'] ? ext.lower['15m'].pctOfOneWidth : -999);
  const acts = [];
  if (evt.filledThisBar.length) acts.push(`FILL ${evt.filledThisBar.join(',')}`);
  if (evt.placedThisBar) acts.push(`place ${evt.placedThisBar} cover`);
  if (evt.openedThisBar) acts.push(`OPEN ${evt.openedThisBar}`);
  acts.push(`[${evt.naked}n/${evt.resting}r]`);
  const ohlc = `${f0(c.open)}/${f0(c.high)}/${f0(c.low)}/${f0(c.close)}`;
  const b5 = c5 ? `${f0(c5.bblower)}..${f0(c5.bbupper)}` : '--';
  console.log(
    hhmm(evt.dt).padEnd(7) + ohlc.padEnd(22) + col.padEnd(5) + b5.padEnd(18) +
    f2(botNorm).padEnd(8) + f2(topNorm).padEnd(9) + (closedIn ? 'yes' : 'NO ').padEnd(5) +
    `${f0(upExt)}%/${f0(dnExt)}%`.padEnd(13) + evt.heldBefore.padEnd(6) + '→ ' + (evt.sig.reason || '').padEnd(32) + acts.join(' '));
});
console.log('-'.repeat(150));
console.log(`RESULT: floor ${eng.round2 ? '' : ''}$${Math.round(r.floor)}  terminal $${Math.round(r.terminal)}  · opens ${r.opens} / covers ${r.filled} / naked ${r.naked}`);
console.log(`legend: botNorm/topNorm = how far the 15m low/high reached beyond the 5m band, in band-widths (>=${eng.CFG.reversalFrac != null ? eng.CFG.reversalFrac : -0.15} triggers a reversal ONLY if "in?"=yes, i.e. closed back inside).`);
console.log(`        1mExtUp/Dn = 1m band beyond the 5m/15m channel as % of its own width (>=10% + a reversal candle = grind trigger). n=naked r=resting-cover.`);
