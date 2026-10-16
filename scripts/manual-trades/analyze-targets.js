#!/usr/bin/env node
'use strict';
/**
 * PHASE 4 of the manual-trades study: CLOSE TARGETS and FLOORS.
 *
 * Hypothesis under test (user): "maybe it was less about signals and covering and more about picking good likely CLOSE
 * TARGETS and optimizing positions toward there ... those floors must have been in areas I didn't expect the underlying
 * to get to."
 *
 *   node scripts/manual-trades/analyze-targets.js [--out data/manual-trades/analysis] [--draws 400]
 *
 * Writes <out>/targets-days.csv (one row per day: final target/zone/floor, settle vs target, floor probability),
 *        <out>/targets-steps.csv (one row per book step: how the target moved order by order),
 *        <out>/targets-levels.csv (one row per target strike: distance to every candidate level type),
 *        <out>/targets-report.md (all tables; hand-written text above the AUTO-TABLES marker is kept on re-runs).
 *
 * Reuses phase 1-3: book.js (netting/payoff), routes.js helpers (bookOrders, payoffCurve, tfSeries, nqAt, etToMs),
 * orders.json from analyze-habits.js (per-order spotEst, ivEst, sigmaPts = implied move to 16:00 backed out of the
 * user's own fills). Read-only; single process.
 *
 * ESTIMATES (flagged):
 *   - spot / intraday levels (60m, 15m BB+9EMA, overnight H/L, RTH H/L so far) are /NQ − per-day basis: ±10-30 pt noise.
 *     Daily levels (BB(20,2), 9EMA, prior H/L/C, today's open) come from the EXACT NDX daily file (no basis noise).
 *   - settle probabilities use a NORMAL(spot, sigma) for the close (no skew, no drift).
 *   - "target" = the book's EXPIRY payoff shape (incl. premium and fees), not its intraday mark.
 */
const fs = require('fs');
const path = require('path');
const B = require('../../server/src/manual-trades/book');
const H = require('../../server/src/manual-trades/routes').helpers;
const BS = require('../../server/src/candle-spread/bs-pricer');
const IND = require('../../server/src/candle-spread/signals/indicators');

const ROOT = path.join(__dirname, '..', '..');
const DATA = path.join(ROOT, 'data', 'manual-trades');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const OUT = path.resolve(arg('--out', path.join(DATA, 'analysis')));
const DRAWS = +arg('--draws', 400);

const r0 = n => (n == null || !isFinite(n) ? null : Math.round(n));
const r1 = n => (n == null || !isFinite(n) ? null : Math.round(n * 10) / 10);
const r2 = n => (n == null || !isFinite(n) ? null : Math.round(n * 100) / 100);
const fin = x => x != null && isFinite(x);
const sum = a => a.reduce((x, y) => x + (y || 0), 0);
const mean = a => { const s = a.filter(fin); return s.length ? sum(s) / s.length : null; };
const median = a => { const s = a.filter(fin).sort((x, y) => x - y); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const ncdf = BS.ncdf;
// deterministic RNG (mulberry32) so the null tables are reproducible
let seed = 12345;
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

// ── NDX daily (exact) ───────────────────────────────────────────────────────────────────────────────────
const etDate = ms => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const NDXD = (() => {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'sweeps', 'daily-bb-2026-10-15', 'daily-NDX.json'), 'utf8'));
  const ind = IND.withIndicators(raw.map(b => ({ datetime: b.datetime, open: b.open, high: b.high, low: b.low, close: b.close })));
  return ind.map(c => ({ date: etDate(c.datetime + 12 * 3600e3), o: c.open, h: c.high, l: c.low, c: c.close, bbU: c.bbUpper, bbM: c.bbMiddle, bbL: c.bbLower, ema9: c.ema9 }));
})();
const ndxIdx = new Map(NDXD.map((r, i) => [r.date, i]));
/** Daily levels known on the morning of `date` (prior close's bands) + that day's open. */
function dailyLevels(date) {
  const i = ndxIdx.get(date);
  if (i == null || i < 1) return null;
  const p = NDXD[i - 1], t = NDXD[i];
  return { dBBU: p.bbU, dBBM: p.bbM, dBBL: p.bbL, dEMA9: p.ema9, pdH: p.h, pdL: p.l, pdC: p.c, open: t.o, _today: t };
}

// ── /NQ intraday ────────────────────────────────────────────────────────────────────────────────────────
const nqCache = new Map();
function nqOf(date) {
  if (!nqCache.has(date)) {
    const p = path.join(DATA, 'market', 'nq-1m', `${date}.json`);
    nqCache.set(date, fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null);
  }
  return nqCache.get(date);
}
const tfCache = new Map();
function seriesOf(date, tf) {
  const k = `${date}|${tf}`;
  if (!tfCache.has(k)) { const nq = nqOf(date); tfCache.set(k, nq ? H.tfSeries(nq.bars, tf, nq.warmup60m || []) : null); }
  return tfCache.get(k);
}
const TF_MIN = { '15m': 15, '60m': 60 };
/** All candidate levels (NDX terms) known at `ms` on trade date `date`. */
function levelsAt(date, ms) {
  const L = {};
  const dl = dailyLevels(date);
  if (dl) Object.assign(L, { dBBU: dl.dBBU, dBBM: dl.dBBM, dBBL: dl.dBBL, dEMA9: dl.dEMA9, pdH: dl.pdH, pdL: dl.pdL, pdC: dl.pdC, open: dl.open });
  const nq = nqOf(date), bs = BASIS[date] ? BASIS[date].basis : null;
  if (nq && bs != null && ms != null) {
    for (const tf of Object.keys(TF_MIN)) {
      const s = seriesOf(date, tf), tfMs = TF_MIN[tf] * 60e3;
      let c = null;
      for (const x of s) { if (x.t + tfMs <= ms) c = x; else break; }
      if (c && c.bbU != null) { L[`${tf}BBU`] = c.bbU - bs; L[`${tf}BBM`] = c.bbM - bs; L[`${tf}BBL`] = c.bbL - bs; L[`${tf}EMA9`] = c.ema9 - bs; }
    }
    const open = H.etToMs(date, '09:30');
    const on = nq.bars.filter(b => b.t < open);
    if (on.length) { L.onH = Math.max(...on.map(b => b.h)) - bs; L.onL = Math.min(...on.map(b => b.l)) - bs; }
    const rth = nq.bars.filter(b => b.t >= open && b.t + 60e3 <= ms);
    if (rth.length) { L.hodSoFar = Math.max(...rth.map(b => b.h)) - bs; L.lodSoFar = Math.min(...rth.map(b => b.l)) - bs; }
  }
  return L;
}
const LEVEL_TYPES = ['dBBU', 'dBBM', 'dBBL', 'dEMA9', '60mBBU', '60mBBM', '60mBBL', '60mEMA9', '15mBBU', '15mBBM', '15mBBL', '15mEMA9',
  'pdH', 'pdL', 'pdC', 'open', 'onH', 'onL', 'hodSoFar', 'lodSoFar'];
const EXACT = new Set(['dBBU', 'dBBM', 'dBBL', 'dEMA9', 'pdH', 'pdL', 'pdC', 'open']);   // NDX-exact (no basis noise)
const roundDist = (x, m) => { const r = ((x % m) + m) % m; return Math.min(r, m - r); };

// ── payoff shape ────────────────────────────────────────────────────────────────────────────────────────
function vAt(curve, x) {
  const P = curve.points;
  if (x <= P[0].x) return P[0].y;
  for (let i = 1; i < P.length; i++) if (x <= P[i].x) return P[i - 1].y + (P[i].y - P[i - 1].y) * (x - P[i - 1].x) / (P[i].x - P[i - 1].x);
  return P[P.length - 1].y;
}
/** Intervals of [xMin,xMax] where pred(V) holds, at 1-pt resolution. */
function intervals(curve, pred) {
  const out = []; let a = null;
  for (let x = curve.xMin; x <= curve.xMax; x++) {
    const ok = pred(vAt(curve, x));
    if (ok && a == null) a = x;
    if (!ok && a != null) { out.push([a, x - 1]); a = null; }
  }
  if (a != null) out.push([a, curve.xMax]);
  return out;
}
const pNorm = (iv, S, sg) => ncdf((iv[1] + 0.5 - S) / sg) - ncdf((iv[0] - 0.5 - S) / sg);
const distTo = (iv, x) => (x < iv[0] ? iv[0] - x : x > iv[1] ? x - iv[1] : 0);

