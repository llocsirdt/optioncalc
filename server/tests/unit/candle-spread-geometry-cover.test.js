'use strict';
// A COVER THAT IS NOT THE TENT.
//
// placeRestingCover resolved leg-uniqueness, and built the credit twin, from pos.shortStrike — the TENT's
// short strike — while the order it sent was plan.legs. For coverGeometry 'tent' those are the same spread
// and nothing diverged. For 'halfway' (v1) and 'underlying' (v2), and for the greedy/joint selectors that
// choose among candidate long strikes, they are DIFFERENT spreads, and three things came apart at once:
//
//   1. the ledger reserved the tent's strikes, which were never traded, and never recorded the geometry
//      strikes that were — so a later order could legally long a strike this cover had just shorted;
//   2. `conflicts()` was asked about the wrong legs, so a real conflict went unseen (and a phantom one on
//      the tent pushed later covers onto the ITM-slide path, which locked a guaranteed loss on 98 of 103);
//   3. on the credit style the SENT order was the twin of the TENT while pendingCover.legs was the
//      GEOMETRY spread — a different instrument — and resolveRestingCovers then decided the fill, booked
//      settlement and credited realizedPnl off the one that was never sent.
//
// Both geometries are LIVE: v1-* and v2-* run in the fleet. Measured in candle-spread-archive, 569 of
// 12,944 covers on the halfway and underlying variants sat at a short strike other than the position's.
//
// Run: node server/tests/unit/candle-spread-geometry-cover.test.js
const os = require('os'), path = require('path'), fs = require('fs');
process.env.CANDLE_SPREAD_RUNS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-geo-'));
const trader = require('../../src/candle-spread/trader');
const LL = require('../../src/candle-spread/leg-ledger');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const key = (l) => `${l.side[0]}${l.type}${l.strike}`;
const show = (ls) => (ls || []).map(key).sort().join(' ');

const W = 20;
const cfg = { symbol: 'NDX', expiration: '2026-09-24', spreadWidth: W, strikeIncrement: 10, quantity: 1,
  tickIncrement: 0.05, coverSelector: 'geometric', coverFillModel: 'resting', variant: 'geo' };
// Monotonic AND at parity: calls fall 0.8/point, puts rise 0.2/point, so a 20-wide call spread and the put
// spread at the same strikes sum to the width. Parity matters here because the credit twin is priced as
// W - debit and the fixture must not make that disagree with the chain.
const getLeg = (type, strike) => {
  const mid = type === 'C' ? 70 - (strike - 21990) * 0.8 : 20 + (strike - 22010) * 0.2;
  return { mid: Math.round(mid * 100) / 100, symbol: `NDX_${type}${strike}`, bid: mid - 0.2, ask: mid + 0.2 };
};
// A bull open at 21990/22010 — so the TENT cover is short P22010 / long P22030.
const mkPos = () => ({ id: 'p1', side: 'bull', legs: [{ side: 'long', type: 'C', strike: 21990 }, { side: 'short', type: 'C', strike: 22010 }],
  quantity: 1, limit: 8.0, shortStrike: 22010, filled: true, covered: false, pendingCover: null, openTime: '09/24 10:00' });
// The HALFWAY plan with the underlying at 22050: cover short at 22030, one increment beyond the tent.
const halfwayPlan = () => ({ legs: [{ side: 'short', type: 'P', strike: 22030 }, { side: 'long', type: 'P', strike: 22050 }],
  limit: 4.0, mark: 4.0, geometry: 'condor', longStrike: 22050 });
const TENT = 'sP22010 lP22030';
const GEO = 'lP22050 sP22030';

// A ledger that records what it is told AND answers conflicts honestly (a stub does neither, and
// LL.resolveCover then silently resolves to 'skip').
function mkLedger(preRecord) {
  const real = LL.makeLegLedger({});
  if (preRecord) real.record(preRecord);
  return { recorded: [], record(l) { this.recorded.push(...l); real.record(l); },
    conflicts: (l) => real.conflicts(l), sideOf: (t, k) => real.sideOf(t, k), size: () => real.size() };
}
const run = async (deps, pre) => {
  const st = { positions: [], cashDeployed: 0 }, d = [], sent = [];
  const pos = mkPos(); st.positions.push(pos);
  const ledger = mkLedger(pre);
  await trader.placeRestingCover(pos, halfwayPlan(), cfg,
    Object.assign({ getLeg, enforceLegUniqueness: true, _ledger: ledger,
      placeOrder: async (payload, meta) => { sent.push(meta); return { status: 'sent', filled: true, orderId: 'o1' }; } }, deps),
    '09/24 10:05', d, 'continuous', 0, st);
  return { pos, d, sent, ledger };
};

