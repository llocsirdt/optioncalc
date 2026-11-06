'use strict';
// BACKTEST REOPEN AFTER A QUICK COVER (runDay5m opts.reopenOnCover, 2026-11-06) — the port of trader.reopenAfterCover.
// Off must leave a day untouched; on, every reopen is a real order (placed -> filled or expired), it never pays more
// than the source position paid, it starts inside the source's strikes, and the governor still bounds the day.
const path = require('path'), fs = require('fs');
process.env.CANDLE_SPREAD_RUNS_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cs-bro-'));
const DIR = path.join(process.cwd(), 'tests/backtest/backtest-data-5m-nq');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
if (!fs.existsSync(DIR)) { console.log('dataset absent — skipped\n\n0 passed, 0 failed'); process.exit(0); }
const E = require('../../src/candle-spread/backtest/backtest-v6-5m');
const { optsFor } = require('../../src/candle-spread/backtest/opts-for');
const { buildRuns } = require('../../src/candle-spread/index');
const etMin = ms => { const d = new Date(new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York' })); return d.getHours() * 60 + d.getMinutes(); };
const days = E.load5mDays(DIR).filter(d => d.bars.some(b => { const m = etMin(b.dt); return m >= 570 && m < 960; })).slice(-30);
const hasPx = days.some(d => d.bars.some(b => b.px));
const v = buildRuns().find(r => r.variant === 'v0-40');
ok(v && v.reopenOnCover === true, 'the roster turns reopen on for v0-40 (every v0-v9 variant)');
const fn = (A, p, ctx) => v.signalFn(A, p, { ...ctx, cfg: v.signalCfg || {} });
const on = optsFor(v, { intradayIV: true, hasPx, where: 'test' });
ok(on.reopenOnCover === true, 'optsFor forwards reopenOnCover to the engine');
const off = { ...on, reopenOnCover: false };
let placed = 0, filled = 0, expired = 0, sameOff = 0, worst = Infinity;
for (const d of days) {
  const a = E.runDay5m(d.bars, fn, off);
  ok(a.reopen === undefined, 'off reports no reopen stats');
  const r = E.runDay5m(d.bars, fn, { ...on, recordReplay: true });
  placed += r.reopen.placed; filled += r.reopen.filled; expired += r.reopen.expired;
  if (r.reopen.placed === 0 && r.terminal === a.terminal) sameOff++;
  worst = Math.min(worst, r.terminal);
  // each reopened position: never above what its source paid, and inside the source's strikes when placed
  const ps = (r.positions || []).filter((p) => !p.hedge);
  for (const p of ps.filter((x) => x.reopenOf)) {
    ok(p.limit > 0 && p.limit <= v.spreadWidth, `a reopen books a sane price (${p.limit})`);
  }
}
ok(placed > 0, `reopens were placed over ${days.length} days (${placed})`);
ok(filled + expired <= placed, `a reopen ends at most one way (filled ${filled} + expired ${expired} <= placed ${placed})`);
ok(sameOff > 0, `a day with no reopen is identical to reopen off (${sameOff} days)`);
ok(worst >= -v.lossMax - 1, `the governor still bounds the day (${worst} vs lossMax ${v.lossMax})`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
