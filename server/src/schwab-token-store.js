'use strict';
/**
 * SCHWAB REFRESH TOKEN STORE (2026-11-12) — renew the 7-day token remotely, without editing the EB environment.
 *
 * WHY. The refresh token lived only in SCHWAB_REFRESH_TOKEN (local .env and, separately, the EB environment).
 * Renewing prod meant editing an EB environment property by hand. Changing it from the app would need AWS
 * permissions the instance does not have, and it restarts the whole environment.
 *
 * HOW.
 *   - A renewed token is written to a small JSON file on the instance's persistent disk (the same state dir
 *     schwab-token-health uses: /var/optioncalc-data on EB, which survives deploys and reboots), and copied to the
 *     run-archive S3 bucket, which survives an instance replacement.
 *   - At boot, BEFORE anything constructs a Schwab client, applyStoredTokenSync() puts the stored token into
 *     process.env when it is newer than the env's. The clients read it at construction.
 *   - The clients keep their credentials private and are shared by reference across modules, so a new token takes
 *     effect by RESTARTING the process (systemd brings it back in seconds). There is no in-place swap.
 *   - reconcileFromS3() (async, after boot) covers a fresh instance: when S3 holds a newer token than the one in
 *     use, it writes the file and restarts once.
 *
 * Two ways in, both behind the control token (index.controlAuthOk):
 *   { code }          the one-time OAuth code from the Schwab redirect (~30 s lifetime); the server exchanges it.
 *   { refreshToken }  a token the local renew script already obtained (scripts/renew-schwab-token.js --push).
 * A code is single-use: whichever of the two paths uses it first consumes it.
 *
 * The token itself is never logged and never returned; responses carry only its fingerprint.
 *
 * ENCRYPTED AT REST, EVERYWHERE THIS STORE WRITES IT (2026-11-18, user: "is it safe to have the refresh token in plain
 * text in S3?"). Both the disk file and the S3 copy are AES-256-GCM envelopes. The key is derived (HKDF-SHA256) from
 * SCHWAB_CLIENT_SECRET, which lives only in the environment and is required anyway to use a refresh token. So a
 * stored copy is useless to anyone who does not already hold the secret, and this store adds no exposure beyond the
 * env var itself. Readable: only issuedAt, source and the fingerprint (bound to the ciphertext as AAD, so they
 * cannot be edited). A copy that will not decrypt (wrong or rotated secret, tampering) is ignored, and the env token
 * stands. Rotating the client secret makes old copies unreadable: the server falls back to the env token and you
 * renew once.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const S3_KEY = 'optioncalc-control/schwab-refresh-token.json';
const FILE_NAME = 'schwab-refresh-token.json';

function stateDir() {
  const home = process.env.HOME || process.env.USERPROFILE;
  const cands = [process.env.SCHWAB_TOKEN_STATE_DIR, '/var/optioncalc-data', home && path.join(home, '.optioncalc')].filter(Boolean);
  for (const d of cands) {
    try { if (fs.existsSync(d)) return d; } catch (e) { /* next */ }
  }
  return null;
}
function filePath() { const d = stateDir(); return d ? path.join(d, FILE_NAME) : null; }
function fingerprint(token) { return token ? crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 12) : null; }

function keyFor(secret) {
  if (!secret) return null;
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(String(secret)), Buffer.from('optioncalc'),
    Buffer.from('schwab-refresh-token v1'), 32));
}
function aadOf(env) { return Buffer.from(`v1|${env.issuedAt}|${env.fingerprint}|${env.source || ''}`); }
/** { refreshToken, issuedAt, source } -> the sealed envelope written to disk / S3. Throws without a client secret. */
function seal(rec, secret = process.env.SCHWAB_CLIENT_SECRET) {
  const key = keyFor(secret);
  if (!key) throw new Error('SCHWAB_CLIENT_SECRET is not set: cannot encrypt the stored token');
  const env = { v: 1, alg: 'aes-256-gcm', issuedAt: rec.issuedAt, source: rec.source || null, fingerprint: fingerprint(rec.refreshToken) };
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aadOf(env));
  const ct = Buffer.concat([c.update(JSON.stringify({ refreshToken: rec.refreshToken }), 'utf8'), c.final()]);
  return { ...env, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}
