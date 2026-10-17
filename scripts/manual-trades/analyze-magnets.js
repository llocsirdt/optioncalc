#!/usr/bin/env node
'use strict';
/**
 * PHASE 6 of the manual-trades study: LEVELS AS DIRECTION MAGNETS.
 *
 * User clarification after phase 5: the levels (prior NDX close, open, 15m/60m 9EMA, BB mid and bands; NQ-24h and
 * NDX-RTH versions) were NOT strike locations. They were DIRECTION MAGNETS: strikes were placed relative to SPOT and
 * the book's risk/reward was biased toward the side where the levels sat. Phases 4/5 tested "strike at level"; this
 * tests "bias toward level".
 *
 *   node scripts/manual-trades/analyze-magnets.js [--out data/manual-trades/analysis] [--nq <NQ 1m csv>] [--draws 200]
 *        [--from 2023-01-01] [--to 2025-09-30]
 *
 * Part A (the user's 55 days, 724 book orders): per order the order bias (phase-5 orderDir) and the book bias after
 *   the order (phase-4 target side), signed distance spot→level (pts, σ), agreement vs three nulls, trend control
 *   (close vs 9EMA), which level wins when levels disagree (rules + ridge logistic, day-bootstrap), outcomes
 *   (touch / settle closer / P&L toward vs away), strike offsets vs the magnet distance.
 * Part B (unconditional, every RTH day in --from..--to): at 10:00 … 14:00 for each level, P(touch before 16:00) and
 *   P(settle closer to it) vs a symmetric placebo level (same distance, other side of spot), by σ-distance, trend
 *   (with/against 15m and 60m close-vs-9EMA), time and gap. The drift-neutral edge averages level-above and
 *   level-below cases so the 2023-25 up-drift cancels.
 *
 * Writes <out>/magnets-report.md, mg-orders.csv, mg-agreement.csv, mg-strikes.csv, mg-market-cube.csv, mg-market-levels.csv.
 * Never prints account identifiers (only dates / order numbers / numbers derived from fills and prices).
 *
 * DERIVED / ESTIMATES (flagged in the report):
 *   - NDX-RTH 1m = /NQ (back-adjusted) RTH 1m − that day's basis (NQ 16:00 close − official NDX close; basis.json
 *     on trade days). ±10-30 pt intraday noise vs real NDX, pinned at 16:00. NQ-24h lines are shifted by the same basis.
 *   - NDX-RTH 15m/60m lines are RTH-only (overnight gap kept), 60m anchored 09:30. Lines from COMPLETED candles only.
 *   - Part B σ = S × ivFromRelBandWidth(NQ 15m band width / close) × √τ (the engine's proxy; no intraday IV
 *     multiplier). Part A σ = orders.json sigmaPts (fit to the user's own fills).
 *   - Part A same machinery as analyze-levels-stacking.js (copied: that script runs at load and exports nothing).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const B = require('../../server/src/manual-trades/book');
const H = require('../../server/src/manual-trades/routes').helpers;
const BS = require('../../server/src/candle-spread/bs-pricer');
const IND = require('../../server/src/candle-spread/signals/indicators');

const ROOT = path.join(__dirname, '..', '..');
const DATA = path.join(ROOT, 'data', 'manual-trades');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const OUT = path.resolve(arg('--out', path.join(DATA, 'analysis')));
const NQ_CSV = arg('--nq', path.join(os.homedir(), 'Downloads', 'Dataset_NQ_1min_2022_2025.csv'));
const DRAWS = +arg('--draws', 200);
const FROM = arg('--from', '2023-01-01'), TO = arg('--to', '2025-09-30');
const GAP_SIG = 0.25, NEUTRAL_SIG = 0.25, TOUCH_TOL = 5, AT_SPOT_SIG = 0.05;
const DTIMES = ['10:00', '10:30', '11:00', '12:00', '13:00', '14:00'];

const r0 = n => (n == null || !isFinite(n) ? null : Math.round(n));
const r2 = n => (n == null || !isFinite(n) ? null : Math.round(n * 100) / 100);
const r3 = n => (n == null || !isFinite(n) ? null : Math.round(n * 1000) / 1000);
const fin = x => x != null && isFinite(x);
const sum = a => a.reduce((x, y) => x + (y || 0), 0);
const mean = a => { const s = a.filter(fin); return s.length ? sum(s) / s.length : null; };
const median = a => { const s = a.filter(fin).sort((x, y) => x - y); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const sgn = x => (x > 0 ? 1 : x < 0 ? -1 : 0);
let seed = 98765;
const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const t0 = Date.now();
const log = (...a) => console.error(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

// ── inputs ──────────────────────────────────────────────────────────────────────────────────────────────
const T = JSON.parse(fs.readFileSync(path.join(DATA, 'trades.json'), 'utf8'));
const BASIS = JSON.parse(fs.readFileSync(path.join(DATA, 'market', 'basis.json'), 'utf8')).days || {};
const ORD = new Map(JSON.parse(fs.readFileSync(path.join(DATA, 'analysis', 'orders.json'), 'utf8')).map(o => [`${o.date}|${o.orderNo}`, o]));
const DAYCSV = (() => {
  const L = fs.readFileSync(path.join(DATA, 'analysis', 'days.csv'), 'utf8').trim().split('\n');
  const h = L[0].split(',');
  return new Map(L.slice(1).map(l => { const v = l.split(','); const o = {}; h.forEach((k, i) => { o[k] = v[i]; }); return [o.date, o]; }));
})();
const byNo = new Map();
for (const d of T.days) for (const o of d.orders) byNo.set(o.orderNo, o);

const etDate = ms => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const NDXD = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'sweeps', 'daily-bb-2026-10-15', 'daily-NDX.json'), 'utf8'))
  .map(b => ({ date: etDate(b.datetime + 12 * 3600e3), o: b.open, h: b.high, l: b.low, c: b.close }));
const ndxIdx = new Map(NDXD.map((r, i) => [r.date, i]));

// ── NQ 1m (all hours) from the csv; labels are bar END (ET) ─────────────────────────────────────────────
if (!fs.existsSync(NQ_CSV)) { console.error(`NQ 1m csv not found: ${NQ_CSV} (pass --nq)`); process.exit(1); }
const noonCache = new Map();
const dayBase = iso => { let b = noonCache.get(iso); if (b == null) { b = H.etToMs(iso, '12:00') - 720 * 60e3; noonCache.set(iso, b); } return b; };
const nq = { t: [], o: [], h: [], l: [], c: [] };   // bar START ms
const rthRaw = new Map();                            // iso -> [{m (end minute), o,h,l,c}]
{
  const text = fs.readFileSync(NQ_CSV, 'utf8');
  let pos = 0;
  while (pos < text.length) {
    let nl = text.indexOf('\n', pos); if (nl < 0) nl = text.length;
    const line = text.slice(pos, nl); pos = nl + 1;
    if (!/^\d/.test(line)) continue;
    const sp = line.indexOf(' ');
    const [mo, d, y] = line.slice(0, sp).split('/');
    const iso = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
    const f = line.split(',');
    const [hh, mm] = f[0].slice(sp + 1).split(':').map(Number);
    const m = hh * 60 + mm;
    const o = +f[1], h = +f[2], l = +f[3], c = +f[4];
    nq.t.push(dayBase(iso) + (m - 1) * 60e3); nq.o.push(o); nq.h.push(h); nq.l.push(l); nq.c.push(c);
    if (m >= 571 && m <= 960) { if (!rthRaw.has(iso)) rthRaw.set(iso, []); rthRaw.get(iso).push({ m, o, h, l, c }); }
  }
  for (let i = 1; i < nq.t.length; i++) if (nq.t[i] < nq.t[i - 1]) { console.error('NQ csv not time-sorted at', i); process.exit(1); }
}
log('NQ bars', nq.t.length, 'RTH days', rthRaw.size);

const basisOf = date => {
  if (BASIS[date] && fin(BASIS[date].basis)) return BASIS[date].basis;
  const i = ndxIdx.get(date), bars = rthRaw.get(date);
  if (i == null || !bars) return null;
  const c16 = bars.find(b => b.m === 960);
  return c16 ? c16.c - NDXD[i].c : null;
};
/** Derived NDX RTH 1m bars (t = START ms) + suffix high/low. */
const RTH = new Map();
for (const [iso, raw] of rthRaw) {
  const bs = basisOf(iso);
  if (bs == null || !ndxIdx.has(iso) || raw.length < 300) continue;
  raw.sort((a, b) => a.m - b.m);
  const t930 = H.etToMs(iso, '09:30');
  const bars = raw.map(b => ({ t: t930 + (b.m - 571) * 60e3, o: b.o - bs, h: b.h - bs, l: b.l - bs, c: b.c - bs }));
  const n = bars.length, sufH = new Float64Array(n), sufL = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) { sufH[i] = Math.max(bars[i].h, i < n - 1 ? sufH[i + 1] : -Infinity); sufL[i] = Math.min(bars[i].l, i < n - 1 ? sufL[i + 1] : Infinity); }
  RTH.set(iso, { bars, sufH, sufL, basis: bs, t930, openD: bars[0].o, settle: NDXD[ndxIdx.get(iso)].c });
}
const rthDays = [...RTH.keys()].sort();
log('derived RTH days', rthDays.length);

