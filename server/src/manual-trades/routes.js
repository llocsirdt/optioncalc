'use strict';
/**
 * LOCAL-ONLY review API for the user's real E*TRADE manual trades (data/manual-trades, built by
 * scripts/manual-trades/parse-etrade.js + assemble-market.js). Mounted at /api/v1/manual-trades.
 *
 *   GET /days        -> per-day summary + the final book's sampled expiry payoff curve, and a totals strip
 *   GET /day/:date   -> orders, the cumulative book after each order (payoff curve per step), NQ candles
 *                       1m/5m/15m/60m with BB(20,2) + 9EMA, the NQ->NDX basis, order markers per TF, levels
 *
 * The data is private trading history and lives at the REPO ROOT (data/manual-trades), which the deploy
 * package (zips server/ only) never carries. When the folder is absent (prod) every route answers 404.
 *
 * All computation is here (pure helpers exported for tests); the pages only draw what this returns.
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const B = require('./book');
const IND = require('../candle-spread/signals/indicators');

const DATA_DIR = process.env.MANUAL_TRADES_DIR || path.join(__dirname, '..', '..', '..', 'data', 'manual-trades');
const r2 = n => Math.round(n * 100) / 100;
const TFS = { '1m': 1, '5m': 5, '15m': 15, '60m': 60 };

// ── pure helpers ──────────────────────────────────────────────────────────────────────────────────────

/** Signed book legs of one order ({root,right,strike,qty}); leg.qty is total contracts, side gives the sign. */
function orderLegs(o) {
  return o.legs.map(l => ({ root: o.root, right: l.type === 'call' ? 'C' : 'P', strike: l.strike, qty: (l.side === 'long' ? 1 : -1) * l.qty }));
}

/** Short human style label, e.g. "V-call debit", "fly", "asymFly balanced", "BWcondor", "single long put". */
function styleLabel(o) {
  const st = o.style, sub = o.subtype || '';
  if (st === 'vertical') return `V-${sub}`;
  if (st === 'butterfly') return 'fly';
  if (st === 'broken-wing butterfly') return 'BWfly';
  if (st === 'asymmetric butterfly') return `asymFly ${sub.split(' ')[0]}`;
  if (st === 'broken-wing condor') return 'BWcondor';
  if (st === 'single') return `single ${sub}`;
  return st;
}

/** Expiry P&L ($) of signed legs + cash at S. `settleOf(leg)` lets AM-settled NDX legs use their own settle. */
function valueAt(legs, cash, S) { return B.payoffAt(legs, S) + cash; }

/**
 * Exact sampled payoff curve over [xMin, xMax]: the payoff is piecewise-linear with kinks only at strikes,
 * so the endpoints + every strike inside the range describe it exactly.
 */
function payoffCurve(legs, cash, xMin, xMax) {
  const xs = new Set([xMin, xMax]);
  for (const l of legs) if (l.strike > xMin && l.strike < xMax) xs.add(l.strike);
  const pts = [...xs].sort((a, b) => a - b).map(x => ({ x, y: r2(valueAt(legs, cash, x)) }));
  const ys = pts.map(p => p.y);
  return { xMin, xMax, points: pts, min: Math.min(...ys), max: Math.max(...ys) };
}

/** Price window for a day's curves: strikes + settle + (optional) underlying range, padded. Rounded to 10s. */
function priceRange(legs, settle, extra = []) {
  const vals = [...legs.map(l => l.strike), settle, ...extra].filter(v => typeof v === 'number' && isFinite(v));
  if (!vals.length) return null;
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = Math.max(50, (hi - lo) * 0.15);
  return { xMin: Math.floor((lo - pad) / 10) * 10, xMax: Math.ceil((hi + pad) / 10) * 10 };
}

/**
 * The orders that build THIS expiry's book, in time order: carried-in orders (traded on an earlier date,
 * expiring today) first, then today's orders expiring today. Non-0DTE orders traded today belong to a later
 * book and are excluded. `byNo` maps orderNo -> order across all days.
 */
function bookOrders(day, byNo) {
  const carried = (day.carriedIn || []).map(n => byNo.get(typeof n === 'string' ? n : n.orderNo)).filter(Boolean)
    .map(o => ({ order: o, carried: true }));
  const today = day.orders.filter(o => o.expiry === day.date)
    .map((o, i) => ({ order: o, carried: false, i }))
    .sort((a, b) => (a.order.timeET && b.order.timeET ? a.order.timeET.localeCompare(b.order.timeET) : 0) || a.i - b.i);
  return [...carried, ...today];
}