/** The sealed envelope -> { refreshToken, issuedAt, source }, or null when it will not open (wrong secret, tampered, not sealed). */
function open(env, secret = process.env.SCHWAB_CLIENT_SECRET) {
  try {
    const key = keyFor(secret);
    if (!key || !env || env.v !== 1 || !env.ct || !Number.isFinite(Date.parse(env.issuedAt))) return null;
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'));
    d.setAAD(aadOf(env));
    d.setAuthTag(Buffer.from(env.tag, 'base64'));
    const j = JSON.parse(Buffer.concat([d.update(Buffer.from(env.ct, 'base64')), d.final()]).toString('utf8'));
    if (!j.refreshToken || fingerprint(j.refreshToken) !== env.fingerprint) return null;
    return { refreshToken: j.refreshToken, issuedAt: env.issuedAt, source: env.source };
  } catch (e) { return null; }
}

function readFileSafe() {
  const f = filePath();
  if (!f) return null;
  try { return open(JSON.parse(fs.readFileSync(f, 'utf8'))); } catch (e) { return null; }
}
function writeFileSafe(rec) {
  const f = filePath();
  if (!f) throw new Error('no writable state dir for the Schwab token (set SCHWAB_TOKEN_STATE_DIR)');
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(seal(rec)), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, f);
}

function envIssuedMs() {
  const t = Date.parse(process.env.SCHWAB_REFRESH_TOKEN_ISSUED_AT || '');
  return Number.isFinite(t) ? t : null;
}

/**
 * Call at boot, right after dotenv and BEFORE any module constructs a Schwab client. Uses the stored token when the
 * env has none, or when the stored one is newer than the env's SCHWAB_REFRESH_TOKEN_ISSUED_AT (an env token with
 * no stamp counts as older, because only a renewal through this store or the stamped script writes one).
 */
function applyStoredTokenSync() {
  const rec = readFileSafe();
  if (!rec) return { applied: false, reason: 'no stored token' };
  if (rec.refreshToken === process.env.SCHWAB_REFRESH_TOKEN) return { applied: false, reason: 'env already has it' };
  const envMs = envIssuedMs();
  const recMs = Date.parse(rec.issuedAt);
  if (process.env.SCHWAB_REFRESH_TOKEN && envMs != null && envMs >= recMs) return { applied: false, reason: 'env token is newer' };
  process.env.SCHWAB_REFRESH_TOKEN = rec.refreshToken;
  process.env.SCHWAB_REFRESH_TOKEN_ISSUED_AT = rec.issuedAt;
  console.log(`[schwab-token] using the stored refresh token ${fingerprint(rec.refreshToken)} issued ${rec.issuedAt} (${rec.source || 'store'})`);
  return { applied: true, issuedAt: rec.issuedAt };
}

async function exchangeCode(code) {
  const id = process.env.SCHWAB_CLIENT_ID, secret = process.env.SCHWAB_CLIENT_SECRET;
  if (!id || !secret) throw Object.assign(new Error('SCHWAB_CLIENT_ID / SCHWAB_CLIENT_SECRET not set on this server'), { status: 503 });
  // Must match the redirect URI registered on the Schwab app AND the one the authorize URL used.
  const redirectUri = process.env.SCHWAB_CALLBACK_URL || 'https://llocsirdt.github.io/optioncalc/';
  const res = await fetch('https://api.schwabapi.com/v1/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
    },
    body: new URLSearchParams({ grant_type: 'authorization_code', redirect_uri: redirectUri, code }),
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* non-JSON error */ }
  if (!res.ok || !data || !data.refresh_token) {
    const why = (data && (data.error_description || data.error)) || `HTTP ${res.status}`;
    throw Object.assign(new Error(`Schwab rejected the code: ${why} (codes are single-use and expire in about 30 s)`), { status: 400 });
  }
  return data.refresh_token;
}