/**
 * Target / floor description of one book curve. legs = netted legs (to know the strike span and tails).
 * S, sg: spot + implied 1-sigma move to the close at that moment (for probabilities); null → skipped.
 */
function shape(curve, legs, S, sg) {
  const ks = legs.map(l => l.strike);
  const kLo = Math.min(...ks), kHi = Math.max(...ks);
  const prof = B.payoffProfile(legs, 0);
  const tailGainLo = prof.unboundedBelow === 'gain', tailGainHi = prof.unboundedAbove === 'gain';
  const max = curve.max, min = curve.min;
  // the peak: the strike(s) where the payoff is maximal inside the strike span; plateau = ≥90% of max (contiguous)
  const span = curve.points.filter(p => p.x >= kLo && p.x <= kHi);
  const pmax = Math.max(...span.map(p => p.y));
  const peakPts = span.filter(p => p.y >= pmax - 1).map(p => p.x);
  const xPeak = peakPts.reduce((b, x) => (Math.abs(x - (S != null ? S : x)) < Math.abs(b - (S != null ? S : b)) ? x : b), peakPts[0]);
  let pa = xPeak, pb = xPeak;
  const thr = pmax > 0 ? pmax * 0.9 : pmax - 1;
  while (pa - 1 >= curve.xMin && vAt(curve, pa - 1) >= thr) pa--;
  while (pb + 1 <= curve.xMax && vAt(curve, pb + 1) >= thr) pb++;
  const plateauOpenLo = pa <= curve.xMin, plateauOpenHi = pb >= curve.xMax;
  // single target POINT: bounded plateau → its middle; plateau running into a tail → its inner edge
  const target = plateauOpenLo && plateauOpenHi ? xPeak : plateauOpenHi ? pa : plateauOpenLo ? pb : (pa + pb) / 2;
  // profit zone containing the peak
  const zones = intervals(curve, v => v > 0);
  const zMain = zones.find(z => xPeak >= z[0] && xPeak <= z[1]) || null;
  // payoff-weighted centre of the positive payoff, over the strike span (beyond it the payoff is linear: flagged)
  let wsum = 0, wx = 0;
  for (let x = kLo; x <= kHi; x++) { const v = Math.max(0, vAt(curve, x)); wsum += v; wx += v * x; }
  const pwCenter = wsum > 0 ? wx / wsum : null;
  const loss = intervals(curve, v => v < 0);
  const deep = min < 0 ? intervals(curve, v => v <= 0.5 * min) : [];
  const o = {
    max: r0(pmax), min: r0(min), xPeak, plateauLo: pa, plateauHi: pb, plateauW: pb - pa, plateauOpenLo, plateauOpenHi,
    target: r1(target), pwCenter: r1(pwCenter), zoneLo: zMain ? zMain[0] : null, zoneHi: zMain ? zMain[1] : null,
    zoneW: zMain ? zMain[1] - zMain[0] : 0, nZones: zones.length, tailGainLo, tailGainHi,
    zones, loss, deep,
  };
  if (S != null && sg > 0) {
    o.pProfit = sum(zones.map(z => pNorm(z, S, sg)));
    o.pLoss = sum(loss.map(z => pNorm(z, S, sg)));
    o.pDeep = sum(deep.map(z => pNorm(z, S, sg)));
    o.pPlateau = pNorm([pa, pb], S, sg);
    o.nearLossSig = loss.length ? Math.min(...loss.map(z => distTo(z, S))) / sg : null;
    o.nearDeepSig = deep.length ? Math.min(...deep.map(z => distTo(z, S))) / sg : null;
    o.targetVsSpotSig = (target - S) / sg;
    // EV of the expiry payoff under N(S, sg) (expected P&L incl. premium already paid)
    let ev = 0;
    for (let z = -4; z <= 4; z += 0.02) ev += vAt(curve, S + z * sg) * Math.exp(-z * z / 2) * 0.02 / Math.sqrt(2 * Math.PI);
    o.ev = ev;
  }
  return o;
}

