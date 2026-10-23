'use strict';
/**
 * NATURAL COVER (v12 / v13) — the ONE implementation of every natural-cover decision, shared by the backtest engine
 * (backtest/backtest-v6-5m.js runDay5m, opts.natural) and the live trader (trader.js processCandleClose, deps.natural).
 *
 * Defined 2026-10-17 (commit ef8b80c, data/sweeps/v12-v13-2026-10-17, journal 2026-10-17): the v6 signal and opens,
 * but the book is protected by OPENS rather than per-position covers.
 *   v12  - NO per-position covers (continuous / signal / proactive / cover-to-stack all off).
 *        - ADD GATE: a same-side open while the side already holds a live position needs the last completed NQ 15m
 *          candle at its outer band (within touchTol) on the open's side; at most maxAdds adds per side.
 *        - REV (reversal-open): the other side of the book's live bias opens when ALL of
 *            touch  - an outer-band touch on the bias side: RTH (NDX) 5m band or NQ 60m band (revTouch 'rth5|nq60';
 *                     'any' = any of NQ 5/15/60 + RTH 5/15/60; 'off' = none needed)
 *            speed  - the last same-side open is at most revWindowMin old
 *            run    - the zigzag (theta 20 pt on NDX 1m closes) leg in the bias direction is >= revRun pt, or
 *                     revRun + 20 when no band/EMA line (NQ shifted by the NQ-NDX basis, or RTH) sits within lineTol
 *                     of the run's extreme
 *          hold, and the candle is not a mid/9EMA-only touch. Struck at the paired position's short (revStrike
 *          'same'; one strike cheaper/dearer if over the cap; else the variant's own placement), and the pair +
 *          REV may cost at most 1.15 W. A filled REV marks its pair OFFSET (naturally covered).
 *        - JUMP GUARD: the book's mark at spot +- X (the 15-min p95 move by time of day, scaled by IV / median IV)
 *          through -lossMax opens the protective side's best-floor vertical (inert in the 821-day backtest).
 *   v13  - v12 + the rostered continuous cover, placed only on a live (not offset, not guard) position once it is
 *          coverAfterMin old.
 *
 * Pricing is INJECTED: the backtest prices strikes with Black-Scholes, the live trader with the real chain
 * (buildOpenAtStrikes). Every rule, threshold and tie-break lives here, once.
 */

// ── config ────────────────────────────────────────────────────────────────────────────────────────────────
// natural mode of an opts / deps object: 'v12' | 'v13' | null
const modeOf = (o) => (o && (o.natural === 'v12' || o.natural === 'v13') ? o.natural : null);
// v13's cover delay in ms (null for v12 / off)
const coverAfterMsOf = (o) => (modeOf(o) === 'v13' ? (o.coverAfterMin != null ? o.coverAfterMin : 30) * 60000 : null);
// The decision constants. Same field names and defaults as the 2026-10-17 backtest block.
function configOf(o) {
  if (!modeOf(o)) return null;
  return { addGate: o.addGate !== false, maxAdds: o.maxAdds != null ? o.maxAdds : 3, revTouch: o.revTouch || 'rth5|nq60',
    revWindowMs: o.revWindowMin === false ? null : (o.revWindowMin != null ? o.revWindowMin : 30) * 60000,
    revRun: o.revRun === false ? null : (o.revRun != null ? o.revRun : 40), revStrike: o.revStrike || 'same', revMaxTotal: 1.15,
    jumpGuard: o.jumpGuard !== false, guardMult: o.guardMult != null ? o.guardMult : 1, guardFixed: o.guardFixed != null ? o.guardFixed : null,
    guardMedianIv: o.guardMedianIv, guardMaxPerDay: o.guardMaxPerDay != null ? o.guardMaxPerDay : 6, theta: 20, lineTol: 12, touchTol: 3 };
}

