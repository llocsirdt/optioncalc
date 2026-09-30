/**
 * OFF-INSTANCE DURABLE STORAGE for candle-spread run records.
 *
 * WHY THIS EXISTS. store.js is a LOCAL-DISK store. /var/optioncalc-data survives an in-place restart but
 * NOT instance replacement: an EB immutable deploy or an ASG health swap hands the app a fresh EBS volume,
 * `ensureDir()` creates an empty store, and the day's book is gone. Observed at least twice —
 * 2026-09-01, and again 2026-09-29 at 20:11 ET (host ip-172-31-82-219, store `files: 0` on a disk only 37%
 * full, so not a space problem). Both times it was survivable because everything was simulated and the
 * local archive mirror had a copy. With real money it is not survivable: the engine would reboot with an
 * empty book while real positions sat at the broker.
 *
 * WHAT THIS IS NOT. It is not a cache, and it is not in the read path of a tick. store.js stays entirely
 * SYNCHRONOUS — the engine depends on that — so this module is used two ways only:
 *   1. WRITE-THROUGH, fire-and-forget, after each local write (store.writeRun).
 *   2. REHYDRATE, once, awaited during startup before the first tick (candle-spread start()).
 * Nothing on a tick path ever awaits S3.
 *
 * FAILURE IS ALWAYS DEGRADATION, NEVER AN EXCEPTION. Every function here resolves; none reject into the
 * caller. An unreachable bucket, a missing IAM permission, an absent SDK or an unset bucket name all leave
 * the engine behaving exactly as it does today (local disk only) with the reason counted and reported on
 * /health. A durability layer that can take the engine down is worse than no durability layer.
 *
 * CONFIGURE with CANDLE_SPREAD_S3_BUCKET (required to enable), optionally CANDLE_SPREAD_S3_PREFIX
 * (default 'candle-spread-runs') and AWS_REGION. The EB instance profile must allow
 * s3:PutObject/GetObject/ListBucket on that bucket — the default aws-elasticbeanstalk-ec2-role does NOT,
 * so it needs a policy. Until it does, health() reports the error and the engine runs unchanged.
 */
const fs = require('fs');
const path = require('path');

const BUCKET = process.env.CANDLE_SPREAD_S3_BUCKET || null;
const PREFIX = (process.env.CANDLE_SPREAD_S3_PREFIX || 'candle-spread-runs').replace(/^\/+|\/+$/g, '');
const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';

// Counters, so a silently-degraded archive is visible rather than merely absent from the logs.
const stats = { puts: 0, putFails: 0, gets: 0, getFails: 0, lists: 0, listFails: 0,
  lastPutAt: null, lastPutRunId: null, lastError: null, lastErrorAt: null, disabledReason: null,
  // null until selfTest() has run. `writable: true` is the only value that means the archive really works;
  // `enabled` merely means it is configured. Check this one.
  writable: null, writeTestError: null, writeTestAt: null };

function note(err, kind) {
  stats.lastError = `${kind}: ${(err && err.message) || String(err)}`;
  stats.lastErrorAt = new Date().toISOString();
}

// LAZY, AND A MISSING SDK IS A DISABLED ARCHIVE, NOT A CRASH LOOP. @aws-sdk/client-s3 is installed by the
// deploy's `npm install --production`; requiring it at module load would make a dependency hiccup take down
// a server that is otherwise perfectly able to trade off local disk.
let _client;         // undefined = not tried, null = unavailable
function client() {
  if (_client !== undefined) return _client;
  if (!BUCKET) { stats.disabledReason = 'CANDLE_SPREAD_S3_BUCKET is not set'; return (_client = null); }
  try {
    const { S3Client } = require('@aws-sdk/client-s3');
    _client = new S3Client({ region: REGION });
  } catch (e) {
    stats.disabledReason = `@aws-sdk/client-s3 unavailable: ${(e && e.message) || e}`;
    note(e, 'require');
    _client = null;
  }
  return _client;
}

function enabled() { return !!client(); }

function keyFor(runId) { return `${PREFIX}/${runId}.json`; }

// runId -> the trade date embedded in it. Used to restore one day without listing the whole bucket.
// SYMBOL_EXPIRATION_TRADEDATE[_VARIANT]; dates carry hyphens, never underscores.
// IT MUST LOOK LIKE A DATE, not merely occupy the third slot. "third segment exists" accepted the seed
// marker `_seed_<hash>` as trade date `<hash>`, so listRuns returned it as a run: harmless downstream only by
// luck (store.listRunFiles skips `_`-prefixed names), but restoreHistory would spend one of its N day-slots
// on a date that does not exist and could push a real day out of the window. Require the shape.
function tradeDateOf(runId) {
  const p = String(runId || '').split('_');
  if (p.length < 3) return null;
  // THE FIRST SEGMENT IS A SYMBOL. Checking only the date let `._NDX_2026-08-18_...` through — a macOS
  // AppleDouble sidecar, whose leading dot meant it dodged every `_`-prefix filter while its third segment
  // parsed as a perfectly good date. 1,127 of them reached the prod store on 2026-09-30.
  if (!/^[A-Z][A-Z0-9.$]*$/.test(p[0])) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(p[2]) ? p[2] : null;
}

