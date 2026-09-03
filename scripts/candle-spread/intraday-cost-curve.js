#!/usr/bin/env node
'use strict';
/**
 * intraday-cost-curve.js — INTRADAY COST CURVE for short-ATM vertical spreads, built from the REAL
 * captured option-chain snapshots in candle-spread-archive/*.json.
 *
 * PURPOSE (analysis + reusable calibration artifact ONLY — not wired into the engine):
 *   The backtest currently prices spreads with a single-IV Black-Scholes model (backtest-v4.js
 *   legsMark + bs-pricer). This script measures what the spreads ACTUALLY cost in the captured
 *   chains, as a FRACTION OF WIDTH, and how that fraction moves by time of day and day to day.
 *
 * GEOMETRY (short leg at ATM/center, long leg WIDTH deeper ITM — the geometry we trade):
 *   bull (call debit spread): mark = call_mid(center - WIDTH) - call_mid(center)
 *   bear (put  debit spread): mark = put_mid (center + WIDTH) - put_mid (center)
 *   fraction-of-width = mark / WIDTH, for WIDTH in {10, 20, 40}.
 *
 * DEDUPE: the chainSnapshot is the real market chain, identical across strategy variants on the
 *   same date, so we pick ONE file per trade date (the one with the most chainSnapshot candles).
 *
 * OUTPUT:
 *   - readable per-width time-of-day tables (mean frac, p25/p50/p75, range, n) to stdout
 *   - a machine-readable calibration JSON the backtest could later consume:
 *       data/intraday-cost-curve.json  (per width, per 30-min ET bucket -> {meanFrac,p25,p50,p75,n})
 *   Re-runnable: just re-run as more archive days accumulate.
 *
 * Usage: node scripts/candle-spread/intraday-cost-curve.js
 */
const fs = require('fs');
const path = require('path');

const ARCHIVE = path.join(__dirname, '..', '..', 'candle-spread-archive');
const OUT_JSON = path.join(__dirname, '..', '..', 'data', 'intraday-cost-curve.json');
const WIDTHS = [10, 20, 40];

// BS engine (for the model-vs-real comparison). Pull the exact functions the backtest uses.
const eng = require('./backtest-v4');            // eng.legsMark, eng.bs
const bs = eng.bs;                               // bs.bsPrice, bs.impliedVol, bs.tauFromTime, bs.ivFromRelBandWidth

// ---------- helpers ----------
const round = (n, k = 4) => { const p = 10 ** k; return Math.round(n * p) / p; };
function quantile(sortedAsc, q) {
  if (!sortedAsc.length) return null;
  const pos = (sortedAsc.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
}
function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }

// "MM/DD HH:MM" -> minutes past midnight ET (HH*60+MM). Returns null if unparseable.
function minutesOfDay(timeStr) {
  if (!timeStr) return null;
  const m = /(\d{1,2}):(\d{2})\s*$/.exec(timeStr);
  if (!m) return null;
  return (+m[1]) * 60 + (+m[2]);
}
// 30-min ET buckets 9:30..16:00. A candle stamped at HH:MM is bucketed by its stamp.
const BUCKETS = [];
for (let t = 9 * 60 + 30; t < 16 * 60; t += 30) BUCKETS.push(t);
function bucketLabel(t) {
  const fmt = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return `${fmt(t)}-${fmt(t + 30)}`;
}
function bucketOf(mins) {
  if (mins == null) return null;
  for (const b of BUCKETS) if (mins >= b && mins < b + 30) return b;
  if (mins >= 16 * 60) return BUCKETS[BUCKETS.length - 1]; // fold 16:00 into last bucket
  if (mins < BUCKETS[0]) return BUCKETS[0];                // pre-open fold (shouldn't happen)
  return null;
}

