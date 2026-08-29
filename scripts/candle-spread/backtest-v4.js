#!/usr/bin/env node
'use strict';
/**
 * v4 backtest — runs the v4 multi-timeframe signal (v4-signals.js) over the 49 NDX days, using the
 * SAME tent-cover geometry + resting-fill model + BS pricing as v3, so the only difference vs the
 * "classic" (v0-v3-style green-breaks-high / any-reversal) signal is the DECISION logic. Reports
 * floor/terminal for both, side by side, to isolate the signal's effect.
 *
 * Data: tests/backtest/backtest-data/*.json (per-minute, multi-TF BB/EMA already computed). Decisions
 * are taken at 15m closes (minute % 15 === 0). Options priced with bs-pricer at the NDX close.
 *
 * Usage: node scripts/candle-spread/backtest-v4.js
 */
const fs = require('fs');
const path = require('path');
const bs = require('../../server/src/candle-spread/bs-pricer');
const { v4Signal } = require('./v4-signals');

const DATA_DIR = path.join(__dirname, '..', '..', 'tests', 'backtest', 'backtest-data');
const TFS = ['1m', '5m', '15m', '60m'];
const WIDTH = 20, INCR = 10, TICK = 0.05, QTY = 1;
const round2 = n => Math.round(n * 100) / 100;
const roundTick = p => Math.max(TICK, Math.round(p / TICK) * TICK);
const money = n => (n < 0 ? '-$' : '+$') + Math.abs(Math.round(n));
const warm = a => a && TFS.every(tf => a[tf] && a[tf].bbupper != null && a[tf].bblower != null && a[tf].ema != null);
const etDay = ms => new Date(ms).toLocaleDateString('en-US', { timeZone: 'America/New_York' });

// --- option pricing helpers (BS) ---
function legsPayoff(legs, S) { let v = 0; for (const l of legs) { const it = l.type === 'C' ? Math.max(S - l.strike, 0) : Math.max(l.strike - S, 0); v += (l.side === 'long' ? 1 : -1) * it; } return v; }
function legsMark(legs, S, tau, iv) { let v = 0; for (const l of legs) v += (l.side === 'long' ? 1 : -1) * bs.bsPrice(l.type, S, l.strike, tau, iv); return v; }

// open spread (ATM) for a side; returns { legs, shortStrike, limit }
function buildOpen(side, S, tau, iv) {
  const center = Math.floor(S / INCR) * INCR, lo = center - WIDTH / 2, hi = center + WIDTH / 2;
  const legs = side === 'bull'
    ? [{ side: 'long', type: 'C', strike: lo }, { side: 'short', type: 'C', strike: hi }]
    : [{ side: 'long', type: 'P', strike: hi }, { side: 'short', type: 'P', strike: lo }];
  const mark = legsMark(legs, S, tau, iv);
  const limit = round2(Math.min(WIDTH / 2 * 1.05, roundTick(mark)));   // debit cap like the engine
  return { legs, shortStrike: side === 'bull' ? hi : lo, limit: Math.max(TICK, limit) };
}
// tent cover legs (offsetting spread sharing the short strike)
function coverLegs(side, shortStrike) {
  return side === 'bull'
    ? [{ side: 'short', type: 'P', strike: shortStrike }, { side: 'long', type: 'P', strike: shortStrike + WIDTH }]
    : [{ side: 'short', type: 'C', strike: shortStrike }, { side: 'long', type: 'C', strike: shortStrike - WIDTH }];
}

// classic v3-style signal for the baseline comparison (same data)
function classicSignal(A, prior, ctx) {
  const c = A['15m']; if (!c || c.close == null) return { openSide: null, cover: false };
  const green = c.close >= c.open;
  const held = ctx.heldDir;
  // cover on a confirmed reversal (opposite color that didn't extend the prior extreme)
  let cover = false;
  if (prior && prior['15m']) {
    const p = prior['15m'];
    if (held === 'bull' && !green && !(c.high > p.high)) cover = true;
    if (held === 'bear' && green && !(c.low < p.low)) cover = true;
  }
  // open: continuation breakout
  let openSide = null;
  if (prior && prior['15m']) {
    const p = prior['15m'];
    if (green && c.high > p.high) openSide = 'bull';
    else if (!green && c.low < p.low) openSide = 'bear';
  }
  return { openSide, cover };
}

