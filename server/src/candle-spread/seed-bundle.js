/**
 * ONE-SHOT RESTORE FROM A BUNDLE SHIPPED IN THE DEPLOY.
 *
 * WHY THIS EXISTS. After the 2026-09-29 instance replacement the instance store was empty and the only copy
 * of 29 trade dates lived on the dev machine. Seeding S3 from there needs AWS credentials this project has
 * never had locally — which would mean creating a long-lived access key just to upload once. The instance,
 * meanwhile, already has S3 write access through its own profile (proved by run-archive.selfTest on
 * 2026-09-30: writable true against elasticbeanstalk-us-east-1-641707696307/optioncalc-runs).
 *
 * So the records travel in the deploy artifact and the instance does the seeding. 967 MB of run records gzip
 * to 81.5 MB — a 12x ratio, because a chain snapshot per candle per variant is enormously repetitive — which
 * fits an EB application version (512 MB limit) with room to spare.
 *
 * IT DOES TWO THINGS, and the second is the point:
 *   1. unpacks records onto the local store, which brings the SERVED history back (compare, debug)
 *   2. uploads each one to S3, so the NEXT instance replacement is survivable
 * Local disk alone would restore the pages and lose everything again on the next swap.
 *
 * NOTHING IS EVER OVERWRITTEN. A record already on disk is live and newer; a key already in S3 was put by a
 * running engine. Both win over a bundle built at some earlier moment. That makes this safe to leave in a
 * deploy, and safe to re-run.
 *
 * IT RUNS ONCE PER BUNDLE. A marker object keyed by the bundle's own SHA-256 means a restart does not redo
 * 1,127 uploads, while a genuinely new bundle seeds again without anyone having to remember a flag.
 *
 * IT IS BACKGROUND WORK AND MUST NEVER DELAY A TICK. candle-spread start() kicks it off after the day's book
 * has been rehydrated; it holds no locks and every failure is logged and dropped.
 *
 * AFTERWARDS, REDEPLOY THE NORMAL PACKAGE. Leaving the bundle in place is harmless (the marker makes it a
 * no-op) but it makes every deploy carry 81 MB it does not need.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// Shipped at the app root by scripts/create-deployment-package.sh when present.
function bundlePath() {
  return process.env.CANDLE_SPREAD_SEED_BUNDLE || path.join(__dirname, '..', '..', 'seed-runs.tgz');
}

// STREAMED, not readFileSync. The bundle is ~81 MB and hashing it by slurping would put all of that in RSS
// on a 1.9 GB instance with a history of OOM.
function sha256File(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (!n) break;
      h.update(buf.subarray(0, n));
    }
  } finally { fs.closeSync(fd); }
  return h.digest('hex').slice(0, 16);
}

// A gzip member records its uncompressed size in the last four bytes (mod 2^32). Our archive is well under
// 4 GB so this is exact, and it lets us refuse before filling a disk rather than after.
function gzipUncompressedBytes(file) {
  try {
    const st = fs.statSync(file);
    if (st.size < 18) return null;
    const fd = fs.openSync(file, 'r');
    try {
      const b = Buffer.allocUnsafe(4);
      fs.readSync(fd, b, 0, 4, st.size - 4);
      return b.readUInt32LE(0);
    } finally { fs.closeSync(fd); }
  } catch (_) { return null; }
}

// Free bytes on the filesystem holding `dir`.
function freeBytes(dir) {
  try { const s = fs.statfsSync(dir); return s.bavail * s.bsize; } catch (_) { return null; }
}

// runId = SYMBOL_EXPIRATION_TRADEDATE[_VARIANT]; dates carry hyphens, never underscores.
function isRunFile(name) {
  if (!name.endsWith('.json') || name.startsWith('_')) return false;
  return String(name).replace(/\.json$/, '').split('_').length >= 3;
}

/**
 * @param opts.runsDir  the live store directory
 * @param opts.archive  run-archive module (injected so tests can supply a fake)
 * @param opts.log      logger
 */
