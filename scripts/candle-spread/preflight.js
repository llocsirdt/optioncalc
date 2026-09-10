#!/usr/bin/env node
'use strict';
/**
 * preflight.js — the standing "is what we run still what we measured?" check.
 *
 * WHY (user, 2026-09-10): "we need the live trading engine to mirror the backtest scenario, because
 * knowing they're not aligned gives zero confidence in the daily runs compared to the backtest numbers …
 * anything that lets backtest and live simulation stray from each other should be reconciled as often as
 * it makes sense to." Run before every deploy, and once or twice a day besides.
 *
 * It runs the two structural audits and gives one verdict:
 *
 *   ENGINE PARITY      — does the live trader do what the 5m backtest measured? An ACTIVE divergence
 *                        (a field a live run SETS, implemented in only one engine) means the baseline
 *                        describes a strategy nobody is running. Four of these were found on 2026-09-09
 *                        alone, including one that stopped the engine booting.
 *   VARIANT DISTINCT.  — does every live variant still differ from every other? v1/v2 declared distinct
 *                        cover geometries for weeks while the selector built the same tent for all of
 *                        them, so the run set was quietly measuring fewer strategies than it claimed.
 *
 * Exit 0 = clean, 1 = something needs attention before deploying. Anything it reports is a real finding:
 * both audits are tuned to stay silent when nothing is wrong.
 *
 * Usage: node scripts/candle-spread/preflight.js [--verbose]
 */
const { execFileSync } = require('child_process');
const path = require('path');

const HERE = __dirname;
const CHECKS = [
  { name: 'ENGINE PARITY', script: 'audit-engine-parity.js',
    fail: 'a live run sets a field only one engine implements' },
  { name: 'VARIANT DISTINCTNESS', script: 'audit-variant-distinctness.js',
    fail: 'two variants are behaviourally identical' },
];

const strip = (s) => s.split('\n')
  .filter(l => !/dotenv|Creating .*singleton|ARMED SELECTION/.test(l))
  .join('\n').trim();

let failed = 0;
const results = [];
for (const c of CHECKS) {
  let out = '', code = 0;
  try {
    out = execFileSync('node', [path.join(HERE, c.script), ...(process.argv.includes('--verbose') ? ['--verbose'] : [])],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    code = e.status == null ? 2 : e.status;
    out = (e.stdout || '') + (e.stderr || '');
  }
  if (code !== 0) failed++;
  results.push({ ...c, code, out: strip(out) });
}

const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
console.log(`\n${'='.repeat(72)}`);
console.log(`ENGINE PREFLIGHT — ${stamp}Z`);
console.log('='.repeat(72));
for (const r of results) {
  console.log(`\n${r.code === 0 ? '✅' : '❌'} ${r.name}${r.code === 0 ? '' : `  — ${r.fail}`}`);
  console.log(r.out.split('\n').map(l => '   ' + l).join('\n'));
}
console.log(`\n${'='.repeat(72)}`);
console.log(failed === 0
  ? 'PREFLIGHT CLEAN — live and backtest agree on every field any variant sets.'
  : `PREFLIGHT FAILED (${failed} of ${CHECKS.length}) — reconcile before deploying.`);
console.log('='.repeat(72) + '\n');
process.exit(failed ? 1 : 0);
