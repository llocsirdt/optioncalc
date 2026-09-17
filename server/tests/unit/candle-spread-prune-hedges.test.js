'use strict';
// PRUNE COLLAPSE RULE. This runs on EVERY DEPLOY with --apply (see server/.ebextensions), unattended,
// against the live run store. A bug here deletes real trading history rather than the duplicate copies
// the 2026-09-16 floor-offset loop left behind, and nobody would be watching when it happened. So the
// rule is pinned from both directions: what it MUST remove, and — more important — everything it must
// never touch.
//
// Run: node server/tests/unit/candle-spread-prune-hedges.test.js
const { collapse, fingerprint, isHedge } = require('../../src/candle-spread/tools/prune-runaway-hedges');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

const hedge = (lo, hi, limit) => ({ side: 'hedge', hedge: true, filled: true, limit,
  legs: [{ side: 'long', type: 'C', strike: lo }, { side: 'short', type: 'C', strike: hi }] });
const spread = (id, lo, hi) => ({ id, side: 'bull', filled: true, limit: 9,
  legs: [{ side: 'long', type: 'C', strike: lo }, { side: 'short', type: 'C', strike: hi }] });

// ── WHAT IT MUST REMOVE ─────────────────────────────────────────────────────────────────────────────
{
  const run = [spread('r1', 29000, 29040), ...Array.from({ length: 5000 }, () => hedge(28930, 28950, 1.65))];
  const kept = collapse(run);
  ok(kept.length === 2, `collapses an unbroken run to one copy (got ${kept.length})`);
  ok(kept[0].id === 'r1', 'the real spread survives and stays first');
  ok(isHedge(kept[1]) && kept[1].limit === 1.65, 'one copy of the hedge is kept, not zero');
}

// ── WHAT IT MUST NEVER TOUCH ────────────────────────────────────────────────────────────────────────
{
  // Real positions are never de-duplicated, even when genuinely identical: opening the same spread twice
  // is ordinary trading, and only the hedge loop produced identical consecutive copies.
  const dupSpreads = [spread('a', 29000, 29040), spread('b', 29000, 29040), spread('c', 29000, 29040)];
  ok(collapse(dupSpreads).length === 3, 'identical non-hedge positions are all kept');

  // A hedge re-bought later, after other activity, is a real decision. Only an UNBROKEN run is the bug.
  const reBought = [hedge(28930, 28950, 1.65), spread('r1', 29000, 29040), hedge(28930, 28950, 1.65)];
  ok(collapse(reBought).length === 3, 'a hedge re-bought after other activity is kept');

  // Different strikes or a different price are different hedges.
  ok(collapse([hedge(28930, 28950, 1.65), hedge(28940, 28960, 1.65)]).length === 2, 'different strikes are not duplicates');
  ok(collapse([hedge(28930, 28950, 1.65), hedge(28930, 28950, 2.10)]).length === 2, 'a different limit is not a duplicate');

  // A clean book must come back completely untouched — the overwhelmingly common case on every deploy.
  const clean = [spread('a', 29000, 29040), hedge(28930, 28950, 1.65), spread('b', 29100, 29140), hedge(29200, 29220, 0.9)];
  const keptClean = collapse(clean);
  ok(keptClean.length === clean.length, 'a healthy book is returned unchanged');
  ok(JSON.stringify(keptClean) === JSON.stringify(clean), 'and in the same order, byte for byte');

  ok(collapse([]).length === 0, 'an empty book is handled');
}

// ── IDENTITY ────────────────────────────────────────────────────────────────────────────────────────
{
  // Leg ORDER must not hide a duplicate — the engine builds legs consistently, but a record edited or
  // rewritten by another tool need not preserve it, and a missed duplicate is the failure that matters.
  const a = hedge(28930, 28950, 1.65);
  const b = { ...a, legs: [a.legs[1], a.legs[0]] };
  ok(fingerprint(a) === fingerprint(b), 'leg order does not change a hedge fingerprint');
  ok(collapse([a, b]).length === 1, 'and a reordered duplicate still collapses');

  // Both spellings of "this is a hedge" are recognised; the loop wrote side:'hedge', older records the flag.
  ok(isHedge({ side: 'hedge' }) && isHedge({ hedge: true }), 'both hedge markers are recognised');
  ok(!isHedge({ side: 'bull' }) && !isHedge(null), 'a real position is not a hedge, and null is safe');
}

