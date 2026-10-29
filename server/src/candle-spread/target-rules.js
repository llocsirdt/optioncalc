'use strict';
/**
 * TARGET RULES (v10 / v11) — the ONE implementation of the target engines' decisions, shared by the backtest
 * (backtest/backtest-target.js runDayTarget) and the live simulate-only trader (target-trader.js).
 *
 * Design: docs/journal/2026-10-16.md "v10 / v11 target engines" (backtest 5308054). Live port 2026-10-23.
 *   v10 = hold toward a close target: lean a debit vertical (and, near the target, a fly) toward the NQ 15m 9EMA (the
 *         60m 9EMA when it agrees, the NDX-RTH 60m EMA on a gap morning), short at the money, standing tent cover.
 *   v11 = touch target: open toward the NDX-RTH 15m BB mid when the NQ 15m AND 60m trends both point to it, short part
 *         of the way (f 0.5), cover AT THE TOUCH, give-up pricing on every cover from 15:00 (flat-ish by 15:00).
 *
 * WHAT IS SHARED HERE: the config (defaults, per-width cap / capFrac / cover config), the book state, the open
 * decision (every gate, in order, with its trace), the anchored entry level, the fly, the cap and book-reject checks,
 * the cover machinery (placement + target, range strike pick, give-up triggers, ladder / give-up / stall working
 * price, fill-at-resting, the v11 touch cover, the cap deferral at the fill, the range re-strike), touches, the
 * floor. WHAT IS NOT: how a price is read and how a fill is observed. The engine hands every rule a PRICER:
 *   pr.now(legs)          the structure's mark at the current underlying   (backtest: BS; live: the real chain)
 *   pr.at(legs, X)        a vertical's mark if the underlying were at X    (backtest: BS; live: chain + BS shift)
 *   pr.flyAt(legs, X, K)  a fly's mark at X, one vol at its body K         (backtest: BS; live: chain + BS shift)
 * and tests fills its own way (backtest: the 1m / inferred bar path against BS marks; live: the real chain mark on
 * every 5m tick and 30 s pass). A live mark can be null (unquoted leg); every rule treats null as "cannot price
 * this" and leaves the order as it was. The backtest never produces null, so the null guards never change it.
 *
 * FOUNDATIONAL: signals (NQ 15m/60m 9EMA, trends, chase filter) come from /NQ `A` (24h, last COMPLETED candle);
 * pricing, fills, the NDX-RTH lines and settlement come from cash NDX. NQ levels move into pricing space with the
 * live basis (NQ 5m close - NDX close).
 */
const eng = require('./backtest/backtest-v4');
const { ivMultAt, skewMultAt } = require('./backtest/backtest-v6-5m');
const SL = require('./spread-logic');
const LAD = require('./cover-ladder');
const bs = eng.bs, legsMark = eng.legsMark, legsPayoff = eng.legsPayoff, TICK = eng.TICK, QTY = eng.QTY;
const round2 = eng.round2, roundTick = eng.roundTick;
const ceilTick = (p) => Math.round(Math.ceil((p / TICK) - 1e-9) * TICK * 100) / 100;
const floorTick = (p) => Math.round(Math.floor((p / TICK) + 1e-9) * TICK * 100) / 100;

