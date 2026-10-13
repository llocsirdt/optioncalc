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

  // ── 3. put/call (iron) mix ──────────────────────────────────────────────────────────────────────────
  // v7-10 at 14:20: a -$244 valley at 30530-30540 with NDX at 30531, and the ledger holding C30520 short, C30540 short,
  // C30550 long, P30520 long, P30540 long — every all-call / all-put condor over the valley conflicts; the iron
  // P30520/P30530/C30540/C30550 (the user's hand order) does not.
  {
    const bs = require('../../src/candle-spread/bs-pricer');
    const spot = 30531, nowMs = Date.parse('2026-10-13T18:20:00Z');
    const tau = bs.tauFromTime(nowMs), vol = 0.16;
    const getLeg = (type, strike) => { const m = Math.round(bs.bsPrice(type, spot, strike, tau, vol) * 100) / 100;
      return { mid: m, bid: Math.max(0, m - 0.1), ask: m + 0.1, symbol: `NDX_${type}${strike}` }; };
    // Two filled spreads whose sum dips at 30530-30540: long P30540/short P30530 (5.00) + long C30540/short C30550 (5.00)
    // are NOT what the ledger holds — the curve is built from these, the ledger is set to the live account's sides.
    const book = [
      { id: 'a', side: 'bear', filled: true, covered: false, quantity: 1, limit: 4.9, legs: [{ side: 'long', type: 'P', strike: 30530 }, { side: 'short', type: 'P', strike: 30520 }] },
      { id: 'b', side: 'bull', filled: true, covered: false, quantity: 1, limit: 4.9, legs: [{ side: 'long', type: 'C', strike: 30540 }, { side: 'short', type: 'C', strike: 30550 }] }];
    const ledger = { C30520: 'short', C30540: 'short', C30550: 'long', P30520: 'long', P30540: 'long', C30530: 'short', P30530: 'short' };
    const A = { '15m': { bbupper: spot * 1.004, bblower: spot * 0.996, close: spot } };
    const run = async (iron) => {
      const st = { positions: JSON.parse(JSON.stringify(book)), legLedger: { ...ledger }, realizedPnl: 0, cashDeployed: 0 };
      const d = [], sent = [];
      const LL = require('../../src/candle-spread/leg-ledger');
      const deps = { getLeg, underlying: spot, A, nowMs, strikeIncrement: 10, enforceLegUniqueness: true, _ledger: LL.makeLegLedger(st.legLedger),
        placeOrder: async (payload, meta) => { sent.push({ payload, meta }); return { orderId: `o${sent.length}` }; } };
      await trader.raiseFloor(st, { floorRaise: true, floorRaiseMinRatio: 3, floorRaiseObjective: 'spreadFirst', floorRaiseIronMix: iron,
        spreadWidth: 10, strikeIncrement: 10, tickIncrement: 0.05, quantity: 1 }, deps, d, '10/13 14:20');
      return { st, d, sent };
    };
    const off = await run(false);
    ok(!off.d.some((x) => x.action === 'raise' && x.legs.some((l) => l.strike === 30530) && x.legs.some((l) => l.strike === 30540)),
      'without the mix: no condor over 30530-30540 (every all-call / all-put one conflicts)');
    const on = await run(true);
    const r = on.d.find((x) => x.action === 'raise' && x.sentNet === 'CREDIT');
    const tagL = (legs) => legs.map((l) => `${l.side[0]}${l.type}${l.strike}`).join(' ');
    if (process.env.SHOW) console.log(on.d.filter((x) => x.action === 'raise').map((x) => [tagL(x.legs), tagL(x.sentLegs || []), x.limit, x.ratio, x.floorNow]));
    ok(r, `with the mix: an iron raise is placed (${on.d.filter((x) => x.action === 'raise').map((x) => tagL(x.sentLegs || x.legs)).join(' | ') || 'none'})`);
    if (r) {
      const s0 = on.sent.find((x) => x.meta.net === 'CREDIT');
      ok(s0 && s0.payload.orderType === 'NET_CREDIT' && s0.payload.orderLegCollection.length === 4, 'sent as a 4-leg NET_CREDIT');
      ok(!require('../../src/candle-spread/leg-ledger').makeLegLedger({ ...ledger }).conflicts(r.sentLegs), 'every sent leg respects the ledger');
      ok(Math.abs(r.ironOffset - 10) < 1e-9 && Math.abs(s0.payload.price - (r.ironOffset - r.limit)) < 0.011,
        `credit = offset - debit-equivalent (${s0.payload.price} = ${r.ironOffset} - ${r.limit})`);
      // Broker fills the credit: booked at the debit-equivalent, cash in.
      const pos = on.st.positions.find((p) => p.id === r.id);
      on.st.liveOrders = [{ orderId: pos.pendingHedge.orderId, kind: 'raise', status: 'filled', fillPrice: s0.payload.price, net: 'CREDIT', legs: r.sentLegs }];
      const cashBefore = on.st.cashDeployed || 0;
      trader.applyBrokerFills(on.st, {}, { fillSource: 'broker' }, []);
      ok(pos.filled === true && Math.abs(pos.limit - r.limit) < 0.011, `booked at the debit-equivalent (${pos.limit})`);
      ok((on.st.cashDeployed || 0) < cashBefore, `a credit fill brings cash in (${cashBefore} -> ${on.st.cashDeployed})`);
    }
  }

  // ── 4. hedge strike range ───────────────────────────────────────────────────────────────────────────
  {
    const real = [{ filled: true, legs: [{ side: 'long', type: 'C', strike: 30500 }, { side: 'short', type: 'C', strike: 30510 }] },
      { filled: true, covered: true, legs: [{ side: 'long', type: 'P', strike: 30600 }, { side: 'short', type: 'P', strike: 30590 }],
        coverLegs: [{ side: 'long', type: 'C', strike: 30560 }, { side: 'short', type: 'C', strike: 30570 }] },
      { filled: true, hedge: true, raise: true, legs: [{ side: 'long', type: 'P', strike: 30170 }, { side: 'short', type: 'P', strike: 30160 }] }];
    const r = FR.realStrikeRange(real);
    ok(r.realLo === 30500 && r.realHi === 30600, `real range = opens + covers, hedges excluded (${r.realLo}-${r.realHi})`);
    const hr = { ...r, bandLo: 30400, bandHi: 30700 };
    const L = (spec) => spec.split(' ').map((t) => ({ side: t[0] === 'l' ? 'long' : 'short', type: t[1], strike: +t.slice(2) }));
    ok(FR.inHedgeRange(L('lP30520 sP30530 sC30540 lC30550'), hr), 'a condor inside the real range: allowed');
    ok(!FR.inHedgeRange(L('lP30160 sP30170 sP30180 lP30190'), hr), 'a condor far out at 30170: refused');
    ok(!FR.inHedgeRange(L('lC30580 sC30600 sC30600 lC30620'), hr), 'a fly reaching past the real range: refused');
    ok(FR.inHedgeRange(L('lP30440 sP30430'), hr), 'a 2-leg vertical outside the range but inside the band: allowed (wing)');
    ok(!FR.inHedgeRange(L('lP30180 sP30170'), hr), 'a 2-leg vertical outside the band: refused');
    ok(!FR.inHedgeRange(L('lP30520 sP30530 sC30540 lC30550'), { realLo: null, realHi: null, bandLo: 30400, bandHi: 30700 }),
      'no real positions: no fly/condor at all');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
