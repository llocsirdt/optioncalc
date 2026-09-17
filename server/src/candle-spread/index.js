/**
 * Candle-spread runtime: run config, the aligned scheduler, live data glue, the
 * (dry-run) order placer, and read accessors for the API. Kept separate from the
 * paper-sim position-manager. Dependencies (candle analysis, chain fetch, trading
 * client, account hash) are injected via start() to avoid circular requires.
 */
const store = require('./store');
const trader = require('./trader');
const om = require('./order-manager');
const summary = require('./summary');
const ab = require('./analysis-builder');
const bs = require('./bs-pricer');
const RH = require('./risk-harvest');   // read-only risk-harvest OBSERVER (measures lopsidedness + real fills)
const VC = require('./variant-contract');
const tradability = require('./tradability');   // is there a market to trade at all? (holiday/halt/dead feed)
const setups = require('./setups');             // named start-of-day setups (informational; never trades)
const chartSeries = require('./../chart-series');

// THE WATCHLIST — THE UNTREATED CONTROLS. Purely a UI marker; the engine does not read it and every
// variant keeps running regardless.
//
// It used to mean "the six best expected performers", picked 2026-09-07 on efficiency and on being
// genuinely different bets. That meaning did not survive the fleet minLock split: v7-40 fell to ret/DD
// 41.5 with 407 losing days of 765, and v1-10 and v6-10 BECAME controls, so half the list was asserting
// two contradictory things at once. "Best" is also a prediction, and a prediction goes stale every time
// the config moves — which is how the list rotted without anyone noticing.
//
// It now marks the three capped MINLOCK control cells: no ladder, family-default minLock. That is
// definitional rather than predictive, so it cannot go stale, and it is the more useful glance — on any
// given day these say whether a result came from the market or from what we changed.
//
// THEY ARE NOT CLEAN OF EVERYTHING, and the tooltip says so rather than overclaiming. FLY_LIVE covers
// families v0/v2/v4/v6/v8, which catches v2-10 and v6-10, so only v1-10 carries no experiment at all.
// The overlap was not noticed when the two sets were chosen for different reasons on the same day. Left
// as is because the 2026-09-15 baselines are built on these control cells and moving them would orphan
// that run; the clean fix, if wanted later, is control cells drawn from families the fly set does not
// touch (v1/v3/v5/v7/v9) — v1-10 and v5-10 both qualify today.
//
// Overlaps the grey arm stripe deliberately. The stripe CLASSIFIES every cell; the watchlist lifts the
// cell ground so the reference set reads as a group from across the room. Classification and priority
// are different jobs and the controls happen to deserve both.
// ENV-OVERRIDABLE (2026-09-15) so the list can change without a package rebuild and redeploy. It is a UI
// marker with no engine behaviour behind it, so needing a deployment to re-aim it was pure friction —
// same reasoning as CANDLE_SPREAD_ARMED. Set CANDLE_SPREAD_WATCHLIST to a comma-separated variant list.
//
// The `-unc` twins of these cells are controls too, but the overlay hides `-unc`, so listing them would
// mark nothing visible while inflating the legend. Capped cells only.
const WATCHLIST = (process.env.CANDLE_SPREAD_WATCHLIST != null
  ? process.env.CANDLE_SPREAD_WATCHLIST
  : 'v1-10,v2-10,v6-10')
  .split(',').map(s => s.trim()).filter(Boolean);

// Named setups change only once a day, so evaluating them per tick would re-fetch a daily series for
// nothing. Cached for 30 minutes; failure is non-fatal and reported rather than thrown, because a setup
// badge going missing must never be able to disturb trading.
let setupCache = null, setupCacheAt = 0;
const SETUP_TTL_MS = 30 * 60 * 1000;
async function currentSetups(symbol) {
  const now = Date.now();
  if (setupCache && now - setupCacheAt < SETUP_TTL_MS) return setupCache;
  try {
    const series = await chartSeries.getChartSeries(symbol, 'daily');
    const rows = (series && (series.candles || series.data || series)) || [];
    // Drop any bar for TODAY: a setup must read the last COMPLETED day, never the forming candle.
    const todayKey = todayEST();
    const done = rows.filter((r) => {
      if (!r || r.datetime == null) return false;
      const d = new Date(r.datetime);
      const k = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
      return k < todayKey;
    });
    setupCache = { ...setups.evaluate(done), symbol, evaluatedAt: new Date(now).toISOString() };
  } catch (e) {
    setupCache = { ok: false, reason: 'daily series unavailable: ' + ((e && e.message) || e), setups: [] };
  }
  setupCacheAt = now;
  return setupCache;
}
const IIV = require('../../shared/intraday-iv');   // time-of-day IV multiplier — same source as the backtest
// Last tradability verdict, published to /status so the UI can show WHY the engine is standing down.
let LAST_TRADABILITY = null;   // fails the boot when a variant flag is not forwarded to the engine
const alias = require('./variant-alias');   // pre-2026-09-03 run names -> the current canonical roster
const { classicSignal } = require('./signals/classic-signal');
const { v4Signal } = require('./signals/v4-signals');
const { v5Signal } = require('./signals/v5-signals');
const { v6Signal } = require('./signals/v6-signals');
const { v7Signal } = require('./signals/v7-signals');

// Gate a signal to 15m closes only (classic/v4/v5 act at 15m; v6/v7 act every 5m). Mirrors the
// backtest's at15 wrapper: on intra-15m bars it returns a no-op decision.
const at15 = fn => (A, p, ctx) => ctx.isFifteen === false ? { openSide: null, cover: false } : fn(A, p, ctx);

// Base run config(s), keyed by (symbol, expiration). NDX 0DTE first. Each base run is
// fanned out into one shadow run PER VARIANT (see VARIANTS) that share the same live candle
// and chain snapshot each tick and differ ONLY in cover-selection, so they can be compared.
// dryRun=true => build + log orders but DO NOT send; assume fills so the day simulates.
const BASE_RUNS = [
  {
    symbol: 'NDX',             // PRICING instrument: strikes/chain/mark (options settle on NDX)
    signalSymbol: '/NQ',       // SIGNAL instrument: direction/Bollinger/reversal off NQ futures
    signalRth: false,          // build the NQ `A` from 24h (ETH+RTH) — matches v6's 762-day
                               // out-of-sample validation (overnight NQ acts as real S/R). Trading
                               // still only fires at RTH marks (the scheduler), on NDX.
    // expiration is set to "today" (0DTE) at start; overridden per environment if needed.
    expiration: null,
    spreadWidth: 20,
    strikeIncrement: 10,
    quantity: 1,
    tickIncrement: 0.05,       // NDX combos price in nickels; make per-run for other tickers
    coverTiming: 'on-reversal', // parked alt: 'each-candle'
    coverStyle: 'debit-offset', // parked alt: 'credit'
    // CAPITAL RECAPTURE (default for ALL strategies): alternate debit/credit OPENS every 3 + CREDIT covers
    // on deep-ITM winners — parity-equivalent (P&L-neutral, same settlement), but keeps NET cash deployed
    // low so the book is fundable (~$75k → ~$28k peak on v6). Debit-only runs pin capital and run the
    // account dry; recapture is the realistic combo that makes the strategy actually tradeable. LEG-
    // UNIQUENESS is its required companion (never trade a strike both ways — the broker nets same-symbol
    // positions; resolve to the parity twin / a strike shift / an anchor cover), costing ~0.6% of P&L.
    capitalRecapture: true, openAlternateEvery: 3, creditCoverFrac: 0.65,
    enforceLegUniqueness: true, legMaxShift: 6, legMaxWing: 8,
    // DAY-LOSS GOVERNOR + COVER-TO-CONTINUE as DEFAULTS for ALL strategies (2026-09-04) — REPLACES the
    // old hardCap/softCap regime as the risk layer. The caps gated `uncoveredRisk()` = Σ uncovered OPEN
    // DEBIT, an instantaneous at-open snapshot that ignores covered pairs' locked P&L and resets each time
    // the book is covered — so a day ran several sequential books each inside the cap and realized ~2× it
    // (v6-40 −$24,095 against a $20k hardCap). The governor instead bounds the BOOK FLOOR (worst terminal
    // P&L of the WHOLE day's book), which IS the day's max loss. See LOSS_TARGET/maxCapFor below.
    // coverToStack ("cover to continue") lets a blocked open lock a deep-ITM winner (≥ minFrac×width) to
    // free room and keep trading rather than going dormant. proactiveCoverFrac stays family-specific.
    lossTarget: 5000, floorOffset: true, coverToStack: true, coverToStackMinFrac: 0.65,
    // CONTINUOUS COVERING (see MIN_LOCK below) + lock covers priced as RESTING orders. 'rest' is the
    // best honest lock-pricing model measured; the legacy instant-book-at-target mode was deleted from
    // the engine (it booked below the market whenever the cover marked above the target).
    continuousCover: true, lockCoverMode: 'rest',
    // OPENING RULE: an initial order never STARTS fully out of the money. Adaptive placement already
    // guaranteed it; a leg-uniqueness shift rebuilt at the shifted strikes without re-checking, which
    // put 7 of 1,382 opens out on 2026-09-08 (each exactly one increment past the boundary). Measured
    // over 765 days it is free-to-positive: +$737 v0-10, +$2,135 v1-10, +$21,582 v6-20, +$13,326
    // v7-10, +$24,418 v7-20, +$4,630 v6-40, -$64 v7-40, with ZERO extra skipped opens.
    openNeverOtm: true,
    // MONEYNESS-AWARE IV (skew). Flat ATM vol is biased BY SIDE — measured against 15,028 real chain
    // quotes it under-prices bull call spreads by $69/contract and over-prices bear put spreads by $50.
    // Per-leg skew reduces those to +$1 / +$8. Removes bias, not dispersion (~$100 |err| either way).
    ivSkew: true,
    dryRun: true
  }
];

// The ported SIGNAL lineage (v4-v9). Each variant is the multi-timeframe signal fn (off the live
// `A` object; see analysis-builder + signals/) plus its cfg and cadence. All share the realistic
// TENT cover: coverSelector 'fixed-mark' (mark-priced tent) + coverFillModel 'resting' (works at
// target = width−open, fills when the real mark reaches it) — matching backtest-v6-5m.runDay5m.
//   v4/v5 act on 15m closes only (at15); v6/v7 act every 5m (fiveMin).
//   v7 = v6 signal + "be wrong" bidirectional opens (opposite side while holding).
// dryRun defaults true (simulate); flip a single variant to 'test'/false to send. v9 = v7 (be-wrong)
// + proactive covering.
const PORTED_COVER = { coverSelector: 'fixed-mark', coverFillModel: 'resting' };

// SIGNAL FAMILIES (width-INDEPENDENT). Each is a signal fn + cadence + cover config + any risk caps/flags,
// expressed at the BASE $20 width. The width sweep below cross-products these with WIDTHS → every family
// gets a -10 / -20 / -40 variant. v0-v3 = CLASSIC signal (15m price-action breakout/reversal) with the
// cover SELECTOR varying (fixed / greedy / joint / fixed-mark); v4-v9 = the multi-TF lineage on the
// mark-priced resting tent (PORTED_COVER). Caps here are the $20 values; buildVariants scales them by width.
// Risk-armed continuous covering: don't rest a cover until the book is actually at risk, OR until this
// position can be covered cheaply enough to be worth locking on its own merits. Both numbers are first
// passes to be swept — 0.60 of lossTarget, and a 2:1 locked-profit-to-cover-cost ratio (which is exactly
// the user's worked example: a $20 spread opened at $11, covered at $3, locks $600 for $300).
// Risk-armed continuous covering, at the BEST setting found by the 70-combination sweep (2026-09-06):
// arm early on book risk (0.2 x lossTarget) and take any cover that locks at least what it costs.
// The first pass was 0.60 / 2.0, which the sweep placed near the BOTTOM of the grid. Two findings drove
// this: the OPPORTUNITY trigger does nearly all the work (at armFrac 0.8, where the risk arm barely
// fires, adding oppRatio 1.0 took $606,735 -> $813,960 and ret/DD 61.2 -> 135.3), and a LOWER oppRatio is
// uniformly better (1.0 > 1.5 > 2.0 > 3.0) because the cheap covers are the ones that pay.
const RISK_ARMED = { continuousCoverArmFrac: 0.20, continuousCoverOppRatio: 1.0 };

const FAMILIES = [
  // ── v0-v3: ONE signal, four COVER policies ────────────────────────────────────────────────────────
  // These four were meant to differ by WHERE the offsetting spread goes, but continuous covering had been
  // overriding all of them — it rested a TENT on every position the moment it opened, so the selector
  // never saw a candidate and v0-v3 came out identical to the dollar. Re-differentiated 2026-09-05 on the
  // two axes that actually matter, which are independent:
  //   WHEN  — v0 rests a cover instantly (every position is decided at birth); v1-v3 arm only on risk,
  //           either the book floor reaching 60% of lossTarget or a cover cheap enough to lock 2x its own
  //           cost (the safety net for a couple of deep winners sitting through a reversal while total
  //           book risk stays low — lockDeepWinners cannot catch that, being gated on the floor ALREADY
  //           breaching lossTarget).
  //   WHERE — tent (butterfly, shares the short strike: cheapest cover, biggest locked floor, least
  //           upside) -> halfway -> at the underlying (condor: a plateau instead of a peak, more terminal
  //           potential, dearer cover, and at the far end it can push open+cover past the width and give
  //           up the guaranteed floor entirely — that is the trade being measured).
  // v0 KEEPS the instant tent deliberately: it is the control the other three are read against, and
  // v0-vs-v1 is a clean A/B of the POLICY with geometry held constant.
  // RE-SLOTTED 2026-09-06. The first arrangement put ALL THREE geometries behind risk-arming, so the
  // geometry comparison ran with a handicap applied to every arm — and the sweep then showed that arming
  // config was one of the worst in the grid. Geometry had therefore never been measured under the policy
  // that actually wins. Now v0/v1/v2 vary GEOMETRY under instant covering (the winning policy), and v3
  // carries the arming idea at its best measured setting, so v0-vs-v3 is a clean policy A/B with geometry
  // held at tent. All three geometry ideas keep a slot.
  { key: 'v0', label: 'classic tent', signalFn: at15(classicSignal), signalCfg: {}, coverSelector: 'fixed', coverFillModel: 'resting', coverGeometry: 'tent' },
  { key: 'v1', label: 'classic halfway', signalFn: at15(classicSignal), signalCfg: {}, coverSelector: 'fixed', coverFillModel: 'resting', coverGeometry: 'halfway' },
  { key: 'v2', label: 'classic at-money', signalFn: at15(classicSignal), signalCfg: {}, coverSelector: 'fixed', coverFillModel: 'resting', coverGeometry: 'underlying' },
  { key: 'v3', label: 'classic tent, risk-armed', signalFn: at15(classicSignal), signalCfg: {}, coverSelector: 'fixed', coverFillModel: 'resting', ...RISK_ARMED, coverGeometry: 'tent' },
  { key: 'v4', label: 'multiTF-overext', signalFn: at15(v4Signal), signalCfg: {}, ...PORTED_COVER },
  { key: 'v5', label: 'trend-flip',      signalFn: at15(v5Signal), signalCfg: {}, ...PORTED_COVER },
  // NOTE `testAtBase` is VESTIGIAL — arming is decided solely by ARMED_VARIANT (env, defaulting to
  // v7-10). Nothing reads this flag; it is left only so the v6 family definition matches its history.
  // All families inherit the day-loss governor from BASE_RUNS ($5k target, width-scaled max) plus the
  // continuous-covering policy; each also gets an uncapped `-unc` twin via buildUncapped() below.
  { key: 'v6', label: '5m-harness', signalFn: v6Signal, signalCfg: { fiveMin: true }, testAtBase: true, ...PORTED_COVER },
  { key: 'v7', label: 'be-wrong',   signalFn: v7Signal, signalCfg: { fiveMin: true, beWrong: true }, bidirectional: true, ...PORTED_COVER },
  // v8 = v6 signal + a soft "churn" cap on at-risk debit (exempt for a same-side trend stack) + proactive
  // deep-ITM covering, on top of the shared governor.
  { key: 'v8', label: 'risk-capped', signalFn: v6Signal, signalCfg: { fiveMin: true }, softCap: 3000, proactiveCoverFrac: 0.70, exemptTrendStack: true, ...PORTED_COVER },
  // v9 = v7 (be-wrong) + proactiveCover 0.80 on top of the $20k backstop — the high-ceiling variant.
  // Still paper pending go/no-go ([[project_daily_risk_tolerance]]).
  { key: 'v9', label: 'be-wrong + caps', signalFn: v7Signal, signalCfg: { fiveMin: true, beWrong: true }, bidirectional: true, proactiveCoverFrac: 0.80, ...PORTED_COVER },
];

