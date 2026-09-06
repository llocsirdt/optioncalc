'use strict';
/**
 * Live candle-spread TRADER — continuous covering.
 *
 * Covers the mechanism ported from the backtest on 2026-09-04. This is live ORDER-PLACEMENT code, and the
 * thing that can go wrong silently is the resting PRICE: if the booked target and the sent limit disagree,
 * or if the profit-lock offset is dropped, the engine rests orders at a price that does not match the
 * strategy the baselines measured — and nothing would fail loudly.
 *
 * Run: node tests/unit/candle-spread-trader.test.js
 */
const assert = require('assert');
const trader = require('../../server/src/candle-spread/trader');
const bs = require('../../server/src/candle-spread/bs-pricer');

let passed = 0;
const test = (name, fn) => { try { fn(); console.log('  ✓ ' + name); passed++; } catch (e) { console.log('  ✗ ' + name + '\n     ' + e.message); process.exitCode = 1; } };
const testAsync = async (name, fn) => { try { await fn(); console.log('  ✓ ' + name); passed++; } catch (e) { console.log('  ✗ ' + name + '\n     ' + e.message); process.exitCode = 1; } };

const UNDER = 20000, W = 20, INCR = 10, TICK = 0.05;
const cfg = () => ({ symbol: 'NDX', spreadWidth: W, strikeIncrement: INCR, quantity: 1, tickIncrement: TICK,
  coverSelector: 'fixed-mark', coverFillModel: 'resting', capFrac: 0.8 });

// Synthetic but self-consistent chain: real BS marks with a bid/ask around them.
function makeGetLeg(spot) {
  const tau = 4 / (365 * 24), iv = 0.20;
  return (type, strike) => {
    const mid = Math.round(bs.bsPrice(type, spot, strike, tau, iv) * 100) / 100;
    return { mid, bid: Math.max(0, Math.round((mid - 0.5) * 100) / 100), ask: Math.round((mid + 0.5) * 100) / 100, symbol: `X${type}${strike}` };
  };
}

// A record with one filled, uncovered bull position at a known open cost.
function makeRecord(limit, opts) {
  const o = opts || {};
  return {
    config: cfg(),
    state: {
      direction: 'bull', positions: [{
        id: 'p1', side: 'bull', legs: [{ side: 'long', type: 'C', strike: 19980 }, { side: 'short', type: 'C', strike: 20000 }],
        quantity: 1, shortStrike: 20000, limit, filled: true, covered: false, pendingCover: null,
      }],
      realizedPnl: 0, cashDeployed: 0, peakCashDeployed: 0, lastCandleTime: null, ...o.state,
    },
    events: [],
  };
}
const candle = (t) => ({ timeEST: t, datetime: Date.UTC(2026, 8, 4, 14, 0), open: UNDER, high: UNDER + 5, low: UNDER - 5, close: UNDER });

// deps with the ported signal seam: no open, no cover — isolates the continuous-cover step.
function makeDeps(extra) {
  const sent = [];
  return {
    sent,
    getLeg: makeGetLeg(UNDER),
    placeOrder: async (payload, meta) => { sent.push({ payload, meta }); return { orderId: 'o' + sent.length }; },
    dryRun: true,
    underlying: UNDER,
    signalFn: () => ({ openSide: null, cover: false }),   // ported mode, but silent
    A: {}, priorA: {},
    ...extra,
  };
}

console.log('\ncandle-spread trader — continuous covering');

