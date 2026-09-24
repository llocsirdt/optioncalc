'use strict';
// A RUN'S CONFIG IS FROZEN AT CREATION — and something was creating records before the session began.
//
// store.initRun returns an EXISTING record untouched, so whatever config was written at creation is what
// the engine runs on for the whole day. That is correct once a session is under way (changing the
// governor half way through a day is worse than running the old one consistently). It was wrong for a
// record created before anything happened.
//
// The order poller runs on a timer regardless of market hours and called initRun, which CREATES. So the
// ARMED variant's record was manufactured at midnight ET, hours before the first tick, freezing whatever
// build was live at 00:00.
//
// Measured on the prod archive: v7-10 was created at 04:00Z every trading day from 2026-09-07 and carried
// lossMax 1000 against the roster's 1500 for SIX sessions (09-16, 17, 18, 21, 22, 23). On 09-23 that
// blocked 19 opens and left 22 positions where the same day backtests to 40. It also left 0-event phantom
// records on non-trading days (09-15, 09-19, 09-20).
//
// Run: node server/tests/unit/candle-spread-config-freeze.test.js
const os = require('os'), path = require('path'), fs = require('fs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-freeze-'));
process.env.CANDLE_SPREAD_RUNS_DIR = tmp;
const store = require('../../src/candle-spread/store');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

const DAY = '2026-09-24';
const base = { symbol: 'NDX', expiration: DAY, variant: 'frz', spreadWidth: 10, lossMax: 1000, lossTarget: 700 };
const runId = store.makeRunId(base.symbol, base.expiration, DAY, base.variant);

// The freeze itself: an existing record wins over the roster, which is what made the skew invisible.
{
  store.initRun(base, DAY);
  const again = store.initRun({ ...base, lossMax: 1500, lossTarget: 1050 }, DAY);
  ok(again.config.lossMax === 1000,
    'initRun returns the EXISTING record — the roster does NOT overwrite a live config (by design)');
}

// So the fix has to be: while the run is UNTOUCHED, the roster is the truth.
// refreshUntouchedConfig lives in index.js; replicate its contract here against the store it works on.
const refresh = (record, cfg) => {
  const st = record.state || {};
  if ((record.events || []).length || (st.positions || []).length) return { record, changed: [] };
  const changed = [];
  for (const k of Object.keys(cfg)) {
    if (typeof cfg[k] === 'function') continue;
    const a = record.config[k], b = cfg[k];
    if (a === b || (a == null && b == null)) continue;
    if (typeof a === 'object' || typeof b === 'object') continue;
    changed.push(`${k}: ${a} -> ${b}`);
  }
  if (changed.length) { record.config = { ...cfg }; store.appendEvent(record, { type: 'config_refreshed', changed }); }
  return { record, changed };
};

// UNTOUCHED: the midnight case. Refresh, and say what moved.
{
  const rec = store.readRun(runId);
  ok((rec.events || []).length === 0 && (rec.state.positions || []).length === 0, 'the record is untouched');
  const { record, changed } = refresh(rec, { ...base, lossMax: 1500, lossTarget: 1050 });
  ok(record.config.lossMax === 1500, `an untouched record takes the roster's lossMax (${record.config.lossMax})`);
  ok(changed.some((c) => /lossMax: 1000 -> 1500/.test(c)), `and names what moved (${changed.join(', ')})`);
  ok((record.events || []).some((e) => e.type === 'config_refreshed'),
    'and records a config_refreshed event, so a silent strategy change is impossible');
}

// UNDER WAY: sealed. Changing the governor mid-session is worse than running the old one consistently.
{
  const rec = store.readRun(runId);
  rec.state.positions.push({ id: 'p1', side: 'bull', filled: true, legs: [{ side: 'long', type: 'C', strike: 100 }] });
  store.writeRun(rec);
  const { record, changed } = refresh(store.readRun(runId), { ...base, lossMax: 9999 });
  ok(record.config.lossMax === 1500, `a run with positions keeps its config (${record.config.lossMax})`);
  ok(changed.length === 0, 'and reports no change');
}

// THE POLLER MUST NOT CREATE. Reading a run that does not exist returns null — which is precisely the
// "no live orders, nothing to poll" case, so read is not just sufficient, it is the right question.
{
  const none = store.readRun(store.makeRunId('NDX', DAY, DAY, 'never-ran'));
  ok(none === null, 'reading a non-existent run returns null rather than creating one');
  ok(!fs.existsSync(path.join(tmp, `NDX_${DAY}_${DAY}_never-ran.json`)),
    'and writes no file — no more midnight phantom records');
}

console.log(`${pass} passed, ${fail} failed`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
process.exit(fail ? 1 : 0);
