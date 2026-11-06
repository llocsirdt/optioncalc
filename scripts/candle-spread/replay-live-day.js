#!/usr/bin/env node
'use strict';
/**
 * LIVE-ENGINE DAY REPLAY (2026-11-06) — run the ACTUAL live engine (index.js processGroup -> trader) through a past
 * session, with the clock faked and Schwab replaced by files on disk. Built to answer "what would the deployed code
 * have done on 2026-11-05", the day the 10-point strikes disappeared and the fallback widths (strike-grid.js) did not
 * exist yet. The backtest cannot answer that: it fixes one width per run and prices any strike it asks for.
 *
 * What is real:   the engine code, end to end — the 5m candle tick, the 30s sub-bar worker, the strike-grid read, the
 *                 tradability gate, every open/cover/hedge rule, settlement. /NQ 24h 1m bars drive the signals and
 *                 NDX RTH 1m bars the pricing (FOUNDATIONAL: NQ signals, NDX pricing), from signal-lab-data/raw-1m.
 *                 The settle is the archived official close when the archive has the day.
 * What is modelled: the option chain. Black-Scholes, the backtest's own IV (15m NQ band IV x the intraday multiplier
 *                 x the moneyness skew correction), bid/ask from bs.makeBidAsk. Fills are the sim (mark) path.
 *
 * THE STRIKE LIST (user, 2026-11-06). NDX 0DTE strikes are listed 100s first, then 25s are added, then 10s fill in
 * near the money. So the 25-point grid is ALWAYS there and the 10s are the layer that can be missing:
 *   every multiple of 25 within +-GRID_REACH of spot, plus every multiple of 10 inside --tens LO-HI
 *   (default: within +-TENS_REACH of spot, i.e. a normal day).
 * 2026-11-05: every quoted non-50 strike that day sat in 27,260-28,070 -> --tens 27260-28070.
 *
 * Usage:
 *   node scripts/candle-spread/replay-live-day.js --date 2026-11-05 --tens 27260-28070 [--variants v7-10,v7-20]
 *        [--json out.json]
 * Nothing leaves the process: runs are written to a temp dir, the S3 archive and Schwab credentials are blanked,
 * every run is forced to dryRun:true, and global fetch throws.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const DATE = arg('--date');
if (!/^\d{4}-\d{2}-\d{2}$/.test(DATE || '')) { console.error('--date YYYY-MM-DD required'); process.exit(1); }
const TENS = arg('--tens') ? arg('--tens').split('-').map(Number) : null;
const WANT = arg('--variants') ? arg('--variants').split(',') : null;
const JSON_OUT = arg('--json');
const GRID_REACH = 2500, TENS_REACH = 1000;
const RAW = path.join(ROOT, 'signal-lab-data', 'raw-1m');

// ── ISOLATION: nothing reaches S3, Schwab or the network ────────────────────────────────────────────────────────────
const RUNS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), `replay-${DATE}-`));
Object.assign(process.env, {
  CANDLE_SPREAD_RUNS_DIR: RUNS_DIR, CANDLE_SPREAD_S3_BUCKET: '', CANDLE_SPREAD_LIVE: '',
  SCHWAB_CLIENT_ID: 'replay-offline', SCHWAB_CLIENT_SECRET: 'replay-offline', SCHWAB_REFRESH_TOKEN: 'replay-offline',
});
global.fetch = async () => { throw new Error('network disabled in replay-live-day'); };

// ── FAKED CLOCK: Date.now() and new Date() read NOW; everything else about Date is untouched ────────────────────────
const RealDate = Date;
let NOW = 0;
class ReplayDate extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(NOW); }
  static now() { return NOW; }
}
global.Date = ReplayDate;

// ── DATA ────────────────────────────────────────────────────────────────────────────────────────────────────────────
const etIso = (ms) => new RealDate(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const etMin = (ms) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new RealDate(ms)).map((x) => [x.type, x.value]));
  return ((+p.hour) % 24) * 60 + (+p.minute);
};
function loadSeries(prefix) {
  const files = fs.readdirSync(RAW).filter((f) => f.startsWith(prefix + '-') && f.endsWith('.json') && f.slice(prefix.length + 1, -5) <= DATE).sort();
  const seen = new Set(), out = [];
  for (const f of files.slice(-30)) for (const c of JSON.parse(fs.readFileSync(path.join(RAW, f), 'utf8')).candles || []) {
    if (c.datetime == null || seen.has(c.datetime)) continue;
    seen.add(c.datetime); out.push(c);
  }
  return out.sort((a, b) => a.datetime - b.datetime);
}
const NQ = loadSeries('NQ');
const NDX = loadSeries('NDX').filter((c) => { const m = etMin(c.datetime); return m >= 570 && m < 960; });
const ndxToday = NDX.filter((c) => etIso(c.datetime) === DATE);
if (!ndxToday.length) { console.error(`no NDX 1m bars for ${DATE} in ${RAW}`); process.exit(1); }
if (!NQ.some((c) => etIso(c.datetime) === DATE)) { console.error(`no NQ 1m bars for ${DATE} in ${RAW}`); process.exit(1); }

// The settle: the archived official close when the archive has the day (a real number), else the last 1m close.
let SETTLE = null, SETTLE_SRC = null;
try {
  const dir = path.join(ROOT, 'candle-spread-archive');
  const f = fs.readdirSync(dir).find((x) => x.startsWith(`NDX_${DATE}_${DATE}_`) && x.endsWith('.json'));
  const r = f ? JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) : null;
  if (r && r.state && r.state.sessionClose > 0) { SETTLE = r.state.sessionClose; SETTLE_SRC = `archive ${f}`; }
} catch (e) { /* no archive */ }
if (SETTLE == null) { SETTLE = ndxToday[ndxToday.length - 1].close; SETTLE_SRC = 'last NDX 1m close (no archive close)'; }

