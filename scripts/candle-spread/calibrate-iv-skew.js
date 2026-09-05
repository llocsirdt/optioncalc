#!/usr/bin/env node
'use strict';
/**
 * calibrate-iv-skew.js — a MONEYNESS-aware IV correction, from the real captured chains.
 *
 * The shipped intraday correction is a single time-of-day multiplier on band-IV: every strike at a given
 * moment gets the SAME vol. That is calibrated on ATM vol and it is right there, but it cannot represent
 * SKEW — and the geometry we actually trade is short-ATM, whose legs sit at and below spot where real vol
 * runs above ATM. Measured against live fills, that under-prices ITM verticals by ~$106/contract (4.7
 * points of width) while OTM structures come out fine, which is exactly the signature of a missing smile.
 *
 *   iv(K) = bandIV(bar) x ivMult(timeOfDay) x skewMult(z)      z = (K - S) / (S * iv * sqrt(tau))
 *
 * MONEYNESS IS IN EXPECTED-MOVE UNITS, not points. A 20-point offset at 09:35 and the same offset at 15:45
 * are wildly different in vol terms; z normalises them so one table serves the whole session.
 *
 * CONVENTION: implied vol is taken from the OTM option at each strike (calls above spot, puts below). By
 * put-call parity both imply the same vol, but the OTM side carries the vega, so it is the identified
 * quote — inverting a deep-ITM option's vol is ill-conditioned in exactly the way the earlier
 * short-ATM-vertical inversion was.
 *
 * ROBUSTNESS: per bucket, the median across SNAPSHOTS (not a pooled median of quotes), so one wide-spread
 * moment cannot move a bucket. Buckets with too few samples fall back to 1.0 (no correction) rather than
 * to a noisy estimate.
 *
 * Output: data/iv-skew-correction.json { buckets:[{z, mult}], meta:{...} }
 * Usage:  node scripts/candle-spread/calibrate-iv-skew.js [--minQuote 0.30] [--minSamples 20]
 */
const fs = require('fs');
const path = require('path');
const bs = require('../../server/src/candle-spread/bs-pricer');

const ARCHIVE = path.join(__dirname, '..', '..', 'candle-spread-archive');
const OUT = path.join(__dirname, '..', '..', 'data', 'iv-skew-correction.json');
const argN = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const MIN_QUOTE = argN('--minQuote', 0.30);     // sub-30c mids are noise at these tenors
const MIN_SAMPLES = argN('--minSamples', 20);
// A day with a handful of snapshots must not weigh the same as a full session. 2026-08-25 contributed 2
// snapshots against 25-77 for every other day, was an outlier low-vol regime, and on its own inflated the
// upside bucket's across-day stdev from 0.005 to 0.045.
const MIN_SNAPS_PER_DAY = argN('--minSnapshotsPerDay', 10);
// Beyond |z| = DAMP_Z the buckets are thin AND vol-regime dependent (the -1.5..-1 bucket swings 1.176 in
// low vol to 1.022 in high vol). Measured on live runs, 99% of our legs sit inside |z| < 1 and 100% inside
// |z| < 1.5 — so out there we would be extrapolating an unstable estimate into territory we never trade.
// Fade toward 1.0 instead of trusting it.
const DAMP_Z = argN('--dampBeyondZ', 1.5);

// bucket edges in expected-move units; finer near the money where the curve bends most
const EDGES = [-4, -3, -2.5, -2, -1.5, -1.25, -1, -0.75, -0.5, -0.25, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4];
const mid2 = (a, b) => Math.round((a + b) / 2 * 100) / 100;
const med = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
const tauOf = m => Math.max(1e-6, (16 * 60 - m) / (365 * 24 * 60));

// one snapshot per (date, time) — every variant records the same chain
const snaps = new Map();
for (const f of fs.readdirSync(ARCHIVE).filter(x => /^NDX_.*\.json$/.test(x))) {
  let j; try { j = JSON.parse(fs.readFileSync(path.join(ARCHIVE, f), 'utf8')); } catch (e) { continue; }
  for (const e of j.events || []) {
    const cs = e.chainSnapshot;
    if (!cs || !cs.strikes || !e.candle) continue;
    const key = `${j.tradeDate}|${e.candle.time}`;
    if (snaps.has(key)) continue;
    const ch = {};
    for (const q of Object.values(cs.strikes)) if (q && q.strike != null) ch[q.strike] = q;
    const [hh, mm] = e.candle.time.split(' ')[1].split(':').map(Number);
    snaps.set(key, { date: j.tradeDate, time: e.candle.time, spot: cs.underlying, min: hh * 60 + mm, ch });
  }
}
if (!snaps.size) { console.error('no chain snapshots in', ARCHIVE); process.exit(1); }
const perDay = {};
for (const s2 of snaps.values()) perDay[s2.date] = (perDay[s2.date] || 0) + 1;
const thinDays = Object.entries(perDay).filter(([, n]) => n < MIN_SNAPS_PER_DAY).map(([d]) => d);
for (const [k, v] of [...snaps]) if (thinDays.includes(v.date)) snaps.delete(k);
if (thinDays.length) console.log(`excluded ${thinDays.length} thin day(s) (<${MIN_SNAPS_PER_DAY} snapshots): ${thinDays.join(', ')}\n`);

