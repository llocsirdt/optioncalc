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
const FAMILIES = [
  { key: 'v0', label: 'classic fixed-tent', signalFn: at15(classicSignal), signalCfg: {}, coverSelector: 'fixed', coverFillModel: 'resting' },
  { key: 'v1', label: 'classic greedy',     signalFn: at15(classicSignal), signalCfg: {}, coverSelector: 'greedy', coverFillModel: 'resting' },
  { key: 'v2', label: 'classic joint',      signalFn: at15(classicSignal), signalCfg: {}, coverSelector: 'joint', coverFillModel: 'resting' },
  { key: 'v3', label: 'classic fixed-mark', signalFn: at15(classicSignal), signalCfg: {}, coverSelector: 'fixed-mark', coverFillModel: 'resting' },
  { key: 'v4', label: 'multiTF-overext', signalFn: at15(v4Signal), signalCfg: {}, ...PORTED_COVER },
  { key: 'v5', label: 'trend-flip',      signalFn: at15(v5Signal), signalCfg: {}, ...PORTED_COVER },
  // v6 is ALSO the live-pipe harness: only its $20 variant (testAtBase + width 20) sends REAL unfillable
  // test orders (dryRun:'test') + auto-cancels when armed; the $10/$40 siblings stay pure paper. INERT
  // until all three gates: isProd + CANDLE_SPREAD_LIVE=true + that dryRun:'test'.
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

// The width sweep is now uniformly SHORT-ATM (shift = W/2: short leg ≈ ATM, long leg W deeper ITM) at
// capFrac 0.8 — the geometry the user actually trades, held constant across widths so width is the only
// variable. All three land on the 10-pt strike grid (W/2 − shift = 0 → short strike = center). The
// ATM-CENTERED geometry (shift 0, legacy 0.525 cap) is measured separately via the `-ctr` comparators
// below (width 20/40 only — $10 ATM-centered is off-grid).
const WIDTHS = [
  { w: 10, shift: 5,  capFrac: 0.8 },
  { w: 20, shift: 10, capFrac: 0.8 },
  { w: 40, shift: 20, capFrac: 0.8 },
];

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
const ARMED_VARIANT = process.env.CANDLE_SPREAD_ARMED || 'v6-20';
const ARMED_MODE = process.env.CANDLE_SPREAD_ARMED_MODE === 'live' ? false : 'test';   // false = real fillable orders

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
        spreadWidth: w, spreadShift: shift,
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
        spreadWidth: w, spreadShift: shift,
        lossTarget: null, lossMax: null, floorOffset: false,   // no governor
        continuousCoverMinLockFrac: minLockFor(f.key, w),      // covering policy is NOT a risk cap — the
        // `-unc` twins isolate the CAPS, so they keep the same covering policy as their capped sibling.
        softCap: null, hardCap: null, riskCap: null,           // no legacy caps either
      };
      if (capFrac != null) v.capFrac = capFrac;
      if (f.bidirectional) v.bidirectional = true;
      if (f.exemptTrendStack) v.exemptTrendStack = true;
      if (f.proactiveCoverFrac != null) v.proactiveCoverFrac = f.proactiveCoverFrac;
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
        spreadWidth: w, spreadShift: 0,   // centered; capFrac left unset → legacy 0.525 ATM ceiling
      };
      if (f.bidirectional) v.bidirectional = true;
      if (f.exemptTrendStack) v.exemptTrendStack = true;
      if (f.proactiveCoverFrac != null) v.proactiveCoverFrac = f.proactiveCoverFrac;
      if (f.softCap != null) v.softCap = f.softCap;
      v.lossMax = maxCapFor(w);                       // same governor as the short-ATM sweep
      v.continuousCoverMinLockFrac = minLockFor(f.key, w);
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
function reportArming(list) {
  // Quiet in forked backtest workers — this line is about the LIVE order pipe and has nothing to do with a
  // backtest slice, but it fires once per worker process and buries the run's real output.
  if (process.argv.includes('--_slice')) return list;
  const hit = list.find(v => v.variant === ARMED_VARIANT);
  if (hit) console.log(`[candle-spread] ARMED SELECTION: ${ARMED_VARIANT} -> dryRun=${JSON.stringify(ARMED_MODE)} (${ARMED_MODE === false ? 'REAL FILLABLE ORDERS' : 'unfillable test orders'}); still gated by isProd + CANDLE_SPREAD_LIVE`);
  else console.log(`[candle-spread] ARMED SELECTION: "${ARMED_VARIANT}" is NOT on the roster — NOTHING is armed (all runs stay dryRun:true).`);
  return list;
}

