'use strict';
// SIMULATED-FILL REALISM (2026-10-05). The simulated variants booked 66% of opens on the very look that
// placed them and 64% of covers at 0-1 tick through, while v7-10's real orders at the same prices took
// 1-34 looks and sometimes never filled. Three rules, all pinned here:
//   1. cfg.simOpenFillMinLooks = 2 — a simulated open cannot fill on the look that placed it.
//   2. cfg.coverFillThroughTicks = 1 — a simulated cover needs the market a tick BETTER than its price.
//   3. a credit-sent cover is judged on its OWN (sent) legs, not by parity off the debit legs.
// The engine defaults stay legacy (1 look, 0 ticks); the roster turns the rules on for every variant —
// also pinned below, since a rule only the tests turn on is not a rule.
//
// Run: node server/tests/unit/candle-spread-sim-fill-realism.test.js
const trader = require('../../src/candle-spread/trader');
const CS = require('../../src/candle-spread/index');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const r2 = (x) => Math.round(x * 100) / 100;

const W = 10;
const base = { symbol: 'NDX', spreadWidth: W, strikeIncrement: 10, tickIncrement: 0.05, quantity: 1 };
// A clean chain: the 30900/30910 bull call marks `m`; puts by parity (S = 30905).
const chain = (m) => (type, strike) => {
  const c = strike === 30900 ? 20 + m : strike === 30910 ? 20 : 20 - (strike - 30910) * 0.5;
  const mid = type === 'C' ? r2(c) : r2(c - (30905 - strike));
  return { mid, bid: r2(mid - 0.2), ask: r2(mid + 0.2), symbol: `NDX_${type}${strike}` };
};
const bullCall = [{ side: 'long', type: 'C', strike: 30900 }, { side: 'short', type: 'C', strike: 30910 }];

