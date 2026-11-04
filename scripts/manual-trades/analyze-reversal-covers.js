#!/usr/bin/env node
'use strict';
/**
 * PHASE 7 of the manual-trades study: ADD vs REVERSAL-OPEN ("natural covers") and opposite-to-trend jump risk.
 *
 * User's description of the style being tested: open when price is likely moving your way, ADD as the 5/15/60m candles
 * confirm continuation; when a candle shows a likely reversal (counter-trend pattern, or a reversal at a 9EMA / BB
 * line) open the OTHER direction — which turns the older positions into tents/plateaus. Think in risk-curve regions,
 * and never let much risk build opposite to the trend (NDX jumps 50-100+ pts in minutes).
 *
 *   node scripts/manual-trades/analyze-reversal-covers.js [--out data/manual-trades/analysis] [--nq <NQ 1m csv>] [--null 30]
 *
 * 1. Class of every same-day book order vs the book's expiry-payoff bias just before it (phase 3 bookBias, ±σ slope):
 *    OPEN (book empty/neutral, directional order), ADD (same dir), REV (opposite dir), OTHER (fly/condor/neutral),
 *    CLOSE (closing/mixed effect).
 * 2. Trigger state at the last COMPLETED 5m/15m/60m candle before the fill, NQ-24h and DERIVED NDX-RTH series, every
 *    feature aligned to the ORDER's direction; null = random minutes (09:45-15:50) of the same day, same direction.
 * 3. Risk-curve effect of each REV (floors ±0.5σ/±1σ, worst region, plateau, geometry vs the prior opposite positions).
 * 4. Jump risk: book loss if NDX jumps 50/100/150 pts against the prevailing NQ 15m / 60m trend (close vs 9EMA), at
 *    every order and every 5 minutes, as an intraday BS mark change (backed-out IV) and as the expiry payoff.
 * 5. Outcomes per REV and per day; 6. REV timing after the last add and after the signal candle.
 *
 * Writes <out>/reversal-covers-report.md, rc-orders.csv, rc-triggers.csv, rc-rev.csv, rc-jump-samples.csv, rc-days.csv.
 * Never prints account identifiers (dates / order numbers / numbers derived from fills and prices only).
 *
 * DERIVED / ESTIMATES (flagged in the report):
 *   - spot = orders.json spotEst (NQ 1m − day basis, ±10-30 pt); σ = orders.json sigmaPts (IV backed out of fills).
 *   - NDX-RTH 1m/5m/15m/60m = NQ RTH 1m − day basis (same machinery as phases 5/6). NQ-24h lines shifted by the basis
 *     for distances to spot; patterns / touches are measured on each series' own candles (shift-invariant).
 *   - Intraday marks = cash + Σ BS(legs) at the day IV fit (days.csv ivBase + ivSkew·ln(K/S), sticky strike), r=0.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const B = require('../../server/src/manual-trades/book');
const H = require('../../server/src/manual-trades/routes').helpers;
const BS = require('../../server/src/candle-spread/bs-pricer');
const IND = require('../../server/src/candle-spread/signals/indicators');
const CP = require('../../server/src/candle-spread/signals/candle-patterns');

const ROOT = path.join(__dirname, '..', '..');
const DATA = path.join(ROOT, 'data', 'manual-trades');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const OUT = path.resolve(arg('--out', path.join(DATA, 'analysis')));
const NQ_CSV = arg('--nq', path.join(os.homedir(), 'Downloads', 'Dataset_NQ_1min_2022_2025.csv'));
const NNULL = +arg('--null', 30);
const JUMPS = [50, 100, 150];
const TFS = ['5m', '15m', '60m'];
const LINES = ['bbU', 'bbM', 'bbL', 'ema9'];
const OUTL = new Set(['2025-05-21', '2025-06-23']);

const r0 = n => (n == null || !isFinite(n) ? null : Math.round(n));
const r1 = n => (n == null || !isFinite(n) ? null : Math.round(n * 10) / 10);
const r2 = n => (n == null || !isFinite(n) ? null : Math.round(n * 100) / 100);
const fin = x => x != null && isFinite(x);
const sum = a => a.reduce((x, y) => x + (y || 0), 0);
const mean = a => { const s = a.filter(fin); return s.length ? sum(s) / s.length : null; };
const median = a => { const s = a.filter(fin).sort((x, y) => x - y); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const q = (a, p) => { const s = a.filter(fin).sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
const sgn = x => (x > 0 ? 1 : x < 0 ? -1 : 0);
let seed = 24680;
const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const t0 = Date.now();
const log = (...a) => console.error(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const share = (a, f) => (a.length ? a.filter(f).length / a.length : null);
const dsign = d => (d === 'bull' ? 1 : d === 'bear' ? -1 : 0);

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

// ── NQ 1m from the csv (labels are bar END, ET) ─────────────────────────────────────────────────────────
if (!fs.existsSync(NQ_CSV)) { console.error(`NQ 1m csv not found: ${NQ_CSV} (pass --nq)`); process.exit(1); }
const FROM_D = '2025-03-01', TO_D = '2025-07-31';
const tradeDays = new Set(T.days.map(d => d.date));
const noonCache = new Map();
const dayBase = iso => { let b = noonCache.get(iso); if (b == null) { b = H.etToMs(iso, '12:00') - 720 * 60e3; noonCache.set(iso, b); } return b; };
const nq = { t: [], o: [], h: [], l: [], c: [] };
const rthRaw = new Map();
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
    if (iso < FROM_D || iso > TO_D) continue;
    const f = line.split(',');
    const [hh, mm] = f[0].slice(sp + 1).split(':').map(Number);
    const m = hh * 60 + mm;
    const o = +f[1], h = +f[2], l = +f[3], c = +f[4];
    nq.t.push(dayBase(iso) + (m - 1) * 60e3); nq.o.push(o); nq.h.push(h); nq.l.push(l); nq.c.push(c);
    if (m >= 571 && m <= 960) { if (!rthRaw.has(iso)) rthRaw.set(iso, []); rthRaw.get(iso).push({ m, o, h, l, c }); }
  }
}
log('NQ bars', nq.t.length);
const basisOf = date => (BASIS[date] && fin(BASIS[date].basis) ? BASIS[date].basis : null);
// RTH days with a basis: trade days have it; other days (warmup for the RTH series) use the NQ 16:00 − NDX close
const NDXD = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'sweeps', 'daily-bb-2026-10-15', 'daily-NDX.json'), 'utf8'))
  .map(b => ({ date: etDate(b.datetime + 12 * 3600e3), c: b.close }));
const ndxClose = new Map(NDXD.map(r => [r.date, r.c]));
const RTH = new Map();
for (const [iso, raw] of rthRaw) {
  raw.sort((a, b) => a.m - b.m);
  let bs = basisOf(iso);
  if (bs == null) { const c16 = raw.find(b => b.m === 960); if (c16 && ndxClose.has(iso)) bs = c16.c - ndxClose.get(iso); }
  if (bs == null || raw.length < 300) continue;
  const t930 = H.etToMs(iso, '09:30');
  const bars = raw.map(b => ({ t: t930 + (b.m - 571) * 60e3, o: b.o - bs, h: b.h - bs, l: b.l - bs, c: b.c - bs }));
  RTH.set(iso, { bars, basis: bs, t930 });
}
const rthDays = [...RTH.keys()].sort();
log('derived RTH days', rthDays.length);

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
  const c = IND.withIndicators(cands).map(x => ({ t: x.datetime, o: x.open, h: x.high, l: x.low, c: x.close, bbU: x.bbUpper, bbM: x.bbMiddle, bbL: x.bbLower, ema9: x.ema9 }));
  return { c, ends: Float64Array.from(cands.map(endFn)) };
}
function lastDone(ser, ms) { const e = ser.ends; let lo = 0, hi = e.length - 1, ans = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (e[m] <= ms) { ans = m; lo = m + 1; } else hi = m - 1; } return ans; }
const SER = {};
for (const [tf, p] of [['5m', 5], ['15m', 15], ['60m', 60]]) SER[`n${tf}`] = mkSeries(resampleArr(nq.t, nq.o, nq.h, nq.l, nq.c, p, 0), x => x.datetime + p * 60e3);
{
  const a = { t: [], o: [], h: [], l: [], c: [] };
  for (const d of rthDays) for (const b of RTH.get(d).bars) { a.t.push(b.t); a.o.push(b.o); a.h.push(b.h); a.l.push(b.l); a.c.push(b.c); }
  SER.r5m = mkSeries(resampleArr(a.t, a.o, a.h, a.l, a.c, 5, 0), x => x.datetime + 5 * 60e3);
  SER.r15m = mkSeries(resampleArr(a.t, a.o, a.h, a.l, a.c, 15, 0), x => x.datetime + 15 * 60e3);
  const close16 = new Map(rthDays.map(d => [d, H.etToMs(d, '16:00')]));
  SER.r60m = mkSeries(resampleArr(a.t, a.o, a.h, a.l, a.c, 60, 30), x => Math.min(x.datetime + 60 * 60e3, close16.get(etDate(x.datetime))));
}
log('series built');
const pxAt = (date, ms) => { const R = RTH.get(date); if (!R) return null; const k = Math.floor((ms - R.t930) / 60e3) - 1; return k >= 0 && k < R.bars.length ? R.bars[k].c : null; };

// ── candle-state features (aligned to direction d = ±1) ─────────────────────────────────────────────────
const cand = c => ({ open: c.o, high: c.h, low: c.l, close: c.c });
const FEATS = ['colA', 'colO', 'contA', 'cont2A', 'breakA', 'breakO', 'emaA', 'emaO', 'slopeA', 'trendA', 'trendO', 'confirmA', 'revPatA', 'revPatO', 'engulfA', 'rejA', 'rejO', 'doji', 'inside', 'outside', 'lineRejA', 'lineRejO', 'touchAny', 'bandRevA', 'bandExtA', 'near025', 'near05', 'lineBehind'];
function candleState(ser, ms, d, S, sg, shift) {
  const s = SER[ser], j = lastDone(s, ms);
  if (j < 2) return null;
  const c = s.c[j], p = s.c[j - 1], pp = s.c[j - 2];
  if (!fin(c.bbU) || !fin(c.ema9) || !fin(p.ema9)) return null;
  const col = sgn(c.c - c.o), pcol = sgn(p.c - p.o);
  const C = cand(c), P = cand(p);
  const emaS = sgn(c.c - c.ema9), slS = sgn(c.ema9 - p.ema9);
  const tr = emaS === slS ? emaS : 0;
  const bullRev = CP.bullishReversalCandle(C, P), bearRev = CP.bearishReversalCandle(C, P);
  const lineRej = dir => LINES.some(L => fin(c[L]) && (dir > 0 ? c.l <= c[L] && c.c > c[L] : c.h >= c[L] && c.c < c[L]));
  let near = null;
  for (const L of LINES) { if (!fin(c[L])) continue; const lv = c[L] - shift, dd = lv - S; if (!near || Math.abs(dd) < Math.abs(near.d)) near = { line: L, d: dd }; }
  const f = {
    colA: col === d, colO: col === -d,
    contA: col === d && (c.c - p.c) * d > 0, cont2A: col === d && pcol === d && (c.c - p.c) * d > 0,
    breakA: d > 0 ? c.c > p.h : c.c < p.l, breakO: d > 0 ? c.c < p.l : c.c > p.h,
    emaA: emaS === d, emaO: emaS === -d, slopeA: slS === d, trendA: tr === d, trendO: tr === -d,
    confirmA: col === d && emaS === d,
    revPatA: d > 0 ? bullRev : bearRev, revPatO: d > 0 ? bearRev : bullRev,
    engulfA: d > 0 ? CP.isBullishEngulfing(C, P) : CP.isBearishEngulfing(C, P),
    rejA: d > 0 ? CP.isBottomRejection(C) : CP.isTopRejection(C), rejO: d > 0 ? CP.isTopRejection(C) : CP.isBottomRejection(C),
    doji: CP.isDoji(C), inside: c.h <= p.h && c.l >= p.l, outside: c.h > p.h && c.l < p.l,
    lineRejA: lineRej(d), lineRejO: lineRej(-d),
    touchAny: LINES.some(L => fin(c[L]) && c.l <= c[L] && c.h >= c[L]),
    bandRevA: d > 0 ? c.l <= c.bbL : c.h >= c.bbU,                       // reversal AT the band on the far side (bull at lower band)
    bandExtA: d > 0 ? c.h >= c.bbU : c.l <= c.bbL,                       // extension: candle reached the band in the order's direction
    near025: near ? Math.abs(near.d) / sg <= 0.25 : false, near05: near ? Math.abs(near.d) / sg <= 0.5 : false,
    lineBehind: near ? sgn(near.d) === -d : false,                       // nearest line sits BEHIND the order (support for a bull)
  };
  f.nearLine = near ? near.line : null; f.nearPts = near ? near.d : null; f.nearSig = near ? near.d / sg : null;
  f.pctB = (c.c - c.bbL) / (c.bbU - c.bbL);
  f.end = s.ends[j];
  void pp;
  return f;
}
const signalAt = (ser, j, d) => {   // reversal signal candle (aligned) at index j
  const s = SER[ser], c = s.c[j], p = s.c[j - 1];
  if (!c || !p || !fin(c.bbU)) return false;
  const C = cand(c), P = cand(p);
  const pat = d > 0 ? CP.bullishReversalCandle(C, P) : CP.bearishReversalCandle(C, P);
  const lr = LINES.some(L => fin(c[L]) && (d > 0 ? c.l <= c[L] && c.c > c[L] : c.h >= c[L] && c.c < c[L]));
  return pat || lr;
};
/** minutes from the end of the most recent aligned reversal-signal candle (≤ 12 candles back) to ms */
function waitSinceSignal(ser, ms, d, maxBack = 12) {
  const s = SER[ser], j = lastDone(s, ms);
  for (let k = j; k >= Math.max(2, j - maxBack); k--) if (signalAt(ser, k, d)) return (ms - s.ends[k]) / 60e3;
  return null;
}