// ── per day ─────────────────────────────────────────────────────────────────────────────────────────────
const dayRows = [], stepRows = [], targetRows = [], worked = new Map(), skillRows = [];
for (const day of T.days) {
  const D = day.date;
  const seq = H.bookOrders(day, byNo);
  if (!seq.length) continue;
  const bsD = BASIS[D] ? BASIS[D].basis : null;
  const nqD = nqOf(D);
  const openMs = H.etToMs(D, '09:30'), closeMs = H.etToMs(D, '16:00');
  const rth = nqD && bsD != null ? nqD.bars.filter(b => b.t >= openMs && b.t < closeMs) : [];
  const dl = dailyLevels(D);
  const openNdx = dl ? dl.open : null;
  const rthLo = dl ? dl._today.l : null, rthHi = dl ? dl._today.h : null;           // exact NDX day range
  const dc = DAYCSV.get(D) || {};
  const ivBase = +dc.ivBase || null;
  const sigOpen = openNdx && ivBase ? openNdx * ivBase * Math.sqrt(6.5 * 3600e3 / BS.YEAR_MS) : null;
  const settle = day.settle, pnl = day.pnl.net;

  const allK = seq.flatMap(s => s.order.legs.map(l => l.strike));
  const xMin = Math.floor((Math.min(...allK, rthLo || settle, settle) - 300) / 10) * 10;
  const xMax = Math.ceil((Math.max(...allK, rthHi || settle, settle) + 300) / 10) * 10;

  const legsAcc = []; let cash = 0;
  const steps = [];
  seq.forEach(({ order: o, carried }, k) => {
    legsAcc.push(...H.orderLegs(o)); cash += o.total;
    const net = B.netLegs(legsAcc);
    const curve = H.payoffCurve(net, cash, xMin, xMax);
    const oi = ORD.get(`${D}|${o.orderNo}`) || {};
    const S = fin(oi.spotEst) ? oi.spotEst : null;
    const sg = fin(oi.sigmaPts) ? oi.sigmaPts : null;
    const ms = o.timeET ? H.etToMs(o.date, o.timeET) : null;
    const sh = net.length ? shape(curve, net, S, sg) : null;
    steps.push({ k, o, oi, carried, S, sg, ms, net, cash, curve, sh });
  });
  if (!steps.length || !steps[steps.length - 1].sh) continue;

  // ── per-step table (target evolution) ──
  for (const st of steps) {
    const s = st.sh; if (!s) continue;
    stepRows.push({
      date: D, step: st.k, orderNo: st.o.orderNo, timeET: st.o.timeET || '', carried: st.carried, style: st.oi.style || st.o.style,
      flyKind: st.oi.flyKind || '', role: st.oi.role || '', spot: r1(st.S), sigma: r1(st.sg),
      target: s.target, xPeak: s.xPeak, plateauLo: s.plateauLo, plateauHi: s.plateauHi, plateauW: s.plateauW,
      zoneLo: s.zoneLo, zoneHi: s.zoneHi, zoneW: s.zoneW, pwCenter: s.pwCenter, max: s.max, floor: s.min,
      targetVsSpotSig: r2(s.targetVsSpotSig), pProfit: r2(s.pProfit), pLoss: r2(s.pLoss), pDeep: r2(s.pDeep), ev: r0(s.ev),
      settle, targetVsSettle: r1(s.target - settle), settleInZone: s.zones.some(z => settle >= z[0] && settle <= z[1]) ? 'Y' : 'N',
      atSettle: r0(vAt(st.curve, settle)),
    });
  }

  // ── final book ──
  const last = steps[steps.length - 1];
  const timedSteps = steps.filter(s => s.S != null && s.sg > 0 && s.sh);
  const lastT = timedSteps.length ? timedSteps[timedSteps.length - 1] : null;
  // final shape probabilities use the LAST order's spot/sigma (the moment the book took its final shape)
  const F = shape(last.curve, last.net, lastT ? lastT.S : null, lastT ? lastT.sg : null);
  const firstT = timedSteps.find(s => !s.carried) || timedSteps[0] || null;
  const first = firstT ? shape(firstT.curve, firstT.net, firstT.S, firstT.sg) : null;
  const sgL = lastT ? lastT.sg : null;
  const vSettle = vAt(last.curve, settle);
  const settleWhere = settle >= F.plateauLo && settle <= F.plateauHi ? 'plateau'
    : F.zones.some(z => settle >= z[0] && settle <= z[1]) ? 'profit-zone'
      : F.deep.some(z => settle >= z[0] && settle <= z[1]) ? 'deep-floor' : vSettle < 0 ? 'floor' : 'zero';
  const dZone = F.zones.length ? Math.min(...F.zones.map(z => distTo(z, settle))) : null;
  const dPlateau = distTo([F.plateauLo, F.plateauHi], settle);
  // path after the final shape: did price trade into the loss / deep-loss region, and did it visit the plateau?
  const pathFrom = (fromMs) => (rth.length ? rth.filter(b => fromMs == null || b.t >= fromMs).map(b => [b.l - bsD, b.h - bsD]) : []);
  const touches = (ivs, path) => path.some(([lo, hi]) => ivs.some(z => hi >= z[0] && lo <= z[1]));
  const pathAfter = pathFrom(lastT ? lastT.ms : null), pathAll = pathFrom(null);
  // floor geometry relative to open / implied range / day range
  const nearLossFromOpen = openNdx != null && F.loss.length ? Math.min(...F.loss.map(z => distTo(z, openNdx))) : null;
  const lossInsideDayRange = rthLo != null ? F.loss.some(z => z[1] >= rthLo && z[0] <= rthHi) : null;
  const lossInside1s = lastT ? F.loss.some(z => z[1] >= lastT.S - sgL && z[0] <= lastT.S + sgL) : null;
  // target drift: first → last, vs spot drift
  const tFirst = first ? first.target : null;
  const sFirst = firstT ? firstT.S : null;
  const tgtMoves = [], spotMoves = [];
  for (let i = 1; i < timedSteps.length; i++) {
    const a = timedSteps[i - 1], b = timedSteps[i];
    tgtMoves.push(b.sh.target - a.sh.target); spotMoves.push(b.S - a.S);
  }
  const dir = (() => { const x = F.target - (firstT ? firstT.S : openNdx); return Math.abs(x) < 0.25 * (sgL || 50) ? 'neutral' : x > 0 ? 'up' : 'down'; })();
  const move = settle - (firstT ? firstT.S : openNdx);
  const nFly = steps.filter(s => s.oi.flyKind).length;
  // book shape: loss on both sides of the profit zone = tent; loss on one side only = directional ramp
  const zLo = F.zoneLo != null ? F.zoneLo : F.xPeak, zHi = F.zoneHi != null ? F.zoneHi : F.xPeak;
  const lossBelow = F.loss.some(z => z[1] < zLo), lossAbove = F.loss.some(z => z[0] > zHi);
  const shapeClass = lossBelow && lossAbove ? 'tent' : lossBelow ? 'bull ramp' : lossAbove ? 'bear ramp' : 'no loss side';
  // time-matched forecast skill rows (today's timed orders only)
  for (const st of steps) {
    if (st.carried || st.ms == null || st.S == null || !st.sh || !sigOpen) continue;
    const lv = levelsAt(D, st.ms);
    skillRows.push({ date: D, win: pnl > 0, ms: st.ms, hr: (st.ms - openMs) / 3600e3, S: st.S, sg: st.sg, target: st.sh.target, pw: st.sh.pwCenter,
      settle, sigOpen, lv, shapeClass: (() => { const a = st.sh.zoneLo != null ? st.sh.zoneLo : st.sh.xPeak, b = st.sh.zoneHi != null ? st.sh.zoneHi : st.sh.xPeak; const lb = st.sh.loss.some(z => z[1] < a), la = st.sh.loss.some(z => z[0] > b); return lb && la ? 'tent' : lb ? 'bull ramp' : la ? 'bear ramp' : 'none'; })() });
  }
  // noon snapshot: the book as it stood at 12:00 ET, spot at 12:00, sigma from the day IV for the 4h left
  let noon = null;
  const noonMs = H.etToMs(D, '12:00');
  const atNoon = steps.filter(s => s.sh && (s.carried || (s.ms != null && s.ms <= noonMs))).pop();
  if (atNoon && nqD && bsD != null && ivBase) {
    const Sn = H.nqAt(nqD.bars, noonMs) - bsD;
    const sgn = Sn * ivBase * Math.sqrt(4 * 3600e3 / BS.YEAR_MS);
    noon = shape(atNoon.curve, atNoon.net, Sn, sgn);
    noon.S = Sn; noon.sg = sgn; noon.vSettle = vAt(atNoon.curve, settle);
  }
  const row = {
    date: D, month: D.slice(0, 7), pnl: r0(pnl), win: pnl > 0 ? 1 : 0, orders: steps.length, flies: nFly,
    open: r1(openNdx), settle: r1(settle), dayLo: r1(rthLo), dayHi: r1(rthHi), sigOpen: r1(sigOpen),
    firstET: firstT ? firstT.o.timeET : '', lastET: lastT ? lastT.o.timeET : '', spotFirst: r1(sFirst), spotLast: r1(lastT && lastT.S), sigLast: r1(sgL),
    tgtFirst: r1(tFirst), tgtFinal: F.target, pwCenter: F.pwCenter, xPeak: F.xPeak, plateauLo: F.plateauLo, plateauHi: F.plateauHi, plateauW: F.plateauW,
    plateauOpen: F.plateauOpenLo ? 'below' : F.plateauOpenHi ? 'above' : '', zoneLo: F.zoneLo, zoneHi: F.zoneHi, zoneW: F.zoneW,
    zoneWsig: r2(sigOpen ? F.zoneW / sigOpen : null), nZones: F.nZones, peak: F.max, floor: F.min,
    tgtDrift: r1(tFirst != null ? F.target - tFirst : null), spotDrift: r1(lastT && sFirst != null ? lastT.S - sFirst : null),
    tgtVsSpotLastSig: r2(F.targetVsSpotSig), bookDir: dir, moveFromFirst: r1(move),
    settleMinusTgt: r1(settle - F.target), dTgtSig: r2(sigOpen ? Math.abs(settle - F.target) / sigOpen : null),
    dTgtSigLast: r2(sgL ? Math.abs(settle - F.target) / sgL : null), dPwSig: r2(sigOpen && F.pwCenter != null ? Math.abs(settle - F.pwCenter) / sigOpen : null),
    dFirstTgtSig: r2(sigOpen && tFirst != null ? Math.abs(settle - tFirst) / sigOpen : null),
    dZone: r1(dZone), dPlateau: r1(dPlateau), settleWhere, vSettle: r0(vSettle), vSettleOverPeak: r2(F.max > 0 ? vSettle / F.max : null),
    pProfitFinal: r2(F.pProfit), pLossFinal: r2(F.pLoss), pDeepFinal: r2(F.pDeep), pPlateauFinal: r2(F.pPlateau), evFinal: r0(F.ev),
    nearLossSigLast: r2(F.nearLossSig), nearDeepSigLast: r2(F.nearDeepSig), nearLossFromOpen: r1(nearLossFromOpen),
    nearLossFromOpenSig: r2(sigOpen && nearLossFromOpen != null ? nearLossFromOpen / sigOpen : null),
    lossInside1s: lossInside1s == null ? '' : lossInside1s ? 'Y' : 'N', lossInsideDayRange: lossInsideDayRange == null ? '' : lossInsideDayRange ? 'Y' : 'N',
    touchedLossAfter: pathAfter.length ? (touches(F.loss, pathAfter) ? 'Y' : 'N') : '', touchedDeepAfter: pathAfter.length ? (touches(F.deep, pathAfter) ? 'Y' : 'N') : '',
    touchedPlateauAfter: pathAfter.length ? (touches([[F.plateauLo, F.plateauHi]], pathAfter) ? 'Y' : 'N') : '',
    touchedPlateauDay: pathAll.length ? (touches([[F.plateauLo, F.plateauHi]], pathAll) ? 'Y' : 'N') : '',
    settleMoveFromLastSig: r2(lastT ? (settle - lastT.S) / sgL : null),
    tgtSpotCorr: tgtMoves.length >= 3 ? r2(corr(tgtMoves, spotMoves)) : null,
    shapeClass, noonPLoss: r2(noon && noon.pLoss), noonNearLossSig: r2(noon && noon.nearLossSig), noonTgtVsSpotSig: r2(noon && noon.targetVsSpotSig),
    noonSpotInLoss: noon ? (noon.loss.some(z => noon.S >= z[0] && noon.S <= z[1]) ? 'Y' : 'N') : '', noonVSettle: r0(noon && noon.vSettle),
    lossIntervals: F.loss.map(z => `${z[0]}..${z[1]}`).join(' '), profitZones: F.zones.map(z => `${z[0]}..${z[1]}`).join(' '),
  };
  dayRows.push(row);
  worked.set(D, { row, steps, F });

  // ── target strikes for the level study ──
  for (const st of steps) {
    if (st.ms == null || st.S == null || !st.sh) continue;
    const td = st.o.date;
    const lv = levelsAt(td, st.ms);
    const add = (kind, K) => targetRows.push({ date: D, tradeDate: td, orderNo: st.o.orderNo, timeET: st.o.timeET, kind, K, S: st.S, sg: st.sg, lv });
    const o = st.o;
    const ks = [...new Set(o.legs.map(l => l.strike))].sort((a, b) => a - b);
    const fk = st.oi.flyKind;
    if (fk) {
      if (o.center != null) add('flyBody', o.center);
      else if (ks.length === 4) { add('flyBody', ks[1]); add('flyBody', ks[2]); }
    } else if (o.style === 'vertical') {
      const sh = o.legs.find(l => l.side === 'short');
      if (sh) add(o.debitCredit === 'credit' ? 'creditShort' : 'debitShort', sh.strike);
    }
    // book peak after this order (only when it changed: a new target decision)
    const prev = steps[st.k - 1];
    if (!prev || !prev.sh || prev.sh.xPeak !== st.sh.xPeak) add('bookPeak', st.sh.xPeak);
  }
  // final plateau edges (bounded edges only)
  if (lastT) {
    const lv = levelsAt(lastT.o.date, lastT.ms);
    if (!F.plateauOpenLo && F.plateauHi - F.plateauLo >= 10) targetRows.push({ date: D, tradeDate: lastT.o.date, orderNo: lastT.o.orderNo, timeET: lastT.o.timeET, kind: 'plateauEdge', K: F.plateauLo, S: lastT.S, sg: lastT.sg, lv });
    // break-even edges where the profit zone meets a LOSS region (the floor boundary the user accepted), at 10-pt grid
    for (const z of F.zones) for (const e of [z[0], z[1]]) {
      if (F.loss.some(l => Math.abs(l[1] + 1 - e) <= 1 || Math.abs(l[0] - 1 - e) <= 1)) targetRows.push({ date: D, tradeDate: lastT.o.date, orderNo: lastT.o.orderNo, timeET: lastT.o.timeET, kind: 'lossEdge', K: e, S: lastT.S, sg: lastT.sg, lv });
    }
    if (!F.plateauOpenHi && F.plateauHi - F.plateauLo >= 10) targetRows.push({ date: D, tradeDate: lastT.o.date, orderNo: lastT.o.orderNo, timeET: lastT.o.timeET, kind: 'plateauEdge', K: F.plateauHi, S: lastT.S, sg: lastT.sg, lv });
  }
}

