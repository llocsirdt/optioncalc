'use strict';
/**
 * TARGET ENGINE (v10 / v11) — BACKTEST ONLY. Not on the live roster.
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
const { ivMultAt, skewMultAt } = require('./backtest-v6-5m');
const IND = require('../signals/indicators');
const SL = require('../spread-logic');
const LAD = require('../cover-ladder');
const bs = eng.bs, legsMark = eng.legsMark, legsPayoff = eng.legsPayoff, TICK = eng.TICK, QTY = eng.QTY;
const round2 = eng.round2, roundTick = eng.roundTick;
const ceilTick = (p) => Math.round(Math.ceil((p / TICK) - 1e-9) * TICK * 100) / 100;
const floorTick = (p) => Math.round(Math.floor((p / TICK) + 1e-9) * TICK * 100) / 100;

const _fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false });
function etMin(ms) { const p = _fmt.formatToParts(new Date(ms)); let h = 0, m = 0; for (const x of p) { if (x.type === 'hour') h = Number(x.value) % 24; else if (x.type === 'minute') m = Number(x.value); } return h * 60 + m; }
const _dfmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const etIso = (ms) => _dfmt.format(new Date(ms));
const etStamp = (ms) => { const iso = etIso(ms), m = etMin(ms); return `${iso.slice(5, 7)}/${iso.slice(8, 10)} ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };

// Per-width defaults = the v6-v9 roster (index.js buildRuns: lossMax 2,000/4,500/7,500, capFrac .55/.575/.5875).
const FIXED = [10, 20, 40];
const CAP_BY_W = { 10: 2000, 20: 4500, 40: 7500 };
const CAPFRAC_BY_W = { 10: 0.55, 20: 0.575, 40: 0.5875 };
const nearestFixed = (W) => FIXED.reduce((b, x) => (Math.abs(x - W) < Math.abs(b - W) ? x : b), FIXED[0]);   // ties -> lower

const DEFAULTS = {
  family: 'v10', width: 20, incr: 10,
  entry: 'anchor', entryBars: 3, chaseFrac: 0.2,
  rthGate: true, noGapFade: true, bookReject: true, farOtmBan: true, fly: true, target60: true, gapRth60: true,
  maxStack: 3, chase: true, giveUpMaxLoss: null, gapSig: 0.25, firstOpenMin: 575, v10Cutoff: 870,
  trendBoth: true, minDist: 0.15, maxDist: 1.0, f: 0.5, v11Cutoff: 840, eodFlat: true, eodFlatMin: 900,
  v11Next: 'same', reentryBars: 1, coverToOpen: true,
};
// The cover-relevant slice of the v6-W roster (optsFor(buildRuns v6-10/20/40), 2026-10-16). The sweep reads the live
// roster instead and passes it as opts.coverCfg; this copy is only the fallback for callers that do not.
const COMMON_COVER = { continuousCover: true, coverGiveUp: true, giveUpPoints: 20, coverToOpen: 'same', coverToOpenExtra: 0, coverToOpenWait: true, stallCoverMin: 15,
  coverLadder: true, ladderStepSeconds: 120, ladderStepPoints: 10, ladderLossCapFrac: 0, ladderStepDollars: 0.05, fillThroughTicksCover: 1, simFillAtLimit: true, coverFillAtResting: true };
const DEFAULT_COVER = {
  10: { ...COMMON_COVER, continuousCoverMinLockFrac: 0.05, coverGeometry: 'offset1', giveUpMaxLoss: 0.05, giveUpGeometry: 'tent' },
  20: { ...COMMON_COVER, continuousCoverMinLockFrac: 0.2, giveUpMaxLoss: 0.075, giveUpGeometry: 'inside', coverRangeInside: 9, coverRangeBeyond: 2, coverRangePremium: 0.02 },
  40: { ...COMMON_COVER, continuousCoverMinLockFrac: 0.2, giveUpMaxLoss: 0.1, giveUpGeometry: 'inside', coverRangeInside: 9, coverRangeBeyond: 2, coverRangePremium: 0.02 },
};
const COVER_KEYS = Object.keys({ ...COMMON_COVER, continuousCoverMinLockFrac: 0, coverGeometry: 0, giveUpMaxLoss: 0, giveUpGeometry: 0, coverRangeInside: 0, coverRangeBeyond: 0, coverRangePremium: 0, ladderSteps: 0, ladderAdverseOnly: 0, stallCoverPts: 0 });

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
// Trend read: price vs 9EMA AND the 9EMA slope must agree; otherwise 0.
const trendOf = (px, emaV, slope) => { if (emaV == null || slope == null) return 0; const a = Math.sign(px - emaV), b = Math.sign(slope); return a !== 0 && a === b ? a : 0; };
// NQ completed candle: EMA_t - EMA_{t-1} = a(C_t - EMA_{t-1}) and C_t - EMA_t = (1-a)(C_t - EMA_{t-1}), so the slope
// sign of the 9EMA at a completed candle IS sign(C_t - EMA_t) — exact, no history needed.
const nqSlope = (c) => (c && c.close != null && c.ema != null ? c.close - c.ema : null);

// P(book payoff < 0) under Normal(S, sig): payoff piecewise-linear; integrate on a fine grid.
const _ncdf = bs.ncdf;
function probLoss(payoff, S, sig) {
  if (!(sig > 0)) return payoff(S) < 0 ? 1 : 0;
  const N = 240, lo = S - 5 * sig, hi = S + 5 * sig, h = (hi - lo) / N;
  let p = 0;
  for (let k = 0; k < N; k++) {
    const a = lo + k * h, b = a + h;
    if (payoff((a + b) / 2) < 0) p += _ncdf((b - S) / sig) - _ncdf((a - S) / sig);
  }
  return p;
}

function runDayTarget(bars, optsIn = {}) {
  const o = { ...DEFAULTS, ...optsIn };
  const fam = o.family, isV11 = fam === 'v11', incr = o.incr;
  if (!o.priceOf && bars.some((b) => b && b.px)) throw new Error('runDayTarget: dataset carries NDX px but opts.priceOf is not set (signals NQ, pricing NDX)');
  const priceOf = o.priceOf || ((b) => { const c = b.analysis['5m']; return { open: c.open, close: c.close, high: c.high, low: c.low }; });
  const openOf = (b) => (b.px || b.analysis['5m']).open;
    const ctx = o.rthCtx || { priorBars: [], priorClose: null };
  const capFor = (W) => (o.lossMax != null ? o.lossMax : CAP_BY_W[nearestFixed(W)]);
  const capFracFor = (W) => (o.capFrac != null ? o.capFrac : CAPFRAC_BY_W[nearestFixed(W)]);

  const D = { bars: 0, decisions: 0, windowOut: 0, noDir: 0, distOut: 0, trendFail: 0, rthGateBlock: 0, gapFadeBlock: 0, chaseBlock: 0,
    stackFull: 0, stackNoAgree: 0, stack15mBlock: 0, farOtm: 0, geoDecline: 0, capBlock: 0, bookRejectSpot: 0, bookRejectP: 0,
    reentryBlock: 0, pendingBusy: 0, noLines: 0, placed: 0, anchorPlaced: 0, anchorFilled: 0, anchorCanceled: 0, marketFilled: 0,
    flyPlaced: 0, flyFilled: 0, flyBlocked: 0, touches: 0, reentries: 0, opensBeforeTouch: 0, opensAfterTouch: 0, eodFlatPlaced: 0,
    coverDeferred: 0, coversPlaced: 0, giveUpPos: 0, giveUpCovered: 0, guRestrikes: 0, rangeRestrikes: 0, stallFires: 0, touchCovers: 0, c2oFires: 0, c2oWait: 0, target60Used: 0, gapRth60Used: 0, gapDay: 0, ladderTargets: 0 };

  const positions = [];   // filled
  let pending = null;     // { side, items:[{kind,legs,limit,W,shortStrike,target}], anchor, placedI, barsLeft }
  let firstTouchSeen = false;
  const lastTouch = { bull: null, bear: null };   // { i, level }
  const last15Open = { bull: null, bear: null };
  const fliesDone = new Set();

  // ── exact book floor (runDay5m floorOf semantics; pending counted as filled when asked) ──
  const posPnlAt = (p, X) => { let v = legsPayoff(p.legs, X), c = p.limit; if (p.covered) { v += legsPayoff(p.coverLegs, X); c += p.coverLimit; } return (v - c) * 100 * QTY; };
  const bookList = (withPending, extras) => {
    const L = positions.slice();
    if (withPending && pending) for (const it of pending.items) L.push({ legs: it.legs, limit: it.limit, covered: false });
    if (extras) for (const x of extras) L.push(x);
    return L;
  };
  const payoffOf = (L) => (X) => { let t = 0; for (const p of L) t += posPnlAt(p, X); return t; };
  function floorOfList(L) {
    if (!L.length) return 0;
    const ks = new Set();
    for (const p of L) { for (const l of p.legs) ks.add(l.strike); if (p.covered) for (const l of p.coverLegs) ks.add(l.strike); }
    let lo = Infinity, hi = -Infinity, m = Infinity; const f = payoffOf(L);
    for (const k of ks) { if (k < lo) lo = k; if (k > hi) hi = k; const v = f(k); if (v < m) m = v; }
    m = Math.min(m, f(lo - incr), f(hi + incr));
    return m;
  }
  const floorNow = (withPending) => floorOfList(bookList(withPending));

  // ── structures ──
  const vertLegs = (side, short, W) => (side === 'bull'
    ? [{ side: 'long', type: 'C', strike: short - W }, { side: 'short', type: 'C', strike: short }]
    : [{ side: 'long', type: 'P', strike: short + W }, { side: 'short', type: 'P', strike: short }]);
  const coverLegs = (side, short, W) => (side === 'bull'
    ? [{ side: 'short', type: 'P', strike: short }, { side: 'long', type: 'P', strike: short + W }]
    : [{ side: 'short', type: 'C', strike: short }, { side: 'long', type: 'C', strike: short - W }]);
  const flyLegs = (K, W, S) => { const t = K >= S ? 'C' : 'P';
    return [{ side: 'long', type: t, strike: K - W }, { side: 'short', type: t, strike: K }, { side: 'short', type: t, strike: K }, { side: 'long', type: t, strike: K + W }]; };
  const sigW = (sig) => Math.max(10, Math.min(40, Math.round(0.25 * sig / incr) * incr));

  // ── metrics state ──
  let ifSum = 0, ifBars = 0, ifNonNeg = 0, floorAt14 = null, floorAt15 = null, bestFloorSeen = -Infinity, everPositive = false;
  let capDep = 0, capPeak = 0, capSum = 0, capN = 0, worstFloor = 0;
  const flatFloors = []; let wasFlat = false;

  // ── RTH series: prior sessions + today ──
  const priorBars = ctx.priorBars || [];
  const nPrior = priorBars.length;
  const rthBars = [];   // today's RTH bars only; prior sessions are bucketed once
  const priorBk = { 15: aggregate(priorBars, 15, null, 0), 60: aggregate(priorBars, 60, null, 0) };
  let cache15 = { n: -1, lines: null }, cache60 = { n: -1, lines: null };
  const lineAt = (P, cache, nowDay, nowMin) => {
    const today = aggregate(rthBars, P, nowDay, nowMin);
    if (today.length !== cache.n) { cache.n = today.length; cache.lines = linesOf(priorBk[P].concat(today)); }
    return cache.lines;
  };
  let todayDay = null, todayOpen = null, gapDay = null, gap = null, opensToday = 0;

  // ── ROSTER COVER MACHINERY (ported from runDay5m, PORTED_COVER) ─────────────────────────────────────
  // Per-width cover config = the v6-W roster run through optsFor (the sweep passes it as opts.coverCfg; DEFAULT_COVER
  // mirrors it for callers that do not). Reused helpers: cover-ladder.js limitNow/ladderMove, spread-logic.js
  // coverShortFor/coverLegsAtShort. Ported from runDay5m: continuous-cover placement + target (W - open - minLock),
  // offset/range geometry + range re-strike (pickK), give-up (points trigger, give-up geometry, cap = break-even +
  // giveUpMaxLoss x W), cover-to-open escalation, stall cover, fill-at-resting, book at the limit, fill-through ticks.
  const cfgFor = (W) => { const c = (o.coverCfg && o.coverCfg[nearestFixed(W)]) || DEFAULT_COVER[nearestFixed(W)];
    return o.giveUpMaxLoss != null ? { ...c, giveUpMaxLoss: o.giveUpMaxLoss } : c; };
  const kDir = (side) => (side === 'bull' ? 1 : -1);
  const legsAtK = (p, k) => SL.coverLegsAtShort(p.side, p.shortStrike + kDir(p.side) * k * incr, p.W);
  const kOf = (p, legs) => { const sh = (legs.find((l) => l.side === 'short') || {}).strike; return sh == null ? 0 : Math.round((sh - p.shortStrike) / incr) * kDir(p.side); };
  const rangeOf = (p) => { const c = p.cc, on = c.coverRangeInside != null || c.coverRangeBeyond != null, kIn = Math.max(0, Math.round(p.W / incr) - 1);
    return { on, lo: -Math.min(kIn, c.coverRangeInside || 0), hi: c.coverRangeBeyond || 0, prem: (c.coverRangePremium || 0) * p.W, kIn }; };
  const guKOf = (p) => { const g = p.cc.giveUpGeometry, kIn = Math.max(0, Math.round(p.W / incr) - 1);
    return g === 'tent' ? 0 : g === 'inside' ? -kIn : /^inside\d+$/.test(g || '') ? -Math.min(kIn, Number(g.slice(6))) : null; };
  const pickK = (p, eqPx, S, tau, iv) => { const R = rangeOf(p); let best = null;
    for (let k = R.hi; k >= R.lo; k--) { const gap = legsMark(legsAtK(p, k), S, tau, iv) - (eqPx + k * R.prem); if (best == null || gap < best.gap - 1e-9) best = { k, gap }; }
    return best.k; };
  const ladderOptsOf = (c) => ({ stepSeconds: c.ladderStepSeconds != null ? c.ladderStepSeconds : LAD.DEFAULTS.stepSeconds,
    stepPoints: c.ladderStepPoints != null ? c.ladderStepPoints : LAD.DEFAULTS.stepPoints, steps: c.ladderSteps != null ? c.ladderSteps : LAD.DEFAULTS.steps,
    lossCapFrac: c.ladderLossCapFrac != null ? c.ladderLossCapFrac : LAD.DEFAULTS.lossCapFrac, stepDollars: c.ladderStepDollars != null ? c.ladderStepDollars : LAD.DEFAULTS.stepDollars });
  // continuous-cover placement (runDay5m (a0b)): target = W - open - minLock, legs per geometry, range pick
  const placeCover = (p, S, tau, iv, dt) => {
    const c = p.cc, minLock = (c.continuousCoverMinLockFrac || 0) * p.W, tgt = round2(p.W - p.limit - minLock), R = rangeOf(p);
    let legs = c.coverGeometry && c.coverGeometry !== 'tent' ? SL.coverLegsAtShort(p.side, SL.coverShortFor(c.coverGeometry, p.side, p.shortStrike, S, incr), p.W)
      : SL.coverLegsAtShort(p.side, p.shortStrike, p.W);
    let k0 = null;
    if (R.on) { k0 = pickK(p, tgt, S, tau, iv); legs = legsAtK(p, k0); }
    p.cover = { legs, target: k0 != null ? round2(tgt + k0 * R.prem) : tgt, openCost: p.limit, minLock, placedMs: dt, placedUnder: S, placedI: i_cur };
    if (k0 != null) p.cover.k = k0;
    D.coversPlaced++;
  };
  let i_cur = -1;
  const bookOpen = (it, side, i, dt, S, extra) => {
    const p = { side, kind: it.kind, W: it.W, legs: it.legs, limit: it.limit, shortStrike: it.shortStrike, target: it.target, covered: false,
      coverLegs: null, coverLimit: null, cover: null, openEpoch: dt, openTime: etStamp(dt), openI: i, touched: false,
      fillI: extra.fillI, fillK: extra.fillK, openUnder: S, cc: cfgFor(it.W) };
    positions.push(p);
    capDep += it.limit * 100 * QTY; capPeak = Math.max(capPeak, capDep);
    return p;
  };
  const noteOpenCounters = (side) => {
    opensToday++;
    if (firstTouchSeen) D.opensAfterTouch++; else D.opensBeforeTouch++;
    if (lastTouch[side] != null) D.reentries++;
  };
  const noteTouch = (p, i) => { p.touched = true; D.touches++; lastTouch[p.side] = { i, level: p.target }; firstTouchSeen = true; };
  const reachesT = (p, st) => (p.side === 'bull' ? st.hi >= p.target : st.lo <= p.target);

  let settleIdx = -1;
  for (let i = 0; i < bars.length; i++) {
    i_cur = i;
    const b = bars[i], m = etMin(b.dt);
    if (m >= 575 && m <= 960) settleIdx = i;
    if (!(m >= 575 && m <= 955)) {
      // the official-close 16:00 bar (or the real 15:55-16:00 bar) still belongs to the RTH series
      if (m === 960) { const p = priceOf(b); rthBars.push({ day: etIso(b.dt), min: m, open: openOf(b), high: p.high, low: p.low, close: p.close }); }
      continue;
    }
    D.bars++;
    const A = b.analysis, px = priceOf(b), S = px.close, tau = bs.tauFromTime(b.dt);
    const day = etIso(b.dt);
    if (todayDay == null) { todayDay = day; todayOpen = openOf(b); }
    rthBars.push({ day, min: m, open: openOf(b), high: px.high, low: px.low, close: S });
    // ── IV block (copied from runDay5m) ──
    let iv = bs.ivFromRelBandWidth((A['15m'].bbupper - A['15m'].bblower) / A['15m'].close);
    if (o.intradayIV) iv *= ivMultAt(m);
    const base = iv, sig = S * base * Math.sqrt(tau);
    if (o.ivSkew) { const band = sig; iv = band > 0 ? ((type, K) => base * skewMultAt((K - S) / band)) : base; }
    if (gapDay == null) {
      gap = ctx.priorClose != null ? todayOpen - ctx.priorClose : null;
      gapDay = gap != null && sig > 0 && Math.abs(gap) >= o.gapSig * sig;
      if (gapDay) D.gapDay = 1;
    }

    // intraday floor sampled BEFORE the bar acts (runDay5m convention)
    if (positions.length) { const f = floorNow(false); ifSum += f; ifBars++; if (f >= 0) ifNonNeg++; if (f < worstFloor) worstFloor = f; }
    { const verts = positions.filter((p) => p.kind === 'vert'); const flat = verts.length > 0 && !pending && verts.every((p) => p.covered);
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
    if (pending && pending.mode === 'anchor' && i > pending.placedI) {
      const k = steps.findIndex((st) => (pending.side === 'bull' ? st.lo <= pending.anchor + 1e-9 : st.hi >= pending.anchor - 1e-9));
      if (k >= 0) {
        const pd = pending; pending = null; D.anchorFilled++;
        for (const it of pd.items) { bookOpen(it, pd.side, i, b.dt, S, { fillI: i, fillK: k }); if (it.kind === 'fly') D.flyFilled++; }
        noteOpenCounters(pd.side);
      }
    }
    // (2) continuous cover on every uncovered vertical without one (placed at this bar's close, as runDay5m)
    for (const p of positions) if (p.kind === 'vert' && !p.covered && !p.cover) placeCover(p, S, tau, iv, b.dt);
    // (3) touches on positions that are not being worked this bar (counters)
    for (const p of positions) {
      if (p.kind !== 'vert' || p.touched || p.target == null || (!p.covered && p.cover)) continue;
      const k0 = p.fillI === i ? p.fillK + 1 : 0;
      for (let k = k0; k < steps.length; k++) if (reachesT(p, steps[k])) { noteTouch(p, i); break; }
    }
    // (4) work and test the resting covers (runDay5m (a), cover branch)
    for (const p of positions) {
      if (p.kind !== 'vert' || p.covered || !p.cover) continue;
      const pc = p.cover, c = p.cc, R = rangeOf(p);
      // sub-bar: a cover placed for a position that filled IN this bar is tested only after the fill
      const k0 = p.fillI === i ? p.fillK + 1 : 0;
      if (k0 >= steps.length) continue;
      // GIVE-UP — its own triggers only: points through the short (giveUpPoints), cover-to-open, v11 eodFlat at 15:00
      let giveUp = false;
      // POINTS trigger (rostered, giveUpPoints): runDay5m measures it from the short strike, which on a v6 open sits at
      // the money. A v11 short sits up to ~0.5 sigma OTM, so that literal reading fires AT BIRTH. Anchored here: the
      // underlying must be giveUpPoints through the short AND giveUpPoints adverse from the open (identical for an
      // at-the-money short). opts.giveUpPoints === false switches the trigger off (arm guPointsOff).
      if (c.coverGiveUp && c.giveUpPoints != null && o.giveUpPoints !== false) {
        const thr = p.side === 'bull' ? Math.min(p.shortStrike - S, p.openUnder - S) : Math.min(S - p.shortStrike, S - p.openUnder);
        if (thr >= c.giveUpPoints) giveUp = true;
      }
      if (p._c2o != null) giveUp = true;
      if (isV11 && o.eodFlat && m >= o.eodFlatMin) { if (!p._eod) { p._eod = true; D.eodFlatPlaced++; } giveUp = true; }
      if (giveUp && !p._gu) { p._gu = true; D.giveUpPos++; }
      const guK = guKOf(p);
      if (giveUp && guK != null && kOf(p, pc.legs) !== guK) { pc.legs = legsAtK(p, guK); pc.k = guK; pc._resting = undefined; D.guRestrikes++; }
      const kc = R.on && !giveUp ? (pc.k != null ? pc.k : kOf(p, pc.legs)) : 0;
      let working = pc.target;
      if (giveUp) {
        const cap = (c.giveUpMaxLoss != null ? c.giveUpMaxLoss : 0.15) * p.W, mk = legsMark(pc.legs, S, tau, iv);
        let lim = round2(p.W - pc.openCost + cap);
        if (p._c2o != null) lim = p._c2o === 'mkt' ? Infinity : round2(lim + p._c2o);
        working = roundTick(Math.min(mk + TICK, lim));
      } else if (c.coverLadder) {
        working = LAD.limitNow({ spreadWidth: p.W, openCost: pc.openCost, minLock: pc.minLock || 0, restingMs: b.dt - pc.placedMs,
          underlyingMove: LAD.ladderMove(S - pc.placedUnder, p.side === 'bull' ? -1 : 1, c.ladderAdverseOnly),
          mark: legsMark(pc.legs, S, tau, iv) - kc * R.prem, tick: TICK }, ladderOptsOf(c)).limit;
        if (kc) working = round2(working + kc * R.prem);
      }
      if (!giveUp && c.stallCoverMin != null) {
        const fav = p.side === 'bull' ? S - p.openUnder : p.openUnder - S;
        if (b.dt - p.openEpoch >= c.stallCoverMin * 60000 && fav < (c.stallCoverPts || 0)) {
          const stallPx = roundTick(Math.min(round2(p.W - pc.openCost), legsMark(pc.legs, S, tau, iv) + TICK));
          if (stallPx > working) { working = stallPx; if (!p._stall) { p._stall = true; D.stallFires++; } }
        }
      }
      let fillAt = working;
      if (c.coverFillAtResting) { const resting = pc._resting != null ? pc._resting : pc.target; fillAt = Math.max(resting, working); pc._resting = working; }
      const thru = (c.fillThroughTicksCover || 0) * TICK;
      let booked = null;
      for (let k = k0; k < steps.length && booked == null; k++) {
        const st = steps[k];
        if (!p.touched && p.target != null && reachesT(p, st)) {
          noteTouch(p, i);
          // v11 TOUCH: if the tent's mark at the level locks at least the normal target, take it at mark + 1 tick,
          // bounded by the normal (working) target price. Underwater at the touch -> the normal order keeps working.
          if (isV11 && !giveUp) {
            const tp = round2(ceilTick(legsMark(pc.legs, p.target, tau, iv)) + TICK);
            if (tp <= fillAt + 1e-9) { booked = roundTick(Math.min(tp, fillAt)); D.touchCovers++; break; }
          }
        }
        if (legsMark(pc.legs, p.side === 'bull' ? st.hi : st.lo, tau, iv) <= fillAt - thru + 1e-9) booked = roundTick(c.simFillAtLimit ? fillAt : Math.min(fillAt, legsMark(pc.legs, S, tau, iv) + TICK));
      }
      if (booked == null) {
        if (R.on && !giveUp) {   // RANGE RE-STRIKE at the close
          const eq = round2(working - kc * R.prem), k2 = pickK(p, eq, S, tau, iv);
          if (k2 !== kc) { const pxk = round2(eq + k2 * R.prem); pc.legs = legsAtK(p, k2); pc.k = k2; pc.target = pxk; pc._resting = pxk; D.rangeRestrikes++; }
        }
        continue;
      }
      const f0 = floorNow(true);
      p.covered = true; p.coverLegs = pc.legs; p.coverLimit = round2(booked);
      const f1 = floorNow(true);
      if (f1 < f0 && -f1 > capFor(p.W)) { p.covered = false; p.coverLegs = null; p.coverLimit = null; D.coverDeferred++; continue; }
      p.coverEpoch = b.dt; p.coverTime = etStamp(b.dt);
      if (p._gu) D.giveUpCovered++;
      capDep += p.coverLimit * 100 * QTY; capPeak = Math.max(capPeak, capDep);
    }
    if (pending && pending.mode === 'anchor' && i - pending.placedI >= o.entryBars) { pending = null; D.anchorCanceled++; }

    // ── decision on the completed bar ──
    const window = isV11 ? (m >= o.firstOpenMin && m <= o.v11Cutoff) : (m >= o.firstOpenMin && m <= o.v10Cutoff);
    const decide = () => {
      if (!window) { D.windowOut++; return; }
      D.decisions++;
      if (pending) { D.pendingBusy++; return; }
      const r15 = lineAt(15, cache15, day, m), r60 = lineAt(60, cache60, day, m);
      const nq = A['5m'].close, basis = nq - S, c15 = A['15m'], c60 = A['60m'];
      const t15 = trendOf(nq, c15.ema, nqSlope(c15)), t60 = trendOf(nq, c60.ema, nqSlope(c60));
      const rt15 = r15 ? trendOf(S, r15.ema, r15.ema - r15.emaPrev) : 0, rt60 = r60 ? trendOf(S, r60.ema, r60.ema - r60.emaPrev) : 0;
      let dir = 0, T = null, Wv = o.width === 'sig' || o.width === 'mix' ? sigW(sig) : o.width, Wfly = null;
      if (!isV11) {
        T = c15.ema - basis; dir = Math.sign(T - S);
        if (o.target60 && dir) { const e60 = c60.ema - basis; if (Math.sign(e60 - S) === dir && Math.sign(nqSlope(c60)) === dir) { T = e60; D.target60Used++; } }
        if (o.gapRth60 && gapDay && m < 720 && r60 && dir) { if (Math.sign(r60.ema - S) === dir && Math.abs(r60.ema - S) < Math.abs(T - S)) { T = r60.ema; D.gapRth60Used++; } }
        if (!dir || Math.abs(T - S) < 0.1 * sig) { D.noDir++; return; }
        if (o.rthGate && (rt15 === -dir || rt60 === -dir)) { D.rthGateBlock++; return; }
        if (o.noGapFade && gapDay && opensToday === 0 && !pending && dir === Math.sign(ctx.priorClose - S)) { D.gapFadeBlock++; return; }
        if (o.width === 'mix') Wfly = 10;
      } else {
        if (!r15) { D.noLines++; return; }
        const inRange = (L) => { const d = Math.abs(L - S); return d >= o.minDist * sig && d <= o.maxDist * sig; };
        if (o.v11Next === 'same') {
          T = r15.mid; dir = Math.sign(T - S);
          if (!dir) { D.noDir++; return; }
          if (!inRange(T)) { D.distOut++; return; }
          const ok = o.trendBoth ? (t15 === dir && t60 === dir) : t15 === dir;
          if (!ok) { D.trendFail++; return; }
        } else {
          if (o.v11Next === 'ladder') dir = o.trendBoth ? (t15 !== 0 && t15 === t60 ? t15 : 0) : t15;
          else { dir = t15; if (dir && (rt15 === -dir || rt60 === -dir)) { D.trendFail++; return; } }
          if (!dir) { D.trendFail++; return; }
          const lines = [r15.mid, r15.ema, r15.upper, r15.lower];
          if (r60) lines.push(r60.ema, r60.mid);
          if (ctx.priorClose != null) lines.push(ctx.priorClose);
          const lt = lastTouch[dir === 1 ? 'bull' : 'bear'];
          let best = null;
          for (const L of lines) {
            if (L == null || Math.sign(L - S) !== dir || !inRange(L)) continue;
            if (lt && (L - lt.level) * dir <= incr / 2) continue;   // after a touch: the next line BEYOND the touched one
            if (best == null || Math.abs(L - S) < Math.abs(best - S)) best = L;
          }
          if (best == null) { D.distOut++; return; }
          T = best; D.ladderTargets++;
        }
        if (o.noGapFade && gapDay && m < 720 && ctx.priorClose != null && dir === Math.sign(ctx.priorClose - S)) { D.gapFadeBlock++; return; }
        const sideK = dir === 1 ? 'bull' : 'bear';
        if (lastTouch[sideK] && i < lastTouch[sideK].i + o.reentryBars) { D.reentryBlock++; return; }
        if (o.width === 'mix') Wv = Math.abs(T - S) < 0.5 * sig ? 10 : sigW(sig);
      }
      const side = dir === 1 ? 'bull' : 'bear';
      // COVER TO OPEN (+ wait), as rostered on v6-v8: an open decision on a side holding an UNDERWATER uncovered
      // position sends that position's cover to the give-up path (+$0) and skips this open.
      if (o.coverToOpen) {
        let under = false;
        for (const p of positions) {
          if (p.kind !== 'vert' || p.covered || p.side !== side || !p.cover || !p.cc.coverToOpen) continue;
          if (legsMark(p.legs, S, tau, iv) >= p.limit) continue;
          under = true;
          if (p._c2o == null) { p._c2o = p.cc.coverToOpenExtra != null ? p.cc.coverToOpenExtra : 0; D.c2oFires++; }
        }
        if (under && positions.some((p) => p.kind === 'vert' && p.side === side && !p.covered && p.cc.coverToOpenWait && legsMark(p.legs, S, tau, iv) < p.limit)) { D.c2oWait++; return; }
      }
      // stacks: uncovered same-side verticals (filled; nothing is pending here)
      const nUnc = positions.filter((p) => p.kind === 'vert' && !p.covered && p.side === side).length;
      if (nUnc >= o.maxStack) { D.stackFull++; return; }
      const b15 = `${day}|${Math.floor((m - 5 - 570) / 15)}`;
      if (nUnc >= 1) {
        const agree = (rt15 === dir) || (rt60 === dir), against = (rt15 === -dir) || (rt60 === -dir);
        if (!agree || against) { D.stackNoAgree++; return; }
        if (last15Open[side] === b15) { D.stack15mBlock++; return; }
      }
      // chase filter: NQ price inside the last completed NQ 15m candle
      if (o.chase) { const rng = c15.high - c15.low; if (rng > 0) { const fr = (nq - c15.low) / rng; if ((dir === 1 && fr >= 1 - o.chaseFrac) || (dir === -1 && fr <= o.chaseFrac)) { D.chaseBlock++; return; } } }
      // strikes
      let short;
      if (!isV11) short = dir === 1 ? Math.ceil(S / incr - 1e-9) * incr : Math.floor(S / incr + 1e-9) * incr;
      else {
        short = Math.round((S + o.f * (T - S)) / incr) * incr;
        if (dir === 1 && short > T) short = Math.floor(T / incr) * incr;
        if (dir === -1 && short < T) short = Math.ceil(T / incr) * incr;
      }
      if (o.farOtmBan && (short - S) * dir >= 0.8 * sig) { D.farOtm++; return; }
      const W = Wv, legs = vertLegs(side, short, W);
      // entry level
      const mid = (px.high + px.low) / 2;
      const anchor = o.entry === 'anchor' ? (dir === 1 ? Math.min(mid, S) : Math.max(mid, S)) : S;
      const vMark = legsMark(legs, anchor, tau, iv);
      if (!(vMark > 0) || vMark > capFracFor(W) * W) { D.geoDecline++; return; }
      const items = [{ kind: 'vert', legs, limit: Math.max(TICK, ceilTick(vMark)), W, shortStrike: short, target: T }];
      if (!isV11 && o.fly && Math.abs(T - S) <= 0.5 * sig) {
        const Wf = Wfly || W, K = Math.round(T / incr) * incr, fk = `${K}|${Wf}`;
        if (!fliesDone.has(fk) && !(o.farOtmBan && Math.abs(K - S) >= 0.8 * sig)) {
          // ONE vol for the whole fly (the skew at its body): the bucketed skew is a step function, and a fly straddling a
          // bucket edge prices its wings on different vols — measured 0.40 vs 1.35 flat for a 20-wing fly at 0.34 band.
          const flyIv = typeof iv === 'function' ? base * skewMultAt((K - S) / sig) : iv;
          const fl = flyLegs(K, Wf, S), fm = legsMark(fl, anchor, tau, flyIv);
          if (fm > 0 && fm <= capFracFor(Wf) * Wf) { items.push({ kind: 'fly', legs: fl, limit: Math.max(TICK, ceilTick(fm)), W: Wf, shortStrike: K, target: null }); }
          else D.flyBlocked++;
        }
      }
      // cap (governor semantics: the new order counted as filled) — vertical first, fly only if it also fits
      const extras = items.map((it) => ({ legs: it.legs, limit: it.limit, covered: false }));
      if (-floorOfList(bookList(true, extras.slice(0, 1))) > capFor(W)) { D.capBlock++; return; }
      if (extras.length > 1 && -floorOfList(bookList(true, extras)) > capFor(W)) { items.pop(); extras.pop(); D.flyBlocked++; }
      if (o.bookReject) {
        const L = bookList(true, extras), pay = payoffOf(L);
        if (pay(S) < 0) { D.bookRejectSpot++; return; }
        if (probLoss(pay, S, sig) > 0.5) { D.bookRejectP++; return; }
      }
      for (const it of items) if (it.kind === 'fly') { fliesDone.add(`${it.shortStrike}|${it.W}`); D.flyPlaced++; }
      D.placed++; last15Open[side] = b15;
      if (o.entry === 'anchor') { pending = { mode: 'anchor', side, items, anchor, placedI: i }; D.anchorPlaced++; }
      else {
        D.marketFilled++;
        for (const it of items) { bookOpen(it, side, i, b.dt, S, { fillI: i, fillK: Infinity }); if (it.kind === 'fly') D.flyFilled++; }
        noteOpenCounters(side);
      }
    };
    decide();
    // end-of-bar bookkeeping
    if (positions.length) { const f = floorNow(false); if (f > bestFloorSeen) bestFloorSeen = f; if (f >= 0) everPositive = true; }
    capSum += capDep; capN++;
  }
  if (pending) { pending = null; D.anchorCanceled++; }
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
    lock: { traded: positions.length > 0, endBookFloor: endF != null ? Math.round(endF) : null, endFloorNoLoss: positions.length > 0 && endF >= 0,
      endFloorProfit: positions.length > 0 && endF > 0, bestFloor: Number.isFinite(bestFloorSeen) ? Math.round(bestFloorSeen) : null, everPositive },
    capital: { peakReal: Math.round(capPeak), avgReal: capN ? round2(capSum / capN) : 0 },
    legs: null, harvest: null, wings: { count: 0, spent: 0 }, giveUpPos: D.giveUpPos, giveUpCovered: D.giveUpCovered, floorRaise: null,
    giveUpTrendFires: undefined, giveUpCandleFires: undefined, trendFloor: undefined, coverAsym: undefined, sigCoverGiveUps: 0, coverSameBar: 0,
    subBar: o.subBarFill ? { mode: o.subBarFill } : undefined, openTrendBlocked: undefined, stallFires: D.stallFires, lateFloor: undefined,
    floorAt14, floorAt15,
    intradayFloorAvg: ifBars ? Math.round(ifSum / ifBars) : null, intradayFloorNonNegPct: ifBars ? Math.round(1000 * ifNonNeg / ifBars) / 10 : null,
    tents: verts.filter((p) => p.covered).length, flatFloors, coverRange: { rangeRestrikes: D.rangeRestrikes, guRestrikes: D.guRestrikes, stepIns: 0, rolls: 0, rollSpent: 0 },
    coverMins: verts.filter((p) => p.covered && !p._gu).map((p) => Math.round((p.coverEpoch - p.openEpoch) / 60000)),
    giveUpMins: verts.filter((p) => p.covered && p._gu).map((p) => Math.round((p.coverEpoch - p.openEpoch) / 60000)),
    uncoveredEod: verts.filter((p) => !p.covered).length,
    governor: null, ratchet: null,
    // target-engine extras
    touch: undefined, decisions: D, gap: gap != null ? round2(gap) : null, gapDay: !!gapDay, rthPriorBars: nPrior,
  };
}

// ── shared with the runDay5m touch overlay (backtest-v6-5m opts.touch*) ─────────────────────────────────
// RTH line tracker: prior sessions bucketed once, today's bars pushed as they complete; lines(P, day, min) returns the
// completed-bucket BB(20,2)/9EMA lines (null until 20 buckets) — the same aggregate/linesOf the target engine uses.
function makeRthLines(priorBars) {
  const prior = { 15: aggregate(priorBars || [], 15, null, 0), 60: aggregate(priorBars || [], 60, null, 0) };
  const today = [], cache = { 15: { n: -1, l: null }, 60: { n: -1, l: null } };
  return {
    push: (bar) => today.push(bar),
    lines: (P, day, min) => { const t = aggregate(today, P, day, min); if (t.length !== cache[P].n) { cache[P].n = t.length; cache[P].l = linesOf(prior[P].concat(t)); } return cache[P].l; },
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

module.exports = { makeRthLines, v11Setup, nqSlope, DEFAULT_COVER, COVER_KEYS, runDayTarget, buildRthContexts, sessionFromBars, sessionFrom1m, aggregate, linesOf, trendOf, probLoss, etMin, etIso, DEFAULTS, CAP_BY_W, CAPFRAC_BY_W };