// ADAPTIVE STRIKE PLACEMENT is the default geometry (2026-09-05). Rather than always placing the short leg
// at a FIXED offset, the engine takes the MOST ITM placement whose real price is still inside the ceiling,
// floored at straddle and never OTM — spending the budget on as much ITM as it can afford early when
// spreads are cheap, and walking outward only when price forces it. ITM spreads cover more easily, and we
// make money on COVERS, not opens. Measured over 765 days it beat the fixed short-ATM geometry on BOTH
// total and ret/DD in ALL 30 governed variants (+$289k to +$1.37M; v6-20 +90%, ret/DD 32.6 → 90.3).
// `spreadShift` is retained only as the fallback placement when adaptiveGeo is off.
//
// capFrac 0.60 — MEASURED, not the 0.65 rule of thumb: 0.60 beat 0.65 at every width and 0.70 was worse
// than fixed everywhere. ⚠️ It rests on MODELED marks; live reads both sides of the chain (call+put sum
// ~1.05-1.1 × W, anchor on the cheaper), and that read is what should confirm 0.60 over 0.65 — the gap is
// worth ~$740k on v6-20. capFrac GATES the trade; it never caps the price.
//
// maxItmStrikes 3 — MEASURED as the peak. The ladder saturates at 5 (itm5 == itm6 to the dollar), is
// effectively saturated at 4, and going deeper than 3 adds ~27 opens out of 20,086 (0.13%) whose
// risk/reward is the worst of the acceptable set. Beyond 3 the differences are tiny and inconsistent in
// sign (+7 ret/DD on v7-10, +0.5 on v0-20, −5.7 on v6-20); 2 is clearly worse everywhere.
// WING CONVERSION — peak->floor. Applied to EVERY variant at every width, including the `-unc` twins and
// the `-cATM` controls.
//
// It was first shipped scoped to `w >= 20` on the capped sweep only, which was wrong twice over:
//   1. The `-unc` twins and `-cATM` controls exist to isolate ONE difference — the caps, and the open
//      geometry respectively. Wings are neither. Giving the sibling wings and not the twin turned every
//      twin subtraction into "the governor PLUS wings", which is not what those variants measure.
//   2. The $10 exclusion generalised from a single variant. v7-10 really is noise (+0.2%, halves disagree
//      in sign), but v2-10 (+$9,379 / +$2,544) and v3-10 (+$4,135 / +$873) were positive in BOTH halves.
//      "The armed variant does not benefit" is not evidence that no $10 variant does.
// The correct default for a capability that is measured to help is ON everywhere, with any exception
// carried by MEASURED evidence for that specific variant rather than by extrapolation from a neighbour.
//
// Shape: NAKED longs allowed with the upside term on, but the short leg NOT swept outward. That arm had the
// best ret/DD on both variants tested (v6-20 100.1, v7-10 144.4) — keep the cheap anchor-pinned spreads as
// the floor workhorses and let an uncapped long compete only when the tail justifies it.
const WINGS = { wingConvert: true, wingMinRatio: 3, wingAfterMin: 0, wingBudgetFrac: 0.10,
  wingNaked: true, wingUpsideLambda: 1.0 };

const WIDTHS = [
  { w: 10, shift: 5,  capFrac: 0.60 },
  { w: 20, shift: 10, capFrac: 0.60 },
  { w: 40, shift: 20, capFrac: 0.60 },
];
const ADAPTIVE_GEO = { adaptiveGeo: true, maxItmStrikes: 3 };

// ── DAY-LOSS GOVERNOR SIZING ────────────────────────────────────────────────────────────────────────
// TARGET = the ideal max day loss, the SAME $5,000 for every model at every width — the working level the
// engine actively manages back toward (lock winners → buy a low-cost offset), without blocking.
// MAX = the hard ceiling no open may push the book floor through. It carries a WIDTH-SCALED BUFFER so a
// single order can marginally exceed the target instead of freezing the model — a wider spread costs more
// per contract, so it needs more headroom to place even one position:
//     maxCap = max(2 × width×100, target + width×100)   →   $10 → $6k · $20 → $7k · $40 → $9k
// (the 2×width term only binds for widths ≥ $50; below that target+width is the greater.)
// ── WHICH VARIANT IS ARMED (env-driven, no deploy needed) ───────────────────────────────────────────
//   CANDLE_SPREAD_ARMED       = variant name (default 'v6-20'). Give it a name not on the roster — e.g.
//                               'none' — to arm NOTHING, which is the safe way to stand the pipe down.
//   CANDLE_SPREAD_ARMED_MODE  = 'test' (default) sends a REAL order at an intentionally unfillable price
//                               and auto-cancels it; 'live' sends REAL, FILLABLE orders.
// This selects WHICH run may send. It does NOT arm anything by itself — every existing gate still
// applies: sending additionally requires DEPS.isProd === true AND CANDLE_SPREAD_LIVE === 'true'. So the
// default config here is inert in dev and inert in prod until the master switch is deliberately on.
// An unknown variant name arms nothing and is logged loudly at startup rather than silently falling back,
// because a typo silently arming the WRONG strategy is the failure mode that matters.
// Default moved v6-20 -> v7-10 on 2026-09-06. v7-10 beats v6-20 on EVERY axis in the 765-day baselines:
// total $2,792,160 vs $2,613,633, worst day -$5,990 vs -$7,000, maxDD30 -$20,324 vs -$28,933, ret/DD
// 137.4 vs 90.3, win 72% vs 64% — while needing roughly HALF the capital (peak $2,041 vs $3,916, ROC 1.8
// vs 0.9). It is also the variant where the governor is demonstrably load-bearing: uncapped it makes
// $3,045,845 with a -$11,120 worst day, so the cap nearly halves the worst day for 8% of the total.
// Its -$5,990 worst is above the $5,000 lossTarget but inside its $6,000 lossMax and well within the
// stated $5-10k daily tolerance. WATCH: v7 is the be-wrong (bidirectional) signal, the family that
// suffered in the mid-Feb chop stretch, and it trades ~35/day against v6-20's 26 — more order flow
// through the pipe, which is what a paper session should be stressing.
const ARMED_VARIANT = process.env.CANDLE_SPREAD_ARMED || 'v7-10';
// LIVE EXPERIMENTS, 2026-09-10. Two mechanisms, each on one of a correlated PAIR so the twin is a
// matched control running the same signal without the feature.
//
// GIVE-UP (force a resting cover to the market once the position turns against us) — the stronger of the
// two in backtest. Over 765 days WITH open fills modelled it is positive on 6 of 7 tested and improves
// win rate, cover fill AND ret/DD on all 7: v7-20 +$490,108, v9-20 +$355,233, v6-20 +$299,331,
// v8-20 +$227,781, v6-40 +$203,136, v3-20 +$59,789; v7-10 -$140,362 but ret/DD 114 -> 254.
//   v3-20 (give-up) vs v0-20      v8-20 (give-up) vs v6-20      v9-20 (give-up) vs v7-20
//
// LADDER (walk a resting cover's price toward the market on a schedule) — kept live DESPITE the backtest
// turning against it once opens were modelled, because that model is not trustworthy enough to kill it
// on: opens are limited at the MID (debitLimit returns the mark, no tick) while covers pay mark+tick, and
// the fill test hands the market a whole bar to move away from a price it may well have filled in
// seconds. The ladder looked good before opens were modelled and bad after — exactly the case where a
// live session should adjudicate rather than a simulation.
//   v2-20 (ladder)      vs v0-20             — v2 is v0 with at-money cover geometry
//   v5-20 (ladder)      vs v4-20             — different signals, so a weaker pair; read it on its own
//   v8-20-cATM (ladder) vs v6-20-cATM        — same family pairing as the give-up set, on the OTHER
//   v9-20-cATM (ladder) vs v7-20-cATM          geometry, so v8/v9 carry give-up at sATM and the ladder
//                                              at cATM and the two can be read side by side.
// NO `-unc` TWINS (user, 2026-09-10): uncapped variants swing far harder by construction, so their
// deltas look disproportionate and they are not strategies anyone would actually trade. The cATM set
// gives the same clean same-family control without that distortion.
// $40 EXTENSION (user, 2026-09-10): the $40s trail anyway so there is less to lose, and a wider spread
// with deeper-ITM strikes might fill more readily from a ladder. Measured, that fill hypothesis HOLDS —
// the ladder lifts v9-40 fill 45% -> 52% — but it costs more than the fills are worth, while GIVE-UP
// lifts fill too AND pays: v9-40-cATM +$789,050 (ret/DD 26.1 -> 42.8, fill 42 -> 50%), v9-40 +$287,694,
// v8-40-cATM +$40,669. So the $40 split follows the evidence: give-up on the v9 names where it is
// strongest, ladder on the v8 names where it is least bad (v8-40 -$11,063, the smallest ladder loss at
// that width) and the family already trails, which is the user's "least to lose" argument.
//   v8-40 / v8-40-cATM (ladder)  vs v6-40 / v6-40-cATM
//   v9-40 / v9-40-cATM (give-up) vs v7-40 / v7-40-cATM
//
// STEP SIZE IS WIDTH-DEPENDENT DESPITE stepDollars. $0.10/step beats $0.25 at $40 on every variant
// tested (v8-40-cATM -$23,125 vs -$143,511), because span = W x (lossCapFrac + minLockFrac) still scales
// and a fixed dollar step is a smaller FRACTION of a wider span. Fixing the concession per step removed
// most of the width dependence, not all of it.
// v7-10 added 2026-09-12. The ladder was first judged on TOTAL P&L (-$70,043 across its six variants) and
// called a loss; that was the wrong metric — it targets FILL RATE. Measured on what it aims at, over 765
// days, it is the strongest lever we have: +13 points of cover fill on average, against the minLock ramp's
// +5, and the two are additive rather than redundant. On v7-10 specifically it is not even a trade:
//   control      74.5% fill   $1,183,947   ret/DD 327.1
//   ladder       84.9% fill   $1,393,491   ret/DD 411.8     (+$209,544, worst day still -$1,000)
// Fill rate is the number that decides whether the BACKTEST IS TRUSTWORTHY AT ALL: modelling ~50% fills
// without being able to say WHICH half fail makes every total an approximation. Getting the armed variant
// to ~85-88% is what turns the backtest into a measurement of the strategy rather than of our fill guess.
const LADDER_LIVE = new Set(
  // EMPTY since the ladder became the fleet default (every non-control cell gets it via MINLOCK_FLEET).
  // NOTE WHAT THIS COSTS: there is no longer a ladder-alone or a minLock-alone arm, so the two can no
  // longer be told apart from here on. That is the deliberate consequence of adopting them together —
  // the question this fleet now asks is 0.10 vs 0.20, not which half of the pair is doing the work.
  // Still the per-variant override if a ladder-only arm is ever wanted again.
  (process.env.CANDLE_SPREAD_LADDER != null ? process.env.CANDLE_SPREAD_LADDER : '')
    .split(',').map(s => s.trim()).filter(Boolean));
// MIN-LOCK LEVEL A/B (2026-09-12). minLock is the price side of every resting cover — the target is
// `W - openCost - minLock` — so it decides what RETURN we refuse to close below. Stated that way the
// current settings are extreme: 0.20-0.35 of width is a 40-70% return DEMANDED on an intraday trade, and
// the fleet's fill rates line up with it almost exactly (v6-20 at 0.35 fills 47.7%, v7-10 at 0.20 fills
// 74.5%). The user's own rule is 5-10% of width — "locking even just $100 on a $20 tent is 10% profit on
// that capital... a good return on any investment even when measured in months or years".
//
// Measured over 765 days it is the biggest fill lever found, and on v7-10 it is not even a trade-off:
//   0.20 (current) + ladder   84.9% fill   $1,393,491
//   0.10           + ladder   89.1% fill   $1,446,388   <- MORE total AND more fill
//   0.05           + ladder   91.7% fill   $1,388,543   ret/DD 782
// Worst day is -$1,000 at EVERY level: the governor bounds the floor, so lowering minLock costs no risk.
//
// WHY FILL RATE IS THE POINT, not P&L: a backtest that models ~50% fills without being able to say WHICH
// half fail is an approximation with a plausible number on the end. Reaching ~90% makes the backtest a
// measurement of the STRATEGY rather than of our fill guess, which is what makes every later experiment
// trustworthy.
//
// SPREAD ACROSS BUCKETS AND WIDTHS, and kept attributable. The three signal blocks behave differently
// enough that a result on one says little about the others (v0-v3 classic tent geometry; v4-v6 multi-TF
// directional on the fixed-mark selector; v7-v9 bidirectional/capped).
//
// CORRELATIONS RE-COMPUTED 2026-09-14 on the CURRENT baselines (765 days, the post-wing-shift-fix set
// prod serves). The figures this block used to carry were measured BEFORE that fix moved +$6.8M through
// the fleet and were never refreshed; every one of them was too high — v0-20/v1-20 0.943 -> 0.752,
// v0-40/v3-40 0.985 -> 0.760, and worst, v9-10/v7-20 0.699 -> 0.192, which is barely a control at all.
// The ORDERING survived, so the original picks were sound in spirit; only the magnitudes were stale.
//
// LADDER+MINLOCK COMBINED, 3 WIDTHS x 3 (2026-09-14). The combined arm had been 3x W=10 and 1x W=40 with
// nothing at W=20, because every base W=20 slot was already spoken for and the only free W=20 names were
// `-cATM` — which this map could not reach until applyExperiments existed. Now balanced:
//   W=10  v7-10 0.10+L (armed, +cap)   v0-10 0.10+L  ctl v1-10 (r 0.646)   v9-10 0.05+L  ctl v7-20 (0.192!)
//   W=20  v4-20 0.10+L ctl v4-40 (0.737)  v2-20 0.10+L ctl v1-20 (0.795)   v6-20-cATM 0.10+L ctl v5-20-cATM (0.819)
//   W=40  v6-40 0.05+L ctl v5-40 (0.730)  v1-40 0.05+L ctl v2-40 (0.966)   v3-40-cATM 0.05+L ctl v0-40-cATM (0.988)
// v1-40/v2-40 (0.966) and v3-40-cATM/v0-40-cATM (0.988) are the tightest pairs on the whole roster: both
// halves were free, so the test and its control differ in exactly one thing.
//
// The SINGLE-FACTOR cells are deliberately kept so the 2x2 still reads: minLock-alone stays on v0-20/v0-40,
// ladder-alone on v5-20/v8-40/v8-20-cATM/v9-20-cATM/v8-40-cATM. v4-20 and v2-20 were UPGRADED into the
// combined arm (each already had one of the two factors), which is why their single-factor twins matter.
const MIN_LOCK_AB = (() => {
  const raw = process.env.CANDLE_SPREAD_MINLOCK != null ? process.env.CANDLE_SPREAD_MINLOCK
    // EMPTY since the fleet default landed. Every entry that used to live here is now covered by
    // MINLOCK_FLEET, and the 0.05 cells are deliberately gone: they were the ones doing the damage in the
    // 765-day rebuild (v1-40 floor -$870 -> -$2,309, v3-40-cATM -$966 -> -$2,156) while their controls
    // held flat. This map remains the per-variant OVERRIDE for a one-off test above the fleet level.
    : '';
  const m = new Map();
  for (const part of raw.split(',').map((x) => x.trim()).filter(Boolean)) {
    const [name, spec] = part.split(':');
    if (!name || !spec) continue;
    const ladder = /\+L$/i.test(spec);
    const frac = parseFloat(spec.replace(/\+L$/i, ''));
    if (Number.isFinite(frac)) m.set(name.trim(), { frac, ladder });
  }
  return m;
})();

