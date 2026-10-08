/**
 * Candle-spread runtime: run config, the aligned scheduler, live data glue, the
 * (dry-run) order placer, and read accessors for the API. Kept separate from the
 * paper-sim position-manager. Dependencies (candle analysis, chain fetch, trading
 * client, account hash) are injected via start() to avoid circular requires.
 */
const store = require('./store');
const trader = require('./trader');
const TS = require('./trend-state');
const om = require('./order-manager');
const BR = require('./book-reconcile');   // does the strategy's book match the orders that really filled?
const SC = require('./strategy-control');   // which variants trade, in what mode, right now (S3-backed)
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

// ── PLACEMENT G (2026-10-05) — the user's own strike rule, on every ADAPTIVE variant (the -unc twins
// included; the fixed-geometry -cATM controls are left alone). "I generally only pay 4.8-5.3 for 10W
// spreads and try to get the deepest ITM strikes keeping within those price limits", stepping one strike
// out of the money when even short-at-the-money is too dear, then walking the price up a little to fill.
//   band [minDebitFrac, capFrac] x W, maxOtmStrikes 1, walk up to openWalkCapFrac x W.
// Measured (sweep-loss-cap --placementModes, realistic fills, 765 days, 30 adaptive governed variants):
// G 36,343/day vs the 0.60 deepest-ITM rule 35,339; 20W +3%, 40W +13%; v7-10 1,113 vs 1,151 with the
// worst day back inside the cap (-1,455 vs -1,624) and opens ~\$0.40 cheaper. Real-chain check: sATM 10W
// mids are ~\$5.40 (bull call) / ~\$4.95 (bear put), so the band is where the strategy actually trades.
const PLACEMENT_G = {
  10: { minDebitFrac: 0.48, capFrac: 0.53, openWalkCapFrac: 0.55 },     // $4.80-5.30, walk to $5.50
  20: { minDebitFrac: 0.475, capFrac: 0.55, openWalkCapFrac: 0.575 },   // $9.50-11.00, walk to $11.50
  40: { minDebitFrac: 0.475, capFrac: 0.575, openWalkCapFrac: 0.60 },   // $19-23, walk to $24
};
function applyPlacementG(v) {
  if (!v.adaptiveGeo) return;
  const g = PLACEMENT_G[v.spreadWidth];
  if (!g) return;
  Object.assign(v, g, { maxOtmStrikes: 1 });
}

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

// COVER GIVE-UP — FLEET DEFAULT since 2026-10-04 (user), v7-10 included. Was an A/B on 5 variants. The
// full-roster re-sweep (scripts/candle-spread/sweep-giveup.js, 765 days, current engine) found ON(10 pts, 5%)
// best by total on 62 of 80 variants: capped aggregate +18%, mean max drawdown -$29.3k -> -$25.4k, cover
// fill +6 pts, worst days unchanged; v7-10 ret/DD 526 -> 979. Enabled only after the replace-result fix
// (daf2194) — before it, a give-up whose replace failed was never re-sent.
// CANDLE_SPREAD_GIVEUP overrides: unset or "all" = every variant; "none" = no variant; else a list.
const GIVEUP_ENV = process.env.CANDLE_SPREAD_GIVEUP != null ? process.env.CANDLE_SPREAD_GIVEUP.trim() : 'all';
const GIVEUP_ALL = /^all$/i.test(GIVEUP_ENV);
const GIVEUP_LIVE = new Set(GIVEUP_ALL || /^none$/i.test(GIVEUP_ENV) ? []
  : GIVEUP_ENV.split(',').map(s => s.trim()).filter(Boolean));
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
// ── THE FLOOR UNDER EVERY LOSS CAP: 1.5 x ONE POSITION'S WIDTH ──────────────────────────────────────
//
// lossMax bounds RC.bookFloor — the day's worst case across all strikes. A cap BELOW what a single position
// can lose is therefore incoherent: the governor must block almost any open that could go the full width, so
// the variant stops trading rather than manages risk.
//
// v7-40 ran at $3,000 against a $4,000 max loss on a 40-wide. Measured on 2026-09-29: **5.13 governor blocks
// per open** (41 blocks, 8 opens all day) — the worst cell in the family x width grid by a factor of three.
// The sweep agrees it was a mistake: at $8,000 v7-40 returns $2.60M with ret/DD 50.8, at $3,000 it returns
// $1.18M with ret/DD 48.4. Worse on BOTH axes, $1.42M forgone.
//
// It was adopted honestly — the comment at the TUNED_CAPS assignment says "ret/DD 41 -> 59" — but from the
// sweep run whose control arm had degenerated into a copy of the treatment (b50e432), so 29 of 50 variants
// were never tested against anything looser than their own cap. A tuning pass can be wrong; this floor is
// the guard that keeps a wrong one from being incoherent.
//
// 1.5x, not 1.0x: at exactly one width the governor still blocks any SECOND position that could run to full
// width, which is nearly as sterile. 1.5x leaves room to hold one position through a full loss and still
// open. Fine-tune ABOVE this; never below.
//
// `-unc` variants are unaffected by construction — they carry lossMax null, meaning no governor at all, and
// null is not "a small cap".
const LOSS_MAX_FLOOR_X_WIDTH = 1.5;
function lossMaxFloorFor(spreadWidth) {
  return Math.round(LOSS_MAX_FLOOR_X_WIDTH * spreadWidth * 100);
}

// ── AND A CEILING: $7,500, AT EVERY WIDTH ───────────────────────────────────────────────────────────
//
// lossMax is what a single day is permitted to lose. The user's stated tolerance is roughly $5-10k per day,
// so a $9,000 cap sits at the top of that band and a $7,500 one sits inside it. That is the reason for this
// number — a risk budget, not a backtest result — which is why it is flat across widths rather than scaled:
// the account does not care how wide the spread was.
//
// IT IS NOT FREE, AND IT IS NOT MEANT TO BE. Six W=40 variants come down (9000/8500/8000 -> 7500), and against
// the sweep the trade splits:
//   v6-40      $9,000 -> ~7,500   total -$370k BUT ret/DD 36.6 -> 39.5 and maxDD -$69.3k -> -$58.0k
//   v6-40-cATM $9,000 -> ~7,500   total -$340k BUT ret/DD 27.5 -> 31.1 and maxDD -$76.2k -> -$59.7k
//   v5-40      $9,000 -> ~7,500   total -$250k, ret/DD 52.6 -> ~49      (costs on both)
//   v3-40      $9,000 -> ~7,500   total -$130k, ret/DD 49.6 -> 41.6     (costs on both)
//   v4-40-cATM $9,000 -> ~7,500   total -$100k, ret/DD 14 -> ~12.5      (costs on both)
//   v1-40-cATM $8,000 -> ~7,500   total  -$65k, ret/DD 50.8 -> ~45      (costs on both)
// So it buys a materially smaller worst day on the two largest earners and pays total return on four. That is
// the trade the capital-building phase is supposed to make: risk reduction outranks total P&L while the
// account is small. See feedback_success_metric_varies_by_feature.
//
// `-unc` arms are untouched — lossMax null means no governor, and a ceiling cannot bound something unbounded.
const LOSS_MAX_CEILING = 7500;

