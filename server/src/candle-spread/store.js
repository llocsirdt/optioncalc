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
//
// *** CRITICAL TODO — DURABLE POSITION RECORDING ***
// This is a LOCAL-DISK store. /var/optioncalc-data survives in-place restarts but NOT instance
// replacement (an EB immutable deploy / ASG health swap gives a fresh EBS volume → empty store). On
// 2026-09-01 today's runs vanished this way — recoverable when it's paper, CATASTROPHIC once live
// (the server would forget real open positions on an instance swap). Before arming any real strategy,
// move run/position state to OFF-INSTANCE durable backing (S3 or a DB), with read-through on boot so a
// replacement instance rehydrates the day's open positions. See /health candleRunsProbe for diagnosis.
const RUNS_DIR = process.env.CANDLE_SPREAD_RUNS_DIR || path.join(__dirname, '..', 'persistence', 'candle-spread-runs');

// SUMMARY SIDECARS. listRunsSummary() used to JSON.parse EVERY run record in full to read six small
// fields out of each, so /api/v1/candle-spread/runs — hit by every compare and debug page load — cost a
// full parse of the whole store. Harmless while records were small; on 2026-09-16 a runaway floor-offset
// loop grew ONE record to 32,411 positions and the index endpoint became a ~140 MB transient allocation
// per request, on a 1.9 GB instance with a history of OOM from exactly this shape of transient spike.
//
// Each write now also drops a small sidecar holding just the summary. The index reads those instead, so
// its cost is proportional to the SUMMARY size rather than the record size and a pathological record can
// no longer make listing expensive. They live in a subdirectory so listRunFiles() (which filters on a
// `.json` suffix in RUNS_DIR) cannot mistake one for a run.
const SUM_DIR = path.join(RUNS_DIR, '_summaries');

function ensureDir() {
  try { fs.mkdirSync(RUNS_DIR, { recursive: true }); } catch (_) { /* exists */ }
  try { fs.mkdirSync(SUM_DIR, { recursive: true }); } catch (_) { /* exists */ }
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

// A FILE THAT WILL NOT PARSE IS NOT AN ABSENT FILE. This returned null for both, and initRun reads null
// as "no run today" and writes a brand-new empty record over the top — so a truncated write (disk full, or
// the OOM kill this box has a history of) silently destroyed the only copy of a day's positions and
// started the variant over from zero, mid-session, with real orders already at the broker.
//
// `missing` is the ordinary case. `corrupt` carries the parse error so the caller can decide, and the
// caller must never overwrite it.
function readRunStatus(runId) {
  const file = runFilePath(runId);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { state: 'missing' };
    return { state: 'corrupt', error: (e && e.message) || String(e) };   // exists but unreadable
  }
  try {
    return { state: 'ok', record: JSON.parse(raw) };
  } catch (e) {
    return { state: 'corrupt', error: (e && e.message) || String(e), bytes: raw.length };
  }
}

function readRun(runId) {
  const r = readRunStatus(runId);
  return r.state === 'ok' ? r.record : null;
}

// Move a file we cannot parse out of the way instead of overwriting it. Returns the quarantine path, or
// null if even that failed — in which case the caller must not write, because the original is still there.
function quarantineRun(runId, why) {
  const file = runFilePath(runId);
  const dest = path.join(RUNS_DIR, `_corrupt_${runId}_${Date.now()}.json`);
  try {
    fs.renameSync(file, dest);
    console.error(`[candle-spread] CORRUPT RUN FILE ${runId} (${why}) — moved to ${path.basename(dest)}; it was NOT overwritten.`);
    return dest;
  } catch (e) {
    console.error(`[candle-spread] CORRUPT RUN FILE ${runId} (${why}) and it could not be moved aside: ${e && e.message}`);
    return null;
  }
}

function sumFilePath(runId) {
  return path.join(SUM_DIR, `${runId}.json`);
}