// ── curve helpers ───────────────────────────────────────────────────────────────────────────────────────
function vAt(curve, x) { const P = curve.points; if (x <= P[0].x) return P[0].y; for (let i = 1; i < P.length; i++) if (x <= P[i].x) return P[i - 1].y + (P[i].y - P[i - 1].y) * (x - P[i - 1].x) / (P[i].x - P[i - 1].x); return P[P.length - 1].y; }
function minOn(curve, a, b) { let m = { v: vAt(curve, a), x: a }; const vb = vAt(curve, b); if (vb < m.v) m = { v: vb, x: b }; for (const p of curve.points) if (p.x > a && p.x < b && p.y < m.v) m = { v: p.y, x: p.x }; return m; }
function maxOn(curve, a, b) { let m = Math.max(vAt(curve, a), vAt(curve, b)); for (const p of curve.points) if (p.x > a && p.x < b) m = Math.max(m, p.y); return m; }
/** flat top: contiguous run around the argmax (within [a,b]) where value ≥ max − max(5% of max, $50); only if max > 0 */
function flatTop(curve, a, b) {
  const mx = maxOn(curve, a, b); if (!(mx > 0)) return null;
  const thr = mx - Math.max(0.05 * mx, 50);
  let xm = a; for (let x = a; x <= b; x += 1) if (vAt(curve, x) >= mx - 1e-6) { xm = x; break; }
  let lo = xm, hi = xm;
  while (lo - 1 >= a && vAt(curve, lo - 1) >= thr) lo--;
  while (hi + 1 <= b && vAt(curve, hi + 1) >= thr) hi++;
  return { lo, hi, w: hi - lo, max: mx };
}
const keyStrike = o => {   // short strike of a vertical, strike of a single, else centre of the strikes
  if (o.style === 'vertical') { const sh = o.legs.find(l => l.side === 'short'); return sh ? sh.strike : null; }
  const ks = o.legs.map(l => l.strike); return o.center != null ? o.center : (Math.min(...ks) + Math.max(...ks)) / 2;
};
function markOf(legs, cash, S, tau, ivFn) {
  let v = cash;
  for (const l of legs) v += l.qty * BS.bsPrice(l.right, S, l.strike, tau, ivFn(l.strike)) * B.MULT;
  return v;
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════════
// FOLLOW-UP (phase 7b): band touch vs timing, run size + confluence, balanced-cost strike choice
// ══════════════════════════════════════════════════════════════════════════════════════════════════════
const TOUCH_TOL = 3, ZZ = 20, ZZ_ALT = 15, CONF_TOL = 12, STEP = 10, KMAX = 5;
const TLINES = { band: null, mid: 'bbM', ema9: 'ema9' };
/** Did a completed candle reach line L IN THE OLD-RUN direction o (up run: high reached a line at/above the body low = resistance hit)? */
const touchOld = (c, L, o) => (!fin(L) ? false : o > 0 ? c.h >= L - TOUCH_TOL && Math.min(c.o, c.c) <= L : c.l <= L + TOUCH_TOL && Math.max(c.o, c.c) >= L);
const rejectOld = (c, L, o) => touchOld(c, L, o) && (o > 0 ? c.c < L : c.c > L);
/** touch features for a REV of direction d (old run o = −d) over the last `back` completed candles of series ser */
function touchFeats(ser, ms, d, back = 1) {
  const s = SER[ser], j = lastDone(s, ms), o = -d, out = {};
  if (j < 1) return null;
  for (const [nm, key] of Object.entries(TLINES)) {
    let t = false, rj = false;
    for (let k = j; k > j - back && k >= 0; k--) { const c = s.c[k]; const L = key ? c[key] : (o > 0 ? c.bbU : c.bbL); if (touchOld(c, L, o)) t = true; if (rejectOld(c, L, o)) rj = true; }
    out[nm] = t; out[`${nm}Rej`] = rj;
  }
  return out;
}
/** zigzag on derived NDX-RTH 1m highs/lows up to (not incl.) the bar containing ms; threshold Z pts */
function zigzagState(bars, ms, Z) {
  const n = bars.findIndex(b => b.t + 60e3 > ms); const N = n < 0 ? bars.length : n;
  if (N < 2) return null;
  const piv = []; let dir = 0, ext = null, mxH = bars[0].h, mnL = bars[0].l, iH = 0, iL = 0;
  for (let i = 0; i < N; i++) {
    const b = bars[i];
    if (dir === 0) {
      if (b.h > mxH) { mxH = b.h; iH = i; } if (b.l < mnL) { mnL = b.l; iL = i; }
      if (mxH - mnL >= Z) { if (iH > iL) { piv.push(mnL); dir = 1; ext = mxH; } else { piv.push(mxH); dir = -1; ext = mnL; } }
    } else if (dir > 0) { if (b.h >= ext) ext = b.h; else if (ext - b.l >= Z) { piv.push(ext); dir = -1; ext = b.l; } }
    else { if (b.l <= ext) ext = b.l; else if (b.h - ext >= Z) { piv.push(ext); dir = 1; ext = b.h; } }
  }
  return { dir, ext, piv, mxH, mnL };
}
/** run in the OLD direction o at the fill: origin (swing extreme opposite the run), extreme, size, retrace to S */
function runAt(bars, ms, o, S, Z) {
  const z = zigzagState(bars, ms, Z); if (!z) return null;
  let origin, extreme;
  if (z.dir === o) { extreme = z.ext; origin = z.piv.length ? z.piv[z.piv.length - 1] : (o > 0 ? z.mnL : z.mxH); }
  else if (z.dir === -o) { if (z.piv.length < 1) return null; extreme = z.piv[z.piv.length - 1]; origin = z.piv.length > 1 ? z.piv[z.piv.length - 2] : (o > 0 ? z.mnL : z.mxH); }
  else { extreme = o > 0 ? z.mxH : z.mnL; origin = o > 0 ? z.mnL : z.mxH; }
  return { origin, extreme, size: (extreme - origin) * o, retrace: (extreme - S) * o, legDone: z.dir === -o };
}
/** every 5/15/60m BB upper/mid/lower + 9EMA level (NQ-24h shifted by basis, and NDX-RTH), last completed candle */
function linesAt(ms, basis) {
  const L = [];
  for (const [pre, sh] of [['n', basis], ['r', 0]]) for (const tf of TFS) { const s = SER[`${pre}${tf}`], j = lastDone(s, ms); if (j < 0) continue; const c = s.c[j]; for (const k of LINES) if (fin(c[k])) L.push({ id: `${pre}${tf}.${k}`, v: c[k] - sh }); }
  return L;
}
/** debit-equivalent cost per unit (index pts) of a vertical: debit as paid; credit → width − credit */
const ceOf = o => (o.style !== 'vertical' ? null : o.netPerUnit > 0 ? o.netPerUnit : o.widths[0] + o.netPerUnit);
/** BS debit-equivalent of a vertical's legs shifted by k strikes */
function modelCe(o, k, S, tau, ivFn) {
  let v = 0;
  for (const l of o.legs) { const R = l.type === 'call' ? 'C' : 'P', K = l.strike + k * STEP; v += (l.side === 'long' ? 1 : -1) * BS.bsPrice(R, S, K, tau, ivFn(K)); }
  return o.netPerUnit > 0 ? v : o.widths[0] + v;   // v<0 for a credit (net short premium)
}
const shortK = o => { const x = o.legs.find(l => l.side === 'short'); return x ? x.strike : null; };
const midK = o => (Math.min(...o.legs.map(l => l.strike)) + Math.max(...o.legs.map(l => l.strike))) / 2;

// ══════════════════════════════════════════════════════════════════════════════════════════════════════
// PER DAY
// ══════════════════════════════════════════════════════════════════════════════════════════════════════
const rows = [];       // every same-day order
const nullRows = [];   // random-minute states for the trigger null (carry the order's class, day, direction)
const revRows = [];
const jumpRows = [];
const dayRows = [];
for (const day of T.days) {
  const D = day.date, R = RTH.get(D);
  const seq = H.bookOrders(day, byNo);
  if (!seq.length || !R) continue;
  const dc = DAYCSV.get(D) || {};
  const ivBase = fin(+dc.ivBase) ? +dc.ivBase : 0.2, ivSkew = fin(+dc.ivSkew) ? +dc.ivSkew : 0;
  const close16 = H.etToMs(D, '16:00');
  const allK = seq.flatMap(s => s.order.legs.map(l => l.strike));
  const xMin = Math.floor((Math.min(...allK, day.settle) - 400) / 10) * 10, xMax = Math.ceil((Math.max(...allK, day.settle) + 400) / 10) * 10;
  const rthLo = Math.min(...R.bars.map(b => b.l)), rthHi = Math.max(...R.bars.map(b => b.h));
  const legsAcc = []; let cash = 0;
  const steps = [];   // { ms, legs(net), cash } after each order
  const dayOrd = [];
  seq.forEach(({ order: o, carried }, k) => {
    const oLegs = H.orderLegs(o);
    const prevNet = B.netLegs(legsAcc), prevCash = cash;
    legsAcc.push(...oLegs); cash += o.total;
    const net = B.netLegs(legsAcc);
    const oi = ORD.get(`${D}|${o.orderNo}`) || {};
    const ms = !carried && o.timeET ? H.etToMs(o.date, o.timeET) : null;
    steps.push({ ms: ms != null ? ms : -Infinity, legs: net, cash, orderNo: o.orderNo });
    const dir = oi.direction || null, d = dsign(dir);
    const bias = oi.bookBias || 'flat', b = dsign(bias);
    let cls;
    if (carried) cls = 'CARRIED';
    else if (o.effect !== 'open') cls = 'CLOSE';
    else if (!d) cls = 'OTHER';
    else if (!b) cls = 'OPEN';
    else cls = d === b ? 'ADD' : 'REV';
    const S = fin(oi.spotEst) ? oi.spotEst : null, sg = fin(oi.sigmaPts) ? oi.sigmaPts : null;
    const rec = { date: D, month: D.slice(0, 7), orderNo: o.orderNo, timeET: o.timeET, carried, k, ms, cls, dir, d, bias, style: o.style, debitCredit: o.debitCredit,
      S, sg, total: o.total, ownPnl: fin(oi.ownPnl) ? oi.ownPnl : null, keyK: keyStrike(o), o, oLegs, prevNet, prevCash, net, cash, dayPnl: day.pnl.net };
    dayOrd.push(rec);
    if (carried) return;
    rows.push(rec);
    // ── triggers
    if ((cls === 'ADD' || cls === 'REV' || cls === 'OPEN') && S != null && sg && ms != null) {
      rec.st = {};
      for (const tf of TFS) {
        rec.st[`n${tf}`] = candleState(`n${tf}`, ms, d, S, sg, R.basis);
        rec.st[`r${tf}`] = candleState(`r${tf}`, ms, d, S, sg, 0);
      }
      rec.wait = { n5m: waitSinceSignal('n5m', ms, d), n15m: waitSinceSignal('n15m', ms, d), r5m: waitSinceSignal('r5m', ms, d), r15m: waitSinceSignal('r15m', ms, d) };
      for (let z = 0; z < NNULL; z++) {
        const mm = 15 + Math.floor(rnd() * 366);   // 09:45..15:50
        const nms = R.t930 + mm * 60e3 + 30e3, nS = pxAt(D, nms);
        if (nS == null) continue;
        const st = {};
        for (const tf of TFS) { st[`n${tf}`] = candleState(`n${tf}`, nms, d, nS, sg, R.basis); st[`r${tf}`] = candleState(`r${tf}`, nms, d, nS, sg, 0); }
        nullRows.push({ date: D, cls, d, st, wait: { n5m: waitSinceSignal('n5m', nms, d), n15m: waitSinceSignal('n15m', nms, d), r5m: waitSinceSignal('r5m', nms, d), r15m: waitSinceSignal('r15m', nms, d) } });
      }
    }
  });

  // ── REV risk-curve effect
  for (const rec of dayOrd) {
    if (rec.cls !== 'REV' || rec.S == null || !rec.sg) continue;
    const { S, sg, d } = rec;
    const before = H.payoffCurve(rec.prevNet, rec.prevCash, xMin, xMax), after = H.payoffCurve(rec.net, rec.cash, xMin, xMax);
    const own = H.payoffCurve(B.netLegs(rec.oLegs), rec.total, xMin, xMax);
    const f05b = minOn(before, S - 0.5 * sg, S + 0.5 * sg), f05a = minOn(after, S - 0.5 * sg, S + 0.5 * sg);
    const f1b = minOn(before, S - sg, S + sg), f1a = minOn(after, S - sg, S + sg);
    const f2b = minOn(before, S - 2 * sg, S + 2 * sg), f2a = minOn(after, S - 2 * sg, S + 2 * sg);
    const wx = f1b.x, worstSide = sgn(wx - S);
    const ownAtW = vAt(own, wx), ownMax1 = maxOn(own, S - sg, S + sg);
    const ftB = flatTop(before, S - 2 * sg, S + 2 * sg), ftA = flatTop(after, S - 2 * sg, S + 2 * sg);
    const pz = (cv) => { const a = S - 2 * sg, b2 = S + 2 * sg; if (vAt(cv, S) <= 0) return 0; let lo = S, hi = S; while (lo - 1 >= a && vAt(cv, lo - 1) > 0) lo--; while (hi + 1 <= b2 && vAt(cv, hi + 1) > 0) hi++; return Math.round(hi - lo); };
    const ft80 = (cv) => { const mx = maxOn(cv, S - 2 * sg, S + 2 * sg); if (!(mx > 0)) return 0; let n = 0; for (let x = Math.ceil(S - 2 * sg); x <= S + 2 * sg; x++) if (vAt(cv, x) >= 0.8 * mx) n++; return n; };
    // prior opposite positions = earlier book orders (incl. carried) whose direction is the book bias (= −d)
    const prior = dayOrd.filter(x => x.k < rec.k && x.d === -d && x.o.effect === 'open');
    const last = prior[prior.length - 1], first = prior[0];
    const nearestK = prior.length && fin(rec.keyK) ? prior.reduce((bst, x) => (fin(x.keyK) && (bst == null || Math.abs(x.keyK - rec.keyK) < Math.abs(bst - rec.keyK)) ? x.keyK : bst), null) : null;
    // last add peak: max excursion in the bias direction between the last same-bias order and this order
    let runPts = null, retracePts = null;
    if (last && last.ms != null && last.S != null) {
      const seg = R.bars.filter(bb => bb.t >= last.ms - 60e3 && bb.t < rec.ms);
      if (seg.length) {
        const peak = -d > 0 ? Math.max(...seg.map(bb => bb.h)) : Math.min(...seg.map(bb => bb.l));
        runPts = (peak - last.S) * -d; retracePts = (peak - S) * -d;
      }
    }
    // final-book floor over the realised RTH range with vs without this order
    const finalNet = B.netLegs(legsAcc), withoutLegs = B.netLegs([...legsAcc, ...rec.oLegs.map(l => ({ ...l, qty: -l.qty }))]);
    const fFin = H.payoffCurve(finalNet, cash, xMin, xMax), fWo = H.payoffCurve(withoutLegs, cash - rec.total, xMin, xMax);
    const rr = {
      date: D, month: rec.month, orderNo: rec.orderNo, timeET: rec.timeET, dir: rec.dir, bias: rec.bias, style: rec.style, debitCredit: rec.debitCredit, S: r1(S), sg: r1(sg),
      floor05Before: r0(f05b.v), floor05After: r0(f05a.v), floor1Before: r0(f1b.v), floor1After: r0(f1a.v), floor2Before: r0(f2b.v), floor2After: r0(f2a.v),
      worstXBefore: r0(wx), worstOffSig: r2((wx - S) / sg), worstOnOrderSide: worstSide === d ? 1 : worstSide === 0 ? null : 0,
      ownAtWorst: r0(ownAtW), ownMax1s: r0(ownMax1), sitsOnWorst: ownMax1 > 0 && ownAtW >= 0.5 * ownMax1 ? 1 : 0,
      dAtWorst: r0(vAt(after, wx) - vAt(before, wx)), raisedLowest: vAt(after, wx) > vAt(before, wx) && f1a.v > f1b.v ? 1 : 0,
      worstXAfter: r0(f1a.x), worstMovedSide: sgn(f1a.x - S) === -worstSide ? 1 : 0,
      plateauBefore: ftB ? ftB.w : 0, plateauAfter: ftA ? ftA.w : 0, plateauLo: ftA ? ftA.lo : null, plateauHi: ftA ? ftA.hi : null,
      profitZoneBefore: pz(before), profitZoneAfter: pz(after), top80Before: ft80(before), top80After: ft80(after),
      spotOnPlateau: ftA && S >= ftA.lo && S <= ftA.hi ? 1 : 0, plateauAfterSig: ftA ? r2(ftA.w / sg) : 0,
      nPriorOpp: prior.length, keyK: rec.keyK, distLastPts: last && fin(last.keyK) && fin(rec.keyK) ? r0(Math.abs(rec.keyK - last.keyK)) : null,
      distNearestPts: fin(nearestK) ? r0(Math.abs(rec.keyK - nearestK)) : null, distNearestSig: fin(nearestK) ? r2(Math.abs(rec.keyK - nearestK) / sg) : null,
      minSinceLast: last && last.ms != null ? r0((rec.ms - last.ms) / 60e3) : null, minSinceFirst: first && first.ms != null ? r0((rec.ms - first.ms) / 60e3) : null,
      moveSinceLastPts: last && last.S != null ? r0((S - last.S) * -d) : null, moveSinceFirstPts: first && first.S != null ? r0((S - first.S) * -d) : null,
      moveSinceFirstSig: first && first.S != null ? r2((S - first.S) * -d / sg) : null,
      runSinceLastAddPts: r0(runPts), retraceFromPeakPts: r0(retracePts), retraceSig: fin(retracePts) ? r2(retracePts / sg) : null,
      ownPnl: r0(rec.ownPnl), floorContribRange: r0(minOn(fFin, rthLo, rthHi).v - minOn(fWo, rthLo, rthHi).v),
      settleContrib: r0(vAt(fFin, day.settle) - vAt(fWo, day.settle)), dayPnl: r0(day.pnl.net), outlierDay: OUTL.has(D) ? 1 : 0,
    };
    // ── 7b: touches, run, confluence, balanced cost
    {
      const tf = {};
      for (const ser of ['n5m', 'n15m', 'n60m', 'r5m', 'r15m', 'r60m']) { const f = touchFeats(ser, rec.ms, d, 1); if (f) for (const k of Object.keys(f)) tf[`t_${ser}_${k}`] = f[k] ? 1 : 0; }
      for (const ser of ['n5m', 'r5m']) { const f = touchFeats(ser, rec.ms, d, 3); if (f) for (const k of ['band', 'mid', 'ema9', 'bandRej']) tf[`t_${ser}x3_${k}`] = f[k] ? 1 : 0; }
      tf.t_anyBand = Object.keys(tf).some(k => /_band$/.test(k) && tf[k]) ? 1 : 0;
      tf.t_anyMidEma = Object.keys(tf).some(k => /_(mid|ema9)$/.test(k) && tf[k]) ? 1 : 0;
      tf.t_anyLine = tf.t_anyBand || tf.t_anyMidEma ? 1 : 0;
      Object.assign(rr, tf);
      const o_ = -d, run = runAt(R.bars, rec.ms, o_, S, ZZ), run15 = runAt(R.bars, rec.ms, o_, S, ZZ_ALT);
      rr.runSize = run ? r0(run.size) : null; rr.runRetrace = run ? r0(run.retrace) : null; rr.runLegDone = run ? (run.legDone ? 1 : 0) : null; rr.runExtreme = run ? r1(run.extreme) : null;
      rr.runSize15 = run15 ? r0(run15.size) : null; rr.runRetrace15 = run15 ? r0(run15.retrace) : null;
      if (run) {
        const Ls = linesAt(rec.ms, R.basis);
        rr.confN = Ls.filter(x => Math.abs(x.v - run.extreme) <= CONF_TOL).length;
        rr.confIds = Ls.filter(x => Math.abs(x.v - run.extreme) <= CONF_TOL).map(x => x.id).join(' ');
        const beyond = Ls.map(x => (x.v - run.extreme) * o_).filter(x => x > CONF_TOL);
        rr.distBeyond = beyond.length ? r0(Math.min(...beyond)) : null;
      }
      // balanced cost vs the most recent prior opposite vertical of the SAME width
      const o = rec.o;
      if (o.style === 'vertical') {
        const W = o.widths[0], ceR = ceOf(o);
        rr.revW = W; rr.revCe = r2(ceR);
        const prevV = dayOrd.filter(x => x.k < rec.k && x.d === -d && x.o.style === 'vertical' && x.o.effect === 'open' && x.o.widths[0] === W);
        const pv = prevV[prevV.length - 1];
        if (pv) {
          const c1 = ceOf(pv.o);
          rr.pairCe1 = r2(c1); rr.pairTotal = r2(c1 + ceR); rr.pairTotW = r2((c1 + ceR) / W); rr.pairCarried = pv.carried ? 1 : 0;
          const tau = Math.max(1e-7, (close16 - rec.ms) / BS.YEAR_MS), ivFn = BS.makeIvFn({ base: ivBase, skew: ivSkew }, S);
          const off = ceR - modelCe(o, 0, S, tau, ivFn);
          const alt = []; for (let k = -KMAX; k <= KMAX; k++) alt.push({ k, ce: modelCe(o, k, S, tau, ivFn) + off, sk: shortK(o) + k * STEP, mid: midK(o) + k * STEP });
          const bal = alt.reduce((b, a) => (Math.abs(c1 + a.ce - W) < Math.abs(c1 + b.ce - W) ? a : b));
          const under = alt.filter(a => c1 + a.ce <= W + 1e-9).sort((a, b) => b.ce - a.ce)[0] || null;
          const same = alt.find(a => a.sk === shortK(pv.o)) || null;
          const spot = alt.reduce((b, a) => (Math.abs(a.mid - S) < Math.abs(b.mid - S) ? a : b));
          rr.kBal = bal.k; rr.kUnder = under ? under.k : null; rr.kSame = same ? same.k : null; rr.kSpot = spot.k;
          rr.modelOff = r2(off);
        }
      }
    }
    revRows.push(rr);
    rec.rev = rr;
  }

  // ── 7b book-level: FIFO-pair REV units against unpaired opposite vertical units (cost as a fraction of width)
  {
    const Q = { 1: [], '-1': [] };
    for (const x of dayOrd) {
      if (x.o.style !== 'vertical' || x.o.effect !== 'open' || !x.d) continue;
      const frac = ceOf(x.o) / x.o.widths[0]; let units = x.o.qty || 1;
      if (x.cls === 'REV') {
        const q_ = Q[String(-x.d)]; let paid = 0, got = 0;
        while (units > 0 && q_.length) { const h = q_[0], t = Math.min(h.u, units); paid += t * h.f; got += t; h.u -= t; units -= t; if (!h.u) q_.shift(); }
        if (x.rev && got) { x.rev.bookPairedFrac = r2(paid / got); x.rev.bookTotW = r2(frac + paid / got); x.rev.bookUnitsPaired = got; }
      }
      if (units > 0) Q[String(x.d)].push({ f: frac, u: units });
    }
  }

  // ── jump risk samples: each order (after its fill) + every 5 min while the book is non-empty
  const firstMs = Math.min(...dayOrd.filter(x => x.ms != null).map(x => x.ms));
  const samples = [];
  for (const x of dayOrd) if (x.ms != null && x.S != null) samples.push({ ms: x.ms, S: x.S, kind: 'order', orderNo: x.orderNo });
  for (let ms = Math.ceil(firstMs / 300e3) * 300e3; ms <= H.etToMs(D, '15:55'); ms += 300e3) { const S = pxAt(D, ms); if (S != null) samples.push({ ms, S, kind: '5min' }); }
  for (const sp of samples) {
    const st = [...steps].filter(s => s.ms <= sp.ms).pop() || (steps[0].ms === -Infinity ? steps[0] : null);
    if (!st || !st.legs.length) continue;
    const tau = Math.max(1e-7, (close16 - sp.ms) / BS.YEAR_MS);
    const ivFn = BS.makeIvFn({ base: ivBase, skew: ivSkew }, sp.S);
    const curve = H.payoffCurve(st.legs, st.cash, xMin, xMax);
    const m0 = markOf(st.legs, st.cash, sp.S, tau, ivFn);
    const j15 = lastDone(SER.n15m, sp.ms), j60 = lastDone(SER.n60m, sp.ms);
    const c15 = SER.n15m.c[j15], c60 = SER.n60m.c[j60];
    const tr15 = c15 && fin(c15.ema9) ? sgn(c15.c - c15.ema9) : 0, tr60 = c60 && fin(c60.ema9) ? sgn(c60.c - c60.ema9) : 0;
    const sgS = sp.S * ivBase * Math.sqrt(tau), bdiff = vAt(curve, sp.S + Math.max(sgS, 25)) - vAt(curve, sp.S - Math.max(sgS, 25));
    const bias = Math.abs(bdiff) < 0.1 * Math.max(1, curve.max - curve.min) ? 0 : sgn(bdiff);
    const jr = { bias, biasVs15: tr15 && bias ? (bias === tr15 ? 'with' : 'against') : 'n/a', biasVs60: tr60 && bias ? (bias === tr60 ? 'with' : 'against') : 'n/a', date: D, month: D.slice(0, 7), timeET: new Date(sp.ms).toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' }), kind: sp.kind, orderNo: sp.orderNo || '', S: r1(sp.S), tr15, tr60, mark: r0(m0), expAtSpot: r0(vAt(curve, sp.S)), dayPnl: r0(day.pnl.net) };
    for (const J of JUMPS) {
      const up = markOf(st.legs, st.cash, sp.S + J, tau, ivFn) - m0, dn = markOf(st.legs, st.cash, sp.S - J, tau, ivFn) - m0;
      const eUp = minOn(curve, sp.S, sp.S + J).v, eDn = minOn(curve, sp.S - J, sp.S).v;
      jr[`mk${J}_vs15`] = r0(tr15 > 0 ? dn : tr15 < 0 ? up : Math.min(up, dn));
      jr[`mk${J}_vs60`] = r0(tr60 > 0 ? dn : tr60 < 0 ? up : Math.min(up, dn));
      jr[`mk${J}_with15`] = r0(tr15 > 0 ? up : tr15 < 0 ? dn : Math.max(up, dn));
      jr[`mk${J}_worst`] = r0(Math.min(up, dn));
      jr[`lv${J}_vs15`] = r0(m0 + (tr15 > 0 ? dn : tr15 < 0 ? up : Math.min(up, dn)));   // P&L LEVEL (mark) after the jump
      jr[`lv${J}_with15`] = r0(m0 + (tr15 > 0 ? up : tr15 < 0 ? dn : Math.max(up, dn)));
      jr[`lv${J}_vs60`] = r0(m0 + (tr60 > 0 ? dn : tr60 < 0 ? up : Math.min(up, dn)));
      jr[`ex${J}_vs15`] = r0(tr15 > 0 ? eDn : tr15 < 0 ? eUp : Math.min(eUp, eDn));
      jr[`ex${J}_worst`] = r0(Math.min(eUp, eDn));
    }
    jumpRows.push(jr);
  }

  // ── per day
  const dirOrders = dayOrd.filter(x => !x.carried && (x.cls === 'OPEN' || x.cls === 'ADD'));
  let covRev = 0, covAny = 0, flyOnly = 0, never = 0, covRevUsd = 0, neverUsd = 0, totUsd = 0;
  for (const x of dirOrders) {
    const later = dayOrd.filter(y => y.k > x.k && !y.carried);
    const usd = Math.abs(x.total); totUsd += usd;
    if (later.some(y => y.cls === 'REV' && y.d === -x.d)) { covRev++; covAny++; covRevUsd += usd; }
    else if (later.some(y => y.d === -x.d)) covAny++;
    else if (later.some(y => y.cls === 'OTHER')) flyOnly++;
    else { never++; neverUsd += usd; }
  }
  const J = jumpRows.filter(r => r.date === D);
  const cnt = c => dayOrd.filter(x => x.cls === c).length;
  dayRows.push({ date: D, month: D.slice(0, 7), pnl: r0(day.pnl.net), win: day.pnl.net > 0 ? 1 : 0, orders: dayOrd.filter(x => !x.carried).length,
    OPEN: cnt('OPEN'), ADD: cnt('ADD'), REV: cnt('REV'), OTHER: cnt('OTHER'), CLOSE: cnt('CLOSE'),
    dirOrders: dirOrders.length, coveredByRev: covRev, coveredAnyOpp: covAny, flyOnly, neverCovered: never,
    shareCovRevUsd: totUsd ? r2(covRevUsd / totUsd) : null, shareNeverUsd: totUsd ? r2(neverUsd / totUsd) : null,
    maxJ100vs15: r0(Math.min(...J.map(r => r.mk100_vs15))), maxJ100vs60: r0(Math.min(...J.map(r => r.mk100_vs60))), maxJ100worst: r0(Math.min(...J.map(r => r.mk100_worst))),
    medJ100vs15: r0(median(J.map(r => r.mk100_vs15))), maxJ50vs15: r0(Math.min(...J.map(r => r.mk50_vs15))), maxJ150vs15: r0(Math.min(...J.map(r => r.mk150_vs15))),
    minLv100vs15: r0(Math.min(...J.map(r => r.lv100_vs15))), minLv100with15: r0(Math.min(...J.map(r => r.lv100_with15))), minLv100vs60: r0(Math.min(...J.map(r => r.lv100_vs60))),
    minLv150vs15: r0(Math.min(...J.map(r => r.lv150_vs15))), minLv50vs15: r0(Math.min(...J.map(r => r.lv50_vs15))), medLv100vs15: r0(median(J.map(r => r.lv100_vs15))),
    shareBiasAgainst15: r2(share(J.filter(r => r.kind === '5min' && r.biasVs15 !== 'n/a'), r => r.biasVs15 === 'against')),
    shareBiasAgainst60: r2(share(J.filter(r => r.kind === '5min' && r.biasVs60 !== 'n/a'), r => r.biasVs60 === 'against')),
    maxEx100vs15: r0(Math.min(...J.map(r => r.ex100_vs15))),
    revOwnPnl: r0(sum(dayOrd.filter(x => x.cls === 'REV').map(x => x.ownPnl))), addOwnPnl: r0(sum(dayOrd.filter(x => x.cls === 'ADD').map(x => x.ownPnl))),
    outlierDay: OUTL.has(D) ? 1 : 0 });
}
log('orders', rows.length, 'null rows', nullRows.length, 'rev', revRows.length, 'jump samples', jumpRows.length);

// ══════════════════════════════════════════════════════════════════════════════════════════════════════
// AGGREGATES
// ══════════════════════════════════════════════════════════════════════════════════════════════════════
const MONTHS = [...new Set(rows.map(r => r.month))].sort();
const CLS = ['OPEN', 'ADD', 'REV', 'OTHER', 'CLOSE'];
const fmt = (v, d = 0) => (v == null || !isFinite(v) ? '—' : (+v).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d }));
const pct = v => (v == null || !isFinite(v) ? '—' : `${Math.round(v * 100)}%`);
const md = (head, rs) => `| ${head.join(' | ')} |\n|${head.map(() => '---').join('|')}|\n${rs.map(r => `| ${r.join(' | ')} |`).join('\n')}\n`;
const toCsv = rs => { if (!rs.length) return ''; const h = Object.keys(rs[0]); const qq = v => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v)); return [h.join(','), ...rs.map(r => h.map(k => qq(r[k])).join(','))].join('\n') + '\n'; };
const spearman = (a, b) => { const rk = v => { const s = v.map((x, i) => [x, i]).sort((x, y) => x[0] - y[0]); const r = new Array(v.length); s.forEach(([, i], k) => { r[i] = k; }); return r; }; const ra = rk(a), rb = rk(b); const ma = mean(ra), mb = mean(rb); let n = 0, da = 0, db = 0; for (let i = 0; i < ra.length; i++) { n += (ra[i] - ma) * (rb[i] - mb); da += (ra[i] - ma) ** 2; db += (rb[i] - mb) ** 2; } return n / Math.sqrt(da * db); };

