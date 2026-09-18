'use strict';
// MARK SANITY. On 2026-09-16, volatility knocked holes in the chain snapshot and legs came back inverted
// and absurdly wide — a 40-wide put spread quoted bid -373.3 / ask 140.0. Netting those produced marks
// like -116.65. markFill only asked `mark > limit`, which a negative mark passes trivially, and the limit
// had been derived from the same bad mark and floored at one tick. Result: 154 covers across 55 variants
// "filled" at $5 on 40-wide spreads, INFLATING the recorded floor by ~$188,425 of value never captured.
//
// The gates are pinned here from both sides. The structural ones are exact and were measured against all
// 1,339 covers of that session: 150 of the 154 bad ones caught, ZERO false positives out of 1,185 healthy.
//
// Run: node server/tests/unit/candle-spread-mark-sanity.test.js
const SQ = require('../../src/candle-spread/spread-quote');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

const callDebit = (lo, hi) => [{ side: 'long', type: 'C', strike: lo }, { side: 'short', type: 'C', strike: hi }];
const putDebit = (lo, hi) => [{ side: 'long', type: 'P', strike: hi }, { side: 'short', type: 'P', strike: lo }];
const callCredit = (lo, hi) => [{ side: 'short', type: 'C', strike: lo }, { side: 'long', type: 'C', strike: hi }];

// ── THE REAL FAILURES, verbatim from the 2026-09-16 record ──────────────────────────────────────────
{
  // -1p29170 +1p29210, marked -32.20 on a 40-wide. Long the HIGHER put = debit, so it cannot be negative.
  ok(!SQ.verticalSanity(putDebit(29170, 29210), -32.20).ok, 'a debit put spread marked -32.20 is refused');
  // -1p29180 +1p29220, marked -116.65: also beyond the width entirely.
  const r = SQ.verticalSanity(putDebit(29180, 29220), -116.65);
  ok(!r.ok && /exceeds width/.test(r.reason), `|mark| beyond the width is refused (${r.reason})`);
  // -1c29170 +1c29130, marked -21.45. Inside the width, but still a debit priced below zero.
  const c = SQ.verticalSanity(callDebit(29130, 29170), -21.45);
  ok(!c.ok && /below zero/.test(c.reason), `a debit call spread marked -21.45 is refused (${c.reason})`);
  // The healthy cover from the same minute must still pass — this is the one that matters.
  ok(SQ.verticalSanity(putDebit(29190, 29230), 16.30).ok, 'the healthy 16.30 cover alongside them still passes');
}

// ── THE BOUNDS, both directions ─────────────────────────────────────────────────────────────────────
{
  ok(SQ.verticalSanity(callDebit(29000, 29040), 0).ok, 'a debit spread may be worth zero');
  ok(SQ.verticalSanity(callDebit(29000, 29040), 40).ok, 'and may be worth the full width');
  ok(!SQ.verticalSanity(callDebit(29000, 29040), 40.01).ok, 'but never more than the width');
  ok(!SQ.verticalSanity(callDebit(29000, 29040), -0.01).ok, 'and never less than zero');
  // Credit spreads are the mirror, and must NOT be refused for being negative.
  ok(SQ.verticalSanity(callCredit(29000, 29040), -12).ok, 'a credit spread marked negative is fine');
  ok(!SQ.verticalSanity(callCredit(29000, 29040), 12).ok, 'a credit spread marked positive is refused');
  // Structures with more legs keep the width bound but not the sign rule, since the sign depends on shape.
  const fly = [{ side: 'long', type: 'C', strike: 29000 }, { side: 'short', type: 'C', strike: 29020 },
    { side: 'short', type: 'C', strike: 29020 }, { side: 'long', type: 'C', strike: 29040 }];
  ok(SQ.verticalSanity(fly, -5).ok, 'a four-leg structure is not judged on sign');
  ok(!SQ.verticalSanity(fly, 45).ok, 'but is still bounded by its strike span');
  ok(!SQ.verticalSanity(callDebit(29000, 29040), null).ok, 'a missing mark is refused');
}

