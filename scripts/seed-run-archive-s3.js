#!/usr/bin/env node
'use strict';
/**
 * seed-run-archive-s3.js — put the LOCAL archive into S3, so a replacement instance can rehydrate.
 *
 * WHY THIS IS A LOCAL SCRIPT AND NOT A DEPLOY HOOK. The records live on this machine
 * (candle-spread-archive/, 1,127 files ≈ 967 MB as of 2026-09-29) and prod's own store is empty, so the
 * data has to travel FROM here. Bundling it into the deploy zip is not an option at that size, and a deploy
 * hook has nothing to copy. Once S3 holds it, prod needs no further help: candle-spread start() restores
 * today's runs before the first tick, and CANDLE_SPREAD_S3_RESTORE_DAYS backfills history behind the engine.
 * So this is a one-time seed, not part of the normal deploy path.
 *
 * IT NEVER DELETES AND BY DEFAULT NEVER OVERWRITES. Re-run it as often as you like: an object already in
 * the bucket is left alone unless --overwrite is given. That makes it safe to run against a bucket prod is
 * actively writing to — the newest copy of a live record is prod's, not this machine's.
 *
 * Usage:
 *   CANDLE_SPREAD_S3_BUCKET=my-bucket node scripts/seed-run-archive-s3.js [options]
 *
 *   --dry-run            list what WOULD be uploaded, touch nothing
 *   --date <YYYY-MM-DD>  only this trade date (repeatable)
 *   --days <n>           only the most recent n trade dates
 *   --overwrite          replace objects that already exist
 *   --concurrency <n>    parallel uploads (default 8)
 *   --archive <dir>      source directory (default candle-spread-archive/)
 *
 * Requires AWS credentials in the usual places (env, ~/.aws/credentials, SSO) with
 * s3:PutObject + s3:ListBucket on the bucket.
 */
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const all = (f) => argv.reduce((a, x, i) => (x === f && argv[i + 1] ? [...a, argv[i + 1]] : a), []);

const DRY = has('--dry-run');
const OVERWRITE = has('--overwrite');
const CONC = Math.max(1, Number(val('--concurrency', 8)) || 8);
const ARCHIVE = path.resolve(val('--archive', path.join(__dirname, '..', 'candle-spread-archive')));
const ONLY_DATES = all('--date');
const DAYS = Number(val('--days', 0)) || 0;

const BUCKET = process.env.CANDLE_SPREAD_S3_BUCKET;
const PREFIX = (process.env.CANDLE_SPREAD_S3_PREFIX || 'candle-spread-runs').replace(/^\/+|\/+$/g, '');
const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';

if (!BUCKET) {
  console.error('CANDLE_SPREAD_S3_BUCKET is not set. Refusing to guess a bucket name.');
  process.exit(2);
}
let S3;
try { S3 = require('@aws-sdk/client-s3'); } catch (e) {
  console.error('@aws-sdk/client-s3 is not installed. Run:  cd server && npm install');
  process.exit(2);
}

// runId = SYMBOL_EXPIRATION_TRADEDATE[_VARIANT]; dates carry hyphens, never underscores.
const tradeDateOf = (runId) => { const p = String(runId).split('_'); return p.length >= 3 ? p[2] : null; };

function collect() {
  if (!fs.existsSync(ARCHIVE)) { console.error(`archive not found: ${ARCHIVE}`); process.exit(2); }
  let files = fs.readdirSync(ARCHIVE).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
  let rows = files.map((f) => ({ file: f, runId: f.replace(/\.json$/, '') }))
    .map((r) => ({ ...r, date: tradeDateOf(r.runId) }))
    .filter((r) => r.date);
  if (ONLY_DATES.length) rows = rows.filter((r) => ONLY_DATES.includes(r.date));
  if (DAYS > 0) {
    const keep = new Set([...new Set(rows.map((r) => r.date))].sort().reverse().slice(0, DAYS));
    rows = rows.filter((r) => keep.has(r.date));
  }
  return rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));   // newest day first
}