const SERL_ = { n5m: 'NQ 5m', n15m: 'NQ 15m', n60m: 'NQ 60m', r5m: 'RTH* 5m', r15m: 'RTH* 15m', r60m: 'RTH* 60m' };
const FL_ = { colA: 'candle colour = order dir', colO: 'candle colour against order', contA: 'colour aligned + close beyond prior close', cont2A: '2 aligned colours + close beyond prior', breakA: 'close beyond prior candle range (order dir)', breakO: 'close beyond prior range (against)',
  emaA: 'close on order side of 9EMA', emaO: 'close against order side of 9EMA', slopeA: '9EMA slope = order dir', trendA: 'trend (close+slope) = order dir', trendO: 'trend (close+slope) against order', confirmA: 'colour + close-vs-9EMA both aligned',
  revPatA: 'repo reversal candle aligned (rejection/engulf/doji)', revPatO: 'repo reversal candle against', engulfA: 'engulfing aligned', rejA: 'hammer/shooting-star aligned', rejO: 'hammer/shooting-star against', doji: 'doji (body<25%)', inside: 'inside bar', outside: 'outside bar',
  lineRejA: 'line rejection aligned (wick through BB/9EMA, closed back)', lineRejO: 'line rejection against', touchAny: 'candle touched any BB/9EMA line', bandRevA: 'touched the FAR band (bull order at lower band)', bandExtA: 'touched the band in order dir', near025: 'spot ≤0.25σ from a line', near05: 'spot ≤0.5σ from a line', lineBehind: 'nearest line behind the order (support)' };