const GIVEUP_LIVE = new Set(
  (process.env.CANDLE_SPREAD_GIVEUP != null ? process.env.CANDLE_SPREAD_GIVEUP : 'v3-20,v8-20,v9-20,v9-40,v9-40-cATM')
    .split(',').map(s => s.trim()).filter(Boolean));
// CAPITAL-PRESERVATION PAIRING (2026-09-11). A TIGHT width-relative day-loss cap plus the dynamic
// minLock ramp. Neither belongs on the fleet; together on one variant they are the configuration the user
// can actually run on a $25k account.
//
// THE CAP: lossMax = 1 x W x 100 (so $1,000 at W=10), lossTarget = 0.7 x that. Because lossMax bounds the
// BOOK FLOOR and every open is gated on it, -$1,000 is a TRUE per-day bound, not a sample statistic. Over
// 765 days v7-10 shows worst day -$1,000, only 5 days <= -$1k, ZERO days <= -$2k, and a worst peak-to-
// trough of -$3,620 = 14.5% of $25k recovered in 2 days — against 81% for the same variant ungated. It
// costs about half the total (ret/DD 126.9 -> 327.1, so what remains is 2.6x more efficient per unit of
// drawdown). The user is explicitly buying survivability with expected value while building $25k -> $50k.
//
// THE RAMP ONLY PAYS UNDER THE CAP, and the measurement is unusually clean because it is the same variant
// and the same ramp either way:  uncapped -$269,485  ·  capped +$94,974.
// Uncapped the ramp trades floor for fills (avgFloor -$774); capped the floor is already bounded by the
// governor so the same trade costs -$28 and the fills are kept. Fleet-wide and uncapped it loses on 18 of
// 29 variants (-$1.1M), which is why this is a PAIRING and not a default.
//
// Shape .25 -> 1 by 12:30 beat the more aggressive 0 -> 1 by 11:30 / 12:00 under the cap: those buy more
// fill but give back more floor, and at the margin under a cap that is no longer free.
// SPREAD ACROSS BUCKETS AND WIDTHS (2026-09-12). The cap ran on v7-10 alone — one variant, one bucket,
// one width — which is not enough to tell whether it generalises. It now runs on one variant from each
// signal block at a different width, each against a clean, correlated control that keeps the $5k/$7k/$9k
// production governor:
//   v7-10  bidirectional  W=10  cap $1,000   (armed)
//   v3-10  classic        W=10  cap $1,000   ctl v2-10 (r 0.789)
//   v6-20  multiTF        W=20  cap $2,000   ctl v6-10 (r 0.802)
//   v7-40  bidirectional  W=40  cap $4,000   ctl v7-20 (r 0.772)
//
// W=40 IS INCLUDED DELIBERATELY, AGAINST THE BACKTEST. The cap sweep says it fails badly there — v6-40 at
// k=1.0 still draws down 142.7% of a $25k account and takes 21 days to recover, versus 14.5%/2 days at
// W=10 — so this slot is spent expecting a negative. The reason to run it anyway is that the sweep is
// backtest-only, and the backtest's cover-fill model is measurably wrong (75% modelled against 48% live).
// A live W=40 read is the one way to find out whether the verdict survives contact with real fills; if it
// does, the width question is settled with evidence rather than by a model we already distrust.
const CAPPRES_LIVE = new Set(
  (process.env.CANDLE_SPREAD_CAPPRES != null ? process.env.CANDLE_SPREAD_CAPPRES : 'v7-10,v3-10,v6-20,v7-40')
    .split(',').map(s => s.trim()).filter(Boolean));
const ARMED_MODE = process.env.CANDLE_SPREAD_ARMED_MODE === 'live' ? false : 'test';   // false = real fillable orders

// FLY / CONDOR VALLEY REPAIR, LIVE (2026-09-14). Ported from the backtest, where it had existed as
// opts.flyConvert and never run live at all — it is one of the fields preflight listed as DORMANT.
//
// WHY IT IS THE COMPLEMENT TO WINGS, not a rival: wings and offsets only BUY, so they need cheap OTM
// premium and have little potential until late in the session; a fly SELLS THE BODY to fund its wings,
// so its net cost stays small while premium is rich. On 231 real chain snapshots a 30-wide fly runs $175
// (17:1) at 09:30 and $720 (4.2:1) by 15:00 — early/mid-day economics, the mirror image of when wings
// work, which is why flyBeforeMin stops it at 15:00 instead of running to the bell.
//
// HALF THE CAPPED FLEET, split by family so every fly variant has an adjacent, correlated control that
// keeps flies OFF: v0/v2/v4/v6/v8 carry it, v1/v3/v5/v7/v9 are the controls. That is 25 of the 50 capped
// variants, spanning all three widths and both geometries.
//
// PLUS FIVE `-unc` TWINS, and excluding them first was a measurement mistake. Flies repair the WORST
// TERMINAL VALUE — the deepest point of the risk curve — and on a capped variant the governor has already
// truncated that tail: measured over 120 days, worstCase never once fell below -$10k on v0-20 or v6-40,
// so there is nothing left to repair and the premium simply lowers every outcome. The `-unc` twins are
// the only population where the tail runs free. On v7-40-unc, where it reaches -$50k and 37 days of 120
// close below -$20k, flies improve the whole body of that tail: p5 -$41,745 -> -$39,048, p10 -$35,012 ->
// -$32,952, days below -$20k 37 -> 33, for 3.8% of terminal P&L.
//
// The `-unc` pairs are also the tightest controls on the entire roster — v7/v9 correlate 0.998-0.999 at
// every width, against 0.75-0.97 for the best capped pairs — so these five A/Bs are the cleanest
// measurement available anywhere:
//   v7-10-unc ctl v9-10-unc (0.998)   v7-20-unc ctl v9-20-unc (0.999)   v7-40-unc ctl v9-40-unc (0.999)
//   v6-40-unc ctl v8-40-unc (0.986)   v0-40-unc ctl v1-40-unc (0.980)
// Weighted to W=40 and to the bidirectional books, which is where the tail is actually deep.
//
// CAVEAT, stated plainly: several of these 25 already carry another experiment (v0-10 and v4-20 have
// ladder+minLock, v6-20 has the tight cap, v8-20 has give-up). Testing five features across 50 variants
// cannot keep every arm single-factor. Read a fly result against its adjacent-family control at the same
// width and geometry, and treat any variant carrying two flags as suggestive rather than attributable.
const FLY_LIVE = new Set(
  (process.env.CANDLE_SPREAD_FLY != null ? process.env.CANDLE_SPREAD_FLY
    : 'v0-10,v0-20,v0-40,v0-20-cATM,v0-40-cATM,'
    + 'v2-10,v2-20,v2-40,v2-20-cATM,v2-40-cATM,'
    + 'v4-10,v4-20,v4-40,v4-20-cATM,v4-40-cATM,'
    + 'v6-10,v6-20,v6-40,v6-20-cATM,v6-40-cATM,'
    + 'v8-10,v8-20,v8-40,v8-20-cATM,v8-40-cATM,'
    + 'v7-10-unc,v7-20-unc,v7-40-unc,v6-40-unc,v0-40-unc')
    .split(',').map(s => s.trim()).filter(Boolean));

// ORDER SLIP A/B (2026-09-14). Opens, offsets and wings were priced exactly AT the mark, which needs the
// market to come to us before anything fills. Paying a tick or two over makes the limit marketable against
// a realistic ask, at $5/tick/contract. The user's call: cheap next to a cover that never fills.
//
// NOT a fleet default. It changes what every order COSTS, so switching it on everywhere at once would
// move all 80 variants and leave no way to attribute the result — the same mistake the minLock ramp
// avoided. Default 0 (today's behaviour, byte-identical), enabled per variant here so its cost in floor
// and its gain in fills are both measurable against untouched controls.
//
// Spelling: `variant:ticks`, e.g. `v7-10:1`. A credit twin concedes the SAME number of ticks of credit —
// slipping only the debit side makes the twins economically different orders (the capital-recapture and
// leg-uniqueness parity suites catch that immediately).
const ORDER_SLIP_AB = (() => {
  const raw = process.env.CANDLE_SPREAD_ORDERSLIP != null ? process.env.CANDLE_SPREAD_ORDERSLIP : '';
  const m = new Map();
  for (const part of raw.split(',').map((x) => x.trim()).filter(Boolean)) {
    const [name, spec] = part.split(':');
    const n = parseInt(spec, 10);
    if (name && Number.isFinite(n) && n >= 0) m.set(name.trim(), n);
  }
  return m;
})();

// ── FLEET DEFAULT: LADDER + REDUCED MIN-LOCK (2026-09-15) ────────────────────────────────────────────
// minLock stops being an opt-in experiment and becomes the fleet setting, with the ladder alongside it.
// The old defaults demanded 0.25-0.35 of width — a 50-70% return on an intraday trade — and the cost of
// that is not theoretical: on 2026-09-14 v8-20 opened at $10.60, the rule allowed a cover at
// 20 - 10.60 - 7.00 = $2.40, and that order sat 77% below a $10.50 mark for 35 minutes, give-up fired
// too late, and the position settled at max loss. That is the default behaving as designed.
//
// LEVEL IS AN OPEN QUESTION, so it is the A/B rather than a decision. The 765-day sweep says the optimum
// is family-dependent and the two ends disagree: on v6-20, 0.20 BEATS 0.35 outright (+12.5 fill points and
// +$158,885 total) while 0.05 costs $396k and three quarters of the floor; on v7-20 even 0.05 more than
// doubles ret/DD (71.3 -> 157.6). So the fleet splits ~50/50 between 0.10 and 0.20 and live decides.
//
// ASSIGNED PER family x width CELL, not per variant, because a `-unc` twin isolates the CAPS and a
// `-cATM` comparator isolates the GEOMETRY — anything that is not the thing under test has to match the
// sibling, or the twin comparison measures two changes at once. So a cell's level propagates to its base,
// `-unc` and `-cATM` variants together.
//
// The split is a CHECKERBOARD over (family, width) so the level is orthogonal to both: 5/5 at W=20 and
// W=40, and no family sits entirely on one level. Deliberately not evidence-weighted — putting v7/v9 on
// 0.10 because the sweep likes it there would confound level with signal block and answer nothing.
const MINLOCK_FAMS = ['v0', 'v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8', 'v9'];
const MINLOCK_WIDTHS = [10, 20, 40];
// THE CONTROLS — three whole cells (base + `-unc`; W=10 has no `-cATM`), so six variants keep the family
// default and no ladder. One per signal block: v1-10 classic, v2-10 classic at-money, v6-10 multi-TF.
// Whole cells rather than single variants, again so the twin comparison stays clean.
const MINLOCK_CONTROL_CELLS = new Set(
  (process.env.CANDLE_SPREAD_MINLOCK_CTL != null ? process.env.CANDLE_SPREAD_MINLOCK_CTL : 'v1-10,v2-10,v6-10')
    .split(',').map(s => s.trim()).filter(Boolean));
// `vX-W` for any variant shape — the cell a variant belongs to.
const cellOf = (variant) => { const m = /^(v\d+)-(\d+)/.exec(variant); return m ? `${m[1]}-${m[2]}` : variant; };
const MINLOCK_FLEET = (() => {
  const m = new Map();
  for (const f of MINLOCK_FAMS) {
    for (const w of MINLOCK_WIDTHS) {
      m.set(`${f}-${w}`, (MINLOCK_FAMS.indexOf(f) + MINLOCK_WIDTHS.indexOf(w)) % 2 === 0 ? 0.10 : 0.20);
    }
  }
  // PINNED: v7-10 is the armed variant and the one configuration with real evidence behind it —
  // 0.10 + ladder measured 89.1% cover fill, $1,446,388 total and ret/DD 591.6 over 765 days, its best
  // result at any level. The checkerboard would have moved it to 0.20; live money does not get reshuffled
  // to keep a grid tidy.
  m.set('v7-10', 0.10);
  return m;
})();

// ── THE LIVE-EXPERIMENT HOOK — ONE PLACE, EVERY BUILDER ──────────────────────────────────────────────
// Every selector above (minLock A/B, cap preset, ladder, give-up) is applied HERE and only here, and all
// three builders (base, `-unc`, `-cATM`) call it. That is the whole point of the function existing.
//
// WHY (found 2026-09-14): the hooks used to be COPIED into each builder, and the copies drifted. The base
// builder had all four; `-unc` and `-cATM` had only ladder + give-up. So naming a `-cATM` variant in
// CANDLE_SPREAD_MINLOCK did NOTHING — the variant ran at its family default while the config said
// otherwise. It could not show up as a live-vs-backtest divergence either, because the backtest imports
// THIS ROSTER (build-backtest-baselines.js requires VARIANTS from this file), so both engines were
// equally wrong and preflight stayed green. The experiment simply never ran anywhere.
//
// The rule now: a selector list is the ONLY statement of what a variant is testing, and it reaches every
// variant shape. Anything a list names that cannot be honoured is REPORTED (see validateSelectors), never
// silently dropped.
function applyLadderCfg(v) {
  v.coverLadder = true; v.ladderStepSeconds = 300; v.ladderLossCapFrac = 0;
  // Step scales with width: $0.25 works the cover meaningfully on a $10/$20 tent, and on a $40 it would
  // walk the price too far per step, so $40 steps at $0.10.
  v.ladderStepDollars = (v.spreadWidth >= 40) ? 0.10 : 0.25;
}
// `capPreset:false` for the `-unc` twins ONLY. An uncapped twin exists to show the model with the
// governor removed; putting a cap back on it would not be "the same experiment on another variant", it
// would delete the variant's reason to exist. Naming a `-unc` variant in CANDLE_SPREAD_CAPPRES is
// therefore refused OUT LOUD by validateSelectors rather than quietly ignored.
function applyExperiments(v, { capPreset = true } = {}) {
  // FLEET DEFAULT first — ladder + the cell's minLock level, unless this is a control cell.
  const cell = cellOf(v.variant);
  if (!MINLOCK_CONTROL_CELLS.has(cell) && MINLOCK_FLEET.has(cell)) {
    v.continuousCoverMinLockFrac = MINLOCK_FLEET.get(cell);
    applyLadderCfg(v);
  }
  // MIN-LOCK A/B second, so an explicit entry still overrides the fleet level for a one-off test. Empty by
  // default now that the fleet carries ladder + reduced minLock; the map is the override, not the policy.
  const ab = MIN_LOCK_AB.get(v.variant);
  if (ab) {
    v.continuousCoverMinLockFrac = ab.frac;
    if (ab.ladder) applyLadderCfg(v);
  }
  // CAPITAL PRESERVATION — after minLock, since it overrides lossMax/lossTarget outright.
  if (capPreset && CAPPRES_LIVE.has(v.variant)) {
    v.lossMax = v.spreadWidth * 100;                 // 1 x width, the tightest cap that can still trade
    v.lossTarget = Math.round(0.7 * v.lossMax);
  }
  if (LADDER_LIVE.has(v.variant)) applyLadderCfg(v);
  // giveUpMaxLoss is the whole ball game: at 10 points a 5% cap is a clear win, 15% is mixed and 30% is a
  // rout (-$1.5M to -$2.0M across the four tested). Force the exit, but CHEAPLY — 5% of width is $1.00 on
  // a $20 spread, enough to cross the spread and not enough to chase.
  if (GIVEUP_LIVE.has(v.variant)) {
    v.coverGiveUp = true; v.giveUpPoints = 10; v.giveUpMaxLoss = 0.05;
  }
  // ORDER SLIP — ticks over the mark on opens/offsets/wings; a credit twin concedes the same.
  if (ORDER_SLIP_AB.has(v.variant)) v.orderSlipTicks = ORDER_SLIP_AB.get(v.variant);
  // FLY / CONDOR VALLEY REPAIR. Defaults match the backtest's (backtest-v6-5m.js) so the two engines
  // plan the same structures; only the prices differ (real chain live, Black-Scholes there).
  if (FLY_LIVE.has(v.variant)) {
    v.flyConvert = true; v.flyMinRatio = 3; v.flyBandSig = 1.5;
    v.flyBudget = 1500; v.flyMaxPerDay = 4; v.flyCondors = true; v.flyBeforeMin = 15 * 60;
  }
  // FLOOR RATCHET last — it reads spreadWidth, which every builder has set by the time we get here.
  // `-unc` twins never take it (see the note on FLOOR_RATCHET_FLEET); the explicit A/B map overrides
  // the grid so a single arm can be re-pointed from the environment without a package + deploy.
  if (!/-unc$/.test(v.variant)) {
    const frac = FLOOR_RATCHET_AB.has(v.variant) ? FLOOR_RATCHET_AB.get(v.variant)
      : FLOOR_RATCHET_FLEET.get(cell);
    if (frac != null) {
      v.floorRatchet = true;
      v.floorGiveBackFrac = frac;
      v.floorRatchetMinPeak = ratchetMinPeakFor(v.spreadWidth);
    }
  }
  return v;
}


