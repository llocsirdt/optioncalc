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

const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;
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

/**
 * The sweep, as a function, so the SERVER can run it at boot.
 *
 * WHY THE SERVER AND NOT ONLY THE DEPLOY HOOK. The 2026-09-17 deploy proved the hook cannot do this job:
 * it runs as a user that may create files in the 1777 store directory but cannot overwrite a record the
 * app owns, so the rewrite failed EACCES while the backup sweep succeeded. The app has the right identity
 * by construction -- it wrote those records -- so it is the only thing that can reliably repair them.
 * Costs one stat per file when the store is healthy, which is the normal case.
 */
function sweepStore(options) {
  const opts = Object.assign({ apply: true, minSize: 5e6, maxSize: 400e6, bakDays: 7, log: console.log }, options || {});
  const console_log = opts.log;
  const rows = store.listRunFiles().map((id) => {
    let size = 0;
    try { size = fs.statSync(store.runFilePath(id)).size; } catch (_) { /* gone */ }
    return { id, size };
  }).filter((r) => r.size >= opts.minSize).sort((a, b) => b.size - a.size);
  if (!rows.length) { console_log(`prune: nothing over ${mb(opts.minSize)} — store is healthy`); return { scanned: 0, rewritten: 0, freed: 0, reclaimed: 0, problems: [] }; }
  let touched = 0, freed = 0, reclaimed = 0;
  const problems = [];
  // ORPHANED BACKUPS from a previous failed run. A .bak is only worth keeping while it differs from the
  // record beside it; one left by a prune that never completed its rewrite is a byte-for-byte duplicate,
  // so it is pure waste. Only removed when the live record is still LARGER than the sane threshold —
  // i.e. the prune it belonged to demonstrably did not take effect.
  try {
    for (const f of fs.readdirSync(store.RUNS_DIR)) {
      const m = /^(.*\.json)\.[0-9TZ-]+\.bak$/.exec(f);
      if (!m) continue;
      const live = path.join(store.RUNS_DIR, m[1]);
      const bakPath = path.join(store.RUNS_DIR, f);
      let liveSize = 0;
      try { liveSize = fs.statSync(live).size; } catch (_) { continue; }   // no record beside it — leave it alone
      // Two reasons to remove one: the record beside it was never rewritten (so the backup is a
      // byte-for-byte duplicate of it — the 2026-09-17 failure), or it has simply aged out. Run BEFORE
      // the prune below, or a backup this run is about to create would be judged against a record this
      // run already shrank.
      const ageDays = (Date.now() - fs.statSync(bakPath).mtimeMs) / 864e5;
      const orphaned = liveSize >= opts.minSize;          // record still runaway => that prune never took
      if (!orphaned && ageDays < opts.bakDays) continue;  // a real backup, still inside its retention
      const bs = fs.statSync(bakPath).size;
      fs.unlinkSync(bakPath);
      reclaimed += bs;
      console_log(`prune: removed backup ${f} (${mb(bs)}) — ${orphaned ? 'its record was never rewritten' : `older than ${opts.bakDays} days`}`);
    }
  } catch (e) { console_log(`prune: backup sweep failed — ${e.message}`); }

  for (const r of rows) {
    if (r.size > opts.maxSize) { console_log(`prune: SKIP ${r.id} — ${mb(r.size)} exceeds the ${mb(opts.maxSize)} parse cap`); problems.push(`${r.id}: over parse cap`); continue; }
    // WRITABILITY FIRST. The 2026-09-17 deploy copied a 65 MB backup and only THEN failed to rewrite the
    // record, leaving an orphan that made the store bigger — the opposite of the job. The store dir is
    // 1777 (sticky, world-writable), so CREATING a .bak always succeeds even when truncating a record
    // owned by another user does not. Check the thing that can actually fail before doing the thing that
    // leaves a mess.
    try { fs.accessSync(store.runFilePath(r.id), fs.constants.W_OK); }
    catch (e) { console_log(`prune: SKIP ${r.id} — not writable by ${process.getuid ? 'uid ' + process.getuid() : 'this user'} (${e.code})`); problems.push(`${r.id}: not writable (${e.code})`); continue; }
    try {
      const rec = store.readRun(r.id);
      if (!rec || !rec.state || !Array.isArray(rec.state.positions)) { console_log(`prune: SKIP ${r.id} — unreadable`); problems.push(`${r.id}: unreadable`); continue; }
      const kept = collapse(rec.state.positions);
      const dropped = rec.state.positions.length - kept.length;
      if (!dropped) { console_log(`prune: ${r.id} — ${mb(r.size)}, no duplicate runs, left alone`); continue; }
      if (!opts.apply) { console_log(`prune: ${r.id} — WOULD remove ${dropped.toLocaleString()} duplicate hedges (dry run)`); continue; }
      const bak = `${store.runFilePath(r.id)}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
      fs.copyFileSync(store.runFilePath(r.id), bak);
      rec.state.positions = kept;
      try { store.writeRun(rec); }
      catch (e) {
        // The rewrite is the only step that can half-succeed. If it fails, take the backup back out
        // rather than leaving a duplicate of an unchanged record on the disk we are trying to free.
        try { fs.unlinkSync(bak); } catch (_) { /* nothing better to do */ }
        throw e;
      }
      const after = fs.statSync(store.runFilePath(r.id)).size;
      touched++; freed += r.size - after;
      console_log(`prune: ${r.id} — removed ${dropped.toLocaleString()} duplicate hedges, ${mb(r.size)} -> ${mb(after)}`);
    } catch (e) {
      console_log(`prune: SKIP ${r.id} — ${e.message}`);
      problems.push(`${r.id}: ${e.message}`);
    }
  }
  // A STATUS FILE, because `|| true` in the deploy hook means nobody ever sees stdout. On 2026-09-17 the
  // prune half-ran and the only evidence was the store getting 65 MB BIGGER. /health surfaces this.
  try {
    fs.writeFileSync(path.join(store.RUNS_DIR, '_prune-last.json'), JSON.stringify({
      when: new Date().toISOString(), apply: opts.apply, scanned: rows.length,
      // WHO RAN IT, and who owns what it tried to write. The 2026-09-17 failure was EACCES on a record
      // this process could not overwrite even though it could create files in the same directory (1777,
      // sticky). Naming both uids turns that from a guess into a read.
      ranAs: (() => { try { return { uid: process.getuid(), gid: process.getgid() }; } catch (e) { return null; } })(),
      storeOwner: (() => { try { const st = fs.statSync(store.RUNS_DIR); return { uid: st.uid, gid: st.gid, mode: (st.mode & 0o7777).toString(8) }; } catch (e) { return null; } })(),
      sampleRecordOwner: (() => { try { const f = rows[0] && store.runFilePath(rows[0].id); if (!f) return null; const st = fs.statSync(f); return { uid: st.uid, gid: st.gid, mode: (st.mode & 0o7777).toString(8) }; } catch (e) { return null; } })(),
      rewritten: touched, freedMB: Math.round(freed / 1e5) / 10,
      reclaimedMB: Math.round(reclaimed / 1e5) / 10, problems,
    }, null, 2), 'utf8');
    try { fs.chmodSync(path.join(store.RUNS_DIR, '_prune-last.json'), 0o644); } catch (_) { /* best effort */ }
  } catch (e) { /* non-fatal, as ever */ }
  if (reclaimed) console_log(`prune: reclaimed ${mb(reclaimed)} of orphaned backups`);
  console_log(`prune: ${touched} record(s) rewritten, ${mb(freed)} freed`);
  
  return { scanned: rows.length, rewritten: touched, freed, reclaimed, problems };
}

module.exports = { collapse, fingerprint, isHedge, sweepStore };

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
// How long a backup from a SUCCESSFUL prune is kept. It holds thousands of duplicate copies of one hedge,
// so it is worth space only as a short rollback window; the local archive is the real durable copy.
const BAK_DAYS = numArg('--bak-days', 7);
const runId = args.find((a) => !a.startsWith('--') && !/^\d+(\.\d+)?(e\d+)?$/i.test(a));

// A hedge's identity for de-duplication. Legs are sorted so an ordering difference between two otherwise
// identical hedges cannot hide a duplicate.
if (ALL) {
  const r = sweepStore({ apply: APPLY, minSize: MIN_SIZE, maxSize: MAX_SIZE, bakDays: BAK_DAYS });
  console.log(`prune: ${r.rewritten} record(s) rewritten, ${mb(r.freed)} freed`);
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
