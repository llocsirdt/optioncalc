'use strict';
// GIVE-UP TAKE-NOW (runDay5m opts.giveUpTakeNowFrac, backtest-only, 2026-10-20): when a give-up fires and the cover's
// mark is within frac x W past break-even, pay the mark (+ a tick) now; otherwise the usual resting price stands.
// Unset = byte-identical; a frac at or below the allowance never raises the price; forwarded by optsFor.
//
// Run: node server/tests/run-unit.js giveup-takenow
const path = require('path'), fs = require('fs');
const E = require('../../src/candle-spread/backtest/backtest-v6-5m');
const { optsFor } = require('../../src/candle-spread/backtest/opts-for');
const { buildRuns } = require('../../src/candle-spread/index');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

const v = buildRuns().find((r) => r.variant === 'v7-10');

// ── forwarding ───────────────────────────────────────────────────────────────────────────────────────
{
  const o = optsFor({ ...v, giveUpTakeNowFrac: 0.12 }, { intradayIV: true, hasPx: true, where: 'test' });
  ok(o.giveUpTakeNowFrac === 0.12, 'optsFor forwards giveUpTakeNowFrac');
  const o0 = optsFor(v, { intradayIV: true, hasPx: true, where: 'test' });
  ok(o0.giveUpTakeNowFrac === undefined, 'roster variants do not carry it (backtest-only)');
}

// ── engine, on real days when the dataset is present ─────────────────────────────────────────────────
const DIR = path.join(__dirname, '../../../tests/backtest/backtest-data-5m-combined');
if (fs.existsSync(DIR)) {
  const days = E.load5mDays(DIR).slice(-30);
  const hasPx = days.some((d) => d.bars.some((b) => b.px));
  const fn = (A, pp, ctx) => v.signalFn(A, pp, { ...ctx, cfg: v.signalCfg || {} });
  const base = optsFor(v, { intradayIV: true, hasPx, where: 'test', openFillModel: 'ladder' });
  const sig = (r) => JSON.stringify([r.terminal, r.opens, r.filled, r.naked]);
  let same0 = 0, sameLow = 0, differ = 0, fires = 0, keyAbsent = true;
  for (const d of days) {
    const off = E.runDay5m(d.bars, fn, base);
    if ('giveUpTakeNow' in off && off.giveUpTakeNow !== undefined) keyAbsent = false;
    const low = E.runDay5m(d.bars, fn, { ...base, giveUpTakeNowFrac: base.giveUpMaxLoss });   // = the allowance: never above it
    const hi = E.runDay5m(d.bars, fn, { ...base, giveUpTakeNowFrac: 0.15 });
    if (sig(low) === sig(off)) sameLow++;
    if (sig(hi) !== sig(off)) differ++;
    fires += hi.giveUpTakeNow || 0;
    same0++;
  }
  ok(keyAbsent, 'unset: no giveUpTakeNow telemetry on the result');
  ok(sameLow === same0, `frac = the allowance never raises the price: identical on ${sameLow}/${same0} days`);
  ok(fires > 0, `frac 0.15 takes give-ups now on the sample (${fires} positions)`);
  ok(differ > 0, `frac 0.15 changes at least one day (${differ}/${same0})`);
} else {
  console.log('(combined dataset absent — engine checks skipped)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
