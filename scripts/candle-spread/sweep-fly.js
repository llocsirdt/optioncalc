#!/usr/bin/env node
'use strict';
/**
 * FLY SWEEP — should the fly/condor valley repair be on across the roster? (adapted from sweep-giveup.js)
 *
 * flyConvert sells a body to fund wings when the day's risk curve has a valley inside the expected band.
 * It runs on 30 variants as an A/B (v0/v2/v4/v6/v8 capped shapes + five -unc arms); v7/v9 capped are the
 * no-fly control. Arms: OFF and ON with the live parameters (minRatio 3, band 1.5 sigma, budget $1,500,
 * max 4/day, condors, before 15:00). Current roster otherwise (minLock width rule, give-up fleet-wide).
 *
 * ── give-up sweep header follows ──
 * GIVE-UP SWEEP — should cover give-up be on across the roster? (adapted from sweep-minlock.js)
 *
 * Give-up forces a resting cover to the market once the underlying runs `giveUpPoints` THROUGH the
 * position's short strike, accepting at most `giveUpMaxLoss` x width — "better a small loss than expiring
 * worthless". It ran on only 5 variants (no 10-wide), last measured 2026-09-10 (v9-20 +$489k, ret/DD
 * 69 -> 146) on an older engine. Arms: OFF, ON(10 pts, 5%) = the live setting, ON(20 pts, 10%) = later
 * trigger / larger concession. Every variant runs as configured otherwise (current roster incl. the
 * 2026-10-04 minLock width rule).
 *
 * ── original header follows ──
 * MINLOCK SWEEP — should the whole roster run ONE continuousCoverMinLockFrac, and which?
 *
 * The roster mixes 0.10 (38 variants), 0.20 (36), 0.25 (4) and 0.35 (2), alternating by WIDTH inside each
 * family — so a cross-width comparison mixes two dials. The last measurement (2026-09-12, v7-10 only) put
 * 0.10 ahead of 0.20 on total, fill and ret/DD, but it predates the 2026-10-02 ladder pace ($0.05 / 120s /
 * 10 pts), the open-ladder pacing and the governor changes, never measured 0.15, and showed lower minLock
 * COSTING total on uncapped variants. This re-measures the whole roster on the current engine.
 *
 * (minLock header) Each variant runs as configured (live roster via buildRuns -> optsFor), with ONLY the minLock fraction
 * overridden: 0.10, 0.15, 0.20, plus its CURRENT value when that is none of those. Measurement only — the
 * roster and the baselines are not touched.
 *
 * Metrics (765 days, NQ 24h signal, RTH action): total, avg/day, worst day, max drawdown (peak-to-trough
 * of cumulative P&L), ret/DD = total / |maxDD|, win rate, cover fill = filled / (filled + still pending
 * at the close), opens/day.
 *
 * Usage: node scripts/candle-spread/sweep-fly.js --workers 8 [--dataDir <5m dir>] [--only v7-10,v4-10]
 */
const fs = require('fs');
const path = require('path');
const { parallelMap } = require('./lib/parallel');

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const ROOT = path.join(__dirname, '..', '..');
const DIR = arg('--dataDir', path.join(ROOT, 'tests', 'backtest', 'backtest-data-5m-nq'));
const ONLY = arg('--only', null) ? arg('--only', null).split(',') : null;
const ARMS = ['off', 'on'];
const FLY_ON = { flyConvert: true, flyMinRatio: 3, flyBandSig: 1.5, flyBudget: 1500, flyMaxPerDay: 4, flyCondors: true, flyBeforeMin: 15 * 60 };
const ARM_CFG = { off: { flyConvert: false }, on: FLY_ON };

process.env.CANDLE_SPREAD_RUNS_DIR = process.env.CANDLE_SPREAD_RUNS_DIR || fs.mkdtempSync(path.join(require('os').tmpdir(), 'mls-'));
const SR = path.join(ROOT, 'server', 'src', 'candle-spread');
const { runDay5m, load5mDays } = require(path.join(SR, 'backtest', 'backtest-v6-5m'));
const { optsFor } = require(path.join(SR, 'backtest', 'opts-for'));
const { buildRuns } = require(path.join(SR, 'index'));