async function seedFromBundle(opts = {}) {
  const log = opts.log || console.log;
  const runsDir = opts.runsDir;
  const A = opts.archive || require('./run-archive');
  const bundle = opts.bundle || bundlePath();
  const res = { bundle, found: false, alreadySeeded: false, files: 0, toDisk: 0, toS3: 0,
    skippedDisk: 0, skippedS3: 0, failed: 0, error: null };

  if (!fs.existsSync(bundle)) return res;                 // the normal case: no bundle in this deploy
  res.found = true;
  const tag = sha256File(bundle);
  res.tag = tag;

  // ONE SHOT PER BUNDLE. The marker lives in S3 rather than on local disk precisely because local disk is the
  // thing that disappears — a disk marker would be lost in the same event that makes a reseed look necessary,
  // and every replacement would re-upload the whole archive.
  const markerId = `_seed_${tag}`;
  if (A.enabled()) {
    const m = await A.getRun(markerId);
    if (m.ok) {
      res.alreadySeeded = true;
      log(`[candle-spread] seed bundle ${tag} already applied (marker in S3) — skipping.`);
      return res;
    }
  }

  // *** NOT os.tmpdir(). *** On this platform /tmp is a RAM-BACKED tmpfs sized at about half the instance
  // memory (956 MB here), and .ebextensions/persistence.config records what writing app data there cost:
  // it consumed RAM, competed with the app, and was the mechanism behind the recurring OOM and the
  // 2026-08-28 deploy hang. The first version of this staged in os.tmpdir() anyway and failed on the very
  // first real attempt (2026-09-30 02:03 UTC): the archive unpacks to 967 MB against a 956 MB tmpfs, so it
  // died of ENOSPC by about 11 MB, the finally-block cleanup erased the evidence, and the only symptom was
  // storeFiles and puts sitting at 0 for four minutes. Had the bundle been slightly smaller it would have
  // "worked" while quietly eating a gigabyte of RAM, which is the worse outcome.
  //
  // Staging goes beside the run store, on the 8 GB root disk, which is also the same filesystem — so records
  // MOVE into place by rename rather than being copied, halving peak disk and making each arrival atomic.
  const stageRoot = path.join(path.dirname(path.resolve(runsDir)), '_seed-staging');
  try { fs.rmSync(stageRoot, { recursive: true, force: true }); } catch (_) { /* first run */ }
  let tmp;
  try { fs.mkdirSync(stageRoot, { recursive: true }); tmp = fs.mkdtempSync(path.join(stageRoot, 'unpack-')); }
  catch (e) {
    res.error = `cannot create staging dir beside the store: ${(e && e.message) || e}`;
    log(`[candle-spread] seed bundle: ${res.error}`);
    return res;
  }

  // REFUSE BEFORE FILLING THE DISK, not after. Needs room for the staged copy; records then rename into the
  // store, so the staged bytes are released as it goes rather than doubling at the end.
  const need = gzipUncompressedBytes(bundle);
  const free = freeBytes(stageRoot);
  res.needBytes = need; res.freeBytes = free;
  if (need != null && free != null && free < need * 1.15) {
    res.error = `not enough room to unpack: needs ~${Math.round(need / 1e6)} MB, `
      + `${Math.round(free / 1e6)} MB free on ${stageRoot}`;
    log(`[candle-spread] seed bundle: ${res.error}`);
    try { fs.rmSync(stageRoot, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    return res;
  }

  try {
    // tar ships on the EB AL2 image and on macOS. Staging rather than extracting straight over the store
    // keeps "never overwrite" a decision this code makes, not a tar flag whose semantics differ between
    // GNU tar and bsdtar.
    execFileSync('tar', ['-xzf', bundle, '-C', tmp], { stdio: 'pipe' });
  } catch (e) {
    res.error = `unpack failed: ${(e && e.stderr ? String(e.stderr).trim() : (e && e.message)) || e}`;
    try { fs.rmSync(stageRoot, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    log(`[candle-spread] seed bundle: ${res.error}`);
    return res;
  }

  try {
    const names = fs.readdirSync(tmp).filter(isRunFile);
    res.files = names.length;
    if (!names.length) { res.error = 'bundle contained no run records'; return res; }
    log(`[candle-spread] seed bundle ${tag}: ${names.length} record(s) unpacked, applying…`);

    try { fs.mkdirSync(runsDir, { recursive: true }); } catch (_) { /* exists */ }
    // What S3 already holds, in ONE list rather than a HEAD per record.
    let inS3 = new Set();
    if (A.enabled()) {
      const l = await A.listRuns();
      if (l.ok) inS3 = new Set(l.ids);
      else log(`[candle-spread] seed bundle: cannot list the bucket (${l.error || l.reason}); will attempt every put`);
    }

    for (const name of names) {
      const runId = name.replace(/\.json$/, '');
      const src = path.join(tmp, name);
      const dest = path.join(runsDir, name);
      let body = null;
      // LOCAL FIRST. A record on disk is the live one; only a genuinely absent file is filled in.
      if (fs.existsSync(dest)) res.skippedDisk++;
      else {
        try {
          body = fs.readFileSync(src, 'utf8');     // needed for the upload anyway
          // RENAME, NOT COPY. Staging is on the same filesystem as the store, so this is free, it is atomic
          // (no half-written record can ever be observed), and it releases the staged bytes as we go instead
          // of holding a second full copy until the end.
          fs.renameSync(src, dest);
          res.toDisk++;
        } catch (e) { res.failed++; continue; }
      }
      if (!A.enabled()) continue;
      if (inS3.has(runId)) { res.skippedS3++; continue; }
      try {
        // An already-present record was not renamed, so its staged copy is still there to read for the upload.
        if (body == null) body = fs.readFileSync(src, 'utf8');
        const p = await A.putRun(runId, body);
        if (p.ok) res.toS3++; else res.failed++;
      } catch (e) { res.failed++; }
    }

    // The marker goes up only if the S3 half actually succeeded for everything it attempted. A partial seed
    // must be retryable, and marking it done would strand the remainder until someone noticed.
    if (A.enabled() && !res.failed) {
      await A.putRun(markerId, JSON.stringify({ seeded: true, tag, at: new Date().toISOString(),
        files: res.files, toS3: res.toS3, toDisk: res.toDisk }, null, 2));
    }
    log(`[candle-spread] seed bundle ${tag} applied: ${res.toDisk} written to disk `
      + `(${res.skippedDisk} already there), ${res.toS3} uploaded (${res.skippedS3} already in S3), `
      + `${res.failed} failed.`
      + (res.failed ? ' NOT marked done — it will retry on the next boot.' : ''));
    return res;
  } finally {
    try { fs.rmSync(stageRoot, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  }
}

module.exports = { seedFromBundle, bundlePath, isRunFile };
