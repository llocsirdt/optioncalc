#!/usr/bin/env node
'use strict';
/**
 * PHASE 5 of the manual-trades study: NDX-RTH LEVELS, GAPS, STACKING and WIDTH.
 *
 * User additions after phase 4 (paraphrased):
 *   1. add the PRIOR DAY'S CLOSE to the level list; price was generally expected to trend back toward the 15m average.
 *   2. the user read the cash-NDX lines, not only /NQ. After a gap, NQ's 15m lines have already "closed the gap"
 *      overnight, while on RTH-only NDX the gap leaves space between price and the 15m centerline. Gaps often tried to
 *      retrace toward the prior close; which level (prior close vs 15m centerline) gave resistance first?
 *   3. STACKING: positions were added in the bias direction when the 15m and/or 60m candles trended that way.
 *   4. WIDTH: when were narrow vs wide spreads chosen?
 *
 *   node scripts/manual-trades/analyze-levels-stacking.js [--out data/manual-trades/analysis] [--nq <NQ 1m csv>] [--draws 400]
 *
 * Writes <out>/levels-stacking-report.md (tables; hand-written text above the AUTO-TABLES marker is kept),
 *        <out>/ls-days.csv (per day: gap, first level reached, held/broke, user positioning, stacks),
 *        <out>/ls-orders.csv (per order: book bias, order direction, category, trend state NDX-RTH + NQ, width),
 *        <out>/ls-levels.csv (per target strike: distance to every level incl. NDX-RTH lines).
 *
 * Reuses phase 1-4: book.js, routes.js helpers (bookOrders, payoffCurve, tfSeries, nqAt, etToMs, orderLegs),
 * orders.json (spotEst / sigmaPts / ownPnl), days.csv (ivBase), basis.json, the exact NDX daily file, and the repo's
 * indicator code. Read-only; single process. Never prints account identifiers (trades.json carries none we use).
 *
 * DERIVED / ESTIMATES (flagged in the report):
 *   - NDX-RTH 1m series = /NQ (back-adjusted) RTH 1m bars − that day's basis (NQ 16:00 close − official NDX close;
 *     basis.json for trade days, same formula for the warm-up days). ±10-30 pt noise intraday (pinned at 16:00).
 *   - NDX-RTH 15m / 60m BB(20,2)+9EMA are computed on RTH bars ONLY (prior sessions' RTH concatenated, no overnight),
 *     so the overnight gap is preserved. 60m candles are anchored at 09:30 (09:30-10:30 … 15:30-16:00).
 *   - The NDX daily file's OPEN is the opening-rotation print and lags (often ≈ prior close), so the GAP uses the derived
 *     NDX price at 09:30 (first RTH NQ bar open − basis). Prior close (pdC) and the settle are exact.
 *   - Lines are read from COMPLETED candles only (no look-ahead).
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
const DRAWS = +arg('--draws', 400);
const GAP_SIG = 0.25;          // |gap| ≥ 0.25σ(day) = gap day
const BIG_GAP_SIG = 0.75;
const NEUTRAL_SIG = 0.25;      // target within 0.25σ of spot = neutral (phase 4)
const TOUCH_TOL = 5;           // pts

const r0 = n => (n == null || !isFinite(n) ? null : Math.round(n));
const r1 = n => (n == null || !isFinite(n) ? null : Math.round(n * 10) / 10);
const r2 = n => (n == null || !isFinite(n) ? null : Math.round(n * 100) / 100);
const fin = x => x != null && isFinite(x);
const sum = a => a.reduce((x, y) => x + (y || 0), 0);
const mean = a => { const s = a.filter(fin); return s.length ? sum(s) / s.length : null; };
const median = a => { const s = a.filter(fin).sort((x, y) => x - y); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
let seed = 54321;
const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };

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
const tradeDates = T.days.map(d => d.date).sort();

// ── NDX daily (exact) ───────────────────────────────────────────────────────────────────────────────────
const etDate = ms => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const NDXD = (() => {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'sweeps', 'daily-bb-2026-10-15', 'daily-NDX.json'), 'utf8'));
  const ind = IND.withIndicators(raw.map(b => ({ datetime: b.datetime, open: b.open, high: b.high, low: b.low, close: b.close })));
  return ind.map(c => ({ date: etDate(c.datetime + 12 * 3600e3), o: c.open, h: c.high, l: c.low, c: c.close, bbU: c.bbUpper, bbM: c.bbMiddle, bbL: c.bbLower, ema9: c.ema9 }));
})();
const ndxIdx = new Map(NDXD.map((r, i) => [r.date, i]));
function dailyLevels(date) {
  const i = ndxIdx.get(date);
  if (i == null || i < 1) return null;
  const p = NDXD[i - 1], t = NDXD[i];
  return { dBBU: p.bbU, dBBM: p.bbM, dBBL: p.bbL, dEMA9: p.ema9, pdH: p.h, pdL: p.l, pdC: p.c, open: t.o, _today: t };
}

// ── NDX-RTH 1m (DERIVED: /NQ RTH − basis) from the raw NQ csv ───────────────────────────────────────────
if (!fs.existsSync(NQ_CSV)) { console.error(`NQ 1m csv not found: ${NQ_CSV} (pass --nq)`); process.exit(1); }
const firstNeed = NDXD[Math.max(0, ndxIdx.get(tradeDates[0]) - 12)].date;
const lastNeed = tradeDates[tradeDates.length - 1];
const rthRaw = new Map();   // iso -> [{min, o,h,l,c}] keyed by bar END minute-of-day (571..960)
{
  const text = fs.readFileSync(NQ_CSV, 'utf8');
  const toIso = mdY => { const [m, d, y] = mdY.split('/'); return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`; };
  let pos = 0;
  while (pos < text.length) {
    let nl = text.indexOf('\n', pos); if (nl < 0) nl = text.length;
    const line = text.slice(pos, nl); pos = nl + 1;
    const sp = line.indexOf(' ');
    if (sp < 0 || !/^\d/.test(line)) continue;
    const iso = toIso(line.slice(0, sp));
    if (iso < firstNeed || iso > lastNeed) continue;
    const f = line.split(',');
    const [hh, mm] = f[0].slice(sp + 1).split(':').map(Number);
    const m = hh * 60 + mm;
    if (m < 9 * 60 + 31 || m > 16 * 60) continue;     // bar-END labels 09:31..16:00 = RTH
    if (!rthRaw.has(iso)) rthRaw.set(iso, []);
    rthRaw.get(iso).push({ m, o: +f[1], h: +f[2], l: +f[3], c: +f[4] });
  }
}
const basisOf = (date) => {
  if (BASIS[date] && fin(BASIS[date].basis)) return BASIS[date].basis;
  const i = ndxIdx.get(date), bars = rthRaw.get(date);
  if (i == null || !bars) return null;
  const c16 = bars.find(b => b.m === 960);
  return c16 ? c16.c - NDXD[i].c : null;
};
const rthDays = [...rthRaw.keys()].filter(d => ndxIdx.has(d) && basisOf(d) != null).sort();
const rthBarsCache = new Map();
/** Derived NDX 1m RTH bars of one session: t = bar START ms. */
function rthBars(date) {
  if (!rthBarsCache.has(date)) {
    const raw = rthRaw.get(date), bs = basisOf(date);
    if (!raw || bs == null) { rthBarsCache.set(date, null); return null; }
    const t930 = H.etToMs(date, '09:30');
    rthBarsCache.set(date, raw.map(b => ({ t: t930 + (b.m - 571) * 60e3, o: b.o - bs, h: b.h - bs, l: b.l - bs, c: b.c - bs })).sort((a, b) => a.t - b.t));
  }
  return rthBarsCache.get(date);
}
// RTH-only 15m / 60m (09:30-anchored) series: 8 prior RTH sessions + this one
const resampleOff = (c1, min, offMin) => IND.resample(c1.map(c => ({ ...c, datetime: c.datetime - offMin * 60e3 })), min).map(c => ({ ...c, datetime: c.datetime + offMin * 60e3 }));
const rthSerCache = new Map();
function rthSeries(date, tf) {
  const k = `${date}|${tf}`;
  if (!rthSerCache.has(k)) {
    const i = rthDays.indexOf(date);
    if (i < 0) { rthSerCache.set(k, null); return null; }
    const days = rthDays.slice(Math.max(0, i - 8), i + 1);
    const c1 = days.flatMap(d => rthBars(d)).map(b => ({ datetime: b.t, open: b.o, high: b.h, low: b.l, close: b.c }));
    const cs = tf === '5m' ? IND.resample(c1, 5) : tf === '15m' ? IND.resample(c1, 15) : resampleOff(c1, 60, 30);
    rthSerCache.set(k, IND.withIndicators(cs).map(c => ({ t: c.datetime, o: c.open, h: c.high, l: c.low, c: c.close, bbU: c.bbUpper, bbM: c.bbMiddle, bbL: c.bbLower, ema9: c.ema9 })));
  }
  return rthSerCache.get(k);
}
// RTH 60m candles are 60 min except the 15:30 one (30 min); completion test uses the true end
const candleEnd = (tf, c) => { if (tf === '5m') return c.t + 5 * 60e3; if (tf === '15m') return c.t + 15 * 60e3; const e = c.t + 60 * 60e3; const close = H.etToMs(etDate(c.t), '16:00'); return Math.min(e, close); };

// ── /NQ 24h series (phase 4), NDX terms = NQ − basis(trade date) ────────────────────────────────────────
const nqCache = new Map();
function nqOf(date) {
  if (!nqCache.has(date)) { const p = path.join(DATA, 'market', 'nq-1m', `${date}.json`); nqCache.set(date, fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null); }
  return nqCache.get(date);
}
const nqSerCache = new Map();
function nqSeries(date, tf) {
  const k = `${date}|${tf}`;
  if (!nqSerCache.has(k)) {
    const nq = nqOf(date), bs = basisOf(date);
    nqSerCache.set(k, nq && bs != null ? H.tfSeries(nq.bars, tf, nq.warmup60m || []).map(c => ({ ...c, o: c.o - bs, h: c.h - bs, l: c.l - bs, c: c.c - bs, bbU: c.bbU - bs, bbM: c.bbM - bs, bbL: c.bbL - bs, ema9: c.ema9 - bs })) : null);
  }
  return nqSerCache.get(k);
}
const TFMS = { '5m': 5 * 60e3, '15m': 15 * 60e3, '60m': 60 * 60e3 };
/** Index of the last COMPLETED candle at ms. */
function lastDone(s, tf, ms, rth) {
  if (!s) return -1;
  let i = -1;
  for (let k = 0; k < s.length; k++) { const end = rth ? candleEnd(tf, s[k]) : s[k].t + TFMS[tf]; if (end <= ms) i = k; else break; }
  return i;
}