// ── 15m / 60m series with BB(20,2) + 9EMA ───────────────────────────────────────────────────────────────
function resampleArr(ts, os_, hs, ls, cs, periodMin, offMin) {
  const P = periodMin * 60e3, off = offMin * 60e3, out = [];
  let cur = null;
  for (let i = 0; i < ts.length; i++) {
    const st = Math.floor((ts[i] - off) / P) * P + off;
    if (!cur || cur.datetime !== st) { cur = { datetime: st, open: os_[i], high: hs[i], low: ls[i], close: cs[i] }; out.push(cur); }
    else { if (hs[i] > cur.high) cur.high = hs[i]; if (ls[i] < cur.low) cur.low = ls[i]; cur.close = cs[i]; }
  }
  return out;
}
function mkSeries(cands, endFn) {
  const c = IND.withIndicators(cands).map(x => ({ t: x.datetime, c: x.close, bbU: x.bbUpper, bbM: x.bbMiddle, bbL: x.bbLower, ema9: x.ema9 }));
  const ends = Float64Array.from(cands.map(endFn));
  return { c, ends };
}
function lastDone(ser, ms) { const e = ser.ends; let lo = 0, hi = e.length - 1, ans = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (e[m] <= ms) { ans = m; lo = m + 1; } else hi = m - 1; } return ans; }
const SER = {};
SER.n15m = mkSeries(resampleArr(nq.t, nq.o, nq.h, nq.l, nq.c, 15, 0), x => x.datetime + 15 * 60e3);
SER.n60m = mkSeries(resampleArr(nq.t, nq.o, nq.h, nq.l, nq.c, 60, 0), x => x.datetime + 60 * 60e3);
{
  const a = { t: [], o: [], h: [], l: [], c: [] };
  for (const d of rthDays) for (const b of RTH.get(d).bars) { a.t.push(b.t); a.o.push(b.o); a.h.push(b.h); a.l.push(b.l); a.c.push(b.c); }
  SER.r15m = mkSeries(resampleArr(a.t, a.o, a.h, a.l, a.c, 15, 0), x => x.datetime + 15 * 60e3);
  const close16 = new Map(rthDays.map(d => [d, H.etToMs(d, '16:00')]));
  SER.r60m = mkSeries(resampleArr(a.t, a.o, a.h, a.l, a.c, 60, 30), x => Math.min(x.datetime + 60 * 60e3, close16.get(etDate(x.datetime))));
}
log('series built');

// ── levels + trend at (date, ms) ───────────────────────────────────────────────────────────────────────
const KEY = ['pdC', 'openD', 'r15mEMA9', 'r15mBBM', 'n15mEMA9', 'n15mBBM', 'r60mEMA9', 'r60mBBM', 'n60mEMA9', 'n60mBBM'];   // center-type
const BANDS = ['r15mBBU', 'r15mBBL', 'n15mBBU', 'n15mBBL', 'r60mBBU', 'r60mBBL', 'n60mBBU', 'n60mBBL'];
const ALL = [...KEY, ...BANDS];
const LABEL = { pdC: 'prior NDX close', openD: 'open (derived 09:30)', r15mEMA9: 'NDX-RTH 15m 9EMA', r15mBBM: 'NDX-RTH 15m mid', n15mEMA9: 'NQ-24h 15m 9EMA', n15mBBM: 'NQ-24h 15m mid',
  r60mEMA9: 'NDX-RTH 60m 9EMA', r60mBBM: 'NDX-RTH 60m mid', n60mEMA9: 'NQ-24h 60m 9EMA', n60mBBM: 'NQ-24h 60m mid',
  r15mBBU: 'NDX-RTH 15m upper', r15mBBL: 'NDX-RTH 15m lower', n15mBBU: 'NQ-24h 15m upper', n15mBBL: 'NQ-24h 15m lower',
  r60mBBU: 'NDX-RTH 60m upper', r60mBBL: 'NDX-RTH 60m lower', n60mBBU: 'NQ-24h 60m upper', n60mBBL: 'NQ-24h 60m lower' };
function levelsAt(date, ms) {
  const R = RTH.get(date); if (!R) return null;
  const i = ndxIdx.get(date);
  const L = { pdC: i > 0 ? NDXD[i - 1].c : null, openD: R.openD }, tr = {};
  for (const [k, sh] of [['n15m', R.basis], ['n60m', R.basis], ['r15m', 0], ['r60m', 0]]) {
    const s = SER[k], j = lastDone(s, ms);
    if (j < 1 || !fin(s.c[j].bbU) || !fin(s.c[j].ema9)) continue;
    const c = s.c[j];
    L[`${k}EMA9`] = c.ema9 - sh; L[`${k}BBM`] = c.bbM - sh; L[`${k}BBU`] = c.bbU - sh; L[`${k}BBL`] = c.bbL - sh;
    tr[k] = sgn(c.c - c.ema9);   // close-vs-9EMA of the last completed candle
    tr[`${k}relW`] = (c.bbU - c.bbL) / c.c;
  }
  return { L, tr };
}
const pxAt = (date, ms) => { const R = RTH.get(date); if (!R) return null; const k = Math.floor((ms - R.t930) / 60e3) - 1; return k >= 0 && k < R.bars.length ? R.bars[k].c : null; };
const touchFrom = (R, ms, L, tol) => { const k = Math.max(0, Math.floor((ms - R.t930) / 60e3)); if (k >= R.bars.length) return null; return R.sufL[k] <= L + tol && R.sufH[k] >= L - tol; };

