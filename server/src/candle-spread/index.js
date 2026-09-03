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
    // RISK CAPS + COVER-TO-STACK as DEFAULTS for ALL strategies (2026-09-03). hardCap = ABSOLUTE at-risk
    // (uncovered-debit) ceiling in $, NOT width-scaled — a wider spread must NOT be allowed to risk more
    // (the whole point is bounding single-day risk). $20k baseline here; v6-v9 tighten to $10k (family).
    // coverToStack lets a blocked open lock a deep-ITM winner (≥ minFrac×width) to free budget then open,
    // so the tight cap doesn't just choke activity — it recycles. proactiveCoverFrac stays family-specific.
    hardCap: 20000, coverToStack: true, coverToStackMinFrac: 0.65,
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
// + risk caps; the v9-40-paper run below is a PURE-PAPER $40 cover-to-stack fill study (never sends).
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
  // All families inherit the shared $20k hard cap (BASE_RUNS); the aggressive families additionally get a
  // tighter $10k-cap A/B variant via buildLowCap() below (that's what v9-40-10k is).
  { key: 'v6', label: '5m-harness', signalFn: v6Signal, signalCfg: { fiveMin: true }, testAtBase: true, ...PORTED_COVER },
  { key: 'v7', label: 'be-wrong',   signalFn: v7Signal, signalCfg: { fiveMin: true, beWrong: true }, bidirectional: true, ...PORTED_COVER },
  // v8 = v6 signal + a soft "churn" cap on at-risk debit (exempt for a same-side trend stack) + proactive
  // deep-ITM covering, on top of the shared $20k hard backstop.
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
      if (f.hardCap != null) v.hardCap = f.hardCap;   // else inherits BASE_RUNS $20k
      if (f.testAtBase && w === 20) v.dryRun = 'test';   // only v6-20 arms the live pipe
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
      if (f.hardCap != null) v.hardCap = f.hardCap;   // else inherits BASE_RUNS $20k
      out.push(v);
    }
  }
  return out;
}

// Additional $10k-cap A/B variants for the AGGRESSIVE families (v5-v9) at the cap-meaningful widths
// ($20/$40 — a $10 spread's cheap positions barely reach even a $10k cap, so $10-10k ≈ $10-20k). Same
// short-ATM geometry as the main sweep; each `vX-W-10k` pairs against its $20k sibling `vX-W` to isolate
// the cap effect. This generator PRODUCES v9-40-10k (formerly a hand-written special). Always paper
// (no testAtBase) — only the $20k v6-20 arms the pipe.
const LOW_CAP_FAMILIES = new Set(['v5', 'v6', 'v7', 'v8', 'v9']);
const LOW_CAP = 10000;
function buildLowCap() {
  const out = [];
  const widths = WIDTHS.filter((x) => x.w === 20 || x.w === 40);
  for (const f of FAMILIES) {
    if (!LOW_CAP_FAMILIES.has(f.key)) continue;
    for (const { w, shift, capFrac } of widths) {
      const v = {
        variant: `${f.key}-${w}-10k`,
        variantLabel: `${f.label} $${w} short-ATM, $10k cap`,
        signalFn: f.signalFn, signalCfg: f.signalCfg,
        coverSelector: f.coverSelector, coverFillModel: f.coverFillModel,
        spreadWidth: w, spreadShift: shift, hardCap: LOW_CAP,
      };
      if (capFrac != null) v.capFrac = capFrac;
      if (f.bidirectional) v.bidirectional = true;
      if (f.exemptTrendStack) v.exemptTrendStack = true;
      if (f.proactiveCoverFrac != null) v.proactiveCoverFrac = f.proactiveCoverFrac;
      if (f.softCap != null) v.softCap = f.softCap;
      out.push(v);
    }
  }
  return out;
}

const VARIANTS = [
  ...buildVariants(),        // v0-v9 × 10/20/40, short-ATM, $20k default cap
  ...buildAtmComparators(),  // v0-v9 × 20/40, ATM-centered, $20k default cap
  ...buildLowCap(),          // v5-v9 × 20/40, short-ATM, $10k-cap A/B (incl. v9-40-10k)
];

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
function listRuns() { return store.listRunsSummary(); }
// date defaults to the EXPIRATION (0DTE: tradeDate == expiration), so `/runs/NDX/2026-08-18`
// with no ?date= resolves to that day's run instead of today. variant is optional.
function getRun(symbol, expiration, date, variant) {
  const tradeDate = date || expiration;
  return store.readRun(store.makeRunId(symbol, expiration, tradeDate, variant));
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
    hasAccountHash: !!(DEPS && DEPS.accountHash)
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
  // exported for tests
  classifyBoundary,
  msToNextBoundary,
  pickJustClosed,
  DEFAULT_RUNS
};
