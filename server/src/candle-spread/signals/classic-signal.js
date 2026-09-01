'use strict';
// CLASSIC signal (the v0-v3 family). Pure price action on the 15m candle: open on a continuation breakout
// (green + new high → bull, red + new low → bear), cover on a confirmed reversal (opposite color that
// FAILED to extend the prior 15m extreme). No Bollinger gate — this is the simple baseline the multi-TF
// lineage (v4-v9) was built to beat; it clusters its worst days on DIFFERENT dates, so it diversifies.
// MUST stay byte-identical to scripts/candle-spread/backtest-v4.js classicSignal (parity-tested).
function classicSignal(A, prior, ctx) {
  const c = A['15m']; if (!c || c.close == null) return { openSide: null, cover: false };
  const green = c.close >= c.open;
  const held = ctx.heldDir;
  let cover = false;
  if (prior && prior['15m']) {
    const p = prior['15m'];
    if (held === 'bull' && !green && !(c.high > p.high)) cover = true;
    if (held === 'bear' && green && !(c.low < p.low)) cover = true;
  }
  let openSide = null;
  if (prior && prior['15m']) {
    const p = prior['15m'];
    if (green && c.high > p.high) openSide = 'bull';
    else if (!green && c.low < p.low) openSide = 'bear';
  }
  return { openSide, cover };
}

module.exports = { classicSignal };
