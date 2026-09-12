#!/usr/bin/env node
'use strict';
/**
 * v6 5m-STEP backtest — steps the engine every 5m (not 15m), pricing/filling/settling off the 5m
 * candle, so v6 can ACT between 15m closes on a confirmed 5m reversal (ctx.isFifteen=false on
 * intra-15m bars; see v6-signals.js). Compares v6-5m against the FROZEN v5 baseline, which is run on
 * the 15m-close subset of the same 5m dataset (identical underlying data). Tent geometry + resting-fill
 * + BS pricing are the same as the frozen engine; only the STEP and the signal differ.
 *
 * Data: a 5m-resolution dataset (build-analysis-dataset.js --step 5).
 * Usage: node scripts/candle-spread/backtest-v6-5m.js --dataDir <5m dir> [--cfg fiveMin=true,...]
 */
const fs = require('fs');
const path = require('path');
const eng = require('./backtest-v4');                         // geometry + pricing + frozen v5 runner
const trader = require('../trader'); // server COVER selectors (pure; BS getLeg)
const SL = require('../spread-logic');  // shared cover GEOMETRY (tent/halfway/underlying)
const { v6Signal } = require('../signals/v6-signals');
const { v5Signal } = require('../signals/v5-signals');
const bs = eng.bs, { WIDTH, INCR, TICK, QTY } = eng;
const roundTick = eng.roundTick, round2 = eng.round2;