// ── FLOOR RATCHET A/B (2026-09-16) ──────────────────────────────────────────────────────────────────
// THE FINDING that motivated it: on 2026-09-16 every one of 79 variants gave back book floor between its
// intraday peak and 15:00. Fleet peak $278,125 -> $48,995 at 15:00 — 82% of a GUARANTEED profit handed
// back, with 75 of 79 peaking at or after 14:00. This is not the day-loss governor's problem: lossMax
// bounds how bad the book can get in absolute terms and says nothing about surrendering a won floor, so
// a book can sit far inside the governor and still give everything back.
//
// THE ARMS. Three-way by CELL so every family and width carries a control:
//   off   — no ratchet (control)
//   0.25  — may give back a quarter of the peak floor
//   0.50  — may give back half
// `(family + width) % 3` spreads the arms evenly instead of clumping them by width, which matters because
// the give-back scaled hard with width (the $40s dominated the worst-12 list).
//
// CELL, not variant, so a `-cATM` comparator always carries the same arm as its base (cellOf strips the
// suffix) — otherwise the geometry comparison would be measuring the ratchet too.
//
// The `-unc` twins are EXCLUDED by name. They exist to show what the caps cost, and a retreat-from-peak
// budget is a cap; putting one on them would break the only variants that answer "what would no caps do".
// (Moot on today's data anyway — the worst `-unc` runs peaked at $0, so the ratchet never engages.)
//
// The minLock control cells stay control here too. They are the clean baseline for the ladder/minLock
// result and stacking a second live experiment on them would cost us that.
//
// ═══ MEASURED AND REJECTED, 765 days, 2026-09-16 ═══════════════════════════════════════════════════
// The grid is OFF by default. It cost money and bought nothing:
//   0.25 arm (15 variants): total $24,744,752 -> $22,987,882   (-$1,756,870, -$117,125/variant)
//   0.50 arm (16 variants): total $32,140,046 -> $30,413,140   (-$1,726,906, -$107,932/variant)
//   control (19 variants):  byte-identical, as were all 30 `-unc` twins — a clean experiment
// **31 of 31 ratcheted variants got WORSE. Not one improved.**
//
// And it failed on the metric it targets, not just on P&L. The worst floor HELD did not move by one
// dollar (-$7,394 -> -$7,394 at 0.25; -$7,796 -> -$7,796 at 0.50), nor did the worst single day. Max
// drawdown improved 1.4%, which is noise. The mechanism worked exactly as designed — opens/day 21.2 ->
// 19.9, win rate 63.5% -> 64.3% — it just bought the wrong thing.
//
// WHY, and it is the useful part: the ratchet only engages once a peak clears minPeak, so it is active
// precisely on the days that were ALREADY GOING WELL and dormant on the days that go badly — which are
// the days that set the worst floor. It is a profit-taker wearing a risk control's clothes, and the
// profit it banks is worth less than the continuation it forgoes. The 2026-09-16 live observation (82%
// of peak floor surrendered) was real but measured the FLOOR, which is a worst case, not the P&L: giving
// back floor buys variance, and over 765 days that variance pays for itself.
//
// STILL UNTESTED and closer to what the live day actually showed: the give-back was concentrated after
// 14:00, while this engages at any hour. A TIME-CONDITIONED ratchet (protect the floor only in the last
// hour) would leave the profitable mid-day continuation alone. Also untested: the backtest's dormant
// `openCutoffMin` / `openFloorGate`. Keep the flags — the machinery is sound and parity-checked, the
// POLICY is what failed. Arm a variant with CANDLE_SPREAD_RATCHET=v6-40:0.25 to re-test.
const RATCHET_LEVELS = [null, null, null];
const FLOOR_RATCHET_FLEET = (() => {
  const m = new Map();
  for (const f of MINLOCK_FAMS) {
    for (const w of MINLOCK_WIDTHS) {
      const cell = `${f}-${w}`;
      if (MINLOCK_CONTROL_CELLS.has(cell)) continue;               // keep the minLock controls clean
      // THE ARMED CELL STAYS SINGLE-FACTOR. v7-10 is the one variant sending orders and the one with real
      // evidence behind its config (0.10 + ladder, 89.1% cover fill over 765 days). The same reasoning that
      // kept it pinned through the minLock reshuffle applies here: the arm carrying order flow does not also
      // carry the newest experiment. An explicit CANDLE_SPREAD_RATCHET entry can still override this.
      if (cell === cellOf(ARMED_VARIANT)) continue;
      const lvl = RATCHET_LEVELS[(MINLOCK_FAMS.indexOf(f) + MINLOCK_WIDTHS.indexOf(w)) % 3];
      if (lvl != null) m.set(cell, lvl);
    }
  }
  return m;
})();
// Env override, same spelling as the other selectors: `variant:frac`, e.g. `v6-40:0.25`. Named per VARIANT
// (not cell) so a one-off arm can be pinned without moving its twin; an entry here wins over the grid.
const FLOOR_RATCHET_AB = (() => {
  const raw = process.env.CANDLE_SPREAD_RATCHET != null ? process.env.CANDLE_SPREAD_RATCHET : '';
  const m = new Map();
  for (const part of raw.split(',').map((x) => x.trim()).filter(Boolean)) {
    const [name, spec] = part.split(':');
    const frac = spec == null || spec === '' ? 0.25 : Number(spec);
    if (Number.isFinite(frac) && frac > 0 && frac < 1) m.set(name.trim(), frac);
  }
  return m;
})();
// Below this much locked floor the ratchet stays out of the way: there is nothing worth protecting, and a
// fraction-of-peak budget is zero at peak zero, which would block the first open of the day and every one
// after it. One spread-width of floor ($10 -> $1,000, $40 -> $4,000) is the natural scale — a $2,500 peak
// on a $40-wide book is noise, the same number on a $10-wide book is a real day's work.
const ratchetMinPeakFor = w => Math.max(1000, w * 100);

const LOSS_TARGET = 5000;
const maxCapFor = w => Math.max(2 * w * 100, LOSS_TARGET + w * 100);

// ── CONTINUOUS COVERING ─────────────────────────────────────────────────────────────────────────────
// Every uncovered position carries a standing resting cover from the moment it opens, at the price that
// still LOCKS A REAL PROFIT (not bare break-even). This is the single biggest measured improvement:
// across 9 variants × 200 days it beat OFF on both fill models at every threshold tested, and OFF averages
// only 43.9% of achievable. Resting at bare break-even is actively HARMFUL — it fills the instant the
// cover is barely acceptable, which is a bad trade on a deep winner (an uncovered spread wins
// W − openCost whenever it stays past its short strike; covering at break-even leaves 0 in both tails).
//
// Thresholds from the 2026-09-04 sweep (200 days, wings off, wick AND close fill models). Two gradients
// held throughout: WIDER spreads want a LOWER threshold, and BIDIRECTIONAL families want lower than the
// rest — v7/v9 already cover hard (proactiveCoverFrac 0.80), so a demanding lock only suppresses fills
// they need. The curve is flat across 0.20–0.35, so precision matters far less than being switched on.
//   MEASURED: v4 (0.30/0.30), v6 (0.35/0.35), v9 (0.20/0.20) at widths 10/20.
//   INFERRED: v8 shares v6's signal → v6's value; v7 shares v9's (be-wrong) → v9's; v5 is v6's lineage
//             predecessor → 0.30. v0–v3 (classic) were NOT swept → the safest single value, 0.25.
//   $40 is UNDER-DETERMINED — the optimistic and conservative fill models point OPPOSITE ways there
//   (v4-40 wick 0.10 vs close 0.25) — so it takes the safest single value pending the full 765-day run.
const MIN_LOCK = { v0: 0.25, v1: 0.25, v2: 0.25, v3: 0.25, v4: 0.30, v5: 0.30, v6: 0.35, v7: 0.20, v8: 0.35, v9: 0.20 };
const minLockFor = (key, w) => {
  const base = MIN_LOCK[key] != null ? MIN_LOCK[key] : 0.25;
  if (w >= 40) return Math.min(base, key === 'v7' || key === 'v9' ? 0.20 : 0.25);   // wider → lower
  return base;
};

// Cross-product families × widths → concrete variants `${key}-${w}`. Dollar risk caps are ABSOLUTE (a
// wider spread must not risk more — see BASE_RUNS.hardCap note); families that don't set a cap inherit the
// $20k baseline from BASE_RUNS. Fraction-of-width knobs (proactiveCoverFrac) are already width-relative.
function buildVariants() {
  const out = [];
  for (const f of FAMILIES) {
    for (const { w, shift, capFrac } of WIDTHS) {
      const v = {
        variant: `${f.key}-${w}`,
        variantLabel: `${f.label} $${w}${shift ? ' short-ATM' : ''}`,
        signalFn: f.signalFn, signalCfg: f.signalCfg,
        coverSelector: f.coverSelector, coverFillModel: f.coverFillModel,
        // Cover POLICY + GEOMETRY travel with the family — v0-v3 differ on exactly these. The `-unc`
        // twins take them too: a twin isolates the CAPS, so anything that is not a cap must match its
        // capped sibling. Note the risk gate reads lossTarget, which a `-unc` twin does not have, so on
        // those the risk arm can never trip and covering is opportunity-only — not a mismatch, but the
        // direct consequence of removing the cap, which is what the twin exists to show.
        ...(f.coverGeometry ? { coverGeometry: f.coverGeometry } : {}),
        ...(f.continuousCoverArmFrac != null ? { continuousCoverArmFrac: f.continuousCoverArmFrac } : {}),
        ...(f.continuousCoverOppRatio != null ? { continuousCoverOppRatio: f.continuousCoverOppRatio } : {}),
        spreadWidth: w, spreadShift: shift, ...ADAPTIVE_GEO,
        ...WINGS,
      };
      if (capFrac != null) v.capFrac = capFrac;
      if (f.bidirectional) v.bidirectional = true;
      if (f.exemptTrendStack) v.exemptTrendStack = true;
      if (f.proactiveCoverFrac != null) v.proactiveCoverFrac = f.proactiveCoverFrac;
      if (f.softCap != null) v.softCap = f.softCap;
      v.lossMax = maxCapFor(w);                          // lossTarget ($5k) + floorOffset inherit from BASE_RUNS
      v.continuousCoverMinLockFrac = minLockFor(f.key, w);
      // arming is decided by env (see ARMED_VARIANT) so the live pipe can be pointed at a different
      // strategy without a code package + deploy — an EB env-var change is an environment update only.
      if (v.variant === ARMED_VARIANT) v.dryRun = ARMED_MODE;
      // THE RAMP IS GONE from the cap-preset pairing, and lowering minLock is why. Both attacked the SAME
      // failure — a resting cover price the market never reaches — and minLock attacks it at the source.
      // Measured on v7-10 with the cap and the ladder in place, at minLock 0.10 the ramp buys +109 fills
      // (+0.8%) and costs $133/day of avgFloor and $51,662 of total. If those extra fills were new profit
      // the floor would RISE; it falls, so the ramp is not winning covers that would otherwise be lost —
      // it is taking covers that would have filled at the full lock and filling them EARLIER for less.
      // That is a straight giveaway once minLock is already reachable. Keeping it would also have meant
      // FOUR simultaneous changes on the only variant sending orders (cap + ramp + ladder + new minLock),
      // with no way to attribute a bad Monday to any one of them.
      applyExperiments(v);
      out.push(v);
    }
  }
  return out;
}

// UNCAPPED TWINS (`-unc`): the SAME family+geometry with the governor (and every legacy cap) switched OFF.
// Purpose (user, 2026-09-04): the risk-controlled number is the realistic one to trade, but a model's
// UNBOUNDED potential is its own metric — it says which strategies will scale as the risk tolerance is
// raised (or the cap eventually removed) as capital grows. Pairing every capped variant with its uncapped
// twin on ONE baseline run makes "what does the cap cost this model?" a direct subtraction. Always paper.
function buildUncapped() {
  const out = [];
  for (const f of FAMILIES) {
    for (const { w, shift, capFrac } of WIDTHS) {
      const v = {
        variant: `${f.key}-${w}-unc`,
        variantLabel: `${f.label} $${w}${shift ? ' short-ATM' : ''}, UNCAPPED`,
        signalFn: f.signalFn, signalCfg: f.signalCfg,
        coverSelector: f.coverSelector, coverFillModel: f.coverFillModel,
        // Cover POLICY + GEOMETRY travel with the family — v0-v3 differ on exactly these. The `-unc`
        // twins take them too: a twin isolates the CAPS, so anything that is not a cap must match its
        // capped sibling. Note the risk gate reads lossTarget, which a `-unc` twin does not have, so on
        // those the risk arm can never trip and covering is opportunity-only — not a mismatch, but the
        // direct consequence of removing the cap, which is what the twin exists to show.
        ...(f.coverGeometry ? { coverGeometry: f.coverGeometry } : {}),
        ...(f.continuousCoverArmFrac != null ? { continuousCoverArmFrac: f.continuousCoverArmFrac } : {}),
        ...(f.continuousCoverOppRatio != null ? { continuousCoverOppRatio: f.continuousCoverOppRatio } : {}),
        // Same GEOMETRY as the capped sibling — the `-unc` twin isolates the CAPS, so anything that is not
        // a cap (adaptive placement, the covering policy) must match or the comparison measures two things.
        spreadWidth: w, spreadShift: shift, ...ADAPTIVE_GEO,
        ...WINGS,   // NOT a cap — it must match the capped sibling or the subtraction measures two things
        lossTarget: null, lossMax: null, floorOffset: false,   // no governor
        continuousCoverMinLockFrac: minLockFor(f.key, w),      // covering policy is NOT a risk cap — the
        // `-unc` twins isolate the CAPS, so they keep the same covering policy as their capped sibling.
        softCap: null, hardCap: null, riskCap: null,           // no legacy caps either
      };
      if (capFrac != null) v.capFrac = capFrac;
      if (f.bidirectional) v.bidirectional = true;
      if (f.exemptTrendStack) v.exemptTrendStack = true;
      if (f.proactiveCoverFrac != null) v.proactiveCoverFrac = f.proactiveCoverFrac;
      // The live experiments apply to `-unc` twins too — v7-20-unc carries the ladder precisely because
      // its control (v9-20-unc) is behaviourally identical to it, which the capped set cannot offer once
      // v9-20 is taken by give-up. `capPreset:false` is the ONE exclusion: a cap preset on an uncapped
      // twin would delete the twin's reason to exist, so it is refused loudly instead (validateSelectors).
      applyExperiments(v, { capPreset: false });
      out.push(v);
    }
  }
  return out;
}