// --- run one day for one signal mode ---
function runDay(bars, signalFn) {
  const st = { dir: 'none', positions: [] };
  const ivOf = A => bs.ivFromRelBandWidth((A['15m'].bbupper - A['15m'].bblower) / A['15m'].close);

  for (let i = 0; i < bars.length; i++) {
    const A = bars[i].analysis, S = A['15m'].close, tau = bs.tauFromTime(bars[i].dt), iv = ivOf(A);

    // (a) resolve resting covers against THIS bar (fill when the cover marks ≤ target at the favorable wick extreme)
    for (const pos of st.positions) {
      if (!pos.pendingCover) continue;
      const pc = pos.pendingCover;
      const useHigh = pos.side === 'bull';   // bull cover (put spread) cheapens as price rises → bar high
      const ext = useHigh ? A['15m'].high : A['15m'].low;
      const markExt = legsMark(pc.legs, ext, tau, iv);
      if (markExt <= pc.target) {
        const markClose = legsMark(pc.legs, S, tau, iv);
        pos.coverLimit = roundTick(Math.min(pc.target, markClose + TICK));
        pos.coverLegs = pc.legs; pos.covered = true; pos.pendingCover = null;
      }
    }

    // (b) signal
    const sig = signalFn(A, i > 0 ? bars[i - 1].analysis : null, { heldDir: st.dir });

    // (c) cover (reversal): place resting covers on all uncovered positions
    if (sig.cover) {
      for (const pos of st.positions) {
        if (pos.covered || pos.pendingCover) continue;
        pos.pendingCover = { legs: coverLegs(pos.side, pos.shortStrike), target: round2(WIDTH - pos.limit) };
      }
      st.dir = 'none';
    }
    // (d) open
    if (sig.openSide && (st.dir === 'none' || st.dir === sig.openSide)) {
      const o = buildOpen(sig.openSide, S, tau, iv);
      st.positions.push({ side: sig.openSide, shortStrike: o.shortStrike, legs: o.legs, limit: o.limit, covered: false, pendingCover: null, coverLegs: null, coverLimit: null });
      st.dir = sig.openSide;
    }
  }

  // settle at day's final 15m close
  const settle = bars[bars.length - 1].analysis['15m'].close;
  let floor = 0, terminal = 0, opens = 0, filled = 0, naked = 0;
  for (const pos of st.positions) {
    opens++;
    let value = legsPayoff(pos.legs, settle), cost = pos.limit;
    if (pos.covered && pos.coverLegs) { value += legsPayoff(pos.coverLegs, settle); cost += pos.coverLimit; floor = round2(floor + (WIDTH - pos.limit - pos.coverLimit) * 100 * QTY); filled++; }
    else naked++;
    terminal = round2(terminal + (value - cost) * 100 * QTY);
  }
  return { floor, terminal, opens, filled, naked, settle };
}

function main() {
  const files = fs.readdirSync(DATA_DIR).filter(f => /^backtest-NDX-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  const rows = [];
  for (const f of files) {
    const arr = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
    const bars = arr.filter(x => warm(x.analysis) && x.datetime != null)
      .filter(x => new Date(x.datetime).getMinutes() % 15 === 0)   // 15m closes
      .map(x => ({ dt: x.datetime, analysis: x.analysis }));
    if (bars.length < 5) continue;
    rows.push({ date: etDay(bars[0].dt), v4: runDay(bars, v4Signal), classic: runDay(bars, classicSignal) });
  }

  console.log(`v4 BACKTEST — ${rows.length} NDX days (15m closes, same tent+resting-fill+BS pricing; only the SIGNAL differs)\n`);
  console.log('DATE         settle   v4 O/F/N   v4 floor/term      classic O/F/N  classic floor/term');
  console.log('-'.repeat(96));
  const tot = { v4: { f: 0, t: 0 }, classic: { f: 0, t: 0 } };
  let winsV4 = 0, winsClassic = 0;
  for (const r of rows) {
    tot.v4.f += r.v4.floor; tot.v4.t += r.v4.terminal; tot.classic.f += r.classic.floor; tot.classic.t += r.classic.terminal;
    if (r.v4.terminal > r.classic.terminal) winsV4++; else winsClassic++;
    console.log(r.date.padEnd(12) + String(Math.round(r.v4.settle)).padEnd(9) +
      `${r.v4.opens}/${r.v4.filled}/${r.v4.naked}`.padEnd(11) + `${money(r.v4.floor)}/${money(r.v4.terminal)}`.padEnd(19) +
      `${r.classic.opens}/${r.classic.filled}/${r.classic.naked}`.padEnd(15) + `${money(r.classic.floor)}/${money(r.classic.terminal)}`);
  }
  console.log('-'.repeat(96));
  console.log('TOTALS'.padEnd(21) + ''.padEnd(11) + `${money(tot.v4.f)}/${money(tot.v4.t)}`.padEnd(19) + ''.padEnd(15) + `${money(tot.classic.f)}/${money(tot.classic.t)}`);
  console.log(`\ncells = floor / terminal ; O/F/N = opens / covers-filled / naked.`);
  console.log(`daily terminal wins:  v4 ${winsV4}  ·  classic ${winsClassic}`);
}

main();
