'use strict';
// OFF-INSTANCE DURABLE STORAGE — write-through and rehydrate.
//
// The failure this exists for: /var/optioncalc-data survives an in-place restart but NOT instance
// replacement. A fresh EBS volume means ensureDir() makes an empty store and the day's book is gone —
// 2026-09-01, and again 2026-09-29 20:11 ET (store `files: 0` on a disk 37% full). Harmless while simulated;
// with real money the engine reboots blind while real positions sit at the broker.
//
// THE PROPERTY THAT MATTERS MOST IS NOT "IT COPIES FILES". It is that NOTHING here can take the engine down.
// A durability layer that throws into a tick is worse than no durability layer, so every failure mode below
// is asserted to degrade quietly and stay counted.
//
// Run: node server/tests/unit/candle-spread-run-archive.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'run-archive-test-'));

// ── A FAKE S3, INSTALLED IN require.cache ───────────────────────────────────────────────────────────
// run-archive lazy-requires @aws-sdk/client-s3, which is exactly what makes it testable without the real
// SDK or a network: seed the module cache and the lazy require finds this instead.
// require.cache is keyed by RESOLVED FILENAME, and an uninstalled package has none — so seeding the cache
// cannot work here. Intercept the loader instead, which is also closer to what we are testing: run-archive's
// lazy `require` is the seam, and this exercises it exactly as production does.
const Module = require('module');
const _origLoad = Module._load;
let FAKE = null;                       // null = fall through to the real loader (i.e. "SDK not installed")
Module._load = function (request, parent, isMain) {
  if (request === '@aws-sdk/client-s3') {
    if (FAKE) return FAKE;
    const e = new Error("Cannot find module '@aws-sdk/client-s3'");
    e.code = 'MODULE_NOT_FOUND';
    throw e;
  }
  return _origLoad.apply(this, arguments);
};

function installFakeS3(behaviour = {}) {
  const store = new Map();                       // Key -> body string
  const calls = { put: 0, get: 0, list: 0 };
  const mod = {
    S3Client: class {
      constructor(cfg) { this.cfg = cfg; }
      async send(cmd) {
        if (behaviour.throwOn === cmd._kind) throw new Error(`boom-${cmd._kind}`);
        if (cmd._kind === 'put') { calls.put++; store.set(cmd.input.Key, String(cmd.input.Body)); return {}; }
        if (cmd._kind === 'get') {
          calls.get++;
          if (!store.has(cmd.input.Key)) { const e = new Error('NoSuchKey'); e.name = 'NoSuchKey'; throw e; }
          const body = store.get(cmd.input.Key);
          return { Body: { transformToString: async () => body } };
        }
        if (cmd._kind === 'list') {
          calls.list++;
          const pre = cmd.input.Prefix || '';
          const keys = [...store.keys()].filter((k) => k.startsWith(pre)).sort();
          // Page at 2 keys so the pagination loop is actually exercised, not assumed.
          const start = cmd.input.ContinuationToken ? Number(cmd.input.ContinuationToken) : 0;
          const page = keys.slice(start, start + 2);
          const done = start + 2 >= keys.length;
          return { Contents: page.map((k) => ({ Key: k })), IsTruncated: !done,
            NextContinuationToken: done ? null : String(start + 2) };
        }
        throw new Error('unknown command');
      }
    },
    PutObjectCommand: class { constructor(input) { this.input = input; this._kind = 'put'; } },
    GetObjectCommand: class { constructor(input) { this.input = input; this._kind = 'get'; } },
    ListObjectsV2Command: class { constructor(input) { this.input = input; this._kind = 'list'; } },
  };
  FAKE = mod;
  return { store, calls, mod, behaviour };
}

// run-archive reads env at load, so each scenario needs a fresh copy of the module.
function loadArchive(env) {
  const p = require.resolve('../../src/candle-spread/run-archive');
  delete require.cache[p];
  const saved = {};
  for (const k of ['CANDLE_SPREAD_S3_BUCKET', 'CANDLE_SPREAD_S3_PREFIX', 'AWS_REGION']) {
    saved[k] = process.env[k];
    if (env && env[k] != null) process.env[k] = env[k]; else delete process.env[k];
  }
  const A = require(p);
  return { A, restore: () => { for (const [k, v] of Object.entries(saved)) { if (v == null) delete process.env[k]; else process.env[k] = v; } } };
}

