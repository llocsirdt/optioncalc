'use strict';
// The cover ladder: start at break-even, work up toward the market, stop at a bounded loss.
// Pinned against the REAL orders from 2026-09-08, the session that motivated it.
const assert = require('assert');
const L = require('../../server/src/candle-spread/cover-ladder.js');

let passed = 0;
const t = (name, fn) => { try { fn(); console.log('  ✓ ' + name); passed++; } catch (e) { console.log('  ✗ ' + name + '\n     ' + e.message); process.exitCode = 1; } };

console.log('\ncover-ladder');

t('the band is break-even up to a bounded loss', () => {
  const b = L.band(40, 22.25);                 // v7-40 position #1 from 2026-09-08
  assert.strictEqual(b.ideal, 17.75, 'W - openCost locks exactly nothing');
  assert.strictEqual(b.maxPay, 21.75, 'ideal + 10% of width');
  assert.strictEqual(b.lossAtMax, -4, 'the worst we accept is -$4 per share on a $40 spread');
});

t('a reversal cover STARTS at break-even, not at a loss', () => {
  const r = L.limitNow({ spreadWidth: 40, openCost: 22.25, minLock: 0, restingMs: 0, underlyingMove: 0 });
  assert.strictEqual(r.limit, 17.75);
  assert.strictEqual(r.step, 0, 'no escalation before anything has happened');
});

t('a profit-demanding trigger starts BELOW break-even and still ladders up', () => {
  const p = { spreadWidth: 20, openCost: 11.15, minLock: 7, underlyingMove: 0 };
  const t0 = L.limitNow({ ...p, restingMs: 0 });
  assert.strictEqual(t0.limit, 1.85, 'this is exactly what v6-20 sent on 2026-09-08 and never moved');
  const t6 = L.limitNow({ ...p, restingMs: 6 * 45000 });
  assert.ok(t6.limit > t0.limit, 'but now it climbs instead of sitting there');
  assert.strictEqual(t6.limit, t6.maxPay, 'and reaches the bounded-loss cap');
});

t('escalation is earned by TIME or by UNDERLYING MOVEMENT, whichever is further', () => {
  const base = { spreadWidth: 10, openCost: 5.55, minLock: 0 };
  const still = L.limitNow({ ...base, restingMs: 90000, underlyingMove: 0 });    // 2 time steps
  const fast  = L.limitNow({ ...base, restingMs: 0, underlyingMove: 21 });       // 4 move steps
  assert.strictEqual(still.step, 2);
  assert.strictEqual(fast.step, 4, 'a 21-point move earns more than a still tape does in 90s');
  assert.ok(fast.limit > still.limit);
});

t('it never bids above the market', () => {
  const r = L.limitNow({ spreadWidth: 10, openCost: 5.55, minLock: 0, restingMs: 10 * 45000,
    underlyingMove: 100, mark: 4.20 });
  assert.strictEqual(r.limit, 4.20, 'clamped to the mark — the fill happens there anyway');
  assert.ok(r.capped);
});

t('it never pays more than the bounded loss, however long it waits', () => {
  const r = L.limitNow({ spreadWidth: 20, openCost: 10.5, minLock: 0, restingMs: 99 * 45000, underlyingMove: 9999 });
  assert.strictEqual(r.limit, r.maxPay);
  assert.strictEqual(r.maxPay, 11.5, 'W - openCost (9.5) + 10% of 20 (2.0)');
  assert.ok(r.atMax);
});

t('REAL CASE: v7-40 #1 would have become fillable', () => {
  // Sent 9.75 against a mark of 28.35 and never moved. The ladder tops out at 21.75 — still short of
  // that mark, so this one was beyond saving; the honest result is that the cap binds, not that it fills.
  const r = L.limitNow({ spreadWidth: 40, openCost: 22.25, minLock: 8, restingMs: 6 * 45000, underlyingMove: 40, mark: 28.35 });
  assert.strictEqual(r.start, 9.75, 'the price actually sent that day');
  assert.strictEqual(r.limit, 21.75, 'the ladder walks it to the bounded-loss cap');
  assert.ok(r.limit < 28.35, 'still under the mark — a 10% loss cap cannot rescue every position, and should not');
});

t('REAL CASE: v6-20 #3 — mark 9.7, ladder reaches it', () => {
  const r = L.limitNow({ spreadWidth: 20, openCost: 10.65, minLock: 7, restingMs: 6 * 45000, underlyingMove: 30, mark: 9.7 });
  assert.strictEqual(r.start, 2.35, 'what was sent that day');
  assert.ok(r.limit >= 9.35 && r.limit <= 9.7, 'the ladder gets to the market: ' + r.limit);
});

t('reprice only when the change is at least a tick', () => {
  assert.strictEqual(L.shouldReprice(5.00, 5.02, 0.05), false, 'sub-tick churn is not worth a round trip');
  assert.strictEqual(L.shouldReprice(5.00, 5.05, 0.05), true);
  assert.strictEqual(L.shouldReprice(null, 5.05, 0.05), false);
});

t('the walk is monotone — it never steps backwards', () => {
  const p = { spreadWidth: 20, openCost: 11.15, minLock: 7, underlyingMove: 0 };
  let prev = -Infinity;
  for (let s = 0; s <= 8; s++) {
    const r = L.limitNow({ ...p, restingMs: s * 45000 });
    assert.ok(r.limit >= prev, `step ${s} went backwards: ${r.limit} < ${prev}`);
    prev = r.limit;
  }
});

console.log(`  ${passed} passed`);
