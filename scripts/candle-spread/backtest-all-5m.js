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
const { v7Signal } = require('./v7-signals');

const di = process.argv.indexOf('--dataDir');
const DIR = di >= 0 ? process.argv[di + 1] : eng.DATA_DIR;
const usd = n => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');

// act only at 15m closes (for the pre-5m signals); v6/v7 act every 5m. Each variant = { fn, opts }.
const at15 = fn => (A, p, ctx) => ctx.isFifteen === false ? { openSide: null, cover: false } : fn(A, p, { ...ctx, cfg: {} });
const variants = {
  classic: { fn: at15((A, p, ctx) => eng.classicSignal(A, p, ctx)) },
  v4: { fn: at15((A, p, ctx) => eng.v4Signal(A, p, ctx)) },
  v5: { fn: at15((A, p, ctx) => v5Signal(A, p, ctx)) },
  'v6 (5m)': { fn: (A, p, ctx) => v6Signal(A, p, { ...ctx, cfg: { fiveMin: true } }) },
  // v7 "be wrong" — the bidirectional variant, kept TRACKED (not deleted): its uncapped ceiling is
  // the high-return / high-drawdown target we're developing toward (~$262k / big DD). SHELVED as a
  // default (loses risk-adjusted to v6) but stays in the table so we never lose sight of it.
  'v7 be-wrong': { fn: (A, p, ctx) => v7Signal(A, p, { ...ctx, cfg: { fiveMin: true, beWrong: true } }), opts: { bidirectional: true } },
};

const days = load5mDays(DIR);
// NQ/24h data (has overnight bars) auto-enables rthActionOnly: 24h signal bands, RTH-only action —
// the faithful live model. NDX (RTH-only) has no overnight bars → no-op.
const etMin = ms => { const d = new Date(new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York' })); return d.getHours() * 60 + d.getMinutes(); };
const is24h = days.length && days[0].bars.some(b => { const m = etMin(b.dt); return m < 570 || m >= 960; });
const RO = is24h ? { rthActionOnly: true } : {};
console.log(`APPLES-TO-APPLES — ${days.length} ${is24h ? 'NQ 24h→RTH-action' : 'NDX'} days, one 5m engine (realistic per-5m fills), QTY=1, uncapped\n`);
console.log('variant'.padEnd(14) + 'floor'.padEnd(13) + 'terminal'.padEnd(13) + 'avg/day'.padEnd(11) + 'maxDD'.padEnd(12) + 'worst day'.padEnd(12) + 'neg days');
console.log('-'.repeat(84));
for (const [name, v] of Object.entries(variants)) {
  let floor = 0, terminal = 0, cum = 0, peak = 0, mdd = 0, worst = Infinity, neg = 0;
  for (const d of days) {
    const r = runDay5m(d.bars, v.fn, { ...RO, ...(v.opts || {}) });
    floor += r.floor; terminal += r.terminal;
    cum += r.terminal; peak = Math.max(peak, cum); mdd = Math.max(mdd, peak - cum);
    worst = Math.min(worst, r.terminal); if (r.terminal < 0) neg++;
  }
  console.log(name.padEnd(14) + usd(floor).padEnd(13) + usd(terminal).padEnd(13) +
    usd(terminal / days.length).padEnd(11) + usd(mdd).padEnd(12) + usd(worst).padEnd(12) + `${neg}/${days.length}`);
}
console.log('-'.repeat(84));
console.log('floor = guaranteed locked; terminal = actual at settle; maxDD = peak-to-trough of cumulative terminal.');
console.log('NOTE: v7 be-wrong is the high-ceiling target (uncapped); shelved as default but tracked. Risk layers (v7 cap, v8 two-cap) are separate — see backtest-v7-5m / backtest-v8-5m.');
