'use strict';
// LADDER DIRECTION + RE-STRIKE RE-PLACE (2026-10-12, trigger catalog D8 / D10).
//   D10: cover-ladder.stepsEarned counts |move|, so a move TOWARD an order's price raised it exactly as a move
//        away did. deps/opts.ladderAdverseOnly counts only the adverse direction (time still earns steps).
//   D8:  the re-strike only cancelled; a new open needed the signal to fire again. deps/opts.openRestrikeReplace
//        queues the same side for the next open decision, at current strikes.
// Both off by default.
//
// Run: node server/tests/unit/candle-spread-ladder-direction-restrike.test.js
const trader = require('../../src/candle-spread/trader');
const LAD = require('../../src/candle-spread/cover-ladder');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const r2 = (x) => Math.round(x * 100) / 100;

const base = { symbol: 'NDX', spreadWidth: 10, strikeIncrement: 10, tickIncrement: 0.05, quantity: 1 };
const chain = (m) => (type, strike) => {
  const c = strike === 30900 ? 20 + m : strike === 30910 ? 20 : 20 - (strike - 30910) * 0.5;
  const mid = type === 'C' ? r2(c) : r2(c - (30905 - strike));
  return { mid, bid: r2(mid - 0.2), ask: r2(mid + 0.2), symbol: `NDX_${type}${strike}` };
};
const bullCall = [{ side: 'long', type: 'C', strike: 30900 }, { side: 'short', type: 'C', strike: 30910 }];

(async () => {
  // ── ladderMove ──────────────────────────────────────────────────────────────────────────────────
  ok(LAD.ladderMove(-12, 1, false) === -12, 'off: the move passes through unchanged (stepsEarned takes |move|)');
  ok(LAD.ladderMove(12, 1, true) === 12, 'on: an adverse move counts');
  ok(LAD.ladderMove(-12, 1, true) === 0, 'on: a favourable move earns nothing');
  ok(LAD.ladderMove(-12, -1, true) === 12, 'direction -1: a fall is adverse');

  // ── the live open ladder ────────────────────────────────────────────────────────────────────────
  // A bull open placed at 5.00 (cap 6.00) with NDX at 30905; the mark is 5.80, so the ladder has room.
  const mk = () => ({ positions: [{ id: 'o', side: 'bull', legs: bullCall, quantity: 1, limit: 5.0, cap: 6.0, ladderBase: 5.0,
    filled: false, orderStatus: 'working', openTime: '10/12 10:00', covered: false, pendingCover: null,
    placedEpoch: 0, placedUnder: 30905, placedMark: 5.8, looks: 5 }], pendingOpenId: 'o', realizedPnl: 0, cashDeployed: 0 });
  const deps = (under, extra) => ({ getLeg: chain(5.8), nowMs: 1000, underlying: under, openLadder: true,
    openLadderStepDollars: 0.05, ladderStepPoints: 5, ...extra });
  {
    const st = mk();
    await trader.resolvePendingOpen(st, base, deps(30885), []);
    ok(st.positions[0].limit > 5.0, `default: a 20-pt FAVOURABLE fall still walks the open up (${st.positions[0].limit})`);
  }
  {
    const st = mk();
    await trader.resolvePendingOpen(st, base, deps(30885, { ladderAdverseOnly: true }), []);
    ok(st.positions[0].limit === 5.0, `adverse-only: the favourable fall earns no step (${st.positions[0].limit})`);
  }
  {
    const st = mk();
    await trader.resolvePendingOpen(st, base, deps(30925, { ladderAdverseOnly: true }), []);
    ok(st.positions[0].limit > 5.0, `adverse-only: a 20-pt rise (away from a bull open) does (${st.positions[0].limit})`);
  }

  // ── re-strike queues a re-place ─────────────────────────────────────────────────────────────────
  {
    const MIN = 60000;
    const atCap = () => ({ positions: [{ id: 'r', side: 'bull', legs: bullCall, quantity: 1, limit: 5.5, cap: 5.5,
      filled: false, orderStatus: 'working', openTime: '10/12 10:05', covered: false, pendingCover: null,
      placedEpoch: 0, lastMoveEpoch: 0, atCapSince: 0 }], pendingOpenId: 'r', realizedPnl: 0, cashDeployed: 0 });
    const cfgR = { ...base, openRestrikeMin: 10 };
    let st = atCap();
    await trader.resolvePendingOpen(st, cfgR, { getLeg: chain(6.5), nowMs: 11 * MIN }, []);
    ok(st.positions[0].orderStatus === 'cancelled' && !st.restrike, 'default: cancelled, nothing queued');
    st = atCap();
    await trader.resolvePendingOpen(st, cfgR, { getLeg: chain(6.5), nowMs: 11 * MIN, openRestrikeReplace: true }, []);
    ok(st.restrike && st.restrike.side === 'bull' && st.restrike.n === 1 && st.restrike.of === 'r',
      `openRestrikeReplace: the side is queued for the next close (${JSON.stringify(st.restrike)})`);
    st = atCap(); st.positions[0].restrikeN = 2;
    await trader.resolvePendingOpen(st, cfgR, { getLeg: chain(6.5), nowMs: 11 * MIN, openRestrikeReplace: true }, []);
    ok(st.restrike && st.restrike.n === 3, 'the chain count carries (a re-place of a re-place is n+1; the close refuses past the max)');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
