#!/usr/bin/env node
/**
 * Mirror EVERY candle-spread run on the server (all variants, all dates) to the local archive,
 * so we always keep a durable local copy independent of the server's /tmp store. Idempotent —
 * re-run anytime (e.g. after each session) to keep the mirror complete and fresh.
 *
 * Usage: node scripts/sync-candle-spread-runs.js [--local]
 */
const fs = require('fs');
const path = require('path');
const PROD = 'https://d1kbxyxn33vpw2.cloudfront.net';
const LOCAL = 'http://localhost:3001';
const base = process.argv.includes('--local') ? LOCAL : PROD;
const ARCHIVE = path.join(__dirname, '..', 'candle-spread-archive');

// runId = SYMBOL_EXPIRATION_TRADEDATE[_VARIANT]; dates contain hyphens, not underscores.
function parseRunId(runId) {
  const [symbol, expiration, tradeDate, variant] = runId.split('_');
  return { symbol, expiration, tradeDate, variant };
}

(async () => {
  let list;
  try {
    const res = await fetch(`${base}/api/v1/candle-spread/runs`);
    list = (await res.json()).runs || [];
  } catch (e) { console.error('failed to list runs:', e.message, '\nbase:', base); process.exit(1); }
  if (!list.length) { console.log('no runs on server to sync (', base, ')'); return; }

  fs.mkdirSync(ARCHIVE, { recursive: true });
  // SKIP A PATHOLOGICAL RECORD. Fetching one forces the SERVER to parse and serialise the whole thing;
  // on 2026-09-16 a runaway floor-offset loop grew v5-40-cATM to 32,411 positions (~100 MB), and pulling
  // that would have meant a ~200 MB transient spike on a 1.9 GB instance with a history of OOM. The index
  // already reports positionCount, so this costs nothing to check. Such a record is corrupt anyway --
  // duplicate copies of one hedge -- so it is not worth risking the server to archive it.
  const SANE_POSITIONS = Number(process.env.SYNC_MAX_POSITIONS || 5000);
  let created = 0, updated = 0, failed = 0, skipped = 0;
  for (const r of list) {
    if (r.positionCount != null && r.positionCount > SANE_POSITIONS) {
      skipped++;
      console.log(`  SKIP      ${r.runId}  (${r.positionCount.toLocaleString()} positions — looks runaway; raise SYNC_MAX_POSITIONS to force)`);
      continue;
    }
    const { symbol, expiration, tradeDate, variant } = parseRunId(r.runId);
    const url = `${base}/api/v1/candle-spread/runs/${symbol}/${expiration}?date=${tradeDate}${variant ? `&variant=${variant}` : ''}`;
    const file = path.join(ARCHIVE, `${r.runId}.json`);
    const existed = fs.existsSync(file);
    try {
      const j = await (await fetch(url)).json();
      if (!j || j.error) { failed++; console.log('  MISS', r.runId, j && j.error); continue; }
      fs.writeFileSync(file, JSON.stringify(j, null, 2));
      if (existed) updated++; else created++;
      console.log(`  ${existed ? 'refreshed' : 'NEW      '} ${r.runId}  (events ${(j.events || []).length}, realized $${j.state?.realizedPnl})`);
    } catch (e) { failed++; console.log('  ERROR', r.runId, e.message); }
  }
  console.log(`\nsynced to ${ARCHIVE}: ${created} new, ${updated} refreshed${failed ? `, ${failed} failed` : ''}${skipped ? `, ${skipped} skipped` : ''}`);
  if (!created && updated) console.log('(nothing new — local mirror was already caught up)');
})();
