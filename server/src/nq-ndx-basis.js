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
 * its quote is frozen at the last close while NQ keeps trading, so we must NOT recompute the basis
 * against a stale NDX (that would just pin the chart to the frozen value). Instead we capture the
 * basis whenever NDX is live and HOLD it; off-hours the held basis carries, giving an "implied NDX"
 * that tracks NQ. Freshness is judged from NDX's own trade timestamp (holiday-proof; no hardcoded
 * RTH clock). If we have no held value yet (e.g. a restart while NDX is closed), we reconstruct it
 * once from NQ's price at the NDX last-trade time.
 *
 * All analysis stays server-side; the client only subtracts the number when the user toggles it on.
 */
const { marketClient } = require('./persistence/market-client');

const TTL_MS = 15000;                 // recompute at most this often (basis drifts slowly)
const NDX_FRESH_MS = 3 * 60 * 1000;   // NDX quote counts as "live" within this of its trade time

let held = null;          // { basis, asOf, source, ndx, nq } — last authoritative basis
let lastComputeAt = 0;

const num = v => (typeof v === 'number' && isFinite(v)) ? v : null;
const r2 = n => Math.round(n * 100) / 100;
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

// NQ price at the regular-session close (16:00 ET) of the given day, to match NDX's close-time
// quote. (NDX stamps its close ~17:15 ET, during NQ's 17:00–18:00 maintenance break, so we can't
// just sample NQ at that timestamp — we take NQ's last RTH bar at/before 16:00.)
async function nqPriceAt(ts) {
  try {
    const resp = await marketClient.priceHistory('/NQ', {
      frequencyType: 'minute', frequency: 1, startDate: ts - 6 * 3600 * 1000, endDate: ts + 60000
    });
    const cs = (resp && resp.candles || []).filter(c => c.close);
    if (!cs.length) return null;
    const rth = cs.filter(c => { const m = etMin(c.datetime); return m >= 570 && m < 960; }); // 9:30–16:00 ET
    const pick = rth.length ? rth[rth.length - 1] : cs[cs.length - 1];
    return pick ? pick.close : null;
  } catch (e) { return null; }
}

/**
 * @returns {Promise<{basis:number, asOf:number, source:'live'|'lastClose', ndx:number, nq:number}|null>}
 */
async function getBasis() {
  const now = Date.now();
  if (now - lastComputeAt < TTL_MS) return held;   // serve cached value across the 5 per-tick calls
  lastComputeAt = now;
  try {
    const q = await marketClient.quotes(['/NQ', '$NDX']);
    const nqQ = findQuote(q, '/NQ'), ndxQ = findQuote(q, '$NDX');
    const nq = num(nqQ && nqQ.mark) != null ? num(nqQ.mark) : num(nqQ && nqQ.lastPrice);
    const ndx = num(ndxQ && ndxQ.lastPrice) != null ? num(ndxQ.lastPrice) : num(ndxQ && ndxQ.closePrice);
    const ndxTime = num(ndxQ && ndxQ.tradeTime);
    if (nq != null && ndx != null && ndxTime != null) {
      if (now - ndxTime < NDX_FRESH_MS) {
        held = { basis: r2(nq - ndx), asOf: now, source: 'live', ndx: r2(ndx), nq: r2(nq) };
      } else if (!held) {
        const nqAt = await nqPriceAt(ndxTime);
        if (nqAt != null) held = { basis: r2(nqAt - ndx), asOf: ndxTime, source: 'lastClose', ndx: r2(ndx), nq: r2(nqAt) };
      }
    }
  } catch (e) {
    console.error('[nq-ndx-basis] getBasis failed:', e && e.message);
  }
  return held;
}

module.exports = { getBasis };