// ── zigzag (theta points) on the pricing series' 1m closes ──────────────────────────────────────────────────
const newZigzag = () => ({ dir: 0, hi: null, lo: null, ext: null, piv: null, last: null });
function zigzagFeed(zz, closes, theta) {
  for (const c of closes) {
    if (zz.hi == null) { zz.hi = c; zz.lo = c; continue; }
    if (zz.dir === 0) {
      if (c > zz.hi) zz.hi = c; if (c < zz.lo) zz.lo = c;
      if (zz.hi - c >= theta) { zz.dir = -1; zz.piv = zz.hi; zz.ext = c; } else if (c - zz.lo >= theta) { zz.dir = 1; zz.piv = zz.lo; zz.ext = c; }
    } else if (zz.dir === 1) {
      if (c > zz.ext) zz.ext = c; else if (zz.ext - c >= theta) { zz.last = { dir: 1, len: zz.ext - zz.piv, ext: zz.ext }; zz.dir = -1; zz.piv = zz.ext; zz.ext = c; }
    } else if (c < zz.ext) zz.ext = c; else if (c - zz.ext >= theta) { zz.last = { dir: -1, len: zz.piv - zz.ext, ext: zz.ext }; zz.dir = 1; zz.piv = zz.ext; zz.ext = c; }
  }
  return zz;
}

// ── book bias ─────────────────────────────────────────────────────────────────────────────────────────────
// live = the LIVE positions (not hedge, not covered, not offset, not a guard), each { side, openEpoch, ... }.
// Bias = the side with more live positions; on a tie, the most recent open's side (a later one wins an equal epoch).
const latestOf = (arr) => arr.reduce((a, p) => (p.openEpoch >= a.openEpoch ? p : a));
function biasOf(live) {
  const nB = live.filter((p) => p.side === 'bull').length, nR = live.length - nB;
  let bias = nB > nR ? 'bull' : nR > nB ? 'bear' : null;
  if (!bias && live.length) bias = latestOf(live).side;
  return { bias, nBull: nB, nBear: nR };
}
// Outer-band touch of a completed candle on direction d (+1 upper, -1 lower). NQ candles carry bbupper/bblower,
// RTH line objects (makeRthLines) carry upper/lower; tol = NC.touchTol.
const outerNq = (c, d, tol) => !!(c && c.bbupper != null && (d > 0 ? c.high >= c.bbupper - tol : c.low <= c.bblower + tol));
const outerRth = (r, d, tol) => !!(r && r.upper != null && (d > 0 ? r.high >= r.upper - tol : r.low <= r.lower + tol));

// ── REV check ─────────────────────────────────────────────────────────────────────────────────────────────
// One bar's reversal-open read. Inputs: NC, live positions, A (NQ multi-TF; '5m','15m','60m'), S (NDX close),
// c5Close (NQ 5m close, for the NQ-NDX basis), r5/r15/r60 (RTH lines or null), zz (zigzag state), nowEpoch,
// revWorking (a REV order is already working -> no evaluation).
// Returns every condition and value (the audit record) and `fire` (all hold, not mid-only) with the pair.
function revCheck(NC, x) {
  const { live, A, S, c5Close, r5, r15, r60, zz, nowEpoch, revWorking } = x;
  const b = biasOf(live);
  const out = { bias: b.bias, nBull: b.nBull, nBear: b.nBear, evaluated: false, fire: false };
  if (!b.bias) { out.why = 'flat'; return out; }
  if (revWorking) { out.why = 'rev-working'; return out; }
  out.evaluated = true;
  const bias = b.bias, d = bias === 'bull' ? 1 : -1, tol = NC.touchTol;
  out.revSide = bias === 'bull' ? 'bear' : 'bull';
  const tRth5 = outerRth(r5, d, tol), tNq60 = outerNq(A['60m'], d, tol);
  const tNq5 = outerNq(A['5m'], d, tol), tNq15 = outerNq(A['15m'], d, tol), tRth15 = outerRth(r15, d, tol), tRth60 = outerRth(r60, d, tol);
  const anyOuter = tRth5 || tNq60 || tNq5 || tNq15 || tRth15 || tRth60;
  const touchOk = NC.revTouch === 'off' ? true : NC.revTouch === 'any' ? anyOuter : (tRth5 || tNq60);
  const inR = (lo, hi, v) => v != null && lo <= v && v <= hi;
  const midOnly = !anyOuter && ((r5 && (inR(r5.low, r5.high, r5.mid) || inR(r5.low, r5.high, r5.ema)))
    || inR(A['5m'].low, A['5m'].high, A['5m'].bbmiddle) || inR(A['5m'].low, A['5m'].high, A['5m'].ema));
  const lastSame = Math.max(...live.filter((p) => p.side === bias).map((p) => p.openEpoch));
  const winOk = NC.revWindowMs == null || nowEpoch - lastSame <= NC.revWindowMs;
  let runOk = true, run = null, ext = null, need = null, lineNear = null;
  if (NC.revRun != null) {
    run = 0;
    if (zz.dir === d) { run = Math.abs(zz.ext - zz.piv); ext = zz.ext; } else if (zz.last && zz.last.dir === d) { run = zz.last.len; ext = zz.last.ext; }
    if (ext == null) runOk = false;
    else {
      const basis = c5Close - S, lines = [];
      for (const tf of ['5m', '15m', '60m']) for (const k of ['bbupper', 'bbmiddle', 'bblower', 'ema']) if (A[tf][k] != null) lines.push(A[tf][k] - basis);
      for (const r of [r5, r15, r60]) if (r) for (const k of ['upper', 'mid', 'lower', 'ema']) if (r[k] != null) lines.push(r[k]);
      lineNear = lines.some((L) => Math.abs(L - ext) <= NC.lineTol);
      need = lineNear ? NC.revRun : NC.revRun + 20;
      runOk = run >= need;
    }
  }
  Object.assign(out, { touch: { rth5: tRth5, nq60: tNq60, nq5: tNq5, nq15: tNq15, rth15: tRth15, rth60: tRth60, mode: NC.revTouch },
    touchOk, midOnly, lastSameEpoch: lastSame, ageMin: Math.round((nowEpoch - lastSame) / 60000 * 10) / 10,
    windowMin: NC.revWindowMs == null ? null : NC.revWindowMs / 60000, winOk, run: run != null ? Math.round(run * 100) / 100 : null,
    runExt: ext, runNeed: need, lineNear, runOk });
  if (touchOk && winOk && runOk) {
    if (midOnly) out.why = 'mid-only';
    else { out.fire = true; out.why = 'fire'; out.pair = latestOf(live.filter((p) => p.side === bias)); }
  } else out.why = !touchOk ? 'no-touch' : !winOk ? 'too-late' : 'run-short';
  return out;
}

