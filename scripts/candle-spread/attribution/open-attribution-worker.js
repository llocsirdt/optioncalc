// One variant over the whole 5m dataset: every OPEN with its signal, side, trend context at the signal bar,
// and its settle P&L (exact from legs). Trend context from /NQ: 15m structural trend, last COMPLETED hourly
// candle (colour, higher high vs the prior hourly), and the FORMING hourly built from completed 5m candles.
process.chdir('/Users/tdriscoll/Documents/surf/optioncalc');
const fs = require('fs');
const E = require('/Users/tdriscoll/Documents/surf/optioncalc/server/src/candle-spread/backtest/backtest-v6-5m');
const { optsFor } = require('/Users/tdriscoll/Documents/surf/optioncalc/server/src/candle-spread/backtest/opts-for');
const RC = require('/Users/tdriscoll/Documents/surf/optioncalc/server/src/candle-spread/risk-curve');
const v = require('/Users/tdriscoll/Documents/surf/optioncalc/server/src/candle-spread/index').buildRuns().find((r) => r.variant === process.argv[2]);
const out = process.argv[3];
const etHour = (ms) => new Date(new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York' })).getHours();
const trendOf = (c) => (!c || c.bbmiddle == null || c.ema == null) ? 0 : (c.close > c.bbmiddle && c.ema >= c.bbmiddle ? 1 : c.close < c.bbmiddle && c.ema <= c.bbmiddle ? -1 : 0);
const days = E.load5mDays('tests/backtest/backtest-data-5m-nq');
const hasPx = days.some((d) => d.bars.some((b) => b.px));
const fn = (A, p, ctx) => v.signalFn(A, p, { ...ctx, cfg: v.signalCfg || {} });
const o = optsFor(v, { intradayIV: true, hasPx, where: 'attr', openFillModel: 'ladder' });
o.recordReplay = true;
const rows = [];
for (const d of days) {
  // trend context per bar
  const ctx = new Map();
  let prevH = null, curH = null, form = null, formHour = null;
  for (const b of d.bars) {
    const A = b.analysis; const h = A['60m'];
    if (h && (!curH || h.close !== curH.close || h.open !== curH.open)) { prevH = curH; curH = h; }
    const c5 = A['5m']; const hr = etHour(b.dt - 5 * 60000);
    if (hr !== formHour) { formHour = hr; form = c5 ? { open: c5.open, high: c5.high, low: c5.low, close: c5.close } : null; }
    else if (form && c5) { form.high = Math.max(form.high, c5.high); form.low = Math.min(form.low, c5.low); form.close = c5.close; }
    ctx.set(b.dt, {
      t15: trendOf(A['15m']),
      hc: curH ? (curH.close > curH.open ? 1 : -1) : 0,
      hcHH: curH && prevH ? (curH.high > prevH.high ? 1 : curH.low < prevH.low ? -1 : 0) : 0,
      hf: form ? (form.close > form.open ? 1 : form.close < form.open ? -1 : 0) : 0,
      hfBreak: form && curH ? (form.high > curH.high ? 1 : form.low < curH.low ? -1 : 0) : 0,
    });
  }
  const r = E.runDay5m(d.bars, fn, o);
  for (const p of r.positions || []) {
    if (p.hedge || p.side === 'hedge' || p.fly || !p.openReason) continue;
    const c = ctx.get(p.sigEpoch) || {};
    rows.push({ day: d.date || d.day || null, side: p.side, reason: p.openReason, ...c, limit: p.limit,
      pnl: Math.round(RC.bookPnl([{ ...p, filled: true }], r.settle)), covered: !!p.covered, gu: !!p._gu,
      coverLimit: p.coverLimit });
  }
}
fs.writeFileSync(out, JSON.stringify({ variant: v.variant, rows }));