/** All candidate levels (NDX terms) at ms on trade date `date`. NQ-24h keys as phase 4; NDX-RTH keys prefixed 'r'. */
function levelsAt(date, ms) {
  const L = {};
  const dl = dailyLevels(date);
  if (dl) Object.assign(L, { dBBU: dl.dBBU, dBBM: dl.dBBM, dBBL: dl.dBBL, dEMA9: dl.dEMA9, pdH: dl.pdH, pdL: dl.pdL, pdC: dl.pdC, open: dl.open });
  const rb = rthBars(date);
  if (rb && rb.length) L.openD = rb[0].o;
  if (ms == null) return L;
  for (const tf of ['15m', '60m']) {
    const s = nqSeries(date, tf), i = lastDone(s, tf, ms, false);
    if (i >= 0 && fin(s[i].bbU)) { const c = s[i]; L[`${tf}BBU`] = c.bbU; L[`${tf}BBM`] = c.bbM; L[`${tf}BBL`] = c.bbL; L[`${tf}EMA9`] = c.ema9; }
    const r = rthSeries(date, tf), j = lastDone(r, tf, ms, true);
    if (j >= 0 && fin(r[j].bbU)) { const c = r[j]; L[`r${tf}BBU`] = c.bbU; L[`r${tf}BBM`] = c.bbM; L[`r${tf}BBL`] = c.bbL; L[`r${tf}EMA9`] = c.ema9; }
  }
  return L;
}
const EXACT = new Set(['dBBU', 'dBBM', 'dBBL', 'dEMA9', 'pdH', 'pdL', 'pdC', 'open']);
const LEVELS_A = ['pdC', 'open', 'openD', 'r15mBBM', 'r15mEMA9', '15mBBM', '15mEMA9', 'r60mBBM', 'r60mEMA9', '60mBBM', '60mEMA9',
  'r15mBBU', 'r15mBBL', '15mBBU', '15mBBL', 'r60mBBU', 'r60mBBL', '60mBBU', '60mBBL', 'pdH', 'pdL', 'dEMA9', 'round100'];

/** Trend state of one TF at ms with spot px (NDX terms). */
function trendState(s, tf, ms, px, rth) {
  const i = lastDone(s, tf, ms, rth);
  if (i < 2 || !fin(s[i].ema9) || !fin(s[i].bbU) || px == null) return null;
  const c = s[i], p = s[i - 1];
  const slope = c.ema9 - p.ema9;
  let consec = 0;
  for (let k = i; k > 0; k--) { const d = Math.sign(s[k].c - s[k - 1].c); if (!d) break; if (consec === 0) consec = d; else if (Math.sign(consec) === d) consec += d; else break; }
  const dir = px > c.ema9 && slope > 0 ? 'up' : px < c.ema9 && slope < 0 ? 'down' : 'mixed';
  return { pctB: (px - c.bbL) / (c.bbU - c.bbL), vsEma: px > c.ema9 ? 'above' : 'below', slope, consec, dir, mid: px > c.bbM ? 'above' : 'below' };
}
const agree = (dir, st) => (!st || (dir !== 'bull' && dir !== 'bear') || st.dir === 'mixed' ? 'mixed' : (dir === 'bull') === (st.dir === 'up') ? 'with' : 'against');
const combo = (a15, a60) => (a15 === 'against' || a60 === 'against' ? (a15 === 'with' || a60 === 'with' ? 'split (one with, one against)' : 'against (≥1 against, none with)') : a15 === 'with' && a60 === 'with' ? 'with both 15m+60m' : a15 === 'with' || a60 === 'with' ? 'with one (other mixed)' : 'both mixed');

// ── payoff shape (phase 4) ──────────────────────────────────────────────────────────────────────────────
function vAt(curve, x) {
  const P = curve.points;
  if (x <= P[0].x) return P[0].y;
  for (let i = 1; i < P.length; i++) if (x <= P[i].x) return P[i - 1].y + (P[i].y - P[i - 1].y) * (x - P[i - 1].x) / (P[i].x - P[i - 1].x);
  return P[P.length - 1].y;
}
function shape(curve, legs, S) {
  const ks = legs.map(l => l.strike);
  const kLo = Math.min(...ks), kHi = Math.max(...ks);
  const span = curve.points.filter(p => p.x >= kLo && p.x <= kHi);
  const pmax = Math.max(...span.map(p => p.y));
  const peakPts = span.filter(p => p.y >= pmax - 1).map(p => p.x);
  const xPeak = peakPts.reduce((b, x) => (Math.abs(x - (S != null ? S : x)) < Math.abs(b - (S != null ? S : b)) ? x : b), peakPts[0]);
  let pa = xPeak, pb = xPeak;
  const thr = pmax > 0 ? pmax * 0.9 : pmax - 1;
  while (pa - 1 >= curve.xMin && vAt(curve, pa - 1) >= thr) pa--;
  while (pb + 1 <= curve.xMax && vAt(curve, pb + 1) >= thr) pb++;
  const oLo = pa <= curve.xMin, oHi = pb >= curve.xMax;
  const target = oLo && oHi ? xPeak : oHi ? pa : oLo ? pb : (pa + pb) / 2;
  return { target, xPeak, plateauLo: pa, plateauHi: pb, max: pmax, min: curve.min };
}
const sideOf = (x, S, sg) => (!fin(x) || !fin(S) ? null : Math.abs(x - S) < NEUTRAL_SIG * (sg || 50) ? 'neutral' : x > S ? 'bull' : 'bear');

/** The order's own direction: verticals/singles by structure; flies/condors by body vs spot; else curve slope. */
function orderDir(o, S, sg, ownCurve) {
  if (o.style === 'vertical' || o.style === 'single') return o.direction;
  const ks = [...new Set(o.legs.map(l => l.strike))].sort((a, b) => a - b);
  if (/butterfly|condor/.test(o.style) && !o.style.startsWith('iron')) {
    if (o.direction === 'short') return 'neutral';
    const body = o.center != null ? o.center : ks.length === 4 ? (ks[1] + ks[2]) / 2 : (ks[0] + ks[ks.length - 1]) / 2;
    return sideOf(body, S, sg) || 'neutral';
  }
  if (S == null) return null;
  const m = Math.max(sg || 0, 25);
  const dd = vAt(ownCurve, S + m) - vAt(ownCurve, S - m);
  return Math.abs(dd) < 0.1 * Math.max(1, ownCurve.max - ownCurve.min) ? 'neutral' : dd > 0 ? 'bull' : 'bear';
}
const FLY = s => /butterfly|condor/.test(s);
const structOf = o => (o.style === 'vertical' ? `vertical ${o.debitCredit}` : o.style === 'asymmetric butterfly' ? 'asym fly' : o.style === 'butterfly' || o.style === 'broken-wing butterfly' ? 'fly/BW fly' : /condor/.test(o.style) ? 'condor' : o.style);
const todBucket = hm => (!hm ? null : hm < '10:30' ? '09:30-10:30' : hm < '12:00' ? '10:30-12:00' : hm < '14:00' ? '12:00-14:00' : '14:00-16:00');

