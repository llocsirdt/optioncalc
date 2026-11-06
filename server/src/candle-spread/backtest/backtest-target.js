'use strict';
/**
 * TARGET ENGINE (v10 / v11) — the backtest's bar loop. Every rule is in ../target-rules.js (shared with the live
 * simulate-only trader, target-trader.js; v10 / v11 on the live roster since 2026-10-23).
 *
 * v10 = target-driven: lean a debit vertical (and, near the target, a fly) toward a level, hold to settle except the
 *       standing tent cover.  v11 = touch-target: open toward the RTH 15m BB mid (or a line ladder), short strike part
 *       of the way, cover at the touch, flat-ish by 15:00.  Design: docs/journal/2026-10-16.md phases 4-6.
 *
 * FOUNDATIONAL: signals (NQ 15m/60m lines, trends, chase filter) come from /NQ bar.analysis (24h, last COMPLETED
 * candle — the dataset carries the completed 15m/60m candle on every 5m bar). Pricing, fills, NDX-RTH lines and
 * settlement come from priceOf(bar) (cash NDX px on 2026 days; the NQ 5m itself pre-2026, exactly like runDay5m).
 * NQ levels are moved into pricing space with the live basis (NQ 5m close - priceOf close; 0 pre-2026).
 *
 * Shares the pricing pieces with runDay5m: legsMark/legsPayoff (backtest-v4), the IV block (band IV x intraday
 * multiplier, per-leg skew function), the exact book floor (strikes +- one increment), the settle bar rule.
 * Result object is a SUPERSET of runDay5m's keys so the same aggregation code reads it.
 */
const eng = require('./backtest-v4');
const IND = require('../signals/indicators');
// THE RULES live in target-rules.js (2026-10-23): one implementation for this backtest and the live simulate-only
// trader (target-trader.js). This file keeps what is genuinely the backtest's: the bar loop, the 1m / inferred bar path
// fills against BS marks, the RTH line builders and the per-day context, the metrics and the result object.
const TR = require('../target-rules');
const legsMark = eng.legsMark, legsPayoff = eng.legsPayoff, TICK = eng.TICK, QTY = eng.QTY;
const round2 = eng.round2, roundTick = eng.roundTick;
const { etMin, etIso, etStamp, DEFAULTS, CAP_BY_W, CAPFRAC_BY_W, DEFAULT_COVER, COVER_KEYS, trendOf, nqSlope, probLoss } = TR;

// ── NDX-RTH LINES ────────────────────────────────────────────────────────────────────────────────────
// rthBar = { day:'YYYY-MM-DD', min: stamp minute (bar CLOSE, 575..960), open, high, low, close }. Buckets are anchored
// at 09:30 (15m: 09:30-09:45 ..; 60m: 09:30-10:30 .. 15:30-16:00). Only COMPLETED buckets are returned.
function aggregate(rthBars, P, nowDay, nowMin) {
  const out = []; let cur = null;
  for (const b of rthBars) {
    const k = Math.floor((b.min - 5 - 570) / P);
    const end = Math.min(960, 570 + (k + 1) * P);
    if (b.day === nowDay && nowMin < end) break;          // bucket still forming (or later) -> stop, no lookahead
    if (!cur || cur.day !== b.day || cur.k !== k) { cur = { day: b.day, k, open: b.open, high: b.high, low: b.low, close: b.close }; out.push(cur); }
    else { if (b.high > cur.high) cur.high = b.high; if (b.low < cur.low) cur.low = b.low; cur.close = b.close; }
  }
  return out;
}
function linesOf(buckets) {
  if (buckets.length < 20) return null;
  const n = buckets.length, e = IND.ema(buckets, 9), bb = IND.bollinger(buckets, 20, 2);
  const last = bb[n - 1];
  return { mid: last.bbMiddle, upper: last.bbUpper, lower: last.bbLower, ema: e[n - 1], emaPrev: e[n - 2], close: buckets[n - 1].close,
    high: buckets[n - 1].high, low: buckets[n - 1].low, n };
}

