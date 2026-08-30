#!/usr/bin/env node
'use strict';
/**
 * v10 — RANGE MODE: v9's multi-TF mean-reversion band-stab ENTRIES, but with a mean-reversion EXIT.
 * Fade a fresh candle wick beyond its band (below lower → bull call spread, above upper → bear put
 * spread), then CLOSE the spread at its mark once price reverts to the target — the entry timeframe's
 * CENTERLINE (20-SMA / BB midline) or 9EMA (opts.exit). This LOCKS the bounce that v9 gave back by
 * riding to settle. Positions that never reach the target settle at expiry. opts.maxImbalance keeps
 * the book balanced (the trend-day guard). A/B the two exit targets.
 *
 * Usage: node scripts/candle-spread/backtest-v10-5m.js --dataDir <5m dir>
 */
const eng = require('./backtest-v4');
const { load5mDays } = require('./backtest-v6-5m');
const bs = eng.bs, { WIDTH, TICK, QTY } = eng, buildOpen = eng.buildOpen, legsPayoff = eng.legsPayoff, legsMark = eng.legsMark, roundTick = eng.roundTick;

const di = process.argv.indexOf('--dataDir');
const DIR = di >= 0 ? process.argv[di + 1] : eng.DATA_DIR;
const TFS = ['5m', '15m', '60m'];
const days = load5mDays(DIR);
const ymd = ms => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const usd = n => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');

function runDay10(bars, opts = {}) {
  const target = opts.exit === '9ema' ? 'ema' : opts.exit === 'centerline' ? 'bbmiddle' : null;   // profit target level, or none
  const stopFrac = opts.stopFrac != null ? opts.stopFrac : null;   // stop-loss: close when mark <= stopFrac*openCost
  const maxImb = opts.maxImbalance != null ? opts.maxImbalance : Infinity;
  const pos = [];   // { legs, limit, side, tf, done, pl }
  const last = {};
  let nBull = 0, nBear = 0, exited = 0, stopped = 0;
  for (let i = 0; i < bars.length; i++) {
    const A = bars[i].analysis, S = A['5m'].close, tau = bs.tauFromTime(bars[i].dt);
    const iv = bs.ivFromRelBandWidth((A['15m'].bbupper - A['15m'].bblower) / A['15m'].close);
    // (1) EXIT — profit target (price reverted to the entry-TF mean) and/or stop-loss (mark decayed).
    for (const p of pos) {
      if (p.done) continue;
      const mark = legsMark(p.legs, S, tau, iv);
      const tgt = target && A[p.tf] ? A[p.tf][target] : null;
      const hitTarget = tgt != null && ((p.side === 'bull' && S >= tgt) || (p.side === 'bear' && S <= tgt));
      const hitStop = stopFrac != null && mark <= stopFrac * p.limit;
      if (hitTarget || hitStop) {
        p.pl = (roundTick(mark) - TICK - p.limit) * 100 * QTY;   // sell at mark (−1 tick)
        p.done = true; if (hitTarget) exited++; else stopped++;
      }
    }
    // (2) ENTER — fade fresh band stabs (balanced).
    for (const tf of TFS) {
      const c = A[tf]; if (!c || c.bblower == null) continue;
      const sig = `${c.open}|${c.high}|${c.low}|${c.close}`; if (sig === last[tf]) continue; last[tf] = sig;
      if (c.low < c.bblower && (nBull - nBear) < maxImb) { const o = buildOpen('bull', S, tau, iv); pos.push({ legs: o.legs, limit: o.limit, side: 'bull', tf, done: false, pl: 0 }); nBull++; }
      if (c.high > c.bbupper && (nBear - nBull) < maxImb) { const o = buildOpen('bear', S, tau, iv); pos.push({ legs: o.legs, limit: o.limit, side: 'bear', tf, done: false, pl: 0 }); nBear++; }
    }
  }
  const settle = bars[bars.length - 1].analysis['5m'].close;
  let terminal = 0;
  for (const p of pos) terminal += p.done ? p.pl : (legsPayoff(p.legs, settle) - p.limit) * 100 * QTY;
  return { terminal, opens: pos.length, exited };
}

function stats(arr) { let t = 0, cum = 0, pk = 0, dd = 0, w = 1e9, neg = 0; for (const x of arr) { t += x; cum += x; pk = Math.max(pk, cum); dd = Math.max(dd, pk - cum); w = Math.min(w, x); if (x < 0) neg++; } return { t, dd, w, neg, ret: dd > 0 ? t / dd : 0 }; }

// v6 daily for the parallel test
const { runDay5m } = require('./backtest-v6-5m');
const { v6Signal } = require('./v6-signals');
const v6t = days.map(d => runDay5m(d.bars, (A, p, c) => v6Signal(A, p, { ...c, cfg: { fiveMin: true } }), {}).terminal);

console.log(`v10 RANGE MODE (band-stab entries; exit = profit-target and/or stop-loss) — ${days.length} days, maxImbalance=5, QTY=1\n`);
console.log('exit rule                total       maxDD      worst      ret/maxDD   +v6 parallel (total/maxDD/ret)');
const configs = [
  ['ride to settle (v9)', {}],
  ['centerline target', { exit: 'centerline' }],
  ['9ema target', { exit: '9ema' }],
  ['stop-loss 0.5x', { stopFrac: 0.5 }],
  ['stop-loss 0.7x', { stopFrac: 0.7 }],
  ['9ema target + stop 0.5x', { exit: '9ema', stopFrac: 0.5 }],
];
for (const [label, o] of configs) {
  const arr = days.map(d => runDay10(d.bars, { ...o, maxImbalance: 5 }).terminal), s = stats(arr);
  const c = stats(v6t.map((x, i) => x + arr[i]));
  console.log(label.padEnd(25) + usd(s.t).padEnd(12) + usd(s.dd).padEnd(11) + usd(s.w).padEnd(11) + s.ret.toFixed(1).padEnd(12) + usd(c.t) + ' / ' + usd(c.dd) + ' / ' + c.ret.toFixed(1));
}
console.log(`\nv6 alone ret/maxDD ${stats(v6t).ret.toFixed(1)}. (parallel needs anti-correlation OR good standalone to help.)`);
