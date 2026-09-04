#!/usr/bin/env node
'use strict';
/**
 * calibrate-intraday-iv.js — INTRADAY-IV CORRECTION for the candle-spread backtest, calibrated from
 * the REAL captured option chains in candle-spread-archive/*.json.
 *
 * GOAL: the backtest prices every leg (opens, covers, settlement) with a single per-bar IV via BS
 *   (backtest-v6-5m runDay5m: iv = bs.ivFromRelBandWidth(15m rel band width)). That band-IV captures
 *   per-DAY vol but is suspected to miss the intraday TERM-STRUCTURE of real marks. This script measures
 *   the real intraday vol behaviour and emits a time-of-day IV MULTIPLIER the engine can splice in:
 *       iv_corrected(bar) = iv_bandIV(bar) * ivMult(timeOfDay)
 *   so BS then reprices ALL moneyness (opens + covers + settlement) consistently off one corrected IV.
 *
 * WHY NOT THE LITERAL SHORT-ATM-VERTICAL INVERSION (m = IV_real_spread / IV_bt):
 *   The geometry we trade (long leg WIDTH deeper ITM, short leg ATM) is a LOW-VEGA vertical — its BS
 *   mark barely moves with IV, so inverting a single flat IV from the spread mark is ill-conditioned:
 *   per-sample IV_real swings 0.3x..8x band-IV and even the cross-day per-bucket MEDIAN blows to ~4.5x
 *   at 11:30 (see `verticalImpliedMedian` below). It is NOT a stable time-of-day shape and cannot be
 *   shipped. Fundamentally, a SINGLE IV cannot reproduce both the ATM vol level AND the ATM-vs-ITM
 *   vertical richness — that gap is SKEW, which a single-IV model cannot carry (deferred, per spec).
 *
 * WHAT WE SHIP INSTEAD (the well-identified single-IV correction):
 *   ivMult(t) = median_over_days[ ATM_impliedVol_real(t) / bandIV(day) ]
 *   The ATM option is HIGH-vega, so its implied vol is well-identified. This is a genuine vol-surface
 *   time-of-day correction that flows consistently through BS to every leg. It re-levels band-IV (which
 *   the data shows runs ~30% below real ATM IV at the open) and adds the real intraday ATM-IV drift.
 *
 * ROBUSTNESS: per bucket we take the MEDIAN across DAYS of each day's median (resists open-auction
 *   stale prints and the low-tau near-expiry noise the prior subagent flagged). bandIV(day) comes from
 *   the captured OPENING 15m band (upper/lower/middle); the 15m BB(20) is a ~5h-window statistic so it
 *   is ~constant intraday — held flat per day is a faithful proxy of runDay5m's per-bar recompute and
 *   is the exact ivFromRelBandWidth quantity the engine feeds. For a day whose archive lacks a captured
 *   band (the 5m-cadence 09-02 run), bandIV is imputed as median(bandIV/openATM)*openATM(day) — a pure
 *   intraday SHAPE contribution (documented in meta.imputedBandIVDates).
 *
 * OUTPUT: data/intraday-iv-correction.json { perBucket:{"09:30":mult,...}, meta:{...} }
 * Usage:  node scripts/candle-spread/calibrate-intraday-iv.js
 */
const fs = require('fs');
const path = require('path');
const cc = require('./intraday-cost-curve');            // loadDedupedDays, candleMarks, bucketOf, BUCKETS
const bs = require('../../server/src/candle-spread/bs-pricer');

const OUT_JSON = path.join(__dirname, '..', '..', 'data', 'intraday-iv-correction.json');
const WIDTHS = [10, 20, 40];
const BUCKETS = cc.BUCKETS;                              // 30-min ET bucket START minutes 9:30..15:30
const bucketKey = t => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;

// tau (years to 16:00 ET) from minutes-past-midnight ET — mirrors bs.tauFromTime for a "MM/DD HH:MM" stamp.
const tauFromMins = mins => Math.max(0, (16 * 60 - mins) / (365 * 24 * 60));
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
const r4 = v => v != null ? Math.round(v * 1e4) / 1e4 : null;

