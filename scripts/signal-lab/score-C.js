#!/usr/bin/env node
'use strict';
/**
 * Hypothesis C — BAND-CROSS REVERSION.
 *   C1: a candle closing BELOW the lower Bollinger band -> bullish (recovers up into the band)
 *   C2: a candle closing ABOVE the upper band -> bearish (falls back into the band)
 * The user's specific claim is color-conditioned (green-below-lower is bullish; red-above-upper
 * is bearish), so we score the pure band-cross AND both color variants to see whether the color
 * actually adds edge. Everything is measured against the unconditional BASE RATE — a signal only
 * matters if it beats "what price does anyway."
 *
 * Metrics (all forward-looking from the signal candle's close, same timeframe):
 *   hit%   = fraction where price moved in the PREDICTED direction after k candles
 *   ret    = mean forward move in the predicted direction, index points (+ = as predicted)
 *   base   = same, unconditional over all candles (the drift to beat)
 *   lift   = ret - base ; z = (hit - baseHit)/SE  (>~2 ≈ unlikely to be noise)
 *   recover% = closed back inside the band within 4 candles (+ median bars to do so)
 *   MFE/MAE = avg best / worst excursion in the predicted dir over the next 4 candles
 *
 * Usage: node scripts/signal-lab/score-C.js [SYMBOL=NDX] [--tf 5m,15m,60m]
 */
const path = require('path');
const fs = require('fs');

const DATA = path.join(__dirname, '../../signal-lab-data');
const symbol = (process.argv.find((a, i) => i >= 2 && !a.startsWith('--')) || 'NDX').toUpperCase();
const tfArgI = process.argv.indexOf('--tf');
const TFS = tfArgI >= 0 ? process.argv[tfArgI + 1].split(',') : ['5m', '15m', '60m'];
const HORIZONS = [1, 2, 4];
const RECOVER_WIN = 4;

const ds = JSON.parse(fs.readFileSync(path.join(DATA, `dataset-${symbol}.json`), 'utf8'));

const green = c => c.close > c.open;
const red = c => c.close < c.open;
const etMinute = ms => {
  const s = new Date(ms).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' });
  const [h, m] = s.split(':').map(Number); return h * 60 + m;
};
const todBucket = ms => { const t = etMinute(ms); return t < 630 ? 'open' : t < 900 ? 'mid' : 'close'; };
const mean = a => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const pct = (n, d) => d ? Math.round((100 * n) / d) : 0;
const p1 = n => (n >= 0 ? '+' : '') + n.toFixed(1);

// dir: 'up' | 'down'. favorable forward move (predicted direction), in points.
const fav = (series, i, k, dir) => {
  if (i + k >= series.length) return null;
  const d = series[i + k].close - series[i].close;
  return dir === 'up' ? d : -d;
};

// The predicate family. The two the user hypothesized are flagged ★.
const PREDICATES = [
  { key: 'below-lower (any)', dir: 'up', star: false, test: c => c.percentB < 0 },
  { key: 'below-lower +GREEN ★', dir: 'up', star: true, test: c => c.percentB < 0 && green(c) },
  { key: 'below-lower +red', dir: 'up', star: false, test: c => c.percentB < 0 && red(c) },
  { key: 'above-upper (any)', dir: 'down', star: false, test: c => c.percentB > 1 },
  { key: 'above-upper +RED ★', dir: 'down', star: true, test: c => c.percentB > 1 && red(c) },
  { key: 'above-upper +green', dir: 'down', star: false, test: c => c.percentB > 1 && green(c) }
];

function baseStats(series, dir) {
  // unconditional forward stats per horizon, oriented to `dir`
  const out = {};
  for (const k of HORIZONS) {
    const favs = [];
    for (let i = 0; i < series.length; i++) { const f = fav(series, i, k, dir); if (f != null) favs.push(f); }
    out[k] = { hit: favs.filter(f => f > 0).length / (favs.length || 1), mean: mean(favs) };
  }
  return out;
}

function recovery(series, i, dir) {
  // bars until price closes back inside the band (dir up: close >= lower; down: close <= upper)
  for (let k = 1; k <= RECOVER_WIN; k++) {
    const c = series[i + k]; if (!c) break;
    if (dir === 'up' && c.bbLower != null && c.close >= c.bbLower) return k;
    if (dir === 'down' && c.bbUpper != null && c.close <= c.bbUpper) return k;
  }
  return null;
}

