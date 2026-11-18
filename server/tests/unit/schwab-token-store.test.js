'use strict';
// SCHWAB TOKEN STORE (2026-11-12): which token wins at boot, the control-token gate, both ways in ({ code },
// { refreshToken }), that the token is never returned, and that a restart is scheduled. Schwab is mocked (fetch).
const fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokstore-'));
process.env.SCHWAB_TOKEN_STATE_DIR = dir;
process.env.SCHWAB_CLIENT_ID = 'cid'; process.env.SCHWAB_CLIENT_SECRET = 'sec';
const TS = require('../../src/schwab-token-store');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const file = path.join(dir, 'schwab-refresh-token.json');

(async () => {
  // 1) boot precedence
  process.env.SCHWAB_REFRESH_TOKEN = 'ENV_TOKEN_OLD'; process.env.SCHWAB_REFRESH_TOKEN_ISSUED_AT = '2026-11-01T00:00:00Z';
  ok(TS.applyStoredTokenSync().applied === false, 'no stored file -> env token kept');
  fs.writeFileSync(file, JSON.stringify(TS._seal({ refreshToken: 'STORED_NEW', issuedAt: '2026-11-10T00:00:00Z', source: 'oauth-code' })));
  ok(TS.applyStoredTokenSync().applied === true && process.env.SCHWAB_REFRESH_TOKEN === 'STORED_NEW', 'a newer stored token replaces the env token');
  process.env.SCHWAB_REFRESH_TOKEN = 'ENV_NEWER'; process.env.SCHWAB_REFRESH_TOKEN_ISSUED_AT = '2026-11-11T00:00:00Z';
  ok(TS.applyStoredTokenSync().applied === false && process.env.SCHWAB_REFRESH_TOKEN === 'ENV_NEWER', 'an env token stamped newer wins');
  process.env.SCHWAB_REFRESH_TOKEN = 'ENV_UNSTAMPED'; delete process.env.SCHWAB_REFRESH_TOKEN_ISSUED_AT;
  ok(TS.applyStoredTokenSync().applied === true, 'an unstamped env token counts as older than a stored one');

  // 2) auth gate
  const deny = { authOk: () => ({ ok: false, status: 401, error: 'bad or missing x-control-token' }), restart: () => {}, archive: null };
  const r401 = await TS.handleUpdate({ body: { code: 'X' } }, deny);
  ok(r401.status === 401, 'a request without the control token is refused');

  // 3) { code } path: exchange mocked
  let restarted = null, calls = [];
  const allow = { authOk: () => ({ ok: true }), restart: (ms) => { restarted = ms; },
    archive: { enabled: () => true, putObjectRaw: async (k, b) => { calls.push({ k, b }); return { ok: true }; } } };
  global.fetch = async (url, init) => {
    const body = String(init.body);
    if (/grant_type=authorization_code/.test(body)) return { ok: true, status: 200, json: async () => ({ refresh_token: 'FROM_CODE_TOKEN' }) };
    if (/grant_type=refresh_token/.test(body)) return { ok: /PUSHED_GOOD/.test(body), status: /PUSHED_GOOD/.test(body) ? 200 : 400, json: async () => ({}) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const rc = await TS.handleUpdate({ body: { code: 'C0.abc@' } }, allow);
  ok(rc.status === 200 && rc.body.ok && rc.body.source === 'oauth-code', 'a code is exchanged and stored');
  ok(!JSON.stringify(rc.body).includes('FROM_CODE_TOKEN'), 'the response never contains the token');
  const stored = () => TS._open(JSON.parse(fs.readFileSync(file, 'utf8')));
  ok(stored().refreshToken === 'FROM_CODE_TOKEN', 'the file holds the new token');
  ok(!fs.readFileSync(file, 'utf8').includes('FROM_CODE_TOKEN'), 'the file does NOT contain the token in plain text');
  ok(calls.length === 1 && calls[0].k === TS.S3_KEY && rc.body.s3 === 'copied', 'a copy goes to S3');
  ok(!String(calls[0].b).includes('FROM_CODE_TOKEN') && TS._open(JSON.parse(calls[0].b)).refreshToken === 'FROM_CODE_TOKEN',
    'the S3 copy is encrypted, and opens with the client secret');
  ok(TS._open(JSON.parse(calls[0].b), 'some-other-secret') === null, 'the S3 copy will not open without the client secret');
  { const env = JSON.parse(calls[0].b); env.issuedAt = '2030-01-01T00:00:00Z'; ok(TS._open(env) === null, 'editing the readable metadata breaks it (AAD)'); }
  ok(restarted > 0, 'a restart is scheduled so the clients load it');

  // 4) a rejected code
  global.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant', error_description: 'code expired' }) });
  const bad = await TS.handleUpdate({ body: { code: 'OLD' } }, allow);
  ok(bad.status === 400 && /code expired/.test(bad.body.error), 'an expired code is reported, nothing stored');
  ok(stored().refreshToken === 'FROM_CODE_TOKEN', 'a failed exchange leaves the stored token alone');

  // 5) { refreshToken } path: validated first
  global.fetch = async (url, init) => ({ ok: /PUSHED_GOOD/.test(String(init.body)), status: /PUSHED_GOOD/.test(String(init.body)) ? 200 : 400, json: async () => ({}) });
  ok((await TS.handleUpdate({ body: { refreshToken: 'PUSHED_BAD' } }, allow)).status === 400, 'a pushed token Schwab refuses is not stored');
  const rp = await TS.handleUpdate({ body: { refreshToken: 'PUSHED_GOOD' } }, allow);
  ok(rp.status === 200 && rp.body.source === 'pushed' && stored().refreshToken === 'PUSHED_GOOD', 'a valid pushed token is stored');

  // 6) S3 reconcile on a fresh instance
  fs.unlinkSync(file);
  process.env.SCHWAB_REFRESH_TOKEN = 'ENV_OLDER'; process.env.SCHWAB_REFRESH_TOKEN_ISSUED_AT = '2026-11-01T00:00:00Z';
  let r2 = null;
  const sealedS3 = JSON.stringify(TS._seal({ refreshToken: 'S3_NEWER', issuedAt: '2026-11-12T00:00:00Z', source: 'oauth-code' }));
  const rec = await TS.reconcileFromS3({ enabled: () => true, getObjectRaw: async () => ({ ok: true, body: sealedS3 }) }, (ms) => { r2 = ms; });
  ok(rec.newer === true && r2 > 0 && stored().refreshToken === 'S3_NEWER', 'a newer S3 token is written and a restart scheduled');
  const plainS3 = await TS.reconcileFromS3({ enabled: () => true, getObjectRaw: async () => ({ ok: true, body: JSON.stringify({ refreshToken: 'PLAIN', issuedAt: '2030-01-01T00:00:00Z' }) }) }, () => { throw new Error('no'); });
  ok(plainS3.newer === false && plainS3.unreadable === true, 'an unencrypted or foreign S3 object is ignored');
  // a file sealed under a different (e.g. rotated) client secret is ignored at boot: the env token stands
  fs.writeFileSync(file, JSON.stringify(TS._seal({ refreshToken: 'OTHER_SECRET_TOKEN', issuedAt: '2030-01-01T00:00:00Z' }, 'rotated-secret')));
  process.env.SCHWAB_REFRESH_TOKEN = 'ENV_STAYS'; delete process.env.SCHWAB_REFRESH_TOKEN_ISSUED_AT;
  ok(TS.applyStoredTokenSync().applied === false && process.env.SCHWAB_REFRESH_TOKEN === 'ENV_STAYS', 'a copy sealed with another secret is ignored at boot');
  const same = await TS.reconcileFromS3({ enabled: () => true, getObjectRaw: async () => ({ ok: false, missing: true }) }, () => { throw new Error('no'); });
  ok(same.newer === false, 'no S3 copy -> nothing happens');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
