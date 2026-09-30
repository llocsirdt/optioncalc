/**
 * REMOTE STRATEGY CONTROL — which variants trade, in what mode, right now.
 *
 * A small JSON object in S3, polled by the engine. It exists because every existing switch is boot-time:
 * CANDLE_SPREAD_DISABLED is read once at startup, CANDLE_SPREAD_ARMED names one variant, and changing either
 * means an env edit plus a restart. On a day when something looks wrong that is far too slow, and it is all or
 * nothing — there is no way to stand one strategy down and leave the rest running.
 *
 * WHY S3 AND NOT MEMORY OR LOCAL DISK. The state has to survive instance replacement. A kill held in memory is
 * forgotten by a replacement instance: you stand a variant down at 11:00, the ASG swaps the box at noon, and it
 * starts trading again. That failure is not hypothetical here — it happened to the run store twice
 * (2026-09-01 and 2026-09-29 20:11 ET). Off-instance is the only correct place for it.
 *
 * ── THE FILE ────────────────────────────────────────────────────────────────────────────────────────
 * Verbose on purpose: it is meant to be hand-edited in the S3 console at 09:20 with one hand.
 *
 *   {
 *     "updatedAt": "2026-09-30T13:40:00Z",
 *     "updatedBy": "tdriscoll",
 *     "variants": {
 *       "v7-10": { "mode": "paper", "note": "first funded week" },
 *       "v6-20": { "mode": "live",  "note": "small size trial", "until": "2026-10-03" },
 *       "v9-20": { "mode": "simulate", "restrict": "halt", "note": "fills looked wrong at 10:40" }
 *     }
 *   }
 *
 * ANY VARIANT NOT LISTED IS SIMULATION ONLY. That is what keeps the file short — only exceptions appear — and
 * it is also the fail-safe direction: an empty file, a deleted file, or a file this code cannot read all mean
 * "nothing trades for real", which is the state you want when in doubt.
 *
 *   mode      'simulate' (default) | 'paper' | 'live'
 *   restrict  optional: 'no-open' | 'halt'          — orthogonal to mode, subtracts from it
 *   until     optional YYYY-MM-DD (ET). Past that date the entry is IGNORED and the variant reverts to
 *             simulate. So a live arming you forget about expires instead of running for a month.
 *
 * ── TWO SEPARATE QUESTIONS, DELIBERATELY ────────────────────────────────────────────────────────────
 * `mode` is what the strategy IS. `restrict` is what it may DO right now. They are orthogonal because the
 * useful kill is not "switch it off" — a live variant holding an uncovered 0DTE position that stops acting is
 * in the most dangerous state available. `no-open` lets the cover logic finish while opening nothing new,
 * which is the reflex you want; `halt` is the fire alarm and should feel like one.
 *
 * ── THE MASTER GATE STAYS IN THE ENVIRONMENT ────────────────────────────────────────────────────────
 * `mode: 'live'` is a REQUEST, not a grant. It is honoured only when CANDLE_SPREAD_LIVE is already true in the
 * environment; otherwise it is downgraded to paper and the downgrade is reported. Stopping should be fast and
 * reachable from a phone; STARTING real-money trading should stay slow and deliberate. Without that asymmetry a
 * mistyped file, or anyone who can write to the bucket, can arm real money in one edit.
 */
const REQUIRED_MODES = ['simulate', 'paper', 'live'];
const RESTRICTS = ['no-open', 'halt'];

// Cache + provenance. `sticky` is the point: a read failure must never change behaviour in either direction.
const state = {
  loadedAt: null,          // when we last successfully parsed a file
  checkedAt: null,         // when we last tried
  etag: null,
  raw: null,               // the parsed file, as read
  variants: {},            // normalised: variant -> { mode, restrict, note, until, expired, downgraded }
  updatedAt: null,
  updatedBy: null,
  source: 'none',          // 'none' | 's3' | 'stale-cache'
  error: null,             // the last read/parse error, if any
  errorAt: null,
  unknownVariants: [],     // named in the file but not on the roster — a typo governs nothing, loudly
  reads: 0, readFails: 0, changes: 0,
};

function controlKey(prefix) {
  return `${String(prefix || '').replace(/\/+$/, '')}/_control/strategy-control.json`;
}

// ET date, to compare against `until`. The trading day is an ET concept and a UTC comparison would expire an
// entry at 20:00 the evening before on the US east coast.
function todayET() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}

/**
 * Turn a parsed file into the normalised per-variant map, dropping and REPORTING anything invalid rather than
 * guessing at it. An entry that cannot be understood must not become an accidental grant.
 *
 * @param file       the parsed JSON
 * @param knownVariants iterable of roster variant names, or null to skip that check
 * @param opts.liveAllowed  whether the environment permits mode:'live' at all
 */