// per-day band-IV from the captured OPENING 15m band (the only reliably-captured band in the archive).
function capturedBandIV(day) {
  const be = day.ccs.find(e => e.bands && e.bands.upper != null);
  if (!be) return null;
  const close = be.bands.middle || (be.candle && be.candle.close);
  if (!close) return null;
  return bs.ivFromRelBandWidth((be.bands.upper - be.bands.lower) / close);
}
// well-identified ATM implied vol at a snapshot (ATM call is high-vega → robust invert).
function atmIV(r, tau) {
  if (r.atmCallMid == null || tau <= 0) return null;
  return bs.impliedVol('C', r.under, r.center, tau, r.atmCallMid);
}
// LOW-VEGA vertical-implied flat IV (kept only for the instability diagnostic, NOT shipped).
function verticalIV(side, W, r, tau) {
  const fr = r[side][W]; if (fr == null) return null;
  const target = fr * W;
  const legs = side === 'bull'
    ? [{ side: 'long', type: 'C', strike: r.center - W }, { side: 'short', type: 'C', strike: r.center }]
    : [{ side: 'long', type: 'P', strike: r.center + W }, { side: 'short', type: 'P', strike: r.center }];
  const mark = iv => legs.reduce((v, l) => v + (l.side === 'long' ? 1 : -1) * bs.bsPrice(l.type, r.under, l.strike, tau, iv), 0);
  let lo = 1e-4, hi = 5;                                 // spread mark is monotonic DECREASING in IV
  if (target >= mark(lo)) return lo; if (target <= mark(hi)) return hi;
  for (let i = 0; i < 80; i++) { const m = (lo + hi) / 2; (mark(m) > target) ? (lo = m) : (hi = m); }
  return (lo + hi) / 2;
}

