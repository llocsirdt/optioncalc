'use strict';
// RAISE DISCIPLINE (2026-10-13). v7-10 live bought C30580/30590 three times (13:00 x2, 13:45) on the locked high
// side of its curve, each premium lowering the true floor, and the third filled in 6 s at the top of its range.
//   1. lockedMustLift: once the floor is >= 0 a raise must lift the GLOBAL floor at the required ratio.
//   2. walkRaiseOrders: a walking raise steps its limit up toward its ceiling and tells the broker.
//
// Run: node server/tests/unit/candle-spread-raise-discipline.test.js
const FR = require('../../src/candle-spread/floor-raise');
const trader = require('../../src/candle-spread/trader');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

(async () => {
  // ── 1. lockedMustLift ───────────────────────────────────────────────────────────────────────────────
  // A book locked at +300 everywhere below 30600 and +1,300 above it. A C30580/30590 vertical pays only above
  // 30580: it lifts the high ground and drops the floor by its premium.
  const xs = []; for (let x = 30400; x <= 30800; x += 10) xs.push(x);
  // The live shape: floor +300 on the left edge, a +2,500 peak, a +1,300 dip at 30600-30700, rising again beyond.
  const base = xs.map((x) => (x < 30500 ? 300 : x < 30600 ? 2500 : x <= 30700 ? 1300 : 2000));
  const legs = [{ side: 'long', type: 'C', strike: 30580 }, { side: 'short', type: 'C', strike: 30590 }];
  const cands = [{ kind: 'vertical', legs }];
  const price = () => ({ debit: 1.95 });
  const gWith = (l, debit) => Math.min(...xs.map((x, j) => base[j] + FR.payoff(l, x, 1) - debit * 100));
  const args = { xs, base, cands, price, qty: 1, minRatio: 3, budget: Infinity, gNow: 300, globalFloorWith: gWith,
    objective: 'spreadFirst', spot: 30520, bandLo: 30400, bandHi: 30800 };
  // Valleys all >= 0, so the valley pass may target the +1,300 ground (the bug as it ran).
  const before = FR.pickBestMulti(args);
  ok(before.best && before.best.legs[0].strike === 30580, 'without the rule: the high-side vertical is bought (as live did)');
  const after = FR.pickBestMulti({ ...args, lockedMustLift: true });
  ok(!after.best, `with the rule: refused (best=${after.best && after.best.legs.map((l) => l.strike)})`);
  ok(after.blockedNoLift >= 1, `with the rule: counted as blocked-no-lift (${after.blockedNoLift})`);
  // A raise that DOES lift a locked floor still passes: floor low on the left, put spread there.
  const base2 = xs.map((x) => (x <= 30450 ? 100 : 900));
  const legs2 = [{ side: 'long', type: 'P', strike: 30470 }, { side: 'short', type: 'P', strike: 30460 }];
  const gWith2 = (l, debit) => Math.min(...xs.map((x, j) => base2[j] + FR.payoff(l, x, 1) - debit * 100));
  const r2 = FR.pickBestMulti({ ...args, base: base2, gNow: 100, globalFloorWith: gWith2, cands: [{ kind: 'vertical', legs: legs2 }],
    price: () => ({ debit: 1.0 }), lockedMustLift: true });
  ok(r2.best && r2.best.legs[0].strike === 30470, 'a raise that lifts the locked floor itself is still bought');
  // Negative floor: rule does not apply (valley-first logic governs).
  const base3 = xs.map((x) => (x >= 30600 ? -200 : 300));
  const gWith3 = (l, debit) => Math.min(...xs.map((x, j) => base3[j] + FR.payoff(l, x, 1) - debit * 100));
  const r3 = FR.pickBestMulti({ ...args, base: base3, gNow: -200, globalFloorWith: gWith3, lockedMustLift: true, price: () => ({ debit: 1.0 }) });
  ok(r3.best, 'a negative floor is unaffected by the locked rule');

  // ── 2. walkRaiseOrders ──────────────────────────────────────────────────────────────────────────────
  const getLeg = (type, strike) => ({ mid: 1, bid: 0.9, ask: 1.1, symbol: `NDX_${type}${strike}` });
  const mk = () => ({ positions: [{ id: 'raise-1', filled: false, side: 'raise', legs, quantity: 1, limit: 0.6, orderId: 'A1',
    pendingHedge: { kind: 'raise', limit: 0.6, orderId: 'A1', placedEpoch: 0, walkStart: 0.6, ceiling: 1.65, walkStepSec: 20, walkStepDollars: 0.05 } }] });
  {
    const st = mk(); const sent = []; const decisions = [];
    const deps = { nowMs: 65000, getLeg, replaceOrder: async (id, payload, meta) => { sent.push({ id, payload, meta }); return { status: 'replaced', orderId: 'A2' }; } };
    await trader.walkRaiseOrders(st, { tickIncrement: 0.05, quantity: 1 }, deps, decisions);
    const ph = st.positions[0].pendingHedge;
    ok(ph.limit === 0.75, `65 s = 3 steps: 0.60 -> 0.75 (${ph.limit})`);
    ok(sent.length === 1 && sent[0].payload.price === 0.75 && sent[0].meta.kind === 'raise', 'the broker is told, as kind raise');
    ok(ph.orderId === 'A2' && st.positions[0].orderId === 'A2', 'the replacement id is tracked on both ends');
  }
  {
    const st = mk(); const decisions = [];
    await trader.walkRaiseOrders(st, { tickIncrement: 0.05 }, { nowMs: 3600000, getLeg, replaceOrder: async () => ({ status: 'replaced' }) }, decisions);
    ok(st.positions[0].pendingHedge.limit === 1.65, `never past the ceiling (${st.positions[0].pendingHedge.limit})`);
  }
  {
    const st = mk(); const decisions = [];
    await trader.walkRaiseOrders(st, { tickIncrement: 0.05 }, { nowMs: 65000, getLeg, replaceOrder: async () => ({ status: 'skipped:filled' }) }, decisions);
    ok(st.positions[0].pendingHedge.limit === 0.6 && decisions.some((d) => d.action === 'raise-walk-not-sent'),
      'a replace that did not take effect leaves the limit where it was');
  }
  {
    const st = mk(); delete st.positions[0].pendingHedge.ceiling; const decisions = [];
    await trader.walkRaiseOrders(st, { tickIncrement: 0.05 }, { nowMs: 65000, getLeg, replaceOrder: async () => ({ status: 'replaced' }) }, decisions);
    ok(st.positions[0].pendingHedge.limit === 0.6, 'a raise placed without a walk is not touched');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
