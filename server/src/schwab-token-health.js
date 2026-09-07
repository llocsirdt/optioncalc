'use strict';
/**
 * SCHWAB TOKEN HEALTH — is the refresh token still good, and how long until it isn't?
 *
 * The refresh token expires ~7 days after it is minted. When it lapses, every market-data call starts
 * failing and the UI shows "Auth Error (server ok — token issue)" — but /health kept reporting status OK,
 * because it only ever looked at memory and disk. Nothing anywhere knew the token was about to die, so the
 * first signal was always a broken UI, after the fact. That happened on 2026-09-06 to both local and prod.
 *
 * TWO SIGNALS, deliberately separate:
 *   1. PROBE — the ground truth. Make a real authenticated call and see whether it works. Cached, because
 *      /health is pinged constantly by EB and this must not hammer Schwab (or the token's rate limits).
 *   2. AGE — the early warning. The probe only turns red AFTER the token is already dead, which is too
 *      late to be useful. The token is an opaque 140-char string with no embedded expiry, so issuance has
 *      to be tracked by us: renew-schwab-token.js stamps SCHWAB_REFRESH_TOKEN_ISSUED_AT into .env, and
 *      failing that the server records when it FIRST SAW this token and says so (`issuedAtObserved`), so
 *      a restart on an already-old token under-reports its age rather than silently lying about it.
 *
 * The token itself NEVER leaves this module: only a short sha256 fingerprint is stored or reported, which
 * is enough to tell "the token changed" from "the same token aged" without writing a credential to disk.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const LIFETIME_DAYS = 7;              // Schwab refresh-token lifetime
// Warn from ~6 days of age (1 day left). Chosen so the reminder starts a full day before the token can
// die, which is the point at which renewing is a two-minute chore rather than an outage.
const WARN_DAYS = 1.0;
const PROBE_TTL_MS = 5 * 60 * 1000;   // ground-truth probe at most every 5 minutes

// Same durability ladder the run store uses: prefer the root-disk dir that survives a deploy, fall back to
// /tmp. A lost state file only costs us the observed issue date, never correctness of the probe.
function stateDir() {
  const cands = [process.env.SCHWAB_TOKEN_STATE_DIR, '/var/optioncalc-data', '/tmp'].filter(Boolean);
  for (const d of cands) {
    try { fs.mkdirSync(d, { recursive: true }); fs.accessSync(d, fs.constants.W_OK); return d; } catch (e) { /* next */ }
  }
  return null;
}
function stateFile() { const d = stateDir(); return d ? path.join(d, 'schwab-token-state.json') : null; }

function fingerprint(token) {
  if (!token) return null;
  return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 12);
}

function readState() {
  const f = stateFile();
  if (!f) return {};
  try { return JSON.parse(fs.readFileSync(f, 'utf8')) || {}; } catch (e) { return {}; }
}
function writeState(s) {
  const f = stateFile();
  if (!f) return;
  try { fs.writeFileSync(f, JSON.stringify(s, null, 2), 'utf8'); } catch (e) { /* non-fatal */ }
}

/**
 * Resolve when the CURRENT token was issued. An explicit stamp from the renew script wins; otherwise fall
 * back to the first time this server saw this fingerprint, flagged as observed rather than authoritative.
 */
function resolveIssuedAt(fp) {
  const explicit = process.env.SCHWAB_REFRESH_TOKEN_ISSUED_AT;
  if (explicit) {
    const t = Date.parse(explicit);
    if (Number.isFinite(t)) return { issuedAt: new Date(t).toISOString(), observed: false };
  }
  const st = readState();
  if (st.fingerprint === fp && st.firstSeenAt) return { issuedAt: st.firstSeenAt, observed: true };
  // New (or first-ever) token: start the clock now.
  const now = new Date().toISOString();
  writeState({ fingerprint: fp, firstSeenAt: now, rotatedAt: now, previousFingerprint: st.fingerprint || null });
  return { issuedAt: now, observed: true };
}

let probeCache = null;   // { at, ok, error }