// ATM-CENTERED comparators (`-cATM`): the legacy shift-0 / capFrac-0.525 geometry, at the on-grid widths
// ($20/$40 only — $10 ATM-centered lands off the 10-pt grid). Every family gets a centered twin at each,
// so the short-ATM default sweep (vX-W) can be measured head-to-head against centered at the SAME width.
// Absolute caps (inherit BASE $20k unless the family sets one); never testAtBase → always paper.
const ATM_WIDTHS = [20, 40];
function buildAtmComparators() {
  const out = [];
  for (const f of FAMILIES) {
    for (const w of ATM_WIDTHS) {
      const v = {
        variant: `${f.key}-${w}-cATM`,
        variantLabel: `${f.label} $${w} ATM-centered`,
        signalFn: f.signalFn, signalCfg: f.signalCfg,
        coverSelector: f.coverSelector, coverFillModel: f.coverFillModel,
        // Cover POLICY + GEOMETRY travel with the family — v0-v3 differ on exactly these. The `-unc`
        // twins take them too: a twin isolates the CAPS, so anything that is not a cap must match its
        // capped sibling. Note the risk gate reads lossTarget, which a `-unc` twin does not have, so on
        // those the risk arm can never trip and covering is opportunity-only — not a mismatch, but the
        // direct consequence of removing the cap, which is what the twin exists to show.
        ...(f.coverGeometry ? { coverGeometry: f.coverGeometry } : {}),
        ...(f.continuousCoverArmFrac != null ? { continuousCoverArmFrac: f.continuousCoverArmFrac } : {}),
        ...(f.continuousCoverOppRatio != null ? { continuousCoverOppRatio: f.continuousCoverOppRatio } : {}),
        // Deliberately NOT adaptive: `-cATM` is the fixed ATM-centered CONTROL the sweep is measured
        // against, and a control that moves its own strikes is not a control. Everything that is NOT open
        // geometry still has to match the sweep, wings included.
        ...WINGS,
        spreadWidth: w, spreadShift: 0,   // centered; capFrac left unset → the debitLimit default
      };
      if (f.bidirectional) v.bidirectional = true;
      if (f.exemptTrendStack) v.exemptTrendStack = true;
      if (f.proactiveCoverFrac != null) v.proactiveCoverFrac = f.proactiveCoverFrac;
      if (f.softCap != null) v.softCap = f.softCap;
      v.lossMax = maxCapFor(w);                       // same governor as the short-ATM sweep
      v.continuousCoverMinLockFrac = minLockFor(f.key, w);
      // cATM builder hook — the live experiments must reach the -cATM comparators too. This used to carry
      // only ladder + give-up, which is exactly how the minLock A/B silently skipped every cATM name.
      applyExperiments(v);
      out.push(v);
    }
  }
  return out;
}

// RETIRED 2026-09-04: buildLowCap() — the `vX-W-10k` $10k-hardCap A/B twins. They existed to measure the
// cap dial when `hardCap` was the risk layer; the day-loss governor replaces that regime entirely (and
// the measurement they were built for is now the capped-vs-`-unc` pair). Removed rather than left dead.

// Validate the env selection against the roster the moment it is built, so a typo is loud, immediate and
// impossible to mistake for "armed but quiet".
// Every selector entry must LAND on a real variant. Before this existed only the armed name was checked,
// so a typo — or a variant shape a builder did not hook — produced a run set that quietly disagreed with
// the config describing it, in BOTH engines at once (the backtest imports this roster). You would then
// read the untouched family-default numbers as though they were the test arm. Neither preflight audit can
// see that: parity compares FIELDS between engines, distinctness compares variants to each other, and
// neither asks whether a requested config name actually took effect.
//
// Reported, not thrown: this module boots the live proxy that also serves the UI and the API, and a stale
// EB env var must not crash-loop the box. Instead it is loud on startup AND published on status() as
// `configProblems`, so the badge, the health check and preflight can all fail on it.
function validateSelectors(list) {
  const names = new Set(list.map(v => v.variant));
  const problems = [];
  const check = (envName, entries) => {
    for (const n of entries) if (!names.has(n)) problems.push(`${envName}: "${n}" matches no variant on the roster`);
  };
  check('CANDLE_SPREAD_MINLOCK', MIN_LOCK_AB.keys());
  check('CANDLE_SPREAD_LADDER', LADDER_LIVE);
  check('CANDLE_SPREAD_GIVEUP', GIVEUP_LIVE);
  check('CANDLE_SPREAD_CAPPRES', CAPPRES_LIVE);
  check('CANDLE_SPREAD_ORDERSLIP', ORDER_SLIP_AB.keys());
  check('CANDLE_SPREAD_FLY', FLY_LIVE);
  check('CANDLE_SPREAD_RATCHET', FLOOR_RATCHET_AB.keys());
  // The watchlist is only a UI marker, but a typo there silently un-marks a variant you meant to watch,
  // which is the same class of quiet failure as the rest of this function.
  check('CANDLE_SPREAD_WATCHLIST', WATCHLIST);
  // The one deliberate refusal — see applyExperiments.
  for (const n of CAPPRES_LIVE) {
    if (/-unc$/.test(n)) problems.push(`CANDLE_SPREAD_CAPPRES: "${n}" is an UNCAPPED twin — a cap preset cannot apply to it`);
  }
  if (problems.length && !process.argv.includes('--_slice')) {
    console.error('[candle-spread] ============ CONFIG PROBLEMS — THESE EXPERIMENTS ARE NOT RUNNING ============');
    for (const p of problems) console.error(`[candle-spread]   ${p}`);
    console.error('[candle-spread] The named variants run at their DEFAULTS. Do not read them as test arms.');
    console.error('[candle-spread] =============================================================================');
  }
  CONFIG_PROBLEMS = problems;
  return list;
}
let CONFIG_PROBLEMS = [];

function reportArming(list) {
  // Quiet in forked backtest workers — this line is about the LIVE order pipe and has nothing to do with a
  // backtest slice, but it fires once per worker process and buries the run's real output.
  if (process.argv.includes('--_slice')) return list;
  const hit = list.find(v => v.variant === ARMED_VARIANT);
  if (hit) console.log(`[candle-spread] ARMED SELECTION: ${ARMED_VARIANT} -> dryRun=${JSON.stringify(ARMED_MODE)} (${ARMED_MODE === false ? 'REAL FILLABLE ORDERS' : 'unfillable test orders'}); still gated by isProd + CANDLE_SPREAD_LIVE`);
  else console.log(`[candle-spread] ARMED SELECTION: "${ARMED_VARIANT}" is NOT on the roster — NOTHING is armed (all runs stay dryRun:true).`);
  return list;
}

const VARIANTS = reportArming(validateSelectors([
  ...buildVariants(),        // v0-v9 × 10/20/40, short-ATM, governor $5k target / width-scaled max
  ...buildUncapped(),        // v0-v9 × 10/20/40, short-ATM, NO caps — the unbounded-potential metric
  ...buildAtmComparators(),  // v0-v9 × 20/40, ATM-centered, same governor
]));

// Expand base runs × variants into the concrete run list.
function buildRuns() {
  const runs = [];
  for (const base of BASE_RUNS) for (const v of VARIANTS) runs.push({ ...base, ...v });
  return runs;
}

// Back-compat: some tests/importers reference DEFAULT_RUNS.
const DEFAULT_RUNS = BASE_RUNS;

let DEPS = null;         // { analyzeCandles, getOrFetchChainData, tradingClient, accountHash }
let RUNS = [];
let started = false;
let schedTimer = null;
let orderPollTimer = null;

function todayEST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD
}

function etParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit'
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map(x => [x.type, x.value]));
  let hour = parseInt(p.hour, 10); if (hour === 24) hour = 0;
  return { weekday: p.weekday, hour, minute: parseInt(p.minute, 10) };
}

const RTH_WEEKDAYS = new Set(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);
const STEP_MS = 5 * 60 * 1000;           // the engine now steps every 5m (v6/v7 act intra-15m)
const FIRST_ACTION_MIN = 9 * 60 + 35;   // 9:35 close of the first (9:30-9:35) 5m candle
const LAST_ACTION_MIN = 15 * 60 + 55;   // 15:55 last normal action before the 16:00 settle
const EOD_MIN = 16 * 60;                 // 16:00 close -> EOD settlement + summary

// Classify a 5-min boundary (by its ET wall-clock). Returns 'action' | 'first' | 'eod' | null.
// 'first' (9:35) is the day's first action bar → priorA=null (no intra-day prior yet).
function classifyBoundary(date) {
  const { weekday, hour, minute } = etParts(date);
  if (!RTH_WEEKDAYS.has(weekday)) return null;
  const t = hour * 60 + minute;
  if (t % 5 !== 0) return null;
  if (t === EOD_MIN) return 'eod';
  if (t === FIRST_ACTION_MIN) return 'first';
  if (t > FIRST_ACTION_MIN && t <= LAST_ACTION_MIN) return 'action';
  return null;
}

function msToNextBoundary(now = Date.now()) {
  return Math.ceil((now + 1) / STEP_MS) * STEP_MS - now;
}

// The 5m mark we just passed (epoch ms): now floored to the 5m grid. The scheduler fires ~5s after
// a boundary, so this is that boundary. isFifteen = the mark is also a 15m close.
function currentMark(now = Date.now()) { return Math.floor(now / STEP_MS) * STEP_MS; }
function markIsFifteen(mark) { return new Date(mark).getMinutes() % 15 === 0; }

// Master live-arm switch. Real orders NEVER go to Schwab unless this env var is the exact
// string 'true'. It is the deliberate "turn it on" toggle — the full send path below is wired
// and ready, but stays dormant until this is set. Off by default so deploying this code does
// not, by itself, start trading real money.
const LIVE_ARMED = process.env.CANDLE_SPREAD_LIVE === 'true';

// Test-mode knobs. In dryRun:'test' a REAL order is sent but at an intentionally unfillable price
// (so you can watch it hit Schwab and stick without any execution risk), then the poller cancels
// it after TEST_CANCEL_MS. TEST_FRAC = the debit fraction (0.1 => a $10.50 debit is sent at $1.05);
// credit orders invert it (see order-manager.unfillablePrice).
const TEST_FRAC = Number(process.env.CANDLE_SPREAD_TEST_FRAC) || 0.1;
const TEST_CANCEL_MS = Number(process.env.CANDLE_SPREAD_TEST_CANCEL_MS) || 60000;
const ORDER_POLL_MS = Number(process.env.CANDLE_SPREAD_POLL_MS) || 20000;

// The order placer.
//
// dryRun is TRI-STATE:
//   true    -> SIMULATE: build + log the order, assume filled at limit (no Schwab contact). Default.
//   'test'  -> REAL SEND at an UNFILLABLE price + auto-cancel (paper-validate the pipe, no fills).
//   false   -> REAL SEND at the real limit (actual trading).
//
// HARD SAFETY RULE: a real order ('test' or false) reaches Schwab ONLY when ALL of:
//   1. DEPS.isProd === true   — prod process only (dev NEVER sends → no duplicate orders).
//   2. LIVE_ARMED === true    — the master CANDLE_SPREAD_LIVE switch is deliberately on.
//   3. tradingClient + accountHash present.
// Anything short of that is SIMULATED (assumed filled) so the strategy still plays out for review.
//
// DECOUPLING: even on a real send we return filled:true so the state machine keeps simulating the
// INTENDED strategy (the run record stays complete). What actually happens at the broker is tracked
// separately by the order-manager poller (real fills, test cancels). See order-manager.js.
// REPLACE an already-resting order (the cover ladder's send path). Schwab exposes updateOrderById,
// which cancel/replaces atomically — safer than cancel-then-place, which can leave the book naked in
// between. Mirrors makePlaceOrder's gating exactly: the same dryRun / isProd / LIVE_ARMED conditions
// decide whether anything actually reaches the broker, so a disarmed run still records its intent.
function makeReplaceOrder(run, record) {
  const mode = run.dryRun;
  const wantsRealSend = mode === false || mode === 'test';
  return async function replaceOrder(orderId, payload, meta) {
    const canSend = DEPS && DEPS.isProd === true && wantsRealSend && LIVE_ARMED
      && DEPS.tradingClient && DEPS.accountHash && orderId;
    if (!canSend) {
      const why = !orderId ? 'no-order-id'
        : mode === true ? 'dryRun'
        : !(DEPS && DEPS.isProd) ? 'dev-mode'
        : !LIVE_ARMED ? 'disarmed' : 'no-client';
      store.appendEvent(record, { type: 'order_simulated', by: why, meta, payload, note: `replace not sent (${why})` });
      return { status: `simulated:${why}`, orderId };
    }
    const isTest = mode === 'test';
    const sendPayload = isTest
      ? { ...payload, price: om.unfillablePrice(payload, TEST_FRAC, run.spreadWidth, run.tickIncrement) }
      : payload;
    try {
      const resp = await DEPS.tradingClient.updateOrderById(DEPS.accountHash, orderId, sendPayload);
      const newId = (resp && resp.orderId) ? resp.orderId : orderId;
      store.appendEvent(record, {
        type: 'order_replaced', meta, payload: sendPayload, orderId, newOrderId: newId, testMode: isTest,
        note: `reprice ${meta && meta.fromLimit} -> ${payload.price}`
      });
      console.log(`[candle-spread] ${run.variant} REPRICE #${orderId} ${meta && meta.fromLimit} -> ${sendPayload.price}`);
      return { status: isTest ? 'test-replaced' : 'replaced', orderId: newId };
    } catch (e) {
      store.appendEvent(record, { type: 'order_error', meta, payload: sendPayload, note: `Schwab replace failed: ${e && e.message}` });
      console.error(`[candle-spread] ${run.variant} REPRICE FAILED #${orderId}: ${e && e.message}`);
      return { status: 'error', orderId, error: e && e.message };
    }
  };
}