// IV of the OTM option at a strike
function ivAt(s, k, tau) {
  const side = k >= s.spot ? 'call' : 'put';
  const q = s.ch[k]; const m = q && q[side] && q[side].mid;
  if (!(m > MIN_QUOTE)) return null;
  const v = bs.impliedVol(side === 'call' ? 'C' : 'P', s.spot, k, tau, m);
  return (v > 0.01 && v < 3) ? v : null;
}

// per SNAPSHOT: the median ratio in each bucket, so a snapshot contributes one value per bucket
const perBucket = EDGES.slice(0, -1).map((lo, i) => ({ lo, hi: EDGES[i + 1], vals: [] }));
let usedSnaps = 0;
const dates = new Set();
for (const s of snaps.values()) {
  const tau = tauOf(s.min);
  const ks = Object.keys(s.ch).map(Number).sort((a, b) => a - b);
  // ATM anchor: nearest strike with an identified OTM vol
  let atm = null;
  for (const k of [...ks].sort((a, b) => Math.abs(a - s.spot) - Math.abs(b - s.spot))) { const v = ivAt(s, k, tau); if (v) { atm = v; break; } }
  if (!atm) continue;
  const band = s.spot * atm * Math.sqrt(tau);
  if (!(band > 0)) continue;
  const local = perBucket.map(() => []);
  for (const k of ks) {
    const v = ivAt(s, k, tau); if (!v) continue;
    const z = (k - s.spot) / band;
    const bi = perBucket.findIndex(b => z >= b.lo && z < b.hi);
    if (bi >= 0) local[bi].push(v / atm);
  }
  let contributed = false;
  local.forEach((vals, i) => { const m = med(vals); if (m != null) { perBucket[i].vals.push(m); contributed = true; } });
  if (contributed) { usedSnaps++; dates.add(s.date); }
}

const buckets = perBucket.map(b => ({
  z: mid2(b.lo, b.hi), lo: b.lo, hi: b.hi, n: b.vals.length,
  mult: b.vals.length >= MIN_SAMPLES ? Math.round(med(b.vals) * 1e4) / 1e4 : null,
}));
// Anchor the ATM bucket at exactly 1.0 — the correction is RELATIVE to ATM, and the intraday multiplier
// already sets the level. Letting it drift would double-count the level adjustment.
const atmB = buckets.find(b => b.lo <= 0 && b.hi > 0);
if (atmB && atmB.mult) { const a = atmB.mult; for (const b of buckets) if (b.mult != null) b.mult = Math.round(b.mult / a * 1e4) / 1e4; }
// Fade the far buckets toward 1.0 — thin, regime-dependent, and outside anything we trade.
for (const b of buckets) {
  if (b.mult == null) { b.mult = 1; b.damped = 'no-data'; continue; }
  const z = Math.max(Math.abs(b.lo), Math.abs(b.hi));
  if (z > DAMP_Z) { const w = Math.max(0, 1 - (z - DAMP_Z) / DAMP_Z); b.mult = Math.round((1 + (b.mult - 1) * w) * 1e4) / 1e4; b.damped = `w=${w.toFixed(2)}`; }
}

const out = {
  generatedAt: new Date().toISOString(),
  method: 'iv(K) = bandIV * ivMult(timeOfDay) * skewMult(z), z = (K-S)/(S*iv*sqrt(tau)); skewMult = median over SNAPSHOTS of [OTM implied vol / ATM implied vol]; ATM bucket normalised to 1.0',
  buckets,
  meta: { snapshots: usedSnaps, dates: [...dates].sort(), minQuote: MIN_QUOTE, minSamples: MIN_SAMPLES,
    minSnapshotsPerDay: MIN_SNAPS_PER_DAY, excludedThinDays: thinDays, dampBeyondZ: DAMP_Z },
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log(`IV SKEW — ${usedSnaps} snapshots across ${dates.size} days\n`);
console.log('   z range        n    skewMult');
for (const b of buckets) console.log(`  ${String(b.lo).padStart(5)} .. ${String(b.hi).padEnd(5)} ${String(b.n).padStart(5)}    ${b.mult.toFixed(4)}${b.damped ? '  (' + b.damped + ')' : ''}`);
console.log(`\nwrote ${path.relative(process.cwd(), OUT)}`);