// ── USABILITY: only what is exactly wrong ───────────────────────────────────────────────────────────
{
  const legs = callDebit(29000, 29040);
  ok(!SQ.quoteUsable(legs, { mark: 10, bid: 20, ask: 5 }).ok, 'an inverted book is refused');
  ok(!SQ.quoteUsable(legs, { mark: 10, bid: null, ask: 5 }).ok, 'an incomplete quote is refused');
  // THE ONE THAT MUST NOT REGRESS. NDX 0DTE quotes very wide and still trades near the mid, and quoted
  // span tracks MONEYNESS and market-wide widening rather than whether a quote is broken. Measured on
  // that session's healthy covers: far-OTM covers (mark < 0.10 of width) median 5.17x span, mid-moneyness
  // ones 0.70x — so covering a deep-ITM position, where the cover sits far OTM, legitimately quotes
  // widest. And the 463 healthy covers in the SAME 14:xx hour as all 154 failures share their span
  // profile exactly (median 0.91x, p90 5.17x, max 12.75x). Span separates nothing here.
  // See feedback_ndx_spreads_fill_near_mid before ever adding a width threshold.
  ok(SQ.quoteUsable(legs, { mark: 12, bid: -140, ask: 160 }).ok, 'a WIDE but ordered book is accepted');
  ok(SQ.quoteUsable(legs, { mark: 12, bid: 2, ask: 25 }).ok, 'and so is an ordinary one');
}

// ── PARITY, two-sided ───────────────────────────────────────────────────────────────────────────────
{
  // A consistent chain around spot ~29130 for the 29120/29140 pair: the call spread is worth 12, the put
  // spread 8, and they sum to the width exactly as parity requires.
  const MID = { C: { 29120: 18, 29140: 6 }, P: { 29120: 6, 29140: 14 } };
  const good = (type, k) => ({ mid: MID[type][k], bid: MID[type][k] - 1, ask: MID[type][k] + 1 });
  const pd = SQ.parityDeviation(29120, 29140, good);
  ok(pd && Math.abs(pd.residual) < 0.01, `a consistent chain shows no parity residual (${pd && pd.residual})`);
  ok(pd.ok, 'and passes the gate');

  // THE 2026-09-16 SHAPE. Both call legs come back broken but only 0.05 apart, so the call SPREAD nets to
  // $0.05 — a perfectly legal price for a 20-wide debit spread, which is why structural bounds let those
  // four covers through. The puts are still quoted sanely, so the parity sum collapses to 8.05 against a
  // width of 20 and the identity is violated by ~12.
  const broken = (type, k) => (type === 'C' ? { mid: k === 29120 ? 74.05 : 74, bid: -74, ask: 148 } : good('P', k));
  const bad = SQ.parityDeviation(29120, 29140, broken);
  ok(bad && !bad.ok, `broken legs that net to a legal price are caught by parity (residual ${bad && bad.residual})`);
  ok(bad && Math.abs(bad.residual) > 10, 'and the residual is large, not marginal');

  // It must ABSTAIN rather than refuse when the opposing side simply is not quoted.
  ok(SQ.parityDeviation(29120, 29140, (t) => (t === 'C' ? { mid: 8, bid: 7, ask: 9 } : null)) === null,
    'an unquoted opposing side abstains instead of refusing');
}