// 1. class counts
const clsTbl = MONTHS.map(m => { const g = rows.filter(r => r.month === m); return [m, g.length, ...CLS.map(c => `${g.filter(r => r.cls === c).length} (${pct(g.filter(r => r.cls === c).length / g.length)})`), fmt(sum(g.filter(r => r.cls === 'ADD').map(r => r.ownPnl))), fmt(sum(g.filter(r => r.cls === 'REV').map(r => r.ownPnl)))]; });
const clsPnl = CLS.map(c => { const g = rows.filter(r => r.cls === c); return [c, g.length, fmt(sum(g.map(r => r.ownPnl))), pct(g.filter(r => r.ownPnl > 0).length / (g.length || 1)), fmt(median(g.map(r => r.ownPnl))), fmt(sum(g.filter(r => !OUTL.has(r.date)).map(r => r.ownPnl))), pct(g.filter(r => r.debitCredit === 'credit').length / (g.length || 1))]; });

// 2. triggers: rate vs null, day-bootstrap CI of the difference
function trig(cls, ser, feat) {
  const a = rows.filter(r => r.cls === cls && r.st && r.st[ser]), nl = nullRows.filter(r => r.cls === cls && r.st[ser]);
  if (!a.length) return null;
  const byD = new Map();
  const put = (D, i, v) => { let x = byD.get(D); if (!x) { x = [0, 0, 0, 0]; byD.set(D, x); } x[i] += v; };
  for (const r of a) { put(r.date, 0, r.st[ser][feat] ? 1 : 0); put(r.date, 1, 1); }
  for (const r of nl) { put(r.date, 2, r.st[ser][feat] ? 1 : 0); put(r.date, 3, 1); }
  const tot = [0, 1, 2, 3].map(i => sum([...byD.values()].map(x => x[i])));
  const rate = tot[0] / tot[1], nrate = tot[2] / tot[3];
  const days = [...byD.keys()], diffs = [];
  for (let bI = 0; bI < 300; bI++) { const s = [0, 0, 0, 0]; for (let k = 0; k < days.length; k++) { const x = byD.get(days[Math.floor(rnd() * days.length)]); for (let i = 0; i < 4; i++) s[i] += x[i]; } if (s[1] && s[3]) diffs.push(s[0] / s[1] - s[2] / s[3]); }
  return { cls, ser, feat, n: tot[1], days: days.length, rate, nrate, lift: nrate ? rate / nrate : null, lo: q(diffs, 0.05), hi: q(diffs, 0.95) };
}
const trigRows = [];
for (const cls of ['ADD', 'REV', 'OPEN']) for (const ser of ['n5m', 'n15m', 'n60m', 'r5m', 'r15m', 'r60m']) for (const f of FEATS) { const x = trig(cls, ser, f); if (x) trigRows.push(x); }
log('triggers done');
const sigTrig = cls => trigRows.filter(x => x.cls === cls && x.n >= 15 && (x.lo > 0 || x.hi < 0)).sort((a, b) => Math.abs(b.rate - b.nrate) - Math.abs(a.rate - a.nrate));
// REV vs ADD direct contrast (same feature, aligned to own order direction)
const contrast = [];
for (const ser of ['n5m', 'n15m', 'n60m', 'r5m', 'r15m', 'r60m']) for (const f of FEATS) { const a = trigRows.find(x => x.cls === 'ADD' && x.ser === ser && x.feat === f), r = trigRows.find(x => x.cls === 'REV' && x.ser === ser && x.feat === f); if (a && r) contrast.push({ ser, f, add: a, rev: r }); }
// TF agreement (confirmA count over 5/15/60) for ADD / REV / null
const tfAgree = (rs, pre, key = 'confirmA') => { const h = [0, 0, 0, 0]; let n = 0; for (const r of rs) { if (!TFS.every(tf => r.st && r.st[`${pre}${tf}`])) continue; n++; h[TFS.filter(tf => r.st[`${pre}${tf}`][key]).length]++; } return { n, h: h.map(x => x / (n || 1)) }; };
const agreeTbl = [];
for (const pre of ['n', 'r']) for (const key of ['confirmA', 'emaA', 'contA', 'trendA', 'trendO']) for (const cls of ['ADD', 'REV', 'OPEN']) {
  const a = tfAgree(rows.filter(r => r.cls === cls), pre, key), nl = tfAgree(nullRows.filter(r => r.cls === cls), pre, key);
  agreeTbl.push([pre === 'n' ? 'NQ-24h' : 'NDX-RTH*', key, cls, a.n, ...a.h.map(pct), ...nl.h.map(pct)]);
}
// waits
const waitStats = (rs, k) => { const v = rs.map(r => r.wait && r.wait[k]); const has = v.filter(fin); return { n: v.length, share: has.length / (v.length || 1), med: median(has), q25: q(has, 0.25), q75: q(has, 0.75), le5: v.filter(x => fin(x) && x <= 5).length / (v.length || 1), le15: v.filter(x => fin(x) && x <= 15).length / (v.length || 1) }; };

