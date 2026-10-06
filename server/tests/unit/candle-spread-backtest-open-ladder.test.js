'use strict';
// BACKTEST OPEN LADDER (opts.openFillModel 'ladder') — the live resting open, ported (2026-10-02).
// Default model must stay byte-identical (proved separately against the pre-port engine: 0 of 900
// day-results differed); here: the ladder model's own bookkeeping and the governor still binding.
const path = require('path'), fs = require('fs');
process.env.CANDLE_SPREAD_RUNS_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cs-bol-'));
const DIR = path.join(process.cwd(), 'tests/backtest/backtest-data-5m-nq');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
if (!fs.existsSync(DIR)) { console.log('dataset absent — skipped\n\n0 passed, 0 failed'); process.exit(0); }
const E = require('../../src/candle-spread/backtest/backtest-v6-5m');
const { optsFor } = require('../../src/candle-spread/backtest/opts-for');
const { buildRuns } = require('../../src/candle-spread/index');
const etMin = ms => { const d = new Date(new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York' })); return d.getHours() * 60 + d.getMinutes(); };
const days = E.load5mDays(DIR).filter(d => d.bars.some(b => { const m = etMin(b.dt); return m >= 570 && m < 960; })).slice(-25);
const hasPx = days.some(d => d.bars.some(b => b.px));
const v = buildRuns().find(r => r.variant === 'v7-10');
const fn = (A, p, ctx) => v.signalFn(A, p, { ...ctx, cfg: v.signalCfg || {} });
const base = optsFor(v, { intradayIV: true, hasPx, where: 'test' });
const lad = optsFor(v, { intradayIV: true, hasPx, where: 'test', openFillModel: 'ladder' });
lad.recordReplay = true;   // positions come back, so hedges can be told apart from opens
ok(base.openFillModel === undefined && lad.openFillModel === 'ladder', 'the model is opt-in through optsFor');
let placed = 0, ends = 0, worst = Infinity, opens = 0, filled = 0;
for (const d of days) {
  const b = E.runDay5m(d.bars, fn, base);
  ok(b.openLadder === undefined, 'default model reports no ladder stats');
  const r = E.runDay5m(d.bars, fn, lad);
  const L = r.openLadder;
  placed += L.placed; filled += L.filled; ends += L.filled + L.canceled + L.stale + L.expired + (L.restruck || 0);
  // r.opens counts EVERY position, hedges included (floor offsets, wings, flies) — count the opens only
  opens += (r.positions || []).filter((p) => !p.hedge && !p.fly && p.side !== 'hedge').length; worst = Math.min(worst, r.terminal);
  ok(L.paidUp >= 0, 'the ladder only ever walks UP from the placed price');
}
ok(placed > 0, `orders were placed (${placed})`);
ok(placed === ends, `every placed order ends exactly one way: filled+canceled+stale+expired+restruck == placed (${ends}/${placed})`);
ok(filled === opens, `every booked open came from a filled working order (${filled} vs ${opens})`);
ok(worst >= -v.lossMax - 1, `the governor still bounds the day (${worst} vs lossMax ${v.lossMax})`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