function corr(a, b) {
  const n = Math.min(a.length, b.length); if (n < 3) return null;
  const ma = mean(a.slice(0, n)), mb = mean(b.slice(0, n));
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : null;
}
const ranks = a => { const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]); const r = new Array(a.length); for (let i = 0; i < idx.length;) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1; i = j + 1; } return r; };
function spearman(xs, ys) { const P = xs.map((x, i) => [x, ys[i]]).filter(([x, y]) => fin(x) && fin(y)); return P.length >= 5 ? corr(ranks(P.map(p => p[0])), ranks(P.map(p => p[1]))) : null; }
/** AUC: P(metric on a winning day > metric on a losing day); 0.5 = no information. */
function auc(rows, f, isWin = r => r.win === 1) {
  const W = rows.filter(isWin).map(f).filter(fin), L = rows.filter(r => !isWin(r)).map(f).filter(fin);
  if (!W.length || !L.length) return null;
  let s = 0; for (const w of W) for (const l of L) s += w > l ? 1 : w === l ? 0.5 : 0;
  return s / (W.length * L.length);
}

// ── level study: actual vs null ─────────────────────────────────────────────────────────────────────────
const LT = [...LEVEL_TYPES, 'round100', 'round50'];
function levelDist(K, lv, t) {
  if (t === 'round100') return roundDist(K, 100);
  if (t === 'round50') return roundDist(K, 50);
  return fin(lv[t]) ? Math.abs(K - lv[t]) : null;
}
// null A: random strike at about the same distance from spot (random side, ±25 pt jitter, 10-pt grid)
// null B (placebo): the same strike-vs-spot offset, but measured against ANOTHER order's levels re-centred on this spot
function nullHits(rows, t, tol) {
  let hA = 0, nA = 0, hB = 0, nB = 0;
  for (const r of rows) {
    const d = Math.abs(r.K - r.S);
    for (let i = 0; i < DRAWS / 4; i++) {
      const K2 = Math.round((r.S + (rnd() < 0.5 ? -1 : 1) * d + (rnd() * 50 - 25)) / 10) * 10;
      const x = levelDist(K2, r.lv, t); if (x != null) { nA++; if (x <= tol) hA++; }
      const o = rows[Math.floor(rnd() * rows.length)];
      if (t === 'round100' || t === 'round50') continue;
      if (!fin(o.lv[t])) continue;
      const lvShift = o.lv[t] - o.S + r.S;
      nB++; if (Math.abs(r.K - lvShift) <= tol) hB++;
    }
  }
  return { a: nA ? hA / nA : null, b: nB ? hB / nB : null };
}
function hitTable(rows) {
  const out = [];
  for (const t of LT) {
    const ds = rows.map(r => levelDist(r.K, r.lv, t)).filter(fin);
    if (!ds.length) continue;
    const h10 = ds.filter(d => d <= 10).length / ds.length, h20 = ds.filter(d => d <= 20).length / ds.length;
    const n10 = nullHits(rows, t, 10), n20 = nullHits(rows, t, 20);
    out.push({ t, n: ds.length, med: median(ds), h10, h20, n10a: n10.a, n20a: n20.a, n20b: n20.b, lift20a: n20.a && h20 * ds.length >= 5 ? h20 / n20.a : null, lift20b: n20.b && h20 * ds.length >= 5 ? h20 / n20.b : null, exact: EXACT.has(t) || t.startsWith('round') });
  }
  return out;
}

// settle vs levels (levels known at the LAST order, and the morning's levels at 09:45)
const settleRows = [];
for (const r of dayRows) {
  const w = worked.get(r.date);
  const lastT = w.steps.filter(s => s.S != null && s.sg > 0 && s.sh).pop();
  const morning = levelsAt(r.date, H.etToMs(r.date, '09:45'));
  const atLast = lastT && lastT.o.date === r.date ? levelsAt(r.date, lastT.ms) : morning;
  settleRows.push({ date: r.date, settle: r.settle, sig: r.sigOpen, open: r.open, morning, atLast, tgt: r.tgtFinal, pw: r.pwCenter, spotLast: r.spotLast, tgtFirst: r.tgtFirst });
}
function settleTable() {
  const out = [];
  const cands = [...LEVEL_TYPES.filter(t => t !== 'hodSoFar' && t !== 'lodSoFar').map(t => ({ t, f: (s, src) => s[src][t] })),
    { t: 'hodSoFar', f: (s) => s.atLast.hodSoFar, last: true }, { t: 'lodSoFar', f: (s) => s.atLast.lodSoFar, last: true },
    { t: 'USER final target', f: s => s.tgt, last: true }, { t: 'USER pw-center', f: s => s.pw, last: true },
    { t: 'USER first target', f: s => s.tgtFirst }, { t: 'spot @ last order', f: s => s.spotLast, last: true }];
  for (const c of cands) {
    for (const src of c.last ? ['atLast'] : ['morning', 'atLast']) {
      if (c.t === 'open' && src === 'atLast') continue;
      if (EXACT.has(c.t) && src === 'atLast') continue;     // daily levels don't change intraday
      const rows = settleRows.map(s => ({ s, L: c.f(s, src) })).filter(x => fin(x.L) && fin(x.s.sig));
      if (!rows.length) continue;
      const ds = rows.map(x => Math.abs(x.s.settle - x.L));
      const dsig = rows.map(x => Math.abs(x.s.settle - x.L) / x.s.sig);
      // null: this day's level vs a settle drawn from open + (another day's normalised move) × this day's sigma
      const moves = settleRows.filter(s => fin(s.sig) && fin(s.open)).map(s => (s.settle - s.open) / s.sig);
      let h = 0, n = 0;
      for (const x of rows) for (let i = 0; i < DRAWS; i++) { const st = x.s.open + moves[Math.floor(rnd() * moves.length)] * x.s.sig; n++; if (Math.abs(st - x.L) <= 20) h++; }
      out.push({ t: c.t, src: c.last ? 'last order' : src === 'morning' ? '09:45' : 'last order', n: rows.length, med: median(ds), medSig: median(dsig),
        h10: ds.filter(d => d <= 10).length / ds.length, h20: ds.filter(d => d <= 20).length / ds.length, null20: h / n, exact: EXACT.has(c.t) });
    }
  }
  return out;
}

