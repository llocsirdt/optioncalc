'use strict';
// A DEAD ORDER ID MUST NOT BE RETRIED FOREVER (2026-10-20). v7-10 in TEST mode (since 10/16): the poller pulls each
// unfillable test order after TEST_CANCEL_MS without clearing the strategy's state (the position is simulated), the
// replace guard then refused every later reprice as "already canceled", and concedeCover reverted the price — so the
// simulated give-up / ladder / open walk froze ~60 s after placement (513 give-up retries on 10/20 alone).
//   test-pulled order   -> the replace is simulated: the book moves, nothing is sent
//   live dead order      -> the pending state is cleared so the next pass places a NEW order
//   REPLACED w/ successor -> the live successor is repriced instead
//   superseded-by-fill   -> state kept (a fill is about to book)
process.env.CANDLE_SPREAD_LIVE = 'true';
process.env.CANDLE_SPREAD_ARMED = 'v7-10';
process.env.CANDLE_SPREAD_ARMED_MODE = 'live';
const os = require('os'), path = require('path'), fs = require('fs');
process.env.CANDLE_SPREAD_RUNS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-dead-'));
const cs = require('../../src/candle-spread/index');
const SC = require('../../src/candle-spread/strategy-control');
const trader = require('../../src/candle-spread/trader');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

SC._reset(); SC.seedBaseline({ 'v7-10': 'live' });
SC._state.variants = SC.normalise({ variants: {} }, null, { liveAllowed: true, baseline: { 'v7-10': 'live' } }).variants;

function client() {
  const calls = { upd: [], place: 0 };
  return { calls,
    placeOrderByAcct: async () => { calls.place++; return { orderId: 'p1' }; },
    updateOrderById: async (_h, id) => { calls.upd.push(id); return { orderId: 'o2' }; },
    orderDelete: async () => ({}),
    orderById: async () => ({ status: 'WORKING' }) };
}
const liveRun = { variant: 'v7-10', spreadWidth: 10, tickIncrement: 0.05, dryRun: false };
const testRun = { ...liveRun, dryRun: 'test' };

const cfg = { spreadWidth: 20, strikeIncrement: 10, quantity: 1, tickIncrement: 0.05, coverFillModel: 'resting' };
const legs = [{ side: 'long', type: 'C', strike: 21990 }, { side: 'short', type: 'C', strike: 22010 }];
const coverLegs = [{ side: 'short', type: 'P', strike: 22010 }, { side: 'long', type: 'P', strike: 22030 }];
const getLeg = (type, strike) => {
  const d = (strike - 22000) * 0.45, mid = type === 'C' ? 400 - d : 400 + d;
  return { mid: Math.round(mid * 100) / 100, symbol: `NDX_${type}${strike}`, bid: mid - 0.2, ask: mid + 0.2 };
};
const mkPos = (orderId) => ({ id: 'p1', side: 'bull', filled: true, covered: false, quantity: 1, limit: 8.0, shortStrike: 22010, legs,
  pendingCover: { legs: coverLegs, target: 4.0, openCost: 8.0, minLock: 0, placedEpoch: Date.now(), placedUnder: 22050, orderId, sentNet: 'DEBIT' } });
const rec = (pos, rows) => ({ runId: 'r', config: { variant: 'v7-10' }, state: { liveOrders: rows, positions: [pos] }, events: [] });
const giveUpDeps = (replaceOrder) => ({ getLeg, coverGiveUp: true, giveUpPoints: 10, giveUpMaxLoss: 0.05, underlying: 21990, replaceOrder });

