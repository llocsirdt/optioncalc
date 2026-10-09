'use strict';
// PLACEMENT G (2026-10-05) — the user's strike rule in the LIVE engine: the deepest-ITM placement priced
// inside a band [minDebitFrac, capFrac] x W, stepping up to maxOtmStrikes out of the money when even
// short-at-the-money is too dear, and an open ladder allowed to walk to openWalkCapFrac x W. The backtest
// was measured with exactly these knobs (backtest-width.makeAdaptiveGeo + opts.openWalkCapFrac); this pins
// that the live trader honours them too, so the roster is not a backtest-only promise.
//
// Run: node server/tests/unit/candle-spread-placement-g.test.js
const trader = require('../../src/candle-spread/trader');
const CS = require('../../src/candle-spread/index');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const r2 = (x) => Math.round(x * 100) / 100;

// A smooth 10-wide chain. Bull call verticals 10 apart price at base + step*k (deeper = dearer).
// spreadAt(shortStrike) for a bull call (long shortStrike-10 / short shortStrike).
const mkChain = (vertAtShort) => {
  const calls = new Map();
  // Build call mids top-down so each adjacent 10-wide vertical equals vertAtShort(short strike).
  let c = 5;
  for (let K = 31200; K >= 30600; K -= 10) { calls.set(K, r2(c)); c += vertAtShort(K); }
  return (type, strike) => {
    const cm = calls.get(strike);
    if (cm == null) return null;
    const mid = type === 'C' ? cm : r2(cm - (30905 - strike));   // puts by parity, S = 30905
    return { mid, bid: r2(mid - 0.1), ask: r2(mid + 0.1), symbol: `NDX_${type}${strike}` };
  };
};
// Vertical value by the SHORT strike's distance into the money (S = 30905): 5.20 at the money, +0.30 per
// strike deeper, -0.30 per strike out.
const sATM = (shortK) => r2(5.2 + (30900 - shortK) / 10 * 0.3);
const chain = mkChain(sATM);
const G10 = { spreadWidth: 10, strikeIncrement: 10, tickIncrement: 0.05, quantity: 1,
  adaptiveGeo: true, maxItmStrikes: 3, capFrac: 0.53, minDebitFrac: 0.48, openWalkCapFrac: 0.55, maxOtmStrikes: 1 };

{
  const res = trader.buildOpenAdaptive('bull', 30905, G10, chain);
  ok(!res.declined && res.limit <= 5.30 + 1e-9 && res.limit >= 4.80, `G picks a placement inside $4.80-5.30 (limit ${res.limit})`);
  ok(res.legs && res.legs.find((l) => l.side === 'short').strike === 30900, `the deepest one that fits: short at 30900 (${JSON.stringify(res.legs)})`);
  ok(res.cap === 5.5, `the ladder may walk to $5.50, above the $5.30 placement ceiling (cap ${res.cap}, placementCap ${res.placementCap})`);
  const A = trader.buildOpenAdaptive('bull', 30905, { ...G10, capFrac: 0.60, minDebitFrac: undefined, openWalkCapFrac: undefined, maxOtmStrikes: 0 }, chain);
  ok(A.limit > 5.3 && A.cap === 6, `the old rule (deepest ITM <= $6) goes dearer for comparison (limit ${A.limit}, cap ${A.cap})`);
}
{
  // Everything at or inside the money is over $5.30: G steps ONE strike out.
  const dear = mkChain((k) => r2(5.6 + (30900 - k) / 10 * 0.3));
  const res = trader.buildOpenAdaptive('bull', 30905, G10, dear);
  const sh = res.legs && res.legs.find((l) => l.side === 'short').strike;
  ok(!res.declined && sh === 30910 && res.itmStrikes === -1, `sATM too dear -> one strike OUT (short ${sh}, itm ${res.itmStrikes}, limit ${res.limit})`);
  const noOtm = trader.buildOpenAdaptive('bull', 30905, { ...G10, maxOtmStrikes: 0 }, dear);
  ok(noOtm.declined, 'without the OTM step the same chain is declined');
}
{
  // Everything that fits under $5.30 is also under the $4.80 floor: the floor LABELS, never refuses (user,
  // 2026-10-09) — the deepest placement is taken at its mark, flagged belowBand, and the ladder walks it up.
  const cheap = mkChain((k) => r2(4.0 + (30900 - k) / 10 * 0.1));
  const res = trader.buildOpenAdaptive('bull', 30905, G10, cheap);
  const sh = res.legs && res.legs.find((l) => l.side === 'short').strike;
  ok(!res.declined && res.belowBand === true && res.limit < 4.8, `a cheap band is placed at its mark, not declined (limit ${res.limit}, belowBand ${res.belowBand})`);
  ok(sh === 30870, `still the DEEPEST placement under the cap: 3 strikes ITM (short ${sh})`);
  const inBand = trader.buildOpenAdaptive('bull', 30905, G10, chain);
  ok(inBand.belowBand === undefined, 'an in-band placement carries no belowBand label');
}
{
  // Roster: every adaptive variant carries G for its width; -unc twins match their parent; -cATM untouched.
  const runs = CS.buildRuns();
  const by = Object.fromEntries(runs.map((r) => [r.variant, r]));
  const g = (r) => [r.minDebitFrac, r.capFrac, r.openWalkCapFrac, r.maxOtmStrikes].join('/');
  // ONE BAND, EVERY WIDTH (2026-10-09): 50% +/- 5% of width, walk ceiling = cap.
  ok(g(by['v7-10']) === '0.45/0.55/0.55/1', `v7-10 carries the band (${g(by['v7-10'])})`);
  ok(g(by['v7-20']) === '0.45/0.575/0.575/1' && g(by['v7-40']) === '0.45/0.5875/0.5875/1', `20W cap $11.50, 40W $23.50 (${g(by['v7-20'])}, ${g(by['v7-40'])})`);
  ok(runs.filter((r) => /-unc$/.test(r.variant)).every((r) => g(r) === g(by[r.variant.replace(/-unc$/, '')])),
    'every -unc twin has exactly its parent\'s placement (twins differ only in the governor)');
  ok(runs.filter((r) => /-cATM$/.test(r.variant)).every((r) => r.minDebitFrac == null && !r.adaptiveGeo),
    'the fixed-geometry -cATM controls are untouched');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
