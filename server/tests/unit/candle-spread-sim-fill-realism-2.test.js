'use strict';
// SIM FILL REALISM, PART 2 (2026-10-17). The 10/16 audit of simulated fills against real quotes (and the
// 10/05-10/16 two-week pass, 23.7k fills) found fills booked off one noisy look, on the fetch that priced the
// order, on unquoted credit twins, on cheap credit twins the debit legs never confirmed, on stale deep-ITM leg
// mids (combo near W/2 on a 0..2W natural), on fly/condor marks below zero, and on stale legs. Pinned here:
//   1. dwell: >= N consecutive at-or-through looks on DISTINCT chain fetches, reset on a miss (covers + hedges)
//   2. never on the fetch that placed / repriced the order
//   3. cheapOutlier + parity-fair (ITM legs) on resting debit covers
//   4. credit covers: no parity fallback for an unquoted twin; twin AND debit legs both at the price
//   5. hedges: fill-through, iron raise on its sent legs, impossible structure marks, structureQuoteSane at fill
//   6. parity residual gate (mark path only)
//   7. combo: covered in candle-spread-combo-live
//   8. quote age (abstain + count when absent)
//   9. order_simulated note text
//  10. per-leg evidence + last-4 looks
// Engine defaults stay legacy; index.simFillRealismDeps arms them for every variant.
//
// Run: node server/tests/unit/candle-spread-sim-fill-realism-2.test.js
const fs = require('fs');
const path = require('path');
const trader = require('../../src/candle-spread/trader');
const CS = require('../../src/candle-spread/index');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const r2 = (x) => Math.round(x * 100) / 100;

// A self-consistent chain around spot S: call = intrinsic + 8*exp(-|S-K|/40), put by parity. Monotonic in strike.
// `over` = { 'C25000': mid | null } overrides; `qt` = quoteTime for every leg (or a per-leg map); `id` = chainId.
function chain(S, { over = {}, qt = null, id = null, spread = 0.2 } = {}) {
  const fn = (type, strike) => {
    const key = `${type}${strike}`;
    let mid;
    if (Object.prototype.hasOwnProperty.call(over, key)) {
      if (over[key] == null) return null;
      mid = over[key];
    } else {
      const c = Math.max(0, S - strike) + 8 * Math.exp(-Math.abs(S - strike) / 40);
      mid = type === 'C' ? c : c - (S - strike);
    }
    mid = r2(mid);
    const q = typeof qt === 'object' && qt !== null ? qt[key] : qt;
    return { mid, bid: r2(mid - spread), ask: r2(mid + spread), symbol: `NDX_${key}`, quoteTime: q != null ? q : null };
  };
  fn.chainId = id;
  return fn;
}
const bullCall = [{ side: 'long', type: 'C', strike: 25000 }, { side: 'short', type: 'C', strike: 25010 }];
const markOf = (legs, g) => r2(legs.reduce((s, l) => s + (l.side === 'long' ? 1 : -1) * g(l.type, l.strike).mid, 0));
const base = { symbol: 'NDX', spreadWidth: 10, strikeIncrement: 10, tickIncrement: 0.05, quantity: 1, coverFillThroughTicks: 1 };
const debitCover = (target, pcOver = {}) => ({ id: 'c', side: 'bull', filled: true, covered: false, quantity: 1, limit: 4.0,
  legs: bullCall, shortStrike: 25010,
  pendingCover: { legs: bullCall, target, openCost: 4.0, minLock: 0, placedEpoch: 1, sentNet: 'DEBIT', ...pcOver } });
const resolve = (p, g, deps, d = []) => { const st = { positions: [p], realizedPnl: 0, cashDeployed: 0, lastUnderlying: 25005 };
  trader.resolveRestingCovers(st, base, g, d, { strikeIncrement: 10, underlying: 25005, ...deps }); return { st, d }; };

