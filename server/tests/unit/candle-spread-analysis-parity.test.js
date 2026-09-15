'use strict';
// Parity test: the server's live analysis-builder must reproduce the committed backtest dataset
// (built by scripts/candle-spread/build-analysis-dataset.js) BYTE-FOR-BYTE, and a ported signal
// (v6) must make IDENTICAL decisions on the live-built `A` as on the backtest `A`. This is the
// proof that porting v4-v9 into the server yields the same behavior as their validated backtests.
//
// Run: node server/tests/nogit/candle-spread-analysis-parity.test.js
const fs = require('fs');
const path = require('path');
const ab = require('../../src/candle-spread/analysis-builder');
const { v6Signal } = require('../../src/candle-spread/signals/v6-signals');

const RAW1 = path.join(__dirname, '..', '..', '..', 'signal-lab-data', 'raw-1m');
const DATASET = path.join(__dirname, '..', '..', '..', 'tests', 'backtest', 'backtest-data-v2');
const SYMBOL = 'NDX';
const STEP = 15; // committed backtest-data-v2 was built at --step 15

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

// Same load as build-analysis-dataset.loadRaw1: concat all cached days, de-dupe, sort by time.
function loadRaw1() {
  const files = fs.readdirSync(RAW1).filter(f => f.startsWith(`${SYMBOL}-`) && f.endsWith('.json')).sort();
  let all = [];
  for (const f of files) all = all.concat(JSON.parse(fs.readFileSync(path.join(RAW1, f), 'utf8')).candles || []);
  const seen = new Set();
  all = all.filter(c => (c.datetime != null && !seen.has(c.datetime)) && seen.add(c.datetime));
  all.sort((a, b) => a.datetime - b.datetime);
  return all;
}

const etDay = ms => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

const raw = loadRaw1();
ok(raw.length > 1000, `raw 1m loaded (${raw.length} candles)`);

// Build every bar the server way, group by ET day.
const built = ab.buildBars(raw, STEP);
const builtByDay = new Map();
for (const b of built) { const d = etDay(b.datetime); if (!builtByDay.has(d)) builtByDay.set(d, []); builtByDay.get(d).push(b); }

// Compare against each committed dataset day file.
const files = fs.readdirSync(DATASET).filter(f => f.startsWith(`backtest-${SYMBOL}-`) && f.endsWith('.json'));
let comparedDays = 0, comparedBars = 0, decMatches = 0;
for (const f of files) {
  const day = f.replace(`backtest-${SYMBOL}-`, '').replace('.json', '');
  const expected = JSON.parse(fs.readFileSync(path.join(DATASET, f), 'utf8'));
  const got = builtByDay.get(day);
  if (!got) { continue; } // day not in the raw-1m cache window — skip (not a failure)
  comparedDays++;
  ok(got.length === expected.length, `${day}: bar count ${got.length} === ${expected.length}`);
  const n = Math.min(got.length, expected.length);
  for (let i = 0; i < n; i++) {
    comparedBars++;
    // Byte-identical analysis object (same datetime + every TF field).
    const same = JSON.stringify(got[i]) === JSON.stringify(expected[i]);
    ok(same, `${day} bar ${i}: analysis byte-identical`);
    if (!same && comparedBars < 3) console.log('  got:', JSON.stringify(got[i].analysis['15m']), '\n  exp:', JSON.stringify(expected[i].analysis['15m']));
    // Signal parity: v6 makes the same decision on live-built A as on the committed A.
    const prevGot = i > 0 ? got[i - 1].analysis : null;
    const prevExp = i > 0 ? expected[i - 1].analysis : null;
    const ctx = { heldDir: 'none', cfg: { fiveMin: true } };
    const dGot = v6Signal(got[i].analysis, prevGot, ctx);
    const dExp = v6Signal(expected[i].analysis, prevExp, ctx);
    if (dGot.openSide === dExp.openSide && dGot.cover === dExp.cover) decMatches++;
    else { fail++; console.log(`FAIL ${day} bar ${i}: v6 decision differs got=${JSON.stringify(dGot)} exp=${JSON.stringify(dExp)}`); }
  }
}

ok(comparedDays > 0, `compared ${comparedDays} days present in both raw cache and committed dataset`);
console.log(`\ncompared ${comparedDays} days, ${comparedBars} bars; v6 decision matches: ${decMatches}/${comparedBars}`);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
