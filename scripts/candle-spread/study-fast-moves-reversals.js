#!/usr/bin/env node
'use strict';
/**
 * FAST MOVES + REVERSALS + CONTINUATION STUDY (analysis only — touches no engine code). Sizes the rules for the
 * planned v12 engine: (A) jump risk, (B) which reversal signals predict a real turn, (C) do multi-TF confirmations
 * make adds safer, (D) a jump-risk budget.
 *
 * SIGNAL vs PRICE (feedback_nq_signals_ndx_pricing): signals ALWAYS /NQ 24h bars; outcomes on cash NDX where it
 * exists (2026 raw-1m), else /NQ RTH 1m as a PROXY (2023-2025, ~/Downloads/Dataset_NQ_1min_2022_2025.csv,
 * back-adjusted, bar-END timestamps -> converted to bar start). The intraday NQ-NDX basis is ~constant, so NQ
 * POINT moves stand in for NDX point moves; part A validates that on the 2026 overlap.
 *
 * SCALING. NQ ran ~11k (2023) -> ~26k (2025); NDX ~25-30k in 2026. Point thresholds are therefore applied in
 * "pts@REF" = pts x REF / price, REF = the mean 2026 NDX RTH close (printed), so every year is measured at
 * today's price level. Part A also reports raw points per year.
 *
 * sigma: per-minute sigma = P x iv / sqrt(252 x 390) with iv = ivFromRelBandWidth(15m band width / close) of
 * the last completed /NQ 15m bar (trading-time scaling; the engine's tauFromTime uses calendar time).
 *
 * Usage: node --max-old-space-size=8192 scripts/candle-spread/study-fast-moves-reversals.js [--csv path] [--out dir]
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const ROOT = path.resolve(__dirname, '..', '..');
const ind = require(path.join(ROOT, 'server/src/candle-spread/signals/indicators.js'));
const pat = require(path.join(ROOT, 'server/src/candle-spread/signals/candle-patterns.js'));
const { ivFromRelBandWidth } = require(path.join(ROOT, 'server/src/candle-spread/bs-pricer.js'));

const argv = process.argv.slice(2);
const arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const CSV = arg('--csv', path.join(os.homedir(), 'Downloads/Dataset_NQ_1min_2022_2025.csv'));
const OUT = path.resolve(ROOT, arg('--out', 'data/sweeps/fast-moves-reversals-2026-10-17'));
const RAW = path.join(ROOT, 'signal-lab-data/raw-1m');
fs.mkdirSync(OUT, { recursive: true });

const MIN = 60000, DAY = 1440;
const RTH0 = 570, RTH1 = 960; // 09:30, 16:00 (minutes after ET midnight)
const TS = [1, 2, 5, 15, 30];
const XS = [25, 50, 75, 100, 150];
const SIG_PER_MIN_DEN = Math.sqrt(252 * 390);
const LEVEL_BP = 0.0005;
// part A3 "after a reversal signal": the less-frequent detectors only (the candle-shape ones fire on most bars)
const STRONG_REV = new Set(['bbCloseBackIn', 'trendFlip15', 'flip5+15', 'v7-grind', 'engulf']); // "at a level" tolerance = 5bp of price (~14 pts @28k)

// ---------- time ----------
const etFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
function etNaiveMs(ms) { // epoch ms -> "ET wall clock as if UTC" ms
  const p = Object.fromEntries(etFmt.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, p.hour === '24' ? 0 : +p.hour, +p.minute);
}
const dateOf = (ms) => new Date(Math.floor(ms / (DAY * MIN)) * DAY * MIN).toISOString().slice(0, 10);
const modOf = (ms) => Math.round((ms % (DAY * MIN)) / MIN); // minute of day
const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

// ---------- loaders ----------
function loadCsv(file) {
  const txt = fs.readFileSync(file, 'utf8');
  const out = [];
  let pos = txt.indexOf('\n') + 1;
  while (pos < txt.length) {
    let nl = txt.indexOf('\n', pos); if (nl < 0) nl = txt.length;
    const line = txt.slice(pos, nl); pos = nl + 1;
    if (!line) continue;
    const f = line.split(',');
    const [dpart, tpart] = f[0].split(' ');
    const [mo, d, y] = dpart.split('/').map(Number);
    const [hh, mi] = tpart.split(':').map(Number);
    const start = Date.UTC(y, mo - 1, d, hh, mi) - MIN; // bar END -> bar start
    out.push({ datetime: start, open: +f[1], high: +f[2], low: +f[3], close: +f[4] });
  }
  out.sort((a, b) => a.datetime - b.datetime);
  return out;
}
function loadRaw(sym) {
  const files = fs.readdirSync(RAW).filter(f => f.startsWith(sym + '-2026')).sort();
  const map = new Map();
  for (const f of files) {
    const j = JSON.parse(fs.readFileSync(path.join(RAW, f), 'utf8'));
    for (const c of (j.candles || j)) if (c && c.datetime != null) { const t = etNaiveMs(c.datetime); map.set(t, { datetime: t, open: c.open, high: c.high, low: c.low, close: c.close }); }
  }
  return [...map.values()].sort((a, b) => a.datetime - b.datetime);
}
// RTH price days: Map date -> { date, h,l,c Float64Array(390) }, forward-filled; full days only.
function priceDays(bars, fromDate, toDate) {
  const by = new Map();
  for (const b of bars) {
    const m = modOf(b.datetime); if (m < RTH0 || m >= RTH1) continue;
    const d = dateOf(b.datetime); if (d < fromDate || d > toDate) continue;
    if (!by.has(d)) by.set(d, []);
    by.get(d).push([m - RTH0, b]);
  }
  const days = new Map();
  for (const [d, arr] of by) {
    if (arr.length < 380) continue;
    const s = new Set(arr.map(a => a[0])); if (!s.has(389) && !s.has(388)) continue;
    const h = new Float64Array(390).fill(NaN), l = new Float64Array(390).fill(NaN), c = new Float64Array(390).fill(NaN), o = new Float64Array(390).fill(NaN);
    for (const [i, b] of arr) { h[i] = b.high; l[i] = b.low; c[i] = b.close; o[i] = b.open; }
    let last = null;
    for (let i = 0; i < 390; i++) { if (Number.isNaN(c[i])) { if (last == null) { const f = arr.sort((a, b) => a[0] - b[0])[0][1].open; last = f; } h[i] = l[i] = c[i] = o[i] = last; } else last = c[i]; }
    days.set(d, { date: d, year: d.slice(0, 4), h, l, c, o });
  }
  return days;
}

// ---------- signal series ----------
const trendOf = (b) => (!b || b.bbMiddle == null || b.ema9 == null) ? null : (b.close > b.bbMiddle && b.ema9 >= b.bbMiddle ? 1 : b.close < b.bbMiddle && b.ema9 <= b.bbMiddle ? -1 : 0);
function buildSignal(sig1m) {
  const S = { tf: {} };
  for (const p of [1, 5, 15, 60]) {
    const bars = ind.withIndicators(p === 1 ? sig1m : ind.resample(sig1m, p));
    const ends = new Float64Array(bars.length);
    for (let i = 0; i < bars.length; i++) ends[i] = bars[i].datetime + p * MIN;
    S.tf[p] = { p, bars, ends };
  }
  // last bar of tf p completed by time T (ms), not stale (> p+30 min old) -> index or -1
  S.last = (p, T) => {
    const { ends } = S.tf[p];
    let lo = 0, hi = ends.length - 1, r = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (ends[m] <= T) { r = m; lo = m + 1; } else hi = m - 1; }
    if (r < 0 || T - ends[r] > (p + 30) * MIN) return -1;
    return r;
  };
  S.bar = (p, T) => { const i = S.last(p, T); return i < 0 ? null : S.tf[p].bars[i]; };
  return S;
}

// ---------- forward outcome from boundary k (entry = close of slot k-1), direction d, in pts@REF ----------
const FAV = [25, 50, 100], ADV = [25, 50];
function outcome(day, k, d, scale) {
  const P = day.c[k - 1];
  const tF = [Infinity, Infinity, Infinity], tA = [Infinity, Infinity];
  let mfe = 0, mae = 0;
  const o = { mfe15: 0, mae15: 0, mfe30: 0, mae30: 0, mfe60: 0, mae60: 0, mv15: NaN, mv30: NaN, mv60: NaN, mvClose: NaN };
  for (let j = k; j < 390; j++) {
    const n = j - k + 1;
    const fav = (d > 0 ? day.h[j] - P : P - day.l[j]) * scale;
    const adv = (d > 0 ? P - day.l[j] : day.h[j] - P) * scale;
    if (fav > mfe) mfe = fav; if (adv > mae) mae = adv;
    for (let a = 0; a < 2; a++) if (tA[a] === Infinity && adv >= ADV[a]) tA[a] = n;
    for (let f = 0; f < 3; f++) if (tF[f] === Infinity && fav >= FAV[f]) tF[f] = n;
    const mv = (day.c[j] - P) * d * scale;
    if (n === 15) { o.mfe15 = mfe; o.mae15 = mae; o.mv15 = mv; }
    if (n === 30) { o.mfe30 = mfe; o.mae30 = mae; o.mv30 = mv; }
    if (n === 60) { o.mfe60 = mfe; o.mae60 = mae; o.mv60 = mv; }
    o.mvClose = mv;
  }
  const win = (f, a, H = Infinity) => (tF[f] < tA[a] && tF[f] <= H ? 1 : 0); // same-minute tie = loss
  o.w25_25 = win(0, 0); o.w50_25 = win(1, 0); o.w50_50 = win(1, 1); o.w100_50 = win(2, 1);
  o.w25_25_60 = win(0, 0, 60); o.w50_25_60 = win(1, 0, 60);
  return o;
}
const OUT_KEYS = ['w25_25', 'w50_25', 'w50_50', 'w100_50', 'w25_25_60', 'w50_25_60', 'mfe30', 'mae30', 'mfe60', 'mae60', 'mv15', 'mv30', 'mv60', 'mvClose', 'probe'];

// ---------- part B: reversal detectors on a completed tf bar ----------
function colorOf(b) { return b.close > b.open ? 1 : b.close < b.open ? -1 : 0; }
function detect(S, p, i) {
  const bars = S.tf[p].bars, c = bars[i], pr = bars[i - 1];
  if (!pr || c.bbMiddle == null || c.ema9 == null || pr.bbMiddle == null) return [];
  const out = [];
  const add = (det, dir) => out.push([det, dir]);
  if (pat.isBullishEngulfing(c, pr)) add('engulf', 1);
  if (pat.isBearishEngulfing(c, pr)) add('engulf', -1);
  if (pat.isBottomRejection(c)) add('hammer/pin', 1);
  if (pat.isTopRejection(c)) add('hammer/pin', -1);
  if (pat.bullishReversalCandle(c, pr)) add('repoRevCandle', 1);
  if (pat.bearishReversalCandle(c, pr)) add('repoRevCandle', -1);
  // runs
  const col = colorOf(c);
  let run = 0, runCol = colorOf(pr);
  for (let j = i - 1; j >= 0 && j >= i - 12; j--) { if (runCol !== 0 && colorOf(bars[j]) === runCol) run++; else break; }
  if (col !== 0 && runCol === -col && run >= 3) add('flip3', col);
  if (col !== 0 && runCol === -col && run >= 5) add('flip5', col);
  if (pat.isDoji(c) && runCol !== 0 && run >= 3) add('doji-after-run', -runCol);
  // band poke / re-entry
  if (c.bbLower != null) {
    if (c.low < c.bbLower && c.close > c.bbLower) add('bbPokeBack', 1);
    if (c.high > c.bbUpper && c.close < c.bbUpper) add('bbPokeBack', -1);
    if (pr.bbLower != null && pr.close < pr.bbLower && c.close > c.bbLower) add('bbCloseBackIn', 1);
    if (pr.bbUpper != null && pr.close > pr.bbUpper && c.close < c.bbUpper) add('bbCloseBackIn', -1);
  }
  // rejection at 9EMA / mid (wick through, close back on the side it came from)
  for (const [nm, lv] of [['emaRej', c.ema9], ['midRej', c.bbMiddle]]) {
    if (c.low < lv && c.close > lv && c.open > lv) add(nm, 1);
    if (c.high > lv && c.close < lv && c.open < lv) add(nm, -1);
  }
  const T = c.datetime + p * MIN;
  const t = trendOf(c), tp = trendOf(pr);
  if (p === 15) {
    // v7 overextension reversal: 15m wick vs the 5m band, revFrac -0.15, closed back inside
    const c5 = S.bar(5, T);
    if (c5 && c5.bbUpper != null) {
      const bw5 = c5.bbUpper - c5.bbLower;
      if (bw5 > 0) {
        if ((c5.bbLower - c.low) / bw5 >= -0.15 && c.close > c5.bbLower) add('v7-overext', 1);
        if ((c.high - c5.bbUpper) / bw5 >= -0.15 && c.close < c5.bbUpper) add('v7-overext', -1);
      }
    }
    // v7 grind: 1m band beyond 5m/15m band by >=10% of 1m width + repo reversal candle
    const c1 = S.bar(1, T);
    if (c1 && c1.bbUpper != null && c5 && c5.bbUpper != null) {
      const w = c1.bbUpper - c1.bbLower;
      if (w > 0) {
        const dn = Math.max((c5.bbLower - c1.bbLower) / w, (c.bbLower - c1.bbLower) / w);
        const up = Math.max((c1.bbUpper - c5.bbUpper) / w, (c1.bbUpper - c.bbUpper) / w);
        if (up >= 0.10 && c.close > c.bbMiddle && pat.bearishReversalCandle(c, pr)) add('v7-grind', -1);
        if (dn >= 0.10 && c.close < c.bbMiddle && pat.bullishReversalCandle(c, pr)) add('v7-grind', 1);
      }
    }
    if (t === 1 && tp !== 1 && tp != null) add('trendFlip15', 1);
    if (t === -1 && tp !== -1 && tp != null) add('trendFlip15', -1);
  }
  if (p === 5) {
    const pp = bars[i - 2], tpp = trendOf(pp), t15 = trendOf(S.bar(15, T));
    if (t === 1 && tp === 1 && tpp !== 1 && tpp != null && t15 === 1) add('flip5+15', 1);
    if (t === -1 && tp === -1 && tpp !== -1 && tpp != null && t15 === -1) add('flip5+15', -1);
    if (t === 1 && tp !== 1 && tp != null) add('trendFlip5', 1);
    if (t === -1 && tp !== -1 && tp != null) add('trendFlip5', -1);
  }
  return out;
}
function atLevel(S, c, dir, T) {
  const L = LEVEL_BP * c.close;
  const ext = dir > 0 ? c.low : c.high;
  for (const p of [5, 15, 60]) {
    const b = S.bar(p, T); if (!b || b.bbMiddle == null) continue;
    for (const lv of [b.bbUpper, b.bbLower, b.bbMiddle, b.ema9]) {
      if (Math.abs(ext - lv) <= L) return true;
      if (dir > 0 && c.low < lv && c.close > lv) return true;
      if (dir < 0 && c.high > lv && c.close < lv) return true;
    }
  }
  return false;
}

// ---------- run one dataset ----------
function runDataset(label, S, days, REF, opts = {}) {
  const res = { label, A: [], jumps: [], B: [], C: [], nDays: days.size };
  const sigFired = new Set(); // date|boundaryMin within 15 min after any reversal signal
  const dayBase = (d) => Date.parse(d + 'T00:00:00Z');

  // ---- per-day decision bars for B/C (5m and 15m), with outcomes for both directions ----
  for (const day of days.values()) {
    const base = dayBase(day.date);
    for (const p of [5, 15]) {
      const tf = S.tf[p];
      for (let M = RTH0 + p; M <= 930; M += p) {
        const T = base + M * MIN;
        const i = S.last(p, T); if (i < 1 || tf.ends[i] !== T) continue;
        const c = tf.bars[i]; if (c.bbMiddle == null || c.ema9 == null) continue;
        const k = M - RTH0;
        const P = day.c[k - 1], scale = REF / P;
        const b60 = S.bar(60, T), t60 = trendOf(b60), t15 = trendOf(S.bar(15, T));
        const nx = tf.bars[i + 1] && tf.ends[i + 1] === T + p * MIN ? tf.bars[i + 1] : null;
        const out = {};
        for (const d of [1, -1]) { const o = outcome(day, k, d, scale); o.probe = nx ? ((d > 0 ? nx.low < c.low : nx.high > c.high) ? 1 : 0) : NaN; out[d] = o; }
        const rec = { date: day.date, year: day.year, p, M, b30: Math.floor((M - 1 - RTH0) / 30), t60, t15, out };
        if (opts.sigOnly !== true) {
          rec.dets = detect(S, p, i).map(([det, dir]) => ({ det, dir, lvl: atLevel(S, c, dir, T) }));
          for (const x of rec.dets) if (STRONG_REV.has(x.det)) for (let m = M; m < M + 15; m++) sigFired.add(day.date + '|' + m);
          // part C context (5m only)
          if (p === 5 && t15) {
            let cnt = 0;
            for (const q of [5, 15, 60]) {
              const j = S.last(q, T); if (j < 1) continue;
              const b = S.tf[q].bars[j], bp = S.tf[q].bars[j - 1];
              if (b.ema9 == null) continue;
              if (t15 > 0 ? (b.close > bp.high && b.close > b.ema9) : (b.close < bp.low && b.close < b.ema9)) cnt++;
            }
            // trend start: walk back the 15m bars while trendOf == t15
            const j15 = S.last(15, T); let js = j15;
            while (js > 0 && trendOf(S.tf[15].bars[js - 1]) === t15) js--;
            const startMs = S.tf[15].ends[js];
            const since = (T - startMs) / MIN;
            const pB = b60 && b60.percentB != null ? (t15 > 0 ? b60.percentB : 1 - b60.percentB) : null;
            rec.C = { dir: t15, cnt, since, startedToday: startMs >= base + RTH0 * MIN, pB };
          }
        }
        res.B.push(rec);
      }
    }
  }

  // ---- part A: excursions per RTH minute boundary ----
  for (const day of days.values()) {
    const base = dayBase(day.date);
    for (let k = 1; k < 390; k++) {
      const M = RTH0 + k, T = base + M * MIN, P = day.c[k - 1];
      const b15 = S.bar(15, T), b60 = S.bar(60, T);
      const t15 = trendOf(b15), t60 = trendOf(b60);
      const iv = b15 && b15.bbUpper != null ? ivFromRelBandWidth((b15.bbUpper - b15.bbLower) / b15.close) : null;
      const row = { year: day.year, date: day.date, b30: Math.floor((M - 1 - RTH0) / 30), t15, t60, P, sig1: iv ? P * iv / SIG_PER_MIN_DEN : null, rev: sigFired.has(day.date + '|' + M) ? 1 : 0, up: {}, dn: {} };
      let mx = -Infinity, mn = Infinity;
      for (let j = k; j < Math.min(390, k + 30); j++) {
        if (day.h[j] > mx) mx = day.h[j]; if (day.l[j] < mn) mn = day.l[j];
        const n = j - k + 1;
        if (TS.includes(n)) { row.up[n] = mx - P; row.dn[n] = P - mn; }
      }
      res.A.push(row);
    }
    // jump episodes: >=50 pts@REF within 5 min, then does it fully retrace?
    for (let k = 1; k < 385;) {
      const P = day.c[k - 1], sc = REF / P;
      let hit = null;
      for (let j = k; j < k + 5; j++) {
        if ((day.h[j] - P) * sc >= 50) { hit = { d: 1, j }; break; }
        if ((P - day.l[j]) * sc >= 50) { hit = { d: -1, j }; break; }
      }
      if (!hit) { k++; continue; }
      // extreme: continue to the furthest point in the move direction within the 5-min window from k
      let te = hit.j, ext = hit.d > 0 ? day.h[hit.j] : day.l[hit.j];
      for (let j = hit.j; j < Math.min(390, k + 5); j++) { if (hit.d > 0 ? day.h[j] > ext : day.l[j] < ext) { ext = hit.d > 0 ? day.h[j] : day.l[j]; te = j; } }
      const size = Math.abs(ext - P) * sc;
      const ev = { year: day.year, date: day.date, b30: Math.floor((k - 1) / 30), d: hit.d, size, full: {}, half: {} };
      for (const N of [5, 15, 30]) {
        let full = 0, half = 0;
        for (let j = te + 1; j <= Math.min(389, te + N); j++) {
          if (hit.d > 0 ? day.l[j] <= P : day.h[j] >= P) full = 1;
          if (hit.d > 0 ? day.l[j] <= (P + ext) / 2 : day.h[j] >= (P + ext) / 2) half = 1;
        }
        ev.full[N] = full; ev.half[N] = half;
      }
      ev.t15 = trendOf(S.bar(15, dayBase(day.date) + (RTH0 + k) * MIN));
      res.jumps.push(ev);
      k = te + 1;
    }
  }
  return res;
}

// ---------- stats helpers ----------
const pctl = (arr, q) => { if (!arr.length) return NaN; const a = Float64Array.from(arr).sort(); return a[Math.min(a.length - 1, Math.floor(q * (a.length - 1) + 0.5))]; };
const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const f1 = (x) => (x == null || Number.isNaN(x) ? '' : (Math.round(x * 10) / 10).toFixed(1));
const f3 = (x) => (x == null || Number.isNaN(x) ? '' : (Math.round(x * 1000) / 1000).toFixed(3));
const pc = (x) => (x == null || Number.isNaN(x) ? '' : (100 * x).toFixed(1));
function writeCsv(name, rows) {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  fs.writeFileSync(path.join(OUT, name), [cols.join(','), ...rows.map(r => cols.map(c => r[c]).join(','))].join('\n') + '\n');
}
function mdTable(rows, cols) {
  cols = cols || Object.keys(rows[0] || {});
  return [`| ${cols.join(' | ')} |`, `|${cols.map(() => '---').join('|')}|`, ...rows.map(r => `| ${cols.map(c => r[c]).join(' | ')} |`)].join('\n');
}
const B30 = (b) => `${hm(RTH0 + b * 30)}`;
const tod3 = (b30) => (b30 < 2 ? '09:30-10:30' : b30 < 9 ? '10:30-14:00' : '14:00-16:00');
const TOD5 = (b30) => (b30 === 0 ? '09:30-10:00' : b30 < 3 ? '10:00-11:00' : b30 < 9 ? '11:00-14:00' : b30 < 11 ? '14:00-15:00' : '15:00-16:00');

// =====================================================================================================
// SECTION E — swing structure (1m zigzag) and the hazard of a run ending (2026-10-17 follow-up).
// All prices in pts@REF: the day's 1m path is multiplied by REF / (day's first RTH open), a constant per day, so
// the zigzag is consistent within a day. Outcome at a decision bar j for direction d (d=+1 = an UP run):
// R = that bar's CLOSE (the zigzag runs on 1m CLOSES, so there is no intra-bar ordering ambiguity; a high/low zigzag
// flip-flopped inside wide bars and its outcome was biased by close-vs-high); from bar j+1 on, does the intrabar
// path reach R - Y (REVERSAL, mirrored for d=-1) before R + Z (EXTENSION)? Same-minute tie counts as extension (no reversal credit). Unresolved by 16:00 -> excluded.
// PLACEBO: the identical outcome at EVERY RTH minute, cell-matched on year x 30-min bucket x direction x IV tercile.
// =====================================================================================================
const E_THETAS = [15, 20, 25];
const E_XS = [40, 60, 80, 100, 120];
const E_PAIRS = [[25, 20], [25, 40], [40, 20], [40, 40]]; // [Y reverse, Z extend]
const E_CONF_R = 12, E_TOUCH_TOL = 3;
function runE(S, days, REF) {
  const mins = [], events = [], runs = [];
  for (const day of days.values()) {
    const base = Date.parse(day.date + 'T00:00:00Z');
    const s = REF / day.o[0];
    const H = Array.from(day.h, x => x * s), L = Array.from(day.l, x => x * s), C = Array.from(day.c, x => x * s);
    const ctx = new Array(390);
    for (let j = 0; j < 390; j++) {
      const T = base + (RTH0 + j + 1) * MIN;
      const b15 = S.bar(15, T), b60 = S.bar(60, T), b1 = S.bar(1, T);
      const iv = b15 && b15.bbUpper != null ? ivFromRelBandWidth((b15.bbUpper - b15.bbLower) / b15.close) : null;
      const out = {};
      for (const d of [1, -1]) {
        const R = C[j];
        out[d] = E_PAIRS.map(([Y, Z]) => {
          for (let i = j + 1; i < 390; i++) {
            const ext = d > 0 ? H[i] >= R + Z : L[i] <= R - Z;
            if (ext) return 0;
            const rev = d > 0 ? L[i] <= R - Y : H[i] >= R + Y;
            if (rev) return 1;
          }
          return NaN;
        });
      }
      ctx[j] = { T, iv, t60: trendOf(b60), b30: Math.floor(j / 30), out, basis: b1 ? b1.close - day.c[j] : null };
      mins.push({ ds: day.date, year: day.year, b30: ctx[j].b30, iv, out });
    }
    for (const th of E_THETAS) {
      let dir = 0, origin = 0, oT = 0, ext = 0, eT = 0, mx = C[0], mxT = 0, mn = C[0], mnT = 0, emitted = new Set();
      const startRun = (d, o, ot, e, et) => { dir = d; origin = o; oT = ot; ext = e; eT = et; emitted = new Set(); };
      for (let j = 0; j < 390; j++) {
        if (dir === 0) {
          if (C[j] > mx) { mx = C[j]; mxT = j; } if (C[j] < mn) { mn = C[j]; mnT = j; }
          if (C[j] - mn >= th) startRun(1, mn, mnT, C[j], j);
          else if (mx - C[j] >= th) startRun(-1, mx, mxT, C[j], j);
          else continue;
        } else if (dir > 0 ? C[j] > ext : C[j] < ext) { ext = C[j]; eT = j; }
        const run = (ext - origin) * dir;
        if (eT === j) for (const X of E_XS) if (!emitted.has(X) && run >= X) {
          emitted.add(X);
          events.push(eventFeatures(S, day, ctx, H, L, C, s, j, dir, X, th, run, oT));
        }
        if (dir > 0 ? C[j] <= ext - th : C[j] >= ext + th) {
          runs.push({ th, date: day.date, year: day.year, size: run, dur: eT - oT, endB30: Math.floor(eT / 30), iv: ctx[eT].iv, dir, done: true });
          startRun(-dir, ext, eT, C[j], j);
        }
      }
      if (dir !== 0) runs.push({ th, date: day.date, year: day.year, size: (ext - origin) * dir, dur: eT - oT, endB30: Math.floor(eT / 30), iv: ctx[eT].iv, dir, done: false });
    }
  }
  return { mins, events, runs };
}
function eventFeatures(S, day, ctx, H, L, C, s, j, dir, X, th, run, oT) {
  const c = ctx[j];
  let wick = dir > 0 ? -Infinity : Infinity; // the run's intrabar extreme (wick) since its pivot — what tags a band
  for (let i = oT; i <= j; i++) wick = dir > 0 ? Math.max(wick, H[i]) : Math.min(wick, L[i]);
  const extRaw = wick / s;
  const extSig = c.basis == null ? null : extRaw + c.basis; // into /NQ space to compare with the NQ lines
  let conf = 0, touch = { 5: 0, 15: 0, 60: 0 }, nextBeyond = Infinity, have = false;
  if (extSig != null) for (const p of [5, 15, 60]) {
    const b = S.bar(p, c.T); if (!b || b.bbMiddle == null) continue; have = true;
    for (const lv of [b.bbUpper, b.bbLower, b.bbMiddle, b.ema9]) {
      const dd = (lv - extSig) * dir * s; // >0 = line still ahead of the run
      if (Math.abs(dd) <= E_CONF_R) conf++;
      else if (dd > E_CONF_R && dd < nextBeyond) nextBeyond = dd;
    }
    const band = dir > 0 ? b.bbUpper : b.bbLower;
    if ((extSig - band) * dir * s >= -E_TOUCH_TOL) touch[p] = 1;
  }
  let mom = 0; for (let i = Math.max(1, j - 4); i <= j; i++) if ((C[i] - C[i - 1]) * dir > 0) mom++;
  return { date: day.date, year: day.year, th, X, dir, j, b30: c.b30, iv: c.iv, t60rel: c.t60 == null ? 'na' : c.t60 === dir ? 'with' : c.t60 === -dir ? 'against' : 'neutral',
    conf: have ? conf : null, touch5: touch[5], touch15: touch[15], touch60: touch[60], touchAny: touch[5] || touch[15] || touch[60] ? 1 : 0,
    nextBeyond, speed: run / (j - oT + 1), dur: j - oT + 1, mom, out: c.out[dir] };
}
function reportE(Es, REF, nDays1, nDays2) {
  const mins = Es.flatMap(e => e.mins), events = Es.flatMap(e => e.events), runs = Es.flatMap(e => e.runs);
  const ivs = Float64Array.from(mins.map(m => m.iv).filter(x => x != null)).sort();
  const q1 = ivs[Math.floor(ivs.length / 3)], q2 = ivs[Math.floor(2 * ivs.length / 3)];
  const ivT = (iv) => iv == null ? 'na' : iv < q1 ? 'lowIV' : iv < q2 ? 'midIV' : 'highIV';
  const key = (y, b, d, iv) => `${y}|${b}|${d}|${ivT(iv)}`;
  const cell = new Map();
  for (const m of mins) for (const d of [1, -1]) {
    const k = key(m.year, m.b30, d, m.iv); let c = cell.get(k); if (!c) { c = E_PAIRS.map(() => [0, 0]); cell.set(k, c); }
    m.out[d].forEach((v, i) => { if (!Number.isNaN(v)) { c[i][0] += v; c[i][1]++; } });
  }
  const base = (e, i) => { const c = cell.get(key(e.year, e.b30, e.dir, e.iv))[i]; return c[1] ? c[0] / c[1] : NaN; };
  const stat = (L, i) => {
    const v = L.filter(e => !Number.isNaN(e.out[i]) && !Number.isNaN(base(e, i)));
    const p = mean(v.map(e => e.out[i])), b = mean(v.map(e => base(e, i)));
    const byDay = new Map(); for (const e of v) byDay.set(e.date, (byDay.get(e.date) || 0) + (e.out[i] - base(e, i)) - (p - b));
    const se = Math.sqrt([...byDay.values()].reduce((a, x) => a + x * x, 0)) / (v.length || 1);
    const yrs = ['2023', '2024', '2025', '2026'].map(y => { const w = v.filter(e => e.year === y); if (w.length < 20) return '.'; return mean(w.map(e => e.out[i] - base(e, i))) > 0 ? '+' : '-'; }).join('');
    return { n: v.length, days: byDay.size, p, b, lift: p - b, z: (p - b) / se, yrs };
  };
  const row = (k, L) => {
    const o = { ...k };
    E_PAIRS.forEach(([Y, Z], i) => { const st = stat(L, i); if (i === 0) { o.n = st.n; o.days = st.days; } o[`rev${Y}/ext${Z}`] = pc(st.p); o[`base${Y}/${Z}`] = pc(st.b); o[`lift${Y}/${Z}`] = pc(st.lift); o[`z${Y}/${Z}`] = f1(st.z); o[`yrs${Y}/${Z}`] = st.yrs; });
    return o;
  };
  // E1 run distribution
  const E1 = [];
  const share = (R, lo, hi) => pc(R.filter(r => r.size >= lo && r.size < hi).length / R.length);
  const distRow = (k, R) => ({ ...k, runs: R.length, perDay: f1(R.length / new Set(R.map(r => r.date)).size), p50: f1(pctl(R.map(r => r.size), 0.5)), p75: f1(pctl(R.map(r => r.size), 0.75)), p90: f1(pctl(R.map(r => r.size), 0.9)), p95: f1(pctl(R.map(r => r.size), 0.95)), '<40': share(R, 0, 40), '40-80': share(R, 40, 80), '80-120': share(R, 80, 120), '120+': share(R, 120, Infinity), medDurMin: f1(pctl(R.map(r => r.dur), 0.5)) });
  for (const th of E_THETAS) {
    const R = runs.filter(r => r.th === th && r.done);
    E1.push(distRow({ theta: th, slice: 'all' }, R));
    for (const y of ['2023', '2024', '2025', '2026']) E1.push(distRow({ theta: th, slice: y }, R.filter(r => r.year === y)));
    for (const t of ['09:30-10:00', '10:00-11:00', '11:00-14:00', '14:00-15:00', '15:00-16:00']) E1.push(distRow({ theta: th, slice: 'end ' + t }, R.filter(r => TOD5(r.endB30) === t)));
    for (const v of ['lowIV', 'midIV', 'highIV']) E1.push(distRow({ theta: th, slice: v }, R.filter(r => ivT(r.iv) === v)));
  }
  writeCsv('E1_run_sizes.csv', E1);
  // E2 hazard by X
  const E2 = [];
  for (const th of E_THETAS) for (const X of E_XS) E2.push(row({ theta: th, X }, events.filter(e => e.th === th && e.X === X)));
  writeCsv('E2_hazard_by_X.csv', E2);
  // E3 splits (theta 20)
  const ev20 = events.filter(e => e.th === 20);
  const confB = (c) => c == null ? 'na' : c >= 3 ? '3+' : String(c);
  const nbB = (x) => x === Infinity ? 'none' : x < 25 ? '<25' : x < 50 ? '25-50' : '50+';
  const spT = {}; for (const X of E_XS) { const sp = Float64Array.from(ev20.filter(e => e.X === X).map(e => e.speed)).sort(); spT[X] = [sp[Math.floor(sp.length / 3)], sp[Math.floor(2 * sp.length / 3)]]; }
  const spB = (e) => e.speed < spT[e.X][0] ? 'slow' : e.speed < spT[e.X][1] ? 'mid' : 'fast';
  const SPLITS = {
    conf: e => confB(e.conf), touch: e => e.touchAny ? (e.touch60 ? 'tag60' : e.touch15 ? 'tag15' : 'tag5only') : 'none',
    nextLine: e => nbB(e.nextBeyond), vs60m: e => e.t60rel, tod: e => TOD5(e.b30), iv: e => ivT(e.iv), speed: spB, mom: e => e.mom >= 4 ? 'mom4-5' : e.mom >= 2 ? 'mom2-3' : 'mom0-1',
  };
  const E3 = [];
  for (const X of E_XS) {
    const LX = ev20.filter(e => e.X === X);
    for (const [nm, fn] of Object.entries(SPLITS)) {
      const vals = [...new Set(LX.map(fn))].sort();
      for (const v of vals) { const LL = LX.filter(e => fn(e) === v); if (LL.length >= 30 && v !== 'na') E3.push(row({ X, split: nm, value: v }, LL)); }
    }
  }
  writeCsv('E3_hazard_splits.csv', E3);
  // speed -> eventual run size: of runs that reached 40, which reach 80/120, by speed tercile at the 40 crossing
  const E4 = [];
  const runMaxOf = new Map(); // event identity via (date, th, dir, origin time) -> max X reached
  for (const e of ev20) { const k = `${e.date}|${e.dir}|${e.j - e.dur + 1}`; runMaxOf.set(k, Math.max(runMaxOf.get(k) || 0, e.X)); }
  for (const sp of ['slow', 'mid', 'fast']) for (const m of ['mom0-1', 'mom2-3', 'mom4-5', 'any']) {
    const L = ev20.filter(e => e.X === 40 && spB(e) === sp && (m === 'any' || SPLITS.mom(e) === m)); if (L.length < 30) continue;
    const mx = L.map(e => runMaxOf.get(`${e.date}|${e.dir}|${e.j - e.dur + 1}`));
    E4.push({ speedAt40: sp, momAt40: m, n: L.length, medMinTo40: f1(pctl(L.map(e => e.dur), 0.5)), 'reach60': pc(mx.filter(x => x >= 60).length / L.length), 'reach80': pc(mx.filter(x => x >= 80).length / L.length), 'reach120': pc(mx.filter(x => x >= 120).length / L.length) });
  }
  writeCsv('E4_speed_vs_run_size.csv', E4);
  // E5 compound rules
  const E5 = [];
  const RULES = [
    ['X40-60 (all)', e => e.X <= 60],
    ['X40-60 & touch any band', e => e.X <= 60 && e.touchAny],
    ['X40-60 & conf>=2', e => e.X <= 60 && e.conf >= 2],
    ['X40-60 & touch & conf>=2', e => e.X <= 60 && e.touchAny && e.conf >= 2],
    ['X40-60 & touch15/60 & conf>=2', e => e.X <= 60 && (e.touch15 || e.touch60) && e.conf >= 2],
    ['X40-60 & touch & conf>=2 & against60m', e => e.X <= 60 && e.touchAny && e.conf >= 2 && e.t60rel === 'against'],
    ['X40-60 & touch & conf>=2 & slow', e => e.X <= 60 && e.touchAny && e.conf >= 2 && spB(e) === 'slow'],
    ['X40-60 & no touch & conf 0', e => e.X <= 60 && !e.touchAny && e.conf === 0],
    ['X80-120 & touch & conf>=2', e => e.X >= 80 && e.touchAny && e.conf >= 2],
    ['X80-120 (all)', e => e.X >= 80],
  ];
  for (const [nm, fn] of RULES) E5.push(row({ rule: nm }, ev20.filter(fn)));
  writeCsv('E5_compound_rules.csv', E5);

  const pick = (rows, cols) => rows.map(r => Object.fromEntries(cols.map(c => [c, r[c]])));
  const md = [];
  md.push(`## E. Swing structure and the hazard of a run ending (follow-up, 2026-10-17)\n`);
  md.push(`Run with \`--only E\`. Zigzag on the 1m RTH path in pts@${REF} (each day multiplied by ${REF}/first open); thresholds theta = 15/20/25. Runs reset at 09:30, and the day's last unfinished run is excluded from E1. The zigzag runs on 1m CLOSES (theta = a close-to-close retrace). A hazard EVENT fires at the 1m close where a live run (measured from its last zigzag pivot close) first reaches X. Outcome: from the next bar, does the intrabar path come back Y from that close (REVERSAL) before going Z beyond it (EXTENSION)? Confluence and touch use the run's wick extreme. A same-minute tie counts as extension. Placebo = the same outcome at every RTH minute, matched on year x 30-min bucket x direction x IV tercile (IV terciles cut at ${f3(q1)} / ${f3(q2)}). Confluence = number of 5/15/60m upper/lower/mid/9EMA lines within +/-${E_CONF_R} pts of the extreme (in /NQ space via the 1m basis). Touch = the extreme within ${E_TOUCH_TOL} pts of (or beyond) that timeframe's band in the run direction. Days: ${nDays1} NQ-proxy + ${nDays2} NDX 2026. z is day-clustered; yrs = sign of the lift in 2023/24/25/26.\n`);
  md.push(`### E1 run (swing) sizes\n`);
  md.push(mdTable(E1.filter(r => r.slice === 'all' || r.theta === 20)) + '\n');
  md.push(`\n### E2 hazard by run size reached (P reversal-first; lift vs placebo)\n`);
  md.push(mdTable(pick(E2, ['theta', 'X', 'n', 'days', 'rev25/ext20', 'base25/20', 'lift25/20', 'z25/20', 'yrs25/20', 'rev40/ext40', 'base40/40', 'lift40/40', 'z40/40', 'yrs40/40'])) + '\n');
  md.push(`\n### E3 splits, theta=20 (X = 40, 60, 80)\n`);
  md.push(mdTable(pick(E3.filter(r => r.X <= 80), ['X', 'split', 'value', 'n', 'days', 'rev25/ext20', 'lift25/20', 'z25/20', 'yrs25/20', 'rev40/ext40', 'lift40/40', 'z40/40', 'yrs40/40'])) + '\n');
  md.push(`\n### E4 speed/momentum at the 40-pt mark vs how far the run eventually goes (theta=20)\n`);
  md.push(mdTable(E4) + '\n');
  md.push(`\n### E5 compound rules (theta=20)\n`);
  md.push(mdTable(pick(E5, ['rule', 'n', 'days', 'rev25/ext20', 'base25/20', 'lift25/20', 'z25/20', 'yrs25/20', 'rev40/ext40', 'base40/40', 'lift40/40', 'z40/40', 'yrs40/40', 'lift25/40', 'z25/40', 'lift40/20', 'z40/20'])) + '\n');
  const sp = path.join(OUT, 'summary.md');
  let cur = fs.existsSync(sp) ? fs.readFileSync(sp, 'utf8') : '';
  const ix = cur.indexOf('\n## E. '); if (ix >= 0) cur = cur.slice(0, ix);
  fs.writeFileSync(sp, cur.trimEnd() + '\n\n' + md.join('\n'));
}

(function main() {
  const t0 = Date.now();
  const log = (...a) => console.error(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);
  log('loading NQ csv', CSV);
  const nq = loadCsv(CSV);
  log('NQ csv bars', nq.length, dateOf(nq[0].datetime), '..', dateOf(nq.at(-1).datetime));
  const nqRaw = loadRaw('NQ'), ndxRaw = loadRaw('NDX');
  log('raw 2026: NQ', nqRaw.length, 'NDX', ndxRaw.length);

  const ndxDays = priceDays(ndxRaw, '2026-01-01', '2026-12-31');
  const REF = Math.round(mean([...ndxDays.values()].map(d => d.c[389])));
  log('REF (mean 2026 NDX close)', REF, 'NDX days', ndxDays.size);

  const S1 = buildSignal(nq);
  const days1 = priceDays(nq, '2023-01-01', '2025-12-31');
  log('NQ proxy days', days1.size);
  if (argv.includes('--only') && arg('--only') === 'E') {
    const S2e = buildSignal(nqRaw);
    const nqRawDaysE = priceDays(nqRaw, '2026-01-01', '2026-12-31');
    const ndxSigE = new Map([...ndxDays].filter(([d]) => nqRawDaysE.has(d)));
    const E1 = runE(S1, days1, REF); log('E dataset 1 done');
    const E2 = runE(S2e, ndxSigE, REF); log('E dataset 2 done');
    reportE([E1, E2], REF, days1.size, ndxSigE.size);
    log('wrote section E');
    return;
  }
  const R1 = runDataset('NQ-proxy 2023-25', S1, days1, REF);
  log('dataset 1 done');
  const S2 = buildSignal(nqRaw);
  const nqRawDays = priceDays(nqRaw, '2026-01-01', '2026-12-31');
  const ndxWithSig = new Map([...ndxDays].filter(([d]) => nqRawDays.has(d)));
  const R2 = runDataset('NDX 2026 (NQ signals)', S2, ndxWithSig, REF);
  const R2all = runDataset('NDX 2026 all days', S2, ndxDays, REF, { sigOnly: true }); // A only (trend null pre-07-20)
  const R2nq = runDataset('NQ 2026 same days', S2, new Map([...nqRawDays].filter(([d]) => ndxWithSig.has(d))), REF, { sigOnly: true });
  log('dataset 2 done; NDX days w/ signals', ndxWithSig.size);

  const md = [];
  md.push(`# Fast moves, reversals, continuation — v12 sizing study (2026-10-17)\n`);
  md.push(`Script: \`scripts/candle-spread/study-fast-moves-reversals.js\`. Signals /NQ 24h; outcomes NQ RTH 1m (2023-01-03..2025-12-11, ${days1.size} full days, PROXY) and cash NDX 1m (2026, ${ndxWithSig.size} days with NQ signals; ${ndxDays.size} NDX days in A). Thresholds in **pts@${REF}** (pts x ${REF}/price — today's NDX level) unless marked raw. Overlapping windows: rates are per decision minute/bar, not independent trials; lift SEs are day-clustered.\n`);

  // ===================== A =====================
  const Arows = (R, tag, yearOverride) => R.A.map(r => ({ ...r, ds: tag, year: yearOverride || r.year }));
  const allA = [...Arows(R1, 'NQ'), ...Arows(R2all, 'NDX26')];
  // A1: per year, raw + scaled
  const A1 = [];
  const groups = [['2023', R1.A.filter(r => r.year === '2023')], ['2024', R1.A.filter(r => r.year === '2024')], ['2025', R1.A.filter(r => r.year === '2025')], ['NQ 2023-25', R1.A], ['NDX 2026', R2all.A], ['POOLED', [...R1.A, ...R2all.A]]];
  for (const [g, rows] of groups) for (const T of TS) {
    const v = rows.filter(r => r.up[T] != null);
    const mxRaw = v.map(r => Math.max(r.up[T], r.dn[T]));
    const mxSc = v.map(r => Math.max(r.up[T], r.dn[T]) * REF / r.P);
    const z = v.filter(r => r.sig1).map(r => Math.max(r.up[T], r.dn[T]) / (r.sig1 * Math.sqrt(T)));
    const row = { group: g, T, n: v.length, meanP: Math.round(mean(v.map(r => r.P))) };
    for (const X of XS) { row[`raw>=${X}`] = pc(mxRaw.filter(x => x >= X).length / v.length); }
    for (const X of XS) { row[`ref>=${X}`] = pc(mxSc.filter(x => x >= X).length / v.length); }
    row.p50ref = f1(pctl(mxSc, 0.5)); row.p95ref = f1(pctl(mxSc, 0.95)); row.p99ref = f1(pctl(mxSc, 0.99)); row.p999ref = f1(pctl(mxSc, 0.999));
    row['z>=2'] = pc(z.filter(x => x >= 2).length / z.length); row['z>=3'] = pc(z.filter(x => x >= 3).length / z.length); row['z>=4'] = pc(z.filter(x => x >= 4).length / z.length);
    row.p99z = f3(pctl(z, 0.99));
    A1.push(row);
  }
  writeCsv('A1_excursion_by_year.csv', A1);
  // day-level: share of days with >=1 move >=X in T
  const A1d = [];
  for (const [g, rows] of groups) for (const T of [1, 5, 15]) {
    const byDay = new Map();
    for (const r of rows) { if (r.up[T] == null) continue; const v = Math.max(r.up[T], r.dn[T]) * REF / r.P; byDay.set(r.date, Math.max(byDay.get(r.date) || 0, v)); }
    const vals = [...byDay.values()];
    const row = { group: g, T, days: vals.length };
    for (const X of XS) row[`days>=${X}ref`] = pc(vals.filter(x => x >= X).length / vals.length);
    A1d.push(row);
  }
  writeCsv('A1_days_with_move.csv', A1d);

  // A2: jump budget, pooled (NQ proxy + NDX26), scaled pts. Trend defs t15, t60, both. "with" = move in the trend direction.
  const A2 = [];
  const pooledA = [...R1.A, ...R2all.A];
  const stateOf = (r, def) => def === 't15' ? r.t15 : def === 't60' ? r.t60 : (r.t15 != null && r.t15 === r.t60 ? r.t15 : (r.t15 == null || r.t60 == null ? null : 0));
  for (const def of ['both', 't15', 't60']) {
    for (const todKey of ['all', ...Array.from({ length: 13 }, (_, i) => i), ...['09:30-10:00', '10:00-11:00', '11:00-14:00', '14:00-15:00', '15:00-16:00'].map(s => 'G' + s)]) {
      const rowsTod = pooledA.filter(r => todKey === 'all' ? true : typeof todKey === 'number' ? r.b30 === todKey : ('G' + TOD5(r.b30)) === todKey);
      for (const st of ['trend', 'mixed']) {
        const rs = rowsTod.filter(r => { const s = stateOf(r, def); return st === 'trend' ? (s === 1 || s === -1) : s === 0; });
        for (const T of TS) {
          const v = rs.filter(r => r.up[T] != null);
          if (!v.length) continue;
          const sc = (r) => REF / r.P;
          // mixed state: with = UP move, ctr = DOWN move (one-sided, comparable to the trend rows)
          const withM = v.map(r => (stateOf(r, def) === -1 ? r.dn[T] : r.up[T]) * sc(r));
          const ctrM = v.map(r => (stateOf(r, def) === -1 ? r.up[T] : r.dn[T]) * sc(r));
          const row = { trendDef: def, tod: typeof todKey === 'number' ? B30(todKey) : todKey, state: st, T, n: v.length };
          for (const X of [25, 50, 75, 100, 150]) { row[`with>=${X}`] = pc(withM.filter(x => x >= X).length / v.length); row[`ctr>=${X}`] = pc(ctrM.filter(x => x >= X).length / v.length); }
          row.with_p95 = f1(pctl(withM, 0.95)); row.with_p99 = f1(pctl(withM, 0.99)); row.ctr_p95 = f1(pctl(ctrM, 0.95)); row.ctr_p99 = f1(pctl(ctrM, 0.99));
          A2.push(row);
        }
      }
    }
  }
  writeCsv('A2_jump_budget.csv', A2);
  // A3: after reversal signal vs not (pooled datasets with signals)
  const A3 = [];
  for (const rev of [0, 1]) for (const T of [5, 15, 30]) {
    const v = [...R1.A, ...R2.A].filter(r => r.rev === rev && r.up[T] != null);
    const m = v.map(r => Math.max(r.up[T], r.dn[T]) * REF / r.P);
    A3.push({ afterRevSignal15m: rev, T, n: v.length, 'any>=25': pc(m.filter(x => x >= 25).length / v.length), 'any>=50': pc(m.filter(x => x >= 50).length / v.length), 'any>=100': pc(m.filter(x => x >= 100).length / v.length), p95: f1(pctl(m, 0.95)), p99: f1(pctl(m, 0.99)) });
  }
  writeCsv('A3_after_reversal_signal.csv', A3);
  // A4: jump reversals
  const A4 = [];
  const J = [...R1.jumps, ...R2all.jumps];
  for (const [g, js] of [['ALL', J], ['NQ 2023-25', R1.jumps], ['NDX 2026', R2all.jumps], ['size 50-75', J.filter(j => j.size < 75)], ['size 75-100', J.filter(j => j.size >= 75 && j.size < 100)], ['size >=100', J.filter(j => j.size >= 100)], ['09:30-10:00', J.filter(j => j.b30 === 0)], ['10:00-16:00', J.filter(j => j.b30 > 0)], ['with 15m trend', J.filter(j => j.t15 === j.d)], ['against 15m trend', J.filter(j => j.t15 === -j.d)], ['up', J.filter(j => j.d > 0)], ['down', J.filter(j => j.d < 0)]]) {
    if (!js.length) continue;
    A4.push({ group: g, n: js.length, perDay: f3(js.length / (new Set(js.map(j => j.date)).size)), days: new Set(js.map(j => j.date)).size, medSize: f1(pctl(js.map(j => j.size), 0.5)), full5: pc(mean(js.map(j => j.full[5]))), full15: pc(mean(js.map(j => j.full[15]))), full30: pc(mean(js.map(j => j.full[30]))), half5: pc(mean(js.map(j => j.half[5]))), half15: pc(mean(js.map(j => j.half[15]))), half30: pc(mean(js.map(j => j.half[30]))) });
  }
  writeCsv('A4_jump_reversals.csv', A4);
  // A5: validation 2026 NDX vs NQ same days (raw pts) + NQ 2025 scaled
  const A5 = [];
  const sameDays = new Set(R2nq.A.map(r => r.date));
  for (const [g, rows, scaled] of [['NDX 2026 raw', R2all.A.filter(r => sameDays.has(r.date)), false], ['NQ 2026 raw (same days)', R2nq.A, false], ['NQ 2025 pts@REF', R1.A.filter(r => r.year === '2025'), true], ['NQ 2023-25 pts@REF', R1.A, true]]) for (const T of [1, 5, 15, 30]) {
    const v = rows.filter(r => r.up[T] != null); const m = v.map(r => Math.max(r.up[T], r.dn[T]) * (scaled ? REF / r.P : 1));
    const z = v.filter(r => r.sig1).map(r => Math.max(r.up[T], r.dn[T]) / (r.sig1 * Math.sqrt(T)));
    A5.push({ series: g, T, n: v.length, '>=25': pc(m.filter(x => x >= 25).length / v.length), '>=50': pc(m.filter(x => x >= 50).length / v.length), '>=100': pc(m.filter(x => x >= 100).length / v.length), p50: f1(pctl(m, 0.5)), p95: f1(pctl(m, 0.95)), p99: f1(pctl(m, 0.99)), 'z>=3': pc(z.filter(x => x >= 3).length / z.length) });
  }
  writeCsv('A5_validation_2026.csv', A5);

  // ===================== B =====================
  const recs = [...R1.B.map(r => ({ ...r, ds: 'NQ' })), ...R2.B.map(r => ({ ...r, ds: 'NDX26' }))];
  // baseline cells: year|p|b30|t60|dir over ALL decision bars
  const cell = new Map();
  const cellKey = (r, d) => `${r.year}|${r.p}|${r.b30}|${r.t60}|${d}`;
  for (const r of recs) for (const d of [1, -1]) {
    const k = cellKey(r, d); let c = cell.get(k); if (!c) { c = { n: 0 }; for (const m of OUT_KEYS) { c[m] = 0; c['n_' + m] = 0; } cell.set(k, c); }
    c.n++; for (const m of OUT_KEYS) { const x = r.out[d][m]; if (!Number.isNaN(x)) { c[m] += x; c['n_' + m]++; } }
  }
  const base = (r, d, m) => { const c = cell.get(cellKey(r, d)); return c['n_' + m] ? c[m] / c['n_' + m] : NaN; };
  const sigs = [];
  for (const r of recs) for (const x of (r.dets || [])) sigs.push({ r, ...x, t60rel: r.t60 == null ? 'na' : r.t60 === x.dir ? 'with' : r.t60 === -x.dir ? 'against' : 'neutral', tod: tod3(r.b30) });
  const METRICS = ['w25_25', 'w50_25', 'w50_50', 'w100_50', 'w25_25_60', 'mv30', 'mvClose', 'mfe30', 'mae30', 'probe'];
  function summarize(list) {
    const o = { n: list.length, days: new Set(list.map(s => s.r.ds + s.r.date)).size };
    for (const m of METRICS) {
      const v = list.filter(s => !Number.isNaN(s.r.out[s.dir][m]));
      const sig = mean(v.map(s => s.r.out[s.dir][m])), bs = mean(v.map(s => base(s.r, s.dir, m)));
      o[m] = sig; o['b_' + m] = bs; o['lift_' + m] = sig - bs;
      // day-clustered SE of the lift
      const byDay = new Map();
      for (const s of v) { const k = s.r.ds + s.r.date; byDay.set(k, (byDay.get(k) || 0) + (s.r.out[s.dir][m] - base(s.r, s.dir, m)) - (sig - bs)); }
      o['se_' + m] = Math.sqrt([...byDay.values()].reduce((a, x) => a + x * x, 0)) / (v.length || 1);
    }
    o.yrsPos = ['2023', '2024', '2025', '2026'].map(y => { const v = list.filter(s => s.r.year === y); if (v.length < 20) return '.'; const l = mean(v.map(s => s.r.out[s.dir].w50_25 - base(s.r, s.dir, 'w50_25'))); return l > 0 ? '+' : '-'; }).join('');
    return o;
  }
  const fmtRow = (key, o) => ({ ...key, n: o.n, days: o.days, 'P50/25': pc(o.w50_25), 'base': pc(o.b_w50_25), 'lift50/25': pc(o.lift_w50_25), 'se': pc(o.se_w50_25), 'z': f1(o.lift_w50_25 / o.se_w50_25), 'P25/25': pc(o.w25_25), 'lift25/25': pc(o.lift_w25_25), 'lift25/25@60m': pc(o.lift_w25_25_60), 'lift50/50': pc(o.lift_w50_50), 'lift100/50': pc(o.lift_w100_50), 'mv30': f1(o.mv30), 'b_mv30': f1(o.b_mv30), 'mvClose': f1(o.mvClose), 'b_mvClose': f1(o.b_mvClose), 'mfe30': f1(o.mfe30), 'mae30': f1(o.mae30), 'probe': pc(o.probe), 'b_probe': pc(o.b_probe), 'yrs+(23-26)': o.yrsPos });
  const dets = [...new Set(sigs.map(s => s.det))];
  const B1 = [], B2 = [];
  for (const p of [5, 15]) for (const det of dets) {
    const L = sigs.filter(s => s.r.p === p && s.det === det); if (L.length < 30) continue;
    B1.push(fmtRow({ tf: p + 'm', det }, summarize(L)));
    for (const dir of [1, -1]) for (const lvl of [true, false]) for (const rel of ['with', 'against', 'neutral']) for (const tod of ['09:30-10:30', '10:30-14:00', '14:00-16:00', 'all']) {
      const LL = L.filter(s => s.dir === dir && s.lvl === lvl && s.t60rel === rel && (tod === 'all' || s.tod === tod)); if (LL.length < 30) continue;
      B2.push(fmtRow({ tf: p + 'm', det, dir: dir > 0 ? 'bull' : 'bear', atLevel: lvl ? 'Y' : 'N', vs60m: rel, tod }, summarize(LL)));
    }
    for (const lvl of [true, false]) { const LL = L.filter(s => s.lvl === lvl); if (LL.length >= 30) B2.push(fmtRow({ tf: p + 'm', det, dir: 'both', atLevel: lvl ? 'Y' : 'N', vs60m: 'any', tod: 'all' }, summarize(LL))); }
    for (const rel of ['with', 'against', 'neutral']) { const LL = L.filter(s => s.t60rel === rel); if (LL.length >= 30) B2.push(fmtRow({ tf: p + 'm', det, dir: 'both', atLevel: 'any', vs60m: rel, tod: 'all' }, summarize(LL))); }
    for (const dir of [1, -1]) { const LL = L.filter(s => s.dir === dir); if (LL.length >= 30) B2.push(fmtRow({ tf: p + 'm', det, dir: dir > 0 ? 'bull' : 'bear', atLevel: 'any', vs60m: 'any', tod: 'all' }, summarize(LL))); }
  }
  // unconditional drift reference: every decision bar, by direction
  const drift = [];
  for (const p of [5, 15]) for (const d of [1, -1]) {
    const v = recs.filter(r => r.p === p);
    drift.push({ tf: p + 'm', dir: d > 0 ? 'bull' : 'bear', n: v.length, 'P50/25': pc(mean(v.map(r => r.out[d].w50_25))), 'P25/25': pc(mean(v.map(r => r.out[d].w25_25))), mv30: f1(mean(v.map(r => r.out[d].mv30))), mvClose: f1(mean(v.map(r => r.out[d].mvClose))), probe: pc(mean(v.map(r => r.out[d].probe).filter(x => !Number.isNaN(x)))) });
  }
  writeCsv('B0_drift_reference.csv', drift);
  writeCsv('B1_reversal_signals.csv', B1);
  writeCsv('B2_reversal_contexts.csv', B2);

  // ===================== C =====================
  const crecs = recs.filter(r => r.p === 5 && r.C);
  const cbase = new Map(); // all 5m bars, year|b30|dir drift baseline
  for (const r of recs.filter(r => r.p === 5)) for (const d of [1, -1]) { const k = `${r.year}|${r.b30}|${d}`; const c = cbase.get(k) || { n: 0, a: 0, b: 0 }; c.n++; c.a += r.out[d].w25_25; c.b += r.out[d].w50_25; cbase.set(k, c); }
  const cb = (r, m) => { const c = cbase.get(`${r.year}|${r.b30}|${r.C.dir}`); return m === 'a' ? c.a / c.n : c.b / c.n; };
  const sinceB = (s) => s < 30 ? '<30m' : s < 90 ? '30-90m' : s < 180 ? '90-180m' : '>=180m';
  const pBB = (x) => x == null ? 'na' : x < 0.5 ? '<0.5' : x < 0.8 ? '0.5-0.8' : x <= 1.0 ? '0.8-1.0' : '>1.0';
  const csum = (key, L) => {
    const a = mean(L.map(r => r.out[r.C.dir].w25_25)), b = mean(L.map(r => r.out[r.C.dir].w50_25));
    const ba = mean(L.map(r => cb(r, 'a'))), bb = mean(L.map(r => cb(r, 'b')));
    const yrs = ['2023', '2024', '2025', '2026'].map(y => { const v = L.filter(r => r.year === y); if (v.length < 20) return '.'; return mean(v.map(r => r.out[r.C.dir].w50_25 - cb(r, 'b'))) > 0 ? '+' : '-'; }).join('');
    const byDay = new Map();
    for (const r of L) { const k = r.ds + r.date; byDay.set(k, (byDay.get(k) || 0) + (r.out[r.C.dir].w50_25 - cb(r, 'b')) - (b - bb)); }
    const se = Math.sqrt([...byDay.values()].reduce((s, x) => s + x * x, 0)) / (L.length || 1);
    return { ...key, n: L.length, days: new Set(L.map(r => r.ds + r.date)).size, 'P25/25': pc(a), 'drift25/25': pc(ba), 'lift25/25': pc(a - ba), 'P50/25': pc(b), 'drift50/25': pc(bb), 'lift50/25': pc(b - bb), 'z50/25': f1((b - bb) / se), mv30: f1(mean(L.map(r => r.out[r.C.dir].mv30))), mae30: f1(mean(L.map(r => r.out[r.C.dir].mae30))), 'yrs+': yrs };
  };
  const C1 = [];
  C1.push(csum({ slice: 'ALL in 15m trend', cnt: 'any', since: 'any', pB: 'any', dir: 'both' }, crecs));
  for (const cnt of [0, 1, 2, 3]) {
    const L = crecs.filter(r => r.C.cnt === cnt);
    C1.push(csum({ slice: 'by count', cnt, since: 'any', pB: 'any', dir: 'both' }, L));
    for (const dir of [1, -1]) C1.push(csum({ slice: 'count x dir', cnt, since: 'any', pB: 'any', dir: dir > 0 ? 'bull' : 'bear' }, L.filter(r => r.C.dir === dir)));
    for (const s of ['<30m', '30-90m', '90-180m', '>=180m']) { const LL = L.filter(r => sinceB(r.C.since) === s); if (LL.length >= 30) C1.push(csum({ slice: 'count x since', cnt, since: s, pB: 'any', dir: 'both' }, LL)); }
    for (const b of ['<0.5', '0.5-0.8', '0.8-1.0', '>1.0']) { const LL = L.filter(r => pBB(r.C.pB) === b); if (LL.length >= 30) C1.push(csum({ slice: 'count x %B60', cnt, since: 'any', pB: b, dir: 'both' }, LL)); }
  }
  for (const b of ['<0.5', '0.5-0.8', '0.8-1.0', '>1.0']) C1.push(csum({ slice: 'by %B60', cnt: 'any', since: 'any', pB: b, dir: 'both' }, crecs.filter(r => pBB(r.C.pB) === b)));
  for (const s of ['<30m', '30-90m', '90-180m', '>=180m']) C1.push(csum({ slice: 'by since', cnt: 'any', since: s, pB: 'any', dir: 'both' }, crecs.filter(r => sinceB(r.C.since) === s)));
  writeCsv('C1_continuation.csv', C1);

  // ===================== summary.md =====================
  const pick = (rows, cols) => rows.map(r => Object.fromEntries(cols.map(c => [c, r[c]])));
  md.push(`## A. Fast moves\n\n### A1 max |excursion| within T (either direction), per decision minute, RTH\n`);
  md.push(mdTable(pick(A1.filter(r => [1, 5, 15, 30].includes(r.T)), ['group', 'T', 'n', 'meanP', 'raw>=50', 'raw>=100', 'ref>=25', 'ref>=50', 'ref>=75', 'ref>=100', 'ref>=150', 'p50ref', 'p95ref', 'p99ref', 'p999ref', 'z>=3', 'p99z'])) + '\n');
  md.push(`\n### A1d share of DAYS with at least one move >= X (pts@REF) within T\n`);
  md.push(mdTable(A1d) + '\n');
  md.push(`\n### A2 jump budget (pooled NQ-proxy + NDX26, pts@REF), trend = 15m AND 60m structural agree. with = move in the trend direction (hurts risk held AGAINST the trend); ctr = against it. For state=mixed, with = UP move, ctr = DOWN move\n`);
  md.push(mdTable(pick(A2.filter(r => r.trendDef === 'both' && r.tod.startsWith('G') && [5, 15].includes(r.T)), ['tod', 'state', 'T', 'n', 'with>=50', 'with>=100', 'ctr>=50', 'ctr>=100', 'with_p95', 'with_p99', 'ctr_p95', 'ctr_p99'])) + '\n');
  md.push(`\n### A3 after a reversal signal (bbCloseBackIn / trendFlip15 / flip5+15 / v7-grind / engulf, 5m or 15m, within prior 15 min) vs not\n`);
  md.push(mdTable(A3) + '\n');
  md.push(`\n### A4 jumps >= 50 pts@REF within 5 min (deduped episodes): how often fully / half retraced within N min of the extreme\n`);
  md.push(mdTable(A4) + '\n');
  md.push(`\n### A5 validation: 2026 NDX vs NQ on the same days (raw pts), and NQ proxy at pts@REF\n`);
  md.push(mdTable(A5) + '\n');
  md.push(`\n## B. Reversal signals (lift vs matched baseline = all decision bars, same year x tf x 30-min bucket x 60m trend x direction; drift already in the baseline)\n\nP50/25 = reaches +50 pts@REF in the signal direction before -25, to the close. probe = next same-TF candle extends the old extreme first.\n\n### B0 drift reference (every decision bar)\n`);
  md.push(mdTable(drift) + '\n');
  md.push(`\n### B1 per detector\n`);
  md.push(mdTable(pick(B1, ['tf', 'det', 'n', 'days', 'P50/25', 'base', 'lift50/25', 'z', 'lift25/25', 'lift25/25@60m', 'lift100/50', 'mv30', 'b_mv30', 'mae30', 'probe', 'b_probe', 'yrs+(23-26)'])) + '\n');
  const B2top = B2.filter(r => r.tod === 'all' && r.n >= 100).sort((a, b) => (+b.z) - (+a.z));
  md.push(`\n### B2 contexts (tod=all, n>=100), top 15 and bottom 8 by z of lift50/25\n`);
  md.push(mdTable(pick([...B2top.slice(0, 15), ...B2top.slice(-8)], ['tf', 'det', 'dir', 'atLevel', 'vs60m', 'n', 'days', 'P50/25', 'base', 'lift50/25', 'z', 'lift25/25', 'mv30', 'probe', 'yrs+(23-26)'])) + '\n');
  md.push(`\n## C. Continuation (5m decisions while the 15m structural trend is set; confirmations = 5/15/60m last bar closed beyond the prior bar's extreme AND beyond its 9EMA in the trend direction)\n`);
  md.push(mdTable(C1.filter(r => ['ALL in 15m trend', 'by count', 'by since', 'by %B60'].includes(r.slice))) + '\n');
  md.push(`\n### C count x since / count x %B60\n`);
  md.push(mdTable(C1.filter(r => ['count x since', 'count x %B60'].includes(r.slice))) + '\n');
  fs.writeFileSync(path.join(OUT, 'summary.md'), md.join('\n'));
  log('wrote', OUT);
})();
