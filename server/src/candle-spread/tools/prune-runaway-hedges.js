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
 *
 * --all [--apply] sweeps every record and is what the DEPLOY HOOK runs (see .ebextensions). It is built
 * to be safe in that position rather than thorough: only records over --min-size are even opened (a clean
 * store costs one stat per file and nothing else), anything over --max-size is skipped rather than parsed
 * so a pathological file can never OOM a deploy, and it ALWAYS exits 0 — a cleanup that fails must not
 * fail the deploy that carries it.
 */
const fs = require('fs');
const path = require('path');
const store = require('../store');

function fingerprint(p) {
  const legs = (p.legs || []).map((l) => `${l.side}${l.type}${l.strike}`).sort().join('|');
  return `${p.side || ''}::${legs}::${p.limit}`;
}
const isHedge = (p) => p && (p.side === 'hedge' || p.hedge === true);

// Collapse CONSECUTIVE duplicate hedges only. A hedge legitimately re-bought later in the day, after
// other trades happened in between, is a real decision and is kept — the loop's signature is an unbroken
// run of identical copies. Non-hedge positions always break the run and are never removed.
function collapse(positions) {
  const kept = [];
  let lastFp = null;
  for (const p of positions) {
    const fp = isHedge(p) ? fingerprint(p) : null;
    if (fp !== null && fp === lastFp) continue;
    kept.push(p);
    lastFp = fp;
  }
  return kept;
}

// SWEEP MODE — every record, biggest first. Used by the deploy hook.
// Exported so the suite can drive the collapse rule directly. This runs on EVERY DEPLOY with --apply
// (see .ebextensions), so a bug here would silently delete real positions rather than duplicates —
// which makes it the one part of this file that genuinely needs tests.
module.exports = { collapse, fingerprint, isHedge };

// Nothing below runs on require — only when invoked as a script.
if (require.main !== module) return;

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const ALL = args.includes('--all');
const numArg = (flag, dflt) => { const i = args.indexOf(flag); const v = i >= 0 ? Number(args[i + 1]) : NaN; return Number.isFinite(v) ? v : dflt; };
// Only bother with records big enough to be a problem. A healthy full day is a few hundred KB; the
// 2026-09-16 runaway was ~100 MB. 5 MB is comfortably above normal and far below pathological.
const MIN_SIZE = numArg('--min-size', 5e6);
// Refuse to PARSE anything above this. JSON.parse of a huge record allocates several times the file size,
// and the deploy hook shares a 1.9 GB box with the running app.
const MAX_SIZE = numArg('--max-size', 400e6);
const runId = args.find((a) => !a.startsWith('--') && !/^\d+(\.\d+)?(e\d+)?$/i.test(a));
const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;

// A hedge's identity for de-duplication. Legs are sorted so an ordering difference between two otherwise
// identical hedges cannot hide a duplicate.
if (ALL) {
  const rows = store.listRunFiles().map((id) => {
    let size = 0;
    try { size = fs.statSync(store.runFilePath(id)).size; } catch (_) { /* gone */ }
    return { id, size };
  }).filter((r) => r.size >= MIN_SIZE).sort((a, b) => b.size - a.size);
  if (!rows.length) { console.log(`prune: nothing over ${mb(MIN_SIZE)} — store is healthy`); process.exit(0); }
  let touched = 0, freed = 0;
  for (const r of rows) {
    if (r.size > MAX_SIZE) { console.log(`prune: SKIP ${r.id} — ${mb(r.size)} exceeds the ${mb(MAX_SIZE)} parse cap`); continue; }
    try {
      const rec = store.readRun(r.id);
      if (!rec || !rec.state || !Array.isArray(rec.state.positions)) { console.log(`prune: SKIP ${r.id} — unreadable`); continue; }
      const kept = collapse(rec.state.positions);
      const dropped = rec.state.positions.length - kept.length;
      if (!dropped) { console.log(`prune: ${r.id} — ${mb(r.size)}, no duplicate runs, left alone`); continue; }
      if (!APPLY) { console.log(`prune: ${r.id} — WOULD remove ${dropped.toLocaleString()} duplicate hedges (dry run)`); continue; }
      fs.copyFileSync(store.runFilePath(r.id), `${store.runFilePath(r.id)}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`);
      rec.state.positions = kept;
      store.writeRun(rec);
      const after = fs.statSync(store.runFilePath(r.id)).size;
      touched++; freed += r.size - after;
      console.log(`prune: ${r.id} — removed ${dropped.toLocaleString()} duplicate hedges, ${mb(r.size)} -> ${mb(after)}`);
    } catch (e) {
      // NEVER fail the deploy over a cleanup.
      console.log(`prune: SKIP ${r.id} — ${e.message}`);
    }
  }
  console.log(`prune: ${touched} record(s) rewritten, ${mb(freed)} freed`);
  process.exit(0);
}

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

const kept = collapse(pos);
const dropped = pos.length - kept.length;
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
