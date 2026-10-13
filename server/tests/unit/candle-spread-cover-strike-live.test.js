'use strict';
// COVER STRIKE CHOICE, LIVE (2026-10-13) — the port of backtest-v6-5m's coverRange / giveUpGeometry (the roll was
// rejected by the user and is not ported).
// Pins:
//   1. placement picks the candidate strike closest to filling at its own price (tent-equivalent + k x premium),
//      the same rule as the backtest's pickK, and rests at that price
//   2. a give-up re-strikes the cover inside the open spread: simulated — re-placed at once; broker — the cancel
//      is requested and the pending cover KEPT until Schwab answers, then re-placed carrying the ladder's clock
//   3. the range re-strike runs at most every 5 minutes and moves the cover to the newly best strike
//   4. the ladder walks the tent-equivalent price: an order k strikes out sits k x premium off it
//
// Run: node server/tests/unit/candle-spread-cover-strike-live.test.js
const os = require('os'), path = require('path'), fs = require('fs');
process.env.CANDLE_SPREAD_RUNS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-cstrike-'));
const T = require('../../src/candle-spread/trader');
const bs = require('../../src/candle-spread/backtest/backtest-v4').bs;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const r2 = (x) => Math.round(x * 100) / 100;
const leg = (side, type, strike) => ({ side, type, strike });
const has = (legs, side, type, strike) => (legs || []).some((l) => l.side === side && l.type === type && l.strike === strike);

const TAU = 3 / (365 * 24), IV = 0.22;
const chainAt = (S) => (type, strike) => {
  const mid = r2(bs.bsPrice(type, S, strike, TAU, IV));
  return { mid, bid: r2(mid - 0.1), ask: r2(mid + 0.1), symbol: `NDXP_${type}${strike}` };
};
const markOf = (legs, g) => r2(legs.reduce((a, l) => a + (l.side === 'long' ? 1 : -1) * g(l.type, l.strike).mid, 0));