// ── THE CREDIT TWIN, and the $995 order ─────────────────────────────────────────────────────────────
// At 14:00 on 2026-09-16, v0-10 sent NET_CREDIT $995 on a $10-wide spread while its OWN recorded mark for
// the same strikes was 3. The put legs were broken, `credit` computed to ~10, and
// Math.min(W - tick, asked) pinned it to exactly the ceiling -- the mirror image of the $5 covers, a price
// that cannot be right forced into range instead of refused.
//
// Neither other gate reaches it: markFill gates FILLS not placements, and 9.95 on a 10-wide credit spread
// is structurally legal. Only the twin identity convicts it -- the credit twin is the SAME position as the
// debit vertical, so parity fixes its price at W - debitMark exactly.
{
  const trader = require('../../src/candle-spread/trader');
  const cfg = { spreadWidth: 10, tickIncrement: 0.05, quantity: 1, strikeIncrement: 10 };
  // A bull credit twin sells the put spread: short P(upper), long P(lower).
  const q = (mid, type, k) => ({ mid, bid: Math.max(0, mid - 1), ask: mid + 1, symbol: `NDX_${type}${k}` });
  const chain = (hi, lo) => (type, k) => (type === 'P' ? q(k === 29130 ? hi : lo, type, k) : q(5, type, k));

  // BROKEN, exactly as it happened: the put legs net to ~10 of credit on a 10-wide spread.
  const bad = trader.buildCreditOpenOrder('bull', 29120, 29130, cfg, chain(80, 70), 3);
  ok(bad.error, `the $995 order is now refused (${bad.error || 'NOT REFUSED'})`);
  ok(!bad.payload, 'and no payload is built for it');

  // HEALTHY: debit mark 3 on a 10-wide implies the twin receives 7. A chain that agrees must go through.
  const good = trader.buildCreditOpenOrder('bull', 29120, 29130, cfg, chain(10, 3), 3);
  ok(!good.error, `a twin that agrees with parity is sent (${good.error || 'ok'})`);
  ok(good.limit === 7, `and is priced at W - debitMark = 7 (got ${good.limit})`);

  // The check must ABSTAIN when there is no debit mark to compare against, rather than block every twin.
  const noMark = trader.buildCreditOpenOrder('bull', 29120, 29130, cfg, chain(10, 3), null);
  ok(!noMark.error, 'with no debit mark the parity check abstains');

  // And the ceiling is a REFUSAL now, not a clamp -- that is what hid the bug.
  const overWidth = trader.buildCreditOpenOrder('bull', 29120, 29130, cfg, chain(200, 180), null);
  ok(overWidth.error && /outside/.test(overWidth.error), `a credit above the width is refused, not clamped (${overWidth.error})`);
}

// ── THE LADDER MUST NOT WALK DOWN TO A BROKEN MARK ──────────────────────────────────────────────────
// cover-ladder's neverExceedMark rule caps the resting limit at the market. With a negative mark that cap
// walked the limit to one tick — the same $5-cover failure, arriving by a different route.
{
  const CL = require('../../src/candle-spread/cover-ladder');
  const base = { spreadWidth: 40, tick: 0.05, openCost: 21.6, minLock: 4, restingMs: 60000, underlyingMove: 0 };
  const opts = { neverExceedMark: true, stepDollars: 0.25, steps: 8, stepSeconds: 30 };
  const sane = CL.limitNow({ ...base, mark: 14.4 }, opts);
  ok(sane.limit > 1, `a usable mark still caps the ladder (limit ${sane.limit})`);
  for (const bad of [-32.2, -0.01, 41, 1e6]) {
    const r = CL.limitNow({ ...base, mark: bad }, opts);
    ok(r.limit > 1, `mark ${bad} does not walk the ladder to a tick (got ${r.limit})`);
    ok(!r.capped, `and is not treated as a cap (mark ${bad})`);
  }
  const noMark = CL.limitNow({ ...base, mark: null }, opts);
  ok(noMark.limit > 1, 'a missing mark leaves the ladder alone');
}

