'use strict';
// FALLBACK WIDTHS ON A SPARSE STRIKE GRID (2026-11-05). NDX fell ~1,370 points and left the band of listed 10-point
// 0DTE strikes; below it only 25-point strikes existed. User's rule: 10W stops opening, 20W trades 25W, 40W trades 50W,
// nothing opens on a 100-point grid, and every position is managed at ITS OWN width (a book can hold a 20W from 09:30
// and a 25W from noon). Pins, on real roster variants and real engine deps (index.buildEngineDeps):
//   1. trader.widthCtx scales strike steps and points and leaves fractions and dollar caps alone;
//   2. processCandleClose opens at the fallback width, records it on the position, and refuses where there is none;
//   3. a mixed 20W + 25W book gets each continuous cover at its own width, on its own grid.
//
// Run: node server/tests/run-unit.js fallback-width
const os = require('os'), path = require('path'), fs = require('fs');
process.env.CANDLE_SPREAD_RUNS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-fw-'));
const store = require('../../src/candle-spread/store');
const trader = require('../../src/candle-spread/trader');
const cs = require('../../src/candle-spread');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

const runs = cs.buildRuns();
const R = Object.fromEntries(runs.map((r) => [r.variant, r]));
const EXP = '2026-11-05';
const U = 27031;   // 11/05 12:00

// A smooth chain that lists only `onGrid(strike)` strikes.
const legFor = (u, onGrid) => (type, strike) => {
  if (!onGrid(strike)) return null;
  const tv = 9 * Math.exp(-Math.abs(u - strike) / 60);
  const mid = (type === 'C' ? Math.max(0, u - strike) : Math.max(0, strike - u)) + tv;
  const m = Math.round(mid * 20) / 20;
  return { mid: m, symbol: `NDXP_${type}${strike}`, bid: Math.max(0, m - 0.5), ask: m + 0.5 };
};
const grid25 = (k) => k % 25 === 0;
const mixed = (k) => k % 25 === 0 || (k >= 27260 && k % 10 === 0);   // 11/05's shape: 10s only up high
const placeOrder = async () => ({ status: 'sim', filled: true });
const width = (legs) => { const ks = legs.map((l) => l.strike); return Math.max(...ks) - Math.min(...ks); };
const Aof = (u) => ({ '5m': { close: u, open: u, high: u + 5, low: u - 5 }, '15m': { close: u, ema: u }, '60m': { close: u, ema: u } });
let n = 0;
function depsFor(run, rec, extra) {
  return cs.buildEngineDeps(run, { getLeg: legFor(U, grid25), placeOrder, signalFn: () => ({ openSide: 'bull' }),
    A: Aof(U), priorA: null, underlying: U, isFifteen: true, nowMs: Date.parse('2026-11-05T17:00:00Z'), ...extra });
}
async function step(variant, grid, extra = {}) {
  const run = R[variant];
  // A fresh record per step: initRun hands back the existing record for a variant + date.
  const rec = store.initRun({ ...run, variant: `${run.variant}~${n}`, expiration: EXP, captureChain: false }, EXP);
  const candle = { timeEST: `11/05 12:${String(n++ % 60).padStart(2, '0')}`, open: U, high: U + 5, low: U - 5, close: U };
  const r = await trader.processCandleClose(rec, candle, null, depsFor(run, rec, { strikeGrid: grid == null ? undefined : { incr: grid }, ...extra }));
  return { rec, r, acts: ((r && r.decisions) || []).map((d) => d.action) };
}