// ── REV strike ────────────────────────────────────────────────────────────────────────────────────────────
// The vertical of width W whose SHORT strike is K, on revSide (bull call / bear put debit).
const revLegs = (revSide, K, W) => (revSide === 'bull' ? [{ side: 'long', type: 'C', strike: K - W }, { side: 'short', type: 'C', strike: K }]
  : [{ side: 'long', type: 'P', strike: K + W }, { side: 'short', type: 'P', strike: K }]);
// Pick the REV. x: { revSide, pair {shortStrike, limit}, W, incr, capF, price(K) -> {legs, shortStrike, mark, limit} | null,
// fallback() -> {legs, shortStrike, limit} | null (the variant's own placement), and for 'curve': S, sigPts,
// curve(sigPts) -> { xs, base }, payoff(legs, x), qty }.
// 'same' = the pair's short (else one strike cheaper, then dearer, inside capF x W; else the fallback);
// 'cost' = the strike within +-4 whose pair + REV cost is closest to <= W; 'curve' = the strike within +-1 sigma that
// maximises the book's expiry floor over spot +- 1 sigma. Any pick must keep pair + REV <= 1.15 W.
// Returns { pick, sameHit, fail: null | 'no-strike' | 'total', tried: [{K, mark}] }.
function pickRevStrike(NC, x) {
  const { revSide, pair, W, incr, capF, price } = x;
  const fits = (c) => !!c && c.mark > 0 && c.mark <= capF * W + 1e-9;
  const cheaper = revSide === 'bull' ? incr : -incr, K0 = pair.shortStrike;
  const tried = [];
  const pr = (K) => { const c = price(K); tried.push({ K, mark: c && c.mark != null ? c.mark : null }); return c; };
  let pick = null, sameHit = false, via = null;
  if (NC.revStrike === 'same') {
    const c0 = pr(K0);
    if (fits(c0)) { pick = c0; sameHit = true; via = 'same'; }
    else { const c1 = pr(K0 + cheaper), c2 = pr(K0 - cheaper); pick = fits(c1) ? c1 : fits(c2) ? c2 : null; if (pick) via = pick === c1 ? 'cheaper' : 'dearer'; }
    if (!pick) { const g = x.fallback(); if (g && !g.skip && g.legs) { pick = g; via = 'placement'; } }
  } else if (NC.revStrike === 'cost') {
    let best = null;
    for (let j = -4; j <= 4; j++) { const c = pr(K0 + j * incr); if (!fits(c)) continue; const tot = pair.limit + c.limit;
      const score = tot <= W + 1e-9 ? W - tot : 1000 + tot - W; if (!best || score < best.score) best = { c, score }; }
    pick = best && best.c; if (pick) via = 'cost';
  } else {
    const { xs, base } = x.curve(x.sigPts);
    const ctr = Math.round(x.S / incr) * incr, nK = Math.max(2, Math.ceil(x.sigPts / incr));
    let best = null;
    for (let j = -nK; j <= nK; j++) {
      const c = pr(ctr + j * incr); if (!fits(c)) continue;
      let mn = Infinity; for (let q = 0; q < xs.length; q++) { const v = base[q] + (x.payoff(c.legs, xs[q]) - c.limit) * 100 * x.qty; if (v < mn) mn = v; }
      if (!best || mn > best.mn) best = { c, mn };
    }
    pick = best && best.c; if (pick) via = 'curve';
  }
  if (!pick) return { pick: null, sameHit: false, fail: 'no-strike', tried };
  if (pair.limit + pick.limit > NC.revMaxTotal * W + 1e-9) return { pick: null, sameHit: false, fail: 'total', tried, total: Math.round((pair.limit + pick.limit) * 100) / 100, via };
  return { pick, sameHit, fail: null, tried, via, total: Math.round((pair.limit + pick.limit) * 100) / 100 };
}