function normalise(file, knownVariants, opts = {}) {
  const known = knownVariants ? new Set(knownVariants) : null;
  const out = { variants: {}, unknown: [], rejected: [], expired: [], downgraded: [] };
  const src = (file && file.variants) || {};
  const today = todayET();
  for (const [name, entryRaw] of Object.entries(src)) {
    if (known && !known.has(name)) { out.unknown.push(name); continue; }
    // A bare string is a kindness for hand-editing: "v7-10": "paper".
    const entry = typeof entryRaw === 'string' ? { mode: entryRaw } : (entryRaw || {});
    const mode = String(entry.mode || 'simulate').toLowerCase();
    if (!REQUIRED_MODES.includes(mode)) {
      out.rejected.push({ variant: name, why: `unknown mode ${JSON.stringify(entry.mode)}` });
      continue;
    }
    let restrict = entry.restrict == null ? null : String(entry.restrict).toLowerCase();
    if (restrict != null && !RESTRICTS.includes(restrict)) {
      out.rejected.push({ variant: name, why: `unknown restrict ${JSON.stringify(entry.restrict)}` });
      continue;
    }
    // EXPIRY IS FAIL-SAFE. Past `until` the entry stops applying entirely, so an arming you forget about
    // reverts to simulate instead of running for a month.
    const until = entry.until ? String(entry.until).slice(0, 10) : null;
    if (until && !/^\d{4}-\d{2}-\d{2}$/.test(until)) {
      out.rejected.push({ variant: name, why: `until is not YYYY-MM-DD: ${JSON.stringify(entry.until)}` });
      continue;
    }
    if (until && until < today) { out.expired.push({ variant: name, until, mode }); continue; }
    // LIVE IS A REQUEST, NOT A GRANT. The environment holds the master switch; see the header note.
    let effective = mode;
    if (mode === 'live' && !opts.liveAllowed) {
      effective = 'paper';
      out.downgraded.push({ variant: name, from: 'live', to: 'paper',
        why: 'CANDLE_SPREAD_LIVE is not set in the environment — the control file cannot arm real money on its own' });
    }
    out.variants[name] = { mode: effective, requestedMode: mode, restrict, note: entry.note || null, until };
  }
  return out;
}

/**
 * Fetch and apply the control file. Resolves always; a failure leaves the previous state in force.
 *
 * @param deps.archive        run-archive (for S3 access)
 * @param deps.knownVariants  roster names
 * @param deps.liveAllowed    whether the env permits live
 * @param deps.log / deps.warn
 */