// 3. REV risk-curve
const R_ = revRows, RX = revRows.filter(r => !r.outlierDay);
const revByMonth = MONTHS.map(m => { const g = R_.filter(r => r.month === m); return [m, g.length, pct(share(g, r => r.floor1After > r.floor1Before)), pct(share(g, r => r.floor05After > r.floor05Before)), pct(share(g, r => r.worstOnOrderSide === 1)), pct(share(g, r => r.sitsOnWorst === 1)), pct(share(g, r => r.raisedLowest === 1)), fmt(median(g.map(r => r.floor1After - r.floor1Before))), fmt(median(g.map(r => r.plateauAfter))), fmt(median(g.map(r => r.plateauAfterSig)), 2), pct(share(g, r => r.spotOnPlateau === 1)), fmt(sum(g.map(r => r.ownPnl))), pct(share(g, r => r.ownPnl > 0))]; });
const revGeo = [['dist key strike → nearest prior opposite (pts)', R_.map(r => r.distNearestPts)], ['  same, σ', R_.map(r => r.distNearestSig)], ['dist → most recent prior opposite (pts)', R_.map(r => r.distLastPts)],
  ['minutes since most recent opposite', R_.map(r => r.minSinceLast)], ['minutes since first opposite', R_.map(r => r.minSinceFirst)],
  ['spot move since most recent opp (pts, + = in its favour)', R_.map(r => r.moveSinceLastPts)], ['spot move since first opp (pts)', R_.map(r => r.moveSinceFirstPts)], ['  same, σ', R_.map(r => r.moveSinceFirstSig)],
  ['run from last add to peak (pts)', R_.map(r => r.runSinceLastAddPts)], ['retrace from that peak at the REV (pts)', R_.map(r => r.retraceFromPeakPts)], ['  same, σ', R_.map(r => r.retraceSig)],
  ['flat top (≥max−5%) before (pts)', R_.map(r => r.plateauBefore)], ['flat top (≥max−5%) after (pts)', R_.map(r => r.plateauAfter)],
  ['span ≥80% of max (±2σ) before (pts)', R_.map(r => r.top80Before)], ['span ≥80% of max (±2σ) after (pts)', R_.map(r => r.top80After)],
  ['profit zone around spot before (pts, 0 = spot in loss)', R_.map(r => r.profitZoneBefore)], ['profit zone around spot after (pts)', R_.map(r => r.profitZoneAfter)],
  ['Δ floor ±1σ ($)', R_.map(r => r.floor1After - r.floor1Before)], ['Δ floor ±0.5σ ($)', R_.map(r => r.floor05After - r.floor05Before)], ['Δ at the prior worst point ($)', R_.map(r => r.dAtWorst)],
  ['own P&L at settle ($)', R_.map(r => r.ownPnl)], ['floor contribution over realised range ($)', R_.map(r => r.floorContribRange)]]
  .map(([k, v]) => [k, v.filter(fin).length, fmt(q(v, 0.25), /σ/.test(k) ? 2 : 0), fmt(median(v), /σ/.test(k) ? 2 : 0), fmt(q(v, 0.75), /σ/.test(k) ? 2 : 0)]);
// outcome split by REV geometry
const splitTbl = (label, f) => { const a = R_.filter(f), b = R_.filter(r => !f(r)); const st = g => `${g.length} / ${fmt(sum(g.map(r => r.ownPnl)))} / ${pct(share(g, r => r.ownPnl > 0))} / ${fmt(median(g.map(r => r.floor1After - r.floor1Before)))}`; return [label, st(a), st(b)]; };
const splits = [
  splitTbl('sits on the prior worst point', r => r.sitsOnWorst === 1),
  splitTbl('worst region on the order side', r => r.worstOnOrderSide === 1),
  splitTbl('raised floor where lowest', r => r.raisedLowest === 1),
  splitTbl('spot ran ≥0.5σ for the old side first', r => r.moveSinceFirstSig >= 0.5),
  splitTbl('retraced ≥0.25σ from the add peak', r => r.retraceSig >= 0.25),
  splitTbl('within 30 min of last add', r => r.minSinceLast != null && r.minSinceLast <= 30),
  splitTbl('plateau after ≥ 0.5σ', r => r.plateauAfterSig >= 0.5),
  splitTbl('credit order', r => r.debitCredit === 'credit'),
];

// 4. jump risk
const jByMonth = (rs, key) => MONTHS.map(m => { const v = rs.filter(r => r.month === m).map(r => r[key]); return [m, v.length, fmt(q(v, 0.05)), fmt(q(v, 0.25)), fmt(median(v)), fmt(q(v, 0.75))]; });
const DR = dayRows;
const tercile = (key) => { const s = [...DR].sort((a, b) => b[key] - a[key]); const n = s.length, out = []; for (const [lab, a, b] of [['smallest third', 0, Math.floor(n / 3)], ['middle third', Math.floor(n / 3), Math.floor(2 * n / 3)], ['largest third', Math.floor(2 * n / 3), n]]) { const g = s.slice(a, b); out.push([lab, g.length, `${fmt(g[g.length - 1][key])}..${fmt(g[0][key])}`, pct(share(g, r => r.win)), fmt(sum(g.map(r => r.pnl))), fmt(median(g.map(r => r.pnl))), fmt(sum(g.filter(r => !r.outlierDay).map(r => r.pnl)))]); } return out; };
const winLoss = key => [['win days', DR.filter(r => r.win)], ['loss days', DR.filter(r => !r.win)]].map(([l, g]) => [l, g.length, fmt(q(g.map(r => r[key]), 0.25)), fmt(median(g.map(r => r[key]))), fmt(q(g.map(r => r[key]), 0.75))]);
// time spent beyond budget
const budgets = [-2000, -4000, -6000, -10000];
const budgetTbl = MONTHS.map(m => { const v = jumpRows.filter(r => r.month === m && r.kind === '5min'); return [m, v.length, ...budgets.map(b => pct(share(v, r => r.mk100_vs15 < b)))]; });
const budgetDay = budgets.map(b => { const hit = DR.filter(r => r.maxJ100vs15 < b), ok = DR.filter(r => r.maxJ100vs15 >= b); return [`$${fmt(-b)}`, `${hit.length} / ${pct(share(hit, r => r.win))} / ${fmt(sum(hit.map(r => r.pnl)))}`, `${ok.length} / ${pct(share(ok, r => r.win))} / ${fmt(sum(ok.map(r => r.pnl)))}`]; });
// against vs with trend asymmetry
const asym = MONTHS.map(m => { const v = jumpRows.filter(r => r.month === m && r.kind === '5min' && r.tr15); return [m, v.length, fmt(median(v.map(r => r.mk100_vs15))), fmt(median(v.map(r => r.mk100_with15))), pct(share(v, r => r.mk100_vs15 < r.mk100_with15))]; });

