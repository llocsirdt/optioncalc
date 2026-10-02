'use strict';
// CLOSED-LOOP FILLS FOR HEDGES: floor-offset, wing and fly.
//
// THE GAP THIS CLOSES. When the closed loop shipped, resolvePendingOpen and resolveRestingCovers were
// gated on `fillSource === 'broker'` so the BROKER decides a fill. resolvePendingHedges was not, and
// applyBrokerFills handled only 'open' and /cover/ — so a hedge's real fill was dropped as
// 'unhandled-kind' while the engine booked the position from its own mark read. That is the same phantom
// shape as prod 2026-09-25 (29 of 29 positions believed, 0 of 33 orders filled), confined to hedges.
//
// It mattered because v7-10 — the first variant armed with real money — runs floorOffset, wingConvert and
// wingNaked. A hedge booked from a mark spends budget on a structure we may not own and reshapes the risk
// curve that the lossMax governor and the cover selectors act on.
//
// What has to hold:
//   1. under 'broker', resolvePendingHedges books NOTHING however fillable the mark looks
//   2. applyBrokerFills books it instead, at the BROKER'S price, with the mark path's exact accounting
//   3. the per-kind counters and budget (offCount/offSpent, wingCount/wingSpent, flyCount/flySpent) match
//   4. exactly once, however many times it runs
//   5. under 'mark' the old path is untouched — 79 simulated variants and every backtest depend on it
//   6. a kind with no booking path is LOUD, not silent
//
// Run: node server/tests/unit/candle-spread-broker-hedges.test.js
const trader = require('../../src/candle-spread/trader');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const near = (a, b, e = 0.011) => Math.abs(a - b) < e;

const cfg = { spreadWidth: 20, strikeIncrement: 10, tickIncrement: 0.05, quantity: 2 };
// A hedge: created filled:false, working, carrying its orderId on BOTH the position and pendingHedge.
const mkHedge = (kind, over = {}) => ({
  id: `${kind}-1`, side: kind === 'offset' ? 'hedge' : kind, hedge: true, shortStrike: null,
  legs: [{ side: 'long', type: 'P', strike: 110 }, { side: 'short', type: 'P', strike: 100 }],
  limit: 2.00, filled: false, covered: false, pendingCover: null, quantity: 2, orderId: 'ord-h',
  pendingHedge: { limit: 2.00, kind, markAtPlace: 1.95, orderId: 'ord-h', placedEpoch: 1 }, ...over });
const mkSt = (pos, los) => ({ positions: [pos], liveOrders: los, realizedPnl: 0, cashDeployed: 0,
  peakCashDeployed: 0, lastCandleTime: 't', lastCandleEpoch: 1 });
const lo = (kind, over = {}) => ({ orderId: 'ord-h', kind, status: 'filled', fillPrice: 1.80,
  fillSide: 'DEBIT', net: 'DEBIT', ...over });

// A chain where the hedge is COMFORTABLY fillable, so "it did not book" can only be the gate.
// MONOTONIC IN STRIKE, because markFill probes each leg's neighbours (at deps.strikeIncrement) and ABSTAINS
// on a chain that is not. A flat or arbitrary stub silently makes every fill test say "not fillable", which
// would turn the broker-gate assertions below into vacuous passes — the control assertion exists to catch
// exactly that, and did on the first run of this test.
// Puts rise with strike: P(s) = 0.18 * (s - 95), floored at a tick. Long P110 - short P100 = 1.80 <= 2.00.
const putMid = (strike) => Math.max(0.05, Math.round(0.18 * (strike - 95) * 100) / 100);
const getLeg = (type, strike) => {
  const mid = putMid(strike);
  return { mid, bid: Math.max(0.05, Math.round((mid - 0.1) * 100) / 100),
    ask: Math.round((mid + 0.1) * 100) / 100, symbol: `X${type}${strike}` };
};
const deps = (fillSource) => ({ getLeg, fillSource, strikeIncrement: 10, underlying: 105, nowMs: 2 });

