#!/usr/bin/env node

// One-command Schwab refresh token renewal.
// Wraps schwab-client-js's manual-authorize CLI, which needs SCHWAB_APP_KEY /
// SCHWAB_SECRET / SCHWAB_CALLBACK_URL — names that don't match this repo's
// .env (SCHWAB_CLIENT_ID / SCHWAB_CLIENT_SECRET, no callback var set).

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const repoRoot = path.resolve(__dirname, '..');

if (!process.env.SCHWAB_CLIENT_ID || !process.env.SCHWAB_CLIENT_SECRET) {
  console.error('SCHWAB_CLIENT_ID / SCHWAB_CLIENT_SECRET missing from .env');
  process.exit(1);
}

const env = {
  ...process.env,
  SCHWAB_APP_KEY: process.env.SCHWAB_CLIENT_ID,
  SCHWAB_SECRET: process.env.SCHWAB_CLIENT_SECRET,
  // Must match the redirect URI registered on the Schwab app (developer.schwab.com)
  SCHWAB_CALLBACK_URL: process.env.SCHWAB_CALLBACK_URL || 'https://llocsirdt.github.io/optioncalc/',
};

const cliPath = path.resolve(repoRoot, 'node_modules', 'schwab-client-js', 'bin', 'manual-authorize.js');
const PORT = process.env.PORT || 3001;

function restartServer() {
  console.log('\nRestarting local server...');
  try {
    const pids = execSync(`lsof -ti:${PORT}`).toString().trim();
    if (pids) execSync(`kill ${pids.split('\n').join(' ')}`);
  } catch {
    // nothing was listening on the port — fine
  }

  // Re-read .env from disk rather than trusting this process's own env —
  // dotenv.config() at startup already cached the old SCHWAB_REFRESH_TOKEN,
  // and a plain inherited env would shadow the freshly written value.
  const freshEnvVars = require('dotenv').parse(fs.readFileSync(path.resolve(repoRoot, '.env')));

  const logFd = fs.openSync(path.resolve(repoRoot, 'server.log'), 'a');
  const server = spawn('npm', ['run', 'dev'], {
    cwd: repoRoot,
    env: { ...process.env, ...freshEnvVars },
    stdio: ['ignore', logFd, logFd],
    detached: true,
  });
  server.unref();

  setTimeout(() => {
    http
      .get(`http://localhost:${PORT}/health`, (res) => {
        console.log(res.statusCode === 200 ? 'Server is up.' : `Server responded with status ${res.statusCode}`);
        process.exit(0);
      })
      .on('error', () => {
        console.log('Server did not respond yet — check server.log.');
        process.exit(0);
      });
  }, 3000);
}

function newTokenLooksValid() {
  // manual-authorize.js exits 0 and writes the literal string "undefined"
  // if the code exchange silently failed — catch that before restarting.
  const envContents = fs.readFileSync(path.resolve(repoRoot, '.env'), 'utf8');
  const match = envContents.match(/^SCHWAB_REFRESH_TOKEN=(.*)$/m);
  return Boolean(match && match[1] && match[1] !== 'undefined' && match[1].length > 20);
}

function updateEnvToken(newToken) {
  const envPath = path.resolve(repoRoot, '.env');
  let contents = fs.readFileSync(envPath, 'utf8');
  contents = contents.includes('SCHWAB_REFRESH_TOKEN')
    ? contents.replace(/^SCHWAB_REFRESH_TOKEN=.*$/m, `SCHWAB_REFRESH_TOKEN=${newToken}`)
    : `${contents}\nSCHWAB_REFRESH_TOKEN=${newToken}`;
  fs.writeFileSync(envPath, contents, 'utf8');
}

// Non-interactive mode: `node renew-schwab-token.js "<redirected-url>"` skips the
// browser-prompt step when the URL was already obtained (e.g. pasted by the user).
const redirectedUrl = process.argv[2];

if (redirectedUrl) {
  (async () => {
    const code = new URL(redirectedUrl).searchParams.get('code');
    if (!code) {
      console.error('No "code" query param found in the provided URL.');
      process.exit(1);
    }
    const basicAuth = Buffer.from(`${env.SCHWAB_APP_KEY}:${env.SCHWAB_SECRET}`).toString('base64');
    const response = await fetch('https://api.schwabapi.com/v1/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basicAuth}`,
        'Accept-Encoding': 'gzip',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        redirect_uri: env.SCHWAB_CALLBACK_URL,
        code,
      }),
    });
    const data = await response.json();
    if (!response.ok || !data.refresh_token) {
      console.error('Token exchange failed:', data.error || response.status, data.error_description || '');
      process.exit(1);
    }
    updateEnvToken(data.refresh_token);
    console.log('SCHWAB_REFRESH_TOKEN updated in .env file.');
    if (newTokenLooksValid()) {
      restartServer();
    } else {
      console.error('New token failed validation — server not restarted.');
      process.exit(1);
    }
  })();
} else {
  const child = spawn(process.execPath, [cliPath], { cwd: repoRoot, env, stdio: 'inherit' });
  child.on('exit', (code) => {
    if (code === 0 && newTokenLooksValid()) {
      restartServer();
    } else {
      console.error('\nToken renewal did not produce a valid SCHWAB_REFRESH_TOKEN — server not restarted.');
      process.exit(1);
    }
  });
}