async function existingKeys(client) {
  const seen = new Set();
  let token;
  do {
    const out = await client.send(new S3.ListObjectsV2Command({ Bucket: BUCKET, Prefix: `${PREFIX}/`,
      ContinuationToken: token, MaxKeys: 1000 }));
    for (const o of out.Contents || []) seen.add(o.Key);
    token = out.IsTruncated ? out.NextContinuationToken : null;
  } while (token);
  return seen;
}

(async () => {
  const rows = collect();
  const bytes = rows.reduce((a, r) => a + fs.statSync(path.join(ARCHIVE, r.file)).size, 0);
  const dates = [...new Set(rows.map((r) => r.date))];
  console.log(`archive:  ${ARCHIVE}`);
  console.log(`selected: ${rows.length} record(s) across ${dates.length} trade date(s), `
    + `${Math.round(bytes / 1e6)} MB`);
  console.log(`target:   s3://${BUCKET}/${PREFIX}/  (region ${REGION})`);

  const client = new S3.S3Client({ region: REGION });

  // ONE LIST INSTEAD OF N HEADS. A HeadObject per record would be 1,127 round trips to answer a question one
  // paginated list answers, and it is the difference between a seed that takes seconds and one that takes
  // minutes. It also tells you honestly how much is already there before anything is written.
  let present = new Set();
  let listed = true;
  try {
    present = await existingKeys(client);
    console.log(`already in bucket: ${present.size} object(s)`);
  } catch (e) {
    listed = false;
    // A DRY RUN IS THE FIRST THING ANYONE TRIES, and it is worth something before the bucket or the IAM
    // policy exists: it still answers "what would go up, and how much". So a list failure is fatal only for
    // a real upload, where not knowing what is present would mean re-uploading 967 MB.
    if (!DRY) {
      console.error(`cannot list the bucket: ${e && e.message}`);
      console.error('check the bucket name, the region, and that your credentials allow s3:ListBucket.');
      process.exit(1);
    }
    console.log(`could not list the bucket (${e && e.message})`);
    console.log('  --dry-run continues anyway; assuming nothing is present yet.');
  }

  const todo = rows.filter((r) => OVERWRITE || !present.has(`${PREFIX}/${r.runId}.json`));
  console.log(`to upload: ${todo.length}${OVERWRITE ? ' (overwriting)' : ` (${rows.length - todo.length} skipped, already present)`}`
    + (listed ? '' : ' [bucket not listed — count is the full selection]'));
  if (DRY) {
    for (const r of todo.slice(0, 20)) console.log(`  would put ${PREFIX}/${r.runId}.json`);
    if (todo.length > 20) console.log(`  … and ${todo.length - 20} more`);
    console.log('\n--dry-run: nothing was uploaded.');
    return;
  }
  if (!todo.length) { console.log('nothing to do.'); return; }

  let done = 0, failed = 0;
  const queue = todo.slice();
  const worker = async () => {
    for (;;) {
      const r = queue.shift();
      if (!r) return;
      // The bytes on disk go up verbatim, so the object and the file are identical and a restore is a copy
      // rather than a re-serialisation that could differ.
      try {
        const body = fs.readFileSync(path.join(ARCHIVE, r.file));
        await client.send(new S3.PutObjectCommand({ Bucket: BUCKET, Key: `${PREFIX}/${r.runId}.json`,
          Body: body, ContentType: 'application/json' }));
        done++;
        if (done % 50 === 0 || done + failed === todo.length) {
          process.stdout.write(`\r  uploaded ${done}/${todo.length}${failed ? ` (${failed} failed)` : ''}   `);
        }
      } catch (e) {
        failed++;
        if (failed <= 5) console.error(`\n  FAILED ${r.runId}: ${e && e.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: CONC }, worker));
  console.log(`\ndone: ${done} uploaded, ${failed} failed.`);
  if (failed) {
    console.log('re-run to retry just the failures (present objects are skipped).');
    process.exit(1);
  }
  console.log(`\nprod will now rehydrate today's runs at boot. To bring back the served history too, set`);
  console.log(`CANDLE_SPREAD_S3_RESTORE_DAYS (e.g. 30) on the environment.`);
})().catch((e) => { console.error(e && e.message); process.exit(1); });
