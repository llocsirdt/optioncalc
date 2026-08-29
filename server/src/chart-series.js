'use strict';
/**
 * Chart series endpoint helper — purpose-built data for the custom NQ chart, independent of the
 * candle-spread engine's candle-analyzer base cache (so we can pull DEEP history per timeframe
 * without touching the engine's data path). Uses start/end RANGE fetches (which return deep
 * history for futures, unlike the capped periodType:'day' form), RTH-filters intraday, aggregates
 * 60m from 30m, and computes Bollinger(20,2) + EMA(9) server-side so every timeframe shows full
 * bands (not just 1 warmup-limited bar). All analysis on the server; the client only renders.
 *
 * CACHING (see getChartSeries): this endpoint is DISPLAY-ONLY — its sole consumer is the NQ chart
 * client. The trading strategy / position-manager path uses analyzeCandles, NOT this. So caching
 * here can never feed stale data to anything critical. Even so we keep it tight: concurrent
 * identical requests are coalesced onto ONE in-flight fetch (zero staleness — they all get the same
 * fresh result), and a very short per-timeframe TTL (well under both the bar duration and the
 * client's own 4s poll) serves rapid repeat/multi-tab polls. A `fresh` flag bypasses the TTL for
 * any caller that must have a guaranteed-fresh fetch. This exists purely to stop the memory spikes
 * from many concurrent deep priceHistory fetches — not to trade freshness for speed.
 */
const { marketClient } = require('./persistence/market-client');

const INDEX = new Set(['NDX', 'SPX', 'RUT', 'DJX', 'OEX', 'VIX']);
const DAY_MS = 864e5;
const MAX_BARS = 400;               // default per-TF bar cap; still leaves >>20 warmup bars for full BB
const BB_PERIOD = 20, BB_MULT = 2, EMA_PERIOD = 9;

// Per-timeframe cache TTL (ms). Deliberately short — <= the client's 4s refresh and far below each
// bar's duration, so a served result is only ever a couple seconds behind a fresh fetch (the closed
// bars are immutable; only the forming bar could differ, and by less than one poll interval).
const TTL_MS = { '1m': 2000, '5m': 3000, '15m': 4000, '60m': 5000, 'daily': 10000 };
const _cache = new Map();     // key -> { at, data }   (bounded: one entry per symbol+timeframe)
const _inflight = new Map();  // key -> Promise<data>  (coalesce concurrent identical fetches)

// Per timeframe: native Schwab frequency to fetch, target bar minutes, lookback window, and the
// aggregation factor (fetch 30m, aggregate x2 -> 60m). Lookbacks are generous so BB is warmed
// across the whole visible range.
// maxBars overrides the default MAX_BARS. 1m gets 2000 so its BB/9EMA lines span the same ~2000
// session-minutes as the 5m's 400 bars (default 400 min ≈ 6.7h was far shorter than every other TF).
const TF = {
  '1m':    { freq: 1,  minutes: 1,   lookbackDays: 5,   agg: 1, maxBars: 2000 },
  '5m':    { freq: 5,  minutes: 5,   lookbackDays: 20,  agg: 1 },
  '15m':   { freq: 15, minutes: 15,  lookbackDays: 45,  agg: 1 },
  '60m':   { freq: 30, minutes: 60,  lookbackDays: 60,  agg: 2 },
  'daily': { daily: true,            lookbackDays: 400 }
};

const apiSym = s => (s.startsWith('$') || s.startsWith('/')) ? s : (INDEX.has(s.toUpperCase()) ? `$${s.toUpperCase()}` : s.toUpperCase());
const r2 = n => Math.round(n * 100) / 100;
const etMin = ms => {
  const s = new Date(ms).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' });
  const [h, m] = s.split(':').map(Number); return h * 60 + m;
};

function aggregate(candles, periodMin) {
  const ms = periodMin * 60000;
  const m = new Map();
  for (const c of candles) {
    const start = Math.floor(c.datetime / ms) * ms;
    const b = m.get(start);
    if (!b) m.set(start, { datetime: start, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 });
    else { b.high = Math.max(b.high, c.high); b.low = Math.min(b.low, c.low); b.close = c.close; b.volume += c.volume || 0; }
  }
  return [...m.values()].sort((a, b) => a.datetime - b.datetime);
}

function bollinger(cs) {
  const out = cs.map(() => ({ bbUpper: null, bbMiddle: null, bbLower: null }));
  for (let i = BB_PERIOD - 1; i < cs.length; i++) {
    let sum = 0; for (let j = i - BB_PERIOD + 1; j <= i; j++) sum += cs[j].close;
    const mean = sum / BB_PERIOD;
    let v = 0; for (let j = i - BB_PERIOD + 1; j <= i; j++) { const d = cs[j].close - mean; v += d * d; }
    const sd = Math.sqrt(v / BB_PERIOD);
    out[i] = { bbUpper: r2(mean + BB_MULT * sd), bbMiddle: r2(mean), bbLower: r2(mean - BB_MULT * sd) };
  }
  return out;
}

