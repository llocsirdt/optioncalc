'use strict';
// FILL AT THE LIMIT + OPEN-LADDER GOVERNOR (2026-10-06).
//   1. A simulated resting order books AT its limit, never better. v7-10 live vs its simulated twin on the
//      same 8 positions: +$7 real vs +$765 simulated — the simulation booked covers at mark + 1 tick when
//      the market had gapped past the limit, price improvement a real resting limit does not get.
//      Roster flag simFillAtLimit (cfg for covers, deps for markFill: opens and hedges).
//   2. Walking an open UP is paying more for a position the governor already counts, so a step that would
//      push the floor down AND through lossMax is refused (the cover rule). Flagged 10-04, fixed here.
//   3. The backtest's floor-raise hedges REST (opts.floorRaiseResting): planned, then filled on a later bar
//      only if the structure marks at or under the limit, booked at the limit.
//
// Run: node server/tests/unit/candle-spread-fill-at-limit.test.js
const trader = require('../../src/candle-spread/trader');
const CS = require('../../src/candle-spread/index');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const r2 = (x) => Math.round(x * 100) / 100;

const base = { symbol: 'NDX', spreadWidth: 10, strikeIncrement: 10, tickIncrement: 0.05, quantity: 1 };
const chain = (m) => (type, strike) => {
  const c = strike === 30900 ? 20 + m : strike === 30910 ? 20 : 20 - (strike - 30910) * 0.5;
  const mid = type === 'C' ? r2(c) : r2(c - (30905 - strike));
  return { mid, bid: r2(mid - 0.2), ask: r2(mid + 0.2), symbol: `NDX_${type}${strike}` };
};
const bullCall = [{ side: 'long', type: 'C', strike: 30900 }, { side: 'short', type: 'C', strike: 30910 }];

(async () => {
  // ── 1a. DEBIT cover: market gaps to 2.50 under a 4.00 target ─────────────────────────────────────
  const mkCov = () => ({ id: 'c', side: 'bull', filled: true, covered: false, quantity: 1, limit: 5.5,
    legs: bullCall, shortStrike: 30910,
    pendingCover: { legs: bullCall, target: 4.0, openCost: 5.5, minLock: 0, placedEpoch: 1, placedUnder: 30905, sentNet: 'DEBIT' } });
  let p = mkCov();
  trader.resolveRestingCovers({ positions: [p], realizedPnl: 0 }, { ...base, coverFillThroughTicks: 1, simFillAtLimit: true }, chain(2.5), [], {});
  ok(p.covered === true && p.coverLimit === 4.0, `at-limit: the cover books at its 4.00 target, not the 2.50 market (${p.coverLimit})`);
  p = mkCov();
  trader.resolveRestingCovers({ positions: [p], realizedPnl: 0 }, { ...base, coverFillThroughTicks: 1 }, chain(2.5), [], {});
  ok(p.covered === true && p.coverLimit === 2.55, `legacy books the improvement (mark + tick = ${p.coverLimit})`);

  // ── 1b. markFill (opens, hedges) ─────────────────────────────────────────────────────────────────
  const g = chain(5.0);
  const at = trader.markFill(bullCall, 5.5, g, 0.05, { simFillAtLimit: true });
  const lg = trader.markFill(bullCall, 5.5, g, 0.05, {});
  ok(at.fillable && at.fill === 5.5, `an open/hedge resting at 5.50 with the market at 5.00 books 5.50 (${at.fill})`);
  ok(lg.fillable && lg.fill === 5.05, `legacy books 5.05 (${lg.fill})`);
  const no = trader.markFill(bullCall, 4.5, g, 0.05, { simFillAtLimit: true });
  ok(!no.fillable, 'and a limit the market has not reached still does not fill');

  // ── 1c. roster ───────────────────────────────────────────────────────────────────────────────────
  const runs = CS.buildRuns();
  ok(runs.every((r) => r.simFillAtLimit === true), 'every variant fills at its limit');
  CS.assertDeps(runs);
  ok(true, 'the live startup contract accepts the new field');

  // ── 2. open ladder vs the governor ───────────────────────────────────────────────────────────────
  {
    const cfg = { symbol: 'NDX', expiration: '2026-09-18', spreadWidth: 10, strikeIncrement: 10,
      quantity: 1, tickIncrement: 0.05, variant: 'tst' };
    const ch = (ty, k) => ({ mid: ty === 'C' ? (k === 29390 ? 20 : 13.5) : (k === 29390 ? 6 : 9.5), bid: 0, ask: 40, symbol: `NDX_${ty}${k}` });
    const run = (lossMax) => {
      const pos = { id: 'p1', side: 'bull', filled: false, quantity: 1, limit: 6.0, cap: 7.0, openTime: '09/18 10:00', placedEpoch: 0,
        legs: [{ side: 'long', type: 'C', strike: 29390 }, { side: 'short', type: 'C', strike: 29400 }] };
      const d = [];
      trader.resolvePendingOpen({ positions: [pos], pendingOpenId: 'p1' }, cfg,
        { getLeg: ch, coverLadder: true, ladderStepDollars: 0.25, underlying: 29395, nowMs: 300000, lossMax,
          replaceOrder: async () => ({}) }, d);
      return { pos, d };
    };
    // The open alone: floor -600 at 6.00, -625 at 6.25.
    const tight = run(610), room = run(700);
    ok(tight.pos.limit === 6.0 && tight.d.some((x) => x.action === 'open-reprice-governor'),
      `a step to 6.25 that puts the floor at -625 past a 610 cap is refused (${tight.pos.limit})`);
    ok(room.pos.limit === 6.25, `with a 700 cap the same step goes (${room.pos.limit})`);
  }

  // ── 3. backtest: resting raises ──────────────────────────────────────────────────────────────────
  {
    const path = require('path'), fs = require('fs');
    const DIR = path.join(__dirname, '../../../tests/backtest/backtest-data-5m-nq');
    if (fs.existsSync(DIR)) {
      const E = require('../../src/candle-spread/backtest/backtest-v6-5m');
      const { optsFor } = require('../../src/candle-spread/backtest/opts-for');
      const v = runs.find((r) => r.variant === 'v7-20');
      const days = E.load5mDays(DIR).slice(-40);
      const hasPx = days.some((d) => d.bars.some((b) => b.px));
      const fn = (A, pp, ctx) => v.signalFn(A, pp, { ...ctx, cfg: v.signalCfg || {} });
      const o = optsFor(v, { intradayIV: true, hasPx, where: 'test', openFillModel: 'ladder' });
      ok(o.floorRaiseResting === true && o.simFillAtLimit === true, 'optsFor forwards resting raises and at-limit fills');
      const oi = optsFor(v, { intradayIV: true, hasPx, where: 'test', openFillModel: 'ladder', floorRaiseResting: false });
      let placed = 0, filled = 0, expired = 0, instant = 0;
      for (const d of days) {
        const a = E.runDay5m(d.bars, fn, o).floorRaise; placed += a.placed; filled += a.count; expired += a.expired;
        instant += E.runDay5m(d.bars, fn, oi).floorRaise.count;
      }
      ok(placed > 0, `raises were planned (${placed})`);
      ok(filled <= placed && filled + expired <= placed, `each resting raise fills or expires at most once (${filled} filled, ${expired} expired of ${placed})`);
      ok(filled < instant || instant === 0, `fewer raises fill when they must rest (${filled} vs ${instant} instant)`);
    } else ok(true, 'dataset absent — backtest part skipped');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