// ── 1. OPEN: not on the placing look ───────────────────────────────────────────────────────────────
(async () => {
  const mk = () => ({ positions: [{ id: 'o', side: 'bull', legs: bullCall, quantity: 1, limit: 5.5, cap: 6,
    filled: false, orderStatus: 'working', openTime: '10/05 10:00', covered: false, pendingCover: null, placedEpoch: 0 }],
  pendingOpenId: 'o', realizedPnl: 0, cashDeployed: 0 });
  const cfg2 = { ...base, simOpenFillMinLooks: 2 };
  const st = mk(); const d = [];
  await trader.resolvePendingOpen(st, cfg2, { getLeg: chain(5.5) }, d);
  ok(st.positions[0].filled === false, 'a simulated open at the mark does NOT fill on the look that placed it');
  ok(d.some((x) => x.action === 'open-rest' && /later observation/.test(x.reason || '')), 'and says why');
  await trader.resolvePendingOpen(st, cfg2, { getLeg: chain(5.5) }, []);
  ok(st.positions[0].filled === true, 'it fills on the NEXT look if the mark is still there (touch is fine for opens)');
  const leg = mk();
  await trader.resolvePendingOpen(leg, base, { getLeg: chain(5.5) }, []);
  ok(leg.positions[0].filled === true, 'engine default (no cfg) keeps the legacy instant fill');

  // ── 2. COVER: one tick through ──────────────────────────────────────────────────────────────────
  // A bull call position covered by a debit bear-call... modelled here as a resting DEBIT cover on the same
  // legs priced by `chain`: target 4.00.
  const mkCov = (pcOver = {}) => ({ id: 'c', side: 'bull', filled: true, covered: false, quantity: 1, limit: 5.5,
    legs: bullCall, shortStrike: 30910,
    pendingCover: { legs: bullCall, target: 4.0, openCost: 5.5, minLock: 0, placedEpoch: 1, placedUnder: 30905,
      sentNet: 'DEBIT', ...pcOver } });
  const cfgC = { ...base, coverFillThroughTicks: 1 };
  let p = mkCov();
  trader.resolveRestingCovers({ positions: [p], realizedPnl: 0 }, cfgC, chain(4.0), [], {});
  ok(p.covered === false, 'a cover whose mark only TOUCHES its target does not fill');
  p = mkCov();
  trader.resolveRestingCovers({ positions: [p], realizedPnl: 0 }, cfgC, chain(3.95), [], {});
  ok(p.covered === true, 'one tick through fills');
  p = mkCov();
  trader.resolveRestingCovers({ positions: [p], realizedPnl: 0 }, base, chain(4.0), [], {});
  ok(p.covered === true, 'engine default (no cfg) keeps the legacy touch fill');

  // ── 3. CREDIT COVER judged on its SENT legs ─────────────────────────────────────────────────────
  // Booked legs = the bull call; sent = the bull put credit twin (short P30910 / long P30900), asking 6.00.
  const twin = [{ side: 'short', type: 'P', strike: 30910 }, { side: 'long', type: 'P', strike: 30900 }];
  const credit = (pcOver) => mkCov({ sentNet: 'CREDIT', sentCredit: 6.0, sentLegs: twin, ...pcOver });
  // Calls say the twin should offer 10 - 3.0 = 7.00 by parity, but the PUTS actually quote a 5.00 credit.
  const skewed = (type, strike) => {
    if (type === 'C') return chain(3.0)(type, strike);
    const mid = strike === 30910 ? 30 : 25;   // short P30910 / long P30900 nets 25 - 30 = -5.00 -> 5.00 credit
    return { mid, bid: mid - 0.2, ask: mid + 0.2, symbol: `NDX_P${strike}` };
  };
  p = credit();
  trader.resolveRestingCovers({ positions: [p], realizedPnl: 0 }, base, skewed, [], {});
  ok(p.covered === false, 'a credit cover does NOT fill on a parity credit (7.00) its own legs never offered (5.00)');
  ok(p.pendingCover.markLow != null && p.pendingCover.atOrThrough == null,
    `and its evidence records the twin never reached 6.00 (markLow ${p.pendingCover.markLow})`);
  const fair = (type, strike) => {
    if (type === 'C') return chain(3.0)(type, strike);
    const mid = strike === 30910 ? 30 : 23.9;   // nets -6.10 -> a 6.10 credit on the twin itself
    return { mid, bid: mid - 0.2, ask: mid + 0.2, symbol: `NDX_P${strike}` };
  };
  p = credit();
  trader.resolveRestingCovers({ positions: [p], realizedPnl: 0 }, { ...base, coverFillThroughTicks: 1 }, fair, [], {});
  ok(p.covered === true, 'it fills when the twin itself offers a tick more than the ask (6.10 vs 6.00)');
  p = credit({ sentLegs: undefined });
  trader.resolveRestingCovers({ positions: [p], realizedPnl: 0 }, base, skewed, [], {});
  ok(p.covered === true, 'with no sent legs recorded it falls back to parity (7.00 >= 6.00)');

  // ── 4. STALE OPEN: released after 90 min without a fill or a move (simulated path only) ───────────
  // 2026-10-05: credit-sent opens parked at their ceiling worked from 10:05 to the close and blocked the
  // slot (720 open-skip-pending fleet-wide). Live and the backtest both release after 90 min.
  {
    const mkStuck = (lastMove) => ({ positions: [{ id: 's', side: 'bull', legs: bullCall, quantity: 1, limit: 5.0, cap: 5.0,
      filled: false, orderStatus: 'working', openTime: '10/05 10:05', covered: false, pendingCover: null,
      placedEpoch: 0, ...(lastMove != null ? { lastMoveEpoch: lastMove } : {}) }], pendingOpenId: 's', realizedPnl: 0, cashDeployed: 0 });
    const MIN = 60000;
    let st = mkStuck(); let d = [];
    await trader.resolvePendingOpen(st, base, { getLeg: chain(6.0), nowMs: 89 * MIN }, d);
    ok(st.pendingOpenId === 's' && st.positions[0].orderStatus === 'working', 'at 89 min an unfilled open is still working');
    st = mkStuck(); d = [];
    await trader.resolvePendingOpen(st, base, { getLeg: chain(6.0), nowMs: 91 * MIN }, d);
    ok(st.pendingOpenId == null && st.positions[0].orderStatus === 'cancelled', 'at 91 min with no move it is released');
    ok(d.some((x) => x.action === 'open-stale' && x.restedMin === 91), 'and the release is logged with how long it rested');
    st = mkStuck(60 * MIN); d = [];
    await trader.resolvePendingOpen(st, base, { getLeg: chain(6.0), nowMs: 91 * MIN }, d);
    ok(st.pendingOpenId === 's', 'the clock runs from the LAST MOVE: repriced at 60 min, still working at 91');
    st = mkStuck(); d = [];
    await trader.resolvePendingOpen(st, base, { getLeg: chain(6.0), nowMs: 91 * MIN, fillSource: 'broker' }, d);
    ok(st.pendingOpenId === 's', 'under the broker it is untouched (the order manager owns the real order)');
  }

  // ── 5. RE-STRIKE TIMEOUT: at its cap for N minutes without a fill -> cancelled (both paths) ───────────
  {
    const MIN = 60000;
    const atCap = (over = {}) => ({ positions: [{ id: 'r', side: 'bull', legs: bullCall, quantity: 1, limit: 5.5, cap: 5.5,
      filled: false, orderStatus: 'working', openTime: '10/05 10:05', covered: false, pendingCover: null,
      placedEpoch: 0, lastMoveEpoch: 0, ...over }], pendingOpenId: 'r', realizedPnl: 0, cashDeployed: 0 });
    const cfgR = { ...base, openRestrikeMin: 10 };
    let st = atCap(); let d = [];
    await trader.resolvePendingOpen(st, cfgR, { getLeg: chain(6.5), nowMs: 1 * MIN }, d);
    ok(st.pendingOpenId === 'r' && st.positions[0].atCapSince === 1 * MIN, 'the clock starts the first time the open is seen AT its cap');
    await trader.resolvePendingOpen(st, cfgR, { getLeg: chain(6.5), nowMs: 10 * MIN }, d);
    ok(st.pendingOpenId === 'r', 'at 9 min on the cap it is still working');
    await trader.resolvePendingOpen(st, cfgR, { getLeg: chain(6.5), nowMs: 11 * MIN }, d);
    ok(st.pendingOpenId == null && st.positions[0].orderStatus === 'cancelled', 'at 10 min on the cap it is cancelled (re-strike)');
    ok(d.some((x) => x.action === 'open-restrike' && x.atCapMin === 10), 'and logged as open-restrike');
    // Below its cap the timeout does not run — the ladder is still working it.
    st = atCap({ limit: 5.2 }); d = [];
    await trader.resolvePendingOpen(st, cfgR, { getLeg: chain(6.5), nowMs: 30 * MIN }, d);
    ok(st.pendingOpenId === 'r' && st.positions[0].atCapSince == null, 'an open still below its cap is never re-struck');
    // Off by default.
    st = atCap({ atCapSince: 0 }); d = [];
    await trader.resolvePendingOpen(st, base, { getLeg: chain(6.5), nowMs: 30 * MIN }, d);
    ok(st.pendingOpenId === 'r', 'without openRestrikeMin nothing changes');
    // Under the broker: the cancel is SENT and the position kept until Schwab answers (the reversal rule).
    const sent = [];
    st = atCap({ atCapSince: 0, orderId: 'ord-9' }); d = [];
    await trader.resolvePendingOpen(st, cfgR, { getLeg: chain(6.5), nowMs: 11 * MIN, fillSource: 'broker',
      cancelOrder: async (id, meta) => { sent.push({ id, meta }); return { ok: true }; } }, d);
    ok(sent.length === 1 && sent[0].id === 'ord-9' && sent[0].meta.reason === 'restrike', 'under the broker the cancel goes to Schwab');
    ok(st.pendingOpenId == null && st.positions[0].cancelRequestedAt === 11 * MIN, 'slot freed, position kept awaiting the broker');
  }

  ok(CS.buildRuns().every((r) => r.openRestrikeMin === 10), 'every roster variant carries the 10-minute re-strike timeout');

  // ── the ROSTER turns 1 and 2 on for every variant ───────────────────────────────────────────────
  const runs = CS.buildRuns();
  ok(runs.length > 0 && runs.every((r) => r.simOpenFillMinLooks === 2 && r.coverFillThroughTicks === 1),
    `every roster variant carries simOpenFillMinLooks 2 / coverFillThroughTicks 1 (${runs.length} runs)`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
