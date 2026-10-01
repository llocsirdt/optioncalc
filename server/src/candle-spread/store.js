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
// *** DURABLE POSITION RECORDING — ADDRESSED 2026-09-29, see run-archive.js ***
// Every writeRun now also ships the record to S3 (write-through, fire-and-forget), and candle-spread
// start() rehydrates the day's runs from S3 before the first tick when the local store is empty. That
// closes the hole described below: a replacement instance recovers the day's open positions instead of
// starting blind. It is OFF unless CANDLE_SPREAD_S3_BUCKET is set and the instance profile grants
// s3:PutObject/GetObject/ListBucket, and /health reports whether it is actually working — an archive that
// is configured but silently failing is the one state worse than no archive.
//
// The original note, kept because it records WHY:
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

// SYMBOL_EXPIRATION_TRADEDATE[_VARIANT].json — the only shape a run record's filename ever has.
function isRunFileName(f) {
  if (!f.endsWith('.json')) return false;
  const p = f.replace(/\.json$/, '').split('_');
  if (p.length < 3) return false;
  if (!/^[A-Z][A-Z0-9.$]*$/.test(p[0])) return false;
  return /^\d{4}-\d{2}-\d{2}$/.test(p[2]);
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

// OFF-INSTANCE COPY, QUEUED AND BOUNDED. The local write is the authority and must never wait on a network:
// writeRun is called from inside the tick, so an S3 round trip on a slow link would delay the engine and a
// rejection would take down whatever called it.
//
// *** WHY THIS IS A QUEUE AND NOT A BARE fire-and-forget PUT ***
// The first version called putRun directly with the serialised body, once per writeRun, with no limit on how
// many could be in flight. That is fine during the day and wrong at 16:00: eodSettlementInner rewrites ALL 80
// variants in a tight loop, so eighty ~1 MB request bodies could be live at once, on top of the parse and
// serialise churn, on a 1.9 GB instance.
//
// On 2026-10-01 the instance went from Ok to "No Data — none of the instances are sending data" within 60
// seconds of the 16:00 settlement boundary, after seven healthy hours. That signature is resource starvation
// severe enough that even the EB health agent stopped reporting, and this is the most plausible contributor:
// not a new bug, but an unbounded background copy competing with the engine at the heaviest moment of the day.
//
// THE QUEUE HOLDS runIds, NOT BODIES, which is what makes it bounded rather than merely ordered:
//   - memory is MAX_INFLIGHT bodies, not one per queued write
//   - coalescing is free. A record written 300 times during the day queues ONE id; whatever is on disk when
//     its turn comes is what ships, and that is by definition the newest content.
//   - the local file is already the authority, so reading it back at send time cannot lose anything
//
// Losing the newest write to a crash is still acceptable and bounded: restoreDay never overwrites a local file
// that exists, so the local copy always wins when both are present.
const SHIP_MAX_INFLIGHT = Number(process.env.CANDLE_SPREAD_S3_MAX_INFLIGHT) || 3;
const shipQueue = new Set();        // runIds awaiting upload (coalesced by construction)
const shipActive = new Set();       // runIds currently uploading — never two at once for the same record
let shipInFlight = 0;
let shipDropped = 0;

function shipToArchive(runId) {
  try {
    const A = require('./run-archive');
    if (!A.enabled()) return;
    shipQueue.add(runId);
    pumpShipQueue();
  } catch (_) { /* archive module unavailable: local disk is still the authority */ }
}

function pumpShipQueue() {
  let A;
  try { A = require('./run-archive'); } catch (_) { return; }
  if (!A.enabled()) { shipQueue.clear(); return; }
  // ONE UPLOAD PER RECORD AT A TIME. Without shipActive, a record written in a burst starts a second and third
  // upload of itself before the first completes — and every one but the last is superseded the moment it lands,
  // so they are pure waste of exactly the resource this queue exists to protect. An id already in flight stays
  // QUEUED instead, and the completion handler pumps again and ships it once, with the newest content.
  for (const runId of Array.from(shipQueue)) {
    if (shipInFlight >= SHIP_MAX_INFLIGHT) break;
    if (shipActive.has(runId)) continue;                    // leave it queued for the next pass
    shipQueue.delete(runId);
    let body;
    // Read at SEND time, not at queue time — one body in memory per in-flight upload, and always the latest.
    try { body = fs.readFileSync(runFilePath(runId), 'utf8'); } catch (_) { shipDropped++; continue; }
    shipActive.add(runId);
    shipInFlight++;
    Promise.resolve(A.putRun(runId, body))
      .catch(() => { /* counted in run-archive stats */ })
      .finally(() => { shipActive.delete(runId); shipInFlight--; pumpShipQueue(); });
  }
}

/** Visible on /health, so a backed-up archive queue is diagnosable rather than invisible. */
function shipQueueStats() {
  return { queued: shipQueue.size, inFlight: shipInFlight, active: shipActive.size,
    maxInFlight: SHIP_MAX_INFLIGHT, dropped: shipDropped };
}

function writeRun(record) {
  ensureDir();
  record.updatedAt = new Date().toISOString();
  const body = JSON.stringify(record, null, 2);
  fs.writeFileSync(runFilePath(record.runId), body, 'utf8');
  writeSummary(record.runId, record);
  shipToArchive(record.runId);          // queued; the body is re-read from disk when its turn comes
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
  // A RUN FILE IS NAMED FOR ITS runId. The old test — ends in .json, does not start with `_` — accepted macOS
  // AppleDouble sidecars: `._NDX_2026-08-18_..._v0-10.json` begins with a DOT, so 1,127 of them shipped in the
  // 2026-09-30 seed bundle, landed here, and the compare page listed 2,254 runs of which half were unreadable.
  // Match the shape instead of excluding prefixes one at a time.
  return fs.readdirSync(RUNS_DIR)
    .filter(isRunFileName)
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
  readRunStatus, quarantineRun, isRunFileName, shipQueueStats,
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
