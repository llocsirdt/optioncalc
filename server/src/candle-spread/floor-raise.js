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

// Sample points. The BAND [lo, hi] is where valleys are targeted and candidates are built; `bookStrikes`
// (optional) extends the SCORING grid to one strike past the book's outermost strikes, so a valley's outward
// region runs to the true tail of the curve rather than stopping at the band edge (an offset spread lifts the
// whole tail; a fly does not — the difference only shows if the tail is measured).
function samplePoints(spot, band, incr, bookStrikes) {
  const lo = Math.floor((spot - band) / incr) * incr, hi = Math.ceil((spot + band) / incr) * incr;
  let a = lo, b = hi;
  if (bookStrikes && bookStrikes.length) {
    a = Math.min(lo, Math.floor(Math.min(...bookStrikes) / incr) * incr - incr);
    b = Math.max(hi, Math.ceil(Math.max(...bookStrikes) / incr) * incr + incr);
  }
  const xs = [];
  for (let x = a; x <= b; x += incr) xs.push(x);
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
// DISTANCE-SCALED RATIO (the user, 2026-10-06): the further from the money a fix lands, the less likely that
// range comes into play, so the more reward per dollar it must offer. Required ratio at a valley =
// minRatio + (minRatioFar - minRatio) x min(1, distance / farSigmas), distance = |spot - nearest point of the
// valley| in units of ONE expected remaining move (sigmaPts). minRatioFar unset = flat minRatio everywhere.
function requiredRatio(minRatio, minRatioFar, farSigmas, dist, sigmaPts) {
  if (minRatioFar == null || !(sigmaPts > 0)) return minRatio;
  const f = Math.min(1, dist / sigmaPts / (farSigmas || 2));
  return minRatio + (minRatioFar - minRatio) * f;
}

// liftMetric (valley objective):
//   'avg' (default, the user's preference 2026-10-06) — the RATIO is the AVERAGE lift across the valley's points
//         per dollar: a fly is credited for most of what it pays where the valley is, not only its weakest edge
//         (the 31060/31080/31100 fly on the 2026-10-05 31070-31090 valley: avg 3.4:1 vs 2.3:1 on the edge).
//         The fix must STILL raise the lowest point of the valley's outward region — that keeps far valleys on
//         offset spreads (a fly there leaves the tail beyond it low) — but the ratio is judged on the average.
//   'min' — the conservative original: the ratio is the lift of that lowest point.
function pickBest({ xs, base, cands, price, qty, minRatio, budget, gNow, globalFloorWith, skip, objective, spot, bandLo, bandHi,
  minRatioFar, farSigmas, sigmaPts, liftMetric, floorMin }) {
  const avgMetric = (liftMetric || 'avg') === 'avg';
  // The 'band' objective keeps its original meaning: the lowest point INSIDE the band.
  const bandIdx = xs.map((x, j) => j).filter((j) => (bandLo == null || xs[j] >= bandLo) && (bandHi == null || xs[j] <= bandHi));
  const floorB = Math.min(...bandIdx.map((j) => base[j]));
  const byValley = (objective || 'valley') === 'valley';
  // EACH VALLEY IS SCORED ON ITS OUTWARD REGION (the user, 2026-10-06): from the valley to the edge of the
  // band on the side AWAY from the money. A fly lifts only its own neighbourhood and leaves the lower ground
  // beyond it; an offset spread lifts the valley AND everything past it. Scoring the valley alone could not
  // tell them apart. With the outward region:
  //   - a far valley prefers an offset spread (a fly there leaves the tail beyond it low);
  //   - a near valley's region contains the far valleys, so it only gets its fly once the far side has been
  //     lifted — offsets for the outer valleys first, flies for the near ones, without hard-coding an order.
  // A valley straddling spot (or with no spot given) is scored on itself.
  // Valleys are TARGETED only where they touch the band; the outward region is scored across the whole grid.
  const inBand = (v) => (bandLo == null || xs[v.b] >= bandLo) && (bandHi == null || xs[v.a] <= bandHi);
  const vs = byValley ? valleys(base).filter(inBand).map((v) => {
    if (spot == null) return { ...v, ra: v.a, rb: v.b };
    if (xs[v.b] < spot) return { ...v, ra: 0, rb: v.b };                       // below the money: down to the edge
    if (xs[v.a] > spot) return { ...v, ra: v.a, rb: xs.length - 1 };           // above the money: up to the edge
    return { ...v, ra: v.a, rb: v.b };
  }) : null;
  // NEGATIVE VALLEYS FIRST, STRICTLY: while any targeted valley is below zero, valleys already at or above zero
  // are not fixed — spending to polish ground that is already positive while a deeper hole stays (and gets
  // deeper by the premium) is backwards. Once every valley is >= 0 the pass may lock in more profit.
  // (2026-10-06 replay, distance-scaled ratio: the near fly fell short of its ratio and the planner bought the
  // far offset a SECOND time on a valley already at +\$115, sinking the floor from -885 to -990.)
  if (vs && vs.some((v) => v.min < 0)) for (let i = vs.length - 1; i >= 0; i--) if (vs[i].min >= 0) vs.splice(i, 1);
  const regionMin = (v) => { let m = Infinity; for (let j = v.ra; j <= v.rb; j++) if (base[j] < m) m = base[j]; return m; };
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
        for (let j = v.ra; j <= v.rb; j++) { const val = base[j] + pay[j] - cost; if (val < after) after = val; }
        const minLift = after - regionMin(v);
        if (!(minLift > 0)) continue;                       // must raise the low point of its outward region
        let lift = minLift;
        if (avgMetric) {                                    // ratio judged on the AVERAGE lift across the valley
          let sum = 0; for (let j = v.a; j <= v.b; j++) sum += pay[j] - cost;
          lift = sum / (v.b - v.a + 1);
          if (!(lift > 0)) continue;
        }
        const ratio = lift / cost;
        const dist = spot == null ? 0 : (xs[v.b] < spot ? spot - xs[v.b] : xs[v.a] > spot ? xs[v.a] - spot : 0);
        const need = requiredRatio(minRatio, minRatioFar, farSigmas, dist, sigmaPts);
        if (ratio >= need) ok.push({ ...c, ...pr, cost, lift, ratio, valley: { from: xs[v.a], to: xs[v.b], min: Math.round(v.min) }, need: Math.round(need * 100) / 100, _vmin: v.min });
      }
    } else {
      let after = Infinity;
      for (const j of bandIdx) { const v = base[j] + payoff(c.legs, xs[j], qty) - cost; if (v < after) after = v; }
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
    // Two hard rules on the GLOBAL floor: never put a locked profit at risk (the user's rule), and never push
    // the book past the day-loss cap (floorMin = -lossMax) — a floor-raising hedge is still an order the
    // governor bounds. Spreads-first fixes one valley at a time and its premium lowers the rest of the curve;
    // without this a v7-10 day ended at -1,870 against a 1,500 cap (open-ladder test, 2026-10-06).
    const g = (gNow >= 0 || floorMin != null) ? globalFloorWith(c.legs, c.debit) : null;
    if (gNow >= 0 && g < 0) { blockedLocked++; continue; }
    if (floorMin != null && g < floorMin && g < gNow) { blockedLocked++; continue; }
    return { best: c, blockedLocked };
  }
  return { best: null, blockedLocked };
}