// ══════════════════════════════════════════════════════════════════════════════════════════════════════
// PART A — the user's orders
// ══════════════════════════════════════════════════════════════════════════════════════════════════════
function vAt(curve, x) { const P = curve.points; if (x <= P[0].x) return P[0].y; for (let i = 1; i < P.length; i++) if (x <= P[i].x) return P[i - 1].y + (P[i].y - P[i - 1].y) * (x - P[i - 1].x) / (P[i].x - P[i - 1].x); return P[P.length - 1].y; }
function shape(curve, legs, S) {
  const ks = legs.map(l => l.strike); const kLo = Math.min(...ks), kHi = Math.max(...ks);
  const span = curve.points.filter(p => p.x >= kLo && p.x <= kHi);
  const pmax = Math.max(...span.map(p => p.y));
  const peakPts = span.filter(p => p.y >= pmax - 1).map(p => p.x);
  const xPeak = peakPts.reduce((b, x) => (Math.abs(x - (S != null ? S : x)) < Math.abs(b - (S != null ? S : b)) ? x : b), peakPts[0]);
  let pa = xPeak, pb = xPeak; const thr = pmax > 0 ? pmax * 0.9 : pmax - 1;
  while (pa - 1 >= curve.xMin && vAt(curve, pa - 1) >= thr) pa--;
  while (pb + 1 <= curve.xMax && vAt(curve, pb + 1) >= thr) pb++;
  const oLo = pa <= curve.xMin, oHi = pb >= curve.xMax;
  return { target: oLo && oHi ? xPeak : oHi ? pa : oLo ? pb : (pa + pb) / 2, xPeak };
}
const sideOf = (x, S, sg) => (!fin(x) || !fin(S) ? null : Math.abs(x - S) < NEUTRAL_SIG * (sg || 50) ? 'neutral' : x > S ? 'bull' : 'bear');
function orderDir(o, S, sg, ownCurve) {
  if (o.style === 'vertical' || o.style === 'single') return o.direction;
  const ks = [...new Set(o.legs.map(l => l.strike))].sort((a, b) => a - b);
  if (/butterfly|condor/.test(o.style) && !o.style.startsWith('iron')) {
    if (o.direction === 'short') return 'neutral';
    const body = o.center != null ? o.center : ks.length === 4 ? (ks[1] + ks[2]) / 2 : (ks[0] + ks[ks.length - 1]) / 2;
    return sideOf(body, S, sg) || 'neutral';
  }
  if (S == null) return null;
  const m = Math.max(sg || 0, 25), dd = vAt(ownCurve, S + m) - vAt(ownCurve, S - m);
  return Math.abs(dd) < 0.1 * Math.max(1, ownCurve.max - ownCurve.min) ? 'neutral' : dd > 0 ? 'bull' : 'bear';
}
const OUTL = new Set(['2025-05-21', '2025-06-23']);   // the two days that dominate $ (phase 5)
const bsign = b => (b === 'bull' ? 1 : b === 'bear' ? -1 : 0);
const structOf = o => (o.style === 'vertical' ? `vertical ${o.debitCredit}` : /butterfly/.test(o.style) ? 'fly' : /condor/.test(o.style) ? 'condor' : o.style);

const A = [];   // per non-carried order with levels
const dayInfo = new Map();
for (const day of T.days) {
  const D = day.date, R = RTH.get(D);
  const seq = H.bookOrders(day, byNo);
  if (!seq.length || !R) continue;
  const dc = DAYCSV.get(D) || {}, ivBase = +dc.ivBase || null;
  const sigOpen = ivBase ? R.openD * ivBase * Math.sqrt(6.5 * 3600e3 / BS.YEAR_MS) : null;
  const i = ndxIdx.get(D), pdC = NDXD[i - 1].c;
  const gapSig = sigOpen ? (R.openD - pdC) / sigOpen : null;
  const gapDay = fin(gapSig) && Math.abs(gapSig) >= GAP_SIG;
  dayInfo.set(D, { pnl: day.pnl.net, gapSig, gapDay, settle: day.settle });
  const allK = seq.flatMap(s => s.order.legs.map(l => l.strike));
  const xMin = Math.floor((Math.min(...allK, day.settle) - 400) / 10) * 10, xMax = Math.ceil((Math.max(...allK, day.settle) + 400) / 10) * 10;
  const legsAcc = []; let cash = 0;
  seq.forEach(({ order: o, carried }, k) => {
    const oLegs = H.orderLegs(o);
    legsAcc.push(...oLegs); cash += o.total;
    if (carried || !o.timeET) return;
    const oi = ORD.get(`${D}|${o.orderNo}`) || {};
    const S = fin(oi.spotEst) ? oi.spotEst : null, sg = fin(oi.sigmaPts) ? oi.sigmaPts : null;
    if (S == null || !sg) return;
    const ms = H.etToMs(o.date, o.timeET);
    const net = B.netLegs(legsAcc), curve = H.payoffCurve(net, cash, xMin, xMax);
    const sh = net.length ? shape(curve, net, S) : null;
    const ownCurve = H.payoffCurve(B.netLegs(oLegs), o.total, xMin, xMax);
    const lt = levelsAt(D, ms); if (!lt) return;
    const row = {
      date: D, month: D.slice(0, 7), orderNo: o.orderNo, timeET: o.timeET, step: k, ms, effect: o.effect || 'open', struct: structOf(o), style: o.style, debitCredit: o.debitCredit,
      S, sg, orderBias: orderDir(o, S, sg, ownCurve) || 'neutral', bookBias: sh ? sideOf(sh.target, S, sg) : 'neutral',
      bookTarget: sh ? sh.target : null, bookPeak: sh ? sh.xPeak : null, ownPnl: fin(oi.ownPnl) ? oi.ownPnl : null, dayPnl: day.pnl.net, gapDay, settle: day.settle,
      trR15: lt.tr.r15m || 0, trN15: lt.tr.n15m || 0, trR60: lt.tr.r60m || 0, trN60: lt.tr.n60m || 0, L: lt.L, o,
      bandSig: lt.tr.n15mrelW ? S * BS.ivFromRelBandWidth(lt.tr.n15mrelW) * Math.sqrt(Math.max(0, H.etToMs(D, '16:00') - ms) / BS.YEAR_MS) : null,
    };
    row.lv = {};
    for (const t of ALL) {
      const L = lt.L[t]; if (!fin(L)) continue;
      const dS = (L - S) / sg;
      row.lv[t] = { L, dPts: L - S, dSig: dS, dir: Math.abs(dS) < AT_SPOT_SIG ? 0 : sgn(dS), touch: touchFrom(R, ms, L, TOUCH_TOL), closer: Math.abs(day.settle - L) < Math.abs(S - L) };
    }
    A.push(row);
  });
}
log('part A rows', A.length);

// random-minute level direction (null 2): precompute per day a pool of minutes
const minutePool = new Map();
for (const D of new Set(A.map(r => r.date))) {
  const pool = [];
  for (let m = 15; m <= 375; m += 3) { const ms = RTH.get(D).t930 + m * 60e3; const S = pxAt(D, ms); const lt = levelsAt(D, ms); if (S == null || !lt) continue; pool.push({ S, L: lt.L }); }
  minutePool.set(D, pool);
}

function agreement(rows, biasKey, t) {
  const sel = rows.filter(r => bsign(r[biasKey]) && r.lv[t] && r.lv[t].dir);
  if (!sel.length) return null;
  const ag = sel.filter(r => bsign(r[biasKey]) === r.lv[t].dir).length / sel.length;
  // null 1 independence (across all days): P(bull)P(up)+P(bear)P(down)
  const pb = sel.filter(r => bsign(r[biasKey]) > 0).length / sel.length, pu = sel.filter(r => r.lv[t].dir > 0).length / sel.length;
  const nInd = pb * pu + (1 - pb) * (1 - pu);
  // null 2 random minute same day (bias fixed, level side read at a random minute)
  let h2 = 0, n2 = 0;
  for (const r of sel) { const pool = minutePool.get(r.date); for (let k = 0; k < 40; k++) { const p = pool[Math.floor(rnd() * pool.length)]; if (!fin(p.L[t])) continue; const d = (p.L[t] - p.S) / r.sg; if (Math.abs(d) < AT_SPOT_SIG) continue; n2++; if (sgn(d) === bsign(r[biasKey])) h2++; } }
  // null 3 permute bias within day
  const byD = new Map(); sel.forEach(r => { if (!byD.has(r.date)) byD.set(r.date, []); byD.get(r.date).push(r); });
  let h3 = 0, n3 = 0;
  for (let d = 0; d < DRAWS; d++) for (const g of byD.values()) { const b = g.map(r => bsign(r[biasKey])); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } g.forEach((r, i) => { n3++; if (b[i] === r.lv[t].dir) h3++; }); }
  // trend control: stratify on NDX-RTH 15m close-vs-9EMA
  const withT = sel.filter(r => r.trR15 && r.lv[t].dir === r.trR15), agT = sel.filter(r => r.trR15 && r.lv[t].dir === -r.trR15);
  const agOf = a => (a.length ? a.filter(r => bsign(r[biasKey]) === r.lv[t].dir).length / a.length : null);
  const corrT = mean(sel.filter(r => r.trR15).map(r => r.lv[t].dir * r.trR15));
  return { t, n: sel.length, days: byD.size, ag, nInd, nMin: n2 ? h2 / n2 : null, nPerm: n3 ? h3 / n3 : null, nWith: withT.length, agWith: agOf(withT), nAgainst: agT.length, agAgainst: agOf(agT), corrT };
}