/**
 * Cumulative book after each order: step k = netted legs + cash (Σ order.total = premium − fees) of orders
 * 0..k, its payoff curve over the shared window, and its P&L at the official settle. The last step IS the
 * day's book (the test checks it reconciles to day.pnl.net).
 */
function cumulativeSteps(seq, xMin, xMax, settle) {
  const legs = [];
  let cash = 0;
  return seq.map(({ order }) => {
    legs.push(...orderLegs(order));
    cash += order.total;
    const net = B.netLegs(legs);
    return {
      orderNo: order.orderNo,
      cash: r2(cash),
      legs: net.map(l => ({ root: l.root, right: l.right, strike: l.strike, qty: l.qty })),
      curve: payoffCurve(net, cash, xMin, xMax),
      atSettle: settle != null ? r2(valueAt(net, cash, settle)) : null,
    };
  });
}

/** ET wall-clock (YYYY-MM-DD, "HH:MM[:SS]") -> epoch ms, DST-correct via Intl. */
function etToMs(date, hms) {
  const [hh, mm, ss = 0] = hms.split(':').map(Number);
  const guess = Date.parse(`${date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`);
  for (const off of [4, 5]) {
    const ms = guess + off * 3600e3;
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(ms)).reduce((a, x) => (a[x.type] = x.value, a), {});
    if (`${p.year}-${p.month}-${p.day}` === date && +p.hour === hh && +p.minute === mm) return ms + ss * 1000;
  }
  return guess + 4 * 3600e3 + ss * 1000;
}

/** Candles for one TF with BB(20,2) + 9EMA. 60m is prefixed with the warmup bars (dropped from the output unless keepWarmup). */
function tfSeries(bars1m, tf, warmup60m = [], keepWarmup = false) {
  const c1 = bars1m.map(b => ({ datetime: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v }));
  let cs = TFS[tf] === 1 ? c1 : IND.resample(c1, TFS[tf]);
  let skip = 0;
  if (tf === '60m' && warmup60m.length) {
    const first = cs.length ? cs[0].datetime : Infinity;
    const pre = warmup60m.filter(h => h.t < first).map(h => ({ datetime: h.t, open: h.o, high: h.h, low: h.l, close: h.c, volume: h.v }));
    skip = pre.length; cs = [...pre, ...cs];
  }
  return IND.withIndicators(cs).slice(keepWarmup ? 0 : skip).map(c => ({
    t: c.datetime, o: c.open, h: c.high, l: c.low, c: c.close,
    bbU: c.bbUpper, bbM: c.bbMiddle, bbL: c.bbLower, ema9: c.ema9,
  }));
}

/** Last 1m close at or before ms (NQ terms), or null. */
function nqAt(bars1m, ms) {
  let lo = 0, hi = bars1m.length - 1, ans = null;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (bars1m[m].t <= ms) { ans = m; lo = m + 1; } else hi = m - 1; }
  if (ans == null) return null;
  // bar t is the START: an order inside the bar sees that bar's running price; its close is the best proxy
  return bars1m[ans].c;
}

// ── data access ───────────────────────────────────────────────────────────────────────────────────────

let cache = { mtime: 0, T: null, byNo: null };
function loadTrades() {
  const p = path.join(DATA_DIR, 'trades.json');
  const st = fs.statSync(p);                      // throws ENOENT when absent -> 404
  if (st.mtimeMs !== cache.mtime) {
    const T = JSON.parse(fs.readFileSync(p, 'utf8'));
    const byNo = new Map();
    for (const d of T.days) for (const o of d.orders) byNo.set(o.orderNo, o);
    cache = { mtime: st.mtimeMs, T, byNo, days: null };
  }
  return cache;
}
function loadNq(date) {
  const p = path.join(DATA_DIR, 'market', 'nq-1m', `${date}.json`);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}
let dailyCache = null;
function loadDaily() {
  const p = path.join(DATA_DIR, 'market', 'nq-daily.json');
  if (!fs.existsSync(p)) return [];
  const st = fs.statSync(p);
  if (!dailyCache || dailyCache.mtime !== st.mtimeMs) {
    const bars = JSON.parse(fs.readFileSync(p, 'utf8')).bars;
    const ind = IND.withIndicators(bars.map(b => ({ datetime: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v })));
    dailyCache = { mtime: st.mtimeMs, rows: bars.map((b, i) => ({ date: b.date, c: ind[i] })) };
  }
  return dailyCache.rows;
}
/** Daily sessions through `date`, chartseries shape. The trade day's own bar carries the PRIOR day's bands: what was
 *  on the chart that morning, not the end-of-day values (which would leak the day's close into every intraday read). */
