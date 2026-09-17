#!/usr/bin/env node
'use strict';
/**
 * sweep-floor-protection.js — two ways to stop handing back a floor we already won, measured against the
 * same panel and the same control.
 *
 * BACKGROUND. On 2026-09-16 every one of 79 live variants gave back book floor between its intraday peak
 * and 15:00: $278,125 of fleet peak down to $48,995, 82% surrendered, 75 of 79 peaking at/after 14:00.
 * The first answer — an always-on give-back budget against the running peak — was measured over 765 days
 * and LOST $1.75M with the worst floor unmoved to the dollar. The diagnosis: it engages the moment a peak
 * exists, so it fires all through the productive 10:00-14:00 window and is dormant on the days that
 * actually set the worst floor. It was a profit-taker, not a risk control.
 *
 * So both arms here are time- or level-aware rather than always-on:
 *
 *   A  TIME-GATED RATCHET (floorRatchetAfterMin x floorGiveBackFrac)
 *      The same budget, but asleep until a clock time. Leaves the middle of the day alone and only
 *      defends the window where the give-back was actually observed.
 *
 *   B  FLOOR LOCK-AND-STOP (openFloorGate)
 *      Once the book's floor reaches a threshold, stop opening entirely and hold the guaranteed win.
 *      The user's framing: "a guaranteed win of at least 1 or 2k is not worth risking arbitrarily."
 *      Thresholds are WIDTH-NORMALISED (k x width x 100), because $2,000 of locked floor is a day's work
 *      on a $10-wide book and noise on a $40-wide one. openFloorGate already existed in the engine and
 *      has never been set by any variant — it is one of the dormant fields preflight reports.
 *
 * Both gate OPENS only; covers, offsets, wings and flies keep running, which is the point — stop adding
 * exposure, keep repairing what is there.
 *
 * Usage: node scripts/candle-spread/sweep-floor-protection.js [--variants a,b] [--arm A|B|both]
 */
const path = require('path');
const { runDay5m, load5mDays } = require('./backtest-v6-5m');
const { buildRuns } = require('../../server/src/candle-spread/index');
// THE SHARED MAPPING. Every hand-copied optsFor in this repo has silently dropped a capability sooner or
// later; this one is the same function the committed baselines are built with, so the control below is
// directly comparable to them rather than approximately so.
const { optsFor } = require('../../server/src/candle-spread/backtest/opts-for');

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const DIR = arg('--dataDir', path.join(__dirname, '..', '..', 'tests', 'backtest', 'backtest-data-5m-nq'));
const ARM = String(arg('--arm', 'both')).toUpperCase();
// A PANEL, not the whole fleet: 13 configs x 80 variants x 765 days is days of compute for no extra
// signal. These span all three widths, both geometries, and the signal families that behave differently
// (v1 classic, v6 multi-TF, v7/v9 bidirectional, v5 mid-range).
const PANEL = arg('--variants', 'v1-10,v7-10,v5-20,v6-20,v9-20,v0-40,v6-40,v9-40,v6-20-cATM,v9-40-cATM')
  .split(',').map((s) => s.trim()).filter(Boolean);

