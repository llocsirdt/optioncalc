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
  v8: { name: 'proactive', what: 'v6 signal with proactive covering. (Its $3,000 at-risk "churn" cap was turned off 2026-10-14.)',
    open: 'v6\'s.', cover: 'v6\'s, plus a cover on any position marking >= 70% of the width.' },
  v9: { name: 'be-wrong + proactive', what: 'v7 signal with proactive covering.',
    open: 'v7\'s.', cover: 'v7\'s, plus a cover on any position marking >= 80% of the width.' },
  // FEATURE-TEST FAMILIES (user, 2026-10-19): a complete copy of the parent family with ONE feature added, named
  // v<parent><tag>. Everything not stated here is the parent's.
  v9sg: { name: 'v9 + stack gate', what: 'v9 with a stack gate: no adding to a side while the NQ trend points against it.',
    open: 'v9\'s, except an ADD (the side already holds an uncovered position) is skipped while the NQ 15m or 60m trend '
      + '(5m close vs that timeframe\'s 9 EMA, confirmed by the candle) points against the side. First opens are never gated.',
    cover: 'v9\'s.' },
  v9ob: { name: 'v9 + open block', what: 'v9 that never opens against the trend.',
    open: 'v9\'s, except an open against trend A (15m structural trend agreeing with the last completed hourly candle) is dropped.',
    cover: 'v9\'s (a dropped open\'s cover side still acts).' },
  // NATURAL COVER (2026-10-17 backtest ef8b80c; live SIMULATE-ONLY 2026-10-23). v6 with the book protected by OPENS
  // instead of per-position covers; every rule in natural-cover.js (shared by the live trader and the backtest).
  v12: { name: 'natural cover', what: 'v6 opens, no per-position covers: the book is protected by reversal-opens (REVs) at the '
      + 'prior short strike and a jump guard. Simulate-only — runs to be watched, not traded.',
    open: 'v6\'s. An ADD (the side already holds a live position) needs the NQ 15m candle at its outer band, max 3 adds a side. '
      + 'A REV opens the other side when the book\'s bias side touched an outer band (NDX RTH 5m or NQ 60m), its last open is '
      + '<= 30 min old and the zigzag run (20 pt, NDX 1m) is >= 40 pt (60 without a band/EMA line at the extreme); struck at '
      + 'the paired position\'s short, pair + REV <= 1.15 W. Jump guard: book mark at spot +- the 15-min p95 move through '
      + '-lossMax opens the protective vertical.',
    cover: 'None per position (no continuous, signal, proactive or cover-to-stack cover). A filled REV marks its pair offset. '
      + 'Hedges (floor raise, wings, offsets) and the governor are v6\'s.',
    shared: 'Shared with v6: day-loss governor, placement G, open ladder, floor raise / wings / offsets, late-day guard. '
      + 'Not used: continuous covers, give-up and stall cover (they act on covers, of which there are none).' },
  v13: { name: 'natural cover + late covers', what: 'v12 plus the roster\'s continuous cover, placed only once a live position is '
      + '30 minutes old. Simulate-only — runs to be watched, not traded.',
    open: 'v12\'s (REVs, ADD gate, jump guard).',
    cover: 'v6\'s continuous cover + ladder, only on a position that is not offset by a REV, not a guard, and >= 30 min since '
      + 'its fill. No signal, proactive or cover-to-stack covers.',
    shared: 'Shared with v6: day-loss governor, placement G, open ladder, continuous cover + ladder / give-up / stall cover on '
      + 'the covers it does place (after 30 min), floor raise / wings / offsets, late-day guard.' },
  // OPENS-ONLY BB FADE (2026-10-21 backtest; live SIMULATE-ONLY 2026-10-23). None of the shared machinery below applies.
  v20: { name: 'BB fade, opens only', what: 'Fades a 5-minute close beyond both the 15m and 60m Bollinger bands; opens only, '
      + 'every position held to the close. Simulate-only — runs to be watched, not traded.',
    open: '5m /NQ close below BOTH the last completed 15m and 60m lower BB(20,2) -> bull; above both uppers -> bear. '
      + 'Strikes as v9 (placement G; centred on -cATM).',
    cover: 'None: no covers, hedges, give-up or floor guards; settled at the 16:00 NDX close.',
    shared: 'Kept: day-loss cap on opens (none on -unc), the open walk ladder (one working open, cancelled on a reversal, '
      + 're-struck after 10 min at its cap), the leg ledger, the 09:30-15:55 action window. Nothing else.' },
  v21: { name: 'BB fade, opens only, priced strike', what: 'v20 with the strike chosen by price: the spread whose real mark '
      + 'is closest to f x width. Simulate-only — runs to be watched, not traded.',
    open: 'v20\'s signal; strike = the vertical priced closest to f x W (f = 0.50 / 0.55 / 0.60, the -fNN suffix), nearest '
      + 'the money on a tie; walked up to (f + v9 cap - 0.50) x W.',
    cover: 'None: no covers, hedges, give-up or floor guards; settled at the 16:00 NDX close.',
    shared: 'Kept: day-loss cap on opens (none on -unc), the open walk ladder (one working open, cancelled on a reversal, '
      + 're-struck after 10 min at its cap), the leg ledger, the 09:30-15:55 action window. Nothing else.' },
};
// Everything below the signal is shared by every strategy (see docs/strategies/README.md).
const SHARED = 'Shared by all: day-loss governor, placement G (deepest ITM inside a price band), open ladder, '
  + 'continuous covers + ladder, give-up, stall cover (15 min), late-day guard (15:00), floor raise (spreads first, 3:1; '
  + 'also the must-fix past the loss cap and peak-banking wings with an upside term).';

// v<n>[tag]-W[-cATM][-fNN][-unc] — e.g. v9-20-cATM, v9sg-10-unc, v20-40-cATM-unc, v21-10-f55-unc.
function describeVariant(variant) {
  const m = /^(v\d+[a-z]*)-(\d+)(-cATM)?(?:-f(\d+))?(-unc)?$/.exec(String(variant || ''));
  if (!m || !FAMILY[m[1]]) return null;
  const f = FAMILY[m[1]];
  const parts = [];
  if (m[4]) parts.push(`Price target f = ${(Number(m[4]) / 100).toFixed(2)}: the strike priced closest to ${(Number(m[4]) / 100).toFixed(2)} x W.`);
  if (m[3]) parts.push('Fixed-geometry control: strikes centred at the money instead of placement G.');
  if (m[5]) parts.push('Uncapped twin: no day-loss governor — shows what the cap costs; not a candidate to trade.');
  return { family: m[1], name: f.name, width: Number(m[2]), what: f.what, open: f.open, cover: f.cover,
    suffix: parts.length ? parts.join(' ') : null, shared: f.shared || SHARED,
    ...(m[4] ? { priceTarget: Number(m[4]) / 100 } : {}) };
}

module.exports = { FAMILY, describeVariant };
