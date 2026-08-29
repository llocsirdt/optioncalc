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

const DATA_DIR = (() => { const i = process.argv.indexOf('--dataDir'); return i >= 0 ? process.argv[i + 1] : path.join(__dirname, '..', '..', 'tests', 'backtest', 'backtest-data'); })();
const TFS = ['1m', '5m', '15m', '60m'];

// v4 cfg from the CLI: --revFrac X (shortcut) and/or --cfg key=val,key=val (general). Numeric values
// are coerced; anything set here is passed straight into v4Signal's cfg (grind/candle/active-cover gates).
function parseCfg() {
  const cfg = {};
  const ri = process.argv.indexOf('--revFrac');
  if (ri >= 0) cfg.reversalFrac = Number(process.argv[ri + 1]);
  const ci = process.argv.indexOf('--cfg');
  if (ci >= 0 && process.argv[ci + 1]) {
    for (const kv of process.argv[ci + 1].split(',')) {
      const [k, v] = kv.split('=');
      if (k) cfg[k.trim()] = v === undefined ? true : (isNaN(Number(v)) ? v : Number(v));
    }
  }
  return cfg;
}
const CFG = parseCfg();
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
// onBar(evt) — optional per-bar trace callback (debugging one day; see trace-day.js). No-op by default.
function runDay(bars, signalFn, onBar) {
  const st = { dir: 'none', positions: [] };
  const ivOf = A => bs.ivFromRelBandWidth((A['15m'].bbupper - A['15m'].bblower) / A['15m'].close);
  let coversPlaced = 0;

  for (let i = 0; i < bars.length; i++) {
    const A = bars[i].analysis, S = A['15m'].close, tau = bs.tauFromTime(bars[i].dt), iv = ivOf(A);
    const heldBefore = st.dir;
    const filledThisBar = [];

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
        pos.coverFillPrice = ext;   // price extreme at fill → how deep ITM the short strike was (Q3 credit-cover choice)
        filledThisBar.push(pos.side);
      }
    }

    // (b) signal
    const sig = signalFn(A, i > 0 ? bars[i - 1].analysis : null, { heldDir: st.dir });

    // (c) cover (reversal): place resting covers on all uncovered positions
    let placedThisBar = 0;
    if (sig.cover) {
      for (const pos of st.positions) {
        if (pos.covered || pos.pendingCover) continue;
        pos.pendingCover = { legs: coverLegs(pos.side, pos.shortStrike), target: round2(WIDTH - pos.limit) };
        coversPlaced++; placedThisBar++;
      }
      st.dir = 'none';
    }
    // (d) open
    let openedThisBar = null;
    if (sig.openSide && (st.dir === 'none' || st.dir === sig.openSide)) {
      const o = buildOpen(sig.openSide, S, tau, iv);
      st.positions.push({ side: sig.openSide, shortStrike: o.shortStrike, legs: o.legs, limit: o.limit, covered: false, pendingCover: null, coverLegs: null, coverLimit: null });
      st.dir = sig.openSide; openedThisBar = sig.openSide;
    }

    if (onBar) onBar({
      i, dt: bars[i].dt, A, S, heldBefore, heldAfter: st.dir, sig,
      filledThisBar, placedThisBar, openedThisBar,
      naked: st.positions.filter(p => !p.covered && !p.pendingCover).length,
      resting: st.positions.filter(p => p.pendingCover).length,
    });
  }

  // settle at day's final 15m close
  const settle = bars[bars.length - 1].analysis['15m'].close;
  let floor = 0, terminal = 0, opens = 0, filled = 0, naked = 0;
  let openCap = 0, coverCap = 0;   // debit capital deployed (× multiplier); nothing closes intraday so this is the day's peak
  const ledger = [];               // per-position detail (Q3 credit-cover + Q4 regime analysis)
  for (const pos of st.positions) {
    opens++;
    openCap = round2(openCap + pos.limit * 100 * QTY);
    let value = legsPayoff(pos.legs, settle), cost = pos.limit;
    const rec = { side: pos.side, shortStrike: pos.shortStrike, openLimit: pos.limit, covered: false, coverLimit: null, coverITM: null };
    if (pos.covered && pos.coverLegs) {
      value += legsPayoff(pos.coverLegs, settle); cost += pos.coverLimit;
      coverCap = round2(coverCap + pos.coverLimit * 100 * QTY);
      floor = round2(floor + (WIDTH - pos.limit - pos.coverLimit) * 100 * QTY); filled++;
      rec.covered = true; rec.coverLimit = pos.coverLimit;
      // how deep ITM the short strike was when the cover filled (bull: fillPrice-shortStrike, bear: mirror)
      rec.coverITM = pos.coverFillPrice != null ? round2(pos.side === 'bull' ? pos.coverFillPrice - pos.shortStrike : pos.shortStrike - pos.coverFillPrice) : null;
    } else naked++;
    terminal = round2(terminal + (value - cost) * 100 * QTY);
    ledger.push(rec);
  }
  // orders = spread tickets (each is 2 legs); contracts = option contracts traded (2 per spread).
  const orders = opens + filled, contracts = orders * 2 * QTY, capital = round2(openCap + coverCap);
  return { floor, terminal, opens, filled, naked, coversPlaced, settle, openCap, coverCap, capital, orders, contracts, ledger };
}

// Load each day-file in `dir` as { date, bars:[{dt,analysis}] } at 15m closes (shared by analysis scripts).
function loadDays(dir = DATA_DIR) {
  const files = fs.readdirSync(dir).filter(f => /^backtest-NDX-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  const out = [];
  for (const f of files) {
    const arr = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const bars = arr.filter(x => warm(x.analysis) && x.datetime != null)
      .filter(x => new Date(x.datetime).getMinutes() % 15 === 0)   // 15m closes
      .map(x => ({ dt: x.datetime, analysis: x.analysis }));
    if (bars.length < 5) continue;
    out.push({ date: etDay(bars[0].dt), bars });
  }
  return out;
}

function main() {
  const rows = loadDays().map(d => {
    const v4fn = (A, p, ctx) => v4Signal(A, p, { ...ctx, cfg: CFG });
    return { date: d.date, v4: runDay(d.bars, v4fn), classic: runDay(d.bars, classicSignal) };
  });

  console.log(`v4 BACKTEST — ${rows.length} NDX days (15m closes, same tent+resting-fill+BS pricing; only the SIGNAL differs)`);
  console.log(`cfg: ${Object.keys(CFG).length ? JSON.stringify(CFG) : '(defaults)'}\n`);
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

module.exports = {
  runDay, buildOpen, coverLegs, legsPayoff, legsMark, classicSignal, loadDays,
  WIDTH, INCR, TICK, QTY, DATA_DIR, CFG, v4Signal, bs, round2, roundTick, etDay,
};

if (require.main === module) main();
