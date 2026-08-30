#!/usr/bin/env node
'use strict';
/**
 * v9 — a SIMPLE multi-timeframe mean-reversion STAB strategy (no tents/covers). At each 5m step,
 * check the 5m, 15m and 60m candles INDEPENDENTLY against their OWN Bollinger bands: whenever a
 * (new) candle's wick extends BELOW its lower band → open a BULL call spread (fade the dip); whenever
 * one extends ABOVE its upper band → open a BEAR put spread (fade the pop). No covering — the bets
 * just ride to settle. Thesis: in chop, stabs above/below roughly balance → risk ~neutral, and if
 * price CLOSES in the middle of the range the accumulated bulls (from lows) + bears (from highs) form
 * a very wide implicit condor that pays. Should SHINE in chop, BLEED in strong trends (fades lose).
 *
 * Reuses the same ATM spread geometry + BS settlement as the tent engine (buildOpen, legsPayoff).
 * Usage: node scripts/candle-spread/backtest-v9-5m.js --dataDir <5m dir> [--tfs 5m,15m,60m] [--window]
 */
const eng = require('./backtest-v4');
const { load5mDays } = require('./backtest-v6-5m');
const bs = eng.bs, { WIDTH, QTY } = eng, buildOpen = eng.buildOpen, legsPayoff = eng.legsPayoff;

const di = process.argv.indexOf('--dataDir');
const DIR = di >= 0 ? process.argv[di + 1] : eng.DATA_DIR;
const ti = process.argv.indexOf('--tfs');
const TFS = ti >= 0 ? process.argv[ti + 1].split(',') : ['5m', '15m', '60m'];
const days = load5mDays(DIR);
const ymd = ms => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const usd = n => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');

// run one day: fade every fresh band-stab across the chosen TFs; no covers; settle at the last 5m close.
// opts.maxImbalance (optional): don't open a fade that would push |bulls−bears| beyond it — enforces
// the "keep the stabs balanced" thesis, so a one-sided TREND day stops adding losing fades.
function runDay9(bars, opts = {}) {
  const maxImb = opts.maxImbalance != null ? opts.maxImbalance : Infinity;
  const positions = [];
  const last = {};   // per-TF signature of the last-seen candle (detect a NEW candle)
  let bullStabs = 0, bearStabs = 0, nBull = 0, nBear = 0;
  for (let i = 0; i < bars.length; i++) {
    const A = bars[i].analysis, S = A['5m'].close, tau = bs.tauFromTime(bars[i].dt);
    const iv = bs.ivFromRelBandWidth((A['15m'].bbupper - A['15m'].bblower) / A['15m'].close);
    for (const tf of TFS) {
      const c = A[tf];
      if (!c || c.bblower == null || c.bbupper == null) continue;
      const sig = `${c.open}|${c.high}|${c.low}|${c.close}`;
      if (sig === last[tf]) continue;   // same candle we already evaluated → skip
      last[tf] = sig;
      if (c.low < c.bblower && (nBull - nBear) < maxImb) { const o = buildOpen('bull', S, tau, iv); positions.push({ legs: o.legs, limit: o.limit }); bullStabs++; nBull++; }
      if (c.high > c.bbupper && (nBear - nBull) < maxImb) { const o = buildOpen('bear', S, tau, iv); positions.push({ legs: o.legs, limit: o.limit }); bearStabs++; nBear++; }
    }
  }
  const settle = bars[bars.length - 1].analysis['5m'].close;
  let terminal = 0;
  for (const p of positions) terminal = Math.round((terminal + (legsPayoff(p.legs, settle) - p.limit) * 100 * QTY) * 100) / 100;
  return { terminal, opens: positions.length, bullStabs, bearStabs, settle };
}

const inWin = d => { const dt = ymd(d.bars[0].dt); return dt >= '2026-02-12' && dt <= '2026-02-24'; };
function report(label, subset) {
  let t = 0, cum = 0, pk = 0, dd = 0, w = 1e9, best = -1e9, o = 0, neg = 0;
  for (const d of subset) { const r = runDay9(d.bars); t += r.terminal; cum += r.terminal; pk = Math.max(pk, cum); dd = Math.max(dd, pk - cum); w = Math.min(w, r.terminal); best = Math.max(best, r.terminal); o += r.opens; if (r.terminal < 0) neg++; }
  console.log(`${label.padEnd(22)} total ${usd(t).padEnd(11)} maxDD ${usd(dd).padEnd(10)} worst ${usd(w).padEnd(10)} best ${usd(best).padEnd(9)} avg/day ${usd(t / subset.length).padEnd(8)} opens/d ${(o / subset.length).toFixed(1).padEnd(6)} neg ${neg}/${subset.length}`);
}

module.exports = { runDay9 };

if (require.main === module) {
  console.log(`v9 STAB (mean-reversion, no covers) — TFs [${TFS.join(',')}], ${days.length} days, QTY=1\n`);
  report('ALL DAYS', days);
  report('mid-Feb CHOP window', days.filter(inWin));
  console.log('\nper-day (mid-Feb chop window):  date        terminal   opens  bull/bear stabs');
  for (const d of days.filter(inWin)) { const r = runDay9(d.bars); console.log('  ' + ymd(d.bars[0].dt).padEnd(12) + usd(r.terminal).padStart(9) + '   ' + String(r.opens).padStart(3) + '    ' + r.bullStabs + '/' + r.bearStabs); }
}
