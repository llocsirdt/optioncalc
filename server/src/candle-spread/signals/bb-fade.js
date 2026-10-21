'use strict';
/**
 * BB FADE (v20 / v21, 2026-10-21, BACKTEST ONLY — not in the live roster).
 *
 * OPEN SIGNAL, evaluated on EVERY 5m close (the /NQ 24h signal series, like every other family):
 *   5m close BELOW both the 15m lower band and the 60m lower band  -> open a BULL spread
 *   5m close ABOVE both the 15m upper band and the 60m upper band  -> open a BEAR spread
 *
 * Bands are the dataset's / live analysis-builder's BB(20,2) (population SD) on /NQ. `A['15m']` / `A['60m']` are the
 * MOST RECENTLY COMPLETED candle of that timeframe as of the 5m mark (analysis-builder.completedAsOf: start + period
 * <= T), so the band only uses data known at that 5m close — at 10:05 the 15m band is the 09:45-10:00 bar's, at 10:15
 * it is the 10:00-10:15 bar's (which closes on this very 5m close). No developing-bar read, no look-ahead.
 *
 * Everything AFTER the open stays the parent engine's: bbFadeSignal wraps the parent signal fn (v9 = v7Signal with
 * beWrong) and keeps its COVER output (trend-flip / 5m early cover / active cover), replacing only its open side.
 */

// 'bull' | 'bear' | null for one analysis snapshot A.
function bbFadeSide(A) {
  const c5 = A && A['5m'], c15 = A && A['15m'], c60 = A && A['60m'];
  if (!c5 || !c15 || !c60 || c5.close == null) return null;
  if (c15.bblower == null || c60.bblower == null || c15.bbupper == null || c60.bbupper == null) return null;
  const x = c5.close;
  if (x < c15.bblower && x < c60.bblower) return 'bull';
  if (x > c15.bbupper && x > c60.bbupper) return 'bear';
  return null;
}

// Wrap a parent signal fn (A, prior, ctx) -> { openSide, coverSide, ... }: covers from the parent, opens from the fade.
function bbFadeSignal(parentFn) {
  return function (A, prior, ctx) {
    const p = (parentFn && parentFn(A, prior, ctx)) || {};
    const side = bbFadeSide(A);
    return { ...p, openSide: side, reason: side ? `bb-fade-${side}` + (p.coverSide ? ` [cover ${p.coverSide}: ${p.reason}]` : '') : (p.reason || 'neutral') };
  };
}

module.exports = { bbFadeSide, bbFadeSignal };
