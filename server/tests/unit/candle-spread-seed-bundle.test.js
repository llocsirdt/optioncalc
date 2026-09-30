'use strict';
// ONE-SHOT SEED FROM A BUNDLE SHIPPED IN THE DEPLOY.
//
// After the 2026-09-29 instance replacement, prod's store was empty and the only copy of 29 trade dates was
// on the dev machine — which has no AWS credentials. Rather than mint a long-lived access key to upload once,
// the records ride in the deploy artifact (967 MB gzips to ~82 MB, a 12x ratio) and the instance seeds S3
// itself, using the write permission its own profile already has.
//
// What has to hold, and every one of these is a way it could quietly go wrong:
//   1. records reach BOTH local disk (the served history) and S3 (surviving the NEXT replacement)
//   2. a restart is a no-op, not 1,127 re-uploads
//   3. a newer local record is never overwritten by an older bundle
//   4. no bundle is a clean no-op, because that is every normal deploy
//   5. with S3 off it still restores the local history
//
// The fixture bundle is built here rather than reusing candle-spread-archive/, so this runs anywhere.
//
// Run: node server/tests/unit/candle-spread-seed-bundle.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const SB = require('../../src/candle-spread/seed-bundle');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-bundle-test-'));
const STORE = path.join(tmp, 'runs');
const FIXT = path.join(tmp, 'fixture');
fs.mkdirSync(FIXT, { recursive: true });

// Three plausible records plus the two kinds of file that must NOT travel as records.
const REC = (v) => JSON.stringify({ runId: `NDX_2026-09-29_2026-09-29_${v}`, tradeDate: '2026-09-29',
  config: { variant: v, symbol: 'NDX' },
  state: { positions: [{ id: 'p1', filled: true }, { id: 'p2', filled: true }], realizedPnl: 1730 },
  events: [{ type: 'candle_close' }, { type: 'eod_settlement', terminalPnl: -1300 }] }, null, 2);
const IDS = ['v7-10', 'v0-20', 'v9-40'].map((v) => `NDX_2026-09-29_2026-09-29_${v}`);
for (const v of ['v7-10', 'v0-20', 'v9-40']) fs.writeFileSync(path.join(FIXT, `NDX_2026-09-29_2026-09-29_${v}.json`), REC(v));
// A SUMMARY SIDECAR SHARES ITS RECORD'S runId. If the bundle shipped one flat it could be written over the
// place the real book belongs, so the builder excludes `_`-prefixed names and isRunFile rejects them.
fs.writeFileSync(path.join(FIXT, '_summaries-NDX_2026-09-29_2026-09-29_v7-10.json'), '{"summary":true}');
fs.writeFileSync(path.join(FIXT, 'notes.txt'), 'not a record');

const bundle = path.join(tmp, 'seed-runs.tgz');
execFileSync('tar', ['-czf', bundle, '-C', FIXT, '.'], { stdio: 'pipe' });

// A stand-in for run-archive, so this tests the SEEDER rather than the SDK.
function fakeArchive(objects) {
  const s3 = new Map();
  const blobs = objects || new Map();         // raw keys (the seed bundle), separate from run records
  const counts = { head: 0, download: 0 };
  return { s3, blobs, counts, PREFIX: 'runs', BUCKET: 'b', enabled: () => true,
    async headObject(key) {
      counts.head++;
      if (!blobs.has(key)) return { ok: false, error: 'NoSuchKey' };
      // A stable identity for the bytes, standing in for the real ETag.
      const b = blobs.get(key);
      return { ok: true, etag: require('crypto').createHash('md5').update(b).digest('hex'), size: b.length };
    },
    async getObjectToFile(key, dest) {
      counts.download++;
      if (!blobs.has(key)) return { ok: false, error: 'NoSuchKey' };
      fs.writeFileSync(dest, blobs.get(key));
      return { ok: true, bytes: fs.statSync(dest).size, path: dest };
    },
    async putRun(id, body) { s3.set(id, body); return { ok: true }; },
    async getRun(id) { return s3.has(id) ? { ok: true, body: s3.get(id) } : { ok: false, error: 'NoSuchKey' }; },
    async listRuns() { return { ok: true, ids: [...s3.keys()].filter((k) => k.split('_').length >= 3 && !k.startsWith('_')) }; } };
}
const log = () => {};

