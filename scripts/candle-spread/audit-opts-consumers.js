#!/usr/bin/env node
'use strict';
/**
 * audit-opts-consumers.js — does every CONSUMER of the variant config accept every LIVE variant?
 *
 * ENGINE PARITY asks "do both engines implement field X". This asks the different question that let a
 * regression through on 2026-09-23: does each consumer that maps a variant onto engine opts actually
 * FORWARD every field the variant carries?
 *
 * The capital trigger was added to the live deps and to the 5m engine, and parity passed — both engines
 * implement it. But the shared optsFor (backtest/opts-for.js), used by run-day-record and
 * build-backtest-baselines, did not forward it. The variant contract refused to run, so EVERY on-demand
 * backtest answered HTTP 500 and the compare page's overlay went dark for every date, while preflight
 * reported CLEAN. The contract guard did its job; nothing was asking it before a deploy.
 *
 * Exit 1 if any (consumer, variant) pair throws. Exit 0 only after actually exercising all of them —
 * a consumer that cannot be loaded is a FAILURE here, not a skip, because "I could not check" and
 * "I checked and it is fine" must never print the same thing.
 */
const { buildRuns } = require('../../server/src/candle-spread/index');

const CONSUMERS = [
  {
    name: 'backtest/opts-for.js optsFor',
    used_by: 'run-day-record (the on-demand /backtest endpoint) + build-backtest-baselines',
    run: (v) => {
      const { optsFor } = require('../../server/src/candle-spread/backtest/opts-for');
      return optsFor(v, { intradayIV: true, hasPx: true, noWings: false, where: 'audit-opts-consumers' });
    },
  },
];

const runs = buildRuns();
if (!runs.length) { console.error('FAIL: buildRuns() returned no variants — nothing was checked.'); process.exit(1); }

let failures = 0, checked = 0;
console.log(`\nOPTS CONSUMERS — ${runs.length} live variants x ${CONSUMERS.length} consumer(s)\n`);
for (const c of CONSUMERS) {
  const bad = [];
  for (const v of runs) {
    checked++;
    try { c.run(v); } catch (e) { bad.push({ variant: v.variant, msg: (e && e.message) || String(e) }); }
  }
  if (bad.length) {
    failures += bad.length;
    console.log(`  ✗ ${c.name}`);
    console.log(`      used by: ${c.used_by}`);
    const byMsg = new Map();
    for (const b of bad) byMsg.set(b.msg, (byMsg.get(b.msg) || []).concat(b.variant));
    for (const [msg, vs] of byMsg) {
      console.log(`      ${vs.length} variant(s): ${vs.slice(0, 4).join(', ')}${vs.length > 4 ? ' …' : ''}`);
      console.log(`        ${msg}`);
    }
  } else {
    console.log(`  ✓ ${c.name}  — all ${runs.length} variants accepted`);
  }
}
console.log(`\n${checked} (consumer, variant) pairs exercised.`);
if (failures) {
  console.log(`\nA consumer that drops a field runs a DIFFERENT strategy than the one the variant names.`);
  process.exit(1);
}
process.exit(0);
