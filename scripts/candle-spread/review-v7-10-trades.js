#!/usr/bin/env node
'use strict';
/**
 * v7-10 LIVE TRADE REVIEW (analysis only — touches no engine code).
 *
 * Every v7-10 position (opens incl. unfilled/cancelled, floor-raise hedges, absorbed manual orders) over a date
 * range, joined to the /NQ indicator state at the decision bar and to the NDX path afterwards, then classified
 * WORKED / MARGINAL / DIDNT / UNFILLED / HEDGE, with pattern tables and candidate open filters.
 *
 * SOURCES (real tracked values wherever they exist):
 *   - Runs: candle-spread-archive/NDX_<D>_<D>_v7-10.json (prod mirror; run sync-candle-spread-runs.js first).
 *     state.positions = legs, sent form, broker fill (price/side), cover legs, broker cover fill, cover geometry,
 *     fillUnder (NDX at fill). order_filled events give the cover KIND (cover-rest/-reprice = normal,
 *     cover-giveup, cover-stall). eod_settlement.positions[].pnl = REAL terminal P&L per position.
 *     candle_close.signal.reason = the v7 rule that fired; classification.openSide = side it asked for.
 *   - /NQ 5m/15m/60m 24h bars with BB(20,2)+9EMA: the server's /chartseries (same chart-series.js the engine
 *     reads), cached in OUT/cache/NQ-{5m,15m,60m}.json. Verified equal to the engine's own signal-trace inputs.
 *   - NQ daily bands: data/sweeps/daily-bb-2026-10-15/daily-NQ.json (prior COMPLETED day's band).
 *   - NDX 1m: signal-lab-data/raw-1m/NDX-<D>.json (MFE/MAE, day move, counterfactual-wait proxy).
 *
 * DERIVED (flagged in the CSV header + report): debit-equivalent open/cover price for credit-form fills
 *   (width - credit, exact for P&L by put-call parity on a vertical); the locked floor/ceiling of a covered
 *   position (eod pnl shifted by the payoff difference across strikes — the eod pnl itself is real); and the
 *   "wait 1-3 bars" / signal-level outcome PROXY (underlying-only, no option prices).
 *
 * 2026-10-01 ran in TEST mode (simulated fills) — kept in the CSV, excluded from the pattern statistics.
 *
 * Usage: node scripts/candle-spread/review-v7-10-trades.js [--from 2026-10-01] [--to 2026-10-15]
 *        [--out data/sweeps/v7-10-review-2026-10-15] [--refresh  (re-pull /NQ bars from the local server)]
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const argv = process.argv.slice(2);
const arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const FROM = arg('--from', '2026-10-01');
const TO = arg('--to', '2026-10-15');
const OUT = path.resolve(ROOT, arg('--out', 'data/sweeps/v7-10-review-2026-10-15'));
const VARIANT = arg('--variant', 'v7-10');
const ARCH = path.join(ROOT, 'candle-spread-archive');
const RAW1 = path.join(ROOT, 'signal-lab-data/raw-1m');
const DAILY = path.join(ROOT, 'data/sweeps/daily-bb-2026-10-15/daily-NQ.json');
const SERVER = arg('--server', 'http://localhost:3001');

const M5 = 5 * 60000, M15 = 15 * 60000, M60 = 60 * 60000;
const etFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
function et(ms) {
  const p = Object.fromEntries(etFmt.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour === '24' ? '00' : p.hour}:${p.minute}` };
}
const hmMin = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
const r1 = n => n == null || !isFinite(n) ? null : Math.round(n * 10) / 10;
const r2 = n => n == null || !isFinite(n) ? null : Math.round(n * 100) / 100;
const sum = a => a.reduce((s, x) => s + (x || 0), 0);
const mean = a => a.length ? sum(a) / a.length : null;
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const legStr = legs => (legs || []).map(l => `${l.side === 'long' ? '+' : '-'}${l.type}${l.strike}`).join('/');

// ---------------------------------------------------------------- data loading
async function loadNq(tf) {
  const f = path.join(OUT, 'cache', `NQ-${tf}.json`);
  if (fs.existsSync(f) && !argv.includes('--refresh')) return JSON.parse(fs.readFileSync(f, 'utf8')).candles;
  const from = Date.parse('2026-09-20T00:00:00Z');
  const url = `${SERVER}/api/v1/marketdata/chartseries?symbol=%2FNQ&timeframe=${tf}&from=${from}&to=${Date.now()}&fresh=1`;
  const j = await (await fetch(url)).json();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(j));
  return j.candles;
}
function ndx1m(date) {
  const f = path.join(RAW1, `NDX-${date}.json`);
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8')).candles.sort((a, b) => a.datetime - b.datetime);
}
function tradingDays() {
  const out = [];
  for (const f of fs.readdirSync(ARCH)) {
    const m = f.match(new RegExp(`^NDX_(\\d{4}-\\d{2}-\\d{2})_\\1_${VARIANT.replace(/-/g, '\\-')}\\.json$`));
    if (m && m[1] >= FROM && m[1] <= TO) out.push(m[1]);
  }
  return out.sort();
}

// ---------------------------------------------------------------- indicator state
const trendOf = c => (!c || c.bbMiddle == null || c.ema9 == null) ? 0
  : (c.close > c.bbMiddle && c.ema9 >= c.bbMiddle ? 1 : c.close < c.bbMiddle && c.ema9 <= c.bbMiddle ? -1 : 0);
const col = c => !c ? '?' : c.close > c.open ? 'G' : c.close < c.open ? 'R' : 'F';
function lastCompletedIdx(S, tfMs, B) {
  let lo = 0, hi = S.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (S[m].datetime + tfMs <= B) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans;
}
function tfState(S, tfMs, B, side) {
  const i = lastCompletedIdx(S, tfMs, B);
  if (i < 2) return null;
  const c = S[i], p = S[i - 1], pp = S[i - 2];
  const bw = c.bbUpper - c.bbLower;
  const pctB = bw > 0 ? (c.close - c.bbLower) / bw : null;
  const trend = trendOf(c);
  const sgn = side === 'bull' ? 1 : side === 'bear' ? -1 : 0;
  return {
    close: c.close, pctB: r2(pctB), vsEma: r1(c.close - c.ema9), emaSlope: r1(c.ema9 - p.ema9), bw: r1(bw),
    vsMid: r1(c.close - c.bbMiddle), trend, cols: col(pp) + col(p) + col(c), hh: c.high > p.high, ll: c.low < p.low,
    distUp: r1(c.bbUpper - c.close), distLo: r1(c.close - c.bbLower),
    // oriented to the trade: >0.5 = price already up in the band in the trade's direction (stretched)
    pctBSide: pctB == null ? null : r2(sgn > 0 ? pctB : 1 - pctB),
    roomSide: r1(sgn > 0 ? c.bbUpper - c.close : c.close - c.bbLower),          // pts to the band ahead
    emaSide: r1(sgn * (c.close - c.ema9)),                                        // >0 = on the trade's side of the 9EMA
    slopeSide: r1(sgn * (c.ema9 - p.ema9)),                                       // >0 = 9EMA sloping with the trade
    rel: trend === 0 ? 'flat' : trend === sgn ? 'with' : 'against',
    lastColSide: col(c) === 'G' ? (sgn > 0 ? 'with' : 'against') : col(c) === 'R' ? (sgn < 0 ? 'with' : 'against') : 'flat',
    // colours of the last 3 bars oriented to the trade: W = with, A = against
    seqSide: [pp, p, c].map(x => { const k = col(x); return k === 'F' ? '-' : ((k === 'G') === (sgn > 0) ? 'W' : 'A'); }).join(''),
    hhllSide: sgn > 0 ? (c.high > p.high ? 'HH' : '') + (c.low < p.low ? 'LL' : '') : (c.low < p.low ? 'LL' : '') + (c.high > p.high ? 'HH' : ''),
  };
}

// PROXY (underlying only, no option prices): from t0, does NDX go favPts our way before advPts against within winMs?
// 'W' = favourable first, 'L' = adverse first, 'n' = neither inside the window.
function proxyOutcome(N1, side, t0, favPts, advPts, winMs = 60 * 60000) {
  let ref = null; for (const b of N1) { if (b.datetime + 60000 <= t0) ref = b.close; else break; }
  if (ref == null) return null;
  for (const b of N1) {
    if (b.datetime < t0) continue; if (b.datetime >= t0 + winMs) break;
    const f = side === 'bull' ? b.high - ref : ref - b.low; const a = side === 'bull' ? ref - b.low : b.high - ref;
    if (a >= advPts) return 'L'; if (f >= favPts) return 'W';
  }
  return 'n';
}
const PROXY_FAVS = [5, 8, 10, 12, 15, 20, 25, 30, 40];

// ---------------------------------------------------------------- main build
async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const NQ = { 5: await loadNq('5m'), 15: await loadNq('15m'), 60: await loadNq('60m') };
  const daily = JSON.parse(fs.readFileSync(DAILY, 'utf8')).map(c => ({ date: et(c.datetime).date, ...c })).sort((a, b) => a.datetime - b.datetime);
  const days = tradingDays();
  const positions = [], signals = [], dayRows = [], traceChecks = [];
  let prevCfg = null;

  for (const D of days) {
    const run = JSON.parse(fs.readFileSync(path.join(ARCH, `NDX_${D}_${D}_${VARIANT}.json`), 'utf8'));
    const cfg = run.config;
    const sim = cfg.dryRun !== false;                // 10/01 'test' = simulated fills
    const W = cfg.spreadWidth || 10;
    const giveUpPts = cfg.coverGiveUp ? (cfg.giveUpPoints || 10) : null;
    const ev = run.events;
    const eod = ev.find(e => e.type === 'eod_settlement');
    const eodPos = new Map((eod ? eod.positions : []).map(p => [p.id, p]));
    const settle = eod ? eod.settle : null;
    const filledKind = new Map(ev.filter(e => e.type === 'order_filled').map(e => [String(e.orderId), e]));
    const cc = ev.filter(e => e.type === 'candle_close');
    const ccByLabel = new Map(); for (const e of cc) ccByLabel.set(e.candle.time, e);
    const N1 = ndx1m(D) || [];
    const ndxOpen = N1.length ? N1[0].open : null;
    const ndxAt = ms => { let v = null; for (const b of N1) { if (b.datetime + 60000 <= ms) v = b.close; else break; } return v; };
    const dayBand = (() => { let ans = null; for (const d of daily) if (d.date < D) ans = d; return ans; })();
    const halts = ev.filter(e => e.type === 'order_control_blocked');

    const feats = (B, side) => {
      const f = { s5: tfState(NQ[5], M5, B, side), s15: tfState(NQ[15], M15, B, side), s60: tfState(NQ[60], M60, B, side) };
      // engine trend state 'A' = 15m structural trend agreeing with the last COMPLETED hourly candle colour
      const i60 = lastCompletedIdx(NQ[60], M60, B);
      const h = NQ[60][i60];
      const hc = !h ? 0 : h.close > h.open ? 1 : h.close < h.open ? -1 : 0;
      const t15 = f.s15 ? f.s15.trend : 0;
      f.trendA = t15 !== 0 && t15 === hc ? t15 : 0;
      // forming hour (completed 5m bars since the last completed hour)
      const formFrom = h ? h.datetime + M60 : null;
      const fb = NQ[5].filter(b => formFrom != null && b.datetime >= formFrom && b.datetime + M5 <= B);
      f.hf = fb.length ? Math.sign(fb[fb.length - 1].close - fb[0].open) : 0;
      const nqNow = f.s5 ? f.s5.close : null;
      f.dailyPctB = dayBand && nqNow != null ? r2((nqNow - dayBand.bbLower) / (dayBand.bbUpper - dayBand.bbLower)) : null;
      const sgn = side === 'bull' ? 1 : -1;
      f.trendARel = f.trendA === 0 ? 'flat' : f.trendA === sgn ? 'with' : 'against';
      f.hcRel = hc === 0 ? 'flat' : hc === sgn ? 'with' : 'against';
      const px = ndxAt(B);
      f.ndxAtB = px;
      f.dayMove = px != null && ndxOpen != null ? r1(px - ndxOpen) : null;
      f.dayMoveSide = f.dayMove != null ? r1(sgn * f.dayMove) : null;
      f.tod = hmMin(et(B).hm) - 570;
      return f;
    };
    // underlying excursion (NDX 1m) in the trade's direction between two epochs, from a reference price
    const excursion = (side, ref, t0, t1) => {
      let fav = 0, adv = 0, firstFavAt = null;
      for (const b of N1) {
        if (b.datetime + 60000 <= t0 || b.datetime >= t1) continue;
        const f = side === 'bull' ? b.high - ref : ref - b.low;
        const a = side === 'bull' ? ref - b.low : b.high - ref;
        fav = Math.max(fav, f); adv = Math.max(adv, a);
      }
      return { fav: r1(fav), adv: r1(adv) };
    };
    const close16 = Date.parse(`${D}T20:00:00Z`);

    // ---- signal-level rows: every bar the rules asked for an open (acted on or not)
    for (const e of cc) {
      const side = e.classification && e.classification.openSide;
      if (!side) continue;
      const B = Math.floor(Date.parse(e.time) / M5) * M5;
      const acts = (e.decisions || []).map(d => d.action);
      const opened = acts.includes('open');
      const what = opened ? 'open' : (acts.find(a => a.startsWith('open-skip')) || acts.find(a => a.startsWith('open')) || acts[0] || '');
      const f = feats(B, side);
      signals.push({ date: D, sim, et: et(B).hm, B, side, reason: (e.signal && e.signal.reason) || '', isFifteen: !!(e.signal && e.signal.isFifteen), acted: what, opened,
        f, giveUpPts, proxyBy: Object.fromEntries(PROXY_FAVS.map(F => [F, proxyOutcome(N1, side, B, F, giveUpPts || 20)])),
        exc60: (() => { const ref = ndxAt(B); return ref == null ? null : excursion(side, ref, B, Math.min(B + 60 * 60000, close16)); })() });
    }

    // ---- positions
    const ps = run.state.positions || [];
    for (const p of ps) {
      const kind = p.manual ? 'manual' : p.raise || String(p.id).startsWith('raise') ? 'raise' : 'open';
      const placed = p.placedEpoch || Date.parse(p.openedAt) || p.openEpoch;
      const B = Math.floor((p.openEpoch || placed) / M5) * M5;
      const cand = ccByLabel.get(p.openTime);
      const side = kind === 'open' ? p.side : p.side;
      const reason = kind === 'open' ? (cand && cand.signal ? cand.signal.reason : '') : kind === 'raise' ? 'floor-raise' : 'manual';
      const decs = cand ? cand.decisions || [] : [];
      const fallback = kind === 'open' && decs.some(d => d.action === 'open-fallback' && d.side === p.side);
      const funds = kind === 'open' && decs.some(d => d.action === 'funds-style');
      const filled = !!p.filled;
      // real open fill
      let fillPx = null, fillSide = null, fillAt = null, fillFrom = 'broker';
      if (p.brokerFill) { fillPx = p.brokerFill.price; fillSide = p.brokerFill.side; fillAt = p.brokerFill.at || p.fillEpoch; }
      else if (filled && p.manual) { fillPx = p.limit; fillSide = 'DEBIT'; fillAt = p.openEpoch; fillFrom = 'manual-exec'; }
      else if (filled) { fillPx = p.limit; fillSide = p.sentNet || 'DEBIT'; fillAt = p.fillEpoch || placed; fillFrom = sim ? 'SIM' : 'engine-limit'; }
      // debit-equivalent (DERIVED for credit-form fills: width - credit)
      const openDE = fillPx == null ? null : (kind === 'open' && fillSide === 'CREDIT' ? r2(W - fillPx) : fillPx);
      // unfilled reason
      let unfilled = '';
      if (!filled) {
        const dead = ev.filter(e => e.type === 'order_dead' && e.positionId === p.id && e.status === 'rejected');
        const canc = ev.filter(e => e.type === 'order_cancelled' && e.meta && e.meta.of === p.id);
        const blocked = ev.filter(e => e.type === 'order_control_blocked' && e.meta && e.meta.of === p.id);
        if (dead.some(e => /buying power/i.test(e.reason || ''))) unfilled = 'rejected:buying-power';
        else if (dead.length) unfilled = 'rejected:' + (dead[0].reason || '');
        else if (canc.length) unfilled = 'cancelled:' + (canc[canc.length - 1].meta.reason || '');
        else if (p.cancelRequestedAt) unfilled = 'cancelled';
        else unfilled = 'unfilled:' + (p.orderStatus || '');
      }
      // cover
      let coverKind = null, coverPx = null, coverSide = null, coverAt = null, coverGeo = p.coverGeometry || null;
      if (p.covered) {
        const bcf = p.brokerCoverFill;
        if (bcf) {
          coverPx = bcf.price; coverSide = bcf.side;
          const fe = filledKind.get(String(bcf.orderId));
          coverKind = fe ? fe.kind : (p.coverOrder ? p.coverOrder.kind : null);
          coverAt = p.coverFilledAt || (fe ? Date.parse(fe.time) : null);
        } else if (p.filledCover) {   // sim (10/01)
          coverPx = p.filledCover.target; coverSide = 'DEBIT-EQ'; coverKind = 'SIM';
          const rw = ev.filter(e => e.type === 'resting_work').flatMap(e => (e.decisions || []).map(d => ({ ...d, t: Date.parse(e.time) }))).find(d => d.action === 'cover-fill' && d.positionId === p.id);
          coverAt = rw ? rw.t : p.coverFilledAt || p.coverEpoch;
          coverPx = rw ? rw.fillPrice : coverPx;
        }
      }
      const coverClass = coverKind == null ? null : /giveup/.test(coverKind) ? 'give-up' : /stall/.test(coverKind) ? 'stall' : coverKind === 'SIM' ? 'sim' : 'normal';
      const ep = eodPos.get(p.id);
      const pnl = ep ? Math.round(ep.pnl) : null;
      // locked floor / ceiling of the covered structure (DERIVED: real eod pnl shifted by the payoff spread)
      let lockFloor = null, lockMax = null;
      if (ep && settle != null) {
        const legs = [...(p.legs || []), ...((p.covered && p.coverLegs) || [])];
        const pay = S => sum(legs.map(l => { const v = l.type === 'C' ? Math.max(0, S - l.strike) : Math.max(0, l.strike - S); return l.side === 'long' ? v : -v; }));
        const ks = legs.map(l => l.strike); const lo = Math.min(...ks) - 50, hi = Math.max(...ks) + 50;
        let mn = Infinity, mx = -Infinity; for (let S = lo; S <= hi; S += 1) { const v = pay(S); mn = Math.min(mn, v); mx = Math.max(mx, v); }
        const ps0 = pay(settle);
        lockFloor = Math.round(ep.pnl + 100 * (mn - ps0)); lockMax = Math.round(ep.pnl + 100 * (mx - ps0));
      }
      // NDX at the fill: last completed 1m close before the broker fill (p.fillUnder is the PLACEMENT-time underlying on
      // resting fills, e.g. 10/08 13:00 bear placed at 30,760, filled 13:03 at ~30,708 — so it is kept only as a fallback)
      const fillUnder = (fillAt ? ndxAt(fillAt) : null) ?? p.fillUnder ?? null;
      const placedUnder = p.placedUnder ?? p.fillUnder ?? null;
      const shortK = p.shortStrike;
      const itmPts = shortK != null && fillUnder != null && kind === 'open' ? r1(side === 'bull' ? fillUnder - shortK : shortK - fillUnder) : null;
      const tEnd = coverAt || close16;
      const exc = filled && fillUnder != null && (side === 'bull' || side === 'bear') ? excursion(side, fillUnder, fillAt, tEnd) : null;
      const post = coverAt && fillUnder != null && (side === 'bull' || side === 'bear') ? (() => {
        const ref = ndxAt(coverAt + 60000) || fillUnder;
        const e60 = excursion(side, ref, coverAt, Math.min(coverAt + 60 * 60000, close16));
        return { ref, fav60: e60.fav, adv60: e60.adv };
      })() : null;
      const minsToCover = coverAt && fillAt ? r1((coverAt - fillAt) / 60000) : null;
      const eodMoveSide = fillUnder != null && settle != null && (side === 'bull' || side === 'bear') ? r1((side === 'bull' ? 1 : -1) * (settle - fillUnder)) : null;
      const f = (side === 'bull' || side === 'bear') ? feats(B, side) : feats(B, 'bull');

      // cover work on this position: give-up decisions, cover rejections, halted sends
      const rwDec = ev.filter(e => e.type === 'resting_work' || e.type === 'candle_close').flatMap(e => (e.decisions || []).filter(d => d.positionId === p.id).map(d => ({ ...d, t: Date.parse(e.time) })));
      const gu = rwDec.filter(d => d.action === 'cover-giveup');
      const nGiveup = gu.length, firstGiveupAt = gu.length ? gu[0].t : null, firstGiveupET = gu.length ? et(gu[0].t).hm : '', giveupThrough = gu.length ? gu[0].through : null;
      // the give-up decisions carry the cover's live mark (debit-equivalent) and the limit sent: what a give-up that
      // paid the MARK would have locked (DERIVED from the real marks; the fills on wide 0DTE quotes often beat the mark)
      const guMark0 = gu.length ? gu[0].mark : null, guTo0 = gu.length ? gu[0].to : null;
      const guMarkLast = gu.length ? gu[gu.length - 1].mark : null, guMarkMax = gu.length ? Math.max(...gu.map(d => d.mark).filter(x => x != null)) : null;
      const coverRejects = ev.filter(e => e.type === 'order_dead' && e.positionId === p.id && e.status === 'rejected' && /^cover/.test(e.kind || ''));
      const rejWhy = [...new Set(coverRejects.map(e => /buying power/i.test(e.reason || '') ? 'funds' : /opening transaction/i.test(e.reason || '') ? 'not-opening' : /replace/i.test(e.reason || '') ? 'replace' : 'other'))].join('+');
      const haltedCovers = ev.filter(e => e.type === 'order_control_blocked' && e.meta && e.meta.of === p.id).length;
      const proxyAtFill = filled && fillAt && (side === 'bull' || side === 'bear') ? Object.fromEntries(PROXY_FAVS.map(F => [F, proxyOutcome(N1, side, fillAt, F, giveUpPts || 20)])) : null;
      const proxyAtPlace = !filled && kind === 'open' ? Object.fromEntries(PROXY_FAVS.map(F => [F, proxyOutcome(N1, side, B, F, giveUpPts || 20)])) : null;

      // classification
      let cls;
      if (kind !== 'open') cls = 'HEDGE';
      else if (!filled) cls = 'UNFILLED';
      else if (p.covered) {
        if (coverClass === 'give-up') cls = 'DIDNT';
        else if (lockFloor != null && lockFloor < 0) cls = 'DIDNT';
        else if (coverClass === 'stall') cls = 'MARGINAL';
        else if (minsToCover != null && minsToCover > 45) cls = 'MARGINAL';
        else cls = 'WORKED';
      } else cls = pnl != null && pnl > 0 ? 'WORKED' : 'DIDNT';
      const why = kind !== 'open' ? '' : !filled ? unfilled : p.covered
        ? (coverClass === 'give-up' ? 'give-up cover' : lockFloor < 0 ? 'covered at a loss' : coverClass === 'stall' ? 'stall cover' : minsToCover > 45 ? `slow cover (${minsToCover}m)` : 'covered')
        : (pnl > 0 ? 'expired in profit' : 'uncovered at close, losing');

      positions.push({ date: D, sim, id: p.id, kind, cls, why, placedET: et(placed).hm, B, fillET: fillAt ? et(fillAt).hm : '', side, legs: legStr(p.legs), shortK,
        reason, fallback, funds, sentNet: p.sentNet || '', fillPx, fillSide, fillFrom, openDE, unfilled, fillUnder: r2(fillUnder), itmPts,
        covered: !!p.covered, coverET: coverAt ? et(coverAt).hm : '', minsToCover, coverClass, coverKind, coverPx, coverSide, coverGeo, coverLegs: legStr(p.coverLegs),
        pnl, lockFloor, lockMax, mfe: exc ? exc.fav : null, mae: exc ? exc.adv : null, post60Fav: post ? post.fav60 : null, post60Adv: post ? post.adv60 : null,
        eodMoveSide, giveUpPts, f, fillAt, coverAt, placedUnder: r2(placedUnder), nGiveup, firstGiveupAt, firstGiveupET, guMark0, guTo0, guMarkLast, guMarkMax, giveupThrough, nCoverRejects: coverRejects.length, rejWhy, haltedCovers, proxyAtFill, proxyAtPlace });
    }

    const cfgChanges = [];
    if (prevCfg) for (const k of new Set([...Object.keys(cfg), ...Object.keys(prevCfg)])) {
      if (k === 'expiration') continue;
      if (JSON.stringify(cfg[k]) !== JSON.stringify(prevCfg[k])) cfgChanges.push(`${k} ${JSON.stringify(prevCfg[k])}->${JSON.stringify(cfg[k])}`);
    }
    prevCfg = cfg;
    const eodSum = eod ? { terminal: eod.terminalPnl, floor: eod.floorPnl } : {};
    const ndxClose = settle;
    let hi = -Infinity, lo = Infinity; for (const b of N1) { hi = Math.max(hi, b.high); lo = Math.min(lo, b.low); }
    dayRows.push({ date: D, sim, terminal: eodSum.terminal, floor: eodSum.floor, ndxOpen: r1(ndxOpen), ndxClose: r1(ndxClose), dayMove: r1(ndxClose - ndxOpen), range: r1(hi - lo),
      haltFirst: (() => { const t = [...halts.map(e => Date.parse(e.time)), ...cc.filter(e => (e.decisions || []).some(d => d.action === 'open-skip-control')).map(e => Date.parse(e.time))]; return t.length ? et(Math.min(...t)).hm : ''; })(),
      haltLast: (() => { const t = [...halts.map(e => Date.parse(e.time)), ...cc.filter(e => (e.decisions || []).some(d => d.action === 'open-skip-control')).map(e => Date.parse(e.time))]; return t.length ? et(Math.max(...t)).hm : ''; })(),
      haltedCoverSends: halts.filter(e => /^cover/.test(e.kind || '')).length, haltN: halts.length, giveUpPts, lossTarget: cfg.lossTarget, lossMax: cfg.lossMax,
      cfgChanges, coverGeometry: cfg.coverGeometry || 'tent', floorRaise: !!cfg.floorRaise, dailyPctBOpen: (() => { const f0 = feats(Date.parse(`${D}T13:30:00Z`), 'bull'); return f0.dailyPctB; })() });

    // trace check: our /NQ bars vs the engine's own signal-trace inputs (10/13+)
    for (const e of cc) {
      const ins = e.signal && e.signal.trace && e.signal.trace.inputs; if (!ins || !ins.c15) continue;
      const B = Math.floor(Date.parse(e.time) / M5) * M5;
      const i = lastCompletedIdx(NQ[15], M15, B); const c = NQ[15][i];
      traceChecks.push(Math.abs(c.close - ins.c15.close) < 0.01 && Math.abs(c.bbMiddle - ins.c15.mid) < 0.02 && Math.abs(c.ema9 - ins.c15.ema) < 0.02);
    }
  }

  // ---------------------------------------------------------------- classification extras
  const real = positions.filter(p => !p.sim);
  const opensF = real.filter(p => p.kind === 'open' && p.covered !== undefined && p.cls !== 'UNFILLED');
  // PROXY calibration: the favourable-points threshold whose 'W' best agrees with the REAL outcome of the filled
  // live opens (WORKED/MARGINAL = good, DIDNT = bad), measured from the fill. Adverse = that day's give-up points.
  const calib = PROXY_FAVS.map(F => {
    let agree = 0, n = 0; for (const p of opensF) { const pr = p.proxyAtFill && p.proxyAtFill[F]; if (!pr) continue; n++; if ((pr === 'W') === (p.cls !== 'DIDNT')) agree++; }
    return { F, agree, n };
  });
  const best = calib.reduce((a, b) => b.agree > a.agree ? b : a);
  const FAV = best.F;
  for (const s of signals) s.proxy = s.proxyBy[FAV];
  const byDay = {}; for (const p of positions) (byDay[p.date] = byDay[p.date] || []).push(p);
  for (const p of positions) {
    if (p.kind !== 'open') continue;
    p.proxy = p.proxyAtFill ? p.proxyAtFill[FAV] : p.proxyAtPlace ? p.proxyAtPlace[FAV] : null;
    // stacking: same-side live opens already filled and still uncovered when this one was placed
    const t = p.B + 30000;
    const N1 = ndx1m(p.date) || [];
    let px = null; for (const b of N1) { if (b.datetime + 60000 <= t) px = b.close; else break; }
    const held = byDay[p.date].filter(q => q !== p && q.kind === 'open' && q.fillAt && q.fillAt < t && (!q.coverAt || q.coverAt > t));
    const same = held.filter(q => q.side === p.side), opp = held.filter(q => q.side !== p.side);
    p.heldSame = same.length; p.heldOpp = opp.length;
    // same side already failed today: a give-up was triggered on a same-side open before this one was placed
    p.priorSameGiveups = byDay[p.date].filter(q => q !== p && q.kind === 'open' && q.side === p.side && q.firstGiveupAt && q.firstGiveupAt < t).length;
    p.heldSameUnder = same.filter(q => px != null && q.fillUnder != null && (q.side === 'bull' ? px - q.fillUnder : q.fillUnder - px) < 0).length;
    if (p.cls === 'UNFILLED' || p.sim) continue;
    // covered too early: normal cover inside 15 min at a small lock while price then ran >= 30 pts our way within 60 min
    p.tooEarly = p.covered && p.coverClass === 'normal' && p.minsToCover != null && p.minsToCover <= 15 && p.lockFloor != null && p.lockFloor <= 60 && p.post60Fav != null && p.post60Fav >= 30;
    p.waitBetter = '';
    // the same-side open 1-3 five-minute bars later (PROXY); kept for every filled open so the DIDNT rate has a baseline
    p.waitSeq = [0, 1, 2, 3].map(k => proxyOutcome(N1, p.side, p.B + k * M5, FAV, p.giveUpPts || 20) || '?').join('');
    if (p.cls === 'DIDNT') p.waitBetter = p.waitSeq.slice(1);
  }

  // ---------------------------------------------------------------- CSV
  const cols = [
    ['date', p => p.date], ['mode', p => p.sim ? 'SIM' : 'LIVE'], ['id', p => p.id], ['kind', p => p.kind], ['class', p => p.cls], ['why', p => p.why],
    ['placed_et', p => p.placedET], ['fill_et', p => p.fillET], ['side', p => p.side], ['legs', p => p.legs], ['short_k', p => p.shortK],
    ['rule', p => p.reason], ['fallback', p => p.fallback ? 1 : 0], ['funds_style', p => p.funds ? 1 : 0], ['sent_net', p => p.sentNet],
    ['fill_px_real', p => p.fillPx], ['fill_side', p => p.fillSide], ['fill_from', p => p.fillFrom], ['open_debit_eq_DERIVED', p => p.openDE], ['unfilled', p => p.unfilled],
    ['ndx_at_fill', p => p.fillUnder], ['short_itm_pts', p => p.itmPts], ['covered', p => p.covered ? 1 : 0], ['cover_et', p => p.coverET], ['mins_to_cover', p => p.minsToCover],
    ['cover_class', p => p.coverClass], ['cover_kind', p => p.coverKind], ['cover_px_real', p => p.coverPx], ['cover_side', p => p.coverSide], ['cover_geo', p => p.coverGeo], ['cover_legs', p => p.coverLegs],
    ['pnl_eod_real', p => p.pnl], ['lock_floor_DERIVED', p => p.lockFloor], ['lock_max_DERIVED', p => p.lockMax],
    ['mfe_pts', p => p.mfe], ['mae_pts', p => p.mae], ['post_cover_60m_fav_pts', p => p.post60Fav], ['eod_move_side_pts', p => p.eodMoveSide],
    ['covered_too_early', p => p.tooEarly ? 1 : 0], ['wait_1_3_bars_PROXY', p => p.waitBetter || ''], ['proxy_outcome_PROXY', p => p.proxy || ''],
    ['n_giveup_decisions', p => p.nGiveup], ['first_giveup_et', p => p.firstGiveupET], ['cover_rejects', p => p.nCoverRejects], ['cover_reject_why', p => p.rejWhy], ['halted_sends', p => p.haltedCovers],
    ['prior_same_side_giveups', p => p.priorSameGiveups], ['held_same_uncovered', p => p.heldSame], ['held_same_underwater', p => p.heldSameUnder], ['held_opp_uncovered', p => p.heldOpp],
    ['tod_min', p => p.f.tod], ['day_move_side', p => p.f.dayMoveSide], ['daily_pctB', p => p.f.dailyPctB], ['trendA', p => p.f.trendA], ['trendA_rel', p => p.f.trendARel], ['hourly_col_rel', p => p.f.hcRel], ['forming_hour', p => p.f.hf],
  ];
  for (const tf of ['5', '15', '60']) {
    const k = 's' + tf;
    cols.push([`${tf}m_trend_rel`, p => p.f[k] && p.f[k].rel], [`${tf}m_pctB`, p => p.f[k] && p.f[k].pctB], [`${tf}m_pctB_side`, p => p.f[k] && p.f[k].pctBSide],
      [`${tf}m_close_vs_ema`, p => p.f[k] && p.f[k].vsEma], [`${tf}m_ema_slope_side`, p => p.f[k] && p.f[k].slopeSide], [`${tf}m_bw`, p => p.f[k] && p.f[k].bw],
      [`${tf}m_room_side_pts`, p => p.f[k] && p.f[k].roomSide], [`${tf}m_last3_cols`, p => p.f[k] && p.f[k].cols], [`${tf}m_last3_side`, p => p.f[k] && p.f[k].seqSide], [`${tf}m_hhll`, p => p.f[k] && p.f[k].hhllSide]);
  }
  const esc = v => v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  fs.writeFileSync(path.join(OUT, 'positions.csv'), [cols.map(c => c[0]).join(','), ...positions.map(p => cols.map(c => esc(c[1](p))).join(','))].join('\n') + '\n');
  const scols = [['date', s => s.date], ['mode', s => s.sim ? 'SIM' : 'LIVE'], ['et', s => s.et], ['side', s => s.side], ['rule', s => s.reason], ['acted', s => s.acted],
    ['proxy_PROXY', s => s.proxy], ['fav60', s => s.exc60 && s.exc60.fav], ['adv60', s => s.exc60 && s.exc60.adv],
    ['trendA_rel', s => s.f.trendARel], ['5m_rel', s => s.f.s5 && s.f.s5.rel], ['15m_rel', s => s.f.s15 && s.f.s15.rel], ['60m_rel', s => s.f.s60 && s.f.s60.rel],
    ['60m_pctB_side', s => s.f.s60 && s.f.s60.pctBSide], ['15m_pctB_side', s => s.f.s15 && s.f.s15.pctBSide], ['5m_pctB_side', s => s.f.s5 && s.f.s5.pctBSide], ['daily_pctB', s => s.f.dailyPctB], ['tod', s => s.f.tod]];
  fs.writeFileSync(path.join(OUT, 'signals.csv'), [scols.map(c => c[0]).join(','), ...signals.map(s => scols.map(c => esc(c[1](s))).join(','))].join('\n') + '\n');
  fs.writeFileSync(path.join(OUT, 'review.json'), JSON.stringify({ FAV, calib, traceChecks: { n: traceChecks.length, ok: traceChecks.filter(Boolean).length }, dayRows, positions, signals }, null, 1));
  console.log(`positions ${positions.length}, signals ${signals.length}, days ${days.length}; trace check ${traceChecks.filter(Boolean).length}/${traceChecks.length}; FAV=${FAV}`);
  require('./review-v7-10-report.js').report(OUT);
}

main().catch(e => { console.error(e); process.exit(1); });
