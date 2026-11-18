'use strict';
// ROSTER RULES (2026-11-18) — invariants decided by the user that a roster edit could silently undo. Each one is
// checked against the BUILT roster (buildRuns) and against what the backtest receives (optsFor).
//   - v0 / v1 / v2 keep their own cover placement at every width (no cover range, no 'inside' give-up); v3+ keep the
//     range at 20/40W (index.applyCoverStrikeChoice, COVER_GEOMETRY_BASELINES; user 2026-11-06).
//   - reopenOnCover on every v0-v9 shape and the v9sg/v9ob copies; off v12/v13 (natural) and v20/v21 (opens-only).
//   - simulateOnly on v9sg, v9ob, v12, v13, v20, v21 and on nothing else.
//   - the backtest never lowers a working cover (coverNeverLower with coverFillAtResting), like live; the trailing
//     give-up is an experiment that stays off unless a sweep env sets it.
const path = require('path'), fs = require('fs');
process.env.CANDLE_SPREAD_RUNS_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cs-roster-'));
const { buildRuns } = require('../../src/candle-spread/index');
const { optsFor } = require('../../src/candle-spread/backtest/opts-for');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const runs = buildRuns();
const fam = (v) => String(v.variant).split('-')[0];
const W = (v) => v.spreadWidth;

// 1) cover placement
const geo = { v0: 'tent', v1: 'halfway', v2: 'underlying' };
for (const v of runs.filter((r) => /^v[012]-/.test(r.variant))) {
  ok(v.coverRangeInside == null && v.coverRangeBeyond == null && v.giveUpGeometry == null,
    `${v.variant}: no cover range / inside give-up (own placement at every width)`);
  ok((v.coverGeometry || 'tent') === geo[fam(v)], `${v.variant}: coverGeometry ${v.coverGeometry} is ${geo[fam(v)]}`);
}
for (const v of runs.filter((r) => /^v[3-9]-/.test(r.variant) && W(r) >= 20)) {
  ok(v.coverRangeInside === 9 && v.giveUpGeometry === 'inside', `${v.variant}: keeps the cover range at ${W(v)}W`);
}
ok(new Set(runs.filter((r) => /^v[012]-20$/.test(r.variant)).map((r) => r.coverGeometry || 'tent')).size === 3,
  'v0/v1/v2 at 20W are three different placements');

// 2) reopen after cover
for (const v of runs) {
  const want = /^v[0-9](sg|ob)?-/.test(v.variant);
  ok(want ? v.reopenOnCover === true : v.reopenOnCover !== true, `${v.variant}: reopenOnCover ${v.reopenOnCover} (want ${want})`);
}

// 3) simulate-only
const SIM = /^v(9sg|9ob|12|13|20|21)-/;
for (const v of runs) ok(SIM.test(v.variant) ? v.simulateOnly === true : v.simulateOnly !== true, `${v.variant}: simulateOnly ${v.simulateOnly}`);

// 4) what the backtest receives
// opens-only (v20 / v21) have no covers at all; optsFor builds their own option set (opens-only.js).
for (const v of runs.filter((r) => r.simFillAtLimit && !r.opensOnly)) {
  const o = optsFor(v, { where: 'roster-rules test' });
  ok(o.coverFillAtResting === true && o.coverNeverLower === true, `${v.variant}: backtest covers never walk down (live parity)`);
  ok(o.giveUpTrail === undefined, `${v.variant}: trailing give-up off by default`);
  ok(/^v[0-9](sg|ob)?-/.test(v.variant) ? o.reopenOnCover === true : o.reopenOnCover !== true, `${v.variant}: reopen reaches the backtest`);
}
const one = runs.find((r) => r.variant === 'v7-40');
ok(optsFor(one, { where: 't', coverNeverLower: false }).coverNeverLower === false, 'env.coverNeverLower=false reproduces the old model');
ok(optsFor(one, { where: 't', giveUpTrail: 0.05 }).giveUpTrail === 0.05, 'env.giveUpTrail reaches the engine (sweep arm)');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
