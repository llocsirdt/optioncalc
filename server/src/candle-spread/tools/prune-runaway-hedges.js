#!/usr/bin/env node
'use strict';
/**
 * prune-runaway-hedges.js — repair a run record bloated by the 2026-09-16 floor-offset loop.
 *
 * WHAT HAPPENED: making hedges rest killed all three exits of the `while` in buyFloorOffsets (offCount
 * and offSpent only move on FILL, and a pending hedge is filtered out of the book the floor is computed
 * from, so the floor never moved either). The loop pushed the SAME offset position once per iteration for
 * hours. v5-40-cATM ended the day with 32,411 positions, ~32,400 of them identical copies, and every one
 * of them triggered a full rewrite of the record. Fixed in d08641c; this cleans up what it left behind.
 *
 * WHY IT STILL MATTERS AFTER THE FIX: the record is ~100 MB. Listing the store no longer parses it (see
 * the summary sidecars in store.js), but GET /runs/:symbol/:expiration?variant=... still answers with the
 * WHOLE record — so opening that one variant in the debug UI parses and serialises 100 MB in one go, on
 * an instance with a history of OOM from exactly that shape of transient spike.
 *
 * WHAT IT DOES: collapses runs of consecutive DUPLICATE hedge positions — same legs, same limit, same
 * side — to a single copy. Real trades are never touched: a position is only ever removed when an
 * identical one is already in the book, which is precisely the signature of the loop and never the
 * signature of a hedge the engine meant to buy.
 *
 * Usage (on the instance, after `eb ssh`):
 *   node /var/app/current/src/candle-spread/tools/prune-runaway-hedges.js --list
 *   node /var/app/current/src/candle-spread/tools/prune-runaway-hedges.js <runId> [--apply]
 *
 * Dry-run by default: it reports what it WOULD remove and writes nothing without --apply. A timestamped
 * .bak of the original sits beside the record so a bad prune is always reversible.
 */
const fs = require('fs');
const path = require('path');
const store = require('../store');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const runId = args.find((a) => !a.startsWith('--'));
const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;

// A hedge's identity for de-duplication. Legs are sorted so an ordering difference between two otherwise
// identical hedges cannot hide a duplicate.
function fingerprint(p) {
  const legs = (p.legs || []).map((l) => `${l.side}${l.type}${l.strike}`).sort().join('|');
  return `${p.side || ''}::${legs}::${p.limit}`;
}
const isHedge = (p) => p && (p.side === 'hedge' || p.hedge === true);

if (!runId) {
  const rows = store.listRunFiles().map((id) => {
    let size = 0;
    try { size = fs.statSync(store.runFilePath(id)).size; } catch (_) { /* gone */ }
    return { id, size };
  }).sort((a, b) => b.size - a.size);
  console.log('Largest run records:\n');
  for (const r of rows.slice(0, 12)) console.log(`  ${mb(r.size).padStart(9)}  ${r.id}`);
  console.log('\nPass a runId to inspect it; add --apply to rewrite it.');
  process.exit(0);
}

const file = store.runFilePath(runId);
if (!fs.existsSync(file)) { console.error(`No such run record: ${file}`); process.exit(1); }
const before = fs.statSync(file).size;
console.log(`${runId}\n  record   ${mb(before)}`);

const rec = store.readRun(runId);
if (!rec) { console.error('Record could not be parsed.'); process.exit(1); }
const pos = (rec.state && rec.state.positions) || [];
console.log(`  positions ${pos.length.toLocaleString()} (${pos.filter(isHedge).length.toLocaleString()} hedges)`);

// Collapse CONSECUTIVE duplicates only. A hedge legitimately re-bought later in the day, after other
// trades happened in between, is a real decision and is kept — the loop's signature is an unbroken run.
const kept = [];
let dropped = 0, lastFp = null;
for (const p of pos) {
  const fp = isHedge(p) ? fingerprint(p) : null;
  if (fp !== null && fp === lastFp) { dropped++; continue; }
  kept.push(p);
  lastFp = fp;
}
console.log(`  duplicate hedge copies to remove: ${dropped.toLocaleString()}`);
console.log(`  positions after prune:            ${kept.length.toLocaleString()}`);

if (!dropped) { console.log('\nNothing to do.'); process.exit(0); }
if (!APPLY) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply to rewrite the record.');
  process.exit(0);
}

const bak = `${file}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
fs.copyFileSync(file, bak);
rec.state.positions = kept;
// Through store.writeRun so the summary sidecar is refreshed in the same step; a pruned record with a
// stale sidecar would keep reporting the old position count to the UI.
store.writeRun(rec);
const after = fs.statSync(file).size;
console.log(`\n  backup   ${bak}`);
console.log(`  rewrote  ${mb(before)} -> ${mb(after)}  (${(100 * (1 - after / before)).toFixed(1)}% smaller)`);
console.log('\nDone. Delete the .bak once the record reads correctly in the UI.');