function ema(cs) {
  const k = 2 / (EMA_PERIOD + 1);
  const out = cs.map(() => null);
  let prev = null;
  for (let i = EMA_PERIOD - 1; i < cs.length; i++) {
    if (i === EMA_PERIOD - 1) { let s = 0; for (let j = 0; j <= i; j++) s += cs[j].close; prev = s / EMA_PERIOD; }
    else prev = (cs[i].close - prev) * k + prev;
    out[i] = r2(prev);
  }
  return out;
}

// range: optional { startDate, endDate } (ms) for an on-demand historical window (date-jump). When
// given, the fetch spans that window and the recent-bars cap is lifted (raised) so the whole
// requested range is returned, not just the last MAX_BARS.
async function computeChartSeries(symbol, timeframe, range = null) {
  const cfg = TF[timeframe];
  if (!cfg) throw new Error(`unsupported timeframe '${timeframe}' (use ${Object.keys(TF).join('/')})`);
  const sym = apiSym(symbol);
  const now = Date.now();
  const startDate = range ? range.startDate : now - cfg.lookbackDays * DAY_MS;
  const endDate = range ? Math.min(range.endDate, now) : now;
  const opts = cfg.daily
    ? { periodType: 'year', period: 1, frequencyType: 'daily', frequency: 1, startDate, endDate }
    : { frequencyType: 'minute', frequency: cfg.freq, startDate, endDate };

  const isFutures = sym.startsWith('/');
  const resp = await marketClient.priceHistory(sym, opts);
  let cs = (resp && resp.candles || []).filter(c => c.open || c.high || c.low || c.close);
  if (!cfg.daily) {
    // Futures trade the near-24h Globex session, so restricting to equity RTH would freeze the
    // chart every evening/overnight — keep the whole session, only dropping the 5–6pm ET daily
    // maintenance break. Index/equity symbols still get the 9:30–16:00 ET RTH filter.
    cs = isFutures
      ? cs.filter(c => { const t = etMin(c.datetime); return t < 1020 || t >= 1080; })  // exclude 17:00–18:00 ET
      : cs.filter(c => { const t = etMin(c.datetime); return t >= 570 && t < 960; });    // 9:30–16:00 ET RTH
  }
  cs.sort((a, b) => a.datetime - b.datetime);
  if (cfg.agg > 1) cs = aggregate(cs, cfg.minutes);
  const cap = range ? (cfg.daily ? 3000 : 6000) : (cfg.maxBars || MAX_BARS);   // ranged windows keep the whole span
  if (cs.length > cap) cs = cs.slice(cs.length - cap);

  const bb = bollinger(cs), e9 = ema(cs);
  return cs.map((c, i) => ({
    datetime: c.datetime, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0,
    bbUpper: bb[i].bbUpper, bbMiddle: bb[i].bbMiddle, bbLower: bb[i].bbLower, ema9: e9[i]
  }));
}

/**
 * Cached, coalesced chart series (display-only — see file header).
 * @param {string} symbol
 * @param {string} timeframe
 * @param {{fresh?: boolean, range?: {startDate:number, endDate:number}}} [opts] - fresh:true bypasses
 *        the TTL cache. range fetches a historical window (date-jump); ranged windows are past/static
 *        so they cache under their own key with a long TTL. Both still coalesce concurrent identical
 *        fetches, so this never returns stale data.
 */
async function getChartSeries(symbol, timeframe, opts = {}) {
  if (!TF[timeframe]) throw new Error(`unsupported timeframe '${timeframe}' (use ${Object.keys(TF).join('/')})`);
  const range = opts.range || null;
  const key = `${apiSym(symbol)}|${timeframe}` + (range ? `|${range.startDate}-${range.endDate}` : '');
  const ttl = opts.fresh ? 0 : range ? 600000 : (TTL_MS[timeframe] || 2000);   // static past data → 10min cache

  if (ttl > 0) {
    const hit = _cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.data;   // fresh enough (< one poll old)
  }
  // A fetch for this exact key is already running — share its result instead of firing another
  // deep priceHistory fetch. This is what collapses the concurrent multi-tab / multi-timeframe
  // bursts that were spiking RSS, with zero added staleness (everyone gets the same live result).
  const pending = _inflight.get(key);
  if (pending) return pending;

  const p = (async () => {
    const data = await computeChartSeries(symbol, timeframe, range);
    _cache.set(key, { at: Date.now(), data });
    if (_cache.size > 60) { const oldest = [..._cache].sort((a, b) => a[1].at - b[1].at)[0]; if (oldest) _cache.delete(oldest[0]); }
    return data;
  })();
  _inflight.set(key, p);
  try { return await p; } finally { _inflight.delete(key); }
}

module.exports = { getChartSeries, computeChartSeries, TIMEFRAMES: Object.keys(TF) };
