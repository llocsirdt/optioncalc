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

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
