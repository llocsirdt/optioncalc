'use strict';
/**
 * variant-alias.test.js — mapping PRE-2026-09-03 run names onto the current canonical roster.
 *
 * The cases here are taken from the real archive, not invented: every legacy shape that actually exists
 * on disk (bare `vN`, the retired `-10k` twins, the `-paper` fill studies) plus the collisions they cause
 * on 2026-09-02 and 2026-09-03/04.
 */
const assert = require('assert');
const { canonicalFor, resolveSlots } = require('../../server/src/candle-spread/variant-alias');

const ROSTER = new Set(['v0-20', 'v6-20', 'v6-40', 'v9-20', 'v9-40', 'v6-20-cATM', 'v6-40-unc']);
let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; } catch (e) { fail++; console.error(`  FAIL ${name}\n    ${e.message}`); } };

t('a name already on the roster is exact, not aliased', () => {
  const r = canonicalFor({ variant: 'v6-20', spreadWidth: 20 }, ROSTER);
  assert.strictEqual(r.variant, 'v6-20');
  assert.strictEqual(r.exact, true);
  assert.strictEqual(r.aliasOf, undefined);
});

t('a bare legacy name takes its width from the RECORDED config, not the name', () => {
  assert.strictEqual(canonicalFor({ variant: 'v6', spreadWidth: 20 }, ROSTER).variant, 'v6-20');
  // Same name, different recorded width -> a different slot. Nothing here assumes $20.
  assert.strictEqual(canonicalFor({ variant: 'v6', spreadWidth: 40 }, ROSTER).variant, 'v6-40');
});

t('a retired -10k twin maps to the same signal+width, flagged as a cap difference', () => {
  const r = canonicalFor({ variant: 'v6-20-10k', spreadWidth: 20 }, ROSTER);
  assert.strictEqual(r.variant, 'v6-20');
  assert.strictEqual(r.exact, false);
  assert.strictEqual(r.aliasOf, 'v6-20-10k');
  assert.match(r.aliasNote, /cap/);
});

t('a -paper run maps by family+width and is flagged as a fill-model difference', () => {
  const r = canonicalFor({ variant: 'v9-40-paper', spreadWidth: 40 }, ROSTER);
  assert.strictEqual(r.variant, 'v9-40');
  assert.match(r.aliasNote, /fill model/);
});

t('a centred-ATM geometry stays in the cATM column', () => {
  // Collapsing this into the short-ATM cell would file the run under a geometry it did not trade.
  assert.strictEqual(canonicalFor({ variant: 'v6-20-cATM-old', spreadWidth: 20 }, ROSTER).variant, 'v6-20-cATM');
});

t('no roster slot -> null rather than a wrong home', () => {
  // v0 only ever ran at $20; a $40 request must not be satisfied by the $20 run.
  assert.strictEqual(canonicalFor({ variant: 'v0', spreadWidth: 40 }, ROSTER), null);
  assert.strictEqual(canonicalFor({ variant: 'vX', spreadWidth: 20 }, ROSTER), null);
  assert.strictEqual(canonicalFor({ variant: 'v6' }, ROSTER), null);          // no recorded width
  assert.strictEqual(canonicalFor({}, ROSTER), null);
});

t('a native run always beats an alias for its slot', () => {
  // The real 2026-09-03/04 case: v6-20 and v6-20-10k both exist.
  const slots = resolveSlots([
    { runId: 'A', config: { variant: 'v6-20-10k', spreadWidth: 20 }, eventCount: 900 },
    { runId: 'B', config: { variant: 'v6-20', spreadWidth: 20 }, eventCount: 5 },
  ], ROSTER);
  assert.strictEqual(slots.get('v6-20').runId, 'B');
  assert.strictEqual(slots.get('v6-20').exact, true);
});

t('closest alias wins when several compete: bare > -10k > -paper', () => {
  // The real 2026-09-02 case for v9-40: a -10k twin and a -paper study, no native run.
  const slots = resolveSlots([
    { runId: 'P', config: { variant: 'v9-40-paper', spreadWidth: 40 }, eventCount: 999 },
    { runId: 'K', config: { variant: 'v9-40-10k', spreadWidth: 40 }, eventCount: 1 },
  ], ROSTER);
  assert.strictEqual(slots.get('v9-40').runId, 'K', 'cap difference is closer than fill-model difference');
});

t('equal-rank ties go to the more complete record, so the pick is stable', () => {
  const runs = [
    { runId: 'thin', config: { variant: 'v6', spreadWidth: 20 }, eventCount: 3 },
    { runId: 'full', config: { variant: 'v6', spreadWidth: 20 }, eventCount: 300 },
  ];
  assert.strictEqual(resolveSlots(runs, ROSTER).get('v6-20').runId, 'full');
  assert.strictEqual(resolveSlots([...runs].reverse(), ROSTER).get('v6-20').runId, 'full');
});

t('one run never occupies two slots, and unmappable runs occupy none', () => {
  const slots = resolveSlots([
    { runId: 'A', config: { variant: 'v6', spreadWidth: 20 }, eventCount: 1 },
    { runId: 'B', config: { variant: 'vZ', spreadWidth: 20 }, eventCount: 1 },
  ], ROSTER);
  assert.strictEqual(slots.size, 1);
  assert.strictEqual(slots.get('v6-20').runId, 'A');
});

console.log(`variant-alias: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
