/**
 * Candle-spread runtime: run config, the aligned scheduler, live data glue, the
 * (dry-run) order placer, and read accessors for the API. Kept separate from the
 * paper-sim position-manager. Dependencies (candle analysis, chain fetch, trading
 * client, account hash) are injected via start() to avoid circular requires.
 */
const store = require('./store');
const trader = require('./trader');

// Default run(s). Each run is independent, keyed by (symbol, expiration). NDX 0DTE first.
// dryRun=true => build + log orders but DO NOT send; assume fills so the day simulates.
const DEFAULT_RUNS = [
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

// The dry-run order placer. Builds nothing new (payload already built) — logs and, while
// dryRun, ASSUMES the order fills at its limit so state advances. Real sending is the
// deliberate future step in the `else` branch.
function makePlaceOrder(run, record) {
  return function placeOrder(payload, meta) {
    if (run.dryRun) {
      store.appendEvent(record, { type: 'order_dry_run', meta, payload, note: 'DRY RUN — not sent; assumed filled at limit' });
      return { status: 'dry-run-assumed-fill', filled: true };
    }
    // FUTURE (real): gated, internal call — NOT enabled yet.
    // return DEPS.tradingClient.placeOrderByAcct(DEPS.accountHash, payload)...
    store.appendEvent(record, { type: 'order_send_blocked', meta, note: 'real send not enabled' });
    return { status: 'blocked', filled: false };
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

async function runDecisionForBoundary(run, kind) {
  const expiration = run.expiration || todayEST(); // 0DTE default
  const tradeDate = todayEST();
  const cfg = { ...run, expiration };
  const record = store.initRun(cfg, tradeDate);

  // Candles
  const analysis = await DEPS.analyzeCandles(cfg.symbol, { timeframe: '15m' });
  const candles = analysis?.candleData?.['15m']?.candles || [];
  const { candle, prior } = pickJustClosed(candles);
  if (!candle) return { pending: 'candle-not-available' };

  // Chain marks
  const chainData = await DEPS.getOrFetchChainData(cfg.symbol, expiration);
  const getLeg = trader.makeLegAccessor(chainData, expiration);

  // First candle of the day uses the Bollinger gate: pass prior=null so classifyOpen
  // takes the first-candle branch even though a prior-session candle exists in the data.
  const priorForLogic = kind === 'first' ? null : prior;

  const placeOrder = makePlaceOrder(run, record);
  const result = trader.processCandleClose(record, candle, priorForLogic, { getLeg, placeOrder, dryRun: run.dryRun });
  return { acted: true, result };
}

// Poll for candle availability: fire at boundary+5s, retry every 5s up to a cap.
function attemptTick(kind, retriesLeft) {
  Promise.all(RUNS.map(run => runDecisionForBoundary(run, kind).catch(e => ({ error: e.message }))))
    .then(results => {
      const stillPending = results.some(r => r && r.pending);
      if (stillPending && retriesLeft > 0) {
        setTimeout(() => attemptTick(kind, retriesLeft - 1), 5000);
      }
    })
    .catch(err => console.error('[candle-spread] tick error:', err && err.message));
}

function eodPlaceholder() {
  // PLACEHOLDER: last-15-minutes routine (15:45–16:00). Intended: sweep for cheap covers
  // (cover cost < 5% of spread width) to lock profit on still-open 0DTE positions, else
  // let them settle. To be defined. For now we just note it in each run's log.
  for (const run of RUNS) {
    const record = store.initRun({ ...run, expiration: run.expiration || todayEST() }, todayEST());
    store.appendEvent(record, { type: 'eod_placeholder', note: 'EOD hook (cheap-cover sweep) not yet implemented' });
  }
}

function scheduleNext() {
  const delay = msToNextBoundary() + 5000; // fire 5s after the boundary
  schedTimer = setTimeout(() => {
    const now = new Date();
    // The boundary we just passed is ~now (minus the 5s). Classify by current ET minute.
    const kind = classifyBoundary(now);
    try {
      if (kind === 'eod') eodPlaceholder();
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
  RUNS = DEFAULT_RUNS.map(r => ({ ...r }));
  started = true;
  scheduleNext();
  console.log(`[candle-spread] started (dry-run) — ${RUNS.length} run(s):`, RUNS.map(r => r.symbol).join(', '));
}

// --- read accessors for the API -------------------------------------------
function listRuns() { return store.listRunsSummary(); }
function getRun(symbol, expiration, date) {
  const tradeDate = date || todayEST();
  return store.readRun(store.makeRunId(symbol, expiration, tradeDate));
}

module.exports = {
  start,
  listRuns,
  getRun,
  // exported for tests
  classifyBoundary,
  msToNextBoundary,
  pickJustClosed,
  DEFAULT_RUNS
};
