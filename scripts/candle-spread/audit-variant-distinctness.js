#!/usr/bin/env node
'use strict';
/**
 * audit-variant-distinctness.js — "does every live variant actually differ from every other one?"
 *
 * WHY THIS EXISTS. v1 declared coverGeometry 'halfway' and v2 'underlying', but both rode
 * coverSelector 'fixed', whose selector built the TENT unconditionally. So live, v0/v1/v2/v3 placed
 * IDENTICAL covers while the run set claimed to be measuring the geometry axis. Nothing caught it for
 * weeks because each variant's CONFIG differed — only its BEHAVIOUR was the same.
 *
 * Two failure modes, and this checks both:
 *   MIRROR  — two variants whose declared config is identical apart from the name. They cannot differ.
 *   INERT   — a field a variant declares that NOTHING in the server engine ever reads. The variant looks
 *             distinct and behaves like its sibling. This is the class the coverGeometry bug was in.
 *
 * The inert check greps the server sources for the field name rather than reasoning about it: a field is
 * "read" if it appears anywhere outside the run-building code that declares it. That over-accepts (a
 * mention is not a use) but never over-rejects, so anything it DOES flag is worth a look.
 *
 * KNOWN-BENIGN: lockCoverMode is reported inert and should be. It is 'rest' on all 80 runs (a uniform
 * constant cannot make two variants mirror each other) and index.js documents it as a backtest pricing
 * -model choice with no live counterpart. Left visible rather than allowlisted so the list stays honest.
 *
 * Exits 1 if any mirror is found, so this can gate a build.
 *
 * Usage: node scripts/candle-spread/audit-variant-distinctness.js [--verbose]
 */
const fs = require('fs');
const path = require('path');
const { buildRuns } = require('../../server/src/candle-spread/index');

const VERBOSE = process.argv.includes('--verbose');
const SRC = path.join(__dirname, '..', '..', 'server', 'src', 'candle-spread');
// index.js DECLARES the fields, so a mention there proves nothing. Everything else is a consumer.
const CONSUMERS = fs.readdirSync(SRC).filter(f => f.endsWith('.js') && f !== 'index.js');
const BODY = CONSUMERS.map(f => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n');

// Identity fields: naming/plumbing, not behaviour. Two variants differing ONLY in these are mirrors.
const IDENTITY = new Set(['variant', 'variantLabel', 'symbol', 'dryRun', 'label', 'key']);

const runs = buildRuns();
// Functions must be compared by IDENTITY, not by source. Every family's signalFn is an at15(...) wrapper
// whose source text is the same string, so stringifying them reported v4 == v5 (and v4 == v5 across all
// 8 width/twin combinations) when the wrapped signals are entirely different functions. Each family
// builds its signalFn once, so all widths of a family legitimately share one reference.
const fnIds = new Map();
const fnId = (f) => { if (!fnIds.has(f)) fnIds.set(f, `fn#${fnIds.size}`); return fnIds.get(f); };
const val = (x) => (typeof x === 'function' ? fnId(x) : x);
const fingerprint = (v) => JSON.stringify(Object.keys(v).filter(k => !IDENTITY.has(k)).sort()
  .map(k => [k, val(v[k])]));

// ---- MIRRORS ------------------------------------------------------------------------------------
const byPrint = new Map();
for (const v of runs) {
  const p = fingerprint(v);
  if (!byPrint.has(p)) byPrint.set(p, []);
  byPrint.get(p).push(v.variant);
}
const mirrors = [...byPrint.values()].filter(g => g.length > 1);

// ---- INERT FIELDS -------------------------------------------------------------------------------
const declared = new Map();   // field -> Set(variants declaring it)
for (const v of runs) for (const k of Object.keys(v)) {
  if (IDENTITY.has(k)) continue;
  if (!declared.has(k)) declared.set(k, new Set());
  declared.get(k).add(v.variant);
}
const inert = [];
for (const [k, who] of declared) {
  // A field is read if the consumer sources mention it at all (cfg.k, opts.k, destructured, or quoted).
  if (new RegExp(`\\b${k}\\b`).test(BODY)) continue;
  inert.push({ field: k, n: who.size, sample: [...who].slice(0, 4) });
}

// ---- VARIANTS THAT DIFFER ONLY BY AN INERT FIELD ------------------------------------------------
// The dangerous case: config differs, but only on fields nothing reads -> behaviourally a mirror.
const inertSet = new Set(inert.map(i => i.field));
const effPrint = (v) => JSON.stringify(Object.keys(v).filter(k => !IDENTITY.has(k) && !inertSet.has(k)).sort()
  .map(k => [k, val(v[k])]));
const byEff = new Map();
for (const v of runs) {
  const p = effPrint(v);
  if (!byEff.has(p)) byEff.set(p, []);
  byEff.get(p).push(v.variant);
}
const effMirrors = [...byEff.values()].filter(g => g.length > 1)
  .filter(g => !mirrors.some(m => m.join() === g.join()));   // already reported as exact mirrors

console.log(`\nVARIANT DISTINCTNESS AUDIT — ${runs.length} live runs\n`);
console.log(`EXACT MIRRORS (identical config apart from the name): ${mirrors.length}`);
for (const g of mirrors) console.log('  ' + g.join('  ==  '));
if (!mirrors.length) console.log('  none');

console.log(`\nINERT FIELDS (declared by a variant, read by NO server consumer): ${inert.length}`);
for (const i of inert) console.log(`  ${i.field.padEnd(28)} declared by ${String(i.n).padStart(3)} variant(s)  e.g. ${i.sample.join(', ')}`);
if (!inert.length) console.log('  none');

console.log(`\nEFFECTIVE MIRRORS (differ only on inert fields): ${effMirrors.length}`);
for (const g of effMirrors) console.log('  ' + g.join('  ==  '));
if (!effMirrors.length) console.log('  none');

if (VERBOSE) {
  console.log('\nPER-FAMILY DISTINGUISHING CONFIG (v0-v3, $10):');
  for (const v of runs.filter(r => /^v[0-3]-10$/.test(r.variant))) {
    const show = ['coverSelector', 'coverGeometry', 'coverFillModel', 'continuousCoverArmFrac', 'continuousCoverOppRatio', 'continuousCoverMinLockFrac', 'lossTarget', 'lossMax'];
    console.log('  ' + v.variant.padEnd(9) + show.map(k => `${k}=${v[k]}`).join(' '));
  }
}
console.log('');
process.exit(mirrors.length || effMirrors.length ? 1 : 0);
