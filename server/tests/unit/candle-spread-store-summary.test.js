'use strict';
// RUN-STORE SUMMARY SIDECARS. listRunsSummary() backs /api/v1/candle-spread/runs, which every compare and
// debug page load hits. It used to JSON.parse every run record IN FULL to read six small fields out of
// each. That was invisible while records were small; on 2026-09-16 a runaway floor-offset loop grew one
// record to 32,411 positions and listing the store became a ~140 MB transient allocation per request on a
// 1.9 GB box with a history of OOM from exactly that shape of spike.
//
// The sidecar must be a pure optimisation: identical output, and every way it can be absent or stale has
// to degrade to the old full-parse path rather than serve something wrong.
//
// Run: node server/tests/unit/candle-spread-store-summary.test.js
const os = require('os'), path = require('path'), fs = require('fs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-sum-'));
process.env.CANDLE_SPREAD_RUNS_DIR = tmp;
const store = require('../../src/candle-spread/store');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const sumPath = (runId) => path.join(tmp, '_summaries', `${runId}.json`);

const mk = (variant, nPos) => {
  const rec = store.initRun({ symbol: 'NDX', expiration: '2026-09-16', variant,
    variantLabel: `${variant} label`, spreadWidth: 20, coverSelector: 'fixed-mark' }, '2026-09-16');
  rec.state.positions = Array.from({ length: nPos }, (_, i) => ({ id: `p${i}`, filled: true, limit: 5,
    legs: [{ side: 'long', type: 'C', strike: 29000 + i }, { side: 'short', type: 'C', strike: 29020 + i }] }));
  rec.state.realizedPnl = 1234;
  rec.events = [{ type: 'x' }, { type: 'y' }];
  return store.writeRun(rec);
};

// ── THE SIDECAR IS WRITTEN, AND THE INDEX MATCHES A FULL PARSE ──────────────────────────────────────
{
  const rec = mk('v1-20', 3);
  ok(fs.existsSync(sumPath(rec.runId)), 'writeRun drops a sidecar');
  const viaSidecar = store.listRunsSummary().find(r => r.runId === rec.runId);
  const viaFullParse = store.summarize(rec.runId, store.readRun(rec.runId));
  ok(JSON.stringify(viaSidecar) === JSON.stringify(viaFullParse), 'sidecar output is identical to a full parse');
  ok(viaSidecar.positionCount === 3 && viaSidecar.realizedPnl === 1234 && viaSidecar.eventCount === 2,
    'the summary carries the fields the UI reads');
  ok(viaSidecar.variantLabel === 'v1-20 label' && viaSidecar.spreadWidth === 20, 'config fields survive');
  // The sidecar must be far smaller than the record — that IS the fix.
  const recBytes = fs.statSync(store.runFilePath(rec.runId)).size;
  const sumBytes = fs.statSync(sumPath(rec.runId)).size;
  ok(sumBytes < recBytes / 2, `sidecar is much smaller than the record (${sumBytes} vs ${recBytes})`);
}

// ── THE SIDECAR DIRECTORY MUST NOT LOOK LIKE A RUN ──────────────────────────────────────────────────
{
  const ids = store.listRunFiles();
  ok(!ids.includes('_summaries'), 'listRunFiles ignores the sidecar directory');
  ok(store.listRunsSummary().every(r => r.runId && r.symbol === 'NDX'), 'no phantom entries in the listing');
}

// ── STALE SIDECAR: the record is newer, so the sidecar must be ignored and rebuilt ───────────────────
{
  const rec = mk('v2-20', 1);
  // Write a sidecar claiming the wrong count, then touch the RECORD so it is newer.
  fs.writeFileSync(sumPath(rec.runId), JSON.stringify({ runId: rec.runId, positionCount: 999 }), 'utf8');
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(store.runFilePath(rec.runId), later, later);
  const got = store.listRunsSummary().find(r => r.runId === rec.runId);
  ok(got.positionCount === 1, `a sidecar older than its record is ignored (got ${got.positionCount})`);
  ok(JSON.parse(fs.readFileSync(sumPath(rec.runId), 'utf8')).positionCount === 1, 'and is healed on the way past');
}

// ── MISSING SIDECAR (every record predating this change) ────────────────────────────────────────────
{
  const rec = mk('v3-20', 4);
  fs.unlinkSync(sumPath(rec.runId));
  const got = store.listRunsSummary().find(r => r.runId === rec.runId);
  ok(got.positionCount === 4, 'a legacy record with no sidecar still lists correctly');
  ok(fs.existsSync(sumPath(rec.runId)), 'and is backfilled, so it is parsed in full at most once');
}

// ── CORRUPT SIDECAR must degrade, never throw or serve garbage ──────────────────────────────────────
{
  const rec = mk('v4-20', 2);
  fs.writeFileSync(sumPath(rec.runId), '{not json', 'utf8');
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(sumPath(rec.runId), later, later);        // NEWER than the record, so only parsing can reject it
  let threw = false, got = null;
  try { got = store.listRunsSummary().find(r => r.runId === rec.runId); } catch (e) { threw = true; }
  ok(!threw, 'an unreadable sidecar does not throw');
  ok(got && got.positionCount === 2, 'an unreadable sidecar falls back to the record');
}

// ── APPENDEVENT KEEPS IT CURRENT ────────────────────────────────────────────────────────────────────
// appendEvent -> writeRun is the hot path during a session; a sidecar that only refreshed on some writes
// would go stale mid-day and quietly re-introduce the full parse.
{
  const rec = mk('v5-20', 1);
  store.appendEvent(rec, { type: 'order_sent' });
  const got = store.listRunsSummary().find(r => r.runId === rec.runId);
  ok(got.eventCount === 3, `appendEvent refreshes the sidecar (got ${got.eventCount})`);
}

// ── THE ACTUAL POINT: a pathological record no longer makes LISTING expensive ────────────────────────
{
  const big = mk('v9-40', 30000);      // the 2026-09-16 shape: one record with tens of thousands of positions
  const recBytes = fs.statSync(store.runFilePath(big.runId)).size;
  ok(recBytes > 3e6, `fixture really is a large record (${(recBytes / 1e6).toFixed(1)} MB)`);
  const t0 = Date.now();
  const list = store.listRunsSummary();
  const ms = Date.now() - t0;
  ok(list.find(r => r.runId === big.runId).positionCount === 30000, 'the big record still summarises correctly');
  // Reading ~6 small sidecars cannot take as long as parsing a multi-MB record. Generous bound so this
  // is a regression test, not a benchmark that flakes on a busy machine.
  ok(ms < 250, `listing the whole store stays cheap (${ms}ms)`);
}

console.log(`${pass} passed, ${fail} failed`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
process.exit(fail ? 1 : 0);