// ridge logistic (IRLS) + day bootstrap
function logit(X, y, lambda = 1) {
  const p = X[0].length; let w = new Array(p).fill(0);
  for (let it = 0; it < 25; it++) {
    const g = new Array(p).fill(0), Hm = Array.from({ length: p }, () => new Array(p).fill(0));
    for (let i = 0; i < X.length; i++) { const z = X[i].reduce((s, x, j) => s + x * w[j], 0); const pr = 1 / (1 + Math.exp(-z)); const e = y[i] - pr, v = pr * (1 - pr); for (let a = 0; a < p; a++) { g[a] += e * X[i][a]; for (let b = 0; b < p; b++) Hm[a][b] += v * X[i][a] * X[i][b]; } }
    for (let a = 1; a < p; a++) { g[a] -= lambda * w[a]; Hm[a][a] += lambda; }
    const step = solve(Hm, g); w = w.map((x, j) => x + step[j]);
    if (Math.max(...step.map(Math.abs)) < 1e-6) break;
  }
  return w;
}
function solve(Am, bv) { const n = bv.length, M = Am.map((r, i) => [...r, bv[i]]); for (let i = 0; i < n; i++) { let mx = i; for (let k = i + 1; k < n; k++) if (Math.abs(M[k][i]) > Math.abs(M[mx][i])) mx = k; [M[i], M[mx]] = [M[mx], M[i]]; const piv = M[i][i] || 1e-12; for (let k = 0; k < n; k++) if (k !== i) { const f = M[k][i] / piv; for (let j = i; j <= n; j++) M[k][j] -= f * M[i][j]; } } return M.map((r, i) => r[n] / (r[i] || 1e-12)); }
function bootLogit(rows, feat, yOf, reps = 200) {
  const X = rows.map(r => [1, ...feat(r)]), y = rows.map(yOf);
  const w = logit(X, y);
  const days = [...new Set(rows.map(r => r.date))], idx = new Map(days.map(d => [d, []])); rows.forEach((r, i) => idx.get(r.date).push(i));
  const B_ = [];
  for (let b = 0; b < reps; b++) { const ii = []; for (let k = 0; k < days.length; k++) ii.push(...idx.get(days[Math.floor(rnd() * days.length)])); B_.push(logit(ii.map(i => X[i]), ii.map(i => y[i]))); }
  const q = (a, p) => { const s = [...a].sort((x, z) => x - z); return s[Math.floor(p * (s.length - 1))]; };
  return w.map((v, j) => ({ coef: v, lo: q(B_.map(x => x[j]), 0.05), hi: q(B_.map(x => x[j]), 0.95), pPos: B_.filter(x => x[j] > 0).length / reps }));
}

const dirRows = A.filter(r => bsign(r.orderBias));
const bookRows = A.filter(r => bsign(r.bookBias));
const agOrder = ALL.map(t => agreement(A, 'orderBias', t)).filter(Boolean);
const agBook = ALL.map(t => agreement(A, 'bookBias', t)).filter(Boolean);
// trend-only agreement
const trendAg = (rows, bk, tk) => { const s = rows.filter(r => r[tk]); return { n: s.length, ag: s.filter(r => bsign(r[bk]) === r[tk]).length / (s.length || 1) }; };
log('agreement done');

// per-level logistic with trend controls (order bias)
const TRF = r => [r.trR15, r.trN15, r.trR60, r.trN60];
const perLevelLogit = KEY.concat(['r15mBBU', 'n15mBBU']).map(t => {
  const rows = dirRows.filter(r => r.lv[t] && r.lv[t].dir);
  const res = bootLogit(rows, r => [...TRF(r), r.lv[t].dir], r => (bsign(r.orderBias) > 0 ? 1 : 0), 150);
  return { t, n: rows.length, ...res[5] };
});
const trendOnly = bootLogit(dirRows, TRF, r => (bsign(r.orderBias) > 0 ? 1 : 0), 150);
// multi-level logistic: all center levels + trends
const multiRows = dirRows.filter(r => KEY.every(t => r.lv[t]));
const multi = bootLogit(multiRows, r => [...TRF(r), ...KEY.map(t => r.lv[t].dir)], r => (bsign(r.orderBias) > 0 ? 1 : 0), 200);
const multiNames = ['intercept', 'trend NDX-RTH 15m', 'trend NQ 15m', 'trend NDX-RTH 60m', 'trend NQ 60m', ...KEY.map(t => LABEL[t])];
// in-sample accuracy
const accOf = (rows, w, feat) => rows.filter(r => { const z = [1, ...feat(r)].reduce((s, x, j) => s + x * w[j].coef, 0); return (z > 0 ? 1 : -1) === bsign(r.orderBias); }).length / rows.length;
const multiAcc = accOf(multiRows, multi, r => [...TRF(r), ...KEY.map(t => r.lv[t].dir)]);
const trendAcc = accOf(dirRows, trendOnly, TRF);
log('logistic done');

// Q3 rules where center levels disagree
function rules(r) {
  const lv = KEY.filter(t => r.lv[t] && r.lv[t].dir).map(t => ({ t, ...r.lv[t] }));
  if (lv.length < 2) return null;
  const up = lv.filter(x => x.dir > 0).length, dn = lv.length - up;
  if (!up || !dn) return { disagree: false };
  const by = [...lv].sort((a, b) => Math.abs(a.dSig) - Math.abs(b.dSig));
  const near1 = lv.filter(x => Math.abs(x.dSig) <= 1), u1 = near1.filter(x => x.dir > 0).length, d1 = near1.length - u1;
  const wsum = sum(lv.map(x => x.dir / Math.max(0.1, Math.abs(x.dSig))));
  const out = { disagree: true, nearest: by[0].dir, farthest: by[by.length - 1].dir, majority: up === dn ? 0 : sgn(up - dn), majority1s: u1 === d1 ? 0 : sgn(u1 - d1), invDist: sgn(wsum),
    fadeR15: -r.trR15, followR15: r.trR15, fadeN15: -r.trN15, followR60: r.trR60 };
  for (const t of KEY) out[`only:${t}`] = r.lv[t] ? r.lv[t].dir : 0;
  return out;
}
const ruleRows = dirRows.map(r => ({ r, x: rules(r) })).filter(z => z.x && z.x.disagree);
const ruleNames = Object.keys(ruleRows[0] ? ruleRows[0].x : {}).filter(k => k !== 'disagree');
const ruleTbl = ruleNames.map(k => { const s = ruleRows.filter(z => z.x[k]); return { k, n: s.length, acc: s.filter(z => z.x[k] === bsign(z.r.orderBias)).length / (s.length || 1) }; }).sort((a, b) => b.acc - a.acc);