// outcome by trigger (own P&L at settle) for ADD / REV
const OBT = [['n5m', 'bandRevA'], ['n5m', 'bandExtA'], ['n5m', 'revPatA'], ['n15m', 'revPatA'], ['n15m', 'trendA'], ['n15m', 'trendO'], ['n15m', 'breakO'], ['n15m', 'breakA'], ['n15m', 'lineRejO'], ['n15m', 'lineRejA'], ['r15m', 'trendA'], ['r15m', 'lineRejA'], ['n60m', 'trendA'], ['n60m', 'trendO'], ['r60m', 'trendA'], ['n15m', 'bandRevA'], ['n15m', 'bandExtA']];
const obtTbl = cls => OBT.map(([ser, f]) => { const g = rows.filter(r => r.cls === cls && r.st && r.st[ser]); const a = g.filter(r => r.st[ser][f]), b = g.filter(r => !r.st[ser][f]); const st = x => `${x.length} / ${fmt(sum(x.map(r => r.ownPnl)))} / ${pct(share(x, r => r.ownPnl > 0))}`; return [SERL_[ser], FL_[f], st(a), st(b), fmt(sum(a.filter(r => !OUTL.has(r.date)).map(r => r.ownPnl)))]; });
// bias vs trend over 5-min samples
const biasTbl = MONTHS.map(m => { const v = jumpRows.filter(r => r.month === m && r.kind === '5min'); const v15 = v.filter(r => r.biasVs15 !== 'n/a'), v60 = v.filter(r => r.biasVs60 !== 'n/a'); return [m, v.length, pct(share(v, r => r.bias === 0)), pct(share(v15, r => r.biasVs15 === 'against')), pct(share(v60, r => r.biasVs60 === 'against'))]; });
const biasWL = [['win days', DR.filter(r => r.win)], ['loss days', DR.filter(r => !r.win)]].map(([l, g]) => [l, g.length, fmt(median(g.map(r => r.shareBiasAgainst15)), 2), fmt(median(g.map(r => r.shareBiasAgainst60)), 2)]);
const budgetsL = [-2000, -5000, -10000, -20000];
const budgetLvlDay = budgetsL.map(b => { const hit = DR.filter(r => r.minLv100vs15 < b), ok = DR.filter(r => r.minLv100vs15 >= b); return [`$${fmt(-b)}`, `${hit.length} / ${pct(share(hit, r => r.win))} / ${fmt(sum(hit.map(r => r.pnl)))}`, `${ok.length} / ${pct(share(ok, r => r.win))} / ${fmt(sum(ok.map(r => r.pnl)))}`]; });
const budgetLvlDayW = budgetsL.map(b => { const hit = DR.filter(r => r.minLv100with15 < b), ok = DR.filter(r => r.minLv100with15 >= b); return [`$${fmt(-b)}`, `${hit.length} / ${pct(share(hit, r => r.win))} / ${fmt(sum(hit.map(r => r.pnl)))}`, `${ok.length} / ${pct(share(ok, r => r.win))} / ${fmt(sum(ok.map(r => r.pnl)))}`]; });
const lvlShare = MONTHS.map(m => { const v = jumpRows.filter(r => r.month === m && r.kind === '5min'); return [m, v.length, fmt(median(v.map(r => r.lv100_vs15))), fmt(q(v.map(r => r.lv100_vs15), 0.1)), fmt(median(v.map(r => r.lv100_with15))), fmt(q(v.map(r => r.lv100_with15), 0.1)), ...budgetsL.map(b => pct(share(v, r => r.lv100_vs15 < b)))]; });
const rhoMovePz = spearman(R_.filter(r => fin(r.moveSinceFirstPts)).map(r => r.moveSinceFirstPts), R_.filter(r => fin(r.moveSinceFirstPts)).map(r => r.profitZoneAfter));
const rhoMoveTop = spearman(R_.filter(r => fin(r.moveSinceFirstPts)).map(r => r.moveSinceFirstPts), R_.filter(r => fin(r.moveSinceFirstPts)).map(r => r.top80After));

// ══ 7b aggregates ══════════════════════════════════════════════════════════════════════════════════════
function solveLin(Am, bv) { const n = bv.length, M = Am.map((r, i) => [...r, bv[i]]); for (let i = 0; i < n; i++) { let mx = i; for (let k = i + 1; k < n; k++) if (Math.abs(M[k][i]) > Math.abs(M[mx][i])) mx = k; [M[i], M[mx]] = [M[mx], M[i]]; const piv = M[i][i] || 1e-12; for (let k = 0; k < n; k++) if (k !== i) { const f = M[k][i] / piv; for (let j = i; j <= n; j++) M[k][j] -= f * M[i][j]; } } return M.map((r, i) => r[n] / (r[i] || 1e-12)); }
function logitFit(X, y, lambda = 0.5) { const p = X[0].length; let w = new Array(p).fill(0); for (let it = 0; it < 30; it++) { const g = new Array(p).fill(0), Hm = Array.from({ length: p }, () => new Array(p).fill(0)); for (let i = 0; i < X.length; i++) { const z = X[i].reduce((a, x, j) => a + x * w[j], 0), pr = 1 / (1 + Math.exp(-z)), e = y[i] - pr, v = pr * (1 - pr); for (let a = 0; a < p; a++) { g[a] += e * X[i][a]; for (let b = 0; b < p; b++) Hm[a][b] += v * X[i][a] * X[i][b]; } } for (let a = 1; a < p; a++) { g[a] -= lambda * w[a]; Hm[a][a] += lambda; } const st = solveLin(Hm, g); w = w.map((x, j) => x + st[j]); if (Math.max(...st.map(Math.abs)) < 1e-7) break; } return w; }
function olsFit(X, y) { const p = X[0].length, A = Array.from({ length: p }, () => new Array(p).fill(0)), b = new Array(p).fill(0); for (let i = 0; i < X.length; i++) for (let a = 0; a < p; a++) { b[a] += X[i][a] * y[i]; for (let c = 0; c < p; c++) A[a][c] += X[i][a] * X[i][c]; } return solveLin(A, b); }
function bootFit(rs, feat, yOf, fit, reps = 300) {
  const X = rs.map(r => [1, ...feat(r)]), y = rs.map(yOf), w = fit(X, y);
  const days = [...new Set(rs.map(r => r.date))], idx = new Map(days.map(d => [d, []])); rs.forEach((r, i) => idx.get(r.date).push(i));
  const Bs = []; for (let b = 0; b < reps; b++) { const ii = []; for (let k = 0; k < days.length; k++) ii.push(...idx.get(days[Math.floor(rnd() * days.length)])); Bs.push(fit(ii.map(i => X[i]), ii.map(i => y[i]))); }
  return w.map((v, j) => ({ coef: v, lo: q(Bs.map(x => x[j]), 0.05), hi: q(Bs.map(x => x[j]), 0.95) }));
}
const RT = revRows.filter(r => r.minSinceLast != null);
const fast = r => (r.minSinceLast <= 30 ? 1 : 0);
const stt = g => `${g.length} / ${fmt(sum(g.map(r => r.ownPnl)))} / ${pct(share(g, r => r.ownPnl > 0))}`;
const meanDiffCI = (rs, f) => { const days = [...new Set(rs.map(r => r.date))], byD = new Map(days.map(d => [d, rs.filter(r => r.date === d)])); const md_ = a => { const t = a.filter(f), u = a.filter(r => !f(r)); return t.length && u.length ? mean(t.map(r => r.ownPnl)) - mean(u.map(r => r.ownPnl)) : null; }; const bs = []; for (let b = 0; b < 300; b++) { const a = []; for (let k = 0; k < days.length; k++) a.push(...byD.get(days[Math.floor(rnd() * days.length)])); const v = md_(a); if (fin(v)) bs.push(v); } return { d: md_(rs), lo: q(bs, 0.05), hi: q(bs, 0.95) }; };
const TK = Object.keys(revRows[0]).filter(k => k.startsWith('t_'));
const touchRank = TK.map(k => { const t = revRows.filter(r => r[k] === 1), u = revRows.filter(r => r[k] === 0); const ci = meanDiffCI(revRows.filter(r => r[k] === 0 || r[k] === 1), r => r[k] === 1); return { k, n: t.length, t, u, ci, pF: share(RT.filter(fast), r => r[k] === 1), pS: share(RT.filter(r => !fast(r)), r => r[k] === 1) }; })
  .filter(x => x.n >= 10 && x.u.length >= 10).sort((a, b) => b.ci.d - a.ci.d);
const TKL = k => k.replace('t_', '').replace('x3_', ' (last 3)_').replace('_', ' ').replace('n5m', 'NQ 5m').replace('n15m', 'NQ 15m').replace('n60m', 'NQ 60m').replace('r5m', 'RTH* 5m').replace('r15m', 'RTH* 15m').replace('r60m', 'RTH* 60m');
const twoByTwo = k => [[1, 1], [1, 0], [0, 1], [0, 0]].map(([t, f]) => { const g = RT.filter(r => r[k] === t && fast(r) === f); return [TKL(k), t ? 'touch' : 'no touch', f ? '≤30 min' : '>30 min', stt(g), fmt(mean(g.map(r => r.ownPnl)))]; });
const best = touchRank[0] ? touchRank[0].k : 't_anyBand';
const regs = ['t_anyBand', 't_n5mx3_band', best].filter((k, i, a) => a.indexOf(k) === i).map(k => {
  const rs = RT.filter(r => r[k] === 0 || r[k] === 1);
  const lg = bootFit(rs, r => [r[k], fast(r)], r => (r.ownPnl > 0 ? 1 : 0), logitFit);
  const lgI = bootFit(rs, r => [r[k], fast(r), r[k] * fast(r)], r => (r.ownPnl > 0 ? 1 : 0), logitFit);
  const ol = bootFit(rs, r => [r[k], fast(r)], r => Math.max(-10000, Math.min(10000, r.ownPnl)), olsFit);
  return { k, n: rs.length, lg, lgI, ol };
});
// run size
const RUNB = [[-1e9, 40, '<40'], [40, 80, '40-80'], [80, 120, '80-120'], [120, 1e9, '120+']];
const CONFB = [[0, 0, '0 lines'], [1, 2, '1-2'], [3, 99, '3+']];
const RR = revRows.filter(r => fin(r.runSize));
const runDist = [...MONTHS.filter(m => m === '2025-05' || m === '2025-06'), 'all'].map(m => { const g = m === 'all' ? RR : RR.filter(r => r.month === m); const v = g.map(r => r.runSize), v15 = g.map(r => r.runSize15), rt = g.map(r => r.runRetrace); return [m, g.length, fmt(q(v, 0.25)), fmt(median(v)), fmt(q(v, 0.75)), fmt(q(v, 0.9)), ...RUNB.map(([a, b]) => pct(share(g, r => r.runSize >= a && r.runSize < b))), fmt(median(v15)), fmt(median(rt)), pct(share(g, r => r.runLegDone === 1))]; });
const runOut = RUNB.map(([a, b, l]) => { const g = RR.filter(r => r.runSize >= a && r.runSize < b); return [l, stt(g), fmt(sum(g.filter(r => !r.outlierDay).map(r => r.ownPnl))), fmt(median(g.map(r => r.runRetrace))), fmt(median(g.map(r => r.confN)), 1), fmt(median(g.map(r => r.distBeyond))), pct(share(g, fast))]; });
const runConf = RUNB.flatMap(([a, b, l]) => CONFB.map(([c1, c2, cl]) => { const g = RR.filter(r => r.runSize >= a && r.runSize < b && r.confN >= c1 && r.confN <= c2); return [l, cl, stt(g), fmt(mean(g.map(r => r.ownPnl)))]; }));
const confRun = CONFB.map(([c1, c2, cl]) => { const g = RR.filter(r => r.confN >= c1 && r.confN <= c2); return [cl, g.length, fmt(q(g.map(r => r.runSize), 0.25)), fmt(median(g.map(r => r.runSize))), fmt(q(g.map(r => r.runSize), 0.75)), stt(g)]; });
const rhoRunConf = spearman(RR.filter(r => fin(r.confN)).map(r => r.runSize), RR.filter(r => fin(r.confN)).map(r => r.confN));
const RB = RR.filter(r => fin(r.distBeyond)); const rhoRunBeyond = spearman(RB.map(r => r.runSize), RB.map(r => r.distBeyond));
// balanced cost
const CP_ = revRows.filter(r => fin(r.pairTotW));
const TWB = [[-1e9, 0.9, '≤0.9W'], [0.9, 1.0, '0.9-1.0W'], [1.0, 1.1, '1.0-1.1W'], [1.1, 1e9, '>1.1W']];
const costDist = [...MONTHS.filter(m => m === '2025-05' || m === '2025-06'), 'all'].map(m => { const g = m === 'all' ? CP_ : CP_.filter(r => r.month === m); const v = g.map(r => r.pairTotW); return [m, g.length, fmt(q(v, 0.1), 2), fmt(q(v, 0.25), 2), fmt(median(v), 2), fmt(q(v, 0.75), 2), fmt(q(v, 0.9), 2), pct(share(g, r => r.pairTotW <= 1.0)), pct(share(g, r => r.pairTotW <= 1.05))]; });
const costOut = TWB.map(([a, b, l]) => { const g = CP_.filter(r => r.pairTotW > a && r.pairTotW <= b); return [l, stt(g), fmt(sum(g.filter(r => !r.outlierDay).map(r => r.ownPnl))), fmt(median(g.map(r => r.floor1After - r.floor1Before)))]; });
const hit = (k, tol = 0) => { const g = CP_.filter(r => r[k] != null && r[k] !== ''); return { n: g.length, h: share(g, r => Math.abs(r[k]) <= tol) }; };
const ruleTbl = [['cost-balance (total closest to W)', 'kBal'], ['nearest with total ≤ W', 'kUnder'], ['same short strike as the prior opposite', 'kSame'], ['midpoint nearest spot', 'kSpot']].map(([l, k]) => { const a = hit(k, 0), b = hit(k, 1); return [l, a.n, pct(a.h), pct(b.h)]; });
const agreeBS = share(CP_.filter(r => r.kSame != null && r.kSame !== ''), r => r.kBal === r.kSame);
const BK = revRows.filter(r => fin(r.bookTotW));
const bookOut = TWB.map(([a, b, l]) => { const g = BK.filter(r => r.bookTotW > a && r.bookTotW <= b); return [l, stt(g)]; });

