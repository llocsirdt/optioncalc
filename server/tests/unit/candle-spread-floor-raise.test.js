'use strict';
// FLOOR RAISE — the live pass (trader.raiseFloor) and the shared planner (floor-raise.js), pinned on REAL
// data: v7-10's book on 2026-10-05 just before the 15:45 open, priced off the 15:35 chain snapshot. The book
// had two valleys at -$780 (31040-31050 and 31070-31090); the user spotted the second and asked why no fly
// was bought (it settled 31076.44 at -$1,218). The rules, as the user set them:
//   valley by valley, LOWEST first; buy the best fix for that valley at >= 2:1 NET lift per dollar;
//   price at the mid (+2 ticks), never the quoted ask (NDX spreads and flies fill near the mid);
//   never push a locked profit (global floor >= 0) below zero.
//
// Run: node server/tests/unit/candle-spread-floor-raise.test.js
const T = require('../../src/candle-spread/trader');
const FR = require('../../src/candle-spread/floor-raise');
const RC = require('../../src/candle-spread/risk-curve');
const fx = require('./fixtures/floor-raise-2026-10-05-1535.json');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const tag = (legs) => legs.map((l) => `${l.side[0]}${l.type}${l.strike}`).join(' ');

const strikeMap = new Map(fx.strikes.map((s) => [s.strike, s]));
const getLeg = (t, k) => { const s = strikeMap.get(k); const q = s && s[t === 'C' ? 'call' : 'put']; return q && q.mid != null ? { ...q, symbol: `NDX_${t}${k}` } : null; };
const A = { '15m': { bbupper: fx.underlying * 1.003, bblower: fx.underlying * 0.997, close: fx.underlying } };
const cfg = { floorRaise: true, floorRaiseMinRatio: 2, spreadWidth: 10, strikeIncrement: 10, tickIncrement: 0.05, quantity: 1 };
const fresh = () => ({ positions: JSON.parse(JSON.stringify(fx.book)), realizedPnl: 0, cashDeployed: 0 });

