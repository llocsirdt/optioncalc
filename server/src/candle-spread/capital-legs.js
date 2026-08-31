'use strict';
/**
 * CAPITAL-RECAPTURE LEG CONSTRUCTION (debit/credit balancing) — the shared, verifiable foundation for
 * balancing net cash by alternating debit/credit OPENS and using credit COVERS on ITM winners, without
 * changing the strategy's P&L. Every position is a directional tent defined by (side, lo, hi, width) with
 * shortStrike = hi (bull) / lo (bear); this module only chooses WHICH legs (calls vs puts, long vs short)
 * express that exposure, so the CASH sign flips while the payoff (and Reg-T max-loss) stays put.
 *
 * Financial basis (0DTE NDX = European, cash-settled → no assignment, no early-exercise): a DEBIT vertical
 * and its put-call-parity CREDIT twin have identical settle payoff up to a box (=width) constant; the box
 * is exactly the extra cash the credit brings in, so at settle P&L is invariant. Proven numerically by the
 * self-test below (P&L equal across all representations at every settle price; only cash differs).
 *
 * Pure leg constructors + signed cash/risk accounting, pricing injected (legsMark for backtest, real chain
 * for live) so the SAME logic ports to the live trader. Run `node scripts/candle-spread/capital-legs.js`
 * to execute the parity + cash self-test.
 */

// --- Leg constructors ------------------------------------------------------
// A bull tent spans [lo, hi] (hi = lo + width), shortStrike = hi. Bear mirrors: shortStrike = lo.
// OPEN, debit  : the classic long-vertical you PAY for.  OPEN, credit: its parity twin you RECEIVE for.
function openLegsFor(side, lo, hi, style) {
  if (side === 'bull') {
    return style === 'credit'
      ? [{ side: 'short', type: 'P', strike: hi }, { side: 'long', type: 'P', strike: lo }]   // bull put credit
      : [{ side: 'long', type: 'C', strike: lo }, { side: 'short', type: 'C', strike: hi }];   // bull call debit
  }
  return style === 'credit'
    ? [{ side: 'short', type: 'C', strike: lo }, { side: 'long', type: 'C', strike: hi }]       // bear call credit
    : [{ side: 'long', type: 'P', strike: hi }, { side: 'short', type: 'P', strike: lo }];      // bear put debit
}

// COVER legs that lock the tent to the canonical iron-fly floor. The lock adds a short at the shortStrike
// + a wing one width beyond, in the option type that (a) offsets the OPEN legs and (b) gives the desired
// cash sign. debit cover = you PAY (the classic tent); credit cover = you RECEIVE (butterfly/iron-fly),
// reclaiming cash on ITM winners. Same shortStrike regardless of how the position was opened.
function coverLegsFor(side, shortStrike, width, coverStyle) {
  if (side === 'bull') {
    return coverStyle === 'credit'
      ? [{ side: 'short', type: 'C', strike: shortStrike }, { side: 'long', type: 'C', strike: shortStrike + width }]
      : [{ side: 'short', type: 'P', strike: shortStrike }, { side: 'long', type: 'P', strike: shortStrike + width }];
  }
  return coverStyle === 'credit'
    ? [{ side: 'short', type: 'P', strike: shortStrike }, { side: 'long', type: 'P', strike: shortStrike - width }]
    : [{ side: 'short', type: 'C', strike: shortStrike }, { side: 'long', type: 'C', strike: shortStrike - width }];
}

// --- Signed cash + risk accounting -----------------------------------------
// entryMark(legs, mark) is the SIGNED net mark: >0 = a debit you PAY (cash out), <0 = a credit you RECEIVE
// (cash in). cashFlow is its negation (what hits the account: -debit / +credit). Both use the injected
// pricer `mark(type, strike) -> price`.
const legSum = (legs, price) => legs.reduce((v, l) => v + (l.side === 'long' ? 1 : -1) * price(l.type, l.strike), 0);
const entryMark = (legs, mark) => legSum(legs, (t, k) => mark(t, k));
const cashFlow = (legs, mark) => -entryMark(legs, mark);        // account cash delta: -paid / +received

// Intrinsic payoff at settle (0DTE), signed by long/short.
const payoff = (legs, settle) => legSum(legs, (t, k) => (t === 'C' ? Math.max(settle - k, 0) : Math.max(k - settle, 0)));