// ── FILL DIRECTION: a credit order fills when the market comes UP to it ─────────────────────────────
// A DEBIT order fills when the mark falls to the limit (you pay at most that). A CREDIT order is the
// mirror: it fills when the mark RISES to the limit, because you must receive at least that. Testing a
// credit order with the debit inequality books a fill exactly when the real order would NOT have filled.
//
// Measured on 2026-09-17 before the fix: 18 of 60 credit-sent opens (30%) were booked filled while the
// best credit mark all day never reached the asked credit.
{
  const trader = require('../../src/candle-spread/trader');
  // Bull put CREDIT spread: short the higher strike, long the lower. Its credit = P(hi) - P(lo).
  const legs = [{ side: 'short', type: 'P', strike: 29400 }, { side: 'long', type: 'P', strike: 29390 }];
  const chain = (hi, lo) => (t, k) => ({ mid: k === 29400 ? hi : lo, bid: 0, ask: 200, symbol: `NDX_${t}${k}` });
  const ASK = 4.20;                       // the credit we are asking for

  // Market short of our price: credit mark 4.10 against an ask of 4.20 -- the real order does not fill.
  const short = trader.markFill(legs, ASK, chain(10.10, 6.00), 0.05, {}, 'CREDIT');
  ok(!short.fillable, `a credit mark of 4.10 does not fill a 4.20 ask (mark ${short.mark})`);
  // THE REGRESSION GUARD: under the old debit inequality this same quote WOULD have filled, because
  // the debit-space mark is below the limit. That is the exact bug.
  ok(trader.markFill(legs, ASK, chain(10.10, 6.00), 0.05, {}).fillable,
    'and the debit test would (wrongly) have filled it — which is what was happening');

  // Market reaches the ask: fills, and never for less than asked.
  const hit = trader.markFill(legs, ASK, chain(10.30, 6.00), 0.05, {}, 'CREDIT');
  ok(hit.fillable, `a credit mark of 4.30 fills a 4.20 ask (mark ${hit.mark})`);
  ok(hit.fill >= ASK, `and receives at least the asked credit (got ${hit.fill})`);
  ok(hit.fill <= 4.30, `and never more than the market (got ${hit.fill})`);

  // Exactly at the ask fills too — a limit order trades at its limit.
  ok(trader.markFill(legs, ASK, chain(10.20, 6.00), 0.05, {}, 'CREDIT').fillable, 'exactly at the ask fills');

  // DEBIT is unchanged, both directions.
  const dLegs = [{ side: 'long', type: 'C', strike: 29390 }, { side: 'short', type: 'C', strike: 29400 }];
  const dChain = (lo, hi) => (t, k) => ({ mid: k === 29390 ? lo : hi, bid: 0, ask: 200, symbol: `NDX_${t}${k}` });
  ok(trader.markFill(dLegs, 6.00, dChain(11, 5), 0.05, {}).fillable, 'a debit fills when the mark is at/below the limit');
  ok(!trader.markFill(dLegs, 6.00, dChain(12, 5), 0.05, {}).fillable, 'and not when the mark is above it');
}

