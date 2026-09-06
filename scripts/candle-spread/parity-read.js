#!/usr/bin/env node
'use strict';
/**
 * parity-read.js — what does a spread REALLY cost, in real quotes, at the placements the engine picks?
 *
 * capFrac is the risk/reward ceiling: never pay more than that fraction of the width for a long debit
 * spread. The backtest says 0.60 beats 0.65 by ~$740k on v6-20 — but it applies the ceiling to a MODELLED
 * mark (BS + intraday-IV + skew) with no second side to check against. The user's rule is different and
 * better: read BOTH sides of the chain, and since a bull call spread and the bear put spread at the same
 * strikes must sum to the width (put-call parity), the pair is a self-check. Whichever side is cheaper is
 * the honest price, because parity means neither can be genuinely below the other.
 *
 * This reads the REAL captured chains (chainSnapshot on the archived run records — the same source that
 * calibrated the IV skew) and answers three things the model cannot:
 *   1. PARITY SUM — does call-debit + put-debit actually land near W, and how far over? The user's stated
 *      experience is 1.05-1.1 x W. If it is systematically higher, mid quotes are inflated and every
 *      modelled price inherits that.
 *   2. CHEAPER SIDE — how much is given up by always pricing the call side for a bull? If the put-side
 *      representation is reliably cheaper, the engine over-states its own cost and the ceiling bites
 *      harder than intended.
 *   3. WHERE THE CEILING ACTUALLY FALLS — the real cost distribution as a fraction of width, per ITM
 *      depth, and what share of placements clear 0.60 vs 0.65. If nearly everything clears both, the
 *      backtest's preference is a model artifact rather than a real trading choice.
 *
 * Usage: node scripts/candle-spread/parity-read.js [--width 20] [--incr 10]
 */
const fs = require('fs');
const path = require('path');

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const W = arg('--width', 20);
const INCR = arg('--incr', 10);
const MAX_ITM = arg('--maxItm', 3);
const ARCHIVE = path.join(__dirname, '..', '..', 'candle-spread-archive');

// One snapshot per (date, time): every variant records the SAME chain, so without de-duping the sample is
// weighted by how many variants happened to run, not by how many market moments were observed.
const snaps = new Map();
for (const f of fs.readdirSync(ARCHIVE).filter((x) => /^NDX_.*\.json$/.test(x))) {
  let j; try { j = JSON.parse(fs.readFileSync(path.join(ARCHIVE, f), 'utf8')); } catch (e) { continue; }
  for (const e of j.events || []) {
    if (!e.chainSnapshot || !e.chainSnapshot.strikes) continue;
    const key = `${j.tradeDate}|${e.time}`;
    if (!snaps.has(key)) snaps.set(key, { date: j.tradeDate, time: e.time, cs: e.chainSnapshot });
  }
}
if (!snaps.size) { console.error('no chain snapshots in', ARCHIVE); process.exit(1); }

const med = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN);
const pct = (a, p) => (a.length ? [...a].sort((x, y) => x - y)[Math.max(0, Math.min(a.length - 1, Math.floor(a.length * p)))] : NaN);

const parity = [], parityMkt = [], sideGap = [], byDepth = new Map();
let nSpreads = 0, nSnaps = 0;

for (const { cs } of snaps.values()) {
  const at = new Map((cs.strikes || []).map((s) => [s.strike, s]));
  const U = cs.underlying;
  if (!(U > 0) || !at.size) continue;
  nSnaps++;
  const center = Math.floor(U / INCR) * INCR;
  const halfOnGrid = Math.floor((W / 2) / INCR) * INCR;
  // The adaptive ladder: most ITM first, out to the straddle — the placements the engine actually considers.
  for (let k = -MAX_ITM; k <= halfOnGrid / INCR; k++) {
    const shortStrike = center + k * INCR;
    const lo = shortStrike - W, hi = shortStrike;
    const A = at.get(lo), B = at.get(hi);
    if (!A || !B || !A.call || !B.call || !A.put || !B.put) continue;
    // BULL CALL debit at these strikes, and the BEAR PUT debit at the SAME strikes. Parity says the two
    // must sum to the width; anything above that is bid/ask and quote noise, shared by both.
    const callDebit = A.call.mid - B.call.mid;
    const putDebit = B.put.mid - A.put.mid;
    if (!(callDebit > 0) || !(putDebit > 0)) continue;
    nSpreads++;
    parity.push((callDebit + putDebit) / W);
    // MARKETABLE parity: what the pair costs if you actually cross — long at the ask, short at the bid, on
    // both sides. Mids satisfy parity by construction, so the premium over W is exactly the bid/ask cost of
    // transacting, which is what a trader experiences rather than what a mid-based model charges.
    const callMkt = A.call.ask - B.call.bid, putMkt = B.put.ask - A.put.bid;
    if (callMkt > 0 && putMkt > 0) parityMkt.push((callMkt + putMkt) / W);
    // A bull can be expressed on either ladder; the cheaper one is the honest cost. Positive = the call
    // side (what the engine always prices for a bull) costs MORE than the parity-implied put-side route.
    const impliedFromPut = W - putDebit;
    sideGap.push((callDebit - impliedFromPut) / W);
    const depth = -k;   // 0 = straddle placement, higher = deeper ITM
    if (!byDepth.has(depth)) byDepth.set(depth, []);
    byDepth.get(depth).push(Math.min(callDebit, impliedFromPut) / W);
  }
}