async function cmd(name, input) {
  const c = client();
  if (!c) return { ok: false, disabled: true, reason: stats.disabledReason };
  try {
    const M = require('@aws-sdk/client-s3');
    const out = await c.send(new M[name](input));
    return { ok: true, out };
  } catch (e) {
    note(e, name);
    return { ok: false, error: (e && e.message) || String(e), code: e && (e.name || e.Code) };
  }
}

/**
 * Ship one record. `body` is the exact JSON text written locally, so the object in S3 is byte-identical to
 * the file on disk — a restore is a copy, never a re-serialisation that could differ.
 */
async function putRun(runId, body) {
  const r = await cmd('PutObjectCommand', { Bucket: BUCKET, Key: keyFor(runId), Body: body,
    ContentType: 'application/json' });
  if (r.ok) { stats.puts++; stats.lastPutAt = new Date().toISOString(); stats.lastPutRunId = runId; }
  else if (!r.disabled) stats.putFails++;
  return r;
}

async function getRun(runId) {
  const r = await cmd('GetObjectCommand', { Bucket: BUCKET, Key: keyFor(runId) });
  if (!r.ok) { if (!r.disabled) stats.getFails++; return r; }
  try {
    const body = await r.out.Body.transformToString();
    stats.gets++;
    return { ok: true, body };
  } catch (e) {
    stats.getFails++; note(e, 'read-body');
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/** Every runId under the prefix, optionally only those for one trade date. Paginates. */
async function listRuns(tradeDate) {
  const ids = [];
  let token;
  do {
    const r = await cmd('ListObjectsV2Command', { Bucket: BUCKET, Prefix: `${PREFIX}/`,
      ContinuationToken: token, MaxKeys: 1000 });
    if (!r.ok) { if (!r.disabled) stats.listFails++; return { ok: false, error: r.error, reason: r.reason, ids }; }
    for (const o of r.out.Contents || []) {
      // DIRECTLY UNDER THE PREFIX, OR IT IS NOT A RUN. A nested key is something else's, and one nesting in
      // particular is dangerous: store.js keeps summary sidecars in `_summaries/` INSIDE the runs directory,
      // under the SAME runId filenames as the records they describe. Upload a runs directory wholesale (by
      // hand, or from some future tool) and `_summaries/NDX_..._v7-10.json` would list as run
      // `NDX_..._v7-10` — the same id as the real record, so a restore could write the tiny projection over
      // the place the real book belongs, and which one won would depend on key order.
      const rel = String(o.Key || '').slice(`${PREFIX}/`.length);
      if (rel.includes('/')) continue;
      const m = /^([^/]+)\.json$/.exec(rel);
      if (!m) continue;
      // A KEY UNDER THE PREFIX IS NOT AUTOMATICALLY A RUN. Anything whose name does not parse to a
      // SYMBOL_EXPIRATION_TRADEDATE id is not ours to hand back - the write probe at _probe/health.json is
      // one such key, and a caller that asked for "the runs" and got `health` would then try to restore a
      // record by that name. The trade date is the discriminator, so require one.
      const d = tradeDateOf(m[1]);
      if (!d) continue;
      if (tradeDate && d !== tradeDate) continue;
      ids.push(m[1]);
    }
    token = r.out.IsTruncated ? r.out.NextContinuationToken : null;
  } while (token);
  stats.lists++;
  return { ok: true, ids };
}

/**
 * Pull records onto local disk for the given trade date, WITHOUT overwriting anything already there.
 *
 * Never clobbering is the whole safety property: if the instance still has today's book, that copy is the
 * live one and S3 is behind it by up to one write. Only a genuinely absent file is filled in, which is
 * exactly the instance-replacement case this exists for.
 */
async function restoreDay(tradeDate, runsDir, opts = {}) {
  const res = { tradeDate, enabled: enabled(), listed: 0, restored: 0, skippedPresent: 0, failed: 0,
    bytes: 0, ids: [], error: null };
  if (!res.enabled) { res.error = stats.disabledReason; return res; }
  const l = await listRuns(tradeDate);
  if (!l.ok) { res.error = l.error || l.reason; return res; }
  res.listed = l.ids.length;
  try { fs.mkdirSync(runsDir, { recursive: true }); } catch (_) { /* exists */ }
  for (const runId of l.ids) {
    const file = path.join(runsDir, `${runId}.json`);
    if (fs.existsSync(file)) { res.skippedPresent++; continue; }
    const g = await getRun(runId);
    if (!g.ok) { res.failed++; continue; }
    try {
      // Write to a temp name and rename, so a crash mid-restore can never leave a half-written record —
      // the exact shape readRunStatus classifies as `corrupt` and refuses to overwrite.
      const tmp = `${file}.restoring`;
      fs.writeFileSync(tmp, g.body, 'utf8');
      fs.renameSync(tmp, file);
      res.restored++; res.bytes += Buffer.byteLength(g.body);
      res.ids.push(runId);
    } catch (e) { res.failed++; note(e, 'restore-write'); }
    if (opts.limit && res.restored >= opts.limit) break;
  }
  return res;
}

/**
 * PROVE THE ARCHIVE CAN ACTUALLY WRITE, AT BOOT, BEFORE ANYTHING DEPENDS ON IT.
 *
 * `enabled` only says a bucket name is set and the SDK loaded. The boot restore then exercises LIST and GET,
 * so a read-permission problem surfaces at once — but PutObject is not touched until the first writeRun,
 * which on a fresh deploy is the next trading session. A role that can read and not write (a real
 * possibility on the EB-managed bucket, whose AWSElasticBeanstalkWebTier grant is about app versions and log
 * bundles, not our data) would therefore look healthy all evening and start losing records silently in the
 * morning — the precise "configured but failing" state that is worse than no archive at all.
 *
 * So: write a few bytes, read them back, compare. It answers the only question that matters — can this
 * process put a record where a replacement instance will find it — and it answers it now.
 *
 * The probe lives outside the run namespace and is harmless to listRuns, whose ids must parse to a trade
 * date and this cannot.
 */
async function selfTest() {
  if (!enabled()) return { ok: false, disabled: true, reason: stats.disabledReason };
  const key = `${PREFIX}/_probe/health.json`;
  const body = JSON.stringify({ probe: true, at: new Date().toISOString(), pid: process.pid });
  const put = await cmd('PutObjectCommand', { Bucket: BUCKET, Key: key, Body: body,
    ContentType: 'application/json' });
  if (!put.ok) {
    stats.writable = false;
    stats.writeTestError = put.error || put.reason || 'put failed';
    return { ok: false, stage: 'put', error: stats.writeTestError };
  }
  const get = await cmd('GetObjectCommand', { Bucket: BUCKET, Key: key });
  if (!get.ok) {
    // Writable but not readable is still broken for our purpose: a record we cannot read back is a record a
    // replacement instance cannot restore.
    stats.writable = false;
    stats.writeTestError = `wrote but could not read back: ${get.error || get.reason}`;
    return { ok: false, stage: 'get', error: stats.writeTestError };
  }
  let same = false;
  try { same = (await get.out.Body.transformToString()) === body; } catch (_) { same = false; }
  stats.writable = same;
  stats.writeTestError = same ? null : 'read back different bytes than were written';
  stats.writeTestAt = new Date().toISOString();
  return { ok: same, stage: same ? 'done' : 'compare', error: stats.writeTestError };
}

/**
 * Stream an arbitrary object to a local file. Used for the seed bundle, which is ~81 MB and must NOT be
 * buffered: getRun's transformToString would put the whole thing in RSS on a 1.9 GB instance, which is the
 * same class of mistake as staging an unpack in the RAM-backed tmpfs.
 *
 * Raw key, not a runId — the bundle is not a run record and deliberately lives under a nested `_seed/` prefix
 * where listRuns cannot mistake it for one.
 */
async function getObjectToFile(key, destPath) {
  const r = await cmd('GetObjectCommand', { Bucket: BUCKET, Key: key });
  if (!r.ok) { if (!r.disabled) stats.getFails++; return r; }
  try {
    const tmpDest = `${destPath}.downloading`;
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(tmpDest);
      r.out.Body.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
      r.out.Body.pipe(out);
    });
    fs.renameSync(tmpDest, destPath);          // atomic: a partial download is never seen as the bundle
    stats.gets++;
    return { ok: true, bytes: fs.statSync(destPath).size, path: destPath };
  } catch (e) {
    stats.getFails++; note(e, 'download');
    try { fs.rmSync(`${destPath}.downloading`, { force: true }); } catch (_) { /* best effort */ }
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

function health() {
  return {
    configured: !!BUCKET,
    enabled: enabled(),
    bucket: BUCKET,
    prefix: PREFIX,
    region: REGION,
    disabledReason: stats.disabledReason,
    ...stats,
  };
}

module.exports = { enabled, health, selfTest, putRun, getRun, getObjectToFile, listRuns, restoreDay, keyFor, tradeDateOf,
  BUCKET, PREFIX, REGION, _stats: stats };
