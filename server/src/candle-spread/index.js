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
    // expiration is set to "today" (0DTE) at start; overridden per environment if needed.
    expiration: null,
    spreadWidth: 20,
    strikeIncrement: 10,
    quantity: 1,
    tickIncrement: 0.05,       // NDX combos price in nickels; make per-run for other tickers
    coverTiming: 'on-reversal', // parked alt: 'each-candle'
    coverStyle: 'debit-offset', // parked alt: 'credit'
    dryRun: true
  }
];

// The ported SIGNAL lineage (v4-v9). Each variant is the multi-timeframe signal fn (off the live
// `A` object; see analysis-builder + signals/) plus its cfg and cadence. All share the realistic
// TENT cover: coverSelector 'fixed-mark' (mark-priced tent) + coverFillModel 'resting' (works at
// target = width−open, fills when the real mark reaches it) — matching backtest-v6-5m.runDay5m.
//   v4/v5 act on 15m closes only (at15); v6/v7 act every 5m (fiveMin).
//   v7 = v6 signal + "be wrong" bidirectional opens (opposite side while holding).
// dryRun defaults true (simulate); flip a single variant to 'test'/false to send. v8 (risk caps) and
// v9 (separate mean-reversion engine) still TODO — see [[project_candle_spread_live_order_wiring]].
const PORTED_COVER = { coverSelector: 'fixed-mark', coverFillModel: 'resting' };
const VARIANTS = [
  { variant: 'v4', variantLabel: 'multiTF-overext', signalFn: at15(v4Signal), signalCfg: {}, ...PORTED_COVER },
  { variant: 'v5', variantLabel: 'trend-flip',      signalFn: at15(v5Signal), signalCfg: {}, ...PORTED_COVER },
  { variant: 'v6', variantLabel: '5m-harness',      signalFn: v6Signal, signalCfg: { fiveMin: true }, ...PORTED_COVER },
  { variant: 'v7', variantLabel: 'be-wrong',        signalFn: v7Signal, signalCfg: { fiveMin: true, beWrong: true }, bidirectional: true, ...PORTED_COVER }
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
  try { raw1m = await DEPS.getRaw1m(signalSymbol); }
  catch (e) { console.error('[candle-spread] getRaw1m failed:', e && e.message); return { pending: 'raw1m-fetch-failed' }; }
  if (!raw1m || raw1m.length < 100) return { pending: 'raw1m-insufficient' };
  const series = ab.buildSeries(raw1m);
  const cur = ab.analysisAt(series, T);
  if (!cur.warm) return { pending: 'analysis-not-warm' };    // retry: 1m/5m/15m/60m not all warm yet
  const A = cur.A;
  // priorA = the prior 5m bar's A (null on the day's first action bar → matches runDay5m's per-day
  // reset; the signal reads prior['15m'] which correctly resolves to the prior 15m candle).
  const priorA = kind === 'first' ? null : ab.analysisAt(series, T - STEP_MS).A;

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
  const candle = { timeEST: markTimeEST, open: c5.open, high: c5.high, low: c5.low, close: c5.close };

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
        A, priorA, isFifteen, underlying, signalSymbol, priceSymbol
      });
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
    // Settle price = newest 15m candle close (~4pm print); fall back to a run's last logged close.
    let settle = null;
    try {
      const analysis = await DEPS.analyzeCandles(symbol, { timeframe: '15m' });
      const candles = analysis?.candleData?.['15m']?.candles || [];
      if (candles.length && candles[0].close != null) settle = Number(candles[0].close);
    } catch (e) { console.error('[candle-spread] EOD candle fetch failed:', e && e.message); }

    for (const run of runs) {
      const cfg = { ...run, expiration: run.expiration || todayEST() };
      const record = store.initRun(cfg, todayEST());
      let px = settle;
      if (px == null) {
        const lastCC = [...record.events].reverse().find(ev => ev.type === 'candle_close');
        px = lastCC ? Number(lastCC.candle.close) : null;
      }
      if (px == null) { store.appendEvent(record, { type: 'eod_settlement', variant: run.variant, note: 'no settle price available' }); continue; }
      const term = trader.computeTerminalPnl(record.state, cfg, px);
      store.appendEvent(record, {
        type: 'eod_settlement', variant: run.variant, settle: px,
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

module.exports = {
  start,
  listRuns,
  getRun,
  buildRuns,
  VARIANTS,
  // exported for tests
  classifyBoundary,
  msToNextBoundary,
  pickJustClosed,
  DEFAULT_RUNS
};
