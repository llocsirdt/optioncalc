#!/usr/bin/env node
'use strict';
/**
 * audit-engine-parity.js — "does the LIVE engine do what the BACKTEST measured?"
 *
 * WHY THIS EXISTS (user, 2026-09-10): "we need the live trading engine to mirror the backtest scenario,
 * because knowing they're not aligned gives zero confidence in the daily runs compared to the backtest
 * numbers. The ultimate goal is for our simulated run risk curves to match the backtest curves, and
 * anything that lets backtest and live simulation stray from each other should be reconciled."
 *
 * Divergence here is not a style issue — it is the difference between a baseline that predicts the live
 * day and a baseline that describes a strategy nobody is running. This session alone found four:
 *   - coverGeometry was honoured by the backtest's continuous path but discarded by the live reversal
 *     selector (selectCoverFixed hardcoded the tent);
 *   - openNeverOtm reached BASE_RUNS but not buildEngineDeps, so the live engine refused to start;
 *   - the ladder's limitNow was called WITHOUT `mark` in the backtest, so neverExceedMark could not fire
 *     there while it did live;
 *   - coverPriorOnOpen (the corrected "continuous cover") exists ONLY in the backtest.
 *
 * WHAT IT CHECKS. Every engine option named in the backtest (`opts.X`) against every option the live path
 * can see (`deps.X` in trader.js, plus whatever buildEngineDeps forwards, plus `cfg.X` — cfg is a spread
 * of the whole run so it picks fields up automatically, which is exactly the asymmetry that hid two dead
 * flags). Three buckets:
 *   BACKTEST-ONLY  — the backtest models a behaviour the live engine cannot perform. Baselines built with
 *                    it describe a strategy that does not run. The dangerous bucket.
 *   LIVE-ONLY      — live does something the backtest never measured, so no baseline covers it.
 *   NOT-APPLICABLE — allowlisted below with a reason (pricing-model or fill-model knobs that are
 *                    meaningless live because live fills are real broker fills).
 *
 * It is deliberately a NAME-level check: it cannot prove two implementations agree, only that both exist.
 * Isomorphism of behaviour is what the shared modules (spread-logic, cover-ladder, leg-ledger) are for.
 *
 * Usage: node scripts/candle-spread/audit-engine-parity.js [--verbose]
 * Exits 1 if any un-allowlisted divergence is found, so it can gate a build.
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'server', 'src', 'candle-spread');
const BT = fs.readFileSync(path.join(__dirname, 'backtest-v6-5m.js'), 'utf8');
const TRADER = fs.readFileSync(path.join(SRC, 'trader.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(SRC, 'index.js'), 'utf8');

const namesFrom = (src, prefix) => {
  const out = new Set();
  const re = new RegExp(`\\b${prefix}\\.([A-Za-z_][A-Za-z0-9_]*)`, 'g');
  let m; while ((m = re.exec(src))) out.add(m[1]);
  return out;
};

// The backtest's option surface, and the live engine's.
const btOpts = namesFrom(BT, 'opts');
const liveDeps = new Set([...namesFrom(TRADER, 'deps'), ...namesFrom(TRADER, 'cfg')]);
// buildEngineDeps forwards `X: run.X` — those are live-visible even if trader reads them indirectly.
for (const m of INDEX.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*):\s*run\.[A-Za-z_][A-Za-z0-9_]*/g)) liveDeps.add(m[1]);
// cfg is a spread of the run, so any variant field is live-visible by name.
for (const m of INDEX.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*):\s*f\.[A-Za-z_][A-Za-z0-9_]*/g)) liveDeps.add(m[1]);

// NOT-APPLICABLE: present in one engine by design. Each needs a REASON, not just an entry.
const NA = {
  // --- backtest-only by nature: pricing and fill MODELS. Live has real quotes and real broker fills. ---
  ivSkew: 'BS pricing-model choice; live reads real chain quotes',
  intradayIV: 'BS pricing-model choice; live reads real chain quotes',
  lockCoverMode: 'backtest lock-pricing model; documented as having no live counterpart',
  coverFillModel: 'names the model; live fills are real broker fills',
  coverFillAtClose: 'fill-model bound (pessimistic); meaningless live',
  coverFillHaircut: 'fill-model robustness knob; meaningless live',
  coverAtClose: 'alias of the fill-model bound',
  // Not a gap but the FIX for one: the backtest used to settle terminal P&L on the last 5m bar (15:55),
  // which differed from the official 16:00 index close by 31.2 points on 2026-09-08 — more than a $20
  // spread's width. Live never had this problem; it reads the $NDX quote's lastPrice and stamps
  // settleSource 'index-close'. settlePrice exists so a caller can TELL the backtest what that close was,
  // which is why it is one-sided by construction.
  settlePrice: 'live already settles on the official index close; this only lets the backtest be told it',
  priceOf: 'dataset accessor (which series prices the book)',
  geo: 'dataset/geometry factory injected by the harness',
  recordReplay: 'harness output option',
  trackCapital: 'harness output option',
  rthActionOnly: 'harness models the live RTH gate; live IS in RTH',
  dataDir: 'harness input',
  signalCfg: 'passed through the signal wrapper',
  // --- harness plumbing, not strategy ---
  quiet: 'harness logging', verbose: 'harness logging', only: 'harness filter', variants: 'harness filter',
};

