/**
 * SHORT-TTL CACHE + INFLIGHT COALESCING for expensive upstream reads.
 *
 * WHY. The documented OOM on this box is client-driven: several browser tabs polling large market-data
 * endpoints, each poll becoming its own upstream fetch and its own large allocation. b929566 fixed exactly
 * that for /chartseries (see chart-series.js) and left the other two heavy endpoints untouched.
 *
 * On 2026-10-01 the instance went Ok -> "No Data, none of the instances are sending data" and nginx had been
 * logging "an upstream response is buffered to a temporary file" continuously since 15:54 for
 *   /api/v1/marketdata/chains?symbol=$NDX&expirationDate=...&strike_count=75
 *   /api/v1/marketdata/candleanalysis?symbol=NDX
 * from dozens of CloudFront edge IPs. In the same window /chartseries was answering 304 — its cache working.
 * One of three heavy endpoints was protected.
 *
 * COALESCING IS THE PART THAT MATTERS, not the cache. Ten simultaneous identical requests become ONE upstream
 * fetch and ONE allocation that all ten share. That is pure win with no staleness at all: every caller gets the
 * same live result they would have got anyway.
 *
 * THE TTL IS SIZED AT OR BELOW THE CLIENT'S OWN POLL INTERVAL (~4s, measured in the access log as requests
 * every 1-4s). That is the property worth stating: a single client polling every 4s with a 3s TTL will miss the
 * cache almost every time and sees NO added staleness. The cache only ever collapses *concurrent* polls — extra
 * tabs, extra devices, CloudFront fanning one page across edges. It trades nothing a lone user can observe for
 * the thing that took the box down.
 *
 * ERRORS ARE NEVER CACHED. A rejection resolves the inflight entry and leaves the cache untouched, so a
 * transient upstream failure is retried rather than pinned for the TTL.
 */

function makeRequestCache(name, opts = {}) {
  const maxEntries = opts.maxEntries || 60;
  const cache = new Map();      // key -> { at, data }
  const inflight = new Map();   // key -> Promise<data>
  const stats = { name, hits: 0, misses: 0, coalesced: 0, errors: 0, evictions: 0 };

  /**
   * @param key    cache key — must include EVERY parameter that changes the response
   * @param ttlMs  0 disables the cache for this call (coalescing still applies)
   * @param fn     () => Promise<data>, called only on a miss with nothing already in flight
   */
  async function run(key, ttlMs, fn) {
    if (ttlMs > 0) {
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < ttlMs) { stats.hits++; return hit.data; }
    }
    // Already fetching this exact key — share it. This is the allocation collapse.
    const pending = inflight.get(key);
    if (pending) { stats.coalesced++; return pending; }

    stats.misses++;
    const p = (async () => {
      const data = await fn();
      // Only a SUCCESS is cached; see the header note on errors.
      cache.set(key, { at: Date.now(), data });
      if (cache.size > maxEntries) {
        let oldestKey = null, oldestAt = Infinity;
        for (const [k, v] of cache) if (v.at < oldestAt) { oldestAt = v.at; oldestKey = k; }
        if (oldestKey != null) { cache.delete(oldestKey); stats.evictions++; }
      }
      return data;
    })();
    inflight.set(key, p);
    try {
      return await p;
    } catch (e) {
      stats.errors++;
      throw e;
    } finally {
      inflight.delete(key);
    }
  }

  function health() {
    return { ...stats, entries: cache.size, inFlight: inflight.size, maxEntries };
  }

  return { run, health, _cache: cache, _inflight: inflight };
}

/**
 * A stable cache key from a query string: every parameter, sorted, so `?a=1&b=2` and `?b=2&a=1` share an entry
 * and a parameter nobody thought about cannot silently collide two different responses onto one key.
 * `fresh` is excluded — it selects whether to use the cache, it is not part of the answer.
 */
function keyFromQuery(prefix, query, exclude = ['fresh', 'cb', '_']) {
  let params;
  try { params = new URL(`http://x${query && query.startsWith('?') ? query : '?' + (query || '')}`).searchParams; }
  catch (_) { return `${prefix}|${String(query || '')}`; }
  const pairs = [];
  for (const [k, v] of params) if (!exclude.includes(k)) pairs.push(`${k}=${v}`);
  pairs.sort();
  return `${prefix}|${pairs.join('&')}`;
}

module.exports = { makeRequestCache, keyFromQuery };
