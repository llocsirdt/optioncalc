'use strict';
/**
 * INTRADAY IV TERM STRUCTURE — the time-of-day multiplier on implied vol.
 *
 * Measured off the captured chains (scripts/candle-spread/calibrate-intraday-iv.js). Vol is not flat
 * across the session: it runs ~1.27x the band-width estimate at the open and decays to ~0.84x into the
 * close. Every backtest baseline is built with this applied (`intradayIV: true`).
 *
 * WHY THIS LIVES IN shared/. It used to be reachable only from scripts/ via data/intraday-iv-correction.json,
 * so the LIVE engine could not apply it — and did not. The live wing band was therefore sized off raw
 * band-width vol while the backtest sized it off vol × this multiplier, making live bands ~21% too narrow
 * at the open and ~19% too wide into the close relative to the numbers the strategy was chosen on. The
 * deploy package zips server/ only (following the server/shared symlink), so a calibration sitting in
 * data/ could never have shipped. Both the engine and the backtest now read this one file.
 */
const fs = require('fs');
const path = require('path');

let _corr = null;
function load() {
  if (_corr) return _corr;
  const p = path.join(__dirname, 'intraday-iv-correction.json');
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  const pts = Object.entries(j.perBucket)
    .map(([k, m]) => { const [h, mm] = k.split(':').map(Number); return { min: h * 60 + mm, mult: m }; })
    .filter((x) => x.mult != null)
    .sort((a, b) => a.min - b.min);
  _corr = { minutes: pts.map((p2) => p2.min), mults: pts.map((p2) => p2.mult), meta: j.meta || null };
  return _corr;
}

// Linear interpolation of the multiplier at ET minute-of-day; clamped to the endpoints outside the table.
function ivMultAt(minOfDay) {
  const c = load(), M = c.minutes, V = c.mults, n = M.length;
  if (!n) return 1;
  if (minOfDay <= M[0]) return V[0];
  if (minOfDay >= M[n - 1]) return V[n - 1];
  for (let i = 1; i < n; i++) if (minOfDay <= M[i]) { const t = (minOfDay - M[i - 1]) / (M[i] - M[i - 1]); return V[i - 1] + t * (V[i] - V[i - 1]); }
  return V[n - 1];
}

module.exports = { ivMultAt, load };