// ── per day ─────────────────────────────────────────────────────────────────────────────────────────────
const dayRows = [], orderRows = [], targetRows = [], widthRows = [], basisCheck = [], ordCtx = [];
for (const day of T.days) {
  const D = day.date;
  const seq = H.bookOrders(day, byNo);
  if (!seq.length) continue;
  const dl = dailyLevels(D);
  const rb = rthBars(D);
  const dc = DAYCSV.get(D) || {};
  const ivBase = +dc.ivBase || null;
  const openD = rb && rb.length ? rb[0].o : null;
  const sigOpen = openD && ivBase ? openD * ivBase * Math.sqrt(6.5 * 3600e3 / BS.YEAR_MS) : null;
  const settle = day.settle, pnl = day.pnl.net;
  const pdC = dl ? dl.pdC : null;
  if (rb && dl) basisCheck.push({ D, dH: Math.max(...rb.map(b => b.h)) - dl._today.h, dL: Math.min(...rb.map(b => b.l)) - dl._today.l, dO: openD - dl._today.o, dC: rb[rb.length - 1].c - dl._today.c });

  // ── gap anatomy ──
  const gap = openD != null && pdC != null ? openD - pdC : null;
  const gapSig = fin(gap) && sigOpen ? gap / sigOpen : null;
  const gapCls = !fin(gapSig) ? 'n/a' : Math.abs(gapSig) < GAP_SIG ? 'flat' : `${Math.abs(gapSig) >= BIG_GAP_SIG ? 'big ' : ''}gap ${gapSig > 0 ? 'up' : 'down'}`;
  const gdir = fin(gapSig) && Math.abs(gapSig) >= GAP_SIG ? Math.sign(gapSig) : 0;
  const t930 = H.etToMs(D, '09:30');
  const r15 = rthSeries(D, '15m'), n15 = nqSeries(D, '15m');
  const at = (s, rth, ms) => { const i = lastDone(s, '15m', ms, rth); return i >= 0 ? s[i] : null; };
  const c0r = at(r15, true, t930 + 60e3), c0n = at(n15, false, t930 + 60e3);
  const g = { rMidOpen: c0r ? c0r.bbM : null, nMidOpen: c0n ? c0n.bbM : null, rEmaOpen: c0r ? c0r.ema9 : null, nEmaOpen: c0n ? c0n.ema9 : null };
  // first touch of pdC and of the NDX-RTH 15m BBM (completed-candle line), 1m derived path
  const firstTouch = (levelFn) => {
    if (!rb || !gdir) return null;
    for (const b of rb) {
      const L = levelFn(b.t); if (!fin(L)) continue;
      // the level sits on the gap-fill side; a touch = price trades back to it
      if (gdir > 0 ? b.l <= L + TOUCH_TOL : b.h >= L - TOUCH_TOL) return { t: b.t, L };
    }
    return null;
  };
  const midAt = (rth, key) => ms => { const s = rth ? r15 : n15; const c = at(s, rth, ms); return c ? c[key] : null; };
  const tPdc = firstTouch(() => pdC), tRMid = firstTouch(midAt(true, 'bbM')), tREma = firstTouch(midAt(true, 'ema9')), tNMid = firstTouch(midAt(false, 'bbM'));
  // held vs broke: the 15m RTH candles containing the touch and the next 2 — a CLOSE beyond the level (toward the fill) by >5 = break
  const holdOf = (tc, levelFn) => {
    if (!tc || !r15) return null;
    const k0 = r15.findIndex(c => c.t <= tc.t && c.t + 15 * 60e3 > tc.t);
    if (k0 < 0) return null;
    let broke = false;
    for (let k = k0; k < Math.min(r15.length, k0 + 3); k++) {
      const L = levelFn(r15[k].t + 15 * 60e3 - 1) ?? tc.L;
      if (gdir > 0 ? r15[k].c < L - TOUCH_TOL : r15[k].c > L + TOUCH_TOL) { broke = true; break; }
    }
    // bounce: best move back in the gap direction within 60 min of the touch
    const after = rb.filter(b => b.t >= tc.t && b.t < tc.t + 60 * 60e3);
    const bounce = after.length ? (gdir > 0 ? Math.max(...after.map(b => b.h)) - tc.L : tc.L - Math.min(...after.map(b => b.l))) : null;
    return { broke, bounce };
  };
  const hPdc = holdOf(tPdc, () => pdC), hRMid = holdOf(tRMid, midAt(true, 'bbM'));
  // how much of the gap had price retraced: within the first 60 min, and at the moment it met the RTH 15m mid
  const retrOf = (bars) => (!gdir || !bars.length || !gap ? null : (gdir > 0 ? openD - Math.min(...bars.map(b => b.l)) : Math.max(...bars.map(b => b.h)) - openD) / Math.abs(gap));
  const retr60 = rb ? retrOf(rb.filter(b => b.t < t930 + 60 * 60e3)) : null;
  const retrAtRMid = tRMid ? (gdir > 0 ? openD - tRMid.L : tRMid.L - openD) / Math.abs(gap) : null;
  const mins = tc => (tc ? Math.round((tc.t - t930) / 60e3) : null);
  const firstLvl = !gdir ? '' : !tPdc && !tRMid ? 'neither' : !tPdc ? 'RTH 15m mid' : !tRMid ? 'prior close' : tPdc.t < tRMid.t ? 'prior close' : tRMid.t < tPdc.t ? 'RTH 15m mid' : 'same minute';
  const firstHeld = firstLvl === 'prior close' ? hPdc : firstLvl === 'RTH 15m mid' ? hRMid : firstLvl === 'same minute' ? hPdc : null;
  const filledGap = gdir && fin(settle) ? (gdir > 0 ? settle <= pdC : settle >= pdC) : null;

  // ── book steps ──
  const allK = seq.flatMap(s => s.order.legs.map(l => l.strike));
  const lo = dl ? dl._today.l : settle, hi = dl ? dl._today.h : settle;
  const xMin = Math.floor((Math.min(...allK, lo, settle) - 300) / 10) * 10, xMax = Math.ceil((Math.max(...allK, hi, settle) + 300) / 10) * 10;
  const legsAcc = []; let cash = 0; let prev = null;
  const steps = [];
  seq.forEach(({ order: o, carried }, k) => {
    const oi = ORD.get(`${D}|${o.orderNo}`) || {};
    const S = fin(oi.spotEst) ? oi.spotEst : null, sg = fin(oi.sigmaPts) ? oi.sigmaPts : null;
    const ms = o.timeET ? H.etToMs(o.date, o.timeET) : null;
    const oLegs = H.orderLegs(o);
    const ownCurve = H.payoffCurve(B.netLegs(oLegs), o.total, xMin, xMax);
    const preShape = prev && prev.net.length ? shape(prev.curve, prev.net, S) : null;
    legsAcc.push(...oLegs); cash += o.total;
    const net = B.netLegs(legsAcc);
    const curve = H.payoffCurve(net, cash, xMin, xMax);
    const sh = net.length ? shape(curve, net, S) : null;
    const bias = preShape ? sideOf(preShape.target, S, sg) : 'none';
    const dir = orderDir(o, S, sg, ownCurve);
    let cat;
    if (o.effect && o.effect !== 'open') cat = 'close/restructure';
    else if (!preShape) cat = 'first';
    else if (dir !== 'bull' && dir !== 'bear') cat = 'neutral order';
    else if (bias === 'neutral' || bias == null) cat = 'tilt (book neutral)';
    else cat = dir === bias ? 'stack' : 'counter';
    const st = {};
    for (const tf of ['15m', '60m']) {
      st[`r${tf}`] = ms != null && S != null ? trendState(rthSeries(o.date, tf), tf, ms, S, true) : null;
      st[`n${tf}`] = ms != null && S != null ? trendState(nqSeries(o.date, tf), tf, ms, S, false) : null;
    }
    const lv = ms != null ? levelsAt(o.date, ms) : null;
    steps.push({ k, o, oi, carried, S, sg, ms, net, curve, sh, preShape, bias, dir, cat, st, lv });
    prev = { net, curve };
  });

  // ── per-order rows ──
  for (const s of steps) {
    const o = s.o, oi = s.oi;
    const a = {}; for (const key of ['r15m', 'r60m', 'n15m', 'n60m']) a[key] = agree(s.dir, s.st[key]);
    const hm = o.timeET ? o.timeET.slice(0, 5) : null;
    const row = {
      date: D, month: D.slice(0, 7), orderNo: o.orderNo, tradeDate: o.date, timeET: o.timeET || '', carried: s.carried ? 1 : 0, tod: s.carried ? 'carried' : todBucket(hm),
      style: o.style, struct: structOf(o), debitCredit: o.debitCredit, widths: (o.widths || []).join('/'), qty: o.qty, total: r0(o.total),
      spot: r1(s.S), sigma: r1(s.sg), preTarget: s.preShape ? r1(s.preShape.target) : null, preTargetVsSpotSig: s.preShape && s.sg ? r2((s.preShape.target - s.S) / s.sg) : null,
      bookBias: s.bias, orderDir: s.dir, cat: s.cat, role3: oi.role || '',
      postTarget: s.sh ? r1(s.sh.target) : null,
      gapCls, gapSig: r2(gapSig),
      ...Object.fromEntries(['r15m', 'r60m', 'n15m', 'n60m'].flatMap(key => { const x = s.st[key]; return [[`${key}_dir`, x ? x.dir : ''], [`${key}_pctB`, x ? r2(x.pctB) : null], [`${key}_slope`, x ? r1(x.slope) : null], [`${key}_consec`, x ? x.consec : null], [`${key}_agree`, a[key]]]; })),
      comboRTH: combo(a.r15m, a.r60m), comboNQ: combo(a.n15m, a.n60m),
      ownPnl: fin(oi.ownPnl) ? r0(oi.ownPnl) : null, dayPnl: r0(pnl),
      settleMoveDir: s.S != null ? (Math.abs(settle - s.S) < 1 ? 'flat' : settle > s.S ? 'bull' : 'bear') : '',
    };
    row.dirRight = (s.dir === 'bull' || s.dir === 'bear') && row.settleMoveDir ? (row.settleMoveDir === s.dir ? 1 : 0) : null;
    orderRows.push(row);
    ordCtx.push({ row, o, S: s.S, sg: s.sg, ms: s.ms, dir: s.dir, cat: s.cat, carried: s.carried, settle });

    // width rows: verticals (1 row) and fly/condor wings (1 row per wing)
    if (s.S != null && s.sg && !s.carried && (o.effect || 'open') === 'open') {
      const base = { date: D, month: row.month, orderNo: o.orderNo, timeET: o.timeET, tod: row.tod, struct: row.struct, cat: s.cat, gapDay: gdir ? 1 : 0, sigma: s.sg,
        comboRTH: row.comboRTH, comboNQ: row.comboNQ, ownPnl: row.ownPnl, dirRight: row.dirRight, qty: o.qty, total: o.total, dayPnl: pnl };
      if (o.style === 'vertical') {
        const sh = o.legs.find(l => l.side === 'short'), ln = o.legs.find(l => l.side === 'long');
        const shortOtm = s.dir === 'bull' ? sh.strike - s.S : s.S - sh.strike;     // + = short strike OTM in the profit direction
        widthRows.push({ ...base, wing: 'vertical', width: Math.abs(sh.strike - ln.strike), shortOtmSig: shortOtm / s.sg, shortDistSig: Math.abs(sh.strike - s.S) / s.sg });
      } else if (FLY(o.style) && !o.style.startsWith('iron') && o.widths && o.widths.length) {
        const ks = [...new Set(o.legs.map(l => l.strike))].sort((x, y) => x - y);
        const body = o.center != null ? o.center : ks.length === 4 ? (ks[1] + ks[2]) / 2 : (ks[0] + ks[ks.length - 1]) / 2;
        const ws = o.widths.length === 3 ? [o.widths[0], o.widths[2]] : o.widths;
        ws.forEach((w, j) => widthRows.push({ ...base, wing: j === 0 ? 'fly lower wing' : 'fly upper wing', width: w, shortOtmSig: null, shortDistSig: Math.abs(body - s.S) / s.sg }));
      }
    }

    // target strikes (phase 4 kinds) with the level snapshot
    if (s.ms != null && s.S != null && s.sh && s.lv) {
      const add = (kind, K) => targetRows.push({ date: D, tradeDate: o.date, orderNo: o.orderNo, timeET: o.timeET, hr: (s.ms - H.etToMs(o.date, '09:30')) / 3600e3, kind, K, S: s.S, sg: s.sg, lv: s.lv, gapDay: !!gdir && o.date === D });
      const ks = [...new Set(o.legs.map(l => l.strike))].sort((x, y) => x - y);
      if (oi.flyKind) { if (o.center != null) add('flyBody', o.center); else if (ks.length === 4) { add('flyBody', ks[1]); add('flyBody', ks[2]); } }
      else if (o.style === 'vertical') { const sh = o.legs.find(l => l.side === 'short'); if (sh) add('shortStrike', sh.strike); }
      const pv = steps[s.k - 1];
      if (!pv || !pv.sh || pv.sh.xPeak !== s.sh.xPeak) add('bookPeak', s.sh.xPeak);
    }
  }

  // ── positioning on the day (gap days: toward the fill vs with the gap) ──
  const today = steps.filter(s => !s.carried && s.S != null && s.sg && s.sh);
  const firstT = today[0] || null;
  const asOf = hm => { const ms = H.etToMs(D, hm); return steps.filter(s => s.sh && (s.carried || (s.ms != null && s.ms <= ms))).pop() || null; };
  const s1030 = asOf('10:30'), sLast = steps[steps.length - 1];
  const posOf = (st, refS, refSg) => { if (!st || !st.sh || !fin(refS)) return ''; const sd = sideOf(st.sh.target, refS, refSg); if (!gdir) return sd; if (sd === 'neutral') return 'neutral'; return (sd === 'bull') === (gdir > 0) ? 'with gap' : 'toward fill'; };
  const refS = firstT ? firstT.S : openD, refSg = firstT ? firstT.sg : sigOpen;
  const dirOrders = today.filter(s => s.ms != null && s.ms < t930 + 60 * 60e3 && (s.dir === 'bull' || s.dir === 'bear'));
  const netFirstHour = sum(dirOrders.map(s => (s.dir === 'bull' ? 1 : -1)));
  // which level was the first target near: pdC vs RTH mid vs NQ mid (at the first order)
  const nearest = (K, lv) => { const c = [['pdC', lv.pdC], ['RTH15mMid', lv.r15mBBM], ['RTH15m9EMA', lv.r15mEMA9], ['NQ15mMid', lv['15mBBM']], ['NQ15m9EMA', lv['15mEMA9']]].filter(([, v]) => fin(v)).map(([n, v]) => [n, Math.abs(K - v)]).sort((x, y) => x[1] - y[1]); return c.length ? `${c[0][0]} (${Math.round(c[0][1])})` : ''; };
  const stacks = steps.filter(s => s.cat === 'stack'), counters = steps.filter(s => s.cat === 'counter');
  dayRows.push({
    date: D, month: D.slice(0, 7), pnl: r0(pnl), orders: steps.length, pdC: r1(pdC), openDaily: r1(dl && dl._today.o), openDerived: r1(openD), gapPts: r0(gap), sigOpen: r0(sigOpen), gapSig: r2(gapSig), gapCls,
    rMidAtOpen: r1(g.rMidOpen), nMidAtOpen: r1(g.nMidOpen), openMinusRMid: r0(fin(g.rMidOpen) && openD ? openD - g.rMidOpen : null), openMinusNMid: r0(fin(g.nMidOpen) && openD ? openD - g.nMidOpen : null),
    rEmaAtOpen: r1(g.rEmaOpen), nEmaAtOpen: r1(g.nEmaOpen),
    touchPdcMin: mins(tPdc), touchRMidMin: mins(tRMid), touchREmaMin: mins(tREma), touchNMidMin: mins(tNMid), firstLevel: firstLvl,
    pdcHeld: hPdc ? (hPdc.broke ? 'broke' : 'held') : '', pdcBounce: r0(hPdc && hPdc.bounce), rMidHeld: hRMid ? (hRMid.broke ? 'broke' : 'held') : '', rMidBounce: r0(hRMid && hRMid.bounce),
    retr60Pct: r2(retr60), retrAtRMidTouchPct: r2(retrAtRMid),
    firstLevelHeld: firstHeld ? (firstHeld.broke ? 'broke' : 'held') : '', settle: r1(settle), settleFilledGap: filledGap == null ? '' : filledGap ? 'Y' : 'N',
    settleVsOpenSig: r2(openD && sigOpen ? (settle - openD) / sigOpen : null),
    firstET: firstT ? firstT.o.timeET : '', posFirst: posOf(firstT, refS, refSg), pos1030: posOf(s1030, refS, refSg), posFinal: posOf(sLast, refS, refSg),
    firstTarget: firstT ? r1(firstT.sh.target) : null, firstTargetNear: firstT && firstT.lv ? nearest(firstT.sh.target, firstT.lv) : '',
    netDirFirstHour: netFirstHour, stacks: stacks.length, counters: counters.length,
    stacksWithRTH: stacks.filter(s => /^with/.test(combo(agree(s.dir, s.st.r15m), agree(s.dir, s.st.r60m)))).length,
    stacksPnl: r0(sum(stacks.map(s => s.oi.ownPnl))), countersPnl: r0(sum(counters.map(s => s.oi.ownPnl))),
  });
}