function runDayTarget(bars, optsIn = {}) {
  const o = TR.configOf(optsIn);
  const isV11 = o.family === 'v11';
  if (!o.priceOf && bars.some((b) => b && b.px)) throw new Error('runDayTarget: dataset carries NDX px but opts.priceOf is not set (signals NQ, pricing NDX)');
  const priceOf = o.priceOf || ((b) => { const c = b.analysis['5m']; return { open: c.open, close: c.close, high: c.high, low: c.low }; });
  const openOf = (b) => (b.px || b.analysis['5m']).open;
  const ctx = o.rthCtx || { priorBars: [], priorClose: null };
  const book = TR.newBook(o, ctx), D = book.D, positions = book.positions;

  // ── metrics state ──
  let ifSum = 0, ifBars = 0, ifNonNeg = 0, floorAt14 = null, floorAt15 = null, bestFloorSeen = -Infinity, everPositive = false;
  let capSum = 0, capN = 0, worstFloor = 0;
  const flatFloors = []; let wasFlat = false;
  const floorNow = (withPending) => TR.floorNow(book, withPending);

  // ── RTH series: prior sessions + today ──
  const priorBars = ctx.priorBars || [];
  const nPrior = priorBars.length;
  const rthBars = [];   // today's RTH bars only; prior sessions are bucketed once
  const priorBk = { 15: aggregate(priorBars, 15, null, 0), 60: aggregate(priorBars, 60, null, 0) };
  const cache15 = { n: -1, lines: null }, cache60 = { n: -1, lines: null };
  const lineAt = (P, cache, nowDay, nowMin) => {
    const today = aggregate(rthBars, P, nowDay, nowMin);
    if (today.length !== cache.n) { cache.n = today.length; cache.lines = linesOf(priorBk[P].concat(today)); }
    return cache.lines;
  };

  let settleIdx = -1;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i], m = etMin(b.dt);
    if (m >= 575 && m <= 960) settleIdx = i;
    if (!(m >= 575 && m <= 955)) {
      // the official-close 16:00 bar (or the real 15:55-16:00 bar) still belongs to the RTH series
      if (m === 960) { const p = priceOf(b); rthBars.push({ day: etIso(b.dt), min: m, open: openOf(b), high: p.high, low: p.low, close: p.close }); }
      continue;
    }
    D.bars++;
    const A = b.analysis, px = priceOf(b), S = px.close, tau = eng.bs.tauFromTime(b.dt);
    const day = etIso(b.dt);
    TR.noteDay(book, day, openOf(b));
    rthBars.push({ day, min: m, open: openOf(b), high: px.high, low: px.low, close: S });
    // ── IV block (runDay5m's; target-rules.pricingModel) ──
    const { iv, base, sig } = TR.pricingModel(A['15m'], S, tau, m, o);
    TR.noteGap(book, o, sig);
    const pr = TR.modelPricer(S, tau, iv, base, sig);

    // intraday floor sampled BEFORE the bar acts (runDay5m convention)
    if (positions.length) { const f = floorNow(false); ifSum += f; ifBars++; if (f >= 0) ifNonNeg++; if (f < worstFloor) worstFloor = f; }
    { const verts = positions.filter((p) => p.kind === 'vert'); const flat = verts.length > 0 && !book.pending && verts.every((p) => p.covered);
      if (flat && !wasFlat) flatFloors.push(Math.round(floorNow(false))); wasFlat = flat; }
    if (floorAt14 == null && m >= 840) floorAt14 = positions.length ? Math.round(floorNow(false)) : 0;
    if (floorAt15 == null && m >= 900) floorAt15 = positions.length ? Math.round(floorNow(false)) : 0;

    // ── the bar's path: 1m candles when present, else the inferred O-x-y-C path ──
    let steps;
    if (o.subBarFill === '1m' && b.sub1m && b.sub1m.length) steps = b.sub1m.map((c) => ({ lo: c.low, hi: c.high }));
    else {
      const O = openOf(b), green = !(px.close < O), pts = green ? [O, px.low, px.high, px.close] : [O, px.high, px.low, px.close];
      steps = [{ lo: O, hi: O }];
      for (let k = 1; k < 4; k++) steps.push({ lo: Math.min(pts[k - 1], pts[k]), hi: Math.max(pts[k - 1], pts[k]) });
    }

    // (1) working anchor open: fills at the first step that reaches the anchor
    if (book.pending && book.pending.mode === 'anchor' && i > book.pending.placedI) {
      const pd = book.pending;
      const k = steps.findIndex((st) => (pd.side === 'bull' ? st.lo <= pd.anchor + 1e-9 : st.hi >= pd.anchor - 1e-9));
      if (k >= 0) TR.fillPending(book, o, i, b.dt, S, () => ({ fillI: i, fillK: k }));
    }
    // (2) continuous cover on every uncovered vertical without one (placed at this bar's close, as runDay5m)
    for (const p of positions) if (p.kind === 'vert' && !p.covered && !p.cover) TR.placeCover(book, p, S, pr, b.dt, i);
    // (3) touches on positions that are not being worked this bar (counters)
    for (const p of positions) {
      if (p.kind !== 'vert' || p.touched || p.target == null || (!p.covered && p.cover)) continue;
      const k0 = p.fillI === i ? p.fillK + 1 : 0;
      for (let k = k0; k < steps.length; k++) if (TR.reachesT(p, steps[k])) { TR.noteTouch(book, p, i); break; }
    }
    // (4) work and test the resting covers (runDay5m (a), cover branch)
    for (const p of positions) {
      if (p.kind !== 'vert' || p.covered || !p.cover) continue;
      const pc = p.cover;
      // sub-bar: a cover placed for a position that filled IN this bar is tested only after the fill
      const k0 = p.fillI === i ? p.fillK + 1 : 0;
      if (k0 >= steps.length) continue;
      const w = TR.coverStep(book, o, p, { S, m, dt: b.dt, pr });
      const { giveUp, fillAt, thru } = w;
      let booked = null;
      for (let k = k0; k < steps.length && booked == null; k++) {
        const st = steps[k];
        if (!p.touched && p.target != null && TR.reachesT(p, st)) {
          TR.noteTouch(book, p, i);
          if (isV11 && !giveUp) { booked = TR.touchCoverPrice(book, giveUp, fillAt, legsMark(pc.legs, p.target, tau, iv)); if (booked != null) break; }
        }
        if (legsMark(pc.legs, p.side === 'bull' ? st.hi : st.lo, tau, iv) <= fillAt - thru + 1e-9) booked = roundTick(p.cc.simFillAtLimit ? fillAt : Math.min(fillAt, legsMark(pc.legs, S, tau, iv) + TICK));
      }
      if (booked == null) { TR.rangeRestrike(book, p, w, pr); continue; }
      TR.bookCover(book, o, p, booked, b.dt);
    }
    TR.expirePending(book, o, i);

    // ── decision on the completed bar ──
    const r = TR.decide(book, o, { i, m, day, dt: b.dt, S, px, A, sig, pr, lines: () => ({ r15: lineAt(15, cache15, day, m), r60: lineAt(60, cache60, day, m) }) });
    if (r.place) {
      const P = r.place;
      if (P.mode === 'anchor') { book.pending = { mode: 'anchor', side: P.side, items: P.items, anchor: P.anchor, placedI: i }; D.anchorPlaced++; }
      else {
        D.marketFilled++;
        for (const it of P.items) { TR.bookOpen(book, o, it, P.side, i, b.dt, S, { fillI: i, fillK: Infinity }); if (it.kind === 'fly') D.flyFilled++; }
        TR.noteOpenCounters(book, P.side);
      }
    }
    // end-of-bar bookkeeping
    if (positions.length) { const f = floorNow(false); if (f > bestFloorSeen) bestFloorSeen = f; if (f >= 0) everPositive = true; }
    capSum += book.capDep; capN++;
  }
  if (book.pending) { book.pending = null; D.anchorCanceled++; }
  { const verts = positions.filter((p) => p.kind === 'vert'); const flat = verts.length > 0 && verts.every((p) => p.covered);
    if (flat && !wasFlat) flatFloors.push(Math.round(floorNow(false))); }

  // ── settle (runDay5m rule: last bar at/through 16:00 in 09:35..16:00) ──
  const settleBar = settleIdx >= 0 ? bars[settleIdx] : bars[bars.length - 1];
  const settle = (o.settlePrice > 0) ? o.settlePrice : priceOf(settleBar).close;
  const bookPayoff = (X) => { let t = 0; for (const p of positions) { let v = legsPayoff(p.legs, X), c = p.limit; if (p.covered) { v += legsPayoff(p.coverLegs, X); c += p.coverLimit; } t = round2(t + (v - c) * 100 * QTY); } return t; };
  const terminal = bookPayoff(settle);
  let floor = 0, filled = 0, naked = 0;
  for (const p of positions) {
    if (p.kind !== 'vert') continue;
    if (p.covered) { floor = round2(floor + (p.W - p.limit - p.coverLimit) * 100 * QTY); filled++; } else naked++;
  }
  let bestCase = 0, worstCase = 0, avgTerminalPotential = 0;
  if (positions.length) {
    let lo = Infinity, hi = -Infinity;
    for (const p of positions) { for (const l of p.legs.concat(p.covered ? p.coverLegs : [])) { lo = Math.min(lo, l.strike); hi = Math.max(hi, l.strike); } }
    if (!(hi > lo)) { const v = bookPayoff(lo); bestCase = v; worstCase = v; avgTerminalPotential = v; }
    else { bestCase = -Infinity; worstCase = Infinity; let s = 0, c = 0; for (let X = lo; X <= hi + 1e-9; X += 5) { const v = bookPayoff(X); if (v > bestCase) bestCase = v; if (v < worstCase) worstCase = v; s += v; c++; } avgTerminalPotential = round2(s / c); }
  }
  const endF = positions.length ? floorNow(false) : null;
  const verts = positions.filter((p) => p.kind === 'vert');
  const gap = book.gap, gapDay = book.gapDay;
  return {
    floor, terminal, opens: positions.length, filled, naked, coverPending: naked,
    coverBySrc: { continuous: filled, reversal: 0, lock: 0, proactive: 0, stack: 0, ladder: 0 },
    openTried: D.placed, openMissed: D.anchorCanceled, giveUps: D.giveUpPos, decayStops: 0, gateCutoff: 0, gateFloor: 0, gateUnderwater: 0, gateC2oWait: D.c2oWait,
    c2oFires: D.c2oFires, c2oChasing: 0, flyCount: positions.filter((p) => p.kind === 'fly').length, flySpent: Math.round(positions.filter((p) => p.kind === 'fly').reduce((a, p) => a + p.limit * 100 * QTY, 0)),
    coverPicks: [], settle, replay: null, positions: o.recordReplay ? positions : undefined, capBlocked: D.capBlock, capBlockedTrend: 0, capSkipCeiling: 0,
    nCoverToStack: 0, geoSkip: D.geoDecline, openFallbacks: 0, openLowBand: 0,
    bestCase, worstCase, avgTerminalPotential,
    openLadder: { placed: D.anchorPlaced + D.marketFilled, filled: D.anchorFilled + D.marketFilled, canceled: D.anchorCanceled, stale: 0, restruck: 0, restrikeReplaced: 0,
      walkGovBlocked: 0, expired: 0, skipPending: D.pendingBusy, reprices: 0, paidUp: 0 },
    reopen: undefined,   // runDay5m's reopen-after-cover counters; the target engine has no reopen
    lock: { traded: positions.length > 0, endBookFloor: endF != null ? Math.round(endF) : null, endFloorNoLoss: positions.length > 0 && endF >= 0,
      endFloorProfit: positions.length > 0 && endF > 0, bestFloor: Number.isFinite(bestFloorSeen) ? Math.round(bestFloorSeen) : null, everPositive },
    capital: { peakReal: Math.round(book.capPeak), avgReal: capN ? round2(capSum / capN) : 0 },
    legs: null, harvest: null, wings: { count: 0, spent: 0 }, giveUpPos: D.giveUpPos, giveUpCovered: D.giveUpCovered, floorRaise: null,
    giveUpTrendFires: undefined, giveUpCandleFires: undefined, trendFloor: undefined, coverAsym: undefined, sigCoverGiveUps: 0, coverSameBar: 0,
    subBar: o.subBarFill ? { mode: o.subBarFill } : undefined, openTrendBlocked: undefined, giveUpTakeNow: undefined, stallFires: D.stallFires, lateFloor: undefined,
    floorAt14, floorAt15,
    intradayFloorAvg: ifBars ? Math.round(ifSum / ifBars) : null, intradayFloorNonNegPct: ifBars ? Math.round(1000 * ifNonNeg / ifBars) / 10 : null,
    tents: verts.filter((p) => p.covered).length, flatFloors, coverRange: { rangeRestrikes: D.rangeRestrikes, guRestrikes: D.guRestrikes, stepIns: 0, rolls: 0, rollSpent: 0 },
    coverMins: verts.filter((p) => p.covered && !p._gu).map((p) => Math.round((p.coverEpoch - p.openEpoch) / 60000)),
    giveUpMins: verts.filter((p) => p.covered && p._gu).map((p) => Math.round((p.coverEpoch - p.openEpoch) / 60000)),
    uncoveredEod: verts.filter((p) => !p.covered).length,
    governor: null, ratchet: null,
    // target-engine extras
    natural: undefined, stackGate: undefined, touch: undefined, decisions: D, gap: gap != null ? round2(gap) : null, gapDay: !!gapDay, rthPriorBars: nPrior,
  };
}

