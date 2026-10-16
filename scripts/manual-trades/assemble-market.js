#!/usr/bin/env node
'use strict';
/**
 * Assemble market data for the manual-trade study (no analysis): per-day /NQ 1m bars + the per-day
 * NQ->NDX basis, so strikes (NDX terms) can be drawn on the NQ chart.
 *
 *   node scripts/manual-trades/assemble-market.js [--nq <1m csv>] [--daily <daily-NDX.json>] [--dates 2025-06-06,...]
 *
 * Default dates: every trade/expiry date in data/manual-trades/trades.json.
 * Writes data/manual-trades/market/nq-1m/<date>.json and data/manual-trades/market/basis.json.
 *
 * NQ source (default ~/Downloads/Dataset_NQ_1min_2022_2025.csv): "timestamp ET" is the bar END minute
 * (Vwap_RTH turns non-zero on the 9:31 bar; the Globex session's first bar is 18:01, last 17:00). It is a
 * BACK-ADJUSTED continuous series: its level sits ~700-760 pts over cash NDX in June 2025, far above the real
 * carry (~150-250), so NEVER read it as real NQ prices — only as NDX + basis(day).
 * Bars are written with `t` = bar START (ms epoch) to match the repo's candle convention.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..', '..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const NQ_CSV = arg('--nq', path.join(os.homedir(), 'Downloads', 'Dataset_NQ_1min_2022_2025.csv'));
const DAILY = arg('--daily', path.join(ROOT, 'data/sweeps/daily-bb-2026-10-15/daily-NDX.json'));
const OUT = path.join(ROOT, 'data/manual-trades/market');

let dates = (arg('--dates', '') || '').split(',').filter(Boolean);
if (!dates.length) {
  const T = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/manual-trades/trades.json'), 'utf8'));
  dates = T.days.map(d => d.date);
}
dates = [...new Set(dates)].sort();

// ET wall clock -> epoch ms (handles EDT/EST via Intl)
function etToMs(date, hh, mm) {
  const guess = Date.parse(`${date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`);
  for (const off of [4, 5]) {
    const ms = guess + off * 3600e3;
    const s = new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const [md, hm] = s.split(', ');
    const [M, D, Y] = md.split('/');
    if (`${Y}-${M}-${D}` === date && hm.replace(/^24/, '00') === `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`) return ms;
  }
  return guess + 4 * 3600e3;
}
const prevDay = d => new Date(Date.parse(d + 'T12:00:00Z') - 864e5).toISOString().slice(0, 10);

// Pull only the rows we need: session for D = (D-1) 18:01 .. D 17:00 (bar-end labels).
const want = new Set();
// + WARMUP: the 60m Bollinger(20) needs 20 hourly bars, but one session (18:00 -> 09:30) only holds 15.5, so the
// 60m bands would not exist until ~13:00 ET. Pull up to 7 prior calendar days and keep the last 30 hourly bars
// before the session as `warmup60m` (resampled here; 1m/5m/15m warm up inside the session itself).
const WARMUP_DAYS = 10;   // also feeds hist60m: ~5 sessions of hourly context on the chart
for (const d of dates) { let p = d; want.add(d); for (let i = 0; i < WARMUP_DAYS; i++) { p = prevDay(p); want.add(p); } }
const toIso = mdY => { const [m, d, y] = mdY.split('/'); return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`; };
const raw = new Map();      // iso date -> [{hh,mm,o,h,l,c,v}]
// DAILY SESSIONS (2026-10-16, user: the daily and hourly candles explain some out-of-the-money strike choices — e.g. the
// 05/19 asym fly peaking at 21100): one bar per Globex session (prior 18:00 .. 17:00 ET), labelled by its close date,
// from 90 days before the first trade day so the daily BB(20)/9EMA are warm. Written to market/nq-daily.json.
const sorted = [...dates].sort();
const dayFrom = new Date(Date.parse(sorted[0]) - 90 * 864e5).toISOString().slice(0, 10), dayTo = sorted[sorted.length - 1];
const sessions = new Map();   // close-date -> {o,h,l,c,v}
const nextIso = (iso) => new Date(Date.parse(iso) + 864e5).toISOString().slice(0, 10);
const text = fs.readFileSync(NQ_CSV, 'utf8');
for (const line of text.split('\n')) {
  const sp = line.indexOf(' ');
  if (sp < 0 || !/^\d/.test(line)) continue;
  const iso = toIso(line.slice(0, sp));
  if (iso >= dayFrom && iso <= dayTo) {
    const f = line.split(',');
    const [hh, mm] = f[0].slice(sp + 1).split(':').map(Number);
    // bar END label: 18:01..23:59 belongs to the next session; 17:01..18:00 is the daily halt (skip)
    const m = hh * 60 + mm;
    if (!(m > 17 * 60 && m <= 18 * 60)) {
      let key = m > 18 * 60 ? nextIso(iso) : iso;
      const dow = new Date(key + 'T12:00:00Z').getUTCDay();
      if (dow === 6) key = nextIso(nextIso(key)); else if (dow === 0) key = nextIso(key);   // Sunday evening -> Monday
      const b = sessions.get(key);
      const o = +f[1], h = +f[2], l = +f[3], c = +f[4], v = +f[5];
      if (!b) sessions.set(key, { o, h, l, c, v }); else { b.h = Math.max(b.h, h); b.l = Math.min(b.l, l); b.c = c; b.v += v; }
    }
  }
  if (!want.has(iso)) continue;
  const f = line.split(',');
  const [hh, mm] = f[0].slice(sp + 1).split(':').map(Number);
  if (!raw.has(iso)) raw.set(iso, []);
  raw.get(iso).push({ hh, mm, o: +f[1], h: +f[2], l: +f[3], c: +f[4], v: +f[5] });
}

const daily = JSON.parse(fs.readFileSync(DAILY, 'utf8'));
const ndxByDate = {};
for (const c of daily) {
  const iso = new Date(c.datetime).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  ndxByDate[iso] = c;
}

fs.mkdirSync(path.join(OUT, 'nq-1m'), { recursive: true });
const basis = {};
for (const d of dates) {
  const bars = [];
  const add = (iso, b) => {
    const endMs = etToMs(iso, b.hh, b.mm);
    bars.push({ t: endMs - 60e3, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
  };
  for (const b of raw.get(prevDay(d)) || []) if (b.hh * 60 + b.mm >= 18 * 60 + 1) add(prevDay(d), b);
  for (const b of raw.get(d) || []) if (b.hh * 60 + b.mm <= 17 * 60) add(d, b);
  bars.sort((a, b) => a.t - b.t);
  // warmup60m: hourly bars (epoch-aligned, t = START) strictly before this session's first bar.
  const sessStart = etToMs(prevDay(d), 18, 0);
  const pre = [];
  let p = prevDay(d);
  for (let i = 0; i < WARMUP_DAYS; i++) {
    for (const b of raw.get(p) || []) { const t = etToMs(p, b.hh, b.mm) - 60e3; if (t < sessStart) pre.push({ t, ...b }); }
    p = prevDay(p);
  }
  pre.sort((a, b) => a.t - b.t);
  const hours = new Map();
  for (const b of pre) {
    const k = Math.floor(b.t / 3600e3) * 3600e3;
    const h = hours.get(k);
    if (!h) hours.set(k, { t: k, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
    else { h.h = Math.max(h.h, b.h); h.l = Math.min(h.l, b.l); h.c = b.c; h.v += b.v; }
  }
  const warmup60m = [...hours.values()].sort((a, b) => a.t - b.t).filter(h => h.t + 3600e3 <= sessStart).slice(-110);
  const nd = ndxByDate[d];
  const at = (hh, mm) => (raw.get(d) || []).find(b => b.hh === hh && b.mm === mm);
  const close16 = at(16, 0), open931 = at(9, 31);
  const entry = { ndxClose: nd ? nd.close : null, ndxOpen: nd ? nd.open : null, nqBars: bars.length };
  if (nd && close16) entry.closeBasis = Math.round((close16.c - nd.close) * 100) / 100;     // NQ @16:00 − NDX official close
  if (nd && open931) entry.openBasis = Math.round((open931.o - nd.open) * 100) / 100;       // NQ @9:30 − NDX open
  // The close print is the reliable one (NDX's daily "open" is the opening-rotation print and lags); use it.
  entry.basis = entry.closeBasis != null ? entry.closeBasis : (entry.openBasis != null ? entry.openBasis : null);
  basis[d] = entry;
  if (bars.length) fs.writeFileSync(path.join(OUT, 'nq-1m', `${d}.json`), JSON.stringify({
    symbol: '/NQ (back-adjusted continuous)', date: d, source: path.basename(NQ_CSV),
    note: 't = bar START ms; session = prior 18:00 .. 17:00 ET; subtract basis to get NDX terms', basis: entry.basis, bars, warmup60m }));
}
// daily: t = the session's 18:00 ET open (bar START, like every other series here)
const dailyBars = [...sessions.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
  .map(([d, b]) => ({ date: d, t: etToMs(prevDay(d), 18, 0), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
fs.writeFileSync(path.join(OUT, 'nq-daily.json'), JSON.stringify({ symbol: '/NQ (back-adjusted continuous)', source: path.basename(NQ_CSV),
  note: 'one bar per Globex session (prior 18:00 .. 17:00 ET); date = close date; t = 18:00 open (ms)', bars: dailyBars }));
fs.writeFileSync(path.join(OUT, 'basis.json'), JSON.stringify({
  method: 'basis = NQ(back-adjusted) close at 16:00 ET minus official NDX close; openBasis shown as a cross-check',
  source: { nq: path.basename(NQ_CSV), ndxDaily: path.relative(ROOT, DAILY) }, days: basis }, null, 1));
for (const d of dates) {
  const b = basis[d];
  console.log(d, 'bars', b.nqBars, 'NDX', b.ndxClose, 'basis', b.basis, 'openBasis', b.openBasis);
}
