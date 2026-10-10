'use strict';
// CANDLE GIVE-UP TRIGGER (2026-10-10) — the user's real exit rule, shared by the live trader and the backtest so
// both judge the same candles the same way:
//
//   "give up if a 15 min candle closes opposite trend or two 5 min candles in a row opposite trend (this matters
//    when the two candles span the last 5 min of one 15 min bar and the first 5 min of the next bar)."
//
// "Opposite", in the user's words, is a REVERSAL candle, judged on the /NQ signal series:
//   'break'  — breaks the prior candle's low WITHOUT breaking its high (reversal of a bull trend); breaks the
//              prior high without breaking the low (reversal of a bear trend). An outside bar is not a reversal.
//   'bbIn'   — closed outside a Bollinger band, now closes back inside it with an opposite-colour candle
//              (bull: prior close above the upper band, this one red and back under it).
//   'ema'    — an opposite-colour candle closes across the EMA (bull: red, prior close >= ema, this close < ema).
//   'mid'    — the same across the Bollinger midline.
//
// TWO 5m IN A ROW is a ROLLING pair: it is judged on every 5m close against the previous 5m close, regardless of
// where 15m boundaries fall — the user's point about a pair spanning two 15m bars.
//
// A fired side means "positions on this side should give up": `bull` = a reversal AGAINST bull positions.

const red = (c) => c.close < c.open;
const green = (c) => c.close > c.open;

// Is `cur` (vs `prev`) a reversal against each side?
function against(kind, cur, prev) {
  if (!cur || !prev) return { bull: false, bear: false };
  switch (kind) {
    case 'break':
      return { bull: cur.low < prev.low && cur.high <= prev.high, bear: cur.high > prev.high && cur.low >= prev.low };
    case 'bbIn':
      return { bull: red(cur) && prev.close > prev.bbupper && cur.close <= cur.bbupper,
        bear: green(cur) && prev.close < prev.bblower && cur.close >= cur.bblower };
    case 'ema':
      return { bull: red(cur) && prev.close >= prev.ema && cur.close < cur.ema,
        bear: green(cur) && prev.close <= prev.ema && cur.close > cur.ema };
    case 'mid':
      return { bull: red(cur) && prev.close >= prev.bbmiddle && cur.close < cur.bbmiddle,
        bear: green(cur) && prev.close <= prev.bbmiddle && cur.close > cur.bbmiddle };
    default:
      return { bull: false, bear: false };
  }
}

/**
 * One closed 5m bar. Mutates `state` (persist it between bars).
 * @param state  {} on the first call
 * @param kind   'break' | 'bbIn' | 'ema' | 'mid'
 * @param a5     the 5m candle that just closed (open/high/low/close/bbupper/bbmiddle/bblower/ema)
 * @param a15    the 15m candle IF one closed on this bar, else null
 * @returns { bull, bear, why } — which side's positions should give up now, and why (for the log)
 */
function step(state, kind, a5, a15) {
  const out = { bull: false, bear: false, why: null };
  const s5 = against(kind, a5, state.prev5);
  const last = state.last5 || { bull: false, bear: false };
  if (s5.bull && last.bull) { out.bull = true; out.why = `two 5m ${kind} reversals`; }
  if (s5.bear && last.bear) { out.bear = true; out.why = `two 5m ${kind} reversals`; }
  if (a15) {
    const s15 = against(kind, a15, state.prev15);
    if (s15.bull) { out.bull = true; out.why = `15m ${kind} reversal`; }
    if (s15.bear) { out.bear = true; out.why = `15m ${kind} reversal`; }
    state.prev15 = { ...a15 };
  }
  state.last5 = s5;
  state.prev5 = { ...a5 };
  return out;
}

const KINDS = ['break', 'bbIn', 'ema', 'mid'];
module.exports = { step, against, KINDS };