const days = load5mDays(DIR);
const HAS_PX = !!(days[0] && days[0].bars && days[0].bars[0] && days[0].bars[0].px);
const usd = (n) => (n == null ? '—' : (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US'));
const runs = buildRuns();
const ET = (h, m) => h * 60 + (m || 0);

// The arms. `label` is what prints; `apply` mutates the opts for one variant.
const CONFIGS = [{ label: 'control', arm: '-', apply: () => {} }];
if (ARM === 'A' || ARM === 'BOTH') {
  for (const [h, m] of [[14, 0], [14, 30], [15, 0], [15, 30]]) {
    for (const frac of [0.25, 0.50]) {
      CONFIGS.push({
        label: `A ratchet>${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} give${frac}`,
        arm: 'A',
        apply: (o, v) => {
          o.floorRatchet = true;
          o.floorGiveBackFrac = frac;
          o.floorRatchetAfterMin = ET(h, m);
          o.floorRatchetMinPeak = Math.max(1000, (v.spreadWidth || 20) * 100);
        },
      });
    }
  }
}
if (ARM === 'B' || ARM === 'BOTH') {
  // k x width x 100 -> $10-wide: 500/1000/1500/2000/3000; $40-wide: 2000/4000/6000/8000/12000.
  for (const k of [0.5, 1, 1.5, 2, 3]) {
    CONFIGS.push({
      label: `B lock&stop ${k}x width`,
      arm: 'B',
      apply: (o, v) => { o.openFloorGate = k * (v.spreadWidth || 20) * 100; },
    });
  }
}

function runOne(v, cfg) {
  const o = optsFor(v, { intradayIV: true, hasPx: HAS_PX, where: 'sweep-floor-protection optsFor' });
  cfg.apply(o, v);
  let total = 0, worst = Infinity, neg = 0, n = 0, blocked = 0, gated = 0;
  for (const d of days) {
    const r = runDay5m(d, o);
    if (!r) continue;
    const t = r.terminal != null ? r.terminal : (r.total != null ? r.total : 0);
    total += t; n++;
    if (t < worst) worst = t;
    if (t < 0) neg++;
    if (r.ratchet) blocked += r.ratchet.blocked || 0;
    if (r.gateFloor != null) gated += r.gateFloor;
  }
  return { total, avg: n ? total / n : 0, worst: worst === Infinity ? null : worst, neg, n, blocked, gated };
}

(function main() {
  console.log(`FLOOR-PROTECTION SWEEP — ${days.length} days, ${PANEL.length} variants, ${CONFIGS.length} configs\n`);
  const base = {};
  const rows = [];
  for (const cfg of CONFIGS) {
    let total = 0, worstSum = 0, negSum = 0, blocked = 0, gated = 0;
    const per = {};
    for (const name of PANEL) {
      const v = runs.find((r) => r.variant === name);
      if (!v) { console.error(`  (no such variant: ${name})`); continue; }
      const r = runOne(v, cfg);
      per[name] = r.total;
      total += r.total; worstSum += (r.worst || 0); negSum += r.neg; blocked += r.blocked; gated += r.gated;
    }
    if (cfg.label === 'control') Object.assign(base, per);
    const delta = total - PANEL.reduce((s, nm) => s + (base[nm] || 0), 0);
    rows.push({ ...cfg, total, delta, worstSum, negSum, blocked, gated, per });
    console.log(`  ${cfg.label.padEnd(26)} ${usd(total).padStart(13)}  ${(cfg.label === 'control' ? '' : usd(delta)).padStart(13)}`
      + `   worstSum ${usd(worstSum).padStart(11)}   negDays ${String(negSum).padStart(5)}`);
  }
  // Winners, by delta against the control.
  const ranked = rows.filter((r) => r.label !== 'control').sort((a, b) => b.delta - a.delta);
  console.log('\nRANKED (best first):');
  for (const r of ranked) console.log(`  ${r.label.padEnd(26)} ${usd(r.delta).padStart(13)}`);
  const best = ranked[0];
  console.log(`\nBEST: ${best ? best.label + '  ' + usd(best.delta) : '(none)'}`);
  if (best && best.delta <= 0) console.log('NO ARM BEATS THE CONTROL — both ideas fail on this panel.');
  console.log('\nPER-VARIANT for the best arm:');
  if (best) for (const nm of PANEL) {
    const d = (best.per[nm] || 0) - (base[nm] || 0);
    console.log(`  ${nm.padEnd(14)} ${usd(base[nm]).padStart(12)} -> ${usd(best.per[nm]).padStart(12)}   ${usd(d).padStart(11)}`);
  }
})();