// An auth failure is specifically an auth failure — a network blip or a Schwab outage must NOT be reported
// as an expired token, or the hourly monitor cries wolf and stops meaning anything.
function looksLikeAuthFailure(err) {
  const msg = String((err && (err.message || err.error || err)) || '');
  const code = err && (err.status || err.statusCode);
  if (code === 401 || code === 403) return true;
  return /access token|schwab-authorize|unauthorized|refresh[_ ]token|invalid_grant|401|403/i.test(msg);
}

/**
 * Ground truth: make one cheap authenticated call. `probeFn` is injected (the market client's quote call)
 * so this module stays free of SDK wiring and is testable without a network.
 */
async function probe(probeFn, opts) {
  const o = opts || {};
  const now = Date.now();
  if (!o.force && probeCache && now - probeCache.at < PROBE_TTL_MS) return probeCache;
  if (typeof probeFn !== 'function') { probeCache = { at: now, ok: null, error: 'no probe wired' }; return probeCache; }
  try {
    await probeFn();
    probeCache = { at: now, ok: true, error: null };
  } catch (e) {
    probeCache = { at: now, ok: false, auth: looksLikeAuthFailure(e), error: String((e && e.message) || e).slice(0, 300) };
  }
  return probeCache;
}

/**
 * The /health block. Synchronous and never throws — health must stay answerable even when auth is broken,
 * because "the server is up but the token is dead" is exactly the state this exists to report.
 */
function report(token) {
  const fp = fingerprint(token);
  if (!fp) {
    return { present: false, state: 'missing', ok: false,
      message: 'SCHWAB_REFRESH_TOKEN is not set on this server.' };
  }
  const { issuedAt, observed } = resolveIssuedAt(fp);
  const ageMs = Date.now() - Date.parse(issuedAt);
  const ageDays = Math.round((ageMs / 86400000) * 100) / 100;
  const expiresAt = new Date(Date.parse(issuedAt) + LIFETIME_DAYS * 86400000).toISOString();
  const daysLeft = Math.round(((Date.parse(expiresAt) - Date.now()) / 86400000) * 100) / 100;
  const p = probeCache;

  // The PROBE decides when it has spoken; age only decides among the not-yet-failing states. An expired
  // probe beats a healthy-looking age, and a working probe beats a scary-looking age (the observed issue
  // date can be wrong after a restart, the probe cannot).
  let state, ok;
  if (p && p.ok === false && p.auth) { state = 'expired'; ok = false; }
  else if (p && p.ok === false) { state = 'probe-failed'; ok = null; }   // not an auth problem — don't blame the token
  else if (daysLeft <= 0) { state = 'expired'; ok = false; }
  else if (daysLeft <= WARN_DAYS) { state = 'expiring'; ok = true; }
  else if (p && p.ok === true) { state = 'valid'; ok = true; }
  else { state = 'unverified'; ok = null; }

  return {
    present: true, state, ok,
    fingerprint: fp,                       // sha256 prefix — identifies the token WITHOUT exposing it
    issuedAt, issuedAtObserved: observed,  // observed = "first seen by this server", not authoritative
    ageDays, expiresAt, daysLeft, lifetimeDays: LIFETIME_DAYS,
    probe: p ? { ok: p.ok, auth: p.auth === true, checkedAt: new Date(p.at).toISOString(), error: p.error } : null,
    message: state === 'expired' ? 'Schwab refresh token is EXPIRED — renew it now (scripts/renew-schwab-token.js).'
      : state === 'expiring' ? `Schwab refresh token expires in ${daysLeft} day(s) — renew it soon.`
      : state === 'probe-failed' ? 'Authenticated probe failed, but not with an auth error — likely a Schwab or network problem, not the token.'
      : state === 'unverified' ? 'Token age looks fine; no authenticated probe has run yet.'
      : 'Token is valid.',
  };
}

module.exports = { report, probe, fingerprint, LIFETIME_DAYS, WARN_DAYS, PROBE_TTL_MS, looksLikeAuthFailure };
