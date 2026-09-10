#!/usr/bin/env node
'use strict';
/**
 * candle-patterns-lab.js — a PURE, self-contained candlestick-pattern library for the open-only
 * entry-signal study (backtest-open-only.js).
 *
 * WHY A SECOND FILE. server/src/candle-spread/signals/candle-patterns.js already exists and is used
 * live by v4/v6/v7. It is deliberately NOT touched here: it exposes only three fuzzy aggregates
 * (isTopRejection / isBottomRejection / doji at bodyFrac<0.25) that were tuned for 15m confluence
 * gating, it has no hammer-vs-inverted-hammer distinction, and it has no piercing/dark-cloud/tweezer
 * at all. This module is the explicit, per-pattern, individually measurable set the study needs. It
 * is additive; nothing existing changes behaviour.
 *
 * EVERY THRESHOLD IS WRITTEN DOWN BELOW so the definitions can be checked by eye. Where a textbook
 * definition is unusable on a continuous 5-minute index-futures tape (patterns that require a true
 * overnight-style GAP, which /NQ essentially never prints intraday) the relaxation is stated
 * explicitly next to the rule.
 *
 * A candle is { open, high, low, close }. Every predicate takes (c, prior) and returns a boolean;
 * single-candle patterns ignore `prior`. All are pure — no I/O, no state, no config.
 *
 * Self-test:  node scripts/candle-spread/candle-patterns-lab.js --selftest
 */

// ── GEOMETRY ────────────────────────────────────────────────────────────────────────────────────
//   body      = |close − open|                    (the real body)
//   range     = high − low                        (the full bar)
//   upWick    = high − max(open, close)           (upper shadow)
//   loWick    = min(open, close) − low            (lower shadow)
//   *Frac     = the above as a fraction of range  (so every threshold is scale-free)
function parts(c) {
  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low;
  const upWick = c.high - Math.max(c.open, c.close);
  const loWick = Math.min(c.open, c.close) - c.low;
  const r = range > 0 ? range : 0;
  return {
    body, range, upWick, loWick,
    green: c.close > c.open, red: c.close < c.open,
    bodyFrac: r > 0 ? body / r : 0,
    upFrac: r > 0 ? upWick / r : 0,
    loFrac: r > 0 ? loWick / r : 0,
  };
}
// A bar with zero range (a perfectly flat 5m print) carries no shape information at all — every
// fraction would be 0/0. Such bars are rejected by every predicate rather than silently counted as
// dojis, which is what a naive bodyFrac<=t test would do.
const degenerate = (c) => !c || c.high == null || c.low == null || !(c.high - c.low > 0);

// ════════════════════════════════════════════════════════════════════════════════════════════════
// REQUIRED SET (the five the strategy spec names)
// ════════════════════════════════════════════════════════════════════════════════════════════════

// DOJI — indecision. Textbook: open and close are "virtually equal".
//   RULE: bodyFrac <= 0.10   (real body is at most 10% of the bar's range)
//    AND  upFrac <= 0.60  AND  loFrac <= 0.60          [the NEUTRALITY guard — see below]
// Direction-neutral by construction: the strategy lists doji in BOTH the bullish and bearish trigger
// sets, so it must not double-count a directional bar. The pure body test alone does not achieve
// that: a small-bodied hammer is also a body<=10% bar, and would then fire the BEAR trigger too. The
// neutrality guard keeps `doji` to the two-sided (long-legged / star) form and leaves the one-sided
// forms to hammer / shootingStar / dragonflyDoji / gravestoneDoji, which are measured separately.
// (Note: the pre-existing server module uses a much looser bodyFrac<0.25; 0.10 is the standard
// definition and is what is used here. The looser threshold is measured separately as `dojiLoose`,
// with the same guard, so the effect of the threshold alone is visible.)
function dojiAt(c, t) { const p = parts(c); return p.bodyFrac <= t && p.upFrac <= 0.60 && p.loFrac <= 0.60; }
function isDoji(c) { if (degenerate(c)) return false; return dojiAt(c, 0.10); }
function isDojiLoose(c) { if (degenerate(c)) return false; return dojiAt(c, 0.25); }

// HAMMER — bullish rejection of a low. Long lower shadow, small body at the TOP of the range,
// little or no upper shadow.
//   RULE: loFrac >= 0.50  AND  bodyFrac <= 0.33  AND  upFrac <= 0.15  AND  loWick >= 2 × body
// (the 2× body test is the classic "shadow at least twice the body"; the loFrac floor stops a
// zero-body bar from passing it trivially.)
function isHammer(c) {
  if (degenerate(c)) return false;
  const p = parts(c);
  return p.loFrac >= 0.50 && p.bodyFrac <= 0.33 && p.upFrac <= 0.15 && p.loWick >= 2 * p.body;
}