// ---------- load + dedupe archive ----------
function loadDedupedDays() {
  const files = fs.readdirSync(ARCHIVE).filter(f => f.endsWith('.json'));
  const byDate = new Map();
  for (const f of files) {
    let d; try { d = JSON.parse(fs.readFileSync(path.join(ARCHIVE, f), 'utf8')); } catch { continue; }
    const evs = d.events || [];
    const ccs = evs.filter(e => e.type === 'candle_close' && e.chainSnapshot && Array.isArray(e.chainSnapshot.strikes) && e.chainSnapshot.strikes.length);
    if (!ccs.length) continue;
    const date = d.tradeDate || f.slice(4, 14);
    const prev = byDate.get(date);
    if (!prev || ccs.length > prev.n) byDate.set(date, { file: f, n: ccs.length, ccs, date });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// mid lookups from a snapshot
function strikeMap(cs) { const m = new Map(); for (const s of cs.strikes) m.set(s.strike, s); return m; }
function callMid(m, k) { const s = m.get(k); return s && s.call && s.call.mid > 0 ? s.call.mid : null; }
function putMid(m, k) { const s = m.get(k); return s && s.put && s.put.mid > 0 ? s.put.mid : null; }

// ---------- per-candle spread marks ----------
// Returns { bull:{width->frac}, bear:{width->frac}, undMinusCenter, atmStraddle, atmIV, mins }
function candleMarks(cc) {
  const cs = cc.chainSnapshot;
  const m = strikeMap(cs);
  const center = cs.center, under = cs.underlying;
  const timeStr = (cc.candle && (cc.candle.timeEST || cc.candle.time)) || cc.time;
  const mins = minutesOfDay(timeStr);
  const out = { bull: {}, bear: {}, undMinusCenter: under - center, mins, timeStr };

  for (const w of WIDTHS) {
    const cLong = callMid(m, center - w), cShort = callMid(m, center);
    out.bull[w] = (cLong != null && cShort != null) ? (cLong - cShort) / w : null;
    const pLong = putMid(m, center + w), pShort = putMid(m, center);
    out.bear[w] = (pLong != null && pShort != null) ? (pLong - pShort) / w : null;
  }

  // vol proxy from the real chain: ATM straddle + backed-out ATM IV (call at center)
  const cAtm = callMid(m, center), pAtm = putMid(m, center);
  out.atmStraddle = (cAtm != null && pAtm != null) ? cAtm + pAtm : null;
  // back out IV from the ATM call using the SAME tau model the backtest uses.
  // tauFromTime needs epoch ms; reconstruct from the ET stamp + tradeDate.
  out.atmCallMid = cAtm; out.center = center; out.under = under;
  return out;
}

// tau (years to 16:00 ET) from a "MM/DD HH:MM" stamp + ISO trade date. Mirrors bs.tauFromTime.
const YEAR_MS = 365 * 24 * 3600 * 1000;
function tauFromStamp(dateISO, mins) {
  if (mins == null) return null;
  return Math.max(0, (16 * 60 - mins) / (365 * 24 * 60));
}

// ---------- main ----------
function main() {
  const days = loadDedupedDays();
  console.log(`\nINTRADAY COST CURVE — real captured chains, ${days.length} deduped trade dates\n`);
  console.log('DATE         file                                        candles');
  for (const d of days) console.log(`${d.date}   ${d.file.padEnd(44)}${d.n}`);

  // accumulate: samples[width][bucket] = [frac,...]  (bull+bear pooled), plus separate bull/bear
  const samples = {}, samplesSide = {};
  for (const w of WIDTHS) { samples[w] = {}; samplesSide[w] = { bull: {}, bear: {} }; for (const b of BUCKETS) { samples[w][b] = []; samplesSide[w].bull[b] = []; samplesSide[w].bear[b] = []; } }

  // per-day aggregates for day-to-day variation + vol correlation
  const perDay = [];
  // moneyness relationship rows: {w, side, undMinusCenter, frac}
  const moneyRows = [];

  for (const d of days) {
    const dayFrac = { 10: [], 20: [], 40: [] };
    const straddles = [];
    let op, hi = -Infinity, lo = Infinity; // realized range from candle high/low
    let openStraddle = null, openMins = Infinity;
    for (const cc of d.ccs) {
      const r = candleMarks(cc);
      const b = bucketOf(r.mins);
      if (b == null) continue;
      for (const w of WIDTHS) {
        for (const side of ['bull', 'bear']) {
          const fr = r[side][w];
          if (fr == null) continue;
          samples[w][b].push(fr);
          samplesSide[w][side][b].push(fr);
          dayFrac[w].push(fr);
          moneyRows.push({ w, side, x: r.undMinusCenter, frac: fr });
        }
      }
      if (r.atmStraddle != null) {
        straddles.push(r.atmStraddle);
        if (r.mins < openMins) { openMins = r.mins; openStraddle = r.atmStraddle; }
      }
      const cd = cc.candle;
      if (cd) { hi = Math.max(hi, cd.high); lo = Math.min(lo, cd.low); }
    }
    // day realized range as % of price
    const anyUnder = d.ccs.find(cc => cc.chainSnapshot).chainSnapshot.underlying;
    const rangePct = (isFinite(hi) && isFinite(lo)) ? (hi - lo) / anyUnder * 100 : null;
    perDay.push({
      date: d.date, n: d.n,
      meanFrac: { 10: mean(dayFrac[10]), 20: mean(dayFrac[20]), 40: mean(dayFrac[40]) },
      openStraddle, meanStraddle: mean(straddles), rangePct,
      straddlePctOpen: openStraddle != null ? openStraddle / anyUnder * 100 : null,
    });
  }

  // ---------- print per-width time-of-day tables ----------
  const calib = { generatedAt: new Date().toISOString(), source: 'candle-spread-archive (deduped by date)', dates: days.map(d => d.date), widths: {} };
  for (const w of WIDTHS) {
    console.log(`\n\n================ WIDTH ${w}  (long leg ${w / 10} strike(s) deeper ITM) ================`);
    console.log('bucket        n    meanFrac   mean$    p25    p50    p75    min    max   | bull  bear');
    console.log('-'.repeat(92));
    calib.widths[w] = { byBucket: {} };
    for (const b of BUCKETS) {
      const arr = samples[w][b].slice().sort((a, z) => a - z);
      const bull = mean(samplesSide[w].bull[b]), bear = mean(samplesSide[w].bear[b]);
      const lbl = bucketLabel(b);
      if (!arr.length) { console.log(`${lbl.padEnd(13)} 0    —`); calib.widths[w].byBucket[lbl] = { n: 0 }; continue; }
      const mn = mean(arr), p25 = quantile(arr, .25), p50 = quantile(arr, .5), p75 = quantile(arr, .75);
      console.log(
        `${lbl.padEnd(13)} ${String(arr.length).padEnd(4)} ` +
        `${mn.toFixed(3).padStart(6)}   ${('$' + (mn * w).toFixed(2)).padStart(6)}  ` +
        `${p25.toFixed(3)}  ${p50.toFixed(3)}  ${p75.toFixed(3)}  ${arr[0].toFixed(3)}  ${arr[arr.length - 1].toFixed(3)}  | ` +
        `${bull != null ? bull.toFixed(3) : ' — '}  ${bear != null ? bear.toFixed(3) : ' — '}`
      );
      calib.widths[w].byBucket[lbl] = {
        n: arr.length, meanFrac: round(mn), meanDollar: round(mn * w, 2),
        p25: round(p25), p50: round(p50), p75: round(p75), min: round(arr[0]), max: round(arr[arr.length - 1]),
        bullFrac: bull != null ? round(bull) : null, bearFrac: bear != null ? round(bear) : null,
      };
    }
    // width-level all-day summary
    const all = BUCKETS.flatMap(b => samples[w][b]).sort((a, z) => a - z);
    calib.widths[w].allDay = all.length ? { n: all.length, meanFrac: round(mean(all)), p25: round(quantile(all, .25)), p50: round(quantile(all, .5)), p75: round(quantile(all, .75)) } : { n: 0 };
  }

  // ---------- open vs midday vs late drift ----------
  console.log(`\n\n================ INTRADAY DRIFT (open vs midday vs close) ================`);
  const grp = (lo, hiExcl) => BUCKETS.filter(b => b >= lo && b < hiExcl);
  const zones = { 'open 9:30-10:00': grp(9 * 60 + 30, 10 * 60), 'midday 12:00-13:00': grp(12 * 60, 13 * 60), 'late 14:30-16:00': grp(14 * 60 + 30, 16 * 60) };
  console.log('width   ' + Object.keys(zones).map(z => z.padEnd(20)).join('') + 'drift(open→late)');
  calib.drift = {};
  for (const w of WIDTHS) {
    const zmeans = {};
    for (const [zname, bs2] of Object.entries(zones)) { const arr = bs2.flatMap(b => samples[w][b]); zmeans[zname] = mean(arr); }
    const openF = zmeans['open 9:30-10:00'], lateF = zmeans['late 14:30-16:00'];
    const drift = (openF != null && lateF != null) ? lateF - openF : null;
    console.log(
      `$${String(w).padEnd(5)} ` +
      Object.keys(zones).map(z => (zmeans[z] != null ? `${zmeans[z].toFixed(3)} ($${(zmeans[z] * w).toFixed(1)})` : '—').padEnd(20)).join('') +
      (drift != null ? `${drift >= 0 ? '+' : ''}${drift.toFixed(3)} (${drift >= 0 ? '+' : ''}$${(drift * w).toFixed(1)})` : '—')
    );
    calib.drift[w] = { openFrac: openF != null ? round(openF) : null, middayFrac: zmeans['midday 12:00-13:00'] != null ? round(zmeans['midday 12:00-13:00']) : null, lateFrac: lateF != null ? round(lateF) : null, driftFrac: drift != null ? round(drift) : null };
  }

  // ---------- day-to-day variation + vol correlation ----------
  console.log(`\n\n================ DAY-TO-DAY VARIATION & VOL PROXY ================`);
  console.log('date         n   meanFrac(10/20/40)         ATMstrad(open)  strad%px  realizedRange%');
  for (const d of perDay) {
    console.log(
      `${d.date}  ${String(d.n).padEnd(3)} ` +
      `${fmtF(d.meanFrac[10])}/${fmtF(d.meanFrac[20])}/${fmtF(d.meanFrac[40])}      ` +
      `${d.openStraddle != null ? d.openStraddle.toFixed(1).padStart(7) : '   —  '}      ` +
      `${d.straddlePctOpen != null ? d.straddlePctOpen.toFixed(3) : '  — '}    ` +
      `${d.rangePct != null ? d.rangePct.toFixed(3) : '  — '}`
    );
  }
  // cross-day correlation: day mean frac (per width) vs vol proxies
  console.log('\ncross-day correlation of day-mean fraction vs vol proxies (Pearson r, n days):');
  const withVol = perDay.filter(d => d.straddlePctOpen != null && d.rangePct != null);
  for (const w of WIDTHS) {
    const rows = withVol.filter(d => d.meanFrac[w] != null);
    const fr = rows.map(d => d.meanFrac[w]);
    const rStrad = pearson(fr, rows.map(d => d.straddlePctOpen));
    const rRange = pearson(fr, rows.map(d => d.rangePct));
    const spread = fr.length ? (Math.max(...fr) - Math.min(...fr)) : null;
    console.log(`  width ${String(w).padEnd(3)}: r(vs open-straddle%)=${fmtR(rStrad)}  r(vs realizedRange%)=${fmtR(rRange)}   day-mean spread=${spread != null ? spread.toFixed(3) : '—'} (min ${Math.min(...fr).toFixed(3)} .. max ${Math.max(...fr).toFixed(3)}) n=${fr.length}`);
  }
  calib.perDay = perDay.map(d => ({ date: d.date, n: d.n, meanFrac: { 10: r4(d.meanFrac[10]), 20: r4(d.meanFrac[20]), 40: r4(d.meanFrac[40]) }, openStraddle: r2(d.openStraddle), straddlePctOpen: r4(d.straddlePctOpen), realizedRangePct: r4(d.rangePct) }));

  // ---------- moneyness relationship ----------
  console.log(`\n\n================ MONEYNESS (underlying - center, pts) vs fraction ================`);
  console.log('(short leg is nominally ATM=center; underlying floats 0..10 pts above center → call-short slightly ITM, put-short slightly OTM)');
  console.log('width  side   slope(Δfrac / +1pt und-center)   r      n');
  calib.moneyness = {};
  for (const w of WIDTHS) {
    for (const side of ['bull', 'bear']) {
      const rows = moneyRows.filter(m => m.w === w && m.side === side);
      const xs = rows.map(m => m.x), ys = rows.map(m => m.frac);
      const { slope, r } = linreg(xs, ys);
      console.log(`$${String(w).padEnd(4)} ${side.padEnd(5)}  ${slope != null ? (slope >= 0 ? '+' : '') + slope.toFixed(5) : '—'}                          ${fmtR(r)}   ${rows.length}`);
      calib.moneyness[`${w}_${side}`] = { slope: r5(slope), r: r4(r), n: rows.length };
    }
  }

  // ---------- BS model comparison ----------
  bsComparison(days, calib);

  // ---------- write calibration ----------
  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, JSON.stringify(calib, null, 2));
  console.log(`\n\nWrote calibration -> ${path.relative(path.join(__dirname, '..', '..'), OUT_JSON)}`);
  console.log(`(per-width per-30min-bucket {meanFrac,p25,p50,p75,n}; drift; perDay; moneyness; bsCompare)\n`);
}

// Compare the REAL fraction-of-width to the backtest's flat-IV BS model.
// For each day we back out a single ATM IV at the FIRST candle (from the real ATM call), hold it
// FLAT all day (as the band-width model effectively does — one IV per day), and reprice the SAME
// short-ATM spread via BS with tauFromStamp decaying to 16:00. Then compare fraction curves.
function bsComparison(days, calib) {
  console.log(`\n\n================ REAL vs FLAT-IV BLACK-SCHOLES (backtest model) ================`);
  console.log('Method: back out ATM IV from the real chain at each day\'s OPEN, hold flat, reprice the');
  console.log('same short-ATM spread with BS (tau→16:00). This mirrors the backtest\'s one-IV-per-day model.\n');
  const W = 20; // representative width the live engine trades
  console.log(`width $${W}:  bucket        realFrac   bsFrac(flatIV)   diff(real-bs)   n`);
  console.log('-'.repeat(72));
  // accumulate per bucket
  const acc = {}; for (const b of BUCKETS) acc[b] = { real: [], bs: [] };
  const dayIV = [];
  for (const d of days) {
    // open IV: first candle with an ATM call, solve BS impliedVol
    let iv = null, ivDate = d.date;
    for (const cc of d.ccs) {
      const r = candleMarks(cc);
      if (r.atmCallMid != null && r.mins != null) {
        const tau = tauFromStamp(d.date, r.mins);
        const solved = bs.impliedVol('C', r.under, r.center, tau, r.atmCallMid);
        if (solved) { iv = solved; break; }
      }
    }
    if (iv == null) continue;
    dayIV.push({ date: d.date, iv });
    for (const cc of d.ccs) {
      const r = candleMarks(cc);
      const b = bucketOf(r.mins);
      if (b == null || r.mins == null) continue;
      const tau = tauFromStamp(d.date, r.mins);
      // BS spread mark with flat day IV, SAME geometry (bull call debit)
      const bsMark = bs.bsPrice('C', r.under, r.center - W, tau, iv) - bs.bsPrice('C', r.under, r.center, tau, iv);
      if (r.bull[W] != null) { acc[b].real.push(r.bull[W]); acc[b].bs.push(bsMark / W); }
    }
  }
  calib.bsCompare = { width: W, dayOpenIV: dayIV.map(d => ({ date: d.date, iv: r4(d.iv) })), byBucket: {} };
  for (const b of BUCKETS) {
    const real = mean(acc[b].real), bsF = mean(acc[b].bs), n = acc[b].real.length;
    const lbl = bucketLabel(b);
    if (!n) { console.log(`           ${lbl.padEnd(13)} —`); continue; }
    const diff = real - bsF;
    console.log(`           ${lbl.padEnd(13)} ${real.toFixed(3)}      ${bsF.toFixed(3)}          ${diff >= 0 ? '+' : ''}${diff.toFixed(3)}       ${n}`);
    calib.bsCompare.byBucket[lbl] = { realFrac: r4(real), bsFrac: r4(bsF), diff: r4(diff), n };
  }
  console.log(`\nBacked-out open ATM IVs by day: ${dayIV.map(d => d.date.slice(5) + '=' + (d.iv * 100).toFixed(0) + '%').join('  ')}`);
}

// ---------- stats helpers ----------
function pearson(a, b) {
  const n = a.length; if (n < 2) return null;
  const ma = mean(a), mb = mean(b); let sa = 0, sb = 0, sab = 0;
  for (let i = 0; i < n; i++) { const da = a[i] - ma, db = b[i] - mb; sa += da * da; sb += db * db; sab += da * db; }
  if (sa === 0 || sb === 0) return null;
  return sab / Math.sqrt(sa * sb);
}
function linreg(xs, ys) {
  const n = xs.length; if (n < 2) return { slope: null, r: null };
  const mx = mean(xs), my = mean(ys); let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); }
  const slope = sxx === 0 ? null : sxy / sxx;
  return { slope, r: pearson(xs, ys) };
}
const fmtF = v => v != null ? v.toFixed(3) : '  —  ';
const fmtR = v => v != null ? (v >= 0 ? '+' : '') + v.toFixed(2) : ' — ';
const r2 = v => v != null ? Math.round(v * 100) / 100 : null;
const r4 = v => v != null ? Math.round(v * 1e4) / 1e4 : null;
const r5 = v => v != null ? Math.round(v * 1e5) / 1e5 : null;

if (require.main === module) main();
module.exports = { loadDedupedDays, candleMarks, bucketOf, BUCKETS };