async function refresh(deps = {}) {
  const A = deps.archive || require('./run-archive');
  const log = deps.log || console.log;
  const warn = deps.warn || console.warn;
  state.checkedAt = new Date().toISOString();
  // Only "is there a bucket at all" here; the capability check for the raw reader is below, where it can say
  // something more specific. This originally tested getObjectToFile — the file-STREAMING getter, which this
  // path does not use — so any archive without it bailed out before reading anything.
  if (!A.enabled()) {
    state.error = 'the run archive is not configured, so there is nowhere to read control from';
    state.errorAt = state.checkedAt;
    return state;
  }
  const key = controlKey(A.PREFIX);
  let body = null;
  try {
    // A control file is small, so read it as an object rather than to disk. quietMissing: an ABSENT file is
    // the normal, correct, everything-in-simulation state — not an error to report forever.
    if (typeof A.getObjectRaw !== 'function') {
      // An older archive module than this one — degrade rather than throw, so a partial deploy leaves the
      // engine in simulation instead of crashing it.
      state.error = 'run-archive has no raw object reader; control cannot be read';
      state.errorAt = state.checkedAt;
      return state;
    }
    const r = await A.getObjectRaw(key, { quietMissing: true });
    if (r && r.ok) body = r.body;
    else if (r && r.missing) {
      // No file at all: every variant simulates. Say it once, not every poll.
      if (state.source !== 'absent') log('[candle-spread] no strategy-control file in S3 — every variant is in simulation.');
      state.source = 'absent'; state.variants = {}; state.raw = null;
      state.unknownVariants = []; state.error = null;
      return state;
    } else {
      state.readFails++;
      state.error = (r && (r.error || r.reason)) || 'control read failed';
      state.errorAt = state.checkedAt;
      if (state.loadedAt) { state.source = 'stale-cache'; warn(`[candle-spread] strategy-control unreadable (${state.error}) — KEEPING the last known state from ${state.loadedAt}.`); }
      return state;
    }
  } catch (e) {
    state.readFails++;
    state.error = (e && e.message) || String(e);
    state.errorAt = state.checkedAt;
    if (state.loadedAt) state.source = 'stale-cache';
    return state;
  }

  let file;
  try { file = JSON.parse(body); } catch (e) {
    // A MALFORMED FILE MUST NOT MEAN "NO RESTRICTIONS". Keeping the last good state is the only safe reading:
    // a half-saved edit would otherwise silently release every halt in force.
    state.readFails++;
    state.error = `control file is not valid JSON: ${(e && e.message) || e}`;
    state.errorAt = state.checkedAt;
    if (state.loadedAt) { state.source = 'stale-cache'; warn(`[candle-spread] ${state.error} — KEEPING the last known state from ${state.loadedAt}.`); }
    else warn(`[candle-spread] ${state.error} — no previous state, so every variant stays in simulation.`);
    return state;
  }

  const n = normalise(file, deps.knownVariants, { liveAllowed: !!deps.liveAllowed });
  const before = JSON.stringify(state.variants);
  const after = JSON.stringify(n.variants);
  state.reads++;
  state.raw = file;
  state.variants = n.variants;
  state.unknownVariants = n.unknown;
  state.rejected = n.rejected;
  state.expired = n.expired;
  state.downgraded = n.downgraded;
  state.updatedAt = file.updatedAt || null;
  state.updatedBy = file.updatedBy || null;
  state.loadedAt = state.checkedAt;
  state.source = 's3';
  state.error = null;

  if (before !== after) {
    state.changes++;
    const summary = Object.entries(n.variants)
      .map(([k, v]) => `${k}=${v.mode}${v.restrict ? '/' + v.restrict : ''}`).join(' ') || '(all simulate)';
    log(`[candle-spread] strategy-control CHANGED -> ${summary}`
      + (file.updatedBy ? `  (by ${file.updatedBy}${file.updatedAt ? ' at ' + file.updatedAt : ''})` : ''));
  }
  // A NAME NOBODY MATCHES GOVERNS NOTHING, and silence there is how a typo becomes "I thought I halted it".
  // Same lesson as armedSelectionValid, which exists because CANDLE_SPREAD_ARMED with a typo armed nothing.
  if (n.unknown.length) warn(`[candle-spread] strategy-control names ${n.unknown.length} variant(s) that are NOT on the roster `
    + `and therefore do nothing: ${n.unknown.join(', ')}`);
  for (const r of n.rejected) warn(`[candle-spread] strategy-control entry for ${r.variant} IGNORED — ${r.why}`);
  for (const e of n.expired) log(`[candle-spread] strategy-control entry for ${e.variant} expired on ${e.until} `
    + `(was ${e.mode}) — it is back to simulation.`);
  for (const d of n.downgraded) warn(`[candle-spread] strategy-control asked for ${d.variant}=${d.from} but ${d.why} — running ${d.to}.`);
  return state;
}

/** What may this variant do right now? Always answers; unlisted means simulate. */
function forVariant(variant) {
  const e = state.variants[variant];
  if (!e) return { mode: 'simulate', restrict: null, listed: false };
  return { mode: e.mode, requestedMode: e.requestedMode, restrict: e.restrict, note: e.note,
    until: e.until, listed: true };
}

const canOpen = (variant) => { const c = forVariant(variant); return !(c.restrict === 'halt' || c.restrict === 'no-open'); };
const canSendOrders = (variant) => forVariant(variant).restrict !== 'halt';
// dryRun in the engine's vocabulary: true = simulate, 'test' = real unfillable orders, false = real fillable.
const dryRunFor = (variant) => ({ simulate: true, paper: 'test', live: false })[forVariant(variant).mode];

function health() {
  const listed = Object.entries(state.variants).map(([k, v]) => ({ variant: k, ...v }));
  return {
    source: state.source,
    updatedAt: state.updatedAt, updatedBy: state.updatedBy,
    loadedAt: state.loadedAt, checkedAt: state.checkedAt,
    ageSeconds: state.loadedAt ? Math.round((Date.now() - new Date(state.loadedAt)) / 1000) : null,
    reads: state.reads, readFails: state.readFails, changes: state.changes,
    error: state.error, errorAt: state.errorAt,
    // Everything that is NOT plain simulation, which is the whole point of reading this at a glance.
    listed,
    halted: listed.filter((v) => v.restrict === 'halt').map((v) => v.variant),
    noOpen: listed.filter((v) => v.restrict === 'no-open').map((v) => v.variant),
    live: listed.filter((v) => v.mode === 'live').map((v) => v.variant),
    paper: listed.filter((v) => v.mode === 'paper').map((v) => v.variant),
    unknownVariants: state.unknownVariants,
    rejected: state.rejected || [],
    expired: state.expired || [],
    downgraded: state.downgraded || [],
  };
}