function parseCfg() {
  const cfg = {}; const ci = process.argv.indexOf('--cfg');
  if (ci >= 0 && process.argv[ci + 1]) for (const kv of process.argv[ci + 1].split(',')) {
    const [k, v] = kv.split('='); if (k) cfg[k.trim()] = v === undefined ? true : (v === 'true' ? true : v === 'false' ? false : (isNaN(Number(v)) ? v : Number(v)));
  }
  return cfg;
}
const CFG = parseCfg();
const di = process.argv.indexOf('--dataDir');
const DIR = di >= 0 ? process.argv[di + 1] : path.join(__dirname, '..', '..', '..', '..', 'tests', 'backtest', 'backtest-data-5m-v2');
const money = n => (n < 0 ? '-$' : '+$') + Math.abs(Math.round(n));
const etDay = ms => new Date(ms).toLocaleDateString('en-US', { timeZone: 'America/New_York' });
const etMinute = ms => { const d = new Date(new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York' })); return d.getHours() * 60 + d.getMinutes(); };
// "MM/DD HH:MM" in ET — the exact stamp format the live run records use for candle + position times.
const etStamp = ms => { const d = new Date(new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York' })); const p = n => String(n).padStart(2, '0'); return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
const isFive = a => ['1m', '5m', '15m', '60m'].every(tf => a[tf] && a[tf].bbupper != null && a[tf].bblower != null && a[tf].ema != null);

// Load ALL 5m bars per day (not just 15m closes). Returns { date, bars:[{dt,analysis,fifteen}] }.
function load5mDays(dir) {
  const files = fs.readdirSync(dir).filter(f => /^backtest-[A-Z]+-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  const out = [];
  for (const f of files) {
    const arr = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const bars = arr.filter(x => x.datetime != null && isFive(x.analysis))
      // `px` (optional) is a SECOND price series carried alongside the signal series — the live model
      // signals off /NQ (24h) but prices and settles NDX options, so a faithful dataset needs both. Bars
      // without it are unchanged; runDay5m only reads it when opts.priceOf is pointed at it.
      .map(x => ({ dt: x.datetime, analysis: x.analysis, px: x.px || null, fifteen: new Date(x.datetime).getMinutes() % 15 === 0 }));
    if (bars.length < 5) continue;
    out.push({ date: etDay(bars[0].dt), bars });
  }
  return out;
}

const legsPayoff = eng.legsPayoff, legsMark = eng.legsMark, buildOpen = eng.buildOpen, coverLegs = eng.coverLegs;

// INTRADAY-IV CORRECTION (opts.intradayIV) — a time-of-day IV MULTIPLIER calibrated from the real
// captured chains (scripts/candle-spread/calibrate-intraday-iv.js -> shared/intraday-iv-correction.json).
// When enabled, the per-bar band-IV is multiplied by ivMult(timeOfDay) BEFORE it flows into every
// legsMark/bsPrice call (opens, covers, cap checks, cover-to-stack, settlement), so BS reprices ALL
// moneyness consistently off one corrected IV. Default OFF -> byte-identical to the current baseline.
// LIMITATION: single-IV (NO skew) correction calibrated on ATM vol; covers at other moneyness receive
// the SAME time-of-day IV mult (best single-IV approximation; moneyness skew is a later refinement).
// MONEYNESS (SKEW) CORRECTION (opts.ivSkew) — data/iv-skew-correction.json. Real index vol is a smile with
// a downside tilt, so pricing every leg of a vertical at one ATM vol is biased BY SIDE: measured against
// 15,028 real chain quotes, flat vol under-prices bull call spreads by $69/contract and over-prices bear
// put spreads by $50. The correction multiplies the base vol per leg by skewMult(z), z in expected-move
// units, which reduces those to +$1 and +$8. It removes BIAS, not dispersion (~$100 |err| either way).
// Default OFF -> byte-identical to the flat-IV baselines.
let _skew = null;
function loadSkew() {
  if (_skew) return _skew;
  const p = path.join(__dirname, '..', '..', '..', '..', 'data', 'iv-skew-correction.json');
  _skew = JSON.parse(fs.readFileSync(p, 'utf8')).buckets.filter(b => b.mult != null);
  return _skew;
}
function skewMultAt(z) {
  const bs2 = loadSkew();
  for (const b of bs2) if (z >= b.lo && z < b.hi) return b.mult;
  return 1;   // outside the calibrated range -> no correction (the far buckets are damped to ~1 anyway)
}
// `iv` is a NUMBER normally and a per-leg FUNCTION when opts.ivSkew is on. Any code path that calls
// bs.bsPrice() DIRECTLY has to resolve it per leg first — handing the function straight in as sigma
// produces NaN silently. (legsMark and buildOpen accept either form themselves.)
const volFn = iv => (typeof iv === 'function' ? iv : () => iv);

let _ivCorr = null;   // lazy-loaded { minutes:[...], mults:[...] } sorted by bucket-start minute-of-day
// Delegated to shared/intraday-iv.js so the LIVE engine and the backtest read the SAME calibration from
// the SAME file. It used to live only under data/, reachable from scripts/ but not from the deploy package
// (which zips server/ and follows the server/shared symlink), so live could never apply it — and didn't.
const IIV = require('../../../shared/intraday-iv');
const ivMultAt = IIV.ivMultAt;

const CL = require('../capital-legs');   // proven debit/credit leg + signed-cash foundation
const LL = require('../leg-ledger');     // intraday leg-uniqueness ledger + placement resolver
const RH = require('../risk-harvest');   // v11 risk-harvest hedge search (far-side loss-zone lock)
const WG = require('../wing-convert');
const FY = require('../fly-convert');   // valley repair: flies/condors (opt-in)
const LAD = require('../cover-ladder');   // work the cover instead of resting it once   // peak->floor wing conversion (knee-anchored)

// 5m-step run for one day. Prices off A['5m'].close; cover fills off the 5m candle's extreme.
// signalFn(A, prior, { heldDir, isFifteen }) → { openSide, cover }.
// opts.riskCap (v7 "be patient"): $ cap on UNCOVERED debit — pause opening new positions once the sum
//   of open debits on not-yet-covered positions would exceed it; covers free risk and re-enable opens.
// opts.bidirectional (v7 "be wrong"): allow opening the opposite side while holding the other.
// v8 opts: proactiveCoverFrac (place a resting cover on any uncovered position whose OPENING spread
//   marks >= frac*WIDTH = deep ITM → locks the leader, and it stops counting toward the soft cap);
//   softCap = "churn cap" on AT-RISK (uncovered AND not-deep-ITM) debit — freed as leaders go deep ITM;
//   hardCap = absolute backstop on TOTAL uncovered debit (deep-ITM included). Any cap default Infinity.

// COVER PRICING helper. 'mark' rests at the cover's CURRENT mark (+1 tick) rather than a price derived
// from a hoped-for profit (W - openCost - minLock). Mirrors trader.placeRestingCover's coverPriceMode.
// NOTE what this does to the fill model: a limit AT the mark clears on the same bar, so a mark-priced
// cover fills immediately. That is not an artefact — it is what paying the market means, and it is why
// mark pricing and covering-at-birth cannot both be right.
function coverTarget(opts, legs, S, tau, iv, fallback) {
  if (opts.coverPriceMode !== 'mark') return fallback;
  const m = legsMark(legs, S, tau, iv);
  return roundTick(Math.max(TICK, m + TICK));
}

function runDay5m(bars, signalFn, opts = {}) {
  const riskCap = opts.riskCap != null ? opts.riskCap : Infinity;   // legacy single cap (v7)
  const softCap = opts.softCap != null ? opts.softCap : Infinity;   // v8 churn cap (at-risk only)
  const hardCap = opts.hardCap != null ? opts.hardCap : Infinity;   // STRATEGY RISK backstop (v8/v9 risk/reward tuning)
  // ACCOUNT capital ceiling — how much at-risk (uncovered) capital the account can hold. SEPARATE and
  // distinct in purpose from the strategy risk caps above (this is buying power, not risk appetite);
  // whichever is tighter throttles. Tracked separately so its skips can be isolated.
  const capCeiling = opts.capitalCeiling != null ? opts.capitalCeiling : Infinity;
  const pFrac = opts.proactiveCoverFrac != null ? opts.proactiveCoverFrac : null;
  const bidir = opts.bidirectional === true;
  // rthActionOnly: model LIVE faithfully — the multi-TF `A` is still built from the 24h series (so the
  // bands carry the overnight session), but we only ACT (open/cover/settle) during RTH, since NDX 0DTE
  // options only trade 9:30-16:00. Overnight bars stay in the loop purely for prior continuity. Default
  // OFF = the legacy 24h-action behavior (the pure-NQ signal validation).
  const rthOnly = opts.rthActionOnly === true;
  const inRth = ms => { const m = etMinute(ms); return m >= 575 && m <= 955; };   // 9:35 .. 15:55 action window
  // coverSelector (v1/v2/v3): pick the cover GEOMETRY via the server's pure selectors (greedy/joint/
  // fixed-mark) using a BS getLeg, instead of the fixed tent. undefined = fixed tent (v0/default).
  const coverSel = opts.coverSelector || null;
  const dirWindow = opts.dirWindow || 12;   // rolling-directionality window (5m bars); ~1h at 12
  // directionality at bar i = |net move over the window| / (window high-low range). ~1 = trending, ~0 = chop.
  const directionalityAt = i => {
    const j0 = Math.max(0, i - dirWindow); if (i - j0 < 3) return 1;
    let hi = -Infinity, lo = Infinity;
    for (let j = j0; j <= i; j++) { const x = bars[j].analysis['5m']; hi = Math.max(hi, x.high); lo = Math.min(lo, x.low); }
    const rng = hi - lo; if (!(rng > 0)) return 1;
    return Math.abs(bars[i].analysis['5m'].close - bars[j0].analysis['5m'].close) / rng;
  };
  // GEOMETRY (opts.geo) — spread WIDTH + strike selection + tent covers. Default = the $20 ATM geometry.
  const G = { WIDTH: (opts.geo && opts.geo.WIDTH) || WIDTH, buildOpen: (opts.geo && opts.geo.buildOpen) || buildOpen, coverLegs: (opts.geo && opts.geo.coverLegs) || coverLegs };
  const st = { dir: 'none', positions: [] };
  const ivOf = A => bs.ivFromRelBandWidth((A['15m'].bbupper - A['15m'].bblower) / A['15m'].close);
  const uncoveredRisk = () => st.positions.reduce((s, p) => s + (p.covered ? 0 : p.limit * 100 * QTY), 0);
  let capBlocked = 0, capBlockedTrend = 0, capSkipCeiling = 0, nCoverToStack = 0;   // capSkipCeiling = opens refused ONLY by the account ceiling
  // CAPITAL accounting (opts.trackCapital) — cash deployed through the day; does NOT touch P&L. Two
  // cover rules tracked in parallel: all-DEBIT (pay every cover) vs CREDIT-cover-on-ITM (a cover on a
  // position marking >= creditFrac×width is done as a credit spread → reclaims ~(width−coverLimit) cash
  // instead of paying; 0DTE P&L-identical, NDX cash-settled so no assignment risk). peak = max
  // simultaneous deployment = the account size needed for the day.
  const trackCap = opts.trackCapital === true;
  const creditFrac = opts.creditCoverFrac != null ? opts.creditCoverFrac : 0.65;
  const altEvery = opts.openAlternateEvery || 3;   // alternate open type debit/credit every N opens
  // CASH views: depD/peakD = all-debit. depC/peakC = credit-cover-on-ITM. depA/peakA = user's CONTINUOUS
  // ALTERNATING opens (N debit, N credit, ...) + ITM credit covers → keeps cash oscillating low all day,
  // decoupled from any ceiling. peakUncov = peak UNCOVERED at-risk (the margin view; = what the account
  // capital ceiling caps). Cash management (alternating) is independent of the at-risk ceiling.
  let depD = 0, peakD = 0, depC = 0, peakC = 0, depA = 0, peakA = 0, peakUncov = 0, nCredit = 0, nDebitCov = 0, openN = 0;
  // depR/peakR = the ACCURATE cash curve for the shipping policy (alternate debit/credit opens every
  // altEvery + credit cover on ITM winners), priced from the REAL legs actually traded via capital-legs
  // (not the ~width approximation of depA/depC). depR += entryMark(legsTraded): +debit deploys, -credit
  // reclaims. peakR = worst simultaneous cash = the account funding this policy actually needs.
  let depR = 0, peakR = 0;
  // avgReal (deployedCapital average): accumulate the real deployed cash (depR) at each RTH action step,
  // divide by step count at EOD → the time-average real cash the day tied up (vs peakR's worst-case peak).
  let sumReal = 0, nSteps = 0;
  // LEG-UNIQUENESS (opts.enforceLegUniqueness): a per-day ledger of which side each (type,strike) leg was
  // traded, so a leg is never both bought- and sold-to-open (the broker nets same-symbol positions). On a
  // conflict the resolver prefers the parity twin at the SAME strikes (keeps geometry + P&L), else shifts.
  const enforceLegs = opts.enforceLegUniqueness === true;
  const legIncr = opts.legIncr || 10;
  // recaptureAlternate: the resolver PREFERS the debit/credit style the recapture alternation would send
  // (every altEvery opens), so opens spread across both option ladders → fewer leg conflicts / shifts.
  const recapAlt = opts.recaptureAlternate === true;
  const ledger = LL.makeLegLedger();
  let legIdeal = 0, legTwin = 0, legShift = 0, legSkip = 0, legCoverTwin = 0, legCoverWing = 0, legCoverSkip = 0, shiftSum = 0, legOpenN = 0;
  // RISK-HARVEST (opts.riskHarvest): spend a sliver of the profit peak on far-side hedges to negate the
  // reachable loss zone when a ≥ratio hedge is available (ratio-gated, not clock-gated). Off by default.
  const harvest = opts.riskHarvest === true;
  const hvRatio = opts.harvestRatio != null ? opts.harvestRatio : 3;
  const hvBandSig = opts.harvestBandSigmas != null ? opts.harvestBandSigmas : 1.5;
  const hvTrigger = opts.harvestTrigger != null ? opts.harvestTrigger : -1000;   // only act if reachable loss worse than this
  const hvBudget = opts.harvestDayBudget != null ? opts.harvestDayBudget : Infinity;
  let hvSpent = 0, hvCount = 0, hvDays = 0;
  // PRICING underlying (opts.priceOf): options are priced/settled off THIS series while the SIGNAL stays on
  // A (the analysis series). Default = the analysis 5m itself → baselines byte-identical. Override to price
  // NDX options off the real NDX close while signalling off NQ (the live model; NDX ≈ NQ − basis, ~44pt).
  // FOUNDATIONAL GUARD — signals come from /NQ, pricing and settlement from cash NDX. A dataset that
  // carries a separate NDX price series (`px`) MUST be priced off it. The default below falls back to the
  // SIGNAL series, which for a dual dataset means silently pricing NDX options off NQ — a violation that
  // produces plausible-looking numbers and no error. This has already been nearly shipped twice (the
  // baseline builder and the replay generator each set priceOf only after the omission was caught), so it
  // is enforced here rather than left to every caller to remember.
  if (!opts.priceOf && bars.some(b => b && b.px)) {
    throw new Error('runDay5m: this dataset carries an NDX price series (bars[].px) but opts.priceOf is not set — '
      + 'pricing would fall back to the /NQ signal series. Pass opts.priceOf = b => b.px. '
      + 'See feedback: signals from NQ, pricing/action from NDX.');
  }
  const priceOf = opts.priceOf || (b => { const c = b.analysis['5m']; return { close: c.close, high: c.high, low: c.low }; });
  // Cover-fill check: default uses the intrabar EXTREME (optimistic, ~a true resting-order fill); the LIVE
  // engine (resolveRestingCovers) books at the candle-CLOSE mark. opts.coverFillAtClose matches live.
  const coverAtClose = opts.coverFillAtClose === true;

  // ══ DAY-LOSS GOVERNOR (opts.lossTarget / opts.lossMax) ═══════════════════════════════════════════
  // WHAT IT FIXES: riskCap/softCap/hardCap all gate on `uncoveredRisk()` = Σ uncovered OPEN DEBIT — an
  // INSTANTANEOUS at-open snapshot. It ignores covered pairs that locked a NEGATIVE floor, and it resets
  // every time the book is covered, so a day can run several sequential books each inside the cap and
  // realize ~2× it (measured: v6-40 −$24,095 against a $20k hardCap). The governor instead gates on the
  // BOOK FLOOR — the worst terminal P&L of the WHOLE day's book (covered pairs, hedges and all). Since
  // realized day P&L = bookPayoff(settle) >= floor, holding floor >= −lossMax is a TRUE bound on the
  // day's loss, not an at-risk proxy.
  //   lossTarget = the WORKING target the engine actively manages toward (breach → reduce risk, but keep
  //                trading); lossMax = the HARD ceiling an open may never push the floor through (the
  //                buffer that lets one order marginally exceed the target without freezing the model).
  // Both default Infinity → ungoverned, byte-identical to the pre-governor engine.
  const lossTarget = opts.lossTarget != null ? opts.lossTarget : Infinity;
  const lossMax = opts.lossMax != null ? opts.lossMax : Infinity;
  const governed = lossTarget < Infinity || lossMax < Infinity;
  // Terminal P&L of one position at settle X (covered pair = its locked value; matches bookPayoff/EOD).
  const posPnlAt = (p, X) => {
    let value = legsPayoff(p.legs, X), cost = p.limit;
    if (p.covered && p.coverLegs) { value += legsPayoff(p.coverLegs, X); cost += p.coverLimit; }
    return (value - cost) * 100 * QTY;
  };
  const bookAt = (X, extra) => {
    let t = 0;
    for (const p of st.positions) t += posPnlAt(p, X);
    if (extra) t += posPnlAt(extra, X);
    return t;
  };
  // EXACT book floor. The terminal payoff is piecewise-linear in the settle price with kinks ONLY at
  // strikes and flat tails beyond the outermost ones, so the minimum is attained at a strike or on a
  // tail — evaluating the distinct strikes plus one point outside each end is exact (and far cheaper
  // than sweeping a grid). `extra` = a hypothetical position (the projected floor if we added it).
  const _ks = [];
  function floorOf(extra) {
    _ks.length = 0;
    const push = k => { if (_ks.indexOf(k) < 0) _ks.push(k); };
    for (const p of st.positions) { for (const l of p.legs) push(l.strike); if (p.covered && p.coverLegs) for (const l of p.coverLegs) push(l.strike); }
    if (extra) for (const l of extra.legs) push(l.strike);
    if (!_ks.length) return 0;
    let lo = Infinity, hi = -Infinity;
    for (const k of _ks) { if (k < lo) lo = k; if (k > hi) hi = k; }
    let m = Infinity;
    for (let j = 0; j < _ks.length; j++) { const v = bookAt(_ks[j], extra); if (v < m) m = v; }
    const vLo = bookAt(lo - legIncr, extra); if (vLo < m) m = vLo;
    const vHi = bookAt(hi + legIncr, extra); if (vHi < m) m = vHi;
    return m;
  }
  // The floor only moves when the BOOK moves (open / cover booked / hedge bought) — cache it and mark
  // dirty at every mutation site so the per-bar checks are near-free.
  let _floorCache = null;
  const markBookDirty = () => { _floorCache = null; };
  const floorNow = () => { if (_floorCache === null) _floorCache = floorOf(null); return _floorCache; };
  // LOW-COST RISK OFFSET (opts.floorOffset) — the user's "look for risk-offsetting positions with low
  // cost": when the floor is through the target, buy the far-side debit spread with the best FLOOR-LIFT
  // PER DOLLAR (ratio-gated, so it only ever trades an outsized risk reduction for a small slice of the
  // peak). Distinct from the v11 riskHarvest overlay: that one targets the REACHABLE floor over a ±σ
  // band on a direction gate (a P&L bet); this one targets the ABSOLUTE floor to satisfy a hard cap.
  const floorOffset = opts.floorOffset === true;
  const offMinRatio = opts.floorOffsetMinRatio != null ? opts.floorOffsetMinRatio : 3;
  const offWidths = opts.floorOffsetWidths || [20, 40, 60];
  const offDepth = opts.floorOffsetDepth != null ? opts.floorOffsetDepth : 8;
  const offSlip = opts.floorOffsetSlip != null ? opts.floorOffsetSlip : 0.25;   // per leg; the validated NDX fill
  const offMaxPerDay = opts.floorOffsetMaxPerDay != null ? opts.floorOffsetMaxPerDay : 6;
  const offBudget = opts.floorOffsetBudget != null ? opts.floorOffsetBudget : Infinity;
  // 'target' (legacy default) | 'mark' (cross at the real price) | 'rest' (resting order at the ideal target)
  // WING CONVERSION (opts.wingConvert) — turn PEAK into FLOOR with cheap OTM spreads anchored at the
  // curve's knee. DISTINCT from floorOffset: that fires when the floor is BAD; this fires when the book is
  // GOOD and the job is banking more of it. wingAfterMin supports the time-of-day idea (e.g. 840 = 2pm).
  const wingOn = opts.wingConvert === true;
  const wingAfterMin = opts.wingAfterMin != null ? opts.wingAfterMin : 0;
  const wingEvery = opts.wingEveryBars != null ? opts.wingEveryBars : 3;   // re-plan at most every N bars
  const wingMinRatio = opts.wingMinRatio != null ? opts.wingMinRatio : 3;
  const wingSlip = opts.wingSlip != null ? opts.wingSlip : 0.25;           // per leg, marketable proxy
  const wingBandSig = opts.wingBandSigmas != null ? opts.wingBandSigmas : 1.5;
  const wingMaxPerDay = opts.wingMaxPerDay != null ? opts.wingMaxPerDay : 6;
  const wingBudgetFrac = opts.wingBudgetFrac != null ? opts.wingBudgetFrac : 0.10;   // of the current peak
  let wingCount = 0, wingSpent = 0, wingLastBar = -99;
  const lockMode = opts.lockCoverMode || 'rest';
  // COVER LADDER (off by default so every committed baseline reproduces byte-for-byte).
  const ladderOn = opts.coverLadder === true;
  const ladderOpts = {
    stepSeconds: opts.ladderStepSeconds != null ? opts.ladderStepSeconds : LAD.DEFAULTS.stepSeconds,
    stepPoints: opts.ladderStepPoints != null ? opts.ladderStepPoints : LAD.DEFAULTS.stepPoints,
    steps: opts.ladderSteps != null ? opts.ladderSteps : LAD.DEFAULTS.steps,
    lossCapFrac: opts.ladderLossCapFrac != null ? opts.ladderLossCapFrac : LAD.DEFAULTS.lossCapFrac,
    // Width-neutral step sizing: fixes the CONCESSION PER STEP rather than the step count, so one
    // setting means the same thing at $10, $20 and $40.
    stepDollars: opts.ladderStepDollars != null ? opts.ladderStepDollars : LAD.DEFAULTS.stepDollars,
  };
  const lockGate = opts.lockFloorGate || 'improve';   // 'improve' | 'cap' | 'target'
  let lockUnfillable = 0, lockFillable = 0, lockRested = 0;
  // WHICH MECHANISM IS ACTUALLY COVERING? On 2026-09-08 live, 101 of 101 covers came from `continuous`,
  // because it stakes a pendingCover on every position the moment it opens and the other three triggers
  // only consider positions that do not already have one. Counting them here makes that visible in the
  // backtest instead of only in a day's live record.
  const coverBySrc = { continuous: 0, reversal: 0, lock: 0, proactive: 0, stack: 0, ladder: 0 };
  const coverPicks = [];   // { pos, short, side, legs } — for the cross-geometry identical-legs check
  let geoSkip = 0;   // opens declined by the adaptive geometry's price ceiling
  let openMissed = 0, openTried = 0;   // openFillModel 'resting': how often a placed open never filled
  let giveUps = 0;   // covers forced to the market because the position turned against us
  let gateCutoff = 0, gateFloor = 0;   // opens blocked by the stop-opening gates
  let flyCount = 0, flySpent = 0;      // valley-repair structures bought
  let lockEpoch = null, lockET = null;   // current bar's stamp, for cover-to-continue locks
  let offCount = 0, offSpent = 0, floorCovers = 0, floorBreaches = 0, govBlocked = 0, coverDeferred = 0, worstFloor = 0, worstFloorPre = 0;

  // COVER-TO-CONTINUE — lock the deepest-ITM winners until `need()` is satisfied. A covered tent is a
  // bounded (normally positive) constant, so locking a winner REMOVES its loss tail from the book floor
  // and frees budget to keep trading instead of going dormant for the day. Shared by the account/risk-cap
  // path and the governor path; returns the positions locked (for the open's ledger re-resolve).
  // floorAware (governed callers only): a lock is committed ONLY if it actually improves the BOOK floor.
  // NON-OBVIOUS AND IMPORTANT: the book floor is NOT the sum of the positions' individual floors. A naked
  // OPPOSITE-side position is a natural hedge at the far tail — it pays exactly where the other side's
  // stack loses. Covering it lifts ITS own floor to ~0 but REMOVES that offset, so the book floor can
  // DROP (measured: 2023-02-21 bar 166→169, floor −$6,695 → −$9,320 purely from bears being covered while
  // 8 naked bulls stayed on). So "cover to reduce risk" is only true position-locally; against the book it
  // has to be checked. Ungoverned callers keep the legacy unconditional behaviour (baseline parity).
  function lockDeepWinners(need, S, tau, iv, floorAware) {
    const lockMin = (opts.coverToStackMinFrac != null ? opts.coverToStackMinFrac : creditFrac) * G.WIDTH;
    const cands = st.positions.filter(p => !p.covered && !p.pendingCover && !p.hedge)
      .map(p => ({ p, mark: legsMark(p.legs, S, tau, iv) }))
      .filter(x => x.mark >= lockMin)
      .sort((a, b) => b.mark - a.mark);                 // deepest ITM first: cheapest cover, biggest lock
    const locked = [];
    for (const { p } of cands) {
      if (!need()) break;
      // LOCK-COVER PRICING MODE (opts.lockCoverMode) — the open question of what an instant
      // cover-to-continue lock actually costs. The open+cover pair is NOT a complement: they are
      // ADJACENT spreads sharing one strike, so the combined payoff runs from W (both tails) to 2W (at
      // the shared strike). Cost < W = guaranteed profit; cost between W and 2W = negative floor with
      // live upside to 2W — a real trade, not a mistake.
      //   'rest' (DEFAULT) — place a RESTING order at the ideal target (W − openCost) and book it only
      //              if/when the market actually gets there (identical semantics to the signal-cover
      //              path). No immediate risk relief; the position stays naked until it fills, or never
      //              fills. Best honest mode everywhere it was measured.
      //   'mark'   — CROSS now: pay mark + 1 tick, whatever that is. Always executable; total cost may
      //              land between W and 2W. Kept because the right answer is likely conditional (curve
      //              posture / trend / time of day), so both extremes stay testable.
      // REMOVED 2026-09-04 — the legacy 'target' mode, which booked instantly at min(W − openCost,
      // mark + tick). That took the resting-mode PRICE with crossing-mode IMMEDIACY: whenever the cover
      // marked above the target it booked BELOW the market. Pre-existing behaviour (it predates the
      // governor) and harmless while coverToStack fired only on a blocked open — but the governor calls
      // this thousands of times per run, which made it the dominant P&L driver and produced the bogus
      // "capped beats uncapped" result. Measured 65% of v6-20 and 79% of v7-40 locks priced below market,
      // the latter by ~$1,070/contract. Deleted rather than left reachable so it cannot be selected by
      // accident; prior baselines built with it are superseded, not reproducible.
      if (lockMode === 'rest') {
        { const _l = G.coverLegs(p.side, p.shortStrike);
          p.pendingCover = { legs: _l, target: coverTarget(opts, _l, S, tau, iv, round2(G.WIDTH - p.limit)), src: 'lock' }; }
        lockRested++;
        continue;   // frees no risk NOW — that is the honest cost of resting rather than crossing
      }
      // Resolve the lock-cover for leg-uniqueness (prefer TWIN = same strikes, P&L-neutral; else
      // wing-shift = anchor cover; else skip this winner). PURE — nothing is recorded until we commit,
      // so a floor-rejected candidate leaves the ledger untouched.
      let cl = G.coverLegs(p.side, p.shortStrike), rc = null;   // debit-canonical (drives P&L)
      if (enforceLegs) {
        rc = LL.resolveCover(p.side, p.shortStrike, G.WIDTH, ledger, { preferStyle: 'debit', incr: legIncr, maxWingShift: opts.legMaxWing || 8 });
        if (rc.resolution === 'skip') { legCoverSkip++; continue; }   // can't lock leg-uniquely → leave uncovered
        if (rc.shift) cl = CL.coverLegsFor(p.side, rc.anchor, G.WIDTH, 'debit');   // slid cover, SAME width
      }
      // coverToStackSlip: the lock-cover is booked INSTANTLY at mark + 1 tick with no resting-fill check
      // (the agreed CROSS mode — the position is deep ITM so its offsetting cover is cheap/OTM and you
      // cross to grab it). That price comes from flat-IV BS, which UNDER-prices a cheap OTM cover because
      // it carries no skew. This knob adds a per-spread premium so the result's dependence on that
      // optimism can be measured. Default 0 = unchanged.
      const _rawMark = legsMark(cl, S, tau, iv) + TICK + (opts.coverToStackSlip || 0);
      const _breakeven = round2(G.WIDTH - p.limit);
      if (_rawMark > _breakeven) lockUnfillable++; else lockFillable++;   // was the ideal target actually available?
      if (opts.onLock) opts.onLock({ W: G.WIDTH, openLimit: p.limit, posMark: legsMark(p.legs, S, tau, iv), coverMark: _rawMark - TICK, breakeven: _breakeven, booked: Math.min(_breakeven, _rawMark) });
      const climit = roundTick(_rawMark);   // 'mark' is the only instant-book mode left: pay the real price
      if (floorAware) {
        const f0 = floorNow();
        p.coverLegs = cl; p.coverLimit = climit; p.covered = true;          // simulate…
        const f1 = floorOf(null);
        p.coverLegs = null; p.coverLimit = null; p.covered = false;          // …and revert
        // FLOOR GATE (opts.lockFloorGate) — what the governor is allowed to do when it covers. The open
        // question: is a lock a RISK action (it must buy headroom, so it must lift the floor) or a TRADE
        // (a W..2W tent — negative floor, live upside to 2W at the shared strike — which is the strategy's
        // actual profit engine: as many tents as possible, locked as often as possible, upside decided by
        // the closing price)? A floor-maximizing rule refuses exactly those tents.
        //   'improve' — narrow/risk-only: take a lock ONLY if it RAISES the book floor.
        //   'cap'     — permissive: take any lock that leaves the floor inside lossMax (tents allowed).
        //   'target'  — middle: allow a floor-lowering lock only while still inside the working target.
        const gateOk = lockGate === 'cap' ? (-f1 <= lossMax)
          : lockGate === 'target' ? (f1 > f0 || -f1 <= lossTarget)
            : (f1 > f0);
        if (!gateOk) continue;
      }
      if (enforceLegs) { if (rc.resolution === 'twin') legCoverTwin++; else if (rc.resolution === 'wingShift') legCoverWing++; ledger.record(rc.legs); }
      p.coverLegs = cl; p.coverLimit = climit;
      p.covered = true; p.pendingCover = null; nCoverToStack++;
      p.coverEpoch = lockEpoch; p.coverTime = lockET; markBookDirty();
      if (trackCap) { const back = (G.WIDTH - p.coverLimit) * 100 * QTY; depC -= back; depA -= back; nCredit++; }   // deep winner → credit cover
      locked.push({ side: p.side, shortStrike: p.shortStrike });
    }
    return locked;
  }

  // Buy the cheapest high-ratio far-side offsets until the floor is back inside `limit` (or nothing
  // clears the ratio / the day budget is spent). Returns how many were bought.
  function buyFloorOffsets(limit, S, tau, iv, force) {
    if (!floorOffset) return 0;
    const ivFor = volFn(iv);
    const mark = (type, k) => bs.bsPrice(type, S, k, tau, ivFor(type, k));
    // FORCE = "must-fix" mode, used only when the floor is through the HARD ceiling: take the best
    // available floor-lift-per-dollar even if it doesn't clear the ratio gate, because lossMax is a
    // ceiling, not a preference. Un-forced, the ratio gate keeps the overlay to outsized-reduction-only.
    const minRatio = force ? 0 : offMinRatio;
    const maxCount = force ? offMaxPerDay * 3 : offMaxPerDay;
    let bought = 0;
    while (offCount < maxCount && offSpent < offBudget) {
      const f = floorNow();
      if (-f <= limit) break;
      // Which tail is the floor on? (the side the offset has to pay into)
      let worstX = S, worstV = Infinity;
      for (const p of st.positions) for (const l of p.legs) { const v = bookAt(l.strike, null); if (v < worstV) { worstV = v; worstX = l.strike; } }
      const zoneSide = worstX >= S ? 'above' : 'below';
      let best = null;
      for (const cand of RH.candidateHedges(zoneSide, S, legIncr, offWidths, offDepth)) {
        if (enforceLegs && ledger.conflicts(cand.legs)) continue;      // respect leg-uniqueness
        const debit = RH.legsDebit(cand.legs, mark, offSlip);
        if (debit == null || debit <= 0) continue;
        const cost = debit * 100 * QTY;
        if (offSpent + cost > offBudget) continue;
        const hp = { side: 'hedge', shortStrike: null, legs: cand.legs, limit: debit, covered: false, pendingCover: null, coverLegs: null, coverLimit: null, hedge: true };
        const lift = floorOf(hp) - f;
        if (lift <= 0) continue;
        const ratio = lift / cost;
        if (ratio >= minRatio && (!best || ratio > best.ratio)) best = { hp, cost, ratio };
      }
      if (!best) break;
      st.positions.push(best.hp); markBookDirty();
      if (enforceLegs) ledger.record(best.hp.legs);
      offSpent += best.cost; offCount++; bought++;
    }
    return bought;
  }

  // The full reduction ladder, cheapest risk-removal first: lock winners (frees a tail for ~free, often
  // at a profit), then spend premium on offsets only if the floor is still through `limit`.
  // ── LOCK TELEMETRY (measurement only, no behaviour change) ──────────────────────────────────────
  // Two questions: how often does a day's book reach a GUARANTEED PROFIT (floor >= 0) at the close, and
  // how often does it reach one at ANY point intraday? The gap between those is days that locked a win
  // and then traded it back — which is the case for a "freeze once locked" rule.
  // To judge freezing honestly we cannot just record that it happened: a frozen book still SETTLES
  // wherever price lands, somewhere between its floor and its peak. So we snapshot the book at the moment
  // it first qualifies and later evaluate THAT book at the day's actual settle, giving a like-for-like
  // comparison against what continuing to trade actually produced.
  let bestFloorSeen = -Infinity, lockBar = -1, lockFloorV = null, lockPeakV = null, lockSnap = null, _bar = -1;
  // EPISODES: the floor can go positive, be given back as the strategy keeps trading, and be regained —
  // possibly several times a day. Freezing at the FIRST lock would cut that short, so first/best/last are
  // all tracked: first and last are implementable live, best is the (unreachable) upper bound that says
  // how much timing could possibly be worth. `episodes` counts crossings INTO the qualifying state.
  let episodes = 0, wasQualified = false;
  let bestLock = null, lastLock = null;   // { bar, floor, peak, snap }
  const lockFloorAt = opts.lockFloorAt != null ? opts.lockFloorAt : 0;      // floor threshold to qualify
  const lockPeakMin = opts.lockPeakMin != null ? opts.lockPeakMin : 0;      // and required terminal potential
  // TIME GATE: don't qualify before this ET minute. Every variant shows later locks being worth far more
  // than early ones, so "wait until the session is mostly done, THEN lock" is the shape worth testing.
  const lockAfterMin = opts.lockAfterMin != null ? opts.lockAfterMin : 0;
  function noteLock() {
    const f = floorNow();
    if (f > bestFloorSeen) bestFloorSeen = f;
    if (lockAfterMin && etMinute(bars[_bar].dt) < lockAfterMin) return;   // too early to consider
    if (f < lockFloorAt) { wasQualified = false; return; }
    // Peak of the CURRENT book — the terminal potential being locked in alongside the floor. Scans the
    // same strike set the floor does: the payoff is piecewise-linear with kinks only at strikes.
    const ks = [];
    for (const p of st.positions) { for (const l of p.legs) if (ks.indexOf(l.strike) < 0) ks.push(l.strike);
      if (p.covered && p.coverLegs) for (const l of p.coverLegs) if (ks.indexOf(l.strike) < 0) ks.push(l.strike); }
    if (!ks.length) return;
    let peak = -Infinity;
    for (const k of ks) { const v = bookAt(k, null); if (v > peak) peak = v; }
    if (!(peak >= lockPeakMin)) { wasQualified = false; return; }
    if (!wasQualified) episodes++;          // a fresh crossing INTO the qualifying state
    wasQualified = true;
    // Deep-copy just what the payoff needs, so later trading cannot mutate the snapshot.
    const snap = st.positions.map(p => ({ legs: p.legs.slice(), limit: p.limit,
      covered: !!p.covered, coverLegs: p.coverLegs ? p.coverLegs.slice() : null, coverLimit: p.coverLimit }));
    const here = { bar: _bar, floor: f, peak, snap };
    if (lockBar < 0) { lockBar = _bar; lockFloorV = f; lockPeakV = peak; lockSnap = snap; }   // FIRST
    if (!bestLock || f > bestLock.floor) bestLock = here;                                     // BEST floor
    lastLock = here;                                                                          // LAST seen
  }

  function reduceRisk(S, tau, iv) {
    // (1) FREE first — lock deep-ITM winners, but only those that actually lift the book floor.
    floorCovers += lockDeepWinners(() => -floorNow() > lossTarget, S, tau, iv, true).length;
    // (2) Ratio-gated offsets toward the WORKING TARGET: outsized risk reduction for a small slice of peak.
    if (-floorNow() > lossTarget) buyFloorOffsets(lossTarget, S, tau, iv, false);
    // (3) MUST-FIX toward the HARD ceiling: whatever the best available lift is, take it.
    if (-floorNow() > lossMax) buyFloorOffsets(lossMax, S, tau, iv, true);
  }

  for (let i = 0; i < bars.length; i++) {
    // rthActionOnly: skip overnight bars entirely (no trading/fills), but they remain in `bars` so the
    // next RTH bar's prior (bars[i-1]) is the real continuous-24h prior — matches live's true continuity.
    if (rthOnly && !inRth(bars[i].dt)) continue;
    const A = bars[i].analysis, c5 = A['5m'], px = priceOf(bars[i]), S = px.close, tau = bs.tauFromTime(bars[i].dt);
    // REPLAY STAMPS — every position records when it opened and when its cover filled, in the same shape
    // the LIVE run records use (epoch + "MM/DD HH:MM" ET). Pure bookkeeping, never read by the P&L math;
    // it is what lets a backtest day be replayed in the compare-strategies UI exactly like a live day.
    const nowEpoch = bars[i].dt, nowET = etStamp(bars[i].dt);
    lockEpoch = nowEpoch; lockET = nowET;
    // per-bar band-IV; when opts.intradayIV is on, scale by the calibrated time-of-day IV multiplier so
    // the correction flows into every legsMark/bsPrice below. Default OFF -> iv === ivOf(A) (byte-identical).
    let iv = ivOf(A);
    if (opts.intradayIV) iv *= ivMultAt(etMinute(bars[i].dt));
    // With skew on, `iv` becomes a FUNCTION of (type, strike): the base vol scaled by the smile at that
    // strike's moneyness. The expected-move band is computed from the BASE vol — one pass, no circularity.
    // Everything downstream (legsMark, buildOpen, cover pricing, settlement marks) takes it unchanged.
    if (opts.ivSkew) {
      const base = iv, band = S * base * Math.sqrt(tau);
      iv = band > 0 ? ((type, K) => base * skewMultAt((K - S) / band)) : base;
    }
    const ivFor = volFn(iv);   // resolve per leg for the direct bs.bsPrice() calls below
    const capMark = (t, k) => legsMark([{ side: 'long', type: t, strike: k }], S, tau, iv);   // single-leg mid for capital-legs
    const isDeep = pos => pFrac != null && !pos.covered && legsMark(pos.legs, S, tau, iv) >= pFrac * G.WIDTH;
    // (a0) PROACTIVE DEEP-ITM COVER (v8) — a leader is deep enough ITM to lock a good tent → rest a cover.
    if (pFrac != null) {
      for (const pos of st.positions) {
        if (pos.covered || pos.pendingCover) continue;
        if (legsMark(pos.legs, S, tau, iv) >= pFrac * G.WIDTH) { const _l = G.coverLegs(pos.side, pos.shortStrike);
          pos.pendingCover = { legs: _l, target: coverTarget(opts, _l, S, tau, iv, round2(G.WIDTH - pos.limit)), src: 'proactive' }; }
      }
    }
    // (a0b) CONTINUOUS COVER (opts.continuousCover) — the user's ACTUAL policy, and a different shape of
    // rule from everything else here: keep a standing resting cover on EVERY uncovered position at its
    // profit-locking price (W − openCost), from the moment it is opened. Not risk-triggered and not
    // signal-triggered — the objective is simply "open as many tents as possible, lock as often as
    // possible, keep risk low, and let the closing price decide the upside". The existing resting-fill
    // machinery books each one the moment the market actually offers that price, so nothing fills
    // optimistically. WHY IT MATTERS: the engine otherwise only covers on a signal reversal, the v8/v9
    // proactive frac, or governor distress — which is why backtest books end with a non-negative floor on
    // only ~5% of days while the live books do it routinely.
    // ARMING (opts.continuousCoverArmFrac / continuousCoverOppRatio). Unset => the original behaviour:
    // rest a cover on EVERY position the moment it opens. That maximises locking but decides the outcome
    // of every position at birth, so the risk-gated variants arm on one of two conditions instead:
    //   (a) BOOK RISK — the day's worst case has run to armFrac x lossTarget. The governor's own measure,
    //       so "start covering as we approach the cap" is literal rather than a proxy.
    //   (b) OPPORTUNITY — this position can be covered cheaply enough that the locked profit is at least
    //       oppRatio x what the cover costs. Without this, a couple of deep-ITM winners can sit uncovered
    //       through a full reversal purely because total book risk never got near the target: two $20
    //       spreads at $11 hold only $2,200 against a $5,000 target, while a $300 cover on the deeper one
    //       locks $600. lockDeepWinners does NOT catch that — it is gated on the floor ALREADY being
    //       through lossTarget, i.e. exactly the case this exists to cover.
    const armFrac = opts.continuousCoverArmFrac;
    const oppRatio = opts.continuousCoverOppRatio;
    const armedByRisk = armFrac == null || (lossTarget < Infinity && -floorNow() >= armFrac * lossTarget);
    if (opts.continuousCover) {
      // continuousCoverMinLockFrac: the resting target is the price that still LOCKS A REAL PROFIT, not
      // merely break-even. Resting at the bare break-even price (W − openCost) fills the instant the cover
      // is barely acceptable, and that is a bad trade on a deep winner: an uncovered spread wins
      // (W − openCost) whenever it stays past its short strike, whereas covering at break-even leaves 0 in
      // both tails and only pays at the shared strike. Requiring the lock to secure `frac × W` makes the
      // order fill only when the offsetting spread is genuinely cheap — the CROSS case.
      // DYNAMIC minLock (opts.minLockRamp, default OFF = the constant it has always been).
      //
      // THE PROBLEM (user, 2026-09-11): `W - openCost - minLock` is a FIXED price, but the premium it has
      // to compete against DECAYS through the day. Early on that target sits far below a rich mark and
      // simply cannot fill, so the position sits naked for two or three hours with no protection from an
      // adverse move; by afternoon the same target is reachable. Two independent measurements line up
      // with that: 42% of unfilled covers sat at prices the underlying DID reach (they were fillable,
      // just far too late), and peak book floors cluster at 13:00-14:10 — exactly when the first covers
      // start landing. The occasional early cover that DOES fill is the reversal path, which prices off
      // the MARK (selectCoverGeometric -> selectCoverFixedMark), not off minLock.
      //
      // THE RAMP: ask for almost nothing early, when the aim is to put on as many tents as possible at
      // the best floor, and demand the full lock later when the price is actually achievable. `to` above
      // 1.0 lets the late demand exceed today's constant, since if early fills are the problem then a
      // MORE aggressive late minLock may pay.
      let minLock = (opts.continuousCoverMinLockFrac || 0) * G.WIDTH;
      if (opts.minLockRamp) {
        const a = opts.minLockRampStart != null ? opts.minLockRampStart : 9 * 60 + 30;
        const b = opts.minLockRampEnd != null ? opts.minLockRampEnd : 12 * 60 + 30;
        const from = opts.minLockRampFrom != null ? opts.minLockRampFrom : 0;
        const to = opts.minLockRampTo != null ? opts.minLockRampTo : 1;
        const now = etMinute(bars[i].dt);
        const prog = b > a ? Math.max(0, Math.min(1, (now - a) / (b - a))) : 1;
        minLock = minLock * (from + (to - from) * prog);
      }
      for (const pos of st.positions) {
        if (pos.covered || pos.pendingCover || pos.hedge) continue;
        const tgt = round2(G.WIDTH - pos.limit - minLock);
        // THE `tgt <= 0` REFUSAL IS GONE. It silently placed NO cover at all whenever the open cost plus
        // the demanded profit exceeded the width — so the positions least able to afford being naked were
        // exactly the ones left uncovered. With a ladder there is always a fillable band (break-even up to
        // a bounded loss), so there is no case where declining to place is the right answer.
        if (!ladderOn && tgt <= 0) continue;
        // GEOMETRY: where the offsetting spread sits. 'tent' (default) shares the position's short strike
        // and reproduces the original legs exactly; 'halfway'/'underlying' walk it toward the money.
        const legs = opts.coverGeometry && opts.coverGeometry !== 'tent'
          ? SL.coverLegsAtShort(pos.side, SL.coverShortFor(opts.coverGeometry, pos.side, pos.shortStrike, S, legIncr), G.WIDTH)
          : G.coverLegs(pos.side, pos.shortStrike);
        if (!armedByRisk) {
          // Not armed by book risk — take it only if the cover is cheap enough to be worth it on its own.
          if (oppRatio == null) continue;
          const cost = legsMark(legs, S, tau, iv);
          const locked = G.WIDTH - pos.limit - cost;
          if (!(cost > 0) || locked < oppRatio * cost) continue;
        }
        // minLock AS A GATE, NOT A PRICE (opts.coverLockGate). Priced, minLock produces an order resting
        // far under the market that cannot fill — measured live 2026-09-09 at a median 64% below the mark
        // on 733 of 735 unfilled covers. But the CONDITION it encodes is sound: only cover once the
        // offsetting spread has become cheap enough to bank a real profit, i.e. once the position has run
        // deep enough ITM. So gate on it and then pay the MARK: right timing, fillable price.
        if (opts.coverLockGate) {
          const cost = legsMark(legs, S, tau, iv);
          if (!(cost > 0) || (G.WIDTH - pos.limit - cost) < minLock) continue;
        }
        // Stamp what the ladder needs to walk this order: when it was placed and where the underlying was.
        pos.pendingCover = { legs, target: coverTarget(opts, legs, S, tau, iv, tgt), openCost: pos.limit, minLock, src: 'continuous',
          placedMs: nowEpoch, placedUnder: S, placedET: nowET };
      }
    }
    // Record newly-placed covers once, at the moment they appear, tagged with the trigger that made them.
    for (const pos of st.positions) {
      if (pos.pendingCover && !pos.pendingCover._seen) {
        pos.pendingCover._seen = true;
        const src = pos.pendingCover.src || 'continuous';
        if (coverBySrc[src] != null) coverBySrc[src]++;
        coverPicks.push({ id: pos.id || null, short: pos.shortStrike, side: pos.side,
          at: pos.pendingCover.placedET || null,
          legs: (pos.pendingCover.legs || []).map(l => `${l.side[0]}${l.type}${l.strike}`).join(' ') });
      }
    }
    for (const pos of st.positions) {                       // (a) resolve resting covers vs THIS 5m bar
      if (!pos.pendingCover) continue;
      // FILL MODEL. A resting cover is a real order at the broker, so it fills if the underlying TRADED
      // THROUGH the level that makes the cover cheap enough — i.e. price it at the bar's most favourable
      // extreme (high for a bull, whose put-spread cover cheapens as price rises; low for a bear). That is
      // the honest model, not an optimistic one; coverFillAtClose (a single point in time) is a strict
      // pessimistic BOUND, not a candidate.
      // coverFillHaircut pulls the extreme back toward the close by N index points, so the market must
      // trade N points BEYOND the fill level — the user's "skew it by a strike" robustness knob.
      const pc = pos.pendingCover;
      const _hc = opts.coverFillHaircut || 0;
      const ext = pos.side === 'bull' ? (px.high - _hc) : (px.low + _hc);
      // LADDER: the working limit is not fixed. It starts at the trigger's price and walks up toward the
      // market as the order ages and the underlying travels, capped at a bounded loss. Without the ladder
      // this is the original fixed-target comparison, so ladderOn:false reproduces the committed baselines.
      // GIVE-UP RULE (opts.coverGiveUp). The user's framing, 2026-09-10: "better to fill at a small
      // locked profit or even a small loss than to let an open position expire worthless."
      //
      // The ladder concedes price on a SCHEDULE. This watches the POSITION and forces the fill when the
      // trade is going against us — which is the case minLock handles worst, because a deteriorating
      // position makes its cover DEARER exactly as our optimistic target becomes least reachable. It is
      // the mechanism that makes an optimistic opening ask survivable: minLock can stay where it is as
      // the price we ASK, because there is now something that stops it becoming a permanent unfilled order.
      //
      // TRIGGER: the underlying has crossed back through the position's own short strike by giveUpPoints
      // — i.e. the position that was winning is now losing. That is a statement about the POSITION, not
      // the clock, so a fast reversal triggers immediately and a quiet drift never does.
      // ACTION: pay the mark (+1 tick), bounded by giveUpMaxLoss x W so it can never become a rout.
      let giveUp = false;
      if (opts.coverGiveUp && pos.shortStrike != null) {
        const pts = opts.giveUpPoints != null ? opts.giveUpPoints : 10;
        // bull loses as price FALLS below its short strike; bear loses as price RISES above it
        const through = pos.side === 'bull' ? (pos.shortStrike - S) : (S - pos.shortStrike);
        if (through >= pts) giveUp = true;
      }
      let workingTarget = pc.target;
      // PRECEDENCE: give-up SUPERSEDES the ladder. The ladder is a schedule for conceding price while the
      // trade is still fine; once the position has turned, the schedule is the wrong answer and we go to
      // the market. Live (trader.workRestingCovers) does exactly this via an early `continue`, and the
      // first version here had the opposite order — the ladder overwrote the give-up price, which made
      // the two-feature arm byte-identical to ladder-only and hid give-up entirely.
      if (giveUp) {
        const cap = (opts.giveUpMaxLoss != null ? opts.giveUpMaxLoss : 0.15) * G.WIDTH;
        const mk = legsMark(pc.legs, S, tau, iv);
        // never pay more than break-even + the bounded loss, and never chase above the mark
        workingTarget = roundTick(Math.min(mk + TICK, round2(G.WIDTH - pc.openCost + cap)));
      }
      if (!giveUp && ladderOn && pc.openCost != null) {
        // `mark` MUST be passed: cover-ladder's neverExceedMark defaults to TRUE, so omitting it let the
        // backtest walk the working limit ABOVE the current market. With the fill test being
        // `legsMark(...) <= workingTarget`, a limit above the mark fills instantly AND books at a price
        // the market never asked for — the ladder overpaying on every step. That is very likely what the
        // first ladder sweep measured when it reported all 36 arms losing $461k-$863k. Live passes the
        // mark (trader.workRestingCovers), so omitting it here also broke isomorphism.
        workingTarget = LAD.limitNow({
          spreadWidth: G.WIDTH, openCost: pc.openCost, minLock: pc.minLock || 0,
          restingMs: pc.placedMs != null ? (nowEpoch - pc.placedMs) : 0,
          underlyingMove: pc.placedUnder != null ? (S - pc.placedUnder) : 0,
          mark: legsMark(pc.legs, S, tau, iv),
          tick: 0.05,
        }, ladderOpts).limit;
      }
      if (giveUp) giveUps++;
      if (legsMark(pc.legs, coverAtClose ? S : ext, tau, iv) <= workingTarget) {
        // GOVERNOR — DEFER A CAP-BREAKING COVER. Booking a cover lifts THAT position's own floor to its
        // locked value, but a naked OPPOSITE-side position is the stack's natural tail hedge: locking it
        // removes the offset and can push the BOOK floor down (the 2026-02-21 mechanism). Since we own the
        // resting order, the fix is simply not to take the fill yet — leave it pending and re-check next
        // bar. This is what makes lossMax an airtight ceiling: opens are gated, offsets only lift, and now
        // no cover can lower the book floor through it either. Covers that IMPROVE the floor always book.
        // Resolve the cover FIRST (pure — nothing recorded yet) so we know the ACTUAL legs/limit this fill
        // would book: ideal tent → credit twin (same strikes) → wing-shift (anchor cover) → skip. The
        // governor then simulates exactly what would be booked (the anchor cover's limit is NOT capped at
        // the tent target, so simulating the ideal tent instead would under-state the floor hit).
        // BOOK AT THE WORKING LIMIT, not the original target. The ladder RAISES the price we are willing
        // to pay, so it must raise what we actually pay — booking at the stale ideal while filling on the
        // raised trigger buys at a price that was never available. That bug turned v6-20 into $14.9M with
        // a worst day of -$710 (eff 21,011), which is what a free-money leak looks like from the outside.
        let cLegs = pc.legs, cLimit = roundTick(Math.min(workingTarget, legsMark(pc.legs, S, tau, iv) + TICK)), rc = null;
        if (enforceLegs) {
          rc = LL.resolveCover(pos.side, pos.shortStrike, G.WIDTH, ledger, { preferStyle: 'debit', incr: legIncr, maxWingShift: opts.legMaxWing || 8 });
          if (rc.resolution === 'skip') { legCoverSkip++; pos.pendingCover = null; continue; }   // can't lock — stays uncovered
          if (rc.shift) {
            // SLID cover (same width, deeper ITM): P&L uses the ACTUAL legs, but the price rule is
            // UNCHANGED from the unshifted case — min(workingTarget, mark + tick). The old branch priced a
            // shifted cover at its own mark with no target cap, which is what let a resolver-shifted cover
            // book above the lock price and bank a guaranteed loss.
            cLegs = CL.coverLegsFor(pos.side, rc.anchor, G.WIDTH, 'debit');
            cLimit = roundTick(Math.min(workingTarget, legsMark(cLegs, S, tau, iv) + TICK));
          }
        }
    if (governed) {
          const f0 = floorNow();
          const sv = { covered: pos.covered, coverLegs: pos.coverLegs, coverLimit: pos.coverLimit };
          pos.coverLegs = cLegs; pos.coverLimit = cLimit; pos.covered = true;
          const f1 = floorOf(null);
          pos.covered = sv.covered; pos.coverLegs = sv.coverLegs; pos.coverLimit = sv.coverLimit;
          if (f1 < f0 && -f1 > lossMax) { coverDeferred++; continue; }   // would un-hedge the book past the ceiling
        }
        if (enforceLegs) {
          if (rc.resolution === 'twin') legCoverTwin++;
          else if (rc.resolution === 'wingShift') legCoverWing++;
          ledger.record(rc.legs);
        }
        pos.coverLegs = cLegs; pos.coverLimit = cLimit; pos.covered = true; pos.pendingCover = null;
        pos.coverEpoch = nowEpoch; pos.coverTime = nowET; markBookDirty();
        if (rc && rc.wing !== G.WIDTH) continue;   // anchor cover: legacy skips the capital accounting below
        if (trackCap) {
          const cd = pos.coverLimit * 100 * QTY;
          depD += cd; peakD = Math.max(peakD, depD);
          const itm = legsMark(pos.legs, S, tau, iv) >= creditFrac * G.WIDTH;   // ITM enough → credit cover reclaims cash
          if (itm) { const back = (G.WIDTH - pos.coverLimit) * 100 * QTY; depC -= back; depA -= back; nCredit++; }
          else { depC += cd; depA += cd; nDebitCov++; }
          peakC = Math.max(peakC, depC); peakA = Math.max(peakA, depA);
          // depR: same policy priced from the REAL legs (credit cover on ITM else the debit cover).
          const covLegsR = itm ? CL.coverLegsFor(pos.side, pos.shortStrike, G.WIDTH, 'credit') : pos.coverLegs;
          depR += CL.entryMark(covLegsR, capMark) * 100 * QTY; peakR = Math.max(peakR, depR);
        }
      }
    }
    if (trackCap) peakUncov = Math.max(peakUncov, uncoveredRisk());   // margin view: at-risk uncovered $ right now
    // (b1) GOVERNOR — WORKING TARGET. Every bar (not just when an open is pending): if the book floor has
    // fallen through lossTarget, actively work it back — lock deep-ITM winners first, then buy a low-cost
    // offset. This is the "try to keep risk under the target" half; the hard lossMax gate below is the
    // "never let an open push it past" half.
    if (governed) {
      const f0 = floorNow();
      if (-f0 > lossTarget) { floorBreaches++; reduceRisk(S, tau, iv); }
      // sample AFTER the ladder: worstFloor is the exposure we actually HELD, which is what lossMax bounds.
      const f1 = floorNow();
      if (f1 < worstFloor) worstFloor = f1;
      if (-f0 > worstFloorPre) worstFloorPre = -f0;   // pre-reduction exposure (what the ladder had to fix)
    }
    // (b2) WING CONVERSION — bank peak as floor. Runs regardless of whether the floor is healthy (that is
    // the whole point); gated by time-of-day, a re-plan interval, a per-day count and a budget expressed as
    // a fraction of the CURRENT peak, so it can never spend real money chasing a small tent.
    if (wingOn && wingCount < wingMaxPerDay && etMinute(bars[i].dt) >= wingAfterMin && i - wingLastBar >= wingEvery && st.positions.length) {
      wingLastBar = i;
      // `iv` is a per-leg FUNCTION when ivSkew is on, so `S * iv` is NaN and the band silently fails the
      // `> 0` test — which is why wing conversion never fired once the skew became the default. The band is
      // an expected-move width, so it wants the ATM scalar vol, not the smile.
      const ivAtm = typeof iv === 'function' ? iv('C', S) : iv;
      const band = Math.round(S * ivAtm * Math.sqrt(tau) * wingBandSig);
      if (band > 0) {
        // marketable proxy: buy the long leg above mid, sell the short below (live swaps in real quotes)
        const price = (type, strike, legSide) => bs.bsPrice(type, S, strike, tau, ivFor(type, strike)) + (legSide === 'long' ? wingSlip : -wingSlip);
        const bookView = st.positions.map(p => ({ filled: true, legs: p.legs, limit: p.limit, quantity: QTY, covered: p.covered, coverLegs: p.coverLegs, coverLimit: p.coverLimit }));
        // Budget is a fraction of the CURRENT peak — there has to be a peak worth converting before we
        // spend anything, and a small tent can never justify real premium.
        const shape = WG.curveShape(bookView, { step: legIncr });
        const peakNow = shape ? shape.peak.pnl : 0;
        const budget = Math.min(opts.wingBudget != null ? opts.wingBudget : Infinity, wingBudgetFrac * peakNow);
        const plan = peakNow > 0 && budget > 0 ? WG.planWings(bookView, {
          spot: S, band, incr: legIncr, price, qty: QTY, step: legIncr, budget,
          maxWings: Math.min(3, wingMaxPerDay - wingCount), minRatio: wingMinRatio,
          // Shape of the candidate set + how much the uncapped tail is worth. Defaults reproduce the
          // capped-at-the-anchor, spreads-only behaviour exactly.
          outSteps: opts.wingOutSteps, naked: opts.wingNaked,
          upsideLambda: opts.wingUpsideLambda, tailSigmas: opts.wingTailSigmas,
        }) : null;
        if (plan && plan.wings.length) {
          for (const w of plan.wings) {
            st.positions.push({ side: 'wing', shortStrike: null, legs: w.legs, limit: w.cost, covered: false, pendingCover: null, coverLegs: null, coverLimit: null, hedge: true, wing: true, openEpoch: nowEpoch, openTime: nowET });
            wingSpent += w.cost * 100 * QTY; wingCount++;
          }
          markBookDirty();
        }
      }
    }
    // FLY / CONDOR VALLEY REPAIR (opts.flyConvert, default OFF).
    //
    // The complement to wingConvert, not a replacement. Wings and offsets only BUY, so they need cheap
    // OTM premium and have little potential until late; a fly SELLS THE BODY to fund its wings, so its
    // net cost stays small when premium is rich. Validated against 231 real chain snapshots: a 30-wide
    // fly is $175 (17:1) at 09:30 rising to $720 (4.2:1) at 15:00 — an early/mid-day tool by its own
    // economics, and the mirror image of when wings work.
    //
    // It also targets the biggest measured leak. Blocking late opens (time cutoff OR positive-floor gate)
    // lost total AND ret/DD in all 42 arms, so the late opens that erode the floor are net-positive and
    // "stop trading" is the wrong answer. Repairing the curve while continuing to trade is what is left.
    if (opts.flyConvert && st.positions.length >= 2) {
      const afterMin = opts.flyAfterMin != null ? opts.flyAfterMin : 0;
      const beforeMin = opts.flyBeforeMin != null ? opts.flyBeforeMin : 15 * 60;   // cost/ratio collapses late
      const nowMin = etMinute(bars[i].dt);
      if (nowMin >= afterMin && nowMin < beforeMin && flyCount < (opts.flyMaxPerDay != null ? opts.flyMaxPerDay : 4)) {
        const ivAtm0 = typeof iv === 'function' ? iv('C', S) : iv;
        const fband = Math.round(S * ivAtm0 * Math.sqrt(tau) * (opts.flyBandSig != null ? opts.flyBandSig : 1.5));
        if (fband > 0) {
          const fslip = opts.flySlip != null ? opts.flySlip : 0.05;
          const fprice = (type, strike, legSide) => bs.bsPrice(type, S, strike, tau, ivFor(type, strike)) + (legSide === 'long' ? fslip : -fslip);
          const fBook = st.positions.map(p => ({ filled: true, legs: p.legs, limit: p.limit, quantity: QTY, covered: p.covered, coverLegs: p.coverLegs, coverLimit: p.coverLimit }));
          const fplan = FY.planFlies(fBook, {
            spot: S, band: fband, incr: legIncr, price: fprice, qty: QTY, step: legIncr,
            budget: opts.flyBudget != null ? opts.flyBudget : 1500,
            maxFlies: Math.min(2, (opts.flyMaxPerDay != null ? opts.flyMaxPerDay : 4) - flyCount),
            minRatio: opts.flyMinRatio != null ? opts.flyMinRatio : 3,
            widths: opts.flyWidths || [2 * legIncr, 3 * legIncr, 4 * legIncr],
            condors: opts.flyCondors !== false,
          });
          if (fplan && fplan.flies.length) {
            for (const f of fplan.flies) {
              st.positions.push({ side: 'fly', shortStrike: null, legs: f.legs, limit: f.cost, covered: false,
                pendingCover: null, coverLegs: null, coverLimit: null, hedge: true, fly: true,
                openEpoch: nowEpoch, openTime: nowET });
              flySpent += f.cost * 100 * QTY; flyCount++;
            }
            markBookDirty();
          }
        }
      }
    }

    // per-side held state (uncovered positions on each side) + legacy single heldDir for v4-v6.
    const heldBull = st.positions.some(p => p.side === 'bull' && !p.covered);
    const heldBear = st.positions.some(p => p.side === 'bear' && !p.covered);
    const sig = signalFn(A, i > 0 ? bars[i - 1].analysis : null, { heldDir: st.dir, heldBull, heldBear, isFifteen: bars[i].fifteen, directionality: directionalityAt(i) });
    // (c) COVER — sig.coverSide ('bull'|'bear'|'both') covers just that side (v7 per-side); legacy
    //     sig.cover (bool) covers all. Place resting covers on the targeted uncovered positions.
    const coverSet = sig.coverSide ? (sig.coverSide === 'both' ? ['bull', 'bear'] : [sig.coverSide]) : (sig.cover ? ['bull', 'bear'] : []);
    if (coverSet.length) {
      const toCover = st.positions.filter(p => !p.covered && !p.pendingCover && coverSet.includes(p.side));
      let plans = null;
      if (coverSel) {   // v1/v2/v3: reuse the server cover selectors with a BS getLeg (single source of truth)
        const getLeg = (type, k) => ({ mid: bs.bsPrice(type, S, k, tau, ivFor(type, k)), symbol: `x${type}${k}`, bid: 0, ask: 0 });
        // coverGeometry has to reach the selector too, not just the fallback legs below: with a
        // coverSelector configured the plan's legs WIN, so leaving it out of cfgLike made the geometry
        // fix a no-op for exactly the v0/v1/v2 variants it was written for.
        const cfgLike = { spreadWidth: G.WIDTH, strikeIncrement: INCR, tickIncrement: TICK, quantity: QTY, coverSelector: coverSel, coverKCap: 5,
          ...(opts.coverGeometryOnReversal && opts.coverGeometry ? { coverGeometry: opts.coverGeometry } : {}) };
        const withId = toCover.map((p, k) => ({ ...p, id: 'c' + k, quantity: QTY }));
        plans = trader.selectCovers(withId, cfgLike, getLeg, { underlying: S, reversedDir: sig.openSide || (coverSet[0] === 'bull' ? 'bear' : 'bull'), bbOverride: false });
      }
      for (let k = 0; k < toCover.length; k++) {
        const pos = toCover[k];
        // GEOMETRY ON THE REVERSAL PATH. The reversal cover has always been hardcoded TENT (share the
        // short strike), while only the CONTINUOUS path honoured opts.coverGeometry. That is why arming —
        // which shifts covers from continuous to reversal — made v0/v1/v2 MORE identical rather than less
        // (35% -> 79% identical legs): it was routing covers into the one path that discards the very
        // thing those variants exist to differ on. Opt-in so the committed baselines still reproduce.
        let legs = (opts.coverGeometryOnReversal && opts.coverGeometry && opts.coverGeometry !== 'tent')
          ? SL.coverLegsAtShort(pos.side, SL.coverShortFor(opts.coverGeometry, pos.side, pos.shortStrike, S, legIncr), G.WIDTH)
          : G.coverLegs(pos.side, pos.shortStrike);
        if (plans) { const pl = plans.find(x => x.positionId === 'c' + k); if (pl && !pl.error && pl.legs) legs = pl.legs; }
        pos.pendingCover = { legs, target: coverTarget(opts, legs, S, tau, iv, round2(G.WIDTH - pos.limit)), src: 'reversal', placedET: nowET };
      }
      if (sig.cover || sig.coverSide === 'both' || sig.coverSide === st.dir) st.dir = 'none';   // reset stance so the flip's opposite open proceeds
    }
    const dirOk = bidir || st.dir === 'none' || st.dir === sig.openSide;

    // STOP-OPENING GATES. Two competing answers to the same measured leak: books build a good floor by
    // mid-afternoon and then trade it away. Live 2026-09-10, 24 of 80 books reached a POSITIVE guaranteed
    // floor and only 6 kept it, giving back $58,558 — and the v4-20-unc trajectory shows the floor
    // climbing to +$100 at 14:05 with 11 positions, then decaying to -$6,600 by 15:45 as six more opens
    // went on. Every late open made it worse.
    //
    //   openCutoffMin  — BLUNT but predictable: no signal-triggered opens after this ET minute. Peak
    //                    floors cluster 13:00-14:10, which is where the user independently pointed.
    //   openFloorGate  — ADAPTIVE: no opens once the book's own guaranteed floor is above the threshold.
    //                    It stops when you have WON, whenever that happens, rather than by the clock.
    //                    This is the MIRROR of the governor's existing loss gate (which blocks an open
    //                    whose projected floor is too NEGATIVE); same machinery, opposite sign.
    //
    // Neither touches covers, offsets or wings — risk-reducing trades keep running all session, which is
    // the whole point: stop adding exposure, keep repairing what is there.
    let openGated = false, gateWhy = null;
    if (opts.openCutoffMin != null && etMinute(bars[i].dt) >= opts.openCutoffMin) { openGated = true; gateWhy = 'cutoff'; }
    if (!openGated && opts.openFloorGate != null && st.positions.length) {
      const fl = floorOf(null);   // the book's guaranteed floor as it stands
      if (fl >= opts.openFloorGate) { openGated = true; gateWhy = 'floor'; }
    }
    if (openGated) { if (gateWhy === 'cutoff') gateCutoff++; else gateFloor++; }

    if (sig.openSide && dirOk && !openGated) {               // (d) open (subject to the caps)
      let o = G.buildOpen(sig.openSide, S, tau, iv);
      // ADAPTIVE geometry can DECLINE: every placement from deep-ITM through straddle priced above the
      // risk/reward ceiling. Skipping is the correct answer — the alternative (buying anyway, or booking a
      // capped sub-market price) is exactly the artifact this geometry exists to avoid.
      if (o && o.skip) {
        geoSkip++;
        // opts.onDecline: report the turned-down spread so a caller can measure whether a resting bid at
        // the ceiling WOULD have filled later in the day. Declining is a strategy choice; whether the
        // market would have come to our price is a fact, and facts should be measured, not assumed.
        if (opts.onDecline && o.legs) opts.onDecline({ i, side: sig.openSide, legs: o.legs, restLimit: o.restLimit, markAtDecline: o.mark });
        sig.openSide = null;
      }
      else {
      // LEG-UNIQUENESS: resolve the ideal spread against the day's ledger — ideal → parity twin (same
      // strikes) → shift → skip. P&L stays on the debit-canonical spread at the RESOLVED strikes; the
      // ledger records the actual (style-specific) legs on commit. `resolvedLegs` = what to record.
      let resolvedLegs = o.legs, legSkip1 = false;
      if (enforceLegs) {
        const _s = o.legs.map(l => l.strike), _lo = Math.min(..._s), _hi = Math.max(..._s);
        const preferStyle = recapAlt ? (Math.floor(legOpenN / altEvery) % 2 === 1 ? 'credit' : 'debit') : 'debit';
        // openNeverOtm mirrors the live rule: an initial order must not START fully out of the money.
        // Opt-in so the committed baselines reproduce with it off.
        const legAllow = opts.openNeverOtm ? ((lo, hi) => LL.notFullyOtm(sig.openSide, lo, hi, S)) : undefined;
        const res = LL.resolveOpen(sig.openSide, _lo, _hi, ledger, { incr: legIncr, maxShift: opts.legMaxShift || 6, preferStyle, allow: legAllow });
        if (res.resolution === 'skip') { legSkip++; legSkip1 = true; }
        else {
          // The REBUILD at the shifted anchor can decline even though the unshifted one did not — the
          // shift moves the placement and therefore the price. Treat that exactly like the first decline
          // (skip the open) rather than carrying a legless `o` into the governor's floor projection.
          if (res.resolution === 'shift') {
            legShift++; shiftSum += Math.abs(res.shift);
            const o2 = G.buildOpen(sig.openSide, S + res.shift * legIncr, tau, iv);
            if (o2 && o2.skip) { geoSkip++; legSkip1 = true; } else o = o2;
          }
          else if (res.resolution === 'twin') legTwin++; else legIdeal++;
          resolvedLegs = res.legs;
        }
      }
      if (!legSkip1) {
      let geoDecline = false;   // set if a post-lock ledger re-resolve rebuilt the open above the price ceiling
      const nd = o.limit * 100 * QTY;
      // COVER-TO-CONTINUE-STACKING (opts.coverToStack): if a new open would breach the ACCOUNT ceiling
      // mid-trend, LOCK the deepest-ITM winner(s) first — a covered tent is riskless, so it frees its
      // at-risk from the budget — rather than skipping the trade. Only locks positions marking >=
      // coverToStackMinFrac×width (real winners → cheap covers, positive floor), deepest first, just
      // enough to fit the new open. Changes P&L (covers a winner sooner) — that's the trade-off.
      // The cap cover-to-stack recycles against: the account ceiling always, and — when
      // opts.coverToStackVsRisk — the STRATEGY risk cap too (user's "if risk hits the cap, cover to
      // enable more"). Effective trigger = the tightest active cap it's allowed to recycle against.
      // The candidate position this open would add — the governor gates on the PROJECTED book floor with
      // it included, so an open can never push the day's max loss through lossMax.
      const candPos = { side: sig.openSide, legs: o.legs, limit: o.limit, covered: false, coverLegs: null, coverLimit: null };
      const ctsCap = Math.min(capCeiling, opts.coverToStackVsRisk ? Math.min(riskCap, hardCap) : Infinity);
      // GOVERNED: recycle against the projected floor vs lossMax. UNGOVERNED (legacy): against uncovered
      // debit vs the tightest active cap. Only LOCKING runs here (it's free risk removal); paying premium
      // for an offset purely to unblock a new open is left to the (b1) target ladder.
      const needRoom = governed
        ? () => opts.coverToStack !== false && -floorOf(candPos) > lossMax
        : () => opts.coverToStack && ctsCap < Infinity && uncoveredRisk() + nd > ctsCap;
      if (needRoom()) {
        const lockedNow = lockDeepWinners(needRoom, S, tau, iv, governed);
        if (governed) floorCovers += lockedNow.length;
        // RE-RESOLVE the open against the now-updated ledger (it may have just gained cover-to-stack legs),
        // so the open can't NET against a lock we just placed — the 4-leg combo then merges two conflict-free
        // spreads (no combo-level wing-shift needed). Prefer the parity twin (same strikes → P&L-neutral).
        if (enforceLegs && lockedNow.length) {
          const _s2 = o.legs.map(l => l.strike), _lo2 = Math.min(..._s2), _hi2 = Math.max(..._s2);
          const preferStyle2 = recapAlt ? (Math.floor(legOpenN / altEvery) % 2 === 1 ? 'credit' : 'debit') : 'debit';
          const legAllow2 = opts.openNeverOtm ? ((lo, hi) => LL.notFullyOtm(sig.openSide, lo, hi, S)) : undefined;
          const res2 = LL.resolveOpen(sig.openSide, _lo2, _hi2, ledger, { incr: legIncr, maxShift: opts.legMaxShift || 6, preferStyle: preferStyle2, allow: legAllow2 });
          // Same as the first re-resolve: a shifted rebuild can decline on price. Record it and let the
          // commit gate below drop the open — `o` must never reach floorOf() without legs.
          if (res2.resolution === 'shift') {
            const o3 = G.buildOpen(sig.openSide, S + res2.shift * legIncr, tau, iv);
            if (o3 && o3.skip) { geoSkip++; geoDecline = true; } else { o = o3; resolvedLegs = res2.legs; }
          }
          else if (res2.resolution !== 'skip') resolvedLegs = res2.legs;
        }
        // Instrumentation hook (opts.onCoverToStack): READ-ONLY — measures 4-leg combo applicability.
        if (opts.onCoverToStack && lockedNow.length) {
          // `iv` is a per-leg FUNCTION when opts.ivSkew is on — the hook's mark() must honour that.
          opts.onCoverToStack({ locked: lockedNow, openLegs: o.legs, openSide: sig.openSide, width: G.WIDTH, mark: (type, k) => bs.bsPrice(type, S, k, tau, ivFor(type, k)) });
        }
      }
      // soft cap counts only AT-RISK debit (uncovered & NOT deep-ITM); hard cap + legacy count ALL uncovered.
      const totalUncov = uncoveredRisk();
      const atRisk = st.positions.reduce((s, p) => s + ((p.covered || isDeep(p)) ? 0 : p.limit * 100 * QTY), 0);
      // exemptTrendStack (v8): if every uncovered position is the SAME side as this open, we're stacking a
      // trend, not churning chop → skip the soft cap (only the hard ceiling limits a trend run).
      const stacking = st.positions.filter(p => !p.covered).every(p => p.side === sig.openSide);
      const softOk = (opts.exemptTrendStack && stacking) ? true : (atRisk + nd <= softCap);
      const strategyOk = (totalUncov + nd <= riskCap) && softOk && (totalUncov + nd <= hardCap);   // strategy RISK caps
      const ceilingOk = totalUncov + nd <= capCeiling;                                             // ACCOUNT capital ceiling (separate)
      // GOVERNOR HARD GATE — the projected BOOK FLOOR (rebuilt from the FINAL `o`, which the ledger
      // re-resolve above may have shifted) must stay inside lossMax. Because realized day P&L =
      // bookPayoff(settle) >= floor, and every open is gated here, the day's loss is bounded by lossMax.
      const govOk = !governed || geoDecline || -floorOf({ legs: o.legs, limit: o.limit, covered: false }) <= lossMax;
      if (!govOk) govBlocked++;
      if (strategyOk && ceilingOk && govOk && !geoDecline) {
        // OPEN FILL MODEL (opts.openFillModel, default 'immediate' = the historical assumption).
        // Until now an open was assumed FILLED AT THE LIMIT, always — the engine simply pushed the
        // position. That is the one order in the system whose execution was never modelled, and it is
        // not obviously safe: we price the open at the mark (+ a tick), so it fills only if the market
        // does not immediately run away from us. A bull call spread costs MORE as the underlying rises,
        // so an adverse move between the decision and the fill leaves our limit too low.
        // 'resting' models it the same way covers are modelled: the order works during the NEXT bar and
        // fills if the spread's price reached our limit at any point in it — i.e. price the legs at that
        // bar's FAVOURABLE extreme (low for a bull open, high for a bear) and compare. A miss is a
        // MISSED TRADE, not a loss; it is dropped and counted.
        if (opts.openFillModel === 'resting') {
          openTried++;
          const nb = bars[i + 1];
          if (nb) {
            const npx = priceOf(nb);
            const fav = sig.openSide === 'bull' ? npx.low : npx.high;
            const ntau = bs.tauFromTime(nb.dt);
            // Reuse THIS bar's vol surface rather than rebuilding next bar's: the fill happens within
            // minutes, and rebuilding would fold a vol change into what is meant to be a price test.
            if (legsMark(o.legs, fav, ntau, iv) > o.limit) { openMissed++; continue; }
          }
        }
        st.positions.push({ side: sig.openSide, shortStrike: o.shortStrike, legs: o.legs, limit: o.limit, covered: false, pendingCover: null, coverLegs: null, coverLimit: null, openEpoch: nowEpoch, openTime: nowET });
        // LADDER COVERING (opts.coverPriorOnOpen) — the CORRECTED reading of "continuous covering".
        // It never meant "rest a cover the instant a position opens"; it meant that opening a NEW position
        // is itself the trigger to cover a PRIOR one. Open one and leave it working; if a cover signal
        // comes, cover on the signal; if instead another OPEN signal comes, cover the earlier position
        // (now deeper in the money) as the new one goes on. Same family as cover-to-stack — free capital
        // by locking a winner — but paced by the open cadence instead of waiting for the risk cap.
        // Priced at the MARK: a cover placed to protect capital must not assume a profit.
        if (opts.coverPriorOnOpen) {
          const cands = st.positions.filter(p => !p.covered && !p.pendingCover && !p.hedge && p.openEpoch !== nowEpoch);
          if (cands.length) {
            // 'oldest' (the user's description: cover the first one) or 'deepest' (most ITM = biggest
            // winner to bank, which is what cover-to-stack picks). Swept, not assumed.
            let pick = cands[0];
            if (opts.coverPriorPick === 'deepest') {
              let bestM = -Infinity;
              for (const c of cands) { const m = legsMark(c.legs, S, tau, iv); if (m > bestM) { bestM = m; pick = c; } }
            }
            const plegs = opts.coverGeometry && opts.coverGeometry !== 'tent'
              ? SL.coverLegsAtShort(pick.side, SL.coverShortFor(opts.coverGeometry, pick.side, pick.shortStrike, S, legIncr), G.WIDTH)
              : G.coverLegs(pick.side, pick.shortStrike);
            // Same gate as the continuous path: the ladder is meant to bank a prior position that the
            // market has carried deeper ITM, so require that there is something to bank before placing.
            const pcost = legsMark(plegs, S, tau, iv);
            const pml = (opts.coverLockGate ? (opts.continuousCoverMinLockFrac || 0) * G.WIDTH : 0);
            if (!opts.coverLockGate || (pcost > 0 && (G.WIDTH - pick.limit - pcost) >= pml)) {
              pick.pendingCover = { legs: plegs, target: coverTarget(opts, plegs, S, tau, iv, round2(G.WIDTH - pick.limit)),
                openCost: pick.limit, minLock: 0, src: 'ladder', placedMs: nowEpoch, placedUnder: S, placedET: nowET };
            }
          }
        }
        markBookDirty();
        if (enforceLegs) { ledger.record(resolvedLegs); legOpenN++; }   // record actual played legs; advance alternation
        st.dir = sig.openSide;
        if (trackCap) {
          depD += nd; depC += nd; peakD = Math.max(peakD, depD); peakC = Math.max(peakC, depC);
          // ALTERNATING opens: first N debit (pay), next N credit (receive ~the debit-equivalent at
          // ATM by parity), repeat → net cash oscillates instead of draining.
          const creditOpen = Math.floor(openN / altEvery) % 2 === 1;
          depA += creditOpen ? -nd : nd; peakA = Math.max(peakA, depA); openN++;
          // depR: real-legs cash — on a credit turn, the parity credit spread (+cash); else the debit (-cash).
          const oStrikes = o.legs.map(l => l.strike), oLo = Math.min(...oStrikes), oHi = Math.max(...oStrikes);
          const openLegsR = creditOpen ? CL.openLegsFor(sig.openSide, oLo, oHi, 'credit') : o.legs;
          depR += CL.entryMark(openLegsR, capMark) * 100 * QTY; peakR = Math.max(peakR, depR);
        }
      } else {
        capBlocked++;   // a cap refused this open; was it a same-direction (trend-stacking) add?
        if (strategyOk && !ceilingOk) capSkipCeiling++;   // refused ONLY by the account ceiling (would've passed the strategy risk cap)
        if (st.positions.every(p => p.covered || p.side === sig.openSide) && st.positions.some(p => !p.covered)) capBlockedTrend++;
      }
      }   // end if(!legSkip1)
      }   // end else (adaptive geometry did not decline)
    }
    // RISK-HARVEST (opts.riskHarvest): after opens/covers, if a REACHABLE loss exists (worse than
    // hvTrigger over ±band = spot·iv·√tau·sigmas) and a ≥hvRatio far-side hedge is available, buy it to lift
    // the reachable floor toward 0 — spending a sliver of the peak. Ratio-gated (fires when lopsided, any
    // time of day), per-day budget. Hedges are held to settle. Off by default → baselines byte-identical.
    if (harvest) {
      const band = Math.round(S * iv * Math.sqrt(tau) * hvBandSig);
      const hvMaxPerDay = opts.harvestMaxPerDay != null ? opts.harvestMaxPerDay : Infinity;   // cap churn
      if (band > 0 && hvSpent < hvBudget && hvCount < hvMaxPerDay && RH.reachableFloor(st.positions, S, band, 10) < hvTrigger) {
        const mark = (type, strike) => bs.bsPrice(type, S, strike, tau, ivFor(type, strike));
        // CONVICTION: only hedge the loss side the underlying is trending TOWARD (15m close vs 9EMA).
        const trend = (opts.harvestDirGate !== false && A['15m'] && A['15m'].ema != null) ? Math.sign(A['15m'].close - A['15m'].ema) : null;
        const plan = RH.harvestPlan(st.positions, mark, S, { band, step: 10, incr: legIncr, widths: [20, 40, 60], depth: 8, minRatio: hvRatio, target: 0, budget: hvBudget - hvSpent, slip: opts.harvestSlip != null ? opts.harvestSlip : 0.5, trend });
        for (const h of plan.hedges) {
          st.positions.push({ side: 'hedge', shortStrike: null, legs: h.legs, limit: h.debit, covered: false, pendingCover: null, coverLegs: null, coverLimit: null, hedge: true, openEpoch: nowEpoch, openTime: nowET });
          hvSpent += h.cost; hvCount++; markBookDirty();
        }
      }
    }
    // deployedCapital average: sample the real deployed cash once per (RTH) action step. Overnight bars
    // are `continue`d above under rthOnly, so only true action steps are counted.
    if (trackCap) { sumReal += depR; nSteps++; }
    _bar = i; noteLock();   // END of the bar: opens, covers and the reduction ladder have all settled
  }
  // Settle: the 0DTE options settle at the 16:00 RTH close. For rthOnly, use the last bar at/through
  // 16:00 (not the 23:59 overnight close); otherwise (24h mode) the last bar of the day.
  let settleBar = bars[bars.length - 1];
  if (rthOnly) { for (let k = bars.length - 1; k >= 0; k--) { const m = etMinute(bars[k].dt); if (m >= 575 && m <= 960) { settleBar = bars[k]; break; } } }
  // THE LAST BAR IS NOT THE CLOSE. 0DTE options settle on the OFFICIAL index close at 16:00, but the last
  // RTH bar this engine sees closes at 15:55 — and those differ materially: 29,476.49 vs 29,507.70 on
  // 2026-09-08, 31.2 points, more than a $20 spread's whole width. Marking terminal P&L at the 15:55 bar
  // therefore settles near-the-money positions on the wrong side of their strikes. The live engine already
  // gets this right (it reads the $NDX quote's lastPrice and records settleSource 'index-close'); the
  // backtest had no way to know it, so opts.settlePrice lets a caller supply the real close. Unset keeps
  // the old behaviour so committed baselines reproduce.
  const settle = (opts.settlePrice > 0) ? opts.settlePrice : priceOf(settleBar).close;
  // bookPayoff(X): the FINAL EOD book's terminal P&L as a function of a hypothetical settle X — exactly the
  // terminal accumulation below but parameterized on X (same order + per-position round2), so terminal and
  // the risk-curve metrics can't drift. terminal = bookPayoff(settle).
  const bookPayoff = X => {
    let t = 0;
    for (const pos of st.positions) {
      let value = legsPayoff(pos.legs, X), cost = pos.limit;
      if (pos.covered && pos.coverLegs) { value += legsPayoff(pos.coverLegs, X); cost += pos.coverLimit; }
      t = round2(t + (value - cost) * 100 * QTY);
    }
    return t;
  };
  // Terminal P&L of a SNAPSHOT book at the day's actual settle — the like-for-like number to compare a
  // freeze against what continuing to trade produced.
  const snapPayoff = (snap) => (snap ? Math.round(snap.reduce((t, pos) => {
    let value = legsPayoff(pos.legs, settle), cost = pos.limit;
    if (pos.covered && pos.coverLegs) { value += legsPayoff(pos.coverLegs, settle); cost += pos.coverLimit; }
    return t + (value - cost) * 100 * QTY;
  }, 0)) : null);

  // OFFSET P&L attribution: what the floor-offset hedges actually settled for, vs what they cost. An
  // insurance overlay should be a net COST that buys a better floor — if this is strongly positive the
  // "hedges" are really directional bets and the risk story is not what it appears.
  let offsetPnl = 0;
  for (const pos of st.positions) if (pos.hedge) offsetPnl += (legsPayoff(pos.legs, settle) - pos.limit) * 100 * QTY;
  let floor = 0, opens = 0, filled = 0, naked = 0;
  for (const pos of st.positions) {
    opens++;
    if (pos.covered && pos.coverLegs) { floor = round2(floor + (G.WIDTH - pos.limit - pos.coverLimit) * 100 * QTY); filled++; } else naked++;
  }
  const terminal = bookPayoff(settle);
  // RISK-CURVE metrics — sweep bookPayoff over the span of TRADED strikes (5-pt grid; payoff is piecewise-
  // linear with kinks only at strikes and flat beyond the outer strikes, so endpoints capture the tails).
  //   bestCase  = max terminal over the grid (best settlement for the held book)
  //   worstCase = min terminal over the grid (max possible loss — the "regularly risky?" number)
  //   avgTerminalPotential = MEAN terminal over the grid (balanced-floor-with-peaks scores over jagged)
  let bestCase = 0, worstCase = 0, avgTerminalPotential = 0;
  if (st.positions.length) {
    let loStrike = Infinity, hiStrike = -Infinity;
    for (const pos of st.positions) {
      for (const l of pos.legs) { if (l.strike < loStrike) loStrike = l.strike; if (l.strike > hiStrike) hiStrike = l.strike; }
      if (pos.covered && pos.coverLegs) for (const l of pos.coverLegs) { if (l.strike < loStrike) loStrike = l.strike; if (l.strike > hiStrike) hiStrike = l.strike; }
    }
    if (!(hiStrike > loStrike)) {                       // degenerate (single strike) → evaluate one point
      const v = bookPayoff(loStrike); bestCase = v; worstCase = v; avgTerminalPotential = v;
    } else {
      bestCase = -Infinity; worstCase = Infinity; let sum = 0, cnt = 0;
      for (let X = loStrike; X <= hiStrike + 1e-9; X += 5) {
        const v = bookPayoff(X);
        if (v > bestCase) bestCase = v; if (v < worstCase) worstCase = v;
        sum += v; cnt++;
      }
      avgTerminalPotential = round2(sum / cnt);
    }
  }
  const coverPending = st.positions.filter(p => !p.covered && p.pendingCover).length;   // placed but never filled
  st.positions.forEach(p => { if (p.pendingCover) delete p.pendingCover._seen; });
  // REPLAY: the RTH bar series (epoch + ET stamp + underlying), so a backtest day can be rebuilt at any
  // point in time by the same UI code that replays a live day. Only built when asked (opts.recordReplay).
  const replay = opts.recordReplay ? bars.filter(b => !rthOnly || inRth(b.dt)).map(b => ({ epoch: b.dt, time: etStamp(b.dt), underlying: priceOf(b).close })) : null;
  return {
    floor, terminal, opens, filled, naked, coverPending, coverBySrc, openTried, openMissed, giveUps, gateCutoff, gateFloor, flyCount, flySpent: Math.round(flySpent), coverPicks, settle, replay, positions: opts.recordReplay ? st.positions : undefined, capBlocked, capBlockedTrend, capSkipCeiling, nCoverToStack, geoSkip,
    bestCase, worstCase, avgTerminalPotential,
    // LOCK TELEMETRY: did the day ever reach a guaranteed profit, and what would freezing there have paid?
    // frozenTerminal evaluates the book AS IT STOOD at that moment against the day's ACTUAL settle, so it
    // is directly comparable to `terminal` (what continuing to trade produced).
    lock: {
      // A day that never traded has a floor of exactly 0, which is not a locked profit — require a book.
      // NOTE the `floor` this function RETURNS is the sum of locked profit on COVERED pairs, ignoring
      // naked risk — a running conservative bound, not the book's worst case. The guaranteed-profit
      // question needs the EXACT book floor the governor bounds, which is floorNow().
      traded: st.positions.length > 0,
      endBookFloor: st.positions.length ? Math.round(floorNow()) : null,
      endFloorNoLoss: st.positions.length > 0 && floorNow() >= 0,
      endFloorProfit: st.positions.length > 0 && floorNow() > 0,
      bestFloor: Number.isFinite(bestFloorSeen) ? Math.round(bestFloorSeen) : null,
      everPositive: lockBar >= 0,
      atBar: lockBar, atTime: lockBar >= 0 ? etStamp(bars[lockBar].dt) : null,
      lockFloor: lockFloorV != null ? Math.round(lockFloorV) : null,
      lockPeak: lockPeakV != null ? Math.round(lockPeakV) : null,
      frozenTerminal: snapPayoff(lockSnap),
      // How many separate times the day entered the qualifying state, and what freezing at the BEST and
      // LAST of them would have paid. best is not implementable live (you cannot know it is the best until
      // the day is over) but it bounds what better timing could ever be worth.
      episodes,
      bestFloor2: bestLock ? Math.round(bestLock.floor) : null,
      bestPeak: bestLock ? Math.round(bestLock.peak) : null,
      frozenAtBest: snapPayoff(bestLock && bestLock.snap),
      lastTime: lastLock ? etStamp(bars[lastLock.bar].dt) : null,
      frozenAtLast: snapPayoff(lastLock && lastLock.snap),
    },
    capital: trackCap ? { peakDebit: peakD, peakCredit: peakC, peakAlt: peakA, peakReal: peakR, avgReal: nSteps ? round2(sumReal / nSteps) : 0, peakUncov, eodDebit: depD, eodCredit: depC, eodReal: depR, nCredit, nDebitCov } : null,
    legs: enforceLegs ? { ideal: legIdeal, twin: legTwin, shift: legShift, skip: legSkip, coverTwin: legCoverTwin, coverWing: legCoverWing, coverSkip: legCoverSkip, shiftSum, played: ledger.size() } : null,
    harvest: harvest ? { spent: Math.round(hvSpent), count: hvCount } : null,
    // WING CONVERSION telemetry, emitted UNCONDITIONALLY and at the top level. It used to live only
    // inside the `governor` block, which is null whenever there is no governor — so every `-unc` twin
    // reported no wing activity at all while actually running wings, and a reader could not tell "wings
    // did not fire" from "wings were never measured here". Wings are not part of the governor: the two
    // are independent mechanisms (the governor bounds the floor; wings convert peak into floor), and
    // tying one's telemetry to the other's existence is what hid this.
    wings: { count: wingCount, spent: Math.round(wingSpent) },
    // GOVERNOR telemetry: worstFloor = the worst book floor seen intraday (the number lossMax bounds);
    // breaches = bars spent through the working target; covers/offsets = what the reduction ladder did.
    governor: governed ? { lossTarget, lossMax, worstFloor: Math.round(worstFloor), worstFloorPre: -Math.round(worstFloorPre), breaches: floorBreaches, covers: floorCovers, offsets: offCount, offsetSpent: Math.round(offSpent), offsetPnl: Math.round(offsetPnl), blocked: govBlocked, coverDeferred, lockMode, lockGate, lockRested, wings: wingCount, wingSpent: Math.round(wingSpent), lockUnfillable, lockFillable } : null
  };
}

// frozen v5 on the 15m-close subset of the same data (via the frozen engine)
function runV5_15m(bars) {
  const sub = bars.filter(b => b.fifteen).map(b => ({ dt: b.dt, analysis: b.analysis }));
  if (sub.length < 5) return { floor: 0, terminal: 0, opens: 0, filled: 0, naked: 0 };
  return eng.runDay(sub, (A, p, ctx) => v5Signal(A, p, { ...ctx, cfg: {} }));
}

// ivMultAt/skewMultAt/etMinute are exported so ANALYSIS scripts can reprice a spread on exactly the same
// vol surface the engine trades on. Reimplementing the lookups in a caller is how a measurement quietly
// stops measuring the thing it claims to.
module.exports = { runDay5m, load5mDays, ivMultAt, skewMultAt, etMinute };

if (require.main === module) {
  const v6fn = (A, p, ctx) => v6Signal(A, p, { ...ctx, cfg: CFG });
  const rows = load5mDays(DIR).map(d => ({ date: d.date, v6: runDay5m(d.bars, v6fn), v5: runV5_15m(d.bars) }));
  console.log(`v6 5m-STEP vs FROZEN v5 (15m) — ${rows.length} NDX days`);
  console.log(`v6 cfg: ${Object.keys(CFG).length ? JSON.stringify(CFG) : '(defaults; add fiveMin=true to enable intra-5m)'}\n`);
  console.log('DATE         v6 O/F/N   v6 floor/term      v5 O/F/N   v5 floor/term');
  console.log('-'.repeat(78));
  const tot = { v6f: 0, v6t: 0, v5f: 0, v5t: 0 }; let wv6 = 0, wv5 = 0;
  for (const r of rows) {
    tot.v6f += r.v6.floor; tot.v6t += r.v6.terminal; tot.v5f += r.v5.floor; tot.v5t += r.v5.terminal;
    if (r.v6.terminal > r.v5.terminal) wv6++; else if (r.v5.terminal > r.v6.terminal) wv5++;
    console.log(r.date.padEnd(12) + `${r.v6.opens}/${r.v6.filled}/${r.v6.naked}`.padEnd(11) + `${money(r.v6.floor)}/${money(r.v6.terminal)}`.padEnd(19) +
      `${r.v5.opens}/${r.v5.filled}/${r.v5.naked}`.padEnd(11) + `${money(r.v5.floor)}/${money(r.v5.terminal)}`);
  }
  console.log('-'.repeat(78));
  console.log(`TOTALS      v6:  ${money(tot.v6f)} / ${money(tot.v6t)}      v5:  ${money(tot.v5f)} / ${money(tot.v5t)}`);
  console.log(`daily terminal wins:  v6 ${wv6}  ·  v5 ${wv5}  ·  ties ${rows.length - wv6 - wv5}`);
}
