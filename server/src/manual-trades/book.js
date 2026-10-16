'use strict';
/**
 * Manual-trade ORDER classification + expiry BOOK / settlement math (pure; no I/O).
 *
 * Leg convention throughout: { right:'C'|'P', strike, qty } with qty SIGNED (+ long, − short), in contracts.
 * Payoffs are in DOLLARS (× 100 multiplier). NDXP is PM-settled, so a book settles at the official NDX close.
 */

const MULT = 100;
const r2 = n => Math.round(n * 100) / 100;
const gcd = (a, b) => (b ? gcd(b, a % b) : Math.abs(a));

const intrinsic = (right, strike, S) => (right === 'C' ? Math.max(0, S - strike) : Math.max(0, strike - S));

/** Expiry value (dollars) of signed legs at underlying S. */
function payoffAt(legs, S) {
  let v = 0;
  for (const l of legs) v += l.qty * intrinsic(l.right, l.strike, S) * MULT;
  return v;
}

/** Net legs by (right, strike); zero positions removed; sorted by right then strike. */
function netLegs(legs) {
  const m = new Map();
  for (const l of legs) {
    const k = `${l.root || ''}|${l.right}|${l.strike}`;
    m.set(k, (m.get(k) || 0) + l.qty);
  }
  return [...m].filter(([, q]) => q !== 0)
    .map(([k, qty]) => { const [root, right, s] = k.split('|'); return root ? { root, right, strike: +s, qty } : { right, strike: +s, qty }; })
    .sort((a, b) => a.right.localeCompare(b.right) || a.strike - b.strike || String(a.root).localeCompare(String(b.root)));
}

/**
 * Exact piecewise-linear payoff profile: value at every strike plus both tail slopes ($ per index point).
 * Tail VALUE is reported as the value just outside the outermost strike plus the slope beyond it.
 */
function payoffProfile(legs, premiumCash = 0) {
  const L = netLegs(legs);
  if (!L.length) return { points: [], slopeBelow: 0, slopeAbove: 0, min: premiumCash, max: premiumCash, unboundedBelow: false, unboundedAbove: false };
  const ks = [...new Set(L.map(l => l.strike))].sort((a, b) => a - b);
  const points = ks.map(k => ({ S: k, value: r2(payoffAt(L, k) + premiumCash) }));
  // slope below lowest strike: only puts matter (each put contributes −qty per point as S falls... d/dS = −qty)
  const slopeBelow = -L.filter(l => l.right === 'P').reduce((a, l) => a + l.qty, 0) * MULT;
  const slopeAbove = L.filter(l => l.right === 'C').reduce((a, l) => a + l.qty, 0) * MULT;
  const vals = points.map(p => p.value);
  return {
    points, slopeBelow, slopeAbove,
    // slopeBelow is dV/dS for S < lowest strike: a positive slope means value FALLS as S falls further
    unboundedBelow: slopeBelow > 0 ? 'loss' : slopeBelow < 0 ? 'gain' : false,
    unboundedAbove: slopeAbove < 0 ? 'loss' : slopeAbove > 0 ? 'gain' : false,
    min: Math.min(...vals), max: Math.max(...vals),
  };
}

const longShort = q => (q > 0 ? 'long' : 'short');

/**
 * Classify ONE order's legs (all one expiry). `legs`: [{ right, strike, qty(signed), price }] — may contain
 * repeated (right,strike,side) rows from partial fills; they are aggregated (price = qty-weighted).
 * Returns { style, subtype, direction, debitCredit, widths, unit, ratio, center, wings, ... }.
 */
