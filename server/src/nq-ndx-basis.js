'use strict';
/**
 * NQ↔NDX basis tracker.
 *
 * NQ futures and the NDX cash index are both quoted in Nasdaq-100 index points, so they differ
 * only by the futures BASIS (carry − dividends, converging to zero at expiry) — an additive offset,
 * not a scale factor. Subtracting the basis from NQ values re-labels the chart into NDX terms so its
 * levels line up with NDX option strikes.
 *
 * The catch: NDX is a cash index that only updates during regular hours (9:30–16:00 ET). Off-hours
 * its quote is frozen at the last close while NQ keeps trading, so recomputing the basis off-hours
 * gives garbage (e.g. NDX's quote can carry a fresh-looking tradeTime overnight while the price is
 * stale — which produced a bogus ~−6 basis instead of the real ~60–80). So:
 *   • ONLY recompute during NDX regular hours (explicit RTH clock — reliable, unlike the quote's
 *     tradeTime), and PERSIST each good value to disk;
 *   • OFF-HOURS, never recompute — return the last persisted good basis (survives restarts/deploys).
 * That keeps the "implied NDX" tracking NQ overnight off the last real regular-hours offset.
 *
 * All analysis stays server-side; the client only subtracts the number when the user toggles it on.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { marketClient } = require('./persistence/market-client');

const TTL_MS = 15000;                 // recompute at most this often during RTH (basis drifts slowly)
const RTH_START = 570, RTH_END = 960; // NDX regular hours: 9:30 (570) .. 16:00 (960) ET, in minutes
// Durable across deploys on EB (/tmp is proven-writable and survives deploys — see .ebextensions);
// on local dev this lands in the OS temp dir so the offset persists between restarts there too.
const BASIS_PATH = process.env.NQ_NDX_BASIS_PATH || path.join(os.tmpdir(), 'nq-ndx-basis.json');

let held = null;          // { basis, asOf, ndx, nq } — last GOOD regular-hours basis (also persisted)
let loaded = false;       // whether we've tried to load the persisted value this process
let lastComputeAt = 0;

const num = v => (typeof v === 'number' && isFinite(v)) ? v : null;
const r2 = n => Math.round(n * 100) / 100;

// Is `now` within NDX cash regular trading hours (weekday 9:30–16:00 ET)? The authoritative
// "NDX is updating" signal — far more reliable than the quote's tradeTime, which lies overnight.
function isNdxRTH(now) {
  const et = new Date(new Date(now).toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay();                         // 0 Sun … 6 Sat
  if (day === 0 || day === 6) return false;
  const m = et.getHours() * 60 + et.getMinutes();
  return m >= RTH_START && m < RTH_END;            // (holidays still pass the clock but NDX just
                                                   //  won't move, so the basis stays ≈ last value)
}

function loadPersisted() {
  loaded = true;
  try {
    const j = JSON.parse(fs.readFileSync(BASIS_PATH, 'utf8'));
    if (j && num(j.basis) != null) return { basis: j.basis, asOf: j.asOf, ndx: j.ndx, nq: j.nq };
  } catch (e) { /* no persisted value yet */ }
  return null;
}
function persist(v) {
  try { fs.writeFileSync(BASIS_PATH, JSON.stringify(v)); } catch (e) { /* best-effort */ }
}

const etMin = ms => {
  const s = new Date(ms).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' });
  const [h, m] = s.split(':').map(Number); return h * 60 + m;
};

// Quotes come back keyed by the resolved symbol (e.g. '/NQ' -> '/NQU26'), so match by prefix.
function findQuote(resp, wanted) {
  if (!resp) return null;
  if (resp[wanted]) return resp[wanted].quote || resp[wanted];
  const key = Object.keys(resp).find(k => k === wanted || k.startsWith(wanted));
  return key ? (resp[key].quote || resp[key]) : null;
}

// NQ price at the regular-session close (last RTH bar at/before 16:00 ET) around a timestamp — used
// only to BOOTSTRAP an initial basis from the last NDX close when nothing is persisted yet.
async function nqPriceAtClose(ts) {
  try {
    const resp = await marketClient.priceHistory('/NQ', {
      frequencyType: 'minute', frequency: 1, startDate: ts - 6 * 3600 * 1000, endDate: ts + 60000
    });
    const cs = (resp && resp.candles || []).filter(c => c.close);
    if (!cs.length) return null;
    const rth = cs.filter(c => { const m = etMin(c.datetime); return m >= RTH_START && m < RTH_END; });
    const pick = rth.length ? rth[rth.length - 1] : cs[cs.length - 1];
    return pick ? pick.close : null;
  } catch (e) { return null; }
}

// One-time off-hours bootstrap: reconstruct "last known good" = NQ@lastClose − NDX close. Uses the
// NDX quote's tradeTime only to LOCATE the close (not to judge liveness), so the overnight
// stale-timestamp bug can't reach this path.
async function bootstrapFromLastClose() {
  try {
    const q = await marketClient.quotes(['$NDX']);
    const ndxQ = findQuote(q, '$NDX');
    const ndx = num(ndxQ && ndxQ.lastPrice) != null ? num(ndxQ.lastPrice) : num(ndxQ && ndxQ.closePrice);
    const ndxTime = num(ndxQ && ndxQ.tradeTime);
    if (ndx == null || ndxTime == null) return null;
    const nqAt = await nqPriceAtClose(ndxTime);
    if (nqAt == null) return null;
    const v = { basis: r2(nqAt - ndx), asOf: ndxTime, ndx: r2(ndx), nq: r2(nqAt) };
    persist(v);
    return v;
  } catch (e) { return null; }
}

/**
 * @returns {Promise<{basis:number, asOf:number, source:'live'|'held', ndx:number, nq:number}|null>}
 * source: 'live' = just computed during regular hours; 'held' = last good value carried off-hours.
 */
async function getBasis() {
  const now = Date.now();
  if (!loaded && !held) held = loadPersisted();

  // Off-hours: never recompute — hold the last good regular-hours basis. If we have NONE yet
  // (fresh deploy), bootstrap once from the last NDX close so the feature isn't dead until RTH.
  if (!isNdxRTH(now)) {
    if (!held && now - lastComputeAt >= TTL_MS) { lastComputeAt = now; held = await bootstrapFromLastClose(); }
    return held ? { ...held, source: 'held' } : null;
  }

  // Regular hours: NDX is live. Recompute (throttled) and persist.
  if (now - lastComputeAt < TTL_MS) return held ? { ...held, source: 'live' } : null;
  lastComputeAt = now;
  try {
    const q = await marketClient.quotes(['/NQ', '$NDX']);
    const nqQ = findQuote(q, '/NQ'), ndxQ = findQuote(q, '$NDX');
    const nq = num(nqQ && nqQ.mark) != null ? num(nqQ.mark) : num(nqQ && nqQ.lastPrice);
    const ndx = num(ndxQ && ndxQ.lastPrice) != null ? num(ndxQ.lastPrice) : num(ndxQ && ndxQ.closePrice);
    if (nq != null && ndx != null) {
      held = { basis: r2(nq - ndx), asOf: now, ndx: r2(ndx), nq: r2(nq) };
      persist(held);
    }
  } catch (e) {
    console.error('[nq-ndx-basis] getBasis failed:', e && e.message);
  }
  return held ? { ...held, source: 'live' } : null;
}

module.exports = { getBasis, isNdxRTH };
