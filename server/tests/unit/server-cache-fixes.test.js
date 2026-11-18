'use strict';
// SERVER CACHE FIXES (2026-11-12): the two load fixes from the 11-06 review.
//   1) option chains are cached IN MEMORY only: no disk write and no server-state save per fetch, bounded at 12
//      keys, and getChainCache still has no `timestamp`, so the engine keeps fetching fresh (unchanged behaviour).
//   2) /candleanalysis: a fetcher that RESOLVES with { status: 'error' } is not cached and not served as a hit.
const fs = require('fs'), path = require('path');
const PM = require('../../src/persistence/persistence');
const { makeRequestCache } = require('../../src/request-cache');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

(async () => {
  // 1) chains
  const pm = new PM();
  let saves = 0; pm.saveState = async () => { saves++; };
  const dir = path.join(__dirname, '..', '..', 'src', 'persistence', 'chain-cache');
  const before = fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
  await pm.cacheChainData('NDX', '2026-11-18', { call: { a: 1 }, put: {} });
  const after = fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
  ok(after === before, `no chain file written to disk (${before} -> ${after})`);
  ok(saves === 0, 'no server-state save per chain fetch');
  const got = pm.getChainCache('NDX_2026-11-18');
  ok(got && got.data && got.data.call.a === 1, 'getChainCache answers from memory');
  ok(got && got.timestamp === undefined, 'no `timestamp` field, so the engine still always refetches (unchanged behaviour)');
  ok((await pm.getCachedChainData('NDX', '2026-11-18')).call.a === 1, 'getCachedChainData answers from memory');
  for (let i = 0; i < 20; i++) await pm.cacheChainData('NDX', `2026-12-${String(i + 1).padStart(2, '0')}`, { call: {}, put: {} });
  ok(pm._chainMem.size <= 12, `the in-memory chains are bounded (${pm._chainMem.size})`);
  ok(pm.getChainCache('NDX_2026-11-18') === null || !pm._chainMem.has('NDX_2026-11-18'), 'the oldest key is evicted first');

  // 2) error results are not cached
  const cache = makeRequestCache('t');
  let calls = 0;
  const isErr = (r) => !!(r && r.status === 'error');
  const errFetch = async () => { calls++; return { status: 'error', message: 'boom' }; };
  const r1 = await cache.runUncachingErrorResults('k', 60000, errFetch, isErr);
  const r2 = await cache.runUncachingErrorResults('k', 60000, errFetch, isErr);
  ok(r1.status === 'error' && r2.status === 'error', 'the caller still receives the error body');
  ok(calls === 2, `an error result is not served from cache (fetched ${calls}x)`);
  ok(cache.health().errors === 2 && cache.health().hits === 0, 'counted as errors, never as hits');
  let okCalls = 0;
  const goodFetch = async () => { okCalls++; return { status: 'ok' }; };
  await cache.runUncachingErrorResults('g', 60000, goodFetch, isErr);
  await cache.runUncachingErrorResults('g', 60000, goodFetch, isErr);
  ok(okCalls === 1 && cache.health().hits === 1, 'a good result is still cached for the TTL');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