// ── THE FAILED-DEPLOY SHAPE (2026-09-17) ────────────────────────────────────────────────────────────
// The hook copied a 65 MB backup, failed to rewrite the record, and `|| true` swallowed the error. The
// only symptom was the store getting BIGGER. Two behaviours pin that: a backup left beside an UNCHANGED
// record is reclaimed, and the sweep runs BEFORE the prune so a backup this run creates is not judged
// against a record this run already shrank.
{
  const os = require('os'), path = require('path'), fs = require('fs');
  const { execFileSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-prune-'));
  const tool = path.join(__dirname, '..', '..', 'src', 'candle-spread', 'tools', 'prune-runaway-hedges.js');
  const env = { ...process.env, CANDLE_SPREAD_RUNS_DIR: dir };
  // A runaway record plus the orphaned backup a half-finished prune leaves behind.
  execFileSync(process.execPath, ['-e', `
    const store = require(${JSON.stringify(path.join(__dirname, '..', '..', 'src', 'candle-spread', 'store.js'))});
    const fs = require('fs');
    const rec = store.initRun({ symbol:'NDX', expiration:'2026-09-16', variant:'vX', spreadWidth:40 }, '2026-09-16');
    const dup = { side:'hedge', hedge:true, filled:true, limit:1.65,
      legs:[{side:'long',type:'C',strike:28930},{side:'short',type:'C',strike:28950}] };
    rec.state.positions = [{ id:'r1', side:'bull', filled:true, limit:9,
      legs:[{side:'long',type:'C',strike:29000},{side:'short',type:'C',strike:29040}] },
      ...Array.from({length:40000},()=>JSON.parse(JSON.stringify(dup)))];
    store.writeRun(rec);
    fs.copyFileSync(store.runFilePath(rec.runId), store.runFilePath(rec.runId)+'.2026-09-17T03-33-00-000Z.bak');
  `], { env, encoding: 'utf8' });

  const bytes = () => fs.readdirSync(dir).filter(f => fs.statSync(path.join(dir, f)).isFile())
    .reduce((a, f) => a + fs.statSync(path.join(dir, f)).size, 0);
  const before = bytes();
  const out = execFileSync(process.execPath, [tool, '--all', '--apply'], { env, encoding: 'utf8' });
  const after = bytes();

  ok(/never rewritten/.test(out), 'the orphaned backup is identified and removed');
  ok(after < before, `the store SHRINKS (${(before / 1e6).toFixed(1)}MB -> ${(after / 1e6).toFixed(1)}MB)`);
  ok(!fs.readdirSync(dir).some(f => /2026-09-17T03-33-00/.test(f)), 'the orphan is gone');
  // The status file is the whole point: `|| true` means stdout goes nowhere on a real deploy.
  const st = JSON.parse(fs.readFileSync(path.join(dir, '_prune-last.json'), 'utf8'));
  ok(st.rewritten === 1, `status records the rewrite (${st.rewritten})`);
  ok(st.reclaimedMB > 0, `status records the reclaim (${st.reclaimedMB}MB)`);
  ok(Array.isArray(st.problems) && st.problems.length === 0, 'and reports no problems on a clean run');
  // Idempotent: a second pass must not touch the fresh backup or the pruned record.
  const out2 = execFileSync(process.execPath, [tool, '--all', '--apply'], { env, encoding: 'utf8' });
  ok(/store is healthy/.test(out2), 'a second run finds nothing to do');
  ok(bytes() === after, 'and changes nothing');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
