'use strict';
// Cover GEOMETRY — where the offsetting spread sits. This is the axis v0-v3 differ on, and it had been
// silently overridden for a long time (continuous covering hardcoded the tent), so these pin the shapes.
const assert = require('assert');
const L = require('../../server/src/candle-spread/spread-logic');
let passed = 0;
const t = (n, f) => { try { f(); console.log('  ✓ ' + n); passed++; } catch (e) { console.log('  ✗ ' + n + '\n     ' + e.message); process.exitCode = 1; } };
const fmt = (ls) => ls.map((l) => (l.side === 'long' ? '+' : '-') + l.type + l.strike).join(' ');
const W = 20, INCR = 10, SHORT = 29500;

console.log('\ncover-geometry');

t('tent reproduces coverLegs EXACTLY (so v0 is unchanged)', () => {
  for (const [side, under] of [['bull', 29560], ['bear', 29440]]) {
    const cs = L.coverShortFor('tent', side, SHORT, under, INCR);
    assert.strictEqual(cs, SHORT, 'tent shares the position short strike');
    assert.strictEqual(fmt(L.coverLegsAtShort(side, cs, W)), fmt(L.coverLegs(side, SHORT, W, 'debit-offset')));
  }
});

t('halfway sits between the short strike and the underlying', () => {
  const cs = L.coverShortFor('halfway', 'bull', SHORT, 29560, INCR);
  assert.strictEqual(cs, 29530);
  assert.ok(cs > SHORT && cs < 29560, 'strictly between');
  assert.strictEqual(L.coverShortFor('halfway', 'bear', SHORT, 29440, INCR), 29470, 'mirrored for a bear');
});

t('underlying sits at the money', () => {
  assert.strictEqual(L.coverShortFor('underlying', 'bull', SHORT, 29560, INCR), 29560);
  assert.strictEqual(L.coverShortFor('underlying', 'bear', SHORT, 29440, INCR), 29440);
});

t('a cover never moves BACKWARD past the position short strike', () => {
  // Underlying still behind the short strike (position not yet a winner) — every geometry must clamp,
  // because a cover on the wrong side overlaps the position instead of offsetting it.
  for (const g of ['halfway', 'underlying']) {
    assert.strictEqual(L.coverShortFor(g, 'bull', SHORT, 29400, INCR), SHORT, `bull ${g}`);
    assert.strictEqual(L.coverShortFor(g, 'bear', SHORT, 29600, INCR), SHORT, `bear ${g}`);
  }
});

t('geometries are ORDERED: tent <= halfway <= underlying (bull), mirrored for bear', () => {
  const u = 29580;
  const a = L.coverShortFor('tent', 'bull', SHORT, u, INCR);
  const b = L.coverShortFor('halfway', 'bull', SHORT, u, INCR);
  const c = L.coverShortFor('underlying', 'bull', SHORT, u, INCR);
  assert.ok(a <= b && b <= c, `${a} <= ${b} <= ${c}`);
  const d = 29420;
  assert.ok(L.coverShortFor('tent', 'bear', SHORT, d, INCR) >= L.coverShortFor('halfway', 'bear', SHORT, d, INCR));
  assert.ok(L.coverShortFor('halfway', 'bear', SHORT, d, INCR) >= L.coverShortFor('underlying', 'bear', SHORT, d, INCR));
});

t('an unknown geometry falls back to the tent rather than inventing strikes', () => {
  assert.strictEqual(L.coverShortFor(undefined, 'bull', SHORT, 29560, INCR), SHORT);
  assert.strictEqual(L.coverShortFor('nonsense', 'bull', SHORT, 29560, INCR), SHORT);
});

t('every geometry keeps the cover a full-width spread on the opposite side', () => {
  for (const g of ['tent', 'halfway', 'underlying']) {
    const bull = L.coverLegsAtShort('bull', L.coverShortFor(g, 'bull', SHORT, 29560, INCR), W);
    assert.ok(bull.every((l) => l.type === 'P'), `${g}: a bull is covered by PUTS`);
    assert.strictEqual(Math.abs(bull[0].strike - bull[1].strike), W, `${g}: width preserved`);
    const bear = L.coverLegsAtShort('bear', L.coverShortFor(g, 'bear', SHORT, 29440, INCR), W);
    assert.ok(bear.every((l) => l.type === 'C'), `${g}: a bear is covered by CALLS`);
    assert.strictEqual(Math.abs(bear[0].strike - bear[1].strike), W, `${g}: width preserved`);
  }
});

console.log(`\n${passed} passed\n`);