// The two bounds must not cross. They cannot at W=10/20/40 (floor tops out at 6000), but a wider spread would
// make the floor exceed the ceiling and there is no sensible silent answer to that — coherence and the risk
// budget would be in direct conflict, which is a decision, not a clamp.
function assertBoundsCoherent(spreadWidth) {
  const floor = lossMaxFloorFor(spreadWidth);
  if (floor > LOSS_MAX_CEILING) {
    throw new Error(`candle-spread: a ${spreadWidth}-wide needs a lossMax floor of ${floor} `
      + `(${LOSS_MAX_FLOOR_X_WIDTH}x one position) which EXCEEDS the ${LOSS_MAX_CEILING} ceiling. `
      + 'A cap cannot be both coherent and inside the risk budget at this width — raise the ceiling '
      + 'deliberately or do not trade this width.');
  }
  return floor;
}

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
// SUPERSEDED 2026-10-04 by the width rule (minLockByWidth, below); kept for the record of why it existed.
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
// ── WIDTH RULE (user, 2026-10-04) — replaces the checkerboard below as the fleet level ───────────────
// The checkerboard split 0.10/0.20 across (family, width) so live could decide the level. The full-roster
// re-sweep on the current engine (scripts/candle-spread/sweep-minlock.js, 765 days) decided it, and by
// WIDTH, not family: capped 10-wides win on risk-adjusted terms at 0.10 (ret/DD v7-10 526 vs 336, v5-10 361
// vs 228, v8-10 300 vs 186, v4-10 239 vs 160), while 20/40-wides earn ~8-10% more at 0.20 with ret/DD
// usually better too (v1-40 36 -> 68, v2-40 35 -> 67). 0.15 was rarely best. One rule for every family also
// removes the confound the user hit: families are now directly comparable at the same width.
const minLockByWidth = (w) => (w <= 10 ? 0.10 : 0.20);
const MINLOCK_FLEET = (() => {
  const m = new Map();
  for (const f of MINLOCK_FAMS) for (const w of MINLOCK_WIDTHS) m.set(`${f}-${w}`, minLockByWidth(w));
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
  v.coverLadder = true; v.ladderLossCapFrac = 0;
  // ONE PACE FOR EVERY WIDTH, OPENS AND COVERS ALIKE (user, 2026-10-02). Was $0.25 / 300s on 10- and
  // 20-wide and $0.10 / 300s on 40-wide, with a step also earned every 5 NDX points: "NDX can move 20pts
  // within 5 min pretty regularly so to give up .25 on normal fluctuation seems aggressive." Now a $0.05
  // step every 120s OR every 10 NDX points since placement, whichever is further along — $0.125 per five
  // minutes on every width, and a tenth as sensitive to movement. The open ladder reads the same three
  // fields (openLadderStepDollars falls back to ladderStepDollars), so the rule is shared by construction.
  v.ladderStepSeconds = 120;
  v.ladderStepPoints = 10;
  v.ladderStepDollars = 0.05;
}
// `capPreset:false` for the `-unc` twins ONLY. An uncapped twin exists to show the model with the
// governor removed; putting a cap back on it would not be "the same experiment on another variant", it
// would delete the variant's reason to exist. Naming a `-unc` variant in CANDLE_SPREAD_CAPPRES is
// therefore refused OUT LOUD by validateSelectors rather than quietly ignored.
// ── MEASURED PER-VARIANT LOSS CAPS (2026-09-23) ─────────────────────────────────────────────────────
// The generic cap was maxCapFor(w) = max(2*w*100, LOSS_TARGET + w*100) — $6k/$7k/$9k at W=10/20/40 — a
// number derived from the width and nothing else. These are measured: 402 (variant, cap) runs over 765
// days, in docs/RISK-CAP-SHEET.md with the raw CSVs in docs/risk-cap-sweep/.
//
// SELECTION (user's rule): the LOWEST cap that holds its bound over all 765 days and does not degrade
// ret/DD, PLUS $500 of headroom — "i certainly dont want to lose out on a potential trade and have the
// governor block something just to save $500 risk" — EXCEPT where the curve is sharp enough that the
// headroom costs more than 10% of ret/DD, where it sits on the optimum instead. Taken on 22, skipped on
// 16. On several the +$500 measured BETTER than the base (v8-20 -21%, v9-20 -17%): blocking is convex,
// so the opens it recovers more than pay for the looser bound.
//
// WHY THESE ARE WORTH TRUSTING: 394 of the 402 measured caps HOLD EXACTLY — worst realized never exceeds
// the cap. That is what makes them additive across variants, which is the whole point (user: "if i know
// what our strategies can hold honest limits to that will give me the confidence to decide to run one,
// two, or any number in parallel and decide which ones i'm willing to run together"). A subset's worst
// case is the SUM of its caps. The 8 that fail all sit at the tightest rung and miss by $41-$396, about
// one spread: the governor gates OPENS on the projected floor, so once a position exists its own loss can
// carry past the cap when the cheapest openable spread already costs more than the headroom left. None of
// those 8 values is used here — notably v6-20 stays at $2,000 because $2,500 realized -$2,541.
//
// Sum of stated caps across the fleet: $298,000 -> $194,000. Eight variants are absent deliberately —
// nothing tighter held without degrading them (v0-20, v1-20, v3-40, v6-40, v4-40-cATM, v7-20-cATM,
// v8-20-cATM, v9-20-cATM), so they keep the generic cap.
//
// W=40 CAVEAT, recorded so it is not re-learned: fleet ret/DD is FLAT across the entire W=40 range, so
// tightening there shrinks P&L and drawdown proportionally — it buys a smaller worst DAY and nothing
// risk-adjusted. Every W=40 arm still draws $20k-$90k at every rung. The day is bounded; the month is
// not. Narrowing the spread is the lever at that width, not the cap.
// CAPITAL TRIGGER, as a factor of width x 100. Env-overridable so it can be dialled or switched off
// without a deploy; 0 disables it and restores openAlternateEvery + creditCoverFrac exactly.
const CREDIT_TRIGGER_XW = process.env.CANDLE_SPREAD_CREDIT_TRIGGER_XW != null
  ? Number(process.env.CANDLE_SPREAD_CREDIT_TRIGGER_XW) : 0.25;

const TUNED_CAPS = new Map([
  // RAISED 2026-09-27 after the loss-cap sweep was re-run with a REAL control arm (see b50e432: the old
  // control had degenerated into a copy of the treatment, so 29 of 50 variants had never been tested
  // against anything looser than their own cap). These three are the cases where the tighter cap loses on
  // BOTH axes — it costs P&L without buying risk-adjusted return, which is not the trade these caps were
  // adopted to make. Everything else stayed put: for 33 variants looser earns more but costs more per
  // unit of drawdown, and for 4 the tighter cap is outright better.
  //   v6-20  $2,000 -> $4,500   at 7,000: $2.83M vs $1.49M and ret/DD 111.4 vs 95.6. 4,500 is the PEAK
  //                             (ret/DD 140.7 at $2.46M), better risk-adjusted than either end.
  //   v5-40  $7,000 -> $9,000   +$296k and ret/DD 52.6 vs 47.5, for $1.3k more drawdown.
  //   v3-10  $1,000 -> $2,000   +$149k and ret/DD 270 vs 230, drawdown unchanged at -$3.4k.
  ['v6-20', 4500],
  ['v3-10', 2000],
  // RAISED 2026-09-30 by the FULL sweep re-read. v7-40 (see the floor rule) proved the 09-27 pass had a gap,
  // so every capped variant was re-tested against the both-axes-dominated criterion: only 7 of 50 failed it.
  // Two of those want rungs BELOW the new 1.5x floor (v8-40-cATM $5,500, v8-20 $2,500) and are deliberately
  // overridden by it — coherence beats a measured preference. v7-40 wants $8,000 and is held at the floor by
  // the user's decision. These four are the remainder, all landing inside [floor, 7500]:
  //   v0-20-cATM  $4,000 -> $7,000   $1,266k vs $1,180k AND ret/DD 87.3 vs 86.7 — better on both.
  //   v6-20-cATM  $6,500 -> $7,000   $2,031k vs $1,971k AND ret/DD 65.6 vs 62.3.
  //   v5-40-cATM  $7,000 -> $7,500   wants $8,000 ($2,094k / 42.4 vs $1,947k / 40.6); the ceiling holds it here.
  //   v2-40-cATM  $6,000 -> $7,500   wants $8,000 ($1,389k / 38.5 vs $1,361k / 36.5); same.
  // NOTE all four are -cATM, which is not a coincidence: the ATM-centered spreads consistently want LOOSER
  // caps than their short-ATM twins, because a centered spread starts nearer mid-width so a tight cap blocks
  // more of the trades it needs. That is a measured property, not a tuning artefact — and it is also why the
  // cATM/sATM cap skew is worth a policy decision rather than a per-variant one.
  // TUNED 2026-09-27 — these four had never been measured at all: their caps were still exactly the
  // width-generic default ($7,000 at W=20, $9,000 at W=40), which is why they sat furthest from their
  // risk-adjusted optimum. Same objective as the rest of TUNED_CAPS — the LOWEST cap that does not
  // meaningfully cost total P&L — plus the user's $500 of headroom.
  //   v0-20       $7,000 -> $4,500   $4,000 DOMINATES $7,000 on every axis: 100% of best total (vs 98.9%),
  //                                  ret/DD 117.2 vs 115.2, maxDD -$12,712 vs -$12,795. Strictly better.
  //   v7-20-cATM  $7,000 -> $6,500   $6,000 keeps 97.1% of total and cuts maxDD $51,366 <- $55,396.
  //   v9-20-cATM  $7,000 -> $6,500   same curve as its v7 twin to within a rounding error.
  //   v6-40       $9,000 -> $8,500   $8,000 keeps 90.1% and improves ret/DD 36.6 -> 39.5 while cutting
  //                                  maxDD by $11,317; $8,500 splits that, and matches v6-40-cATM.
  // NOT moved to their ret/DD peaks: for these the peak costs 25-55% of total P&L, which is the trade
  // this fleet already declined. See the log entry for why ret/DD-optimal and cap-minimal disagree.
  ['v0-20', 4500],
  ['v7-20-cATM', 6500],
  ['v9-20-cATM', 6500],
  ['v6-40', 8500],
  // LOWERED 2026-09-27 — the two places where tightening was nearly free on total and bought real
  // risk-adjusted return:
  //   v0-10  $3,000 -> $1,500   costs $30,068 (3.1% of total) for ret/DD 306.8 -> 379.9, maxDD -$2,473.
  //   v8-40  $6,000 -> $4,000   costs  $3,601 (0.9%)          for ret/DD  10.1 ->  11.0, maxDD -$35,238.
  // W=10
  ['v5-10', 2000],
  // RAISED 2026-10-06 $1,500 -> $1,750 (user OK): floor raise spends cap room and blocked 35% more opens.
  // 765-day sweep, floor raise 3:1 + honest fills: $1,750 = +$82/day (+5%), maxDD30 -4,644 -> -4,188 (the
  // best of 1,500-3,000), worst day -1,490 -> -1,745. $2,000 earned no more and maxDD -5,113.
  ['v7-10', 2000],
  // ALL 10-WIDES AT $2,000 (user, 2026-10-07): one cap for the whole width so a strategy's result is not
  // skewed by how often ITS cap binds — the families are compared on their signals, not on cap tuning.
  // Moved: v0/v5/v8-10 1,500 -> 2,000, v7-10 1,750 -> 2,000 (real money), v2/v9-10 2,500 -> 2,000.
  // v7-10 at 2,000 was measured 2026-10-07 (floor raise 3:1, honest fills): avg 1,702/day vs 1,712 at
  // 1,750, maxDD30 -5,113 vs -4,188, worst day -1,985 vs -1,745.
  ['v8-10', 2000],
  ['v1-10', 2000],
  ['v4-10', 2000],
  ['v6-10', 2000],
  ['v2-10', 2000],
  ['v9-10', 2000],
  ['v0-10', 2000],
  // W=20
  ['v3-20', 2500],
  ['v8-20', 2500],
  ['v3-20-cATM', 3500],
  ['v0-20-cATM', 7000],
  ['v5-20', 4000],
  // NORMALISED 2026-09-30 to match its own -cATM twin. v1-20 was never tuned — it sat on the width-generic
  // $7,000 — and its ret/DD curve is FLAT: 90.2 at $3,000, 89.5 at $4,000, 89.8 at $6,000, 91.1 at $7,000,
  // with total between $1,301k and $1,394k. There is no information in that curve, so $7,000 was arbitrary
  // rather than measured, and it produced the fleet's second-largest sATM/cATM skew (7000 vs 4500, ratio 0.64)
  // for no reason anyone could point at. $4,500 costs ~$18k of total (1.3%) and buys a $2,500 smaller worst
  // day plus a cap that matches its twin.
  //
  // The OTHER large skew, v8-20 at 2.33x, is deliberately left alone: those two curves genuinely disagree
  // (v8-20 ret/DD peaks 101.6 at $2,500 and decays to 52.3 at $7,000; v8-20-cATM runs the other way, 17.4 at
  // $3,000 rising to 30.8 at $7,000). Forcing a match there would cost real money to satisfy a symmetry the
  // measurement does not support. Same for v6-20 vs v6-20-cATM.
  ['v1-20', 4500],
  ['v1-20-cATM', 4500],
  ['v2-20', 4500],
  ['v2-20-cATM', 4500],
  ['v4-20', 4500],
  ['v4-20-cATM', 4500],
  ['v5-20-cATM', 4500],
  ['v9-20', 4500],
  ['v6-20-cATM', 7000],
  ['v7-20', 6500],
  // W=40
  ['v7-40', 3000],
  ['v0-40', 5000],
  ['v2-40', 5500],
  ['v8-40-cATM', 5500],
  ['v1-40', 6000],
  ['v2-40-cATM', 7500],
  ['v8-40', 4000],
  ['v4-40', 7000],
  ['v5-40', 9000],
  ['v5-40-cATM', 7500],
  ['v7-40-cATM', 7000],
  ['v0-40-cATM', 7500],
  ['v3-40-cATM', 7500],
  ['v9-40', 7500],
  ['v9-40-cATM', 7500],
  ['v1-40-cATM', 8000],
  ['v6-40-cATM', 8500],]);

// SIMULATED-FILL REALISM (2026-10-05), every variant. Inert under the broker (v7-10's fills are Schwab's);
// on the mark path: an open cannot fill on the look that placed it, and a cover needs the market 1 tick
// THROUGH its price, not just touching it. Measured that morning: 66% of simulated opens booked on the
// placing look and 64% of covers at 0-1 tick, while v7-10's real orders at the same prices did not all fill.
// Overridable per run (set the field before applyExperiments, or CANDLE_SPREAD_SIM_FILL=legacy for both).
const SIM_FILL_LEGACY = String(process.env.CANDLE_SPREAD_SIM_FILL || '').toLowerCase() === 'legacy';
// RE-STRIKE TIMEOUT (2026-10-05), every variant: an open that has walked to its cap and still not filled for
// 10 minutes is cancelled so the next bar can re-place it at current strikes and prices. Swept 0/5/10/15/30
// on the G roster (realistic fills, 765 days): fleet +1.2% at 10 min with drawdown and losing days
// unchanged; v7-10 1,113 -> 1,190. 10 over 5: two bars at the cap, and real opens have taken 15+ min to fill.
const OPEN_RESTRIKE_MIN = 10;
function applyRestrike(v) { if (v.openRestrikeMin == null) v.openRestrikeMin = OPEN_RESTRIKE_MIN; }

// FLOOR RAISE (2026-10-06) — the user's standing policy, live: always buy the best near-money floor lift per
// dollar at 2:1 or better, never pushing a locked profit below zero (floor-raise.js, shared with the
// backtest). 765-day sweep at 2:1: locked-profit days 33.7% -> 37.2% fleet-wide, closing floor +\$286, peak
// not given up. Rollout is env-controlled so it can be widened WITHOUT a deploy:
//   CANDLE_SPREAD_FLOOR_RAISE = 'all' (default) — every variant, the armed real-money one included
//                             = 'sim'           — every variant EXCEPT the armed one
//                             = 'off'           — none
// Default 'all' (user, 2026-10-06): every strategy, the armed real-money one included.
const FLOOR_RAISE_MODE = String(process.env.CANDLE_SPREAD_FLOOR_RAISE || 'all').toLowerCase();
function applyFloorRaise(v) {
  if (FLOOR_RAISE_MODE === 'off' || v.floorRaise != null) return;
  if (FLOOR_RAISE_MODE !== 'all' && v.variant === ARMED_VARIANT) return;
  v.floorRaise = true;
  // 3:1 (user, 2026-10-06): under honest fills (at-limit, resting raises) 3:1 beat 2:1 on every floor metric
  // and on P&L at every width — fleet locked days 34.6 -> 35.6%, avg/day 79.0k -> 84.5k, maxDD -35.1k -> -33.5k.
  v.floorRaiseMinRatio = 3;
  // SPREADS FIRST (objective B) on EVERY variant — the user's choice 2026-10-06: offset spreads fix a valley
  // and lift the tail beyond it; when none qualifies, any structure (flies included) may still raise the
  // book's lowest point. 765-day sweep at 2:1: fleet locked-profit days 33.7% -> 38.0%, closing floor
  // -1,293 -> -932 (best of all arms); best on 20W/40W. On 10W the lowest-point rule locked more days
  // (v7-10 55.4% vs 47.9% under B) — measured and recorded; the user chose B for all strategies.
  v.floorRaiseObjective = 'spreadFirst';
}
function applySimFillRealism(v) {
  if (SIM_FILL_LEGACY) return;
  if (v.simOpenFillMinLooks == null) v.simOpenFillMinLooks = 2;
  if (v.coverFillThroughTicks == null) v.coverFillThroughTicks = 1;
  // Simulated fills (opens, covers, hedges) book AT their limit, never better (2026-10-06: simulated covers
  // +$765 vs live +$7 on the same 8 v7-10 positions, almost all of it booked price improvement).
  if (v.simFillAtLimit == null) v.simFillAtLimit = true;
}

function applyExperiments(v, { capPreset = true } = {}) {
  applySimFillRealism(v);
  applyPlacementG(v);
  applyRestrike(v);
  applyFloorRaise(v);
  // FLEET DEFAULT first — ladder + the cell's minLock level, unless this is a control cell.
  const cell = cellOf(v.variant);
  // minLock follows the width rule on EVERY cell, controls included, so the no-ladder control cells differ
  // from the fleet in the ladder alone.
  if (MINLOCK_FLEET.has(cell)) v.continuousCoverMinLockFrac = MINLOCK_FLEET.get(cell);
  if (!MINLOCK_CONTROL_CELLS.has(cell) && MINLOCK_FLEET.has(cell)) applyLadderCfg(v);
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
  // CAPITAL TRIGGER — dollars, scaled by width so one setting means the same thing at W=10/20/40 (the
  // reasoning that made ladder stepDollars beat a fixed step count). Measured 12 variants x 400 days:
  // peak capital $3,930 -> $1,631 (-58%) with P&L identical to the dollar and FEWER credit orders than
  // today (51% vs 79%). Wins on all 12 individually. Set to 0/null to fall back to the old hand-set rules.
  if (CREDIT_TRIGGER_XW > 0) v.creditCapitalTrigger = Math.round(CREDIT_TRIGGER_XW * v.spreadWidth * 100);
  // MEASURED CAP LAST, so it wins over both the width-derived generic and the CAPPRES preset — it is the
  // only one of the three backed by a 765-day measurement of this exact variant. It moves v7-10 off the
  // preset's $1,000 to its measured peak $1,500 (+19% P&L, ret/DD 809 -> 850).
  //
  // THE v7-40 CLAIM HERE WAS WRONG AND IS LEFT ON THE RECORD DELIBERATELY. It read: "and v7-40 from $4,000
  // DOWN to $3,000, which is both tighter and better (ret/DD 41 -> 59)". The re-run sweep — the one with a
  // real control arm (b50e432) — says $3,000 gives ret/DD 48.4 against 40.3 at $4,000 and **50.8 at $8,000**,
  // where the total is $2.60M rather than $1.18M. Worse on both axes. The 41 -> 59 figures came from the
  // broken-control run. The floor below now makes this class of error impossible to ship, but the cap itself
  // is still looser-than-floor by measurement and wants a separate decision.
  const tuned = capPreset ? TUNED_CAPS.get(v.variant) : null;
  if (tuned != null) {
    v.lossMax = tuned;
    v.lossTarget = Math.round(0.7 * tuned);
  }
  // THE FLOOR, LAST AND UNCONDITIONAL. After the width-generic default, the CAPPRES preset and the measured
  // TUNED_CAPS — whichever set the value, it cannot end up below one-and-a-half positions' width. Outside the
  // `capPreset` branch on purpose: the builder that passes capPreset:false still needs the floor.
  if (v.lossMax != null && v.spreadWidth) {
    const floor = assertBoundsCoherent(v.spreadWidth);
    // CEILING FIRST, so a value above it is reported as capped rather than as floored, and so the floor has
    // the last word if the two ever meet (they cannot today — assertBoundsCoherent refuses that case).
    if (v.lossMax > LOSS_MAX_CEILING) {
      console.warn(`[candle-spread] ${v.variant}: lossMax ${v.lossMax} is above the ${LOSS_MAX_CEILING} `
        + `ceiling — lowering it. A single day may not be allowed to lose more than the risk budget.`);
      v.lossMax = LOSS_MAX_CEILING;
      v.lossTarget = Math.round(0.7 * LOSS_MAX_CEILING);
      v.lossMaxCapped = true;
    }
    if (v.lossMax < floor) {
      console.warn(`[candle-spread] ${v.variant}: lossMax ${v.lossMax} is below the floor for a `
        + `${v.spreadWidth}-wide (${floor} = ${LOSS_MAX_FLOOR_X_WIDTH}x one position) — raising it. `
        + 'A cap under one position\'s width makes the governor block nearly every open.');
      v.lossMax = floor;
      v.lossTarget = Math.round(0.7 * floor);
      v.lossMaxFloored = true;        // visible on the record, so a floored cap is never mistaken for a tuned one
    }
  }
  if (LADDER_LIVE.has(v.variant)) applyLadderCfg(v);
  // giveUpMaxLoss is the whole ball game: at 10 points a 5% cap is a clear win, 15% is mixed and 30% is a
  // rout (-$1.5M to -$2.0M across the four tested). Force the exit, but CHEAPLY — 5% of width is $1.00 on
  // a $20 spread, enough to cross the spread and not enough to chase.
  if (GIVEUP_ALL || GIVEUP_LIVE.has(v.variant)) {
    // ALLOWANCE BY WIDTH (2026-10-06, the user: wider spreads have a wider profitable range, so a little more
    // can be paid to close a losing one). Swept 5/7.5/10/15/20% on the G roster with realistic fills, scored
    // on positions closed / left open / opens freed: 10W best at 5% (more costs locked days and P&L), 20W at
    // 7.5% (fewer left open, 13% fewer blocked opens, P&L flat), 40W at 10% (P&L +6%, 11% fewer blocked).
    // 15-20% hurt every width. TRIGGER stays 10 points through the short strike: re-swept against candle-
    // break and signal-reversal triggers the same day and it led on locked days and on 10W.
    v.coverGiveUp = true; v.giveUpPoints = 10;
    v.giveUpMaxLoss = v.spreadWidth >= 40 ? 0.10 : v.spreadWidth >= 20 ? 0.075 : 0.05;
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
  // A WINDOW, NOT ONE MINUTE. This fired settlement only when the wall clock read EXACTLY 16:00, and the
  // scheduler classifies at the moment the timer actually fires — so a timer that ran a minute late, or a
  // boundary the event loop was too busy to service, skipped the day's settlement entirely and left no
  // trace anywhere. 2026-09-24 and 09-25 both ended with 77 candles and no eod_settlement while the
  // process ran continuously, the disk was fine, and every per-variant computation was provably sound.
  //
  // Every boundary from 16:00 to 16:30 now attempts it. Settlement is IDEMPOTENT (a run already carrying
  // an eod_settlement is skipped), so the extra attempts cost one cheap scan and the first one that gets
  // through wins. A single missed timer can no longer cost a day's headline number.
  if (t >= EOD_MIN && t <= EOD_MIN + 30) return 'eod';
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

// ── WHO DECIDES A FILL ──────────────────────────────────────────────────────────────────────────────
// 'mark'   — the engine's own read of the chain (markFill). Correct with no broker, and the only honest
//            answer for the 79 simulated variants. Today's behaviour, everywhere.
// 'broker' — the broker's reported fill, consumed from the order row by trader.applyBrokerFills.
//
// DERIVED, NOT CONFIGURED. A run whose orders can really fill is a run whose fills belong to the broker;
// there is no version of that where our own mark is the authority.
//
// This was briefly two independent env vars (CANDLE_SPREAD_ARMED_MODE=live plus
// CANDLE_SPREAD_FILL_SOURCE=broker) so the new path could ship inert. That was a mistake: the combination
// it left reachable — real fillable orders at the broker, book decided by our marks — IS the 2026-09-25
// failure exactly (16 opens and 13 covers believed, 0 of 33 filled, 29 of 29 positions phantom). Arming
// live and forgetting the second var would have reproduced it with real money. A flag whose wrong setting
// recreates the bug it was written to fix is not a safety feature.
//
// There is deliberately NO override in the other direction either. If the broker loop misbehaves, the
// correct response is to DISARM (CANDLE_SPREAD_ARMED_MODE back to test), which fails safe and is already
// one variable. "Keep sending real orders but book them off our marks" is not a fallback, it is the defect.
//
// The gate is that orders genuinely REACH a broker — isProd, LIVE_ARMED, a client and an account hash.
// Without those nothing is ever sent, so no order could ever report filled, and a derived 'broker' would
// leave the engine holding nothing at all (which is what a local dev run of the armed variant would do).
//
// A 'test'-mode run stays on 'mark': its orders are priced never to fill, so broker fills would correctly
// book nothing — true, and useless, since it would turn the paper variant into a no-op not a comparison.
// ── THE MODE THE ORDER SENDERS MUST USE ─────────────────────────────────────────────────────────────
//
// The roster sets the CEILING (CANDLE_SPREAD_ARMED_MODE); the control file may lower it. This returns what
// actually applies, and every sender plus fillSourceFor now reads it instead of run.dryRun.
//
// WHY THIS EXISTS. All three senders captured `const mode = run.dryRun` at closure-creation time and decided
// unfillable pricing from it (`const isTest = mode === 'test'`). So with the roster armed live, a control entry
// of 'paper' was ignored by the senders: the trader believed paper while REAL FILLABLE orders went out, and
// fillSource read the roster too and said 'broker'. I had recommended exactly that as a safe "brake" before
// going live — it would have sent real orders. Caught 2026-10-01 before the next open, with nothing traded.
//
// The clamp in strategy-control stops the file raising ABOVE the roster; this makes lowering actually work.
// Together they are the rule stated from the start: the environment raises, the file lowers.
function effectiveDryRun(run) {
  const c = SC.forVariant(run.variant);
  const fromControl = c.listed ? SC.dryRunFor(run.variant) : undefined;
  return fromControl !== undefined ? fromControl : run.dryRun;
}

function fillSourceFor(run) {
  // EFFECTIVE, not roster: holding a live-armed variant at paper must also keep the engine booking from marks,
  // or it would treat the broker as authoritative for fills that were never fillable.
  const real = effectiveDryRun(run) === false && DEPS && DEPS.isProd === true && LIVE_ARMED
    && DEPS.tradingClient && DEPS.accountHash;
  return real ? 'broker' : 'mark';
}

// Test-mode knobs. In dryRun:'test' a REAL order is sent but at an intentionally unfillable price
// (so you can watch it hit Schwab and stick without any execution risk), then the poller cancels
// it after TEST_CANCEL_MS. TEST_FRAC = the debit fraction (0.1 => a $10.50 debit is sent at $1.05);
// credit orders invert it (see order-manager.unfillablePrice).
// RANGE-CHECKED. It MULTIPLIES a debit (must shrink it) and DIVIDES a credit (must grow it), so anything
// at or above 1 sends at or through the real price while /status still reports "unfillable + auto-cancel".
// unfillablePrice clamps too; this makes a bad value visible instead of silently corrected.
const TEST_FRAC = (() => {
  const raw = process.env.CANDLE_SPREAD_TEST_FRAC;
  if (raw == null || raw === '') return 0.1;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0 && n < 1) return n;
  console.error(`[candle-spread] CANDLE_SPREAD_TEST_FRAC=${raw} is outside (0,1) — test orders would be FILLABLE. Using 0.1.`);
  return 0.1;
})();
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
// ── THE HALT, AT THE ONE BOUNDARY EVERY ORDER CROSSES ───────────────────────────────────────────────
//
// `restrict: 'halt'` has to mean NOTHING reaches the broker, so it is checked at the send itself rather than at
// each decision that leads to one. There are three senders (place, replace, cancel) and a halt that covered two
// of them would be worse than none — it would look effective while the ladder kept repricing.
//
// A CANCEL IS STILL ALLOWED. Halt means "stop putting risk on", not "abandon the orders already resting": if
// something is wrong, pulling a working order is the helpful action, and blocking it would leave live orders at
// the broker that the engine has decided to stop managing. That is the shape of the phantom book, inverted.
//
// Returns a REASON rather than a boolean so the refusal event says which restriction stopped it and who set it.
function controlBlocks(run, kind) {
  const c = SC.forVariant(run.variant);
  if (c.restrict !== 'halt') return null;
  if (kind === 'cancel') return null;
  return { why: 'halted', note: c.note || null, mode: c.mode };
}

function makeReplaceOrder(run, record) {
  // RESOLVED PER CALL, not captured: the control file can lower the mode between one order and the next, and a
  // value captured when the closure was built would ignore that for the life of the process.
  const modeNow = () => effectiveDryRun(run);
  return async function replaceOrder(orderId, payload, meta) {
    // REMOTE HALT — see controlBlocks. Checked before the gates below so a halted variant records its intent
    // and sends nothing, exactly as a disarmed one does.
    const blocked = controlBlocks(run, 'replace');
    if (blocked) {
      store.appendEvent(record, { type: 'order_control_blocked', kind: (meta && meta.kind) || 'replace',
        restrict: blocked.why, controlNote: blocked.note, meta,
        note: `not sent: ${run.variant} is ${blocked.why} by strategy-control`
          + (blocked.note ? ` (${blocked.note})` : '') });
      return { status: `blocked:${blocked.why}`, sent: false };
    }
    // Resolve the mode HERE, on every order, so lowering v7-10 to paper mid-session actually reaches the wire.
    const mode = modeNow();
    const wantsRealSend = mode === false || mode === 'test';
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
    // NEVER REPLACE AN ORDER THE BROKER HAS ALREADY FINISHED WITH. Schwab answers a replace on a dead
    // order with `400 - Order in status REJECTED cannot be replaced`, and the ladder would keep asking
    // every bar: 53 such calls across 19 positions on 2026-09-24 alone, one position six times over.
    //
    // The poller now clears the strategy's pending state when an order dies (order-manager
    // clearDeadOrderState), which stops most of this at the source — but the two run on separate timers,
    // so a reprice can still be built from state the poller has not caught up with yet. This is the belt
    // to that braces, and it costs one array lookup.
    const tracked = ((record.state && record.state.liveOrders) || []).find((x) => x && x.orderId === orderId);
    if (tracked && tracked.cancelRequestedAt && !om.isTerminal(tracked)) {
      store.appendEvent(record, { type: 'order_replace_skipped', meta, orderId, status: 'cancel-requested',
        note: 'not sent: a cancel is pending on this order' });
      return { status: 'skipped:cancel-requested', orderId };
    }
    if (tracked && om.isTerminal(tracked)) {
      store.appendEvent(record, { type: 'order_replace_skipped', orderId, kind: meta && meta.kind,
        status: tracked.status, meta,
        note: `not replaced: the broker already reports this order ${tracked.status}` });
      return { status: `skipped:${tracked.status}`, orderId, sent: false };
    }
    const isTest = mode === 'test';
    // Same rule as the place path: a replace is an order too, and a walked price that cannot be proven
    // unfillable is still walked at the broker rather than dropped on the floor.
    const testOrd = isTest ? om.unfillableOrder(payload, TEST_FRAC, run.spreadWidth, run.tickIncrement) : null;
    if (isTest && !testOrd) {
      store.appendEvent(record, { type: 'order_simulated', by: 'no-price', meta, payload,
        note: `no usable price on a ${payload.orderType} replace (${payload.price}) — leaving the order where it is` });
      return { status: 'simulated:no-price', orderId };
    }
    if (isTest && !testOrd.guaranteed) {
      store.appendEvent(record, { type: 'order_test_not_guaranteed', meta, orderId,
        orderType: payload.orderType, realPrice: payload.price, sentPrice: testOrd.price, why: testOrd.why,
        note: 'TEST replace SENT at the least fillable price this structure admits' });
    }
    const sendPayload = om.wirePrice(isTest ? { ...payload, price: testOrd.price } : payload);
    try {
      const resp = await DEPS.tradingClient.updateOrderById(DEPS.accountHash, orderId, sendPayload);
      const newId = (resp && resp.orderId) ? resp.orderId : orderId;
      // A REPLACEMENT IS A NEW ORDER AT THE BROKER. Nothing tracked it, so after the first ladder step the
      // live order was invisible: never polled for a fill, never auto-cancelled in test mode, never swept
      // when stale. Meanwhile the OLD id stayed in liveOrders and polls to REPLACED -> 'canceled' ->
      // terminal, so the record claimed a dead order and missed a live one. In test mode that is the worse
      // half: the replaced order rests at Schwab past TEST_CANCEL_MS with nothing to pull it.
      if (newId && newId !== orderId) {
        // ACCEPTED IS NOT REPLACED. Retiring the old row here stopped polling it the moment Schwab accepted
        // the PUT — but the ladder replaces exactly when the market is nearest our price, which is when the
        // OLD order is likeliest to fill while the replace is still pending. Its fill was then invisible,
        // the replacement died, and the engine re-covered (a double cover) or never booked a real open.
        // Live orders now keep the old row polling until the broker confirms REPLACED, and link the pair so
        // order-manager.reconcile can settle the race either way. Test orders keep the old shortcut: an
        // unfillable price cannot race anything.
        const oldRow = ((record.state && record.state.liveOrders) || []).find((x) => x && x.orderId === orderId);
        if (isTest || !oldRow) {
          om.retireOrder(record, orderId, 'replaced');
        } else {
          oldRow.replacedBy = newId;
          oldRow.replacedAt = Date.now();
          // An OPEN's first row carries no positionId (it is sent before the position exists); give it the
          // link now, or a fill on it could not find its position.
          if (!oldRow.positionId && meta && (meta.of || meta.positionId)) oldRow.positionId = meta.of || meta.positionId;
        }
        om.trackOrder(record, {
          orderId: newId, kind: (meta && meta.kind) || 'replace',
          positionId: (meta && (meta.of || meta.positionId)) || null,
          net: om.netOfPayload(sendPayload), requestedPrice: payload.price, sentPrice: sendPayload.price,
          testMode: isTest, legs: meta && meta.legs, placedAt: Date.now(),
          replaces: (!isTest && oldRow) ? orderId : undefined,
          prior: (!isTest && oldRow && meta && meta.prior) ? meta.prior : undefined
        });
      } else {
        // THE ROW MUST DESCRIBE THE ORDER THAT IS NOW RESTING, even when the id did not change. Schwab
        // normally answers a replace with a NEW orderId (measured 09-28: 1008084814192 -> ...198), which
        // takes the branch above and re-tracks with the new net. But a response carrying no orderId leaves
        // newId === orderId and skipped this entirely, so the row kept its OLD net and price.
        //
        // That matters because concedeCover can replace a DEBIT cover with its CREDIT twin: the row would
        // then say NET_DEBIT while a credit order rests at the broker. Every consumer of `net` would be
        // wrong, and the wrong-side guard in applyBrokerFills would refuse a perfectly good fill on the
        // strength of our own stale label. Update in place instead.
        const row = ((record.state && record.state.liveOrders) || []).find((x) => x && x.orderId === orderId);
        // NO NEW ID CAME BACK, but Schwab always issues one: this id will poll REPLACED while the real
        // replacement rests untracked. Flag it so reconcile does NOT read that REPLACED as "the order died"
        // (which would clear the pending state and invite a second order) and says so loudly instead.
        if (row && !isTest) row.replaceIdUnknown = true;
        if (!isTest) console.error(`[candle-spread] ${run.variant} REPLACE #${orderId} returned NO new order id — `
          + 'the replacement is live at Schwab and untracked; the position check will show it');
        if (row) {
          const wasNet = row.net;
          row.net = om.netOfPayload(sendPayload);
          row.requestedPrice = payload.price;
          row.sentPrice = sendPayload.price;
          if (meta && meta.legs) row.legs = meta.legs;
          if (wasNet !== row.net) {
            store.appendEvent(record, { type: 'order_side_changed', orderId, from: wasNet, to: row.net,
              note: 'a replace kept the same order id but changed the net side; the tracked row was updated '
                + 'in place so it still describes the resting order' });
          }
        }
      }
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

// CANCEL ONE ORDER AT THE BROKER. Same three gates as every other sender, and the same shape of result.
//
// The capability already existed — order-manager's reconcile calls orderDelete on its own 20s timer — but
// nothing the STRATEGY decided ever reached it. A reversal cancelled the position in memory and left the
// order live; the only thing that eventually pulled it was om's stale-open sweep, up to 15 minutes later.
function makeCancelOrder(run, record) {
  // RESOLVED PER CALL, not captured: the control file can lower the mode between one order and the next, and a
  // value captured when the closure was built would ignore that for the life of the process.
  const modeNow = () => effectiveDryRun(run);
  return async function cancelOrder(orderId, meta) {
    // REMOTE HALT — see controlBlocks. Checked before the gates below so a halted variant records its intent
    // and sends nothing, exactly as a disarmed one does.
    const blocked = controlBlocks(run, 'cancel');
    if (blocked) {
      store.appendEvent(record, { type: 'order_control_blocked', kind: (meta && meta.kind) || 'cancel',
        restrict: blocked.why, controlNote: blocked.note, meta,
        note: `not sent: ${run.variant} is ${blocked.why} by strategy-control`
          + (blocked.note ? ` (${blocked.note})` : '') });
      return { status: `blocked:${blocked.why}`, sent: false };
    }
    // Resolve the mode HERE, on every order, so lowering v7-10 to paper mid-session actually reaches the wire.
    const mode = modeNow();
    const wantsRealSend = mode === false || mode === 'test';
    const canSend = DEPS && DEPS.isProd === true && wantsRealSend && LIVE_ARMED
      && DEPS.tradingClient && DEPS.accountHash && orderId;
    if (!canSend) {
      const why = !orderId ? 'no-order-id' : mode === true ? 'dryRun'
        : !(DEPS && DEPS.isProd) ? 'dev-mode' : !LIVE_ARMED ? 'disarmed' : 'no-client';
      store.appendEvent(record, { type: 'order_simulated', by: why, meta, orderId, note: `cancel not sent (${why})` });
      return { status: `simulated:${why}`, orderId };
    }
    // DO NOT CANCEL WHAT IS ALREADY GONE. The poller and the strategy both act on the same order rows, and
    // the poller's test-mode auto-cancel can retire an order before the strategy's own reversal-cancel
    // reaches it. Schwab answers that with `400 — Order in state CANCELED cannot be canceled`, which this
    // recorded as order_error: harmless in outcome, but indistinguishable in the log from a cancel that
    // genuinely failed on an order we still believed was live. Seen once today (09-28, pos-1790606108508-228
    // on a reversal). replaceOrder already refuses terminal orders; this is the same rule for the same
    // reason. Recorded as a distinct event so the near-miss is still visible.
    const tracked = ((record.state && record.state.liveOrders) || []).find((x) => x && x.orderId === orderId);
    if (tracked && om.isTerminal(tracked)) {
      store.appendEvent(record, { type: 'order_cancel_skipped', meta, orderId, status: tracked.status,
        note: `not sent: the order is already ${tracked.status}`
          + (tracked.canceledReason ? ` (${tracked.canceledReason})` : '') });
      return { status: `already:${tracked.status}`, orderId };
    }
    try {
      await DEPS.tradingClient.orderDelete(DEPS.accountHash, orderId);
      // ACCEPTED IS NOT CANCELLED. This retired the row as soon as Schwab accepted the DELETE, so the poller
      // never saw the outcome: a fill that beat the cancel was invisible, and a reversed open kept "until
      // the broker answers" never got its answer. Keep the row and let the poller resolve it — CANCELED
      // retires it through clearDeadOrderState, FILLED books it through applyBrokerFills.
      if (tracked) {
        tracked.cancelRequestedAt = Date.now();
        tracked.canceledReason = (meta && meta.reason) || (meta && meta.kind) || 'strategy-cancel';
      }
      store.appendEvent(record, { type: 'order_cancelled', meta, orderId,
        note: `cancelled #${orderId}${meta && meta.reason ? ` (${meta.reason})` : ''}` });
      console.log(`[candle-spread] ${run.variant} CANCEL #${orderId}${meta && meta.reason ? ` — ${meta.reason}` : ''}`);
      return { status: 'cancelled', orderId };
    } catch (e) {
      // An order already filled or already gone cannot be cancelled, and that is not worth failing a tick
      // over — but it IS worth recording, because it means the engine's belief and the broker's state had
      // already diverged.
      store.appendEvent(record, { type: 'order_error', meta, orderId, note: `Schwab cancel failed: ${e && e.message}` });
      console.error(`[candle-spread] ${run.variant} CANCEL FAILED #${orderId}: ${e && e.message}`);
      return { status: 'error', orderId, error: e && e.message };
    }
  };
}

function makePlaceOrder(run, record) {
  const modeNow = () => effectiveDryRun(run);      // true | 'test' | false, control-aware

  return async function placeOrder(payload, meta) {
    // REMOTE HALT — see controlBlocks. Checked before the gates below so a halted variant records its intent
    // and sends nothing, exactly as a disarmed one does.
    const blocked = controlBlocks(run, 'place');
    if (blocked) {
      store.appendEvent(record, { type: 'order_control_blocked', kind: (meta && meta.kind) || 'place',
        restrict: blocked.why, controlNote: blocked.note, meta,
        note: `not sent: ${run.variant} is ${blocked.why} by strategy-control`
          + (blocked.note ? ` (${blocked.note})` : '') });
      // filled:false IS THE CONTRACT every caller tests (`placed.filled === false` = nothing at the broker).
      // Without it a halted send read as a success: placeRestingCover attached a pendingCover with no order
      // behind it and every hedge planner booked a pending hedge, so after `resume` those positions were
      // never covered again — every cover path skips a position that already has a pendingCover.
      return { status: `blocked:${blocked.why}`, sent: false, filled: false, error: blocked.why };
    }
    // Resolve the mode HERE, on every order, so lowering v7-10 to paper mid-session actually reaches the wire.
    const mode = modeNow();
    const wantsRealSend = mode === false || mode === 'test';
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
    // TEST MODE ALWAYS SENDS. The point of this mode is that a REAL order reaches Schwab and comes back
    // through the real lifecycle, so the path is exercised and the broker's order list matches what the
    // strategy wanted. This used to SKIP the send whenever unfillableOrder could not prove the price
    // unfillable — which suppressed exactly the case worth seeing (a broken chain) and made "orders sent"
    // stop matching "orders intended". It now sends at the extreme the instrument admits and records that
    // the guarantee is weak; residual exposure in that case is ONE TICK.
    const testOrd = isTest ? om.unfillableOrder(payload, TEST_FRAC, run.spreadWidth, run.tickIncrement) : null;
    if (isTest && !testOrd) {
      // No usable price on the payload at all — there is no order to send in any mode.
      store.appendEvent(record, { type: 'order_simulated', by: 'no-price', meta, payload,
        note: `no usable price on a ${payload.orderType} payload (${payload.price}) — nothing to send` });
      console.warn(`[candle-spread] ${run.variant} NO PRICE on a ${payload.orderType} payload — not sent`);
      return { status: 'error', filled: false, sent: false, error: 'no usable price' };
    }
    if (isTest && !testOrd.guaranteed) {
      store.appendEvent(record, { type: 'order_test_not_guaranteed', meta,
        orderType: payload.orderType, realPrice: payload.price, sentPrice: testOrd.price, why: testOrd.why,
        note: 'TEST order SENT at the least fillable price this structure admits — not provably unfillable' });
      console.warn(`[candle-spread] ${run.variant} TEST order not provably unfillable: ${testOrd.why}`);
    }
    const sendPayload = om.wirePrice(isTest ? { ...payload, price: testOrd.price } : payload);
    try {
      const resp = await DEPS.tradingClient.placeOrderByAcct(DEPS.accountHash, sendPayload);
      const orderId = resp && resp.orderId ? resp.orderId : null;
      om.trackOrder(record, {
        orderId, kind: meta.kind, positionId: meta.of || meta.positionId || null,
        net: om.netOfPayload(payload), requestedPrice: payload.price, sentPrice: sendPayload.price,
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
      // A refusal AT SEND counts toward the same repeated-rejection alarm as an asynchronous REJECTED.
      om.noteReject(record, om.rejectKey(meta && meta.kind, meta && (meta.of || meta.positionId)), String((e && e.message) || 'send failed').slice(0, 300),
        { kind: meta && meta.kind, price: sendPayload && sendPayload.price });
      console.error(`[candle-spread] ${run.variant} ORDER SEND FAILED: ${e && e.message}`);
      // A REJECTED ORDER IS NOT A POSITION. This returned `filled: true` so the state machine would keep
      // simulating the intended strategy through a send failure — correct while nothing was real, and
      // exactly inverted once it is. Every caller treats the result as "the order exists": a rejected
      // cover-rest became a resting cover and later a booked floor, a rejected combo booked two positions
      // and a locked profit, a rejected hedge became a pending hedge holding budget. All of it off a 4xx.
      //
      // `filled: false` now, and the callers skip. The SIMULATED path above still returns true — there the
      // order genuinely was not sent and continuing to model the strategy is the whole point.
      return { status: 'error', filled: false, sent: false, error: e && e.message };
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
  // ── REMOTE CONTROL, APPLIED HERE SO ONE PLACE DECIDES ─────────────────────────────────────────────
  // `mode` selects dryRun and `restrict: 'no-open'` blocks new opens. Both are resolved at deps-build time
  // rather than inside the trader, because the trader should keep taking its orders from deps and knowing
  // nothing about where they came from — the same reason signalFn is passed in rather than looked up.
  //
  // MODE OVERRIDES THE ROSTER'S dryRun, which is what makes the control file useful: the roster arms exactly
  // one variant from the environment, and this is how a second one starts paper-trading without a deploy.
  // strategy-control has ALREADY downgraded a 'live' request to paper unless CANDLE_SPREAD_LIVE permits it, so
  // nothing here can arm real money that the environment has not already allowed.
  const ctl = SC.forVariant(run.variant);
  const ctlDryRun = ctl.listed ? SC.dryRunFor(run.variant) : undefined;
  return Object.assign({
      dryRun: ctlDryRun !== undefined ? ctlDryRun : run.dryRun,
      // NO-OPEN: work what is already on the book, start nothing new. The safe reflex — a live variant holding
      // an uncovered 0DTE position that stops acting entirely is in the most dangerous state available, so this
      // deliberately leaves covers, ladders and hedges running.
      blockNewOpens: ctl.restrict === 'no-open' || ctl.restrict === 'halt',
      controlMode: ctl.listed ? ctl.mode : null,
      controlRestrict: ctl.restrict || null,
      // CLOSED-LOOP FILLS — see FILL_SOURCE. 'mark' for every simulated run; 'broker' only for a run whose
      // orders can really fill, and only when explicitly switched on.
      fillSource: fillSourceFor(run),
      // Mark-path fills (opens, covers, hedges) book AT their limit, never better (trader.markFill).
      simFillAtLimit: run.simFillAtLimit === true,
      // Urgent cover for a position fighting the trend (trend-state definition name, or null = off).
      giveUpTrend: run.giveUpTrend || null,
      // Floor raise follows the CURRENT roster (and its env kill switch) even inside a sealed session —
      // trader.raiseFloor merges this over the record's frozen config. floorRaise is always explicit so
      // switching it off takes effect at once.
      floorRaiseCfg: Object.assign({ floorRaise: run.floorRaise === true },
        ...Object.keys(run).filter((k) => /^floorRaise./.test(k) && run[k] !== undefined).map((k) => ({ [k]: run[k] }))),
      // Needed by the chain-monotonicity gate in markFill to find each leg's neighbours. Listed in
      // NOT_ENGINE_OPTS as geo-consumed, so it is not contract-checked, but the gate reads it off deps.
      strikeIncrement: run.strikeIncrement,
      signalFn: run.signalFn, signalCfg: run.signalCfg, bidirectional: run.bidirectional,
      // v8 risk-cap opts (undefined for other variants → cap logic inert)
      riskCap: run.riskCap, softCap: run.softCap, hardCap: run.hardCap,
      proactiveCoverFrac: run.proactiveCoverFrac, exemptTrendStack: run.exemptTrendStack,
      coverToStack: run.coverToStack, coverToStackMinFrac: run.coverToStackMinFrac,
      // CONTINUOUS COVERING (ported from the backtest 2026-09-04) — the covering POLICY, not a risk cap.
      continuousCover: run.continuousCover, continuousCoverMinLockFrac: run.continuousCoverMinLockFrac,
      // CAPITAL TRIGGER — credit orders fire to RECLAIM deployed capital rather than on a counter
      // (openAlternateEvery) or a depth (creditCoverFrac). Like every engine opt it MUST be listed here
      // or the flag is a silent live no-op; the variant contract asserts exactly that.
      creditCapitalTrigger: run.creditCapitalTrigger,
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
    //   simOpenFillMinLooks / coverFillThroughTicks / minDebitFrac / openWalkCapFrac / maxOtmStrikes /
    //     openRestrikeMin — read by the trader straight off the run's cfg (resolvePendingOpen,
    //     resolveRestingCovers, buildOpenAtStrikes, buildOpenAdaptive), not via deps. Missing here took prod
    //     down on 2026-10-05: the startup check refused every variant once G put them on the roster.
    VC.assertForwarded(run, keys, 'live deps (buildEngineDeps)',
      ['coverGeometry', 'coverSelector', 'lockCoverMode', 'ivSkew',
        'simOpenFillMinLooks', 'coverFillThroughTicks', 'minDebitFrac', 'openWalkCapFrac', 'maxOtmStrikes', 'openRestrikeMin',
        // floor raise: read straight off cfg by trader.raiseFloor
        'floorRaise', 'floorRaiseMinRatio', 'floorRaiseBudgetFrac', 'floorRaiseSigmas', 'floorRaiseEveryMin',
        'floorRaiseMaxPerDay', 'floorRaiseSlipTicks', 'floorRaiseObjective', 'floorRaiseMinRatioFar', 'floorRaiseFarSigmas', 'floorRaiseLiftMetric']);
  }
}

// ── MOVED TO MODULE SCOPE 2026-09-28 — THIS WAS THE SETTLEMENT BUG ──────────────────────────────────
// Both helpers were introduced in 73454ff INSIDE processGroup, which put them out of reach of three of
// their four callers. A `function` declaration hoists to its enclosing FUNCTION, not to the file, so the
// only call site that worked was the one that also lives in processGroup (the candle close). The other
// three — the 30s sub-bar worker, session close, and EOD settlement — threw `initRunSafe is not defined`
// on every single invocation.
//
// It cost three sessions of settlement (09-24, 09-25, 09-28 — 560 eod_settlement_error events today alone,
// 80 variants x 7 retries) and, quieter and worse, it killed the sub-bar worker on every pass since 09-23,
// so resting covers were only resolved at 5m candle closes instead of roughly every 30s and the ladder
// never repriced between bars.
//
// It hid because the per-variant try/catch added in the SAME commit caught the ReferenceError and filed it
// as a settlement failure, and the boot backfill then quietly repaired the days behind it. An uncaught
// crash would have been found in an hour; a caught error that something else papers over survived five
// sessions. Keep these at module scope: every caller is in a different function.
// ONE BAD RECORD MUST NOT STOP THE OTHER 79. store.initRun now THROWS in a single case — the run file is
// corrupt AND could not be moved aside — because writing over it is the failure it exists to prevent. That
// is correct, but three of the loops below call it once per variant, so an unthrowable throw would abort
// the whole pass and skip every healthy variant with it. Catch per variant, log loudly, skip that one.
// A record's config is FROZEN AT CREATION and is what the engine runs on for the rest of the day. That is
// right once a session is under way — changing the governor half way through a day is worse than running
// the old one consistently — but it is wrong for a record created before anything happened, which is how
// the armed variant came to run six sessions on a stale lossMax.
//
// So: while a run is UNTOUCHED (no events, no positions) the roster is the truth and the record is
// refreshed to match, with an event recording exactly which fields moved. Once the first candle lands the
// config is sealed.
function refreshUntouchedConfig(record, cfg, where) {
  if (!record || !record.config) return record;
  const st = record.state || {};
  if ((record.events || []).length || (st.positions || []).length) return record;   // session under way: seal it
  const changed = [];
  for (const k of Object.keys(cfg)) {
    if (typeof cfg[k] === 'function') continue;
    const a = record.config[k], b = cfg[k];
    if (a === b) continue;
    if (a == null && b == null) continue;
    if (typeof a === 'object' || typeof b === 'object') continue;   // compare scalars only
    changed.push(`${k}: ${a} -> ${b}`);
  }
  if (!changed.length) return record;
  record.config = { ...cfg };
  store.appendEvent(record, { type: 'config_refreshed', where, changed,
    note: 'the record was created before this session began and its config had gone stale against the roster; '
      + 'refreshed while the run is still untouched. A config is sealed once the first candle lands.' });
  console.warn(`[candle-spread] ${cfg.variant} config refreshed before the session (${where}): ${changed.join(', ')}`);
  return record;
}

function initRunSafe(cfg, tradeDate, where) {
  try {
    return refreshUntouchedConfig(store.initRun(cfg, tradeDate), cfg, where);
  } catch (e) {
    console.error(`[candle-spread] ${where}: cannot open the record for ${cfg.variant} — ${e && e.message}`);
    console.error('  this variant is SKIPPED this pass; the others continue. Fix the file, do not delete it.');
    return null;
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
  // TREND STATE context (15m + completed/forming hourly) from the same signal series — trend-state.js.
  let trendCtx = null;
  try { trendCtx = TS.contextFromSeries(series, T); } catch (e) { console.error('[candle-spread] trend context failed:', e && e.message); }

  // PRICING underlying (strike centering). Single-instrument: A's own 5m close. Split (signal≠price):
  // the price instrument's just-closed 5m close.
  let underlying = A['5m'] && A['5m'].close;
  // THE PRICING BAR, NOT JUST ITS CLOSE. We kept four numbers (OHLC) for the instrument we only take
  // SIGNALS from, and exactly one for the instrument we price and settle against — which is backwards
  // given /NQ signals, NDX pricing. The cost showed up on 2026-09-23: NDX opened 30706 and the first bar
  // we record closed at 30637, so 69 points — 29% of the day's entire decline — happened inside a bar
  // whose open we simply did not keep. Every "how much of the move did we capture" answer this week was
  // silently anchored at the 09:35 close rather than the session open, and there was no way to tell.
  //
  // The 09:30-09:35 bar is NOT skipped: FIRST_ACTION_MIN is its CLOSE and the engine acts on it. Only the
  // record was lossy. Purely additive — nothing reads priceBar yet, so no decision changes.
  let priceBar = A['5m'] ? { open: A['5m'].open, high: A['5m'].high, low: A['5m'].low, close: A['5m'].close } : null;
  if (signalSymbol !== priceSymbol) {
    try {
      const pxAnalysis = await DEPS.analyzeCandles(priceSymbol, { timeframe: '5m' });
      const px = pickJustClosed(pxAnalysis?.candleData?.['5m']?.candles || [], STEP_MS);
      if (!px.candle) return { pending: 'price-candle-not-available' };
      underlying = px.candle.close;
      priceBar = { open: px.candle.open, high: px.candle.high, low: px.candle.low, close: px.candle.close };
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
      const record = initRunSafe(cfg, tradeDate, 'candle close');
      if (!record) continue;
      const getLeg = trader.makeLegAccessor(chainData, expiration);
      const placeOrder = makePlaceOrder(run, record);
      const replaceOrder = makeReplaceOrder(run, record);
      await trader.processCandleClose(record, candle, null, buildEngineDeps(run, {
        getLeg, placeOrder, replaceOrder, cancelOrder: makeCancelOrder(run, record),
        A, priorA, isFifteen, underlying, priceBar, signalSymbol, priceSymbol, trendCtx,
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
// Declared here with the other guards rather than beside the poller: attemptTick reads it, and a `let`
// used above its own declaration sits in the temporal dead zone — safe only because module load finishes
// before any timer fires, which is not a property worth depending on.
let pollBusy = false;
function attemptTick(kind, retriesLeft) {
  // DEFER IF A POLL IS MID-FLIGHT, do not skip. All three writers read-modify-write the WHOLE run record
  // (store.initRun re-parses from disk, writeRun rewrites the file), so an overlap loses whichever write
  // lands first — in full, silently, and leaving a file that parses perfectly. The poller already skips
  // when a tick or worker is running; this closes the other direction.
  //
  // The tick DEFERS rather than skipping because it is the one pass that cannot be missed: it is the
  // candle close, and everything else follows from it. A poll takes well under a second, so the retry
  // costs latency and nothing else. Give up deferring after a few tries rather than drop the candle —
  // a stuck pollBusy must never be able to stop the engine trading.
  if (pollBusy && retriesLeft > 0) {
    setTimeout(() => attemptTick(kind, retriesLeft - 1), 400);
    return;
  }
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
  if (!started || workBusy || tickBusy || pollBusy) return;
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
      const record = initRunSafe(cfg, tradeDate, 'sub-bar worker');
      if (!record) continue;
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
      // THE WORKER HAS TO REACH THE BROKER TOO. These were missing, so concedeCover's
      // `if (deps.replaceOrder && pc.orderId)` was false on every sub-bar pass: the ladder and give-up
      // moved pc.target/pc.sentCredit and logged cover-reprice while the resting Schwab order never
      // moved, and resolveRestingCovers then booked fills at prices that order never asked for. The
      // worker runs every 30s against the tick's ~5 minutes, so it is where most repricing happens —
      // measured on v7-10 for 2026-09-23, 14 of 39 cover repricings (36%) never left the process.
      const deps = buildEngineDeps(run, { getLeg, nowMs: Date.now(), underlying: st.lastUnderlying,
        placeOrder: makePlaceOrder(run, record), replaceOrder: makeReplaceOrder(run, record),
        cancelOrder: makeCancelOrder(run, record) });
      try {
        // Consume broker fills here too, not only at the candle close: the poller runs on its own timer,
        // and a fill should become a position within ~30s rather than waiting up to five minutes for the
        // next bar. Idempotent (each order applies once), so both call sites is correct, not double.
        trader.applyBrokerFills(st, cfg, deps, decisions);
        await trader.resolvePendingOpen(st, cfg, deps, decisions);
        trader.resolvePendingHedges(st, cfg, deps, decisions);
        if (cfg.coverFillModel === 'resting') {
          // BOTH, and in this order, exactly as processCandleClose does it (trader.js). workRestingCovers
          // only WALKS the ladder; resolveRestingCovers is what tests whether the mark reached the target
          // and books the fill. Calling the first alone — which is what this did on 2026-09-15 — meant the
          // worker repriced 126 times and filled nothing, so every fill still waited for a candle close
          // and the whole reason for a sub-bar pass was missing.
          trader.governRestingCovers(st, cfg, deps, decisions);
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

// THE THIRD WRITER. The tick and the sub-bar worker already serialize against each other (tickBusy /
// workBusy) because both mutate the same run records; the poller does not, and it is the one that writes
// order_filled.
//
// store.initRun re-parses the record from disk on every call and writeRun rewrites the whole file, so
// whoever writes last wins the WHOLE record, not just their field. A poll landing mid-tick silently
// erases a cover the worker just booked, or the tick erases the fill the poller just recorded — and
// nothing anywhere notices, because each wrote a file that parsed perfectly.
//
// Same guard as the worker: skip this pass rather than queue it. The poller runs every 20s and a missed
// pass costs at most one cycle of fill-detection latency, which is far cheaper than a lost write.
async function runOrderPoll() {
  if (!(LIVE_ARMED && DEPS && DEPS.isProd === true && DEPS.tradingClient && DEPS.accountHash)) return;
  if (pollBusy || tickBusy || workBusy) return;
  pollBusy = true;
  try {
    await runOrderPollInner();
  } finally {
    pollBusy = false;
  }
}

// THE POSITION LOOP runs on its own, slower clock. The order poll is every ORDER_POLL_MS because an
// unfilled order needs working; what we HOLD changes only when something fills, so checking it every poll
// would spend API quota to re-read the same answer. Once every few minutes catches an orphan long before it
// matters, and the account fetch is ONE call shared by every run rather than one per run.
let _posCheckAt = 0;
const POS_CHECK_MS = 3 * 60 * 1000;
async function accountPositionsIfDue() {
  // ANY RUN THAT REACHES THE BROKER AT ALL, test mode included — the same `wantsRealSend` condition the
  // order senders use.
  //
  // The tighter gate (dryRun === false only) was wrong for the reason this whole week has been about. With
  // ARMED_MODE defaulting to 'test', NO run has dryRun === false, so this fetch would never have executed
  // once — and the FIRST time it ran would be the day a funded account went live, on response parsing that
  // has never seen a real response. A reconciler whose code has never run is not a safety net.
  //
  // Running it in test mode costs one read-only account read every 3 minutes and exercises the whole path
  // — fetch, symbol parse, netting, the roots actually returned — while nothing is at stake. A test run
  // still reports severity 'expected', so it raises no false alarm; what it produces is evidence that the
  // shape is right, visible at /status.runs[].positionReconcile.
  const anyReal = RUNS.some((r) => r.dryRun === false || r.dryRun === 'test');
  if (!anyReal || !LIVE_ARMED || !(DEPS && DEPS.isProd === true && DEPS.tradingClient && DEPS.accountHash)) return null;
  if (typeof DEPS.tradingClient.accountsDetails !== 'function') return null;
  const now = Date.now();
  if (now - _posCheckAt < POS_CHECK_MS) return null;
  _posCheckAt = now;
  try {
    // 'positions' IS REQUIRED. Schwab omits the positions array unless fields=positions is asked for, so
    // without it every read came back with zero rows — brokerRows 0 / brokerRoots [] on 2026-10-02 while
    // the account held two real NDXP spreads. The reconciler could never have seen anything.
    return await DEPS.tradingClient.accountsDetails(DEPS.accountHash, 'positions');
  } catch (e) {
    console.error('[candle-spread] account positions fetch:', e && e.message);
    return null;
  }
}

async function runOrderPollInner() {
  const deps = { tradingClient: DEPS.tradingClient, accountHash: DEPS.accountHash };
  // REFRESH THE CONTROL PLANE. On the order-poll tick rather than a timer of its own: ~20s is the worst-case
  // latency for a halt to take effect, which is well inside the 5m candle cadence the engine acts on, and it
  // keeps one clock instead of two. Resolves always; a failure leaves the previous state in force.
  // THE ROSTER'S BASELINE GOES WITH IT, so an unlisted variant reports what it actually does rather than
  // defaulting to 'simulate' — v7-10 runs paper from the environment and the control file never mentions it.
  await SC.refresh({ knownVariants: rosterVariants(), liveAllowed: LIVE_ARMED, baseline: rosterBaseline() })
    .catch((e) => console.error('[candle-spread] strategy-control:', e && e.message));
  // FETCHED ONLY IF SOMETHING WILL USE IT. Eagerly calling accountPositionsIfDue() here meant the account
  // was read every 3 minutes whether or not any run had a record to compare against — all weekend, all
  // night, ~480 reads a day answering a question nobody asked. Lazy + memoised per poll: the first run that
  // actually has a book triggers the one fetch, every later run in the same pass reuses it, and on a day
  // with no session it never happens at all.
  let _acct;
  const acctDetailsIfAny = async () => {
    if (_acct === undefined) _acct = await accountPositionsIfDue();
    return _acct;
  };
  for (const run of RUNS) {
    if (!(run.dryRun === false || run.dryRun === 'test')) continue;
    // READ, NEVER CREATE. This called initRun, which CREATES the record when none exists — and the poller
    // runs on a timer regardless of market hours, so it manufactured the armed variant's record at
    // midnight, hours before the first tick. initRun freezes the variant's config onto the record at
    // creation, so the whole session then ran against whatever build was live at 00:00 ET.
    //
    // Measured: v7-10 (the ARMED variant) was created at 04:00Z every trading day since 2026-09-07 and
    // carried lossMax 1000 against the roster's 1500 for six sessions (09-16, 17, 18, 21, 22, 23). On
    // 09-23 that blocked NINETEEN opens and left 22 positions where the same config backtests to 40. It
    // also littered the archive with 0-event phantom records on non-trading days (09-15, 19, 20).
    //
    // The poller only ever reads state.liveOrders. No record means no live orders, which is exactly the
    // "nothing to poll" case — so reading is not merely sufficient, it is the correct question.
    const cfg = { ...run, expiration: run.expiration || todayEST() };
    const record = store.readRun(store.makeRunId(cfg.symbol, cfg.expiration, todayEST(), cfg.variant));
    if (!record || !record.state) continue;
    const outstanding = (record.state.liveOrders || []).some(o => !om.isTerminal(o));
    if (outstanding) {
      try {
        await om.reconcile(record, deps, { testCancelAfterMs: TEST_CANCEL_MS });
      } catch (e) {
        console.error(`[candle-spread] order poll error (${run.variant}):`, e && e.message);
      }
    }
    // ── THE LOOP CLOSES HERE ──────────────────────────────────────────────────────────────────────
    // Polling tells each ORDER what the broker thinks of it. This asks the question one level up: does
    // the BOOK the strategy is trading on match the orders that actually filled? Those are different
    // questions, and the second one is the one nobody was asking — book-reconcile found every position of
    // v7-10 on 2026-09-25 to be a phantom (16 opens, 13 covers believed; 0 of 33 orders filled), and it
    // took a script run two days later to notice.
    //
    // Deliberately OUTSIDE the `outstanding` gate: a book whose orders are all terminal is exactly when
    // divergence is final, and skipping it there is how the 09-25 case stayed quiet.
    //
    // Only on a CHANGE of signature, so a standing disagreement is recorded once instead of every 30s for
    // six hours. The signature lives on the record, so it survives a restart with the day's book.
    try {
      const rec = BR.reconcileBook(record);
      // THE SIGNATURE HAS TO INCLUDE THE COUNTS, not just the disagreement kinds. Keyed on severity alone a
      // test-mode session never changes signature all day, so the summary would be written once, at zero.
      const sig = `${rec.severity}:${Object.entries(rec.byKind).sort().map(([k, v]) => k + v).join(',')}`
        + `:${rec.engine.opensFilled}/${rec.engine.coversFilled}:${rec.broker.filled}/${rec.broker.sent}`;
      // PERSISTED, NOT JUST ASSIGNED. This set record.state.bookReconcile and then only ever WROTE the
      // record inside the branch below — which is skipped whenever severity is 'expected', i.e. in simulate
      // and test mode, i.e. every mode we are currently in. The poller re-reads the record from disk each
      // pass, so the assignment was discarded every time and /status served null through a full session
      // with 17 real orders sent. The observability was blind in exactly the mode it exists to be observed
      // in, which also left the account response shape unconfirmed.
      if (sig !== record.state.bookReconcileSig) {
        record.state.bookReconcileSig = sig;
        record.state.bookReconcile = { severity: rec.severity, mode: rec.mode, byKind: rec.byKind,
          diffs: rec.diffs.length, at: new Date().toISOString(), engine: rec.engine, broker: rec.broker };
        // On CHANGE only — a handful of writes a session rather than every 30s for six hours. The
        // noteworthy case appends an event (which writes); the expected case just writes.
        if (rec.severity === 'expected') store.writeRun(record);
      }
      if (rec.severity !== 'expected' && sig !== record.state.bookReconcileEventSig) {
        record.state.bookReconcileEventSig = sig;
        store.appendEvent(record, { type: 'book_reconcile', severity: rec.severity, byKind: rec.byKind,
          engineOpens: rec.engine.opensFilled, engineCovers: rec.engine.coversFilled,
          brokerFilled: rec.broker.filled, brokerSent: rec.broker.sent,
          note: rec.agree
            ? 'engine book agrees with the broker'
            : `${rec.diffs.length} position(s) the engine and the broker do not agree on: `
              + Object.entries(rec.byKind).map(([k, v]) => `${v} ${k}`).join(', '),
          positions: rec.diffs.slice(0, 20) });
        if (rec.severity === 'DIVERGENT') {
          console.error(`[candle-spread] BOOK DIVERGENCE (${run.variant}): ${rec.diffs.length} position(s) — `
            + Object.entries(rec.byKind).map(([k, v]) => `${v} ${k}`).join(', ')
            + `; engine ${rec.engine.opensFilled} opens/${rec.engine.coversFilled} covers vs broker ${rec.broker.filled} filled of ${rec.broker.sent} sent`);
        }
      }
    } catch (e) {
      console.error(`[candle-spread] book reconcile (${run.variant}):`, e && e.message);
    }
    // ── AND THE OTHER LOOP: DO WE HOLD WHAT WE THINK WE HOLD? ─────────────────────────────────────
    // Orders answer "did what we sent fill?". This answers "what is in the account?" — the only question
    // that can see a fill whose order id we lost, an assignment, or a position that outlived our record
    // (the local-disk gap in store.js). REPORT ONLY: it never repairs a book, because a disagreement can
    // equally mean the reconciler or the account is wrong, and its response shape has never been seen
    // against a real position. See the note in book-reconcile.js.
    const acctDetails = await acctDetailsIfAny();
    if (acctDetails) {
      try {
        const pr = BR.reconcilePositions(record, acctDetails);
        // Same persistence bug as the book loop above, same fix. This summary is what confirms the account
        // response shape — brokerRoots should read NDXP, unparsedSymbols should be empty — and it never
        // reached disk, because a test-mode run is always 'expected'.
        const psig = `${pr.severity}:${pr.engineLegCount}:${pr.brokerRows}:${pr.brokerRoots.join('|')}`
          + `:${pr.unparsedSymbols.length}:${pr.diffs.map((d) => d.kind + d.leg + d.engine + '/' + d.broker).sort().join(',')}`;
        if (psig !== record.state.positionReconcileSig) {
          record.state.positionReconcileSig = psig;
          record.state.positionReconcile = { severity: pr.severity, byKind: pr.byKind, diffs: pr.diffs.length,
            engineLegCount: pr.engineLegCount, brokerRows: pr.brokerRows, brokerRoots: pr.brokerRoots,
            unparsedSymbols: pr.unparsedSymbols, at: new Date().toISOString() };
          if (pr.severity === 'expected' || pr.severity === 'clean') store.writeRun(record);
        }
        if (pr.severity !== 'expected' && pr.severity !== 'clean' && psig !== record.state.positionReconcileEventSig) {
          record.state.positionReconcileEventSig = psig;
          store.appendEvent(record, { type: 'position_reconcile', severity: pr.severity, byKind: pr.byKind,
            engineLegCount: pr.engineLegCount, brokerRows: pr.brokerRows, brokerRoots: pr.brokerRoots,
            unparsedSymbols: pr.unparsedSymbols.length ? pr.unparsedSymbols : undefined,
            legs: pr.diffs.slice(0, 40),
            note: pr.severity === 'UNREADABLE'
              ? `${pr.unparsedSymbols.length} broker symbol(s) could not be parsed — this comparison is NOT a clean bill`
              : `${pr.diffs.length} leg(s) the account and the book disagree on: `
                + Object.entries(pr.byKind).map(([k, v]) => `${v} ${k}`).join(', ') });
          console.error(`[candle-spread] POSITION DIVERGENCE (${run.variant}) ${pr.severity}: `
            + Object.entries(pr.byKind).map(([k, v]) => `${v} ${k}`).join(', ')
            + `; ${pr.diffs.slice(0, 6).map((d) => `${d.leg} book ${d.engine} vs account ${d.broker}`).join('; ')}`);
        }
      } catch (e) {
        console.error(`[candle-spread] position reconcile (${run.variant}):`, e && e.message);
      }
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
    // BOUNDED. An un-timed await on a network call can hang forever, and this one runs before anything is
    // written — so a stalled quote produces exactly what was seen: no settlement, no error, no trace.
    const withTimeout = (p, ms, what) => Promise.race([p,
      new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms}ms`)), ms))]);
    try {
      settle = DEPS.getSettlementPrice ? await withTimeout(DEPS.getSettlementPrice(symbol), 20000, 'settlement quote') : null;
      if (settle != null) settleSource = 'index-close';
    } catch (e) { console.error('[candle-spread] EOD settlement quote failed:', e && e.message); }
    if (settle == null) {   // fallback: newest 15m candle close
      try {
        const analysis = await withTimeout(DEPS.analyzeCandles(symbol, { timeframe: '15m' }), 20000, '15m candle fetch');
        const candles = analysis?.candleData?.['15m']?.candles || [];
        if (candles.length && candles[0].close != null) { settle = Number(candles[0].close); settleSource = '15m-candle-fallback'; }
      } catch (e) { console.error('[candle-spread] EOD candle fetch failed:', e && e.message); }
    }

    // ── RECORD THE CLOSE BEFORE ANYTHING CAN FAIL ────────────────────────────────────────────────────
    // RECORDING AND ACTING ARE DIFFERENT DECISIONS, and LAST_ACTION_MIN was making both. The engine stops
    // TRADING at 15:55, which is right — but it also stopped WRITING there, so the record's last known
    // price was the 15:55 sample and the 16:00 close entered the record only as a side-effect of the
    // settlement job computing terminal P&L. When that job failed on 2026-09-24/25 the close went with
    // it, and every consumer fell back to a price 12-19 points stale (worth $1,316 of terminal on one
    // variant). The close is a FACT ABOUT THE SESSION; it should not be hostage to a computation.
    //
    // So it is written first, per run, in its own guard: a cheap append that cannot be taken down by
    // anything the settlement loop does afterwards. state.sessionClose is what consumers read when there
    // is no settlement event, in preference to lastUnderlying.
    if (settle != null && settle > 0) {
      for (const run of runs) {
        try {
          const cfg0 = { ...run, expiration: run.expiration || todayEST() };
          const rec0 = initRunSafe(cfg0, todayEST(), 'session close');
          if (!rec0 || rec0.state.sessionClose != null) continue;
          rec0.state.sessionClose = settle;
          rec0.state.sessionCloseSource = settleSource || 'index-close';
          store.appendEvent(rec0, { type: 'session_close', variant: run.variant, close: settle,
            source: settleSource || 'index-close',
            note: 'the official close, recorded independently of settlement so a failed terminal '
              + 'computation cannot cost the record its closing price' });
        } catch (e) { console.error(`[candle-spread] session close write failed for ${run.variant}:`, e && e.message); }
      }
    }

    for (const run of runs) {
     // ONE VARIANT MUST NOT BE ABLE TO COST THE OTHER 79 THEIR SETTLEMENT. This loop had no per-run guard,
     // so a throw anywhere inside it — in computeTerminalPnl, in a write, in the summary — aborted the
     // whole pass and left EVERY run unsettled. That is one of the two shapes that could have produced
     // 2026-09-24/25 (the other was a missed timer, now covered by the window above); neither is
     // distinguishable from the record, which is itself the problem this fixes.
     try {
      const cfg = { ...run, expiration: run.expiration || todayEST() };
      const record = initRunSafe(cfg, todayEST(), 'EOD settlement');
      if (!record) continue;
      // IDEMPOTENT, so the 16:00-16:30 window can retry freely and a manual backfill cannot double-book.
      if ((record.events || []).some((e) => e.type === 'eod_settlement')) continue;
      let px = settle, pxSource = settleSource;
      if (px == null) {
        // SETTLE ON THE PRICING INSTRUMENT OR NOT AT ALL. The comment here has always said "NOT
        // candle.close (the NQ signal instrument, ~54 pts off)" — and the last clause did exactly that,
        // reading lastCC.candle.close whenever the stored underlying was missing. `candle` is the /NQ bar
        // the SIGNAL is computed from; NDX is what the options settle against. A terminal P&L struck 54
        // points off is not a slightly worse estimate of the day, it is a different day, and it was tagged
        // 'run-underlying' either way so nothing downstream could tell. See feedback_nq_signals_ndx_pricing.
        //
        // Every fallback below is an NDX price. `priceCandle` is the pricing instrument's own OHLC bar,
        // stamped on candle_close since 2026-09-23; older records simply do not have it, and then there is
        // nothing left to settle on — which is the honest answer, not a reason to reach for the NQ bar.
        // A RECORDED CLOSE BEATS THE 15:55 SAMPLE. Written above, and by a previous pass on a retry.
        if (record.state && record.state.sessionClose != null) {
          px = Number(record.state.sessionClose); pxSource = record.state.sessionCloseSource || 'session-close';
        }
        if (px == null && record.state && record.state.lastUnderlying != null) {
          px = Number(record.state.lastUnderlying); pxSource = 'run-underlying';
        }
        if (px == null) {
          const withU = [...record.events].reverse().find((ev) => ev.type === 'candle_close' && ev.underlying != null);
          if (withU) { px = Number(withU.underlying); pxSource = 'candle-underlying'; }
        }
        if (px == null) {
          const withP = [...record.events].reverse().find((ev) => ev.type === 'candle_close' && ev.priceCandle && ev.priceCandle.close != null);
          if (withP) { px = Number(withP.priceCandle.close); pxSource = 'price-candle-close'; }
        }
      }
      if (px == null || !(px > 0)) {
        store.appendEvent(record, { type: 'eod_settlement', variant: run.variant,
          note: 'no settle price available on the PRICING instrument — refusing to settle on the signal instrument' });
        continue;
      }
      // BOOK THE BROKER'S LAST FILLS FIRST. The sub-bar worker stops at 15:55 and no tick runs after it, so a
      // cover (or open, or hedge) that Schwab filled between 15:55 and 16:00 sat on its order row unbooked
      // and the day settled as if it had not happened — the terminal P&L of a real position, wrong. The
      // poller keeps reading fills through the close; this consumes them, once, before the book is valued.
      if (fillSourceFor(run) === 'broker') {
        const lastFills = [];
        try { trader.applyBrokerFills(record.state, cfg, { fillSource: 'broker' }, lastFills); }
        catch (e) { console.error(`[candle-spread] eod broker fills (${run.variant}):`, e && e.message); }
        if (lastFills.length) {
          store.appendEvent(record, { type: 'eod_broker_fills', decisions: lastFills,
            note: `${lastFills.length} broker fill decision(s) booked at the close, before settlement` });
        }
      }
      const term = trader.computeTerminalPnl(record.state, cfg, px, record.events);
      store.appendEvent(record, {
        type: 'eod_settlement', variant: run.variant, settle: px, settleSource: pxSource || 'unknown',
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
     } catch (e) {
      // SAY IT IN THE RECORD, not only in a log nobody can reach from a phone. A settlement that failed
      // silently is indistinguishable from one that never ran, and that ambiguity cost two sessions.
      console.error(`[candle-spread] EOD settlement FAILED for ${run.variant}:`, e && e.message);
      try {
        const rec = store.initRun({ ...run, expiration: run.expiration || todayEST() }, todayEST());
        store.appendEvent(rec, { type: 'eod_settlement_error', variant: run.variant,
          error: (e && e.message) || String(e),
          note: 'this run did NOT settle; the others were unaffected. Retried on every boundary to 16:30.' });
      } catch (e2) { /* the record itself is unreachable; the console line above is all there is */ }
     }
    }
  }
}


// ── REHYDRATE THE DAY'S BOOK FROM OFF-INSTANCE STORAGE ──────────────────────────────────────────────
//
// /var/optioncalc-data survives an in-place restart but NOT instance replacement: a fresh EBS volume means
// ensureDir() creates an empty store and the day's book is gone. Seen 2026-09-01, and again 2026-09-29 at
// 20:11 ET (store `files: 0` on a disk 37% full — a new volume, not a deletion). Harmless while everything
// is simulated; with real money the engine would reboot blind while real positions sat at the broker.
//
// IT RUNS IN THE APP, NOT A DEPLOY HOOK. See the note in .ebextensions/persistence.config: a hook runs as a
// user that may create files in the 1777 store directory but cannot overwrite a record the app owns, which
// is exactly how the 2026-09-17 store repair failed EACCES. Here the identity is right by construction.
//
// IT NEVER OVERWRITES A LOCAL RECORD. If the instance still holds today's book, that copy is the live one
// and S3 is behind it by at most one write. Only a genuinely absent file is filled in — the
// instance-replacement case and nothing else.
//
// THE TICK WAITS FOR IT. store.js is synchronous and initRun creates an empty record when the file is
// missing, so a tick landing mid-restore would manufacture exactly the blank book this exists to prevent.
// start() cannot be made async without changing its contract, so the promise is published here and every
// path that opens a record awaits it first. Awaiting a settled promise costs nothing, so this stays in place
// for the life of the process rather than being a startup-only special case.
let _rehydrated = null;
async function rehydrateRuns() {
  const A = require('./run-archive');
  const dir = store.RUNS_DIR;
  if (!A.enabled()) {
    console.log(`[candle-spread] run archive OFF (${A.health().disabledReason}) — local disk only; `
      + 'an instance replacement WILL lose the day. Set CANDLE_SPREAD_S3_BUCKET to enable.');
    return { enabled: false, reason: A.health().disabledReason };
  }
  // WRITE TEST FIRST. Reading proves nothing about the thing we depend on. If this fails the archive is
  // decorative, and saying so loudly at boot is the difference between finding out now and finding out from
  // a lost book.
  const st = await A.selfTest();
  if (st.ok) {
    console.log(`[candle-spread] run archive WRITABLE — s3://${A.BUCKET}/${A.PREFIX} verified by write+read-back.`);
  } else {
    console.error(`[candle-spread] run archive NOT WRITABLE (${st.stage || 'disabled'}): ${st.error || st.reason}`);
    console.error(`  the bucket is configured but this instance cannot store records in it. The day's book is`);
    console.error(`  NOT protected. Check the instance profile allows s3:PutObject+GetObject on`);
    console.error(`  arn:aws:s3:::${A.BUCKET}/${A.PREFIX}/* and s3:ListBucket on arn:aws:s3:::${A.BUCKET}.`);
  }
  const today = todayEST();
  const r = await A.restoreDay(today, dir);
  if (r.error) {
    console.error(`[candle-spread] run archive RESTORE FAILED for ${today}: ${r.error}`);
    console.error('  continuing on local disk. If this instance was just replaced, the day starts EMPTY.');
  } else if (r.restored) {
    console.log(`[candle-spread] run archive RESTORED ${r.restored} record(s) for ${today} from `
      + `s3://${A.BUCKET}/${A.PREFIX} (${Math.round(r.bytes / 1e5) / 10} MB; ${r.skippedPresent} already on disk, `
      + `${r.failed} failed) — the day's book survived an instance change.`);
  } else {
    console.log(`[candle-spread] run archive OK — nothing to restore for ${today} `
      + `(${r.skippedPresent} record(s) already on disk, ${r.listed} in the bucket).`);
  }
  // SWEEP AppleDouble JUNK. The 2026-09-30 seed bundle was built with macOS tar without COPYFILE_DISABLE, so
  // it carried a `._<name>` sidecar for every record and 1,127 of them extracted into this store. They are
  // inert now that listRunFiles matches the runId shape, but they are also 1,127 files nobody wants, and
  // there is no ssh into this box — so the app removes its own litter, exactly as the store repair does.
  //
  // Deliberately narrow: ONLY the unambiguous `._` AppleDouble pattern. A general "delete anything that does
  // not parse" sweep would be a loaded gun pointed at a real record the day a naming convention changes.
  try {
    // Required locally: this module does not import fs/path at the top level, and reaching for them as if it
    // did would throw ReferenceError straight into the catch below — a sweep that silently never runs. Same
    // shape as `initRunSafe is not defined`, which node --check also accepted.
    const fs = require('fs');
    const path = require('path');
    const junk = fs.readdirSync(dir).filter((f) => /^\._/.test(f) && f.endsWith('.json'));
    if (junk.length) {
      let gone = 0;
      for (const f of junk) { try { fs.rmSync(path.join(dir, f), { force: true }); gone++; } catch (_) { /* skip */ } }
      console.log(`[candle-spread] removed ${gone} AppleDouble sidecar file(s) from the run store `
        + '(macOS tar litter from the seed bundle; harmless but not ours)');
    }
  } catch (e) { console.error('[candle-spread] sidecar sweep:', e && e.message); }

  // A SEED BUNDLE SHIPPED IN THE DEPLOY, if this artifact carries one. Behind the engine: it unpacks up to
  // ~1 GB and uploads it, which has no business in front of the first tick. One-shot per bundle, never
  // overwrites, and it is how the archive gets its history without anyone creating an AWS access key —
  // the instance already has the write permission it needs. See seed-bundle.js.
  require('./seed-bundle').seedFromBundle({ runsDir: dir, archive: A, log: (m) => console.log(m) })
    .catch((e) => console.error('[candle-spread] seed bundle:', e && e.message));

  // HISTORY IS FOR THE UI AND MUST NEVER DELAY TRADING. Today's book is the correctness-critical part and is
  // awaited above; older days only populate the compare and debug pages, so they stream in behind the engine.
  const days = Number(process.env.CANDLE_SPREAD_S3_RESTORE_DAYS || 0);
  if (days > 0) restoreHistory(days, dir).catch((e) => console.error('[candle-spread] history restore:', e && e.message));
  return r;
}

// Fill in the last N trade dates behind the engine, newest first, so the served history comes back without
// any of it sitting in front of the first tick.
async function restoreHistory(days, dir) {
  const A = require('./run-archive');
  const l = await A.listRuns();
  if (!l.ok) { console.error(`[candle-spread] history restore: cannot list (${l.error || l.reason})`); return; }
  const dates = [...new Set(l.ids.map((id) => A.tradeDateOf(id)).filter(Boolean))].sort().reverse().slice(0, days);
  let total = 0;
  for (const d of dates) {
    if (d === todayEST()) continue;                     // already done, and awaited
    const r = await A.restoreDay(d, dir);
    total += r.restored;
  }
  if (total) console.log(`[candle-spread] run archive restored ${total} historical record(s) across ${dates.length} day(s).`);
}

// Every entry point that opens a record funnels through this.
function archiveReady() { return _rehydrated || Promise.resolve(null); }

function scheduleNext() {
  const delay = msToNextBoundary() + 5000; // fire 5s after the boundary
  schedTimer = setTimeout(async () => {
    // WAIT FOR THE BOOK. A tick that runs while the restore is in flight would call initRun on a missing
    // file and write a brand-new empty record — manufacturing the blank book the restore exists to prevent,
    // and sealing today's config against a record that describes nothing.
    try { await archiveReady(); } catch (_) { /* rehydrateRuns already logged; local disk is the fallback */ }
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


// BACKFILL A SESSION THAT ENDED WITHOUT SETTLING. Runs once at startup.
//
// The 16:00-16:30 window fixes the FUTURE; it cannot reach a day already past, because the scheduler only
// ever settles todayEST(). 2026-09-24 and 09-25 both closed with a full 77 candles and no eod_settlement,
// and the only people who could have run a recovery script were nowhere near a terminal. So the engine
// repairs its own history on boot.
//
// IT SETTLES ON THE REAL CLOSE. The first version reached straight for the record's own 15:55 underlying,
// reasoning that the official close was unrecoverable once the day had passed: the LIVE quote answers
// about today, so asking it tomorrow would be a fabrication. That was true of the QUOTE and false of the
// INSTRUMENT — the DAILY price-history bar carries the same official close durably. Verified against
// 2026-09-23, which settled live at 30470.2928 from `index-close`: the daily bar returns 30470.2928,
// diff 0.0000.
//
// The distinction is worth real money. On the two days this was written to recover, the 15:55 underlying
// was 15 and 23 points from the close, and a 1m bar's close is ~9 points off — on a 10-wide spread that is
// a whole width, the difference between a position settling in the money and out of it.
//
// lastUnderlying stays the fallback for a date the daily series cannot reach (today's bar may not have
// posted yet), tagged `backfill-run-underlying` so an approximation can never be mistaken for an index
// close. See feedback_use_real_numbers_not_derived.
//
// Bounded to the last 10 sessions so a long outage cannot turn a boot into a batch job.
async function backfillMissedSettlements() {
  let done = 0, failed = 0, approx = 0;
  try {
    const today = todayEST();
    const nowET = etParts();
    // Past the close plus the same grace the completeness check uses, so a boot at 16:02 does not race a
    // settlement pass that is still legitimately in flight.
    const pastClose = (nowET.hour * 60 + nowET.minute) >= EOD_MIN + 5;
    const byVariant = new Map(RUNS.map((r) => [r.variant, r]));
    const files = store.listRunFiles().slice(-10 * Math.max(1, RUNS.length));
    for (const f of files) {
      const runId = String(f).replace(/\.json$/, '');
      const rec = store.readRun(runId);
      if (!rec || !rec.state || !rec.tradeDate || rec.tradeDate > today) continue;        // a future date is not ours
      // TODAY COUNTS TOO, once the session is over. This skipped today's date outright on the reasoning
      // that the scheduler owns it — but the scheduler owns the 16:00-16:30 WINDOW, and a boot at 20:00
      // is long past that. Skipping meant a session whose settlement pass had already failed stayed
      // unsettled until some boot on a later day, for no reason: the market is shut and the close is a
      // known number. Only a session that might STILL BE RUNNING is left alone.
      if (rec.tradeDate === today && !pastClose) continue;
      const ev = rec.events || [];
      // A PROVISIONAL SETTLEMENT IS NOT A FINISHED ONE. A day recovered before its daily bar posted is
      // priced on the 15:55 underlying, and plain idempotency would freeze that approximation forever —
      // measured at $1,316 of terminal P&L on v7-10 for 2026-09-24 alone. So a settlement tagged
      // `backfill-run-underlying` stays eligible for ONE upgrade, and only to the real close: readers take
      // the LAST eod_settlement, so appending the corrected one supersedes it without rewriting history.
      const prior = [...ev].reverse().find((e) => e.type === 'eod_settlement');
      const provisional = !!(prior && prior.settleSource === 'backfill-run-underlying');
      if (prior && !provisional) continue;                                                // properly settled already
      const cc = ev.filter((e) => e.type === 'candle_close');
      const last = cc[cc.length - 1];
      const hm = last && last.candle && /(\d\d):(\d\d)$/.exec(String(last.candle.time));
      if (!hm || (+hm[1] * 60 + +hm[2]) < LAST_ACTION_MIN) continue;                      // never reached the close
      const run = byVariant.get((rec.config || {}).variant);
      if (!run) continue;                                                                 // not on the current roster
      // THE OFFICIAL CLOSE FIRST; the run's own last underlying only if that cannot be had.
      let px = null, pxSource = null;
      try {
        const sym = (rec.config || {}).symbol || 'NDX';
        // 1) THE DAILY BAR — durable and exact for any past date.
        let real = DEPS.getSettlementPriceFor ? await DEPS.getSettlementPriceFor(sym, rec.tradeDate) : null;
        let src = 'index-close-daily';
        // 2) THE LIVE QUOTE — for the session that has not posted a daily bar yet, which is the one that
        // just ended. With the market shut, $NDX lastPrice IS that session's official close: measured
        // 30608.1343 for 2026-09-25 while its daily bar did not yet exist. There is no reason to record a
        // provisional price when the accurate one is a quote away, and the index page was showing exactly
        // this number while the engine was about to write the 15:55 sample instead.
        if (!(real > 0) && rec.tradeDate === today && pastClose && DEPS.getSettlementPrice) {
          real = await DEPS.getSettlementPrice(sym);
          src = 'index-close-quote';
        }
        if (real > 0) {
          px = real; pxSource = src;
          // The close is a fact about the session, so record it as one even here — a later reader gets it
          // without having to trust or re-derive the settlement.
          if (rec.state.sessionClose == null) { rec.state.sessionClose = real; rec.state.sessionCloseSource = src; }
        }
      } catch (e) { /* fall through to the measured underlying */ }
      // Re-settling a provisional record is worth it ONLY for the real close; re-writing the same
      // approximation would add an event and change nothing.
      if (provisional && !(pxSource === 'index-close-daily' || pxSource === 'index-close-quote')) continue;
      if (px == null && rec.state.lastUnderlying != null) {
        px = Number(rec.state.lastUnderlying); pxSource = 'backfill-run-underlying'; approx++;
      }
      if (!(px > 0)) continue;                                                            // nothing honest to settle on
      try {
        const cfg = { ...rec.config, expiration: (rec.config || {}).expiration || rec.tradeDate };
        const term = trader.computeTerminalPnl(rec.state, cfg, px, rec.events);
        store.appendEvent(rec, { type: 'eod_settlement', variant: run.variant, settle: px,
          settleSource: pxSource, backfilledAt: new Date().toISOString(),
          terminalPnl: term.total, floorPnl: term.floor, positions: term.positions,
          supersedes: provisional ? (prior.settle != null ? prior.settle : null) : undefined,
          note: (provisional ? 'RE-settled on BOOT at the official close, replacing a provisional settlement '
                  + 'priced off the 15:55 underlying. ' : 'settled on BOOT because the 16:00 pass did not run for this session. ')
            + (pxSource === 'index-close-daily' || pxSource === 'index-close-quote'
              ? `Priced at the OFFICIAL index close (${pxSource === 'index-close-quote' ? 'live quote, market shut' : 'daily bar'}) `
                + '— the same number the live pass would have used.'
              : "Priced at the run's own last NDX underlying (15:55) because the daily bar could not be "
                + 'reached; that is a few points off the official close.') });
        try {
          const ds = summary.buildDaySummary(rec);
          store.appendEvent(rec, { type: 'eod_summary', variant: run.variant, summary: ds });
        } catch (e) { /* the settlement is what matters; the summary is a convenience */ }
        done++;
      } catch (e) { failed++; console.error(`[candle-spread] backfill failed for ${runId}:`, e && e.message); }
    }
  } catch (e) { console.error('[candle-spread] backfill scan failed:', e && e.message); }
  if (done || failed) console.log(`[candle-spread] BACKFILL: settled ${done} missed session-run(s)`
    + `${approx ? `, ${approx} on the 15:55 underlying rather than the official close` : ''}`
    + `${failed ? `, ${failed} failed` : ''}.`);
  return { done, failed, approx };
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
  // SEED THE CONTROL BASELINE IMMEDIATELY. The order poll refreshes it every 20s, but /status and /control can
  // be read inside that first window, and an unseeded baseline reports an env-armed variant as simulating —
  // which is the exact wrong answer on the page whose job is to say what the engine is doing.
  SC.seedBaseline(rosterBaseline());
  // WHO DECIDES A FILL, stated once at boot now that DEPS exists and the value is knowable. Derived, so
  // there is nothing to set and nothing to forget — but it decides whether the book is the broker's record
  // or our own reading of the chain, which is too important to be visible only via /status.
  {
    const src = fillSourceFor(RUNS.find((r) => r.variant === ARMED_VARIANT) || {});
    const realRuns = RUNS.filter((r) => r.dryRun === false).map((r) => r.variant);
    console.log(`[candle-spread] FILL SOURCE: ${src}`
      + (src === 'broker'
        ? ` — the BROKER's reported fills book the book (${realRuns.join(',') || 'none'}); our marks no longer decide`
        : ' — our own chain marks decide fills, which is correct while no order can really fill')
      + (realRuns.length && src !== 'broker'
        ? ` !! ${realRuns.join(',')} can send fillable orders but is booking off MARKS — this is the 2026-09-25 phantom-book shape`
        : ''));
  }
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
  // Kick the rehydrate off now and publish the promise; scheduleNext's handler awaits it, so the first tick
  // cannot create an empty record over a book that is still on its way back from S3.
  _rehydrated = rehydrateRuns().catch((e) => {
    console.error('[candle-spread] run archive rehydrate failed (continuing on local disk):', e && e.message);
    return { enabled: false, error: (e && e.message) || String(e) };
  });
  scheduleNext();
  // Repair any session that ended without settling before scheduling anything new (see the function).
  archiveReady().then(() => backfillMissedSettlements())
    .catch((e) => console.error('[candle-spread] backfill:', e && e.message));
  // Poll outstanding real orders on a fixed interval (real fill tracking + test/stale cancels).
  // Harmless when disarmed/dry-run: runOrderPoll early-returns and there are no liveOrders.
  orderPollTimer = setInterval(() => { archiveReady().then(() => runOrderPoll()).catch(e => console.error('[candle-spread] poll:', e && e.message)); }, ORDER_POLL_MS);
  if (orderPollTimer.unref) orderPollTimer.unref();
  // Sub-bar pass over resting opens and covers. Inert outside RTH and on any pass with nothing working.
  workTimer = setInterval(() => { archiveReady().then(() => runRestingWork()).catch(e => console.error('[candle-spread] resting work:', e && e.message)); }, WORK_MS);
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
  // EVERY EVENT THAT CARRIES DECISIONS, not just candle_close. A RESTING COVER USUALLY FILLS BETWEEN BARS:
  // on prod v7-10 2026-10-01, 20 of 31 cover-fills landed in `resting_work` and only 11 at a candle close,
  // so this reported coverFills: 11 against covered: 31 and looked like a 66% cover failure. It was a
  // counting bug — the filter predates the sub-bar worker emitting decisions, and the worker was dead from
  // 2026-09-23 until the initRunSafe fix, so nothing contradicted it.
  //
  // Filter on the DECISION, never on the event that happens to carry it; a sub-bar fill is the same fill.
  for (const ev of (rec.events || [])) {
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
// ── THE CONTROL WRITE PATH, AND ITS AUTHENTICATION ──────────────────────────────────────────────────
//
// This is the FIRST authenticated surface on this server. Everything else is either public (status, runs) or
// dev-only via requireDevMode, which BLOCKS in prod rather than authenticating. So the bar here is not "match
// the existing pattern" — there isn't one — and the thing being guarded can change what trades with real money.
//
// THE TOKEN LIVES IN A HEADER, NEVER A URL. Query strings land in CloudFront logs, access logs, browser history
// and Referer headers; a bearer credential in one is a credential published.
//
// NO TOKEN CONFIGURED MEANS THE ENDPOINT IS OFF, not open. There is deliberately no default and no fallback:
// a default secret on a server that can place real orders is worse than no endpoint at all.
//
// COMPARISON IS CONSTANT-TIME. A byte-by-byte early return leaks the token's prefix to anyone who can measure
// response latency, and this one guards real money.
const CONTROL_TOKEN = process.env.CANDLE_SPREAD_CONTROL_TOKEN || null;

// THE ROSTER, WHETHER OR NOT start() HAS RUN. RUNS is populated by start(), so a handler that validated against
// it directly rejected every variant as "not on the roster" before startup — which in production is masked
// because start() always has run, and which therefore meant the roster check was never actually exercised by a
// test. The roster is deterministic, so building it on demand is the same answer; memoised because buildRuns
// walks and logs the whole fleet.
// variant -> the mode the ROSTER gives it (from run.dryRun), which is what applies when the control file is
// silent. Rebuilt each call from RUNS so a re-arm is reflected without a restart; cheap, it is a map over 80.
function rosterBaseline() {
  const out = {};
  const runs = (RUNS && RUNS.length) ? RUNS : buildRuns();
  for (const r of runs) out[r.variant] = SC.modeFromDryRun(r.dryRun);
  return out;
}

let _rosterFallback = null;
function rosterVariants() {
  if (RUNS && RUNS.length) return RUNS.map((r) => r.variant);
  if (!_rosterFallback) _rosterFallback = buildRuns().map((r) => r.variant);
  return _rosterFallback;
}

function controlAuthOk(req) {
  if (!CONTROL_TOKEN) return { ok: false, status: 503, error: 'control API is disabled (CANDLE_SPREAD_CONTROL_TOKEN is not set)' };
  // HEADER OR BODY, NEVER A QUERY STRING.
  //
  // The header is the better channel and is tried first. The body is the fallback because CloudFront forwards a
  // POST body unconditionally while forwarding a CUSTOM HEADER is a separate setting that is off by default —
  // so a header-only design can be unreachable through the CDN for a reason that has nothing to do with this
  // code. Measured 2026-10-01: POST already passes through, header forwarding unverified.
  //
  // A body is NOT the same risk as a query string, which is the thing actually worth avoiding: query strings
  // land in CloudFront access logs, origin access logs, browser history and Referer headers. A POST body
  // appears in none of those, and this server's request logger prints only `${method} ${path}` — no bodies, no
  // headers — which was checked rather than assumed.
  const given = req.get('x-control-token') || (req.body && req.body.token) || '';
  const crypto = require('crypto');
  const a = Buffer.from(String(given));
  const b = Buffer.from(CONTROL_TOKEN);
  // timingSafeEqual throws on a length mismatch, which would itself leak the length — so compare fixed-size
  // digests instead of the raw bytes.
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  if (!crypto.timingSafeEqual(ha, hb)) return { ok: false, status: 401, error: 'bad or missing x-control-token' };
  return { ok: true };
}

/**
 * Handle a control write. Returns { status, body } for the route to send; does not touch res, so it stays
 * testable without an HTTP server.
 */
async function handleControlWrite(req) {
  const auth = controlAuthOk(req);
  if (!auth.ok) {
    // Log the attempt but never the token, and never echo what was sent back to the caller.
    console.warn(`[candle-spread] control write REFUSED (${auth.error})`);
    return { status: auth.status, body: { ok: false, error: auth.error } };
  }
  const patch = req.body || {};
  const r = await SC.applyPatch(patch, {
    knownVariants: rosterVariants(),
    liveAllowed: LIVE_ARMED,
    log: (m) => console.log(m), warn: (m) => console.warn(m),
  });
  if (!r.ok) return { status: r.status || 400, body: { ok: false, error: r.error,
    unknownVariants: r.unknownVariants, rejected: r.rejected } };
  console.log(`[candle-spread] control WRITTEN by ${r.wrote.updatedBy}: `
    + (Object.entries(r.wrote.variants).map(([k, v]) => `${k}=${v.mode}${v.restrict ? '/' + v.restrict : ''}`).join(' ') || '(all simulate)'));
  return { status: 200, body: { ok: true, state: r.state } };
}

// ── ONE-WORD PRESETS, FOR WHEN YOU ARE NOT AT A COMPUTER ────────────────────────────────────────────
//
// The full API takes { variant, mode, restrict, note, until }, which is right for setting up a day and wrong
// for stopping one. Stopping needs to be a single action from a phone, so these are named states applied to the
// ARMED variant by default:
//
//   POST /api/v1/candle-spread/control/halt       stop sending anything (cancels still allowed)
//   POST /api/v1/candle-spread/control/wind-down  finish the covers, open nothing new
//   POST /api/v1/candle-spread/control/live       real fillable orders (needs CANDLE_SPREAD_LIVE too)
//   POST /api/v1/candle-spread/control/paper      real orders at unfillable prices
//   POST /api/v1/candle-spread/control/off        force simulation, overriding an env arming
//   POST /api/v1/candle-spread/control/clear      drop the override; whatever the environment says applies
//
// URL plus one header, no body — which is what makes it one tap from an iOS Shortcut. POST, never GET: a GET
// that mutates can be fired by a link preview, a prefetcher or a crawler, and this one can stop trading.
//
// THIS DOES NOT SCALE PAST ONE OR TWO ARMED VARIANTS and is not meant to. `?variant=` names one explicitly;
// beyond that, use the full API or edit the file.
//
// halt and wind-down PRESERVE THE CURRENT MODE rather than forcing one. Halting a paper variant should leave it
// paper — if halt implied live, resuming would silently promote it, and the resume is exactly the moment nobody
// is reading carefully.
// `off` WRITES simulate; `clear` REMOVES the entry. They are not the same thing and conflating them made `off`
// a lie on an env-armed variant: removing the control entry reverts to the ROSTER, so v7-10 would have gone
// back to paper — still trading — under a button labelled off. The control file can override the roster
// downward, so `off` does that explicitly and means what it says. `clear` is the separate, honest action for
// "stop overriding, whatever the environment decides is fine".
const CONTROL_PRESETS = {
  live:         { mode: 'live', restrict: null },
  paper:        { mode: 'paper', restrict: null },
  simulate:     { mode: 'simulate', restrict: null },
  off:          { mode: 'simulate', restrict: null },
  clear:        { remove: true },
  'wind-down':  { restrict: 'no-open', keepMode: true },
  'no-open':    { restrict: 'no-open', keepMode: true },
  halt:         { restrict: 'halt', keepMode: true },
  resume:       { restrict: null, keepMode: true },
};

async function handleControlPreset(req) {
  const auth = controlAuthOk(req);
  if (!auth.ok) {
    console.warn(`[candle-spread] control preset REFUSED (${auth.error})`);
    return { status: auth.status, body: { ok: false, error: auth.error } };
  }
  const name = String((req.params && req.params.preset) || (req.body && req.body.mode) || '').toLowerCase();
  const preset = CONTROL_PRESETS[name];
  if (!preset) {
    return { status: 400, body: { ok: false, error: `unknown preset ${JSON.stringify(name)}`,
      presets: Object.keys(CONTROL_PRESETS) } };
  }
  const variant = (req.query && req.query.variant) || (req.body && req.body.variant) || ARMED_VARIANT;
  if (!rosterVariants().includes(variant)) {
    return { status: 400, body: { ok: false, error: `${variant} is not on the roster` } };
  }
  // keepMode reads what is in force now, so halting does not change what the variant IS.
  // Seed the baseline first: a preset can arrive before the first poll has run, and keepMode must not read a
  // missing baseline as 'simulate' and demote an env-armed variant.
  SC.refresh({ knownVariants: rosterVariants(), liveAllowed: LIVE_ARMED, baseline: rosterBaseline(),
    log: () => {}, warn: () => {} }).catch(() => { /* the baseline is set synchronously regardless */ });
  const cur = SC.forVariant(variant);
  const patch = preset.remove
    ? { variant, remove: true }
    : { variant, mode: preset.keepMode ? (cur.requestedMode || cur.mode || 'simulate') : preset.mode,
        restrict: preset.restrict || undefined,
        note: (req.query && req.query.note) || (req.body && req.body.note) || `preset:${name}`,
        until: (req.query && req.query.until) || (req.body && req.body.until) || undefined };
  patch.by = (req.body && req.body.by) || (req.query && req.query.by) || 'preset-api';

  const r = await SC.applyPatch(patch, { knownVariants: rosterVariants(), liveAllowed: LIVE_ARMED,
    log: (m) => console.log(m), warn: (m) => console.warn(m) });
  if (!r.ok) return { status: r.status || 400, body: { ok: false, error: r.error } };
  const now = SC.forVariant(variant);
  console.log(`[candle-spread] control PRESET ${name} applied to ${variant} -> `
    + `mode=${now.mode}${now.restrict ? ' restrict=' + now.restrict : ''}`);
  // Echo the EFFECTIVE result in one line, because the caller is on a phone and will not read a JSON tree.
  return { status: 200, body: { ok: true, variant, preset: name,
    effective: `${now.mode}${now.restrict ? '/' + now.restrict : ''}`,
    requested: now.requestedMode || now.mode,
    downgraded: (r.state.downgraded || []).length > 0 || undefined,
    state: r.state } };
}

/**
 * Read-only view, for symmetry with the write path. Same data /status already exposes.
 *
 * Seeds the baseline if it is somehow still empty, so this cannot answer "everything is simulating" merely
 * because it was asked before the first refresh.
 */
function controlState() {
  if (!SC.hasBaseline()) SC.seedBaseline(rosterBaseline());
  return SC.health();
}

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
    armedSelectionValid: RUNS.some(r => r.variant === ARMED_VARIANT),
    // REMOTE CONTROL. Shown under gates because it is one: the control file can restrict any variant, and a
    // `halt` nobody remembers setting looks exactly like a broken engine unless it is visible here.
    strategyControl: SC.health(),
    // WHO DECIDES A FILL, for the armed variant specifically — it is derived per run (see fillSourceFor),
    // so there is no global value to report. 'mark' means the engine's own read of the chain, which is
    // correct for a simulated or test run and a phantom for one whose orders can really fill.
    fillSource: fillSourceFor(RUNS.find((r) => r.variant === ARMED_VARIANT) || {})
  };
  // EFFECTIVE, NOT ROSTER. This headline is the first thing an operator reads, so it has to say what the
  // engine will actually DO. Pre-ebdde67 it reported the roster, which is how prod came to display
  // "LIVE-ARMED (real orders: v7-10)" while the control file held v7-10 at paper — the same roster-vs-file
  // confusion as the sender bug, and in the one field most likely to be trusted at a glance.
  const liveV = RUNS.filter(r => effectiveDryRun(r) === false).map(r => r.variant);
  const testV = RUNS.filter(r => effectiveDryRun(r) === 'test').map(r => r.variant);
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
      // The mode that APPLIES, after any control-file lowering; rosterMode is what the environment granted.
      // Both, because "paper because I pressed the brake" and "paper because that is all it was armed for"
      // are different situations and the operator needs to tell them apart.
      mode: SC.modeFromDryRun(effectiveDryRun(run)) === 'paper' ? 'test' : SC.modeFromDryRun(effectiveDryRun(run)),
      rosterMode: run.dryRun === false ? 'live' : run.dryRun === 'test' ? 'test' : 'simulate',
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
      // WHAT IS THIS VARIANT ALLOWED TO DO RIGHT NOW (remote control; unlisted = simulate).
      control: (() => { const c = SC.forVariant(run.variant);
        return c.listed ? { mode: c.mode, requestedMode: c.requestedMode, restrict: c.restrict,
          note: c.note, until: c.until } : null; })(),
      // DOES THE BOOK MATCH THE BROKER? Written by the poller (see book_reconcile) and surfaced here so a
      // divergence is one HTTP call away instead of buried in EB logs — which is how 2026-09-25's fully
      // phantom book went unnoticed for two days. null means nothing to compare yet, or a mode where the
      // two are MEANT to differ (simulate / unfillable test orders).
      bookReconcile: (st && st.bookReconcile) || null,
      // And the position-level loop — what the ACCOUNT holds vs what the book believes. null until a run
      // can really hold something (see accountPositionsIfDue).
      positionReconcile: (st && st.positionReconcile) || null,
      rejectStreaks: (st && st.rejectStreaks && Object.keys(st.rejectStreaks).length) ? st.rejectStreaks : null,
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
  // The live STARTUP check, exported so a unit test runs it against the real roster: 2026-10-05 a roster
  // field the check did not know took prod down at boot while every unit suite passed.
  assertDeps,
  // The floor under every cap (1.5x one position's width) — exported so the sweep and the tests can use the
  // real rule rather than restating it. See LOSS_MAX_FLOOR_X_WIDTH.
  lossMaxFloorFor,
  LOSS_MAX_FLOOR_X_WIDTH,
  LOSS_MAX_CEILING,
  // THE PRE-TIGHTENING FLEET DEFAULT. Exported so sweep-loss-cap can use the real formula as its
  // counterfactual arm instead of inferring it from the roster — see the note on genericFor.
  maxCapFor,
  start,
  listRuns,
  getRun,
  status,
  buildRuns,
  handleControlWrite,
  handleControlPreset,
  CONTROL_PRESETS,
  controlState,
  VARIANTS,
  listVariants,
  // exported for tests
  //
  // The senders and fillSourceFor are exported so a test can prove the EFFECTIVE mode reaches the wire. That
  // cannot be shown through start(): it needs a real tradingClient and the live gates. See the control-mode
  // enforcement test — the bug it pins (senders reading the roster, ignoring a control-file lowering) was
  // invisible to every test that went through the trader, because the trader reads deps.dryRun and was right.
  makePlaceOrder,
  makeReplaceOrder,
  makeCancelOrder,
  fillSourceFor,
  effectiveDryRun,
  _setDeps: (d) => { DEPS = d; },
  _liveArmed: () => LIVE_ARMED,
  tallyRun,
  classifyBoundary,
  msToNextBoundary,
  pickJustClosed,
  DEFAULT_RUNS
};