// ── level hit tables (phase 4 method, extended) ────────────────────────────────────────────────────────
const roundDist = (x, m) => { const r = ((x % m) + m) % m; return Math.min(r, m - r); };
const levelDist = (K, lv, t) => (t === 'round100' ? roundDist(K, 100) : fin(lv[t]) ? Math.abs(K - lv[t]) : null);
function nullHits(rows, t, tol) {
  let hA = 0, nA = 0, hB = 0, nB = 0;
  for (const r of rows) {
    const d = Math.abs(r.K - r.S);
    for (let i = 0; i < DRAWS / 4; i++) {
      const K2 = Math.round((r.S + (rnd() < 0.5 ? -1 : 1) * d + (rnd() * 50 - 25)) / 10) * 10;
      const x = levelDist(K2, r.lv, t); if (x != null) { nA++; if (x <= tol) hA++; }
      if (t === 'round100') continue;
      const o = rows[Math.floor(rnd() * rows.length)];
      if (!fin(o.lv[t])) continue;
      nB++; if (Math.abs(r.K - (o.lv[t] - o.S + r.S)) <= tol) hB++;
    }
  }
  return { a: nA ? hA / nA : null, b: nB ? hB / nB : null };
}
function hitTable(rows, types = LEVELS_A) {
  return types.map(t => {
    const ds = rows.map(r => levelDist(r.K, r.lv, t)).filter(fin);
    if (!ds.length) return null;
    const h20 = ds.filter(d => d <= 20).length / ds.length;
    const n20 = nullHits(rows, t, 20);
    return { t, n: ds.length, med: median(ds), h10: ds.filter(d => d <= 10).length / ds.length, h20, n20a: n20.a, n20b: n20.b, lift20a: n20.a ? h20 / n20.a : null, lift20b: n20.b ? h20 / n20.b : null, hits: Math.round(h20 * ds.length) };
  }).filter(Boolean);
}

// ── report ──────────────────────────────────────────────────────────────────────────────────────────────
const fmt = (v, d = 0) => (v == null || !isFinite(v) ? '—' : (+v).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d }));
const pct = v => (v == null || !isFinite(v) ? '—' : `${Math.round(v * 100)}%`);
const md = (head, rows) => `| ${head.join(' | ')} |\n|${head.map(() => '---').join('|')}|\n${rows.map(r => `| ${r.join(' | ')} |`).join('\n')}\n`;
const toCsv = (rows) => { const h = Object.keys(rows[0]); const q = v => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v)); return [h.join(','), ...rows.map(r => h.map(k => q(r[k])).join(','))].join('\n') + '\n'; };
const LABEL = { pdC: 'prior NDX close', open: 'open (daily file, lags)', openD: 'open (derived 09:30)', r15mBBM: 'NDX-RTH 15m mid', r15mEMA9: 'NDX-RTH 15m 9EMA', '15mBBM': 'NQ-24h 15m mid', '15mEMA9': 'NQ-24h 15m 9EMA',
  r60mBBM: 'NDX-RTH 60m mid', r60mEMA9: 'NDX-RTH 60m 9EMA', '60mBBM': 'NQ-24h 60m mid', '60mEMA9': 'NQ-24h 60m 9EMA', r15mBBU: 'NDX-RTH 15m upper', r15mBBL: 'NDX-RTH 15m lower', '15mBBU': 'NQ-24h 15m upper', '15mBBL': 'NQ-24h 15m lower',
  r60mBBU: 'NDX-RTH 60m upper', r60mBBL: 'NDX-RTH 60m lower', '60mBBU': 'NQ-24h 60m upper', '60mBBL': 'NQ-24h 60m lower', pdH: 'prior high', pdL: 'prior low', dEMA9: 'daily 9EMA', round100: 'round 100' };
const src = t => (EXACT.has(t) || t === 'round100' ? 'exact' : t.startsWith('r') ? 'DERIVED ±basis' : t === 'openD' ? 'DERIVED' : '±basis');
const OUTL = new Set(['2025-05-21', '2025-06-23']);
const dOf = r => r.date || (r.c && r.c.row.date);
const grpStats = (a, f = r => r.ownPnl) => [a.length, fmt(sum(a.map(f))), fmt(mean(a.map(f))), pct(a.filter(r => f(r) > 0).length / (a.length || 1)), fmt(sum(a.filter(r => !OUTL.has(dOf(r))).map(f)))];

const S = [];
const bc = basisCheck;
S.push(`Sample: ${dayRows.length} days, ${orderRows.length} book orders, ${targetRows.length} target strikes, ${widthRows.length} width rows. One trader, one up-trending regime: every split is directional evidence, not significance. Order P&L = the order's own expiry P&L at the official settle (real fills, from orders.json); day P&L real.\n`);
S.push(`DERIVED NDX-RTH series check vs the exact NDX daily bar (derived − exact, median |x| / max |x| pts): high ${fmt(median(bc.map(x => Math.abs(x.dH))))}/${fmt(Math.max(...bc.map(x => Math.abs(x.dH))))}, low ${fmt(median(bc.map(x => Math.abs(x.dL))))}/${fmt(Math.max(...bc.map(x => Math.abs(x.dL))))}, 16:00 close ${fmt(median(bc.map(x => Math.abs(x.dC))), 1)} (pinned by construction), daily-file open vs derived 09:30 ${fmt(median(bc.map(x => Math.abs(x.dO))))}/${fmt(Math.max(...bc.map(x => Math.abs(x.dO))))} (the daily open lags — the gap uses the derived open).\n`);

// A. levels
const tr = targetRows;
S.push('## A. Levels used more than chance (adds prior close + NDX-RTH lines)\n');
const tblA = (rows) => md(['level', 'source', 'n', 'median |K−L|', 'hit ±10', 'hit ±20', 'null A ±20', 'null B ±20 (placebo)', 'lift vs B', 'hits ±20'],
  hitTable(rows).sort((a, b) => (b.lift20b || b.lift20a || 0) - (a.lift20b || a.lift20a || 0)).map(h => [LABEL[h.t] || h.t, src(h.t), h.n, fmt(h.med), pct(h.h10), pct(h.h20), pct(h.n20a), pct(h.n20b), fmt(h.lift20b, 2), h.hits]));
S.push('### A1. All target strikes pooled (book peaks + fly bodies + vertical short strikes)\n');
S.push(tblA(tr));
S.push(`Kinds: ${Object.entries(tr.reduce((a, r) => (a[r.kind] = (a[r.kind] || 0) + 1, a), {})).map(([k, v]) => `${k} ${v}`).join(', ')}. Null B borrows another order's level-vs-spot offset (the honest test); lift < ~1.2 or < ~15 hits is noise at this n.\n`);
for (const [name, f] of [['book peaks (the target)', r => r.kind === 'bookPeak'], ['fly bodies', r => r.kind === 'flyBody'], ['vertical short strikes', r => r.kind === 'shortStrike'], ['GAP days, before 12:00 (where NDX-RTH and NQ lines differ most)', r => r.gapDay && r.hr < 2.5], ['non-gap days', r => !r.gapDay]]) {
  const rows = tr.filter(f);
  S.push(`### A. ${name} (n=${rows.length}) — key levels\n`);
  const keep = ['pdC', 'openD', 'r15mBBM', 'r15mEMA9', '15mBBM', '15mEMA9', 'r60mBBM', 'r60mEMA9', '60mBBM', '60mEMA9'];
  S.push(md(['level', 'source', 'hit ±20', 'null B ±20', 'lift vs B', 'hits'], hitTable(rows, keep).map(h => [LABEL[h.t], src(h.t), pct(h.h20), pct(h.n20b), fmt(h.lift20b, 2), h.hits])));
}
// head to head
S.push('### A2. Head-to-head: is the strike closer to the NDX-RTH line or the NQ-24h line? (only where the two lines are ≥20 pts apart)\n');
const h2h = (rows, a, b) => { const x = rows.filter(r => fin(r.lv[a]) && fin(r.lv[b]) && Math.abs(r.lv[a] - r.lv[b]) >= 20); const wa = x.filter(r => Math.abs(r.K - r.lv[a]) < Math.abs(r.K - r.lv[b])).length; return [x.length, wa, x.length - wa, pct(x.length ? wa / x.length : null)]; };
// null for head-to-head: same-distance random strike (null A geometry)
const h2hNull = (rows, a, b) => { const x = rows.filter(r => fin(r.lv[a]) && fin(r.lv[b]) && Math.abs(r.lv[a] - r.lv[b]) >= 20); let w = 0, n = 0; for (const r of x) for (let i = 0; i < 100; i++) { const K2 = Math.round((r.S + (rnd() < 0.5 ? -1 : 1) * Math.abs(r.K - r.S) + (rnd() * 50 - 25)) / 10) * 10; n++; if (Math.abs(K2 - r.lv[a]) < Math.abs(K2 - r.lv[b])) w++; } return pct(n ? w / n : null); };
S.push(md(['strikes', 'pair (RTH vs NQ)', 'n (lines ≥20 apart)', 'closer to RTH', 'closer to NQ', 'RTH share', 'null RTH share (random strike same dist)', 'median line gap pts'],
  [['all targets', tr], ['book peaks', tr.filter(r => r.kind === 'bookPeak')], ['fly bodies', tr.filter(r => r.kind === 'flyBody')], ['short strikes', tr.filter(r => r.kind === 'shortStrike')]].flatMap(([n, rows]) =>
    [['r15mBBM', '15mBBM'], ['r15mEMA9', '15mEMA9'], ['r60mEMA9', '60mEMA9']].map(([a, b]) => [n, `${LABEL[a]} vs ${LABEL[b]}`, ...h2h(rows, a, b), h2hNull(rows, a, b), fmt(median(rows.filter(r => fin(r.lv[a]) && fin(r.lv[b]) && Math.abs(r.lv[a] - r.lv[b]) >= 20).map(r => Math.abs(r.lv[a] - r.lv[b]))))]))));
S.push('Line-distance guide: the two 15m lines only differ in the first hours after a gap (RTH bands still hold yesterday\'s afternoon); later in the day they converge.\n');

// B. gaps
const DR = dayRows;
S.push('## B. Gaps: prior close vs NDX-RTH 15m centerline\n');
S.push(md(['gap class (|gap| vs σ day)', 'days', 'median gap pts', 'median |open − RTH 15m mid| at open', 'median |open − NQ 15m mid| at open', 'win %', 'P&L'],
  ['big gap up', 'gap up', 'flat', 'gap down', 'big gap down'].map(c => { const a = DR.filter(r => r.gapCls === c); return a.length ? [c, a.length, fmt(median(a.map(r => r.gapPts))), fmt(median(a.map(r => Math.abs(r.openMinusRMid)))), fmt(median(a.map(r => Math.abs(r.openMinusNMid)))), pct(a.filter(r => r.pnl > 0).length / a.length), fmt(sum(a.map(r => r.pnl)))] : null; }).filter(Boolean)));