// Q4 outcomes per level: toward vs away (order-level), plus day-level at the first directional order
function outcome(rows, t, filt = () => true) {
  const s = rows.filter(r => bsign(r.orderBias) && r.lv[t] && r.lv[t].dir && filt(r));
  const tw = s.filter(r => bsign(r.orderBias) === r.lv[t].dir), aw = s.filter(r => bsign(r.orderBias) !== r.lv[t].dir);
  const st = a => ({ n: a.length, touch: mean(a.map(r => (r.lv[t].touch ? 1 : 0))), closer: mean(a.map(r => (r.lv[t].closer ? 1 : 0))), pnl: sum(a.map(r => r.ownPnl)), pnlX: sum(a.filter(r => !OUTL.has(r.date)).map(r => r.ownPnl)), win: a.length ? a.filter(r => r.ownPnl > 0).length / a.length : null, mpnl: mean(a.map(r => r.ownPnl)) });
  // day-clustered bootstrap of (mean $ toward − mean $ away)
  const days = [...new Set(s.map(r => r.date))], byD = new Map(days.map(d => [d, s.filter(r => r.date === d)]));
  const diffs = [];
  for (let b = 0; b < 300; b++) { let a1 = 0, n1 = 0, a2 = 0, n2 = 0; for (let k = 0; k < days.length; k++) for (const r of byD.get(days[Math.floor(rnd() * days.length)])) { if (!fin(r.ownPnl)) continue; if (bsign(r.orderBias) === r.lv[t].dir) { a1 += r.ownPnl; n1++; } else { a2 += r.ownPnl; n2++; } } if (n1 && n2) diffs.push(a1 / n1 - a2 / n2); }
  diffs.sort((x, y) => x - y);
  return { t, all: st(s), tw: st(tw), aw: st(aw), dMean: mean(tw.map(r => r.ownPnl)) - mean(aw.map(r => r.ownPnl)), dLo: diffs[Math.floor(0.05 * diffs.length)], dHi: diffs[Math.floor(0.95 * diffs.length)] };
}
const firstDir = [...new Set(A.map(r => r.date))].map(D => A.find(r => r.date === D && bsign(r.orderBias))).filter(Boolean);
function dayOutcome(t, filt = () => true) {
  const s = firstDir.filter(r => r.lv[t] && r.lv[t].dir && filt(r));
  const tw = s.filter(r => bsign(r.orderBias) === r.lv[t].dir), aw = s.filter(r => bsign(r.orderBias) !== r.lv[t].dir);
  const st = a => ({ n: a.length, pnl: sum(a.map(r => r.dayPnl)), win: a.length ? a.filter(r => r.dayPnl > 0).length / a.length : null });
  return { tw: st(tw), aw: st(aw) };
}

// Q5 strike placement vs magnet distance (magnet = nearest center level on the bias side, ≥0.1σ away)
const strikeRows = [];
for (const r of dirRows) {
  if (r.effect !== 'open') continue;
  const b = bsign(r.orderBias);
  const cands = KEY.filter(t => r.lv[t] && r.lv[t].dir === b && Math.abs(r.lv[t].dSig) >= 0.1).sort((x, y) => Math.abs(r.lv[x].dSig) - Math.abs(r.lv[y].dSig));
  const magT = cands[0] || null, magD = magT ? Math.abs(r.lv[magT].dSig) : null;
  const o = r.o, off = K => (K - r.S) * b / r.sg;
  let shortOff = null, longOff = null, bodyOff = null;
  if (o.style === 'vertical') { const sh = o.legs.find(l => l.side === 'short'), ln = o.legs.find(l => l.side === 'long'); shortOff = off(sh.strike); longOff = off(ln.strike); }
  else if (/butterfly|condor/.test(o.style) && !o.style.startsWith('iron')) { const ks = [...new Set(o.legs.map(l => l.strike))].sort((x, y) => x - y); bodyOff = off(o.center != null ? o.center : ks.length === 4 ? (ks[1] + ks[2]) / 2 : (ks[0] + ks[ks.length - 1]) / 2); }
  const keyOff = o.style === 'vertical' ? shortOff : bodyOff;
  const far = KEY.filter(t => r.lv[t] && r.lv[t].dir === b && Math.abs(r.lv[t].dSig) >= 0.1).sort((x, y) => Math.abs(r.lv[y].dSig) - Math.abs(r.lv[x].dSig))[0] || null;
  const farD = far ? Math.abs(r.lv[far].dSig) : null;
  const n15 = r.lv.n15mEMA9 && r.lv.n15mEMA9.dir === b ? Math.abs(r.lv.n15mEMA9.dSig) : null;
  strikeRows.push({ date: r.date, month: r.month, orderNo: r.orderNo, timeET: r.timeET, struct: r.struct, bias: r.orderBias, magnet: magT || 'none', magnetSig: r2(magD), shortOffSig: r2(shortOff), longOffSig: r2(longOff), bodyOffSig: r2(bodyOff),
    peakOffSig: r2(r.bookPeak != null ? off(r.bookPeak) : null), ratio: magD && fin(keyOff) ? r2(keyOff / magD) : null, farMagnet: far || 'none', farSig: r2(farD), ratioFar: farD && fin(keyOff) ? r2(keyOff / farD) : null,
    n15Sig: r2(n15), ratioN15: n15 && n15 >= 0.1 && fin(keyOff) ? r2(keyOff / n15) : null, nMagnets: KEY.filter(t => r.lv[t] && r.lv[t].dir === b).length, nAgainst: KEY.filter(t => r.lv[t] && r.lv[t].dir === -b).length, magnetTouched: magT ? (r.lv[magT].touch ? 1 : 0) : null, ownPnl: r0(r.ownPnl), gapDay: r.gapDay ? 1 : 0, outlierDay: OUTL.has(r.date) ? 1 : 0 });
}
log('part A done');

// ══════════════════════════════════════════════════════════════════════════════════════════════════════
// PART B — unconditional magnet study
// ══════════════════════════════════════════════════════════════════════════════════════════════════════
const DB = [[0.05, 0.25], [0.25, 0.5], [0.5, 1], [1, 1.5], [1.5, 3]];
const dbOf = a => { for (let i = 0; i < DB.length; i++) if (a >= DB[i][0] && a < DB[i][1]) return i; return -1; };
const DBL = DB.map(([a, b]) => `${a}-${b}σ`);
const cube = new Map();      // key -> [n, touchL, touchP, sideL, sideP, closerL, closerP]
const perDay = new Map();    // `${t}|${dir}` -> Map(day -> [n,tL,tP,cL,cP])
const add = (key, v) => { let c = cube.get(key); if (!c) { c = new Array(7).fill(0); cube.set(key, c); } for (let i = 0; i < 7; i++) c[i] += v[i]; };
const mDays = rthDays.filter(d => d >= FROM && d <= TO && ndxIdx.get(d) > 0);
let mRows = 0, sigRatio = [];
for (const D of mDays) {
  const R = RTH.get(D); if (R.bars.length < 385) continue;
  const settle = R.settle;
  const lt0 = levelsAt(D, R.t930 + 60e3);
  const iv0 = lt0 && lt0.tr.n15mrelW ? BS.ivFromRelBandWidth(lt0.tr.n15mrelW) : null;
  const sigDay = iv0 ? R.openD * iv0 * Math.sqrt(6.5 * 3600e3 / BS.YEAR_MS) : null;
  const pdC = NDXD[ndxIdx.get(D) - 1].c;
  const gap = sigDay ? (Math.abs(R.openD - pdC) / sigDay >= GAP_SIG ? 'gap' : 'flat') : 'n/a';
  for (const hm of DTIMES) {
    const ms = H.etToMs(D, hm), S = pxAt(D, ms), lt = levelsAt(D, ms);
    if (S == null || !lt || !lt.tr.n15mrelW) continue;
    const sg = S * BS.ivFromRelBandWidth(lt.tr.n15mrelW) * Math.sqrt((H.etToMs(D, '16:00') - ms) / BS.YEAR_MS);
    const k = Math.floor((ms - R.t930) / 60e3), hiF = R.sufH[k], loF = R.sufL[k];
    for (const t of ALL) {
      const L = lt.L[t]; if (!fin(L)) continue;
      const d = L - S, a = Math.abs(d) / sg, bi = dbOf(a); if (bi < 0) continue;
      const above = d > 0, P = S - d;
      const tL = above ? hiF >= L : loF <= L, tP = above ? loF <= P : hiF >= P;
      const sL = sgn(settle - S) === sgn(d), sP = sgn(settle - S) === -sgn(d);
      const cL = Math.abs(settle - L) < Math.abs(d), cP = Math.abs(settle - P) < Math.abs(d);
      const w15 = !lt.tr.n15m ? 'mixed' : sgn(d) === lt.tr.n15m ? 'with' : 'against', w60 = !lt.tr.n60m ? 'mixed' : sgn(d) === lt.tr.n60m ? 'with' : 'against';
      add(`${t}|${hm}|${bi}|${w15}|${w60}|${gap}|${above ? 'above' : 'below'}`, [1, +tL, +tP, +sL, +sP, +cL, +cP]);
      const pk = `${t}|${above ? 1 : -1}`; if (!perDay.has(pk)) perDay.set(pk, new Map());
      const pm = perDay.get(pk); let v = pm.get(D); if (!v) { v = [0, 0, 0, 0, 0]; pm.set(D, v); } v[0]++; v[1] += tL; v[2] += tP; v[3] += cL; v[4] += cP;
      mRows++;
    }
  }
}
// band-σ vs the user's own σ on trade days (calibration context)
for (const r of A) if (fin(r.bandSig) && r.sg) sigRatio.push(r.bandSig / r.sg);
log('part B rows', mRows, 'days', mDays.length);

