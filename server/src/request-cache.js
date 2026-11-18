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
 * WHAT THE TTL DOES, PER ENDPOINT (corrected 2026-11-12 against the client's real poll intervals). A cache
 * entry only answers a LONE tab if its next poll lands inside the TTL:
 *   /candleanalysis — 4 s TTL vs a 10 s poll: a lone tab never hits; only concurrent tabs/devices share an entry.
 *   /chains         — 3 s TTL vs a >= 2 s poll: a lone tab is served from cache about every other poll, so it can
 *                     be up to ~3 s staler than an uncached read.
 * So the protection against the 2026-10-01 failure is the coalescing above plus collapsing concurrent tabs,
 * extra devices and CloudFront edges. It does not reduce a single tab's own load. Raising a TTL above the poll
 * interval would, at the cost of that much staleness; that trade is a backlog item, not a default.
 *
 * ERRORS ARE NEVER CACHED. A rejection resolves the inflight entry and leaves the cache untouched, so a
 * transient upstream failure is retried rather than pinned for the TTL. This only covers a REJECTION. A fetcher
 * that resolves with an error object has to throw it itself (proxy-server-sdk's /candleanalysis does, since
 * 2026-11-12).
 *
 * PER-DAY COUNTS (2026-11-04). The totals above run from boot, so a burst of 29k /chains errors could not be
 * placed on a day. `byDay` keeps the last DAYS_KEPT ET trade dates: upstream fetches, errors, the last error
 * time, and the distinct error messages (capped) so an expired-expiration 400 can be told from an outage.
 */
const DAYS_KEPT = 14, MSGS_KEPT = 5;
const _etDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });

function makeRequestCache(name, opts = {}) {
  const maxEntries = opts.maxEntries || 60;
  const cache = new Map();      // key -> { at, data }
  const inflight = new Map();   // key -> Promise<data>
  const stats = { name, hits: 0, misses: 0, coalesced: 0, errors: 0, evictions: 0 };
  const byDay = new Map();      // ET date -> { fetches, errors, lastErrorAt, messages: { msg: n } }
  let lastError = null;         // { at, message }
  const now = opts.now || Date.now;
  function dayRow() {
    const d = _etDay.format(new Date(now()));
    let row = byDay.get(d);
    if (!row) {
      row = { fetches: 0, errors: 0, lastErrorAt: null, messages: {} };
      byDay.set(d, row);
      while (byDay.size > DAYS_KEPT) byDay.delete(byDay.keys().next().value);
    }
    return row;
  }

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
    dayRow().fetches++;
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
      const row = dayRow(), at = new Date(now()).toISOString();
      const msg = String((e && e.message) || e).slice(0, 160);
      row.errors++; row.lastErrorAt = at; lastError = { at, message: msg };
      if (row.messages[msg] != null || Object.keys(row.messages).length < MSGS_KEPT) row.messages[msg] = (row.messages[msg] || 0) + 1;
      else row.messages['(other)'] = (row.messages['(other)'] || 0) + 1;
      throw e;
    } finally {
      inflight.delete(key);
    }
  }

  function health() {
    return { ...stats, entries: cache.size, inFlight: inflight.size, maxEntries, lastError,
      byDay: Object.fromEntries(byDay) };
  }

  // runUncachingErrorResults: like run(), for a fetcher that RESOLVES with an error object instead of throwing
  // (analyzeCandles does: { status: 'error' }). isError(result) marks it; it is then not cached and counted as an
  // error, and the caller still receives that same result object. Added 2026-11-12 for /candleanalysis.
  async function runUncachingErrorResults(key, ttlMs, fn, isError) {
    try {
      return await run(key, ttlMs, () => Promise.resolve(fn()).then((r) => {
        if (isError(r)) { const e = new Error((r && (r.message || r.error)) || 'error result'); e.errorResult = r; throw e; }
        return r;
      }));
    } catch (e) {
      if (e && e.errorResult !== undefined) return e.errorResult;
      throw e;
    }
  }

  return { run, runUncachingErrorResults, health, _cache: cache, _inflight: inflight };
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
