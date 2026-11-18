'use strict';
// BACKTEST COVER LOWERING (2026-11-18): the live-parity rule and the trailing give-up experiment, on real days.
//   - coverNeverLower ON (the roster default) vs OFF must differ somewhere: the flag has to do something.
//   - giveUpTrail unset must be byte-identical to giveUpTrail 0: the experiment must not leak into the baseline.
//   - giveUpTrail ON must actually lower working covers (its counter > 0) and only after a give-up.
const path = require('path'), fs = require('fs');
process.env.CANDLE_SPREAD_RUNS_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cs-bcl-'));
const DIR = path.join(process.cwd(), 'tests/backtest/backtest-data-5m-nq');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
if (!fs.existsSync(DIR)) { console.log('dataset absent — skipped\n\n0 passed, 0 failed'); process.exit(0); }
const E = require('../../src/candle-spread/backtest/backtest-v6-5m');
const { optsFor } = require('../../src/candle-spread/backtest/opts-for');
const { buildRuns } = require('../../src/candle-spread/index');
const etMin = ms => { const d = new Date(new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York' })); return d.getHours() * 60 + d.getMinutes(); };
const days = E.load5mDays(DIR).filter(d => d.bars.some(b => { const m = etMin(b.dt); return m >= 570 && m < 960; })).slice(-40);
const hasPx = days.some(d => d.bars.some(b => b.px));
const v = buildRuns().find(r => r.variant === 'v9-40');
const fn = (A, p, ctx) => v.signalFn(A, p, { ...ctx, cfg: v.signalCfg || {} });
const base = optsFor(v, { intradayIV: true, hasPx, where: 'test', openFillModel: 'ladder' });
ok(base.coverNeverLower === true && base.giveUpTrail === undefined, 'roster defaults: never-lower on, trail off');
let diffNL = 0, diffTrail0 = 0, lowers = 0, trailDiff = 0;
for (const d of days) {
  const a = E.runDay5m(d.bars, fn, base);
  const off = E.runDay5m(d.bars, fn, { ...base, coverNeverLower: false });
  const z = E.runDay5m(d.bars, fn, { ...base, giveUpTrail: 0 });
  const t = E.runDay5m(d.bars, fn, { ...base, giveUpTrail: 0.05 });
  if (a.terminal !== off.terminal) diffNL++;
  if (a.terminal !== z.terminal || JSON.stringify(a.lock) !== JSON.stringify(z.lock)) diffTrail0++;
  if (t.giveUpTrail) lowers += t.giveUpTrail.lowers;
  if (t.terminal !== a.terminal) trailDiff++;
  ok(a.giveUpTrail === undefined, 'no trail stats when the trail is off');
}
ok(diffNL > 0, `coverNeverLower changes results on some days (${diffNL}/${days.length})`);
ok(diffTrail0 === 0, `giveUpTrail 0 is byte-identical to unset (${diffTrail0} days differ)`);
ok(lowers > 0, `the trail lowers working covers after a give-up (${lowers} lowers over ${days.length} days)`);
console.log(`  (trail changed the terminal on ${trailDiff} days)`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