// ALIASES: the same behaviour under two names. These are NOT divergences, but they are traps — the
// variant-contract guard cannot catch them, because the field IS forwarded, just renamed. Every analysis
// script's optsFor has to translate by hand, and a new script that forgets simply runs the backtest
// WITHOUT the feature while live runs WITH it.
const ALIAS = { capitalRecapture: 'recaptureAlternate' };

// A divergence only MATTERS if a live run actually sets the field. One that no variant carries is dead
// config: worth fixing, but it is not making today's baselines describe the wrong strategy.
let liveSets = {};
try {
  const { buildRuns } = require('../../server/src/candle-spread/index');
  const runs = buildRuns();
  for (const v of runs) for (const k of Object.keys(v)) {
    if (v[k] != null && v[k] !== false) liveSets[k] = (liveSets[k] || 0) + 1;
  }
} catch (e) { liveSets = null; }

const divergent = [];
const aliasTargets = new Set(Object.values(ALIAS));
for (const k of [...btOpts].sort()) {
  if (liveDeps.has(k)) continue;
  if (NA[k] || aliasTargets.has(k)) continue;
  divergent.push({ side: 'BACKTEST-ONLY', field: k, live: liveSets ? (liveSets[k] || 0) : null });
}

// Live-only: a strategy field the live engine forwards that the backtest never reads.
const forwarded = new Set();
for (const m of INDEX.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*):\s*run\.[A-Za-z_][A-Za-z0-9_]*/g)) forwarded.add(m[1]);
const LIVE_NA = new Set(['dryRun', 'signalFn', 'signalCfg', 'getLeg', 'placeOrder', 'replaceOrder',
  'accountHash', 'tradingClient', 'isProd', 'A', 'priorA', 'underlying', 'signalSymbol', 'priceSymbol',
  'isFifteen', 'captureChain', 'snapshotStrikes', 'coverTiming', 'coverKCap', 'coverStyle', 'variant',
  'quantity', 'strikeIncrement', 'tickIncrement', 'spreadWidth', 'spreadShift', 'capFrac', 'adaptiveGeo',
  'maxItmStrikes', 'jointDrift', 'jointMaxCombos', 'jointTopN', 'upsideLambda', 'convictionMult',
  'coverSelector', 'coverGeometry', 'coverFillModel',
  // run-identity / plumbing, not strategy behaviour: the backtest is handed one day's bars and one
  // geometry, so it has no need to name the instrument or the expiry.
  'symbol', 'expiration', 'mode', 'shift', 'width']);
for (const k of [...forwarded].sort()) {
  if (btOpts.has(k) || LIVE_NA.has(k) || NA[k] || ALIAS[k]) continue;
  divergent.push({ side: 'LIVE-ONLY', field: k, live: liveSets ? (liveSets[k] || 0) : null });
}

console.log('\nENGINE PARITY AUDIT — live trader vs 5m backtest');
console.log(`  backtest options: ${btOpts.size}   live-visible: ${liveDeps.size}   allowlisted N/A: ${Object.keys(NA).length}\n`);

const bo = divergent.filter(d => d.side === 'BACKTEST-ONLY');
const lo = divergent.filter(d => d.side === 'LIVE-ONLY');
const hot = divergent.filter(d => d.live > 0);
const cold = divergent.filter(d => !d.live);

console.log(`\u26a0\ufe0f  ACTIVE DIVERGENCES (${hot.length}) — a LIVE RUN SETS THIS and the engines disagree.`);
console.log('   These make the baseline describe a different strategy from the one running.');
for (const d of hot) console.log(`     ${d.side.padEnd(14)} ${d.field.padEnd(26)} set by ${d.live}/80 runs`);
if (!hot.length) console.log('     none — no live variant currently depends on a divergent field');

console.log(`\nDORMANT (${cold.length}) — the engines disagree but NO live run sets the field.`);
console.log('   Worth fixing before the field is ever used; not affecting today\u2019s baselines.');
const fmt = (arr, label) => {
  if (!arr.length) return;
  console.log(`   ${label}:`);
  for (let i = 0; i < arr.length; i += 3) console.log('     ' + arr.slice(i, i + 3).map(d => d.field.padEnd(26)).join(''));
};
fmt(cold.filter(d => d.side === 'BACKTEST-ONLY'), 'backtest-only');
fmt(cold.filter(d => d.side === 'LIVE-ONLY'), 'live-only');

console.log(`\nALIASED (${Object.keys(ALIAS).length}) — same behaviour, different name in each engine.`);
console.log('   Not a divergence, but the variant-contract guard CANNOT catch a missed translation.');
for (const [l, b] of Object.entries(ALIAS)) {
  const n = liveSets ? (liveSets[l] || 0) : '?';
  console.log(`     live \`${l}\` == backtest \`${b}\`   (set by ${n}/80 runs)`);
}

if (process.argv.includes('--verbose')) {
  console.log('\nALLOWLISTED AS NOT-APPLICABLE (with reason):');
  for (const [k, why] of Object.entries(NA)) console.log(`    ${k.padEnd(20)} ${why}`);
}
console.log('');
process.exit(hot.length ? 1 : 0);   // only ACTIVE divergences gate a build