const closed1m = (series, now) => series.filter((c) => c.datetime + 60000 <= now);
function bars5mNewestFirst(series, now) {
  const by = new Map();
  for (const c of series) {
    const k = Math.floor(c.datetime / 300000) * 300000;
    if (k + 300000 > now + 2000) continue;   // only completed bars, as Schwab would serve them
    const b = by.get(k);
    if (!b) by.set(k, { datetime: k, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 });
    else { b.high = Math.max(b.high, c.high); b.low = Math.min(b.low, c.low); b.close = c.close; }
  }
  return [...by.values()].sort((a, b) => b.datetime - a.datetime);
}

// ── MODELLED CHAIN ──────────────────────────────────────────────────────────────────────────────────────────────────
const bs = require(path.join(ROOT, 'server/src/candle-spread/bs-pricer'));
const ab = require(path.join(ROOT, 'server/src/candle-spread/analysis-builder'));
const BT = require(path.join(ROOT, 'server/src/candle-spread/backtest/backtest-v6-5m'));
const nqSeries = ab.buildSeries(NQ);
const ivCache = new Map();
function baseIvAt(now) {   // the backtest's IV: 15m NQ band IV at the last 5m mark, x the time-of-day multiplier
  const mark = Math.floor(now / 300000) * 300000;
  if (!ivCache.has(mark)) {
    const a = ab.analysisAt(nqSeries, mark);
    const iv = a && a.A && a.A['15m'] ? bs.ivFromRelBandWidth((a.A['15m'].bbupper - a.A['15m'].bblower) / a.A['15m'].close) * BT.ivMultAt(etMin(mark)) : null;
    ivCache.set(mark, iv);
  }
  return ivCache.get(mark);
}
function listedStrikes(S) {
  const out = new Set();
  for (let k = Math.ceil((S - GRID_REACH) / 25) * 25; k <= S + GRID_REACH; k += 25) out.add(k);
  const lo = TENS ? TENS[0] : S - TENS_REACH, hi = TENS ? TENS[1] : S + TENS_REACH;
  for (let k = Math.ceil(lo / 10) * 10; k <= hi; k += 10) out.add(k);
  return [...out].sort((a, b) => a - b);
}
const bidAsk = bs.makeBidAsk();
let chainStats = { builds: 0 };
function chainAt(now, expiration) {
  const px = closed1m(ndxToday, now);
  if (!px.length) return null;
  const S = px[px.length - 1].close;
  const base = baseIvAt(now);
  if (!(base > 0)) return null;
  const tau = bs.tauFromTime(now);
  const band = S * base * Math.sqrt(tau);
  const vol = (K) => (band > 0 ? base * BT.skewMultAt((K - S) / band) : base);
  const expKey = `${expiration}:0`;
  const call = { [expKey]: {} }, put = { [expKey]: {} };
  for (const K of listedStrikes(S)) {
    for (const [type, side] of [['C', call], ['P', put]]) {
      const mid = Math.round(bs.bsPrice(type, S, K, tau, vol(K)) * 100) / 100;
      const q = bidAsk(mid);
      side[expKey][K.toFixed(1)] = [{ symbol: `NDX_${type}${K}`, mark: mid, bid: Math.round(q.bid * 100) / 100,
        ask: Math.round(q.ask * 100) / 100, quoteTimeInLong: now, strikePrice: K }];
    }
  }
  chainStats.builds++;
  return { call, put, underlying: S };
}

// ── THE ENGINE ──────────────────────────────────────────────────────────────────────────────────────────────────────
// 09:30 ET of DATE, from the first NDX bar of the day (its datetime IS the 09:30 mark).
const OPEN_MS = ndxToday[0].datetime;
NOW = OPEN_MS - 3600000;
const idx = require(path.join(ROOT, 'server/src/candle-spread/index'));
const store = require(path.join(ROOT, 'server/src/candle-spread/store'));

let runs = idx.buildRuns();
if (WANT) runs = runs.filter((r) => WANT.includes(r.variant));
if (!runs.length) { console.error('no variants selected'); process.exit(1); }
runs = runs.map((r) => ({ ...r, dryRun: true }));   // simulate, whatever the roster or arm says