/** Aggregate the cube with a filter; returns drift-neutral edges (mean of above / below edges). */
function agg(filter) {
  const s = { above: new Array(7).fill(0), below: new Array(7).fill(0) };
  for (const [k, v] of cube) { const p = k.split('|'); const o = { t: p[0], hm: p[1], db: +p[2], w15: p[3], w60: p[4], gap: p[5], side: p[6] }; if (!filter(o)) continue; for (let i = 0; i < 7; i++) s[o.side][i] += v[i]; }
  const e = (x, a, b) => (x[0] ? (x[a] - x[b]) / x[0] : null);
  const both = [0, 1, 2, 3, 4, 5, 6].map(i => s.above[i] + s.below[i]);
  const ok = s.above[0] >= 30 && s.below[0] >= 30;
  return { n: both[0], nA: s.above[0], nB: s.below[0], touchL: both[0] ? both[1] / both[0] : null, touchP: both[0] ? both[2] / both[0] : null, closerL: both[0] ? both[5] / both[0] : null, closerP: both[0] ? both[6] / both[0] : null,
    sideL: both[0] ? both[3] / both[0] : null,
    eTouchA: e(s.above, 1, 2), eTouchB: e(s.below, 1, 2), eTouch: ok ? (e(s.above, 1, 2) + e(s.below, 1, 2)) / 2 : null,
    eCloserA: e(s.above, 5, 6), eCloserB: e(s.below, 5, 6), eCloser: ok ? (e(s.above, 5, 6) + e(s.below, 5, 6)) / 2 : null,
    eSide: ok ? (e(s.above, 3, 4) + e(s.below, 3, 4)) / 2 : null };
}
/** Day-clustered bootstrap SE of the drift-neutral closer / touch edge (all times, all distances). */
function bootEdge(t, reps = 300) {
  const A_ = perDay.get(`${t}|1`) || new Map(), B_ = perDay.get(`${t}|-1`) || new Map();
  const days = [...new Set([...A_.keys(), ...B_.keys()])];
  const ed = (ds) => { const a = [0, 0, 0, 0, 0], b = [0, 0, 0, 0, 0]; for (const d of ds) { const x = A_.get(d), y = B_.get(d); if (x) for (let i = 0; i < 5; i++) a[i] += x[i]; if (y) for (let i = 0; i < 5; i++) b[i] += y[i]; } if (!a[0] || !b[0]) return null; return { t: ((a[1] - a[2]) / a[0] + (b[1] - b[2]) / b[0]) / 2, c: ((a[3] - a[4]) / a[0] + (b[3] - b[4]) / b[0]) / 2 }; };
  const bs = []; for (let r = 0; r < reps; r++) { const ds = []; for (let k = 0; k < days.length; k++) ds.push(days[Math.floor(rnd() * days.length)]); const x = ed(ds); if (x) bs.push(x); }
  const sd = a => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); };
  return { seT: sd(bs.map(x => x.t)), seC: sd(bs.map(x => x.c)), days: days.length };
}
log('aggregating');

// ══════════════════════════════════════════════════════════════════════════════════════════════════════
// REPORT
// ══════════════════════════════════════════════════════════════════════════════════════════════════════
const fmt = (v, d = 0) => (v == null || !isFinite(v) ? '—' : (+v).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d }));
const pct = v => (v == null || !isFinite(v) ? '—' : `${Math.round(v * 100)}%`);
const pp = v => (v == null || !isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}`);
const md = (head, rows) => `| ${head.join(' | ')} |\n|${head.map(() => '---').join('|')}|\n${rows.map(r => `| ${r.join(' | ')} |`).join('\n')}\n`;
const toCsv = rows => { const h = Object.keys(rows[0]); const q = v => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v)); return [h.join(','), ...rows.map(r => h.map(k => q(r[k])).join(','))].join('\n') + '\n'; };
const src = t => (t === 'pdC' ? 'exact' : t === 'openD' || t.startsWith('r') ? 'DERIVED' : 'NQ−basis');
const S = [];
const months = [...new Set(A.map(r => r.month))].sort();
S.push(`Part A: ${new Set(A.map(r => r.date)).size} days, ${A.length} same-day orders with levels (carried-in orders excluded), ${dirRows.length} with a directional ORDER bias (${dirRows.filter(r => r.orderBias === 'bull').length} bull / ${dirRows.filter(r => r.orderBias === 'bear').length} bear), ${bookRows.length} with a directional BOOK bias after the order. Gap days ${[...dayInfo.values()].filter(d => d.gapDay).length}/${dayInfo.size}. Months: ${months.map(m => `${m} ${A.filter(r => r.month === m).length}`).join(', ')}.\n`);
S.push(`Part B: ${mDays.length} RTH days ${FROM}..${TO}, ${DTIMES.join('/')} ET, ${fmt(mRows)} level×time rows. Band-σ (Part B method) / user's fill-σ on trade days: median ${fmt(median(sigRatio), 2)} (IQR ${fmt(median(sigRatio.filter(x => x < median(sigRatio))), 2)}-${fmt(median(sigRatio.filter(x => x > median(sigRatio))), 2)}).\n`);

S.push('## 1-2. Agreement: does the bias point toward the level?\n');
S.push(`Trend alone: order bias = NDX-RTH 15m close-vs-9EMA direction ${pct(trendAg(dirRows, 'orderBias', 'trR15').ag)} (n ${trendAg(dirRows, 'orderBias', 'trR15').n}); NQ 15m ${pct(trendAg(dirRows, 'orderBias', 'trN15').ag)}; NDX-RTH 60m ${pct(trendAg(dirRows, 'orderBias', 'trR60').ag)}; NQ 60m ${pct(trendAg(dirRows, 'orderBias', 'trN60').ag)}. Below 50% = the user FADED the trend.\n`);
const agTbl = (rows) => md(['level', 'src', 'n', 'days', 'agree', 'null indep', 'null rand-minute', 'null permute-in-day', 'lift vs permute', 'corr(levelDir, RTH15 trend)', 'agree | level WITH RTH15 trend (n)', 'agree | level AGAINST trend (n)'],
  rows.sort((a, b) => (b.ag - b.nPerm) - (a.ag - a.nPerm)).map(x => [LABEL[x.t], src(x.t), x.n, x.days, pct(x.ag), pct(x.nInd), pct(x.nMin), pct(x.nPerm), fmt(x.ag / x.nPerm, 2), fmt(x.corrT, 2), `${pct(x.agWith)} (${x.nWith})`, `${pct(x.agAgainst)} (${x.nAgainst})`]));
S.push('### Order bias (the order\'s own direction)\n'); S.push(agTbl(agOrder));
S.push('### Book bias after the order (target side vs spot)\n'); S.push(agTbl(agBook));
S.push('Bands: price sits between them, so the upper band is almost always "above" (agreement ≈ share of bull orders); read the bands only through the null columns. The 15m 9EMA level direction is the mirror of close-vs-9EMA trend (corr ≈ −1), so for it "agree" = "faded the 15m trend".\n');
S.push('### Per-level logistic: order bull ~ RTH15 + NQ15 + RTH60 + NQ60 trends + levelDir (ridge λ=1; 90% day-bootstrap CI)\n');
S.push(md(['level', 'n', 'levelDir coef', '90% CI', 'P(coef>0) boot'], perLevelLogit.map(x => [LABEL[x.t], x.n, fmt(x.coef, 2), `${fmt(x.lo, 2)}..${fmt(x.hi, 2)}`, pct(x.pPos)])));
S.push(`Trend-only model: ${trendOnly.slice(1).map((c, i) => `${['RTH15', 'NQ15', 'RTH60', 'NQ60'][i]} ${fmt(c.coef, 2)} [${fmt(c.lo, 2)}..${fmt(c.hi, 2)}]`).join(', ')}; in-sample accuracy ${pct(trendAcc)} (n ${dirRows.length}).\n`);

