'use strict';
// STRIKE GRID + TRADABILITY ON A SPARSE CHAIN (2026-11-05).
// NDX fell ~1,370 points and left the band of listed 10-point 0DTE strikes (27,260-28,070). Below it the chain listed
// 25-point strikes, and further down only 100-point ones. The tradability gate sampled a 10-point grid, found 3-4
// quoted, and skipped 49 of 78 ticks of an open market. These tests pin the replacement:
//   - the grid is READ from the strikes the chain lists (strike-grid.localIncrement);
//   - the gate counts listed quoted strikes at any spacing and never fails an open market over a sparse grid;
//   - the width a variant opens at follows the user's rule (strike-grid.openWidthFor).
//
// Run: node server/tests/unit/candle-spread-strike-grid.test.js
const SG = require('../../src/candle-spread/strike-grid');
const TR = require('../../src/candle-spread/tradability');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

const EXP = '2026-11-05';
// A chain in the engine's shape, quoting every strike in `strikes` (null quotes for those in `dead`).
function chainOf(strikes, dead = []) {
  const side = {};
  for (const k of strikes) {
    const q = dead.includes(k) ? { bid: null, ask: null, mark: null } : { bid: 10, ask: 11, mark: 10.5 };
    side[`${k.toFixed(1)}`] = [{ symbol: `NDXP_${k}`, ...q }];
  }
  return { call: { [`${EXP}:0`]: side }, put: { [`${EXP}:0`]: JSON.parse(JSON.stringify(side)) } };
}
const range = (lo, hi, step) => { const a = []; for (let k = lo; k <= hi; k += step) a.push(k); return a; };
// 11/05's shape: 10s from 27,260 to 28,070, 25s from 26,800 up, 100s below.
const NOV5 = [...new Set([...range(27260, 28070, 10), ...range(26800, 28100, 25), ...range(25000, 28500, 100)])].sort((a, b) => a - b);

// ── 1. THE GRID IS READ, NOT ASSUMED ──────────────────────────────────────────────────────────────────
{
  const c = chainOf(NOV5);
  ok(SG.assess(c, EXP, 27996).incr === 10, `at the 09:30 price (27,996) the 10-pt grid is there (${SG.assess(c, EXP, 27996).incr})`);
  ok(SG.assess(c, EXP, 27031).incr === 25, `at 12:00's 27,031 only the 25-pt grid is (${SG.assess(c, EXP, 27031).incr})`);
  ok(SG.assess(c, EXP, 26600).incr === 100, `below 26,800 only 100-pt (${SG.assess(c, EXP, 26600).incr})`);
  ok(SG.assess(c, EXP, 27265).incr === 25, 'at the edge of the 10-pt band (3 strikes a side missing) it reads 25, not 10');
  ok(SG.assess(chainOf(range(27000, 28000, 5)), EXP, 27500).incr === 5, 'a 5-pt grid reads 5');
  ok(SG.assess(chainOf(NOV5, NOV5), EXP, 27500).incr === null, 'a chain with no quotes at all has no grid');
}

// ── 2. THE GATE: A SPARSE GRID IS STILL A MARKET ─────────────────────────────────────────────────────
{
  const c = chainOf(NOV5);
  for (const u of [27996, 27031, 26600]) {
    const g = SG.assess(c, EXP, u);
    const t = TR.assess({ underlying: u, nowMs: 0, quotedStrikes: g.strikes, listedStrikes: g.listed });
    ok(t.ok === true, `open market at ${u} (${g.incr}-pt grid) is tradable (${t.reason}: ${t.detail})`);
  }
  // 11/05 12:00 as the OLD gate saw it: a 10-pt sample of 17 strikes, only the 50s quoted -> 4 of 17, then 3 at 15:55.
  const snap = { strikes: range(26950, 27110, 10).map((k) => ({ strike: k, call: k % 50 ? null : { mark: 1 }, put: null })) };
  ok(TR.assess({ underlying: 27031, nowMs: 0, chainSnapshot: snap }).ok === true, 'the legacy snapshot path no longer needs 4 quoted strikes (the 50s pass)');
  // The holiday (2026-09-07): 17 strikes listed, every quote null -> closed.
  const hol = chainOf(range(29460, 29620, 10), range(29460, 29620, 10));
  const gh = SG.assess(hol, EXP, 29542);
  const th = TR.assess({ underlying: 29542, nowMs: 0, quotedStrikes: gh.strikes, listedStrikes: gh.listed });
  ok(th.ok === false && th.reason === 'chain-not-quoted' && /17 strikes listed/.test(th.detail), `a fully unquoted chain is still "not open" (${th.detail})`);
  const tn = TR.assess({ underlying: 29542, nowMs: 0, quotedStrikes: [], listedStrikes: 0 });
  ok(tn.ok === false && tn.reason === 'no-chain', 'and no chain at all is no-chain');
  // A stale price still stands the engine down, whatever the chain.
  const ts = TR.assess({ underlying: 27000, nowMs: 3600000, priceAsOfMs: 0, quotedStrikes: NOV5, listedStrikes: NOV5.length });
  ok(ts.ok === false && ts.reason === 'stale-price', 'a stale price still blocks');
}

// ── 3. THE WIDTH RULE (user, 2026-11-05) ──────────────────────────────────────────────────────────────
{
  const w = (W, g) => SG.openWidthFor(W, 10, g);
  ok(w(10, 10).width === 10 && w(20, 10).width === 20 && w(40, 10).width === 40 && !w(20, 10).fallback, 'on a 10-pt grid every width is its own');
  ok(w(20, 5).width === 20 && w(10, 5).incr === 10, 'a 5-pt grid also carries the 10-pt one');
  ok(w(10, 25).width === null, '25-pt grid: 10W stops opening');
  ok(w(20, 25).width === 25 && w(20, 25).incr === 25 && w(20, 25).fallback, '25-pt grid: 20W trades 25W');
  ok(w(40, 25).width === 50 && w(40, 25).incr === 25, '25-pt grid: 40W trades 50W');
  ok(w(40, 50).width === 50 && w(40, 50).incr === 50 && w(20, 50).width === null && w(10, 50).width === null, '50-pt grid: only 40W (as 50W)');
  ok(w(10, 100).width === null && w(20, 100).width === null && w(40, 100).width === null, '100-pt grid: nothing opens');
  ok(w(40, null).width === null && /no quoted strike grid/.test(w(40, null).reason), 'no grid: nothing opens, with the reason');
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