(async () => {
  // ── the planner finds both valleys ──────────────────────────────────────────────────────────────
  {
    const xs = []; for (let x = 31030; x <= 31130; x += 10) xs.push(x);
    const vs = FR.valleys(xs.map((x) => RC.bookPnl(fx.book, x)));
    ok(vs.length >= 2 && vs.some((v) => xs[v.a] === 31040) && vs.some((v) => xs[v.a] === 31070),
      `both valleys found (${vs.map((v) => `${xs[v.a]}-${xs[v.b]}@${Math.round(v.min)}`).join(', ')})`);
  }

  // ── the live pass on the real book: both valleys fixed, lowest first, user's fly included ─────────
  {
    const st = fresh(); const d = []; const sent = [];
    const n = await T.raiseFloor(st, cfg, { getLeg, underlying: fx.underlying, A, nowMs: Date.parse(fx.time), strikeIncrement: 10,
      placeOrder: async (payload, meta) => { sent.push({ payload, meta }); return { orderId: `o${sent.length}` }; } }, d, '10/05 15:35');
    const raises = d.filter((x) => x.action === 'raise');
    ok(n === 2 && raises.length === 2, `two valley fixes placed in one pass (${n})`);
    // FAR valley -> an OFFSET spread (lifts the valley AND the tail beyond it); NEAR valley -> the fly. The
    // user's rule (2026-10-06): a fly leaves the lower ground beyond its range, a cheap offset raises it all.
    ok(raises[0] && raises[0].structure === 'vertical' && raises[0].valley.from === 31040,
      `the far 31040-31050 valley gets an offset spread (${raises[0] && raises[0].structure} ${raises[0] && tag(raises[0].legs)})`);
    ok(raises[1] && tag(raises[1].legs) === 'lP31060 sP31080 sP31080 lP31100', `the near 31070-31090 valley gets the user's fly (${raises[1] && tag(raises[1].legs)})`);
    ok(raises.every((r) => r.ratio >= 2), `every fix clears 2:1 (${raises.map((r) => r.ratio).join(', ')})`);
    ok(raises.every((r) => r.limit <= r.quotedMid + 0.15 + 1e-9 && r.limit < r.quotedAsk), 'priced at the mid + 2 ticks, not the quoted ask');
    ok(sent.every((s) => s.meta.kind === 'raise' && s.payload.orderType === 'NET_DEBIT'), 'sent as NET_DEBIT orders of kind raise');
    const fly = sent[1] && sent[1].payload;
    ok(fly && fly.complexOrderStrategyType === 'CUSTOM' && fly.orderLegCollection.length === 3
      && fly.orderLegCollection.find((l) => l.instruction === 'SELL_TO_OPEN').quantity === 2, 'the fly goes out as 3 legs with the body at quantity 2');
    const all = st.positions.map((p) => (p.raise ? { ...p, filled: true } : p));
    const atSettle = Math.round(RC.bookPnl(all, 31076.44));
    ok(atSettle > 0 && Math.round(RC.bookPnl(fx.book, 31076.44)) === -780, `at the real 31076.44 settle the book ends +$${atSettle} instead of -$780`);
    const gBefore = RC.bookFloor(fx.book, null, 10), gAfter = RC.bookFloor(all, null, 10);
    ok(gAfter > gBefore + 500, `the WHOLE floor rises, tail included (global ${Math.round(gBefore)} -> ${Math.round(gAfter)})`);
    ok(st.positions.filter((p) => p.raise).every((p) => p.filled === false && p.pendingHedge && p.pendingHedge.kind === 'raise'),
      'placed hedges are WORKING orders (pendingHedge kind raise), not booked fills');
    // One working at a time: a second pass while they are pending places nothing.
    const d2 = [];
    const n2 = await T.raiseFloor(st, cfg, { getLeg, underlying: fx.underlying, A, nowMs: Date.parse(fx.time) + 20 * 60000, strikeIncrement: 10,
      placeOrder: async () => ({ orderId: 'x' }) }, d2, '10/05 15:55');
    ok(n2 === 0, 'nothing new is planned while raises are still working');
  }

  // ── never trade a locked profit for a possible loss ─────────────────────────────────────────────
  {
    // A book whose global floor is +$100 everywhere: a bull call 31100/31110 at 4.00 plus a bear put
    // 31110/31100 at 5.00 pay $10 together at any settle, for $9.
    const locked = [
      { id: 'B', side: 'bull', filled: true, quantity: 1, limit: 4.0, covered: false,
        legs: [{ side: 'long', type: 'C', strike: 31100 }, { side: 'short', type: 'C', strike: 31110 }] },
      { id: 'R', side: 'bear', filled: true, quantity: 1, limit: 5.0, covered: false,
        legs: [{ side: 'long', type: 'P', strike: 31110 }, { side: 'short', type: 'P', strike: 31100 }] }];
    const g = RC.bookFloor(locked, null, 10);
    // Scored ONLY at 31090 (the fly's body), so it clearly lifts what it is scored on — the point is that
    // the GLOBAL floor check still catches the damage everywhere else.
    const xs = [31090];
    const base = xs.map((x) => RC.bookPnl(locked, x));
    // A fly costing more than the locked profit lifts its own point by plenty, but sinks the floor elsewhere.
    const dear = [{ kind: 'fly', legs: [{ side: 'long', type: 'P', strike: 31080 }, { side: 'short', type: 'P', strike: 31090 }, { side: 'short', type: 'P', strike: 31090 }, { side: 'long', type: 'P', strike: 31100 }] }];
    const r = FR.pickBest({ xs, base, cands: dear, price: () => ({ debit: 2.0 }), qty: 1, minRatio: 0, budget: Infinity, gNow: g,
      globalFloorWith: (legs, debit) => RC.bookFloor(locked, { legs, limit: debit, quantity: 1, covered: false }, 10), objective: 'band' });
    ok(g >= 0 && r.best == null && r.blockedLocked === 1, `a $200 hedge on a +$${Math.round(g)} locked book is refused (blocked ${r.blockedLocked})`);
  }

  // ── never push the floor past the day-loss cap (floorMin = -lossMax) ─────────────────────────────
  {
    // Real 15:35 book (global floor -780). A cap of $800 leaves $20 of room: the offset that lifts the far
    // valley costs $105 and drops the near valley to -885 -> past the cap -> refused.
    const book = fx.book;
    const xs = []; for (let x = 31030; x <= 31130; x += 10) xs.push(x);
    const base = xs.map((x) => RC.bookPnl(book, x));
    const offset = [{ kind: 'vertical', legs: [{ side: 'long', type: 'P', strike: 31060 }, { side: 'short', type: 'P', strike: 31050 }] }];
    const args = { xs, base, cands: offset, price: () => ({ debit: 1.05 }), qty: 1, minRatio: 2, budget: Infinity,
      gNow: RC.bookFloor(book, null, 10), spot: fx.underlying, bandLo: 31030, bandHi: 31130, objective: 'valley', liftMetric: 'min',
      globalFloorWith: (legs, debit) => RC.bookFloor(book, { legs, limit: debit, quantity: 1, covered: false }, 10) };
    ok(FR.pickBest(args).best != null, 'with no cap the offset is bought');
    const capped = FR.pickBest({ ...args, floorMin: -800 });
    ok(capped.best == null && capped.blockedLocked === 1, 'with lossMax 800 the same offset is refused (would put the floor at -885)');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
