/**
 * Persistence + tracking for candle-spread runs. One JSON record per
 * (symbol, expiration, tradeDate), written to disk so it survives EB restarts and
 * can be read by the UI at any time. Single-instance server, so synchronous writes
 * are fine and keep the on-disk copy consistent after every event.
 */
const fs = require('fs');
const path = require('path');

// Override via CANDLE_SPREAD_RUNS_DIR so tests can point at an isolated temp dir
// (store-internal reads/writes use this local binding, so a module-level override is
// the only reliable way to redirect persistence).
const RUNS_DIR = process.env.CANDLE_SPREAD_RUNS_DIR || path.join(__dirname, '..', 'persistence', 'candle-spread-runs');

function ensureDir() {
  try { fs.mkdirSync(RUNS_DIR, { recursive: true }); } catch (_) { /* exists */ }
}

// e.g. NDX_2026-08-11_2026-08-11 (symbol_expiration_tradeDate), or
// NDX_2026-08-11_2026-08-11_v1 when a variant is given (the 3 parallel shadow strategies).
// variant is optional so pre-variant run files keep their original ids.
function makeRunId(symbol, expiration, tradeDate, variant) {
  const base = `${symbol}_${expiration}_${tradeDate}`;
  return variant ? `${base}_${variant}` : base;
}

function runFilePath(runId) {
  return path.join(RUNS_DIR, `${runId}.json`);
}

function readRun(runId) {
  try {
    return JSON.parse(fs.readFileSync(runFilePath(runId), 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeRun(record) {
  ensureDir();
  record.updatedAt = new Date().toISOString();
  fs.writeFileSync(runFilePath(record.runId), JSON.stringify(record, null, 2), 'utf8');
  return record;
}

// Create (or load existing) record for a run+day. Initial state carries the direction
// machine and position list the engine maintains.
function initRun(config, tradeDate) {
  const runId = makeRunId(config.symbol, config.expiration, tradeDate, config.variant);
  const existing = readRun(runId);
  if (existing) return existing;
  const record = {
    runId,
    tradeDate,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    config,
    state: {
      direction: 'none',            // side of currently-held UNCOVERED spreads: 'bull'|'bear'|'none'
      positions: [],                // { id, side, legs, quantity, limit, mark, orderStatus, filled, covered, coverId, openedAt }
      pendingOpenId: null,          // id of the most-recent OPEN order still unfilled (cancelled next candle)
      realizedPnl: 0,               // running locked P&L (dollars) as covers complete
      lastCandleTime: null          // timeEST of the last candle we acted on (de-dupe)
    },
    events: []
  };
  return writeRun(record);
}

function appendEvent(record, event) {
  record.events.push({ time: new Date().toISOString(), ...event });
  writeRun(record);
  return record;
}

// For the read endpoints.
function listRunFiles() {
  ensureDir();
  return fs.readdirSync(RUNS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace(/\.json$/, ''));
}

function listRunsSummary() {
  return listRunFiles().map(runId => {
    const r = readRun(runId);
    if (!r) return { runId };
    return {
      runId,
      symbol: r.config?.symbol,
      expiration: r.config?.expiration,
      tradeDate: r.tradeDate,
      variant: r.config?.variant || null,
      variantLabel: r.config?.variantLabel || null,
      coverSelector: r.config?.coverSelector || null,
      direction: r.state?.direction,
      positionCount: r.state?.positions?.length || 0,
      realizedPnl: r.state?.realizedPnl || 0,
      eventCount: r.events?.length || 0,
      updatedAt: r.updatedAt
    };
  });
}

module.exports = {
  RUNS_DIR,
  makeRunId,
  runFilePath,
  readRun,
  writeRun,
  initRun,
  appendEvent,
  listRunFiles,
  listRunsSummary
};