(async () => {
  // ── 1. UNCONFIGURED IS A NO-OP, NOT AN ERROR ──────────────────────────────────────────────────────
  {
    const { A, restore } = loadArchive({});
    ok(A.enabled() === false, 'no bucket -> disabled');
    ok(/not set/.test(A.health().disabledReason || ''), 'and it says why');
    const r = await A.putRun('X', '{}');
    ok(r.ok === false && r.disabled === true, 'putRun resolves with disabled rather than throwing');
    const g = await A.getRun('X');
    ok(g.ok === false, 'getRun resolves too');
    const d = await A.restoreDay('2026-09-29', path.join(tmp, 'nope'));
    ok(d.enabled === false && d.restored === 0, 'restoreDay is a no-op and reports why');
    ok(!fs.existsSync(path.join(tmp, 'nope')), 'and it does not even create the directory');
    restore();
  }

  // ── 2. ROUND TRIP: PUT THEN RESTORE ───────────────────────────────────────────────────────────────
  {
    installFakeS3();
    const { A, restore } = loadArchive({ CANDLE_SPREAD_S3_BUCKET: 'b', CANDLE_SPREAD_S3_PREFIX: 'runs' });
    ok(A.enabled() === true, 'a bucket plus an SDK -> enabled');
    const body = JSON.stringify({ runId: 'NDX_2026-09-29_2026-09-29_v7-10', hello: 'world' }, null, 2);
    const p1 = await A.putRun('NDX_2026-09-29_2026-09-29_v7-10', body);
    ok(p1.ok === true, 'putRun succeeds');
    await A.putRun('NDX_2026-09-29_2026-09-29_v0-10', '{"runId":"v0"}');
    await A.putRun('NDX_2026-09-28_2026-09-28_v7-10', '{"runId":"yesterday"}');

    const l = await A.listRuns();
    ok(l.ok && l.ids.length === 3, `listRuns paginates and finds all 3 (${l.ids.length})`);
    const l1 = await A.listRuns('2026-09-29');
    ok(l1.ok && l1.ids.length === 2, `listRuns filters by trade date (${l1.ids.length})`);

    const dir = path.join(tmp, 'store1');
    const d = await A.restoreDay('2026-09-29', dir);
    ok(d.restored === 2 && d.failed === 0, `restoreDay writes only that day (${d.restored} restored, ${d.failed} failed)`);
    ok(fs.existsSync(path.join(dir, 'NDX_2026-09-29_2026-09-29_v7-10.json')), 'the file lands with its runId name');
    ok(fs.readFileSync(path.join(dir, 'NDX_2026-09-29_2026-09-29_v7-10.json'), 'utf8') === body,
      'BYTE-IDENTICAL to what was put — a restore is a copy, not a re-serialisation');
    ok(!fs.existsSync(path.join(dir, 'NDX_2026-09-28_2026-09-28_v7-10.json')), "yesterday's record is not pulled in");
    ok(!fs.readdirSync(dir).some((f) => f.endsWith('.restoring')), 'no temp files are left behind');
    restore();
  }

  // ── 3. A LOCAL RECORD IS NEVER OVERWRITTEN ────────────────────────────────────────────────────────
  // The safety property. If the instance still holds today's book, that copy is LIVE and S3 is behind it by
  // up to one write. Clobbering it would lose the newest events — the opposite of the job.
  {
    installFakeS3();
    const { A, restore } = loadArchive({ CANDLE_SPREAD_S3_BUCKET: 'b' });
    await A.putRun('NDX_2026-09-29_2026-09-29_v7-10', '{"from":"s3","stale":true}');
    const dir = path.join(tmp, 'store2');
    fs.mkdirSync(dir, { recursive: true });
    const local = path.join(dir, 'NDX_2026-09-29_2026-09-29_v7-10.json');
    fs.writeFileSync(local, '{"from":"local","live":true}', 'utf8');
    const d = await A.restoreDay('2026-09-29', dir);
    ok(d.restored === 0 && d.skippedPresent === 1, `an existing record is skipped, not restored (${JSON.stringify({ r: d.restored, s: d.skippedPresent })})`);
    ok(JSON.parse(fs.readFileSync(local, 'utf8')).from === 'local', 'and the LIVE local copy still wins');
    restore();
  }

  // ── 4. EVERY FAILURE DEGRADES, NOTHING THROWS ─────────────────────────────────────────────────────
  {
    installFakeS3({ throwOn: 'put' });
    const { A, restore } = loadArchive({ CANDLE_SPREAD_S3_BUCKET: 'b' });
    const r = await A.putRun('X', '{}');
    ok(r.ok === false && /boom-put/.test(r.error || ''), 'a failing put resolves with the error');
    ok(A.health().putFails === 1, 'and it is COUNTED, so a silently-degraded archive is visible');
    ok(/put/i.test(A.health().lastError || ''), 'with the reason recorded on health()');
    restore();
  }
  {
    installFakeS3({ throwOn: 'list' });
    const { A, restore } = loadArchive({ CANDLE_SPREAD_S3_BUCKET: 'b' });
    const d = await A.restoreDay('2026-09-29', path.join(tmp, 'store3'));
    ok(d.restored === 0 && !!d.error, 'a failing list leaves restoreDay reporting an error, not throwing');
    restore();
  }
  {
    // SEED FIRST, THEN BREAK GET. Starting with a throwing get leaves the bucket empty, so `restored === 0`
    // would hold whether or not the failure path worked — the assertion would prove nothing.
    const fake = installFakeS3();
    const { A, restore } = loadArchive({ CANDLE_SPREAD_S3_BUCKET: 'b' });
    await A.putRun('NDX_2026-09-29_2026-09-29_v7-10', '{"a":1}');
    await A.putRun('NDX_2026-09-29_2026-09-29_v0-10', '{"b":2}');
    const dir = path.join(tmp, 'store4');
    const control = await A.restoreDay('2026-09-29', dir);
    ok(control.restored === 2, `control: with get working, both records restore (${control.restored})`);

    fake.behaviour.throwOn = 'get';                     // now every fetch fails
    const dir2 = path.join(tmp, 'store4b');
    const d = await A.restoreDay('2026-09-29', dir2);
    ok(d.listed === 2 && d.restored === 0 && d.failed === 2,
      `a failing get is counted per record and restores nothing (listed ${d.listed}, failed ${d.failed})`);
    ok(fs.existsSync(dir2) && fs.readdirSync(dir2).length === 0, 'leaving the store empty rather than half-written');
    ok(A.health().getFails >= 2, 'and the failures are counted on health()');
    restore();
  }
  // A MISSING SDK must disable the archive, never crash the process on boot.
  {
    const saved = FAKE;
    FAKE = null;                       // as if the package were not installed
    const { A, restore } = loadArchive({ CANDLE_SPREAD_S3_BUCKET: 'b' });
    ok(A.enabled() === false, 'no SDK installed -> disabled rather than a crash loop');
    ok(/unavailable/i.test(A.health().disabledReason || ''), `and health says so (${A.health().disabledReason})`);
    restore();
    FAKE = saved;
  }

  // ── 5. store.writeRun SHIPS A COPY, AND A BROKEN ARCHIVE CANNOT BREAK A WRITE ─────────────────────
  {
    const { store: s3store } = installFakeS3();
    const runsDir = path.join(tmp, 'live-store');
    const savedDir = process.env.CANDLE_SPREAD_RUNS_DIR;
    const savedBucket = process.env.CANDLE_SPREAD_S3_BUCKET;
    process.env.CANDLE_SPREAD_RUNS_DIR = runsDir;
    process.env.CANDLE_SPREAD_S3_BUCKET = 'b';
    delete require.cache[require.resolve('../../src/candle-spread/run-archive')];
    delete require.cache[require.resolve('../../src/candle-spread/store')];
    const store = require('../../src/candle-spread/store');
    const rec = store.initRun({ symbol: 'NDX', expiration: '2026-09-29', variant: 'v7-10' }, '2026-09-29');
    store.writeRun(rec);
    await new Promise((r) => setTimeout(r, 20));        // the ship is fire-and-forget
    ok(fs.existsSync(path.join(runsDir, 'NDX_2026-09-29_2026-09-29_v7-10.json')), 'writeRun still writes locally');
    ok([...s3store.keys()].some((k) => k.includes('v7-10')), `and a copy reaches the archive (${[...s3store.keys()].join(',')})`);
    const localBody = fs.readFileSync(path.join(runsDir, 'NDX_2026-09-29_2026-09-29_v7-10.json'), 'utf8');
    ok(s3store.get([...s3store.keys()].find((k) => k.includes('v7-10'))) === localBody,
      'byte-identical to the file on disk');

    // Now make every archive call throw: the local write MUST still succeed.
    installFakeS3({ throwOn: 'put' });
    delete require.cache[require.resolve('../../src/candle-spread/run-archive')];
    let threw = null;
    try { store.writeRun(rec); } catch (e) { threw = e; }
    await new Promise((r) => setTimeout(r, 20));
    ok(threw === null, 'a throwing archive does NOT throw out of writeRun — the tick is untouched');
    ok(fs.existsSync(path.join(runsDir, 'NDX_2026-09-29_2026-09-29_v7-10.json')), 'and the record is on disk regardless');

    if (savedDir == null) delete process.env.CANDLE_SPREAD_RUNS_DIR; else process.env.CANDLE_SPREAD_RUNS_DIR = savedDir;
    if (savedBucket == null) delete process.env.CANDLE_SPREAD_S3_BUCKET; else process.env.CANDLE_SPREAD_S3_BUCKET = savedBucket;
    delete require.cache[require.resolve('../../src/candle-spread/store')];
  }

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