// MULTI-STEP OBJECTIVES (the user, 2026-10-06: "it's usually not a single hedge that achieves the desired
// result"). Layered on pickBest so the measured objectives stay byte-identical.
//   'spreadFirst' (B) — verticals and single longs may fix a valley on their own (valley objective, scored on
//                       the valley's OUTWARD region's lowest point — they lift the tail beyond it); only when
//                       none qualifies may anything (flies included) be bought, and then only if it raises the
//                       band's lowest point ('band'). A fly can never be bought while it sinks the rest of the
//                       curve; once an offset has lifted an outer valley, the near one becomes the lowest point
//                       and its fly qualifies on the band rule.
//   'pair'        (C) — the band rule over singles AND two-structure combinations (an offset/long + a fly, or two
//                       of either), scored TOGETHER: the combined band-floor lift per combined dollar. Judges the
//                       joint effect honestly — a sequence can clear a ratio step by step that the pair does not.
// Returns { best, companion?, blockedLocked }; a companion is a second structure to place alongside best.
function pickBestMulti(args) {
  const obj = args.objective || 'valley';
  if (obj === 'spreadFirst') {
    const spreads = args.cands.filter((c) => c.kind !== 'fly');
    const r1 = pickBest({ ...args, cands: spreads, objective: 'valley', liftMetric: 'min' });
    if (r1.best) return r1;
    const r2 = pickBest({ ...args, objective: 'band' });
    return { best: r2.best, blockedLocked: r1.blockedLocked + r2.blockedLocked };
  }
  if (obj !== 'pair') return pickBest(args);
  const { xs, base, cands, price, qty, minRatio, budget, gNow, globalFloorWith, skip, bandLo, bandHi } = args;
  const bandIdx = xs.map((x, j) => j).filter((j) => (bandLo == null || xs[j] >= bandLo) && (bandHi == null || xs[j] <= bandHi));
  const floorB = Math.min(...bandIdx.map((j) => base[j]));
  // Price + payoff every candidate once; keep the ones that lift SOME low point (pay > cost where the band is
  // at its floor or within one premium of it), best 12 of each family by that lift per dollar.
  const priced = [];
  for (const c of cands) {
    if (skip && skip(c.legs)) continue;
    const pr = price(c.legs);
    if (!pr || !(pr.debit > 0)) continue;
    const cost = pr.debit * 100 * (qty || 1);
    if (cost > budget) continue;
    const pay = xs.map((x) => payoff(c.legs, x, qty));
    let best = -Infinity;
    for (const j of bandIdx) if (base[j] <= floorB + cost) best = Math.max(best, pay[j] - cost);
    if (best > 0) priced.push({ ...c, ...pr, cost, pay, score: best / cost });
  }
  const top = (fly) => priced.filter((c) => (c.kind === 'fly') === fly).sort((a, b) => b.score - a.score).slice(0, 12);
  const pool = top(false).concat(top(true));
  const options = [];
  const evalSet = (set) => {
    const cost = set.reduce((t, c) => t + c.cost, 0);
    if (cost > budget) return;
    let after = Infinity;
    for (const j of bandIdx) { let v = base[j] - cost; for (const c of set) v += c.pay[j]; if (v < after) after = v; }
    const lift = after - floorB;
    if (!(lift > 0)) return;
    const ratio = lift / cost;
    if (ratio >= minRatio) options.push({ set, cost, lift, ratio });
  };
  for (const c of pool) evalSet([c]);
  for (let i = 0; i < pool.length; i++) for (let k = i + 1; k < pool.length; k++) evalSet([pool[i], pool[k]]);
  options.sort((a, b) => b.ratio - a.ratio || a.set.length - b.set.length);
  let blockedLocked = 0;
  for (const o of options) {
    if (gNow >= 0 || args.floorMin != null) {
      const legs = o.set.reduce((l, c) => l.concat(c.legs), []);
      const g = globalFloorWith(legs, o.set.reduce((t, c) => t + c.debit, 0));
      if ((gNow >= 0 && g < 0) || (args.floorMin != null && g < args.floorMin && g < gNow)) { blockedLocked++; continue; }
    }
    const strip = ({ pay, score, ...c }) => c;
    // Report the pair's JOINT lift/ratio on both members (the honest number); cost stays per structure.
    const best = { ...strip(o.set[0]), lift: o.lift, ratio: o.ratio, pairCost: o.cost };
    const companion = o.set[1] ? { ...strip(o.set[1]), lift: o.lift, ratio: o.ratio, pairCost: o.cost } : null;
    return { best, companion, blockedLocked };
  }
  return { best: null, blockedLocked };
}

module.exports = { samplePoints, candidates, payoff, valleys, requiredRatio, pickBest, pickBestMulti };