(async () => {
// ── 1. THE LEDGER RECORDS WHAT WAS TRADED ───────────────────────────────────────────────────────────
{
  const { pos, sent, ledger } = await run({ capitalRecapture: false });
  ok(sent.length === 1, 'the cover is sent');
  ok(show(sent[0].legs) === GEO, `and the SENT legs are the geometry spread (${show(sent[0].legs)})`);
  ok(show(ledger.recorded) === GEO, `the ledger records the strikes actually traded (${show(ledger.recorded)})`);
  ok(show(ledger.recorded) !== TENT, 'and NOT the tent, which was never traded — the regression');
  ok(show(pos.pendingCover.legs) === GEO, 'and the booked cover is the same instrument as the sent one');
}

// ── 2. A CONFLICT ON THE REAL LEGS IS SEEN ──────────────────────────────────────────────────────────
// The book is already LONG P22030. The geometry cover wants to SHORT it — the one thing leg-uniqueness
// exists to forbid. Resolving at the tent (short P22010 / long P22030) sees no conflict at all, because
// long P22030 is the same side, so the old code sent a short at a strike the book was long.
{
  const { sent, ledger, d } = await run({ capitalRecapture: false }, [{ side: 'long', type: 'P', strike: 22030 }]);
  const legs = sent.length ? sent[0].legs : [];
  const shortAt = legs.filter((l) => l.side === 'short' && l.type === 'P').map((l) => l.strike);
  ok(!shortAt.includes(22030),
    `a strike the book is already LONG is never shorted (sent ${show(legs) || 'nothing'})`);
  ok(show(legs) !== GEO, 'so the plan is not sent as-is');
  ok(sent.length === 0 || !ledger.recorded.some((l) => l.side === 'short' && l.type === 'P' && l.strike === 22030),
    'and the ledger is not handed a both-ways strike');
  ok(sent.length > 0 || d.some((x) => x.action === 'cover-skip-leg'),
    'either a legal alternative was found or the cover was skipped — never sent anyway');
}

// ── 3. THE CREDIT TWIN IS THE TWIN OF THE PLAN, NOT OF THE TENT ─────────────────────────────────────
// Capital recapture sends the credit twin at the SAME strikes, so the position record can stay
// debit-canonical. The twin of the tent is a different instrument, and booking one while sending the other
// is what made resolveRestingCovers decide the fill off legs that were never at the broker.
{
  const { pos, sent } = await run({ capitalRecapture: true, creditCoverFrac: 0.65 });
  ok(sent.length === 1 && sent[0].net === 'CREDIT', `the cover goes out as a credit (${sent.length && sent[0].net})`);
  ok(show(sent[0].legs) === 'lC22050 sC22030',
    `the twin is at the PLAN's strikes 22030/22050 (${show(sent[0].legs)})`);
  ok(show(sent[0].legs) !== 'lC22030 sC22010', 'and not the tent twin at 22010/22030 — the regression');
  ok(show(pos.pendingCover.legs) === GEO, 'while the booking stays debit-canonical at the same strikes');
  // Parity: the credit asked must be W - the debit the canonical side would have paid.
  const debit = Math.round((W - pos.limit) * 100) / 100;   // lock target, minLock 0
  ok(Math.abs(sent[0].limit - (W - debit)) < 0.051,
    `and asks W - debit = ${Math.round((W - debit) * 100) / 100} (asked ${sent[0].limit})`);
}

// ── 4. A PLAN THIS CODE CANNOT COVER IS REFUSED, NOT SUBSTITUTED ────────────────────────────────────
// Every rebuild below the resolver uses coverLegsFor(..., cfg.spreadWidth, ...). A plan of a different
// width would be silently swapped for a width-W instrument, which resolveCover's own note says does not
// cover the original — it re-introduces untracked risk on the opposite side.
{
  const st = { positions: [], cashDeployed: 0 }, d = [], sent = [];
  const pos = mkPos(); st.positions.push(pos);
  const wide = { legs: [{ side: 'short', type: 'P', strike: 22030 }, { side: 'long', type: 'P', strike: 22070 }],
    limit: 6.0, mark: 6.0, geometry: 'condor', longStrike: 22070 };
  await trader.placeRestingCover(pos, wide, cfg, { getLeg, enforceLegUniqueness: true, _ledger: mkLedger(),
    placeOrder: async (p, m) => { sent.push(m); return { status: 'sent', filled: true, orderId: 'o1' }; } },
    '09/24 10:05', d, 'continuous', 0, st);
  ok(sent.length === 0, 'a 40-wide cover plan on a 20-wide position sends nothing');
  ok(!pos.pendingCover, 'and books nothing');
  ok(d.some((x) => x.action === 'cover-not-sent' && /width/.test(x.reason || '')),
    'and says why, rather than substituting a width-20 spread');
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})();
