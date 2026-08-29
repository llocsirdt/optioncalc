#!/usr/bin/env node
'use strict';
/**
 * v6 5m-STEP backtest — steps the engine every 5m (not 15m), pricing/filling/settling off the 5m
 * candle, so v6 can ACT between 15m closes on a confirmed 5m reversal (ctx.isFifteen=false on
 * intra-15m bars; see v6-signals.js). Compares v6-5m against the FROZEN v5 baseline, which is run on
 * the 15m-close subset of the same 5m dataset (identical underlying data). Tent geometry + resting-fill
 * + BS pricing are the same as the frozen engine; only the STEP and the signal differ.
 *
 * Data: a 5m-resolution dataset (build-analysis-dataset.js --step 5).
 * Usage: node scripts/candle-spread/backtest-v6-5m.js --dataDir <5m dir> [--cfg fiveMin=true,...]
 */
const fs = require('fs');
const path = require('path');
const eng = require('./backtest-v4');                         // geometry + pricing + frozen v5 runner
const { v6Signal } = require('./v6-signals');
const { v5Signal } = require('./v5-signals');
const bs = eng.bs, { WIDTH, INCR, TICK, QTY } = eng;
const roundTick = eng.roundTick, round2 = eng.round2;

function parseCfg() {
  const cfg = {}; const ci = process.argv.indexOf('--cfg');
  if (ci >= 0 && process.argv[ci + 1]) for (const kv of process.argv[ci + 1].split(',')) {
    const [k, v] = kv.split('='); if (k) cfg[k.trim()] = v === undefined ? true : (v === 'true' ? true : v === 'false' ? false : (isNaN(Number(v)) ? v : Number(v)));
  }
  return cfg;
}
const CFG = parseCfg();
const di = process.argv.indexOf('--dataDir');
const DIR = di >= 0 ? process.argv[di + 1] : path.join(__dirname, '..', '..', 'tests', 'backtest', 'backtest-data-5m-v2');
const money = n => (n < 0 ? '-$' : '+$') + Math.abs(Math.round(n));
const etDay = ms => new Date(ms).toLocaleDateString('en-US', { timeZone: 'America/New_York' });
const isFive = a => ['1m', '5m', '15m', '60m'].every(tf => a[tf] && a[tf].bbupper != null && a[tf].bblower != null && a[tf].ema != null);

