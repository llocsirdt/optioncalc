'use strict';
// NO LOSS CAP MAY SIT BELOW 1.5x ONE POSITION'S WIDTH.
//
// lossMax bounds RC.bookFloor — the day's worst case across every strike. A cap below what a SINGLE position
// can lose is incoherent: the governor must then block almost any open that could run the full width, so the
// variant stops trading instead of managing risk.
//
// v7-40 shipped at $3,000 against a $4,000 max loss on a 40-wide. Measured on 2026-09-29: 5.13 governor
// blocks per open (41 blocks, 8 opens all day), the worst cell in the family x width grid by 3x. The sweep
// agreed it was wrong — $8,000 returns $2.60M at ret/DD 50.8 where $3,000 returns $1.18M at 48.4, worse on
// BOTH axes. It was adopted from the sweep run whose control arm had degenerated into a copy of the treatment
// (b50e432), so 29 of 50 variants were never tested against anything looser than their own cap.
//
// A tuning pass can be wrong. This asserts the result is never INCOHERENT.
//
// Run: node server/tests/unit/candle-spread-lossmax-floor.test.js
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

// buildRuns logs the roster; keep the test output about the test.
const _log = console.log, _warn = console.warn;
const warnings = [];
console.log = () => {};
console.warn = (m) => { warnings.push(String(m)); };
const I = require('../../src/candle-spread/index');
const runs = I.buildRuns();
console.log = _log; console.warn = _warn;

ok(typeof I.lossMaxFloorFor === 'function', 'the rule is exported, not restated by callers');
ok(I.lossMaxFloorFor(10) === 1500, `W=10 floor is $1,500 (${I.lossMaxFloorFor(10)})`);
ok(I.lossMaxFloorFor(20) === 3000, `W=20 floor is $3,000 (${I.lossMaxFloorFor(20)})`);
ok(I.lossMaxFloorFor(40) === 6000, `W=40 floor is $6,000 (${I.lossMaxFloorFor(40)})`);
ok(I.LOSS_MAX_FLOOR_X_WIDTH === 1.5, 'and it is 1.5x one position, not 1x');

// ── THE INVARIANT, ON THE REAL ROSTER ───────────────────────────────────────────────────────────────
// Asserted on the BUILT roster rather than on TUNED_CAPS, because three different builders set lossMax
// (width-generic, the CAPPRES preset, TUNED_CAPS) and what matters is the value a variant actually trades.
ok(runs.length > 0, `the roster built (${runs.length} variants)`);
const capped = runs.filter((r) => r.lossMax != null && r.spreadWidth);
ok(capped.length > 0, `and some variants carry a cap (${capped.length})`);
const violations = capped.filter((r) => r.lossMax < I.lossMaxFloorFor(r.spreadWidth));
ok(violations.length === 0,
  `NO variant trades a cap below its floor — ${violations.map((r) => `${r.variant} W=${r.spreadWidth} lossMax=${r.lossMax} floor=${I.lossMaxFloorFor(r.spreadWidth)}`).join('; ') || 'none'}`);

// lossTarget must move with it, or the ratchet and the governor disagree about the same day.
const badTarget = capped.filter((r) => r.lossTarget != null && r.lossTarget > r.lossMax);
ok(badTarget.length === 0,
  `lossTarget never exceeds lossMax (${badTarget.map((r) => r.variant).join(', ') || 'none'})`);

// ── `-unc` MEANS NO GOVERNOR, AND null IS NOT "A SMALL CAP" ──────────────────────────────────────────
// The floor must not invent a cap for the uncapped arms — that would silently convert a deliberately
// ungoverned control into a governed one and destroy every A/B that rests on it.
{
  const unc = runs.filter((r) => /-unc$/.test(r.variant));
  ok(unc.length > 0, `there are uncapped arms (${unc.length})`);
  const governed = unc.filter((r) => r.lossMax != null);
  ok(governed.length === 0,
    `and the floor did NOT give any of them a cap (${governed.map((r) => r.variant).join(', ') || 'none'})`);
}

// ── A FLOORED CAP IS FLAGGED AND ANNOUNCED ──────────────────────────────────────────────────────────
// Silently raising a number someone tuned on purpose is how a roster drifts away from its own measurements.
{
  const floored = runs.filter((r) => r.lossMaxFloored);
  ok(floored.length > 0, `variants below the floor are marked lossMaxFloored (${floored.length})`);
  ok(floored.every((r) => r.lossMax === I.lossMaxFloorFor(r.spreadWidth)),
    'each is raised to exactly its floor, not to some other number');
  ok(floored.every((r) => r.lossTarget === Math.round(0.7 * r.lossMax)),
    'with lossTarget recomputed from the new cap');
  ok(warnings.filter((w) => /below the floor/.test(w)).length >= floored.length,
    `and each one warned on the way past (${warnings.filter((w) => /below the floor/.test(w)).length} warnings)`);
  // v7-40 is the case that motivated this. Pinned by name so a later roster edit cannot quietly undo it.
  const v740 = runs.find((r) => r.variant === 'v7-40');
  ok(v740 && v740.lossMax >= 6000,
    `v7-40 — the variant that ran at $3,000 against a $4,000 width — is at or above $6,000 (${v740 && v740.lossMax})`);
}

// ── AND A CEILING: $7,500 AT EVERY WIDTH ────────────────────────────────────────────────────────────
// lossMax is what a single day may lose, and the stated tolerance is ~$5-10k/day, so $9,000 sat at the top of
// the band. Flat across widths on purpose — the account does not care how wide the spread was.
{
  ok(I.LOSS_MAX_CEILING === 7500, `the ceiling is $7,500 (${I.LOSS_MAX_CEILING})`);
  const over = capped.filter((r) => r.lossMax > I.LOSS_MAX_CEILING);
  ok(over.length === 0,
    `NO variant trades a cap above the ceiling — ${over.map((r) => `${r.variant}=${r.lossMax}`).join(', ') || 'none'}`);
  const cappedDown = runs.filter((r) => r.lossMaxCapped);
  ok(cappedDown.length > 0, `variants above it are marked lossMaxCapped (${cappedDown.length})`);
  ok(cappedDown.every((r) => r.lossMax === I.LOSS_MAX_CEILING),
    'each sits exactly at the ceiling');
  ok(cappedDown.every((r) => r.lossTarget === Math.round(0.7 * r.lossMax)),
    'with lossTarget recomputed');
  // Every cap must now sit inside BOTH bounds — the whole point of having two.
  const inBand = capped.every((r) => r.lossMax >= I.lossMaxFloorFor(r.spreadWidth) && r.lossMax <= I.LOSS_MAX_CEILING);
  ok(inBand, 'every capped variant sits inside [floor, ceiling]');
  // A floored variant and a capped one are different things and must not both be flagged on one variant.
  const both = runs.filter((r) => r.lossMaxFloored && r.lossMaxCapped);
  ok(both.length === 0, `no variant is both floored and capped (${both.map((r) => r.variant).join(', ') || 'none'})`);
  // The bounds must not cross at any width we trade.
  for (const w of [10, 20, 40]) ok(I.lossMaxFloorFor(w) <= I.LOSS_MAX_CEILING,
    `W=${w}: floor ${I.lossMaxFloorFor(w)} fits under the ceiling`);
  // And a width where they WOULD cross must throw rather than silently pick one.
  ok(I.lossMaxFloorFor(60) > I.LOSS_MAX_CEILING,
    'a 60-wide would need a floor above the ceiling — the case assertBoundsCoherent refuses');
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