S.push(`Gap = derived NDX 09:30 − exact prior close; σ day = implied full-session move at the open. Gap day = |gap| ≥ ${GAP_SIG}σ, big ≥ ${BIG_GAP_SIG}σ.\n`);
const GD = DR.filter(r => r.gapCls.includes('gap'));
S.push('### B1. Which level did price reach first (1m derived path), and did it hold?\n');
S.push(md(['first level reached', 'days', 'median minutes after open', 'held (no 15m close through it in 45 min)', 'median bounce in 60 min (pts)', 'settle filled the gap', 'win %', 'P&L'],
  ['prior close', 'RTH 15m mid', 'same minute', 'neither'].map(k => { const a = GD.filter(r => r.firstLevel === k); if (!a.length) return null; const m = k === 'prior close' || k === 'same minute' ? a.map(r => r.touchPdcMin) : k === 'RTH 15m mid' ? a.map(r => r.touchRMidMin) : []; const b = k === 'RTH 15m mid' ? a.map(r => r.rMidBounce) : a.map(r => r.pdcBounce);
    return [k, a.length, fmt(median(m)), k === 'neither' ? '—' : `${a.filter(r => r.firstLevelHeld === 'held').length}/${a.length}`, k === 'neither' ? '—' : fmt(median(b)), `${a.filter(r => r.settleFilledGap === 'Y').length}/${a.length}`, pct(a.filter(r => r.pnl > 0).length / a.length), fmt(sum(a.map(r => r.pnl)))]; }).filter(Boolean)));
S.push(md(['level', 'gap days touched', 'median min after open', 'held', 'broke', 'median bounce 60m (pts)'], [
  ['prior close (exact level, derived path)', GD.filter(r => r.touchPdcMin != null).length, fmt(median(GD.map(r => r.touchPdcMin))), GD.filter(r => r.pdcHeld === 'held').length, GD.filter(r => r.pdcHeld === 'broke').length, fmt(median(GD.map(r => r.pdcBounce)))],
  ['NDX-RTH 15m mid', GD.filter(r => r.touchRMidMin != null).length, fmt(median(GD.map(r => r.touchRMidMin))), GD.filter(r => r.rMidHeld === 'held').length, GD.filter(r => r.rMidHeld === 'broke').length, fmt(median(GD.map(r => r.rMidBounce)))],
  ['NDX-RTH 15m 9EMA', GD.filter(r => r.touchREmaMin != null).length, fmt(median(GD.map(r => r.touchREmaMin))), '', '', ''],
  ['NQ-24h 15m mid', GD.filter(r => r.touchNMidMin != null).length, fmt(median(GD.map(r => r.touchNMidMin))), '', '', ''],
]));
S.push(`Gap retracement: median max retrace in the first 60 min = ${pct(median(GD.map(r => r.retr60Pct)))} of the gap (≥50% on ${GD.filter(r => r.retr60Pct >= 0.5).length}/${GD.length} days, ≥100% on ${GD.filter(r => r.retr60Pct >= 1).length}). When price met the RTH 15m mid it had retraced a median ${pct(median(GD.map(r => r.retrAtRMidTouchPct)))} of the gap (<25% on ${GD.filter(r => fin(r.retrAtRMidTouchPct) && r.retrAtRMidTouchPct < 0.25).length}/${GD.filter(r => fin(r.retrAtRMidTouchPct)).length} days = the LINE came to price, not a retrace).\n`);
S.push('Touch = a 1m derived NDX bar trades within 5 pts of the level on the gap-fill side (lines from completed 15m candles). Held/broke uses 15m RTH closes; ±10-30 pt basis noise means a "touch" of the exact prior close can be off by that much.\n');
S.push('### B2. How the user positioned on gap days (book target vs first-order spot)\n');
const posT = key => md(['positioning', 'days', 'win %', 'P&L', 'median P&L', 'gap filled at settle'],
  ['toward fill', 'with gap', 'neutral'].map(k => { const a = GD.filter(r => r[key] === k); return a.length ? [k, a.length, pct(a.filter(r => r.pnl > 0).length / a.length), fmt(sum(a.map(r => r.pnl))), fmt(median(a.map(r => r.pnl))), `${a.filter(r => r.settleFilledGap === 'Y').length}/${a.length}`] : null; }).filter(Boolean));
S.push('At the FIRST order:\n'); S.push(posT('posFirst'));
S.push('Book as of 10:30:\n'); S.push(posT('pos1030'));
S.push('Final book:\n'); S.push(posT('posFinal'));
S.push(md(['positioning (final) × gap filled at settle', 'days', 'P&L'], ['toward fill', 'with gap', 'neutral'].flatMap(k => ['Y', 'N'].map(f => { const a = GD.filter(r => r.posFinal === k && r.settleFilledGap === f); return [`${k} / filled ${f}`, a.length, fmt(sum(a.map(r => r.pnl)))]; }))));
S.push('First target nearest level (gap days): ' + Object.entries(GD.reduce((a, r) => { const k = (r.firstTargetNear || '').split(' ')[0] || 'n/a'; a[k] = (a[k] || 0) + 1; return a; }, {})).map(([k, v]) => `${k} ${v}`).join(', ') + '\n');
S.push('### B3. Per gap day\n');
S.push(md(['date', 'P&L', 'gap', 'σ', 'gap σ', 'open−RTH mid', 'open−NQ mid', 'first level', 'min', 'held', 'pdC touch min', 'RTH mid touch min', 'filled@settle', 'pos first', 'pos final', 'first tgt near'],
  GD.map(r => [r.date, fmt(r.pnl), fmt(r.gapPts), fmt(r.sigOpen), fmt(r.gapSig, 2), fmt(r.openMinusRMid), fmt(r.openMinusNMid), r.firstLevel, r.firstLevel === 'RTH 15m mid' ? r.touchRMidMin : r.firstLevel === 'neither' ? '—' : r.touchPdcMin, r.firstLevelHeld || '—', r.touchPdcMin ?? '—', r.touchRMidMin ?? '—', r.settleFilledGap, r.posFirst, r.posFinal, r.firstTargetNear])));

// C. stacking
const OR = orderRows;
S.push('## C. Stacking (adds in the book\'s bias direction) and counters\n');
S.push('Book bias = side of the pre-order book target (phase 4 shape) vs spot, neutral within 0.25σ. Order direction = vertical/single structure; fly/condor = body side vs spot. stack = same side as the bias; counter = opposite side (hedge/offset).\n');
S.push(md(['category', 'orders', 'own P&L', 'mean', 'win %', 'P&L excl 05-21/06-23', 'right direction at settle', 'May n', 'May P&L', 'May win%', 'Jun n', 'Jun P&L', 'Jun win%'],
  ['first', 'stack', 'counter', 'tilt (book neutral)', 'neutral order', 'close/restructure'].map(c => { const a = OR.filter(r => r.cat === c); const m = OR.filter(r => r.cat === c && r.month === '2025-05'), j = OR.filter(r => r.cat === c && r.month === '2025-06');
    return [c, ...grpStats(a), pct(mean(a.map(r => r.dirRight))), m.length, fmt(sum(m.map(r => r.ownPnl))), pct(m.filter(r => r.ownPnl > 0).length / (m.length || 1)), j.length, fmt(sum(j.map(r => r.ownPnl))), pct(j.filter(r => r.ownPnl > 0).length / (j.length || 1))]; })));
const stk = OR.filter(r => r.cat === 'stack'), ctr = OR.filter(r => r.cat === 'counter');
const COMBOS = ['with both 15m+60m', 'with one (other mixed)', 'both mixed', 'split (one with, one against)', 'against (≥1 against, none with)'];
for (const [name, key] of [['NDX-RTH', 'comboRTH'], ['NQ-24h', 'comboNQ']]) {
  S.push(`### C1. Stacks by ${name} 15m/60m trend agreement (trend = price vs 9EMA AND 9EMA slope agree)\n`);
  S.push(md(['trend vs stack', 'stacks', 'own P&L', 'mean', 'win %', 'P&L excl 05-21/06-23', 'right dir at settle', 'days', 'May n / P&L / win', 'Jun n / P&L / win'],
    COMBOS.map(c => { const a = stk.filter(r => r[key] === c); if (!a.length) return null; const m = a.filter(r => r.month === '2025-05'), j = a.filter(r => r.month === '2025-06');
      return [c, ...grpStats(a), pct(mean(a.map(r => r.dirRight))), new Set(a.map(r => r.date)).size, `${m.length} / ${fmt(sum(m.map(r => r.ownPnl)))} / ${pct(m.filter(r => r.ownPnl > 0).length / (m.length || 1))}`, `${j.length} / ${fmt(sum(j.map(r => r.ownPnl)))} / ${pct(j.filter(r => r.ownPnl > 0).length / (j.length || 1))}`]; }).filter(Boolean)));
}
S.push('### C2. Stacks: single-TF agreement (NDX-RTH vs NQ-24h)\n');
S.push(md(['TF / source', 'with: n', 'with: P&L', 'with: win%', 'with: right dir', 'against: n', 'against: P&L', 'against: win%', 'against: right dir', 'mixed: n', 'mixed: P&L'],
  [['15m NDX-RTH', 'r15m_agree'], ['15m NQ-24h', 'n15m_agree'], ['60m NDX-RTH', 'r60m_agree'], ['60m NQ-24h', 'n60m_agree']].map(([n, k]) => { const w = stk.filter(r => r[k] === 'with'), a = stk.filter(r => r[k] === 'against'), m = stk.filter(r => r[k] === 'mixed');
    return [n, w.length, fmt(sum(w.map(r => r.ownPnl))), pct(w.filter(r => r.ownPnl > 0).length / (w.length || 1)), pct(mean(w.map(r => r.dirRight))), a.length, fmt(sum(a.map(r => r.ownPnl))), pct(a.filter(r => r.ownPnl > 0).length / (a.length || 1)), pct(mean(a.map(r => r.dirRight))), m.length, fmt(sum(m.map(r => r.ownPnl)))]; })));
S.push('### C3. Stack trend state (medians): RTH 15m %B, consecutive closes, 9EMA slope\n');
const stState = (a, p) => [fmt(median(a.map(r => r[`${p}15m_pctB`])), 2), fmt(median(a.map(r => (r.orderDir === 'bear' ? -1 : 1) * r[`${p}15m_consec`])), 1), fmt(median(a.map(r => (r.orderDir === 'bear' ? -1 : 1) * r[`${p}15m_slope`])), 1), fmt(median(a.map(r => (r.orderDir === 'bear' ? -1 : 1) * r[`${p}60m_slope`])), 1)];
S.push(md(['group', 'n', 'RTH 15m %B', 'RTH 15m consec (signed to stack dir)', 'RTH 15m 9EMA slope (signed)', 'RTH 60m slope (signed)', 'NQ 15m %B', 'NQ consec', 'NQ 15m slope', 'NQ 60m slope'],
  [['stacks, own P&L > 0', stk.filter(r => r.ownPnl > 0)], ['stacks, own P&L ≤ 0', stk.filter(r => r.ownPnl <= 0)], ['bull stacks', stk.filter(r => r.orderDir === 'bull')], ['bear stacks', stk.filter(r => r.orderDir === 'bear')], ['counters', ctr]].map(([n, a]) => [n, a.length, ...stState(a, 'r'), ...stState(a, 'n')])));
S.push('### C4. Counters (adds AGAINST the book bias): trend at the time, relative to the COUNTER order\n');
S.push(md(['RTH 15m/60m vs the counter order', 'counters', 'own P&L', 'mean', 'win %', 'P&L excl 05-21/06-23', 'right dir at settle', 'day P&L sum (unique days)'],
  COMBOS.map(c => { const a = ctr.filter(r => r.comboRTH === c); if (!a.length) return null; const days = [...new Set(a.map(r => r.date))]; return [c, ...grpStats(a), pct(mean(a.map(r => r.dirRight))), fmt(sum(days.map(d => DR.find(x => x.date === d).pnl)))]; }).filter(Boolean)));
