#!/usr/bin/env node
'use strict';
/**
 * v6 backtest — runs the v6 signal (v6-signals.js, faster trend read) against the FROZEN v5 baseline
 * on the same tent+resting-fill+BS engine (reused from backtest-v4.js). Only the signal differs.
 *
 * Usage: node scripts/candle-spread/backtest-v6.js [--dataDir D] [--cfg k=v,...]
 *   cfg passes to v6Signal (trendTf=5m|15m|both, revFrac, widenFrac, activeCoverRadius, ...).
 */
const eng = require('./backtest-v4');                 // frozen signal-agnostic engine
const { v6Signal } = require('./v6-signals');
const { v5Signal } = require('./v5-signals');         // frozen v5 baseline

function parseCfg() {
  const cfg = {};
  const ci = process.argv.indexOf('--cfg');
  if (ci >= 0 && process.argv[ci + 1]) {
    for (const kv of process.argv[ci + 1].split(',')) {
      const [k, v] = kv.split('=');
      if (k) cfg[k.trim()] = v === undefined ? true : (v === 'true' ? true : v === 'false' ? false : (isNaN(Number(v)) ? v : Number(v)));
    }
  }
  return cfg;
}
const CFG = parseCfg();
const di = process.argv.indexOf('--dataDir');
const dir = di >= 0 ? process.argv[di + 1] : eng.DATA_DIR;

const money = n => (n < 0 ? '-$' : '+$') + Math.abs(Math.round(n));
const v6fn = (A, p, ctx) => v6Signal(A, p, { ...ctx, cfg: CFG });
const v5fn = (A, p, ctx) => v5Signal(A, p, { ...ctx, cfg: {} });   // frozen v5 defaults

const rows = eng.loadDays(dir).map(d => ({ date: d.date, v6: eng.runDay(d.bars, v6fn), v5: eng.runDay(d.bars, v5fn) }));

console.log(`v6 vs FROZEN v5 — ${rows.length} NDX days (same engine; only the signal differs)`);
console.log(`v6 cfg: ${Object.keys(CFG).length ? JSON.stringify(CFG) : '(defaults: trendTf=5m)'}\n`);
console.log('DATE         settle   v6 O/F/N   v6 floor/term      v5 O/F/N   v5 floor/term');
console.log('-'.repeat(92));
const tot = { v6: { f: 0, t: 0 }, v5: { f: 0, t: 0 } };
let winV6 = 0, winV5 = 0;
for (const r of rows) {
  tot.v6.f += r.v6.floor; tot.v6.t += r.v6.terminal; tot.v5.f += r.v5.floor; tot.v5.t += r.v5.terminal;
  if (r.v6.terminal > r.v5.terminal) winV6++; else if (r.v5.terminal > r.v6.terminal) winV5++;
  console.log(r.date.padEnd(12) + String(Math.round(r.v6.settle)).padEnd(9) +
    `${r.v6.opens}/${r.v6.filled}/${r.v6.naked}`.padEnd(11) + `${money(r.v6.floor)}/${money(r.v6.terminal)}`.padEnd(19) +
    `${r.v5.opens}/${r.v5.filled}/${r.v5.naked}`.padEnd(11) + `${money(r.v5.floor)}/${money(r.v5.terminal)}`);
}
console.log('-'.repeat(92));
console.log('TOTALS'.padEnd(21) + `${money(tot.v6.f)}/${money(tot.v6.t)}`.padEnd(19) + `${money(tot.v5.f)}/${money(tot.v5.t)}`);
console.log(`\ncells = floor / terminal ; O/F/N = opens / covers-filled / naked.`);
console.log(`daily terminal wins:  v6 ${winV6}  ·  v5 ${winV5}  ·  ties ${rows.length - winV6 - winV5}`);
