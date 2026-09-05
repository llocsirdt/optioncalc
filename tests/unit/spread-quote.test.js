'use strict';
// Mark-validation gate: parity (exact), neighbour outlier, and the 65%-of-width ceiling.
const assert = require('assert');
const SQ = require('../../server/src/candle-spread/spread-quote');
const L = require('../../server/src/candle-spread/spread-logic');
const bs = require('../../server/src/candle-spread/bs-pricer');

let passed = 0;
const t = (name, fn) => { try { fn(); console.log('  ✓ ' + name); passed++; } catch (e) { console.log('  ✗ ' + name + '\n     ' + e.message); process.exitCode = 1; } };

// A clean synthetic chain: BS mids with a uniform half-spread. `bad` injects one wide leg.
function chain(spot, opts) {
  const o = opts || {}, tau = o.tau || 3 / (365 * 24), iv = o.iv || 0.20, half = o.half || 0.25;
  return (type, strike) => {
    const mid = Math.round(bs.bsPrice(type, spot, strike, tau, iv) * 100) / 100;
    let h = half;
    if (o.bad && o.bad.type === type && o.bad.strike === strike) h = o.bad.half;
    return { mid: Math.round((mid + (o.bad && o.bad.type === type && o.bad.strike === strike ? (o.bad.skew || 0) : 0)) * 100) / 100,
      bid: Math.max(0, Math.round((mid - h) * 100) / 100), ask: Math.round((mid + h) * 100) / 100 };
  };
}

console.log('\nspread-quote — mark validation');

t('netQuote: ask is the legged cost, crossOverMid is what crossing costs over the mark', () => {
  const g = chain(20000, { half: 0.25 });
  const q = SQ.netQuote(SQ.bullCallLegs(19980, 20000), g);
  assert.ok(q, 'expected a quote');
  assert.ok(Math.abs(q.crossOverMid - 0.5) < 1e-6, `crossOverMid ${q.crossOverMid} should be 2 legs x $0.25`);
  assert.ok(Math.abs(q.perLeg - 0.25) < 1e-6, `perLeg ${q.perLeg} should be $0.25`);
});

t('parity holds EXACTLY on a clean chain: call mid + put mid = width', () => {
  const g = chain(20000, { half: 0.25 });
  for (const [lo, hi] of [[19980, 20000], [19960, 20000], [20000, 20040]]) {
    const p = SQ.parityCheck(lo, hi, g);
    assert.ok(p.ok, `${lo}/${hi}: parity should hold, sum ${p.sum} vs width ${p.width}`);
    assert.ok(Math.abs(p.sum - p.width) < 0.02, `${lo}/${hi}: sum ${p.sum} != width ${p.width}`);
  }
});

t("the user's worked example: $20 spread, call $16 / put $8 -> fair call $12", () => {
  // Hand-built quotes reproducing the example exactly.
  const g = (type, strike) => {
    const table = { C19980: 16 + 8 - 8, C20000: 0, P20000: 8, P19980: 0 };  // call spread 16, put spread 8
    const mids = { C19980: 16, C20000: 0, P20000: 8, P19980: 0 };
    const m = mids[type + strike];
    return m == null ? null : { mid: m, bid: Math.max(0, m - 0.25), ask: m + 0.25 };
  };
  const p = SQ.parityCheck(19980, 20000, g);
  assert.strictEqual(p.sum, 24, 'call 16 + put 8 = 24');
  assert.strictEqual(p.width, 20);
  assert.strictEqual(p.excess, 4, 'excess over width');
  assert.strictEqual(p.ok, false, 'should flag the inflation');
  assert.strictEqual(p.inflated, 'call');
  assert.strictEqual(p.fair.call, 12, `fair call should be 20 - 8 = 12, got ${p.fair.call}`);
  assert.strictEqual(p.overstatedBy, 4);
});

t('neighbour check: a single wide/skewed leg shows up as a local outlier', () => {
  const clean = chain(20000, { half: 0.25 });
  const n1 = SQ.neighbourCheck('bull', 19980, 20000, clean, { incr: 10 });
  assert.ok(n1.ok, `clean chain should pass, resid ${n1.resid} vs scale ${n1.scale}`);
  // now inflate ONE leg's mid by $3 and re-check the same spread
  const dirty = chain(20000, { half: 0.25, bad: { type: 'C', strike: 19980, half: 2, skew: 3 } });
  const n2 = SQ.neighbourCheck('bull', 19980, 20000, dirty, { incr: 10 });
  assert.ok(!n2.ok, `inflated leg should fail; resid ${n2.resid} vs scale ${n2.scale}`);
  assert.ok(n2.resid > 0, 'the outlier should be ABOVE the neighbour trend');
});