// ── ADD gate ──────────────────────────────────────────────────────────────────────────────────────────────
// A signal open on openSide while that side holds >= 1 live position is an ADD: it needs the NQ 15m candle at its
// outer band on that side (NC.addGate) and fewer than maxAdds earlier adds (same - 1 < maxAdds).
// Returns { kind: 'first' | 'add' | 'blocked' | 'capped', same, at15 }.
function addGate(NC, openSide, live, c15) {
  const same = live.filter((p) => p.side === openSide).length;
  if (same < 1) return { kind: 'first', same };
  const at15 = outerNq(c15, openSide === 'bull' ? 1 : -1, NC.touchTol);
  if (NC.addGate && !at15) return { kind: 'blocked', same, at15 };
  if (same - 1 >= NC.maxAdds) return { kind: 'capped', same, at15 };
  return { kind: 'add', same, at15 };
}

// ── JUMP GUARD ────────────────────────────────────────────────────────────────────────────────────────────
// X = the 15-minute p95 adverse move for this ET minute (09:30-10 150, 10-11 120, 11-14 85, 14-15 80, 15-16 85),
// x IV / median IV x guardMult; or guardFixed points. ivNow is a FUNCTION (only read when scaling).
function guardX(NC, m, ivNow) {
  const p95 = m < 600 ? 150 : m < 660 ? 120 : m < 840 ? 85 : m < 900 ? 80 : 85;
  return NC.guardFixed != null ? NC.guardFixed : p95 * (NC.guardMedianIv > 0 ? ivNow() / NC.guardMedianIv : 1) * NC.guardMult;
}
// The guard's dollar threshold: -lossMax (the spec) | guardAt 'target' = -lossTarget | a dollar number.
const guardLimit = (guardAt, lossTarget, lossMax) => (guardAt === 'target' ? lossTarget : (typeof guardAt === 'number' ? guardAt : lossMax));
// The breach read: book marks at S+X / S-X vs -gLim. side = the losing direction's protective vertical.
function guardBreach(up, dn, gLim) {
  if (!Number.isFinite(gLim) || (up >= -gLim && dn >= -gLim)) return { breach: false };
  return { breach: true, side: up < dn ? 'bull' : 'bear' };
}
// The protective vertical: every width-W vertical on `side` with a strike from one W below the jump region to one
// W above it, priced by price(legs) -> { mark, limit } | null, inside capF x W; the one whose expiry floor over the
// region (5-pt grid, book base(x) + this vertical) is highest. Returns { best, f0 } (best null = nothing raises it).
function guardPick(x) {
  const { side, S, X, W, incr, capF, base: baseAt, price, payoff, qty } = x;
  const lo = side === 'bull' ? S : S - X, hi = side === 'bull' ? S + X : S;
  const xs = []; for (let v = lo; v <= hi + 1e-9; v += 5) xs.push(v);
  const base = xs.map((v) => baseAt(v)), f0 = Math.min(...base);
  let best = null;
  for (let K = Math.floor(lo / incr) * incr - W; K <= Math.ceil(hi / incr) * incr + W; K += incr) {
    const legs = revLegs(side, K, W);
    const c = price(legs); if (!c || !(c.mark > 0) || c.mark > capF * W) continue;
    let mn = Infinity; for (let q = 0; q < xs.length; q++) { const v = base[q] + (payoff(legs, xs[q]) - c.limit) * 100 * qty; if (v < mn) mn = v; }
    if (!best || mn > best.mn) best = { legs, K, limit: c.limit, mark: c.mark, mn, priced: c };
  }
  return { best: best && best.mn > f0 ? best : null, f0, top: best };
}