// Reg-T buying power a position ties up = its max loss = the entry debit minus the worst-case settle
// payoff (evaluated at every strike ± a width, which brackets a vertical/tent's piecewise-linear min).
// Same for a debit vertical and its credit twin — that's the whole point (cash flips, risk doesn't).
function maxLoss(legs, mark, width) {
  const em = entryMark(legs, mark);
  const strikes = legs.map(l => l.strike);
  const probes = [Math.min(...strikes) - width, ...strikes, Math.max(...strikes) + width];
  const minPayoff = Math.min(...probes.map(s => payoff(legs, s)));
  return Math.max(0, em - minPayoff);   // >=0 dollars of max loss (per 1x, ×100×qty for real $)
}

module.exports = { openLegsFor, coverLegsFor, entryMark, cashFlow, payoff, maxLoss };

// --- Parity + cash self-test -----------------------------------------------
if (require.main === module) {
  // Toy pricer: intrinsic + a symmetric time value so debit≈credit≈~half width at ATM (parity holds for
  // ANY arbitrage-free pricer; this one just makes the numbers concrete). tv peaks ATM, 0 deep ITM/OTM.
  const S = 100, W = 20;                       // spot, width
  const tv = k => 3 * Math.exp(-Math.abs(S - k) / 15);
  const mark = (type, k) => (type === 'C' ? Math.max(S - k, 0) : Math.max(k - S, 0)) + tv(k);
  const lo = 90, hi = 110;                     // a bull tent [90,110], shortStrike 110 (deep-ish so it's a winner)
  const settles = [70, 85, 90, 95, 100, 105, 110, 120, 135];
  let pass = 0, fail = 0;
  const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
  const r2 = x => Math.round(x * 100) / 100;

  // For each (side, openStyle, coverStyle) build the position, then assert its settle P&L equals the
  // canonical (debit open + debit cover) at EVERY settle price — proving the representations are P&L-identical.
  function pnlCurve(side, openStyle, coverStyle) {
    const L = side === 'bull' ? lo : lo, H = side === 'bull' ? hi : hi;
    const sStrike = side === 'bull' ? H : L;
    const oLegs = openLegsFor(side, L, H, openStyle);
    const cLegs = coverLegsFor(side, sStrike, W, coverStyle);
    const entry = entryMark(oLegs, mark) + entryMark(cLegs, mark);   // total signed cost
    return { curve: settles.map(s => r2(payoff(oLegs, s) + payoff(cLegs, s) - entry)),
             openCash: r2(cashFlow(oLegs, mark)), coverCash: r2(cashFlow(cLegs, mark)),
             risk: r2(maxLoss(oLegs, mark, W)) };
  }

  for (const side of ['bull', 'bear']) {
    const canon = pnlCurve(side, 'debit', 'debit');
    for (const openStyle of ['debit', 'credit']) {
      for (const coverStyle of ['debit', 'credit']) {
        const p = pnlCurve(side, openStyle, coverStyle);
        const same = p.curve.every((v, i) => Math.abs(v - canon.curve[i]) < 1e-6);
        ok(same, `${side} open:${openStyle} cover:${coverStyle} P&L != canonical\n   got ${p.curve}\n   exp ${canon.curve}`);
      }
    }
    // Cash direction: a debit OPEN drains (<0), a credit OPEN adds (>0); risk is identical for both.
    const dOpen = pnlCurve(side, 'debit', 'debit'), cOpen = pnlCurve(side, 'credit', 'debit');
    ok(dOpen.openCash < 0, `${side} debit open should drain cash (got ${dOpen.openCash})`);
    ok(cOpen.openCash > 0, `${side} credit open should add cash (got ${cOpen.openCash})`);
    ok(Math.abs(dOpen.risk - cOpen.risk) < 1e-6, `${side} debit vs credit open risk should match (${dOpen.risk} vs ${cOpen.risk})`);
    // Credit COVER should reclaim cash vs the debit cover (less paid / more received).
    const dCov = pnlCurve(side, 'debit', 'debit'), cCov = pnlCurve(side, 'debit', 'credit');
    ok(cCov.coverCash > dCov.coverCash, `${side} credit cover should reclaim cash vs debit cover (${cCov.coverCash} > ${dCov.coverCash})`);
    console.log(`${side}: canonical P&L curve @settles ${settles} = ${canon.curve}`);
    console.log(`   open cash debit=${dOpen.openCash} credit=${cOpen.openCash} | cover cash debit=${dCov.coverCash} credit=${cCov.coverCash} | risk=${dOpen.risk}`);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