// ── 1. UNDER 'broker' THE MARK PATH BOOKS NOTHING ───────────────────────────────────────────────────
{
  const pos = mkHedge('offset');
  const st = mkSt(pos, []);
  const d = [];
  // Control first: prove this very hedge IS fillable on this chain, or the test below is vacuous.
  const markSt = mkSt(mkHedge('offset'), []);
  const md = [];
  trader.resolvePendingHedges(markSt, cfg, deps('mark'), md);
  ok(markSt.positions[0].filled === true, 'CONTROL: on this chain the mark path does fill the hedge');
  ok(md.some((x) => x.action === 'offset-fill'), 'CONTROL: and logs offset-fill');

  trader.resolvePendingHedges(st, cfg, deps('broker'), d);
  ok(pos.filled === false, 'under broker the hedge is NOT booked from our mark');
  ok(pos.pendingHedge != null, 'and it stays working rather than being retired');
  ok(st.cashDeployed === 0, 'no budget is spent on a hedge we may not own');
  ok((st.offCount || 0) === 0 && (st.offSpent || 0) === 0, 'and the offset counters stay at zero');
  const obs = d.find((x) => x.action === 'offset-mark-fillable');
  ok(!!obs, 'but the observation is recorded, not swallowed');
  ok(obs && obs.note === 'the mark reached our price; waiting on the broker', 'saying what it is waiting for');
  ok(!d.some((x) => x.action === 'offset-fill'), 'and nothing claims a fill');
}

// ── 2. applyBrokerFills BOOKS IT, AT THE BROKER'S PRICE ─────────────────────────────────────────────
{
  const pos = mkHedge('offset');
  const st = mkSt(pos, [lo('floor-offset')]);
  const d = [];
  const n = trader.applyBrokerFills(st, cfg, { fillSource: 'broker' }, d);
  ok(n === 1, `one hedge fill applied (${n})`);
  ok(pos.filled === true && pos.orderStatus === 'filled', 'the hedge is filled');
  ok(near(pos.limit, 1.80), `booked at the BROKER'S 1.80, not our 2.00 (${pos.limit})`);
  ok(pos.pendingHedge === null, 'and it is no longer working');
  ok(near(st.cashDeployed, 1.80 * 100 * 2), `cash is the real debit x 100 x qty 2 (${st.cashDeployed})`);
  ok(st.offCount === 1 && near(st.offSpent, 360), `offset counters follow the real spend (${st.offCount}/${st.offSpent})`);
  const dec = d.find((x) => x.action === 'offset-fill');
  ok(!!dec, 'the decision keeps the mark path action name, so analysis keys still match');
  ok(dec && dec.source === 'broker' && near(dec.brokerPrice, 1.80), 'tagged source broker with the real price');
  ok(pos.brokerFill && pos.brokerFill.orderId === 'ord-h', 'and the row records which order filled it');
  // 4. IDEMPOTENT
  const again = trader.applyBrokerFills(st, cfg, { fillSource: 'broker' }, d);
  ok(again === 0 && st.offCount === 1 && near(st.cashDeployed, 360),
    'running again books nothing twice — budget is not double-counted');
}

// ── 3. WING AND FLY GO TO THEIR OWN COUNTERS ────────────────────────────────────────────────────────
for (const [kind, orderKind, cnt, spt] of [['wing', 'wing', 'wingCount', 'wingSpent'], ['fly', 'fly', 'flyCount', 'flySpent']]) {
  const pos = mkHedge(kind);
  const st = mkSt(pos, [lo(orderKind)]);
  const d = [];
  trader.applyBrokerFills(st, cfg, { fillSource: 'broker' }, d);
  ok(pos.filled === true, `a ${kind} books from the broker`);
  ok(st[cnt] === 1 && near(st[spt], 360), `into ${cnt}/${spt}, not the offset budget (${st[cnt]}/${st[spt]})`);
  ok((st.offCount || 0) === 0, `and a ${kind} does not touch offCount`);
  ok(d.some((x) => x.action === `${kind}-fill` && x.source === 'broker'), `logged as ${kind}-fill`);
}

