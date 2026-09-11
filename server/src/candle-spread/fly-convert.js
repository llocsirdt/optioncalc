'use strict';
/**
 * FLY CONVERSION — lift a VALLEY, early in the session.
 *
 * WHY THIS IS NOT wing-convert or floorOffset. Both of those only BUY: a cheap OTM debit spread lifts a
 * declining wing (wingConvert) or negates a reachable loss (floorOffset). Because they only buy, they
 * need OTM premium to be CHEAP, which means they have little potential until late in the day. A butterfly
 * SELLS THE BODY to fund its wings, so its net cost stays small even when premium is rich — which is
 * exactly why it covers the half of the session the other two cannot.
 *
 * VALIDATED BEFORE BUILDING (2026-09-10, validate-fly-pricing.js, 231 real chain snapshots):
 *   fly 30 ($3,000 lift):  $175 (17:1) at 09:30 -> $280 (10.7:1) at 12:00 -> $720 (4.2:1) at 15:00
 *   fly 40 ($4,000 lift):  $305 (13:1)          -> $535  (7.5:1)          -> $1,245 (3.2:1)
 *   condor 20/40 ($2,000): $245 (8.2:1)         -> $375  (5.3:1)          -> $925  (2.2:1)
 * Cost rises MONOTONICALLY all session (30-wide 4x from open to close), so this is an early/mid-day tool
 * by its own economics. Flies beat condors everywhere; the 20/40 condor drops below 1:1 after 15:00,
 * i.e. you would pay more than it can ever return. Wider is better early, narrower holds up later.
 *
 * WHY IT MATTERS BEYOND ITS OWN P&L. The 2026-09-10 stop-opening sweep blocked late opens two different
 * ways (time cutoff, positive-floor gate) and lost total AND ret/DD in all 42 arms — so the late opens
 * that erode the floor are net-POSITIVE on average, and "stop trading" is the wrong answer to the
 * give-back. Repairing the curve while continuing to trade is the remaining candidate. This is that.
 *
 * PLACEMENT IS THE NEW LOGIC. planWings anchors on the KNEE (where the peak's decline flattens) because a
 * wing lifts a declining tail. A fly lifts a VALLEY — a local minimum BETWEEN two peaks — which is a
 * different feature of the curve and the reason this is not just a new candidate set inside wing-convert.
 *
 * Pure + isomorphic: the pricer is injected (BS in backtest, real chain quotes live).
 */
const RC = require('./risk-curve');

const r2 = (n) => Math.round(n * 100) / 100;

/**
 * VALLEYS of the terminal curve: local minima with a higher point on BOTH sides. That two-sided test is
 * what distinguishes a valley from the declining tail a wing handles — a tail keeps falling to the edge,
 * a valley comes back up. Returns them deepest-first, each with the peaks that bracket it, because the
 * lift available is bounded by how far the valley sits below its shoulders.
 */
function findValleys(curve, opts) {
  const o = opts || {};
  const minDrop = o.minDrop != null ? o.minDrop : 0;   // ignore ripples shallower than this
  const out = [];
  for (let i = 1; i < curve.length - 1; i++) {
    const [x, y] = curve[i];
    if (!(y <= curve[i - 1][1] && y <= curve[i + 1][1])) continue;
    // walk out to the bracketing local maxima
    let l = i, r = i;
    while (l > 0 && curve[l - 1][1] >= curve[l][1]) l--;
    while (r < curve.length - 1 && curve[r + 1][1] >= curve[r][1]) r++;
    if (l === 0 && r === curve.length - 1) continue;          // monotone — not a valley
    const shoulder = Math.min(curve[l][1], curve[r][1]);
    const drop = shoulder - y;
    if (drop <= minDrop) continue;
    out.push({ price: x, pnl: y, drop, leftPeak: curve[l][0], rightPeak: curve[r][0] });
  }
  // de-duplicate flat bottoms: keep the deepest per bracketing pair
  const seen = new Map();
  for (const v of out) {
    const k = `${v.leftPeak}|${v.rightPeak}`;
    if (!seen.has(k) || v.pnl < seen.get(k).pnl) seen.set(k, v);
  }
  return [...seen.values()].sort((a, b) => a.pnl - b.pnl);
}

