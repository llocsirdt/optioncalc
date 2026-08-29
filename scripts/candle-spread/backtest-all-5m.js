#!/usr/bin/env node
'use strict';
/**
 * Apples-to-apples: run the whole SIGNAL lineage (classic → v4 → v5 → v6) on the SAME 5m-step engine
 * (identical realistic per-5m fills), so every variant is measured on one honest yardstick. classic/
 * v4/v5 were designed for 15m-close decisions, so they act only at 15m closes here (intra-5m = flat);
 * v6 uses its native intra-5m action (fiveMin on). Reports floor/terminal + drawdown per variant.
 *
 * NOTE: these variants differ by SIGNAL. v0-v3 differ by COVER GEOMETRY (a single geometry is fixed
 * in this engine), so they aren't separable here — see backtest-tent.js for that family.
 *
 * Usage: node scripts/candle-spread/backtest-all-5m.js --dataDir <5m dir>
 */
const eng = require('./backtest-v4');
const { runDay5m, load5mDays } = require('./backtest-v6-5m');
const { v5Signal } = require('./v5-signals');
const { v6Signal } = require('./v6-signals');

const di = process.argv.indexOf('--dataDir');
const DIR = di >= 0 ? process.argv[di + 1] : eng.DATA_DIR;
const usd = n => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');

// act only at 15m closes (for the pre-5m signals); v6 acts every 5m.
const at15 = fn => (A, p, ctx) => ctx.isFifteen === false ? { openSide: null, cover: false } : fn(A, p, { ...ctx, cfg: {} });
const variants = {
  classic: at15((A, p, ctx) => eng.classicSignal(A, p, ctx)),
  v4: at15((A, p, ctx) => eng.v4Signal(A, p, ctx)),
  v5: at15((A, p, ctx) => v5Signal(A, p, ctx)),
  'v6 (5m)': (A, p, ctx) => v6Signal(A, p, { ...ctx, cfg: { fiveMin: true } }),
};

const days = load5mDays(DIR);
console.log(`APPLES-TO-APPLES — ${days.length} NDX days, one 5m engine (realistic per-5m fills), QTY=1\n`);
console.log('variant'.padEnd(12) + 'floor'.padEnd(13) + 'terminal'.padEnd(13) + 'avg/day'.padEnd(11) + 'maxDD'.padEnd(12) + 'worst day'.padEnd(12) + 'neg days');
console.log('-'.repeat(82));
for (const [name, fn] of Object.entries(variants)) {
  let floor = 0, terminal = 0, cum = 0, peak = 0, mdd = 0, worst = Infinity, neg = 0;
  for (const d of days) {
    const r = runDay5m(d.bars, fn);
    floor += r.floor; terminal += r.terminal;
    cum += r.terminal; peak = Math.max(peak, cum); mdd = Math.max(mdd, peak - cum);
    worst = Math.min(worst, r.terminal); if (r.terminal < 0) neg++;
  }
  console.log(name.padEnd(12) + usd(floor).padEnd(13) + usd(terminal).padEnd(13) +
    usd(terminal / days.length).padEnd(11) + usd(mdd).padEnd(12) + usd(worst).padEnd(12) + `${neg}/${days.length}`);
}
console.log('-'.repeat(82));
console.log('floor = guaranteed locked; terminal = actual at settle; maxDD = peak-to-trough of cumulative terminal.');