// ── report ──────────────────────────────────────────────────────────────────────────────────────────────
const fmt = (v, d = 0) => (v == null || !isFinite(v) ? '—' : (+v).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d }));
const pct = v => (v == null || !isFinite(v) ? '—' : `${Math.round(v * 100)}%`);
const md = (head, rows) => `| ${head.join(' | ')} |\n|${head.map(() => '---').join('|')}|\n${rows.map(r => `| ${r.join(' | ')} |`).join('\n')}\n`;
const toCsv = (rows) => { const h = Object.keys(rows[0]); const q = v => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v)); return [h.join(','), ...rows.map(r => h.map(k => q(r[k])).join(','))].join('\n') + '\n'; };

const S = [];
const N = dayRows.length;
S.push(`Sample: ${N} trading days (2025-04-15..07-11), ${stepRows.length} book steps, ${targetRows.length} target strikes. One trader, one regime: treat every split below as directional, not significant. Spot and intraday levels carry ±10-30 pt basis noise (NQ − per-day basis); daily levels, open, prior H/L/C and the settle are exact NDX.\n`);

// 1. where did settle land vs the final book
const byWhere = {};
for (const r of dayRows) (byWhere[r.settleWhere] = byWhere[r.settleWhere] || []).push(r);
S.push('### 1a. Where the settle landed on the FINAL book\n');
S.push(md(['settle landed in', 'days', 'win days', 'P&L total', 'P&L median', 'median |settle−target| σ(day)', 'median P(profit) at final shape'],
  ['plateau', 'profit-zone', 'zero', 'floor', 'deep-floor'].filter(k => byWhere[k]).map(k => { const a = byWhere[k]; return [k, a.length, a.filter(r => r.win).length, fmt(sum(a.map(r => r.pnl))), fmt(median(a.map(r => r.pnl))), fmt(median(a.map(r => r.dTgtSig)), 2), pct(median(a.map(r => r.pProfitFinal)))]; })));
S.push('plateau = within the ≥90%-of-peak region; profit-zone = payoff > 0 outside it; floor = payoff < 0; deep-floor = payoff ≤ 50% of the book\'s worst value. A losing day is BY DEFINITION a settle in the floor — the question is whether that floor was far/unlikely (the user\'s claim) or near/likely.\n');

// 1b. what explains P&L
const metrics = [
  ['|settle − final target| (σ day)', r => r.dTgtSig, -1],
  ['|settle − final target| (σ at last order)', r => r.dTgtSigLast, -1],
  ['|settle − pw-centre| (σ day)', r => r.dPwSig, -1],
  ['|settle − FIRST target| (σ day)', r => r.dFirstTgtSig, -1],
  ['distance settle→plateau (pts)', r => r.dPlateau, -1],
  ['distance settle→profit zone (pts) [TAUTOLOGY: win ⇔ 0]', r => r.dZone, -1],
  ['profit-zone width (σ day)', r => r.zoneWsig, 1],
  ['P(profit) at final shape', r => r.pProfitFinal, 1],
  ['EV at final shape ($, N(spot,σ))', r => r.evFinal, 1],
  ['nearest loss region from last spot (σ)', r => r.nearLossSigLast, 1],
  ['EX-ANTE @noon: |target − spot| (σ to close)', r => (fin(r.noonTgtVsSpotSig) ? Math.abs(r.noonTgtVsSpotSig) : null), -1],
  ['EX-ANTE @noon: P(settle in loss)', r => r.noonPLoss, -1],
  ['EX-ANTE @noon: spot inside loss region (1/0)', r => (r.noonSpotInLoss ? (r.noonSpotInLoss === 'Y' ? 1 : 0) : null), -1],
  ['orders in book', r => r.orders, 0],
  ['fly orders', r => r.flies, 0],
  ['|open→settle| (σ day)', r => (fin(r.sigOpen) ? Math.abs(r.settle - r.open) / r.sigOpen : null), 0],
  ['book direction right (target side = move side)', r => (r.bookDir === 'neutral' ? null : (r.bookDir === 'up') === (r.moveFromFirst > 0) ? 1 : 0), 1],
  ['final floor ($)', r => r.floor, 1],
];
S.push('### 1b. What separates winning from losing days\n');
S.push(md(['metric', 'n', 'Spearman vs P&L', 'AUC win vs loss', 'median (win days)', 'median (loss days)'],
  metrics.map(([name, f]) => { const xs = dayRows.map(f), ys = dayRows.map(r => r.pnl); return [name, xs.filter(fin).length, fmt(spearman(xs, ys), 2), fmt(auc(dayRows, f), 2), fmt(median(dayRows.filter(r => r.win).map(f)), 2), fmt(median(dayRows.filter(r => !r.win).map(f)), 2)]; })));
S.push('AUC = P(a random win day scores higher than a random loss day); 0.50 = no information, <0.5 = lower on wins. With ~30 wins / ~25 losses an AUC needs to be beyond about 0.35-0.65 to mean anything.\n');

// distance bands
const bands = [[0, 0.25], [0.25, 0.5], [0.5, 1], [1, 9]];
S.push('### 1c. P&L by distance of the settle from the final target (σ day = implied full-session move)\n');
S.push(md(['|settle − target|', 'days', 'win %', 'P&L total', 'P&L mean', 'settle in profit zone'],
  bands.map(([a, b]) => { const x = dayRows.filter(r => fin(r.dTgtSig) && r.dTgtSig >= a && r.dTgtSig < b); return [`${a}–${b === 9 ? '∞' : b}σ`, x.length, pct(x.filter(r => r.win).length / (x.length || 1)), fmt(sum(x.map(r => r.pnl))), fmt(mean(x.map(r => r.pnl))), `${x.filter(r => r.settleWhere === 'plateau' || r.settleWhere === 'profit-zone').length}/${x.length}`]; })));

// 1d. target evolution
S.push('### 1d. How the target moved through the day\n');
const drift = dayRows.filter(r => fin(r.tgtDrift) && fin(r.spotDrift));
const towardSettle = dayRows.filter(r => fin(r.dFirstTgtSig) && fin(r.dTgtSig));
S.push(md(['measure', 'value'], [
  ['days with ≥2 timed orders', drift.length],
  ['median |target drift| first→final (pts)', fmt(median(drift.map(r => Math.abs(r.tgtDrift))))],
  ['median |spot drift| first→last order (pts)', fmt(median(drift.map(r => Math.abs(r.spotDrift))))],
  ['corr(target drift, spot drift) across days', fmt(corr(drift.map(r => r.tgtDrift), drift.map(r => r.spotDrift)), 2)],
  ['median per-day corr(Δtarget, Δspot) order-to-order', fmt(median(dayRows.map(r => r.tgtSpotCorr)), 2)],
  ['final target closer to settle than first target', `${towardSettle.filter(r => r.dTgtSig < r.dFirstTgtSig).length}/${towardSettle.length}`],
  ['median |settle − first target| σ', fmt(median(towardSettle.map(r => r.dFirstTgtSig)), 2)],
  ['median |settle − final target| σ', fmt(median(towardSettle.map(r => r.dTgtSig)), 2)],
  ['median |settle − spot at last order| σ', fmt(median(dayRows.map(r => (fin(r.spotLast) && fin(r.sigOpen) ? Math.abs(r.settle - r.spotLast) / r.sigOpen : null))), 2)],
  ['median (final target − last spot) σ at last order', fmt(median(dayRows.map(r => r.tgtVsSpotLastSig)), 2)],
  ['median |final target − last spot| σ at last order', fmt(median(dayRows.map(r => (fin(r.tgtVsSpotLastSig) ? Math.abs(r.tgtVsSpotLastSig) : null))), 2)],
]));
S.push('A target that tracks spot (corr ≈ 1, |final target − last spot| ≈ 0) is a "re-centre on price" habit, not an independent close forecast.\n');