(async () => {
  ok(SB.isRunFile('NDX_2026-09-29_2026-09-29_v7-10.json') === true, 'a runId filename is a run file');
  ok(SB.isRunFile('_summaries-NDX_2026-09-29_2026-09-29_v7-10.json') === false,
    'an underscore-prefixed sidecar is NOT — it shares the real record\'s id');
  ok(SB.isRunFile('notes.txt') === false && SB.isRunFile('nodate.json') === false,
    'and neither is anything without a trade date');

  // ── 1. A REPLACED INSTANCE: empty store, empty bucket, bundle in the deploy ──────────────────────
  const A = fakeArchive();
  fs.mkdirSync(STORE, { recursive: true });
  const r1 = await SB.seedFromBundle({ runsDir: STORE, archive: A, bundle, log });
  const onDisk = fs.readdirSync(STORE).filter((f) => f.endsWith('.json'));
  ok(r1.found === true && r1.files === 3, `the bundle is found and only records counted (${r1.files})`);
  ok(r1.toDisk === 3 && onDisk.length === 3, `all 3 land on disk (${r1.toDisk})`);
  ok(r1.toS3 === 3, `and all 3 reach S3 — local disk alone would be lost in the next swap (${r1.toS3})`);
  ok(!onDisk.some((f) => f.startsWith('_')), 'no sidecar was written as a record');
  const got = JSON.parse(fs.readFileSync(path.join(STORE, `${IDS[0]}.json`), 'utf8'));
  ok(got.state.realizedPnl === 1730 && got.state.positions.length === 2 && got.events.length === 2,
    'the record arrives intact — positions, realized P&L and events');
  ok(A.s3.has(`_seed_${r1.tag}`), 'a one-shot marker is written, keyed by the bundle hash');

  // ── 2. A RESTART MUST NOT RE-UPLOAD ─────────────────────────────────────────────────────────────
  const before = A.s3.size;
  const r2 = await SB.seedFromBundle({ runsDir: STORE, archive: A, bundle, log });
  ok(r2.alreadySeeded === true && r2.toS3 === 0 && A.s3.size === before,
    'a restart is a no-op rather than re-uploading everything');

  // ── 3. A NEWER LOCAL RECORD WINS ────────────────────────────────────────────────────────────────
  // The safety property. A record on disk was written by a running engine; the bundle was built earlier.
  fs.writeFileSync(path.join(STORE, `${IDS[0]}.json`), '{"live":"newer"}', 'utf8');
  A.s3.delete(`_seed_${r1.tag}`);                       // force another pass
  const r3 = await SB.seedFromBundle({ runsDir: STORE, archive: A, bundle, log });
  ok(JSON.parse(fs.readFileSync(path.join(STORE, `${IDS[0]}.json`), 'utf8')).live === 'newer',
    'a live local record is NOT overwritten by the bundle');
  ok(r3.skippedDisk === 3, `and the ones already present are skipped, not rewritten (${r3.skippedDisk})`);

  // ── 4. NO BUNDLE IS THE NORMAL CASE ─────────────────────────────────────────────────────────────
  const r4 = await SB.seedFromBundle({ runsDir: STORE, archive: A, bundle: path.join(tmp, 'absent.tgz'), log });
  ok(r4.found === false && r4.files === 0 && !r4.error, 'a deploy with no bundle does nothing, quietly');

  // ── 5. S3 OFF: THE SERVED HISTORY STILL COMES BACK ──────────────────────────────────────────────
  const STORE2 = path.join(tmp, 'runs2');
  const r5 = await SB.seedFromBundle({ runsDir: STORE2, archive: { enabled: () => false }, bundle, log });
  ok(r5.toDisk === 3 && r5.toS3 === 0, 'with the archive disabled it still restores local records');
  ok(fs.readdirSync(STORE2).filter((f) => f.endsWith('.json')).length === 3, 'so compare and debug work again');

  // ── 6. A FAILING UPLOAD MUST NOT MARK THE SEED DONE ─────────────────────────────────────────────
  // Marking a partial seed complete would strand the remainder until someone noticed.
  {
    const bad = fakeArchive();
    bad.putRun = async (id) => (String(id).startsWith('_seed_') ? { ok: true } : { ok: false, error: 'AccessDenied' });
    const STORE3 = path.join(tmp, 'runs3');
    const r6 = await SB.seedFromBundle({ runsDir: STORE3, archive: bad, bundle, log });
    ok(r6.failed === 3 && r6.toS3 === 0, `every upload failed and is counted (${r6.failed})`);
    ok(![...bad.s3.keys()].some((k) => k.startsWith('_seed_')),
      'and NO marker is written, so the next boot retries instead of stranding it');
  }

  // ── 7. A CORRUPT BUNDLE IS REPORTED, NOT THROWN ─────────────────────────────────────────────────
  {
    const junk = path.join(tmp, 'junk.tgz');
    fs.writeFileSync(junk, 'this is not a tarball');
    const r7 = await SB.seedFromBundle({ runsDir: path.join(tmp, 'runs4'), archive: fakeArchive(), bundle: junk, log });
    ok(r7.found === true && /unpack failed/.test(r7.error || ''), `an unreadable bundle reports an error (${r7.error})`);
  }

  // ── 7b. THE BUNDLE CAN COME FROM S3 INSTEAD OF THE DEPLOY ───────────────────────────────────────
  // Shipping 81 MB inside the application version is legitimate but impractical: the EB console's browser
  // upload fails at that size ("Failed to Fetch", 2026-09-30) and every later deploy would carry bytes it
  // does not need. The S3 console handles one large file properly, so the bundle is uploaded there once and
  // the instance streams it down.
  {
    const blobs = new Map([['runs/_seed/seed-runs.tgz', fs.readFileSync(bundle)]]);
    const A2 = fakeArchive(blobs);
    const STORE7 = path.join(tmp, 's3src', 'runs');
    fs.mkdirSync(STORE7, { recursive: true });
    const r = await SB.seedFromBundle({ runsDir: STORE7, archive: A2,
      bundle: path.join(tmp, 'no-local-bundle.tgz'), log });
    ok(r.found === true && r.source === 's3', `with no bundle in the deploy it fetches from S3 (${r.source})`);
    ok(r.toDisk === 3 && r.toS3 === 3, `and seeds exactly as the deploy path does (${r.toDisk}/${r.toS3})`);
    ok(!fs.existsSync(path.join(path.dirname(path.resolve(STORE7)), '_seed-download')),
      'the downloaded bundle is cleaned up — 81 MB of scratch must not linger and be re-hashed every boot');
    // ONCE SEEDED, A BUNDLE LEFT IN THE BUCKET MUST NOT BE DOWNLOADED AGAIN.
    // The first version fetched all 81 MB and only then hashed it to look for the marker, so leaving the
    // bundle in place cost a full download on every boot and deploy forever, purely to rediscover it had
    // already been applied. ETag identifies it in one cheap HeadObject instead.
    {
      const downloadsAfterSeed = A2.counts.download;
      const again = await SB.seedFromBundle({ runsDir: STORE7, archive: A2,
        bundle: path.join(tmp, 'no-local-bundle.tgz'), log });
      ok(again.alreadySeeded === true, 'a second boot sees the marker');
      ok(A2.counts.download === downloadsAfterSeed,
        `and transfers NOTHING — no re-download of the bundle (${A2.counts.download} vs ${downloadsAfterSeed})`);
      ok(A2.counts.head > 0, 'it identified the object by HeadObject instead');
    }

    // Absent from BOTH places is the normal case for every ordinary deploy.
    const r2 = await SB.seedFromBundle({ runsDir: STORE7, archive: fakeArchive(),
      bundle: path.join(tmp, 'no-local-bundle.tgz'), log });
    ok(r2.found === false && !r2.error, 'no bundle in the deploy and none in S3 -> a silent no-op');
  }

  // ── 8. IT MUST NOT STAGE IN os.tmpdir() ─────────────────────────────────────────────────────────
  // THE REGRESSION. The first version unpacked into os.tmpdir(), which on the EB platform is a RAM-BACKED
  // tmpfs sized at about half the instance memory (956 MB). The archive unpacks to 967 MB, so the real
  // deploy died of ENOSPC by ~11 MB, the finally-block cleanup erased the evidence, and the only symptom was
  // storeFiles and puts flat at 0 for four minutes. A slightly smaller bundle would have "worked" while
  // eating a gigabyte of RAM on a box with a documented OOM history — the worse outcome.
  //
  // Every test above passed with that bug present, because a dev machine's /tmp has room. So assert the
  // PLACE, not the outcome: staging belongs beside the run store, on the root disk.
  {
    const STORE5 = path.join(tmp, 'deep', 'runs');
    fs.mkdirSync(STORE5, { recursive: true });
    const seen = [];
    const realMkdtemp = fs.mkdtempSync;
    fs.mkdtempSync = (pfx) => { seen.push(pfx); return realMkdtemp(pfx); };
    try {
      await SB.seedFromBundle({ runsDir: STORE5, archive: fakeArchive(), bundle, log });
    } finally { fs.mkdtempSync = realMkdtemp; }
    ok(seen.length === 1, `staging was created exactly once (${seen.length})`);
    const where = seen[0] || '';
    // The discriminator is BESIDE THE STORE, not "avoids os.tmpdir()" — this test's own fixture lives under
    // os.tmpdir(), so a lexical check on that would fail for the correct path too. With the bug, stageRoot
    // was os.tmpdir() itself, which is not under the store's parent, so this is what catches it.
    const beside = path.join(path.dirname(path.resolve(STORE5)), '_seed-staging');
    ok(where.startsWith(beside + path.sep) || where.startsWith(beside),
      `staging sits beside the run store, on the same filesystem, so records rename into place for free `
      + `(wanted under ${beside}, got ${where})`);
    ok(!fs.existsSync(path.join(path.dirname(path.resolve(STORE5)), '_seed-staging')),
      'and the staging tree is removed afterwards');
    ok(fs.readdirSync(STORE5).filter((f) => f.endsWith('.json')).length === 3,
      'while the records still land where they belong');
  }

  // ── 9. REFUSE BEFORE FILLING A DISK ─────────────────────────────────────────────────────────────
  {
    const STORE6 = path.join(tmp, 'tight', 'runs');
    fs.mkdirSync(STORE6, { recursive: true });
    const realStatfs = fs.statfsSync;
    fs.statfsSync = () => ({ bavail: 1, bsize: 1024 });        // ~1 KB free
    let r;
    try { r = await SB.seedFromBundle({ runsDir: STORE6, archive: fakeArchive(), bundle, log }); }
    finally { fs.statfsSync = realStatfs; }
    ok(/not enough room/.test(r.error || ''), `a full disk is refused up front (${r.error})`);
    ok(r.toDisk === 0 && fs.readdirSync(STORE6).length === 0,
      'nothing is written, so a half-filled disk is not the failure mode');
  }

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