(async () => {
  const S = 25005;
  const m0 = markOf(bullCall, chain(S));                     // 5.00
  const T = r2(m0 + 0.10);                                   // two ticks through at S
  const away = 25015;                                        // mark well above T
  ok(markOf(bullCall, chain(away)) > T, `control: at ${away} the cover is not at its price`);

  // ── 1+2. DWELL on a debit cover ──────────────────────────────────────────────────────────────────
  {
    const dd = { simCoverFillMinLooks: 2 };
    let p = debitCover(T, { placedChainAt: 'P' });
    resolve(p, chain(S, { id: 'P' }), dd);
    ok(!p.covered, 'no fill on the fetch that PLACED it, even at or through the price');
    ok(p.pendingCover.fillStreak == null || p.pendingCover.fillStreak === 0, 'and the placing fetch does not count toward the streak');
    resolve(p, chain(S, { id: 'A' }), dd);
    ok(!p.covered && p.pendingCover.fillStreak === 1, 'first distinct fetch after placement: streak 1, no fill');
    resolve(p, chain(S, { id: 'B' }), dd);
    ok(p.covered, 'second consecutive through fetch after placement -> fill');

    p = debitCover(T, { placedChainAt: 'P' });
    resolve(p, chain(away, { id: 'P' }), dd);
    resolve(p, chain(S, { id: 'A' }), dd);
    ok(!p.covered && p.pendingCover.fillStreak === 1, 'one-look dip: streak 1, no fill');
    resolve(p, chain(away, { id: 'B' }), dd);
    ok(!p.covered && p.pendingCover.fillStreak === 0, 'the market reverts: streak reset, no fill');
    resolve(p, chain(S, { id: 'C' }), dd);
    ok(!p.covered, 'the next dip starts again at 1');
    resolve(p, chain(S, { id: 'D' }), dd);
    ok(p.covered, 'two consecutive through looks on distinct fetches -> fill');

    p = debitCover(T, { placedChainAt: 'P' });
    resolve(p, chain(S, { id: 'A' }), dd);
    const { d } = resolve(p, chain(S, { id: 'A' }), dd);
    ok(!p.covered && p.pendingCover.fillStreak === 1, 'the SAME fetch read twice counts once (no fill)');
    ok(d.some((x) => x.action === 'cover-dwell'), 'and the wait is logged as cover-dwell');

    p = debitCover(T);
    resolve(p, chain(S), {});
    ok(p.covered, 'engine default (no knob): legacy single-look fill');
  }

  // ── 10. EVIDENCE: last 4 looks with outcome, per-leg quotes at the fill ─────────────────────────────
  {
    const dd = { simCoverFillMinLooks: 2, nowMs: 1000 };
    const p = debitCover(T);
    for (const [s, id] of [[away, 'a'], [S, 'b'], [away, 'c'], [away, 'd'], [S, 'e']]) resolve(p, chain(s, { id, qt: 900 }), dd);
    const pc = p.pendingCover;
    ok(pc.recentLooks.length === 4, `keeps the last 4 looks (${pc.recentLooks.length})`);
    ok(pc.recentLooks.map((l) => l.thr).join('') === '1001', `each look records whether it was through (${pc.recentLooks.map((l) => l.thr).join('')})`);
    ok(pc.recentLooks[0].c === 'b' && pc.recentLooks[0].t === 1000 && pc.recentLooks[0].m != null && pc.recentLooks[0].b != null,
      'with chain id, wall time and combo mark/bid/ask — including the through look that did not fill');
    const { d } = resolve(p, chain(S, { id: 'f', qt: 900 }), dd);
    const f = d.find((x) => x.action === 'cover-fill');
    ok(p.covered && f && f.quote && f.quote.legs.length === 2, 'cover-fill carries the per-leg quotes');
    const lg = f.quote.legs[0];
    ok(lg.strike === 25000 && lg.type === 'C' && lg.bid != null && lg.ask != null && lg.mark != null && lg.quoteTime === 900,
      'each leg: strike, type, bid, ask, mark, quoteTime');
    ok(f.quote.mark != null && f.quote.bid != null && f.quote.ask != null && f.quote.looks.length === 4, 'plus the combo quote and the looks');
    ok(p.coverFillQuote === f.quote, 'and it persists on the position');
  }

  // ── 3a. cheapOutlier on a resting cover (strict) ────────────────────────────────────────────────────
  {
    const g = chain(S, { over: { C25000: 7.5 } });     // 25000/25010 marks 0.44 under 25010/25020's 1.56
    let p = debitCover(1.0);
    const { d } = resolve(p, g, { simFillStrict: true });
    ok(!p.covered && d.some((x) => x.action === 'cover-badquote' && /further out of the money/.test(x.reason)),
      'strict: a cover priced under its further-OTM sibling is a bad quote, not a fill');
    p = debitCover(1.0);
    resolve(p, g, {});
    ok(p.covered, 'control: without strict the same quote booked (the 10/16 shape)');
  }

  // ── 3b. PARITY-FAIR on ITM legs — 10/16 v9-20 10:42:50: +C29630 -C29650 quoted 1.0 / 9.85 / 18.7 ──────
  {
    const q = (mid, bid, ask) => ({ mid, bid, ask, symbol: 'x', quoteTime: null });
    const legs = { C29630: q(34.925, 30.0, 39.85), C29650: q(25.075, 21.15, 29.0), C29660: q(14.0, 13.8, 14.2),
      P29630: q(2.0, 1.8, 2.2), P29650: q(8.3, 8.1, 8.5), P29660: q(12.0, 11.8, 12.2) };
    const g = (type, strike) => legs[`${type}${strike}`] || null;
    const cl = [{ side: 'long', type: 'C', strike: 29630 }, { side: 'short', type: 'C', strike: 29650 }];
    const mk = (target) => ({ id: 'v9', side: 'bull', filled: true, covered: false, quantity: 1, limit: 5, legs: cl, shortStrike: 29650,
      pendingCover: { legs: cl, target, openCost: 5, minLock: 0, placedEpoch: 1, sentNet: 'DEBIT' } });
    const cfg20 = { ...base, spreadWidth: 20, simMaxQuoteWidthFrac: 1.0 };
    const run = (p, deps) => { const d = []; trader.resolveRestingCovers({ positions: [p], realizedPnl: 0, cashDeployed: 0 }, cfg20, g, d,
      { strikeIncrement: 10, underlying: 29662, simMaxQuoteWidthFrac: 1.0, parityGateTolFrac: 0.25, ...deps }); return d; };
    let p = mk(10.0);
    const d = run(p, { simFillStrict: true });
    const bad = d.find((x) => x.action === 'cover-badquote');
    ok(!p.covered && bad && /parity-fair 13\.7/.test(bad.reason), `strict: mark 9.85 vs parity-fair 13.7 -> refused (${bad && bad.reason})`);
    p = mk(10.0);
    run(p, {});
    ok(p.covered, 'control: every older gate (width <= W, parity residual 25%, cheapOutlier floor 40%) let it through');
    // Same strikes with the ITM legs AT parity: fills.
    legs.C29630 = q(34.0, 32.0, 36.0); legs.C29650 = q(20.3, 18.3, 22.3);
    p = mk(13.8);
    run(p, { simFillStrict: true });
    ok(p.covered, 'control: legs at their parity value (13.70) fill a 13.80 target');
  }

  // ── 4. CREDIT COVER: no parity fallback; twin AND debit legs at the price ─────────────────────────
  {
    const twin = [{ side: 'short', type: 'P', strike: 25010 }, { side: 'long', type: 'P', strike: 25000 }];
    const credit = (over = {}) => debitCover(5.10, { sentNet: 'CREDIT', sentCredit: 4.90, sentLegs: twin, ...over });
    let p = credit();
    let r = resolve(p, chain(S, { over: { P25000: null } }), { simFillStrict: true });
    ok(!p.covered && r.d.some((x) => x.action === 'cover-twin-unquoted'), 'strict: an unquoted twin never fills off the debit legs by parity');
    p = credit();
    resolve(p, chain(S, { over: { P25000: null } }), {});
    ok(p.covered, 'control: legacy fell back to parity and booked it');
    p = credit();
    resolve(p, chain(S, { over: { C25000: 12.56 } }), { simFillStrict: true });   // twin offers 5.00, debit legs mark 5.50
    ok(!p.covered, 'strict: the twin offering the credit is not enough when the debit legs mark 5.50 > 5.05');
    p = credit();
    resolve(p, chain(S, { over: { C25000: 12.56 } }), {});
    ok(p.covered, 'control: legacy took the better of the two chains');
    p = credit();
    resolve(p, chain(S, { id: 'A' }), { simFillStrict: true, simCoverFillMinLooks: 2 });
    ok(!p.covered, 'both chains at the price: first look waits (dwell)');
    resolve(p, chain(S, { id: 'B' }), { simFillStrict: true, simCoverFillMinLooks: 2 });
    ok(p.covered && p.coverLimit <= 5.10 && p.coverFillQuote.sent && p.coverFillQuote.sent.legs[0].type === 'P',
      'second look: fills at the limit, evidence carries the twin legs too');
  }

  // ── 6. PARITY RESIDUAL — the ±148 shape (call spread 0.05, puts net 0 on a 10-wide) ─────────────────
  {
    const g = chain(S, { over: { C25000: 7.11, C25010: 7.06, P25000: 7.0, P25010: 7.0 }, spread: 74 });
    let p = debitCover(1.0);
    const { d } = resolve(p, g, { parityGateTolFrac: 0.25 });
    ok(!p.covered && d.some((x) => /parity off by/.test(x.reason || '')), 'a cover on a call spread 0.05 whose puts net 0 is refused');
    p = debitCover(1.0);
    resolve(p, g, {});
    ok(p.covered, 'control: without the gate it booked');
    // (siblings unquoted so cheapOutlier abstains and the parity gate is what decides)
    const gm = chain(S, { over: { C25000: 7.11, C25010: 7.06, P25000: 7.0, P25010: 7.0, C25020: null, C25030: null }, spread: 74 });
    const chk = trader.markFill(bullCall, 1.0, gm, 0.05, { strikeIncrement: 10, parityGateTolFrac: 0.25 });
    ok(!chk.fillable && /parity off by/.test(chk.badQuote || ''), 'markFill (opens, hedges) refuses it too');
    const brk = trader.markFill(bullCall, 1.0, gm, 0.05, { strikeIncrement: 10, parityGateTolFrac: 0.25, fillSource: 'broker' });
    ok(!/parity/.test(brk.badQuote || ''), 'under the broker the gate is inert (broker path untouched)');
  }

  // ── 8. QUOTE AGE ─────────────────────────────────────────────────────────────────────────────────
  {
    const now = 10_000_000;
    let p = debitCover(T);
    const { d } = resolve(p, chain(S, { qt: { C25000: now - 120_000, C25010: now - 1000 } }), { simMaxQuoteAgeSec: 60, nowMs: now });
    ok(!p.covered && d.some((x) => /stale quote: C25000/.test(x.reason || '')), 'a leg last quoted 120s ago is refused');
    p = debitCover(T);
    const r = resolve(p, chain(S, { qt: now - 5000 }), { simMaxQuoteAgeSec: 60, nowMs: now });
    ok(p.covered && !r.st.simQuoteAgeUnknown, 'fresh legs fill');
    p = debitCover(T);
    const r2_ = resolve(p, chain(S), { simMaxQuoteAgeSec: 60, nowMs: now });
    ok(p.covered && r2_.st.simQuoteAgeUnknown === 2, `no quoteTime: abstains and counts it (${r2_.st.simQuoteAgeUnknown})`);
    const chk = trader.markFill(bullCall, 9, chain(S, { qt: now - 120_000 }), 0.05, { strikeIncrement: 10, simMaxQuoteAgeSec: 60, nowMs: now });
    ok(!chk.fillable && chk.staleQuote, 'markFill (opens, hedges) refuses a stale leg');
  }

  // ── 5. HEDGES ────────────────────────────────────────────────────────────────────────────────────
  const hedge = (legs, limit, phOver = {}) => ({ id: 'h', filled: false, side: 'raise', legs, limit, quantity: 1, hedge: true, raise: true,
    pendingHedge: { limit, kind: 'raise', placedEpoch: 0, ...phOver } });
  const resolveH = (pos, g, deps) => { const st = { positions: [pos], realizedPnl: 0, cashDeployed: 0, lastUnderlying: S }; const d = [];
    trader.resolvePendingHedges(st, { ...base }, { getLeg: g, nowMs: 1000, strikeIncrement: 10, underlying: S, simFillAtLimit: true, ...deps }, d); return { st, d }; };
  {
    // fill-through
    let h = hedge(bullCall, m0);
    resolveH(h, chain(S), { simHedgeFillThroughTicks: 1 });
    ok(h.filled === false, 'a hedge whose mark only touches its limit does not fill (1-tick through)');
    h = hedge(bullCall, r2(m0 + 0.05));
    resolveH(h, chain(S), { simHedgeFillThroughTicks: 1 });
    ok(h.filled === true && h.limit === r2(m0 + 0.05), 'one tick through fills, booked at the limit');
    // dwell + same fetch + reprice
    h = hedge(bullCall, r2(m0 + 0.05), { placedChainAt: 'P' });
    resolveH(h, chain(S, { id: 'P' }), { simHedgeFillMinLooks: 2 });
    ok(h.filled === false, 'hedge: no fill on the placing fetch');
    resolveH(h, chain(S, { id: 'A' }), { simHedgeFillMinLooks: 2 });
    ok(h.filled === false, 'hedge: one look after placement is not enough');
    resolveH(h, chain(S, { id: 'A2' }), { simHedgeFillMinLooks: 2 });
    ok(h.filled === true, 'hedge: fills on the second distinct fetch after placement');
    h = hedge(bullCall, 0.5, { placedChainAt: 'P', walkStart: 0.5, ceiling: r2(m0 + 0.2), walkStepSec: 60, walkStepDollars: 10 });
    resolveH(h, chain(S, { id: 'P' }), { simHedgeFillMinLooks: 2 });
    const st = { positions: [h], realizedPnl: 0 };
    await trader.walkRaiseOrders(st, base, { getLeg: chain(S, { id: 'B' }), nowMs: 61_000 }, []);
    ok(h.pendingHedge.limit === r2(m0 + 0.2) && h.pendingHedge.repricedChainAt === 'B', 'a walk reprice stamps its fetch');
    resolveH(h, chain(S, { id: 'B' }), { simHedgeFillMinLooks: 2 });
    ok(h.filled === false, 'no fill on the fetch that repriced it');
    resolveH(h, chain(S, { id: 'C' }), { simHedgeFillMinLooks: 2 });
    ok(h.filled === false, 'the reprice restarted the streak: one look is not enough');
    resolveH(h, chain(S, { id: 'D' }), { simHedgeFillMinLooks: 2 });
    ok(h.filled === true && h.fillQuote && h.fillQuote.legs.length === 2, 'two looks at the new price fill, with per-leg evidence');

    // negative fly mark
    const fly = [{ side: 'long', type: 'C', strike: 24990 }, { side: 'short', type: 'C', strike: 25000 },
      { side: 'short', type: 'C', strike: 25000 }, { side: 'long', type: 'C', strike: 25010 }];
    const gNeg = chain(S, { over: { C25000: 14.0 } });
    ok(markOf(fly, gNeg) < 0, `fixture: the fly marks ${markOf(fly, gNeg)}`);
    h = hedge(fly, 2.0, { kind: 'fly' });
    const rf = resolveH(h, gNeg, { simFillStrict: true });
    ok(h.filled === false && rf.d.some((x) => x.action === 'fly-badquote' && /below the least/.test(x.reason)), 'strict: a fly marked below zero is refused');
    h = hedge(fly, 2.0, { kind: 'fly' });
    resolveH(h, gNeg, {});
    ok(h.filled === true, 'control: legacy booked the negative fly');
    // structure bounds, directly: condor above its wing, single long below zero / below intrinsic
    const condor = [{ side: 'long', type: 'C', strike: 24990 }, { side: 'short', type: 'C', strike: 25000 },
      { side: 'short', type: 'C', strike: 25010 }, { side: 'long', type: 'C', strike: 25020 }];
    ok(!trader.structureBounds(condor, 10.5).ok && trader.structureBounds(condor, 9.9).ok, 'a condor above its 10-point wing is impossible');
    ok(!trader.structureBounds(condor, -0.2).ok, 'and below zero');
    const iron = [{ side: 'long', type: 'P', strike: 24990 }, { side: 'short', type: 'P', strike: 25000 },
      { side: 'short', type: 'C', strike: 25000 }, { side: 'long', type: 'C', strike: 25010 }];
    ok(trader.structureBounds(iron, -6.5).ok && !trader.structureBounds(iron, -10.5).ok && !trader.structureBounds(iron, 0.3).ok,
      'an iron (credit) must mark in [-wing, 0]');
    ok(!trader.structureBounds([{ side: 'long', type: 'C', strike: 24900 }], 90, 25005).ok, 'a long C24900 at 90 with spot 25005 is under intrinsic (stale)');
    ok(trader.structureBounds([{ side: 'long', type: 'C', strike: 25100 }], 0.4, 25005).ok, 'an OTM wing is fine');

    // stale condor at FILL time (structureQuoteSane)
    const q = (mid) => ({ mid, bid: r2(Math.max(0, mid - 0.1)), ask: r2(mid + 0.1), symbol: 'x', quoteTime: null });
    const cq = { C24700: q(305), C24710: q(304), C25300: q(0.5), C25310: q(0.15),
      P24700: q(0), P24710: q(9), P25300: q(295.5), P25310: q(305.15) };
    const gC = (type, strike) => cq[`${type}${strike}`] || null;
    const deep = [{ side: 'long', type: 'C', strike: 24700 }, { side: 'short', type: 'C', strike: 24710 },
      { side: 'short', type: 'C', strike: 25300 }, { side: 'long', type: 'C', strike: 25310 }];
    h = hedge(deep, 0.8);
    const rq = resolveH(h, gC, { simFillStrict: true });
    ok(h.filled === false && rq.d.some((x) => x.action === 'raise-badquote' && /expected payoff/.test(x.reason)),
      'strict: a condor with spot inside a 600-point body quoted 0.65 is refused at FILL time');
    h = hedge(deep, 0.8);
    resolveH(h, gC, {});
    ok(h.filled === true, 'control: legacy booked it');

    // iron raise tested on its SENT legs as a CREDIT
    const gIron = chain(S, { over: { P24990: 6.5 } });       // fly legs mark 3.44; iron offers only 5.56 credit
    const ironRaise = () => hedge(fly, 3.60, { sentNet: 'CREDIT', sentLegs: iron, sentOffset: 10, sentLimit: 6.40 });
    h = ironRaise();
    resolveH(h, gIron, { simFillStrict: true, simHedgeFillThroughTicks: 1 });
    ok(h.filled === false, 'strict: the iron that rests offers 5.56 < 6.45 — no fill, whatever the fly legs say');
    h = ironRaise();
    resolveH(h, gIron, { simHedgeFillThroughTicks: 1 });
    ok(h.filled === true, 'control: legacy tested the canonical fly legs and booked it');
    h = ironRaise();
    resolveH(h, chain(S), { simFillStrict: true, simHedgeFillThroughTicks: 1 });
    ok(h.filled === true && h.limit === 3.60 && h.fillQuote.legs[0].type === 'P',
      'strict: when the iron itself offers 6.56 >= 6.45 it fills at the debit-equivalent limit, evidence on the iron legs');
  }

  // ── chain fetch identity + quoteTime through makeLegAccessor ────────────────────────────────────────
  {
    const raw = { call: { '2026-10-16:0': { '25000.0': [{ bid: 10, ask: 12, mark: 11, quoteTimeInLong: 111, symbol: 'C' }] } },
      put: { '2026-10-16:0': { '25000.0': [{ bid: 4, ask: 6, mark: 5, quoteTimeInLong: 222, symbol: 'P' }] } } };
    const a = trader.makeLegAccessor(raw, '2026-10-16');
    const b = trader.makeLegAccessor(JSON.parse(JSON.stringify(raw)), '2026-10-16');
    ok(a.chainId === 'q222' && a.chainId === b.chainId, `a re-parsed copy of the same fetch is the same fetch (${a.chainId})`);
    ok(a('C', 25000).quoteTime === 111, 'quoteTime is carried per leg');
    raw.call['2026-10-16:0']['25000.0'][0].quoteTimeInLong = 333;
    ok(trader.makeLegAccessor(raw, '2026-10-16').chainId === 'q333', 'a newer quote anywhere is a new fetch');
  }

  // ── broker path: covers and hedges untouched by the new rules ──────────────────────────────────────
  {
    const p = debitCover(1.0);
    const g = chain(S, { over: { C25000: 7.5 } });
    const { d } = resolve(p, g, { fillSource: 'broker', simFillStrict: true, simCoverFillMinLooks: 2, parityGateTolFrac: 0.25, simMaxQuoteAgeSec: 60 });
    ok(!p.covered && !d.length && p.pendingCover.recentLooks == null, 'under the broker resolveRestingCovers records no sim looks and books nothing');
  }

  // ── roster defaults + note text ─────────────────────────────────────────────────────────────────
  {
    const dflt = CS.simFillRealismDeps({});
    ok(dflt.simCoverFillMinLooks === 2 && dflt.simHedgeFillMinLooks === 2 && dflt.simHedgeFillThroughTicks === 1
      && dflt.simFillStrict === true && dflt.parityGateTolFrac === 0.25 && dflt.simMaxQuoteAgeSec === 60,
      `every variant gets the defaults (${JSON.stringify(dflt)})`);
    const over = CS.simFillRealismDeps({ simCoverFillMinLooks: 3, simFillStrict: false });
    ok(over.simCoverFillMinLooks === 3 && over.simFillStrict === false, 'a run can override them');
    const src = fs.readFileSync(path.join(__dirname, '../../src/candle-spread/index.js'), 'utf8');
    ok(/not sent \(\$\{why\}\); fill decided by the mark path/.test(src) && !/assumed filled at limit` \}\)/.test(src),
      'order_simulated note says the mark path decides the fill');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