// 2. floors
S.push('### 2a. Where the floor (loss region) sat on the final book\n');
const grp = (name, f) => { const a = dayRows.filter(f); return [name, a.length,
  pct(a.filter(r => r.lossInside1s === 'Y').length / (a.length || 1)), pct(a.filter(r => r.lossInsideDayRange === 'Y').length / (a.length || 1)),
  fmt(median(a.map(r => r.nearLossFromOpenSig)), 2), fmt(median(a.map(r => r.nearLossSigLast)), 2), pct(median(a.map(r => r.pLossFinal))), pct(median(a.map(r => r.pDeepFinal))),
  pct(a.filter(r => r.touchedLossAfter === 'Y').length / (a.filter(r => r.touchedLossAfter).length || 1)), pct(a.filter(r => r.touchedDeepAfter === 'Y').length / (a.filter(r => r.touchedDeepAfter).length || 1)),
  pct(a.filter(r => r.settleWhere === 'floor' || r.settleWhere === 'deep-floor').length / (a.length || 1))]; };
S.push(md(['days', 'n', 'loss region inside last spot ±1σ', 'loss region inside day range', 'nearest loss from OPEN (σ day)', 'nearest loss from last spot (σ last)', 'median P(settle in loss) @final', 'median P(settle in deep loss)', 'price traded in loss region after final shape', '…in deep loss', 'settled in loss'],
  [grp('all', () => true), grp('win', r => r.win), grp('loss', r => !r.win), grp('May', r => r.month === '2025-05'), grp('June', r => r.month === '2025-06')]));
S.push('"nearest loss from last spot = 0" means spot was ALREADY in the loss region when the book took its final shape (a debit tent built away from price, or a book underwater at spot).\n');

S.push('### 2a-bis. The book at NOON (removes the late-final-order effect: last orders are often after 15:00, when the outcome is nearly known)\n');
S.push(md(['days', 'n', 'median P(loss) @noon', 'spot in loss region @noon', 'median nearest loss σ @noon', 'median |target − spot| σ @noon', 'noon book would have lost at settle'],
  [['all', () => true], ['win', r => r.win], ['loss', r => !r.win], ['May', r => r.month === '2025-05'], ['June', r => r.month === '2025-06']].map(([n, f]) => { const a = dayRows.filter(f).filter(r => fin(r.noonPLoss)); return [n, a.length, pct(median(a.map(r => r.noonPLoss))), pct(a.filter(r => r.noonSpotInLoss === 'Y').length / (a.length || 1)), fmt(median(a.map(r => r.noonNearLossSig)), 2), fmt(median(a.map(r => Math.abs(r.noonTgtVsSpotSig))), 2), pct(a.filter(r => r.noonVSettle < 0).length / (a.length || 1))]; })));
S.push(`Median last-order time: ${(() => { const t = dayRows.map(r => r.lastET).filter(Boolean).sort(); return t[t.length >> 1]; })()} ET (wins ${(() => { const t = dayRows.filter(r => r.win).map(r => r.lastET).filter(Boolean).sort(); return t[t.length >> 1]; })()}, losses ${(() => { const t = dayRows.filter(r => !r.win).map(r => r.lastET).filter(Boolean).sort(); return t[t.length >> 1]; })()}).\n`);

// 2b. calibration: was the floor probability honest?
S.push('### 2b. Calibration: implied P(settle in loss) at final shape vs what happened\n');
const pb = [[0, 0.3], [0.3, 0.5], [0.5, 0.7], [0.7, 1.01]];
S.push(md(['implied P(loss) @final', 'days', 'mean implied', 'actual settled in loss', 'P&L total'],
  pb.map(([a, b]) => { const x = dayRows.filter(r => fin(r.pLossFinal) && r.pLossFinal >= a && r.pLossFinal < b); return [`${a}–${b > 1 ? 1 : b}`, x.length, pct(mean(x.map(r => r.pLossFinal))), pct(x.filter(r => r.vSettle < 0).length / (x.length || 1)), fmt(sum(x.map(r => r.pnl)))]; })));
const lossDays = dayRows.filter(r => !r.win);
const farLoss = lossDays.filter(r => fin(r.nearLossSigLast) && r.nearLossSigLast >= 0.5);
S.push(md(['losing-day type', 'days', 'P&L'], [
  ['spot already IN the loss region at final shape (nearest loss = 0σ)', lossDays.filter(r => r.nearLossSigLast === 0).length, fmt(sum(lossDays.filter(r => r.nearLossSigLast === 0).map(r => r.pnl)))],
  ['loss region within 0.5σ of last spot', lossDays.filter(r => r.nearLossSigLast > 0 && r.nearLossSigLast < 0.5).length, fmt(sum(lossDays.filter(r => r.nearLossSigLast > 0 && r.nearLossSigLast < 0.5).map(r => r.pnl)))],
  ['loss region ≥ 0.5σ away ("judged unreachable")', farLoss.length, fmt(sum(farLoss.map(r => r.pnl)))],
  ['no timed final shape', lossDays.filter(r => !fin(r.nearLossSigLast)).length, fmt(sum(lossDays.filter(r => !fin(r.nearLossSigLast)).map(r => r.pnl)))],
]));


// 1e. book shape
S.push('### 1e. Final book shape (tent = loss on both sides of the profit zone; ramp = loss on one side only)\n');
S.push(md(['shape', 'days', 'win %', 'P&L total', 'P&L mean', 'median |settle−target| σ', 'median P(loss)@final', 'median noon P(loss)'],
  ['tent', 'bull ramp', 'bear ramp', 'no loss side'].map(k => { const a = dayRows.filter(r => r.shapeClass === k); return [k, a.length, pct(a.filter(r => r.win).length / (a.length || 1)), fmt(sum(a.map(r => r.pnl))), fmt(mean(a.map(r => r.pnl))), fmt(median(a.map(r => r.dTgtSig)), 2), pct(median(a.map(r => r.pLossFinal))), pct(median(a.map(r => r.noonPLoss)))]; }).filter(r => r[1])));
S.push('For a ramp the "target" (argmax) is the FAR end of the ramp — the short strike of the furthest spread — so |settle − target| measures how far the user reached, not a point forecast. The ramp\'s break-even edge and its side are what matter.\n');

// 1f. direction × distance
S.push('### 1f. Direction vs target distance (which one carries the P&L)\n');
const dirOk = r => (r.bookDir === 'neutral' ? null : (r.bookDir === 'up') === (r.moveFromFirst > 0));
const cell = (f) => { const a = dayRows.filter(f); return [a.length, pct(a.filter(r => r.win).length / (a.length || 1)), fmt(sum(a.map(r => r.pnl)))]; };
S.push(md(['book direction', 'settle within 0.5σ of target: days', 'win %', 'P&L', 'settle > 0.5σ from target: days', 'win %', 'P&L'], [
  ['right side', ...cell(r => dirOk(r) === true && r.dTgtSig < 0.5), ...cell(r => dirOk(r) === true && r.dTgtSig >= 0.5)],
  ['wrong side', ...cell(r => dirOk(r) === false && r.dTgtSig < 0.5), ...cell(r => dirOk(r) === false && r.dTgtSig >= 0.5)],
  ['neutral (target within 0.25σ of first spot)', ...cell(r => dirOk(r) == null && r.dTgtSig < 0.5), ...cell(r => dirOk(r) == null && r.dTgtSig >= 0.5)],
]));
S.push(md(['book direction (all distances)', 'days', 'win %', 'P&L'], [['right side', ...cell(r => dirOk(r) === true)], ['wrong side', ...cell(r => dirOk(r) === false)], ['neutral', ...cell(r => dirOk(r) == null)]]));
S.push('Direction = side of the final target vs spot at the first order; "right" = the settle moved to that side of the first-order spot.\n');

