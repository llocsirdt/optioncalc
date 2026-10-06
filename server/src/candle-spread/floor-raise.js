'use strict';
// FLOOR RAISE — the shared planner for the user's standing policy (2026-10-05/06): ALWAYS raise the floor
// when it is cheap to, whether it is negative or already positive, trading a little profit potential for
// a higher floor or locked-in profit. Shared by the backtest (backtest-v6-5m.js) and the live trader so the
// two plan the same structures against the same objective; only the PRICES differ (Black-Scholes with the
// skew correction there, real chain mids here).
//
// The rules, exactly as the user set them:
//   - Search everything near the money: single longs, verticals (10/20 wide) and flies (10/20 wings), puts
//     and calls, across [spot - band, spot + band] where band = sigmas x the expected remaining move.
//   - Score = NET lift of the BAND floor (the min P&L the market can plausibly reach, after paying) per
//     dollar spent. Buy the best while it clears minRatio — "risk $500 to raise the floor by at least $500"
//     is ratio 1; the 765-day sweep chose 2 (most locked-profit days, closing floor +$286 fleet-wide).
//   - NEVER TRADE A LOCKED PROFIT FOR A POSSIBLE LOSS: if the book's GLOBAL floor is >= 0, a hedge that
//     would push it below zero anywhere (outside the scored band included) is refused.
//
// Pure: callers pass the book's settlement P&L at the sample points, a structure pricer, and a global-floor
// evaluator. Payoffs are exact at settlement (piecewise-linear, kinks only at strikes).

function samplePoints(spot, band, incr) {
  const lo = Math.floor((spot - band) / incr) * incr, hi = Math.ceil((spot + band) / incr) * incr;
  const xs = [];
  for (let x = lo; x <= hi; x += incr) xs.push(x);
  return { lo, hi, xs };
}

// Every candidate structure with a strike in [lo, hi]. A fly carries its body twice (one leg per contract);
// order builders merge duplicate legs into quantity 2.
function candidates(lo, hi, incr) {
  const out = [];
  for (let K = lo; K <= hi; K += incr) for (const T of ['P', 'C']) {
    const L = (k) => ({ side: 'long', type: T, strike: k }), S = (k) => ({ side: 'short', type: T, strike: k });
    const dir = T === 'P' ? -1 : 1;   // a put spread's short leg sits BELOW its long; a call spread's above
    out.push({ kind: 'long', legs: [L(K)] });
    for (const w of [10, 20]) {
      out.push({ kind: 'vertical', legs: [L(K), S(K + dir * w)] });
      out.push({ kind: 'fly', legs: [L(K - w), S(K), S(K), L(K + w)] });
    }
  }
  return out;
}

// Settlement value of a leg set at underlying x, in dollars for `qty` contracts.
function payoff(legs, x, qty) {
  let v = 0;
  for (const l of legs) {
    const intr = l.type === 'C' ? Math.max(0, x - l.strike) : Math.max(0, l.strike - x);
    v += (l.side === 'long' ? 1 : -1) * intr;
  }
  return v * 100 * (qty || 1);
}

// VALLEYS — every local low stretch of the sampled curve: a run of points (a plateau counts as one) whose
// neighbours on both sides are higher, or that touches the edge of the band. Returns [{ a, b, min }] index
// ranges into xs. A monotone slope to the band edge is a valley at that edge (a tail is the lowest
// reachable ground on that side).
function valleys(base) {
  const out = [];
  const n = base.length;
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && Math.abs(base[j + 1] - base[i]) < 1e-9) j++;   // plateau [i, j]
    const leftHigher = i === 0 || base[i - 1] > base[i] + 1e-9;
    const rightHigher = j === n - 1 || base[j + 1] > base[i] + 1e-9;
    if (leftHigher && rightHigher) out.push({ a: i, b: j, min: base[i] });
    i = j + 1;
  }
  return out;
}

// Pick the best structure, or null.
//   objective: 'valley' (default, the user's choice 2026-10-06) — score each candidate against EACH valley:
//              NET lift of that valley's lowest point per dollar; the best valley fix that clears minRatio
//              wins. Fixing one of two equal valleys counts (the lowest-point rule could not see it).
//              'band'  — the original rule: NET lift of the lowest point of the whole band per dollar.
//   xs, base       — sample points and the book's settlement P&L at each (base[j] = book at xs[j])
//   cands          — from candidates()
//   price(legs)    — { debit } per contract (already tick-rounded, slip included) or null when unquotable
//   qty            — contracts
//   minRatio       — NET band-floor lift per dollar required
//   budget         — dollars still spendable (Infinity = no cap)
//   gNow           — the book's current GLOBAL floor
//   globalFloorWith(legs, debit) — the book's global floor if this structure were added
//   skip(legs)     — optional veto (leg-uniqueness)
function pickBest({ xs, base, cands, price, qty, minRatio, budget, gNow, globalFloorWith, skip, objective }) {
  const floorB = Math.min(...base);
  const byValley = (objective || 'valley') === 'valley';
  const vs = byValley ? valleys(base) : null;
  const ok = [];
  for (const c of cands) {
    if (skip && skip(c.legs)) continue;
    const pr = price(c.legs);
    if (!pr || !(pr.debit > 0)) continue;
    const cost = pr.debit * 100 * (qty || 1);
    if (cost > budget) continue;
    if (byValley) {
      const pay = xs.map((x) => payoff(c.legs, x, qty));
      // One entry per (candidate, valley) it fixes at the required ratio — the valley ORDER is decided below.
      for (const v of vs) {
        let after = Infinity;
        for (let j = v.a; j <= v.b; j++) { const val = base[j] + pay[j] - cost; if (val < after) after = val; }
        const lift = after - v.min;
        if (!(lift > 0)) continue;
        const ratio = lift / cost;
        if (ratio >= minRatio) ok.push({ ...c, ...pr, cost, lift, ratio, valley: { from: xs[v.a], to: xs[v.b], min: Math.round(v.min) }, _vmin: v.min });
      }
    } else {
      let after = Infinity;
      for (let j = 0; j < xs.length; j++) { const v = base[j] + payoff(c.legs, xs[j], qty) - cost; if (v < after) after = v; }
      const lift = after - floorB;
      if (!(lift > 0)) continue;
      const ratio = lift / cost;
      if (ratio >= minRatio) ok.push({ ...c, ...pr, cost, lift, ratio });
    }
  }
  // LOWEST VALLEY FIRST (valley objective): the deepest low point that has a fix at the required ratio gets
  // that fix — the best ratio among the fixes for IT — before any shallower valley is touched. Pure best-ratio
  // kept polishing a cheap far valley (a \$0.40 fly at 24:1 on a valley already at +\$150) while the deeper one
  // next to the price sat at -\$890 (2026-10-05 15:35 replay). Band objective: best ratio, as before.
  ok.sort((a, b) => (byValley ? (a._vmin - b._vmin) : 0) || (b.ratio - a.ratio));
  let blockedLocked = 0;
  for (const c of ok) {
    if (gNow >= 0 && globalFloorWith(c.legs, c.debit) < 0) { blockedLocked++; continue; }
    return { best: c, blockedLocked };
  }
  return { best: null, blockedLocked };
}

module.exports = { samplePoints, candidates, payoff, valleys, pickBest };
