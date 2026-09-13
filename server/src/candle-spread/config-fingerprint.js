'use strict';
/**
 * config-fingerprint.js — a short hash of WHAT THE STRATEGIES CURRENTLY ARE.
 *
 * WHY. Backtest artefacts fall into two kinds, and only one of them is safe to cache across a change:
 *   BARS (day-builder)  — market data. Config-independent, so they stay valid forever and the expensive
 *                         Schwab fetch is never wasted.
 *   RUNS / BUNDLES      — the result of applying a STRATEGY to those bars. These go stale the moment any
 *                         variant's config changes, and they are cached on disk, so a served bundle can
 *                         silently show yesterday's strategy under today's name.
 *
 * That already happened once: on 2026-09-12 a replay bundle built at 12:39 predated the minLock A/B and
 * the cap spread wired later the same afternoon, and the compare overlay would have drawn the old
 * strategies with no indication anything was wrong. It was caught by hand; nothing in the system would
 * have caught it.
 *
 * The fingerprint closes that by construction. It hashes every variant's engine-visible config plus the
 * build commit, so ANY strategy change — a new flag, a different minLock, a changed default, a rebuilt
 * package — produces a different value. A cached artefact whose stamp does not match the current one is
 * not served; it is rebuilt. No manual purge step to remember, which matters because the failure is
 * silent and the manual step is exactly what gets forgotten.
 */
const crypto = require('crypto');

let _fp = null;

function fingerprint() {
  if (_fp) return _fp;                       // config is fixed for the life of the process
  let payload = '';
  try {
    const { buildRuns } = require('./index');
    // Sort keys so an incidental reordering in index.js does not invalidate every cache for no reason.
    const runs = buildRuns().map((r) => {
      const o = {};
      for (const k of Object.keys(r).sort()) {
        const v = r[k];
        if (typeof v === 'function' || v === undefined) continue;   // signalFn is identity, not config
        o[k] = v;
      }
      return o;
    }).sort((a, b) => String(a.variant).localeCompare(String(b.variant)));
    payload = JSON.stringify(runs);
  } catch (e) { payload = 'unbuildable:' + (e && e.message); }
  // The build commit covers ENGINE changes the variant config cannot see — a fix to cover pricing or the
  // ladder changes results without changing a single variant field.
  let build = '';
  try { build = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'build-info.json'), 'utf8')).gitCommit || ''; }
  catch (e) { /* dev tree without a build stamp — config alone still catches strategy edits */ }
  _fp = crypto.createHash('sha256').update(payload + '|' + build).digest('hex').slice(0, 12);
  return _fp;
}

module.exports = { fingerprint };