function scoreTf(tf) {
  const raw = ds.timeframes[tf] || [];
  const series = raw; // keep indices aligned; predicates require percentB != null anyway
  const cov = ds.coverage[tf];
  const baseUp = baseStats(series, 'up');
  const baseDown = baseStats(series, 'down');

  console.log(`\n══ ${tf}  (${cov.days}d ${cov.from}..${cov.to}, ${series.length} candles${cov.derived ? ', resampled' : ''})`);
  console.log(`   base up-rate k1/k2/k4: ${pct(baseUp[1].hit, 1)}/${pct(baseUp[2].hit, 1)}/${pct(baseUp[4].hit, 1)}%   base mean move: ${p1(baseUp[1].mean)}/${p1(baseUp[2].mean)}/${p1(baseUp[4].mean)} pts`);
  console.log(`   ${'predicate'.padEnd(22)} ${'n'.padStart(4)}  ${'hit% k1/k2/k4'.padEnd(14)} ${'ret k2(base)'.padEnd(14)} ${'lift'.padStart(6)} ${'z'.padStart(5)}  ${'recov%'.padStart(6)} ${'MFE/MAE'.padStart(9)}  tod hit% o/m/c`);

  for (const p of PREDICATES) {
    const base = p.dir === 'up' ? baseUp : baseDown;
    const idx = [];
    for (let i = 0; i < series.length; i++) { const c = series[i]; if (c.percentB != null && p.test(c)) idx.push(i); }
    if (!idx.length) { console.log(`   ${p.key.padEnd(22)} ${'0'.padStart(4)}  (no occurrences)`); continue; }

    const hit = {}, ret = {};
    for (const k of HORIZONS) {
      const favs = idx.map(i => fav(series, i, k, p.dir)).filter(f => f != null);
      hit[k] = favs.filter(f => f > 0).length / (favs.length || 1);
      ret[k] = mean(favs);
    }
    // significance of k2 hit-rate vs base
    const n2 = idx.filter(i => fav(series, i, 2, p.dir) != null).length;
    const p0 = base[2].hit, se = Math.sqrt((p0 * (1 - p0)) / (n2 || 1));
    const z = se ? (hit[2] - p0) / se : 0;
    const lift = ret[2] - base[2].mean;

    // recovery within 4
    const recs = idx.map(i => recovery(series, i, p.dir));
    const recovered = recs.filter(r => r != null);
    const recPct = pct(recovered.length, idx.length);
    // MFE/MAE over next 4 (predicted dir)
    const mfe = [], mae = [];
    for (const i of idx) {
      const fs4 = HORIZONS.concat([3]).map(k => fav(series, i, k, p.dir)).filter(f => f != null);
      if (fs4.length) { mfe.push(Math.max(...fs4)); mae.push(Math.min(...fs4)); }
    }
    // time of day at k2
    const tod = { open: [], mid: [], close: [] };
    for (const i of idx) { const f = fav(series, i, 2, p.dir); if (f != null) tod[todBucket(series[i].datetime)].push(f > 0 ? 1 : 0); }
    const todStr = ['open', 'mid', 'close'].map(b => `${pct(tod[b].reduce((s, x) => s + x, 0), tod[b].length)}%(${tod[b].length})`).join(' ');

    const hitStr = `${pct(hit[1], 1)}/${pct(hit[2], 1)}/${pct(hit[4], 1)}`;
    const retStr = `${p1(ret[2])}(${p1(base[2].mean)})`;
    const flag = z >= 2 ? ' ✓' : z <= -2 ? ' ✗' : '';
    console.log(`   ${p.key.padEnd(22)} ${String(idx.length).padStart(4)}  ${hitStr.padEnd(14)} ${retStr.padEnd(14)} ${p1(lift).padStart(6)} ${z.toFixed(1).padStart(5)}  ${(recPct + '%').padStart(6)} ${(p1(mean(mfe)) + '/' + p1(mean(mae))).padStart(9)}  ${todStr}${flag}`);
  }
}

console.log(`C SCORER — BAND-CROSS REVERSION — ${symbol}`);
console.log(`hit%=moved as predicted after k candles · ret=mean forward pts in predicted dir · z=hit vs base (✓ z≥2, ✗ z≤-2) · recov%=back inside band ≤4 · MFE/MAE=avg best/worst of next 4`);
for (const tf of TFS) scoreTf(tf);
console.log('');
