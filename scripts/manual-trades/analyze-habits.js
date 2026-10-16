#!/usr/bin/env node
'use strict';
/**
 * PHASE 3 of the manual-trades study: per-ORDER role / risk-curve / candle-context analysis of the user's real
 * 0DTE NDX trading (data/manual-trades/trades.json), then month-vs-month comparison tables.
 *
 *   node scripts/manual-trades/analyze-habits.js [--out data/manual-trades/analysis]
 *
 * Writes <out>/orders.csv, <out>/days.csv, <out>/orders.json, <out>/report-tables.md (all generated tables) and <out>/report.md:
 * created on first run; afterwards only the block between the AUTO-TABLES markers is replaced (hand-written text kept).
 *
 * Reuses: server/src/manual-trades/book.js (netting, payoff), routes.js helpers (bookOrders, payoffCurve, tfSeries,
 * nqAt, etToMs), server/src/candle-spread/bs-pricer.js (BS price / implied vol / skewed IV fn). Read-only; single process.
 *
 * ESTIMATES (flagged in the outputs):
 *   - spot = /NQ 1m close at the order minute − per-day basis (NQ back-adjusted; ±10-30 pt noise).
 *   - IV is backed out of the user's own leg fill prices (OTM legs ≥10 pts out, price ≥0.30) with BS (r=0) at that
 *     spot and time-to-16:00; per day a base + linear skew in ln(K/S) is fitted; per order the base is re-centred on
 *     its own OTM legs when it has any. sigma (implied move to close) = S·IV·sqrt(tau).
 *   - "MTM" intraday book value = cash + BS value of the open legs at estimated spot with the day IV fit.
 *   - floor / peak / profit zones are EXPIRY payoffs (incl. premium and fees) over a window = book strikes ∪ RTH range ± 250.
 */
const fs = require('fs');
const path = require('path');
const B = require('../../server/src/manual-trades/book');
const H = require('../../server/src/manual-trades/routes').helpers;
const BS = require('../../server/src/candle-spread/bs-pricer');

const ROOT = path.join(__dirname, '..', '..');
const DATA = path.join(ROOT, 'data', 'manual-trades');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const OUT = path.resolve(arg('--out', path.join(DATA, 'analysis')));
const OUTLIERS = ['2025-05-21', '2025-06-23'];

