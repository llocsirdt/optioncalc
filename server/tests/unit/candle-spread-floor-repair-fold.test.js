'use strict';
// FLOOR REPAIR FOLD (2026-10-09) — wings, floor offsets and fly repair run as stages of floor raise. Pins:
// the roster carries no stand-alone wing/offset/fly hedger wherever floor raise is on; every governed variant
// keeps the must-fix (raise-cap); every variant keeps wings (raise-wing); both reach the backtest; and the
// backtest reports the stages apart from the planner's own raises.
const path = require('path'), fs = require('fs');
process.env.CANDLE_SPREAD_RUNS_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cs-fold-'));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const { buildRuns } = require('../../src/candle-spread/index');
const { optsFor } = require('../../src/candle-spread/backtest/opts-for');
const runs = buildRuns();

for (const r of runs) {
  if (r.floorRaise !== true) continue;
  ok(r.wingConvert !== true, `${r.variant}: no stand-alone wings beside floor raise`);
  ok(r.floorOffset !== true, `${r.variant}: no stand-alone offsets beside floor raise`);
  ok(r.flyConvert !== true, `${r.variant}: no stand-alone fly repair beside floor raise`);
  ok(r.floorRaiseWings === true, `${r.variant}: wings run as the raise-wing stage`);
  ok((r.lossMax != null) === (r.floorRaiseCapFix === true), `${r.variant}: must-fix exactly where there is a cap to breach`);
  const o = optsFor(r, { intradayIV: true, hasPx: true, where: 'test' });
  ok(o.floorRaiseWings === true && (r.lossMax == null || o.floorRaiseCapFix === true), `${r.variant}: stages reach the backtest`);
  ok(o.wingConvert !== true && o.floorOffset !== true && o.flyConvert !== true, `${r.variant}: legacy hedgers stay off in the backtest`);
}
const v710 = runs.find((r) => r.variant === 'v7-10');
ok(v710 && v710.floorRaiseCapFix === true && v710.floorRaiseWings === true, 'v7-10 (live money) keeps must-fix and wings');
ok(v710 && typeof v710.lossTarget === 'number', 'lossTarget survives the fold (v3 arming reads it)');

// Backtest: the stages are counted apart from the planner's own raises.
const DIR = path.join(process.cwd(), 'tests/backtest/backtest-data-5m-nq');
if (fs.existsSync(DIR)) {
  const E = require('../../src/candle-spread/backtest/backtest-v6-5m');
  const days = E.load5mDays(DIR).slice(-15);
  const hasPx = days.some((d) => d.bars.some((b) => b.px));
  const fn = (A, p, ctx) => v710.signalFn(A, p, { ...ctx, cfg: v710.signalCfg || {} });
  const o = optsFor(v710, { intradayIV: true, hasPx, where: 'test' });
  let wingStage = 0, wings = 0;
  for (const d of days) {
    const r = E.runDay5m(d.bars, fn, o);
    ok(r.floorRaise && typeof r.floorRaise.wingStage === 'number' && typeof r.floorRaise.capStage === 'number', 'stage counts reported');
    wingStage += r.floorRaise.wingStage; wings += r.wings.count;
  }
  ok(wingStage === wings, `every wing is a raise-wing under the fold (${wingStage} of ${wings})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
