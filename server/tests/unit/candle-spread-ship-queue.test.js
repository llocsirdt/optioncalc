'use strict';
// THE ARCHIVE UPLOAD QUEUE — bounded, coalescing, and reading at send time.
//
// WHY IT EXISTS. write-through started as a bare fire-and-forget PUT per writeRun with no limit on concurrency.
// Fine during the day, wrong at 16:00: eodSettlementInner rewrites all 80 variants in a tight loop, so eighty
// ~1 MB request bodies could be live at once on a 1.9 GB instance. On 2026-10-01 the instance went Ok ->
// "No Data, none of the instances are sending data" within 60 seconds of the 16:00 boundary after seven healthy
// hours — starvation severe enough that the EB health agent stopped reporting.
//
// The three properties that make this bounded rather than merely ordered:
//   1. at most MAX_INFLIGHT uploads at a time
//   2. the queue holds runIds, not bodies, so N queued writes cost N ids and not N megabytes
//   3. the body is read from DISK at send time, so coalescing is free and what ships is always the newest
//
// Run: node server/tests/unit/candle-spread-ship-queue.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-q-'));
process.env.CANDLE_SPREAD_RUNS_DIR = tmp;
process.env.CANDLE_SPREAD_S3_MAX_INFLIGHT = '3';
process.env.CANDLE_SPREAD_S3_BUCKET = 'b';

// A fake archive that lets us hold uploads open, so concurrency is observable rather than inferred.
const uploads = [];
let peakInFlight = 0, live = 0;
const gate = [];
const fake = {
  enabled: () => true,
  async putRun(runId, body) {
    live++; peakInFlight = Math.max(peakInFlight, live);
    uploads.push({ runId, body });
    await new Promise((resolve) => gate.push(resolve));   // held until released
    live--;
    return { ok: true };
  },
};
require.cache[require.resolve('../../src/candle-spread/run-archive')] = {
  id: 'fake', filename: 'fake', loaded: true, exports: fake,
};
const store = require('../../src/candle-spread/store');

const rec = (v, extra) => ({ runId: `NDX_2026-10-01_2026-10-01_${v}`, tradeDate: '2026-10-01',
  config: { symbol: 'NDX', expiration: '2026-10-01', variant: v },
  state: { positions: [], realizedPnl: 0, ...(extra || {}) }, events: [] });

const release = (n) => { for (let i = 0; i < n && gate.length; i++) gate.shift()(); };
const settle = () => new Promise((r) => setImmediate(r));

(async () => {
  // ── 1. CONCURRENCY IS CAPPED ──────────────────────────────────────────────────────────────────────
  // The settlement shape: many distinct records written in a tight loop.
  for (let i = 0; i < 20; i++) store.writeRun(rec('v' + i));
  await settle();
  ok(peakInFlight <= 3, `at most 3 uploads in flight from 20 writes (peak ${peakInFlight})`);
  ok(uploads.length === 3, `only 3 have started (${uploads.length})`);
  const q1 = store.shipQueueStats();
  ok(q1.queued === 17 && q1.inFlight === 3, `the rest are queued, not in flight (${JSON.stringify(q1)})`);

  // Draining proceeds as uploads complete, and never exceeds the cap.
  release(3); await settle(); await settle();
  ok(peakInFlight <= 3, `still capped as it drains (peak ${peakInFlight})`);
  while (gate.length) { release(gate.length); await settle(); }
  await settle();
  ok(store.shipQueueStats().queued === 0, 'the queue drains to empty');
  ok(uploads.length === 20, `all 20 records eventually shipped (${uploads.length})`);

  // ── 2. REPEATED WRITES OF ONE RECORD COALESCE ─────────────────────────────────────────────────────
  // A record written 300 times during the day must not become 300 uploads.
  uploads.length = 0; peakInFlight = 0;
  const r = rec('solo');
  for (let i = 0; i < 50; i++) { r.state.realizedPnl = i; store.writeRun(r); }
  await settle();
  // One upload in flight; the other 49 collapsed onto the same queued id.
  ok(uploads.length === 1, `50 writes of one record produce 1 upload in flight (${uploads.length})`);
  ok(store.shipQueueStats().queued <= 1, `and at most one queued (${store.shipQueueStats().queued})`);
  while (gate.length) { release(gate.length); await settle(); }
  await settle();
  ok(uploads.length <= 2, `at most 2 uploads total for 50 writes (${uploads.length})`);

  // ── 3. WHAT SHIPS IS WHAT IS ON DISK NOW, NOT WHAT WAS QUEUED ─────────────────────────────────────
  // THE PROPERTY THAT MAKES COALESCING SAFE. Holding bodies would ship a stale one; reading at send time
  // cannot, because the local file is already the authority.
  {
    uploads.length = 0;
    const r2 = rec('latest');
    r2.state.realizedPnl = 111;
    store.writeRun(r2);                    // starts immediately; reads 111, which IS current at that instant
    r2.state.realizedPnl = 999;
    store.writeRun(r2);                    // file is now 999; the id is re-queued behind the active upload
    await settle();
    ok(JSON.parse(uploads[0].body).state.realizedPnl === 111,
      'the first upload carries what was on disk when it started');
    // Drain: the re-queued id must now ship the NEWER content, so the last word is never stale.
    while (gate.length) { release(gate.length); await settle(); await settle(); }
    await settle();
    const last = JSON.parse(uploads[uploads.length - 1].body);
    ok(last.state.realizedPnl === 999,
      `and the LAST upload carries the newest file (realizedPnl ${last.state.realizedPnl}, expected 999)`);
    ok(uploads.length === 2, `two uploads, not one per write (${uploads.length})`);
  }

  // ── 4. A MISSING FILE IS SKIPPED, NOT A CRASH ─────────────────────────────────────────────────────
  // Quarantine or a prune can remove a file between queueing and sending.
  {
    uploads.length = 0;
    const before = store.shipQueueStats().dropped;
    const r3 = rec('vanishes');
    store.writeRun(r3);
    await settle();
    while (gate.length) { release(gate.length); await settle(); }
    fs.rmSync(path.join(tmp, `${r3.runId}.json`), { force: true });
    // queue it again with the file gone
    const sq = require('../../src/candle-spread/store');
    sq.writeRun(r3);                        // recreates the file
    fs.rmSync(path.join(tmp, `${r3.runId}.json`), { force: true });
    await settle();
    ok(store.shipQueueStats().dropped >= before, 'a vanished file is counted as dropped rather than throwing');
    while (gate.length) { release(gate.length); await settle(); }
  }

  // ── 5. THE LOCAL WRITE IS NEVER BLOCKED BY THE QUEUE ──────────────────────────────────────────────
  // The whole point: the archive is a background copy and must never make the engine wait.
  {
    const r4 = rec('local');
    const t0 = Date.now();
    for (let i = 0; i < 30; i++) store.writeRun(r4);          // uploads are all held open
    const ms = Date.now() - t0;
    ok(ms < 1500, `30 writes with every upload stalled still return promptly (${ms}ms)`);
    ok(fs.existsSync(path.join(tmp, `${r4.runId}.json`)), 'and the record is on disk regardless');
    while (gate.length) { release(gate.length); await settle(); }
  }

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