S.push('### C5. Day level: share of stacks with RTH trend (≥1 TF with, none against) vs day P&L\n');
const dayStack = DR.filter(r => r.stacks >= 2).map(r => ({ ...r, share: r.stacksWithRTH / r.stacks }));
S.push(md(['days with ≥2 stacks', 'days', 'win %', 'P&L', 'stacks P&L', 'counters P&L'], [['≥50% of stacks with trend', dayStack.filter(r => r.share >= 0.5)], ['<50% with trend', dayStack.filter(r => r.share < 0.5)]].map(([n, a]) => [n, a.length, pct(a.filter(r => r.pnl > 0).length / (a.length || 1)), fmt(sum(a.map(r => r.pnl))), fmt(sum(a.map(r => r.stacksPnl))), fmt(sum(a.map(r => r.countersPnl)))])));

// D. width
const W = widthRows.map(r => ({ ...r, wSig: r.width / r.sigma }));
const wb = x => (x < 0.2 ? '<0.20σ' : x < 0.35 ? '0.20-0.35σ' : x < 0.6 ? '0.35-0.60σ' : '≥0.60σ');
S.push('## D. Width (verticals: width; flies/condors: each wing)\n');
S.push(`Width/σ uses the order's own implied move to the close (sigmaPts, backed out of the user's fills — ESTIMATE). n = ${W.length} (${W.filter(r => r.wing === 'vertical').length} verticals, ${W.filter(r => r.wing !== 'vertical').length} fly wings).\n`);
const wTab = (name, keyFn, keys) => md([name, 'n', 'median width pts', 'median width/σ', 'share <0.35σ', 'share ≥0.60σ', 'own P&L', 'win %'],
  keys.map(k => { const a = W.filter(r => keyFn(r) === k); if (!a.length) return null; const ords = [...new Map(a.map(r => [r.orderNo, r])).values()]; return [k, a.length, fmt(median(a.map(r => r.width))), fmt(median(a.map(r => r.wSig)), 2), pct(a.filter(r => r.wSig < 0.35).length / a.length), pct(a.filter(r => r.wSig >= 0.6).length / a.length), fmt(sum(ords.map(r => r.ownPnl))), pct(ords.filter(r => r.ownPnl > 0).length / ords.length)]; }).filter(Boolean));
S.push('### D1. Width by context (verticals + fly wings)\n');
S.push(wTab('month', r => r.month, ['2025-04', '2025-05', '2025-06', '2025-07']));
S.push(wTab('time of day', r => r.tod, ['09:30-10:30', '10:30-12:00', '12:00-14:00', '14:00-16:00']));
S.push(wTab('structure', r => r.struct, ['vertical debit', 'vertical credit', 'fly/BW fly', 'asym fly', 'condor']));
S.push(wTab('order category', r => r.cat, ['first', 'stack', 'counter', 'tilt (book neutral)', 'neutral order']));
S.push(wTab('gap day', r => (r.gapDay ? 'gap day' : 'flat open'), ['gap day', 'flat open']));
S.push(wTab('σ (implied move) bucket', r => (r.sigma < 100 ? 'σ <100' : r.sigma < 140 ? 'σ 100-140' : r.sigma < 180 ? 'σ 140-180' : 'σ ≥180'), ['σ <100', 'σ 100-140', 'σ 140-180', 'σ ≥180']));
S.push(wTab('stacks: NDX-RTH trend', r => (r.cat === 'stack' ? r.comboRTH : null), COMBOS));
S.push('### D2. Verticals: width vs distance from spot to the SHORT strike (σ; + = short strike OTM in the profit direction)\n');
const V = W.filter(r => r.wing === 'vertical');
const db = x => (x < -0.25 ? 'ITM >0.25σ' : x < 0.1 ? 'near spot (−0.25..0.10σ)' : x < 0.4 ? '0.10-0.40σ OTM' : x < 0.8 ? '0.40-0.80σ OTM' : '≥0.80σ OTM');
const DB = ['ITM >0.25σ', 'near spot (−0.25..0.10σ)', '0.10-0.40σ OTM', '0.40-0.80σ OTM', '≥0.80σ OTM'];
S.push(md(['short strike vs spot', 'n', 'median width', 'median width/σ', 'debit share', 'own P&L', 'win %', 'stack n / median w/σ', 'counter n / median w/σ'],
  DB.map(k => { const a = V.filter(r => db(r.shortOtmSig) === k); if (!a.length) return null; const s = a.filter(r => r.cat === 'stack'), c = a.filter(r => r.cat === 'counter');
    return [k, a.length, fmt(median(a.map(r => r.width))), fmt(median(a.map(r => r.wSig)), 2), pct(a.filter(r => r.struct === 'vertical debit').length / a.length), fmt(sum(a.map(r => r.ownPnl))), pct(a.filter(r => r.ownPnl > 0).length / a.length), `${s.length} / ${fmt(median(s.map(r => r.wSig)), 2)}`, `${c.length} / ${fmt(median(c.map(r => r.wSig)), 2)}`]; }).filter(Boolean)));
S.push('### D3. Outcome by width bucket (width/σ)\n');
S.push(md(['width/σ', 'rows', 'median width', 'own P&L', 'mean P&L', 'win %', 'right dir at settle', 'May n / P&L', 'Jun n / P&L', 'own P&L per $100 of |premium|'],
  ['<0.20σ', '0.20-0.35σ', '0.35-0.60σ', '≥0.60σ'].map(k => { const a0 = W.filter(r => wb(r.wSig) === k); const a = [...new Map(a0.map(r => [r.orderNo, r])).values()]; if (!a.length) return null; const m = a.filter(r => r.month === '2025-05'), j = a.filter(r => r.month === '2025-06');
    return [k, a0.length, fmt(median(a0.map(r => r.width))), fmt(sum(a.map(r => r.ownPnl))), fmt(mean(a.map(r => r.ownPnl))), pct(a.filter(r => r.ownPnl > 0).length / a.length), pct(mean(a.map(r => r.dirRight))), `${m.length} / ${fmt(sum(m.map(r => r.ownPnl)))}`, `${j.length} / ${fmt(sum(j.map(r => r.ownPnl)))}`, fmt(100 * sum(a.map(r => r.ownPnl)) / sum(a.map(r => Math.abs(r.total))), 1)]; }).filter(Boolean)));
S.push('(own P&L counted once per order even when a fly contributes two wing rows)\n');
// rank correlations
const ranks = a => { const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]); const r = new Array(a.length); for (let i = 0; i < idx.length;) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1; i = j + 1; } return r; };
const corr = (a, b) => { const n = a.length; if (n < 5) return null; const ma = mean(a), mb = mean(b); let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; } return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : null; };
const spear = (rows, fx, fy) => { const P = rows.map(r => [fx(r), fy(r)]).filter(([x, y]) => fin(x) && fin(y)); return P.length >= 5 ? [corr(ranks(P.map(p => p[0])), ranks(P.map(p => p[1]))), P.length] : [null, 0]; };
const hrOf = r => { if (!r.timeET) return null; const [h, m] = r.timeET.split(':').map(Number); return h + m / 60; };
S.push('### D4. Spearman rank correlation with width (pts) and width/σ\n');
S.push(md(['predictor', 'n', 'ρ vs width pts', 'ρ vs width/σ', 'ρ (verticals only) width/σ'], [
  ['time of day (hours)', hrOf], ['σ (implied move pts)', r => r.sigma], ['|short strike or body − spot| (σ)', r => r.shortDistSig], ['short strike OTM (σ, signed; verticals)', r => r.shortOtmSig], ['qty', r => r.qty], ['day number (calendar trend)', r => Date.parse(r.date) / 864e5],
].map(([n, f]) => { const [a, k] = spear(W, f, r => r.width), [b] = spear(W, f, r => r.wSig), [c] = spear(V, f, r => r.wSig); return [n, k, fmt(a, 2), fmt(b, 2), fmt(c, 2)]; })));

