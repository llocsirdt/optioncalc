'use strict';
// SUB-BAR RESTING WORK. The candle tick prices an open from a chain snapshot and tests it against that
// same snapshot, so it can only ever say "fillable". The live worker re-reads the chain BETWEEN candles,
// which is the only way a resting open or cover gets a real answer. These cover the piece that matters:
// trader.resolvePendingOpen against a chain that has moved.
//
// Run: node server/tests/unit/candle-spread-resting-work.test.js
const os = require('os'), path = require('path'), fs = require('fs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-rw-'));
process.env.CANDLE_SPREAD_RUNS_DIR = tmp;
const store = require('../../src/candle-spread/store');
const trader = require('../../src/candle-spread/trader');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

const cfg = { symbol: 'NDX', expiration: '2026-08-30', spreadWidth: 20, strikeIncrement: 10, quantity: 1,
  tickIncrement: 0.05, coverSelector: 'fixed-mark', coverFillModel: 'resting', variant: 'rw' };
// A bull call spread 21990/22010, priced so the SPREAD mark is exactly `m`. Moving both legs by the same
// amount would leave the spread unchanged (long - short cancels it), which is why this sets the long leg
// alone — the first version of this fixture made that mistake and every "market moved" case silently
// tested a stationary mark.
const legAt = (m) => (type, strike) => {
  const mid = strike === 21990 ? Math.round((2 + m) * 100) / 100 : 2;
  return { mid, symbol: `NDX_${type}${strike}`, bid: mid - 0.2, ask: mid + 0.2 };
};
const legs = [{ side: 'long', type: 'C', strike: 21990 }, { side: 'short', type: 'C', strike: 22010 }];
function restingOpen(limit) {
  const st = { positions: [], pendingOpenId: 'p1', lastUnderlying: 22000 };
  st.positions.push({ id: 'p1', side: 'bull', legs, quantity: 1, limit, cap: 13, filled: false,
    orderStatus: 'working', openTime: '08/30 10:00', covered: false, pendingCover: null });
  return st;
}

// 1) The market comes to the order -> it fills, at the limit that was working.
{
  const st = restingOpen(10.20), d = [];
  trader.resolvePendingOpen(st, cfg, { getLeg: legAt(10.00), coverLadder: false }, d);   // mark 10.00
  const p = st.positions[0];
  ok(p.filled === true, 'mark at/through the limit fills the resting open');
  ok(st.pendingOpenId === null, 'pendingOpenId cleared on fill');
  ok(d.some(x => x.action === 'open-fill' && x.mark === 10), 'logs open-fill with the mark it saw');
}
// 2) The market runs AWAY -> no fill. This is the case the candle tick can never produce.
{
  const st = restingOpen(10.20), d = [];
  trader.resolvePendingOpen(st, cfg, { getLeg: legAt(10.60), coverLadder: false }, d);  // mark 10.60
  ok(st.positions[0].filled === false, 'a mark above the limit does not fill');
  ok(st.pendingOpenId === 'p1', 'the order keeps working');
  ok(!d.some(x => x.action === 'open-fill'), 'no fill logged');
}
// 3) With the ladder on, the limit walks toward the market — never past it, never past the ceiling.
{
  const st = restingOpen(10.20), d = [];
  const deps = { getLeg: legAt(10.60), coverLadder: true, ladderStepDollars: 0.25 };
  trader.resolvePendingOpen(st, cfg, deps, d);
  ok(st.positions[0].limit === 10.45, `ladder steps 10.20 -> 10.45 (got ${st.positions[0].limit})`);
  ok(d.some(x => x.action === 'open-reprice' && x.to === 10.45), 'logs open-reprice');
  // a second pass reaches the mark and stops there rather than paying through it
  const d2 = [];
  trader.resolvePendingOpen(st, cfg, deps, d2);
  ok(st.positions[0].limit === 10.6, `second step stops AT the mark 10.60 (got ${st.positions[0].limit})`);
  const d3 = [];
  trader.resolvePendingOpen(st, cfg, deps, d3);
  ok(st.positions[0].filled === true, 'once the limit reaches the mark it fills');
}
// 4) The 65% ceiling still binds a working order.
{
  const st = restingOpen(12.95), d = [];
  trader.resolvePendingOpen(st, cfg, { getLeg: legAt(13.50), coverLadder: true, ladderStepDollars: 0.25 }, d);
  ok(st.positions[0].limit <= 13, `ladder never walks past the ceiling (got ${st.positions[0].limit})`);
  ok(d.some(x => x.action === 'open-reprice' || x.action === 'open-rest'), 'ceiling case is logged');
}
// 5) Unquotable legs: no fill, no crash, no phantom position.
{
  const st = restingOpen(10.20), d = [];
  trader.resolvePendingOpen(st, cfg, { getLeg: () => null, coverLadder: true }, d);
  ok(st.positions[0].filled === false, 'an unquotable spread does not fill');
  ok(st.positions[0].limit === 10.20, 'and its limit is not walked on a price we cannot see');
}