// The projection listRunsSummary() serves. Kept in ONE place so the sidecar and the fallback full-parse
// path cannot drift into producing different shapes for the same record.
function summarize(runId, r) {
  return {
    runId,
    symbol: r.config?.symbol,
    expiration: r.config?.expiration,
    tradeDate: r.tradeDate,
    variant: r.config?.variant || null,
    variantLabel: r.config?.variantLabel || null,
    // The width is what lets a legacy name (`v6`, `v6-20-10k`) be resolved onto the current roster —
    // it comes from the run's own config, so the mapping is read from the record, never assumed.
    spreadWidth: r.config?.spreadWidth ?? null,
    coverSelector: r.config?.coverSelector || null,
    direction: r.state?.direction,
    positionCount: r.state?.positions?.length || 0,
    realizedPnl: r.state?.realizedPnl || 0,
    eventCount: r.events?.length || 0,
    updatedAt: r.updatedAt
  };
}

// Best-effort: a sidecar that cannot be written must never fail the run write that produced it. The
// reader falls back to a full parse, so the worst case of a failure here is the old cost, not wrong data.
function writeSummary(runId, record) {
  try { fs.writeFileSync(sumFilePath(runId), JSON.stringify(summarize(runId, record)), 'utf8'); } catch (_) { /* non-fatal */ }
}

function writeRun(record) {
  ensureDir();
  record.updatedAt = new Date().toISOString();
  fs.writeFileSync(runFilePath(record.runId), JSON.stringify(record, null, 2), 'utf8');
  writeSummary(record.runId, record);
  return record;
}

// Create (or load existing) record for a run+day. Initial state carries the direction
// machine and position list the engine maintains.
function initRun(config, tradeDate) {
  const runId = makeRunId(config.symbol, config.expiration, tradeDate, config.variant);
  const st = readRunStatus(runId);
  if (st.state === 'ok') return st.record;
  let recovered = null;
  if (st.state === 'corrupt') {
    // THE DAY'S BOOK IS GONE AND WE ARE MID-SESSION. Do not pretend it is a fresh morning: preserve the
    // file, say so on the record, and say so in the log. What the engine SHOULD do from here — carry on
    // blind, or stand down for this variant — is a policy call, not something to decide silently inside a
    // file reader; the flag is here so whoever makes it can see the case actually happened.
    recovered = { quarantined: quarantineRun(runId, st.error), error: st.error, bytes: st.bytes || null,
      at: new Date().toISOString() };
    if (!recovered.quarantined) {
      // The bad file is still in place. Writing now would destroy it, which is the whole failure.
      throw new Error(`candle-spread: run file ${runId} is corrupt and could not be quarantined — refusing to overwrite it`);
    }
  }
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
  if (recovered) {
    record.recoveredFromCorrupt = recovered;
    record.events.push({ time: new Date().toISOString(), type: 'run_file_corrupt',
      note: `the previous record for ${runId} would not parse and was moved to ${path.basename(recovered.quarantined)}; `
        + 'this record starts EMPTY and does not describe any orders placed before now',
      error: recovered.error, bytes: recovered.bytes });
  }
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
  // `_`-prefixed names are INTERNAL (the prune's status file, and anything added later). Without this
  // the prune's own _prune-last.json listed as a run on 2026-09-17 — a phantom entry with null variant
  // and zero positions, served to the compare page as if it were a session. Same convention as the
  // _summaries/ directory, which is excluded already by virtue of not being a file.
  return fs.readdirSync(RUNS_DIR)
    .filter(f => f.endsWith('.json') && !f.startsWith('_'))
    .map(f => f.replace(/\.json$/, ''));
}

function listRunsSummary() {
  return listRunFiles().map(runId => {
    // A sidecar is authoritative only while it is at least as new as the record it describes. Comparing
    // mtimes rather than trusting its existence is what makes this safe against a record written by an
    // older build, a half-finished write, or a file edited out of band: any of those just costs one full
    // parse and heals the sidecar.
    try {
      const rp = runFilePath(runId), sp = sumFilePath(runId);
      if (fs.statSync(sp).mtimeMs >= fs.statSync(rp).mtimeMs) return JSON.parse(fs.readFileSync(sp, 'utf8'));
    } catch (_) { /* missing / unreadable / stale -> fall through and rebuild it */ }
    const r = readRun(runId);
    if (!r) return { runId };
    const sum = summarize(runId, r);
    ensureDir();
    writeSummary(runId, r);   // BACKFILL, so each legacy record is parsed in full at most once
    return sum;
  });
}

module.exports = {
  readRunStatus, quarantineRun,
  RUNS_DIR,
  summarize,
  makeRunId,
  runFilePath,
  readRun,
  writeRun,
  initRun,
  appendEvent,
  listRunFiles,
  listRunsSummary
};