/**
 * Candidate structures centred on a body strike.
 *   BUTTERFLY  long K-W, short 2x K, long K+W   — a POINT of lift, max W*100 at K, zero outside the wings
 *   CONDOR     long K-o, short K-i, short K+i, long K+o — a PLATEAU: less lift per unit, but across a band
 * Both are built on one option type; by put-call parity the two are equivalent, so both are generated and
 * the pricer decides which quotes better.
 */
function candidateFlies(bodyStrike, incr, opts) {
  const o = opts || {};
  const widths = o.widths || [2 * incr, 3 * incr, 4 * incr];
  const out = [];
  const K = Math.round(bodyStrike / incr) * incr;
  for (const type of (o.types || ['C', 'P'])) {
    for (const W of widths) {
      out.push({ kind: 'fly', type, body: K, width: W, maxLift: W,
        tag: `${type} fly ${K - W}/${K}x2/${K + W}`,
        legs: [
          { side: 'long', type, strike: K - W },
          { side: 'short', type, strike: K },
          { side: 'short', type, strike: K },
          { side: 'long', type, strike: K + W },
        ] });
    }
    if (o.condors !== false) {
      for (const W of widths) {
        const inner = W, outer = W * 2;
        out.push({ kind: 'condor', type, body: K, width: outer - inner, maxLift: outer - inner,
          tag: `${type} condor ${K - outer}/${K - inner}/${K + inner}/${K + outer}`,
          legs: [
            { side: 'long', type, strike: K - outer },
            { side: 'short', type, strike: K - inner },
            { side: 'short', type, strike: K + inner },
            { side: 'long', type, strike: K + outer },
          ] });
      }
    }
  }
  return out;
}

/** Net debit of a leg-set from an injected pricer. `price(type, strike, legSide)` returns the marketable
 *  price for that leg. A fly should come out POSITIVE (a net debit) — a negative cost is an arbitrage and
 *  means the quotes are stale or crossed, so the caller must reject it rather than bank free money. */
function flyCost(legs, price) {
  let d = 0;
  for (const l of legs) {
    const p = price(l.type, l.strike, l.side);
    if (p == null || !Number.isFinite(p)) return null;
    d += (l.side === 'long' ? 1 : -1) * p;
  }
  return r2(d);
}

/**
 * Plan a set of flies/condors. Greedy, scored on the improvement in the WORST outcome inside the REACHABLE
 * band — the same objective planWings uses, so the two tools are directly comparable and a shared budget
 * means something. Candidates are generated at the VALLEYS rather than across a grid: that is where the
 * lift is, and it keeps the candidate set small enough to price against real quotes every bar.
 *
 *   opts: { spot, band, incr, price, qty, budget, maxFlies, minRatio, step, widths, condors, types }
 * Returns { flies:[{legs,cost,tag,kind,ratio}], spent, before:{floor,reachFloor,peak}, after:{...}, valleys }
 */