t('ceiling: declines a spread priced over 65% of width (does NOT book a capped price)', () => {
  // deep ITM: mid will be well over 65% of width
  const g = chain(20000, { half: 0.25 });
  const v = SQ.validateOpen('bull', 19900, 19920, g, { maxDebitFrac: 0.65, incr: 10 });
  assert.strictEqual(v.ok, false, `expected decline; frac of width was ${v.fracOfWidth}`);
  assert.strictEqual(v.reason, 'ceiling');
  assert.ok(v.limit > v.maxAllowed, 'limit must report the REAL price, not a capped one');
});

t('ceiling: accepts a spread priced inside 65% of width', () => {
  const g = chain(20000, { half: 0.25 });
  const v = SQ.validateOpen('bull', 20000, 20020, g, { maxDebitFrac: 0.65, incr: 10 });   // ATM/OTM -> cheap
  assert.strictEqual(v.ok, true, `expected accept; frac ${v.fracOfWidth} vs max ${v.maxAllowed}`);
  assert.ok(v.limit <= v.maxAllowed);
});

t('validateOpen uses the parity-derived fair price when the mark is inflated', () => {
  const mids = { C19980: 13.5, C20000: 0, P20000: 8, P19980: 0 };
  const g = (type, strike) => { const m = mids[type + strike]; return m == null ? null : { mid: m, bid: Math.max(0, m - 0.25), ask: m + 0.25 }; };
  const v = SQ.validateOpen('bull', 19980, 20000, g, { maxDebitFrac: 0.65, neighbours: 0 });
  assert.strictEqual(v.quotedMid, 13.5, 'quoted mid preserved for the record');
  assert.strictEqual(v.limit, 12, 'should price off parity: 20 - 8 = 12');
  assert.strictEqual(v.adjusted, true);
  assert.strictEqual(v.reason, 'parity');
  assert.strictEqual(v.ok, true, '12 is inside 65% of 20 (13)');
});

t('never invents a price better than the market shows', () => {
  const g = chain(20000, { half: 0.25 });
  const v = SQ.validateOpen('bull', 20000, 20020, g, { maxDebitFrac: 0.65, incr: 10 });
  assert.ok(v.limit <= v.quotedMid + 1e-9, `limit ${v.limit} must not exceed the quoted mid ${v.quotedMid}`);
});

// ── debitLimit: the ceiling GATES the trade, it never prices it ────────────────────────────────────
// Regression for the sub-market bug. The old code did `limit = min(cap, mark)`, so an over-ceiling
// spread was sent at the cap — a limit order below the market, which does not fill live while the
// backtest happily booked it as a fill. Now the ceiling only reports `exceedsCap` and the OPEN path
// declines (trader.buildOpenAtStrikes -> {declined}, decision 'open-skip-ceiling').
t('debitLimit prices at the real mark, never below it', () => {
  const r = L.debitLimit(14.00, 1.00, 20, 0.05, 0.65);   // mark 13.00, cap 13.00 -> at the ceiling
  assert.strictEqual(r.mark, 13);
  assert.strictEqual(r.limit, 13, 'limit must be the mark');
  assert.strictEqual(r.exceedsCap, false, '13.00 is not over a 13.00 cap');
});

t('debitLimit FLAGS an over-ceiling spread instead of capping the price', () => {
  const r = L.debitLimit(16.00, 1.00, 20, 0.05, 0.65);   // mark 15.00 vs cap 13.00
  assert.strictEqual(r.mark, 15);
  assert.strictEqual(r.cap, 13);
  assert.strictEqual(r.exceedsCap, true, 'must report the breach');
  assert.strictEqual(r.limit, 15, 'THE BUG: old code returned 13.00 here — a price nobody offered');
});

t('debitLimit defaults to the user\'s 65%-of-width ceiling', () => {
  assert.strictEqual(L.debitLimit(10, 1, 20, 0.05).cap, 13);
});

console.log(`\n${passed} passed\n`);