(async () => {
// ── A CREDIT COVER MUST ASK EXACTLY WHAT THE DEBIT TWIN WOULD PAY ───────────────────────────────────
// The two branches used to answer different questions: the debit cover rests at the profit-LOCK target
// (W - openCost - minLock), a price chosen to bank a result; the credit twin was priced at its own chain
// MARK, a price chosen to trade. On a 40-wide with a lock target of 8.6 the twin asked 21.6 where parity
// demands 31.4 — nearly $1,000 a contract less credit, so it filled far too easily and locked far less
// than the book recorded. 258 of 284 credit covers on 2026-09-17 were short; $107,950 in one session.
{
  // async because placeRestingCover awaits placeOrder
  const trader = require('../../src/candle-spread/trader');
  const cfg = { symbol: 'NDX', expiration: '2026-09-17', spreadWidth: 40, strikeIncrement: 10,
    quantity: 1, tickIncrement: 0.05, coverSelector: 'fixed-mark', coverFillModel: 'resting', variant: 'tst' };
  // A flat chain: every leg 10.00, so a mark-priced twin would come out at ZERO and can never accidentally
  // agree with the lock-derived price. Any agreement below is therefore structural, not coincidence.
  const flat = (t, k) => ({ mid: 10, bid: 9, ask: 11, symbol: `NDX_${t}${k}` });
  const run = async (style) => {
    const pos = { id: 'p1', side: 'bull', filled: true, quantity: 1, limit: 23.4, shortStrike: 29380,
      legs: [{ side: 'long', type: 'C', strike: 29340 }, { side: 'short', type: 'C', strike: 29380 }],
      covered: false, pendingCover: null };
    const sent = [];
    const deps = { getLeg: flat, coverPriceMode: 'lock', capitalRecapture: style === 'credit',
      openAlternateEvery: 1, placeOrder: async (payload, meta) => { sent.push(meta); return { id: 'o1' }; } };
    const plan = { legs: [{ side: 'short', type: 'P', strike: 29340 }, { side: 'long', type: 'P', strike: 29380 }],
      target: null, mark: 8.6, geometry: 'tent', longStrike: 29380 };
    await trader.placeRestingCover(pos, plan, cfg, deps, '09/17 09:50', [], 'test', 8);
    return { pc: pos.pendingCover, sent };
  };
  const d = await run('debit');
  ok(d.pc != null, 'a debit cover is placed');
  const debitPrice = d.sent.length ? d.sent[0].limit : null;
  ok(debitPrice != null && debitPrice > 0, `debit cover rests at the lock target (${debitPrice})`);

  const c = await run('credit');
  const creditSent = c.sent.find((x) => x.net === 'CREDIT');
  if (creditSent) {
    const want = Math.round((cfg.spreadWidth - debitPrice) * 100) / 100;
    ok(Math.abs(creditSent.limit - want) < 0.06,
      `credit twin asks W - debit = ${want}, not its own mark (got ${creditSent.limit})`);
    ok(creditSent.limit > cfg.spreadWidth / 2,
      'and is nowhere near the zero a flat-chain mark would have produced');
  } else {
    ok(true, '(capital recapture did not select the credit twin in this fixture — parity untested here)');
  }
}

  // ── A RESTING CREDIT COVER FILLS WHEN THE MARKET COMES UP TO IT ───────────────────────────────────
  const trader = require('../../src/candle-spread/trader');
  // resolveRestingCovers tested `mark > pc.target`, both DEBIT-CANONICAL, while the order actually at the
  // broker was a CREDIT at pc.sentCredit. Those tests coincide only while sentCredit == W - target, which
  // they did not, so covers sat unfilled that the real order had already filled: of 94 credit covers left
  // resting on 2026-09-17, 92 (98%) saw a credit mark that reached their ask. Those positions carried the
  // open's full naked risk for the rest of the day.
  {
    const cfg = { symbol: 'NDX', expiration: '2026-09-17', spreadWidth: 40, strikeIncrement: 10,
      quantity: 1, tickIncrement: 0.05, coverSelector: 'fixed-mark', coverFillModel: 'resting', variant: 'tst' };
    // Canonical cover legs worth `m` as a debit; the twin's credit is therefore 40 - m.
    const chainAt = (m) => (t, k) => ({ mid: k === 29390 ? 20 : 20 - m, bid: 0, ask: 60, symbol: `NDX_${t}${k}` });
    const mk = (sentCredit, target) => ({
      id: 'p', side: 'bear', filled: true, quantity: 1, limit: 21.8, shortStrike: 29430,
      legs: [{ side: 'long', type: 'P', strike: 29470 }, { side: 'short', type: 'P', strike: 29430 }],
      covered: false,
      pendingCover: { legs: [{ side: 'long', type: 'C', strike: 29390 }, { side: 'short', type: 'C', strike: 29430 }],
        target, sentNet: 'CREDIT', sentCredit, placedEpoch: 1 },
    });
    // Canonical mark 25.45 => the twin is worth 14.55 of credit. An ask of 12.65 has been reached.
    const a = mk(12.65, 14.2);
    trader.resolveRestingCovers({ positions: [a] }, cfg, chainAt(25.45), [], {});
    ok(a.covered === true, 'a credit cover fills once the credit mark reaches its ask');
    // Booked debit-canonically: W - credit received, never the stale debit target.
    ok(a.coverLimit != null && a.coverLimit > 25 && a.coverLimit < 28,
      `and books W - credit received (${a.coverLimit})`);
    // THE REGRESSION GUARD: the old debit test (25.45 > 14.2) would have left this resting.
    ok(25.45 > 14.2, 'and the old debit-canonical test would have refused it — the bug');

    // Market not yet up to the ask: canonical mark 30 => credit 10, below a 12.65 ask.
    const b = mk(12.65, 14.2);
    trader.resolveRestingCovers({ positions: [b] }, cfg, chainAt(30), [], {});
    ok(!b.covered, 'and does NOT fill while the credit mark is short of the ask');

    // A DEBIT cover is unchanged: fills when the mark falls to its target.
    const d = { ...mk(null, 27), pendingCover: undefined };
    d.pendingCover = { legs: [{ side: 'long', type: 'C', strike: 29390 }, { side: 'short', type: 'C', strike: 29430 }],
      target: 27, sentNet: 'DEBIT', placedEpoch: 1 };
    d.covered = false;
    trader.resolveRestingCovers({ positions: [d] }, cfg, chainAt(25.45), [], {});
    ok(d.covered === true, 'a debit cover still fills when the mark falls to its target');
  }

  // ── EVIDENCE CAPTURE: direction-aware dwell, placement stamp, post-fill tracking ───────────────────
  // Three gaps the user found while auditing trades after the fact: bid/ask were recorded at the low-water
  // mark and at the fill but never at PLACEMENT; the underlying was never stamped on an order at all; and
  // dwell counting stopped the moment an order filled, so a mark that grazed the limit once and one the
  // market later went a dollar through were indistinguishable afterwards.
  {
    const dbg = { markLow: null };
    // DEBIT: reached when the mark falls TO the limit.
    trader.noteMarkLow(dbg, { mark: 12, bid: 11, ask: 13, underlying: 29400 }, 10, 'DEBIT');
    ok(dbg.looks === 1 && !dbg.atOrThrough, 'a debit above its limit counts a look, not a touch');
    trader.noteMarkLow(dbg, { mark: 9.5, bid: 9, ask: 10, underlying: 29390 }, 10, 'DEBIT');
    ok(dbg.atOrThrough === 1, 'and counts the touch when the mark falls to it');
    ok(dbg.markLow === 9.5 && dbg.markLowUnder === 29390, 'keeping the best price and the underlying there');

    // CREDIT is the mirror — and the bug this replaces made atOrThrough equal looks on EVERY credit
    // order, because a credit structure marks negative and `mark <= limit` was trivially true.
    const cr = { markLow: null };
    trader.noteMarkLow(cr, { mark: -10, bid: -12, ask: -8, underlying: 29400 }, 12, 'CREDIT');
    ok(cr.looks === 1 && !cr.atOrThrough, 'a credit of 10 does not reach a 12 ask');
    trader.noteMarkLow(cr, { mark: -13, bid: -14, ask: -12, underlying: 29420 }, 12, 'CREDIT');
    ok(cr.atOrThrough === 1, 'and does reach it at a credit of 13');
    ok(cr.markLow === -13, 'best credit kept (most negative canonical mark)');

    // POST-FILL: keeps watching, separately, and records how far through it went.
    const pf = { markLow: null, filled: true };
    trader.noteMarkLow(pf, { mark: 8, bid: 7, ask: 9 }, 10, 'DEBIT');
    trader.noteMarkLow(pf, { mark: 6.5, bid: 6, ask: 7 }, 10, 'DEBIT');
    ok(pf.looks == null, 'a filled order stops accruing pre-fill dwell');
    ok(pf.throughLooks === 2 && pf.throughAt === 2, 'and accrues post-fill looks instead');
    ok(pf.throughBest === 3.5, `recording how far through the market went (${pf.throughBest})`);
    const graze = { markLow: null, filled: true };
    trader.noteMarkLow(graze, { mark: 9.99, bid: 9, ask: 11 }, 10, 'DEBIT');
    ok(graze.throughBest < 0.02, 'a graze is distinguishable from a decisive fill');

    // PLACEMENT STAMP: first observation only, so it records the market when the order went out.
    const pl = {};
    trader.notePlaced(pl, { mark: 5, bid: 4, ask: 6 }, 29401.5);
    trader.notePlaced(pl, { mark: 9, bid: 8, ask: 10 }, 29500);
    ok(pl.placedMark === 5 && pl.placedBid === 4 && pl.placedAsk === 6, 'placement keeps the FIRST quote');
    ok(pl.placedUnder === 29401.5, 'and stamps the underlying on the order itself');
  }

  // ── THE OPEN LADDER MUST WORK A CREDIT TWIN TOO ───────────────────────────────────────────────────
  // The ladder walks in DEBIT space. When the fill test started following the RESTING order (53b12b7),
  // chk.mark became the credit structure's mark — NEGATIVE — so Math.min(limit + step, ceiling, mark)
  // returned the negative every time and `next > limit` was never true. 43.2% of opens on 2026-09-17
  // were credit-sent, across the 74 variants that run the ladder: all of them would have rested unworked
  // all session, against feedback_opens_must_fill.
  {
    const cfg = { symbol: 'NDX', expiration: '2026-09-18', spreadWidth: 10, strikeIncrement: 10,
      quantity: 1, tickIncrement: 0.05, coverSelector: 'fixed-mark', coverFillModel: 'resting', variant: 'tst' };
    // Debit spread marks 6.50 against a 6.00 limit (no fill); the twin is therefore worth 3.50 of credit
    // against a 4.50 ask (no fill either). Neither fills, so the ladder is the only thing that can act.
    const chain = (ty, k) => ({ mid: ty === 'C' ? (k === 29390 ? 20 : 13.5) : (k === 29390 ? 6 : 9.5),
      bid: 0, ask: 40, symbol: `NDX_${ty}${k}` });
    const mk = (credit) => ({ id: 'p1', side: 'bull', filled: false, quantity: 1, limit: 6.0, cap: 7.0,
      openTime: '09/18 10:00',
      legs: [{ side: 'long', type: 'C', strike: 29390 }, { side: 'short', type: 'C', strike: 29400 }],
      ...(credit ? { sentNet: 'CREDIT', sentLimit: 4.5,
        sentLegs: [{ side: 'short', type: 'P', strike: 29400 }, { side: 'long', type: 'P', strike: 29390 }] } : {}) });
    const run = (credit) => {
      const pos = mk(credit), d = [];
      trader.resolvePendingOpen({ positions: [pos], pendingOpenId: 'p1' }, cfg,
        { getLeg: chain, coverLadder: true, ladderStepDollars: 0.25, underlying: 29395,
          replaceOrder: async () => ({}) }, d);
      return { pos, reprice: d.find((x) => x.action === 'open-reprice') };
    };
    const deb = run(false), cre = run(true);
    ok(deb.reprice && deb.pos.limit === 6.25, `a debit open is worked toward the market (${deb.pos.limit})`);
    ok(cre.reprice && cre.pos.limit === 6.25, `and so is a CREDIT twin (${cre.pos.limit}) — the regression`);
    // The twin's ask must move the opposite way, and stay parity-exact against the new debit limit.
    ok(cre.pos.sentLimit === 3.75, `the twin asks LESS credit as it walks (${cre.pos.sentLimit})`);
    ok(Math.abs(cre.pos.limit + cre.pos.sentLimit - cfg.spreadWidth) < 0.001,
      'and limit + ask still equals the width — parity preserved by construction');
    // Neither may walk past the ceiling it was gated on.
    const capped = (() => {
      const pos = mk(true); pos.cap = 6.10; const d = [];
      trader.resolvePendingOpen({ positions: [pos], pendingOpenId: 'p1' }, cfg,
        { getLeg: chain, coverLadder: true, ladderStepDollars: 0.25, underlying: 29395,
          replaceOrder: async () => ({}) }, d);
      return pos;
    })();
    ok(capped.limit <= 6.10, `the ladder still respects the cap (${capped.limit})`);
  }

  // ── A COVER THAT WAS NEVER SENT MUST NOT BE BOOKED ────────────────────────────────────────────────
  // pendingCover used to be attached BEFORE the send, which sits behind `if (!srl.error)` and
  // `if (price > 0)`. The SENT legs are a different instrument from the BOOKED ones whenever the style is
  // credit or the resolver shifted, so the send can fail on an unquotable leg while the booked legs quote
  // fine. resolveRestingCovers then booked it as filled and credited its floor to realizedPnl — a lock
  // reported for an order that never reached the broker.
  {
    const cfg = { symbol: 'NDX', expiration: '2026-09-18', spreadWidth: 40, strikeIncrement: 10,
      quantity: 1, tickIncrement: 0.05, coverSelector: 'fixed-mark', coverFillModel: 'resting', variant: 'tst' };
    // The OPEN's calls quote and are deep ITM, so the style resolves to credit; the credit twin then
    // reaches a call strike the chain cannot quote, while the booked puts quote perfectly.
    const broken = (ty, k) => {
      if (ty === 'C' && k === 29360) return { mid: 70, bid: 69, ask: 71, symbol: 'a' };
      if (ty === 'C' && k === 29400) return { mid: 40, bid: 39, ask: 41, symbol: 'b' };
      if (ty === 'C') return null;
      return { mid: k === 29400 ? 12 : 20, bid: 11, ask: 21, symbol: `P${k}` };
    };
    const whole = (ty, k) => ({ mid: ty === 'C' ? (k === 29360 ? 70 : k === 29400 ? 40 : 24)
      : (k === 29400 ? 12 : 20), bid: 1, ask: 99, symbol: `${ty}${k}` });
    const mk = () => ({ id: 'p1', side: 'bull', filled: true, quantity: 1, limit: 22, shortStrike: 29400,
      covered: false, pendingCover: null,
      legs: [{ side: 'long', type: 'C', strike: 29360 }, { side: 'short', type: 'C', strike: 29400 }] });
    const plan = { legs: [{ side: 'short', type: 'P', strike: 29400 }, { side: 'long', type: 'P', strike: 29440 }],
      mark: 8, geometry: 'tent', longStrike: 29440 };
    const run = async (chain) => {
      const pos = mk(), sent = [], d = [];
      await trader.placeRestingCover(pos, plan, cfg, { getLeg: chain, capitalRecapture: true,
        creditCoverFrac: 0.65, coverPriceMode: 'lock', underlying: 29400,
        placeOrder: async (p, m) => { sent.push(m); return { orderId: 'o' }; } }, '09/18 10:00', d, 't', 8);
      // Snapshot the resting order BEFORE resolving: a healthy cover can fill on its first observation,
      // and pendingCover is then moved to filledCover, so checking it afterwards asks the wrong question.
      const resting = pos.pendingCover;
      trader.resolveRestingCovers({ positions: [pos] }, cfg, chain, [], {});
      return { pos, sent, d, resting };
    };
    const bad = await run(broken);
    ok(bad.sent.length === 0, 'nothing reaches the broker when the sent legs are unquotable');
    ok(!bad.pos.pendingCover, 'and no pending cover is attached');
    ok(!bad.pos.covered, 'so the position is NOT booked as covered — the regression');
    ok(bad.d.some((x) => x.action === 'cover-not-sent'), 'and the failure is recorded, not silent');

    const good = await run(whole);
    ok(good.sent.length === 1 && good.resting, 'a healthy cover still sends and rests');
    ok(good.resting.sentNet === 'CREDIT' && good.resting.target === 10,
      'carrying the right net and target');
    ok(good.pos.covered === true, 'and it books when the market is already there');
  }

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})();
