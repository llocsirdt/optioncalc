#!/usr/bin/env node
'use strict';
/**
 * check-token-health.js — is the Schwab refresh token still good on LOCAL and on PROD?
 *
 * The refresh token dies every ~7 days, and until now the first sign of it was the UI showing
 * "Auth Error (server ok — token issue)" — after the fact, on both environments at once, because they
 * hold SEPARATE tokens that were minted at the same time and therefore expire together.
 *
 * Reads /health on each environment (which now carries a `schwabToken` block) and prints one compact
 * verdict per environment. Exit code is the alerting signal:
 *   0 = both fine · 1 = something needs attention (expired / expiring / unreachable) · 2 = usage error
 *
 * Deliberately NOT a token check by itself: it distinguishes "the token is dead" from "the server is
 * unreachable" from "Schwab had a blip", because waking someone up for the wrong one trains them to
 * ignore it. Run hourly.
 *
 * Usage: node scripts/check-token-health.js [--local http://localhost:3001] [--prod https://...] [--json]
 */
const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const LOCAL = arg('--local', process.env.OPTIONCALC_LOCAL_URL || 'http://localhost:3001');
const PROD = arg('--prod', process.env.OPTIONCALC_PROD_URL || 'https://d1kbxyxn33vpw2.cloudfront.net');
const JSON_OUT = process.argv.includes('--json');
const TIMEOUT_MS = 15000;

async function check(name, base) {
  const url = `${base.replace(/\/$/, '')}/health`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch (e) { /* CloudFront 5xx HTML, etc. */ }
    if (!body) {
      return { name, base, reachable: false, level: 'warn',
        summary: `unreachable — HTTP ${res.status}, non-JSON body`, detail: text.slice(0, 200) };
    }
    const tok = body.schwabToken;
    if (!tok) {
      // An older build that predates this field. Report it, but at INFO — not `warn`. A pending deploy is
      // not an incident, and raising it hourly is how a monitor teaches people to ignore it. Say plainly
      // that the token state is UNKNOWN here rather than implying either a problem or an all-clear.
      return { name, base, reachable: true, level: 'info',
        summary: 'token state unknown — deploy predates this check (not an error; redeploy to enable)',
        build: body.build && (body.build.commit || body.build.version) };
    }
    const level = tok.state === 'expired' || tok.state === 'missing' ? 'bad'
      : tok.state === 'expiring' ? 'warn'
      : tok.state === 'probe-failed' ? 'warn' : 'ok';
    // Only show the age estimate when it is still MEANINGFUL. Once the probe has proven the token dead,
    // printing "expired · 7d left" side by side reads like a contradiction — the days-left figure is just
    // the observed-first-seen clock, which restarts with the server and says nothing once auth is failing.
    const dead = tok.state === 'expired' || tok.state === 'missing';
    const age = dead ? '' : (tok.daysLeft != null ? ` · ${tok.daysLeft}d left` : '')
      + (tok.issuedAtObserved ? ' (age observed, not stamped)' : '');
    return { name, base, reachable: true, level, token: tok, dead,
      summary: `${tok.state}${age}${dead && tok.probe && tok.probe.auth ? ' — confirmed by auth probe' : ''}`,
      build: body.build && (body.build.commit || body.build.version) };
  } catch (e) {
    return { name, base, reachable: false, level: 'warn',
      summary: `unreachable — ${String((e && e.message) || e).slice(0, 120)}` };
  } finally { clearTimeout(t); }
}

(async () => {
  const rs = await Promise.all([check('LOCAL', LOCAL), check('PROD', PROD)]);
  if (JSON_OUT) { console.log(JSON.stringify({ checkedAt: new Date().toISOString(), results: rs }, null, 2)); }
  else {
    const icon = { ok: '✅', info: 'ℹ️ ', warn: '⚠️ ', bad: '❌' };
    console.log(`SCHWAB TOKEN HEALTH — ${new Date().toISOString()}`);
    for (const r of rs) {
      console.log(`${icon[r.level]} ${r.name.padEnd(6)} ${r.summary}`);
      if (r.token && r.token.expiresAt && !r.dead) {
        console.log(`         issued ${r.token.issuedAt} · expires ~${r.token.expiresAt} · fp ${r.token.fingerprint}`);
      }
      if (r.token && r.token.probe && r.token.probe.ok === false) {
        console.log(`         probe: ${r.token.probe.error}`);
      }
      if (r.detail) console.log(`         ${r.detail}`);
    }
    const bad = rs.filter(r => r.level === 'bad'), warn = rs.filter(r => r.level === 'warn');
    if (bad.length) console.log(`\nACTION: renew the token — node scripts/renew-schwab-token.js (then set SCHWAB_REFRESH_TOKEN + SCHWAB_REFRESH_TOKEN_ISSUED_AT on EB too).`);
    else if (warn.length) console.log(`\nNo hard failure, but ${warn.map(r => r.name).join(' + ')} needs a look.`);
    else console.log('\nNothing to act on.');
  }
  // Exit non-zero ONLY for something actionable. `info` (a pending deploy) is deliberately excluded:
  // an hourly alert nobody can act on is worse than no alert, because it trains the reader to skip it.
  process.exit(rs.some(r => r.level === 'bad' || r.level === 'warn') ? 1 : 0);
})();
