'use strict';
/**
 * PARALLEL SWEEP — fork self, slice the work units, merge the results.
 *
 * Every candle-spread sweep has the same shape: a handful of ARMS, each run over a panel of variants over
 * ~765 days. That is CPU-bound and perfectly independent per (arm, variant), and it was all running on one
 * core. Measured on the baseline build: 3801s of CPU work finished in 597s wall on 8 workers — 6.4x.
 * See feedback_always_parallelize_backtests.
 *
 * WHY A SHARED HELPER RATHER THAN COPYING THE PATTERN. The fork/slice/merge is ten lines, but two of them
 * are traps, and one of them has already cost a night:
 *
 *   1. THE CHILD MUST INHERIT EVERY ARM-DEFINING FLAG. build-backtest-baselines forwarded its flags by
 *      hand, and when --orderSlipTicks was added it was passed to the workers but swallowed by a local
 *      wrapper — five sweep arms, fifty minutes, and every one of them silently ran the control. Here the
 *      child inherits the parent's WHOLE argv (minus --workers), so a new flag is forwarded by
 *      construction and there is nothing to remember.
 *   2. RESULTS MUST BE ORDERED BY THE CALLER, NOT BY SCHEDULING. Workers finish out of order. This returns
 *      a keyed object and the caller prints in its own canonical order, so a table is comparable between
 *      runs rather than reflecting which core happened to win.
 *
 * USAGE — call it EARLY, before any output:
 *
 *     const { parallelMap, workerCount } = require('./lib/parallel');
 *     const units = [];                                    // one entry per independent piece of work
 *     for (const arm of ARMS) for (const v of PANEL) units.push({ key: `${arm.label}|${v}`, arm, v });
 *     const results = await parallelMap(units, (u) => runOne(u.v, u.arm));
 *     for (const arm of ARMS) { ... read results[`${arm.label}|${v}`] ... }   // canonical order
 *
 * The child computes its stride and EXITS inside parallelMap, so nothing after the call runs there — the
 * table is printed once, by the parent. With --workers absent or 1 it runs inline and forks nothing, which
 * keeps a serial run available as the reference when checking that a parallel refactor did not change the
 * numbers.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

function workerCount(argv = process.argv) {
  const i = argv.indexOf('--workers');
  if (i < 0) return 1;
  const n = Number(argv[i + 1]);
  return Number.isFinite(n) ? Math.max(1, Math.min(16, Math.floor(n))) : 1;
}

const sliceOf = (argv) => { const i = argv.indexOf('--_slice'); return i < 0 ? null : { k: Number(argv[i + 1]), n: Number(argv[i + 2]) }; };
const outOf = (argv) => { const i = argv.indexOf('--_out'); return i < 0 ? null : argv[i + 1]; };

// units: [{ key, ... }] — `key` must be unique and stable. compute(unit) -> JSON-serializable.
// Returns an object keyed by unit.key. In a forked child this NEVER returns: it writes and exits.
async function parallelMap(units, compute) {
  const argv = process.argv;
  const slice = sliceOf(argv);

  if (slice) {                                   // ── CHILD: compute my stride, write, exit
    const mine = {};
    for (let i = slice.k; i < units.length; i += slice.n) {
      const u = units[i];
      mine[u.key] = await compute(u);
    }
    const out = outOf(argv);
    if (!out) { console.error('parallel: worker has --_slice but no --_out'); process.exit(2); }
    fs.writeFileSync(out, JSON.stringify(mine), 'utf8');
    process.exit(0);
  }

  const n = Math.min(workerCount(argv), units.length);
  if (n <= 1) {                                  // ── SERIAL: the reference path
    const out = {};
    for (const u of units) out[u.key] = await compute(u);
    return out;
  }

  // ── PARENT: fork self n times, inheriting the whole command line except --workers.
  const base = [];
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--workers') { i++; continue; }
    base.push(argv[i]);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-parallel-'));
  const merged = {};
  try {
    await Promise.all(Array.from({ length: n }, (_, k) => new Promise((resolve, reject) => {
      const outFile = path.join(tmp, `slice-${k}.json`);
      const ch = spawn(process.execPath, [argv[1], ...base, '--_slice', String(k), String(n), '--_out', outFile],
        { stdio: ['ignore', 'ignore', 'inherit'] });     // stdout muted: the PARENT prints the table
      ch.on('error', reject);
      ch.on('close', (code) => {
        if (code !== 0) return reject(new Error(`worker ${k} exited ${code}`));
        if (!fs.existsSync(outFile)) return reject(new Error(`worker ${k} produced no result file`));
        try { Object.assign(merged, JSON.parse(fs.readFileSync(outFile, 'utf8'))); resolve(); }
        catch (e) { reject(new Error(`worker ${k} wrote unreadable JSON: ${e.message}`)); }
      });
    })));
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  }
  // EVERY unit must come back. A silently short merge would print a table missing rows, or worse, sum a
  // subset and compare it against a full control — the shape that made an arm look like a winner.
  const missing = units.filter((u) => !(u.key in merged)).map((u) => u.key);
  if (missing.length) throw new Error(`parallel: ${missing.length} unit(s) missing from the merge, e.g. ${missing.slice(0, 3).join(', ')}`);
  return merged;
}

module.exports = { parallelMap, workerCount };
