'use strict';
// NQ analysis parity: prove the server analysis-builder reproduces the backtest's independent
// build-analysis-dataset on NQ (the live signal instrument — signals on NQ, trades on NDX), and
// that v6 makes identical decisions. Runs on the available ~30-day Schwab NQ cache, which is
// RTH-only (390 bars/day); this validates the BUILDER LOGIC, which is hours-agnostic (it resamples
// whatever 1m it's given), so it carries to the live 24h NQ path. A 24h-specific NUMERIC fixture
// would come from the Kaggle set. Complements the NDX parity test (same builder, NQ instrument).
//
// Run: node server/tests/nogit/candle-spread-nq-parity.test.js
const fs = require('fs'), path = require('path'), os = require('os');
const { execSync } = require('child_process');
const ab = require('../../src/candle-spread/analysis-builder');
const { v6Signal } = require('../../src/candle-spread/signals/v6-signals');

const ROOT = path.join(__dirname, '..', '..', '..');
const RAW1 = path.join(ROOT, 'signal-lab-data', 'raw-1m');
const SYMBOL = 'NQ';
const STEP = 5;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

if (!fs.existsSync(RAW1) || !fs.readdirSync(RAW1).some(f => f.startsWith('NQ-'))) {
  console.log('SKIP: no NQ raw-1m cache present'); process.exit(0);
}

// Generate the EXPECTED bars with the backtest's own builder (independent of analysis-builder).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nq-exp-'));
execSync(`node ${path.join(ROOT, 'scripts/candle-spread/build-analysis-dataset.js')} ${SYMBOL} --raw ${RAW1} --out ${tmp} --step ${STEP}`, { stdio: 'ignore' });

// Load the same NQ raw 1m the builder used (concat + de-dupe + sort), build the server way.
function loadRaw1() {
  const files = fs.readdirSync(RAW1).filter(f => f.startsWith(`${SYMBOL}-`) && f.endsWith('.json')).sort();
  let all = [];
  for (const f of files) all = all.concat(JSON.parse(fs.readFileSync(path.join(RAW1, f), 'utf8')).candles || []);
  const seen = new Set();
  all = all.filter(c => c.datetime != null && !seen.has(c.datetime) && seen.add(c.datetime));
  all.sort((a, b) => a.datetime - b.datetime);
  return all;
}
const etDay = ms => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const built = ab.buildBars(loadRaw1(), STEP);
const builtByDay = new Map();
for (const b of built) { const d = etDay(b.datetime); if (!builtByDay.has(d)) builtByDay.set(d, []); builtByDay.get(d).push(b); }

const files = fs.readdirSync(tmp).filter(f => f.startsWith(`backtest-${SYMBOL}-`) && f.endsWith('.json'));
ok(files.length > 0, `backtest builder produced ${files.length} NQ day-files`);
let days = 0, barsCompared = 0, decMatches = 0;
for (const f of files) {
  const day = f.replace(`backtest-${SYMBOL}-`, '').replace('.json', '');
  const expected = JSON.parse(fs.readFileSync(path.join(tmp, f), 'utf8'));
  const got = builtByDay.get(day);
  if (!got) { ok(false, `${day}: server built no bars for a day the backtest did`); continue; }
  days++;
  ok(got.length === expected.length, `${day}: bar count ${got.length} === ${expected.length}`);
  const n = Math.min(got.length, expected.length);
  for (let i = 0; i < n; i++) {
    barsCompared++;
    ok(JSON.stringify(got[i]) === JSON.stringify(expected[i]), `${day} bar ${i}: analysis byte-identical`);
    const ctx = { heldDir: 'none', cfg: { fiveMin: true } };
    const dG = v6Signal(got[i].analysis, i > 0 ? got[i - 1].analysis : null, ctx);
    const dE = v6Signal(expected[i].analysis, i > 0 ? expected[i - 1].analysis : null, ctx);
    if (dG.openSide === dE.openSide && dG.cover === dE.cover) decMatches++;
    else { fail++; console.log(`FAIL ${day} bar ${i}: v6 decision differs`); }
  }
}
ok(days > 0, `compared ${days} NQ days`);
console.log(`\nNQ: ${days} days, ${barsCompared} bars; v6 decision matches ${decMatches}/${barsCompared}`);
console.log(`${pass} passed, ${fail} failed`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
process.exit(fail ? 1 : 0);