(async () => {
  await testAsync('OFF by default: no resting cover is placed', async () => {
    const rec = makeRecord(10.5);
    const deps = makeDeps({});
    await trader.processCandleClose(rec, candle('09/04 10:00'), null, deps);
    assert.strictEqual(rec.state.positions[0].pendingCover, null, 'should not have placed a cover');
    assert.strictEqual(deps.sent.length, 0, 'should not have sent an order');
  });

  await testAsync('ON: rests a cover on every uncovered position', async () => {
    const rec = makeRecord(10.5);
    const deps = makeDeps({ continuousCover: true, continuousCoverMinLockFrac: 0 });
    await trader.processCandleClose(rec, candle('09/04 10:00'), null, deps);
    assert.ok(rec.state.positions[0].pendingCover, 'expected a pendingCover');
    assert.strictEqual(rec.state.positions[0].coverStatus, 'resting');
  });

  await testAsync('target = W − openCost − minLockFrac×W (the profit-lock price)', async () => {
    for (const frac of [0, 0.15, 0.25, 0.35]) {
      const limit = 10.5;
      const rec = makeRecord(limit);
      const deps = makeDeps({ continuousCover: true, continuousCoverMinLockFrac: frac });
      await trader.processCandleClose(rec, candle('09/04 10:00'), null, deps);
      const pc = rec.state.positions[0].pendingCover;
      const expected = Math.round((W - limit - frac * W) * 100) / 100;
      assert.ok(pc, `frac ${frac}: expected a pendingCover`);
      assert.strictEqual(pc.target, expected, `frac ${frac}: target ${pc.target} != ${expected}`);
    }
  });

  await testAsync('SENT limit matches the BOOKED target (never rest at one price, book at another)', async () => {
    const limit = 10.5, frac = 0.25;
    const rec = makeRecord(limit);
    const deps = makeDeps({ continuousCover: true, continuousCoverMinLockFrac: frac });
    await trader.processCandleClose(rec, candle('09/04 10:00'), null, deps);
    const pc = rec.state.positions[0].pendingCover;
    const coverOrder = deps.sent.find(x => x.meta && x.meta.kind === 'cover-rest');
    assert.ok(coverOrder, 'expected a cover-rest order to be sent');
    assert.strictEqual(coverOrder.meta.limit, pc.target, `sent ${coverOrder.meta.limit} != booked target ${pc.target}`);
  });

  await testAsync('a target at/below zero places NO order (frac too large for this open cost)', async () => {
    const rec = makeRecord(16);   // W−limit = 4; frac 0.5 → target −6
    const deps = makeDeps({ continuousCover: true, continuousCoverMinLockFrac: 0.5 });
    await trader.processCandleClose(rec, candle('09/04 10:00'), null, deps);
    assert.strictEqual(rec.state.positions[0].pendingCover, null, 'must not rest an underwater target');
    assert.strictEqual(deps.sent.length, 0);
  });

  await testAsync('does not double-place on an already-resting position', async () => {
    const rec = makeRecord(10.5);
    const deps = makeDeps({ continuousCover: true, continuousCoverMinLockFrac: 0.25 });
    await trader.processCandleClose(rec, candle('09/04 10:00'), null, deps);
    const n1 = deps.sent.length;
    await trader.processCandleClose(rec, candle('09/04 10:05'), candle('09/04 10:00'), deps);
    assert.strictEqual(deps.sent.length, n1, 'second candle must not re-place the resting cover');
  });

  await testAsync('PRE-EMPTS the reversal cover (backtest ordering)', async () => {
    // A cover signal fires on the same candle. Continuous covering runs first, so the reversal-cover step
    // must find nothing left to select — matching the backtest, where the signal cover skips anything
    // already pending. If this inverts, the live engine trades a different strategy than the baselines.
    const rec = makeRecord(10.5);
    const deps = makeDeps({
      continuousCover: true, continuousCoverMinLockFrac: 0.25,
      signalFn: () => ({ openSide: null, coverSide: 'bull' }),
    });
    await trader.processCandleClose(rec, candle('09/04 10:00'), null, deps);
    const restOrders = deps.sent.filter(x => x.meta && x.meta.kind === 'cover-rest');
    assert.strictEqual(restOrders.length, 1, `expected exactly 1 resting cover, got ${restOrders.length}`);
    const pc = rec.state.positions[0].pendingCover;
    // and it must be the CONTINUOUS one (profit-lock target), not the reversal one (break-even target)
    assert.strictEqual(pc.target, Math.round((W - 10.5 - 0.25 * W) * 100) / 100, 'the surviving cover must carry the profit-lock target');
  });

  await testAsync('fills at the profit-lock target and books that floor', async () => {
    const limit = 10.5, frac = 0.25;
    const rec = makeRecord(limit);
    const deps = makeDeps({ continuousCover: true, continuousCoverMinLockFrac: frac });
    await trader.processCandleClose(rec, candle('09/04 10:00'), null, deps);
    const target = rec.state.positions[0].pendingCover.target;
    // Move the market so the cover's mark drops to/below target, then re-tick.
    const far = UNDER + 400;
    deps.getLeg = makeGetLeg(far);
    deps.underlying = far;
    await trader.processCandleClose(rec, candle('09/04 10:05'), candle('09/04 10:00'), deps);
    const p = rec.state.positions[0];
    assert.ok(p.covered, 'expected the resting cover to fill once the mark reached target');
    assert.ok(p.coverLimit <= target + 1e-9, `fill ${p.coverLimit} must not exceed target ${target}`);
    const floor = Math.round((W - limit - p.coverLimit) * 100 * 1);
    assert.ok(floor >= frac * W * 100 - 1, `locked floor ${floor} should be at least the ${frac}xW profit lock`);
    assert.strictEqual(rec.state.realizedPnl, Math.round((W - limit - p.coverLimit) * 100 * 100) / 100);
  });

  console.log('\ncandle-spread trader — day-loss governor');

  // A book of N naked bull spreads, each risking `limit` — floor = -N x limit x 100.
  function stackedRecord(n, limit) {
    const rec = makeRecord(limit);
    rec.state.positions = [];
    for (let i = 0; i < n; i++) rec.state.positions.push({
      id: 'p' + i, side: 'bull',
      legs: [{ side: 'long', type: 'C', strike: 19980 - i * 10 }, { side: 'short', type: 'C', strike: 20000 - i * 10 }],
      quantity: 1, shortStrike: 20000 - i * 10, limit, filled: true, covered: false, pendingCover: null,
    });
    return rec;
  }

  await testAsync('open gate: blocks the open whose projected floor breaches lossMax', async () => {
    // 6 naked spreads at $10.50 => floor -$6,300. lossMax $7,000. One more (~$10+) would breach it.
    const rec = stackedRecord(6, 10.5);
    const deps = makeDeps({ lossTarget: 5000, lossMax: 7000, signalFn: () => ({ openSide: 'bull', cover: false }) });
    const before = rec.state.positions.length;
    const out = await trader.processCandleClose(rec, candle('09/04 10:00'), null, deps);
    const blocked = out.decisions.find(d => d.action === 'open-skip-governor');
    assert.ok(blocked, 'expected open-skip-governor; got ' + JSON.stringify(out.decisions.map(d => d.action)));
    assert.ok(-blocked.projectedFloor > 7000, `projected floor ${blocked.projectedFloor} should breach 7000`);
    assert.strictEqual(rec.state.positions.length, before, 'no position may be added');
  });

  await testAsync('open gate: allows the open that stays inside lossMax', async () => {
    const rec = stackedRecord(2, 10.5);   // floor -$2,100; one more is fine under $7,000
    const deps = makeDeps({ lossTarget: 5000, lossMax: 7000, signalFn: () => ({ openSide: 'bull', cover: false }) });
    const before = rec.state.positions.length;
    const out = await trader.processCandleClose(rec, candle('09/04 10:00'), null, deps);
    assert.ok(!out.decisions.find(d => d.action === 'open-skip-governor'), 'must not block');
    assert.strictEqual(rec.state.positions.length, before + 1, 'expected the open to be taken');
  });

  await testAsync('governor OFF: the same book opens freely', async () => {
    const rec = stackedRecord(6, 10.5);
    const deps = makeDeps({ signalFn: () => ({ openSide: 'bull', cover: false }) });   // no lossMax
    const before = rec.state.positions.length;
    await trader.processCandleClose(rec, candle('09/04 10:00'), null, deps);
    assert.strictEqual(rec.state.positions.length, before + 1, 'ungoverned must be unchanged behaviour');
  });

  await testAsync('cover deferral: refuses a fill that would un-hedge the book past lossMax', async () => {
    // Naked bulls lose to the DOWNSIDE; a naked bear pays there and is their tail hedge. Covering the
    // bear removes that offset -> book floor drops. With the stack deep enough, the fill must be deferred.
    const rec = stackedRecord(6, 10.5);
    const bear = {
      id: 'bear1', side: 'bear',
      legs: [{ side: 'long', type: 'P', strike: 20000 }, { side: 'short', type: 'P', strike: 19980 }],
      quantity: 1, shortStrike: 19980, limit: 10.5, filled: true, covered: false,
      pendingCover: { legs: [{ side: 'long', type: 'C', strike: 19960 }, { side: 'short', type: 'C', strike: 19980 }], target: 9.5, geometry: 'tent' },
      coverStatus: 'resting',
    };
    rec.state.positions.push(bear);
    const RCm = require('../../server/src/candle-spread/risk-curve');
    const f0 = RCm.bookFloor(rec.state.positions.filter(p => p.filled !== false), null, 10);
    // Set the ceiling exactly AT the current floor. The engine fills at min(target, mark+tick) — not at
    // the target — so the exact post-fill floor depends on the fill price; anchoring on f0 makes the test
    // independent of it: ANY cover that lowers the floor at all now breaches.
    const deps = makeDeps({ lossTarget: 5000, lossMax: Math.floor(-f0), signalFn: () => ({ openSide: null, cover: false }) });
    // make the bear's cover fillable
    deps.getLeg = (type, strike) => ({ mid: 0.05, bid: 0, ask: 0.1, symbol: 'x' });
    const out = await trader.processCandleClose(rec, candle('09/04 10:05'), candle('09/04 10:00'), deps);
    assert.ok(out.decisions.find(d => d.action === 'cover-defer-governor'), 'expected cover-defer-governor');
    assert.strictEqual(bear.covered, false, 'the cover must NOT have been booked');
    assert.ok(bear.pendingCover, 'the order must stay working');
  });

  await testAsync('cover deferral: a floor-IMPROVING cover always books', async () => {
    const rec = makeRecord(10.5);
    const p = rec.state.positions[0];
    p.pendingCover = { legs: [{ side: 'long', type: 'P', strike: 20000 }, { side: 'short', type: 'P', strike: 20020 }], target: 9.5, geometry: 'tent' };
    p.coverStatus = 'resting';
    const deps = makeDeps({ lossTarget: 5000, lossMax: 7000, signalFn: () => ({ openSide: null, cover: false }) });
    deps.getLeg = (type, strike) => ({ mid: 0.05, bid: 0, ask: 0.1, symbol: 'x' });
    await trader.processCandleClose(rec, candle('09/04 10:05'), candle('09/04 10:00'), deps);
    assert.ok(p.covered, 'a cover that lifts the floor must book');
  });

  // ── ADAPTIVE STRIKE PLACEMENT (live port of makeAdaptiveGeo) ────────────────────────────────────
  // The rule is "most ITM placement still within the ceiling, floored at straddle, never OTM". These pin
  // the parts that could drift silently: the ORDER of candidates, the ceiling actually binding, the
  // straddle floor, and that a gap in the chain is survivable rather than fatal.
  const acfg = (over) => ({ ...cfg(), capFrac: 0.65, adaptiveGeo: true, maxItmStrikes: 3, ...over });

  test('adaptive picks the MOST ITM placement inside the ceiling', () => {
    const r = trader.buildOpenAdaptive('bull', UNDER, acfg(), makeGetLeg(UNDER));
    assert.ok(!r.declined, 'should find a placement: ' + r.reason);
    assert.ok(r.limit <= 0.65 * W + 1e-9, `booked ${r.limit} over the ceiling`);
    assert.ok(r.itmStrikes >= 0, 'never OTM on an open');
    // Anything more ITM than the chosen placement must be over the ceiling, or it was not the MOST ITM.
    if (r.itmStrikes < 3) {
      const deeper = trader.buildOpenAtStrikes('bull', r.lower - INCR, r.upper - INCR, acfg(), makeGetLeg(UNDER));
      assert.ok(deeper.declined || deeper.error, 'a cheaper deeper placement existed and was skipped');
    }
  });

  test('a tighter ceiling forces a LESS ITM placement', () => {
    const loose = trader.buildOpenAdaptive('bull', UNDER, acfg({ capFrac: 0.75 }), makeGetLeg(UNDER));
    const tight = trader.buildOpenAdaptive('bull', UNDER, acfg({ capFrac: 0.55 }), makeGetLeg(UNDER));
    assert.ok(!loose.declined && !tight.declined, 'both should place');
    assert.ok(loose.itmStrikes >= tight.itmStrikes,
      `looser ceiling should allow >= ITM depth (${loose.itmStrikes} vs ${tight.itmStrikes})`);
  });

  test('bear places on the mirror side and is also never OTM', () => {
    const r = trader.buildOpenAdaptive('bear', UNDER, acfg(), makeGetLeg(UNDER));
    assert.ok(!r.declined, r.reason);
    assert.strictEqual(r.upper - r.lower, W, 'width preserved');
    assert.ok(r.itmStrikes >= 0, 'never OTM on an open');
    assert.strictEqual(r.legs[0].type, 'P', 'bear opens the put side');
  });

  test('DECLINES rather than overpaying when no placement fits', () => {
    const r = trader.buildOpenAdaptive('bull', UNDER, acfg({ capFrac: 0.01 }), makeGetLeg(UNDER));
    assert.strictEqual(r.declined, true);
    assert.strictEqual(r.limit, 0, 'a declined open must carry no bookable limit');
    assert.ok(r.placementsTried > 1, 'should have tried the whole ladder, got ' + r.placementsTried);
    assert.match(r.reason, /no placement within/);
  });

  test('a missing chain quote skips that placement instead of killing the open', () => {
    const base = makeGetLeg(UNDER);
    // Knock a hole in the chain exactly where the deepest ITM candidate would price.
    const holed = (type, strike) => (strike === UNDER - 3 * INCR ? null : base(type, strike));
    const r = trader.buildOpenAdaptive('bull', UNDER, acfg(), holed);
    assert.ok(!r.declined, 'a gap in the chain is not a reason to abandon the signal: ' + r.reason);
    assert.ok(r.limit > 0);
  });

  test('maxItmStrikes bounds the search but never forces a WORSE price', () => {
    const deep = trader.buildOpenAdaptive('bull', UNDER, acfg({ maxItmStrikes: 6 }), makeGetLeg(UNDER));
    const shallow = trader.buildOpenAdaptive('bull', UNDER, acfg({ maxItmStrikes: 1 }), makeGetLeg(UNDER));
    assert.ok(!deep.declined && !shallow.declined);
    assert.ok(deep.itmStrikes >= shallow.itmStrikes, 'a deeper bound can only allow deeper placements');
    assert.ok(deep.limit <= 0.65 * W + 1e-9 && shallow.limit <= 0.65 * W + 1e-9, 'both respect the ceiling');
  });

  test('adaptiveGeo OFF leaves the fixed placement untouched', () => {
    const c = { ...cfg(), capFrac: 0.65, spreadShift: W / 2 };
    const fixed = trader.buildOpen('bull', UNDER, c, makeGetLeg(UNDER));
    assert.ok(!fixed.declined, 'the shipped fixed path still works');
    assert.strictEqual(fixed.itmStrikes, undefined, 'fixed placement reports no adaptive metadata');
  });

  // ── COVER GEOMETRY + RISK ARMING (live port) ────────────────────────────────────────────────────
  // These must agree with the backtest's shared helpers, because a live/backtest divergence here means
  // v1-v3 trade differently from the baselines that describe them.
  const gcfg = (over) => ({ ...cfg(), capFrac: 0.65, spreadWidth: W, ...over });
  const POS = () => ({ id: 'p1', side: 'bull', shortStrike: UNDER, limit: 11, filled: true, quantity: 1 });

  test('tent geometry is IDENTICAL to the previous tent-only path (v0 untouched)', () => {
    const a = trader.selectCoverGeometric(POS(), gcfg({ coverGeometry: 'tent' }), makeGetLeg(UNDER + 40), UNDER + 40);
    const b = trader.selectCoverFixedMark(POS(), gcfg(), makeGetLeg(UNDER + 40));
    assert.deepStrictEqual(a.legs, b.legs, 'legs must match the tent path exactly');
    assert.strictEqual(a.limit, b.limit);
  });

  test('geometries walk the cover toward the money, in order', () => {
    const under = UNDER + 60, g = makeGetLeg(under);
    const shorts = ['tent', 'halfway', 'underlying'].map((geometry) => {
      const p = trader.selectCoverGeometric(POS(), gcfg({ coverGeometry: geometry }), g, under);
      assert.ok(!p.error, geometry + ': ' + p.error);
      return p.legs.find((l) => l.side === 'short').strike;
    });
    assert.ok(shorts[0] < shorts[1] && shorts[1] <= shorts[2], `tent<halfway<=underlying, got ${shorts}`);
    assert.strictEqual(shorts[0], UNDER, 'tent shares the position short strike');
  });

  test('a geometry cover is cheaper the closer it sits to the tent', () => {
    const under = UNDER + 60, g = makeGetLeg(under);
    const tent = trader.selectCoverGeometric(POS(), gcfg({ coverGeometry: 'tent' }), g, under);
    const atm = trader.selectCoverGeometric(POS(), gcfg({ coverGeometry: 'underlying' }), g, under);
    assert.ok(atm.mark > tent.mark, `at-the-money cover should cost more (${atm.mark} vs ${tent.mark})`);
    assert.ok(atm.peakExtra >= tent.peakExtra, 'and buy more terminal upside');
  });

  test('live geometry agrees with the shared helper the backtest uses', () => {
    const SL = require('../../server/src/candle-spread/spread-logic');
    const under = UNDER + 60;
    for (const geometry of ['tent', 'halfway', 'underlying']) {
      const p = trader.selectCoverGeometric(POS(), gcfg({ coverGeometry: geometry }), makeGetLeg(under), under);
      const want = SL.coverLegsAtShort('bull', SL.coverShortFor(geometry, 'bull', UNDER, under, INCR), W);
      assert.deepStrictEqual(
        p.legs.map((l) => l.side + l.type + l.strike).sort(),
        want.map((l) => l.side + l.type + l.strike).sort(),
        geometry + ': live legs must match the shared helper');
    }
  });

  console.log(`\n${passed} passed\n`);
})();
