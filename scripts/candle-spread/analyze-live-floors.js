#!/usr/bin/env node
'use strict';
/**
 * LIVE FLOORS vs THE BACKTEST (2026-11-18). Per variant over a window of archived prod runs (candle-spread-archive):
 *   - live terminal P&L per day (eod_settlement.terminalPnl), the real recorded number;
 *   - the intraday BOOK FLOOR rebuilt minute by minute from each position's recorded fill time (fillEpoch) and cover
 *     fill time (coverFilledAt), using the engine's own risk-curve.bookFloor: peak floor, end floor, and whether a
 *     floor >= 0 (or > 0) was later traded away into a losing day;
 *   - with --backtest, the CURRENT backtest on exactly the same days, built from raw 1m (/NQ 24h signals, NDX
 *     pricing) and settled at the archived official close, with the baseline fill model (open ladder + 1m sub-bar).
 *
 * Usage: node scripts/candle-spread/analyze-live-floors.js --from 2026-11-09 --to 2026-11-17 [--backtest]
 *          [--variants v7-10,v9-20] [--md out.md] [--json out.json]
 * The live P&L is the live engine on SIMULATED fills (paper / test mode), as recorded. Nothing here is estimated
 * except the intraday floor path, which is recomputed from recorded fills (its end value is checked against the
 * floor can never be above the settled result, and the count of runs where it is is reported). NOTE: eod_settlement.
 * floorPnl is NOT the book floor: it is state.realizedPnl, the profit locked by filled covers.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const FROM = arg('--from', '2026-11-09'), TO = arg('--to', '2026-11-17');
const WANT = arg('--variants') ? new Set(arg('--variants').split(',')) : null;
const DO_BT = argv.includes('--backtest');
const MD = arg('--md'), JSON_OUT = arg('--json');
const ARCH = path.join(ROOT, 'candle-spread-archive');
const RAW = path.join(ROOT, 'signal-lab-data', 'raw-1m');
const RC = require(path.join(ROOT, 'server/src/candle-spread/risk-curve'));

const etParts = (ms) => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false })
  .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
const etMin = (ms) => { const p = etParts(ms); return ((+p.hour) % 24) * 60 + (+p.minute); };

// ── LIVE ────────────────────────────────────────────────────────────────────────────────────────────────────────
const files = fs.readdirSync(ARCH).filter((f) => {
  const m = /^NDX_(\d{4}-\d{2}-\d{2})_\1_(.+)\.json$/.exec(f);
  return m && m[1] >= FROM && m[1] <= TO && (!WANT || WANT.has(m[2]));
});
const live = [];
let floorChecks = 0, floorMismatch = 0;   // mismatch = rebuilt end floor above the settled result (impossible)
for (const f of files) {
  const rec = JSON.parse(fs.readFileSync(path.join(ARCH, f), 'utf8'));
  const variant = rec.config && rec.config.variant;
  const date = rec.tradeDate;
  const st = [...(rec.events || [])].reverse().find((e) => e.type === 'eod_settlement');
  if (!variant || !st || st.terminalPnl == null) continue;   // incomplete day: skipped (complete = priced settlement)
  const pos = (rec.state.positions || []).filter((p) => p && p.filled && p.legs);
  const fillAt = (p) => p.fillEpoch || p.openEpoch || p.placedEpoch || null;
  const coverAt = (p) => p.coverFilledAt || p.coverEpoch || null;
  let peak = null, peakAt = null, firstNonNeg = null;
  const ts = pos.map(fillAt).filter(Boolean);
  if (ts.length) {
    const start = Math.min(...ts);
    const end = Date.parse(`${date}T21:00:00Z`);   // 16:00 ET in November (EST)
    for (let t = start; t <= end; t += 60000) {
      const book = pos.filter((p) => fillAt(p) != null && fillAt(p) <= t)
        .map((p) => ({ ...p, covered: !!(p.covered && coverAt(p) != null && coverAt(p) <= t) }));
      if (!book.length) continue;
      const fl = RC.bookFloor(book, null, 10);
      if (peak == null || fl > peak) { peak = fl; peakAt = t; }
      if (fl >= 0 && firstNonNeg == null) firstNonNeg = t;
    }
  }
  const endFloor = pos.length ? Math.round(RC.bookFloor(pos, null, 10)) : 0;
  if (pos.length) { floorChecks++; if (endFloor > st.terminalPnl + 1) floorMismatch++; }
  live.push({ variant, date, terminal: st.terminalPnl, endFloor, locked: st.floorPnl, peak: peak == null ? null : Math.round(peak),
    peakAt: peakAt ? `${String(Math.floor(etMin(peakAt) / 60)).padStart(2, '0')}:${String(etMin(peakAt) % 60).padStart(2, '0')}` : null,
    opens: pos.filter((p) => !p.hedge).length, sessionClose: rec.state.sessionClose || st.settle });
}

// ── BACKTEST on the same days ───────────────────────────────────────────────────────────────────────────────────
const bt = new Map();   // `${variant}|${date}` -> { terminal, endFloor, peak }
async function runBacktests() {
  const { buildDualDay } = require(path.join(ROOT, 'server/src/candle-spread/backtest/day-builder'));
  const E = require(path.join(ROOT, 'server/src/candle-spread/backtest/backtest-v6-5m'));
  const { optsFor } = require(path.join(ROOT, 'server/src/candle-spread/backtest/opts-for'));
  const { buildRuns } = require(path.join(ROOT, 'server/src/candle-spread/index'));
  const rawCache = {};
  const loadRaw = (sym) => {
    if (rawCache[sym]) return rawCache[sym];
    const seen = new Set(), out = [];
    for (const f of fs.readdirSync(RAW).filter((x) => x.startsWith(sym + '-') && x.endsWith('.json')).sort()) {
      for (const c of JSON.parse(fs.readFileSync(path.join(RAW, f), 'utf8')).candles || []) {
        if (c.datetime == null || seen.has(c.datetime)) continue; seen.add(c.datetime); out.push(c);
      }
    }
    return (rawCache[sym] = out.sort((a, b) => a.datetime - b.datetime));
  };
  const priceHistory = async (sym, { startDate, endDate }) => {
    const src = sym.includes('NQ') ? loadRaw('NQ') : loadRaw('NDX');
    return { candles: src.filter((c) => c.datetime >= startDate && c.datetime < endDate) };
  };
  const dates = [...new Set(live.map((r) => r.date))].sort();
  const settleOf = Object.fromEntries(live.map((r) => [r.date, r.sessionClose]));
  const days = [];
  for (const d of dates) {
    const day = await buildDualDay(d, priceHistory);
    if (!day) { console.error(`backtest: no bars for ${d}`); continue; }
    const close = settleOf[d];
    if (close > 0) {   // the official 16:00 close, as load5mDays adds it from settles.json
      const last = day.bars[day.bars.length - 1];
      const t1600 = Date.parse(`${d}T21:00:00Z`);
      if (t1600 > last.dt) day.bars.push({ dt: t1600, analysis: last.analysis, px: { open: close, high: close, low: close, close }, fifteen: true, officialClose: true });
    }
    days.push(day);
  }
  E.attachSub1m(days, RAW);
  const runs = buildRuns().filter((r) => live.some((l) => l.variant === r.variant));
  for (const run of runs) {
    const o = optsFor(run, { intradayIV: true, hasPx: true, where: 'analyze-live-floors', openFillModel: 'ladder', subBarFill: '1m' });
    const fn = (A, p, ctx) => run.signalFn(A, p, { ...ctx, cfg: run.signalCfg || {} });
    for (const day of days) {
      const r = E.runDay5m(day.bars, fn, o);
      bt.set(`${run.variant}|${day.date}`, { terminal: Math.round(r.terminal), endFloor: r.lock ? r.lock.endBookFloor : null, peak: r.lock ? r.lock.bestFloor : null });
    }
  }
}

// ── REPORT ──────────────────────────────────────────────────────────────────────────────────────────────────────
function summarize() {
  const by = new Map();
  for (const r of live) { if (!by.has(r.variant)) by.set(r.variant, []); by.get(r.variant).push(r); }
  const rows = [];
  for (const [v, rs] of by) {
    const n = rs.length, tot = rs.reduce((a, r) => a + r.terminal, 0);
    const traded = rs.filter((r) => r.peak != null);
    const nonNeg = traded.filter((r) => r.peak >= 0), pos = traded.filter((r) => r.peak > 0);
    const b = rs.map((r) => bt.get(`${v}|${r.date}`)).filter(Boolean);
    rows.push({
      variant: v, days: n, liveTotal: Math.round(tot), liveAvg: Math.round(tot / n),
      win: rs.filter((r) => r.terminal > 0).length, endFloorPos: rs.filter((r) => r.endFloor != null && r.endFloor >= 0).length,
      peakNonNeg: nonNeg.length, nonNegToLoss: nonNeg.filter((r) => r.terminal < 0).length,
      peakPos: pos.length, posToLoss: pos.filter((r) => r.terminal < 0).length,
      giveBack: traded.length ? Math.round(traded.reduce((a, r) => a + Math.max(0, r.peak - (r.endFloor || 0)), 0) / traded.length) : null,
      btAvg: b.length === n ? Math.round(b.reduce((a, x) => a + x.terminal, 0) / n) : null,
      btWin: b.length === n ? b.filter((x) => x.terminal > 0).length : null,
      btEndFloorPos: b.length === n ? b.filter((x) => x.endFloor != null && x.endFloor >= 0).length : null,
      sameSign: b.length === n ? rs.filter((r) => { const x = bt.get(`${v}|${r.date}`); return Math.sign(x.terminal) === Math.sign(r.terminal); }).length : null,
    });
  }
  return rows.sort((a, b) => a.variant.localeCompare(b.variant, 'en', { numeric: true }));
}

(async () => {
  if (DO_BT) await runBacktests();
  const rows = summarize();
  const dates = [...new Set(live.map((r) => r.date))].sort();
  const all = live.filter((r) => r.peak != null);
  const nn = all.filter((r) => r.peak >= 0), ps = all.filter((r) => r.peak > 0);
  const money = (n) => (n == null ? '—' : (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString());
  const lines = [];
  lines.push(`# Live floors${DO_BT ? ' vs backtest' : ''}: ${dates[0]} .. ${dates[dates.length - 1]} (${dates.length} trading days, ${rows.length} variants)`);
  lines.push('');
  lines.push(`Floor path rebuilt from recorded fills with the engine's bookFloor; sanity (end-of-day floor <= settled result) held on ${floorChecks - floorMismatch}/${floorChecks} runs.`);
  lines.push(`Fleet: ${all.length} variant-days that traded. Peak floor >= 0 on ${nn.length}; ${nn.filter((r) => r.terminal < 0).length} of those closed the day NEGATIVE. Peak floor > 0 on ${ps.length}; ${ps.filter((r) => r.terminal < 0).length} closed negative.`);
  lines.push('');
  lines.push(`| variant | days | live total | live avg/day | live win days | end floor >= 0 | peak floor >= 0 | ...then a losing day | peak floor > 0 | ...then a losing day | avg give-back (peak - end floor) |${DO_BT ? ' backtest avg/day | backtest win days | backtest end floor >= 0 | same-sign days |' : ''}`);
  lines.push(`|---|---|---|---|---|---|---|---|---|---|---|${DO_BT ? '---|---|---|---|' : ''}`);
  for (const r of rows) {
    lines.push(`| ${r.variant} | ${r.days} | ${money(r.liveTotal)} | ${money(r.liveAvg)} | ${r.win} | ${r.endFloorPos} | ${r.peakNonNeg} | ${r.nonNegToLoss} | ${r.peakPos} | ${r.posToLoss} | ${money(r.giveBack)} |`
      + (DO_BT ? ` ${money(r.btAvg)} | ${r.btWin} | ${r.btEndFloorPos} | ${r.sameSign} |` : ''));
  }
  const md = lines.join('\n') + '\n';
  if (MD) fs.writeFileSync(MD, md); else process.stdout.write(md);
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ from: FROM, to: TO, dates, rows, live, backtest: Object.fromEntries(bt) }, null, 1));
  if (MD) console.log(`wrote ${MD}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