// ---- PENDING HEDGES: offsets, wings and flies work like covers now -------------------------------
// Each was previously booked the instant it was priced, against the very marks that priced it — an
// offset from those mids, a wing or fly from the ASK while the test read the MID. None could be refused.
const hLegs = [{ side: 'long', type: 'C', strike: 29100 }, { side: 'short', type: 'C', strike: 29140 }];
const hLegAt = (m) => (type, strike) => {
  const mid = strike === 29100 ? Math.round((2 + m) * 100) / 100 : 2;
  return { mid, symbol: `NDX_${type}${strike}`, bid: mid - 0.2, ask: mid + 0.2 };
};
const pendingHedge = (kind, limit, placedEpoch) => ({ positions: [{
  id: kind + '-1', side: kind === 'offset' ? 'hedge' : kind, legs: hLegs, quantity: 1, limit,
  filled: false, hedge: true, covered: false, pendingCover: null,
  pendingHedge: { limit, kind, markAtPlace: limit, placedEpoch } }] });

{ // the market comes to it -> books, and the SPEND is counted here rather than at placement
  const st = pendingHedge('wing', 1.20, 1000), d = [];
  trader.resolvePendingHedges(st, cfg, { getLeg: hLegAt(1.00), nowMs: 1000 }, d);
  const p = st.positions[0];
  ok(p.filled === true, 'a hedge fills when a later mark reaches its limit');
  ok(p.pendingHedge === null, 'pendingHedge cleared on fill');
  ok(st.wingSpent > 0 && st.wingCount === 1, `spend counted at the FILL (got ${st.wingSpent})`);
  ok(d.some(x => x.action === 'wing-fill' && x.markLow != null), 'logs wing-fill with the low-water mark');
}
{ // the market stays away -> keeps working, nothing booked, no budget consumed
  const st = pendingHedge('fly', 1.20, 1000), d = [];
  trader.resolvePendingHedges(st, cfg, { getLeg: hLegAt(2.00), nowMs: 1000 }, d);
  ok(st.positions[0].filled === false, 'a hedge does NOT book while the mark is above its limit');
  ok(st.positions[0].pendingHedge != null, 'it keeps working');
  ok(!st.flySpent, 'no budget consumed by an unfilled hedge');
  ok(st.positions[0].markLow === 2, `low-water mark recorded even without a fill (got ${st.positions[0].markLow})`);
}
{ // stale: a hedge chosen for a curve shape that is long gone must not fill an hour later
  const st = pendingHedge('offset', 1.20, 0), d = [];
  trader.resolvePendingHedges(st, cfg, { getLeg: hLegAt(2.00), nowMs: 11 * 60 * 1000 }, d);
  ok(st.positions.length === 0, 'an unfilled hedge is dropped once it goes stale');
  ok(d.some(x => x.action === 'offset-expire'), 'and the expiry is logged, not silent');
}
{ // an expired hedge must not be counted as held
  const st = pendingHedge('offset', 1.20, 0), d = [];
  trader.resolvePendingHedges(st, cfg, { getLeg: hLegAt(2.00), nowMs: 11 * 60 * 1000 }, d);
  ok(!st.positions.some(p => p.hedge), 'no phantom hedge left in the book');
}

console.log(`\n${pass} passed, ${fail} failed`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
process.exit(fail ? 1 : 0);