function classifyOrder(rawLegs) {
  // aggregate by right|strike|side keeping VWAP
  const agg = new Map();
  for (const l of rawLegs) {
    const k = `${l.right}|${l.strike}|${Math.sign(l.qty)}`;
    const a = agg.get(k) || { right: l.right, strike: l.strike, qty: 0, notional: 0 };
    a.qty += l.qty; a.notional += Math.abs(l.qty) * (l.price || 0);
    agg.set(k, a);
  }
  const legs = [...agg.values()].map(a => ({ right: a.right, strike: a.strike, qty: a.qty, price: r2(a.notional / Math.abs(a.qty) * 1e4) / 1e4 }))
    .sort((a, b) => a.right.localeCompare(b.right) || a.strike - b.strike || a.qty - b.qty);
  const unit = legs.reduce((g, l) => gcd(g, Math.abs(l.qty)), 0) || 1;
  const ratio = legs.map(l => l.qty / unit);
  const netPerUnit = r2(legs.reduce((s, l) => s + l.qty * l.price, 0) / unit);   // + = debit paid, per 1 unit, in index points
  const debitCredit = netPerUnit > 0 ? 'debit' : netPerUnit < 0 ? 'credit' : 'even';
  const calls = legs.filter(l => l.right === 'C'), puts = legs.filter(l => l.right === 'P');
  const out = { legs, unit, ratio, netPerUnit, debitCredit, style: 'other', subtype: null, direction: null, widths: [] };
  const oneRight = !calls.length || !puts.length;
  const same = oneRight ? legs : null;
  const R = oneRight ? legs[0].right : null;

  if (oneRight && same.length === 1) {
    const l = same[0];
    out.style = 'single'; out.subtype = `${longShort(l.qty)} ${R === 'C' ? 'call' : 'put'}`;
    out.direction = (R === 'C') === (l.qty > 0) ? 'bull' : 'bear';
    return out;
  }
  if (oneRight && same.length === 2 && same[0].qty === -same[1].qty) {
    const [lo, hi] = same;
    out.style = 'vertical';
    out.widths = [hi.strike - lo.strike];
    // calls: long the lower strike = bull (debit); puts: long the higher strike = bear (debit)
    out.direction = R === 'C' ? (lo.qty > 0 ? 'bull' : 'bear') : (hi.qty > 0 ? 'bear' : 'bull');
    out.subtype = `${R === 'C' ? 'call' : 'put'} ${out.direction === 'bull' ? (R === 'C' ? 'debit' : 'credit') : (R === 'C' ? 'credit' : 'debit')}`;
    out.longStrike = (lo.qty > 0 ? lo : hi).strike; out.shortStrike = (lo.qty > 0 ? hi : lo).strike;
    return out;
  }
  if (oneRight && same.length === 2) {
    out.style = 'ratio-spread'; out.widths = [same[1].strike - same[0].strike];
    return out;
  }
  if (oneRight && same.length === 3) {
    const [a, m, b] = ratio;
    if (Math.sign(a) === Math.sign(b) && Math.sign(m) === -Math.sign(a) && a + b === -m) {
      const w1 = same[1].strike - same[0].strike, w2 = same[2].strike - same[1].strike;
      out.widths = [w1, w2];
      out.center = same[1].strike;
      out.wings = { lower: { width: w1, qty: Math.abs(a) }, upper: { width: w2, qty: Math.abs(b) } };
      out.direction = a > 0 ? 'long' : 'short';          // long fly = long the wings, short the body (debit tent)
      if (Math.abs(a) === Math.abs(b)) {
        out.style = w1 === w2 ? 'butterfly' : 'broken-wing butterfly';
      } else {
        // a:(a+b):b ratio fly. Balanced when a·w1 == b·w2: both tails are FLAT at zero (the tent is just
        // skewed toward the side with the narrower, heavier wing) — no tail risk on either side.
        const balanced = Math.abs(a) * w1 === Math.abs(b) * w2;
        out.style = 'asymmetric butterfly';
        out.subtype = balanced ? 'balanced (zero both tails)' : 'unbalanced (tail risk)';
      }
      if (out.style !== 'butterfly') {
        // Which side is the tent SKEWED toward (peak sits nearer the narrow wing)?
        out.lean = w1 < w2 ? 'peak-low (narrow lower wing)' : w1 > w2 ? 'peak-high (narrow upper wing)' : 'centered';
      }
      return out;
    }
  }
  if (oneRight && same.length === 4) {
    const s = ratio.map(Math.sign);
    const q = ratio.map(Math.abs);
    if (q.every(x => x === q[0]) && ((s.join() === '1,-1,-1,1') || (s.join() === '-1,1,1,-1'))) {
      const w1 = same[1].strike - same[0].strike, body = same[2].strike - same[1].strike, w2 = same[3].strike - same[2].strike;
      out.style = w1 === w2 ? 'condor' : 'broken-wing condor';
      out.widths = [w1, body, w2];
      out.direction = s[0] > 0 ? 'long' : 'short';
      return out;
    }
    out.style = 'multi-vertical';
    out.widths = [same[3].strike - same[0].strike];
    return out;
  }
  if (!oneRight && calls.length === 2 && puts.length === 2 && calls[0].qty === -calls[1].qty && puts[0].qty === -puts[1].qty
      && Math.abs(calls[0].qty) === Math.abs(puts[0].qty)) {
    const [p1, p2] = puts, [c1, c2] = calls;            // ascending strikes
    // classic iron: short the inner put (p2) and inner call (c1), long the outer wings
    const shortInner = p2.qty < 0 && c1.qty < 0;
    const longInner = p2.qty > 0 && c1.qty > 0;
    if ((shortInner || longInner) && p2.strike <= c1.strike) {
      out.style = p2.strike === c1.strike ? 'iron butterfly' : 'iron condor';
      out.direction = shortInner ? 'short (credit tent)' : 'long (debit, wants a move)';
      out.widths = [p2.strike - p1.strike, c1.strike - p2.strike, c2.strike - c1.strike];
      return out;
    }
  }
  out.style = oneRight ? 'other' : 'combo';
  // legs are sorted by right THEN strike, so last − first can go negative on a call+put combo; use the span
  const ks = legs.map(l => l.strike);
  out.widths = [Math.max(...ks) - Math.min(...ks)];
  return out;
}