function planFlies(book, opts) {
  const o = opts || {};
  const incr = o.incr || 10, qty = o.qty || 1, step = o.step || 10;
  const band = o.band, spot = o.spot;
  const budget = o.budget != null ? o.budget : Infinity;
  const maxFlies = o.maxFlies != null ? o.maxFlies : 2;
  const minRatio = o.minRatio != null ? o.minRatio : 3;
  const reach = (b) => {
    let m = Infinity;
    for (let S = spot - band; S <= spot + band; S += step) { const v = RC.bookPnl(b, S); if (v < m) m = v; }
    return m;
  };
  // SHORTFALL — the objective a fly needs, and the reason this module does not just reuse planWings'.
  //
  // planWings scores on the reachable MINIMUM, deliberately: its own comment records that per-side
  // scoring once bought two put wings and pushed the floor DOWN. That works for a wing, which lifts a
  // whole declining tail. It fails for a fly, which repairs ONE LOCALIZED VALLEY: measured on the real
  // v7-20 book at 12:00 on 2026-09-10, the band held TWO equally deep minima (-$2,935 near 29154 and
  // -$2,935 at the upper edge), so lifting either one left the other binding, the minimum did not move,
  // and every candidate scored a lift of exactly -cost. The greedy loop could never take a first step.
  //
  // Shortfall is the total dollars of downside across the band — sum of max(0, -pnl). One fly reduces it
  // even when the global minimum is pinned elsewhere, so progress is visible and the SECOND pass can go
  // after the other valley. The reachable minimum is still enforced as a hard constraint below (a fly may
  // never make the floor worse), so this buys sensitivity without giving up the guarantee planWings has.
  const shortfall = (b) => {
    let s = 0;
    for (let S = spot - band; S <= spot + band; S += step) { const v = RC.bookPnl(b, S); if (v < 0) s += -v; }
    return s;
  };
  const curve0 = RC.riskCurve(book, { step, pad: o.pad != null ? o.pad : 400 });
  if (curve0.length < 3) return null;
  const valleys0 = findValleys(curve0, { minDrop: o.minDrop });
  const before = { floor: Math.min(...curve0.map(c => c[1])), reachFloor: reach(book), peak: Math.max(...curve0.map(c => c[1])) };

  let cur = book.slice(), spent = 0;
  const flies = [];
  for (let n = 0; n < maxFlies; n++) {
    const curve = RC.riskCurve(cur, { step, pad: o.pad != null ? o.pad : 400 });
    const valleys = findValleys(curve, { minDrop: o.minDrop });
    if (!valleys.length) break;
    const r0 = reach(cur), s0 = shortfall(cur);
    let best = null;
    // Only the valleys that sit INSIDE the reachable band are worth repairing — lifting a valley the
    // underlying cannot get to by settle spends premium on an outcome that cannot happen.
    for (const v of valleys.filter(v => Math.abs(v.price - spot) <= band)) {
      for (const cand of candidateFlies(v.price, incr, { widths: o.widths, condors: o.condors, types: o.types })) {
        const cost = flyCost(cand.legs, o.price);
        if (cost == null || !(cost > 0)) continue;          // non-positive debit = stale/crossed quotes
        const dollars = cost * 100 * qty;
        if (spent + dollars > budget) continue;
        const trial = cur.concat([{ filled: true, legs: cand.legs, limit: cost, quantity: qty, fly: true }]);
        // HARD CONSTRAINT: never make the reachable floor worse. This is planWings' guarantee and it is
        // kept — the softer objective below only decides WHICH qualifying structure to take.
        if (reach(trial) < r0 - 1e-9) continue;
        const gain = s0 - shortfall(trial);   // dollars of downside removed across the band
        if (gain <= 0) continue;
        const ratio = gain / dollars;
        if (ratio < minRatio) continue;
        if (!best || ratio > best.ratio) best = { cand, cost, dollars, ratio, trial, valley: v, floorLift: reach(trial) - r0 };
      }
    }
    if (!best) break;
    cur = best.trial; spent += best.dollars;
    flies.push({ legs: best.cand.legs, cost: best.cost, tag: best.cand.tag, kind: best.cand.kind,
      body: best.cand.body, width: best.cand.width, ratio: r2(best.ratio),
      valleyAt: best.valley.price, valleyPnl: r2(best.valley.pnl), floorLift: r2(best.floorLift) });
  }
  const curve1 = RC.riskCurve(cur, { step, pad: o.pad != null ? o.pad : 400 });
  return {
    flies, spent: Math.round(spent), book: cur, valleys: valleys0,
    before: { ...before, shortfall: Math.round(shortfall(book)) },
    after: { shortfall: Math.round(shortfall(cur)), floor: Math.min(...curve1.map(c => c[1])), reachFloor: reach(cur), peak: Math.max(...curve1.map(c => c[1])) },
  };
}

module.exports = { findValleys, candidateFlies, flyCost, planFlies };