// ── shared with the runDay5m touch overlay (backtest-v6-5m opts.touch*) ─────────────────────────────────
// RTH line tracker: prior sessions bucketed once, today's bars pushed as they complete; lines(P, day, min) returns the
// completed-bucket BB(20,2)/9EMA lines (null until 20 buckets) — the same aggregate/linesOf the target engine uses.
function makeRthLines(priorBars) {
  const prior = {}, today = [], cache = {};   // any bucket size P (5 / 15 / 60), prior sessions bucketed once per P
  return {
    push: (bar) => today.push(bar),
    lines: (P, day, min) => {
      if (!prior[P]) { prior[P] = aggregate(priorBars || [], P, null, 0); cache[P] = { n: -1, l: null }; }
      const t = aggregate(today, P, day, min); if (t.length !== cache[P].n) { cache[P].n = t.length; cache[P].l = linesOf(prior[P].concat(t)); } return cache[P].l; },
  };
}
// v11 SETUP at a completed bar. mode 'mid': NQ 15m AND 60m trends both point toward the RTH 15m mid M, minDist <= |M-S|
// <= maxDist sigma. mode 'ladder': the nearest line of {RTH15 mid/ema/upper/lower, RTH60 ema/mid, prior close} in the
// direction both NQ trends agree on, inside the same distance band. Returns { side, level } or null. NQ levels are not
// used (all lines are in pricing space). nq = NQ 5m close, S = pricing close, sig = sigma to 16:00 in points.
function v11Setup({ A, nq, S, sig, r15, r60, priorClose, minDist = 0.15, maxDist = 1.0, mode = 'mid' }) {
  if (!r15 || !(sig > 0)) return null;
  const c15 = A['15m'], c60 = A['60m'];
  const t15 = trendOf(nq, c15.ema, nqSlope(c15)), t60 = trendOf(nq, c60.ema, nqSlope(c60));
  if (!t15 || t15 !== t60) return null;
  const inRange = (L) => { const d = Math.abs(L - S); return d >= minDist * sig && d <= maxDist * sig; };
  let level = null;
  if (mode === 'ladder') {
    const lines = [r15.mid, r15.ema, r15.upper, r15.lower];
    if (r60) lines.push(r60.ema, r60.mid);
    if (priorClose != null) lines.push(priorClose);
    for (const L of lines) if (L != null && Math.sign(L - S) === t15 && inRange(L) && (level == null || Math.abs(L - S) < Math.abs(level - S))) level = L;
  } else if (r15.mid != null && Math.sign(r15.mid - S) === t15 && inRange(r15.mid)) level = r15.mid;
  return level == null ? null : { side: t15 === 1 ? 'bull' : 'bear', level };
}