// ── 4. MATCHING BY pendingHedge.orderId ALONE ───────────────────────────────────────────────────────
// Both ends, like the cover branch: the first cover lookup matched one end and missed every open.
{
  const pos = mkHedge('offset', { orderId: null });
  const st = mkSt(pos, [lo('floor-offset')]);
  const d = [];
  ok(trader.applyBrokerFills(st, cfg, { fillSource: 'broker' }, d) === 1,
    'a hedge whose id lives only on pendingHedge is still found');
}

// ── 5. THE MARK PATH IS UNTOUCHED UNDER 'mark' ──────────────────────────────────────────────────────
{
  const pos = mkHedge('offset');
  const st = mkSt(pos, []);
  const d = [];
  trader.resolvePendingHedges(st, cfg, deps('mark'), d);
  ok(pos.filled === true, "under 'mark' the hedge still books from our own read");
  ok(st.offCount === 1 && st.offSpent > 0, `and spends the budget as it always did (${st.offCount}/${st.offSpent})`);
  const dec = d.find((x) => x.action === 'offset-fill');
  ok(dec && dec.source === undefined, 'with no broker source tag — the two paths stay distinguishable');
}
{
  // Inert for hedges too: no fillSource at all must apply nothing.
  const pos = mkHedge('offset');
  const st = mkSt(pos, [lo('floor-offset')]);
  ok(trader.applyBrokerFills(st, cfg, {}, []) === 0, 'applyBrokerFills stays inert with no fillSource');
  ok(pos.filled === false, 'and the hedge is untouched');
}

// ── 6. AN UNBOOKABLE KIND IS LOUD ───────────────────────────────────────────────────────────────────
{
  const pos = mkHedge('offset');
  const st = mkSt(pos, [lo('something-new')]);
  const d = [];
  const err = console.error; let logged = ''; console.error = (m) => { logged += m; };
  trader.applyBrokerFills(st, cfg, { fillSource: 'broker' }, d);
  console.error = err;
  ok(st.liveOrders[0].brokerApplied === 'unhandled-kind', 'an unknown kind is still flagged');
  const dec = d.find((x) => x.action === 'broker-fill-unhandled');
  ok(!!dec, 'AND pushes a decision — it used to be a flag nothing ever read');
  ok(dec && dec.kind === 'something-new' && dec.orderId === 'ord-h', 'naming the order and the kind');
  ok(/UNHANDLED BROKER FILL/.test(logged), 'and says so on the console');
  ok(pos.filled === false, 'the position is not booked on a guess');
}

// ── 7. A WRONG-SIDE HEDGE FILL IS STILL REFUSED ─────────────────────────────────────────────────────
// The hedge branch sits after the wrong-side guard; a hedge is always a DEBIT, so a CREDIT fill on one is
// a disagreement about what was sent and must not be booked.
{
  const pos = mkHedge('offset');
  const st = mkSt(pos, [lo('floor-offset', { fillSide: 'CREDIT', net: 'DEBIT' })]);
  const d = [];
  const err = console.error; console.error = () => {}; 
  trader.applyBrokerFills(st, cfg, { fillSource: 'broker' }, d);
  console.error = err;
  ok(pos.filled === false, 'a CREDIT fill on a DEBIT hedge is refused');
  ok(d.some((x) => x.action === 'broker-fill-wrong-side'), 'and reported as wrong-side');
}

