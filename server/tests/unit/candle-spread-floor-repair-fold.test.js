'use strict';
// FLOOR REPAIR FOLD — built 2026-10-09, DEFAULT OFF the same day after the reval sweep (ladder fills, 978 days):
// the separate hedgers beat the fold by +10.6% P&L and 27.1% vs 20.2% locked-floor days (all 50 governed).
// Pins: by default wings + offsets run as their own features and stand-alone fly repair is OFF for every
// variant (flies stay inside floor raise); CANDLE_SPREAD_FLOOR_FOLD=on still yields the folded roster, and the
// backtest reports its stages apart from the planner's own raises.
const path = require('path'), fs = require('fs');
const { execFileSync } = require('child_process');
process.env.CANDLE_SPREAD_RUNS_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cs-fold-'));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const { buildRuns } = require('../../src/candle-spread/index');
const { optsFor } = require('../../src/candle-spread/backtest/opts-for');

// ── default: separate hedgers, no stand-alone flies ────────────────────────────────────────────────────
const runs = buildRuns();
for (const r of runs) {
  ok(r.flyConvert !== true, `${r.variant}: stand-alone fly repair is off`);
  ok(r.wingConvert === true, `${r.variant}: wings run as their own feature`);
  ok((r.lossMax != null) === (r.floorOffset === true), `${r.variant}: offsets exactly where there is a cap`);
  ok(r.floorRaiseCapFix !== true && r.floorRaiseWings !== true, `${r.variant}: no fold stages`);
  ok(r.floorRaise === true, `${r.variant}: floor raise on (flies stay on its menu)`);
  const o = optsFor(r, { intradayIV: true, hasPx: true, where: 'test' });
  ok(o.flyConvert !== true && o.wingConvert === true, `${r.variant}: the same reaches the backtest`);
}
const v710 = runs.find((r) => r.variant === 'v7-10');
ok(v710.giveUpPoints === 20, 'give-up trigger is 20 points');

// ── CANDLE_SPREAD_FLOOR_FOLD=on: the folded roster, in a child process (the switch is read at load) ────
const probe = `const {buildRuns}=require(${JSON.stringify(path.resolve(__dirname, '../../src/candle-spread/index'))});
  const r=buildRuns();const c=(k)=>r.filter((x)=>x[k]===true).length;
  process.stdout.write(JSON.stringify({w:c('wingConvert'),o:c('floorOffset'),f:c('flyConvert'),rw:c('floorRaiseWings'),rc:c('floorRaiseCapFix'),n:r.length}));`;
const out = execFileSync(process.execPath, ['-e', probe], { env: { ...process.env, CANDLE_SPREAD_FLOOR_FOLD: 'on' }, encoding: 'utf8' });
const k = JSON.parse(out.slice(out.lastIndexOf('{')));
ok(k.w === 0 && k.o === 0 && k.f === 0 && k.rw === k.n && k.rc === 50, `FOLD=on: wings/offsets become stages (${JSON.stringify(k)})`);

// ── backtest: the fold's stages are counted apart from the planner's own raises ──────────────────────────
const DIR = path.join(process.cwd(), 'tests/backtest/backtest-data-5m-nq');
if (fs.existsSync(DIR)) {
  const E = require('../../src/candle-spread/backtest/backtest-v6-5m');
  const days = E.load5mDays(DIR).slice(-15);
  const hasPx = days.some((d) => d.bars.some((b) => b.px));
  const fn = (A, p, ctx) => v710.signalFn(A, p, { ...ctx, cfg: v710.signalCfg || {} });
  const folded = { ...v710, wingConvert: false, floorOffset: false, floorRaiseWings: true, floorRaiseCapFix: true };
  const o = optsFor(folded, { intradayIV: true, hasPx, where: 'test' });
  let wingStage = 0, wings = 0;
  for (const d of days) {
    const r = E.runDay5m(d.bars, fn, o);
    ok(r.floorRaise && typeof r.floorRaise.wingStage === 'number' && typeof r.floorRaise.capStage === 'number', 'stage counts reported');
    wingStage += r.floorRaise.wingStage; wings += r.wings.count;
  }
  ok(wingStage === wings, `folded: every wing is a raise-wing (${wingStage} of ${wings})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