// Load ALL 5m bars per day (not just 15m closes). Returns { date, bars:[{dt,analysis,fifteen}] }.
function load5mDays(dir) {
  const files = fs.readdirSync(dir).filter(f => /^backtest-NDX-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  const out = [];
  for (const f of files) {
    const arr = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const bars = arr.filter(x => x.datetime != null && isFive(x.analysis))
      .map(x => ({ dt: x.datetime, analysis: x.analysis, fifteen: new Date(x.datetime).getMinutes() % 15 === 0 }));
    if (bars.length < 5) continue;
    out.push({ date: etDay(bars[0].dt), bars });
  }
  return out;
}

const legsPayoff = eng.legsPayoff, legsMark = eng.legsMark, buildOpen = eng.buildOpen, coverLegs = eng.coverLegs;

// 5m-step run for one day. Prices off A['5m'].close; cover fills off the 5m candle's extreme.
// signalFn(A, prior, { heldDir, isFifteen }) → { openSide, cover }.
// opts.riskCap (v7 "be patient"): $ cap on UNCOVERED debit — pause opening new positions once the sum
//   of open debits on not-yet-covered positions would exceed it; covers free risk and re-enable opens.
// opts.bidirectional (v7 "be wrong"): allow opening the opposite side while holding the other.
function runDay5m(bars, signalFn, opts = {}) {
  const riskCap = opts.riskCap != null ? opts.riskCap : Infinity;
  const bidir = opts.bidirectional === true;
  const st = { dir: 'none', positions: [] };
  const ivOf = A => bs.ivFromRelBandWidth((A['15m'].bbupper - A['15m'].bblower) / A['15m'].close);
  const uncoveredRisk = () => st.positions.reduce((s, p) => s + (p.covered ? 0 : p.limit * 100 * QTY), 0);
  for (let i = 0; i < bars.length; i++) {
    const A = bars[i].analysis, c5 = A['5m'], S = c5.close, tau = bs.tauFromTime(bars[i].dt), iv = ivOf(A);
    for (const pos of st.positions) {                       // (a) resolve resting covers vs THIS 5m bar
      if (!pos.pendingCover) continue;
      const pc = pos.pendingCover, ext = pos.side === 'bull' ? c5.high : c5.low;
      if (legsMark(pc.legs, ext, tau, iv) <= pc.target) {
        pos.coverLimit = roundTick(Math.min(pc.target, legsMark(pc.legs, S, tau, iv) + TICK));
        pos.coverLegs = pc.legs; pos.covered = true; pos.pendingCover = null;
      }
    }
    const sig = signalFn(A, i > 0 ? bars[i - 1].analysis : null, { heldDir: st.dir, isFifteen: bars[i].fifteen });
    if (sig.cover) {                                        // (c) place resting covers on all uncovered
      for (const pos of st.positions) { if (pos.covered || pos.pendingCover) continue; pos.pendingCover = { legs: coverLegs(pos.side, pos.shortStrike), target: round2(WIDTH - pos.limit) }; }
      st.dir = 'none';
    }
    const dirOk = bidir || st.dir === 'none' || st.dir === sig.openSide;
    if (sig.openSide && dirOk) {                            // (d) open (subject to the risk cap)
      const o = buildOpen(sig.openSide, S, tau, iv);
      if (uncoveredRisk() + o.limit * 100 * QTY <= riskCap) {   // "be patient": pause opens over the cap
        st.positions.push({ side: sig.openSide, shortStrike: o.shortStrike, legs: o.legs, limit: o.limit, covered: false, pendingCover: null, coverLegs: null, coverLimit: null });
        st.dir = sig.openSide;
      }
    }
  }
  const settle = bars[bars.length - 1].analysis['5m'].close;
  let floor = 0, terminal = 0, opens = 0, filled = 0, naked = 0;
  for (const pos of st.positions) {
    opens++; let value = legsPayoff(pos.legs, settle), cost = pos.limit;
    if (pos.covered && pos.coverLegs) { value += legsPayoff(pos.coverLegs, settle); cost += pos.coverLimit; floor = round2(floor + (WIDTH - pos.limit - pos.coverLimit) * 100 * QTY); filled++; } else naked++;
    terminal = round2(terminal + (value - cost) * 100 * QTY);
  }
  return { floor, terminal, opens, filled, naked, settle };
}

// frozen v5 on the 15m-close subset of the same data (via the frozen engine)
function runV5_15m(bars) {
  const sub = bars.filter(b => b.fifteen).map(b => ({ dt: b.dt, analysis: b.analysis }));
  if (sub.length < 5) return { floor: 0, terminal: 0, opens: 0, filled: 0, naked: 0 };
  return eng.runDay(sub, (A, p, ctx) => v5Signal(A, p, { ...ctx, cfg: {} }));
}

module.exports = { runDay5m, load5mDays };

if (require.main === module) {
  const v6fn = (A, p, ctx) => v6Signal(A, p, { ...ctx, cfg: CFG });
  const rows = load5mDays(DIR).map(d => ({ date: d.date, v6: runDay5m(d.bars, v6fn), v5: runV5_15m(d.bars) }));
  console.log(`v6 5m-STEP vs FROZEN v5 (15m) — ${rows.length} NDX days`);
  console.log(`v6 cfg: ${Object.keys(CFG).length ? JSON.stringify(CFG) : '(defaults; add fiveMin=true to enable intra-5m)'}\n`);
  console.log('DATE         v6 O/F/N   v6 floor/term      v5 O/F/N   v5 floor/term');
  console.log('-'.repeat(78));
  const tot = { v6f: 0, v6t: 0, v5f: 0, v5t: 0 }; let wv6 = 0, wv5 = 0;
  for (const r of rows) {
    tot.v6f += r.v6.floor; tot.v6t += r.v6.terminal; tot.v5f += r.v5.floor; tot.v5t += r.v5.terminal;
    if (r.v6.terminal > r.v5.terminal) wv6++; else if (r.v5.terminal > r.v6.terminal) wv5++;
    console.log(r.date.padEnd(12) + `${r.v6.opens}/${r.v6.filled}/${r.v6.naked}`.padEnd(11) + `${money(r.v6.floor)}/${money(r.v6.terminal)}`.padEnd(19) +
      `${r.v5.opens}/${r.v5.filled}/${r.v5.naked}`.padEnd(11) + `${money(r.v5.floor)}/${money(r.v5.terminal)}`);
  }
  console.log('-'.repeat(78));
  console.log(`TOTALS      v6:  ${money(tot.v6f)} / ${money(tot.v6t)}      v5:  ${money(tot.v5f)} / ${money(tot.v5t)}`);
  console.log(`daily terminal wins:  v6 ${wv6}  ·  v5 ${wv5}  ·  ties ${rows.length - wv6 - wv5}`);
}