// 5. per day
const revBuckets = [[0, 0], [1, 2], [3, 5], [6, 99]].map(([a, b]) => { const g = DR.filter(r => r.REV >= a && r.REV <= b); return [`${a}${b > a ? `-${b === 99 ? '+' : b}` : ''}`, g.length, pct(share(g, r => r.win)), fmt(sum(g.map(r => r.pnl))), fmt(median(g.map(r => r.pnl))), fmt(median(g.map(r => r.shareNeverUsd)), 2), fmt(median(g.map(r => r.maxJ100vs15)))]; });
const covTbl = MONTHS.map(m => { const g = DR.filter(r => r.month === m); const t = k => sum(g.map(r => r[k])); return [m, g.length, t('dirOrders'), pct(t('coveredByRev') / t('dirOrders')), pct(t('coveredAnyOpp') / t('dirOrders')), pct(t('flyOnly') / t('dirOrders')), pct(t('neverCovered') / t('dirOrders')), fmt(median(g.map(r => r.shareNeverUsd)), 2)]; });
const corrs = [['worst P&L level after 100pt jump vs 15m', 'minLv100vs15'], ['worst P&L level after 100pt jump WITH 15m', 'minLv100with15'], ['worst level after 150pt vs 15m', 'minLv150vs15'], ['share of samples book biased against 15m', 'shareBiasAgainst15'], ['share biased against 60m', 'shareBiasAgainst60'], ['REV count', 'REV'], ['ADD count', 'ADD'], ['max 100pt jump vs 15m ($)', 'maxJ100vs15'], ['max 100pt jump vs 60m ($)', 'maxJ100vs60'], ['median 100pt jump vs 15m', 'medJ100vs15'], ['share of debit never covered', 'shareNeverUsd'], ['share covered by REV', 'shareCovRevUsd']]
  .map(([l, k]) => { const g = DR.filter(r => fin(r[k])); return [l, g.length, fmt(spearman(g.map(r => r[k]), g.map(r => r.pnl)), 2), fmt(spearman(g.filter(r => !r.outlierDay).map(r => r[k]), g.filter(r => !r.outlierDay).map(r => r.pnl)), 2)]; });

// 6. timing
const revT = R_.filter(r => r.minSinceLast != null);
const within = [10, 15, 30, 60].map(N => [`≤ ${N} min after last same-bias order`, `${revT.filter(r => r.minSinceLast <= N).length} / ${revT.length} (${pct(share(revT, r => r.minSinceLast <= N))})`, `${revT.filter(r => r.minSinceLast <= N && r.retraceSig >= 0.25).length}`]);

// ══════════════════════════════════════════════════════════════════════════════════════════════════════
// REPORT
// ══════════════════════════════════════════════════════════════════════════════════════════════════════
const SERL = SERL_; const _unused = {n5m: 'NQ 5m', n15m: 'NQ 15m', n60m: 'NQ 60m', r5m: 'RTH* 5m', r15m: 'RTH* 15m', r60m: 'RTH* 60m' };
const FL = FL_; const _unused2 = { colA: 'candle colour = order dir', colO: 'candle colour against order', contA: 'colour aligned + close beyond prior close', cont2A: '2 aligned colours + close beyond prior', breakA: 'close beyond prior candle range (order dir)', breakO: 'close beyond prior range (against)',
  emaA: 'close on order side of 9EMA', emaO: 'close against order side of 9EMA', slopeA: '9EMA slope = order dir', trendA: 'trend (close+slope) = order dir', trendO: 'trend (close+slope) against order', confirmA: 'colour + close-vs-9EMA both aligned',
  revPatA: 'repo reversal candle aligned (rejection/engulf/doji)', revPatO: 'repo reversal candle against', engulfA: 'engulfing aligned', rejA: 'hammer/shooting-star aligned', rejO: 'hammer/shooting-star against', doji: 'doji (body<25%)', inside: 'inside bar', outside: 'outside bar',
  lineRejA: 'line rejection aligned (wick through BB/9EMA, closed back)', lineRejO: 'line rejection against', touchAny: 'candle touched any BB/9EMA line', bandRevA: 'touched the FAR band (bull at lower)', bandExtA: 'touched the band in order dir', near025: 'spot ≤0.25σ from a line', near05: 'spot ≤0.5σ from a line', lineBehind: 'nearest line behind the order (support)' };
const S = [];
S.push('# Phase 7 — reversal-opens ("natural covers"), adds, and opposite-to-trend jump risk\n');
S.push(`Generated by scripts/manual-trades/analyze-reversal-covers.js. ${new Set(rows.map(r => r.date)).size} days, ${rows.length} same-day book orders (carried-in excluded). Null = ${NNULL} random minutes (09:45-15:50) per order, same day, same direction. **DERIVED**: spot and NDX-RTH* lines (NQ − day basis, ±10-30 pt), σ and marks from IV backed out of the user's fills. In-sample, one trader, ${MONTHS.join('/')} 2025. Outlier days ${[...OUTL].join(', ')} dominate $.\n`);
S.push('## 1. Order classes (vs book expiry-payoff bias just before the order)\n');
S.push(md(['month', 'orders', ...CLS, 'ADD own $', 'REV own $'], clsTbl));
S.push(md(['class', 'n', 'own P&L', 'win%', 'median', 'P&L excl. outliers', 'credit%'], clsPnl));
S.push('## 2. Triggers (last completed candle before the fill; features aligned to the ORDER direction)\n');
S.push('### ADD — features off the null (90% day-bootstrap CI excludes 0), largest |Δ| first\n');
const trigTbl = a => md(['series', 'feature', 'n', 'rate', 'null', 'Δ pp', '90% CI'], a.slice(0, 18).map(x => [SERL[x.ser], FL[x.feat], x.n, pct(x.rate), pct(x.nrate), fmt((x.rate - x.nrate) * 100, 1), `${fmt(x.lo * 100, 1)}..${fmt(x.hi * 100, 1)}`]));
S.push(trigTbl(sigTrig('ADD')));
S.push('### REV — features off the null\n');
S.push(trigTbl(sigTrig('REV')));
S.push('### OPEN (first directional order on an empty/neutral book) — features off the null\n');
S.push(trigTbl(sigTrig('OPEN')));
S.push('### Key features, ADD vs REV side by side (rate / null)\n');
const KEYF = ['colA', 'contA', 'breakA', 'emaA', 'trendA', 'trendO', 'revPatA', 'revPatO', 'rejA', 'engulfA', 'doji', 'inside', 'lineRejA', 'bandRevA', 'bandExtA', 'near025'];
S.push(md(['feature', ...['n5m', 'n15m', 'n60m', 'r15m'].flatMap(s => [`ADD ${SERL[s]}`, `REV ${SERL[s]}`])], KEYF.map(f => [FL[f], ...['n5m', 'n15m', 'n60m', 'r15m'].flatMap(s => { const c = contrast.find(x => x.ser === s && x.f === f); return c ? [`${pct(c.add.rate)}/${pct(c.add.nrate)}`, `${pct(c.rev.rate)}/${pct(c.rev.nrate)}`] : ['—', '—']; })])));
S.push('### How many of 5/15/60m agree (order vs null): share with 0/1/2/3 TFs\n');
S.push(md(['series', 'feature', 'class', 'n', '0', '1', '2', '3', 'null 0', 'null 1', 'null 2', 'null 3'], agreeTbl));
S.push('### Wait from the most recent aligned reversal-signal candle (repo reversal candle or line rejection, ≤12 candles back) to the fill\n');
S.push(md(['series', 'class', 'n', 'has signal', 'median min', 'IQR', '≤5 min', '≤15 min', 'null ≤5', 'null ≤15', 'null median'], ['n5m', 'n15m', 'r5m', 'r15m'].flatMap(k => ['REV', 'ADD'].map(cls => { const a = waitStats(rows.filter(r => r.cls === cls && r.wait), k), nl = waitStats(nullRows.filter(r => r.cls === cls), k); return [SERL[k], cls, a.n, pct(a.share), fmt(a.med, 1), `${fmt(a.q25, 1)}-${fmt(a.q75, 1)}`, pct(a.le5), pct(a.le15), pct(nl.le5), pct(nl.le15), fmt(nl.med, 1)]; }))));
S.push('### Own P&L at settle by trigger (n / P&L / win%): feature true vs false\n');
S.push('ADD:\n'); S.push(md(['series', 'feature', 'true', 'false', 'true excl. outliers $'], obtTbl('ADD')));
S.push('REV:\n'); S.push(md(['series', 'feature', 'true', 'false', 'true excl. outliers $'], obtTbl('REV')));
S.push('## 3. Risk-curve effect of each REV (expiry payoff incl. premium, at the order\'s spot ± σ)\n');
S.push(md(['month', 'n', 'raised ±1σ floor', 'raised ±0.5σ floor', 'prior worst on order side', 'order sits on prior worst', 'raised floor where lowest', 'median Δ±1σ floor $', 'median plateau after (pts)', 'plateau σ', 'spot on plateau', 'own P&L', 'win%'], [...revByMonth, ['all', R_.length, pct(share(R_, r => r.floor1After > r.floor1Before)), pct(share(R_, r => r.floor05After > r.floor05Before)), pct(share(R_, r => r.worstOnOrderSide === 1)), pct(share(R_, r => r.sitsOnWorst === 1)), pct(share(R_, r => r.raisedLowest === 1)), fmt(median(R_.map(r => r.floor1After - r.floor1Before))), fmt(median(R_.map(r => r.plateauAfter))), fmt(median(R_.map(r => r.plateauAfterSig)), 2), pct(share(R_, r => r.spotOnPlateau === 1)), fmt(sum(R_.map(r => r.ownPnl))), pct(share(R_, r => r.ownPnl > 0))]]));
S.push(md(['REV geometry', 'n', 'q25', 'median', 'q75'], revGeo));
S.push(`Spearman(spot move since first opposite position, width after): profit zone ${fmt(rhoMovePz, 2)}, ≥80%-of-max span ${fmt(rhoMoveTop, 2)}. NOTE "prior worst on order side" / "sits on prior worst" are near-tautological for an opposite-direction order on a biased book.\n`);
S.push('Split of REV outcomes (n / own P&L / win% / median Δ±1σ floor): condition true vs false\n');
S.push(md(['condition', 'true', 'false'], splits));
S.push('## 4. Jump risk against the prevailing trend (NQ close vs 9EMA of the last completed candle)\n');
S.push('Book expiry bias (payoff slope over ±σ) vs the NQ trend, 5-minute samples:\n');
S.push(md(['month', 'samples', 'book neutral', 'biased AGAINST 15m trend', 'biased AGAINST 60m trend'], biasTbl));
S.push(md(['days', 'n', 'median share of samples against 15m', 'against 60m'], biasWL));
S.push('Book P&L LEVEL (intraday mark incl. premium paid) if NDX jumped 100 pts now, 5-minute samples:\n');
S.push(md(['month', 'samples', 'vs 15m median', 'vs 15m q10', 'WITH 15m median', 'WITH 15m q10', ...budgetsL.map(b => `vs15 < -$${fmt(-b)}`)], lvlShare));
S.push('Days whose worst 100-pt-AGAINST-15m P&L level breached a budget (days / win% / P&L) vs kept:\n');
S.push(md(['budget', 'breached', 'kept'], budgetLvlDay));
S.push('Same for a 100-pt jump WITH the 15m trend (continuation):\n');
S.push(md(['budget', 'breached', 'kept'], budgetLvlDayW));
S.push('Terciles of the day\'s worst 100-pt-against-15m P&L level:\n');
S.push(md(['tercile', 'days', 'range $', 'win%', 'P&L', 'median', 'P&L excl. outliers'], tercile('minLv100vs15')));
S.push('Intraday BS mark CHANGE ($) of the whole book for a 100-pt jump against the 15m trend, 5-minute samples (a profitable tent near its peak loses mark on ANY jump, so this scales with gamma/size):\n');
S.push(md(['month', 'samples', 'q05', 'q25', 'median', 'q75'], jByMonth(jumpRows.filter(r => r.kind === '5min'), 'mk100_vs15')));
S.push('Same, 60m trend:\n');
S.push(md(['month', 'samples', 'q05', 'q25', 'median', 'q75'], jByMonth(jumpRows.filter(r => r.kind === '5min'), 'mk100_vs60')));
S.push('Against vs WITH the 15m trend (median 100-pt mark change; share of samples where against is worse):\n');
S.push(md(['month', 'samples', 'against 15m', 'with 15m', 'against worse'], asym));
S.push('Share of 5-minute samples whose 100-pt-against-15m mark loss exceeds a budget:\n');
S.push(md(['month', 'samples', ...budgets.map(b => `> $${fmt(-b)}`)], budgetTbl));
S.push('Days by their WORST 100-pt-against-15m mark loss (days / win% / P&L): breached vs never breached\n');
S.push(md(['budget', 'breached', 'kept'], budgetDay));
S.push('Terciles of the day\'s worst 100-pt-against-15m mark loss:\n');
S.push(md(['tercile', 'days', 'range $', 'win%', 'P&L', 'median', 'P&L excl. outliers'], tercile('maxJ100vs15')));
S.push('Day max 100-pt jump (mark, vs 15m) on winning vs losing days:\n');
S.push(md(['days', 'n', 'q25', 'median', 'q75'], winLoss('maxJ100vs15')));
S.push('Day max 150-pt jump (mark, vs 15m):\n');
S.push(md(['days', 'n', 'q25', 'median', 'q75'], winLoss('maxJ150vs15')));
S.push('## 5. Outcomes per day\n');
S.push(md(['REV count', 'days', 'win%', 'P&L', 'median', 'median share of debit never covered', 'median max 100-pt jump'], revBuckets));
S.push('Directional OPEN/ADD orders later covered by an opposite order (count share) and debit share never covered:\n');
S.push(md(['month', 'days', 'dir orders', 'covered by REV', 'covered by any opp', 'fly only', 'never', 'median debit share never covered'], covTbl));
S.push('Spearman vs day P&L:\n');
S.push(md(['day metric', 'n', 'ρ all', 'ρ excl. outliers'], corrs));
S.push('## 6. Timing\n');
S.push(md(['REV timing', 'count', 'of which retraced ≥0.25σ from the add peak'], within));
const tsplit = (lab, f) => MONTHS.filter(m => m === '2025-05' || m === '2025-06').map(m => { const g = R_.filter(r => r.month === m && r.minSinceLast != null); const a = g.filter(f), b = g.filter(r => !f(r)); const st = x => `${x.length} / ${fmt(sum(x.map(r => r.ownPnl)))} / ${pct(share(x, r => r.ownPnl > 0))} / ${new Set(x.map(r => r.date)).size}d`; return [lab, m, st(a), st(b)]; });
S.push('\nStability by month (n / own P&L / win% / days): condition true vs false\n');
S.push(md(['condition', 'month', 'true', 'false'], [...tsplit('REV ≤30 min after last same-bias order', r => r.minSinceLast <= 30), ...tsplit('REV key strike = a prior opposite key strike (tight tent)', r => r.distNearestPts === 0),
  ...MONTHS.filter(m => m === '2025-05' || m === '2025-06').map(m => { const g = rows.filter(r => r.cls === 'REV' && r.month === m && r.st && r.st.n5m); const a = g.filter(r => r.st.n5m.bandRevA), b = g.filter(r => !r.st.n5m.bandRevA); const st = x => `${x.length} / ${fmt(sum(x.map(r => r.ownPnl)))} / ${pct(share(x, r => r.ownPnl > 0))} / ${new Set(x.map(r => r.date)).size}d`; return ['REV after NQ 5m tagged the old-trend band', m, st(a), st(b)]; })]));
