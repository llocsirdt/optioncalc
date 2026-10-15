#!/usr/bin/env node
'use strict';
/**
 * EMA-RIDE STUDY (analysis only — touches no engine code).
 *
 * The user's question (2026-10-14): the 15m and hourly trends were bearish all day; 15m bars kept getting
 * rejected on the UNDERSIDE of the 15m 9EMA and traded between the 9EMA (top) and the lower 15m Bollinger
 * band (bottom), with the 9EMA below the BB midline. Is this "EMA ride" a continuation/trend-day signal vs a
 * chop/reversal day? Is the mirror (bull ride) true?
 *
 * DEFINITION (pre-registered; thresholds are named constants, variants are sensitivity, NOT tuning):
 *   At checkpoint T, using only /NQ 15m bars CLOSED by T, over the last N bars (bear; bull is the mirror):
 *     1. ema9 < bbMid on every bar                                    (bull: ema9 > bbMid)
 *     2. close < ema9 on every bar                                    (bull: close > ema9)
 *     3. >= K "rejections": high >= ema9 - REJ_TOL*(ema9 - bbLower)   (bull: low <= ema9 + REJ_TOL*(bbUpper - ema9))
 *        (close < ema9 already holds by 2)
 *     4. >= 1 bar reaching the band: low <= bbLower + BAND_TOL*(ema9 - bbLower)
 *                                                                    (bull: high >= bbUpper - BAND_TOL*(bbUpper - ema9))
 *   PLAIN TREND STATE: last bar only, ema9 < bbMid && close < ema9 (bull mirror).
 *
 * SIGNAL vs PRICE: signals are ALWAYS /NQ (24h). Outcomes are cash NDX where NDX exists (2026, raw-1m),
 * and /NQ RTH as a PROXY for 2023-2025 (backtest-data-5m-nq has no NDX series). Every row carries `px_src`.
 *
 * SOURCES
 *   2023-2025: tests/backtest/backtest-data-5m-combined, NQ-only files (5m bars, END-labeled; at a label on
 *              :00/:15/:30/:45 the 15m snapshot is the bucket that just closed — verified 0/22,751 mismatches).
 *              The builder's 15m ema/BB are used directly (computed on 24h NQ from the day's 00:00).
 *   2026:      signal-lab-data/raw-1m NQ + NDX 1m (2026-07-20 .. 2026-10-14). 15m bars + indicators via the
 *              engine's signals/indicators.js (resample / withIndicators), from the day's 00:00 — the same
 *              window the dataset builder used (parity checked against the dataset on overlapping days).
 *              Close = official settle (backtest-data-5m-combined/settles.json) when present, else the last
 *              NDX 1m close (15:59 bar).
 *
 * EXPECTED MOVE (EM): per checkpoint, mean |close - P_T| over the PRIOR 20 study days of the same price
 * series (no look-ahead). Null for the first 20 days of each series.
 *
 * Usage: node scripts/candle-spread/study-ema-ride.js [--out data/sweeps/ema-ride-2026-10-14]
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const ind = require(path.join(ROOT, 'server/src/candle-spread/signals/indicators.js'));

const argv = process.argv.slice(2);
const OUT = path.resolve(ROOT, argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : 'data/sweeps/ema-ride-2026-10-14');
const DS_DIR = path.join(ROOT, 'tests/backtest/backtest-data-5m-combined');
const RAW_DIR = path.join(ROOT, 'signal-lab-data/raw-1m');

// ---- named thresholds -------------------------------------------------------------------------------
const CHECKPOINTS = ['10:30', '11:00', '11:30', '12:00'];
const BASE = { name: 'base', N: 4, K: 2, REJ_TOL: 0.15, BAND_TOL: 0.10 };
const VARIANTS = [
  BASE,
  { name: 'N3', N: 3, K: 2, REJ_TOL: 0.15, BAND_TOL: 0.10 },
  { name: 'N6', N: 6, K: 2, REJ_TOL: 0.15, BAND_TOL: 0.10 },
  { name: 'loose', N: 4, K: 1, REJ_TOL: 0.25, BAND_TOL: 0.50 },   // 1 rejection, low into the lower half
  { name: 'tight', N: 4, K: 3, REJ_TOL: 0.10, BAND_TOL: 0.00 },   // 3 rejections, low touches/pierces the band
];
const EM_LOOKBACK = 20;
const THIN = 20;

// ---- time helpers ---------------------------------------------------------------------------------
const etFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
function et(ms) {
  const p = Object.fromEntries(etFmt.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  const hh = p.hour === '24' ? '00' : p.hour;
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${hh}:${p.minute}`, min: (+hh) * 60 + (+p.minute) };
}
const hm2min = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };

let settles = {};
try { settles = JSON.parse(fs.readFileSync(path.join(DS_DIR, 'settles.json'), 'utf8')); } catch (e) { /* none */ }