function dailySeries(date) {
  const rows = loadDaily().filter(r => r.date <= date);
  return rows.map((r, i) => {
    const b = (r.date === date && i > 0) ? rows[i - 1].c : r.c;
    return { datetime: r.c.datetime, open: r.c.open, high: r.c.high, low: r.c.low, close: r.c.close, volume: r.c.volume || 0,
      bbUpper: b.bbUpper, bbMiddle: b.bbMiddle, bbLower: b.bbLower, ema9: b.ema9 };
  });
}
function loadBasis() {
  const p = path.join(DATA_DIR, 'market', 'basis.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')).days || {} : {};
}

/** RTH (09:30-16:00 ET) high/low of NQ in NDX terms — used to size the price window. */
function rthRangeNdx(nq, date, basis) {
  if (!nq || basis == null) return [];
  const a = etToMs(date, '09:30'), b = etToMs(date, '16:00');
  const rth = nq.bars.filter(x => x.t >= a && x.t < b);
  if (!rth.length) return [];
  return [Math.min(...rth.map(x => x.l)) - basis, Math.max(...rth.map(x => x.h)) - basis];
}

function daySummary(day, byNo, basisDay, nq) {
  const seq = bookOrders(day, byNo);
  const final = B.netLegs(seq.flatMap(s => orderLegs(s.order)));
  const cash = seq.reduce((a, s) => a + s.order.total, 0);
  const basis = basisDay ? basisDay.basis : null;
  const range = priceRange(final, day.settle, rthRangeNdx(nq, day.date, basis)) || { xMin: day.settle - 100, xMax: day.settle + 100 };
  return {
    date: day.date,
    timesKnown: !!(day.source && day.source.timesKnown),
    settle: day.settle, amSettle: day.amSettle || null,
    orders: day.orders.length, ordersInBook: seq.length,
    carriedIn: (day.carriedIn || []).length, nonZeroDte: (day.nonZeroDteOrders || []).length,
    styleCounts: day.styleCounts, widthsUsed: day.widthsUsed,
    pnl: day.pnl, reconcile: day.reconcile ? day.reconcile.status : null,
    basis,
    curve: payoffCurve(final, cash, range.xMin, range.xMax),
    // P&L of the netted book at the official close. Equals pnl.net except when AM-settled monthly NDX legs
    // are in the book (they settle at amSettle, not the close) — pnl.net is the true number.
    curveAtSettle: r2(valueAt(final, cash, day.settle)),
    _range: range, _seq: seq,
  };
}

function allDays() {
  const c = loadTrades();
  if (!c.days) {
    const basis = loadBasis();
    c.days = c.T.days.map(d => daySummary(d, c.byNo, basis[d.date], loadNq(d.date)));
  }
  return c;
}