// INVERTED HAMMER / SHOOTING STAR — the mirror image: long upper shadow, small body at the BOTTOM
// of the range, little or no lower shadow. The two names are the same GEOMETRY at different
// locations (inverted hammer after a decline, shooting star after a rally); the strategy uses it
// only as the bearish trigger, so one predicate serves both.
//   RULE: upFrac >= 0.50  AND  bodyFrac <= 0.33  AND  loFrac <= 0.15  AND  upWick >= 2 × body
function isShootingStar(c) {
  if (degenerate(c)) return false;
  const p = parts(c);
  return p.upFrac >= 0.50 && p.bodyFrac <= 0.33 && p.loFrac <= 0.15 && p.upWick >= 2 * p.body;
}

// BULLISH ENGULFING — a down bar followed by an up bar whose real body covers the prior real body.
//   RULE: prior is RED (pc < po) with a real body (priorBodyFrac >= 0.10)
//         current is GREEN (c > o)
//         current.open <= prior.close  AND  current.close > prior.open
//         current body > prior body
// RELAXATION: textbook wants open STRICTLY below the prior close. A continuous futures tape opens
// each 5m bar at (or within a tick of) the previous close, so strict-< would make the pattern almost
// impossible; `<=` is used and stated here.
function isBullishEngulfing(c, prior) {
  if (degenerate(c) || degenerate(prior)) return false;
  const p = parts(c), pp = parts(prior);
  if (!p.green || !pp.red) return false;
  if (pp.bodyFrac < 0.10) return false;                 // engulfing a doji is not an engulfing
  return c.open <= prior.close && c.close > prior.open && p.body > pp.body;
}