const etMin = (ms) => { const d = new Date(new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York' })); return d.getHours() * 60 + d.getMinutes(); };
const days = load5mDays(DIR).filter((d) => d.bars.some((b) => { const m = etMin(b.dt); return m >= 570 && m < 960; }));
const hasPx = days.some((d) => d.bars.some((b) => b.px));
const runs = buildRuns().filter((v) => !ONLY || ONLY.includes(v.variant));

const units = [];
for (const v of runs) {
  for (const a of ARMS) units.push({ key: `${v.variant}|${a}`, variant: v.variant, arm: a });
}

(async () => {
  const res = await parallelMap(units, (u) => {
    const v = { ...runs.find((r) => r.variant === u.variant), ...ARM_CFG[u.arm] };
    if (!v.flyConvert) for (const k of Object.keys(FLY_ON)) if (k !== 'flyConvert') delete v[k];
    const fn = (A, p, ctx) => v.signalFn(A, p, { ...ctx, cfg: v.signalCfg || {} });
    const o = optsFor(v, { intradayIV: true, hasPx, where: 'sweep-fly' });
    let filled = 0, pending = 0, opens = 0, best = 0, worstC = 0;
    const daily = days.map((d) => { const r = runDay5m(d.bars, fn, o); filled += r.filled; pending += r.coverPending || 0; opens += r.opens;
      best += r.bestCase || 0; worstC += r.worstCase || 0; return Math.round(r.terminal); });
    const wins = daily.filter((x) => x > 0), losses = daily.filter((x) => x < 0);
    let cum = 0, peak = 0, maxDD = 0;
    for (const x of daily) { cum += x; peak = Math.max(peak, cum); maxDD = Math.min(maxDD, cum - peak); }
    return { total: cum, avg: Math.round(cum / daily.length), worst: Math.min(...daily), maxDD,
      win: daily.filter((x) => x > 0).length / daily.length, fill: filled / Math.max(1, filled + pending), opensDay: opens / daily.length,
      avgWin: wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0, avgLoss: losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : 0,
      peakPot: best / daily.length, lossPot: worstC / daily.length };
  });

  const m$ = (n) => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString();
  const fam = (v) => v.match(/^v\d+/)[0];
  const kind = (v) => (/-unc$/.test(v) ? 'uncapped' : 'capped');
  console.log(`\nFLY SWEEP — ${runs.length} variants x ${ARMS.join(' / ')}, ${days.length} days, ${path.basename(DIR)}\n`);
  console.log('variant        live  ' + ARMS.map((a) => `| ${a.padEnd(4)}: total       worst    maxDD     ret/DD fill `).join('') + '| best');
  const best = {}; const agg = {};
  for (const v of runs) {
    const cells = ARMS.map((a) => res[`${v.variant}|${a}`]);
    const b = ARMS[cells.reduce((bi, c, i) => (c.total > cells[bi].total ? i : bi), 0)];
    best[b] = (best[b] || 0) + 1;
    for (const [i, a] of ARMS.entries()) {
      const k = `${kind(v.variant)}|${a}`; const c = cells[i];
      agg[k] = agg[k] || { total: 0, f: 0, n: 0, worst: 0, dd: 0 };
      agg[k].total += c.total; agg[k].f += c.fill; agg[k].n++; agg[k].worst += c.worst; agg[k].dd += c.maxDD;
    }
    const curNote = '';
    console.log(v.variant.padEnd(14) + (v.flyConvert ? 'on' : 'off').padEnd(6) + cells.map((c) =>
      `| ${m$(c.total).padStart(11)} ${m$(c.worst).padStart(8)} ${m$(c.maxDD).padStart(9)} ${(c.maxDD ? c.total / -c.maxDD : 0).toFixed(1).padStart(8)} ${(c.fill * 100).toFixed(0).padStart(3)}% `).join('') + `| ${b}${curNote}`);
  }
  console.log('\nBEST ARM BY TOTAL: ' + ARMS.map((a) => `${a} x${best[a] || 0}`).join(' · '));
  console.log('\nAGGREGATE (sum of totals; mean fill / worst / maxDD per variant)');
  for (const k of ['capped', 'uncapped']) {
    console.log('  ' + k.padEnd(9) + ARMS.map((a) => { const g = agg[`${k}|${a}`]; return g ? `${a}: ${m$(g.total)} fill ${(g.f / g.n * 100).toFixed(1)}% worst ${m$(g.worst / g.n)} maxDD ${m$(g.dd / g.n)}` : ''; }).join('   '));
  }
  console.log('\nBY FAMILY (capped only, sum of totals)');
  for (const f of [...new Set(runs.map((v) => fam(v.variant)))]) {
    const vs = runs.filter((v) => fam(v.variant) === f && kind(v.variant) === 'capped');
    console.log('  ' + f.padEnd(4) + ARMS.map((a) => `${a} ${m$(vs.reduce((s, v) => s + res[`${v.variant}|${a}`].total, 0)).padStart(12)} fill ${(vs.reduce((s, v) => s + res[`${v.variant}|${a}`].fill, 0) / vs.length * 100).toFixed(0)}%`).join('  '));
  }
  // RISK-CURVE SHAPE (the user's preferred lens): avg win day, avg loss day, payoff, avg peak / loss potential
  console.log('\nSHAPE (off -> on): avg win day | avg loss day | payoff | avg peak potential | avg loss potential');
  for (const v of runs) {
    const a = res[`${v.variant}|off`], b = res[`${v.variant}|on`];
    const pf = (x) => (x.avgLoss ? (x.avgWin / -x.avgLoss).toFixed(2) : '—');
    console.log(`  ${v.variant.padEnd(14)} ${m$(a.avgWin)} -> ${m$(b.avgWin)} | ${m$(a.avgLoss)} -> ${m$(b.avgLoss)} | ${pf(a)} -> ${pf(b)} | ${m$(a.peakPot)} -> ${m$(b.peakPot)} | ${m$(a.lossPot)} -> ${m$(b.lossPot)}`);
  }
  fs.writeFileSync(path.join(ROOT, 'signal-lab-data', 'sweep-fly-results.json'), JSON.stringify({ at: new Date().toISOString(), days: days.length, arms: ARMS, res }));
  console.log('\nraw results -> signal-lab-data/sweep-fly-results.json\n');
})();