// ── v13 cover delay ───────────────────────────────────────────────────────────────────────────────────────
// Why a v13 continuous cover may NOT be placed on this position yet (null = it may): an offset pair and a guard are
// never covered; a position younger than coverAfterMin waits.
function v13CoverHold(p, ageMs, coverAfterMs) {
  return p.offset ? 'offset' : p.guard ? 'guard' : ageMs < coverAfterMs ? 'young' : null;
}

// ── LIVE context (the backtest builds the same from the dataset: sweep / baselines rthCtx + bars[i].sub1m) ────
// candles = the pricing symbol's (NDX) RTH 1m candles, a few weeks deep, ascending ({ datetime, open, high, low, close });
// T = the mark (ms, the 5m candle's close). Builds the 8 prior RTH sessions + today's completed 5m bars into the SAME
// makeRthLines tracker the backtest uses, and folds today's 1m closes (09:30 .. T) into the zigzag.
function liveContext(candles, T, theta) {
  const TG = require('./backtest/backtest-target');   // lazy: backtest-target -> backtest-v6-5m -> this module
  const today = TG.etIso(T), nowMin = TG.etMin(T);
  const byDay = new Map();
  for (const c of candles || []) {
    if (!c || !(c.datetime < T)) continue;          // only candles complete by the mark (no lookahead)
    const iso = TG.etIso(c.datetime);
    if (!byDay.has(iso)) byDay.set(iso, []);
    byDay.get(iso).push(c);
  }
  const sessions = [];
  for (const [iso, cs] of byDay) { const s = TG.sessionFrom1m(iso, cs, null); if (s) sessions.push(s); }
  if (!sessions.some((s) => s.iso === today)) sessions.push({ iso: today, rth: [], close: null });   // 09:30: no bar yet, priors still apply
  const ctx = TG.buildRthContexts(sessions, 8).get(today) || { priorBars: [], priorIso: null };
  const todaySess = sessions.find((s) => s.iso === today);
  const rth = TG.makeRthLines(ctx.priorBars);
  const todayBars = todaySess ? todaySess.rth.filter((b) => b.min >= 575 && b.min <= nowMin) : [];
  for (const b of todayBars) rth.push(b);
  const zz = newZigzag();
  const closes = (byDay.get(today) || []).filter((c) => TG.etMin(c.datetime) >= 570).map((c) => c.close);
  zigzagFeed(zz, closes, theta != null ? theta : 20);
  const last = (byDay.get(today) || []).slice(-1)[0];
  return {
    day: today, min: nowMin, r5: rth.lines(5, today, nowMin), r15: rth.lines(15, today, nowMin), r60: rth.lines(60, today, nowMin), zz,
    priorSessions: sessions.filter((s) => s.iso < today).length, priorUsed: ctx.priorBars.length ? new Set(ctx.priorBars.map((b) => b.day)).size : 0,
    todayBars: todayBars.length, oneMin: closes.length, last1m: last ? last.datetime : null,
  };
}

module.exports = { modeOf, coverAfterMsOf, configOf, newZigzag, zigzagFeed, biasOf, outerNq, outerRth, revCheck, revLegs, pickRevStrike,
  addGate, guardX, guardLimit, guardBreach, guardPick, v13CoverHold, liveContext };