// 1g. time-matched forecast skill
S.push('### 1g. Forecast skill, time-matched: was the user\'s target a better close forecast than spot / simple levels AT THE SAME MOMENT?\n');
const hb = [[0, 1], [1, 2.5], [2.5, 4.5], [4.5, 7]];
const sideHit = (rows, f) => { const x = rows.map(r => { const t = f(r); if (!fin(t) || Math.abs(t - r.S) < 0.25 * r.sg) return null; return Math.sign(t - r.S) === Math.sign(r.settle - r.S) ? 1 : 0; }).filter(v => v != null); return x.length ? [mean(x), x.length] : [null, 0]; };
const dayMaj = (rows, f) => { const by = new Map(); for (const r of rows) { const t = f(r); if (!fin(t) || Math.abs(t - r.S) < 0.25 * r.sg) continue; const h = Math.sign(t - r.S) === Math.sign(r.settle - r.S) ? 1 : 0; (by.get(r.date) || by.set(r.date, []).get(r.date)).push(h); } const v = [...by.values()].map(a => mean(a)); return v.length ? `${pct(mean(v))} (${v.length}d)` : '—'; };
S.push(md(['time (ET)', 'steps', 'days', 'median |settle−target| σ', 'median |settle−spot| σ', 'target closer than spot', 'target side right (steps)', 'per-day avg', '15m BBM side right', '60m 9EMA side right', 'open side right'],
  hb.map(([a, b]) => { const x = skillRows.filter(r => r.hr >= a && r.hr < b); if (!x.length) return null;
    const [th, tn] = sideHit(x, r => r.target), [bh] = sideHit(x, r => r.lv['15mBBM']), [eh] = sideHit(x, r => r.lv['60mEMA9']), [oh] = sideHit(x, r => r.lv.open);
    return [`${['09:30', '10:30', '12:00', '14:00'][hb.findIndex(h => h[0] === a)]}–${['10:30', '12:00', '14:00', '16:00'][hb.findIndex(h => h[0] === a)]}`, x.length, new Set(x.map(r => r.date)).size,
      fmt(median(x.map(r => Math.abs(r.settle - r.target) / r.sigOpen)), 2), fmt(median(x.map(r => Math.abs(r.settle - r.S) / r.sigOpen)), 2),
      pct(x.filter(r => Math.abs(r.settle - r.target) < Math.abs(r.settle - r.S)).length / x.length), `${pct(th)} (n ${tn})`, dayMaj(x, r => r.target), pct(bh), pct(eh), pct(oh)]; }).filter(Boolean)));
{
  const [th, tn] = sideHit(skillRows, r => r.target), [bh, bn] = sideHit(skillRows, r => r.lv['15mBBM']), [eh, en] = sideHit(skillRows, r => r.lv['60mEMA9']);
  const [ph, pn] = sideHit(skillRows, r => r.pw);
  S.push(`All steps: target side right ${pct(th)} (n ${tn}, per-day avg ${dayMaj(skillRows, r => r.target)}); payoff-weighted centre side ${pct(ph)} (n ${pn}); "revert to 15m BBM" side ${pct(bh)} (n ${bn}, per-day ${dayMaj(skillRows, r => r.lv['15mBBM'])}); "revert to 60m 9EMA" side ${pct(eh)} (n ${en}, per-day ${dayMaj(skillRows, r => r.lv['60mEMA9'])}). Steps within a day are strongly correlated (same settle) — the per-day average is the honest unit (n ≈ 55).\n`);
  const win = skillRows.filter(r => r.win), los = skillRows.filter(r => !r.win);
  S.push(`Target side right on WIN days ${pct(sideHit(win, r => r.target)[0])}, on LOSS days ${pct(sideHit(los, r => r.target)[0])}.\n`);
}

// 3. levels
const tr = targetRows;
S.push('### 3a. Do target strikes sit on levels? (all target kinds pooled)\n');
const ht = hitTable(tr).sort((a, b) => (b.lift20b || b.lift20a || 0) - (a.lift20b || a.lift20a || 0));
S.push(md(['level', 'NDX-exact', 'n', 'median |K−L|', 'hit ±10', 'hit ±20', 'null A ±20 (random strike same dist)', 'null B ±20 (placebo levels)', 'lift vs A', 'lift vs B'],
  ht.map(h => [h.t, h.exact ? 'Y' : '±basis', h.n, fmt(h.med), pct(h.h10), pct(h.h20), pct(h.n20a), pct(h.n20b), fmt(h.lift20a, 2), fmt(h.lift20b, 2)])));
S.push(`Target kinds: ${Object.entries(tr.reduce((a, r) => (a[r.kind] = (a[r.kind] || 0) + 1, a), {})).map(([k, v]) => `${k} ${v}`).join(', ')}. Strikes are on a 10-pt grid, so ±10 is effectively "same or adjacent strike"; for the ±basis levels a real ±10 hit cannot be distinguished from ±30. Null B keeps the real level-vs-spot geometry (it borrows another order's level offset), so lift vs B is the honest test.\n`);
for (const kind of ['flyBody', 'bookPeak', 'debitShort', 'plateauEdge', 'lossEdge']) {
  const rows = tr.filter(r => r.kind === kind);
  if (rows.length < 10) continue;
  const h = hitTable(rows).sort((a, b) => (b.lift20b || 0) - (a.lift20b || 0)).slice(0, 8);
  S.push(`#### 3b. ${kind} (n=${rows.length}) — top 8 by lift vs placebo\n`);
  S.push(md(['level', 'hit ±20', 'null B ±20', 'lift vs B', 'null A ±20', 'lift vs A'], h.map(x => [x.t, pct(x.h20), pct(x.n20b), fmt(x.lift20b, 2), pct(x.n20a), fmt(x.lift20a, 2)])));
}
// any-level hit
const anyHit = (rows, tol, types) => rows.filter(r => types.some(t => { const d = levelDist(r.K, r.lv, t); return d != null && d <= tol; })).length / rows.length;
const exactTypes = ['dBBU', 'dBBM', 'dBBL', 'dEMA9', 'pdH', 'pdL', 'pdC', 'open'];
S.push(md(['set', 'targets within ±10 of ANY daily/prior-day/open level (exact)', '±20'], [
  ['all targets', pct(anyHit(tr, 10, exactTypes)), pct(anyHit(tr, 20, exactTypes))],
  ['null A (random strike, same distance)', ...[10, 20].map(tol => { let h = 0, n = 0; for (const r of tr) for (let i = 0; i < 50; i++) { const d = Math.abs(r.K - r.S); const K2 = Math.round((r.S + (rnd() < 0.5 ? -1 : 1) * d + (rnd() * 50 - 25)) / 10) * 10; n++; if (exactTypes.some(t => fin(r.lv[t]) && Math.abs(K2 - r.lv[t]) <= tol)) h++; } return pct(h / n); })],
]));

S.push('### 3c. Which levels predicted the actual SETTLE\n');
const stb = settleTable().sort((a, b) => (b.h20 - b.null20) - (a.h20 - a.null20));
S.push(md(['level', 'as of', 'NDX-exact', 'n', 'median |settle−L| pts', 'median σ', 'hit ±10', 'hit ±20', 'null ±20', 'lift'],
  stb.map(h => [h.t, h.src, h.exact ? 'Y' : '±basis', h.n, fmt(h.med), fmt(h.medSig, 2), pct(h.h10), pct(h.h20), pct(h.null20), fmt(h.null20 ? h.h20 / h.null20 : null, 2)])));
S.push('Null = a settle drawn as open + (another day\'s move in σ) × this day\'s σ — a level that "predicts" the close must beat where closes land anyway. n≈55 days: a ±20 hit rate has a standard error of about ±6 percentage points.\n');

