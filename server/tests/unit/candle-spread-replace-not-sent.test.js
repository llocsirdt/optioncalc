'use strict';
// A REPLACE THAT DID NOT HAPPEN MUST NOT MOVE THE BOOK (2026-10-04, before enabling give-up on v7-10).
// concedeCover (ladder + give-up) and the open ladder set the new price in memory, sent the replace, and
// ignored its result. A refused / blocked / skipped replace then left the engine believing a price was
// working that the broker never had — give-up never retried, because it re-sends only when its price
// differs from the working one.
const trader = require('../../src/candle-spread/trader');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

const cfg = { spreadWidth: 20, strikeIncrement: 10, quantity: 1, tickIncrement: 0.05, coverFillModel: 'resting' };
const legs = [{ side: 'long', type: 'C', strike: 21990 }, { side: 'short', type: 'C', strike: 22010 }];
const coverLegs = [{ side: 'short', type: 'P', strike: 22010 }, { side: 'long', type: 'P', strike: 22030 }];
// chain whose cover (put 22010/22030) marks ~9.00
const getLeg = (type, strike) => {
  const d = (strike - 22000) * 0.45, mid = type === 'C' ? 400 - d : 400 + d;
  return { mid: Math.round(mid * 100) / 100, symbol: `NDX_${type}${strike}`, bid: mid - 0.2, ask: mid + 0.2 };
};
const mkCover = () => ({ id: 'p1', side: 'bull', filled: true, covered: false, quantity: 1, limit: 8.0, shortStrike: 22010, legs,
  pendingCover: { legs: coverLegs, target: 4.0, openCost: 8.0, minLock: 0, placedEpoch: Date.now(), placedUnder: 22050, orderId: 'ord-1', sentNet: 'DEBIT' } });
const sender = (status) => { const calls = []; return { calls, fn: async (id, payload, meta) => { calls.push({ id, price: payload.price, meta }); return { status, orderId: status === 'replaced' ? 'ord-2' : id }; } }; };

(async () => {
  // ── GIVE-UP: refused, then retried ───────────────────────────────────────────────────────────────
  for (const bad of ['error', 'blocked:halted', 'skipped:cancel-requested', 'simulated:no-price']) {
    const pos = mkCover(), st = { positions: [pos] };
    const s1 = sender(bad), d1 = [];
    const deps = { getLeg, coverGiveUp: true, giveUpPoints: 10, giveUpMaxLoss: 0.05, underlying: 21990, replaceOrder: s1.fn };
    await trader.workRestingCovers(st, cfg, d1, deps, 21990);       // 20 pts through the short strike
    ok(s1.calls.length === 1, `${bad}: give-up attempted the replace`);
    ok(pos.pendingCover.target === 4.0 && !pos.pendingCover.gaveUp, `${bad}: the working price stays 4.00 (got ${pos.pendingCover.target})`);
    ok(d1.some((x) => x.action === 'cover-giveup-not-sent'), `${bad}: logged as not sent`);
    const s2 = sender('replaced'), d2 = [];
    await trader.workRestingCovers(st, cfg, d2, { ...deps, replaceOrder: s2.fn }, 21990);
    ok(s2.calls.length === 1 && pos.pendingCover.target > 4.0 && pos.pendingCover.gaveUp, `${bad}: the next pass RETRIES and the give-up lands (${pos.pendingCover.target})`);
    ok(pos.pendingCover.orderId === 'ord-2', `${bad}: and adopts the replacement id`);
  }
  // A successful give-up is unchanged behaviour.
  {
    const pos = mkCover(), s = sender('replaced'), d = [];
    await trader.workRestingCovers({ positions: [pos] }, cfg, d, { getLeg, coverGiveUp: true, giveUpPoints: 10, giveUpMaxLoss: 0.05, underlying: 21990, replaceOrder: s.fn }, 21990);
    ok(d.some((x) => x.action === 'cover-giveup') && pos.pendingCover.gaveUp, 'a replace that lands moves the price as before');
  }
  // Simulation (no broker order id): nothing is sent, nothing reverts.
  {
    const pos = mkCover(); pos.pendingCover.orderId = null; const d = [];
    await trader.workRestingCovers({ positions: [pos] }, cfg, d, { getLeg, coverGiveUp: true, giveUpPoints: 10, giveUpMaxLoss: 0.05, underlying: 21990, replaceOrder: sender('error').fn }, 21990);
    ok(pos.pendingCover.target > 4.0, 'with no broker order the simulated price still moves');
  }
  // ── COVER LADDER: the step is not consumed by a failed replace ─────────────────────────────────────
  {
    const pos = mkCover(); pos.pendingCover.placedEpoch = Date.now() - 10 * 60000;   // steps earned
    const st = { positions: [pos] };
    const deps = { getLeg, coverLadder: true, ladderStepSeconds: 120, ladderStepPoints: 10, ladderStepDollars: 0.05, ladderLossCapFrac: 0, underlying: 22050 };
    await trader.workRestingCovers(st, cfg, [], { ...deps, replaceOrder: sender('error').fn }, 22050);
    ok(pos.pendingCover.target === 4.0 && pos.pendingCover.ladderStep == null, 'ladder: failed replace leaves price AND step untouched');
    const s = sender('replaced');
    await trader.workRestingCovers(st, cfg, [], { ...deps, replaceOrder: s.fn }, 22050);
    ok(s.calls.length === 1 && pos.pendingCover.target > 4.0, `ladder: the next pass takes the step (${pos.pendingCover.target})`);
  }
  // ── OPEN LADDER ─────────────────────────────────────────────────────────────────────────────────────
  {
    const legAt = (m) => (type, strike) => { const away = (type === 'C' ? 22010 - strike : strike - 21990) / 20; const mid = Math.round((2 + m * away) * 100) / 100; return { mid, symbol: `NDX_${type}${strike}`, bid: mid - 0.2, ask: mid + 0.2 }; };
    const pos = { id: 'o1', side: 'bull', legs, quantity: 1, limit: 10.2, cap: 13, filled: false, orderStatus: 'working', orderId: 'brk-1', placedEpoch: 0 };
    const st = { positions: [pos], pendingOpenId: 'o1' }, d = [];
    await trader.resolvePendingOpen(st, cfg, { getLeg: legAt(10.6), coverLadder: true, ladderStepDollars: 0.25, nowMs: 300000, replaceOrder: sender('blocked:halted').fn }, d);
    ok(pos.limit === 10.2 && d.some((x) => x.action === 'open-reprice-not-sent'), `open ladder: a refused replace leaves the limit at 10.20 (${pos.limit})`);
    const s = sender('replaced');
    await trader.resolvePendingOpen(st, cfg, { getLeg: legAt(10.6), coverLadder: true, ladderStepDollars: 0.25, nowMs: 300000, replaceOrder: s.fn }, []);
    ok(s.calls.length === 1 && pos.limit === 10.45, `open ladder: retried and walked on the next pass (${pos.limit})`);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL: threw ->', e && e.stack); process.exit(1); });
