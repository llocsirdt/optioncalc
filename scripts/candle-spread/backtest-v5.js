#!/usr/bin/env node
'use strict';
/**
 * v5 backtest — runs the v5 signal (v5-signals.js) against the FROZEN v4 baseline on the same
 * tent+resting-fill+BS engine (reused from backtest-v4.js, which stays the untouched baseline).
 * Only the signal differs, so this isolates v5's trend-flip cover + momentum gates.
 *
 * Usage: node scripts/candle-spread/backtest-v5.js [--dataDir D] [--cfg k=v,...]
 *   cfg passes through to v5Signal (trendFlip, flipMomentum, revTrendGate, revFrac, widenFrac, ...).
 */
const eng = require('./backtest-v4');           // frozen engine + v4Signal baseline
const { v5Signal } = require('./v5-signals');

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
const v5fn = (A, p, ctx) => v5Signal(A, p, { ...ctx, cfg: CFG });
const v4fn = eng.v4Signal;   // frozen baseline (its own defaults)

const rows = eng.loadDays(dir).map(d => ({ date: d.date, v5: eng.runDay(d.bars, v5fn), v4: eng.runDay(d.bars, v4fn) }));

console.log(`v5 vs FROZEN v4 — ${rows.length} NDX days (same engine; only the signal differs)`);
console.log(`v5 cfg: ${Object.keys(CFG).length ? JSON.stringify(CFG) : '(defaults)'}\n`);
console.log('DATE         settle   v5 O/F/N   v5 floor/term      v4 O/F/N   v4 floor/term');
console.log('-'.repeat(92));
const tot = { v5: { f: 0, t: 0 }, v4: { f: 0, t: 0 } };
let winV5 = 0, winV4 = 0;
for (const r of rows) {
  tot.v5.f += r.v5.floor; tot.v5.t += r.v5.terminal; tot.v4.f += r.v4.floor; tot.v4.t += r.v4.terminal;
  if (r.v5.terminal > r.v4.terminal) winV5++; else if (r.v4.terminal > r.v5.terminal) winV4++;
  console.log(r.date.padEnd(12) + String(Math.round(r.v5.settle)).padEnd(9) +
    `${r.v5.opens}/${r.v5.filled}/${r.v5.naked}`.padEnd(11) + `${money(r.v5.floor)}/${money(r.v5.terminal)}`.padEnd(19) +
    `${r.v4.opens}/${r.v4.filled}/${r.v4.naked}`.padEnd(11) + `${money(r.v4.floor)}/${money(r.v4.terminal)}`);
}
console.log('-'.repeat(92));
console.log('TOTALS'.padEnd(21) + `${money(tot.v5.f)}/${money(tot.v5.t)}`.padEnd(19) + ''.padEnd(0) + `${money(tot.v4.f)}/${money(tot.v4.t)}`.padStart(0));
console.log(`\ncells = floor / terminal ; O/F/N = opens / covers-filled / naked.`);
console.log(`daily terminal wins:  v5 ${winV5}  ·  v4 ${winV4}  ·  ties ${rows.length - winV5 - winV4}`);
