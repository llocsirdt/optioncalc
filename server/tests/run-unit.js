#!/usr/bin/env node
'use strict';
// Runs every suite in server/tests/unit. Each suite is a standalone script that prints "N passed, M
// failed" and exits non-zero on failure, so this just forks them in series and tallies.
//
// These suites lived in server/tests/nogit/ and were therefore IGNORED BY GIT (.gitignore has `nogit/`).
// That is how commit ab922ee changed debitLimit's contract on 2026-09-05 and left three of them broken
// for nine days with nothing to notice: they existed only on one machine and `npm test` runs the LIVE
// Schwab API script, not these. Tracked now, and runnable with `npm run test:unit`.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, 'unit');
// Several suites reach the backtest datasets by a REPO-ROOT-relative path ('tests/backtest/...'), so they
// only pass when cwd is the repo root. `npm run test:unit` runs from server/, which made
// candle-spread-classic-signal die on ENOENT. Pin cwd rather than rewrite the paths in each suite.
const REPO_ROOT = path.join(__dirname, '..', '..');
const only = process.argv[2];                       // optional substring filter: `npm run test:unit -- ledger`
const files = fs.readdirSync(dir).filter(f => f.endsWith('.test.js')).filter(f => !only || f.includes(only)).sort();

let failed = 0;
const slow = [];
for (const f of files) {
  const t0 = Date.now();
  process.stdout.write(`  ${f.replace(/\.test\.js$/, '').padEnd(42)}`);
  try {
    const out = execFileSync(process.execPath, [path.join(dir, f)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd: REPO_ROOT });
    const m = /(\d+) passed/.exec(out);
    const ms = Date.now() - t0;
    if (ms > 5000) slow.push([f, ms]);
    console.log(`ok   ${m ? m[1] + ' assertions' : ''}  ${ms > 1000 ? `(${(ms / 1000).toFixed(1)}s)` : ''}`);
  } catch (e) {
    failed++;
    console.log('FAIL');
    const body = `${e.stdout || ''}${e.stderr || ''}`.trimEnd().split('\n');
    for (const line of body.slice(-14)) console.log(`      ${line}`);
  }
}

console.log(`\n${files.length - failed}/${files.length} suites passed`);
if (slow.length) console.log(`slow: ${slow.map(([f, ms]) => `${f} ${(ms / 1000).toFixed(1)}s`).join(', ')}`);
process.exit(failed ? 1 : 0);