/**
 * Apply a change and write it back to S3. Validates against the roster BEFORE writing, so a typo is refused at
 * the moment it is made rather than silently governing nothing until someone reads /health.
 *
 * Three shapes, all going through the same validation:
 *   { variant, mode, restrict?, note?, until? }   set or replace one entry
 *   { variant, remove: true }                     delete one entry (back to simulate)
 *   { variants: {...} }                           replace the whole map
 *
 * READ-MODIFY-WRITE, LAST WRITE WINS. There is one operator, so a compare-and-swap would be machinery for a
 * race that cannot happen; if that changes, the ETag returned by getObjectRaw is the hook for it.
 */
async function applyPatch(patch, deps = {}) {
  const A = deps.archive || require('./run-archive');
  const known = deps.knownVariants ? new Set(deps.knownVariants) : null;
  if (!A.enabled() || typeof A.putObjectRaw !== 'function') {
    return { ok: false, status: 503, error: 'the run archive is not configured, so control cannot be written' };
  }
  const key = controlKey(A.PREFIX);

  // Start from what is actually in the bucket, not from our cache: the cache may be stale, and writing a stale
  // view back would silently revert someone else's change.
  let file = { variants: {} };
  const cur = await A.getObjectRaw(key, { quietMissing: true });
  if (cur.ok) {
    try { file = JSON.parse(cur.body) || { variants: {} }; }
    catch (e) {
      // REFUSE rather than overwrite. A file we cannot parse may hold a halt somebody is relying on, and
      // replacing it with our own view would silently drop it.
      return { ok: false, status: 409,
        error: `the existing control file is not valid JSON (${(e && e.message) || e}) — refusing to overwrite it. `
          + 'Fix or delete the object in S3, then retry.' };
    }
  } else if (!cur.missing) {
    return { ok: false, status: 502, error: `cannot read the current control file: ${cur.error || cur.reason}` };
  }
  if (!file.variants || typeof file.variants !== 'object') file.variants = {};

  const next = { ...file, variants: { ...file.variants } };
  if (patch && patch.variants && typeof patch.variants === 'object') {
    next.variants = { ...patch.variants };
  } else if (patch && patch.variant) {
    if (known && !known.has(patch.variant)) {
      return { ok: false, status: 400,
        error: `${patch.variant} is not on the roster — refusing to write an entry that would govern nothing` };
    }
    if (patch.remove === true) delete next.variants[patch.variant];
    else {
      const entry = { mode: patch.mode || 'simulate' };
      if (patch.restrict) entry.restrict = patch.restrict;
      if (patch.note) entry.note = patch.note;
      if (patch.until) entry.until = patch.until;
      next.variants[patch.variant] = entry;
    }
  } else {
    return { ok: false, status: 400, error: 'nothing to do: send { variant, mode } or { variants: {...} }' };
  }

  // VALIDATE THE RESULT, not the patch. liveAllowed:true here on purpose — we are storing an intent, and the
  // downgrade to paper happens at READ time against the environment the engine is actually running in.
  const check = normalise(next, deps.knownVariants, { liveAllowed: true });
  if (check.unknown.length || check.rejected.length) {
    return { ok: false, status: 400,
      error: 'the resulting file would contain entries that do nothing',
      unknownVariants: check.unknown, rejected: check.rejected };
  }

  next.updatedAt = new Date().toISOString();
  next.updatedBy = (patch && (patch.by || patch.updatedBy)) || 'api';
  const body = JSON.stringify(next, null, 2);
  const w = await A.putObjectRaw(key, body);
  if (!w.ok) return { ok: false, status: 502, error: `write failed: ${w.error || w.reason}` };

  // Refresh immediately so the caller sees the state the engine will act on, including any live -> paper
  // downgrade the environment imposes. Without this a caller could be told 'live' and get paper.
  await refresh({ archive: A, knownVariants: deps.knownVariants, liveAllowed: !!deps.liveAllowed,
    log: deps.log || (() => {}), warn: deps.warn || (() => {}) });
  return { ok: true, status: 200, wrote: next, state: health() };
}

function _reset() {
  Object.assign(state, { loadedAt: null, checkedAt: null, etag: null, raw: null, variants: {},
    updatedAt: null, updatedBy: null, source: 'none', error: null, errorAt: null, unknownVariants: [],
    rejected: [], expired: [], downgraded: [], reads: 0, readFails: 0, changes: 0 });
}

module.exports = { refresh, applyPatch, forVariant, canOpen, canSendOrders, dryRunFor, health, normalise,
  controlKey, todayET, REQUIRED_MODES, RESTRICTS, _state: state, _reset };