// BEARISH ENGULFING — the mirror.
//   RULE: prior GREEN with a real body; current RED; open >= prior.close; close < prior.open;
//         current body > prior body.
function isBearishEngulfing(c, prior) {
  if (degenerate(c) || degenerate(prior)) return false;
  const p = parts(c), pp = parts(prior);
  if (!p.red || !pp.green) return false;
  if (pp.bodyFrac < 0.10) return false;
  return c.open >= prior.close && c.close < prior.open && p.body > pp.body;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// SECONDARY SET (implemented and measured SEPARATELY — never folded into the required aggregate)
// ════════════════════════════════════════════════════════════════════════════════════════════════

// DRAGONFLY DOJI — a doji whose whole range is BELOW the body: open ≈ close ≈ high.
//   RULE: bodyFrac <= 0.10  AND  loFrac >= 0.60  AND  upFrac <= 0.10          (bullish)
function isDragonflyDoji(c) {
  if (degenerate(c)) return false;
  const p = parts(c);
  return p.bodyFrac <= 0.10 && p.loFrac >= 0.60 && p.upFrac <= 0.10;
}
// GRAVESTONE DOJI — the mirror: open ≈ close ≈ low.
//   RULE: bodyFrac <= 0.10  AND  upFrac >= 0.60  AND  loFrac <= 0.10          (bearish)
function isGravestoneDoji(c) {
  if (degenerate(c)) return false;
  const p = parts(c);
  return p.bodyFrac <= 0.10 && p.upFrac >= 0.60 && p.loFrac <= 0.10;
}

// PIERCING LINE — bullish two-bar reversal: a solid down bar, then an up bar that opens at/below
// the prior close and closes back ABOVE the midpoint of the prior body but BELOW its open (a full
// close above the prior open would be an engulfing, not a piercing).
//   RULE: prior RED with priorBodyFrac >= 0.30
//         current GREEN
//         current.open <= prior.close                       [RELAXED — see below]
//         current.close > (prior.open + prior.close) / 2
//         current.close < prior.open
// RELAXATION: textbook requires the open below the prior LOW (a gap). Intraday /NQ does not gap, so
// "opens at or below the prior close" is used instead. Stated, not hidden.
function isPiercingLine(c, prior) {
  if (degenerate(c) || degenerate(prior)) return false;
  const p = parts(c), pp = parts(prior);
  if (!p.green || !pp.red || pp.bodyFrac < 0.30) return false;
  const mid = (prior.open + prior.close) / 2;
  return c.open <= prior.close && c.close > mid && c.close < prior.open;
}
// DARK CLOUD COVER — the bearish mirror of the piercing line.
//   RULE: prior GREEN with priorBodyFrac >= 0.30; current RED;
//         current.open >= prior.close; current.close < midpoint(prior body); current.close > prior.open
function isDarkCloudCover(c, prior) {
  if (degenerate(c) || degenerate(prior)) return false;
  const p = parts(c), pp = parts(prior);
  if (!p.red || !pp.green || pp.bodyFrac < 0.30) return false;
  const mid = (prior.open + prior.close) / 2;
  return c.open >= prior.close && c.close < mid && c.close > prior.open;
}

// TWEEZER BOTTOM — two consecutive bars that put in (essentially) the SAME low, the first red and
// the second green: the market probed the same level twice and refused it.
//   RULE: |low − prior.low| <= 0.10 × max(range, prior.range)     (matching within a tenth of a bar)
//         prior RED, current GREEN
//         both bars have a real range (degenerate bars excluded)
function isTweezerBottom(c, prior) {
  if (degenerate(c) || degenerate(prior)) return false;
  const p = parts(c), pp = parts(prior);
  if (!p.green || !pp.red) return false;
  const tol = 0.10 * Math.max(p.range, pp.range);
  return Math.abs(c.low - prior.low) <= tol;
}
// TWEEZER TOP — the mirror: matching highs, first green, second red.
function isTweezerTop(c, prior) {
  if (degenerate(c) || degenerate(prior)) return false;
  const p = parts(c), pp = parts(prior);
  if (!p.red || !pp.green) return false;
  const tol = 0.10 * Math.max(p.range, pp.range);
  return Math.abs(c.high - prior.high) <= tol;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// REGISTRY — one entry per pattern, with its DIRECTION. 'bull' / 'bear' / 'both' (doji only).
// The study enables an arbitrary SUBSET of these by key, so every pattern's contribution can be
// isolated instead of being buried in an aggregate.
// ════════════════════════════════════════════════════════════════════════════════════════════════
const PATTERNS = {
  // required set
  hammer:            { dir: 'bull', core: true,  fn: (c, p) => isHammer(c) },
  bullishEngulfing:  { dir: 'bull', core: true,  fn: (c, p) => isBullishEngulfing(c, p) },
  shootingStar:      { dir: 'bear', core: true,  fn: (c, p) => isShootingStar(c) },
  bearishEngulfing:  { dir: 'bear', core: true,  fn: (c, p) => isBearishEngulfing(c, p) },
  doji:              { dir: 'both', core: true,  fn: (c, p) => isDoji(c) },
  // secondary set — measured separately, NEVER part of `core`
  dojiLoose:         { dir: 'both', core: false, fn: (c, p) => isDojiLoose(c) },
  dragonflyDoji:     { dir: 'bull', core: false, fn: (c, p) => isDragonflyDoji(c) },
  gravestoneDoji:    { dir: 'bear', core: false, fn: (c, p) => isGravestoneDoji(c) },
  piercingLine:      { dir: 'bull', core: false, fn: (c, p) => isPiercingLine(c, p) },
  darkCloudCover:    { dir: 'bear', core: false, fn: (c, p) => isDarkCloudCover(c, p) },
  tweezerBottom:     { dir: 'bull', core: false, fn: (c, p) => isTweezerBottom(c, p) },
  tweezerTop:        { dir: 'bear', core: false, fn: (c, p) => isTweezerTop(c, p) },
};
const CORE = Object.keys(PATTERNS).filter(k => PATTERNS[k].core);
const ALL = Object.keys(PATTERNS);

// Which of `keys` fire on (c, prior), split by direction. A 'both' pattern (doji) lands in BOTH
// lists; the caller decides what to do when only a neutral pattern is present.
function fired(c, prior, keys) {
  const bull = [], bear = [];
  for (const k of keys) {
    const P = PATTERNS[k];
    if (!P || !P.fn(c, prior)) continue;
    if (P.dir === 'bull' || P.dir === 'both') bull.push(k);
    if (P.dir === 'bear' || P.dir === 'both') bear.push(k);
  }
  return { bull, bear };
}

module.exports = {
  parts, PATTERNS, CORE, ALL, fired,
  isDoji, isDojiLoose, isHammer, isShootingStar, isBullishEngulfing, isBearishEngulfing,
  isDragonflyDoji, isGravestoneDoji, isPiercingLine, isDarkCloudCover, isTweezerBottom, isTweezerTop,
};

// ── SELF-TEST ───────────────────────────────────────────────────────────────────────────────────
if (require.main === module && process.argv.includes('--selftest')) {
  let pass = 0, fail = 0;
  const t = (name, got, want) => { if (got === want) { pass++; } else { fail++; console.log(`  FAIL ${name}: got ${got} want ${want}`); } };
  const C = (o, h, l, c) => ({ open: o, high: h, low: l, close: c });

  // hammer: range 100, body 5 at the top, lower shadow 90, upper shadow 5
  const hammer = C(100.90, 101.00, 100.00, 100.95);
  t('hammer/isHammer', isHammer(hammer), true);
  t('hammer/isShootingStar', isShootingStar(hammer), false);
  // shooting star: mirror
  const star = C(100.05, 101.00, 100.00, 100.10);
  t('star/isShootingStar', isShootingStar(star), true);
  t('star/isHammer', isHammer(star), false);
  // a big solid green bar is neither
  const solid = C(100.00, 101.00, 100.00, 101.00);
  t('solid/isHammer', isHammer(solid), false);
  t('solid/isShootingStar', isShootingStar(solid), false);
  t('solid/isDoji', isDoji(solid), false);
  // doji: body 0.05 of a 1.00 range, wicks both sides
  const doji = C(100.50, 101.00, 100.00, 100.52);
  t('doji/isDoji', isDoji(doji), true);
  t('doji/isDragonfly', isDragonflyDoji(doji), false);
  t('doji/isGravestone', isGravestoneDoji(doji), false);
  // the neutrality guard: a tiny-bodied hammer is NOT counted as a (neutral) doji
  t('hammer/isDoji', isDoji(hammer), false);
  t('star/isDoji', isDoji(star), false);
  // a bar with 12% body: not a strict doji, IS a loose one
  const nearDoji = C(100.50, 101.00, 100.00, 100.62);
  t('nearDoji/isDoji', isDoji(nearDoji), false);
  t('nearDoji/isDojiLoose', isDojiLoose(nearDoji), true);
  // dragonfly / gravestone
  t('dragonfly', isDragonflyDoji(C(100.95, 101.00, 100.00, 100.97)), true);
  t('gravestone', isGravestoneDoji(C(100.03, 101.00, 100.00, 100.05)), true);
  // degenerate flat bar is nothing
  const flat = C(100, 100, 100, 100);
  t('flat/isDoji', isDoji(flat), false);
  t('flat/isDragonfly', isDragonflyDoji(flat), false);
  // engulfing
  const priorRed = C(101.00, 101.10, 100.40, 100.50);
  const engBull = C(100.50, 101.40, 100.45, 101.30);       // opens at prior close, closes above prior open
  t('bullEngulf', isBullishEngulfing(engBull, priorRed), true);
  t('bullEngulf/notBear', isBearishEngulfing(engBull, priorRed), false);
  const priorGreen = C(100.50, 100.60, 100.40, 101.00);
  const engBear = C(101.00, 101.05, 100.20, 100.30);
  t('bearEngulf', isBearishEngulfing(engBear, priorGreen), true);
  // engulfing a doji prior does not count
  const priorDoji = C(100.50, 101.00, 100.00, 100.52);
  t('engulfDojiPrior', isBullishEngulfing(C(100.52, 101.60, 100.50, 101.50), priorDoji), false);
  // piercing line: prior red body 101.00 -> 100.00 (mid 100.50); current opens 100.00, closes 100.70
  const pierPrior = C(101.00, 101.10, 99.90, 100.00);
  t('piercing', isPiercingLine(C(100.00, 100.80, 99.95, 100.70), pierPrior), true);
  // ...but closing ABOVE the prior open is an engulfing, not a piercing
  t('piercing/notWhenEngulf', isPiercingLine(C(100.00, 101.40, 99.95, 101.30), pierPrior), false);
  // ...and closing below the midpoint is nothing
  t('piercing/notBelowMid', isPiercingLine(C(100.00, 100.40, 99.95, 100.30), pierPrior), false);
  // dark cloud cover: mirror
  const dccPrior = C(100.00, 100.10, 99.90, 101.00);
  t('darkCloud', isDarkCloudCover(C(101.00, 101.05, 100.20, 100.30), dccPrior), true);
  t('darkCloud/notBelowPriorOpen', isDarkCloudCover(C(101.00, 101.05, 99.60, 99.70), dccPrior), false);
  // tweezers: matching low within 10% of the larger range
  const twPrior = C(101.00, 101.10, 100.00, 100.20);       // red, low 100.00, range 1.10
  t('tweezerBottom', isTweezerBottom(C(100.20, 100.90, 100.05, 100.80), twPrior), true);
  t('tweezerBottom/tooFar', isTweezerBottom(C(100.20, 100.90, 99.50, 100.80), twPrior), false);
  const ttPrior = C(100.00, 101.10, 99.90, 101.00);        // green, high 101.10
  t('tweezerTop', isTweezerTop(C(101.00, 101.08, 100.20, 100.30), ttPrior), true);

  // fired(): doji lands in both directions, hammer only in bull
  const f1 = fired(doji, priorRed, CORE);
  t('fired/doji-bull', f1.bull.join(), 'doji');
  t('fired/doji-bear', f1.bear.join(), 'doji');
  const f2 = fired(hammer, priorRed, CORE);
  t('fired/hammer-bull', f2.bull.join(), 'hammer');
  t('fired/hammer-bear', f2.bear.length, 0);

  console.log(`candle-patterns-lab selftest: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