const r0 = n => (n == null || !isFinite(n) ? null : Math.round(n));
const r1 = n => (n == null || !isFinite(n) ? null : Math.round(n * 10) / 10);
const r2 = n => (n == null || !isFinite(n) ? null : Math.round(n * 100) / 100);
const r3 = n => (n == null || !isFinite(n) ? null : Math.round(n * 1000) / 1000);
const median = a => { const s = a.filter(x => x != null && isFinite(x)).sort((x, y) => x - y); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const sum = a => a.reduce((x, y) => x + (y || 0), 0);
const mean = a => { const s = a.filter(x => x != null && isFinite(x)); return s.length ? sum(s) / s.length : null; };

const T = JSON.parse(fs.readFileSync(path.join(DATA, 'trades.json'), 'utf8'));
const BASIS = JSON.parse(fs.readFileSync(path.join(DATA, 'market', 'basis.json'), 'utf8')).days || {};
const byNo = new Map();
for (const d of T.days) for (const o of d.orders) byNo.set(o.orderNo, o);

const nqCache = new Map();
function nqOf(date) {
  if (!nqCache.has(date)) {
    const p = path.join(DATA, 'market', 'nq-1m', `${date}.json`);
    nqCache.set(date, fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null);
  }
  return nqCache.get(date);
}
const TF_MIN = { '1m': 1, '5m': 5, '15m': 15, '60m': 60 };
const tfCache = new Map();
function seriesOf(date, tf) {
  const k = `${date}|${tf}`;
  if (!tfCache.has(k)) { const nq = nqOf(date); tfCache.set(k, nq ? H.tfSeries(nq.bars, tf, nq.warmup60m || []) : null); }
  return tfCache.get(k);
}

// ── order geometry ───────────────────────────────────────────────────────────────────────────────────────
const FLY_STYLES = new Set(['butterfly', 'broken-wing butterfly', 'asymmetric butterfly', 'condor', 'broken-wing condor', 'iron condor', 'iron butterfly']);
function flyKind(o) {
  if (o.style === 'butterfly') return 'fly';
  if (o.style === 'asymmetric butterfly') return o.subtype && o.subtype.startsWith('balanced') ? 'asymFly-balanced' : 'asymFly-unbalanced';
  if (o.style === 'broken-wing butterfly') return 'BWfly';
  if (o.style === 'condor' || o.style === 'broken-wing condor') return o.direction === 'short' ? 'short-condor' : 'condor';
  if (o.style.startsWith('iron')) return 'iron';
  return null;
}
function flyBody(o) {
  const ks = [...new Set(o.legs.map(l => l.strike))].sort((a, b) => a - b);
  if (o.center != null) return [o.center, o.center];
  if (ks.length === 4) return [ks[1], ks[2]];
  return [ks[0], ks[ks.length - 1]];
}

/** Zones of the payoff where value > 0 (interpolated crossings). Returns [{a,b,boundedLo,boundedHi}] */
function profitZones(curve) {
  const P = curve.points, out = [];
  let start = null;
  for (let i = 0; i < P.length; i++) {
    const p = P[i];
    if (p.y > 0 && start == null) {
      start = i === 0 ? p.x : P[i - 1].x + (P[i].x - P[i - 1].x) * (0 - P[i - 1].y) / (P[i].y - P[i - 1].y);
    }
    if (p.y <= 0 && start != null) {
      const x = P[i - 1].x + (P[i].x - P[i - 1].x) * (P[i - 1].y - 0) / (P[i - 1].y - P[i].y);
      out.push({ a: start, b: x }); start = null;
    }
  }
  if (start != null) out.push({ a: start, b: P[P.length - 1].x });
  return out.map(z => ({ ...z, boundedLo: z.a > curve.xMin, boundedHi: z.b < curve.xMax }));
}
const zoneAt = (zones, x) => zones.find(z => x >= z.a && x <= z.b) || null;
function valueAtCurve(curve, x) {
  const P = curve.points;
  if (x <= P[0].x) return P[0].y;
  for (let i = 1; i < P.length; i++) if (x <= P[i].x) return P[i - 1].y + (P[i].y - P[i - 1].y) * (x - P[i - 1].x) / (P[i].x - P[i - 1].x);
  return P[P.length - 1].y;
}
/** min of the piecewise-linear curve on [a,b] (endpoints + kinks inside) */
function localMin(curve, a, b) {
  let m = Math.min(valueAtCurve(curve, a), valueAtCurve(curve, b));
  for (const p of curve.points) if (p.x > a && p.x < b) m = Math.min(m, p.y);
  return m;
}
/** width of the region (contiguous, containing argmax) where payoff >= 90% of the peak (flat top / plateau) */
function flatTop(curve) {
  if (curve.max <= 0) return null;
  const thr = curve.max * 0.9, P = curve.points;
  const xs = [];
  for (let x = curve.xMin; x <= curve.xMax; x += 1) if (valueAtCurve(curve, x) >= thr) xs.push(x);
  if (!xs.length) return null;
  // contiguous run containing the argmax
  const iMax = P.reduce((b, p, i) => (p.y > P[b].y ? i : b), 0); const xm = P[iMax].x;
  let a = xm, b = xm;
  while (a - 1 >= curve.xMin && valueAtCurve(curve, a - 1) >= thr) a--;
  while (b + 1 <= curve.xMax && valueAtCurve(curve, b + 1) >= thr) b++;
  return { a, b, w: b - a };
}

// ── candle context ───────────────────────────────────────────────────────────────────────────────────────
const LINES = ['bbU', 'bbL', 'bbM', 'ema9'];
function candleCtx(date, ms, px, tf) {
  const s = seriesOf(date, tf);
  if (!s || px == null) return null;
  const tfMs = TF_MIN[tf] * 60e3;
  let i = -1;
  for (let k = 0; k < s.length; k++) if (s[k].t + tfMs <= ms) i = k; else break;
  if (i < 2 || s[i].bbU == null || s[i].ema9 == null) return null;
  const c = s[i], p = s[i - 1];
  const pb = (px - c.bbL) / (c.bbU - c.bbL);
  const trend = px > c.bbM && c.ema9 > c.bbM ? 'up' : px < c.bbM && c.ema9 < c.bbM ? 'down' : 'mixed';
  const colors = [s[i - 2], p, c].map(x => (x.c > x.o ? 'G' : x.c < x.o ? 'R' : '-')).join('');
  const hh = c.h > p.h, ll = c.l < p.l;
  let near = null;
  for (const L of LINES) { const d = px - c[L]; if (!near || Math.abs(d) < Math.abs(near.d)) near = { line: L, d }; }
  // line events on the last two completed candles (latest first; outer bands > midline > ema)
  let ev = null;
  const PRI = ['bbU', 'bbL', 'bbM', 'ema9'];
  for (const j of [i, i - 1]) {
    const a = s[j - 1], b = s[j];
    if (!a || a[PRI[0]] == null) continue;
    for (const L of PRI) {
      if (a[L] == null || b[L] == null) continue;
      if (a.c < a[L] && b.c > b[L]) { ev = { kind: 'break', dir: 'up', line: L, ago: i - j }; break; }
      if (a.c > a[L] && b.c < b[L]) { ev = { kind: 'break', dir: 'down', line: L, ago: i - j }; break; }
      if (a.c > a[L] && b.l <= b[L] && b.c > b[L]) { ev = { kind: 'bounce', dir: 'up', line: L, ago: i - j }; break; }
      if (a.c < a[L] && b.h >= b[L] && b.c < b[L]) { ev = { kind: 'reject', dir: 'down', line: L, ago: i - j }; break; }
    }
    if (ev) break;
  }
  return {
    pctB: r3(pb), vsEma: px > c.ema9 ? 'above' : 'below', emaSlope: r2(c.ema9 - p.ema9), mid: px > c.bbM ? 'above' : 'below',
    colors, hh, ll, trend, nearLine: near.line, nearDist: r1(near.d), ev,
  };
}
const withAgainst = (dir, trend) => (dir !== 'bull' && dir !== 'bear') || trend === 'mixed' ? 'n/a'
  : (dir === 'bull') === (trend === 'up') ? 'with' : 'against';

// ── per day ──────────────────────────────────────────────────────────────────────────────────────────────
const orderRows = [], dayRows = [];
for (const day of T.days) {
  const D = day.date;
  const seq = H.bookOrders(day, byNo);
  const basisD = BASIS[D] ? BASIS[D].basis : null;
  const settleOf = root => (root === 'NDX' && day.amSettle ? day.amSettle.value : day.settle);
  const closeMs = H.etToMs(D, '16:00');
  const nqD = nqOf(D);
  const rth = nqD && basisD != null ? nqD.bars.filter(b => b.t >= H.etToMs(D, '09:30') && b.t < closeMs) : [];

  // estimated spot / tau per order
  const info = seq.map(({ order: o, carried }) => {
    const td = o.date, nq = nqOf(td), bs = BASIS[td] ? BASIS[td].basis : null;
    const ms = o.timeET ? H.etToMs(td, o.timeET) : null;
    const nqPx = nq && ms != null ? H.nqAt(nq.bars, ms) : null;
    const S = nqPx != null && bs != null ? nqPx - bs : null;
    const tau = ms != null ? Math.max(0, (closeMs - ms) / BS.YEAR_MS) : null;
    return { o, carried, ms, nqPx, S, tau };
  });

  // IV fit from OTM leg fills
  const pts = [];
  for (const x of info) {
    if (x.S == null || !(x.tau > 0)) continue;
    x.legIv = [];
    for (const l of x.o.legs) {
      const R = l.type === 'call' ? 'C' : 'P';
      const otm = R === 'C' ? l.strike - x.S : x.S - l.strike;
      if (otm < 10 || !(l.price >= 0.3) || Math.abs(Math.log(l.strike / x.S)) > 0.015) continue;   // near-the-money only: far wings are noisy fills
      const iv = BS.impliedVol(R, x.S, l.strike, x.tau, l.price);
      if (iv == null || iv < 0.03 || iv > 2) continue;
      const lx = Math.log(l.strike / x.S);
      pts.push({ lx, iv, carried: x.carried }); x.legIv.push({ lx, iv });
    }
  }
  const fitPts = pts.filter(p => !p.carried).length >= 3 ? pts.filter(p => !p.carried) : pts;
  let base = median(fitPts.map(p => p.iv)), skew = 0;
  if (fitPts.length >= 4) {
    const mx = mean(fitPts.map(p => p.lx)), my = mean(fitPts.map(p => p.iv));
    const sxx = sum(fitPts.map(p => (p.lx - mx) ** 2)), sxy = sum(fitPts.map(p => (p.lx - mx) * (p.iv - my)));
    if (sxx > 1e-8) { skew = Math.max(-15, Math.min(2, sxy / sxx)); base = my - skew * mx; }
  }
  if (base == null) base = 0.2;
  for (const x of info) {
    // carried-in orders (traded the prior session) price overnight risk: their own-leg IV is not comparable, use the day fit
    const own = x.carried ? [] : (x.legIv || []).map(p => p.iv - skew * p.lx);
    x.iv = Math.max(0.05, Math.min(1.5, own.length ? median(own) : base));
    x.ivSource = own.length ? 'own-legs' : 'day-fit';
    x.sigma = x.S != null && x.tau > 0 ? x.S * x.iv * Math.sqrt(x.tau) : null;
  }

  // shared payoff window for floor/peak
  const allK = seq.flatMap(s => s.order.legs.map(l => l.strike));
  const rthLo = rth.length ? Math.min(...rth.map(b => b.l)) - basisD : day.settle, rthHi = rth.length ? Math.max(...rth.map(b => b.h)) - basisD : day.settle;
  const xMin = Math.floor((Math.min(...allK, rthLo, day.settle) - 250) / 10) * 10;
  const xMax = Math.ceil((Math.max(...allK, rthHi, day.settle) + 250) / 10) * 10;

  const legsAcc = []; let cash = 0;
  const curveOf = () => H.payoffCurve(B.netLegs(legsAcc), cash, xMin, xMax);
  let before = { legs: [], cash: 0, curve: H.payoffCurve([], 0, xMin, xMax) };
  const steps = [];
  info.forEach((x, k) => {
    const o = x.o;
    const oLegs = H.orderLegs(o);
    const prevNet = B.netLegs(legsAcc);
    legsAcc.push(...oLegs); cash += o.total;
    const after = { legs: B.netLegs(legsAcc), cash, curve: curveOf() };
    const own = H.payoffCurve(B.netLegs(oLegs), o.total, xMin, xMax);
    const ownPnl = sum(oLegs.map(l => l.qty * B.intrinsic(l.right, l.strike, settleOf(l.root)) * B.MULT)) + o.total;
    const S = x.S;
    const m = Math.max(x.sigma || 0, 25);
    const span = Math.max(1, before.curve.max - before.curve.min);
    let bias = 'flat';
    if (prevNet.length && S != null) {
      const diff = valueAtCurve(before.curve, S + m) - valueAtCurve(before.curve, S - m);
      bias = Math.abs(diff) < 0.1 * span ? 'neutral' : diff > 0 ? 'bull' : 'bear';
    }
    let dir = o.style === 'vertical' || o.style === 'single' ? o.direction : FLY_STYLES.has(o.style) ? 'neutral' : null;
    if (!dir && S != null) {
      const dd = valueAtCurve(own, S + m) - valueAtCurve(own, S - m);
      dir = Math.abs(dd) < 0.1 * Math.max(1, own.max - own.min) ? 'neutral' : dd > 0 ? 'bull' : 'bear';
    }
    // nets against existing legs?
    const nets = oLegs.some(l => prevNet.some(p => p.right === l.right && p.strike === l.strike && Math.sign(p.qty) !== Math.sign(l.qty)));

    // candle context (trade date)
    const ctx = {};
    for (const tf of Object.keys(TF_MIN)) ctx[tf] = x.ms != null ? candleCtx(o.date, x.ms, x.nqPx, tf) : null;

    // distance of nearest order strike from spot (OTM side for its direction)
    const ks = o.legs.map(l => l.strike);
    let otmPts = null;
    if (S != null && (dir === 'bull' || dir === 'bear')) {
      // OTM distance of the order's NEAREST strike in its profit direction (bull: strikes above spot are OTM)
      const near = dir === 'bull' ? Math.min(...ks) - S : S - Math.max(...ks);
      otmPts = near;
    }
    const sigOtm = otmPts != null && x.sigma ? otmPts / x.sigma : null;

    // ROLE
    const tr15 = ctx['15m'] ? ctx['15m'].trend : 'mixed', tr5 = ctx['5m'] ? ctx['5m'].trend : 'mixed';
    const zonesAfter = profitZones(after.curve), zonesBefore = profitZones(before.curve);
    const zA = S != null ? zoneAt(zonesAfter, S) : null;
    const boundedAfter = zonesAfter.filter(z => z.boundedLo && z.boundedHi);
    const boundedBefore = zonesBefore.filter(z => z.boundedLo && z.boundedHi);
    const nearestBounded = S != null && boundedAfter.length ? boundedAfter.reduce((b, z) => {
      const d = S < z.a ? z.a - S : S > z.b ? S - z.b : 0; return !b || d < b.d ? { z, d } : b; }, null) : null;
    let role, sub = '';
    const fk = flyKind(o);
    if (!prevNet.length) role = 'first-open';
    else if (o.effect !== 'open') role = 'restructure/close';
    else if (fk) role = 'fly';
    else if ((dir === 'bull' || dir === 'bear') && sigOtm != null && sigOtm >= 1.0) role = 'wing (far OTM ≥1σ)';
    else if ((dir === 'bull' || dir === 'bear') && (bias === 'bull' || bias === 'bear') && dir !== bias) {
      role = boundedAfter.length && boundedAfter.length >= boundedBefore.length && nearestBounded && nearestBounded.d <= Math.max(50, x.sigma || 0)
        ? 'offset→tent/plateau' : 'offset (no tent)';
    } else if ((dir === 'bull' || dir === 'bear') && dir === bias) {
      role = withAgainst(dir, tr15) === 'with' ? 'add same-dir WITH 15m trend' : withAgainst(dir, tr15) === 'against' ? 'add same-dir AGAINST 15m trend' : 'add same-dir (15m mixed)';
    } else if (dir === 'bull' || dir === 'bear') role = 'tilt neutral book';
    else role = 'other';
    if (role === 'first-open') sub = fk || (dir || '');

    // fly placement
    let fly = null;
    if (fk) {
      const [b1, b2] = flyBody(o), body = (b1 + b2) / 2;
      const ownZones = profitZones(own); const pz = ownZones.length ? { a: Math.min(...ownZones.map(z => z.a)), b: Math.max(...ownZones.map(z => z.b)) } : null;
      let placement = 'standalone';
      if (prevNet.length) {
        const vb = valueAtCurve(before.curve, body), eps = 0.1 * span;
        let maxL = -Infinity, maxR = -Infinity;
        for (const p of before.curve.points) { if (p.x < body) maxL = Math.max(maxL, p.y); if (p.x > body) maxR = Math.max(maxR, p.y); }
        if (vb < maxL - eps && vb < maxR - eps) placement = 'between peaks (valley)';
        else if (vb >= before.curve.max - eps) placement = 'on peak (stacking)';
        else placement = vb > 0 ? 'on slope (in profit zone)' : 'outside profit zone';
      }
      let entered = null, maxExc = null;
      if (pz && x.ms != null && rth.length) {
        const path = rth.filter(b => b.t >= x.ms - 60e3).map(b => ({ l: b.l - basisD, h: b.h - basisD }));
        entered = path.some(b => b.h >= pz.a && b.l <= pz.b);
      }
      const st = settleOf(o.root);
      fly = {
        kind: fk, body: r1(body), bodyDistPts: S != null ? r1(body - S) : null, bodyDistSig: S != null && x.sigma ? r2((body - S) / x.sigma) : null,
        pzLo: pz ? r1(pz.a) : null, pzHi: pz ? r1(pz.b) : null, pzWidth: pz ? r1(pz.b - pz.a) : null,
        placement, enteredAfter: entered, settleVsPz: pz ? (st < pz.a ? 'below' : st > pz.b ? 'above' : 'inside') : null,
        sigmaPzEdge: pz && S != null && x.sigma ? r2((S < pz.a ? pz.a - S : S > pz.b ? S - pz.b : 0) / x.sigma) : null,
      };
    }

    const ft = flatTop(after.curve);
    const row = {
      date: D, month: D.slice(0, 7), orderNo: o.orderNo, tradeDate: o.date, timeET: o.timeET, carried: x.carried, step: k,
      style: o.style, subtype: o.subtype || '', flyKind: fk || '', direction: dir, debitCredit: o.debitCredit,
      widths: (o.widths || []).join('/'), maxWidth: o.widths && o.widths.length ? Math.max(...(fk && o.widths.length === 3 ? [o.widths[0], o.widths[2]] : o.widths)) : null,
      qty: o.qty, contracts: sum(o.legs.map(l => l.qty)), netPerUnit: o.netPerUnit, total: r2(o.total),
      legs: o.legs.map(l => `${l.side === 'long' ? '+' : '-'}${l.qty} ${l.strike}${l.type === 'call' ? 'C' : 'P'}@${l.price}`).join(' '),
      spotEst: r1(S), ivEst: r3(x.iv), ivSource: x.ivSource, sigmaPts: r1(x.sigma), minsToClose: x.tau != null ? r0(x.tau * BS.YEAR_MS / 60e3) : null,
      otmPts: r1(otmPts), otmSig: r2(sigOtm),
      bookBias: bias, role, roleSub: sub, netsExisting: nets,
      floorBefore: r0(prevNet.length || before.cash ? before.curve.min : null), floorAfter: r0(after.curve.min),
      dFloor: r0(after.curve.min - (prevNet.length || before.cash ? before.curve.min : 0)),
      peakBefore: r0(prevNet.length ? before.curve.max : null), peakAfter: r0(after.curve.max),
      atSpotBefore: S != null && prevNet.length ? r0(valueAtCurve(before.curve, S)) : null, atSpotAfter: S != null ? r0(valueAtCurve(after.curve, S)) : null,
      spotInZoneAfter: zA ? 'inside' : S == null ? null : zonesAfter.length ? (S < zonesAfter[0].a ? 'below' : S > zonesAfter[zonesAfter.length - 1].b ? 'above' : 'between zones') : 'no zone',
      zoneWidthAtSpot: zA ? r0(zA.b - zA.a) : null, boundedZoneAfter: nearestBounded ? r0(nearestBounded.z.b - nearestBounded.z.a) : null,
      flatTopWidth: ft ? ft.w : null,
      // LOCAL floor: min of the expiry payoff within ±1σ of spot (the range the implied move says is likely)
      localFloorBefore: S != null && x.sigma && prevNet.length ? r0(localMin(before.curve, S - x.sigma, S + x.sigma)) : null,
      localFloorAfter: S != null && x.sigma ? r0(localMin(after.curve, S - x.sigma, S + x.sigma)) : null,
      dLocalFloor: S != null && x.sigma ? r0(localMin(after.curve, S - x.sigma, S + x.sigma) - (prevNet.length ? localMin(before.curve, S - x.sigma, S + x.sigma) : 0)) : null,
      floorPerDollar: o.total < 0 ? r2((after.curve.min - (prevNet.length ? before.curve.min : 0)) / -o.total) : null,
      ownPnl: r2(ownPnl),
      fly,
      ctx,
    };
    for (const tf of Object.keys(TF_MIN)) {
      const c = ctx[tf];
      row[`${tf}_trend`] = c ? c.trend : null;
      row[`${tf}_wa`] = c ? withAgainst(dir, c.trend) : null;
      row[`${tf}_pctB`] = c ? c.pctB : null;
      row[`${tf}_vsEma`] = c ? c.vsEma : null;
      row[`${tf}_emaSlope`] = c ? c.emaSlope : null;
      row[`${tf}_mid`] = c ? c.mid : null;
      row[`${tf}_colors`] = c ? c.colors : null;
      row[`${tf}_hhll`] = c ? `${c.hh ? 'HH' : ''}${c.ll ? 'LL' : ''}` || '-' : null;
      row[`${tf}_near`] = c ? `${c.nearLine}:${c.nearDist}` : null;
      row[`${tf}_event`] = c && c.ev ? `${c.ev.kind}-${c.ev.dir}:${c.ev.line}${c.ev.ago ? '(-1)' : ''}` : '';
      row[`${tf}_eventWA`] = c && c.ev && (dir === 'bull' || dir === 'bear') ? ((c.ev.dir === 'up') === (dir === 'bull') ? 'with' : 'against') : '';
    }
    orderRows.push(row);
    steps.push({ ms: x.ms, carried: x.carried, legs: after.legs, cash, curve: after.curve });
    before = after;
  });

  // fill vs model (verticals): day fit (base, skew), order's own spot/tau
  for (const row of orderRows.filter(r => r.date === D)) {
    const x = info[row.step];
    if (x.S == null || !(x.tau > 0)) continue;
    const ivFn = BS.makeIvFn({ base, skew }, x.S);
    const unit = x.o.qty || 1;
    let model = 0;
    for (const l of x.o.legs) {
      const R = l.type === 'call' ? 'C' : 'P';
      model += (l.side === 'long' ? 1 : -1) * (l.qty / unit) * BS.bsPrice(R, x.S, l.strike, x.tau, ivFn(l.strike));
    }
    row.modelNet = r2(model);
    row.fillResid = r2(x.o.netPerUnit - model);   // + = worse than model (paid more / received less)
    row.fillResidPctW = row.maxWidth ? r2(100 * row.fillResid / row.maxWidth) : null;
  }

  // intraday MTM path (BS with day fit) at estimated spot, from the first today order to 15:59
  const ivFnAt = Sx => BS.makeIvFn({ base, skew }, Sx);
  const firstMs = Math.min(...info.filter(x => !x.carried && x.ms != null).map(x => x.ms));
  let worstMtm = null, worstMtmT = null, worstIntr = null, peakMtm = -Infinity, maxDD = 0;
  const startMs = info.some(x => x.carried) ? H.etToMs(D, '09:30') : firstMs;
  for (const b of rth) {
    if (b.t + 60e3 < startMs) continue;
    const t = b.t + 60e3; const Sx = b.c - basisD;
    let st = null; for (const s of steps) if (s.carried || (s.ms != null && s.ms <= t)) st = s;
    if (!st) continue;
    const tau = Math.max(0, (closeMs - t) / BS.YEAR_MS);
    const ivf = ivFnAt(Sx);
    let v = st.cash; let vi = st.cash;
    for (const l of st.legs) { v += l.qty * BS.bsPrice(l.right, Sx, l.strike, tau, ivf(l.strike)) * B.MULT; vi += l.qty * B.intrinsic(l.right, l.strike, Sx) * B.MULT; }
    if (worstMtm == null || v < worstMtm) { worstMtm = v; worstMtmT = new Date(t).toISOString(); }
    if (worstIntr == null || vi < worstIntr) worstIntr = vi;
    peakMtm = Math.max(peakMtm, v); maxDD = Math.max(maxDD, peakMtm - v);
  }

  // day summary
  const rows = orderRows.filter(r => r.date === D);
  const fin = steps[steps.length - 1];
  const zf = profitZones(fin.curve);
  const zs = zoneAt(zf, day.settle);
  const lastSpot = [...info].reverse().find(x => x.S != null);
  const zLast = lastSpot ? zoneAt(zf, lastSpot.S) : null;
  const firstOffsetIdx = rows.findIndex(r => r.role.startsWith('offset'));
  const credit = rows.filter(r => r.debitCredit === 'credit');
  dayRows.push({
    date: D, month: D.slice(0, 7), pnl: day.pnl.net, orders: rows.length, carriedIn: rows.filter(r => r.carried).length,
    verticals: rows.filter(r => r.style === 'vertical').length, flies: rows.filter(r => r.flyKind).length,
    asymFlies: rows.filter(r => r.flyKind.startsWith('asym')).length, singles: rows.filter(r => r.style === 'single').length,
    creditShareCount: r2(credit.length / rows.length),
    creditShareCash: r2(sum(credit.map(r => Math.abs(r.total))) / Math.max(1, sum(rows.map(r => Math.abs(r.total))))),
    netCash: r0(fin.cash), peakDebitDeployed: r0(Math.max(0, ...steps.map(s => -s.cash))),
    peakAtRisk: r0(Math.max(0, ...steps.map(s => -s.curve.min))),
    finalFloor: r0(fin.curve.min), finalPeak: r0(fin.curve.max),
    plateauAtSettle: zs && zs.boundedLo && zs.boundedHi ? 'Y' : zs ? 'in-profit-unbounded' : 'N',
    settleZoneWidth: zs ? r0(zs.b - zs.a) : null,
    tentAtLastOrder: zLast && zLast.boundedLo && zLast.boundedHi ? 'Y' : 'N',
    ordersBeforeFirstOffset: firstOffsetIdx < 0 ? null : firstOffsetIdx,
    firstOrderET: rows.find(r => !r.carried) ? rows.find(r => !r.carried).timeET : null,
    lastOrderET: rows.length ? rows[rows.length - 1].timeET : null,
    worstMtm: r0(worstMtm), worstMtmAtET: worstMtmT ? new Date(worstMtmT).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false }).slice(0, 5) : null,
    maxDrawdownMtm: r0(maxDD), worstIntrinsicAtSpot: r0(worstIntr),
    ivBase: r3(base), ivSkew: r2(skew), ivPts: fitPts.length,
    finalStrikes: new Set(fin.legs.map(l => l.strike)).size,
    rthRangePts: rth.length ? r0(rthHi - rthLo) : null, settle: day.settle,
    dayMovePts: rth.length ? r1(day.settle - (rth[0].o - basisD)) : null,
  });
}