// 4. May vs June
S.push('### 4. May vs June\n');
const mrow = (name, f, d = 2, agg = median) => [name, ...['2025-04', '2025-05', '2025-06', '2025-07'].map(m => fmt(agg(dayRows.filter(r => r.month === m).map(f)), d))];
const pctRow = (name, f) => [name, ...['2025-04', '2025-05', '2025-06', '2025-07'].map(m => { const a = dayRows.filter(r => r.month === m); return pct(a.filter(f).length / (a.length || 1)); })];
S.push(md(['metric (median unless %)', 'Apr', 'May', 'Jun', 'Jul'], [
  ['days', ...['2025-04', '2025-05', '2025-06', '2025-07'].map(m => dayRows.filter(r => r.month === m).length)],
  mrow('P&L total', r => r.pnl, 0, sum),
  mrow('σ day (implied full-session move, pts)', r => r.sigOpen, 0),
  mrow('|open→settle| / σ day', r => (fin(r.sigOpen) ? Math.abs(r.settle - r.open) / r.sigOpen : null)),
  mrow('|settle − final target| pts', r => Math.abs(r.settleMinusTgt), 0),
  mrow('|settle − final target| σ day', r => r.dTgtSig),
  mrow('|settle − first target| σ day', r => r.dFirstTgtSig),
  mrow('|settle − last spot| σ day', r => (fin(r.spotLast) && fin(r.sigOpen) ? Math.abs(r.settle - r.spotLast) / r.sigOpen : null)),
  mrow('profit-zone width pts', r => r.zoneW, 0),
  mrow('profit-zone width σ day', r => r.zoneWsig),
  mrow('plateau width pts', r => r.plateauW, 0),
  mrow('P(profit) at final shape', r => r.pProfitFinal),
  mrow('P(loss) at final shape', r => r.pLossFinal),
  mrow('nearest loss from last spot σ', r => r.nearLossSigLast),
  mrow('final floor $', r => r.floor, 0),
  mrow('peak $', r => r.peak, 0),
  pctRow('settle on plateau', r => r.settleWhere === 'plateau'),
  pctRow('settle in profit zone (incl plateau)', r => r.settleWhere === 'plateau' || r.settleWhere === 'profit-zone'),
  pctRow('settle in deep floor', r => r.settleWhere === 'deep-floor'),
  pctRow('price visited final plateau during day', r => r.touchedPlateauDay === 'Y'),
  pctRow('book direction matched move', r => r.bookDir !== 'neutral' && (r.bookDir === 'up') === (r.moveFromFirst > 0)),
  pctRow('book neutral (target within 0.25σ of first spot)', r => r.bookDir === 'neutral'),
]));
S.push('Target side (final target vs first-order spot) × what the market did (settle vs first-order spot):\n');
S.push(md(['month', 'target', 'market went', 'days', 'wins', 'P&L'], (() => { const g = new Map(); for (const r of dayRows) { const k = `${r.month}|${r.bookDir}|${r.settle > r.spotFirst ? 'up' : 'down'}`; const a = g.get(k) || { n: 0, w: 0, p: 0 }; a.n++; a.w += r.win; a.p += r.pnl; g.set(k, a); } return [...g].sort().map(([k, a]) => [...k.split('|'), a.n, a.w, fmt(a.p)]); })()));
for (const m of ['2025-05', '2025-06']) {
  const rows = tr.filter(r => r.date.startsWith(m));
  const h = hitTable(rows).filter(x => x.n >= 20).sort((a, b) => (b.lift20b || 0) - (a.lift20b || 0)).slice(0, 6);
  S.push(`Top target levels ${m} (n=${rows.length} targets): ${h.map(x => `${x.t} ${pct(x.h20)} vs ${pct(x.n20b)} (×${fmt(x.lift20b, 2)})`).join('; ')}\n`);
}

// 5. per-day table
S.push('### 5. Per-day table (final book)\n');
S.push(md(['date', 'P&L', 'ord', 'open', 'settle', 'first tgt', 'final tgt', 'plateau', 'profit zone', 'settle−tgt', 'σ day', 'landed', 'P(loss)@final', 'near loss σ', 'loss in day range'],
  dayRows.map(r => [r.date, fmt(r.pnl), r.orders, fmt(r.open), fmt(r.settle), fmt(r.tgtFirst), fmt(r.tgtFinal), `${r.plateauLo}..${r.plateauHi}${r.plateauOpen ? `(open ${r.plateauOpen})` : ''}`, r.zoneLo != null ? `${r.zoneLo}..${r.zoneHi}` : '—', fmt(r.settleMinusTgt), fmt(r.sigOpen), r.settleWhere, pct(r.pLossFinal), fmt(r.nearLossSigLast, 2), r.lossInsideDayRange])));

// worked days
const pickWorked = () => {
  const s = [...dayRows].sort((a, b) => b.pnl - a.pnl);
  const set = new Set([s[0].date, s[1].date, s[s.length - 1].date, s[s.length - 2].date, '2025-05-21']);
  return [...set];
};
S.push('### 6. Worked days (target evolution, step by step)\n');
for (const D of pickWorked()) {
  const w = worked.get(D); if (!w) continue;
  const r = w.row;
  const lv = levelsAt(D, H.etToMs(D, '09:45'));
  const near = (K, lvx) => LT.filter(t => !t.startsWith('round')).map(t => [t, lvx[t]]).filter(([, v]) => fin(v) && Math.abs(K - v) <= 20).map(([t, v]) => `${t} ${fmt(v)}`).join(', ') || '—';
  S.push(`#### ${D}: P&L ${fmt(r.pnl)} · settle ${fmt(r.settle, 1)} · open ${fmt(r.open, 1)} · σ day ${fmt(r.sigOpen)} · manual-debug.html?date=${D}\n`);
  S.push(`Morning levels (NDX): dBBU ${fmt(lv.dBBU)} · dBBM ${fmt(lv.dBBM)} · dBBL ${fmt(lv.dBBL)} · d9EMA ${fmt(lv.dEMA9)} · pdH ${fmt(lv.pdH)} · pdL ${fmt(lv.pdL)} · pdC ${fmt(lv.pdC)} · onH ${fmt(lv.onH)} · onL ${fmt(lv.onL)} · 60m BB ${fmt(lv['60mBBL'])}/${fmt(lv['60mBBM'])}/${fmt(lv['60mBBU'])} · 60m 9EMA ${fmt(lv['60mEMA9'])}. Levels within 20 of the settle: ${near(r.settle, { ...lv, ...levelsAt(D, H.etToMs(D, '15:59')) })}.\n`);
  const rows = w.steps.filter(s => s.sh).map(s => {
    const lvx = s.ms != null ? levelsAt(s.o.date, s.ms) : {};
    return [s.o.timeET ? `${s.o.date === D ? '' : s.o.date.slice(5) + ' '}${s.o.timeET.slice(0, 5)}` : '?', `${s.oi.style || s.o.style}${s.oi.flyKind ? '' : ` ${s.o.debitCredit}`}`, fmt(s.S), fmt(s.sh.target), `${s.sh.plateauLo}..${s.sh.plateauHi}`, s.sh.zoneLo != null ? `${s.sh.zoneLo}..${s.sh.zoneHi}` : '—', fmt(s.sh.max), fmt(s.sh.min), pct(s.sh.pLoss), fmt(vAt(s.curve, r.settle)), near(s.sh.xPeak, lvx)];
  });
  // keep the table readable: show at most 30 steps (first 10, then every k-th, always the last)
  const keep = rows.length <= 30 ? rows : rows.filter((_, i) => i < 10 || i === rows.length - 1 || i % Math.ceil(rows.length / 20) === 0);
  S.push(md(['time', 'order', 'spot', 'target', 'plateau', 'profit zone', 'peak $', 'floor $', 'P(loss)', '$ at settle', 'levels within 20 of peak strike'], keep));
  S.push(`Final loss region(s): ${r.lossIntervals || 'none'} · profit zone(s): ${r.profitZones || 'none'} · settle landed: ${r.settleWhere} · P(loss) at final shape ${pct(r.pLossFinal)} · price traded in the loss region after the final shape: ${r.touchedLossAfter}.\n`);
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'targets-days.csv'), toCsv(dayRows));
fs.writeFileSync(path.join(OUT, 'targets-steps.csv'), toCsv(stepRows));
fs.writeFileSync(path.join(OUT, 'targets-levels.csv'), toCsv(targetRows.map(r => {
  const o = { date: r.date, tradeDate: r.tradeDate, orderNo: r.orderNo, timeET: r.timeET, kind: r.kind, K: r.K, spot: r1(r.S), sigma: r1(r.sg), kMinusSpotSig: r2((r.K - r.S) / r.sg) };
  for (const t of LT) o[`d_${t}`] = r1((() => { if (t.startsWith('round')) return levelDist(r.K, r.lv, t); return fin(r.lv[t]) ? r.K - r.lv[t] : null; })());
  return o;
})));
const tables = S.join('\n');
const rp = path.join(OUT, 'targets-report.md');
const START = '<!-- AUTO-TABLES:START -->', END = '<!-- AUTO-TABLES:END -->';
let doc = fs.existsSync(rp) ? fs.readFileSync(rp, 'utf8') : `# Manual trades phase 4: close targets and floors\n\nGenerated by scripts/manual-trades/analyze-targets.js. Hand-written findings go ABOVE the marker; re-runs replace only the block between the markers.\n\n${START}\n${END}\n`;
if (!doc.includes(START)) doc += `\n${START}\n${END}\n`;
doc = doc.slice(0, doc.indexOf(START) + START.length) + '\n' + tables + '\n' + doc.slice(doc.indexOf(END));
fs.writeFileSync(rp, doc);
console.log(`days ${dayRows.length} · steps ${stepRows.length} · targets ${targetRows.length} → ${OUT}/targets-*.csv, targets-report.md`);