(async () => {
  // ── 1. THE SCALING ────────────────────────────────────────────────────────────────────────────────────────
  {
    const run = R['v9-20'];
    const deps = cs.buildEngineDeps(run, {});
    const { cfg, deps: d } = trader.widthCtx(run, deps, 25, 25);
    ok(cfg.spreadWidth === 25 && cfg.strikeIncrement === 25 && d.strikeIncrement === 25, 'width and grid scaled on cfg and deps');
    ok(cfg.capFrac === run.capFrac && cfg.openWalkCapFrac === run.openWalkCapFrac && cfg.minDebitFrac === run.minDebitFrac,
      'fractions of W are untouched (placement band 45%-57.5% of 25 = $11.25-$14.38)');
    ok(d.lossMax === deps.lossMax && d.lossTarget === deps.lossTarget, `dollar caps are book-level and unscaled (lossMax ${d.lossMax})`);
    ok(d.spreadWidth === deps.spreadWidth, 'deps.spreadWidth stays the variant\'s (book-level give-back)');
    ok(cfg.maxItmStrikes === 2, `3 ITM strikes on a 20W (1.5W) -> 2 on a 25W grid (${cfg.maxItmStrikes})`);
    ok(d.legMaxShift === 3 && d.legMaxWing === 4, `leg-uniqueness shifts in 25-pt steps: 6 -> 3, 8 -> 4 (${d.legMaxShift}, ${d.legMaxWing})`);
    if (deps.giveUpPoints != null) ok(d.giveUpPoints === deps.giveUpPoints * 1.25, `give-up points scale with W (${deps.giveUpPoints} -> ${d.giveUpPoints})`);
    if (deps.coverRangePremium != null) ok(Math.abs(d.coverRangePremium * 25 / 25 - deps.coverRangePremium * 20 / 10) < 1e-9,
      'the re-strike premium per POINT of strike is unchanged');
    ok(!Object.keys(cfg).includes('_base'), 'the base link is not enumerable (never persisted with a record)');
    const back = trader.widthCtx(cfg, d, 20, 10);
    ok(back.cfg === run && back.deps === deps, 'scaling back to the base width returns the very base objects');
    ok(trader.widthCtx(run, deps, 25, 25).cfg === cfg, 'scaled copies are memoised');
    ok(trader.posCtx(run, deps, { id: 'legacy' }).cfg === run, 'a position with no recorded width is at the base width');
    const h = trader.hedgeCtx(run, { ...deps, strikeGrid: { incr: 25 } });
    ok(h.cfg.strikeIncrement === 25 && h.cfg.spreadWidth === 20, 'hedges: the grid changes, the width does not');
    ok(trader.hedgeCtx(run, deps).cfg === run, 'hedges on a normal grid: the base objects');
  }

  // ── 2. OPENS AT THE FALLBACK WIDTH ───────────────────────────────────────────────────────────────────────────
  {
    const a = await step('v9-20', 25);
    const p = a.rec.state.positions[0];
    ok(a.acts.includes('open-fallback-width'), `v9-20 on a 25-pt grid records the fallback (${a.acts.join(',')})`);
    ok(p && width(p.legs) === 25 && p.legs.every((l) => l.strike % 25 === 0), `and opens a 25W on 25-pt strikes (${p && JSON.stringify(p.legs)})`);
    ok(p && p.width === 25 && p.incr === 25 && p.fallbackFrom === 20, 'the position carries its width, grid and origin');
    const o = a.r.decisions.find((d) => d.action === 'open');
    // The scaled band: never over 57.5% of 25, and a cheaper placement is labelled against the 45%-of-25 floor.
    ok(o && o.width === 25 && o.limit <= 0.575 * 25 + 0.05 && (o.limit >= 0.45 * 25 - 0.05 || o.belowBand === true),
      `priced under the scaled cap $14.38, band floor $11.25 (limit ${o && o.limit}, belowBand ${o && o.belowBand}, floor ${o && o.bandFloor})`);
    ok(!o || !o.belowBand || o.bandFloor === 11.25, `the band floor is 45% of 25 (${o && o.bandFloor})`);

    const b = await step('v9-40', 25);
    const q = b.rec.state.positions[0];
    ok(q && width(q.legs) === 50 && q.width === 50 && q.legs.every((l) => l.strike % 25 === 0), `v9-40 opens a 50W (${q && JSON.stringify(q.legs)})`);

    const c = await step('v9-10', 25);
    const d = c.r.decisions.find((x) => x.action === 'open-skip-grid');
    ok(d && d.grid === 25 && c.rec.state.positions.length === 0, `v9-10 does not open on a 25-pt grid (${d && d.reason})`);

    for (const v of ['v9-20', 'v9-40', 'v20-20']) {
      const e = await step(v, 100);
      ok(e.acts.includes('open-skip-grid') && e.rec.state.positions.length === 0, `${v}: nothing opens on a 100-pt grid`);
    }
    const f = await step('v9-20', 10, { getLeg: legFor(U, () => true) });
    const fp = f.rec.state.positions[0];
    ok(fp && width(fp.legs) === 20 && fp.width === undefined && !f.acts.includes('open-fallback-width'),
      'on a normal grid nothing changes: 20W, no width recorded');
    const g = await step('v9-20', undefined, { getLeg: legFor(U, () => true) });
    ok(g.rec.state.positions[0] && width(g.rec.state.positions[0].legs) === 20, 'no grid reading (backtests, old callers): the base width');

    const h = await step('v21-20-f50', 25);
    const hp = h.rec.state.positions[0];
    ok(hp && width(hp.legs) === 25, `v21 (price target) opens 25W, target 0.50 x 25 (${hp && JSON.stringify(hp.legs)}, limit ${hp && hp.limit})`);
  }

  // ── 3. A MIXED BOOK: EACH POSITION COVERED AT ITS OWN WIDTH ─────────────────────────────────────────────────
  {
    const run = R['v9-20'];
    const rec = store.initRun({ ...run, expiration: EXP, captureChain: false }, EXP);
    const st = rec.state;
    const getLeg = legFor(U, mixed);
    const deps = depsFor(run, rec, { getLeg, strikeGrid: { incr: 25 } });
    trader.attachLedger(st, deps);
    // A 20W bull from the morning, up in the 10-pt band, and a 25W bull opened at noon on the 25-pt grid.
    const p20 = { id: 'p20', side: 'bull', filled: true, covered: false, quantity: 1, limit: 4.0, shortStrike: 27300,
      legs: [{ side: 'long', type: 'C', strike: 27280 }, { side: 'short', type: 'C', strike: 27300 }] };
    const p25 = { id: 'p25', side: 'bull', filled: true, covered: false, quantity: 1, limit: 12.0, shortStrike: 27050, width: 25, incr: 25,
      legs: [{ side: 'long', type: 'C', strike: 27025 }, { side: 'short', type: 'C', strike: 27050 }] };
    st.positions.push(p20, p25);
    const decisions = [];
    await trader.placeContinuousCovers(st, run, deps, decisions, '11/05 12:05', U);
    ok(p20.pendingCover && width(p20.pendingCover.legs) === 20 && p20.pendingCover.legs.every((l) => l.strike % 10 === 0),
      `the 20W is covered 20 wide on its own strikes (${p20.pendingCover && JSON.stringify(p20.pendingCover.legs)})`);
    ok(p25.pendingCover && width(p25.pendingCover.legs) === 25 && p25.pendingCover.legs.every((l) => l.strike % 25 === 0),
      `the 25W is covered 25 wide on the 25-pt grid (${p25.pendingCover && JSON.stringify(p25.pendingCover.legs)})`);
    // The lock is minLock at the position's width: eq = W - paid - minLockFrac x W, plus k x premium for a strike beyond.
    const ml = deps.continuousCoverMinLockFrac || 0;
    const k25 = p25.pendingCover && p25.pendingCover.k != null ? p25.pendingCover.k : 0;
    const prem25 = trader.widthCtx(run, deps, 25, 25).deps.coverRangePremium * 25;
    if (p25.pendingCover) ok(Math.abs(p25.pendingCover.target - (25 - 12.0 - ml * 25 + k25 * prem25)) < 0.051,
      `the 25W's target is 25 - 12 - ${ml} x 25 + ${k25} x ${prem25} (target ${p25.pendingCover.target})`);
    const k20 = p20.pendingCover && p20.pendingCover.k != null ? p20.pendingCover.k : 0;
    if (p20.pendingCover) ok(Math.abs(p20.pendingCover.target - (20 - 4.0 - ml * 20 + k20 * (deps.coverRangePremium || 0) * 20)) < 0.051,
      `and the 20W's at 20 (target ${p20.pendingCover.target}, k ${k20})`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