const VARIANTS = reportArming([
  ...buildVariants(),        // v0-v9 × 10/20/40, short-ATM, governor $5k target / width-scaled max
  ...buildUncapped(),        // v0-v9 × 10/20/40, short-ATM, NO caps — the unbounded-potential metric
  ...buildAtmComparators(),  // v0-v9 × 20/40, ATM-centered, same governor
]);

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
function groupKey(run) { return `${run.symbol}|${run.expiration || todayEST()}`; }

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
  let harvestTau = 0, harvestIv = 0;
  try { harvestTau = bs.tauFromTime(candle.datetime); const c5 = A['5m']; harvestIv = bs.ivFromRelBandWidth((c5.bbupper - c5.bblower) / c5.close); } catch (e) { /* leave 0 → observer skips */ }

  // Feed every ported variant the SAME live A + underlying + chain (apples-to-apples).
  for (const run of runs) {
    try {
      const cfg = { ...run, expiration };
      delete cfg.signalFn;   // functions don't serialize; keep the persisted run config JSON-clean
      const record = store.initRun(cfg, tradeDate);
      const getLeg = trader.makeLegAccessor(chainData, expiration);
      const placeOrder = makePlaceOrder(run, record);
      await trader.processCandleClose(record, candle, null, {
        getLeg, placeOrder, dryRun: run.dryRun,
        signalFn: run.signalFn, signalCfg: run.signalCfg, bidirectional: run.bidirectional,
        // v8 risk-cap opts (undefined for other variants → cap logic inert)
        riskCap: run.riskCap, softCap: run.softCap, hardCap: run.hardCap,
        proactiveCoverFrac: run.proactiveCoverFrac, exemptTrendStack: run.exemptTrendStack,
        coverToStack: run.coverToStack, coverToStackMinFrac: run.coverToStackMinFrac,
        // CONTINUOUS COVERING (ported from the backtest 2026-09-04) — the covering POLICY, not a risk cap.
        continuousCover: run.continuousCover, continuousCoverMinLockFrac: run.continuousCoverMinLockFrac,
        // DAY-LOSS GOVERNOR — bounds the BOOK FLOOR (the day's true max loss), not at-risk debit.
        lossTarget: run.lossTarget, lossMax: run.lossMax,
        comboOrders: run.comboOrders, comboSlip: run.comboSlip,   // 4-leg atomic cover+open (default off)
        capitalRecapture: run.capitalRecapture, openAlternateEvery: run.openAlternateEvery, creditCoverFrac: run.creditCoverFrac,
        enforceLegUniqueness: run.enforceLegUniqueness, legMaxShift: run.legMaxShift, legMaxWing: run.legMaxWing,
        A, priorA, isFifteen, underlying, signalSymbol, priceSymbol
      });
      // RISK-HARVEST OBSERVER (read-only, ALL variants): does this book's risk curve go lopsided, when
      // (first time / how often), and what would the far-side hedge REALLY cost on the live chain (mid vs
      // marketable)? Records onto state — NEVER trades, never affects the strategy. Answers: how early it
      // shows up, how often, and whether NDX OTM spreads fill near mid (the slippage question). See v11 research.
      try {
        const st = record.state;
        if (harvestTau > 0 && harvestIv > 0 && st.positions && st.positions.length) {
          const obs = RH.observe(st.positions, getLeg, underlying, harvestTau, harvestIv, { bandSigmas: 2.0, minRatio: 3, trigger: -500 });
          if (obs) {
            if (!st.harvestObs) st.harvestObs = { count: 0, firstLopsidedTime: null, worstFloor: 0, samples: [] };
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
function attemptTick(kind, retriesLeft) {
  const groups = {};
  for (const run of RUNS) { (groups[groupKey(run)] = groups[groupKey(run)] || []).push(run); }
  Promise.all(Object.values(groups).map(runs => processGroup(runs, kind).catch(e => ({ error: e.message }))))
    .then(results => {
      const stillPending = results.some(r => r && r.pending);
      if (stillPending && retriesLeft > 0) {
        setTimeout(() => attemptTick(kind, retriesLeft - 1), 5000);
      }
    })
    .catch(err => console.error('[candle-spread] tick error:', err && err.message));
}

// --- Real order poller ----------------------------------------------------
// Reconciles every live/test run's outstanding Schwab orders on a fixed interval: records real
// fills, and cancels test-mode orders (after TEST_CANCEL_MS) and stale working OPENs. Inert
// unless armed + prod + a run is actually sending real orders (dryRun 'test' | false). Costs
// nothing in dry-run (no liveOrders to poll).
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
  started = true;
  scheduleNext();
  // Poll outstanding real orders on a fixed interval (real fill tracking + test/stale cancels).
  // Harmless when disarmed/dry-run: runOrderPoll early-returns and there are no liveOrders.
  orderPollTimer = setInterval(() => { runOrderPoll().catch(e => console.error('[candle-spread] poll:', e && e.message)); }, ORDER_POLL_MS);
  if (orderPollTimer.unref) orderPollTimer.unref();
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
    : testV.length ? `TEST-ARMED (unfillable paper orders: ${testV.join(',')})`
    : 'ARMED (all dry-run)';
  const tradeDate = todayEST();
  const runs = RUNS.map(run => {
    const rec = store.readRun(store.makeRunId(run.symbol, run.expiration || tradeDate, tradeDate, run.variant));
    const st = rec && rec.state;
    const lo = (st && st.liveOrders) || [];
    const t = rec ? tallyRun(rec) : { opens: 0, covers: 0, coverFills: 0, cancels: 0 };
    // TERMINAL (mark-to-market) P&L: value EVERY position (covered + uncovered) at the current NDX
    // underlying — the true P&L (what the UI shows). realizedPnl below is only the covered tents' locked
    // FLOOR (always ~positive; ignores uncovered legs), kept as the conservative lower bound.
    let terminalPnl = null;
    if (st && st.lastUnderlying != null && st.positions && st.positions.length) {
      try { terminalPnl = Math.round(trader.computeTerminalPnl(st, rec.config, st.lastUnderlying, rec.events).total); } catch (e) { /* leave null */ }
    }
    const base = backtestBaselines().variants[run.variant] || null;
    return {
      variant: run.variant, symbol: run.symbol, signalSymbol: run.signalSymbol || run.symbol,
      mode: run.dryRun === false ? 'live' : run.dryRun === 'test' ? 'test' : 'simulate',
      width: run.spreadWidth || 20, shift: run.spreadShift || 0,
      positions: st ? st.positions.length : 0,
      covered: st ? st.positions.filter(p => p.covered).length : 0,
      terminalPnl,                                    // the real P&L (mark-to-market at the NDX underlying)
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
    mode, gates, armedVariants: { live: liveV, test: testV },
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