S.push('## 3. When the center levels disagree, which one does the bias follow?\n');
S.push(`${ruleRows.length} directional orders where the 10 center levels sit on BOTH sides of spot (of ${dirRows.length}). Accuracy of each rule at predicting the order bias (rule abstains on ties / missing):\n`);
S.push(md(['rule', 'n', 'accuracy'], ruleTbl.map(x => [x.k.replace(/^only:(.*)$/, (m, t) => `level: ${LABEL[t]}`), x.n, pct(x.acc)])));
S.push(`### Multi-level ridge logistic (all 10 center level directions + 4 trends; n ${multiRows.length}, in-sample accuracy ${pct(multiAcc)} vs trend-only ${pct(trendAcc)})\n`);
S.push(md(['feature', 'coef', '90% CI', 'P(coef>0)'], multi.map((c, j) => [multiNames[j], fmt(c.coef, 2), `${fmt(c.lo, 2)}..${fmt(c.hi, 2)}`, pct(c.pPos)])));

S.push('## 4. Outcomes under the magnet lens (order bias toward vs away from the level)\n');
S.push('Touch = derived 1m path trades within 5 pts of the level (frozen at order time) before 16:00. Closer = exact settle nearer the level than spot was. P&L = each order\'s own expiry P&L (real fills).\n');
const outTbl = (filt) => md(['level', 'toward n', 'toward touch', 'toward closer', 'toward P&L', 'toward P&L ex 05-21/06-23', 'toward win', 'away n', 'away touch', 'away closer', 'away P&L', 'away P&L ex 05-21/06-23', 'away win', 'Δ mean $/order toward−away [90% day-boot]'],
  KEY.map(t => { const x = outcome(A, t, filt); return [LABEL[t], x.tw.n, pct(x.tw.touch), pct(x.tw.closer), fmt(x.tw.pnl), fmt(x.tw.pnlX), pct(x.tw.win), x.aw.n, pct(x.aw.touch), pct(x.aw.closer), fmt(x.aw.pnl), fmt(x.aw.pnlX), pct(x.aw.win), `${fmt(x.dMean)} [${fmt(x.dLo)}..${fmt(x.dHi)}]`]; }));
S.push('### All orders\n'); S.push(outTbl(() => true));
const splitTbl = md(['level', 'May toward / away P&L (n)', 'June toward / away P&L (n)', 'gap-day toward / away P&L (n)', 'non-gap toward / away P&L (n)', 'DAY P&L by 1st directional order toward / away (days)'],
  KEY.map(t => { const f = (filt) => { const x = outcome(A, t, filt); return `${fmt(x.tw.pnl)} (${x.tw.n}) / ${fmt(x.aw.pnl)} (${x.aw.n})`; }; const d = dayOutcome(t);
    return [LABEL[t], f(r => r.month === '2025-05'), f(r => r.month === '2025-06'), f(r => r.gapDay), f(r => !r.gapDay), `${fmt(d.tw.pnl)} ${pct(d.tw.win)} (${d.tw.n}) / ${fmt(d.aw.pnl)} ${pct(d.aw.win)} (${d.aw.n})`]; }));
S.push('### Splits\n'); S.push(splitTbl);

S.push('## 5. Strike placement relative to spot (magnet-aligned open orders)\n');
S.push('Magnet = the NEAREST center level on the bias side, ≥0.1σ from spot. Offsets in σ, signed + = in the bias direction. ratio = key strike offset / magnet distance (vertical: short strike; fly: body).\n');
const SR = strikeRows.filter(r => r.magnet !== 'none');
S.push(`${SR.length} of ${strikeRows.length} directional opens had a magnet on the bias side (${strikeRows.length - SR.length} had none = bias against every center level).\n`);
const grpS = (rows, name) => [name, rows.length, fmt(median(rows.map(r => r.magnetSig)), 2), fmt(median(rows.map(r => r.shortOffSig)), 2), fmt(median(rows.map(r => r.longOffSig)), 2), fmt(median(rows.map(r => r.bodyOffSig)), 2), fmt(median(rows.map(r => r.peakOffSig)), 2), fmt(median(rows.map(r => r.ratio)), 2), pct(mean(rows.map(r => r.magnetTouched))), fmt(sum(rows.map(r => r.ownPnl))), pct(rows.filter(r => r.ownPnl > 0).length / (rows.length || 1))];
S.push(md(['struct', 'n', 'median magnet dist σ', 'short off σ', 'long off σ', 'body off σ', 'book peak off σ', 'median ratio', 'magnet touched', 'P&L', 'win'],
  [...['vertical debit', 'vertical credit', 'fly'].map(s => grpS(SR.filter(r => r.struct === s), s)), grpS(strikeRows.filter(r => r.magnet === 'none'), 'no magnet on bias side (all)')]));
const RB = [[-99, 0, '<0 (behind spot)'], [0, 0.33, '0-0.33'], [0.33, 0.67, '0.33-0.67'], [0.67, 1.0, '0.67-1.0'], [1.0, 1.5, '1.0-1.5'], [1.5, 99, '>1.5 (beyond magnet)']];
for (const s of ['vertical debit', 'vertical credit', 'fly']) {
  S.push(`### ${s}: P&L by placement ratio\n`);
  S.push(md(['ratio bucket', 'n', 'median magnet σ', 'magnet touched', 'P&L', 'mean', 'win'], RB.map(([a, b, nm]) => { const x = SR.filter(r => r.struct === s && fin(r.ratio) && r.ratio >= a && r.ratio < b); return [nm, x.length, fmt(median(x.map(r => r.magnetSig)), 2), pct(mean(x.map(r => r.magnetTouched))), fmt(sum(x.map(r => r.ownPnl))), fmt(mean(x.map(r => r.ownPnl))), pct(x.filter(r => r.ownPnl > 0).length / (x.length || 1))]; })));
}
for (const [nm, rk, dk] of [['FARTHEST aligned center level', 'ratioFar', 'farSig'], ['NQ-24h 15m 9EMA when on the bias side', 'ratioN15', 'n15Sig']]) {
  S.push(`### Alt magnet = ${nm}: P&L by placement ratio (debit verticals short strike / flies body)\n`);
  S.push(md(['ratio bucket', 'debit V n', 'median magnet σ', 'P&L', 'P&L ex 05-21/06-23', 'win', 'fly n', 'fly P&L', 'fly win'], RB.map(([a, b, lb]) => { const x = SR.filter(r => r.struct === 'vertical debit' && fin(r[rk]) && r[rk] >= a && r[rk] < b), y = strikeRows.filter(r => r.struct === 'fly' && fin(r[rk]) && r[rk] >= a && r[rk] < b);
    return [lb, x.length, fmt(median(x.map(r => r[dk])), 2), fmt(sum(x.map(r => r.ownPnl))), fmt(sum(x.filter(r => !r.outlierDay).map(r => r.ownPnl))), pct(x.filter(r => r.ownPnl > 0).length / (x.length || 1)), y.length, fmt(sum(y.map(r => r.ownPnl))), pct(y.filter(r => r.ownPnl > 0).length / (y.length || 1))]; })));
}
S.push('### Bias vs level COUNT: how many of the 10 center levels sat on the bias side (directional opens)\n');
S.push(md(['levels on bias side − against', 'n', 'P&L', 'P&L ex 05-21/06-23', 'win'], [[-99, -4, '≤ −4'], [-3, -1, '−3..−1'], [0, 0, '0'], [1, 3, '+1..+3'], [4, 99, '≥ +4']].map(([a, b, lb]) => { const x = strikeRows.filter(r => r.nMagnets - r.nAgainst >= a && r.nMagnets - r.nAgainst <= b); return [lb, x.length, fmt(sum(x.map(r => r.ownPnl))), fmt(sum(x.filter(r => !r.outlierDay).map(r => r.ownPnl))), pct(x.filter(r => r.ownPnl > 0).length / (x.length || 1))]; })));
S.push('### Magnet distance buckets (all structures)\n');
S.push(md(['magnet dist', 'n', 'touched', 'P&L', 'win'], DB.map(([a, b], i) => { const x = SR.filter(r => r.magnetSig >= a && r.magnetSig < b); return [DBL[i], x.length, pct(mean(x.map(r => r.magnetTouched))), fmt(sum(x.map(r => r.ownPnl))), pct(x.filter(r => r.ownPnl > 0).length / (x.length || 1))]; })));