/** Checks a refresh token by asking Schwab for an access token with it. Throws when Schwab refuses it. */
async function validateRefreshToken(token) {
  const id = process.env.SCHWAB_CLIENT_ID, secret = process.env.SCHWAB_CLIENT_SECRET;
  const res = await fetch('https://api.schwabapi.com/v1/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token }),
  });
  if (!res.ok) throw Object.assign(new Error(`Schwab refused that refresh token (HTTP ${res.status})`), { status: 400 });
  return true;
}

async function persist(refreshToken, source, archive) {
  const rec = { refreshToken, issuedAt: new Date().toISOString(), source };
  writeFileSafe(rec);
  let s3 = 'not configured';
  if (archive && archive.enabled && archive.enabled()) {
    // The file is the primary; the S3 copy is the backup. putObjectRaw reports failure in its result, not by throwing.
    try { const r = await archive.putObjectRaw(S3_KEY, JSON.stringify(seal(rec)), 'application/json'); s3 = r && r.ok ? 'copied' : `copy failed: ${(r && (r.error || r.reason)) || 'unknown'}`; }
    catch (e) { s3 = `copy failed: ${e && e.message}`; }
  }
  return { rec, s3 };
}

/**
 * The route body. deps = { authOk(req) -> {ok,status,error}, archive, restart(ms) }.
 * Returns { status, body }; never includes the token.
 */
async function handleUpdate(req, deps) {
  const auth = deps.authOk(req);
  if (!auth.ok) return { status: auth.status, body: { ok: false, error: auth.error } };
  const b = req.body || {};
  let token, source;
  try {
    if (b.code) { token = await exchangeCode(String(b.code)); source = 'oauth-code'; }
    else if (b.refreshToken) { await validateRefreshToken(String(b.refreshToken)); token = String(b.refreshToken); source = 'pushed'; }
    else return { status: 400, body: { ok: false, error: 'send { code } from the Schwab redirect, or { refreshToken }' } };
    const { rec, s3 } = await persist(token, source, deps.archive);
    const restartMs = 1500;
    deps.restart(restartMs);
    console.log(`[schwab-token] refresh token ${fingerprint(token)} stored (${source}); S3 ${s3}; restarting in ${restartMs} ms`);
    return { status: 200, body: { ok: true, fingerprint: fingerprint(token), issuedAt: rec.issuedAt, source, s3,
      restartingInMs: restartMs, note: 'the server restarts to load the new token; /health shows it in ~15 s' } };
  } catch (e) {
    return { status: e.status || 500, body: { ok: false, error: e.message } };
  }
}

/** After boot: if S3 holds a newer token than the one in use (e.g. a replaced instance), store it and restart once. */
async function reconcileFromS3(archive, restart) {
  if (!(archive && archive.enabled && archive.enabled() && archive.getObjectRaw)) return { checked: false };
  let rec = null;
  try {
    const r = await archive.getObjectRaw(S3_KEY, { quietMissing: true });   // { ok, body } | { ok:false, missing }
    if (!r || !r.ok) return { checked: true, newer: false, missing: !!(r && r.missing) };
    rec = open(JSON.parse(r.body));
    if (!rec) return { checked: true, newer: false, unreadable: true };   // will not decrypt: ignore it, keep the env token
  } catch (e) { return { checked: true, error: e && e.message }; }
  if (!rec || !rec.refreshToken || rec.refreshToken === process.env.SCHWAB_REFRESH_TOKEN) return { checked: true, newer: false };
  const inUse = envIssuedMs();
  if (inUse != null && inUse >= Date.parse(rec.issuedAt)) return { checked: true, newer: false };
  writeFileSafe(rec);
  console.log(`[schwab-token] S3 holds a newer refresh token (${fingerprint(rec.refreshToken)}, ${rec.issuedAt}); restarting to load it`);
  restart(1000);
  return { checked: true, newer: true };
}

module.exports = { applyStoredTokenSync, handleUpdate, reconcileFromS3, fingerprint, S3_KEY, _filePath: filePath, _seal: seal, _open: open };