// ── 8. THE LATENT ASSUME-FILL COVER PATH REFUSES UNDER A BROKER ─────────────────────────────────────
// Unreachable on today's roster (all 80 variants are coverFillModel 'resting'), which is exactly why it
// needs a test: it books `covered = true` AND credits plan.floor to realizedPnl on SEND ACCEPTANCE, so the
// day someone sets the flag the engine claims a locked profit for a cover that may never fill — silently,
// and shaped exactly like the 2026-09-25 phantom book. An unreachable trap is still a trap.
(async () => {
  const bs = require('../../src/candle-spread/bs-pricer');
  const spot = 100;
  const gl = (type, strike) => { const mid = bs.bsPrice(type, spot, strike, 0.01, 0.4);
    return mid == null ? null : { mid: Math.round(mid * 100) / 100, bid: mid - 0.1, ask: mid + 0.1, symbol: `X${type}${strike}` }; };
  const c2 = { symbol: 'NDX', spreadWidth: 20, strikeIncrement: 10, tickIncrement: 0.05, quantity: 1,
    coverFillModel: 'assume-fill', expiration: '2026-09-30', variant: 'v0-20' };
  const mkRec = () => ({ runId: 'r', tradeDate: '2026-09-30', config: { ...c2 },
    state: { direction: 'bull', positions: [], pendingOpenId: null, realizedPnl: 0, cashDeployed: 0,
      lastCandleTime: null, liveOrders: [] }, events: [] });
  const candle = (close) => ({ timeEST: '2026-09-30 10:30', datetime: Date.parse('2026-09-30T14:30:00Z'),
    open: close - 2, high: close + 1, low: close - 3, close });
  // A filled, uncovered, deep-ITM winner — the thing a cover signal acts on.
  const mkPos = () => ({ id: 'p1', side: 'bull', filled: true, covered: false, pendingCover: null,
    quantity: 1, limit: 8, shortStrike: 120, orderId: 'oo', openTime: 't', openEpoch: 1,
    legs: [{ side: 'long', type: 'C', strike: 100 }, { side: 'short', type: 'C', strike: 120 }] });
  const sent = [];
  const base = { getLeg: gl, underlying: spot, signalSymbol: 'NDX', priceSymbol: 'NDX', strikeIncrement: 10,
    coverSelector: 'fixed-mark', A: {}, priorA: {}, isFifteen: false,
    signalFn: () => ({ coverSide: 'bull' }),
    placeOrder: async (p, m) => { sent.push(m || {}); return { status: 'sent', filled: true, orderId: 'o1' }; } };

  // CONTROL: with no broker, assume-fill really does book the cover. Without this the refusal below
  // proves only that nothing ever covers on this fixture.
  const r1 = mkRec(); r1.state.positions = [mkPos()];
  const o1 = await trader.processCandleClose(r1, candle(spot), null, { ...base, dryRun: true });
  const d1 = (o1 && o1.decisions) || [];
  const booked = d1.some((x) => x.action === 'cover') || r1.state.positions[0].covered === true;
  ok(booked, `CONTROL: assume-fill books a cover with no broker (${d1.map((x) => x.action).join(',') || 'no decisions'})`);
  ok(r1.state.positions[0].covered === true, 'CONTROL: and the position is marked covered');

  // UNDER A BROKER: refuse, and leave the position honestly uncovered.
  const r2 = mkRec(); r2.state.positions = [mkPos()];
  const before = r2.state.realizedPnl;
  const o2 = await trader.processCandleClose(r2, candle(spot), null,
    { ...base, dryRun: false, fillSource: 'broker' });
  const d2 = (o2 && o2.decisions) || [];
  ok(r2.state.positions[0].covered === false,
    `under broker the assume-fill cover is NOT booked (${d2.map((x) => x.action).join(',') || 'no decisions'})`);
  ok(r2.state.realizedPnl === before, 'and no locked floor is credited for a cover that may not have filled');
  ok(d2.some((x) => x.action === 'cover-skip-broker'), 'the refusal is recorded as cover-skip-broker');
  ok(!d2.some((x) => x.action === 'cover'), 'and nothing claims a cover');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