// per-day
// ── E. ENTRY ANCHORING (user: entries priced off the nearest line or an anticipated retracement in the NEXT candle) ──
S.push('## E. Entry anchoring: lines and next-candle retracements vs spot\n');
{
  // E0. what the export can tell us about resting orders
  const allO = T.days.flatMap(d => d.orders);
  const multi = allO.filter(o => (o.fillTimesET || []).length > 1);
  const byDate = new Map(); for (const o of allO) if (/^\d+$/.test(o.orderNo) && o.timeET) (byDate.get(o.date) || byDate.set(o.date, []).get(o.date)).push(o);
  let missing = 0, pairs = 0; const rested = [];   // rested = lower order number filled AFTER a higher one (placed earlier, filled later)
  const sec = t => { const [a, b, c] = t.split(':').map(Number); return a * 3600 + b * 60 + (c || 0); };
  for (const os of byDate.values()) {
    const s = os.sort((a, b) => +a.orderNo - +b.orderNo);
    for (let i = 1; i < s.length; i++) { missing += Math.max(0, +s[i].orderNo - +s[i - 1].orderNo - 1); pairs++; }
    for (let i = 0; i < s.length; i++) {
      const later = s.slice(i + 1).filter(x => sec(x.timeET) < sec(s[i].timeET));
      if (later.length) rested.push({ o: s[i], minRest: (sec(s[i].timeET) - Math.min(...later.map(x => sec(x.timeET)))) / 60 });
    }
  }
  S.push('### E0. Timestamps available\n');
  S.push(md(['fact', 'value'], [
    ['timestamp per fill', 'execution time only (E*TRADE transaction history); NO placed time, NO cancelled/unfilled orders in the export'],
    ['orders with a fill time', `${allO.filter(o => o.timeET).length}/${allO.length}`],
    ['orders filled at >1 distinct time (partial fills = rested)', `${multi.length} (spans ${multi.map(o => { const f = o.fillTimesET.map(sec); return `${Math.max(...f) - Math.min(...f)}s`; }).join(', ')})`],
    ['order numbers skipped between consecutive same-day fills', `${missing} skipped across ${pairs} gaps (INFERENCE: placed-but-unfilled, cancel/replace, or other-symbol orders — cannot tell which)`],
    ['orders that filled AFTER a higher-numbered (later-placed) order', `${rested.length} (provably rested ≥ median ${fmt(median(rested.map(r => r.minRest)), 1)} min, max ${fmt(Math.max(...rested.map(r => r.minRest)), 0)} min)`],
  ]));
  S.push('So the data can only show WHERE fills landed, not where limits were placed or how many never filled. Everything below is fill-location evidence.\n');

  // per-order anchoring metrics
  const DIRO = ordCtx.filter(c => !c.carried && c.ms != null && c.S != null && c.sg && (c.dir === 'bull' || c.dir === 'bear') && (c.o.effect || 'open') === 'open');
  const sgn = c => (c.dir === 'bull' ? 1 : -1);
  const serOf = (date, tf, src) => (src === 'RTH' ? rthSeries(date, tf) : nqSeries(date, tf));
  const formingIdx = (s, tf, ms, rth) => { const i = lastDone(s, tf, ms, rth); return i + 1 < s.length && s[i + 1].t <= ms ? i + 1 : -1; };
  const minutesIn = (date, t0, t1) => (rthBars(date) || []).filter(b => b.t >= t0 && b.t < t1);
  const linesAt = (date, ms, src) => { const out = []; for (const tf of ['5m', '15m', '60m']) { const s = serOf(date, tf, src); const i = lastDone(s, tf, ms, src === 'RTH'); if (i >= 0 && fin(s[i].bbU)) out.push(s[i].bbU, s[i].bbM, s[i].bbL, s[i].ema9); } return out; };
  const nearestLine = (px, L) => (L.length ? Math.min(...L.map(x => Math.abs(px - x))) : null);
  const A = [];
  for (const c of DIRO) {
    const D = c.o.date, r = { c, month: c.row.month, ownPnl: c.row.ownPnl, dirRight: c.row.dirRight };
    for (const tf of ['5m', '15m']) {
      const s = serOf(D, tf, 'RTH'); const i = lastDone(s, tf, c.ms, true); const fi = formingIdx(s, tf, c.ms, true);
      if (i < 2 || fi < 0) continue;
      const pr = s[i], p2 = s[i - 1], p3 = s[i - 2], fm = s[fi];
      const rng = Math.max(1, pr.h - pr.l);
      const signedPos = px => { const p = (px - pr.l) / rng; return c.dir === 'bull' ? p : 1 - p; };   // 1 = chase extreme (top for bull)
      const mins = minutesIn(D, fm.t, fm.t + TFMS[tf]);
      const fRng = Math.max(1, fm.h - fm.l);
      const posForm = px => { const p = (px - fm.l) / fRng; return c.dir === 'bull' ? p : 1 - p; };     // 0 = best price of the forming candle
      const pull = px => sgn(c) * (px - pr.c) < 0;                                                  // dip below prior close (bull) / pop above (bear)
      const ov2 = [Math.max(pr.l, p2.l), Math.min(pr.h, p2.h)], ov3 = [Math.max(pr.l, p2.l, p3.l), Math.min(pr.h, p2.h, p3.h)];
      const inOv = (ov, px) => ov[0] <= ov[1] && px >= ov[0] && px <= ov[1];
      r[`${tf}_pos`] = signedPos(c.S); r[`${tf}_posNull`] = mean(mins.map(b => signedPos(b.c)));
      r[`${tf}_posLeHalf`] = signedPos(c.S) <= 0.5 ? 1 : 0; r[`${tf}_posLeHalfNull`] = mean(mins.map(b => (signedPos(b.c) <= 0.5 ? 1 : 0)));
      r[`${tf}_form`] = posForm(c.S); r[`${tf}_formNull`] = mean(mins.map(b => posForm(b.c)));
      r[`${tf}_pull`] = pull(c.S) ? 1 : 0; r[`${tf}_pullNull`] = mean(mins.map(b => (pull(b.c) ? 1 : 0)));
      r[`${tf}_ov2`] = ov2[0] <= ov2[1] ? (inOv(ov2, c.S) ? 1 : 0) : null; r[`${tf}_ov2Null`] = ov2[0] <= ov2[1] ? mean(mins.map(b => (inOv(ov2, b.c) ? 1 : 0))) : null;
      r[`${tf}_ov3`] = ov3[0] <= ov3[1] ? (inOv(ov3, c.S) ? 1 : 0) : null; r[`${tf}_ov3Null`] = ov3[0] <= ov3[1] ? mean(mins.map(b => (inOv(ov3, b.c) ? 1 : 0))) : null;
      // ENGINE TEST: decision at the forming candle's start; anchors from completed candles; reached within N bars?
      const decPx = pr.c;
      const anchors = {
        'prior candle mid': (pr.h + pr.l) / 2,
        'overlap-2 zone mid': ov2[0] <= ov2[1] ? (ov2[0] + ov2[1]) / 2 : (pr.h + pr.l) / 2,
        'nearest RTH line on the dip side (≤0.5σ)': (() => { const L = linesAt(D, fm.t, 'RTH').filter(x => sgn(c) * (decPx - x) > 0 && Math.abs(decPx - x) <= 0.5 * c.sg); return L.length ? L.reduce((b, x) => (Math.abs(decPx - x) < Math.abs(decPx - b) ? x : b)) : null; })(),
      };
      for (const [an, A0] of Object.entries(anchors)) {
        if (!fin(A0)) { r[`${tf}|${an}`] = null; continue; }
        const imp = Math.max(0, sgn(c) * (decPx - A0));                     // pts better than the decision price (0 = anchor already through)
        const reach = [1, 2, 3].map(N => { const path = minutesIn(D, fm.t, fm.t + N * TFMS[tf]); return imp === 0 || path.some(b => (c.dir === 'bull' ? b.l <= A0 : b.h >= A0)) ? 1 : 0; });
        r[`${tf}|${an}`] = { A0, imp, impSig: imp / c.sg, reach, userBetter: sgn(c) * (A0 - c.S) >= 0 ? 1 : 0 };
      }
      r[`${tf}_userImp`] = sgn(c) * (decPx - c.S);                            // user fill vs the candle-start price (+ = better)
    }
    // distance from fill to nearest 5m/15m/60m line, vs the minutes of the forming 15m candle
    for (const src of ['RTH', 'NQ']) {
      const L = linesAt(D, c.ms, src); r[`line_${src}`] = nearestLine(c.S, L);
      const s15 = serOf(D, '15m', src); const fi = s15 ? formingIdx(s15, '15m', c.ms, src === 'RTH') : -1;
      if (fi >= 0) { const mins = minutesIn(D, s15[fi].t, s15[fi].t + 15 * 60e3); r[`line_${src}_null`] = mean(mins.map(b => nearestLine(b.c, linesAt(D, b.t + 60e3, src)))); r[`line_${src}_le5null`] = mean(mins.map(b => (nearestLine(b.c, linesAt(D, b.t + 60e3, src)) <= 5 ? 1 : 0))); }
    }
    // strike anchor: short strike (vertical) — distance to any line / pdC / open vs a random strike the same distance from spot
    if (c.o.style === 'vertical') {
      const K = c.o.legs.find(l => l.side === 'short').strike;
      const lv = levelsAt(D, c.ms);
      const L = [...linesAt(D, c.ms, 'RTH'), ...linesAt(D, c.ms, 'NQ'), lv.pdC, lv.openD].filter(fin);
      r.kLine = nearestLine(K, L);
      let h = 0, n = 0; for (let i = 0; i < 100; i++) { const K2 = Math.round((c.S + (rnd() < 0.5 ? -1 : 1) * Math.abs(K - c.S) + (rnd() * 50 - 25)) / 10) * 10; n++; if (nearestLine(K2, L) <= 10) h++; }
      r.kLineNull10 = h / n; r.kSpotDist = Math.abs(K - c.S);
    }
    A.push(r);
  }
  S.push(`### E1. Where fills landed inside the candles (n = ${A.length} directional opening orders; signed so 0 = the favorable extreme, 1 = the chase extreme)\n`);
  const m2 = (k) => [fmt(median(A.map(r => r[k])), 2), fmt(mean(A.map(r => r[k])), 2)];
  const sh = (k) => pct(mean(A.map(r => r[k])));
  S.push(md(['measure', '5m actual', '5m null (minutes of the same candle)', '15m actual', '15m null'], [
    ['position inside the PRIOR candle range (median / mean)', m2('5m_pos').join(' / '), m2('5m_posNull').join(' / '), m2('15m_pos').join(' / '), m2('15m_posNull').join(' / ')],
    ['share in the favorable half of the prior candle', sh('5m_posLeHalf'), sh('5m_posLeHalfNull'), sh('15m_posLeHalf'), sh('15m_posLeHalfNull')],
    ['position inside the CURRENT (fill) candle (0 = its best price)', m2('5m_form').join(' / '), m2('5m_formNull').join(' / '), m2('15m_form').join(' / '), m2('15m_formNull').join(' / ')],
    ['pullback fill (bull below / bear above the prior close)', sh('5m_pull'), sh('5m_pullNull'), sh('15m_pull'), sh('15m_pullNull')],
    ['inside the overlap of the last 2 candles', sh('5m_ov2'), sh('5m_ov2Null'), sh('15m_ov2'), sh('15m_ov2Null')],
    ['inside the overlap of the last 3 candles', sh('5m_ov3'), sh('5m_ov3Null'), sh('15m_ov3'), sh('15m_ov3Null')],
    ['user fill vs the candle-start price, pts (+ = better)', fmt(median(A.map(r => r['5m_userImp'])), 1), '0 by construction', fmt(median(A.map(r => r['15m_userImp'])), 1), '0'],
  ]));
  S.push('Prior candle = last COMPLETED candle at the fill; null = every 1m close of the candle the fill happened in (same prior candle, random minute). 5m/15m candle ranges on NDX-RTH and NQ are identical inside RTH (same 1m bars − constant basis), so only the line tests differ by source.\n');
  for (const [nm, gf] of [['May', r => r.month === '2025-05'], ['June', r => r.month === '2025-06']]) {
    const a = A.filter(gf);
    S.push(`${nm}: n ${a.length}; 5m prior-candle pos median ${fmt(median(a.map(r => r['5m_pos'])), 2)} (null ${fmt(median(a.map(r => r['5m_posNull'])), 2)}); pullback fills ${pct(mean(a.map(r => r['5m_pull'])))} (null ${pct(mean(a.map(r => r['5m_pullNull'])))}); 15m pullback ${pct(mean(a.map(r => r['15m_pull'])))} (null ${pct(mean(a.map(r => r['15m_pullNull'])))}).\n`);
  }
  S.push('### E2. Distance from the fill to the nearest 5m/15m/60m BB/9EMA line, and short strikes at a line\n');
  S.push(md(['measure', 'actual', 'null', 'n'], [
    ['median |fill − nearest NDX-RTH line| pts', fmt(median(A.map(r => r.line_RTH)), 1), fmt(median(A.map(r => r.line_RTH_null)), 1), A.filter(r => fin(r.line_RTH)).length],
    ['fills within 5 pts of an NDX-RTH line', pct(mean(A.map(r => (fin(r.line_RTH) ? (r.line_RTH <= 5 ? 1 : 0) : null)))), pct(mean(A.map(r => r.line_RTH_le5null))), ''],
    ['median |fill − nearest NQ-24h line| pts', fmt(median(A.map(r => r.line_NQ)), 1), fmt(median(A.map(r => r.line_NQ_null)), 1), A.filter(r => fin(r.line_NQ)).length],
    ['fills within 5 pts of an NQ-24h line', pct(mean(A.map(r => (fin(r.line_NQ) ? (r.line_NQ <= 5 ? 1 : 0) : null)))), pct(mean(A.map(r => r.line_NQ_le5null))), ''],
    ['vertical short strike within ±10 of ANY line (5/15/60m RTH+NQ, pdC, open)', pct(mean(A.filter(r => fin(r.kLine)).map(r => (r.kLine <= 10 ? 1 : 0)))), pct(mean(A.map(r => r.kLineNull10))), A.filter(r => fin(r.kLine)).length],
    ['median |short strike − nearest line| vs |short strike − spot|', `${fmt(median(A.map(r => r.kLine)))} vs ${fmt(median(A.map(r => r.kSpotDist)))}`, '', ''],
  ]));
  S.push('Null for lines = the minutes of the same 15m candle (lines re-read each minute). Null for strikes = a random 10-pt strike at the same distance from spot (±25). With 24 lines in play the "any line" test has a high base rate.\n');
  S.push('### E3. Outcome: pullback-anchored vs chased entries (own order P&L at settle)\n');
  const cls = (r, tf) => (!fin(r[`${tf}_pos`]) ? null : r[`${tf}_pos`] <= 0.5 ? 'anchored (favorable half of prior candle)' : r[`${tf}_pos`] >= 0.8 ? 'chased (top 20% bull / bottom 20% bear, or beyond)' : 'middle');
  const CL = ['anchored (favorable half of prior candle)', 'middle', 'chased (top 20% bull / bottom 20% bear, or beyond)'];
  for (const tf of ['5m', '15m']) {
    S.push(md([`${tf} entry class`, 'orders', 'own P&L', 'mean', 'win %', 'P&L excl 05-21/06-23', 'right dir at settle', 'May n / P&L / win', 'Jun n / P&L / win'],
      CL.map(k => { const a = A.filter(r => cls(r, tf) === k); const m = a.filter(r => r.month === '2025-05'), j = a.filter(r => r.month === '2025-06');
        return [k, ...grpStats(a), pct(mean(a.map(r => r.dirRight))), `${m.length} / ${fmt(sum(m.map(r => r.ownPnl)))} / ${pct(m.filter(r => r.ownPnl > 0).length / (m.length || 1))}`, `${j.length} / ${fmt(sum(j.map(r => r.ownPnl)))} / ${pct(j.filter(r => r.ownPnl > 0).length / (j.length || 1))}`]; })));
  }
  S.push(md(['5m pullback fill?', 'orders', 'own P&L', 'mean', 'win %', 'P&L excl 05-21/06-23', 'right dir at settle'], [['pullback (against the order dir vs prior close)', A.filter(r => r['5m_pull'] === 1)], ['no pullback (chasing through the prior close)', A.filter(r => r['5m_pull'] === 0)]].map(([n, a]) => [n, ...grpStats(a), pct(mean(a.map(r => r.dirRight)))])));

  // E4. reversal signals → does the next candle first extend the old trend?
  S.push('### E4. After a reversal-signal candle, does the next candle first extend the old trend?\n');
  S.push('Signal = two same-colour candles, then an opposite-colour candle closing beyond the prior candle\'s midpoint (NDX-RTH, trade days, RTH only). Probe = the next candle trades ≥30% of the signal candle\'s range beyond the signal CLOSE in the OLD direction before it breaks the signal candle\'s extreme in the NEW direction. Confirm = a close beyond the signal candle\'s extreme (new direction) within the next 2 candles.\n');
  const sigRows = [];
  const sigUse = [];
  for (const tf of ['5m', '15m']) {
    let n = 0, probe = 0, conf = 0, confP = 0, confNP = 0, nP = 0;
    for (const day of T.days) {
      const D = day.date, s = rthSeries(D, tf); if (!s) continue;
      const t0 = H.etToMs(D, '09:30'), t1 = H.etToMs(D, '16:00');
      for (let k = 2; k + 1 < s.length; k++) {
        const a = s[k - 2], b = s[k - 1], c = s[k], nx = s[k + 1];
        if (c.t < t0 || nx.t >= t1) continue;
        const col = x => Math.sign(x.c - x.o);
        if (!col(a) || col(a) !== col(b) || col(c) !== -col(b)) continue;
        const old = col(b), mid = (b.h + b.l) / 2;
        if (!(old > 0 ? c.c < mid : c.c > mid)) continue;
        n++;
        const R = Math.max(1, c.h - c.l), probeLvl = c.c + old * 0.3 * R, breakLvl = old > 0 ? c.l : c.h;
        let pr = false;
        for (const m of minutesIn(D, nx.t, nx.t + TFMS[tf])) {
          if (old > 0 ? m.l < breakLvl : m.h > breakLvl) break;
          if (old > 0 ? m.h >= probeLvl : m.l <= probeLvl) { pr = true; break; }
        }
        const cf = [s[k + 1], s[k + 2]].some(x => x && (old > 0 ? x.c < c.l : x.c > c.h));
        if (pr) { probe++; nP++; if (cf) confP++; } else if (cf) confNP++;
        if (cf) conf++;
        // user orders in the NEW direction placed during the next candle
        for (const r of A) { if (r.c.o.date !== D || r.c.ms < nx.t || r.c.ms >= nx.t + TFMS[tf]) continue; if ((r.c.dir === 'bull' ? 1 : -1) !== -old) continue;
          sigUse.push({ tf, r, soldProbe: old * (r.c.S - c.c) > 0 ? 1 : 0, probe: pr, conf: cf }); }
      }
    }
    sigRows.push([tf, n, `${probe} (${pct(probe / n)})`, `${conf} (${pct(conf / n)})`, pct(confP / (nP || 1)), pct(confNP / ((n - nP) || 1))]);
  }
  S.push(md(['TF', 'signals', 'next candle probes old direction first', 'confirmed within 2 candles', 'confirm rate given probe', 'confirm rate given no probe'], sigRows));
  S.push(md(['user orders in the NEW direction during the candle after a signal', 'orders', 'own P&L', 'win %', 'right dir at settle'],
    ['5m', '15m'].flatMap(tf => [['filled on the old-trend side of the signal close (sold the probe)', 1], ['filled beyond the signal close (chased the new direction)', 0]].map(([n, v]) => { const a = sigUse.filter(x => x.tf === tf && x.soldProbe === v).map(x => x.r); return [`${tf}: ${n}`, a.length, fmt(sum(a.map(r => r.ownPnl))), pct(a.filter(r => r.ownPnl > 0).length / (a.length || 1)), pct(mean(a.map(r => r.dirRight)))]; }))));

  // E5. the engine rule: resting limit at the anchor, timeout N bars
  S.push('### E5. Candidate rule: resting limit at an anchor, decided at the start of the fill candle, timeout 1-3 bars\n');
  S.push('Decision price = the prior candle close; the anchor must be on the dip side (bull: below) or it fills at once. "Reached" = the 1m derived path touches the anchor within N bars. Kept/dropped = the user\'s own orders split by whether the rule would have filled within 3 bars (its own P&L at settle — what the rule would have kept vs missed).\n');
  const E5 = [];
  for (const tf of ['5m', '15m']) for (const an of ['prior candle mid', 'overlap-2 zone mid', 'nearest RTH line on the dip side (≤0.5σ)']) {
    const a = A.filter(r => r[`${tf}|${an}`]); if (!a.length) continue;
    const x = a.map(r => r[`${tf}|${an}`]);
    const kept = a.filter(r => r[`${tf}|${an}`].reach[2]), dropped = a.filter(r => !r[`${tf}|${an}`].reach[2]);
    E5.push([`${tf} · ${an}`, a.length, pct(mean(x.map(v => (v.imp === 0 ? 1 : 0)))), ...[0, 1, 2].map(i => pct(mean(x.filter(v => v.imp > 0).map(v => v.reach[i])))), fmt(median(x.filter(v => v.imp > 0).map(v => v.imp)), 1), fmt(median(x.filter(v => v.imp > 0).map(v => v.impSig)), 3),
      pct(mean(x.map(v => v.userBetter))), `${kept.length} / ${fmt(sum(kept.map(r => r.ownPnl)))} / ${pct(mean(kept.map(r => r.dirRight)))}`, `${dropped.length} / ${fmt(sum(dropped.map(r => r.ownPnl)))} / ${pct(mean(dropped.map(r => r.dirRight)))}`]);
  }
  S.push(md(['TF · anchor', 'user orders', 'already through at decision', 'reached ≤1 bar (when not already through)', '≤2 bars', '≤3 bars', 'median improvement pts (when not already through)', 'in σ', 'user fill at/better than anchor', 'kept (≤3 bars): n / P&L / right dir', 'dropped: n / P&L / right dir'], E5));
  // unconditional base rate over every RTH candle start on trade days (no trend filter): bull anchor = prior mid
  const base = [];
  for (const tf of ['5m', '15m']) {
    const hits = [[], [], []], imps = [];
    for (const day of T.days) {
      const D = day.date, s = rthSeries(D, tf); if (!s) continue;
      const t0 = H.etToMs(D, '09:30'), t1 = H.etToMs(D, '16:00');
      for (let k = 1; k < s.length; k++) {
        if (s[k].t < t0 || s[k].t >= t1) continue;
        const pr = s[k - 1];
        for (const d of [1, -1]) {
          const A0 = (pr.h + pr.l) / 2, imp = d * (pr.c - A0);
          if (imp <= 0) continue;                                            // anchor not on the dip side: fills at once
          imps.push(imp);
          [1, 2, 3].forEach((N, i) => { const path = minutesIn(D, s[k].t, Math.min(t1, s[k].t + N * TFMS[tf])); hits[i].push(path.some(b => (d > 0 ? b.l <= A0 : b.h >= A0)) ? 1 : 0); });
        }
      }
    }
    base.push([tf, imps.length, ...hits.map(h => pct(mean(h))), fmt(median(imps), 1)]);
  }
  S.push('Unconditional base rate (every RTH candle start on the 55 trade days, both directions, anchor = prior candle mid on the dip side):\n');
  S.push(md(['TF', 'candle-starts with the mid on the dip side', 'reached ≤1 bar', '≤2 bars', '≤3 bars', 'median improvement pts'], base));
}

