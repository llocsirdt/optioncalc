'use strict';
/**
 * BB FADE (v20 / v21, 2026-10-21; LIVE as SIMULATE-ONLY opens-only families since 2026-10-23).
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
 * The OPENS-ONLY families (the rostered v20 / v21, user 2026-10-21) take the pure fade, bbFadeSignal(null): no parent,
 * so no signal cover. That ONE function object (OPENS_ONLY_SIGNAL) is the roster's signalFn, so the live trader, the
 * baselines build and the sweep all call the same code.
 *
 * bbFadeTrace: what the signal saw on each candle (inputs + both triggers), recorded by the live trader for the debug
 * page. Observation only — `fired` is read from bbFadeSide itself, so the trace cannot disagree with the decision.
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

const OPENS_ONLY_SIGNAL = bbFadeSignal(null);

// SIGNAL TRACE (signal-trace.js shape) — every condition of both triggers, on the same inputs.
const r2 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
function bbFadeTrace(A, prior, ctx = {}) {
  const c5 = A && A['5m'], c15 = A && A['15m'], c60 = A && A['60m'];
  const out = { family: 'bb-fade', stage: ctx.isFifteen === false ? '5m' : '15m',
    held: { bull: !!ctx.heldBull, bear: !!ctx.heldBear }, inputs: {}, triggers: [], fired: null, firedAll: [] };
  if (!c5 || !c15 || !c60 || c5.close == null) { out.reason = 'no-bands'; return out; }
  const band = (c) => ({ close: r2(c.close), open: r2(c.open), high: r2(c.high), low: r2(c.low), mid: r2(c.bbmiddle), ema: r2(c.ema),
    upper: r2(c.bbupper), lower: r2(c.bblower), green: c.close >= (c.open != null ? c.open : c.close) });
  out.inputs = { c5: band(c5), c15: band(c15), c60: band(c60),
    note: '15m / 60m = the last COMPLETED bar at this 5m close (no developing bar)' };
  const x = c5.close, P = (name, ok, value) => ({ name, ok: !!ok, value: value == null ? undefined : value });
  const side = bbFadeSide(A);
  out.triggers.push({ id: 'bb-fade-bull', label: '5m close below BOTH the 15m and 60m lower bands -> bull', side: 'bull', enabled: true,
    active: side === 'bull', parts: [P('5m close < 15m lower', c15.bblower != null && x < c15.bblower, r2(c15.bblower)),
      P('5m close < 60m lower', c60.bblower != null && x < c60.bblower, r2(c60.bblower))] });
  out.triggers.push({ id: 'bb-fade-bear', label: '5m close above BOTH the 15m and 60m upper bands -> bear', side: 'bear', enabled: true,
    active: side === 'bear', parts: [P('5m close > 15m upper', c15.bbupper != null && x > c15.bbupper, r2(c15.bbupper)),
      P('5m close > 60m upper', c60.bbupper != null && x > c60.bbupper, r2(c60.bbupper))] });
  out.fired = side ? `bb-fade-${side}` : null;
  out.firedAll = side ? [out.fired] : [];
  out.reason = side ? `bb-fade-${side}` : 'neutral';
  return out;
}

module.exports = { bbFadeSide, bbFadeSignal, bbFadeTrace, OPENS_ONLY_SIGNAL };
