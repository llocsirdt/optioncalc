'use strict';
/**
 * NAMED START-OF-DAY SETUPS — "does today look like a day a particular strategy is built for?"
 *
 * These come out of the regime study (scripts/candle-spread/classify-regimes.js and mine-regime-rules.js).
 * The one durable mechanism behind them: **v7 is structurally LONG the day's movement and v4 is
 * structurally SHORT it** — Spearman rho of daily P&L against |close-open| is +0.49 for v7-10 and -0.31
 * for v4-20. So picking between those families is a MAGNITUDE question, never a direction question, and a
 * setup is worth surfacing only if it says something about how far the market is likely to travel.
 *
 * WHAT THESE ARE NOT. They are not signals and they do not place, size, or block a single order — the
 * engine never reads this module. They are a heads-up in the UI so a human can see a studied condition
 * appear in real time and judge it against the live result. n=24 over three years is not a mandate.
 *
 * HONESTY REQUIREMENTS baked into every entry below, because a green badge is exactly the kind of thing
 * that gets trusted more than its evidence warrants:
 *   - `n` and `firesPct` travel with the setup, so a 3.4%-of-days rule can never look like a daily edge.
 *   - `evidence` states the MEASURED effect and its p-value, and `caveat` states what failed or is
 *     untested. BIG_MOVE's directional reading was the user's original hypothesis and it was WRONG —
 *     that correction is carried in the text rather than quietly dropped.
 *   - Anything not yet validated out of sample says so.
 */

// Where the close sits inside the Bollinger band, as a fraction: 0 = at the lower band, 1 = at the upper.
// Values outside [0,1] mean the price closed beyond the band.
function pctB(price, lower, upper) {
  if (lower == null || upper == null || !(upper > lower)) return null;
  return (price - lower) / (upper - lower);
}

/**
 * @param daily ascending array of {datetime, open, high, low, close, bbUpper, bbMiddle, bbLower, ema9}.
 *   The LAST entry must be the most recent COMPLETED day — never today's forming candle, or the setup
 *   would be reading the future it is supposed to anticipate.
 */
function evaluate(daily) {
  if (!Array.isArray(daily) || daily.length < 2) return { ok: false, reason: 'insufficient daily history', setups: [] };
  const pd = daily[daily.length - 1];
  if (pd.bbUpper == null || pd.bbLower == null) return { ok: false, reason: 'daily bands not warm', setups: [] };

  const range = pd.high - pd.low;
  const body = Math.abs(pd.close - pd.open);
  const bodyFrac = range > 0 ? body / range : 0;
  const green = pd.close > pd.open;
  const lowPctB = pctB(pd.low, pd.bbLower, pd.bbUpper);      // <= 0 means the low pierced the lower band
  const closePctB = pctB(pd.close, pd.bbLower, pd.bbUpper);

  const setups = [];

  // BIG MOVE — the only rule that survived a clustering-preserving rotation null. The user's original
  // framing was "green day off the lower band is followed by a green TREND day"; the direction half is
  // wrong (41.7% green next day against a 54.8% base rate — it leans red). What it actually marks is a
  // day that MOVES, and that is what makes it a v7 signal rather than a directional one.
  // THRESHOLD IS `<= 0` — the low must actually REACH or pierce the band, not merely approach it. The
  // study's threshold ladder is explicit that n=24 / +$5,468 belongs to `<= 0`; at `<= 0.10` the rule
  // fires on 38 days for +$2,469. Porting it at 0.10 would have attached the strong evidence to a much
  // weaker rule — caught by checking the shipped module's firing rate against the study's count.
  if (green && lowPctB != null && lowPctB <= 0) {
    setups.push({
      key: 'BIG_MOVE', label: 'Big-move setup', favors: ['v7-10', 'v7-20', 'v9-20'],
      why: 'prior day closed green with its low at the lower daily band',
      expect: 'a LARGE move today, direction unknown — favours the bidirectional (v7/v9) families',
      evidence: 'n=24 of 704 days: next-day |close-open| 290.7 pts vs 132.0 base (2.2x, rotation p 0.0028); '
        + 'v7-20 +$5,468/day above its own average (p 0.0085); v4-20 -$54 (nothing)',
      caveat: 'NOT a direction call — next day is green only 41.7% vs a 54.8% base rate, so it leans '
        + 'slightly RED if anything. n=24 and never tested out of sample. The v7 dollar figure does not '
        + 'clear the strict 5-hypotheses x 6-variants bar (0.0017); the magnitude result is the clean one.',
      n: 24, firesPct: 3.4, strength: 'strong', tested: 'in-sample only',
      detail: `low pctB ${lowPctB.toFixed(3)} (<= 0 = touched the band), body ${(bodyFrac * 100).toFixed(0)}% of range`,
    });
  }

  // QUIET DAY — the mirror image, and the reason it is here at all: it points the OTHER way, at v4.
  // Its market claim (a smaller day follows) clears the bar; its P&L cells do not yet, so it is flagged
  // as weaker rather than presented as an equal.
  // bodyFrac >= 0.62 approximates the study's top-tercile "large body" split: it reproduces the measured
  // firing count (89 of 704 there; ~92 of 745 here on a slightly longer warm window).
  if (green && bodyFrac >= 0.62 && closePctB != null && closePctB > 0.50 && closePctB <= 1.0) {
    setups.push({
      key: 'QUIET_DAY', label: 'Quiet-day setup', favors: ['v4-20', 'v4-10'],
      why: 'prior day was a large green body closing between the band midline and the upper band',
      expect: 'a SMALLER move today — the range-averse (v4) family suffers least',
      evidence: 'n=89 of 704 days: next-day |close-open| 89.0 pts vs 132.0 base (-33%, rotation p 0.0071); '
        + 'v7-20 -$1,017/day, v4-20 +$337 — the only variant up',
      caveat: 'The market effect clears the bar; the P&L cells do NOT under the rotation null, so treat '
        + 'this as a statement about the DAY, not yet a validated variant switch. The original directional '
        + 'claim (next day green) is dead: 56.2% vs a 54.8% base rate is nothing.',
      n: 89, firesPct: 12.6, strength: 'moderate', tested: 'in-sample only',
      detail: `body ${(bodyFrac * 100).toFixed(0)}% of range, close pctB ${closePctB.toFixed(3)}`,
    });
  }

  return {
    ok: true,
    asOf: pd.datetime || null,
    priorDay: { open: pd.open, high: pd.high, low: pd.low, close: pd.close, green,
      bodyFrac: Math.round(bodyFrac * 1000) / 1000,
      lowPctB: lowPctB == null ? null : Math.round(lowPctB * 1000) / 1000,
      closePctB: closePctB == null ? null : Math.round(closePctB * 1000) / 1000 },
    setups,
  };
}

module.exports = { evaluate, pctB };