function makePlaceOrder(run, record) {
  const mode = run.dryRun;                        // true | 'test' | false
  const wantsRealSend = mode === false || mode === 'test';
  return async function placeOrder(payload, meta) {
    const canSend = DEPS && DEPS.isProd === true && wantsRealSend && LIVE_ARMED
      && DEPS.tradingClient && DEPS.accountHash;
    if (!canSend) {
      const why = mode === true ? 'dryRun'
        : !(DEPS && DEPS.isProd) ? 'dev-mode'
        : !LIVE_ARMED ? 'disarmed'
        : 'no-client';
      store.appendEvent(record, { type: 'order_simulated', by: why, meta, payload, note: `not sent (${why}); assumed filled at limit` });
      console.log(`[candle-spread] ${run.variant} ${summary.orderLine(meta, payload, `SIM:${why}`)}`);
      return { status: `simulated:${why}`, filled: true };
    }
    // Real send. In test mode, rewrite the price to something that can't fill.
    const isTest = mode === 'test';
    const sendPayload = isTest
      ? { ...payload, price: om.unfillablePrice(payload, TEST_FRAC, run.spreadWidth, run.tickIncrement) }
      : payload;
    try {
      const resp = await DEPS.tradingClient.placeOrderByAcct(DEPS.accountHash, sendPayload);
      const orderId = resp && resp.orderId ? resp.orderId : null;
      om.trackOrder(record, {
        orderId, kind: meta.kind, positionId: meta.of || meta.positionId || null,
        net: payload.orderType, requestedPrice: payload.price, sentPrice: sendPayload.price,
        testMode: isTest, legs: meta.legs, placedAt: Date.now()
      });
      store.appendEvent(record, {
        type: 'order_sent', meta, payload: sendPayload, orderId, testMode: isTest,
        note: isTest ? `TEST send at unfillable ${sendPayload.price} (real ${payload.price})` : `LIVE send at ${sendPayload.price}`
      });
      console.log(`[candle-spread] ${run.variant} ${summary.orderLine(meta, sendPayload, `${isTest ? 'TEST' : 'LIVE'}#${orderId || '?'}`)}`);
      return { status: isTest ? 'test-sent' : 'sent', filled: true, orderId };
    } catch (e) {
      store.appendEvent(record, { type: 'order_error', meta, payload: sendPayload, testMode: isTest, note: `Schwab send failed: ${e && e.message}` });
      console.error(`[candle-spread] ${run.variant} ORDER SEND FAILED: ${e && e.message}`);
      // Keep simulating the intended strategy (decoupled) despite the send failure.
      return { status: 'error', filled: true, error: e && e.message };
    }
  };
}

// Find the just-closed candle (and its prior) from newest-first candles of the given period.
// A candle is "closed" when its open time + periodMs <= now. NOTE: assumes candle.datetime is the
// candle's OPEN time in epoch ms — verify against live Schwab data when enabling.
function pickJustClosed(candles, periodMs = 15 * 60 * 1000, now = Date.now()) {
  for (let i = 0; i < candles.length; i++) {
    const dt = typeof candles[i].datetime === 'number' ? candles[i].datetime : null;
    if (dt == null) continue;
    if (dt + periodMs <= now + 2000) { // small skew tolerance
      return { candle: candles[i], prior: candles[i + 1] || null };
    }
  }
  return { candle: null, prior: null };
}

// Group runs that share live data (candles + chain) so we fetch ONCE per (symbol, expiration)
// per tick instead of once per variant — the variants must not multiply the Schwab load.
// Compact ET stamp for log lines about a 5m mark.
function markOf(t) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York',
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date(t)).map(x => [x.type, x.value]));
  return `${p.month}/${p.day} ${p.hour === '24' ? '00' : p.hour}:${p.minute} ET`;
}

function groupKey(run) { return `${run.symbol}|${run.expiration || todayEST()}`; }

// Build the per-tick `deps` the engine reads. Extracted from the call site for ONE reason: it is a
// hand-maintained enumeration of every capability a variant can carry, and three separate omissions here
// (floorOffset, the two cover-arming flags, and the wing flags) each shipped a feature that silently did
// nothing live while the backtest showed it working. Because it is now a pure function of `run`, start()
// can replay it for every variant and assert that nothing in the config falls through — see assertDeps().
// `live` carries the per-tick values (chain accessor, order fn, the analysis objects).
function buildEngineDeps(run, live) {
  return Object.assign({
      dryRun: run.dryRun,
      signalFn: run.signalFn, signalCfg: run.signalCfg, bidirectional: run.bidirectional,
      // v8 risk-cap opts (undefined for other variants → cap logic inert)
      riskCap: run.riskCap, softCap: run.softCap, hardCap: run.hardCap,
      proactiveCoverFrac: run.proactiveCoverFrac, exemptTrendStack: run.exemptTrendStack,
      coverToStack: run.coverToStack, coverToStackMinFrac: run.coverToStackMinFrac,
      // CONTINUOUS COVERING (ported from the backtest 2026-09-04) — the covering POLICY, not a risk cap.
      continuousCover: run.continuousCover, continuousCoverMinLockFrac: run.continuousCoverMinLockFrac,
      // DAY-LOSS GOVERNOR — bounds the BOOK FLOOR (the day's true max loss), not at-risk debit.
      lossTarget: run.lossTarget, lossMax: run.lossMax,
      // FLOOR RATCHET — bounds the RETREAT FROM THE PEAK floor, which the governor structurally cannot
      // see (a book can be nowhere near lossMax and still hand back everything it won). Read off `deps`,
      // so like every other engine opt it MUST be listed here or the flag is a silent live no-op.
      floorRatchet: run.floorRatchet, floorRatchetMinPeak: run.floorRatchetMinPeak,
      floorGiveBackFrac: run.floorGiveBackFrac, floorRatchetAfterMin: run.floorRatchetAfterMin,
      // LOW-COST RISK OFFSET — the governor's only REPAIR tool (everything else it does is preventive:
      // block an open, defer a cover). Buys the far-side spread with the best floor-lift per dollar once
      // the floor is through the target. Tuning knobs fall back to the trader's defaults when unset.
      floorOffset: run.floorOffset, floorOffsetMinRatio: run.floorOffsetMinRatio,
      floorOffsetMaxPerDay: run.floorOffsetMaxPerDay, floorOffsetWidths: run.floorOffsetWidths,
      floorOffsetDepth: run.floorOffsetDepth, floorOffsetSlip: run.floorOffsetSlip,
      floorOffsetBudget: run.floorOffsetBudget,
      // COVER ARMING (v1-v3) — when to place the standing cover. NOTE these are read off `deps`, so they
      // MUST be listed here; `cfg` is a spread of the whole run and picks up everything automatically,
      // which is exactly why the omission was easy to miss.
      continuousCoverArmFrac: run.continuousCoverArmFrac, continuousCoverOppRatio: run.continuousCoverOppRatio,
      // OPENING RULE — read off `deps` in the leg-uniqueness resolve, so it MUST be listed here. Adding it
      // to BASE_RUNS without this line made the engine refuse to start (assertDeps), which is the guard
      // working: it would otherwise have been a silent no-op live while the backtest measured a gain.
      openNeverOtm: run.openNeverOtm,
      // COVER PRICING MODE — 'lock' (historical) vs 'mark'. Read off `deps`, so it must be listed here.
      coverPriceMode: run.coverPriceMode, coverSlipTicks: run.coverSlipTicks,
      // ORDER SLIP — ticks paid OVER the mark on opens/offsets/wings (and conceded on a credit twin), so
      // the limit is likelier to be crossed. Read off `deps`, so it MUST be listed here.
      orderSlipTicks: run.orderSlipTicks,
      // OPEN LADDER — separate from coverLadder so working an OPEN toward the market can be switched on
      // and measured on its own. Unset means "follow coverLadder", which is today's behaviour.
      openLadder: run.openLadder, openLadderStepDollars: run.openLadderStepDollars,
      // FLY / CONDOR VALLEY REPAIR — read off `deps`, so like every other engine opt it MUST be listed
      // here or the flag is silently dropped live while the backtest measures a gain.
      flyConvert: run.flyConvert, flyMinRatio: run.flyMinRatio, flyBandSig: run.flyBandSig,
      flyBudget: run.flyBudget, flyMaxPerDay: run.flyMaxPerDay, flyWidths: run.flyWidths,
      flyCondors: run.flyCondors, flyAfterMin: run.flyAfterMin, flyBeforeMin: run.flyBeforeMin,
      // COVER LADDER — work a resting cover toward the market instead of leaving it untouched all day.
      // Read off `deps`, so it must be listed here. Default OFF; see the note in BASE_RUNS.
      coverLadder: run.coverLadder, ladderStepSeconds: run.ladderStepSeconds, ladderStepPoints: run.ladderStepPoints,
      ladderSteps: run.ladderSteps, ladderLossCapFrac: run.ladderLossCapFrac,
      ladderStepDollars: run.ladderStepDollars,
      // GIVE-UP: force a resting cover to the market once the position turns against us. Read off deps.
      coverGiveUp: run.coverGiveUp, giveUpPoints: run.giveUpPoints, giveUpMaxLoss: run.giveUpMaxLoss,
      minLockRamp: run.minLockRamp, minLockRampStart: run.minLockRampStart, minLockRampEnd: run.minLockRampEnd,
      minLockRampFrom: run.minLockRampFrom, minLockRampTo: run.minLockRampTo,
      // WING CONVERSION — peak->floor. Read off `deps`, so like everything else here it MUST be listed
      // explicitly; `cfg` picks fields up automatically and that asymmetry is what hid two dead flags.
      wingConvert: run.wingConvert, wingMinRatio: run.wingMinRatio, wingAfterMin: run.wingAfterMin,
      wingBudgetFrac: run.wingBudgetFrac, wingBudget: run.wingBudget, wingMaxPerDay: run.wingMaxPerDay,
      wingBandSigmas: run.wingBandSigmas, wingOutSteps: run.wingOutSteps, wingNaked: run.wingNaked,
      wingUpsideLambda: run.wingUpsideLambda, wingTailSigmas: run.wingTailSigmas,
      comboOrders: run.comboOrders, comboSlip: run.comboSlip,   // 4-leg atomic cover+open (default off)
      capitalRecapture: run.capitalRecapture, openAlternateEvery: run.openAlternateEvery, creditCoverFrac: run.creditCoverFrac,
      enforceLegUniqueness: run.enforceLegUniqueness, legMaxShift: run.legMaxShift, legMaxWing: run.legMaxWing,
    }, live);
}

// Startup check: every variant's config must be fully represented in buildEngineDeps. Runs once, before
// any order can be placed, so an unforwarded flag is a boot failure rather than a silent live no-op.
function assertDeps(runs) {
  for (const run of runs) {
    const keys = Object.keys(buildEngineDeps(run, {}));
    // LIVE-ONLY exemptions. These are deliberately narrow and scoped here rather than added to the shared
    // NOT_ENGINE_OPTS, because the BACKTEST consumers do have to forward them and must keep being checked.
    //   coverGeometry / coverSelector — reach the engine through `cfg = record.config` (the persisted run
    //     config is a spread of the whole variant), so they are forwarded, just on the other channel.
    //   lockCoverMode / ivSkew — backtest PRICING-MODEL choices with no live counterpart: live reads real
    //     chain quotes (no modelled skew) and a resting cover either fills or does not (no fill model).
    VC.assertForwarded(run, keys, 'live deps (buildEngineDeps)',
      ['coverGeometry', 'coverSelector', 'lockCoverMode', 'ivSkew']);
  }
}

async function processGroup(runs, kind) {
  const sample = runs[0];
  const expiration = sample.expiration || todayEST(); // 0DTE default
  const tradeDate = todayEST();
  const priceSymbol = sample.symbol;                        // NDX (strikes/chain)
  const signalSymbol = sample.signalSymbol || priceSymbol;  // instrument the `A` object is built from

  const T = currentMark();
  const isFifteen = markIsFifteen(T);

  // Build the live multi-timeframe `A` from the SIGNAL instrument's deep raw 1m — same
  // resample + indicators + slotting as the backtest (analysis-builder), so the ported signals see
  // the same `A` they were validated on. PARITY NOTE: the builder is parity-proven on NDX RTH data;
  // a /NQ (24h futures) signal instrument needs its own parity fixture before arming.
  let raw1m;
  // signalRth:false → 24h (ETH+RTH) NQ for the `A` bands (matches the validation); default RTH.
  try { raw1m = await DEPS.getRaw1m(signalSymbol, { rth: sample.signalRth !== false }); }
  catch (e) { console.error('[candle-spread] getRaw1m failed:', e && e.message); return { pending: 'raw1m-fetch-failed' }; }
  if (!raw1m || raw1m.length < 100) return { pending: 'raw1m-insufficient' };
  const series = ab.buildSeries(raw1m);
  const cur = ab.analysisAt(series, T);
  if (!cur.warm) return { pending: 'analysis-not-warm' };    // retry: 1m/5m/15m/60m not all warm yet
  const A = cur.A;
  // priorA = the PRIOR 5m bar's A — TRUE CONTINUITY. The NQ signal is built from the continuous 24h
  // Globex series, so even the day's first RTH mark (9:35) has a real prior bar (9:30); we do NOT
  // null it. Falls back to null only if there's genuinely no warm prior (thin/just-started data).
  const prev = ab.analysisAt(series, T - STEP_MS);
  const priorA = prev.warm ? prev.A : null;

  // PRICING underlying (strike centering). Single-instrument: A's own 5m close. Split (signal≠price):
  // the price instrument's just-closed 5m close.
  let underlying = A['5m'] && A['5m'].close;
  if (signalSymbol !== priceSymbol) {
    try {
      const pxAnalysis = await DEPS.analyzeCandles(priceSymbol, { timeframe: '5m' });
      const px = pickJustClosed(pxAnalysis?.candleData?.['5m']?.candles || [], STEP_MS);
      if (!px.candle) return { pending: 'price-candle-not-available' };
      underlying = px.candle.close;
    } catch (e) { console.error('[candle-spread] price fetch failed:', e && e.message); return { pending: 'price-fetch-failed' }; }
  }
  if (!(underlying > 0)) return { pending: 'no-underlying' };

  // Option chain for pricing — the price instrument (NDX).
  const chainData = await DEPS.getOrFetchChainData(priceSymbol, expiration);

  // TRADABILITY GATE — is there actually a market to trade right now?
  // Checked HERE, once per tick before any variant is evaluated, so a closed/halted/unquoted market is a
  // single explicit decision rather than 80 variants each failing somewhere downstream for their own
  // reasons. Discovered on 2026-09-07 (Labor Day): NDX was closed, /NQ was open, and the engine ran all
  // day on a frozen NDX price with a chain of 17 strikes that carried no quotes at all. Nothing stopped
  // it — both 15m decision points happened to return `neutral`, which is luck, not a safety property.
  // See tradability.js for why this gates on EVIDENCE (can we see a price, is there a two-sided market)
  // rather than on a holiday calendar.
  currentSetups(priceSymbol).catch(() => { /* cached failure is reported in status(); never blocks a tick */ });
  const tradeGate = tradability.assess({
    underlying,
    nowMs: T,
    chainSnapshot: trader.snapshotChain(trader.makeLegAccessor(chainData, expiration), underlying,
      sample.strikeIncrement, sample.snapshotStrikes || 16),
  });
  // Publish the verdict either way, so the UI can show a live "not trading, and here is why" state
  // rather than the operator having to infer it from an absence of orders. An absence looks identical to
  // a quiet signal day, which is exactly the confusion that let a whole holiday session go unnoticed.
  LAST_TRADABILITY = { ...tradeGate, at: Date.now(), mark: markOf(T), markMs: T,
    symbol: priceSymbol, expiration, underlying };
  if (!tradeGate.ok) {
    // Log once per tick, not per variant, and keep it visible: this is the difference between "we chose
    // not to trade" and "something is broken", and the two must never be confused in the record.
    console.warn(`[candle-spread] NOT TRADABLE (${tradeGate.reason}): ${tradeGate.detail} — skipping tick ${markOf(T)}`);
    return { pending: `not-tradable:${tradeGate.reason}` };
  }

  // Synthetic 5m candle for the engine's plumbing (de-dupe key, event log, classic simpleDir field).
  // Decisions come from the signal fn off `A`, NOT from this candle. Compact "MM/DD HH:MM" ET time
  // (matches the classic convention + the summary's TIME column; unique per 5m mark).
  const tp = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date(T)).map(p => [p.type, p.value]));
  const markTimeEST = `${tp.month}/${tp.day} ${tp.hour === '24' ? '00' : tp.hour}:${tp.minute}`;
  const c5 = A['5m'];
  // datetime = the 5m mark epoch (ms) — the SAME grid /chartseries uses, so trade markers land on the
  // exact NQ candle without parsing the human timeEST. timeEST stays for the log/summary TIME column.
  const candle = { timeEST: markTimeEST, datetime: T, open: c5.open, high: c5.high, low: c5.low, close: c5.close };

  // Time-to-expiry + IV for the read-only harvest observer's reachable band (spot·iv·√tau·σ).
  //
  // TWO CORRECTIONS, and they only work TOGETHER (fixed 2026-09-07, basis marker `iv15m+intraday`):
  //   1. 15m bands, not 5m. The intraday-IV calibration is defined as
  //      ivMult(t) = median[ ATM_implied_real(t) / bandIV(day) ] where bandIV is measured from the
  //      15m band — and the backtest's own ivOf() is 15m too. Applying that multiplier on top of a
  //      5m-derived IV would be a DIFFERENT wrongness, not a fix, because the multiplier's denominator
  //      would no longer be the quantity being multiplied.
  //   2. Apply the multiplier. Without it the band ran ~21% too narrow at the open and ~19% too wide
  //      into the close. That biased the observer in exactly the dimension it exists to measure: a
  //      too-narrow band at the open scans a smaller region, finds fewer reachable loss zones, and so
  //      UNDER-REPORTS how early lopsidedness appears — which is the whole research question.
  // bandSigmas stays 2.0 (see the observe() call): the observer deliberately casts a wider net than
  // wing conversion's 1.5, because it is looking for zones to study, not zones to pay to fix.
  let harvestTau = 0, harvestIv = 0;
  try {
    harvestTau = bs.tauFromTime(candle.datetime);
    const b15 = A['15m'];
    const etm = (() => { const q = etParts(new Date(candle.datetime)); return q.hour * 60 + q.minute; })();
    harvestIv = bs.ivFromRelBandWidth((b15.bbupper - b15.bblower) / b15.close) * IIV.ivMultAt(etm);
  } catch (e) { /* leave 0 → observer skips */ }

  // Feed every ported variant the SAME live A + underlying + chain (apples-to-apples).
  for (const run of runs) {
    try {
      const cfg = { ...run, expiration };
      delete cfg.signalFn;   // functions don't serialize; keep the persisted run config JSON-clean
      const record = store.initRun(cfg, tradeDate);
      const getLeg = trader.makeLegAccessor(chainData, expiration);
      const placeOrder = makePlaceOrder(run, record);
      const replaceOrder = makeReplaceOrder(run, record);
      await trader.processCandleClose(record, candle, null, buildEngineDeps(run, {
        getLeg, placeOrder, replaceOrder, A, priorA, isFifteen, underlying, signalSymbol, priceSymbol,
      }));
      // RISK-HARVEST OBSERVER (read-only, ALL variants): does this book's risk curve go lopsided, when
      // (first time / how often), and what would the far-side hedge REALLY cost on the live chain (mid vs
      // marketable)? Records onto state — NEVER trades, never affects the strategy. Answers: how early it
      // shows up, how often, and whether NDX OTM spreads fill near mid (the slippage question). See v11 research.
      try {
        const st = record.state;
        if (harvestTau > 0 && harvestIv > 0 && st.positions && st.positions.length) {
          const obs = RH.observe(st.positions, getLeg, underlying, harvestTau, harvestIv, { bandSigmas: 2.0, minRatio: 3, trigger: -500 });
          if (obs) {
            // BASIS MARKER. The band definition changed on 2026-09-07 (5m -> 15m bands, intraday IV
            // multiplier applied). Samples recorded before that are not comparable with samples after,
            // and a research series whose meaning silently changed mid-collection is worse than no
            // series at all — so every record says which definition produced it.
            if (!st.harvestObs) st.harvestObs = { count: 0, firstLopsidedTime: null, worstFloor: 0, samples: [], basis: 'iv15m+intraday' };
            if (!st.harvestObs.basis) st.harvestObs.basis = 'iv15m+intraday';
            if (obs.lopsided) {
              st.harvestObs.count++;
              if (!st.harvestObs.firstLopsidedTime) st.harvestObs.firstLopsidedTime = candle.timeEST;
              if (obs.reachableFloor < st.harvestObs.worstFloor) st.harvestObs.worstFloor = obs.reachableFloor;
              if (st.harvestObs.samples.length < 150) st.harvestObs.samples.push({ time: candle.timeEST, epoch: candle.datetime, spot: obs.spot, floor: obs.reachableFloor, hedge: obs.hedge || null });
            }
            st.lastHarvestObs = obs;
          }
        }
      } catch (e) { /* observer must never break the tick */ }
    } catch (e) {
      console.error(`[candle-spread] variant ${run.variant} error:`, e && e.message);
    }
  }
  return { acted: true };
}

