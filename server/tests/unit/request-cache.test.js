'use strict';
// SHORT-TTL CACHE + INFLIGHT COALESCING for the heavy market-data endpoints.
//
// WHY. The documented OOM on this box is client-driven: browser tabs polling large endpoints, each poll its own
// upstream fetch and its own large allocation. b929566 fixed /chartseries and left /chains and /candleanalysis
// uncovered. On 2026-10-01 nginx logged those two buffering large responses to temp files continuously from
// 15:54 until the instance stopped responding at 16:02, while /chartseries answered 304 throughout.
//
// COALESCING IS THE PART THAT MATTERS, not the cache. Ten simultaneous identical requests must become ONE
// upstream fetch that all ten share — zero added staleness, since everyone gets the same live result. The TTL is
// a smaller, separate win, deliberately sized at or below the client's own poll interval so a lone user never
// observes it.
//
// Run: node server/tests/unit/request-cache.test.js
const { makeRequestCache, keyFromQuery } = require('../../src/request-cache');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const tick = () => new Promise((r) => setImmediate(r));

(async () => {
  // ── 1. CONCURRENT IDENTICAL CALLS BECOME ONE UPSTREAM FETCH ───────────────────────────────────────
  // THE POINT OF THE WHOLE MODULE. This is the allocation that took the instance down.
  {
    const c = makeRequestCache('t');
    let calls = 0, release;
    const held = new Promise((r) => { release = r; });
    const fn = () => { calls++; return held.then(() => ({ big: 'payload' })); };
    const all = Promise.all(Array.from({ length: 10 }, () => c.run('k', 3000, fn)));
    await tick();
    ok(calls === 1, `10 concurrent calls -> 1 upstream fetch (${calls})`);
    release();
    const results = await all;
    ok(results.length === 10 && results.every((r) => r.big === 'payload'), 'and all 10 get the result');
    ok(results.every((r) => r === results[0]), 'the SAME object — one allocation, not ten copies');
    ok(c.health().coalesced === 9, `9 of them coalesced (${c.health().coalesced})`);
  }

  // ── 2. COALESCING WORKS EVEN WITH THE CACHE OFF ───────────────────────────────────────────────────
  // ttl 0 must still share an in-flight fetch: that half is free of any staleness trade-off at all.
  {
    const c = makeRequestCache('t');
    let calls = 0, release;
    const held = new Promise((r) => { release = r; });
    const fn = () => { calls++; return held.then(() => 'v'); };
    const all = Promise.all([c.run('k', 0, fn), c.run('k', 0, fn), c.run('k', 0, fn)]);
    await tick();
    ok(calls === 1, `ttl 0 still coalesces (${calls} fetch)`);
    release(); await all;
  }

  // ── 3. THE TTL SERVES REPEATS, THEN EXPIRES ───────────────────────────────────────────────────────
  {
    const c = makeRequestCache('t');
    let calls = 0;
    const fn = async () => { calls++; return calls; };
    ok(await c.run('k', 50, fn) === 1, 'first call fetches');
    ok(await c.run('k', 50, fn) === 1, 'second call inside the TTL is served from cache');
    ok(calls === 1, `still one fetch (${calls})`);
    await new Promise((r) => setTimeout(r, 70));
    ok(await c.run('k', 50, fn) === 2, 'after the TTL it fetches again');
    ok(c.health().hits === 1 && c.health().misses === 2, `hit/miss counted (${JSON.stringify({h:c.health().hits,m:c.health().misses})})`);
  }

  // ── 4. DIFFERENT KEYS DO NOT SHARE ────────────────────────────────────────────────────────────────
  // A chain for a different expiration or strike_count is a different answer; collapsing those would be
  // worse than no cache, because it would serve WRONG data rather than merely stale data.
  {
    const c = makeRequestCache('t');
    const r1 = await c.run('a', 5000, async () => 'A');
    const r2 = await c.run('b', 5000, async () => 'B');
    ok(r1 === 'A' && r2 === 'B', 'separate keys get separate results');
  }

  // ── 5. ERRORS ARE NEVER CACHED ────────────────────────────────────────────────────────────────────
  // A transient upstream failure must be retried on the next poll, not pinned for the TTL.
  {
    const c = makeRequestCache('t');
    let calls = 0;
    const fn = async () => { calls++; if (calls === 1) throw new Error('upstream 500'); return 'ok'; };
    let threw = null;
    try { await c.run('k', 5000, fn); } catch (e) { threw = e; }
    ok(threw && /upstream 500/.test(threw.message), 'the error propagates to the caller');
    ok(c.health().errors === 1, 'and is counted');
    ok(await c.run('k', 5000, fn) === 'ok', 'the very next call RETRIES rather than replaying the failure');
    // A rejection must not poison the in-flight map either.
    ok(c.health().inFlight === 0, 'and nothing is left in flight');
  }

  // ── 6. THE CACHE IS BOUNDED ───────────────────────────────────────────────────────────────────────
  // Chain keys vary by expiration and strike_count, so an unbounded map would be its own slow leak.
  {
    const c = makeRequestCache('t', { maxEntries: 5 });
    for (let i = 0; i < 20; i++) await c.run('k' + i, 60000, async () => i);
    ok(c.health().entries <= 5, `entries capped at 5 (${c.health().entries})`);
    ok(c.health().evictions >= 15, `and evictions counted (${c.health().evictions})`);
  }

  // ── 7. THE KEY INCLUDES EVERY PARAMETER THAT CHANGES THE ANSWER ───────────────────────────────────
  {
    ok(keyFromQuery('chains', '?a=1&b=2') === keyFromQuery('chains', '?b=2&a=1'),
      'parameter order does not create two entries for one answer');
    ok(keyFromQuery('chains', '?strike_count=75') !== keyFromQuery('chains', '?strike_count=50'),
      'but a different strike_count IS a different key');
    ok(keyFromQuery('chains', '?a=1&cb=99') === keyFromQuery('chains', '?a=1'),
      'a cache-buster param does not defeat the cache for everyone else');
    ok(keyFromQuery('chains', '?a=1&fresh=1') === keyFromQuery('chains', '?a=1'),
      'and `fresh` selects whether to use the cache rather than being part of the answer');
    ok(keyFromQuery('chains', '') === 'chains|', 'an empty query still yields a stable key');
  }

  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
