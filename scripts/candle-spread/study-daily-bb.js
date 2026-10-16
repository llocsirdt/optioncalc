#!/usr/bin/env node
'use strict';
/**
 * DAILY-BAND OVERSOLD/OVERBOUGHT STUDY (analysis only — touches no engine code).
 *
 * The user's hypothesis (2026-10-15): when a 15m or 60m candle CLOSES below the LOWER DAILY Bollinger band
 * (BB 20,2 on daily closes, bands as of the last COMPLETED day — never today's forming bar) the market is
 * oversold and bias should go BULL. Mirror: a close above the UPPER daily band is overbought -> BEAR.
 * Example: 2026-10-15, the 09:45-10:00 15m candle closed below the lower daily band and the market bounced.
 *
 * TWO SERIES, computed independently:
 *   (a) NQ : daily bands from Schwab /NQ DAILY bars (CME session 18:00->17:00 ET; close = 16:15 ET settle —
 *            verified: the 2026-10-14 daily close 30,139.25 == the 16:14 1m close). Trigger = /NQ 15m/60m close
 *            (24h stream, clock-aligned buckets, 17:00-18:00 ET break dropped).
 *   (b) NDX: daily bands from Schwab $NDX DAILY bars (official cash close). Trigger = NDX RTH 15m/60m close
 *            (RTH-only stream; the 10:00 60m bar is the 09:30-10:00 partial, same as chart-series.js).
 *   Daily bars are the REAL Schwab daily series (via the local server's /chartseries daily, which is
 *   chart-series.js: Bollinger 20,2 population sd + 9EMA). Cached in OUT/daily-{NQ,NDX}.json.
 *   For trigger date D the band is the bar with the largest date < D (= last completed day).
 *
 * OUTCOMES (pricing is NDX): NDX cash wherever NDX intraday exists for that date; otherwise /NQ RTH as a PROXY
 * (every row carries px_src). NDX intraday exists only in 2026 (2026-01-28 .. 2026-10-14, RTH), so the NQ
 * series' 2023-2025 events are priced on /NQ (proxy). Close = official NDX daily close (Schwab daily bar) for
 * NDX; /NQ 16:00 5m close for the proxy. Forward returns: close of the price-series 5m bar ending at T+h
 * (null if T+h > 16:00). MFE/MAE: price-series 5m highs/lows from T to 16:00 vs P0 (P0 = price-series 5m
 * close at T). All signed in the hypothesis direction (oversold -> up is positive; overbought -> down).
 *
 * BASELINES (same series, same tf, same window):
 *   B0  every close in the window.
 *   B1  "htf-only": the last COMPLETED 60m bar (same series) closed beyond its own 60m band (the engine's
 *       cfg.htfGate 'close' condition) but the trigger close is NOT beyond the daily band.
 *
 * INTRADAY SOURCES (5m bars, start-labeled after conversion; priority raw-1m > raw-5m > dataset):
 *   NQ : tests/backtest/backtest-data-5m-combined (END-labeled 5m snapshot, 24h, 2022-12-27..2026-10-07),
 *        signal-lab-data/raw-1m NQ (00:00-16:59 ET only — the 18:00-24:00 evening is NOT captured, so 2026-07+
 *        NQ 15m/60m bands are computed over a stream with evening gaps; the CLOSES are unaffected).
 *        raw-5m NQ (2026-04-13..08-20) is RTH-ONLY and therefore NOT used (it would corrupt the 24h bands).
 *   NDX: tests/backtest/backtest-data-5m-janapr (END-labeled), signal-lab-data/raw-5m NDX, raw-1m NDX.
 *   2026-10-15 (today): live 1m from the local server (/chartseries 1m), cached in OUT/live-1m-*.json.
 *   Today is shown in the confirmation section only (day incomplete -> excluded from aggregates).
 *
 * Usage: node scripts/candle-spread/study-daily-bb.js [--out DIR] [--refresh] [--server http://localhost:3001]
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const ROOT = path.resolve(__dirname, '..', '..');
const ind = require(path.join(ROOT, 'server/src/candle-spread/signals/indicators.js'));

const argv = process.argv.slice(2);
const arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const OUT = path.resolve(ROOT, arg('--out', 'data/sweeps/daily-bb-2026-10-15'));
const SERVER = arg('--server', 'http://localhost:3001');
const REFRESH = argv.includes('--refresh');
const DS_DIR = path.join(ROOT, 'tests/backtest/backtest-data-5m-combined');
const JANAPR_DIR = path.join(ROOT, 'tests/backtest/backtest-data-5m-janapr');
const RAW1 = path.join(ROOT, 'signal-lab-data/raw-1m');
const RAW5 = path.join(ROOT, 'signal-lab-data/raw-5m');
const TODAY = '2026-10-15';

// ---- named, pre-registered constants ----------------------------------------------------------------
const HORIZONS = [15, 30, 60, 120];
const WIN = { 15: [hm('09:45'), hm('15:45')], 60: [hm('10:00'), hm('15:00')] }; // trigger close times (inclusive)
const TOD = [['09:45-11:00', hm('09:45'), hm('11:00')], ['11:00-13:00', hm('11:00'), hm('13:00')], ['13:00-16:00', hm('13:00'), hm('16:00')]];
const PTS_BUCKETS = [[0, 25], [25, 75], [75, 150], [150, Infinity]];
const WPCT_BUCKETS = [[0, 1], [1, 2.5], [2.5, 5], [5, Infinity]];
const THIN = 20;

// ---- time helpers ---------------------------------------------------------------------------------
function hm(s) { const [h, m] = s.split(':').map(Number); return h * 60 + m; }
const etFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const etCache = new Map();
function et(ms) {
  let v = etCache.get(ms); if (v) return v;
  const p = Object.fromEntries(etFmt.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  const hh = p.hour === '24' ? '00' : p.hour;
  v = { date: `${p.year}-${p.month}-${p.day}`, hm: `${hh}:${p.minute}`, min: (+hh) * 60 + (+p.minute) };
  etCache.set(ms, v); return v;
}
const mm2 = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const M5 = 5 * 60000;

// ---- server fetch (daily + today's 1m) -------------------------------------------------------------
function getJSON(url) {
  return new Promise((res, rej) => {
    http.get(url, r => { let s = ''; r.on('data', d => s += d); r.on('end', () => { try { res(JSON.parse(s)); } catch (e) { rej(new Error(`bad JSON from ${url}: ${s.slice(0, 120)}`)); } }); }).on('error', rej);
  });
}
async function cached(file, url) {
  const f = path.join(OUT, file);
  if (!REFRESH && fs.existsSync(f)) return { data: JSON.parse(fs.readFileSync(f, 'utf8')), from: 'cache' };
  try {
    const j = await getJSON(url);
    const c = j.candles || j;
    if (!Array.isArray(c) || !c.length) throw new Error('empty');
    fs.writeFileSync(f, JSON.stringify(c));
    return { data: c, from: 'server' };
  } catch (e) {
    if (fs.existsSync(f)) return { data: JSON.parse(fs.readFileSync(f, 'utf8')), from: 'cache (server failed)' };
    return { data: null, from: `UNAVAILABLE (${e.message})` };
  }
}
const symQ = s => s === 'NQ' ? '%2FNQ' : 'NDX';

// ---- daily ------------------------------------------------------------------------------------------
function dailyIndex(candles) {
  const rows = candles.map(c => ({ date: et(c.datetime).date, o: c.open, h: c.high, l: c.low, c: c.close, up: c.bbUpper, mid: c.bbMiddle, lo: c.bbLower }))
    .sort((a, b) => a.date < b.date ? -1 : 1);
  const byDate = new Map(rows.map((r, i) => [r.date, i]));
  // prior COMPLETED day for date D = largest date < D
  const prior = D => { let lo = 0, hi = rows.length - 1, ans = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (rows[m].date < D) { ans = m; lo = m + 1; } else hi = m - 1; } return ans; };
  return { rows, byDate, prior };
}

// ---- intraday 5m streams --------------------------------------------------------------------------
function readCandles(f) { const j = JSON.parse(fs.readFileSync(f, 'utf8')); return (j.candles || j).filter(c => c && c.datetime != null); }
function put(map, start, o, h, l, c, src) { map.set(start, { datetime: start, open: o, high: h, low: l, close: c, src }); }
function addEndLabeledDataset(map, dir, re, src, skipIfPx) {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const f of fs.readdirSync(dir).filter(f => re.test(f)).sort()) {
    for (const b of JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))) {
      const a = b && b.analysis && b.analysis['5m']; if (!a || b.datetime == null) continue;
      put(map, b.datetime - M5, a.open, a.high, a.low, a.close, src); n++;
    }
  }
  return n;
}
function add1m(map, candles, src) {
  for (const b of ind.resample(candles.sort((a, b) => a.datetime - b.datetime), 5)) put(map, b.datetime, b.open, b.high, b.low, b.close, src);
}
function buildStream(sym, live1m) {
  const map = new Map();
  if (sym === 'NQ') addEndLabeledDataset(map, DS_DIR, /^backtest-NQ-\d{4}-\d{2}-\d{2}\.json$/, 'ds5m');
  else {
    addEndLabeledDataset(map, JANAPR_DIR, /^backtest-NDX-\d{4}-\d{2}-\d{2}\.json$/, 'janapr5m');
    for (const f of fs.readdirSync(RAW5).filter(f => f.startsWith('NDX-')).sort()) for (const c of readCandles(path.join(RAW5, f))) put(map, c.datetime, c.open, c.high, c.low, c.close, 'raw5m');
  }
  for (const f of fs.readdirSync(RAW1).filter(f => f.startsWith(sym + '-')).sort()) add1m(map, readCandles(path.join(RAW1, f)), 'raw1m');
  if (live1m) add1m(map, live1m.filter(c => et(c.datetime).date === TODAY), 'live1m');
  let bars = [...map.values()].sort((a, b) => a.datetime - b.datetime);
  if (sym === 'NQ') bars = bars.filter(b => { const m = et(b.datetime).min; return m < hm('17:00') || m >= hm('18:00'); });
  else bars = bars.filter(b => { const m = et(b.datetime).min; return m >= hm('09:30') && m < hm('16:00'); });
  return bars;
}
// 15m / 60m bars with indicators over the continuous stream; `n5` = number of 5m bars in the bucket.
function tfBars(bars5, period) {
  const agg = ind.resample(bars5, period);
  const cnt = new Map(); const ms = period * 60000;
  for (const b of bars5) { const s = Math.floor(b.datetime / ms) * ms; cnt.set(s, (cnt.get(s) || 0) + 1); }
  return ind.withIndicators(agg).map(b => {
    const t = et(b.datetime + ms);
    return { ...b, n5: cnt.get(b.datetime), date: t.date, endMin: t.min === 0 ? 1440 : t.min, endMs: b.datetime + ms };
  });
}

// ---- price days (outcome series) ----------------------------------------------------------------------
function priceDays(bars5, sym, daily) {
  const days = new Map();
  for (const b of bars5) {
    const t = et(b.datetime); if (t.min < hm('09:30') || t.min >= hm('16:00')) continue;
    if (!days.has(t.date)) days.set(t.date, new Map());
    days.get(t.date).set(t.min + 5, b);
  }
  const out = new Map();
  for (const [date, m] of days) {
    if (m.size < 70 || !m.has(hm('16:00')) || !m.has(hm('09:35'))) continue; // incomplete / half day
    let close, closeSrc;
    if (sym === 'NDX') {
      const i = daily.byDate.get(date);
      if (i == null) continue;
      close = daily.rows[i].c; closeSrc = 'NDX official (daily bar)';
    } else { close = m.get(hm('16:00')).close; closeSrc = 'NQ 16:00 5m close (proxy)'; }
    out.set(date, { date, bars: m, close, closeSrc, px_src: sym === 'NDX' ? 'NDX' : 'NQ(proxy)' });
  }
  return out;
}
function outcome(pd, Tm, sign) {
  const b0 = pd.bars.get(Tm); if (!b0) return null;
  const P0 = b0.close;
  const fwd = {};
  for (const h of HORIZONS) { const b = Tm + h <= hm('16:00') ? pd.bars.get(Tm + h) : null; fwd[h] = b ? sign * (b.close - P0) : null; }
  fwd.close = sign * (pd.close - P0);
  let hi = P0, lo = P0;
  for (let e = Tm + 5; e <= hm('16:00'); e += 5) { const b = pd.bars.get(e); if (b) { if (b.high > hi) hi = b.high; if (b.low < lo) lo = b.low; } }
  const mfe = sign > 0 ? hi - P0 : P0 - lo, mae = sign > 0 ? P0 - lo : hi - P0;
  return { P0, fwd, closePct: fwd.close / P0 * 100, mfe, mae, px_src: pd.px_src };
}

// ---- stats ------------------------------------------------------------------------------------------
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const median = a => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const sd = a => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const f0 = x => Number.isFinite(x) ? x.toFixed(0) : '—';
const f1 = x => Number.isFinite(x) ? x.toFixed(1) : '—';
const f2 = x => Number.isFinite(x) ? x.toFixed(2) : '—';
function cell(rows) {
  const o = rows.map(r => r.out);
  const c = { n: rows.length, days: new Set(rows.map(r => r.date)).size };
  for (const h of [...HORIZONS, 'close']) {
    const v = o.map(x => x.fwd[h]).filter(x => x != null);
    c[h] = { n: v.length, mean: mean(v), hit: v.length ? 100 * v.filter(x => x > 0).length / v.length : NaN };
  }
  const cl = o.map(x => x.fwd.close);
  c.medClose = median(cl); c.tClose = cl.length > 1 ? mean(cl) / (sd(cl) / Math.sqrt(cl.length)) : NaN;
  c.closePct = mean(o.map(x => x.closePct));
  c.mfe = mean(o.map(x => x.mfe)); c.mae = mean(o.map(x => x.mae));
  c.mfeGtMae = o.length ? 100 * o.filter(x => x.mfe > x.mae).length / o.length : NaN;
  return c;
}
const HDR = '| group | n | days | +15m pts / hit% | +30m | +60m | +120m | to close pts / hit% | med close | t(close) | close % | MFE pts | MAE pts | MFE>MAE % |';
const SEP = '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|';
const hc = x => `${f1(x.mean)} / ${f0(x.hit)}`;
function row(label, rows) {
  const c = cell(rows);
  if (!c.n) return `| ${label} | 0 | 0 | | | | | | | | | | | |`;
  return `| ${label}${c.n < THIN ? ' (THIN)' : ''} | ${c.n} | ${c.days} | ${hc(c[15])} | ${hc(c[30])} | ${hc(c[60])} | ${hc(c[120])} | ${hc(c.close)} | ${f1(c.medClose)} | ${f2(c.tClose)} | ${f2(c.closePct)} | ${f1(c.mfe)} | ${f1(c.mae)} | ${f0(c.mfeGtMae)} |`;
}

// ---- main ------------------------------------------------------------------------------------------
async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const out = []; const log = s => { out.push(s); console.log(s); };
  const fromMs = Date.parse('2022-06-01T12:00:00Z'), toMs = Date.now();
  const src = {};
  const daily = {}, live = {};
  for (const s of ['NQ', 'NDX']) {
    const d = await cached(`daily-${s}.json`, `${SERVER}/api/v1/marketdata/chartseries?symbol=${symQ(s)}&timeframe=daily&from=${fromMs}&to=${toMs}&fresh=1`);
    if (!d.data) throw new Error(`no daily series for ${s}: ${d.from}`);
    daily[s] = dailyIndex(d.data); src[`daily ${s}`] = `${d.from}, ${d.data.length} bars ${daily[s].rows[0].date}..${daily[s].rows.at(-1).date}`;
    const l = await cached(`live-1m-${s}-${TODAY}.json`, `${SERVER}/api/v1/marketdata/chartseries?symbol=${symQ(s)}&timeframe=1m&fresh=1`);
    live[s] = l.data; src[`live 1m ${s} ${TODAY}`] = l.data ? `${l.from}, last bar ${et(l.data.at(-1).datetime).date} ${et(l.data.at(-1).datetime).hm} ET` : l.from;
  }

  const S = {};
  for (const s of ['NQ', 'NDX']) {
    const b5 = buildStream(s, live[s]);
    S[s] = { b5, tf: { 15: tfBars(b5, 15), 60: tfBars(b5, 60) }, px: priceDays(b5, s, daily[s]) };
    const srcCount = {}; for (const b of b5) srcCount[b.src] = (srcCount[b.src] || 0) + 1;
    src[`intraday ${s}`] = `${b5.length} 5m bars ${et(b5[0].datetime).date}..${et(b5.at(-1).datetime).date} (${Object.entries(srcCount).map(([k, v]) => `${k}:${v}`).join(', ')}); complete RTH price days: ${S[s].px.size}`;
  }

  // ---- NQ daily: the 2023-2025 intraday dataset is a BACK-ADJUSTED continuous contract (offset vs the
  // unadjusted Schwab /NQ daily = +2,517 pts in 2023-03 shrinking to +247 by 2025-12), so Schwab's daily bands
  // cannot be compared against it. For dates < 2026 the NQ daily bars are therefore SELF-BUILT from the same
  // intraday stream (CME trade date: 18:00 ET prior evening -> 17:00 ET; close = last 5m close at or before
  // 17:00 ET — verified to be how Schwab's /NQ daily close is defined: it equals the 16:59 1m close on 2026 days). For 2026 dates (raw-1m, unadjusted front month,
  // no evening capture) the real Schwab daily bars are used. NQ intraday has a gap 2025-12-12..2026-07-19, so
  // no 20-day window crosses the seam.
  const schwabNQ = daily.NQ;
  {
    const rthDates = [...new Set(S.NQ.b5.filter(b => { const m = et(b.datetime).min; return m >= hm('09:30') && m < hm('16:00'); }).map(b => et(b.datetime).date))].sort();
    const nextTrade = d => { let lo = 0, hi = rthDates.length - 1, ans = null; while (lo <= hi) { const m = (lo + hi) >> 1; if (rthDates[m] > d) { ans = rthDates[m]; hi = m - 1; } else lo = m + 1; } return ans; };
    const sess = new Map();
    for (const b of S.NQ.b5) {
      const t = et(b.datetime); if (t.date >= '2026-01-01') continue;
      const td = t.min >= hm('18:00') ? nextTrade(t.date) : t.date; if (!td || td >= '2026-01-01') continue;
      const end = t.min + 5;
      if (!sess.has(td)) sess.set(td, { date: td, o: b.open, h: b.high, l: b.low, c: null, last: null, lastEnd: -1 });
      const x = sess.get(td);
      if (t.min >= hm('18:00') || end <= hm('17:00')) { x.h = Math.max(x.h, b.high); x.l = Math.min(x.l, b.low); }
      if (t.min < hm('18:00') && end <= hm('17:00') && end > x.lastEnd) { x.last = b.close; x.lastEnd = end; }
    }
    const rows = [...sess.values()].filter(x => rthDates.includes(x.date)).sort((a, b) => a.date < b.date ? -1 : 1)
      .map(x => ({ datetime: Date.parse(x.date + 'T16:00:00Z'), open: x.o, high: x.h, low: x.l, close: x.last })).filter(r => r.close != null);
    const bb = ind.bollinger(rows);
    const self = rows.map((r, i) => ({ ...r, bbUpper: bb[i].bbUpper, bbMiddle: bb[i].bbMiddle, bbLower: bb[i].bbLower }));
    const merged = [...self, ...schwabNQ.rows.filter(r => r.date >= '2026-01-01').map(r => ({ datetime: Date.parse(r.date + 'T16:00:00Z'), open: r.o, high: r.h, low: r.l, close: r.c, bbUpper: r.up, bbMiddle: r.mid, bbLower: r.lo }))];
    daily.NQ = dailyIndex(merged);
    // offset check: self-built close - Schwab unadjusted close (should be a per-quarter constant = back-adjust offset)
    const offs = self.map(r => { const i = schwabNQ.byDate.get(et(r.datetime).date); return i == null ? null : { q: et(r.datetime).date.slice(0, 7), d: r.close - schwabNQ.rows[i].c, r: r.close / schwabNQ.rows[i].c }; }).filter(Boolean);
    let steps = 0, small = 0; for (let i = 1; i < offs.length; i++) { const dd = Math.abs(offs[i].d - offs[i - 1].d); if (dd > 10) steps++; else small = Math.max(small, dd); }
    src['daily NQ (used)'] = `self-built from intraday for ${self.length} trade dates ${self[0] && et(self[0].datetime).date}..${self.at(-1) && et(self.at(-1).datetime).date} (dataset is a back-adjusted continuous series; close = last trade <= 17:00 ET); real Schwab /NQ daily bars for 2026 dates. Check, self-built minus Schwab unadjusted close over ${offs.length} dates: offset ${f2(offs[0].d)} (first) -> ${f2(offs.at(-1).d)} (last); it changes by >10 pts on ${steps} day-to-day transitions (12 quarterly rolls in the span; the rest are Schwab historical daily closes that are not exactly the 17:00 last trade, or date misalignments around holidays) and otherwise by at most ${f2(small)} pts — i.e. APPROXIMATELY a constant back-adjust offset. Self-built bands are therefore the live-chart bands shifted by the offset to within a few points, EXCEPT in the ~20 days after a roll, where Schwab's unadjusted daily series carries the roll jump and the adjusted series does not (live chart and this study diverge there).`;
  }

  // ---- parity checks -----------------------------------------------------------------------------
  const par = [];
  { // NDX daily close vs settles.json
    let st = {}; try { st = JSON.parse(fs.readFileSync(path.join(DS_DIR, 'settles.json'), 'utf8')); } catch (e) { /* none */ }
    let n = 0, mx = 0; for (const [d, v] of Object.entries(st)) { const i = daily.NDX.byDate.get(d); if (i == null) continue; n++; mx = Math.max(mx, Math.abs(daily.NDX.rows[i].c - v)); }
    par.push(`NDX daily close vs backtest settles.json: ${n} dates, max |diff| ${mx.toFixed(4)} pts.`);
  }
  { // my NQ 60m/15m vs dataset analysis snapshot at :00 labels (2024 sample — full 24h data)
    let n = 0, mc = 0, ml = 0, n15 = 0, m15 = 0;
    const by60 = new Map(S.NQ.tf[60].map(b => [b.endMs, b])), by15 = new Map(S.NQ.tf[15].map(b => [b.endMs, b]));
    for (const f of fs.readdirSync(DS_DIR).filter(f => /^backtest-NQ-2024-0[3-5]/.test(f))) {
      for (const b of JSON.parse(fs.readFileSync(path.join(DS_DIR, f), 'utf8'))) {
        const t = et(b.datetime); if (t.min < hm('10:00') || t.min > hm('15:00')) continue;
        if (t.min % 15 === 0 && by15.has(b.datetime) && b.analysis['15m']) { n15++; m15 = Math.max(m15, Math.abs(by15.get(b.datetime).close - b.analysis['15m'].close)); }
        if (t.min % 60 === 0 && by60.has(b.datetime) && b.analysis['60m'] && b.analysis['60m'].bblower != null) {
          const me = by60.get(b.datetime); n++; mc = Math.max(mc, Math.abs(me.close - b.analysis['60m'].close)); ml = Math.max(ml, Math.abs(me.bbLower - b.analysis['60m'].bblower));
        }
      }
    }
    par.push(`NQ 15m close vs dataset 15m snapshot (2024-03..05, RTH :15 labels): ${n15} bars, max |diff| ${m15.toFixed(2)}. NQ 60m close / 60m bbLower vs dataset 60m snapshot (:00 labels): ${n} bars, max |diff| close ${mc.toFixed(2)}, bbLower ${ml.toFixed(2)} pts.`);
  }

  // ---- records: every tf close in the window --------------------------------------------------------
  const recs = [];
  for (const s of ['NQ', 'NDX']) {
    const by60end = S[s].tf[60].filter(b => b.bbLower != null && b.n5 >= (s === 'NDX' ? 6 : 12));
    const h60 = new Map(by60end.map(b => [b.endMs, b]));
    for (const tf of [15, 60]) {
      const need = s === 'NDX' && tf === 60 ? 6 : tf / 5;
      for (const b of S[s].tf[tf]) {
        if (b.endMin < WIN[tf][0] || b.endMin > WIN[tf][1] || b.n5 < need) continue;
        const di = daily[s].prior(b.date); if (di < 0) continue;
        const dp = daily[s].rows[di]; if (dp.lo == null) continue;
        // last completed 60m at T (ends at the hour <= T)
        const endHourMs = b.endMs - ((b.endMin % 60) * 60000);
        const hb = h60.get(endHourMs);
        const htf = hb ? { below: hb.close < hb.bbLower, above: hb.close > hb.bbUpper, c: hb.close, lo: hb.bbLower, up: hb.bbUpper } : null;
        // outcome series: NDX where NDX price day exists; else (NQ only) NQ proxy
        const pd = S.NDX.px.get(b.date) || (s === 'NQ' ? S.NQ.px.get(b.date) : null);
        const width = dp.up - dp.lo;
        const base = { series: s, tf, date: b.date, T: b.endMin, c: b.close, dLo: dp.lo, dUp: dp.up, dMid: dp.mid, dPriorDate: dp.date, width, htf,
          priorClosedBelow: dp.c < dp.lo, priorClosedAbove: dp.c > dp.up };
        for (const side of ['bull', 'bear']) {
          const daily_ = side === 'bull' ? b.close < dp.lo : b.close > dp.up;
          const beyondPts = side === 'bull' ? dp.lo - b.close : b.close - dp.up;
          const o = pd ? outcome(pd, b.endMin, side === 'bull' ? 1 : -1) : null;
          recs.push({ ...base, side, daily: daily_, htfFlag: htf ? (side === 'bull' ? htf.below : htf.above) : null, beyondPts, beyondW: beyondPts / width * 100,
            priorBeyond: side === 'bull' ? base.priorClosedBelow : base.priorClosedAbove, out: o, today: b.date === TODAY });
        }
      }
    }
  }
  // first event per (series, tf, side, date)
  const firstKey = new Set();
  for (const r of recs.filter(r => r.daily).sort((a, b) => a.T - b.T)) { const k = `${r.series}|${r.tf}|${r.side}|${r.date}`; if (!firstKey.has(k)) { firstKey.add(k); r.first = true; } }
  const firstHtf = new Set();
  for (const r of recs.filter(r => r.htfFlag && !r.daily).sort((a, b) => a.T - b.T)) { const k = `${r.series}|${r.tf}|${r.side}|${r.date}`; if (!firstHtf.has(k)) { firstHtf.add(k); r.firstHtf = true; } }

  const agg = recs.filter(r => r.out && !r.today);

  log(`# Daily-band (BB 20,2) close-beyond study — generated ${new Date().toISOString()}`);
  log('');
  log('Hypothesis: a 15m/60m close BELOW the prior-completed-day LOWER daily band is oversold -> bull; ABOVE the UPPER band is overbought -> bear. All moves are signed in that hypothesis direction (positive = the hypothesis worked).');
  log('');
  log('## Data');
  for (const [k, v] of Object.entries(src)) log(`- ${k}: ${v}`);
  for (const p of par) log(`- parity: ${p}`);
  log(`- Windows: 15m trigger closes ${mm2(WIN[15][0])}-${mm2(WIN[15][1])} ET, 60m closes ${mm2(WIN[60][0])}-${mm2(WIN[60][1])} ET. Records with an outcome (aggregates): ${agg.length / 2} closes x 2 sides. ${TODAY} excluded from aggregates (day in progress).`);
  log('- Outcome pricing: NDX cash wherever an NDX RTH day exists (2026-01-28..2026-10-14); /NQ RTH proxy otherwise (all 2023-2025 NQ-series rows, plus 2026 NQ days without NDX). NDX-series rows are always NDX. See the px_src splits.');
  log('- Column key: "+h pts / hit%" = mean signed move from the trigger close to the close of the 5m bar ending T+h, and % of events where it was > 0 (n per horizon shrinks for late triggers). "to close" uses the official NDX close (or NQ 16:00 proxy). t(close) = mean/SE of the to-close move — events within a day are dependent, so read t on the first-per-day rows. MFE/MAE = max favorable / adverse excursion from the trigger to 16:00 (5m highs/lows).');
  log(`- THIN = n<${THIN}.`);
  log('');

  const G = (s, tf, side, set = agg) => set.filter(r => r.series === s && r.tf === tf && r.side === side);
  for (const s of ['NQ', 'NDX']) for (const tf of [15, 60]) for (const side of ['bull', 'bear']) {
    const all = G(s, tf, side);
    const ev = all.filter(r => r.daily), b1 = all.filter(r => r.htfFlag && !r.daily);
    const lbl = side === 'bull' ? 'OVERSOLD (close < lower daily band) -> bull' : 'OVERBOUGHT (close > upper daily band) -> bear';
    log(`## ${s} · ${tf}m · ${lbl}`);
    log('');
    log(HDR); log(SEP);
    log(row('EVENT all', ev));
    log(row('EVENT first-per-day', ev.filter(r => r.first)));
    log(row('EVENT later (2nd+ in day)', ev.filter(r => !r.first)));
    log(row('EVENT & 60m also beyond (both)', ev.filter(r => r.htfFlag)));
    log(row('EVENT & 60m NOT beyond', ev.filter(r => r.htfFlag === false)));
    log(row('B1 htf-only (60m beyond, NOT daily)', b1));
    log(row('B1 htf-only first-per-day', b1.filter(r => r.firstHtf)));
    log(row('B0 all closes in window', all));
    log('');
    log(`### splits — ${s} ${tf}m ${side}`);
    log('');
    log(HDR); log(SEP);
    for (const [n, a, b] of TOD) {
      const inT = r => r.T >= a && r.T < b;
      log(row(`TOD ${n}: EVENT all`, ev.filter(inT)));
      log(row(`TOD ${n}: EVENT first`, ev.filter(r => r.first && inT(r))));
      log(row(`TOD ${n}: B1 htf-only`, b1.filter(inT)));
      log(row(`TOD ${n}: B0`, all.filter(inT)));
    }
    for (const [a, b] of PTS_BUCKETS) log(row(`beyond ${a}-${b === Infinity ? '+' : b} pts`, ev.filter(r => r.beyondPts > a && r.beyondPts <= b)));
    for (const [a, b] of WPCT_BUCKETS) log(row(`beyond ${a}-${b === Infinity ? '+' : b}% of band width`, ev.filter(r => r.beyondW > a && r.beyondW <= b)));
    log(row(`prior day CLOSED beyond (yes)`, ev.filter(r => r.priorBeyond)));
    log(row(`prior day closed beyond (no)`, ev.filter(r => !r.priorBeyond)));
    log(row(`first-per-day & prior day closed beyond`, ev.filter(r => r.first && r.priorBeyond)));
    log(row(`first-per-day & prior NOT beyond`, ev.filter(r => r.first && !r.priorBeyond)));
    log(row(`B0 when prior day closed beyond`, all.filter(r => r.priorBeyond)));
    if (s === 'NQ') {
      for (const px of ['NDX', 'NQ(proxy)']) {
        log(row(`priced on ${px}: EVENT all`, ev.filter(r => r.out.px_src === px)));
        log(row(`priced on ${px}: EVENT first`, ev.filter(r => r.first && r.out.px_src === px)));
        log(row(`priced on ${px}: B0`, all.filter(r => r.out.px_src === px)));
      }
    }
    for (const y of [...new Set(ev.map(r => r.date.slice(0, 4)))].sort()) log(row(`year ${y}: EVENT first`, ev.filter(r => r.first && r.date.startsWith(y))));
    log('');
  }

  // ---- event-day list (first per day), compact ------------------------------------------------------
  log('## Event days (first trigger per day; aggregates)');
  log('');
  log('| series | tf | side | date | T | close | daily band | beyond pts | % width | prior closed beyond | 60m beyond | px | P0 | +60m | to close | MFE | MAE |');
  log('|---|---|---|---|---|---:|---:|---:|---:|:-:|:-:|---|---:|---:|---:|---:|---:|');
  for (const r of agg.filter(r => r.first).sort((a, b) => a.series.localeCompare(b.series) || a.tf - b.tf || a.side.localeCompare(b.side) || (a.date < b.date ? -1 : 1))) {
    log(`| ${r.series} | ${r.tf} | ${r.side} | ${r.date} | ${mm2(r.T)} | ${r.c} | ${r.side === 'bull' ? r.dLo : r.dUp} | ${f1(r.beyondPts)} | ${f2(r.beyondW)} | ${r.priorBeyond ? 'Y' : '.'} | ${r.htfFlag == null ? 'n/a' : r.htfFlag ? 'Y' : '.'} | ${r.out.px_src} | ${f2(r.out.P0)} | ${f1(r.out.fwd[60])} | ${f1(r.out.fwd.close)} | ${f1(r.out.mfe)} | ${f1(r.out.mae)} |`);
  }
  log('');

  // ---- 2026-10-15 confirmation ----------------------------------------------------------------------
  log(`## ${TODAY} confirmation`);
  log('');
  for (const s of ['NQ', 'NDX']) {
    const di = daily[s].prior(TODAY); const dp = di >= 0 ? daily[s].rows[di] : null;
    if (!dp) { log(`${s}: no prior daily bar`); continue; }
    log(`### ${s}: daily bands from ${dp.date} (last completed day): lower ${dp.lo}, mid ${dp.mid}, upper ${dp.up}, width ${f2(dp.up - dp.lo)}; ${dp.date} close ${dp.c} (${dp.c < dp.lo ? 'CLOSED BELOW lower' : dp.c > dp.up ? 'closed above upper' : 'inside'})`);
    log('');
    const t15 = S[s].tf[15].filter(b => b.date === TODAY && b.endMin >= hm('09:45') && b.endMin <= hm('16:00'));
    if (!t15.length) { log(`${s}: no ${TODAY} intraday bars (live fetch: ${src[`live 1m ${s} ${TODAY}`]})`); log(''); continue; }
    log('| 15m bar | open | high | low | close | vs lower daily band (close - lower) | below? | % of width | 60m last completed close / 60m lower | 60m beyond? | 5m bars in bucket |');
    log('|---|---:|---:|---:|---:|---:|:-:|---:|---|:-:|---:|');
    for (const b of t15) {
      const r = recs.find(x => x.series === s && x.tf === 15 && x.side === 'bull' && x.date === TODAY && x.T === b.endMin);
      log(`| ${mm2(b.endMin - 15)}-${mm2(b.endMin)} | ${f2(b.open)} | ${f2(b.high)} | ${f2(b.low)} | ${f2(b.close)} | ${f2(b.close - dp.lo)} | ${b.close < dp.lo ? 'YES' : '.'} | ${f2((dp.lo - b.close) / (dp.up - dp.lo) * 100)} | ${r && r.htf ? `${f2(r.htf.c)} / ${f2(r.htf.lo)}` : 'n/a'} | ${r && r.htf ? (r.htf.below ? 'Y' : '.') : 'n/a'} | ${b.n5} |`);
    }
    log('');
    const ev = recs.filter(r => r.series === s && r.today && r.daily);
    for (const r of ev) {
      const o = r.out;
      log(`- ${s} ${r.tf}m ${r.side} event at ${mm2(r.T)}: close ${r.c} vs ${r.side === 'bull' ? 'lower ' + r.dLo : 'upper ' + r.dUp}, beyond ${f2(r.beyondPts)} pts (${f2(r.beyondW)}% width); ${r.first ? 'FIRST of day' : 'later'}; 60m beyond: ${r.htfFlag == null ? 'n/a' : r.htfFlag ? 'Y' : 'n'}` +
        (o ? `; priced ${o.px_src} P0 ${f2(o.P0)}, fwd ${HORIZONS.map(h => `+${h}m ${o.fwd[h] == null ? 'n/a' : f1(o.fwd[h])}`).join(', ')}, MFE/MAE so far ${f1(o.mfe)}/${f1(o.mae)} (partial day)` : '; no complete price day yet (live, partial outcome below)'));
    }
    if (!ev.length) log(`- no ${s} daily-band events today in the window so far.`);
    // partial forward moves for today's events using today's live NDX 5m bars
    const todayPx = new Map(); for (const b of S.NDX.b5) { const t = et(b.datetime); if (t.date === TODAY) todayPx.set(t.min + 5, b); }
    const lastEnd = Math.max(0, ...todayPx.keys());
    for (const r of ev.filter(r => r.first)) {
      const p0 = todayPx.get(r.T); if (!p0) continue;
      const sg = r.side === 'bull' ? 1 : -1;
      let hi = p0.close, lo = p0.close; for (let e = r.T + 5; e <= lastEnd; e += 5) { const b = todayPx.get(e); if (b) { hi = Math.max(hi, b.high); lo = Math.min(lo, b.low); } }
      log(`  - partial NDX outcome for the first ${r.tf}m ${r.side} event (${mm2(r.T)}): P0 ${f2(p0.close)}; ${HORIZONS.map(h => { const b = todayPx.get(r.T + h); return `+${h}m ${b ? f1(sg * (b.close - p0.close)) : 'n/a'}`; }).join(', ')}; latest NDX 5m (${mm2(lastEnd)}) ${f2(todayPx.get(lastEnd).close)} = ${f1(sg * (todayPx.get(lastEnd).close - p0.close))}; MFE ${f1(sg > 0 ? hi - p0.close : p0.close - lo)} / MAE ${f1(sg > 0 ? p0.close - lo : hi - p0.close)} through ${mm2(lastEnd)}.`);
    }
    log('');
  }

  // ---- CSV -----------------------------------------------------------------------------------------
  const cols = ['series', 'tf', 'side', 'date', 'T', 'close', 'daily_prior_date', 'daily_lower', 'daily_mid', 'daily_upper', 'band_width', 'beyond_daily', 'beyond_pts', 'beyond_pct_width',
    'first_of_day', 'prior_day_closed_beyond', 'htf60_close', 'htf60_lower', 'htf60_upper', 'htf60_beyond', 'px_src', 'P0', ...HORIZONS.map(h => `fwd_${h}`), 'fwd_close', 'fwd_close_pct', 'mfe', 'mae', 'today_partial'];
  const num = (x, d = 2) => x == null || !Number.isFinite(x) ? '' : (+x).toFixed(d);
  const b01 = x => x == null ? '' : x ? 1 : 0;
  const line = r => [r.series, r.tf, r.side, r.date, mm2(r.T), r.c, r.dPriorDate, r.dLo, r.dMid, r.dUp, num(r.width), b01(r.daily), num(r.beyondPts), num(r.beyondW, 3),
    b01(!!r.first), b01(r.priorBeyond), r.htf ? r.htf.c : '', r.htf ? r.htf.lo : '', r.htf ? r.htf.up : '', b01(r.htfFlag), r.out ? r.out.px_src : '', r.out ? num(r.out.P0) : '',
    ...HORIZONS.map(h => r.out ? num(r.out.fwd[h]) : ''), r.out ? num(r.out.fwd.close) : '', r.out ? num(r.out.closePct, 4) : '', r.out ? num(r.out.mfe) : '', r.out ? num(r.out.mae) : '', b01(r.today)].join(',');
  fs.writeFileSync(path.join(OUT, 'daily-bb-events.csv'), [cols.join(','), ...recs.filter(r => r.daily).map(line)].join('\n') + '\n');
  fs.writeFileSync(path.join(OUT, 'daily-bb-all-closes.csv'), [cols.join(','), ...recs.map(line)].join('\n') + '\n');
  fs.writeFileSync(path.join(OUT, 'summary.md'), out.join('\n') + '\n');
  console.log(`\nwrote ${OUT}/summary.md, daily-bb-events.csv (${recs.filter(r => r.daily).length} rows), daily-bb-all-closes.csv (${recs.length} rows)`);
}

main().catch(e => { console.error(e); process.exit(1); });