// Poll for candle availability: fire at boundary+5s, retry every 5s up to a cap.
// Held for the whole tick INCLUDING its retries, so the sub-bar worker cannot mutate a record between a
// failed attempt and the retry that succeeds. Both touch the same run records; the candle tick owns them
// while it is running, and the worker skips rather than queues (it runs again in WORK_MS anyway).
let tickBusy = false;
function attemptTick(kind, retriesLeft) {
  const groups = {};
  tickBusy = true;
  for (const run of RUNS) { (groups[groupKey(run)] = groups[groupKey(run)] || []).push(run); }
  Promise.all(Object.values(groups).map(runs => processGroup(runs, kind).catch(e => ({ error: e.message }))))
    .then(results => {
      const stillPending = results.some(r => r && r.pending);
      if (stillPending && retriesLeft > 0) {
        setTimeout(() => attemptTick(kind, retriesLeft - 1), 5000);   // stays busy across the retry
      } else {
        tickBusy = false;
      }
    })
    .catch(err => { tickBusy = false; console.error('[candle-spread] tick error:', err && err.message); });
}

// --- Real order poller ----------------------------------------------------
// Reconciles every live/test run's outstanding Schwab orders on a fixed interval: records real
// fills, and cancels test-mode orders (after TEST_CANCEL_MS) and stale working OPENs. Inert
// unless armed + prod + a run is actually sending real orders (dryRun 'test' | false). Costs
// nothing in dry-run (no liveOrders to poll).
// ── SUB-BAR RESTING-ORDER WORKER (LIVE ONLY) ─────────────────────────────────────────────────────────
// Both engines evaluated resting orders once per 5m CANDLE — workRestingCovers from processCandleClose,
// and the backtest once per bar. In a backtest that is all the data supports. Live it is a lie about how
// the day works: a cover whose mark dips through its target at 10:31 and recovers by 10:35 filled in
// reality and was never seen, and an open priced at a candle close was tested against the very snapshot
// that priced it, so it could only ever say yes.
//
// This pass re-reads the chain between candles and re-evaluates what is resting. It is the ONLY reason
// the open-resting and ladder logic can do anything: the answer now comes from a different observation
// than the one that set the price.
//
// WHAT IT DOES NOT DO. No signals, no opens, no covers placed, no reversals — those need the candle close
// and its analysis. This only asks "did anything already working become fillable, and if not, walk it."
//
// The ladder does NOT speed up as a result: cover-ladder.stepsEarned reads ELAPSED restingMs, so looking
// more often changes how soon a fill is NOTICED, not how fast the price chases. Live and backtest fill
// rates will legitimately differ because live samples the tape more finely — expected, not a divergence,
// and not something preflight can see (it compares fields, not sampling rates).
//
// The underlying is not refreshed here. The chain gives prices, not a spot, and the ladder's
// underlying-move term and the governor both tolerate the last candle's value; a 5m-old spot is a far
// smaller error than pretending a resting order cannot fill for five minutes.
const WORK_MS = Number(process.env.CANDLE_SPREAD_WORK_MS) || 30000;
let workTimer = null;
let workBusy = false;      // never overlap a pass with itself or with a candle tick
async function runRestingWork() {
  if (!started || workBusy || tickBusy) return;
  if (!(DEPS && DEPS.getOrFetchChainData)) return;
  // RTH only, and not on the boundary itself — the candle tick owns that moment.
  const { weekday, hour, minute } = etParts(new Date());
  if (!RTH_WEEKDAYS.has(weekday)) return;
  const t = hour * 60 + minute;
  if (t < FIRST_ACTION_MIN || t > LAST_ACTION_MIN) return;
  workBusy = true;
  try {
    const tradeDate = todayEST();
    // Which variants actually have something working? Cheap enough to check before any network call, and
    // on most passes the answer is none.
    const pending = [];
    for (const run of RUNS) {
      const cfg = { ...run, expiration: run.expiration || tradeDate };
      const record = store.initRun(cfg, tradeDate);
      const st = record.state || {};
      const hasOpen = !!st.pendingOpenId;
      const hasCover = (st.positions || []).some(p => p.filled !== false && !p.covered && p.pendingCover);
      const hasHedge = (st.positions || []).some(p => p.filled === false && p.pendingHedge);
      if (hasOpen || hasCover || hasHedge) pending.push({ run, cfg, record });
    }
    if (!pending.length) return;
    // ONE chain read for the whole pass. The 5s freshness window in getOrFetchChainData means every
    // variant after the first reuses it, so 80 variants cost one request rather than eighty.
    const first = pending[0].cfg;
    const chainData = await DEPS.getOrFetchChainData(first.priceSymbol || first.symbol, first.expiration);
    if (!chainData) return;
    const getLeg = trader.makeLegAccessor(chainData, first.expiration);
    for (const { run, cfg, record } of pending) {
      const st = record.state;
      const decisions = [];
      const deps = buildEngineDeps(run, { getLeg, nowMs: Date.now(), underlying: st.lastUnderlying });
      try {
        trader.resolvePendingOpen(st, cfg, deps, decisions);
        trader.resolvePendingHedges(st, cfg, deps, decisions);
        if (cfg.coverFillModel === 'resting') {
          // BOTH, and in this order, exactly as processCandleClose does it (trader.js). workRestingCovers
          // only WALKS the ladder; resolveRestingCovers is what tests whether the mark reached the target
          // and books the fill. Calling the first alone — which is what this did on 2026-09-15 — meant the
          // worker repriced 126 times and filled nothing, so every fill still waited for a candle close
          // and the whole reason for a sub-bar pass was missing.
          await trader.workRestingCovers(st, cfg, decisions, deps, st.lastUnderlying);
          trader.resolveRestingCovers(st, cfg, deps.getLeg, decisions, deps);
        }
      } catch (e) {
        console.error(`[candle-spread] resting work (${run.variant}):`, e && e.message);
        continue;
      }
      if (decisions.length) {
        store.appendEvent(record, { type: 'resting_work', at: new Date().toISOString(), decisions });
      }
    }
  } finally {
    workBusy = false;
  }
}

async function runOrderPoll() {
  if (!(LIVE_ARMED && DEPS && DEPS.isProd === true && DEPS.tradingClient && DEPS.accountHash)) return;
  const deps = { tradingClient: DEPS.tradingClient, accountHash: DEPS.accountHash };
  for (const run of RUNS) {
    if (!(run.dryRun === false || run.dryRun === 'test')) continue;
    const cfg = { ...run, expiration: run.expiration || todayEST() };
    const record = store.initRun(cfg, todayEST());
    const outstanding = (record.state.liveOrders || []).some(o => !om.isTerminal(o));
    if (!outstanding) continue;
    try {
      await om.reconcile(record, deps, { testCancelAfterMs: TEST_CANCEL_MS });
    } catch (e) {
      console.error(`[candle-spread] order poll error (${run.variant}):`, e && e.message);
    }
  }
}

// EOD (16:00): book each run's TERMINAL settlement P/L — the fair cross-variant metric,
// valuing every established position at the day's settle price (0DTE => intrinsic), so the
// joint variant's retained upside is actually counted. (The parked cheap-cover sweep < 5%
// width would slot in just before this.)
async function eodSettlement() {
  tickBusy = true;                 // settlement rewrites every record; the worker must stand clear
  try { return await eodSettlementInner(); } finally { tickBusy = false; }
}
async function eodSettlementInner() {
  const bySymbol = {};
  for (const run of RUNS) { (bySymbol[run.symbol] = bySymbol[run.symbol] || []).push(run); }
  for (const [symbol, runs] of Object.entries(bySymbol)) {
    // Settle price = the OFFICIAL index 4:00 CLOSE (the $NDX quote lastPrice) — the actual 0DTE settlement
    // value. NOT the last 5m/15m candle mark (~9 pts off) and NOT `closePrice` (Schwab's prior-day close).
    let settle = null, settleSource = null;
    try { settle = DEPS.getSettlementPrice ? await DEPS.getSettlementPrice(symbol) : null; if (settle != null) settleSource = 'index-close'; }
    catch (e) { console.error('[candle-spread] EOD settlement quote failed:', e && e.message); }
    if (settle == null) {   // fallback: newest 15m candle close
      try {
        const analysis = await DEPS.analyzeCandles(symbol, { timeframe: '15m' });
        const candles = analysis?.candleData?.['15m']?.candles || [];
        if (candles.length && candles[0].close != null) { settle = Number(candles[0].close); settleSource = '15m-candle-fallback'; }
      } catch (e) { console.error('[candle-spread] EOD candle fetch failed:', e && e.message); }
    }

    for (const run of runs) {
      const cfg = { ...run, expiration: run.expiration || todayEST() };
      const record = store.initRun(cfg, todayEST());
      let px = settle;
      if (px == null) {
        // Settle on the PRICING instrument (NDX underlying) — NOT candle.close (the NQ signal instrument,
        // ~54 pts off). Prefer the persisted last underlying, else the last candle_close's underlying.
        px = record.state && record.state.lastUnderlying != null ? Number(record.state.lastUnderlying) : null;
        if (px == null) { const lastCC = [...record.events].reverse().find(ev => ev.type === 'candle_close'); px = lastCC ? Number(lastCC.underlying != null ? lastCC.underlying : lastCC.candle.close) : null; }
      }
      if (px == null) { store.appendEvent(record, { type: 'eod_settlement', variant: run.variant, note: 'no settle price available' }); continue; }
      const term = trader.computeTerminalPnl(record.state, cfg, px, record.events);
      store.appendEvent(record, {
        type: 'eod_settlement', variant: run.variant, settle: px, settleSource: settleSource || 'run-underlying',
        terminalPnl: term.total, floorPnl: term.floor, positions: term.positions
      });
      // Concise, at-a-glance day summary (orders/time/strikes/price + real broker outcomes),
      // persisted as its own event AND printed to the log so the day is reviewable without
      // scrolling the full JSON. Built from the record, so it's identical in dry-run and live.
      try {
        const daySummary = summary.buildDaySummary(record);
        store.appendEvent(record, { type: 'eod_summary', variant: run.variant, summary: daySummary });
        console.log('\n' + summary.renderText(daySummary) + '\n');
      } catch (e) { console.error('[candle-spread] EOD summary failed:', e && e.message); }
    }
  }
}

function scheduleNext() {
  const delay = msToNextBoundary() + 5000; // fire 5s after the boundary
  schedTimer = setTimeout(() => {
    const now = new Date();
    // The boundary we just passed is ~now (minus the 5s). Classify by current ET minute.
    const kind = classifyBoundary(now);
    try {
      if (kind === 'eod') eodSettlement().catch(e => console.error('[candle-spread] EOD error:', e && e.message));
      else if (kind === 'first' || kind === 'action') attemptTick(kind, 12); // ~1 min of polling
    } catch (e) {
      console.error('[candle-spread] boundary error:', e && e.message);
    }
    scheduleNext();
  }, delay);
}

