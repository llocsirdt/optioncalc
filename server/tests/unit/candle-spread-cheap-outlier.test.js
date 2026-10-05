'use strict';
// TOO-CHEAP OUTLIER. 2026-10-05 09:45: every 10-wide priced the 30900/30910 bull call at 2.90 off single
// legs quoted $10-17 wide. Its neighbouring spreads put it at ~7.32, and 14 seconds later the same chain
// marked it 6.55. v7-10 sent a real order at 2.90 (it could never fill); every simulated 10-wide BOOKED it.
// The chain below is that bar's snapshot, verbatim. Pinned from both sides: the bad quote is refused at
// build AND at fill, and an ordinary chain still opens and fills.
//
// Run: node server/tests/unit/candle-spread-cheap-outlier.test.js
const SQ = require('../../src/candle-spread/spread-quote');
const T = require('../../src/candle-spread/trader');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

const SNAP = [
  [30860, 133.55, 125.1, 142, 39.65, 31.5, 47.8], [30870, 126.05, 117, 135.1, 42.25, 34, 50.5],
  [30880, 118.5, 110, 127, 44.85, 36.4, 53.3], [30890, 112.4, 103.6, 121.2, 47.5, 39.5, 55.5],
  [30900, 101.55, 96.5, 106.6, 51.7, 45, 58.4], [30910, 98.65, 89.9, 107.4, 54.85, 47.5, 62.2],
  [30920, 92.4, 83.6, 101.2, 60.3, 55, 65.6], [30930, 86.3, 77.6, 95, 60.75, 52, 69.5],
  [30940, 80.3, 71.5, 89.1, 64.8, 56, 73.6], [30950, 73.25, 65.7, 80.8, 70.45, 63, 77.9],
  [30960, 69.5, 65, 74, 77.75, 73, 82.5],
];
const chainOf = (rows) => {
  const m = new Map(rows.map((r) => [r[0], r]));
  return (type, strike) => {
    const r = m.get(strike); if (!r) return null;
    const [mid, bid, ask] = type === 'C' ? [r[1], r[2], r[3]] : [r[4], r[5], r[6]];
    return { mid, bid, ask, symbol: `NDXP 251005${type}${strike}` };
  };
};
const bad = chainOf(SNAP);
// A smooth chain: call verticals ~6.0 everywhere, puts consistent. Nothing here is an outlier.
const SMOOTH = SNAP.map(([k], i) => [k, 140 - 6 * i, 136 - 6 * i, 144 - 6 * i, 40 + 4 * i, 37 + 4 * i, 43 + 4 * i]);
const good = chainOf(SMOOTH);
const bullCall = (lo, hi) => [{ side: 'long', type: 'C', strike: lo }, { side: 'short', type: 'C', strike: hi }];

// ── the gate itself ─────────────────────────────────────────────────────────────────────────────────
{
  const r = SQ.cheapOutlier(bullCall(30900, 30910), bad);
  ok(!r.ok && r.mark === 2.9 && r.otherMid >= 6.25, `2.90 is refused: a further-OTM spread costs more (${r.reason})`);
  ok(SQ.cheapOutlier(bullCall(30910, 30920), bad).ok, 'the 30910/30920 spread (6.25) on the same chain passes');
  ok(SQ.cheapOutlier(bullCall(30900, 30910), good).ok, 'a smooth chain passes');
  // The S-curve that a straight-line fit got wrong (18.40, 9.99, [1.60], 0.01): ordered, so it passes.
  const bs = require('../../src/candle-spread/bs-pricer');
  const curve = (type, strike) => { const m = bs.bsPrice(type, 100, strike, 0.01, 0.4);
    return m == null ? null : { mid: Math.round(m * 100) / 100, bid: m - 0.1, ask: m + 0.1 }; };
  ok(SQ.cheapOutlier(bullCall(100, 120), curve, { incr: 10 }).ok, 'a steep but ordered S-curve near the money passes');
  // Abstains rather than guesses: no neighbours quoted -> ok.
  const thin = chainOf(SNAP.filter((r) => r[0] === 30900 || r[0] === 30910));
  ok(SQ.cheapOutlier(bullCall(30900, 30910), thin).ok, 'with no quoted neighbours it abstains');
  // Credit shape is not judged here (only debit verticals are recognised).
  ok(SQ.cheapOutlier([{ side: 'short', type: 'C', strike: 30900 }, { side: 'long', type: 'C', strike: 30910 }], bad).ok,
    'a credit-shaped vertical abstains');
}

// ── at BUILD: the adaptive walk skips the bad placement instead of sending it ──────────────────────
{
  const cfg = { spreadWidth: 10, strikeIncrement: 10, tickIncrement: 0.05, capFrac: 0.6, maxItmStrikes: 3 };
  const at = T.buildOpenAtStrikes('bull', 30900, 30910, cfg, bad);
  ok(at.error && /further out of the money/.test(at.error), `buildOpenAtStrikes refuses the 2.90 placement (${at.error})`);
  const res = T.buildOpenAdaptive('bull', 30949.42, cfg, bad);
  const ks = res.legs ? res.legs.map((l) => l.strike) : [];
  ok(!(ks.includes(30900) && ks.includes(30910)), `adaptive placement does not pick 30900/30910 (got ${ks.join('/') || res.reason})`);
  ok(res.declined || (res.limit >= 5.5), `whatever it does pick is not a sub-$5.50 phantom (limit ${res.limit}, ${res.reason || ''})`);
  const g = T.buildOpenAtStrikes('bull', 30900, 30910, cfg, good);
  ok(!g.error, `a smooth chain still builds the open (${g.error || g.limit})`);
}

// ── at FILL: the mark path cannot book the phantom ─────────────────────────────────────────────────
{
  const deps = { strikeIncrement: 10 };
  const f = T.markFill(bullCall(30900, 30910), 2.9, bad, 0.05, deps);
  ok(!f.fillable && /further out of the money/.test(f.badQuote || ''), `markFill refuses to book 2.90 (${f.badQuote})`);
  const g = T.markFill(bullCall(30900, 30910), 6.5, good, 0.05, deps);
  ok(g.fillable, 'markFill still books an ordinary fill on a smooth chain');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
