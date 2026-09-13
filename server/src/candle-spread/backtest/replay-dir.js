'use strict';
/**
 * replay-dir.js — ONE resolver for where replay bundles live.
 *
 * This exists because having the answer in two places was already a production bug. The generator got the
 * durability ladder (so it can write on the deployed box, where server/ IS the app root and a repo-relative
 * data/ dir resolves outside it) while the route kept the old repo-relative constant. The child then wrote
 * the bundle, exited 0, and the route looked somewhere else and reported "Could not generate that replay"
 * with an empty detail — a 500 that says nothing, from two paths that merely had to agree.
 *
 * Both sides now import this. A path pair that must match should not be written down twice.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

let _dir = null;

function replayDir() {
  if (_dir) return _dir;
  const cands = [
    process.env.CANDLE_REPLAY_DIR,
    '/var/optioncalc-data/backtest-replays',                                   // EB: survives a deploy
    path.join(__dirname, '..', '..', '..', '..', 'data', 'backtest-replays'),  // dev tree
    path.join(os.tmpdir(), 'backtest-replays'),                                // last resort
  ].filter(Boolean);
  for (const d of cands) {
    try { fs.mkdirSync(d, { recursive: true }); fs.accessSync(d, fs.constants.W_OK); _dir = d; return _dir; }
    catch (e) { /* next */ }
  }
  _dir = path.join(os.tmpdir(), 'backtest-replays');
  return _dir;
}

module.exports = { replayDir };