function start(deps) {
  if (started) return;
  if (process.env.CANDLE_SPREAD_DISABLED === 'true') {
    console.log('[candle-spread] disabled via CANDLE_SPREAD_DISABLED');
    return;
  }
  DEPS = deps;
  RUNS = buildRuns();
  // Every variant's capabilities must be forwarded to the engine. Checked HERE, before the scheduler can
  // place anything, because the failure this catches is invisible at runtime: an unforwarded flag makes the
  // feature a no-op that still reports success. Three shipped that way before this existed.
  assertDeps(RUNS);
  // REPAIR THE STORE BEFORE TRADING. A runaway loop once grew a single record to 32,411 positions (~62 MB),
  // and every read of the store then paid for it. The deploy hook cannot fix that: it runs as a user that
  // may create files in the 1777 store directory but cannot overwrite a record THIS PROCESS owns, which
  // is exactly how it failed EACCES on 2026-09-17. The app has the right identity by construction, so the
  // repair belongs here. Costs one stat per file when the store is healthy, which is the normal case.
  try {
    const { sweepStore } = require('./tools/prune-runaway-hedges');
    const r = sweepStore({ apply: true, log: (m) => console.log(`[candle-spread] ${m}`) });
    if (r.rewritten || r.reclaimed) {
      console.log(`[candle-spread] store repaired: ${r.rewritten} record(s) rewritten, `
        + `${Math.round((r.freed + r.reclaimed) / 1e5) / 10} MB reclaimed`);
    }
  } catch (e) {
    // Never block trading on housekeeping.
    console.error('[candle-spread] store sweep failed (continuing):', e && e.message);
  }
  started = true;
  scheduleNext();
  // Poll outstanding real orders on a fixed interval (real fill tracking + test/stale cancels).
  // Harmless when disarmed/dry-run: runOrderPoll early-returns and there are no liveOrders.
  orderPollTimer = setInterval(() => { runOrderPoll().catch(e => console.error('[candle-spread] poll:', e && e.message)); }, ORDER_POLL_MS);
  if (orderPollTimer.unref) orderPollTimer.unref();
  // Sub-bar pass over resting opens and covers. Inert outside RTH and on any pass with nothing working.
  workTimer = setInterval(() => { runRestingWork().catch(e => console.error('[candle-spread] resting work:', e && e.message)); }, WORK_MS);
  if (workTimer.unref) workTimer.unref();
  // Live-send status. Real orders require prod + CANDLE_SPREAD_LIVE=true + a run with
  // dryRun:false (real) or dryRun:'test' (unfillable paper send).
  const liveRuns = RUNS.filter(r => r.dryRun === false);
  const testRuns = RUNS.filter(r => r.dryRun === 'test');
  const liveState = !(deps && deps.isProd) ? 'DEV (never sends)'
    : !LIVE_ARMED ? 'DISARMED (CANDLE_SPREAD_LIVE not set — no real orders)'
    : liveRuns.length ? `*** LIVE-ARMED — real orders WILL be sent for: ${liveRuns.map(r => r.variant).join(',')} ***`
    : testRuns.length ? `ARMED, TEST-ONLY — unfillable paper orders for: ${testRuns.map(r => r.variant).join(',')}`
    : 'ARMED but all runs dryRun:true (no real orders)';
  console.log(`[candle-spread] started — ${RUNS.length} run(s) [${liveState}]:`,
    RUNS.map(r => `${r.symbol}/${r.variant}(${r.coverSelector})`).join(', '));
}

// --- read accessors for the API -------------------------------------------
// Runs, with every recorded variant name resolved onto the CURRENT canonical roster (see
// variant-alias.js). Pre-2026-09-03 runs used a different naming convention, so without this the
// comparison grid — which is keyed by canonical name — silently renders those days empty despite the data
// being right there. `variant` is therefore the name the UI should key off; `recordedVariant` is what the
// run actually called itself, and `aliasOf`/`aliasNote` are present ONLY on aliased entries so a caller
// can mark them as approximations rather than showing them as native runs.
function listRuns() {
  const roster = new Set(buildRuns().map(r => r.variant));
  const rows = store.listRunsSummary();
  // Resolve per (symbol, tradeDate) group — slot competition is only meaningful within one day.
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.symbol}|${r.tradeDate}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const winners = new Map();   // runId -> annotated
  for (const g of groups.values()) {
    for (const [, w] of alias.resolveSlots(g.map(r => ({ ...r, config: { variant: r.variant, spreadWidth: r.spreadWidth } })), roster)) {
      winners.set(w.runId, w);
    }
  }
  return rows.map(r => {
    const w = winners.get(r.runId);
    // Not a winner: either unmappable, or it lost its slot to a closer run. Either way it must NOT keep a
    // canonical-looking `variant`, or the UI would fetch it into a cell that belongs to something else.
    if (!w) return { ...r, recordedVariant: r.variant, canonical: false };
    return w.exact
      ? { ...r, recordedVariant: r.variant, canonical: true }
      : { ...r, variant: w.variant, recordedVariant: r.variant, canonical: true, aliasOf: w.aliasOf, aliasNote: w.aliasNote };
  });
}
// The CANONICAL variant roster the server is currently configured to trade — name, label, geometry, and
// which one (if any) is armed for the live pipe. The runs store keeps records for RETIRED variants too
// (e.g. the removed -10k twins), so any UI that lists strategies must filter against this rather than
// against whatever run files happen to exist, or it shows dead entries. Ordered by family then width then
// suffix so callers get version order for free.
function listVariants() {
  const rank = v => {
    const m = /^v(\d+)-(\d+)(?:-(.*))?$/.exec(v.variant) || [];
    const suffix = m[3] || '';
    const grp = suffix === '' ? 0 : suffix === 'unc' ? 1 : 2;
    return [Number(m[1] || 99), grp, Number(m[2] || 0), suffix];
  };
  return buildRuns()
    .map(v => ({
      variant: v.variant, label: v.variantLabel, spreadWidth: v.spreadWidth,
      dryRun: v.dryRun, live: v.dryRun === 'test' || v.dryRun === false,
      lossTarget: v.lossTarget != null ? v.lossTarget : null, lossMax: v.lossMax != null ? v.lossMax : null,
      // WHAT THIS VARIANT IS TESTING. The roster is the canonical answer to "which strategies have
      // give-up?" and until now it could not answer it — the compare page could show 80 rows of results
      // with no way to see which experiment produced them. Sent as raw facts, so a UI can label, colour
      // or sort them however it likes without the engine holding an opinion about presentation.
      minLock: v.continuousCoverMinLockFrac != null ? v.continuousCoverMinLockFrac : null,
      ladder: v.coverLadder === true,
      giveUp: v.coverGiveUp === true,
      fly: v.flyConvert === true,
    }))
    .sort((a, b) => { const x = rank(a), y = rank(b); for (let i = 0; i < x.length; i++) { if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1; } return 0; });
}
// date defaults to the EXPIRATION (0DTE: tradeDate == expiration), so `/runs/NDX/2026-08-18`
// with no ?date= resolves to that day's run instead of today. variant is optional.
function getRun(symbol, expiration, date, variant) {
  const tradeDate = date || expiration;
  const direct = store.readRun(store.makeRunId(symbol, expiration, tradeDate, variant));
  if (direct || !variant) return direct;
  // No native run under that name — the UI asked for a canonical variant on a day recorded under the old
  // convention. Re-resolve that day's files and hand back the nearest equivalent, ANNOTATED. The record is
  // returned as-recorded apart from the added alias fields: nothing about the run itself is rewritten, so
  // its config still says what it really traded.
  const roster = new Set(buildRuns().map(r => r.variant));
  const fam = /^(v\d+)/.exec(variant);
  if (!fam) return null;
  const prefix = `${symbol}_${expiration}_${tradeDate}_`;
  const cands = [];
  for (const runId of store.listRunFiles()) {
    // Cheap filename filter first — only same-day, same-family files can possibly alias to this slot,
    // which keeps this to a handful of reads instead of the whole store.
    if (!runId.startsWith(prefix)) continue;
    if (!runId.slice(prefix.length).startsWith(fam[1])) continue;
    const rec = store.readRun(runId);
    if (rec) cands.push({ runId, config: rec.config || {}, eventCount: (rec.events || []).length, rec });
  }
  const hit = alias.resolveSlots(cands, roster).get(variant);
  if (!hit || hit.exact) return null;   // exact would have been found by the direct read above
  return { ...hit.rec, aliasOf: hit.aliasOf, aliasNote: hit.aliasNote, requestedVariant: variant };
}

// Count today's decisions on a run record (for the status endpoint).
function tallyRun(rec) {
  const t = { opens: 0, covers: 0, coverFills: 0, cancels: 0 };
  for (const ev of (rec.events || [])) {
    if (ev.type !== 'candle_close') continue;
    for (const d of (ev.decisions || [])) {
      if (d.action === 'open') t.opens++;
      else if (d.action === 'cover' || d.action === 'cover-rest') t.covers++;
      else if (d.action === 'cover-fill') t.coverFills++;
      else if (d.action === 'cancel-open') t.cancels++;
    }
  }
  return t;
}

// BACKTEST BASELINE per variant (avg daily terminal P&L over the full history, generated offline by
// scripts/candle-spread/build-backtest-baselines.js with each variant's matching config). Loaded once;
// status diffs today's live terminal against it so we can see how real runs track the backtested edge.
let _baselines = null;
function backtestBaselines() {
  if (_baselines) return _baselines;
  try { _baselines = require('./backtest-baselines.json'); } catch (e) { _baselines = { variants: {} }; }
  return _baselines;
}

// Compact live status for the UI to poll — confirms mode/gates and what each strategy is doing today,
// so you can validate the server is behaving as expected (esp. the prod test-mode session).
function status() {
  const gates = {
    isProd: !!(DEPS && DEPS.isProd === true),
    liveArmed: LIVE_ARMED,                                   // CANDLE_SPREAD_LIVE === 'true'
    hasTradingClient: !!(DEPS && DEPS.tradingClient),
    hasAccountHash: !!(DEPS && DEPS.accountHash),
    // Which variant the env SELECTED, and whether that name actually exists — so a typo (which arms
    // nothing) is visible in /status instead of only in the startup log.
    armedSelection: ARMED_VARIANT,
    armedMode: ARMED_MODE === false ? 'live (real fillable orders)' : 'test (unfillable + auto-cancel)',
    armedSelectionValid: RUNS.some(r => r.variant === ARMED_VARIANT)
  };
  const liveV = RUNS.filter(r => r.dryRun === false).map(r => r.variant);
  const testV = RUNS.filter(r => r.dryRun === 'test').map(r => r.variant);
  const mode = !gates.isProd ? 'DEV (never sends)'
    : !gates.liveArmed ? 'DISARMED (CANDLE_SPREAD_LIVE not set)'
    : liveV.length ? `LIVE-ARMED (real orders: ${liveV.join(',')})`
    : testV.length ? `TEST-ARMED (unfillable orders: ${testV.join(',')})`
    : 'ARMED (all dry-run)';
  // TRADABILITY — surfaced at the top level because "the market is not open / not quoted" is the single
  // most important thing to see at a glance: it explains an empty session without the operator having to
  // guess whether the engine is broken, disarmed, or simply looking at a closed tape.
  // Setups are informational and evaluated asynchronously; status() is sync, so it reports whatever the
  // last refresh produced. Never blocks, never throws.
  const setupBlock = setupCache || { ok: null, reason: 'not evaluated yet', setups: [] };
  const t = LAST_TRADABILITY;
  const STALE_MS = 20 * 60 * 1000;   // older than a few marks = we are not currently ticking at all
  const tradability = t
    ? { ...t, stale: Date.now() - t.at > STALE_MS,
        blocked: t.ok === false,
        checkedAgo: Math.round((Date.now() - t.at) / 1000) }
    : { ok: null, blocked: false, reason: 'not-checked-yet', detail: 'no tick has run since startup', stale: true };
  const tradeDate = todayEST();
  const runs = RUNS.map(run => {
    const rec = store.readRun(store.makeRunId(run.symbol, run.expiration || tradeDate, tradeDate, run.variant));
    const st = rec && rec.state;
    const lo = (st && st.liveOrders) || [];
    const t = rec ? tallyRun(rec) : { opens: 0, covers: 0, coverFills: 0, cancels: 0 };
    // TERMINAL (mark-to-market) P&L: value EVERY position (covered + uncovered) at the current NDX
    // underlying — the true P&L (what the UI shows). realizedPnl below is only the covered tents' locked
    // FLOOR (always ~positive; ignores uncovered legs), kept as the conservative lower bound.
    let terminalPnl = null, pnlBasis = null;
    // ONCE THE DAY HAS SETTLED, THE SETTLEMENT IS THE ANSWER. Re-marking at `lastUnderlying` uses the last
    // 5m candle the engine acted on (15:55), not the official close — 31 points apart on 2026-09-08, and on
    // 0DTE that gap flips strikes between ITM and OTM. It reported v7-40 at +$2,374 on a day it lost
    // $7,920: not merely off, the wrong SIGN. The settlement event already carries the right figure.
    const settled = [...(rec ? rec.events || [] : [])].reverse()
      .find((e) => e.type === 'eod_settlement' && e.settle != null);
    if (settled && settled.terminalPnl != null) {
      terminalPnl = Math.round(settled.terminalPnl); pnlBasis = 'settled';
    } else if (st && st.lastUnderlying != null && st.positions && st.positions.length) {
      try { terminalPnl = Math.round(trader.computeTerminalPnl(st, rec.config, st.lastUnderlying, rec.events).total); pnlBasis = 'mark-to-market'; } catch (e) { /* leave null */ }
    }
    const base = backtestBaselines().variants[run.variant] || null;
    return {
      variant: run.variant, symbol: run.symbol, signalSymbol: run.signalSymbol || run.symbol,
      mode: run.dryRun === false ? 'live' : run.dryRun === 'test' ? 'test' : 'simulate',
      width: run.spreadWidth || 20, shift: run.spreadShift || 0,
      // WHICH ARM THIS VARIANT IS IN. The overlay tints cells by arm, and without these it could not tell
      // a 0.10 cell from a 0.20 one from a control — nothing else in this payload carries the covering
      // policy. Sent as the two FACTS rather than a computed label so the server never has to agree with
      // the client about what an "arm" is; the tint is presentation and lives where the presenting happens.
      minLock: run.continuousCoverMinLockFrac != null ? run.continuousCoverMinLockFrac : null,
      ladder: run.coverLadder === true,
      positions: st ? st.positions.length : 0,
      covered: st ? st.positions.filter(p => p.covered).length : 0,
      terminalPnl,                                    // settled terminal when the day is done, else mark-to-market
      pnlBasis,                                       // 'settled' | 'mark-to-market' — the UI should say which
      realizedPnl: st ? Math.round(st.realizedPnl) : 0,   // conservative FLOOR (covered tents only)
      // How today's live terminal compares to THIS variant's BACKTEST average daily terminal P&L.
      backtestAvg: base ? base.avgDaily : null,
      backtestDays: base ? base.days : null,
      vsBacktest: (base && terminalPnl != null) ? terminalPnl - base.avgDaily : null,
      // capital view (recap variants): net cash currently deployed + the day's peak (= funding needed).
      cashDeployed: st && st.cashDeployed != null ? Math.round(st.cashDeployed) : null,
      peakCash: st && st.peakCashDeployed != null ? Math.round(st.peakCashDeployed) : null,
      // read-only risk-harvest observer: when/how-often the book went lopsided + the latest real-chain hedge.
      harvest: st && st.harvestObs ? {
        lopsidedCount: st.harvestObs.count, firstLopsidedTime: st.harvestObs.firstLopsidedTime, worstReachableFloor: st.harvestObs.worstFloor,
        now: st.lastHarvestObs ? { lopsided: st.lastHarvestObs.lopsided, reachableFloor: st.lastHarvestObs.reachableFloor, hedge: st.lastHarvestObs.hedge || null } : null
      } : null,
      ...t,
      realOrders: {
        sent: lo.length,
        working: lo.filter(o => o.status === 'working').length,
        filled: lo.filter(o => o.status === 'filled').length,
        canceled: lo.filter(o => o.status === 'canceled').length,
        lastAt: lo.length ? lo[lo.length - 1].placedAtEST : null
      },
      lastCandle: st ? st.lastCandleTime : null,
      updatedAt: rec ? rec.updatedAt : null
    };
  });
  return {
    mode, gates, tradability, watchlist: WATCHLIST, setups: setupBlock,
    // Non-empty means a selector named something that never landed — those variants are running at their
    // DEFAULTS, not as test arms. Surfaced here so the UI badge and preflight can both fail on it.
    configProblems: CONFIG_PROBLEMS,
    armedVariants: { live: liveV, test: testV },
    testConfig: { unfillableFrac: TEST_FRAC, cancelAfterMs: TEST_CANCEL_MS, pollMs: ORDER_POLL_MS },
    tradeDate, started, msToNextTick: msToNextBoundary(), runs, serverTime: new Date().toISOString()
  };
}

module.exports = {
  start,
  listRuns,
  getRun,
  status,
  buildRuns,
  VARIANTS,
  listVariants,
  // exported for tests
  classifyBoundary,
  msToNextBoundary,
  pickJustClosed,
  DEFAULT_RUNS
};