S.push('## 6. Unconditional magnet study (all days, placebo = same distance on the other side of spot)\n');
S.push('Edges are percentage points, level minus placebo. Drift-neutral edge = mean of the level-above edge and the level-below edge (cancels the 2023-25 up-drift; shown only when both sides have n ≥ 30). SE = day-clustered bootstrap. Touch = exact cross on the derived 1m path (no tolerance).\n');
const LT = ALL.map(t => ({ t, a: agg(o => o.t === t), b: bootEdge(t) }));
S.push(md(['level', 'src', 'n (above/below)', 'touch L', 'touch placebo', 'touch edge above', 'touch edge below', 'touch edge (drift-neutral) ± SE', 'closer L', 'closer placebo', 'closer edge above', 'closer edge below', 'closer edge (drift-neutral) ± SE'],
  LT.map(({ t, a, b }) => [LABEL[t], src(t), `${a.nA}/${a.nB}`, pct(a.touchL), pct(a.touchP), pp(a.eTouchA), pp(a.eTouchB), `${pp(a.eTouch)} ± ${fmt(b.seT * 100, 1)}`, pct(a.closerL), pct(a.closerP), pp(a.eCloserA), pp(a.eCloserB), `${pp(a.eCloser)} ± ${fmt(b.seC * 100, 1)}`])));
S.push('### Drift-neutral CLOSER edge by distance (pp)\n');
S.push(md(['level', ...DBL], ALL.map(t => [LABEL[t], ...DB.map((_, i) => { const a = agg(o => o.t === t && o.db === i); return `${pp(a.eCloser)} (${a.n})`; })])));
S.push('### Drift-neutral TOUCH edge by distance (pp)\n');
S.push(md(['level', ...DBL], ALL.map(t => [LABEL[t], ...DB.map((_, i) => { const a = agg(o => o.t === t && o.db === i); return `${pp(a.eTouch)} (${a.n})`; })])));
S.push('### Drift-neutral CLOSER edge by decision time (pp)\n');
S.push(md(['level', ...DTIMES], KEY.map(t => [LABEL[t], ...DTIMES.map(hm => pp(agg(o => o.t === t && o.hm === hm).eCloser))])));
S.push('### Level WITH vs AGAINST the trend (NQ 15m / 60m close vs 9EMA), drift-neutral closer edge and touch edge (pp, n)\n');
const combos = [['with', 'with'], ['with', 'against'], ['against', 'with'], ['against', 'against']];
S.push(md(['level', ...combos.map(([a, b]) => `15m ${a} / 60m ${b}: closer · touch (n)`)], ALL.map(t => [LABEL[t], ...combos.map(([a, b]) => { const x = agg(o => o.t === t && o.w15 === a && o.w60 === b); return `${pp(x.eCloser)} · ${pp(x.eTouch)} (${x.n})`; })])));
S.push('Note: a level "with the 15m trend" means it is on the side price has been moving; the 15m 9EMA / mid are below price in an up-trend, so they are almost always AGAINST the trend.\n');
S.push('### Gap vs flat open (|derived open − prior close| ≥ 0.25σ day), drift-neutral closer · touch edge (pp, n), before 12:00 and all times\n');
S.push(md(['level', 'gap <12:00', 'flat <12:00', 'gap all', 'flat all'], ALL.map(t => [LABEL[t], ...[['gap', true], ['flat', true], ['gap', false], ['flat', false]].map(([g, am]) => { const x = agg(o => o.t === t && o.gap === g && (!am || o.hm < '12:00')); return `${pp(x.eCloser)} · ${pp(x.eTouch)} (${x.n})`; })])));
S.push('### Raw P(touch) of the level by distance (all levels pooled, both sides) — the base rate an engine can plan with\n');
S.push(md(['distance', 'P(touch level)', 'P(touch placebo)', 'P(settle closer to level)', 'n'], DB.map((_, i) => { const x = agg(o => KEY.includes(o.t) && o.db === i); return [DBL[i], pct(x.touchL), pct(x.touchP), pct(x.closerL), x.n]; })));

// ── write ──
const MARK_S = '<!-- AUTO-TABLES:START -->', MARK_E = '<!-- AUTO-TABLES:END -->';
const rp = path.join(OUT, 'magnets-report.md');
let head = `# Manual trades phase 6: levels as direction magnets\n\nGenerated by scripts/manual-trades/analyze-magnets.js. Hand-written findings go ABOVE the marker; re-runs replace only the block between the markers.\n\n`;
if (fs.existsSync(rp)) { const old = fs.readFileSync(rp, 'utf8'); const i = old.indexOf(MARK_S); if (i > 0) head = old.slice(0, i); }
fs.writeFileSync(rp, `${head}${MARK_S}\n${S.join('\n')}\n${MARK_E}\n`);
const orderCsv = A.map(r => { const x = { date: r.date, orderNo: r.orderNo, timeET: r.timeET, struct: r.struct, effect: r.effect, spot: r0(r.S), sigma: r0(r.sg), orderBias: r.orderBias, bookBias: r.bookBias, trR15: r.trR15, trN15: r.trN15, trR60: r.trR60, trN60: r.trN60, gapDay: r.gapDay ? 1 : 0, ownPnl: r0(r.ownPnl), dayPnl: r0(r.dayPnl) }; for (const t of ALL) { const l = r.lv[t]; x[`${t}_dSig`] = l ? r2(l.dSig) : null; x[`${t}_touch`] = l ? (l.touch ? 1 : 0) : null; x[`${t}_closer`] = l ? (l.closer ? 1 : 0) : null; } return x; });
fs.writeFileSync(path.join(OUT, 'mg-orders.csv'), toCsv(orderCsv));
fs.writeFileSync(path.join(OUT, 'mg-agreement.csv'), toCsv([...agOrder.map(x => ({ bias: 'order', ...x })), ...agBook.map(x => ({ bias: 'book', ...x }))].map(x => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, typeof v === 'number' ? r3(v) : v])))));
fs.writeFileSync(path.join(OUT, 'mg-strikes.csv'), toCsv(strikeRows));
fs.writeFileSync(path.join(OUT, 'mg-market-cube.csv'), toCsv([...cube].map(([k, v]) => { const p = k.split('|'); return { level: p[0], time: p[1], dist: DBL[+p[2]], trend15: p[3], trend60: p[4], open: p[5], side: p[6], n: v[0], touchL: v[1], touchP: v[2], sideL: v[3], sideP: v[4], closerL: v[5], closerP: v[6] }; })));
fs.writeFileSync(path.join(OUT, 'mg-market-levels.csv'), toCsv(LT.map(({ t, a, b }) => ({ level: t, n: a.n, nAbove: a.nA, nBelow: a.nB, touchL: r3(a.touchL), touchP: r3(a.touchP), eTouch: r3(a.eTouch), seTouch: r3(b.seT), closerL: r3(a.closerL), closerP: r3(a.closerP), eCloser: r3(a.eCloser), seCloser: r3(b.seC), eSide: r3(a.eSide) }))));
log('wrote', rp);
