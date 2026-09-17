'use strict';
// PRUNE COLLAPSE RULE. This runs on EVERY DEPLOY with --apply (see server/.ebextensions), unattended,
// against the live run store. A bug here deletes real trading history rather than the duplicate copies
// the 2026-09-16 floor-offset loop left behind, and nobody would be watching when it happened. So the
// rule is pinned from both directions: what it MUST remove, and — more important — everything it must
// never touch.
//
// Run: node server/tests/unit/candle-spread-prune-hedges.test.js
const { collapse, fingerprint, isHedge } = require('../../src/candle-spread/tools/prune-runaway-hedges');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

const hedge = (lo, hi, limit) => ({ side: 'hedge', hedge: true, filled: true, limit,
  legs: [{ side: 'long', type: 'C', strike: lo }, { side: 'short', type: 'C', strike: hi }] });
const spread = (id, lo, hi) => ({ id, side: 'bull', filled: true, limit: 9,
  legs: [{ side: 'long', type: 'C', strike: lo }, { side: 'short', type: 'C', strike: hi }] });

// ── WHAT IT MUST REMOVE ─────────────────────────────────────────────────────────────────────────────
{
  const run = [spread('r1', 29000, 29040), ...Array.from({ length: 5000 }, () => hedge(28930, 28950, 1.65))];
  const kept = collapse(run);
  ok(kept.length === 2, `collapses an unbroken run to one copy (got ${kept.length})`);
  ok(kept[0].id === 'r1', 'the real spread survives and stays first');
  ok(isHedge(kept[1]) && kept[1].limit === 1.65, 'one copy of the hedge is kept, not zero');
}

// ── WHAT IT MUST NEVER TOUCH ────────────────────────────────────────────────────────────────────────
{
  // Real positions are never de-duplicated, even when genuinely identical: opening the same spread twice
  // is ordinary trading, and only the hedge loop produced identical consecutive copies.
  const dupSpreads = [spread('a', 29000, 29040), spread('b', 29000, 29040), spread('c', 29000, 29040)];
  ok(collapse(dupSpreads).length === 3, 'identical non-hedge positions are all kept');

  // A hedge re-bought later, after other activity, is a real decision. Only an UNBROKEN run is the bug.
  const reBought = [hedge(28930, 28950, 1.65), spread('r1', 29000, 29040), hedge(28930, 28950, 1.65)];
  ok(collapse(reBought).length === 3, 'a hedge re-bought after other activity is kept');

  // Different strikes or a different price are different hedges.
  ok(collapse([hedge(28930, 28950, 1.65), hedge(28940, 28960, 1.65)]).length === 2, 'different strikes are not duplicates');
  ok(collapse([hedge(28930, 28950, 1.65), hedge(28930, 28950, 2.10)]).length === 2, 'a different limit is not a duplicate');

  // A clean book must come back completely untouched — the overwhelmingly common case on every deploy.
  const clean = [spread('a', 29000, 29040), hedge(28930, 28950, 1.65), spread('b', 29100, 29140), hedge(29200, 29220, 0.9)];
  const keptClean = collapse(clean);
  ok(keptClean.length === clean.length, 'a healthy book is returned unchanged');
  ok(JSON.stringify(keptClean) === JSON.stringify(clean), 'and in the same order, byte for byte');

  ok(collapse([]).length === 0, 'an empty book is handled');
}

// ── IDENTITY ────────────────────────────────────────────────────────────────────────────────────────
{
  // Leg ORDER must not hide a duplicate — the engine builds legs consistently, but a record edited or
  // rewritten by another tool need not preserve it, and a missed duplicate is the failure that matters.
  const a = hedge(28930, 28950, 1.65);
  const b = { ...a, legs: [a.legs[1], a.legs[0]] };
  ok(fingerprint(a) === fingerprint(b), 'leg order does not change a hedge fingerprint');
  ok(collapse([a, b]).length === 1, 'and a reordered duplicate still collapses');

  // Both spellings of "this is a hedge" are recognised; the loop wrote side:'hedge', older records the flag.
  ok(isHedge({ side: 'hedge' }) && isHedge({ hedge: true }), 'both hedge markers are recognised');
  ok(!isHedge({ side: 'bull' }) && !isHedge(null), 'a real position is not a hedge, and null is safe');
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
