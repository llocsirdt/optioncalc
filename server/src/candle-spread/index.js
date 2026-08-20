/**
 * Candle-spread runtime: run config, the aligned scheduler, live data glue, the
 * (dry-run) order placer, and read accessors for the API. Kept separate from the
 * paper-sim position-manager. Dependencies (candle analysis, chain fetch, trading
 * client, account hash) are injected via start() to avoid circular requires.
 */
const store = require('./store');
const trader = require('./trader');

// Base run config(s), keyed by (symbol, expiration). NDX 0DTE first. Each base run is
// fanned out into one shadow run PER VARIANT (see VARIANTS) that share the same live candle
// and chain snapshot each tick and differ ONLY in cover-selection, so they can be compared.
// dryRun=true => build + log orders but DO NOT send; assume fills so the day simulates.
const BASE_RUNS = [
  {
    symbol: 'NDX',
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

// The 3 parallel shadow strategies. coverSelector is the only behavioral difference.
//   v0 fixed  = current deployed behavior (tent cover, old cap pricing) — the baseline.
//   v1 greedy = phase-1 best-per-position candidate cover (skew-aware pricing).
//   v2 joint  = phase-2 joint basket optimization over the covering stack.
const VARIANTS = [
  { variant: 'v0', variantLabel: 'fixed-tent', coverSelector: 'fixed' },
  { variant: 'v1', variantLabel: 'greedy',     coverSelector: 'greedy' },
  { variant: 'v2', variantLabel: 'joint',      coverSelector: 'joint' }
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
const FIRST_ACTION_MIN = 9 * 60 + 45;   // 9:45 close of the first (9:30-9:45) candle
const LAST_ACTION_MIN = 15 * 60 + 45;   // 15:45 last normal action
const EOD_MIN = 16 * 60;                 // 16:00 close -> EOD placeholder

// Classify a 15-min boundary (by its ET wall-clock). Returns 'action' | 'first' | 'eod' | null.
function classifyBoundary(date) {
  const { weekday, hour, minute } = etParts(date);
  if (!RTH_WEEKDAYS.has(weekday)) return null;
  const t = hour * 60 + minute;
  if (t % 15 !== 0) return null;
  if (t === EOD_MIN) return 'eod';
  if (t === FIRST_ACTION_MIN) return 'first';
  if (t > FIRST_ACTION_MIN && t <= LAST_ACTION_MIN) return 'action';
  return null;
}

function msToNextBoundary(now = Date.now()) {
  const period = 15 * 60 * 1000;
  return Math.ceil((now + 1) / period) * period - now;
}

// The order placer.
//
// HARD SAFETY RULE: real orders are sent ONLY in production (DEPS.isProd) AND only when
// this run's dryRun flag is off. DEV MODE NEVER SENDS, regardless of dryRun — otherwise a
// local dev server running alongside the prod server would place DUPLICATE orders to
// Schwab. Anything that isn't a real send is simulated: logged and ASSUMED filled at its
// limit so the day's state machine advances.
function makePlaceOrder(run, record) {
  return function placeOrder(payload, meta) {
    const canSendReal = DEPS && DEPS.isProd === true && run.dryRun === false;
    if (!canSendReal) {
      const why = !(DEPS && DEPS.isProd) ? 'dev-mode' : 'dryRun';
      store.appendEvent(record, { type: 'order_simulated', by: why, meta, payload, note: `not sent (${why}); assumed filled at limit` });
      return { status: `simulated:${why}`, filled: true };
    }
    // PROD + dryRun off = the REAL send path. Still STOPPED SHORT for now: the internal
    // tradingClient.placeOrderByAcct(...) call is intentionally not wired yet — enable it
    // here (and make placeOrder async) when ready to go live.
    // e.g. return DEPS.tradingClient.placeOrderByAcct(DEPS.accountHash, payload)...
    store.appendEvent(record, { type: 'order_real_pending', meta, payload, note: 'PROD real-send path reached — actual send not yet wired' });
    return { status: 'real-not-enabled', filled: false };
  };
}

// Find the just-closed 15m candle (and its prior) from newest-first 15m candles.
// A candle is "closed" when its open time + 15min <= now. NOTE: assumes candle.datetime
// is the candle's OPEN time in epoch ms — verify against live Schwab data when enabling.
function pickJustClosed(candles, now = Date.now()) {
  const FIFTEEN = 15 * 60 * 1000;
  for (let i = 0; i < candles.length; i++) {
    const dt = typeof candles[i].datetime === 'number' ? candles[i].datetime : null;
    if (dt == null) continue;
    if (dt + FIFTEEN <= now + 2000) { // small skew tolerance
      return { candle: candles[i], prior: candles[i + 1] || null };
    }
  }
  return { candle: null, prior: null };
}

// Group runs that share live data (candles + chain) so we fetch ONCE per (symbol, expiration)
// per tick instead of once per variant — 3 variants must not triple the Schwab load.
function groupKey(run) { return `${run.symbol}|${run.expiration || todayEST()}`; }

async function processGroup(runs, kind) {
  const sample = runs[0];
  const expiration = sample.expiration || todayEST(); // 0DTE default
  const tradeDate = todayEST();

  // Fetch shared candle + chain ONCE for the whole group.
  const analysis = await DEPS.analyzeCandles(sample.symbol, { timeframe: '15m' });
  const candles = analysis?.candleData?.['15m']?.candles || [];
  const { candle, prior } = pickJustClosed(candles);
  if (!candle) return { pending: 'candle-not-available' };
  const chainData = await DEPS.getOrFetchChainData(sample.symbol, expiration);

  // First candle of the day uses the Bollinger gate: pass prior=null so classifyOpen takes
  // the first-candle branch even though a prior-session candle exists in the data.
  const priorForLogic = kind === 'first' ? null : prior;

  // Feed every variant the SAME candle + chain so the comparison is apples-to-apples.
  for (const run of runs) {
    try {
      const cfg = { ...run, expiration };
      const record = store.initRun(cfg, tradeDate);
      const getLeg = trader.makeLegAccessor(chainData, expiration);
      const placeOrder = makePlaceOrder(run, record);
      trader.processCandleClose(record, candle, priorForLogic, { getLeg, placeOrder, dryRun: run.dryRun });
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
  console.log(`[candle-spread] started (dry-run) — ${RUNS.length} run(s):`,
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