// per-day
S.push('## F. Per-day table\n');
S.push(md(['date', 'P&L', 'gap', 'gap σ', 'class', 'open−RTH15mid', 'open−NQ15mid', 'first lvl', 'held', 'pos first', 'pos final', 'stacks', 'with RTH trend', 'stacks P&L', 'counters', 'counters P&L'],
  DR.map(r => [r.date, fmt(r.pnl), fmt(r.gapPts), fmt(r.gapSig, 2), r.gapCls, fmt(r.openMinusRMid), fmt(r.openMinusNMid), r.firstLevel || '—', r.firstLevelHeld || '—', r.posFirst || '—', r.posFinal || '—', r.stacks, r.stacksWithRTH, fmt(r.stacksPnl), r.counters, fmt(r.countersPnl)])));

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'ls-days.csv'), toCsv(DR));
fs.writeFileSync(path.join(OUT, 'ls-orders.csv'), toCsv(OR));
fs.writeFileSync(path.join(OUT, 'ls-widths.csv'), toCsv(W.map(r => ({ ...r, sigma: r1(r.sigma), wSig: r2(r.wSig), shortOtmSig: r2(r.shortOtmSig), shortDistSig: r2(r.shortDistSig), total: r0(r.total), dayPnl: r0(r.dayPnl) }))));
fs.writeFileSync(path.join(OUT, 'ls-levels.csv'), toCsv(tr.map(r => {
  const o = { date: r.date, tradeDate: r.tradeDate, orderNo: r.orderNo, timeET: r.timeET, kind: r.kind, K: r.K, spot: r1(r.S), sigma: r1(r.sg), gapDay: r.gapDay ? 1 : 0 };
  for (const t of LEVELS_A) o[`d_${t}`] = r1(t === 'round100' ? levelDist(r.K, r.lv, t) : fin(r.lv[t]) ? r.K - r.lv[t] : null);
  return o;
})));
const rp = path.join(OUT, 'levels-stacking-report.md');
const START = '<!-- AUTO-TABLES:START -->', END = '<!-- AUTO-TABLES:END -->';
let doc = fs.existsSync(rp) ? fs.readFileSync(rp, 'utf8') : `# Manual trades phase 5: NDX-RTH levels, gaps, stacking, width\n\nGenerated by scripts/manual-trades/analyze-levels-stacking.js. Hand-written findings go ABOVE the marker; re-runs replace only the block between the markers.\n\n${START}\n${END}\n`;
if (!doc.includes(START)) doc += `\n${START}\n${END}\n`;
doc = doc.slice(0, doc.indexOf(START) + START.length) + '\n' + S.join('\n') + '\n' + doc.slice(doc.indexOf(END));
fs.writeFileSync(rp, doc);
console.log(`days ${DR.length} · orders ${OR.length} · targets ${tr.length} · widths ${W.length} · rth days ${rthDays.length} → ${OUT}/ls-*.csv, levels-stacking-report.md`);
