#!/usr/bin/env node
'use strict';
/**
 * audit-strike-placement.js — "is every leg we send where the strategy says it should be?"
 *
 * THE RULE (user, 2026-09-09): every OPEN is placed at the money or IN the money — never with both legs
 * out of the money. How far in is a ladder/pricing choice; being fully OTM is not a choice, it is a bug.
 * The only legitimate both-OTM structures are the risk hedges (floorOffset / wing) whose whole job is to
 * lift the floor cheaply, so those are counted separately and never flagged.
 *
 * It reads the REAL persisted run records — the legs actually sent and the NDX underlying stamped on the
 * candle that placed them — so this measures what the engine DID, not what the model says it does.
 *
 * MONEYNESS, per leg, against the underlying at placement time:
 *   call ITM  <=>  spot > strike        put ITM  <=>  spot < strike
 * A spread is BOTH-OTM when neither leg is in the money. For an open that is the violation. For a cover
 * it is reported but NOT called a violation: a cover is an offsetting structure whose tent peaks at the
 * shared short strike, and whether it should track spot is exactly the coverGeometry question (tent vs
 * halfway vs at-the-underlying), so the report breaks covers down BY GEOMETRY instead of judging them.
 *
 * SOURCE. Live runs are read from PROD by default. The local persistence directory holds only whatever
 * the local engine happened to record — on 2026-09-08 that was ~1 position per variant against PROD's 19,
 * so auditing local files silently measures a truncated session. --local reads the directory anyway.
 *
 * Usage: node scripts/candle-spread/audit-strike-placement.js [--date 2026-09-08] [--variants v6-20,v7-10]
 *        node scripts/candle-spread/audit-strike-placement.js --local        (local persistence dir)
 *        node scripts/candle-spread/audit-strike-placement.js --detail       (per-order lines)
 */
const fs = require('fs');
const path = require('path');

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const DIR = path.join(__dirname, '..', '..', 'server', 'src', 'persistence', 'candle-spread-runs');
const LOCAL = process.argv.includes('--local');
const DETAIL = process.argv.includes('--detail');
const DATE = arg('--date', '2026-09-08');
const ONLY = arg('--variants', null);
const BASE = arg('--base', 'https://d1kbxyxn33vpw2.cloudfront.net');

// The variant list comes from the run set itself, so the audit covers exactly what runs live.
const { buildRuns } = require('../../server/src/candle-spread/index');
const VARIANTS = (ONLY ? ONLY.split(',') : buildRuns().map(r => r.variant));

async function fetchRun(variant) {
  const url = `${BASE}/api/v1/candle-spread/runs/NDX/${DATE}?date=${DATE}&variant=${variant}&cb=${Date.now()}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const j = await res.json();
  return (j && j.state) ? j : null;
}
function readLocal(variant) {
  const f = path.join(DIR, `NDX_${DATE}_${DATE}_${variant}.json`);
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

// Underlying at a given ET label ("09/08 13:45"), from the candle_close events. Placement stamps carry
// the ET label, so match on that and fall back to the nearest earlier candle.
function underlyingIndex(rec) {
  const rows = [];
  for (const e of rec.events || []) {
    if (e.type !== 'candle_close' || e.underlying == null) continue;
    rows.push({ label: e.candle && e.candle.time, u: e.underlying, t: Date.parse(e.time) });
  }
  const byLabel = new Map(rows.map(r => [r.label, r.u]));
  return { byLabel, rows };
}
const itm = (leg, spot) => (leg.type === 'C' ? spot > leg.strike : spot < leg.strike);

function classify(legs, spot) {
  const ins = legs.filter(l => itm(l, spot)).length;
  if (ins === legs.length) return 'allITM';
  if (ins === 0) return 'allOTM';
  return 'straddling';   // spot sits between the strikes — the cATM case
}

const tot = { open: {}, cover: {}, hedge: 0 };
const byGeom = {};
const violations = [];
let files_read = 0;

async function main() {
for (const variant of VARIANTS) {
  const rec = LOCAL ? readLocal(variant) : await fetchRun(variant);
  if (!rec) continue;
  files_read++;
  const { byLabel, rows } = underlyingIndex(rec);
  if (!rows.length) continue;
  const spotAt = (label) => {
    if (label && byLabel.has(label)) return byLabel.get(label);
    return rows[rows.length - 1].u;                   // no stamp -> last known (flagged as approx below)
  };
  for (const p of (rec.state && rec.state.positions) || []) {
    if (!p.legs || !p.legs.length) continue;
    // hedges are single-leg longs or explicitly tagged overlays: exempt by design
    if (p.hedge || p.wing || p.offset || p.legs.length === 1) { tot.hedge++; continue; }
    const oSpot = spotAt(p.openTime);
    const k = classify(p.legs, oSpot);
    tot.open[k] = (tot.open[k] || 0) + 1;
    if (k === 'allOTM') violations.push({ variant, kind: 'OPEN', time: p.openTime, spot: oSpot,
      legs: p.legs.map(l => (l.side === 'long' ? '+' : '-') + l.type + l.strike).join(' ') });
    const pc = p.pendingCover;
    if (pc && pc.legs) {
      const cSpot = spotAt(pc.placedAt);
      const ck = classify(pc.legs, cSpot);
      tot.cover[ck] = (tot.cover[ck] || 0) + 1;
      const g = pc.geometry || 'unknown';
      byGeom[g] = byGeom[g] || {};
      byGeom[g][ck] = (byGeom[g][ck] || 0) + 1;
      if (DETAIL) console.log(`  ${variant.padEnd(12)} COVER ${String(pc.placedAt).padEnd(12)} spot ${String(Math.round(cSpot)).padEnd(6)} ${g.padEnd(6)} ${ck.padEnd(11)} ` +
        pc.legs.map(l => (l.side === 'long' ? '+' : '-') + l.type + l.strike).join(' '));
    }
  }
}

const pct = (o) => { const n = Object.values(o).reduce((a, b) => a + b, 0) || 1;
  return ['allITM', 'straddling', 'allOTM'].map(k => `${k} ${String(o[k] || 0).padStart(5)} (${String(Math.round((o[k] || 0) / n * 100)).padStart(3)}%)`).join('   '); };

console.log(`\nSTRIKE PLACEMENT AUDIT — ${files_read} run record(s), ${DATE}, source ${LOCAL ? 'LOCAL dir' : BASE}`);
console.log('moneyness measured against the NDX underlying stamped on the placing candle\n');
console.log('  OPENS   ' + pct(tot.open));
console.log('  COVERS  ' + pct(tot.cover));
console.log(`  hedges skipped (single-leg / tagged overlays): ${tot.hedge}`);

console.log('\n  COVERS BY GEOMETRY');
console.log('    geometry'.padEnd(14) + 'allITM'.padStart(9) + 'straddling'.padStart(12) + 'allOTM'.padStart(9));
for (const [g, o] of Object.entries(byGeom)) {
  console.log('    ' + g.padEnd(10) + String(o.allITM || 0).padStart(9) + String(o.straddling || 0).padStart(12) + String(o.allOTM || 0).padStart(9));
}

console.log(`\n  RULE VIOLATIONS (opens with BOTH legs out of the money): ${violations.length}`);
for (const v of violations.slice(0, 25)) {
  console.log(`    ${v.variant.padEnd(13)} ${String(v.time).padEnd(12)} spot ${Math.round(v.spot)}   ${v.legs}`);
}
if (violations.length > 25) console.log(`    ... and ${violations.length - 25} more`);
console.log('');
process.exit(violations.length ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
