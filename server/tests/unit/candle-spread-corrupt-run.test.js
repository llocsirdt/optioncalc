'use strict';
// A FILE THAT WILL NOT PARSE IS NOT AN ABSENT FILE.
//
// readRun caught everything and returned null; initRun reads null as "no run today" and writes a
// brand-new empty record over the top. So a truncated write — disk full, or the OOM kill this box has a
// documented history of — silently DESTROYED the only copy of a day's positions and restarted the variant
// from zero, mid-session, with real orders already at the broker. The store's own header calls durable
// position recording a CRITICAL TODO for exactly this class of loss.
//
// Run: node server/tests/unit/candle-spread-corrupt-run.test.js
const os = require('os'), path = require('path'), fs = require('fs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-corrupt-'));
process.env.CANDLE_SPREAD_RUNS_DIR = tmp;
const store = require('../../src/candle-spread/store');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

const cfg = { symbol: 'NDX', expiration: '2026-09-24', variant: 'cor', spreadWidth: 20 };
const DAY = '2026-09-24';
const runId = store.makeRunId(cfg.symbol, cfg.expiration, DAY, cfg.variant);
const file = path.join(tmp, `${runId}.json`);

// A day with real positions on it, then truncated mid-write.
{
  const rec = store.initRun(cfg, DAY);
  rec.state.positions.push({ id: 'pos-1', side: 'bull', filled: true, limit: 8.05,
    legs: [{ side: 'long', type: 'C', strike: 29390 }, { side: 'short', type: 'C', strike: 29410 }] });
  rec.state.realizedPnl = 1234;
  store.writeRun(rec);
  const whole = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, whole.slice(0, Math.floor(whole.length * 0.6)), 'utf8');   // truncated write
  ok(store.readRunStatus(runId).state === 'corrupt', 'a truncated record reads as CORRUPT');
  ok(store.readRunStatus(`${runId}-nope`).state === 'missing', 'and an absent one still reads as MISSING');
}

// initRun must not write over it.
{
  const before = fs.readFileSync(file, 'utf8');
  const rec2 = store.initRun(cfg, DAY);
  const quarantined = fs.readdirSync(tmp).filter((f) => f.startsWith('_corrupt_'));
  ok(quarantined.length === 1, `the bad file is moved aside, not overwritten (${quarantined.length} quarantined)`);
  ok(fs.readFileSync(path.join(tmp, quarantined[0]), 'utf8') === before,
    'and the quarantined copy is byte-identical to what was on disk');
  ok(rec2.recoveredFromCorrupt && rec2.recoveredFromCorrupt.quarantined,
    'the fresh record says it was recovered from a corrupt one');
  ok((rec2.events || []).some((e) => e.type === 'run_file_corrupt'),
    'and carries a run_file_corrupt event, so the day is not silently a fresh morning');
  ok(rec2.state.positions.length === 0 && rec2.state.realizedPnl === 0,
    'the new record is honestly EMPTY — it does not claim the lost book');
  ok(/does not describe any orders placed before now/.test((rec2.events[0] || {}).note || ''),
    'and the event says exactly that');
}

// The quarantine name is `_`-prefixed, which listRunFiles already treats as internal — a corrupt copy
// must never show up as a session on the compare page.
{
  const listed = store.listRunFiles ? store.listRunFiles() : [];
  ok(!listed.some((f) => String(f).includes('_corrupt_')), 'a quarantined file is not listed as a run');
}

// Reading the same day again now finds the fresh record and leaves it alone.
{
  const again = store.initRun(cfg, DAY);
  ok(again.runId === runId && !again.events.some((e, i) => i > 0 && e.type === 'run_file_corrupt'),
    'a second initRun returns the existing record without re-flagging it');
  ok(fs.readdirSync(tmp).filter((f) => f.startsWith('_corrupt_')).length === 1, 'and quarantines nothing more');
}

console.log(`${pass} passed, ${fail} failed`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
process.exit(fail ? 1 : 0);