idx._setDeps({
  isProd: false, tradingClient: null, accountHash: null,
  getRaw1m: async (symbol, { days = 7, endDate = NOW, rth } = {}) => {
    const fut = symbol.startsWith('/');
    const src = fut ? NQ : NDX;
    const useRth = rth != null ? rth : !fut;
    const end = Math.min(endDate, NOW), start = end - days * 86400000;
    return closed1m(src, NOW).filter((c) => c.datetime >= start && c.datetime <= end
      && (useRth ? (etMin(c.datetime) >= 570 && etMin(c.datetime) < 960) : true));
  },
  analyzeCandles: async (symbol, { timeframe = '5m' } = {}) => {
    const src = symbol.includes('NQ') ? NQ : NDX;
    const per = timeframe === '15m' ? 900000 : 300000;
    const b5 = bars5mNewestFirst(closed1m(src, NOW), NOW);
    if (per === 300000) return { candleData: { '5m': { candles: b5 } } };
    const by = new Map();
    for (const b of b5.slice().reverse()) {
      const k = Math.floor(b.datetime / per) * per;
      if (k + per > NOW + 2000) continue;
      const x = by.get(k);
      if (!x) by.set(k, { ...b, datetime: k }); else { x.high = Math.max(x.high, b.high); x.low = Math.min(x.low, b.low); x.close = b.close; }
    }
    return { candleData: { [timeframe]: { candles: [...by.values()].sort((a, b) => b.datetime - a.datetime) } } };
  },
  getOrFetchChainData: async (symbol, expiration) => chainAt(NOW, expiration),
  getSettlementPrice: async () => SETTLE,
  getSettlementPriceFor: async () => SETTLE,
});
idx._setRuns(runs);
idx._replay.markStarted();

(async () => {
  const T0 = Date.now ? RealDate.now() : 0;
  const ticks = { acted: 0, pending: {} };
  for (let mark = OPEN_MS; mark <= OPEN_MS + (6 * 60 + 25) * 60000; mark += 300000) {
    // THE CANDLE TICK at boundary + 5 s, retried every 5 s while pending (attemptTick).
    let r = null;
    for (let i = 0; i <= 12; i++) {
      NOW = mark + 5000 + i * 5000;
      r = await idx._replay.processGroup(runs, 'replay');
      if (!(r && r.pending)) break;
    }
    if (r && r.pending) ticks.pending[r.pending] = (ticks.pending[r.pending] || 0) + 1; else ticks.acted++;
    // THE SUB-BAR WORKER every 30 s until the next boundary.
    for (let s = 30000; s < 300000; s += 30000) { NOW = mark + s; await idx._replay.runRestingWork(); }
  }
  NOW = OPEN_MS + 6.5 * 3600000 + 7000;   // 16:00:07 ET
  await idx._replay.eodSettlement();

  // ── REPORT ──────────────────────────────────────────────────────────────────────────────────────────────────────
  const out = [];
  for (const run of runs) {
    const rec = store.initRun({ ...run, expiration: DATE }, DATE);
    const ev = rec.events || [];
    const settle = [...ev].reverse().find((e) => e.type === 'eod_settlement');
    const decs = ev.flatMap((e) => e.decisions || []);
    const count = (a) => decs.filter((d) => d.action === a).length;
    const pos = (rec.state.positions || []).filter((p) => p.filled && !p.hedge);
    const widths = {};
    for (const p of pos) { const w = p.spreadWidth || p.width || (p.legs ? Math.abs(p.legs[0].strike - p.legs[1].strike) : null); widths[w] = (widths[w] || 0) + 1; }
    out.push({ variant: run.variant, terminal: settle ? settle.terminalPnl : null, floor: settle ? settle.floorPnl : null,
      opens: pos.length, covered: pos.filter((p) => p.covered).length, widths,
      fallbackOpens: count('open-fallback-width'), skipGrid: count('open-skip-grid'), skipCeiling: count('open-skip-ceiling'),
      skipGov: count('open-skip-governor') });
  }
  const money = (n) => (n == null ? '—' : (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString());
  console.log(`\nREPLAY ${DATE} — live engine, modelled chain (25s always${TENS ? `, 10s only ${TENS[0]}-${TENS[1]}` : `, 10s within ±${TENS_REACH}`}), settle ${SETTLE} (${SETTLE_SRC})`);
  console.log(`ticks acted ${ticks.acted}, pending ${JSON.stringify(ticks.pending)}, chain builds ${chainStats.builds}, ${((RealDate.now() - T0) / 1000).toFixed(0)}s\n`);
  console.log('| variant | terminal | floor | opens | covered | widths | fallback opens | skip: grid | skip: ceiling | skip: governor |');
  console.log('|---|---|---|---|---|---|---|---|---|---|');
  for (const o of out) console.log(`| ${o.variant} | ${money(o.terminal)} | ${money(o.floor)} | ${o.opens} | ${o.covered} | ${Object.entries(o.widths).map(([w, n]) => `${w}W×${n}`).join(' ') || '—'} | ${o.fallbackOpens} | ${o.skipGrid} | ${o.skipCeiling} | ${o.skipGov} |`);
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ date: DATE, tens: TENS, settle: SETTLE, settleSource: SETTLE_SRC, ticks, runs: out }, null, 1));
  console.log(`\nrun records: ${RUNS_DIR}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