const _fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false });
function etMin(ms) { const p = _fmt.formatToParts(new Date(ms)); let h = 0, m = 0; for (const x of p) { if (x.type === 'hour') h = Number(x.value) % 24; else if (x.type === 'minute') m = Number(x.value); } return h * 60 + m; }
const _dfmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const etIso = (ms) => _dfmt.format(new Date(ms));
const etStamp = (ms) => { const iso = etIso(ms), m = etMin(ms); return `${iso.slice(5, 7)}/${iso.slice(8, 10)} ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };

// ── CONFIG ───────────────────────────────────────────────────────────────────────────────────────────
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
// The cover-relevant slice of the v6-W roster (optsFor(buildRuns v6-10/20/40), 2026-10-16). The sweep and the live
// roster read the roster instead (opts.coverCfg); this copy is only the fallback for callers that do not.
const COMMON_COVER = { continuousCover: true, coverGiveUp: true, giveUpPoints: 20, coverToOpen: 'same', coverToOpenExtra: 0, coverToOpenWait: true, stallCoverMin: 15,
  coverLadder: true, ladderStepSeconds: 120, ladderStepPoints: 10, ladderLossCapFrac: 0, ladderStepDollars: 0.05, fillThroughTicksCover: 1, simFillAtLimit: true, coverFillAtResting: true };
const DEFAULT_COVER = {
  10: { ...COMMON_COVER, continuousCoverMinLockFrac: 0.05, coverGeometry: 'offset1', giveUpMaxLoss: 0.05, giveUpGeometry: 'tent' },
  20: { ...COMMON_COVER, continuousCoverMinLockFrac: 0.2, giveUpMaxLoss: 0.075, giveUpGeometry: 'inside', coverRangeInside: 9, coverRangeBeyond: 2, coverRangePremium: 0.02 },
  40: { ...COMMON_COVER, continuousCoverMinLockFrac: 0.2, giveUpMaxLoss: 0.1, giveUpGeometry: 'inside', coverRangeInside: 9, coverRangeBeyond: 2, coverRangePremium: 0.02 },
};
const COVER_KEYS = Object.keys({ ...COMMON_COVER, continuousCoverMinLockFrac: 0, coverGeometry: 0, giveUpMaxLoss: 0, giveUpGeometry: 0, coverRangeInside: 0, coverRangeBeyond: 0, coverRangePremium: 0, ladderSteps: 0, ladderAdverseOnly: 0, stallCoverPts: 0 });

// THE ROSTER -> ENGINE OPTS for a target variant (live and baselines read the same thing). `targetEngine` carries the
// engine's own knobs (family, width, any arm override); the cover config is the variant's own v6-W shape run through
// the shared optsFor and sliced to COVER_KEYS (= the sweep's coverCfg); lossMax null (an -unc twin) = no cap.
function coverCfgFromOpts(o6) { const c = {}; for (const k of COVER_KEYS) if (o6[k] !== undefined) c[k] = o6[k]; return c; }

const configOf = (optsIn) => ({ ...DEFAULTS, ...optsIn });
const capFor = (o, W) => (o.lossMax != null ? o.lossMax : CAP_BY_W[nearestFixed(W)]);
const capFracFor = (o, W) => (o.capFrac != null ? o.capFrac : CAPFRAC_BY_W[nearestFixed(W)]);
const cfgFor = (o, W) => { const c = (o.coverCfg && o.coverCfg[nearestFixed(W)]) || DEFAULT_COVER[nearestFixed(W)];
  return o.giveUpMaxLoss != null ? { ...c, giveUpMaxLoss: o.giveUpMaxLoss } : c; };

// ── PURE HELPERS ─────────────────────────────────────────────────────────────────────────────────────
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
// THE PRICING MODEL of a bar (runDay5m's IV block): band IV off the NQ 15m band x the intraday multiplier, sigma to
// the close, per-leg skew. Live uses it for sig (the distance gates, sigW, far-OTM ban, book-reject P) and for the
// anchor SHIFT only — every live price is the real chain.
function pricingModel(A15, S, tau, m, o) {
  let iv = bs.ivFromRelBandWidth((A15.bbupper - A15.bblower) / A15.close);
  if (o.intradayIV) iv *= ivMultAt(m);
  const base = iv, sig = S * base * Math.sqrt(tau);
  if (o.ivSkew) { const band = sig; iv = band > 0 ? ((type, K) => base * skewMultAt((K - S) / band)) : base; }
  return { iv, base, sig };
}
// The BS pricer the backtest uses (and the live trader uses for the anchor shift).
function modelPricer(S, tau, iv, base, sig) {
  return {
    now: (legs) => legsMark(legs, S, tau, iv),
    at: (legs, X) => legsMark(legs, X, tau, iv),
    // ONE vol for the whole fly (the skew at its body): the bucketed skew is a step function, and a fly straddling a
    // bucket edge prices its wings on different vols — measured 0.40 vs 1.35 flat for a 20-wing fly at 0.34 band.
    flyAt: (fl, X, K) => legsMark(fl, X, tau, typeof iv === 'function' ? base * skewMultAt((K - S) / sig) : iv),
  };
}

// ── STRUCTURES ───────────────────────────────────────────────────────────────────────────────────────
const vertLegs = (side, short, W) => (side === 'bull'
  ? [{ side: 'long', type: 'C', strike: short - W }, { side: 'short', type: 'C', strike: short }]
  : [{ side: 'long', type: 'P', strike: short + W }, { side: 'short', type: 'P', strike: short }]);
const flyLegs = (K, W, S) => { const t = K >= S ? 'C' : 'P';
  return [{ side: 'long', type: t, strike: K - W }, { side: 'short', type: t, strike: K }, { side: 'short', type: t, strike: K }, { side: 'long', type: t, strike: K + W }]; };
const sigW = (sig, incr) => Math.max(10, Math.min(40, Math.round(0.25 * sig / incr) * incr));

// ── THE BOOK (state both engines carry; JSON-clean so the live record can persist it) ──────────────────
const COUNTERS = ['bars', 'decisions', 'windowOut', 'noDir', 'distOut', 'trendFail', 'rthGateBlock', 'gapFadeBlock', 'chaseBlock',
  'stackFull', 'stackNoAgree', 'stack15mBlock', 'farOtm', 'geoDecline', 'capBlock', 'bookRejectSpot', 'bookRejectP',
  'reentryBlock', 'pendingBusy', 'noLines', 'placed', 'anchorPlaced', 'anchorFilled', 'anchorCanceled', 'marketFilled',
  'flyPlaced', 'flyFilled', 'flyBlocked', 'touches', 'reentries', 'opensBeforeTouch', 'opensAfterTouch', 'eodFlatPlaced',
  'coverDeferred', 'coversPlaced', 'giveUpPos', 'giveUpCovered', 'guRestrikes', 'rangeRestrikes', 'stallFires', 'touchCovers', 'c2oFires', 'c2oWait', 'target60Used', 'gapRth60Used', 'gapDay', 'ladderTargets'];
function newBook(o, ctx) {
  const D = {}; for (const k of COUNTERS) D[k] = 0;
  return { family: o.family, isV11: o.family === 'v11', incr: o.incr, positions: [], pending: null, firstTouchSeen: false,
    lastTouch: { bull: null, bear: null }, last15Open: { bull: null, bear: null }, fliesDone: [], opensToday: 0,
    todayDay: null, todayOpen: null, gapDay: null, gap: null, priorClose: ctx && ctx.priorClose != null ? ctx.priorClose : null,
    capDep: 0, capPeak: 0, D };
}

// ── FLOOR (runDay5m floorOf semantics; pending counted as filled when asked) ─────────────────────────────
const posPnlAt = (p, X) => { let v = legsPayoff(p.legs, X), c = p.limit; if (p.covered) { v += legsPayoff(p.coverLegs, X); c += p.coverLimit; } return (v - c) * 100 * QTY; };
function bookList(book, withPending, extras) {
  const L = book.positions.slice();
  if (withPending && book.pending) for (const it of book.pending.items) L.push({ legs: it.legs, limit: it.limit, covered: false });
  if (extras) for (const x of extras) L.push(x);
  return L;
}
const payoffOf = (L) => (X) => { let t = 0; for (const p of L) t += posPnlAt(p, X); return t; };
function floorOfList(L, incr) {
  if (!L.length) return 0;
  const ks = new Set();
  for (const p of L) { for (const l of p.legs) ks.add(l.strike); if (p.covered) for (const l of p.coverLegs) ks.add(l.strike); }
  let lo = Infinity, hi = -Infinity, m = Infinity; const f = payoffOf(L);
  for (const k of ks) { if (k < lo) lo = k; if (k > hi) hi = k; const v = f(k); if (v < m) m = v; }
  m = Math.min(m, f(lo - incr), f(hi + incr));
  return m;
}
const floorNow = (book, withPending) => floorOfList(bookList(book, withPending), book.incr);

// ── DAY CONTEXT ──────────────────────────────────────────────────────────────────────────────────────
// The first in-window bar fixes today's open; the gap (today's open vs the prior RTH close) is judged on that bar's
// sigma. Idempotent.
function noteDay(book, day, open) { if (book.todayDay == null) { book.todayDay = day; book.todayOpen = open; } }
function noteGap(book, o, sig) {
  if (book.gapDay != null) return;
  book.gap = book.priorClose != null ? book.todayOpen - book.priorClose : null;
  book.gapDay = book.gap != null && sig > 0 && Math.abs(book.gap) >= o.gapSig * sig;
  if (book.gapDay) book.D.gapDay = 1;
}

// ── OPENS ────────────────────────────────────────────────────────────────────────────────────────────
// A filled item becomes a position. `extra` carries the engine's own fields (backtest fillI/fillK; live id / filled /
// quantity / fill evidence) — none of them is read by a rule.
function bookOpen(book, o, it, side, i, dt, S, extra) {
  const p = { side, kind: it.kind, W: it.W, legs: it.legs, limit: it.limit, shortStrike: it.shortStrike, target: it.target, covered: false,
    coverLegs: null, coverLimit: null, cover: null, openEpoch: dt, openTime: etStamp(dt), openI: i, touched: false,
    ...extra, openUnder: S, cc: cfgFor(o, it.W) };
  book.positions.push(p);
  book.capDep += it.limit * 100 * QTY; book.capPeak = Math.max(book.capPeak, book.capDep);
  return p;
}
function noteOpenCounters(book, side) {
  book.opensToday++;
  if (book.firstTouchSeen) book.D.opensAfterTouch++; else book.D.opensBeforeTouch++;
  if (book.lastTouch[side] != null) book.D.reentries++;
}
// The working anchored order filled: every item becomes a position.
function fillPending(book, o, i, dt, S, extraOf) {
  const pd = book.pending; book.pending = null; book.D.anchorFilled++;
  const out = [];
  for (const it of pd.items) { out.push(bookOpen(book, o, it, pd.side, i, dt, S, extraOf(it))); if (it.kind === 'fly') book.D.flyFilled++; }
  noteOpenCounters(book, pd.side);
  return out;
}
// An anchored order lives entryBars bars; cancelled after the bar that reaches that age. Returns the cancelled order.
function expirePending(book, o, i) {
  if (book.pending && book.pending.mode === 'anchor' && i - book.pending.placedI >= o.entryBars) { const pd = book.pending; book.pending = null; book.D.anchorCanceled++; return pd; }
  return null;
}

// ── TOUCHES ──────────────────────────────────────────────────────────────────────────────────────────
const reachesT = (p, st) => (p.side === 'bull' ? st.hi >= p.target : st.lo <= p.target);
function noteTouch(book, p, i) { p.touched = true; book.D.touches++; book.lastTouch[p.side] = { i, level: p.target }; book.firstTouchSeen = true; }

// ── COVER MACHINERY (ported from runDay5m, PORTED_COVER) ──────────────────────────────────────────────
// Per-width cover config = the v6-W roster through optsFor (opts.coverCfg; DEFAULT_COVER mirrors it). Reused helpers:
// cover-ladder.js limitNow/ladderMove, spread-logic.js coverShortFor/coverLegsAtShort. Ported from runDay5m:
// continuous-cover placement + target (W - open - minLock), offset/range geometry + range re-strike (pickK), give-up
// (points trigger, give-up geometry, cap = break-even + giveUpMaxLoss x W), cover-to-open escalation, stall cover,
// fill-at-resting, book at the limit, fill-through ticks.
const kDir = (side) => (side === 'bull' ? 1 : -1);
const legsAtK = (book, p, k) => SL.coverLegsAtShort(p.side, p.shortStrike + kDir(p.side) * k * book.incr, p.W);
const kOf = (book, p, legs) => { const sh = (legs.find((l) => l.side === 'short') || {}).strike; return sh == null ? 0 : Math.round((sh - p.shortStrike) / book.incr) * kDir(p.side); };
const rangeOf = (book, p) => { const c = p.cc, on = c.coverRangeInside != null || c.coverRangeBeyond != null, kIn = Math.max(0, Math.round(p.W / book.incr) - 1);
  return { on, lo: -Math.min(kIn, c.coverRangeInside || 0), hi: c.coverRangeBeyond || 0, prem: (c.coverRangePremium || 0) * p.W, kIn }; };
const guKOf = (book, p) => { const g = p.cc.giveUpGeometry, kIn = Math.max(0, Math.round(p.W / book.incr) - 1);
  return g === 'tent' ? 0 : g === 'inside' ? -kIn : /^inside\d+$/.test(g || '') ? -Math.min(kIn, Number(g.slice(6))) : null; };
// The strike in the range whose price sits furthest below its equivalent target. null when nothing in range prices.
const pickK = (book, p, eqPx, pr) => { const R = rangeOf(book, p); let best = null;
  for (let k = R.hi; k >= R.lo; k--) { const mk = pr.now(legsAtK(book, p, k)); if (mk == null) continue; const gap = mk - (eqPx + k * R.prem); if (best == null || gap < best.gap - 1e-9) best = { k, gap }; }
  return best == null ? null : best.k; };
const ladderOptsOf = (c) => ({ stepSeconds: c.ladderStepSeconds != null ? c.ladderStepSeconds : LAD.DEFAULTS.stepSeconds,
  stepPoints: c.ladderStepPoints != null ? c.ladderStepPoints : LAD.DEFAULTS.stepPoints, steps: c.ladderSteps != null ? c.ladderSteps : LAD.DEFAULTS.steps,
  lossCapFrac: c.ladderLossCapFrac != null ? c.ladderLossCapFrac : LAD.DEFAULTS.lossCapFrac, stepDollars: c.ladderStepDollars != null ? c.ladderStepDollars : LAD.DEFAULTS.stepDollars });

// Continuous-cover placement (runDay5m (a0b)): target = W - open - minLock, legs per geometry, range pick.
function placeCover(book, p, S, pr, dt, i) {
  const c = p.cc, minLock = (c.continuousCoverMinLockFrac || 0) * p.W, tgt = round2(p.W - p.limit - minLock), R = rangeOf(book, p);
  let legs = c.coverGeometry && c.coverGeometry !== 'tent' ? SL.coverLegsAtShort(p.side, SL.coverShortFor(c.coverGeometry, p.side, p.shortStrike, S, book.incr), p.W)
    : SL.coverLegsAtShort(p.side, p.shortStrike, p.W);
  let k0 = null;
  if (R.on) { k0 = pickK(book, p, tgt, pr); if (k0 != null) legs = legsAtK(book, p, k0); }
  p.cover = { legs, target: k0 != null ? round2(tgt + k0 * R.prem) : tgt, openCost: p.limit, minLock, placedMs: dt, placedUnder: S, placedI: i };
  if (k0 != null) p.cover.k = k0;
  book.D.coversPlaced++;
  return p.cover;
}

// ONE BAR'S WORK ON A RESTING COVER: give-up triggers, the give-up re-strike, the working price (give-up / ladder /
// stall), fill-at-resting and the fill-through bar. Mutates the position's flags and the cover; the engine then tests
// the fill its own way against { fillAt, thru } (and the v11 touch cover). { unquoted: true } = a mark it needed was
// null (live only) — nothing is worked this bar.
function coverStep(book, o, p, x) {
  const { S, m, dt, pr } = x;
  const pc = p.cover, c = p.cc, R = rangeOf(book, p), D = book.D;
  let giveUp = false;
  const why = [];
  // POINTS trigger (rostered, giveUpPoints): runDay5m measures it from the short strike, which on a v6 open sits at
  // the money. A v11 short sits up to ~0.5 sigma OTM, so that literal reading fires AT BIRTH. Anchored here: the
  // underlying must be giveUpPoints through the short AND giveUpPoints adverse from the open (identical for an
  // at-the-money short). opts.giveUpPoints === false switches the trigger off (arm guPointsOff).
  if (c.coverGiveUp && c.giveUpPoints != null && o.giveUpPoints !== false) {
    const thr = p.side === 'bull' ? Math.min(p.shortStrike - S, p.openUnder - S) : Math.min(S - p.shortStrike, S - p.openUnder);
    if (thr >= c.giveUpPoints) { giveUp = true; why.push('points'); }
  }
  if (p._c2o != null) { giveUp = true; why.push('cover-to-open'); }
  let eodNew = false;
  if (book.isV11 && o.eodFlat && m >= o.eodFlatMin) { if (!p._eod) { p._eod = true; D.eodFlatPlaced++; eodNew = true; } giveUp = true; why.push('eod-flat'); }
  let guNew = false;
  if (giveUp && !p._gu) { p._gu = true; D.giveUpPos++; guNew = true; }
  const guK = guKOf(book, p);
  let restruck = false;
  if (giveUp && guK != null && kOf(book, p, pc.legs) !== guK) { pc.legs = legsAtK(book, p, guK); pc.k = guK; pc._resting = undefined; D.guRestrikes++; restruck = true; }
  const kc = R.on && !giveUp ? (pc.k != null ? pc.k : kOf(book, p, pc.legs)) : 0;
  let working = pc.target, stallNew = false;
  if (giveUp) {
    const cap = (c.giveUpMaxLoss != null ? c.giveUpMaxLoss : 0.15) * p.W, mk = pr.now(pc.legs);
    if (mk == null) return { unquoted: true, giveUp, why, guNew, eodNew, restruck };
    let lim = round2(p.W - pc.openCost + cap);
    if (p._c2o != null) lim = p._c2o === 'mkt' ? Infinity : round2(lim + p._c2o);
    working = roundTick(Math.min(mk + TICK, lim));
  } else if (c.coverLadder) {
    const mk = pr.now(pc.legs);
    working = LAD.limitNow({ spreadWidth: p.W, openCost: pc.openCost, minLock: pc.minLock || 0, restingMs: dt - pc.placedMs,
      underlyingMove: LAD.ladderMove(S - pc.placedUnder, p.side === 'bull' ? -1 : 1, c.ladderAdverseOnly),
      mark: mk == null ? null : mk - kc * R.prem, tick: TICK }, ladderOptsOf(c)).limit;
    if (kc) working = round2(working + kc * R.prem);
  }
  if (!giveUp && c.stallCoverMin != null) {
    const fav = p.side === 'bull' ? S - p.openUnder : p.openUnder - S;
    if (dt - p.openEpoch >= c.stallCoverMin * 60000 && fav < (c.stallCoverPts || 0)) {
      const mk = pr.now(pc.legs);
      if (mk != null) {
        const stallPx = roundTick(Math.min(round2(p.W - pc.openCost), mk + TICK));
        if (stallPx > working) { working = stallPx; if (!p._stall) { p._stall = true; D.stallFires++; stallNew = true; } }
      }
    }
  }
  let fillAt = working;
  if (c.coverFillAtResting) { const resting = pc._resting != null ? pc._resting : pc.target; fillAt = Math.max(resting, working); pc._resting = working; }
  const thru = (c.fillThroughTicksCover || 0) * TICK;
  return { giveUp, why, guNew, eodNew, stallNew, restruck, kc, R, working, fillAt, thru };
}

// v11 TOUCH: if the tent's mark at the level (backtest: BS at the target; live: the real chain right after the touch)
// locks at least the normal target, take it at mark + 1 tick, bounded by the normal (working) target price.
// Underwater at the touch -> null: the normal order keeps working.
function touchCoverPrice(book, giveUp, fillAt, markAtTouch) {
  if (!book.isV11 || giveUp || markAtTouch == null) return null;
  const tp = round2(ceilTick(markAtTouch) + TICK);
  if (tp <= fillAt + 1e-9) { book.D.touchCovers++; return roundTick(Math.min(tp, fillAt)); }
  return null;
}

// The cover filled at `booked`: the CAP check (a fill that lowers the floor below -cap is deferred and the order keeps
// working), then the position is a tent. Returns { covered, f0, f1 } or { deferred, f0, f1 }.
function bookCover(book, o, p, booked, dt) {
  const pc = p.cover;
  const f0 = floorNow(book, true);
  p.covered = true; p.coverLegs = pc.legs; p.coverLimit = round2(booked);
  const f1 = floorNow(book, true);
  if (f1 < f0 && -f1 > capFor(o, p.W)) { p.covered = false; p.coverLegs = null; p.coverLimit = null; book.D.coverDeferred++; return { deferred: true, f0, f1 }; }
  p.coverEpoch = dt; p.coverTime = etStamp(dt);
  if (p._gu) book.D.giveUpCovered++;
  book.capDep += p.coverLimit * 100 * QTY; book.capPeak = Math.max(book.capPeak, book.capDep);
  return { covered: true, f0, f1 };
}

// RANGE RE-STRIKE at the close of a bar that did not fill (never on a give-up).
function rangeRestrike(book, p, w, pr) {
  if (!(w.R.on && !w.giveUp)) return null;
  const pc = p.cover, eq = round2(w.working - w.kc * w.R.prem), k2 = pickK(book, p, eq, pr);
  if (k2 == null || k2 === w.kc) return null;
  const pxk = round2(eq + k2 * w.R.prem); pc.legs = legsAtK(book, p, k2); pc.k = k2; pc.target = pxk; pc._resting = pxk; book.D.rangeRestrikes++;
  return { from: w.kc, to: k2, target: pxk };
}

// ── THE OPEN DECISION on a completed bar ─────────────────────────────────────────────────────────────
// x = { i, m, day, dt, S, px:{high,low}, A (NQ analysis), sig, lines: () => ({ r15, r60 }), pr, trace? }.
// Mutates the book exactly as the 10/16 engine did (counters, c2o flags, last15Open, fliesDone, D.placed) and returns
// { place: { side, mode, items, anchor, T, short, W } } or { block: '<counter>' } (or { idle: '<counter>' } outside
// the window / with an order working). trace (optional, live) receives every gate in order: { name, ok, value }.
function decide(book, o, x) {
  const D = book.D, isV11 = book.isV11, incr = book.incr, tr = x.trace || null;
  const g = (name, ok, value) => { if (tr) tr.push({ name, ok: !!ok, value: value === undefined ? null : value }); };
  const { i, m, day, S, px, A, sig, pr } = x;
  const window = isV11 ? (m >= o.firstOpenMin && m <= o.v11Cutoff) : (m >= o.firstOpenMin && m <= o.v10Cutoff);
  g('window', window, `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')} (opens ${hhmm(o.firstOpenMin)}-${hhmm(isV11 ? o.v11Cutoff : o.v10Cutoff)})`);
  if (!window) { D.windowOut++; return { idle: 'windowOut' }; }
  D.decisions++;
  g('no order working', !book.pending, book.pending ? `anchored ${book.pending.side} @ ${r2(book.pending.anchor)}` : null);
  if (book.pending) { D.pendingBusy++; return { idle: 'pendingBusy' }; }
  const { r15, r60 } = x.lines();
  const nq = A['5m'].close, basis = nq - S, c15 = A['15m'], c60 = A['60m'];
  const t15 = trendOf(nq, c15.ema, nqSlope(c15)), t60 = trendOf(nq, c60.ema, nqSlope(c60));
  const rt15 = r15 ? trendOf(S, r15.ema, r15.ema - r15.emaPrev) : 0, rt60 = r60 ? trendOf(S, r60.ema, r60.ema - r60.emaPrev) : 0;
  const lastTouch = book.lastTouch;
  let dir = 0, T = null, Wv = o.width === 'sig' || o.width === 'mix' ? sigW(sig, incr) : o.width, Wfly = null, Tsrc = null;
  if (!isV11) {
    T = c15.ema - basis; dir = Math.sign(T - S); Tsrc = 'NQ 15m 9EMA';
    if (o.target60 && dir) { const e60 = c60.ema - basis; if (Math.sign(e60 - S) === dir && Math.sign(nqSlope(c60)) === dir) { T = e60; D.target60Used++; Tsrc = 'NQ 60m 9EMA'; } }
    if (o.gapRth60 && book.gapDay && m < 720 && r60 && dir) { if (Math.sign(r60.ema - S) === dir && Math.abs(r60.ema - S) < Math.abs(T - S)) { T = r60.ema; D.gapRth60Used++; Tsrc = 'NDX-RTH 60m 9EMA (gap morning)'; } }
    g('target', !!dir && Math.abs(T - S) >= 0.1 * sig, `${Tsrc} ${r2(T)} (NDX ${r2(S)}, ${dir > 0 ? '+' : ''}${r2(T - S)} pts = ${r2((T - S) / sig)} sigma; need >= 0.1)`);
    if (!dir || Math.abs(T - S) < 0.1 * sig) { D.noDir++; return { block: 'noDir', T, dir }; }
    g('NDX-RTH 15m/60m trend not against', !(o.rthGate && (rt15 === -dir || rt60 === -dir)), `rth15 ${rt15} rth60 ${rt60}${o.rthGate ? '' : ' (gate off)'}`);
    if (o.rthGate && (rt15 === -dir || rt60 === -dir)) { D.rthGateBlock++; return { block: 'rthGateBlock', T, dir }; }
    const fade = o.noGapFade && book.gapDay && book.opensToday === 0 && !book.pending && dir === Math.sign(book.priorClose - S);
    g('no gap fade (first open)', !fade, book.gapDay ? `gap ${r2(book.gap)} vs prior close ${r2(book.priorClose)}` : 'no gap day');
    if (fade) { D.gapFadeBlock++; return { block: 'gapFadeBlock', T, dir }; }
    if (o.width === 'mix') Wfly = 10;
  } else {
    g('NDX-RTH 15m lines', !!r15, r15 ? `mid ${r2(r15.mid)} ema ${r2(r15.ema)} band ${r2(r15.lower)}-${r2(r15.upper)}` : 'fewer than 20 completed 15m buckets');
    if (!r15) { D.noLines++; return { block: 'noLines' }; }
    const inRange = (L) => { const d = Math.abs(L - S); return d >= o.minDist * sig && d <= o.maxDist * sig; };
    if (o.v11Next === 'same') {
      T = r15.mid; dir = Math.sign(T - S); Tsrc = 'NDX-RTH 15m BB mid';
      g('target', !!dir, `${Tsrc} ${r2(T)} (NDX ${r2(S)})`);
      if (!dir) { D.noDir++; return { block: 'noDir', T, dir }; }
      g('distance in band', inRange(T), `${r2(Math.abs(T - S))} pts = ${r2(Math.abs(T - S) / sig)} sigma (band ${o.minDist}-${o.maxDist})`);
      if (!inRange(T)) { D.distOut++; return { block: 'distOut', T, dir }; }
      const ok = o.trendBoth ? (t15 === dir && t60 === dir) : t15 === dir;
      g(o.trendBoth ? 'NQ 15m AND 60m trends point to it' : 'NQ 15m trend points to it', ok, `NQ15 ${t15} NQ60 ${t60}, target dir ${dir}`);
      if (!ok) { D.trendFail++; return { block: 'trendFail', T, dir }; }
    } else {
      if (o.v11Next === 'ladder') dir = o.trendBoth ? (t15 !== 0 && t15 === t60 ? t15 : 0) : t15;
      else { dir = t15; if (dir && (rt15 === -dir || rt60 === -dir)) { g('trend', false, `NQ15 ${t15}, rth15 ${rt15} rth60 ${rt60}`); D.trendFail++; return { block: 'trendFail', dir }; } }
      g('trend', !!dir, `NQ15 ${t15} NQ60 ${t60}`);
      if (!dir) { D.trendFail++; return { block: 'trendFail' }; }
      const lines = [r15.mid, r15.ema, r15.upper, r15.lower];
      if (r60) lines.push(r60.ema, r60.mid);
      if (book.priorClose != null) lines.push(book.priorClose);
      const lt = lastTouch[dir === 1 ? 'bull' : 'bear'];
      let best = null;
      for (const L of lines) {
        if (L == null || Math.sign(L - S) !== dir || !inRange(L)) continue;
        if (lt && (L - lt.level) * dir <= incr / 2) continue;   // after a touch: the next line BEYOND the touched one
        if (best == null || Math.abs(L - S) < Math.abs(best - S)) best = L;
      }
      g('line in band', best != null, best != null ? `ladder line ${r2(best)}` : 'no line in the distance band');
      if (best == null) { D.distOut++; return { block: 'distOut', dir }; }
      T = best; D.ladderTargets++; Tsrc = 'ladder line';
    }
    const fade = o.noGapFade && book.gapDay && m < 720 && book.priorClose != null && dir === Math.sign(book.priorClose - S);
    g('no gap fade (before 12:00)', !fade, book.gapDay ? `gap ${r2(book.gap)} vs prior close ${r2(book.priorClose)}` : 'no gap day');
    if (fade) { D.gapFadeBlock++; return { block: 'gapFadeBlock', T, dir }; }
    const sideK = dir === 1 ? 'bull' : 'bear';
    const reent = !!(lastTouch[sideK] && i < lastTouch[sideK].i + o.reentryBars);
    g('re-entry wait', !reent, lastTouch[sideK] ? `last ${sideK} touch at ${r2(lastTouch[sideK].level)}` : null);
    if (reent) { D.reentryBlock++; return { block: 'reentryBlock', T, dir }; }
    if (o.width === 'mix') Wv = Math.abs(T - S) < 0.5 * sig ? 10 : sigW(sig, incr);
  }
  const side = dir === 1 ? 'bull' : 'bear';
  // COVER TO OPEN (+ wait), as rostered on v6-v8: an open decision on a side holding an UNDERWATER uncovered
  // position sends that position's cover to the give-up path (+$0) and skips this open.
  const c2oFired = [];
  if (o.coverToOpen) {
    let under = false;
    for (const p of book.positions) {
      if (p.kind !== 'vert' || p.covered || p.side !== side || !p.cover || !p.cc.coverToOpen) continue;
      const mk = pr.now(p.legs);
      if (mk == null || mk >= p.limit) continue;
      under = true;
      if (p._c2o == null) { p._c2o = p.cc.coverToOpenExtra != null ? p.cc.coverToOpenExtra : 0; D.c2oFires++; c2oFired.push(p); }
    }
    const wait = under && book.positions.some((p) => { if (p.kind !== 'vert' || p.side !== side || p.covered || !p.cc.coverToOpenWait) return false; const mk = pr.now(p.legs); return mk != null && mk < p.limit; });
    g('no underwater same-side position (cover to open)', !wait, under ? `${c2oFired.length} cover(s) sent to give-up` : null);
    if (wait) { D.c2oWait++; return { block: 'c2oWait', T, dir, c2o: c2oFired }; }
  }
  // stacks: uncovered same-side verticals (filled; nothing is pending here)
  const nUnc = book.positions.filter((p) => p.kind === 'vert' && !p.covered && p.side === side).length;
  g('stack room', nUnc < o.maxStack, `${nUnc} uncovered ${side} (max ${o.maxStack})`);
  if (nUnc >= o.maxStack) { D.stackFull++; return { block: 'stackFull', T, dir, c2o: c2oFired }; }
  const b15 = `${day}|${Math.floor((m - 5 - 570) / 15)}`;
  if (nUnc >= 1) {
    const agree = (rt15 === dir) || (rt60 === dir), against = (rt15 === -dir) || (rt60 === -dir);
    g('add: NDX-RTH trend agrees', agree && !against, `rth15 ${rt15} rth60 ${rt60}`);
    if (!agree || against) { D.stackNoAgree++; return { block: 'stackNoAgree', T, dir, c2o: c2oFired }; }
    g('add: one per 15m', book.last15Open[side] !== b15, null);
    if (book.last15Open[side] === b15) { D.stack15mBlock++; return { block: 'stack15mBlock', T, dir, c2o: c2oFired }; }
  }
  // chase filter: NQ price inside the last completed NQ 15m candle
  if (o.chase) { const rng = c15.high - c15.low; if (rng > 0) { const fr = (nq - c15.low) / rng; const chased = (dir === 1 && fr >= 1 - o.chaseFrac) || (dir === -1 && fr <= o.chaseFrac);
    g('not chasing (NQ inside its last 15m range)', !chased, `${r2(fr * 100)}% of the 15m range`);
    if (chased) { D.chaseBlock++; return { block: 'chaseBlock', T, dir, c2o: c2oFired }; } } }
  // strikes
  let short;
  if (!isV11) short = dir === 1 ? Math.ceil(S / incr - 1e-9) * incr : Math.floor(S / incr + 1e-9) * incr;
  else {
    short = Math.round((S + o.f * (T - S)) / incr) * incr;
    if (dir === 1 && short > T) short = Math.floor(T / incr) * incr;
    if (dir === -1 && short < T) short = Math.ceil(T / incr) * incr;
  }
  const far = o.farOtmBan && (short - S) * dir >= 0.8 * sig;
  g('short not far OTM', !far, `short ${short}, ${r2((short - S) * dir)} pts OTM (ban at ${r2(0.8 * sig)})`);
  if (far) { D.farOtm++; return { block: 'farOtm', T, dir, c2o: c2oFired }; }
  const W = Wv, legs = vertLegs(side, short, W);
  // entry level
  const mid = (px.high + px.low) / 2;
  const anchor = o.entry === 'anchor' ? (dir === 1 ? Math.min(mid, S) : Math.max(mid, S)) : S;
  const vMark = pr.at(legs, anchor);
  const geoOk = vMark != null && vMark > 0 && !(vMark > capFracFor(o, W) * W);
  g('price within capFrac', geoOk, vMark == null ? 'unquoted' : `${r2(vMark)} at ${r2(anchor)} (ceiling ${r2(capFracFor(o, W) * W)})`);
  if (!geoOk) { D.geoDecline++; return { block: 'geoDecline', T, dir, c2o: c2oFired }; }
  const items = [{ kind: 'vert', legs, limit: Math.max(TICK, ceilTick(vMark)), W, shortStrike: short, target: T }];
  if (!isV11 && o.fly && Math.abs(T - S) <= 0.5 * sig) {
    const Wf = Wfly || W, K = Math.round(T / incr) * incr, fk = `${K}|${Wf}`;
    if (!book.fliesDone.includes(fk) && !(o.farOtmBan && Math.abs(K - S) >= 0.8 * sig)) {
      const fl = flyLegs(K, Wf, S), fm = pr.flyAt(fl, anchor, K);
      if (fm != null && fm > 0 && fm <= capFracFor(o, Wf) * Wf) { items.push({ kind: 'fly', legs: fl, limit: Math.max(TICK, ceilTick(fm)), W: Wf, shortStrike: K, target: null }); }
      else D.flyBlocked++;
    }
  }
  // cap (governor semantics: the new order counted as filled) — vertical first, fly only if it also fits
  const extras = items.map((it) => ({ legs: it.legs, limit: it.limit, covered: false }));
  const fV = floorOfList(bookList(book, true, extras.slice(0, 1)), incr);
  g('book floor within the cap', !(-fV > capFor(o, W)), `floor with it ${Math.round(fV)} (cap ${capFor(o, W) === Infinity ? 'none' : -capFor(o, W)})`);
  if (-fV > capFor(o, W)) { D.capBlock++; return { block: 'capBlock', T, dir, c2o: c2oFired }; }
  if (extras.length > 1 && -floorOfList(bookList(book, true, extras), incr) > capFor(o, W)) { items.pop(); extras.pop(); D.flyBlocked++; }
  if (o.bookReject) {
    const L = bookList(book, true, extras), pay = payoffOf(L);
    const atS = pay(S);
    g('book not losing at spot', !(atS < 0), Math.round(atS));
    if (atS < 0) { D.bookRejectSpot++; return { block: 'bookRejectSpot', T, dir, c2o: c2oFired }; }
    const pl = probLoss(pay, S, sig);
    g('P(book loses) <= 50%', !(pl > 0.5), r2(pl * 100) + '%');
    if (pl > 0.5) { D.bookRejectP++; return { block: 'bookRejectP', T, dir, c2o: c2oFired }; }
  }
  for (const it of items) if (it.kind === 'fly') { book.fliesDone.push(`${it.shortStrike}|${it.W}`); D.flyPlaced++; }
  D.placed++; book.last15Open[side] = b15;
  return { place: { side, mode: o.entry === 'anchor' ? 'anchor' : 'market', items, anchor, T, Tsrc, short, W, dir, vMark }, c2o: c2oFired };
}
const r2 = (x) => (x == null || !Number.isFinite(x) ? x : Math.round(x * 100) / 100);
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

module.exports = {
  // config
  DEFAULTS, CAP_BY_W, CAPFRAC_BY_W, DEFAULT_COVER, COVER_KEYS, COUNTERS, nearestFixed, configOf, capFor, capFracFor, cfgFor, coverCfgFromOpts,
  // pricing / time
  TICK, QTY, round2, roundTick, ceilTick, floorTick, etMin, etIso, etStamp, pricingModel, modelPricer, legsMark, legsPayoff,
  // pure helpers
  trendOf, nqSlope, probLoss, vertLegs, flyLegs, sigW,
  // book
  newBook, bookList, payoffOf, floorOfList, floorNow, posPnlAt, noteDay, noteGap,
  // opens / touches
  bookOpen, noteOpenCounters, fillPending, expirePending, reachesT, noteTouch,
  // covers
  legsAtK, kOf, rangeOf, guKOf, pickK, placeCover, coverStep, touchCoverPrice, bookCover, rangeRestrike,
  // the open decision
  decide,
};