// ── per-day NDX-RTH context ──────────────────────────────────────────────────────────────────────────
// sessions: [{ iso, rth:[{day,min,open,high,low,close}], close }] chronological (dataset days + optional raw-1m days).
// Returns Map iso -> { priorBars, priorClose, priorIso }. Chain cut when consecutive sessions are > 5 calendar days apart.
function sessionFromBars(iso, bars, priceOf, settles) {
  const rth = [];
  for (const b of bars) {
    const m = etMin(b.dt);
    if (m < 575 || m > 960) continue;
    const p = priceOf(b); rth.push({ day: iso, min: m, open: (b.px || b.analysis['5m']).open, high: p.high, low: p.low, close: p.close });
  }
  if (!rth.length) return null;
  const close = settles && settles[iso] > 0 ? settles[iso] : rth[rth.length - 1].close;
  return { iso, rth, close };
}
function sessionFrom1m(iso, candles, settles) {
  const by = new Map();
  for (const c of candles) {
    const m = etMin(c.datetime); if (m < 570 || m >= 960) continue;
    const stamp = (Math.floor(m / 5) + 1) * 5;
    const x = by.get(stamp);
    if (!x) by.set(stamp, { day: iso, min: stamp, open: c.open, high: c.high, low: c.low, close: c.close });
    else { x.high = Math.max(x.high, c.high); x.low = Math.min(x.low, c.low); x.close = c.close; }
  }
  const rth = [...by.values()].sort((a, b) => a.min - b.min);
  if (!rth.length) return null;
  return { iso, rth, close: settles && settles[iso] > 0 ? settles[iso] : rth[rth.length - 1].close };
}
function buildRthContexts(sessions, nPrior = 8) {
  const S = sessions.slice().sort((a, b) => (a.iso < b.iso ? -1 : 1));
  const out = new Map();
  const dayMs = (iso) => Date.parse(iso + 'T12:00:00Z');
  for (let k = 0; k < S.length; k++) {
    const pri = [];
    for (let j = k - 1; j >= 0 && pri.length < nPrior; j--) {
      const later = j + 1 === k ? S[k] : S[j + 1];
      if ((dayMs(later.iso) - dayMs(S[j].iso)) / 86400000 > 5) break;
      pri.unshift(S[j]);
    }
    out.set(S[k].iso, { priorBars: pri.flatMap((s) => s.rth), priorClose: pri.length ? pri[pri.length - 1].close : null, priorIso: pri.length ? pri[pri.length - 1].iso : null });
  }
  return out;
}