// A "day" = { date, src, px_src, bars15:[{endMin,o,h,l,c,ema,mid,up,lo}], px:[{endMin,h,l,c}], close, closeSrc }
// bars15 and px are restricted to the ET calendar date; endMin = minutes after ET midnight the bar CLOSED.

// ---- 2023-2025: NQ-only dataset ------------------------------------------------------------------------
function loadDatasetNQ() {
  const byDate = new Map(); // date -> Map(endMin -> bar)
  const files = fs.readdirSync(DS_DIR).filter(f => /^backtest-NQ-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  let skippedDual = 0;
  for (const f of files) {
    const arr = JSON.parse(fs.readFileSync(path.join(DS_DIR, f), 'utf8'));
    if (arr.some(b => b && b.px)) { skippedDual++; continue; } // 2026 dual days -> taken from raw-1m instead
    for (const b of arr) {
      if (b.datetime == null || !b.analysis || !b.analysis['5m']) continue;
      const t = et(b.datetime);
      if (!byDate.has(t.date)) byDate.set(t.date, new Map());
      byDate.get(t.date).set(t.min, b);
    }
  }
  const days = [];
  let noRth = 0, halfDay = 0;
  for (const [date, m] of [...byDate.entries()].sort()) {
    const mins = [...m.keys()].sort((a, b) => a - b);
    if (!m.has(hm2min('10:30')) || !m.has(hm2min('12:00'))) { noRth++; continue; }
    if (!m.has(hm2min('16:00'))) { halfDay++; continue; } // no 16:00 NQ bar (half day / gap)
    const bars15 = [], px = [];
    for (const mn of mins) {
      const b = m.get(mn), a5 = b.analysis['5m'], a15 = b.analysis['15m'];
      if (mn % 15 === 0 && a15 && a15.ema != null && a15.bbmiddle != null) {
        bars15.push({ endMin: mn, o: a15.open, h: a15.high, l: a15.low, c: a15.close, ema: a15.ema, mid: a15.bbmiddle, up: a15.bbupper, lo: a15.bblower });
      }
      if (mn > hm2min('09:30') && mn <= hm2min('16:00')) px.push({ endMin: mn, h: a5.high, l: a5.low, c: a5.close });
    }
    const close = m.get(hm2min('16:00')).analysis['5m'].close;
    days.push({ date, src: 'ds-5m-nq', px_src: 'NQ(proxy)', bars15, px, close, closeSrc: 'NQ 16:00 5m close' });
  }
  return { days, skippedDual, noRth, halfDay };
}

// ---- 2026: raw 1m NQ (signal) + NDX (price) ----------------------------------------------------------------
function loadRaw1m(sym, date) {
  const f = path.join(RAW_DIR, `${sym}-${date}.json`);
  if (!fs.existsSync(f)) return null;
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  return (j.candles || j).filter(c => c && c.datetime != null).sort((a, b) => a.datetime - b.datetime);
}
function loadRaw2026() {
  const dates = fs.readdirSync(RAW_DIR).map(f => (f.match(/^NQ-(\d{4}-\d{2}-\d{2})\.json$/) || [])[1]).filter(Boolean).sort();
  const days = [], skipped = [];
  for (const date of dates) {
    const nq = loadRaw1m('NQ', date), ndx = loadRaw1m('NDX', date);
    if (!nq || !ndx || !ndx.length) { skipped.push(`${date}:no-NDX`); continue; }
    const nqDay = nq.filter(c => et(c.datetime).date === date);
    const b15 = ind.withIndicators(ind.resample(nqDay, 15));
    const bars15 = b15.filter(b => b.ema9 != null && b.bbMiddle != null).map(b => {
      const t = et(b.datetime); return { endMin: t.min + 15, o: b.open, h: b.high, l: b.low, c: b.close, ema: b.ema9, mid: b.bbMiddle, up: b.bbUpper, lo: b.bbLower };
    });
    const px = ndx.map(c => ({ t: et(c.datetime), c })).filter(x => x.t.date === date && x.t.min >= hm2min('09:30') && x.t.min < hm2min('16:00'))
      .map(x => ({ endMin: x.t.min + 1, h: x.c.high, l: x.c.low, c: x.c.close }));
    if (!px.length || px[px.length - 1].endMin < hm2min('15:55')) { skipped.push(`${date}:NDX-incomplete(last ${px.length ? px[px.length - 1].endMin : 'none'})`); continue; }
    const st = settles[date];
    days.push({ date, src: 'raw-1m', px_src: 'NDX', bars15, px, close: st > 0 ? st : px[px.length - 1].c, closeSrc: st > 0 ? 'official settle' : 'NDX 15:59 1m close' });
  }
  return { days, skipped };
}

// ---- detector --------------------------------------------------------------------------------------
function lastBars(day, T, N) {
  const Tm = hm2min(T);
  const closed = day.bars15.filter(b => b.endMin <= Tm);
  if (closed.length < N || closed[closed.length - 1].endMin !== Tm) return null; // need the bar ending exactly at T
  const sl = closed.slice(-N);
  for (let i = 1; i < sl.length; i++) if (sl[i].endMin - sl[i - 1].endMin !== 15) return null; // contiguous
  return sl;
}
function ride(bars, side, v) {
  if (!bars) return null;
  let rej = 0, band = 0;
  for (const b of bars) {
    if (side === 'bear') {
      if (!(b.ema < b.mid && b.c < b.ema)) return false;
      const rng = Math.max(b.ema - b.lo, 0);
      if (b.h >= b.ema - v.REJ_TOL * rng) rej++;
      if (b.l <= b.lo + v.BAND_TOL * rng) band++;
    } else {
      if (!(b.ema > b.mid && b.c > b.ema)) return false;
      const rng = Math.max(b.up - b.ema, 0);
      if (b.l <= b.ema + v.REJ_TOL * rng) rej++;
      if (b.h >= b.up - v.BAND_TOL * rng) band++;
    }
  }
  return rej >= v.K && band >= 1;
}
function trendState(bars, side) {
  if (!bars) return null;
  const b = bars[bars.length - 1];
  return side === 'bear' ? (b.ema < b.mid && b.c < b.ema) : (b.ema > b.mid && b.c > b.ema);
}

// ---- outcomes -------------------------------------------------------------------------------------
function outcomeBase(day, T) {
  const Tm = hm2min(T);
  const pT = day.px.filter(p => p.endMin <= Tm).pop();
  if (!pT || pT.endMin < Tm - 5) return null;
  const after = day.px.filter(p => p.endMin > Tm);
  const hiAfter = Math.max(pT.c, ...after.map(p => p.h)), loAfter = Math.min(pT.c, ...after.map(p => p.l));
  const nqT = day.bars15.find(b => b.endMin === Tm);
  if (!nqT) return null;
  return { P: pT.c, C: day.close, hiAfter, loAfter, nq: nqT };
}
function sided(o, side, em) {
  const d = side === 'bear' ? -1 : 1, r = x => o.P * (x / o.nq.c); // NQ level -> price-series level (basis by ratio)
  const move = d * (o.C - o.P);
  const mae = side === 'bear' ? o.hiAfter - o.P : o.P - o.loAfter;
  const mfe = side === 'bear' ? o.P - o.loAfter : o.hiAfter - o.P;
  return {
    move, movePct: move / o.P * 100, moveEM: em ? move / em : null,
    cont: move > 0,
    beyond: side === 'bear' ? o.C < r(o.nq.lo) : o.C > r(o.nq.up),
    revEma: side === 'bear' ? o.C > r(o.nq.ema) : o.C < r(o.nq.ema),
    revMid: side === 'bear' ? o.C > r(o.nq.mid) : o.C < r(o.nq.mid),
    mae, maePct: mae / o.P * 100, maeEM: em ? mae / em : null, mfeEM: em ? mfe / em : null,
  };
}

// ---- stats -----------------------------------------------------------------------------------------
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const median = a => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pct = (a, f) => a.length ? 100 * a.filter(f).length / a.length : NaN;
const f1 = x => Number.isFinite(x) ? x.toFixed(1) : '—';
const f2 = x => Number.isFinite(x) ? x.toFixed(2) : '—';
function cell(rows) {
  const n = rows.length, em = rows.filter(r => r.moveEM != null);
  const cont = pct(rows, r => r.cont), ci = n ? 196 * Math.sqrt((cont / 100) * (1 - cont / 100) / n) : NaN;
  return {
    n, thin: n < THIN, cont, ci,
    movePct: mean(rows.map(r => r.movePct)), medMovePct: median(rows.map(r => r.movePct)),
    movePts: mean(rows.map(r => r.move)),
    moveEM: mean(em.map(r => r.moveEM)), medMoveEM: median(em.map(r => r.moveEM)), nEM: em.length,
    beyond: pct(rows, r => r.beyond), revEma: pct(rows, r => r.revEma), revMid: pct(rows, r => r.revMid),
    maeEM: median(em.map(r => r.maeEM)), maePct: mean(rows.map(r => r.maePct)),
  };
}
const HDR = '| group | n | cont % (±95%) | mean move % | med move % | mean move pts | mean move EM | med move EM | close beyond band % | rev: close past 9EMA % | rev: close past mid % | med MAE EM | mean MAE % |';
const SEP = '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|';
function row(label, c) {
  return `| ${label}${c.thin ? ' (THIN)' : ''} | ${c.n} | ${f1(c.cont)} (±${f1(c.ci)}) | ${f2(c.movePct)} | ${f2(c.medMovePct)} | ${f1(c.movePts)} | ${f2(c.moveEM)} | ${f2(c.medMoveEM)} | ${f1(c.beyond)} | ${f1(c.revEma)} | ${f1(c.revMid)} | ${f2(c.maeEM)} | ${f2(c.maePct)} |`;
}

// ---- main ------------------------------------------------------------------------------------------
function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const ds = loadDatasetNQ(), raw = loadRaw2026();
  const out = [];
  const log = s => { out.push(s); console.log(s); };

  // parity: raw-1m 15m indicators vs dataset snapshots on overlapping 2026 dual days
  let parN = 0, parMax = 0;
  for (const d of raw.days) {
    const f = path.join(DS_DIR, `backtest-NQ-${d.date}.json`);
    if (!fs.existsSync(f)) continue;
    for (const b of JSON.parse(fs.readFileSync(f, 'utf8'))) {
      const t = et(b.datetime); if (t.min % 15 !== 0 || !b.analysis['15m']) continue;
      const mine = d.bars15.find(x => x.endMin === t.min); if (!mine) continue;
      parN++; parMax = Math.max(parMax, Math.abs(mine.ema - b.analysis['15m'].ema), Math.abs(mine.mid - b.analysis['15m'].bbmiddle), Math.abs(mine.lo - b.analysis['15m'].bblower));
    }
  }

  const days = [...ds.days, ...raw.days].sort((a, b) => a.date < b.date ? -1 : 1);
  // EM per series per checkpoint (prior 20 days of the same px_src)
  const emOf = new Map();
  for (const src of ['NQ(proxy)', 'NDX']) {
    const ser = days.filter(d => d.px_src === src);
    for (const T of CHECKPOINTS) {
      const absMoves = ser.map(d => { const o = outcomeBase(d, T); return o ? Math.abs(o.C - o.P) : null; });
      ser.forEach((d, i) => {
        const prior = absMoves.slice(Math.max(0, i - EM_LOOKBACK), i).filter(x => x != null);
        emOf.set(`${d.date}|${T}`, prior.length >= EM_LOOKBACK ? mean(prior) : null);
      });
    }
  }

  // per day x T record
  const recs = [];
  for (const d of days) for (const T of CHECKPOINTS) {
    const o = outcomeBase(d, T); if (!o) continue;
    const em = emOf.get(`${d.date}|${T}`);
    const rec = { date: d.date, year: d.date.slice(0, 4), T, px_src: d.px_src, closeSrc: d.closeSrc, P: o.P, C: o.C, em, nq: o.nq, o, flags: {} };
    for (const v of VARIANTS) {
      const bars = lastBars(d, T, v.N);
      for (const side of ['bear', 'bull']) rec.flags[`${v.name}|${side}`] = ride(bars, side, v);
    }
    const b1 = lastBars(d, T, 1);
    rec.trend = { bear: trendState(b1, 'bear'), bull: trendState(b1, 'bull') };
    rec.out = { bear: sided(o, 'bear', em), bull: sided(o, 'bull', em) };
    recs.push(rec);
  }

  log(`# EMA-ride study — generated ${new Date().toISOString()}`);
  log('');
  log(`Days: ${days.length} total = ${ds.days.length} NQ-proxy (2023-2025, dataset) + ${raw.days.length} NDX (2026, raw-1m). ` +
    `Dataset: ${ds.skippedDual} dual 2026 files skipped (taken from raw-1m), ${ds.noRth} ET dates without RTH bars, ${ds.halfDay} dates without a 16:00 NQ bar (half days) excluded. ` +
    `Raw skipped: ${raw.skipped.join(', ') || 'none'}.`);
  log(`Parity raw-1m vs dataset 15m (ema/mid/lower): ${parN} bars compared, max |diff| = ${parMax.toFixed(2)} pts.`);
  log(`Thresholds: ${VARIANTS.map(v => `${v.name}={N:${v.N},K:${v.K},REJ_TOL:${v.REJ_TOL},BAND_TOL:${v.BAND_TOL}}`).join('  ')}. EM = mean |close-P_T| of prior ${EM_LOOKBACK} days, same series & checkpoint. THIN = n<${THIN}.`);
  log('');

  const groups = (side, v, T, set) => {
    const opp = side === 'bear' ? 'bull' : 'bear', at = set.filter(r => r.T === T);
    const k = `${v.name}|${side}`, ko = `${v.name}|${opp}`;
    return [
      ['RIDE', at.filter(r => r.flags[k])],
      ['trend-only (trend state, no ride)', at.filter(r => r.trend[side] && !r.flags[k])],
      ['trend state (all, incl. ride)', at.filter(r => r.trend[side])],
      ['ALL days', at],
      ['no trend state either side', at.filter(r => !r.trend.bear && !r.trend.bull)],
      [`opposite trend state (${opp})`, at.filter(r => r.trend[opp])],
      [`opposite RIDE (${opp})`, at.filter(r => r.flags[ko])],
    ].map(([l, rs]) => [l, rs.map(r => r.out[side])]);
  };

  for (const v of VARIANTS) {
    log(`## Variant ${v.name} (N=${v.N}, K=${v.K}, REJ_TOL=${v.REJ_TOL}, BAND_TOL=${v.BAND_TOL})${v === BASE ? ' — BASE' : ''}`);
    log('');
    for (const side of ['bear', 'bull']) for (const T of CHECKPOINTS) {
      const g = groups(side, v, T, recs);
      if (v !== BASE && side) {
        // sensitivity variants: only the rows that change with the variant + the trend-only reference
        log(`### ${v.name} · ${side.toUpperCase()} · T=${T} (all moves signed in the ${side} direction)`);
        log(HDR); log(SEP);
        for (const [l, rs] of g.filter(([l]) => l === 'RIDE' || l.startsWith('trend-only') || l === 'ALL days')) log(row(l, cell(rs)));
      } else {
        log(`### ${side.toUpperCase()} · T=${T} (all moves signed in the ${side} direction)`);
        log(HDR); log(SEP);
        for (const [l, rs] of g) log(row(l, cell(rs)));
      }
      log('');
    }
  }

  // year split (BASE)
  log('## Year split — BASE variant: RIDE vs trend-only (cont %, mean move EM, n)');
  log('');
  const years = [...new Set(recs.map(r => r.year))].sort().filter(y => y >= '2023'); // 2022 = 3 late-Dec days, in aggregates only
  log(`| side | T | ${years.map(y => `${y} RIDE n | cont % | move EM | ${y} trend-only n | cont % | move EM`).join(' | ')} |`);
  log(`|---|---|${years.map(() => '---:|---:|---:|---:|---:|---:').join('|')}|`);
  for (const side of ['bear', 'bull']) for (const T of CHECKPOINTS) {
    const cells = years.map(y => {
      const ys = recs.filter(r => r.year === y);
      const g = Object.fromEntries(groups(side, BASE, T, ys));
      const a = cell(g.RIDE), b = cell(g['trend-only (trend state, no ride)']);
      return `${a.n}${a.thin ? '*' : ''} | ${f1(a.cont)} | ${f2(a.moveEM)} | ${b.n}${b.thin ? '*' : ''} | ${f1(b.cont)} | ${f2(b.moveEM)}`;
    });
    log(`| ${side} | ${T} | ${cells.join(' | ')} |`);
  }
  log('');
  log(`(* = n<20, thin. 2023-2025 priced on NQ RTH as a proxy; 2026 on cash NDX. ${recs.filter(r => r.year === '2022' && r.T === CHECKPOINTS[0]).length} late-Dec-2022 days are in the aggregates but not shown here.)`);
  log('');

  // day-level, first fire
  log('## Day-level, BASE: first checkpoint at which the ride fires vs days in trend state at some checkpoint but never riding (outcome from the first qualifying T)');
  log('');
  log(HDR); log(SEP);
  for (const side of ['bear', 'bull']) {
    const byDay = new Map(); for (const r of recs) { if (!byDay.has(r.date)) byDay.set(r.date, []); byDay.get(r.date).push(r); }
    const rideRows = [], trendRows = [];
    for (const rs of byDay.values()) {
      const fr = rs.find(r => r.flags[`base|${side}`]);
      if (fr) rideRows.push(fr.out[side]);
      else { const ft = rs.find(r => r.trend[side]); if (ft) trendRows.push(ft.out[side]); }
    }
    log(row(`${side} RIDE first fire`, cell(rideRows)));
    log(row(`${side} trend state, never ride`, cell(trendRows)));
  }
  log('');

  // 2026-10-14 verification
  log('## 2026-10-14 verification (raw-1m NQ signal, NDX price)');
  log('');
  const d14 = days.find(d => d.date === '2026-10-14');
  if (!d14) log('2026-10-14 NOT LOADED');
  else {
    log('| 15m bar end | open | high | low | close | 9EMA | BB mid | BB lower | ema<mid | close<ema | rejection (base) | band touch (base) |');
    log('|---|---:|---:|---:|---:|---:|---:|---:|:-:|:-:|:-:|:-:|');
    for (const b of d14.bars15.filter(b => b.endMin >= hm2min('09:30') && b.endMin <= hm2min('16:00'))) {
      const rng = Math.max(b.ema - b.lo, 0);
      const hh = `${String(Math.floor(b.endMin / 60)).padStart(2, '0')}:${String(b.endMin % 60).padStart(2, '0')}`;
      log(`| ${hh} | ${b.o} | ${b.h} | ${b.l} | ${b.c} | ${b.ema} | ${b.mid} | ${b.lo} | ${b.ema < b.mid ? 'Y' : '.'} | ${b.c < b.ema ? 'Y' : '.'} | ${b.c < b.ema && b.h >= b.ema - BASE.REJ_TOL * rng ? 'Y' : '.'} | ${b.l <= b.lo + BASE.BAND_TOL * rng ? 'Y' : '.'} |`);
    }
    log('');
    log(`| T | ${VARIANTS.map(v => `${v.name} bear`).join(' | ')} | ${VARIANTS.map(v => `${v.name} bull`).join(' | ')} | trend bear | NDX P_T | NDX close (${d14.closeSrc}) | bear move pts | beyond lower band | rev past 9EMA |`);
    log(`|---|${VARIANTS.map(() => ':-:').join('|')}|${VARIANTS.map(() => ':-:').join('|')}|:-:|---:|---:|---:|:-:|:-:|`);
    for (const r of recs.filter(r => r.date === '2026-10-14')) {
      const yn = x => x == null ? 'n/a' : x ? 'YES' : 'no';
      log(`| ${r.T} | ${VARIANTS.map(v => yn(r.flags[`${v.name}|bear`])).join(' | ')} | ${VARIANTS.map(v => yn(r.flags[`${v.name}|bull`])).join(' | ')} | ${yn(r.trend.bear)} | ${r.P.toFixed(2)} | ${r.C.toFixed(2)} | ${r.out.bear.move.toFixed(1)} | ${yn(r.out.bear.beyond)} | ${yn(r.out.bear.revEma)} |`);
    }
  }
  log('');

  // CSV: every day x T row
  const cols = ['date', 'year', 'T', 'px_src', 'close_src', 'P_T', 'close', 'em', 'nq_close_T', 'nq_ema9_T', 'nq_bbmid_T', 'nq_bblower_T', 'nq_bbupper_T', 'trend_bear', 'trend_bull',
    ...VARIANTS.flatMap(v => [`ride_${v.name}_bear`, `ride_${v.name}_bull`]),
    'bear_move', 'bear_move_pct', 'bear_move_em', 'bear_cont', 'bear_beyond_lower', 'bear_rev_ema', 'bear_rev_mid', 'bear_mae', 'bear_mae_em',
    'bull_move', 'bull_move_pct', 'bull_move_em', 'bull_cont', 'bull_beyond_upper', 'bull_rev_ema', 'bull_rev_mid', 'bull_mae', 'bull_mae_em'];
  const num = (x, d = 2) => x == null || !Number.isFinite(x) ? '' : (+x).toFixed(d);
  const b01 = x => x == null ? '' : x ? 1 : 0;
  const lines = [cols.join(',')];
  for (const r of recs) {
    const B = r.out.bear, U = r.out.bull;
    lines.push([r.date, r.year, r.T, r.px_src, `"${r.closeSrc}"`, num(r.P), num(r.C), num(r.em), r.nq.c, r.nq.ema, r.nq.mid, r.nq.lo, r.nq.up, b01(r.trend.bear), b01(r.trend.bull),
      ...VARIANTS.flatMap(v => [b01(r.flags[`${v.name}|bear`]), b01(r.flags[`${v.name}|bull`])]),
      num(B.move), num(B.movePct, 3), num(B.moveEM, 3), b01(B.cont), b01(B.beyond), b01(B.revEma), b01(B.revMid), num(B.mae), num(B.maeEM, 3),
      num(U.move), num(U.movePct, 3), num(U.moveEM, 3), b01(U.cont), b01(U.beyond), b01(U.revEma), b01(U.revMid), num(U.mae), num(U.maeEM, 3)].join(','));
  }
  fs.writeFileSync(path.join(OUT, 'ema-ride-day-checkpoints.csv'), lines.join('\n') + '\n');
  const det = [lines[0], ...lines.slice(1).filter((l, i) => VARIANTS.some(v => recs[i].flags[`${v.name}|bear`] || recs[i].flags[`${v.name}|bull`]))];
  fs.writeFileSync(path.join(OUT, 'ema-ride-detections.csv'), det.join('\n') + '\n');
  fs.writeFileSync(path.join(OUT, 'ema-ride-report.md'), out.join('\n') + '\n');
  console.log(`\nwrote ${OUT}/ema-ride-report.md, ema-ride-day-checkpoints.csv (${recs.length} rows), ema-ride-detections.csv (${det.length - 1} rows)`);
}

main();
