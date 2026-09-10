'use strict';
/**
 * open-only-signals.js — the two OPEN-ONLY entry strategies under test.
 *
 *   Strategy A: 60m Bollinger band break/near-touch  →  first matching 5m REVERSAL CANDLE = entry.
 *   Strategy B: identical, but the band is read off the 15m timeframe.
 *
 * There is NO cover logic here at all. `cover` is always false and `openSide` is the only output that
 * ever changes. The point is to isolate whether the ENTRY has an edge; positions ride to settlement.
 *
 * ── THE SETUP (band condition) ──────────────────────────────────────────────────────────────────
 * Read on every 5m bar, comparing the CURRENT 5m candle's extreme against the chosen timeframe's
 * outer bands (the bands only move once per 15m/60m, but price moves every 5m — a trader watching
 * the hourly chart sees price poke the band intra-hour, and that is what is modelled):
 *
 *     bandWidth W = bbupper − bblower   (of the setup timeframe)
 *     BULL setup  (looking to go BULL):  bar5m.low  <= bblower + prox × W
 *     BEAR setup  (looking to go BEAR):  bar5m.high >= bbupper − prox × W
 *
 *   prox = 0    → a STRICT break of the outer band.
 *   prox > 0    → "came within prox × W of the band" (a near-touch counts).
 *   prox = null → the CONTROL arm: no band condition at all, both sides permanently armed. This is
 *                 what shows whether the band filter adds anything over the candle pattern alone.
 *
 * ── THE TRIGGER (entry) ─────────────────────────────────────────────────────────────────────────
 * A setup only ARMS a side. The entry is the first 5m reversal candle in the matching direction on
 * or after the arming bar, within `armBars` bars (default 12 = one hour). Same-bar counts: the very
 * candle that stabs the band is frequently the hammer, and refusing it would be an artefact.
 * Firing consumes the arm; the side re-arms only on a fresh band condition.
 *
 * Patterns come from candle-patterns-lab.js. `doji` is direction-NEUTRAL and can therefore satisfy
 * either side. If both sides are armed and only the neutral doji fires, direction is taken from the
 * doji's own colour (green → bull, red → bear) — the same convention the existing server module uses
 * in bullishReversalCandle/bearishReversalCandle. A directional pattern always outranks the doji.
 *
 * STATEFUL: `makeOpenOnlySignal` returns a FRESH closure that must be built once per day (the engine
 * calls it exactly once per bar, in order). It also carries `.stats` so the study can report how
 * often each setup fired and how many of those setups actually produced an entry.
 */
const P = require('./candle-patterns-lab');

/**
 * @param {object} o
 *   o.tf       '60m' (Strategy A) | '15m' (Strategy B) — the band timeframe.
 *   o.prox     number (fraction of band width) | null (no band condition = control arm).
 *   o.patterns array of pattern keys from candle-patterns-lab (default: the required core set).
 *   o.armBars  how many 5m bars a setup stays armed (default 12 = 1h).
 */
function makeOpenOnlySignal(o = {}) {
  const tf = o.tf || '60m';
  const prox = o.prox === undefined ? 0 : o.prox;
  const keys = o.patterns || P.CORE;
  const armBars = o.armBars != null ? o.armBars : 12;

  let i = -1;                       // index of the bar this call is looking at (engine-call order)
  let armBull = null, armBear = null;   // bar index the side was last armed at, or null
  let heldBull = false, heldBear = false;  // was the band condition true on the PREVIOUS bar?
  const stats = {
    bars: 0,
    // A setup EPISODE = a contiguous run of bars over which the band condition holds, counted once on
    // its rising edge. This is the honest "how often does the setup occur" number. It is deliberately
    // NOT the same as the arming count: an entry consumes the arm, and a still-true band condition
    // re-arms the side on the very next bar, so one long band-hug can legitimately produce several
    // entries inside ONE episode.
    setupBull: 0, setupBear: 0,     // episodes (rising edges)
    barsBull: 0, barsBear: 0,       // bars on which the band condition held
    entryBull: 0, entryBear: 0,
    expiredBull: 0, expiredBear: 0, // armed but never triggered inside armBars
    byPattern: {},                  // pattern key -> entries it drove
  };
  const bump = (k) => { stats.byPattern[k] = (stats.byPattern[k] || 0) + 1; };

  function signal(A, priorA /* , ctx */) {
    i++; stats.bars++;
    const c5 = A && A['5m'];
    if (!c5 || c5.close == null) return { openSide: null, cover: false, reason: 'no-5m' };
    const p5 = priorA && priorA['5m'];

    // ── setup ───────────────────────────────────────────────────────────────────────────────────
    if (prox === null) {
      armBull = i; armBear = i;                      // control: permanently armed, both sides
    } else {
      const b = A[tf];
      let condBull = false, condBear = false;
      if (b && b.bbupper != null && b.bblower != null && b.bbupper > b.bblower) {
        const W = b.bbupper - b.bblower;
        condBull = c5.low <= b.bblower + prox * W;
        condBear = c5.high >= b.bbupper - prox * W;
      }
      if (condBull) { if (!heldBull) stats.setupBull++; stats.barsBull++; armBull = i; }
      if (condBear) { if (!heldBear) stats.setupBear++; stats.barsBear++; armBear = i; }
      heldBull = condBull; heldBear = condBear;
      // expire stale arms
      if (armBull !== null && i - armBull > armBars) { armBull = null; stats.expiredBull++; }
      if (armBear !== null && i - armBear > armBars) { armBear = null; stats.expiredBear++; }
    }

    // ── trigger ─────────────────────────────────────────────────────────────────────────────────
    const f = P.fired(c5, p5, keys);
    const bullOk = armBull !== null && f.bull.length > 0;
    const bearOk = armBear !== null && f.bear.length > 0;
    if (!bullOk && !bearOk) return { openSide: null, cover: false, reason: 'no-trigger' };

    // Directional patterns outrank the neutral doji; a doji-only tie is broken by candle colour.
    const dirBull = f.bull.filter(k => P.PATTERNS[k].dir === 'bull');
    const dirBear = f.bear.filter(k => P.PATTERNS[k].dir === 'bear');
    let side = null, why = null;
    if (bullOk && bearOk) {
      if (dirBull.length && !dirBear.length) { side = 'bull'; why = dirBull[0]; }
      else if (dirBear.length && !dirBull.length) { side = 'bear'; why = dirBear[0]; }
      else if (dirBull.length && dirBear.length) {
        // A bar that is simultaneously a directional bull and a directional bear pattern is not a
        // signal — it is noise. Skip rather than pick.
        return { openSide: null, cover: false, reason: 'ambiguous' };
      } else {
        const pp = P.parts(c5);
        if (pp.green) { side = 'bull'; why = f.bull[0]; }
        else if (pp.red) { side = 'bear'; why = f.bear[0]; }
        else return { openSide: null, cover: false, reason: 'ambiguous-flat-doji' };
      }
    } else if (bullOk) { side = 'bull'; why = dirBull[0] || f.bull[0]; }
    else { side = 'bear'; why = dirBear[0] || f.bear[0]; }

    if (side === 'bull') { stats.entryBull++; armBull = null; } else { stats.entryBear++; armBear = null; }
    bump(why);
    return { openSide: side, cover: false, reason: `${side}:${why}` };
  }
  signal.stats = stats;
  return signal;
}

module.exports = { makeOpenOnlySignal };