const f2 = (x) => (Number.isFinite(x) ? (x * 100).toFixed(1) + '%' : '—');
console.log(`\nPARITY READ — real captured chains · $${W} width · ${nSnaps.toLocaleString()} snapshots · ${nSpreads.toLocaleString()} spreads\n`);

console.log('1. PARITY SUM  (call debit + put debit) / width — theory says 1.00, quotes add spread on top');
console.log(`   median ${med(parity).toFixed(4)}x   p10 ${pct(parity, 0.1).toFixed(4)}x   p90 ${pct(parity, 0.9).toFixed(4)}x`);
console.log(`   -> quotes sit ${((med(parity) - 1) * 100).toFixed(1)}% above parity` +
  (med(parity) >= 1.03 && med(parity) <= 1.12 ? '  ✓ matches the stated 1.05-1.1x' : '  ⚠ OUTSIDE the stated 1.05-1.1x'));

console.log(`   MARKETABLE (cross both sides): median ${med(parityMkt).toFixed(4)}x   p10 ${pct(parityMkt, 0.1).toFixed(4)}x   p90 ${pct(parityMkt, 0.9).toFixed(4)}x`);
console.log(`   -> ${((med(parityMkt) - 1) * 100).toFixed(1)}% over width` +
  (med(parityMkt) >= 1.03 && med(parityMkt) <= 1.12 ? '  ✓ THIS is the stated 1.05-1.1x — it is the CROSSING cost, not the mid' : ''));

console.log('\n2. CHEAPER SIDE  (call-side cost − put-side-implied cost) / width');
console.log(`   median ${f2(med(sideGap))}   p10 ${f2(pct(sideGap, 0.1))}   p90 ${f2(pct(sideGap, 0.9))}`);
const callDearer = sideGap.filter((x) => x > 0).length / sideGap.length;
console.log(`   the call side is the dearer route on ${(callDearer * 100).toFixed(0)}% of spreads`);
console.log(`   -> always pricing the call side for a bull overstates cost by a median ${f2(med(sideGap))} of width`);

console.log('\n3. REAL COST BY PLACEMENT (cheaper side, fraction of width) — and where the ceiling falls');
console.log('   itmStrikes'.padEnd(14) + 'n'.padStart(8) + 'median'.padStart(9) + 'p90'.padStart(9) + 'under 0.60'.padStart(12) + 'under 0.65'.padStart(12));
for (const depth of [...byDepth.keys()].sort((a, b) => b - a)) {
  const a = byDepth.get(depth);
  const u60 = a.filter((x) => x <= 0.60).length / a.length, u65 = a.filter((x) => x <= 0.65).length / a.length;
  console.log(`   ${String(depth).padEnd(11)}${a.length.toLocaleString().padStart(8)}${f2(med(a)).padStart(9)}${f2(pct(a, 0.9)).padStart(9)}${(u60 * 100).toFixed(0).padStart(11)}%${(u65 * 100).toFixed(0).padStart(11)}%`);
}
const all = [].concat(...byDepth.values());
const a60 = all.filter((x) => x <= 0.60).length / all.length, a65 = all.filter((x) => x <= 0.65).length / all.length;
console.log(`   ${'ALL'.padEnd(11)}${all.length.toLocaleString().padStart(8)}${f2(med(all)).padStart(9)}${f2(pct(all, 0.9)).padStart(9)}${(a60 * 100).toFixed(0).padStart(11)}%${(a65 * 100).toFixed(0).padStart(11)}%`);
console.log(`\n   0.60 vs 0.65 changes the admitted set by ${((a65 - a60) * 100).toFixed(1)} percentage points in REAL quotes.`);
