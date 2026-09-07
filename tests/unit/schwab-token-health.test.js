'use strict';
// Schwab refresh-token health. The whole point of this module is to be RIGHT about three states that look
// similar from the outside and demand different reactions:
//   expired      -> wake the user, renew now
//   probe-failed -> Schwab or the network is unhappy; the token is NOT the problem, don't cry wolf
//   expiring     -> still working, but renew before it bites
// It must also never write the token itself anywhere. Both are checked here.
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokhealth-'));
process.env.SCHWAB_TOKEN_STATE_DIR = dir;
delete process.env.SCHWAB_REFRESH_TOKEN_ISSUED_AT;
const th = require('../../server/src/schwab-token-health.js');

let passed = 0;
const t = (name, fn) => { try { fn(); console.log('  ✓ ' + name); passed++; } catch (e) { console.log('  ✗ ' + name + '\n     ' + e.message); process.exitCode = 1; } };
const ta = async (name, fn) => { try { await fn(); console.log('  ✓ ' + name); passed++; } catch (e) { console.log('  ✗ ' + name + '\n     ' + e.message); process.exitCode = 1; } };

console.log('\nschwab-token-health');

const TOKEN = 'x'.repeat(140);

t('a missing token is its own state, not a false all-clear', () => {
  const r = th.report(null);
  assert.strictEqual(r.present, false);
  assert.strictEqual(r.state, 'missing');
  assert.strictEqual(r.ok, false);
});

t('the token itself never appears in the report or on disk', () => {
  const r = th.report(TOKEN);
  const blob = JSON.stringify(r) + fs.readdirSync(dir).map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('');
  assert.ok(!blob.includes(TOKEN), 'raw token leaked');
  assert.strictEqual(r.fingerprint.length, 12, 'fingerprint is a short hash');
});

t('an explicit issued-at stamp beats the observed first-seen date', () => {
  process.env.SCHWAB_REFRESH_TOKEN_ISSUED_AT = '2026-09-01T00:00:00.000Z';
  const r = th.report(TOKEN);
  assert.strictEqual(r.issuedAt, '2026-09-01T00:00:00.000Z');
  assert.strictEqual(r.issuedAtObserved, false, 'a stamped date is authoritative');
  delete process.env.SCHWAB_REFRESH_TOKEN_ISSUED_AT;
});

t('age alone drives expiring/expired when no probe has run', () => {
  const days = (n) => new Date(Date.now() - n * 86400000).toISOString();
  process.env.SCHWAB_REFRESH_TOKEN_ISSUED_AT = days(6.2);
  assert.strictEqual(th.report(TOKEN).state, 'expiring', '6.2 days old -> warn');
  process.env.SCHWAB_REFRESH_TOKEN_ISSUED_AT = days(7.5);
  assert.strictEqual(th.report(TOKEN).state, 'expired', 'past the 7-day lifetime');
  process.env.SCHWAB_REFRESH_TOKEN_ISSUED_AT = days(1);
  assert.strictEqual(th.report(TOKEN).state, 'unverified', 'young, but nothing has proven it works');
});

t('auth failures are told apart from everything else', () => {
  assert.ok(th.looksLikeAuthFailure(new Error('failed to update access token. run schwab-authorize')));
  assert.ok(th.looksLikeAuthFailure({ status: 401 }));
  assert.ok(th.looksLikeAuthFailure(new Error('invalid_grant')));
  assert.ok(!th.looksLikeAuthFailure(new Error('ETIMEDOUT connect')), 'a network timeout is not an auth failure');
  assert.ok(!th.looksLikeAuthFailure(new Error('500 Internal Server Error')), 'a Schwab 5xx is not an auth failure');
});

(async () => {
  await ta('a successful probe reports valid', async () => {
    process.env.SCHWAB_REFRESH_TOKEN_ISSUED_AT = new Date().toISOString();
    await th.probe(async () => ({}), { force: true });
    const r = th.report(TOKEN);
    assert.strictEqual(r.state, 'valid');
    assert.strictEqual(r.ok, true);
  });

  await ta('an AUTH probe failure overrides a healthy-looking age', async () => {
    process.env.SCHWAB_REFRESH_TOKEN_ISSUED_AT = new Date().toISOString();   // brand new by the clock
    await th.probe(async () => { throw new Error('failed to update access token: 400'); }, { force: true });
    const r = th.report(TOKEN);
    assert.strictEqual(r.state, 'expired', 'the probe is ground truth, the clock is an estimate');
    assert.strictEqual(r.ok, false);
  });

  await ta('a NON-auth probe failure must not blame the token', async () => {
    process.env.SCHWAB_REFRESH_TOKEN_ISSUED_AT = new Date().toISOString();
    await th.probe(async () => { throw new Error('ETIMEDOUT'); }, { force: true });
    const r = th.report(TOKEN);
    assert.strictEqual(r.state, 'probe-failed');
    assert.strictEqual(r.ok, null, 'unknown, not bad — this must not page anyone');
  });

  await ta('probe results are cached so /health cannot hammer Schwab', async () => {
    let calls = 0;
    const fn = async () => { calls++; };
    await th.probe(fn, { force: true });
    await th.probe(fn);
    await th.probe(fn);
    assert.strictEqual(calls, 1, 'only the forced call went out');
  });

  console.log(`  ${passed} passed`);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
})();