// ── outputs ──────────────────────────────────────────────────────────────────────────────────────────────
fs.mkdirSync(OUT, { recursive: true });
function toCsv(rows, cols) {
  const esc = v => { if (v == null) return ''; const s = typeof v === 'object' ? JSON.stringify(v) : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n') + '\n';
}
const flat = orderRows.map(r => {
  const { fly, ctx, ...rest } = r;
  return { ...rest, ...(fly ? Object.fromEntries(Object.entries(fly).map(([k, v]) => [`fly_${k}`, v])) : {}) };
});
const ocols = [...new Set(flat.flatMap(r => Object.keys(r)))];
fs.writeFileSync(path.join(OUT, 'orders.csv'), toCsv(flat, ocols));
fs.writeFileSync(path.join(OUT, 'orders.json'), JSON.stringify(orderRows));

// ── comparison tables ────────────────────────────────────────────────────────────────────────────────────
const MONTHS = ['2025-04', '2025-05', '2025-06', '2025-07'];
const MN = { '2025-04': 'Apr', '2025-05': 'May', '2025-06': 'Jun', '2025-07': 'Jul' };
const md = [];
const tbl = (head, rows) => { md.push(`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map(r => `| ${r.join(' | ')} |`), ''); };
const fmt = n => (n == null || !isFinite(n) ? '–' : Math.abs(n) >= 1000 ? Math.round(n).toLocaleString('en-US') : String(Math.round(n * 100) / 100));
const pct = (a, b) => (b ? `${Math.round(100 * a / b)}%` : '–');

for (const excl of [false, true]) {
  const DR = dayRows.filter(d => !excl || !OUTLIERS.includes(d.date));
  const OR = orderRows.filter(r => !excl || !OUTLIERS.includes(r.date));
  md.push(`### Month summary ${excl ? '(EXCLUDING 05-21 and 06-23)' : '(all days)'}`, '');
  const rows = [];
  const metric = (name, f) => rows.push([name, ...MONTHS.map(m => f(DR.filter(d => d.month === m), OR.filter(r => r.month === m)))]);
  metric('days', d => d.length);
  metric('P&L total', d => fmt(sum(d.map(x => x.pnl))));
  metric('P&L / day (mean)', d => fmt(mean(d.map(x => x.pnl))));
  metric('P&L / day (median)', d => fmt(median(d.map(x => x.pnl))));
  metric('win days', d => `${d.filter(x => x.pnl > 0).length}/${d.length}`);
  metric('orders / day', (d, o) => fmt(o.length / d.length));
  metric('verticals %', (d, o) => pct(o.filter(r => r.style === 'vertical').length, o.length));
  metric('flies (all kinds) %', (d, o) => pct(o.filter(r => r.flyKind).length, o.length));
  metric('  of which asym flies', (d, o) => o.filter(r => r.flyKind.startsWith('asym')).length);
  metric('singles', (d, o) => o.filter(r => r.style === 'single').length);
  metric('credit % (count)', (d, o) => pct(o.filter(r => r.debitCredit === 'credit').length, o.length));
  metric('credit % (verticals only)', (d, o) => pct(o.filter(r => r.style === 'vertical' && r.debitCredit === 'credit').length, o.filter(r => r.style === 'vertical').length));
  metric('median width (verticals)', (d, o) => fmt(median(o.filter(r => r.style === 'vertical').map(r => r.maxWidth))));
  metric('median qty / order', (d, o) => fmt(median(o.map(r => r.qty))));
  metric('median contracts / order', (d, o) => fmt(median(o.map(r => r.contracts))));
  metric('peak $ at risk / day (median)', d => fmt(median(d.map(x => x.peakAtRisk))));
  metric('peak net debit / day (median)', d => fmt(median(d.map(x => x.peakDebitDeployed))));
  metric('final floor (median)', d => fmt(median(d.map(x => x.finalFloor))));
  metric('final floor ≥ 0 days', d => `${d.filter(x => x.finalFloor >= 0).length}/${d.length}`);
  metric('plateau/tent around settle', d => `${d.filter(x => x.plateauAtSettle === 'Y').length}/${d.length}`);
  metric('tent around last-order spot', d => `${d.filter(x => x.tentAtLastOrder === 'Y').length}/${d.length}`);
  metric('orders before 1st offset (median)', d => fmt(median(d.map(x => x.ordersBeforeFirstOffset))));
  metric('days with no offset', d => d.filter(x => x.ordersBeforeFirstOffset == null).length);
  metric('worst MTM (median)', d => fmt(median(d.map(x => x.worstMtm))));
  metric('worst MTM (mean)', d => fmt(mean(d.map(x => x.worstMtm))));
  metric('max MTM drawdown (median)', d => fmt(median(d.map(x => x.maxDrawdownMtm))));
  metric('RTH range pts (median)', d => fmt(median(d.map(x => x.rthRangePts))));
  metric('|open→settle| pts (median)', d => fmt(median(d.map(x => Math.abs(x.dayMovePts)))));
  metric('IV est (median)', d => fmt(median(d.map(x => x.ivBase))));
  tbl(['metric', ...MONTHS.map(m => MN[m])], rows);

  md.push(`### Role mix and role P&L (own order P&L at settle) ${excl ? '(excl. outliers)' : '(all days)'}`, '');
  const roles = [...new Set(orderRows.map(r => r.role))].sort();
  tbl(['role', ...MONTHS.map(m => `${MN[m]} n`), ...MONTHS.map(m => `${MN[m]} P&L`), ...MONTHS.map(m => `${MN[m]} win%`)], roles.map(ro => {
    const g = m => OR.filter(r => r.month === m && r.role === ro);
    return [ro, ...MONTHS.map(m => g(m).length), ...MONTHS.map(m => fmt(sum(g(m).map(r => r.ownPnl)))), ...MONTHS.map(m => pct(g(m).filter(r => r.ownPnl > 0).length, g(m).length))];
  }));
  md.push(`Role share of orders ${excl ? '(excl.)' : ''}:`, '');
  tbl(['role', ...MONTHS.map(m => MN[m])], roles.map(ro => [ro, ...MONTHS.map(m => pct(OR.filter(r => r.month === m && r.role === ro).length, OR.filter(r => r.month === m).length))]));
}

md.push('### Time of day (share of orders, today-traded only)', '');
const buckets = ['09:30', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00'];
const bucketOf = t => { let b = buckets[0]; for (const x of buckets) if (t >= x) b = x; return t < '09:30' ? 'pre' : b; };
tbl(['bucket', ...MONTHS.map(m => MN[m])], ['pre', ...buckets].map(b => [b, ...MONTHS.map(m => { const o = orderRows.filter(r => r.month === m && !r.carried); return pct(o.filter(r => bucketOf(r.timeET) === b).length, o.length); })]));

md.push('### Widths (vertical max width / fly wing width)', '');
const wb = [[0, 10, '≤10'], [11, 25, '15-25'], [26, 50, '30-50'], [51, 100, '55-100'], [101, 1e9, '>100']];
tbl(['width', ...MONTHS.map(m => MN[m])], wb.map(([a, b, n]) => [n, ...MONTHS.map(m => { const o = orderRows.filter(r => r.month === m && r.maxWidth != null); return pct(o.filter(r => r.maxWidth >= a && r.maxWidth <= b).length, o.length); })]));

md.push('### Debit vs credit: fill vs model (verticals; model = BS with the day\'s IV fit backed out of the user\'s own fills)', '',
  'fillResid = netPerUnit − model (index pts per unit); + = worse than model (paid more / received less). Noisy: ±spot error and intraday IV drift. Compare columns, not absolute levels.', '');
tbl(['month', 'debit n', 'debit median resid', 'debit median resid %W', 'credit n', 'credit median resid', 'credit median resid %W'], MONTHS.map(m => {
  const v = orderRows.filter(r => r.month === m && r.style === 'vertical' && r.fillResid != null);
  const d = v.filter(r => r.debitCredit === 'debit'), c = v.filter(r => r.debitCredit === 'credit');
  return [MN[m], d.length, fmt(median(d.map(r => r.fillResid))), fmt(median(d.map(r => r.fillResidPctW))), c.length, fmt(median(c.map(r => r.fillResid))), fmt(median(c.map(r => r.fillResidPctW)))];
}));
md.push('Credit vs debit by role (count, all months):', '');
const roleList = [...new Set(orderRows.map(r => r.role))].sort();
tbl(['role', ...MONTHS.map(m => `${MN[m]} credit%`)], roleList.map(ro => [ro, ...MONTHS.map(m => { const o = orderRows.filter(r => r.month === m && r.role === ro); return o.length ? pct(o.filter(r => r.debitCredit === 'credit').length, o.length) : '–'; })]));

md.push('### Flies (all kinds) by month and placement', '');
const flies = orderRows.filter(r => r.fly);
tbl(['month', 'n', 'cost (sum debit $)', 'own P&L sum', 'win%', 'settled inside', 'ever entered after', 'median |body−spot| σ', 'median ΔFloor'], MONTHS.map(m => {
  const f = flies.filter(r => r.month === m);
  return [MN[m], f.length, fmt(sum(f.map(r => -r.total))), fmt(sum(f.map(r => r.ownPnl))), pct(f.filter(r => r.ownPnl > 0).length, f.length),
    pct(f.filter(r => r.fly.settleVsPz === 'inside').length, f.length), pct(f.filter(r => r.fly.enteredAfter).length, f.length),
    fmt(median(f.map(r => Math.abs(r.fly.bodyDistSig)))), fmt(median(f.map(r => r.dFloor)))];
}));
const plc = [...new Set(flies.map(r => r.fly.placement))];
tbl(['placement', 'n', 'May n', 'Jun n', 'own P&L sum', 'win%', 'settled inside', 'entered after', 'median ΔFloor (global)', 'median Δ local floor (±1σ)', 'median cost'], plc.map(p => {
  const f = flies.filter(r => r.fly.placement === p);
  return [p, f.length, f.filter(r => r.month === '2025-05').length, f.filter(r => r.month === '2025-06').length, fmt(sum(f.map(r => r.ownPnl))), pct(f.filter(r => r.ownPnl > 0).length, f.length),
    pct(f.filter(r => r.fly.settleVsPz === 'inside').length, f.length), pct(f.filter(r => r.fly.enteredAfter).length, f.length), fmt(median(f.map(r => r.dFloor))), fmt(median(f.map(r => r.dLocalFloor))), fmt(median(f.map(r => -r.total)))];
}));
const sigB = [[0, 0.5, '<0.5σ'], [0.5, 1, '0.5-1σ'], [1, 1.5, '1-1.5σ'], [1.5, 99, '≥1.5σ']];
md.push('Fly profit-zone EDGE distance from spot at order time (0 = spot already inside the fly\'s profit range):', '');
tbl(['edge distance', 'n', 'May', 'Jun', 'own P&L sum', 'win%', 'entered after', 'settled inside'], [[-1, 0.0001, 'inside (0)'], [0.0001, 0.5, '0-0.5σ'], [0.5, 1, '0.5-1σ'], [1, 99, '≥1σ']].map(([a, b, n]) => {
  const f = flies.filter(r => r.fly.sigmaPzEdge != null && r.fly.sigmaPzEdge >= a && r.fly.sigmaPzEdge < b);
  return [n, f.length, f.filter(r => r.month === '2025-05').length, f.filter(r => r.month === '2025-06').length, fmt(sum(f.map(r => r.ownPnl))), pct(f.filter(r => r.ownPnl > 0).length, f.length), pct(f.filter(r => r.fly.enteredAfter).length, f.length), pct(f.filter(r => r.fly.settleVsPz === 'inside').length, f.length)];
}));
md.push('Body distance from spot in σ:', '');
tbl(['|body−spot|', 'n', 'own P&L sum', 'win%', 'entered after', 'settled inside'], sigB.map(([a, b, n]) => {
  const f = flies.filter(r => r.fly.bodyDistSig != null && Math.abs(r.fly.bodyDistSig) >= a && Math.abs(r.fly.bodyDistSig) < b);
  return [n, f.length, fmt(sum(f.map(r => r.ownPnl))), pct(f.filter(r => r.ownPnl > 0).length, f.length), pct(f.filter(r => r.fly.enteredAfter).length, f.length), pct(f.filter(r => r.fly.settleVsPz === 'inside').length, f.length)];
}));
tbl(['fly kind', 'n', 'May', 'Jun', 'own P&L', 'win%'], [...new Set(flies.map(r => r.fly.kind))].map(k => {
  const f = flies.filter(r => r.fly.kind === k);
  return [k, f.length, f.filter(r => r.month === '2025-05').length, f.filter(r => r.month === '2025-06').length, fmt(sum(f.map(r => r.ownPnl))), pct(f.filter(r => r.ownPnl > 0).length, f.length)];
}));

md.push('### Candle context of directional orders (verticals/singles), with/against trend per TF', '');
const dirO = orderRows.filter(r => (r.direction === 'bull' || r.direction === 'bear') && !r.carried);
const ctxRows = [];
for (const tf of ['1m', '5m', '15m', '60m']) {
  ctxRows.push([`${tf} WITH trend`, ...MONTHS.map(m => { const o = dirO.filter(r => r.month === m); return pct(o.filter(r => r[`${tf}_wa`] === 'with').length, o.length); })]);
  ctxRows.push([`${tf} AGAINST trend`, ...MONTHS.map(m => { const o = dirO.filter(r => r.month === m); return pct(o.filter(r => r[`${tf}_wa`] === 'against').length, o.length); })]);
}
for (const tf of ['5m', '15m']) {
  ctxRows.push([`${tf} last event = reversal (bounce/reject)`, ...MONTHS.map(m => { const o = dirO.filter(r => r.month === m); return pct(o.filter(r => /^(bounce|reject)/.test(r[`${tf}_event`])).length, o.length); })]);
  ctxRows.push([`${tf} last event = break-and-close`, ...MONTHS.map(m => { const o = dirO.filter(r => r.month === m); return pct(o.filter(r => /^break/.test(r[`${tf}_event`])).length, o.length); })]);
  ctxRows.push([`${tf} order WITH the event direction`, ...MONTHS.map(m => { const o = dirO.filter(r => r.month === m && r[`${tf}_event`]); return pct(o.filter(r => r[`${tf}_eventWA`] === 'with').length, o.length); })]);
  ctxRows.push([`${tf} bull at %B>0.8 or bear at %B<0.2 (chasing)`, ...MONTHS.map(m => { const o = dirO.filter(r => r.month === m && r[`${tf}_pctB`] != null); return pct(o.filter(r => (r.direction === 'bull' && r[`${tf}_pctB`] > 0.8) || (r.direction === 'bear' && r[`${tf}_pctB`] < 0.2)).length, o.length); })]);
  ctxRows.push([`${tf} bull at %B<0.2 or bear at %B>0.8 (fading the band)`, ...MONTHS.map(m => { const o = dirO.filter(r => r.month === m && r[`${tf}_pctB`] != null); return pct(o.filter(r => (r.direction === 'bull' && r[`${tf}_pctB`] < 0.2) || (r.direction === 'bear' && r[`${tf}_pctB`] > 0.8)).length, o.length); })]);
}
tbl(['context', ...MONTHS.map(m => MN[m])], ctxRows);

md.push('### Directional-order outcome by 15m with/against (own P&L, all months)', '');
tbl(['15m', 'May n', 'May P&L', 'May win%', 'Jun n', 'Jun P&L', 'Jun win%'], ['with', 'against', 'n/a'].map(w => {
  const g = m => dirO.filter(r => r.month === m && r['15m_wa'] === w);
  return [w, g('2025-05').length, fmt(sum(g('2025-05').map(r => r.ownPnl))), pct(g('2025-05').filter(r => r.ownPnl > 0).length, g('2025-05').length),
    g('2025-06').length, fmt(sum(g('2025-06').map(r => r.ownPnl))), pct(g('2025-06').filter(r => r.ownPnl > 0).length, g('2025-06').length)];
}));

// ── habit / mistake diagnostics ──
const dayOf = Object.fromEntries(dayRows.map(d => [d.date, d]));
const firstToday = {};
for (const r of orderRows) if (!r.carried && !firstToday[r.date]) firstToday[r.date] = r;
md.push('### First order of the session: direction and 60m trend (day P&L median)', '');
tbl(['month', 'bull', 'bear', 'neutral (fly/condor)', 'vs 60m WITH', 'vs 60m AGAINST', 'n/a', 'median P&L when WITH', 'median P&L when AGAINST'], MONTHS.map(m => {
  const F = Object.values(firstToday).filter(r => r.month === m);
  const P = w => median(F.filter(r => r['60m_wa'] === w).map(r => dayOf[r.date].pnl));
  return [MN[m], F.filter(r => r.direction === 'bull').length, F.filter(r => r.direction === 'bear').length, F.filter(r => r.direction === 'neutral').length,
    F.filter(r => r['60m_wa'] === 'with').length, F.filter(r => r['60m_wa'] === 'against').length, F.filter(r => r['60m_wa'] === 'n/a').length, fmt(P('with')), fmt(P('against'))];
}));
md.push('### Fighting the tape: net count of bull vs bear directional orders vs the day\'s open→settle move', '');
const fightOf = d => {
  const rs = orderRows.filter(r => r.date === d.date);
  const b = rs.filter(r => r.direction === 'bull').length - rs.filter(r => r.direction === 'bear').length;
  return b === 0 || d.dayMovePts == null ? 'balanced' : (b > 0) === (d.dayMovePts > 0) ? 'aligned' : 'fighting';
};
for (const d of dayRows) d.netDirVsMove = fightOf(d);
tbl(['month', 'up days', 'aligned days', 'aligned median P&L', 'fighting days', 'fighting median P&L', 'fighting P&L sum', 'balanced'], MONTHS.map(m => {
  const ds = dayRows.filter(d => d.month === m);
  const g = k => ds.filter(d => d.netDirVsMove === k);
  return [MN[m], `${ds.filter(d => d.dayMovePts > 0).length}/${ds.length}`, g('aligned').length, fmt(median(g('aligned').map(d => d.pnl))), g('fighting').length, fmt(median(g('fighting').map(d => d.pnl))), fmt(sum(g('fighting').map(d => d.pnl))), g('balanced').length];
}));
md.push('### Sizing relative to the implied move', '');
tbl(['month', 'median implied move σ (pts)', 'median vertical width', 'median width/σ', 'median |$| per order', 'median debit/width (debit verticals)', 'loss days settled AT the book floor', '$ lost on those days'], MONTHS.map(m => {
  const os = orderRows.filter(r => r.month === m), v = os.filter(r => r.style === 'vertical');
  const ds = dayRows.filter(d => d.month === m);
  const atF = ds.filter(d => d.pnl < 0 && d.pnl <= d.finalFloor + Math.max(200, 0.05 * Math.abs(d.finalFloor)));
  return [MN[m], fmt(median(os.filter(r => !r.carried).map(r => r.sigmaPts))), fmt(median(v.map(r => r.maxWidth))), fmt(median(v.filter(r => r.sigmaPts && !r.carried).map(r => r.maxWidth / r.sigmaPts))),
    fmt(median(os.map(r => Math.abs(r.total)))), fmt(median(v.filter(r => r.debitCredit === 'debit').map(r => r.netPerUnit / r.maxWidth))), `${atF.length}/${ds.length}`, fmt(sum(atF.map(d => d.pnl)))];
}));
md.push('### Same-direction adds: into a book that was winning vs losing at spot (own P&L)', '');
tbl(['month', 'adds when book ≥0 at spot', 'P&L', 'adds when book <0 at spot', 'P&L', 'median $ per add'], MONTHS.map(m => {
  const a = orderRows.filter(r => r.month === m && r.role.startsWith('add same'));
  const w = a.filter(r => !(r.atSpotBefore < 0)), l = a.filter(r => r.atSpotBefore < 0);
  return [MN[m], w.length, fmt(sum(w.map(r => r.ownPnl))), l.length, fmt(sum(l.map(r => r.ownPnl))), fmt(median(a.map(r => -r.total)))];
}));
md.push('### Offsets: floor raised and price-action trigger', '');
tbl(['month', 'offsets', 'raised floor %', 'median ΔFloor', 'raised local (±1σ) floor %', 'median floor $ per $ spent', 'credit %', '15m reversal-off-line in offset direction', '5m reversal-off-line in offset direction'], MONTHS.map(m => {
  const o = orderRows.filter(r => r.month === m && r.role.startsWith('offset'));
  return [MN[m], o.length, pct(o.filter(r => r.dFloor > 0).length, o.length), fmt(median(o.map(r => r.dFloor))), pct(o.filter(r => r.dLocalFloor > 0).length, o.length), fmt(median(o.map(r => r.floorPerDollar))), pct(o.filter(r => r.debitCredit === 'credit').length, o.length),
    pct(o.filter(r => /^(bounce|reject)/.test(r['15m_event']) && r['15m_eventWA'] === 'with').length, o.length), pct(o.filter(r => /^(bounce|reject)/.test(r['5m_event']) && r['5m_eventWA'] === 'with').length, o.length)];
}));
md.push('### Flies by month × profit-zone edge distance (σ) — cost, own P&L, wins', '');
for (const excl of [false, true]) {
  const F = flies.filter(r => !r.carried && (!excl || !OUTLIERS.includes(r.date)));
  tbl([`month ${excl ? '(excl. outliers)' : '(all)'}`, 'spot inside: n / cost / P&L / wins', '0-0.5σ: n / cost / P&L / wins', '≥0.5σ: n / cost / P&L / wins'], MONTHS.map(m => [MN[m], ...[[-1, 1e-4], [1e-4, 0.5], [0.5, 99]].map(([a, b]) => {
    const f = F.filter(r => r.month === m && r.fly.sigmaPzEdge != null && r.fly.sigmaPzEdge >= a && r.fly.sigmaPzEdge < b);
    return `${f.length} / ${fmt(sum(f.map(r => -r.total)))} / ${fmt(sum(f.map(r => r.ownPnl)))} / ${f.filter(r => r.ownPnl > 0).length}`;
  })]));
}
md.push('### Simplicity', '');
tbl(['month', 'distinct widths / day', 'distinct structures / day', 'final book strikes', 'gross $ traded / day (median)'], MONTHS.map(m => {
  const ds = dayRows.filter(d => d.month === m);
  const per = ds.map(d => { const rs = orderRows.filter(r => r.date === d.date); return { w: new Set(rs.map(r => r.widths)).size, s: new Set(rs.map(r => r.flyKind || r.style + r.direction)).size, g: sum(rs.map(r => Math.abs(r.total))) }; });
  return [MN[m], fmt(median(per.map(p => p.w))), fmt(median(per.map(p => p.s))), fmt(median(ds.map(d => d.finalStrikes))), fmt(median(per.map(p => p.g)))];
}));

md.push('### Per-day table', '');
tbl(['date', 'P&L', 'orders', 'V/fly/single', 'asym', 'credit%', 'final floor', 'plateau@settle', 'zone w', 'worst MTM', 'peak at-risk', '1st offset after', 'IV'],
  dayRows.map(d => [d.date, fmt(d.pnl), d.orders, `${d.verticals}/${d.flies}/${d.singles}`, d.asymFlies, pct(d.creditShareCount * 100, 100), fmt(d.finalFloor), d.plateauAtSettle, d.settleZoneWidth == null ? '–' : d.settleZoneWidth,
    fmt(d.worstMtm), fmt(d.peakAtRisk), d.ordersBeforeFirstOffset == null ? '–' : d.ordersBeforeFirstOffset, d.ivBase]));

fs.writeFileSync(path.join(OUT, 'days.csv'), toCsv(dayRows, Object.keys(dayRows[0])));
const tables = md.join('\n');
fs.writeFileSync(path.join(OUT, 'report-tables.md'), tables);
const rp = path.join(OUT, 'report.md');
const START = '<!-- AUTO-TABLES:START -->', END = '<!-- AUTO-TABLES:END -->';
if (fs.existsSync(rp)) {
  const cur = fs.readFileSync(rp, 'utf8');
  const i = cur.indexOf(START), j = cur.indexOf(END);
  if (i >= 0 && j > i) fs.writeFileSync(rp, cur.slice(0, i + START.length) + '\n' + tables + '\n' + cur.slice(j));
}
else fs.writeFileSync(rp, `# Manual-trade habits: generated tables\n\nGenerated by scripts/manual-trades/analyze-habits.js. Add hand-written findings ABOVE the marker; re-runs replace only the block between the markers.\n\n${START}\n${tables}\n${END}\n`);
console.log(`orders ${orderRows.length}, days ${dayRows.length} -> ${OUT}`);
