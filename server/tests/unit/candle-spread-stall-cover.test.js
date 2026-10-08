'use strict';
// STALL COVER (2026-10-08) — a position that has not moved our way within stallCoverMin minutes of filling stops
// waiting for its minLock target: its cover goes to break-even, or the market + a tick when that is better.
// 765 days x 50 governed at 15 min: avg/day +1.1%, maxDD better on 33/50, worst day better on 44/50.
//
// Run: node server/tests/unit/candle-spread-stall-cover.test.js
const T = require('../../src/candle-spread/trader');
const CS = require('../../src/candle-spread/index');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

(async () => {
  // A bull C31000/31010 paid 5.10; its cover (bear put 31010/31020) marks `m`. Break-even cover = 4.90.
  const legs = [{ side: 'short', type: 'P', strike: 31010 }, { side: 'long', type: 'P', strike: 31020 }];
  const chain = (m) => (t, k) => (t === 'P' ? { 31020: { mid: 20 + m, bid: 19.8 + m, ask: 20.2 + m, symbol: 'NDX_P31020' },
    31010: { mid: 20, bid: 19.8, ask: 20.2, symbol: 'NDX_P31010' } }[k] : null);
  const T0 = Date.parse('2026-10-08T14:00:00Z');
  const mk = () => ({ positions: [{ id: 'p', side: 'bull', filled: true, limit: 5.1, quantity: 1, shortStrike: 31010, covered: false,
    legs: [{ side: 'long', type: 'C', strike: 31000 }, { side: 'short', type: 'C', strike: 31010 }], fillEpoch: T0, fillUnder: 31005,
    pendingCover: { legs, target: 3.9, openCost: 5.1, minLock: 1, placedEpoch: T0, placedUnder: 31005, sentNet: 'DEBIT', orderId: 'o1' } }],
    realizedPnl: 0 });
  const cfg = { spreadWidth: 10, tickIncrement: 0.05, quantity: 1, symbol: 'NDX' };
  const deps = (over) => ({ coverGiveUp: true, giveUpPoints: 10, giveUpMaxLoss: 0.05, coverLadder: false, stallCoverMin: 15,
    replaceOrder: async () => ({ orderId: 'o2' }), ...over });

  // 1. 16 minutes, a point AGAINST us (the measured rule: moved < stallCoverPts our way, strictly), cover marks
  // 5.20 > break-even: the cover goes to break-even 4.90
  let st = mk(), d = [];
  await T.workRestingCovers(st, cfg, d, deps({ getLeg: chain(5.2), nowMs: T0 + 16 * 60000 }), 31004);
  const s1 = d.find((x) => x.action === 'cover-stall');
  ok(s1 && s1.to === 4.9, `stalled 16 min: the cover goes to break-even (${s1 && s1.to})`);
  // 2. market already better than break-even (cover marks 4.50): pay the market + a tick, lock a little
  st = mk(); d = [];
  await T.workRestingCovers(st, cfg, d, deps({ getLeg: chain(4.5), nowMs: T0 + 16 * 60000 }), 31004);
  const s2 = d.find((x) => x.action === 'cover-stall');
  ok(s2 && s2.to === 4.55, `market better than break-even: mark + a tick (${s2 && s2.to})`);
  // 3. too soon
  st = mk(); d = [];
  await T.workRestingCovers(st, cfg, d, deps({ getLeg: chain(5.2), nowMs: T0 + 10 * 60000 }), 31004);
  ok(!d.some((x) => x.action === 'cover-stall'), 'at 10 minutes nothing happens');
  // 4. it moved our way: no stall (a bull with the underlying 8 points higher)
  st = mk(); d = [];
  await T.workRestingCovers(st, cfg, d, deps({ getLeg: chain(5.2), nowMs: T0 + 16 * 60000 }), 31013);
  ok(!d.some((x) => x.action === 'cover-stall'), 'a position that moved our way keeps its patient target');
  // 5. off
  st = mk(); d = [];
  await T.workRestingCovers(st, cfg, d, deps({ getLeg: chain(5.2), nowMs: T0 + 16 * 60000, stallCoverMin: null }), 31004);
  ok(!d.some((x) => x.action === 'cover-stall'), 'stallCoverMin null: off');
  // 7. GIVE-UP NEVER LOWERS: a give-up cover working at 5.00 (cap) whose mark dips to 4.15 stays at 5.00
  {
    const st7 = mk(); st7.positions[0].pendingCover.target = 5.0; st7.positions[0].pendingCover.gaveUp = true; const d7 = [];
    // bull short 31010, underlying 30990: 20 points through -> give-up territory; cover mark 4.15
    await T.workRestingCovers(st7, cfg, d7, deps({ getLeg: chain(4.15), nowMs: T0 + 30 * 60000, stallCoverMin: null }), 30990);
    ok(!d7.some((x) => /cover-(giveup|reprice|stall)/.test(x.action) && x.to < 5.0), 'a working give-up cover is never pulled down when the mark dips');
  }
  // 6. roster
  ok(CS.buildRuns().every((r) => r.stallCoverMin === 15), 'every variant carries 15 minutes');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