/**
 * Settle an expiry BOOK. `fills`: every fill for this expiry ({root?,right,strike,side,qty,gross,fees}).
 * `settle`: a number (official NDX close — NDXP is PM-settled) or { [root]: value } when the book mixes
 * PM-settled NDXP with AM-settled monthly NDX (which settles on the opening SOQ, not the close).
 * Returns premium cash, fees, terminal value, P/L. `profile` is the payoff vs one common underlying.
 */
function settleBook(fills, settle) {
  const legs = netLegs(fills.map(f => ({ root: f.root, right: f.right, strike: f.strike, qty: f.side * f.qty })));
  const premiumCash = r2(fills.reduce((s, f) => s + f.gross, 0));     // + received, − paid (premium only)
  const fees = r2(fills.reduce((s, f) => s + f.fees, 0));
  const S = l => (typeof settle === 'number' ? settle : (settle[l.root] != null ? settle[l.root] : settle.default));
  const terminal = r2(legs.reduce((v, l) => v + l.qty * intrinsic(l.right, l.strike, S(l)) * MULT, 0));
  return {
    legs, premiumCash, fees, terminal,
    gross: r2(premiumCash + terminal),
    net: r2(premiumCash + terminal - fees),
    profile: payoffProfile(legs, premiumCash - fees),
  };
}

/**
 * Settlement value implied by E*TRADE's cash-settle rows ('Sold … @ $intrinsic'). Each row's price is the
 * intrinsic at the official settle, so it pins the settle itself: put → K − price, call → K + price.
 */
function impliedSettleFromRows(rows) {
  const vals = rows.filter(r => r.kind === 'cash-settle' && r.price > 0)
    .map(r => (r.right === 'P' ? r.strike - r.price : r.strike + r.price));
  return vals.length ? { min: r2(Math.min(...vals)), max: r2(Math.max(...vals)), n: vals.length } : null;
}

module.exports = { MULT, intrinsic, payoffAt, netLegs, payoffProfile, classifyOrder, settleBook, impliedSettleFromRows };