(async () => {
  const cfg20 = { symbol: 'NDX', expiration: '2026-10-13', spreadWidth: 20, strikeIncrement: 10, quantity: 1, tickIncrement: 0.05,
    coverFillModel: 'resting', coverGeometry: 'tent' };
  const rangeDeps = { coverRangeInside: 9, coverRangeBeyond: 2, coverRangePremium: 0.03, giveUpGeometry: 'inside',
    continuousCoverMinLockFrac: 0.1 };
  const bull20 = () => ({ id: 'b20', side: 'bull', legs: [leg('long', 'C', 30580), leg('short', 'C', 30600)], quantity: 1,
    limit: 9.5, shortStrike: 30600, filled: true, covered: false, pendingCover: null, openTime: '10/13 10:00' });
  const sends = [], cancels = [];
  const placeOrder = async (payload, meta) => { sends.push(meta); return { status: 'sent', filled: true, orderId: `o${sends.length}` }; };
  const cancelOrder = async (id, meta) => { cancels.push({ id, meta }); return { status: 'cancel-sent' }; };

  // ── 1. placement ────────────────────────────────────────────────────────────────────────────────
  {
    const S = 30612, g = chainAt(S), pos = bull20();
    const st = { positions: [pos], realizedPnl: 0, cashDeployed: 0 };
    const deps = { ...rangeDeps, getLeg: g, placeOrder, dryRun: true, underlying: S };
    await T.placeContinuousCovers(st, cfg20, deps, [], '10/13 10:05', S);
    // the backtest's pickK, restated: k from 2 down to -1, gap = mark - (eq + k x 0.6), first strict minimum
    const eq = r2(20 - 9.5 - 2), prem = 0.6;
    let best = null;
    for (let k = 2; k >= -1; k--) { const gap = markOf(T.coverLegsAtK(pos, k, cfg20), g) - (eq + k * prem); if (!best || gap < best.gap - 1e-9) best = { k, gap }; }
    const pc = pos.pendingCover;
    ok(pc && pc.k === best.k, `placed at the backtest's k (${pc && pc.k} vs ${best.k})`);
    ok(pc && Math.abs(pc.target - r2(eq + best.k * prem)) < 0.051, `rests at eq + k x premium (${pc && pc.target} vs ${r2(eq + best.k * prem)})`);
    ok(pc && T.coverKOf(pos, pc.legs, cfg20) === best.k, 'and the legs are that strike\'s');
  }

  // ── 2. give-up re-strike, simulated ─────────────────────────────────────────────────────────────
  {
    const S = 30585, g = chainAt(S), pos = bull20();
    pos.pendingCover = { legs: T.coverLegsAtK(pos, 0, cfg20), sentLegs: T.coverLegsAtK(pos, 0, cfg20), target: 8.5, k: 0, rangePrem: 0.6,
      openCost: 9.5, minLock: 2, orderId: 'old', placedEpoch: 1000, placedUnder: 30612 };
    const st = { positions: [pos], realizedPnl: 0, cashDeployed: 0, lastCandleTime: '10/13 10:30', legLedger: {} };
    const dec = [];
    const deps = { ...rangeDeps, getLeg: g, placeOrder, cancelOrder, dryRun: true, underlying: S, coverGiveUp: true, giveUpPoints: 10, giveUpMaxLoss: 0.05 };
    await T.workRestingCovers(st, cfg20, dec, deps, S);
    const pc = pos.pendingCover;
    ok(dec.some((d) => d.action === 'cover-restrike' && d.why === 'give-up' && d.toK === -1), 'give-up re-strikes inside');
    ok(pc && pc.k === -1 && has(pc.legs, 'short', 'P', 30590) && has(pc.legs, 'long', 'P', 30610),
      `re-placed one strike inside: short P30590 / long P30610 (${JSON.stringify(pc && pc.legs)})`);
    ok(pc && pc.placedEpoch === 1000 && pc.restruckForGiveUp, 'carrying the ladder clock');
    ok(cancels.some((c) => c.id === 'old'), 'the old (simulated) order is cancelled too');
  }

  // ── 2b. give-up re-strike, broker: cancel first, keep the pending cover until Schwab answers ────────
  {
    const S = 30585, g = chainAt(S), pos = bull20();
    pos.pendingCover = { legs: T.coverLegsAtK(pos, 0, cfg20), target: 8.5, k: 0, rangePrem: 0.6, openCost: 9.5, minLock: 2,
      orderId: 'live1', placedEpoch: 2000, placedUnder: 30612 };
    const st = { positions: [pos], realizedPnl: 0, cashDeployed: 0, lastCandleTime: '10/13 10:30', liveOrders: [] };
    const dec = [], n0 = sends.length;
    const deps = { ...rangeDeps, getLeg: g, placeOrder, cancelOrder, dryRun: false, fillSource: 'broker', underlying: S,
      coverGiveUp: true, giveUpPoints: 10, giveUpMaxLoss: 0.05 };
    await T.workRestingCovers(st, cfg20, dec, deps, S);
    ok(cancels.some((c) => c.id === 'live1' && /restrike/.test(c.meta.reason)), 'broker: the cancel is requested');
    ok(pos.pendingCover && pos.pendingCover.orderId === 'live1' && sends.length === n0, 'and nothing is re-sent while the old order may still fill');
    ok(pos.coverCarry && pos.coverCarry.k === -1, 'the target strike is carried');
    pos.pendingCover = null;   // the broker confirmed the cancel (order-manager.clearDeadOrderState)
    await T.placeContinuousCovers(st, cfg20, deps, dec, '10/13 10:31', S);
    ok(pos.pendingCover && pos.pendingCover.k === -1 && pos.pendingCover.placedEpoch === 2000 && !pos.coverCarry,
      're-placed at the carried strike on the next pass, ladder clock intact');
  }

  // ── 3. range re-strike at most every 5 minutes ──────────────────────────────────────────────────
  {
    const S = 30612, g = chainAt(S), pos = bull20();
    const legs2 = T.coverLegsAtK(pos, 2, cfg20);
    pos.pendingCover = { legs: legs2, sentLegs: legs2, target: r2(8.5 + 2 * 0.6), k: 2, rangePrem: 0.6, openCost: 9.5, minLock: 2,
      orderId: 'r1', placedEpoch: 0, placedUnder: S };
    const st = { positions: [pos], realizedPnl: 0, cashDeployed: 0, lastCandleTime: '10/13 11:00', legLedger: {} };
    const deps = { ...rangeDeps, getLeg: g, placeOrder, cancelOrder, dryRun: true, underlying: S, coverGiveUp: true, giveUpPoints: 10 };
    const want = T.pickCoverK(pos, 8.5, cfg20, deps);
    const dec = [];
    await T.workRestingCovers(st, cfg20, dec, { ...deps, nowMs: 4 * 60000 }, S);
    ok(!dec.some((d) => d.action === 'cover-restrike'), 'not before 5 minutes');
    await T.workRestingCovers(st, cfg20, dec, { ...deps, nowMs: 6 * 60000 }, S);
    if (want !== 2) ok(dec.some((d) => d.action === 'cover-restrike' && d.why === 'range') && pos.pendingCover.k === want,
      `after 5 minutes it moves to the best strike (${pos.pendingCover && pos.pendingCover.k} vs ${want})`);
    else ok(!dec.some((d) => d.action === 'cover-restrike'), 'k=2 is already best — nothing moves');
  }

  // ── 4. the ladder works in tent-equivalent terms ────────────────────────────────────────────────
  {
    const S = 30612, g = chainAt(S), pos = bull20();
    const legs1 = T.coverLegsAtK(pos, 1, cfg20);
    pos.pendingCover = { legs: legs1, sentLegs: legs1, target: r2(8.5 + 0.6), k: 1, rangePrem: 0.6, openCost: 9.5, minLock: 2,
      orderId: 'l1', placedEpoch: Date.now() - 60 * 60000, placedUnder: S, rangeCheckedAt: Date.now() };
    const st = { positions: [pos], realizedPnl: 0, cashDeployed: 0 };
    const dec = [];
    await T.workRestingCovers(st, cfg20, dec, { ...rangeDeps, getLeg: g, dryRun: true, underlying: S, coverLadder: true,
      ladderStepSeconds: 300, ladderSteps: 4, ladderLossCapFrac: 0.05 }, S);
    const rp = dec.find((d) => d.action === 'cover-reprice');
    const mark = markOf(legs1, g);
    ok(rp && rp.to <= mark + 0.05 + 1e-9, `a k=1 order may walk up to its OWN mark (${rp && rp.to} <= ${mark})`);
    ok(rp && rp.to > r2(8.5 + 0.6), 'and it does walk');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
