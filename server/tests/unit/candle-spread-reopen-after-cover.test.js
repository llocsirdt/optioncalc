'use strict';
// REOPEN AFTER A QUICK COVER (2026-10-14, v7-10). An open that covers inside the current 15m signal window, with the
// underlying still between its strikes, is placed again: same strikes at min(paid, mark), or deeper ITM at no more
// than was paid; at most 2 per 5m bar; never against a cover signal on that side.
//
// Run: node server/tests/unit/candle-spread-reopen-after-cover.test.js
const os = require('os'), path = require('path'), fs = require('fs');
process.env.CANDLE_SPREAD_RUNS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-reopen-'));
const trader = require('../../src/candle-spread/trader');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

const S = 22000;
const tv = (k) => 6 * Math.exp(-Math.abs(S - k) / 40);
const r2 = (x) => Math.round(x * 100) / 100;
const getLeg = (type, k) => {
  const c = Math.max(S - k, 0) + tv(k), p = c - (S - k);
  const mid = r2(type === 'C' ? c : p);
  return { mid, bid: r2(mid - 0.1), ask: r2(mid + 0.1), symbol: `NDX_${type}${k}` };
};
const cfg = { symbol: 'NDX', expiration: '2026-10-15', spreadWidth: 10, strikeIncrement: 10, quantity: 1, tickIncrement: 0.05,
  coverFillModel: 'resting', variant: 'v7-10', reopenOnCover: true, capFrac: 0.65 };
const T0 = Date.parse('2026-10-15T13:45:00Z');      // 09:45 ET 15m decision
const bull = (lo, extra) => ({ id: 'p1', side: 'bull', legs: [{ side: 'long', type: 'C', strike: lo }, { side: 'short', type: 'C', strike: lo + 10 }],
  quantity: 1, limit: 5.5, filled: true, covered: true, coverFilledAt: T0 + 120000, placedEpoch: T0 + 1000, ...extra });
const sends = [];
const deps = (now) => ({ getLeg, nowMs: now, underlying: S, enforceLegUniqueness: false, capitalRecapture: false,
  placeOrder: async (payload, meta) => { sends.push({ payload, meta }); return { status: 'sent', filled: true, orderId: 'o' + sends.length }; } });
const mkSt = (pos, sig) => ({ positions: [pos], cashDeployed: 0, openN: 1, lastUnderlying: S,
  lastSignal15: { openSide: 'bull', coverSides: [], at: T0, ...(sig || {}) } });

(async () => {
  // paritySpot recovers the chain's spot
  ok(Math.abs(trader.paritySpot(getLeg, 21990, 10) - S) < 0.01, 'parity spot = the chain spot');

  // 1) mark below what was paid -> deeper ITM, never above paid
  {
    const st = mkSt(bull(21990, { limit: 9.0 })), d = [];   // 21990/22000 marks 8.67 < 9.00 paid; spot 22000 inside
    const n = await trader.reopenAfterCover(st, cfg, deps(T0 + 130000), d);
    const r = d.find((x) => x.action === 'reopen');
    ok(n === 1 && r, 'reopens a quick cover with spot inside the strikes');
    ok(r && r.limit <= 9.0, `never above the price paid (limit ${r && r.limit})`);
    ok(r && r.deeper === 1 && r.lower === 21980, `walks deeper ITM while it costs no more (lower ${r && r.lower}, deeper ${r && r.deeper})`);
    const np = st.positions.find((p) => p.reopenOf === 'p1');
    ok(np && np.cap === 9.0, 'the open ladder cannot walk past the price paid (cap)');
    ok(st.positions[0].reopened === true, 'the source is marked so it reopens once');
  }
  // 2) mark above paid -> the same strikes at the price paid
  {
    const st = mkSt(bull(21990, { limit: 2.0 })), d = [];
    await trader.reopenAfterCover(st, cfg, deps(T0 + 130000), d);
    const r = d.find((x) => x.action === 'reopen');
    ok(r && r.lower === 21990 && r.deeper === 0 && r.limit === 2.0, `same strikes at the price paid (${JSON.stringify(r)})`);
  }
  // 3) spot outside the strikes -> no reopen
  {
    const st = mkSt(bull(22100)), d = [];
    await trader.reopenAfterCover(st, cfg, deps(T0 + 130000), d);
    ok(!d.some((x) => x.action === 'reopen') && d.some((x) => x.action === 'reopen-skip'), 'underlying outside the strikes: skipped');
  }
  // 4) cover filled before the latest 15m decision -> not in the window
  {
    const st = mkSt(bull(21990, { coverFilledAt: T0 - 60000 })), d = [];
    ok(await trader.reopenAfterCover(st, cfg, deps(T0 + 130000), d) === 0, 'a cover before the 15m decision is out of the window');
  }
  // 5) a cover signal on that side since the decision -> no reopen
  {
    const st = mkSt(bull(21990), { coverSides: ['bull'] }), d = [];
    ok(await trader.reopenAfterCover(st, cfg, deps(T0 + 130000), d) === 0, 'a bull cover signal blocks a bull reopen');
  }
  // 6) decision now wants the other side and the position predates it -> no reopen
  {
    const st = mkSt(bull(21990, { placedEpoch: T0 - 600000 }), { openSide: 'bear' }), d = [];
    ok(await trader.reopenAfterCover(st, cfg, deps(T0 + 130000), d) === 0, 'an older bull does not reopen under a bear decision');
  }
  // 7) opened by this decision but the decision is now neutral -> still allowed (same 15m window)
  {
    const st = mkSt(bull(21990), { openSide: null }), d = [];
    ok(await trader.reopenAfterCover(st, cfg, deps(T0 + 130000), d) === 1, 'a position opened in this window reopens');
  }
  // 8) pace: 2 per 5m bar
  {
    const st = mkSt(bull(21990)), now = T0 + 130000;
    st.positions.push(bull(21990, { id: 'p2' }), bull(21990, { id: 'p3' }));
    let n = 0;
    for (let i = 0; i < 3; i++) { st.pendingOpenId = null; n += await trader.reopenAfterCover(st, cfg, deps(now), []); }
    ok(n === 2, `two reopens per 5m bar (got ${n})`);
    st.pendingOpenId = null;
    ok(await trader.reopenAfterCover(st, cfg, deps(now + 300000), []) === 1, 'the next 5m bar allows more');
  }
  // 9) off unless configured; one working open at a time
  {
    ok(await trader.reopenAfterCover(mkSt(bull(21990)), { ...cfg, reopenOnCover: false }, deps(T0 + 130000), []) === 0, 'off by default');
    const st = mkSt(bull(21990)); st.pendingOpenId = 'x';
    ok(await trader.reopenAfterCover(st, cfg, deps(T0 + 130000), []) === 0, 'waits while an open is working');
  }

  console.log(`reopen after cover: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