// RTH CONTEXTS FOR A DATASET (moved here 2026-10-23 from sweep-v10.js so the baselines build gets the SAME context for the
// natural-cover v12 / v13 variants): the dataset's own sessions (pricing series via priceOf) plus the raw-1m NDX sessions
// it lacks (signal-lab-data/raw-1m NDX-YYYY-MM-DD.json), then 8 prior sessions per day. days = load5mDays output.
function rthContextsForDataset(days, { dir, sub1mDir, priceOf, isoOf }) {
  const fs = require('fs'), path = require('path');
  let settles = {};
  try { settles = JSON.parse(fs.readFileSync(path.join(dir, 'settles.json'), 'utf8')); } catch (e) { /* none */ }
  const sessions = [];
  const have = new Set();
  for (const d of days) { const iso = isoOf(d); const s = sessionFromBars(iso, d.bars, priceOf, settles); if (s) { sessions.push(s); have.add(iso); } }
  let rawAdded = 0;
  if (sub1mDir && fs.existsSync(sub1mDir)) {
    for (const f of fs.readdirSync(sub1mDir)) {
      const mm = /^NDX-(\d{4}-\d{2}-\d{2})\.json$/.exec(f); if (!mm || have.has(mm[1])) continue;
      try { const s = sessionFrom1m(mm[1], JSON.parse(fs.readFileSync(path.join(sub1mDir, f), 'utf8')).candles, settles); if (s) { sessions.push(s); rawAdded++; } } catch (e) { /* skip */ }
    }
  }
  return { ctx: buildRthContexts(sessions, 8), sessions, settles, rawAdded };
}

module.exports = { rthContextsForDataset, makeRthLines, v11Setup, nqSlope, DEFAULT_COVER, COVER_KEYS, runDayTarget, buildRthContexts, sessionFromBars, sessionFrom1m, aggregate, linesOf, trendOf, probLoss, etMin, etIso, DEFAULTS, CAP_BY_W, CAPFRAC_BY_W };