(async () => {
  // ── 1. TEST MODE: a test order the engine pulled — the simulated give-up lands, once, nothing sent ─────────
  {
    const c = client(); cs._setDeps({ isProd: true, tradingClient: c, accountHash: 'h' });
    const pos = mkPos('t1');
    const r = rec(pos, [{ orderId: 't1', kind: 'cover-rest', positionId: 'p1', status: 'canceled', testMode: true, canceledReason: 'test-auto-cancel' }]);
    const rp = cs.makeReplaceOrder(testRun, r);
    const all = [];
    for (let i = 0; i < 3; i++) { const d = []; await trader.workRestingCovers(r.state, cfg, d, giveUpDeps(rp), 21990); all.push(...d); }
    ok(pos.pendingCover.target > 4.0 && pos.pendingCover.gaveUp, `test-pulled: the give-up price moved (${pos.pendingCover.target})`);
    ok(all.filter((x) => x.action === 'cover-giveup').length === 1, 'test-pulled: exactly one give-up across three passes');
    ok(!all.some((x) => /not-sent$/.test(x.action)), 'test-pulled: no not-sent retry loop');
    ok(c.calls.upd.length === 0 && c.calls.place === 0, 'test-pulled: nothing reached the broker');
    ok(r.events.some((e) => e.type === 'order_simulated' && e.by === 'test-pulled'), 'test-pulled: recorded as simulated');
  }
  // Open reprice in test mode walks too.
  {
    const c = client(); cs._setDeps({ isProd: true, tradingClient: c, accountHash: 'h' });
    const legAt = (m) => (type, strike) => { const away = (type === 'C' ? 22010 - strike : strike - 21990) / 20; const mid = Math.round((2 + m * away) * 100) / 100; return { mid, symbol: `NDX_${type}${strike}`, bid: mid - 0.2, ask: mid + 0.2 }; };
    const pos = { id: 'o1', side: 'bull', legs, quantity: 1, limit: 10.2, cap: 13, filled: false, orderStatus: 'working', orderId: 't9', placedEpoch: 0 };
    const r = { runId: 'r', config: { variant: 'v7-10' }, state: { positions: [pos], pendingOpenId: 'o1',
      liveOrders: [{ orderId: 't9', kind: 'open', status: 'canceled', testMode: true, canceledReason: 'test-auto-cancel' }] }, events: [] };
    const d = [];
    await trader.resolvePendingOpen(r.state, cfg, { getLeg: legAt(10.6), coverLadder: true, ladderStepDollars: 0.25, nowMs: 300000, replaceOrder: cs.makeReplaceOrder(testRun, r) }, d);
    ok(pos.limit === 10.45 && !d.some((x) => x.action === 'open-reprice-not-sent'), `test-pulled open: the ladder walks (${pos.limit})`);
  }

  // ── 2. LIVE: a canceled real order — state cleared so the next pass places a NEW order ─────────────────
  for (const status of ['canceled', 'rejected']) {
    const c = client(); cs._setDeps({ isProd: true, tradingClient: c, accountHash: 'h' });
    const pos = mkPos('L1');
    const r = rec(pos, [{ orderId: 'L1', kind: 'cover-rest', positionId: 'p1', status }]);
    const rp = cs.makeReplaceOrder(liveRun, r);
    const out = await rp('L1', { orderType: 'NET_DEBIT', price: 5, legs: [] }, { kind: 'cover-giveup', of: 'p1' });
    ok(out.status === `skipped:${status}` && out.cleared === 'cover', `live ${status}: refused and the cover state cleared (${JSON.stringify(out)})`);
    ok(pos.pendingCover == null, `live ${status}: pendingCover cleared — the placement path re-places it`);
    ok(c.calls.upd.length === 0, `live ${status}: no replace was sent to a dead id`);
    ok(r.events.some((e) => e.type === 'order_replace_skipped' && e.cleared === 'cover'), `live ${status}: surfaced with what was cleared`);
    const d = [];
    await trader.workRestingCovers(r.state, cfg, d, giveUpDeps(rp), 21990);
    ok(!d.some((x) => /not-sent$/.test(x.action)), `live ${status}: no further retries against the dead id`);
  }

  // ── 3. REPLACED with a known live successor: reprice the successor, adopt its new id ────────────────────
  {
    const c = client(); cs._setDeps({ isProd: true, tradingClient: c, accountHash: 'h' });
    const pos = mkPos('R1');
    const r = rec(pos, [
      { orderId: 'R1', kind: 'cover-rest', positionId: 'p1', status: 'canceled', canceledReason: 'replaced', replacedBy: 'R2' },
      { orderId: 'R2', kind: 'cover-rest', positionId: 'p1', status: 'working', net: 'NET_DEBIT', placedAt: Date.now(), replaces: 'R1' }]);
    const d = [];
    await trader.workRestingCovers(r.state, cfg, d, giveUpDeps(cs.makeReplaceOrder(liveRun, r)), 21990);
    ok(c.calls.upd.length === 1 && c.calls.upd[0] === 'R2', `followed: the replace went to the live successor (${c.calls.upd})`);
    ok(pos.pendingCover.orderId === 'o2' && pos.pendingCover.gaveUp, `followed: the give-up landed and the new id was adopted (${pos.pendingCover.orderId})`);
    ok(r.events.some((e) => e.type === 'order_replace_followed'), 'followed: recorded');
  }

  // ── 4. SUPERSEDED BY A FILL: keep the state (applyBrokerFills is about to book the original's fill) ─────
  {
    const c = client(); cs._setDeps({ isProd: true, tradingClient: c, accountHash: 'h' });
    const pos = mkPos('S2');
    const r = rec(pos, [{ orderId: 'S2', kind: 'cover-rest', positionId: 'p1', status: 'canceled', supersededByFill: 'S1' }]);
    const out = await cs.makeReplaceOrder(liveRun, r)('S2', { orderType: 'NET_DEBIT', price: 5, legs: [] }, { kind: 'cover-giveup', of: 'p1' });
    ok(out.status === 'skipped:canceled' && !out.cleared && pos.pendingCover, 'superseded-by-fill: refused, state kept');
  }

  // ── 5. A TEST order dead for another reason (broker reject) is NOT treated as test-pulled ────────────────
  {
    const c = client(); cs._setDeps({ isProd: true, tradingClient: c, accountHash: 'h' });
    const pos = mkPos('T5');
    const r = rec(pos, [{ orderId: 'T5', kind: 'cover-rest', positionId: 'p1', status: 'rejected', testMode: true }]);
    const out = await cs.makeReplaceOrder(testRun, r)('T5', { orderType: 'NET_DEBIT', price: 5, legs: [] }, { kind: 'cover-giveup', of: 'p1' });
    ok(out.status === 'skipped:rejected' && !out.cleared && pos.pendingCover, 'test order rejected: refused, simulated state untouched');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL: threw ->', e && e.stack); process.exit(1); });
