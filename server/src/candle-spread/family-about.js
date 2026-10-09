'use strict';
// PLAIN-WORDS DESCRIPTION OF EACH STRATEGY, for the UI (compare page's backtest table: click a variant id).
// Served by the server with the runs index so the page stays presentation-only. Source of truth for the
// wording: docs/strategies/README.md (comparison table) and the per-family docs; keep the two in step.
const FAMILY = {
  v0: { name: 'classic tent', what: 'Classic 15-minute price-action breakout; the cover shares the short strike (a "tent").',
    open: '15m candle closes green and makes a new high -> bull; red and a new low -> bear.',
    cover: 'An opposite-colour 15m candle that failed to extend the prior extreme.' },
  v1: { name: 'classic halfway', what: 'v0, with the cover\'s short strike walked halfway to the underlying (a condor, not a tent).',
    open: 'As v0.', cover: 'As v0; cover geometry halfway.' },
  v2: { name: 'classic at-money', what: 'v0, with the cover\'s short strike at the underlying (widest cover; can give up the guaranteed floor).',
    open: 'As v0.', cover: 'As v0; cover geometry at the money.' },
  v3: { name: 'classic, risk-armed', what: 'v0 geometry, but the standing cover goes on only once armed (book risk or a cheap lock), not at birth.',
    open: 'As v0.', cover: 'As v0, plus continuous covering once armed.' },
  v4: { name: 'multi-timeframe', what: 'The discretionary multi-timeframe read: 1/5/15/60m Bollinger + 9 EMA confluence as support/resistance.',
    open: '15m closes: overextension reversal (closed back inside a band), grind top/bottom, or a gated trend continuation.',
    cover: 'Overextension/grind flip, or active cover into an opposing cluster of 3+ timeframes.' },
  v5: { name: 'trend-flip', what: 'v4 plus a trend-flip exit.',
    open: 'v4\'s signals.', cover: 'v4\'s, plus: when the 15m close and 9 EMA cross the midline against you, cover the book and take the new side.' },
  v6: { name: '5-minute', what: 'v5 acting every 5 minutes instead of only at 15m closes.',
    open: 'v5\'s at 15m closes; between them, flips on a 2-bar-confirmed 5m reversal the 15m agrees with.',
    cover: 'v5\'s, plus an early cover when the 5m trend turns against the held side for two bars.' },
  v7: { name: 'be-wrong', what: 'v6 that can be wrong without going flat: opens the opposite side while still holding, without covering the loser.',
    open: 'v6\'s, plus a "be-wrong" opposite open on a 15m reversal candle that breaks the prior extreme.',
    cover: 'v6\'s, per side: only the wrong-way side is covered.' },
  v8: { name: 'churn-capped', what: 'v6 signal with a fixed $3,000 at-risk "churn" cap (a same-side trend stack is exempt) and proactive covering.',
    open: 'v6\'s (subject to the churn cap).', cover: 'v6\'s, plus a cover on any position marking >= 70% of the width.' },
  v9: { name: 'be-wrong + proactive', what: 'v7 signal with proactive covering.',
    open: 'v7\'s.', cover: 'v7\'s, plus a cover on any position marking >= 80% of the width.' },
};
// Everything below the signal is shared by every strategy (see docs/strategies/README.md).
const SHARED = 'Shared by all: day-loss governor, placement G (deepest ITM inside a price band), open ladder, '
  + 'continuous covers + ladder, give-up, stall cover (15 min), late-day guard (15:00), floor raise (spreads first, 3:1; '
  + 'also the must-fix past the loss cap and peak-banking wings with an upside term).';

function describeVariant(variant) {
  const m = /^(v\d)-(\d+)(-(unc|cATM))?$/.exec(String(variant || ''));
  if (!m || !FAMILY[m[1]]) return null;
  const f = FAMILY[m[1]];
  const suffix = m[4] === 'unc' ? 'Uncapped twin: no day-loss governor — shows what the cap costs; not a candidate to trade.'
    : m[4] === 'cATM' ? 'Fixed-geometry control: strikes centred at the money instead of placement G.' : null;
  return { family: m[1], name: f.name, width: Number(m[2]), what: f.what, open: f.open, cover: f.cover, suffix, shared: SHARED };
}

module.exports = { FAMILY, describeVariant };