function main() {
  const days = cc.loadDedupedDays().filter(d => d.ccs.length >= 5);   // drop 08-25 (2 candles)

  // ---- per-day open ATM IV (for band-IV imputation on band-less days) + captured band-IV ----
  const openATM = {}, capBand = {};
  for (const d of days) {
    const rows = d.ccs.map(e => cc.candleMarks(e)).filter(r => r.mins != null).sort((a, b) => a.mins - b.mins);
    const r0 = rows[0];
    openATM[d.date] = r0 ? atmIV(r0, tauFromMins(r0.mins)) : null;
    capBand[d.date] = capturedBandIV(d);
  }
  const ratios = days.map(d => (capBand[d.date] && openATM[d.date]) ? capBand[d.date] / openATM[d.date] : null).filter(x => x != null);
  const kRatio = median(ratios);                          // median bandIV/openATM across band-days
  const imputed = [];
  const bandIVfor = d => { if (capBand[d.date]) return capBand[d.date]; imputed.push(d.date); return openATM[d.date] != null ? kRatio * openATM[d.date] : null; };

  // ---- accumulate per (day,bucket): median ATM-mult, median vertical-mult (diagnostic), median mark-ratio ----
  const atmByBucket = {}, vertByBucket = {}, markByBucket = {}, nSnap = {};
  for (const b of BUCKETS) { atmByBucket[b] = []; vertByBucket[b] = []; markByBucket[b] = []; nSnap[b] = 0; }
  const perDayShape = {};                                 // date -> {bucket -> atmMult} for cross-day stability check

  for (const d of days) {
    const bIV = bandIVfor(d);
    perDayShape[d.date] = {};
    const dayAtm = {}, dayVert = {}, dayMark = {};
    for (const b of BUCKETS) { dayAtm[b] = []; dayVert[b] = []; dayMark[b] = []; }
    for (const e of d.ccs) {
      const r = cc.candleMarks(e); const b = cc.bucketOf(r.mins); if (b == null) continue;
      const tau = tauFromMins(r.mins); nSnap[b]++;
      const aiv = atmIV(r, tau);
      if (aiv != null && bIV) dayAtm[b].push(aiv / bIV);
      for (const W of WIDTHS) for (const side of ['bull', 'bear']) {
        const viv = verticalIV(side, W, r, tau);
        if (viv != null && bIV) dayVert[b].push(viv / bIV);
        const fr = r[side][W];
        if (fr != null && bIV) {
          const legs = side === 'bull'
            ? [{ side: 'long', type: 'C', strike: r.center - W }, { side: 'short', type: 'C', strike: r.center }]
            : [{ side: 'long', type: 'P', strike: r.center + W }, { side: 'short', type: 'P', strike: r.center }];
          const bsMark = legs.reduce((v, l) => v + (l.side === 'long' ? 1 : -1) * bs.bsPrice(l.type, r.under, l.strike, tau, bIV), 0);
          if (bsMark > 0.5) dayMark[b].push((fr * W) / bsMark);
        }
      }
    }
    for (const b of BUCKETS) {
      const ma = median(dayAtm[b]); if (ma != null) { atmByBucket[b].push(ma); perDayShape[d.date][b] = ma; }
      const mv = median(dayVert[b]); if (mv != null) vertByBucket[b].push(mv);
      const mr = median(dayMark[b]); if (mr != null) markByBucket[b].push(mr);
    }
  }

  // ---- the shipped curve: per-bucket MEDIAN ACROSS DAYS of ATM-mult ----
  const perBucket = {}, diag = {};
  for (const b of BUCKETS) {
    const key = bucketKey(b);
    const atmMed = median(atmByBucket[b]);
    perBucket[key] = r4(atmMed);
    diag[key] = {
      nDays: atmByBucket[b].length, nSnapshots: nSnap[b],
      atmMult: r4(atmMed),
      verticalImpliedMult: r4(median(vertByBucket[b])),
      directMarkRatio: r4(median(markByBucket[b])),
    };
  }

  // ---- CHECK (a): is the ATM-mult a stable time-of-day SHAPE across days, or does it swing w/ regime? ----
  // Normalise each day's curve by its own OPEN bucket value → pure shape; report cross-day dispersion.
  const shapeStats = {};
  for (const b of BUCKETS) {
    const key = bucketKey(b);
    const vals = [];
    for (const d of days) {
      const openB = perDayShape[d.date][BUCKETS[0]];
      const v = perDayShape[d.date][b];
      if (openB && v != null) vals.push(v / openB);      // shape relative to that day's open
    }
    if (vals.length) {
      const mu = vals.reduce((a, c) => a + c, 0) / vals.length;
      const sd = Math.sqrt(vals.reduce((a, c) => a + (c - mu) ** 2, 0) / vals.length);
      shapeStats[key] = { meanRelShape: r4(mu), stdevRelShape: r4(sd), n: vals.length };
    }
  }

  // ---- CHECK (b): width dependence — for ATM-IV there is no width dimension (ATM option only), so the
  //      curve is width-independent by construction. We still report the direct mark-ratio per width to
  //      show whether the REAL spread cost gap differs by width (informational). ----
  const markRatioByWidth = {};
  for (const W of WIDTHS) {
    const perB = {};
    for (const b of BUCKETS) perB[b] = [];
    for (const d of days) {
      const bIV = bandIVfor(d);
      for (const e of d.ccs) {
        const r = cc.candleMarks(e); const b = cc.bucketOf(r.mins); if (b == null || !bIV) continue;
        const tau = tauFromMins(r.mins);
        for (const side of ['bull', 'bear']) {
          const fr = r[side][W]; if (fr == null) continue;
          const legs = side === 'bull'
            ? [{ side: 'long', type: 'C', strike: r.center - W }, { side: 'short', type: 'C', strike: r.center }]
            : [{ side: 'long', type: 'P', strike: r.center + W }, { side: 'short', type: 'P', strike: r.center }];
          const bsMark = legs.reduce((v, l) => v + (l.side === 'long' ? 1 : -1) * bs.bsPrice(l.type, r.under, l.strike, tau, bIV), 0);
          if (bsMark > 0.5) perB[b].push((fr * W) / bsMark);
        }
      }
    }
    markRatioByWidth[W] = median(BUCKETS.flatMap(b => perB[b]));   // all-day median mark ratio at this width
  }

  const out = {
    generatedAt: new Date().toISOString(),
    method: 'ivMult(t) = median_days[ ATM_impliedVol_real(t) / bandIV(day) ]; splice: iv_corrected = bandIV(bar) * ivMult(tod)',
    perBucket,
    meta: {
      dates: days.map(d => d.date),
      nDays: days.length,
      imputedBandIVDates: [...new Set(imputed)],
      bandIVoverOpenATMratio: r4(kRatio),
      perDayBandIV: Object.fromEntries(days.map(d => [d.date, r4(bandIVfor(d))])),
      perDayOpenATM_IV: Object.fromEntries(days.map(d => [d.date, r4(openATM[d.date])])),
      bucketDiagnostics: diag,
      crossDayShapeStability: shapeStats,
      directMarkRatioByWidth: Object.fromEntries(WIDTHS.map(W => [W, r4(markRatioByWidth[W])])),
      caveats: [
        `Only ${days.length} usable captured days (08-25 dropped: 2 candles) — PROVISIONAL.`,
        'No-skew limitation: single-IV time-of-day correction calibrated on ATM vol; covers at other moneyness get the same IV mult (best single-IV approximation; moneyness skew is a later refinement).',
        'Literal short-ATM vertical inversion (m=IV_real_spread/bandIV) is ill-conditioned (low vega): per-bucket cross-day median swings 0.65..4.5 (see bucketDiagnostics.verticalImpliedMult) — NOT shipped. ATM-IV multiplier substituted as the well-identified single-IV proxy.',
        'directMarkRatio ~0.97..1.03 all day: band-IV BS already matches real spread marks within ~3%; the traded verticals + intrinsic settlement are LOW-VEGA, so the IV correction moves opens/covers only modestly.',
        'Cross-instrument: calibration is on real NDX chains (6 Aug-Sep 2026 days); baselines run on NQ 2022-2026 history. The multiplier is a dimensionless time-of-day SHAPE, not a level transfer between datasets.',
        '09-02 is a 5m-cadence run with no captured band → bandIV imputed via median(bandIV/openATM) ratio (contributes pure intraday shape).',
      ],
    },
  };

  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2) + '\n', 'utf8');

  // ---- console report ----
  console.log(`\nINTRADAY-IV CORRECTION — ${days.length} real captured days: ${days.map(d => d.date).join(', ')}`);
  console.log(`median bandIV/openATM = ${r4(kRatio)}   imputed-band days: ${[...new Set(imputed)].join(', ') || '(none)'}\n`);
  console.log('bucket   nDays nSnap  ATMmult(SHIP)  vertImplied(diag)  markRatio(diag)  relShape±sd');
  console.log('-'.repeat(88));
  for (const b of BUCKETS) {
    const key = bucketKey(b), dg = diag[key], ss = shapeStats[key];
    console.log(
      key.padEnd(8) + String(dg.nDays).padEnd(6) + String(dg.nSnapshots).padEnd(7) +
      String(dg.atmMult).padEnd(15) + String(dg.verticalImpliedMult).padEnd(19) +
      String(dg.directMarkRatio).padEnd(17) +
      (ss ? `${ss.meanRelShape}±${ss.stdevRelShape}` : '-'));
  }
  console.log('-'.repeat(88));
  console.log(`direct mark-ratio all-day by width: ${WIDTHS.map(W => `$${W}=${r4(markRatioByWidth[W])}`).join('  ')}`);
  console.log(`\nCHECK (a) shape stability: relShape stdev peaks ~${Math.max(...Object.values(shapeStats).map(s => s.stdevRelShape)).toFixed(2)} — see per-bucket ± above.`);
  console.log(`CHECK (b) width: ATM-IV mult is width-independent by construction; real mark-ratio is ~flat across widths (above).`);
  console.log(`\nwrote ${path.relative(path.join(__dirname, '..', '..'), OUT_JSON)}\n`);
}

if (require.main === module) main();
module.exports = { main };