S.push('## 7. Follow-up: band touch vs timing, run size and confluence, balanced-cost strikes\n');
S.push(`Touch = the last completed candle reached the line IN THE OLD-RUN direction (up run: high ≥ line − ${TOUCH_TOL} pts with the body low at/below it; "band" = the outer band on the old-trend side); "Rej" = also closed back. "(last 3)" = any of the last three 5m candles. Timing split = minutes since the last same-bias order (n ${RT.length}).\n`);
S.push('### Touch features ranked by mean REV own P&L (true − false, 90% day-bootstrap CI); P(touch) for ≤30-min vs later REVs\n');
S.push(md(['touch', 'true (n / $ / win)', 'false', 'Δ mean $', '90% CI', 'P(touch | ≤30m)', 'P(touch | >30m)'], touchRank.map(x => [TKL(x.k), stt(x.t), stt(x.u), fmt(x.ci.d), `${fmt(x.ci.lo)}..${fmt(x.ci.hi)}`, pct(x.pF), pct(x.pS)])));
S.push('### 2×2: touch × timing (n / P&L / win%, mean $)\n');
S.push(md(['touch feature', 'touch', 'timing', 'n / P&L / win', 'mean $'], [...twoByTwo('t_anyBand'), ...twoByTwo('t_n5mx3_band'), ...(best !== 't_anyBand' && best !== 't_n5mx3_band' ? twoByTwo(best) : [])]));
S.push('### Regressions (day-bootstrap 90% CI): logistic win ~ touch + fast (+ interaction); OLS own $ (winsorised ±$10k) ~ touch + fast\n');
S.push(md(['touch feature', 'n', 'logit touch', 'logit ≤30m', 'logit (w/ int.) touch', '≤30m', 'touch×≤30m', 'OLS $ touch', 'OLS $ ≤30m'], regs.map(x => { const c = v => `${fmt(v.coef, 2)} [${fmt(v.lo, 2)}..${fmt(v.hi, 2)}]`, cd = v => `${fmt(v.coef)} [${fmt(v.lo)}..${fmt(v.hi)}]`; return [TKL(x.k), x.n, c(x.lg[1]), c(x.lg[2]), c(x.lgI[1]), c(x.lgI[2]), c(x.lgI[3]), cd(x.ol[1]), cd(x.ol[2])]; })));
S.push(`### Run size at REV entry (zigzag on DERIVED NDX-RTH* 1m highs/lows, threshold ${ZZ} pts, RTH only; run = last swing extreme opposite the old run → the old-run extreme before the fill; retrace = extreme → fill spot)\n`);
S.push(md(['month', 'n', 'q25', 'median', 'q75', 'q90', '<40', '40-80', '80-120', '120+', `median (zigzag ${ZZ_ALT})`, 'median retrace', 'old leg already reversed ≥Z'], runDist));
S.push(md(['run bucket', 'n / P&L / win', 'excl. outliers $', 'median retrace', 'median confluence', `median dist to next line beyond (> ${CONF_TOL} pts)`, 'share ≤30 min'], runOut));
S.push(`Confluence = number of the 24 lines (5/15/60m BB upper/mid/lower + 9EMA, NQ-24h shifted by basis AND NDX-RTH*) within ±${CONF_TOL} pts of the run extreme. Spearman(run, confluence) ${fmt(rhoRunConf, 2)} (n ${RR.length}); Spearman(run, distance to next line beyond) ${fmt(rhoRunBeyond, 2)} (n ${RB.length}).\n`);
S.push(md(['confluence', 'n', 'run q25', 'run median', 'run q75', 'n / P&L / win'], confRun));
S.push(md(['run bucket', 'confluence', 'n / P&L / win', 'mean $'], runConf));
S.push('### Balanced cost: earlier opposite vertical (most recent, SAME width) + REV, debit-equivalent per unit (credit → W − credit), real fills, fees excluded\n');
S.push(md(['month', 'pairs', 'q10 total/W', 'q25', 'median', 'q75', 'q90', '≤ W', '≤ 1.05W'], costDist));
S.push(md(['total/W', 'n / P&L / win', 'excl. outliers $', 'median Δ±1σ floor $'], costOut));
S.push(`Strike-choice test: alternative REV strikes ±${KMAX}×${STEP} pts priced with BS at the day IV fit (DERIVED), shifted so k=0 reproduces the real fill. Hit = the rule picks the strike actually used.\n`);
S.push(md(['rule', 'n', 'exact hit', 'within ±1 strike'], ruleTbl));
S.push(`Cost-balance and same-strike rules pick the same strike in ${pct(agreeBS)} of pairs where both are defined.\n`);
S.push(`Book level (FIFO-pair REV units against unpaired opposite vertical units, cost/W): n ${BK.length}, median ${fmt(median(BK.map(r => r.bookTotW)), 2)}, ≤ 1.0: ${pct(share(BK, r => r.bookTotW <= 1))}, ≤ 1.05: ${pct(share(BK, r => r.bookTotW <= 1.05))}.\n`);
S.push(md(['book total/W', 'n / P&L / win'], bookOut));
S.push('\nCSV: rc-orders.csv (class + trigger state per order), rc-triggers.csv (every feature × series × class vs null), rc-rev.csv (REV risk-curve rows), rc-jump-samples.csv, rc-days.csv.\n');
{
  const fp = path.join(OUT, 'reversal-covers-report.md');
  const old = fs.existsSync(fp) ? fs.readFileSync(fp, 'utf8') : '';
  const m = old.match(/<!-- HAND-START -->[\s\S]*?<!-- HAND-END -->/);
  const hand = m ? m[0] : '<!-- HAND-START -->\n(hand-written findings go here; kept across re-runs)\n<!-- HAND-END -->';
  const m2 = old.match(/<!-- HAND2-START -->[\s\S]*?<!-- HAND2-END -->/);
  const hand2 = m2 ? m2[0] : '<!-- HAND2-START -->\n(phase 7b hand-written findings)\n<!-- HAND2-END -->';
  S.splice(2, 0, hand + '\n', hand2 + '\n');
  fs.writeFileSync(fp, S.join('\n'));
}

// CSVs
const flat = rows.map(r => {
  const o = { date: r.date, month: r.month, orderNo: r.orderNo, timeET: r.timeET, cls: r.cls, dir: r.dir, bookBiasBefore: r.bias, style: r.style, debitCredit: r.debitCredit, S: r1(r.S), sg: r1(r.sg), keyK: r.keyK, ownPnl: r0(r.ownPnl), dayPnl: r0(r.dayPnl) };
  for (const ser of ['n5m', 'n15m', 'n60m', 'r5m', 'r15m', 'r60m']) { const st = r.st && r.st[ser]; for (const f of ['colA', 'contA', 'breakA', 'emaA', 'trendA', 'trendO', 'revPatA', 'revPatO', 'lineRejA', 'bandRevA', 'bandExtA', 'doji', 'inside', 'outside']) o[`${ser}_${f}`] = st ? (st[f] ? 1 : 0) : ''; o[`${ser}_nearLine`] = st ? st.nearLine : ''; o[`${ser}_nearSig`] = st ? r2(st.nearSig) : ''; }
  if (r.wait) for (const k of Object.keys(r.wait)) o[`wait_${k}`] = r1(r.wait[k]);
  return o;
});
fs.writeFileSync(path.join(OUT, 'rc-orders.csv'), toCsv(flat));
fs.writeFileSync(path.join(OUT, 'rc-triggers.csv'), toCsv(trigRows.map(x => ({ cls: x.cls, series: x.ser, feature: x.feat, n: x.n, days: x.days, rate: r2(x.rate), nullRate: r2(x.nrate), lift: r2(x.lift), ciLo: r2(x.lo), ciHi: r2(x.hi) }))));
fs.writeFileSync(path.join(OUT, 'rc-rev.csv'), toCsv(revRows));
fs.writeFileSync(path.join(OUT, 'rc-jump-samples.csv'), toCsv(jumpRows));
fs.writeFileSync(path.join(OUT, 'rc-days.csv'), toCsv(dayRows));
log('wrote', OUT);
