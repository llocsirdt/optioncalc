#!/usr/bin/env node
'use strict';
/**
 * OVEREXTENSION STUDY (analysis only — touches no engine code, writes no baselines).
 *
 * QUESTION (user, 2026-10-15): live losses come from WITH-TREND opens made LATE in a move. Is "how far
 * beyond the outer Bollinger band price is, on each bar size" (a different threshold per TF) what tells
 * "overextended — ignore the trend" from "keep trading with the trend"? The 60m-only binary htfGate
 * ('close'/'touch') washed out (data/sweeps/htf-gate-rerun-2026-10-15), so this asks whether GRADED,
 * MULTI-TF distance separates the bad opens.
 *
 * PHASE 1 (positions): the live roster (buildRuns) through the same validated 5m engine the sweeps/baselines
 * use (optsFor -> runDay5m, openFillModel 'ladder', subBarFill '1m' with raw-1m sub-bars), recordReplay on, over
 * tests/backtest/backtest-data-5m-combined (tradeable days only). Every directional OPEN (no hedges/wings/flies)
 * is joined to the SIGNAL bar's analysis snapshot (/NQ, completed candles only):
 *   per TF (1m/5m/15m/60m): structural trend (close & 9EMA same side of mid) rel. to the trade, band width,
 *   pctBSide (current price's %B oriented to the trade: 1.0 = at the band ahead, 1.1 = 10% of band width
 *   BEYOND it), beyondPts (points beyond the band ahead, <0 = room left), wickBeyond (that TF's last bar
 *   extreme beyond its band, as a fraction of width), emaPts / emaBw (distance from the 9EMA in the trade's
 *   direction). Plus trend-state 'A' (15m + completed hourly) from trend-state.js's tracker.
 * Outcome from the replay: good (covered, locked >= minLock), covlow (covered below minLock, not a give-up),
 * giveup (covered by the give-up path), tail (uncovered at the close); pnl = the position's own settled P&L
 * (open legs + cover legs at the engine's settle, x100). REAL engine values; nothing derived.
 *
 * PHASE 2 (rules): population = opens WITH the 60m structural trend (the review's finding) — and, as a
 * check, all opens. Fit ONLY on 2023-2024 days, evaluate on 2025-2026 (held out). Rules: single-TF threshold
 * on pctBSide (and points), per-TF threshold set OR'd, per-TF set with a count k (beyond on >= k TFs).
 * Objective (train) = first-order P&L saved = -(sum pnl of removed opens), with a minimum removal count.
 * Random control: remove the same number of opens at random from the same test population (2000 draws).
 *
 * CAVEATS: first-order counterfactual only (removing an open changes governor headroom, the cover-on-open
 * ladder and later opens — book effects need a real engine gate + sweep); backtest fills are mid-priced;
 * the 2023-25 /NQ series is back-adjusted (fine for intraday bands; levels are not real prices).
 *
 * Usage: node scripts/candle-spread/study-overextension.js [--variants v7-10,v7-20,v6-10]
 *        [--out data/sweeps/overext-2026-10-15] [--analyzeOnly   (reuse OUT/positions-*.json)]
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const argv = process.argv.slice(2);
const arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const OUT = path.resolve(ROOT, arg('--out', 'data/sweeps/overext-2026-10-15'));
const VARIANTS = arg('--variants', 'v7-10,v7-20,v6-10').split(',');
const DIR = path.resolve(ROOT, arg('--dataDir', 'tests/backtest/backtest-data-5m-combined'));
const SUB1M = path.resolve(ROOT, arg('--sub1m', 'signal-lab-data/raw-1m'));
const TFS = ['1m', '5m', '15m', '60m'];
const r2 = (n) => (n == null || !isFinite(n) ? null : Math.round(n * 100) / 100);
const r3 = (n) => (n == null || !isFinite(n) ? null : Math.round(n * 1000) / 1000);
fs.mkdirSync(OUT, { recursive: true });

// ------------------------------------------------------------------ phase 1
function buildPositions() {
  const { runDay5m, load5mDays, attachSub1m, etMinute } = require('../../server/src/candle-spread/backtest/backtest-v6-5m');
  const { buildRuns } = require('../../server/src/candle-spread/index');
  const { optsFor } = require('../../server/src/candle-spread/backtest/opts-for');
  const { legsPayoff } = require('../../server/src/candle-spread/backtest/backtest-v4');
  const TS = require('../../server/src/candle-spread/trend-state');

  const allDays = load5mDays(DIR);
  const n1 = attachSub1m(allDays, SUB1M);
  const days = allDays.filter((d) => d.bars.some((b) => { const m = etMinute(b.dt); return m >= 570 && m < 960; }));
  const HAS_PX = allDays.some((d) => d.bars.some((b) => b.px));
  console.log(`${days.length} tradeable days (of ${allDays.length}), 1m sub-bars on ${n1}, hasPx=${HAS_PX}`);
  const iso = (s) => { const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s); return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : s; };

  // per-day signal-bar features (independent of variant except for side)
  const featCache = new Map();
  const dayCtx = (d) => {
    if (featCache.has(d)) return featCache.get(d);
    const step = TS.makeTracker();
    const ctx = d.bars.map((b) => step(b.analysis, b.dt));
    const byDt = new Map(d.bars.map((b, i) => [b.dt, i]));
    const v = { ctx, byDt };
    featCache.set(d, v);
    return v;
  };
  const feats = (d, i, side) => {
    const A = d.bars[i].analysis, sgn = side === 'bull' ? 1 : -1;
    const cur = A['5m'].close;
    const f = {};
    for (const tf of TFS) {
      const c = A[tf];
      if (!c || c.bbupper == null || c.bblower == null) { f[tf] = null; continue; }
      const bw = c.bbupper - c.bblower;
      const t = TS.trendOf(c);
      const ahead = sgn > 0 ? c.bbupper : c.bblower;
      f[tf] = {
        rel: t === 0 ? 'flat' : t === sgn ? 'with' : 'against',
        bw: r2(bw),
        pctB: bw > 0 ? r3(sgn > 0 ? (cur - c.bblower) / bw : (c.bbupper - cur) / bw) : null,
        beyondPts: r2(sgn * (cur - ahead)),
        wick: bw > 0 ? r3((sgn > 0 ? c.high - c.bbupper : c.bblower - c.low) / bw) : null,
        ownPctB: bw > 0 ? r3(sgn > 0 ? (c.close - c.bblower) / bw : (c.bbupper - c.close) / bw) : null,
        emaPts: c.ema != null ? r2(sgn * (cur - c.ema)) : null,
        emaBw: c.ema != null && bw > 0 ? r3(sgn * (cur - c.ema) / bw) : null,
      };
    }
    const tA = TS.state(dayCtx(d).ctx[i], 'A');
    f.trendA = tA === 0 ? 'flat' : tA === sgn ? 'with' : 'against';
    f.cur = cur;
    return f;
  };

  for (const variant of VARIANTS) {
    const run = buildRuns().find((r) => r.variant === variant);
    if (!run) throw new Error(`no variant ${variant}`);
    const W = run.spreadWidth;
    const minLock = (run.continuousCoverMinLockFrac || 0) * W;
    const fn = (A, p, ctx) => run.signalFn(A, p, { ...ctx, cfg: run.signalCfg || {} });
    const o = optsFor(run, { intradayIV: true, hasPx: HAS_PX, where: 'study-overextension', openFillModel: 'ladder', subBarFill: '1m' });
    if (o.openFillModel !== 'ladder' || o.subBarFill !== '1m') throw new Error('fill model did not reach the engine opts');
    o.recordReplay = true;
    const rows = [];
    let total = 0;
    const t0 = Date.now();
    for (const d of days) {
      const res = runDay5m(d.bars, fn, o);
      total += res.terminal;
      const date = iso(d.date);
      const { byDt } = dayCtx(d);
      for (const p of res.positions || []) {
        if (p.hedge || (p.side !== 'bull' && p.side !== 'bear') || p.filled === false) continue;
        const sigI = byDt.has(p.sigEpoch) ? byDt.get(p.sigEpoch) : byDt.get(p.openEpoch);
        if (sigI == null) continue;
        let value = legsPayoff(p.legs, res.settle), cost = p.limit;
        if (p.covered && p.coverLegs) { value += legsPayoff(p.coverLegs, res.settle); cost += p.coverLimit; }
        const pnl = Math.round((value - cost) * 100);
        const locked = p.covered && p.coverLegs ? r2(W - p.limit - p.coverLimit) : null;
        const outcome = !p.covered ? 'tail' : p._gu ? 'giveup' : locked >= minLock - 0.005 ? 'good' : 'covlow';
        rows.push({ variant, date, year: Number(date.slice(0, 4)), sigMin: etMinute(p.sigEpoch || p.openEpoch), openMin: etMinute(p.openEpoch),
          side: p.side, reason: String(p.openReason || ''), limit: p.limit, locked, outcome, pnl,
          coverMins: p.coverEpoch ? Math.round((p.coverEpoch - p.openEpoch) / 60000) : null, f: feats(d, sigI, p.side) });
      }
    }
    console.log(`${variant}: ${rows.length} opens, total terminal ${Math.round(total)}, ${Math.round((Date.now() - t0) / 1000)}s`);
    fs.writeFileSync(path.join(OUT, `positions-${variant}.json`), JSON.stringify({ variant, W, minLock, days: days.length, total: Math.round(total), rows }));
    // CSV
    const hdr = ['variant', 'date', 'sigET', 'side', 'reason', 'outcome', 'pnl', 'limit', 'locked', 'coverMins', 'trendA',
      ...TFS.flatMap((tf) => [`rel${tf}`, `pctB${tf}`, `beyondPts${tf}`, `wick${tf}`, `ownPctB${tf}`, `emaPts${tf}`, `emaBw${tf}`, `bw${tf}`])];
    const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    const lines = [hdr.join(',')];
    for (const r of rows) {
      lines.push([r.variant, r.date, hm(r.sigMin), r.side, JSON.stringify(r.reason), r.outcome, r.pnl, r.limit, r.locked, r.coverMins, r.f.trendA,
        ...TFS.flatMap((tf) => { const x = r.f[tf] || {}; return [x.rel, x.pctB, x.beyondPts, x.wick, x.ownPctB, x.emaPts, x.emaBw, x.bw]; })]
        .map((v) => (v == null ? '' : v)).join(','));
    }
    fs.writeFileSync(path.join(OUT, `positions-${variant}.csv`), lines.join('\n') + '\n');
  }
}

// ------------------------------------------------------------------ phase 2
const BAD = (r) => r.outcome === 'tail' || r.outcome === 'giveup';
const isTrain = (r) => r.year === 2023 || r.year === 2024;
const isTest = (r) => r.year >= 2025;
const PCT_GRID = [0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 1.0, 1.05, 1.1, 1.15, 1.2, 1.3, 1.4, 1.6, Infinity];
const fmt$ = (n) => (n == null ? '' : (n < 0 ? '-' : '') + '$' + Math.abs(Math.round(n)).toLocaleString('en-US'));
const pct = (a, b) => (b ? (100 * a / b).toFixed(1) + '%' : '-');

function stats(set) {
  const n = set.length;
  const c = { good: 0, covlow: 0, giveup: 0, tail: 0 };
  let pnl = 0, neg = 0, tailLoss = 0;
  for (const r of set) { c[r.outcome]++; pnl += r.pnl; if (r.pnl < 0) neg++; if (r.outcome === 'tail' && r.pnl < 0) tailLoss++; }
  return { n, ...c, bad: c.giveup + c.tail, pnl, neg, tailLoss };
}
// evaluate a predicate on a population
function evalRule(pop, pred) {
  const rem = [], kept = [];
  for (const r of pop) (pred(r) ? rem : kept).push(r);
  return { rem: stats(rem), kept: stats(kept), remRows: rem };
}
// random control: remove n at random, distribution of removed pnl
function randomControl(pop, n, removedPnl, draws = 2000) {
  if (!n) return null;
  let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pn = pop.map((r) => r.pnl), out = [];
  const idx = pn.map((_, i) => i);
  for (let d = 0; d < draws; d++) {
    for (let i = 0; i < n; i++) { const j = i + Math.floor(rnd() * (idx.length - i)); const t = idx[i]; idx[i] = idx[j]; idx[j] = t; }
    let s = 0; for (let i = 0; i < n; i++) s += pn[idx[i]]; out.push(s);
  }
  out.sort((a, b) => a - b);
  const mean = out.reduce((a, b) => a + b, 0) / draws;
  const pLE = out.filter((x) => x <= removedPnl).length / draws;   // chance a random removal is at least as negative
  return { mean, p5: out[Math.floor(draws * 0.05)], p95: out[Math.floor(draws * 0.95)], pLE };
}

const pctB = (r, tf) => (r.f[tf] ? r.f[tf].pctB : null);
const ptsB = (r, tf) => (r.f[tf] ? r.f[tf].beyondPts : null);

// grid search per-TF threshold set on train: OR (k=1) and count k in 2..4
function fitMulti(train, minRemove) {
  const N = train.length, G = PCT_GRID.length;
  // flags[tf][g] = Uint8Array over train
  const flags = TFS.map((tf) => PCT_GRID.map((t) => Uint8Array.from(train, (r) => { const v = pctB(r, tf); return v != null && v >= t ? 1 : 0; })));
  const pnl = Float64Array.from(train, (r) => r.pnl);
  const best = { 1: null, 2: null, 3: null, 4: null };
  const cnt = new Uint8Array(N);
  for (let a = 0; a < G; a++) for (let b = 0; b < G; b++) for (let c = 0; c < G; c++) for (let e = 0; e < G; e++) {
    const fa = flags[0][a], fb = flags[1][b], fc = flags[2][c], fe = flags[3][e];
    const sum = [0, 0, 0, 0, 0], n = [0, 0, 0, 0, 0];
    for (let i = 0; i < N; i++) {
      const k = fa[i] + fb[i] + fc[i] + fe[i];
      if (!k) continue;
      for (let j = 1; j <= k; j++) { sum[j] += pnl[i]; n[j]++; }
    }
    for (let k = 1; k <= 4; k++) {
      if (n[k] < minRemove) continue;
      const saved = -sum[k];
      if (!best[k] || saved > best[k].saved) best[k] = { k, th: [PCT_GRID[a], PCT_GRID[b], PCT_GRID[c], PCT_GRID[e]], saved, n: n[k] };
    }
  }
  void cnt;
  return best;
}
function fitSingle(train, getter, grid, minRemove) {
  const out = {};
  for (const tf of TFS) {
    let best = null;
    for (const t of grid(tf)) {
      let s = 0, n = 0;
      for (const r of train) { const v = getter(r, tf); if (v != null && v >= t) { s += r.pnl; n++; } }
      if (n < minRemove) continue;
      if (!best || -s > best.saved) best = { tf, t, saved: -s, n };
    }
    out[tf] = best;
  }
  return out;
}
// INTERVAL rule: remove if lo <= metric < hi — "near the band but not through it" (the live review's finding was
// little ROOM left to the 60m band, which is the zone just inside it, not beyond it).
function fitInterval(train, getter, gridFor, minRemove) {
  const out = {};
  for (const tf of TFS) {
    const g = gridFor(tf);
    let best = null;
    for (let a = 0; a < g.length; a++) for (let b = a + 1; b < g.length; b++) {
      let s = 0, n = 0;
      for (const r of train) { const v = getter(r, tf); if (v != null && v >= g[a] && v < g[b]) { s += r.pnl; n++; } }
      if (n < minRemove) continue;
      if (!best || -s > best.saved) best = { tf, lo: g[a], hi: g[b], saved: -s, n };
    }
    out[tf] = best;
  }
  return out;
}
const ZONE_GRID = [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.93, 0.95, 0.97, 1.0, 1.03, 1.05, 1.1, 1.2, 1.3, Infinity];
const quantGrid = (vals) => {
  const s = vals.filter((v) => v != null && isFinite(v)).sort((a, b) => a - b);
  const qs = [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.93, 0.95, 0.97, 0.98, 0.99];
  return [...new Set(qs.map((q) => Math.round(s[Math.floor(q * (s.length - 1))] * 2) / 2))];
};

function analyze() {
  const md = [];
  const P = (s = '') => md.push(s);
  P('# Overextension study — graded multi-TF band distance as a with-trend open gate');
  P();
  P(`Generated ${new Date().toISOString()} by scripts/candle-spread/study-overextension.js (analysis only, no engine change).`);
  P();
  P('**Method.** Live roster config (buildRuns) -> optsFor -> runDay5m, openFillModel ladder, subBarFill 1m, recordReplay, over the 821-day combined dataset (tradeable days). Every directional open is joined to its SIGNAL bar\'s /NQ analysis snapshot. `pctB<tf>` = current price\'s %B on that TF oriented to the trade (1.00 = at the band ahead, 1.10 = 10% of band width beyond it). Outcome: good = covered at >= minLock; covlow = covered below minLock (not give-up); giveup = give-up cover; tail = uncovered at the close. "bad" = giveup + tail. pnl = the position\'s own settled P&L (real engine values). **Fit on 2023-2024, test on 2025-2026.** Objective = first-order P&L saved = -(sum pnl of removed opens), min removal 3% of the train population.');
  P();
  P('**Caveats.** First-order counterfactual only — removing an open frees governor headroom / changes cover-on-open and later opens; book-level effect needs a real engine gate + sweep. Backtest fills are mid-priced. The 2023-25 /NQ series is back-adjusted (fine for intraday bands). Population = opens WITH the 60m structural trend unless noted.');
  P();
  const summary = {};
  for (const variant of VARIANTS) {
    const f = path.join(OUT, `positions-${variant}.json`);
    if (!fs.existsSync(f)) continue;
    const J = JSON.parse(fs.readFileSync(f, 'utf8'));
    const all = J.rows;
    P(`## ${variant} (W=${J.W}, minLock $${J.minLock.toFixed(2)}, ${J.days} days, engine total ${fmt$(J.total)})`);
    P();
    // overview by trend relation
    P('### Outcomes by 60m-trend relation (all years)');
    P();
    P('| set | opens | good | covlow | giveup | tail | bad% | pnl | pnl/open |');
    P('|---|---|---|---|---|---|---|---|---|');
    for (const rel of ['with', 'flat', 'against']) {
      const s = stats(all.filter((r) => r.f['60m'] && r.f['60m'].rel === rel));
      P(`| 60m ${rel} | ${s.n} | ${s.good} | ${s.covlow} | ${s.giveup} | ${s.tail} | ${pct(s.bad, s.n)} | ${fmt$(s.pnl)} | ${fmt$(s.pnl / Math.max(1, s.n))} |`);
    }
    const sAll = stats(all);
    P(`| all | ${sAll.n} | ${sAll.good} | ${sAll.covlow} | ${sAll.giveup} | ${sAll.tail} | ${pct(sAll.bad, sAll.n)} | ${fmt$(sAll.pnl)} | ${fmt$(sAll.pnl / sAll.n)} |`);
    P();
    const withPop = all.filter((r) => r.f['60m'] && r.f['60m'].rel === 'with');
    const pops = { 'with-60m': withPop, all };
    // univariate buckets
    P('### Univariate: with-60m-trend opens by pctB bucket per TF (train | test)');
    P();
    const buckets = [[-Infinity, 0.5], [0.5, 0.7], [0.7, 0.85], [0.85, 0.95], [0.95, 1.0], [1.0, 1.1], [1.1, 1.25], [1.25, Infinity]];
    P('| TF | pctB bucket | train n | train bad% | train pnl/open | test n | test bad% | test pnl/open |');
    P('|---|---|---|---|---|---|---|---|');
    for (const tf of TFS) {
      for (const [lo, hi] of buckets) {
        const inB = (r) => { const v = pctB(r, tf); return v != null && v >= lo && v < hi; };
        const a = stats(withPop.filter((r) => isTrain(r) && inB(r))), b = stats(withPop.filter((r) => isTest(r) && inB(r)));
        P(`| ${tf} | ${lo === -Infinity ? '<' : lo}${hi === Infinity ? '+' : '-' + hi} | ${a.n} | ${pct(a.bad, a.n)} | ${fmt$(a.pnl / Math.max(1, a.n))} | ${b.n} | ${pct(b.bad, b.n)} | ${fmt$(b.pnl / Math.max(1, b.n))} |`);
      }
    }
    P();
    summary[variant] = {};
    for (const [popName, pop] of Object.entries(pops)) {
      if (popName === 'all' && variant !== 'v7-10') continue;
      const train = pop.filter(isTrain), test = pop.filter(isTest);
      const minRemove = Math.max(10, Math.round(0.03 * train.length));
      const rules = [];
      // reference rule from the live review
      rules.push({ name: 'REF 60m pctB>=0.9', pred: (r) => (pctB(r, '60m') ?? -9) >= 0.9, train: null });
      // single-TF pctB and points
      const sp = fitSingle(train, pctB, () => PCT_GRID.filter(isFinite), minRemove);
      for (const tf of TFS) if (sp[tf]) rules.push({ name: `single ${tf} pctB>=${sp[tf].t}`, pred: (r) => (pctB(r, tf) ?? -9) >= sp[tf].t });
      const spts = fitSingle(train, ptsB, (tf) => quantGrid(train.map((r) => ptsB(r, tf))), minRemove);
      for (const tf of TFS) if (spts[tf]) rules.push({ name: `single ${tf} beyondPts>=${spts[tf].t}`, pred: (r) => (ptsB(r, tf) ?? -1e9) >= spts[tf].t });
      // interval (zone) rules
      const zp = fitInterval(train, pctB, () => ZONE_GRID, minRemove);
      for (const tf of TFS) if (zp[tf]) rules.push({ name: `zone ${tf} pctB in [${zp[tf].lo},${zp[tf].hi})`, pred: (r) => { const v = pctB(r, tf); return v != null && v >= zp[tf].lo && v < zp[tf].hi; } });
      const roomGrid = (tf) => { const q = quantGrid(train.map((r) => ptsB(r, tf))); return [...new Set([-200, -100, -60, -40, -30, -20, -15, -10, -8, -5, -3, 0, 3, 5, 10, 20, ...q].filter((x) => x <= Math.max(...q)))].sort((a, b) => a - b); };
      const zpts = fitInterval(train, ptsB, roomGrid, minRemove);
      for (const tf of TFS) if (zpts[tf]) rules.push({ name: `zone ${tf} beyondPts in [${zpts[tf].lo},${zpts[tf].hi})`, pred: (r) => { const v = ptsB(r, tf); return v != null && v >= zpts[tf].lo && v < zpts[tf].hi; } });
      // fixed a-priori zone rules (not fitted): the review's "little room left to the 60m band"
      rules.push({ name: 'FIXED 60m pctB in [0.9,1.0)', pred: (r) => { const v = pctB(r, '60m'); return v != null && v >= 0.9 && v < 1.0; } });
      rules.push({ name: 'FIXED 60m room 0-10pts (beyondPts in [-10,0))', pred: (r) => { const v = ptsB(r, '60m'); return v != null && v >= -10 && v < 0; } });
      // the v7-10 with-60m TRAIN fit of the 60m zone, applied unchanged everywhere (cross-variant check)
      rules.push({ name: 'V7-10-FIT 60m pctB in [0.97,1.05)', pred: (r) => { const v = pctB(r, '60m'); return v != null && v >= 0.97 && v < 1.05; } });
      rules.push({ name: 'V7-10-FIT 60m OR 1m zone (60m [0.97,1.05) or 1m [0.95,1.03))', pred: (r) => { const a = pctB(r, '60m'), b = pctB(r, '1m'); return (a != null && a >= 0.97 && a < 1.05) || (b != null && b >= 0.95 && b < 1.03); } });
      // multi-TF
      const t0 = Date.now();
      const mb = fitMulti(train, minRemove);
      console.log(`${variant}/${popName}: multi grid ${Math.round((Date.now() - t0) / 1000)}s`);
      for (const k of [1, 2, 3, 4]) {
        const b = mb[k];
        if (!b) continue;
        const th = b.th;
        const nm = `${k === 1 ? 'OR' : `count>=${k}`} [1m ${th[0]}, 5m ${th[1]}, 15m ${th[2]}, 60m ${th[3]}]`.replace(/Infinity/g, 'off');
        rules.push({ name: nm, th, k, pred: (r) => TFS.reduce((s, tf, j) => s + ((pctB(r, tf) ?? -9) >= th[j] ? 1 : 0), 0) >= k });
      }
      P(`### Rules — population: ${popName} (train n=${train.length}, test n=${test.length}; min removal ${minRemove})`);
      P();
      P('Removed = opens the rule would have blocked. "saved" = -(sum pnl removed) = first-order gain. "rand" = mean removed pnl when removing the same count at random from the same TEST population; p = share of 2000 random draws whose removed pnl is <= the rule\'s (small p = the rule picks losers better than chance).');
      P();
      P('| rule | split | removed | %pop | good | covlow | giveup | tail | removed bad% | kept bad% | removed pnl/open | kept pnl/open | saved | rand removed pnl | p |');
      P('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
      const out = [];
      for (const rule of rules) {
        for (const [split, S] of [['train', train], ['test', test]]) {
          const e = evalRule(S, rule.pred);
          const rc = split === 'test' ? randomControl(S, e.rem.n, e.rem.pnl) : null;
          P(`| ${rule.name} | ${split} | ${e.rem.n} | ${pct(e.rem.n, S.length)} | ${e.rem.good} | ${e.rem.covlow} | ${e.rem.giveup} | ${e.rem.tail} | ${pct(e.rem.bad, e.rem.n)} | ${pct(e.kept.bad, e.kept.n)} | ${fmt$(e.rem.pnl / Math.max(1, e.rem.n))} | ${fmt$(e.kept.pnl / Math.max(1, e.kept.n))} | ${fmt$(-e.rem.pnl)} | ${rc ? fmt$(rc.mean) : ''} | ${rc ? rc.pLE.toFixed(3) : ''} |`);
          out.push({ rule: rule.name, split, removed: e.rem, kept: e.kept, rand: rc });
        }
      }
      P();
      // per-year stability of the a-priori / cross-checked rules
      P(`Per-year (${popName}): removed pnl/open vs kept pnl/open, removed bad% vs kept bad% (n removed)`);
      P();
      const yrs = [...new Set(pop.map((r) => r.year))].sort();
      P('| rule | ' + yrs.join(' | ') + ' |');
      P('|---|' + yrs.map(() => '---').join('|') + '|');
      for (const rule of rules.filter((x) => /^(FIXED|V7-10-FIT|REF)/.test(x.name))) {
        P(`| ${rule.name} | ` + yrs.map((y) => { const e = evalRule(pop.filter((r) => r.year === y), rule.pred);
          return `${fmt$(e.rem.pnl / Math.max(1, e.rem.n))} vs ${fmt$(e.kept.pnl / Math.max(1, e.kept.n))}; ${pct(e.rem.bad, e.rem.n)} vs ${pct(e.kept.bad, e.kept.n)} (${e.rem.n})`; }).join(' | ') + ' |');
      }
      P();
      summary[variant][popName] = out;
    }
  }
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 1));
  fs.writeFileSync(path.join(OUT, 'summary.md'), md.join('\n') + '\n');
  console.log('wrote', path.join(OUT, 'summary.md'));
}

if (!argv.includes('--analyzeOnly')) buildPositions();
analyze();
