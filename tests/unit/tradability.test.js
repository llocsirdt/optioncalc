'use strict';
// May the engine act on this tick? Validated against REAL recorded chains, because the failure this
// exists to prevent was found live: on 2026-09-07 (Labor Day) NDX was closed, /NQ was open and moving,
// and the engine ran all day on a frozen NDX price against a 17-strike chain with no quotes on it.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const T = require('../../server/src/candle-spread/tradability.js');

let passed = 0;
const t = (name, fn) => { try { fn(); console.log('  ✓ ' + name); passed++; } catch (e) { console.log('  ✗ ' + name + '\n     ' + e.message); process.exitCode = 1; } };

console.log('\ntradability');

const q = (bid, ask) => ({ bid, ask, mark: bid != null && ask != null ? (bid + ask) / 2 : null });
const chainOf = (n, quoted, base) => ({ underlying: base, strikes: Array.from({ length: n }, (_, i) => ({
  strike: base - (n / 2) * 10 + i * 10,
  call: quoted ? q(5, 5.4) : { bid: null, ask: null, mark: null },
  put: quoted ? q(4, 4.4) : { bid: null, ask: null, mark: null },
})) });

t('a normal quoted chain is tradable', () => {
  const r = T.assess({ underlying: 29500, chainSnapshot: chainOf(16, true, 29500), nowMs: Date.now() });
  assert.strictEqual(r.ok, true, r.detail);
});

t('a chain that EXISTS but carries no quotes is not tradable', () => {
  // The holiday case. "Does a chain exist" would have passed here — Schwab listed the strikes.
  const r = T.assess({ underlying: 29500, chainSnapshot: chainOf(16, false, 29500), nowMs: Date.now() });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'chain-not-quoted');
});

t('no chain at all is reported distinctly from an unquoted one', () => {
  const r = T.assess({ underlying: 29500, chainSnapshot: { underlying: 29500, strikes: [] }, nowMs: Date.now() });
  assert.strictEqual(r.reason, 'no-chain', 'the two look alike downstream but mean different things');
});

t('a stale pricing instrument blocks the tick', () => {
  const now = Date.now();
  const r = T.assess({ underlying: 29500, chainSnapshot: chainOf(16, true, 29500), nowMs: now,
    priceAsOfMs: now - 3 * 3600 * 1000 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'stale-price');
});

t('a slightly late bar is tolerated — one missed print must not halt trading', () => {
  const now = Date.now();
  const r = T.assess({ underlying: 29500, chainSnapshot: chainOf(16, true, 29500), nowMs: now,
    priceAsOfMs: now - 6 * 60 * 1000 });
  assert.strictEqual(r.ok, true, 'must not be trigger-happy: a brief gap is not a closed market');
});

t('a missing underlying blocks the tick', () => {
  assert.strictEqual(T.assess({ underlying: 0, chainSnapshot: chainOf(16, true, 29500) }).reason, 'no-underlying');
});

t('quotes far from the money do not rescue an unquoted near-money chain', () => {
  const cs = { underlying: 29500, strikes: [
    { strike: 29500, call: { bid: null, ask: null, mark: null }, put: { bid: null, ask: null, mark: null } },
    { strike: 31000, call: q(1, 1.2), put: q(1, 1.2) },
    { strike: 31010, call: q(1, 1.2), put: q(1, 1.2) },
    { strike: 31020, call: q(1, 1.2), put: q(1, 1.2) },
    { strike: 31030, call: q(1, 1.2), put: q(1, 1.2) },
  ] };
  assert.strictEqual(T.assess({ underlying: 29500, chainSnapshot: cs, nowMs: Date.now() }).ok, false);
});

// ---- REAL RECORDED DATA ----------------------------------------------------------------------
// The strongest check available: the actual chains the live engine saw on a holiday and on normal days.
const dir = path.join(__dirname, '..', '..', 'server', 'src', 'persistence', 'candle-spread-runs');
function lastSnapshot(date) {
  if (!fs.existsSync(dir)) return null;
  const f = fs.readdirSync(dir).filter(x => x.startsWith('NDX_' + date) && x.includes('v7-10')).sort()[0];
  if (!f) return null;
  const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const evs = (d.events || []).filter(e => e.chainSnapshot);
  return evs.length ? evs[evs.length - 1] : null;
}

const holiday = lastSnapshot('2026-09-07');
if (holiday) {
  t('REAL 2026-09-07 (Labor Day, NDX closed) is blocked', () => {
    const r = T.assess({ underlying: holiday.underlying, chainSnapshot: holiday.chainSnapshot,
      nowMs: Date.parse(holiday.time) });
    assert.strictEqual(r.ok, false, 'the live engine traded through this day unguarded');
    assert.strictEqual(r.reason, 'chain-not-quoted');
  });
} else { console.log('  – REAL holiday fixture not present, skipped'); }

const open = lastSnapshot('2026-09-04') || lastSnapshot('2026-09-03');
if (open) {
  t('REAL normal session is NOT blocked (no false positive)', () => {
    const r = T.assess({ underlying: open.underlying, chainSnapshot: open.chainSnapshot,
      nowMs: Date.parse(open.time) });
    assert.strictEqual(r.ok, true, 'a guard that blocks real trading days is worse than none');
  });
} else { console.log('  – REAL open-session fixture not present, skipped'); }

console.log(`  ${passed} passed`);