function dayDetail(date) {
  const c = allDays();
  const day = c.T.days.find(d => d.date === date);
  if (!day) return null;
  const sum = c.days.find(d => d.date === date);
  const nq = loadNq(date);
  const basis = sum.basis;
  const { xMin, xMax } = sum._range;
  const seq = sum._seq;
  const steps = cumulativeSteps(seq, xMin, xMax, day.settle);
  const bars = nq ? nq.bars : [];
  const timed = sum.timesKnown;
  const orderMs = o => (o.timeET && o.date ? etToMs(o.date, o.timeET) : null);

  const stepOf = new Map(seq.map((s, k) => [s.order.orderNo, k]));
  // Each order's OWN result at its expiry's settle (premium − fees + expiry value of its legs): did this order make money?
  const settleOn = new Map(c.T.days.map(d => [d.date, d.settle]));
  const orderPnl = (o) => { const S = settleOn.get(o.expiry); return S == null ? null : r2(valueAt(orderLegs(o), o.total, S)); };
  const orders = [...seq.map(s => s.order), ...day.orders.filter(o => o.expiry !== date)].map(o => {
    const ms = orderMs(o);
    const nqPx = ms != null && o.date === date ? nqAt(bars, ms) : null;
    return {
      orderNo: o.orderNo, date: o.date, timeET: o.timeET, ms: o.date === date ? ms : null,
      carried: o.date !== date, expiry: o.expiry, inBook: stepOf.has(o.orderNo), step: stepOf.has(o.orderNo) ? stepOf.get(o.orderNo) : null,
      effect: o.effect, style: o.style, subtype: o.subtype, styleLabel: styleLabel(o), direction: o.direction,
      debitCredit: o.debitCredit, widths: o.widths, qty: o.qty, ratio: o.ratio,
      legs: o.legs, netPerUnit: o.netPerUnit, premium: o.premium, fees: o.fees, total: o.total,
      groupingInferred: !!o.groupingInferred,
      underlyingNdxEst: nqPx != null && basis != null ? r2(nqPx - basis) : null, underlyingNq: nqPx,
      pnlAtSettle: orderPnl(o),
    };
  });
  for (const st of steps) {
    const o = orders.find(x => x.orderNo === st.orderNo);
    st.ms = o.ms; st.timeET = o.timeET; st.carried = o.carried; st.label = `${o.styleLabel} ${o.widths.join('/')}`;
    st.underlyingNdxEst = o.underlyingNdxEst;
  }

  // series = the /chartseries candle shape client/lib/nq-chart.js reads, so the page can host the SAME NQ chart as
  // index/debug (Schwab no longer serves 2025 bars, so the page hands these in via NQChart.setSeries).
  const series = {}, markers = {};
  for (const tf of Object.keys(TFS)) {
    series[tf] = (bars.length ? tfSeries(bars, tf, nq.warmup60m || [], tf === '60m') : []).map(c => ({
      datetime: c.t, open: c.o, high: c.h, low: c.l, close: c.c, volume: 0,
      bbUpper: c.bbU, bbMiddle: c.bbM, bbLower: c.bbL, ema9: c.ema9,
    }));
    const ms = TFS[tf] * 60e3;
    markers[tf] = timed ? orders.filter(o => o.ms != null).map(o => ({
      orderNo: o.orderNo, candleT: Math.floor(o.ms / ms) * ms, ms: o.ms, timeET: o.timeET,
      styleLabel: o.styleLabel, direction: o.direction, debitCredit: o.debitCredit, effect: o.effect, inBook: o.inBook,
      legs: o.legs.map(l => `${l.side === 'long' ? '+' : '−'}${l.qty} ${l.strike}${l.type === 'call' ? 'C' : 'P'}`).join(' '),
      netPerUnit: o.netPerUnit, pnlAtSettle: o.pnlAtSettle,
    })) : [];
  }

  series.daily = dailySeries(date);   // the chart's 1D button; 60m above keeps ~5 prior sessions for hourly context

  const strikes = [...new Set(steps.length ? steps[steps.length - 1].legs.map(l => l.strike) : [])].sort((a, b) => a - b);
  const levels = basis == null ? [] : [
    ...strikes.map(k => ({ kind: 'strike', ndx: k, nq: r2(k + basis) })),
    { kind: 'settle', ndx: day.settle, nq: r2(day.settle + basis) },
  ];

  const { _range, _seq, ...summary } = sum;
  return {
    summary,
    timesKnown: timed,
    markersNote: timed ? null : 'Date-only export for this day: no order times, so no markers on the candles and no "underlying at order".',
    basis, basisDetail: loadBasis()[date] || null,
    basisNote: 'NDX levels are drawn on the NQ chart as NDX + basis; basis is a per-day constant (NQ back-adjusted close − NDX close) with ±10-30 pt noise, so strike lines are approximate.',
    orders, steps, series, markers, levels,
    nqSymbol: nq ? nq.symbol : null,
  };
}

// ── router ────────────────────────────────────────────────────────────────────────────────────────────

const router = express.Router();
const absent = () => !fs.existsSync(path.join(DATA_DIR, 'trades.json'));

router.get('/days', (req, res) => {
  if (absent()) return res.status(404).json({ error: 'manual-trades data not present on this server' });
  try {
    const c = allDays();
    const days = c.days.map(({ _range, _seq, ...d }) => d);
    const nets = days.map(d => d.pnl.net);
    const best = days.reduce((a, d) => (!a || d.pnl.net > a.pnl.net ? d : a), null);
    const worst = days.reduce((a, d) => (!a || d.pnl.net < a.pnl.net ? d : a), null);
    res.json({
      totals: {
        days: days.length, total: r2(nets.reduce((a, b) => a + b, 0)),
        winning: nets.filter(n => n > 0).length, losing: nets.filter(n => n < 0).length, flat: nets.filter(n => n === 0).length,
        best: best && { date: best.date, net: best.pnl.net }, worst: worst && { date: worst.date, net: worst.pnl.net },
        orders: days.reduce((a, d) => a + d.orders, 0),
      },
      days,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/day/:date', (req, res) => {
  if (absent()) return res.status(404).json({ error: 'manual-trades data not present on this server' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  try {
    const d = dayDetail(req.params.date);
    if (!d) return res.status(404).json({ error: `no manual trades on ${req.params.date}` });
    res.json(d);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports.helpers = { orderLegs, styleLabel, payoffCurve, priceRange, bookOrders, cumulativeSteps, etToMs, tfSeries, nqAt };
