#!/usr/bin/env node
'use strict';
/**
 * DAY-SHAPE STUDY — which families / variants do best on which KIND of day?
 *
 * The user's question (2026-10-02): "today was a large gap up and early retracement compared to a gap up
 * that steadily climbs. Look at those kinds of days as a group compared to days that are choppy all day,
 * or a large aggressive rise in the first hour, or a steep sell-off in the first hour or two."
 *
 * PRE-REGISTERED. The shapes and thresholds below were written BEFORE any P&L was looked at, and are the
 * ONLY hypotheses tested. The 2026-09-07 regime work showed why: rules MINED from pure noise held their
 * sign across all quarters 80-90% of the time, so a searched-for pattern proves nothing. A fixed, small set
 * of hypotheses named in advance is the honest version. (project_roadmap_backlog: v7 is long the day's
 * MOVE, v4 short it — the magnitude mechanism these shapes are expected to express.)
 *
 * Every threshold is in units of R = the mean RTH (high-low) of the PRIOR 20 sessions (no lookahead), so
 * a "large" gap means the same thing in a quiet year and a wild one.
 *
 *   GU / GD           gap up / down: |open - prior RTH close| >= 0.25 R
 *   GU_FADE           gap up, and by 10:30 the low has given back >= 50% of the gap   ("gap up, early retrace")
 *   GU_CLIMB          gap up, NOT faded, and the day closes >= 0.25 R above the open    ("gap up, steady climb")
 *   GU_REVERSE        gap up, and the day closes BELOW its open (any amount)          ("gap up, then gives it back")
 *   GD_REVERSE        gap down, and the day closes ABOVE its open
 *   GD_BOUNCE         gap down, and by 10:30 the high has recovered >= 50% of the gap
 *   GD_SLIDE          gap down, NOT bounced, and the day closes >= 0.25 R below the open
 *   CHOP              efficiency ratio < 0.15 over the RTH 5m closes AND |close - open| < 0.25 R
 *   H1_RALLY          10:30 close >= open + 0.5 R                                       ("aggressive first-hour rise")
 *   H1_SELLOFF        10:30 close <= open - 0.5 R
 *   H2_SELLOFF        10:30 OR 11:30 close <= open - 0.5 R                              ("steep sell-off in the first hour or two")
 *   TREND_UP / DOWN   |close - open| >= 0.5 R in that direction AND efficiency >= 0.30
 *
 * GU_REVERSE / GD_REVERSE were added after labelling recent days but BEFORE any P&L was seen: 2026-10-02 (the
 * user's own example — gap +1.11 R, ran to +0.49 R by 10:30, closed -0.25 R) is not a GU_FADE, because the
 * gap was so large that half of it was never given back by 10:30. The EOD version captures what they meant.
 *
 * Efficiency ratio = |RTH close - RTH open| / sum of |5m close changes| (1 = a straight line, ~0 = chop).
 *
 * STATISTICS. For each (shape, variant): mean P&L on shape days, on all other days, the LIFT (difference),
 * and a CIRCULAR-ROTATION p-value — the shape's day labels are rotated against the P&L series by every
 * offset, which keeps both series' autocorrelation and asks how often a label set of the same size and
 * clustering would show a lift this large by chance. Families are the mean of their members. Each lift is
 * also checked in both chronological halves (sign agreement — valid for PRE-REGISTERED shapes, not mined
 * ones). Shape days are known only at the END of the day except where noted: GU/GD at the open;
 * GU_FADE / GD_BOUNCE / H1_* by 10:30; H2_SELLOFF by 11:30. A full-day P&L conditional on a 10:30 label
 * includes the morning, so this says which strategy SUITS a day shape — choosing one at 10:30 needs
 * rest-of-day P&L, a separate step.
 *
 * Usage:
 *   node scripts/candle-spread/day-shape-study.js --build --workers 8   # compute + cache the day x variant grid
 *   node scripts/candle-spread/day-shape-study.js                       # analyze the cached grid
 *   [--dataDir <5m dir>] [--top 6] [--variants]                          # --variants: per-variant tables too
 *   --labels [n] [--dataDir ...]                                         # print the last n days' features + shapes
 */
const fs = require('fs');
const path = require('path');
const { parallelMap } = require('./lib/parallel');

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const ROOT = path.join(__dirname, '..', '..');
const DIR = arg('--dataDir', path.join(ROOT, 'tests', 'backtest', 'backtest-data-5m-nq'));
const CACHE = arg('--cache', path.join(ROOT, 'signal-lab-data', `day-shape-grid-${path.basename(DIR)}.json`));
const TOP = Number(arg('--top', 6));
const SHOW_VARIANTS = process.argv.includes('--variants');

const SR = path.join(ROOT, 'server', 'src', 'candle-spread');
const { runDay5m, load5mDays } = require(path.join(SR, 'backtest', 'backtest-v6-5m'));
const { optsFor } = require(path.join(SR, 'backtest', 'opts-for'));

const etMin = (ms) => { const d = new Date(new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York' })); return d.getHours() * 60 + d.getMinutes(); };
const etDate = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

function loadDays() {
  const all = load5mDays(DIR);
  const hasRth = (d) => d.bars.some((b) => { const m = etMin(b.dt); return m >= 570 && m < 960; });
  return all.filter(hasRth);
}

// ── STAGE 1: the grid ───────────────────────────────────────────────────────────────────────────────
async function build() {
  process.env.CANDLE_SPREAD_RUNS_DIR = process.env.CANDLE_SPREAD_RUNS_DIR || fs.mkdtempSync(path.join(require('os').tmpdir(), 'dss-'));
  const { buildRuns } = require(path.join(SR, 'index'));
  const days = loadDays();
  const hasPx = days.some((d) => d.bars.some((b) => b.px));
  const runs = buildRuns();
  const units = runs.map((v) => ({ key: v.variant, v }));
  const res = await parallelMap(units, (u) => {
    const v = u.v;
    const fn = (A, p, ctx) => v.signalFn(A, p, { ...ctx, cfg: v.signalCfg || {} });
    const o = optsFor(v, { intradayIV: true, hasPx, where: 'day-shape-study' });
    return days.map((d) => Math.round(runDay5m(d.bars, fn, o).terminal));
  });
  const out = { builtAt: new Date().toISOString(), dataDir: path.basename(DIR), dates: days.map((d) => etDate(d.bars.find((b) => { const m = etMin(b.dt); return m >= 570 && m < 960; }).dt)),
    variants: runs.map((v) => v.variant), pnl: res };
  fs.writeFileSync(CACHE, JSON.stringify(out));
  console.log(`grid: ${out.variants.length} variants x ${out.dates.length} days -> ${CACHE}`);
}

// ── STAGE 2: day features + shapes ──────────────────────────────────────────────────────────────────
function features(days) {
  const px = (b) => (b.px ? b.px : { open: b.analysis['5m'].open, high: b.analysis['5m'].high, low: b.analysis['5m'].low, close: b.analysis['5m'].close });
  const rows = [];
  let prevClose = null; const ranges = [];
  for (const d of days) {
    const rth = d.bars.filter((b) => { const m = etMin(b.dt); return m >= 570 && m < 960; }).map((b) => ({ m: etMin(b.dt), ...px(b) }));
    // The study's dataset carries the 09:30 bar. The dual NQ/NDX set drops it (cold indicators), so for
    // labelling recent live days a first bar at 09:35 is accepted and its open stands in for the open.
    if (!rth.length || rth[0].m > 575 || rth[0].open == null) { prevClose = rth.length ? rth[rth.length - 1].close : prevClose; continue; }
    const open = rth[0].open, close = rth[rth.length - 1].close;
    const hi = Math.max(...rth.map((b) => b.high)), lo = Math.min(...rth.map((b) => b.low));
    const R = ranges.length >= 20 ? ranges.slice(-20).reduce((a, b) => a + b, 0) / 20 : null;
    const upto = (mm) => rth.filter((b) => b.m < mm);
    const at = (mm) => { const u = upto(mm); return u.length ? u[u.length - 1].close : null; };
    const h1 = upto(630);
    let path = 0; for (let k = 1; k < rth.length; k++) path += Math.abs(rth[k].close - rth[k - 1].close);
    path += Math.abs(rth[0].close - open);
    rows.push({ date: etDate(d.bars.find((b) => etMin(b.dt) >= 570).dt), R, gap: prevClose != null ? open - prevClose : null,
      open, close, net: close - open, range: hi - lo, er: path > 0 ? Math.abs(close - open) / path : 0,
      h1High: Math.max(...h1.map((b) => b.high)), h1Low: Math.min(...h1.map((b) => b.low)), c1030: at(630), c1130: at(690) });
    ranges.push(hi - lo); prevClose = close;
  }
  return rows;
}
const SHAPES = {
  GU: (f) => f.gap >= 0.25 * f.R,
  GD: (f) => f.gap <= -0.25 * f.R,
  GU_FADE: (f) => f.gap >= 0.25 * f.R && f.h1Low <= f.open - 0.5 * f.gap,
  GU_CLIMB: (f) => f.gap >= 0.25 * f.R && !(f.h1Low <= f.open - 0.5 * f.gap) && f.net >= 0.25 * f.R,
  GU_REVERSE: (f) => f.gap >= 0.25 * f.R && f.net < 0,
  GD_REVERSE: (f) => f.gap <= -0.25 * f.R && f.net > 0,
  GD_BOUNCE: (f) => f.gap <= -0.25 * f.R && f.h1High >= f.open + 0.5 * -f.gap,
  GD_SLIDE: (f) => f.gap <= -0.25 * f.R && !(f.h1High >= f.open + 0.5 * -f.gap) && f.net <= -0.25 * f.R,
  CHOP: (f) => f.er < 0.15 && Math.abs(f.net) < 0.25 * f.R,
  H1_RALLY: (f) => f.c1030 - f.open >= 0.5 * f.R,
  H1_SELLOFF: (f) => f.c1030 - f.open <= -0.5 * f.R,
  H2_SELLOFF: (f) => Math.min(f.c1030 - f.open, f.c1130 - f.open) <= -0.5 * f.R,
  TREND_UP: (f) => f.net >= 0.5 * f.R && f.er >= 0.30,
  TREND_DOWN: (f) => f.net <= -0.5 * f.R && f.er >= 0.30,
};
const KNOWN = { GU: '09:30', GD: '09:30', GU_FADE: '10:30', GD_BOUNCE: '10:30', H1_RALLY: '10:30', H1_SELLOFF: '10:30', H2_SELLOFF: '11:30' };

// Circular-rotation p-value for the difference in means between labelled and unlabelled days.
function rotationP(y, lab) {
  const n = y.length, k = lab.reduce((a, b) => a + b, 0);
  if (k < 3 || k > n - 3) return { diff: null, p: null };
  const tot = y.reduce((a, b) => a + b, 0);
  const diffOf = (off) => { let s = 0; for (let i = 0; i < n; i++) if (lab[(i + off) % n]) s += y[i]; return s / k - (tot - s) / (n - k); };
  const obs = diffOf(0);
  let ge = 0, m = 0;
  for (let off = 5; off <= n - 5; off++) { m++; if (Math.abs(diffOf(off)) >= Math.abs(obs) - 1e-9) ge++; }
  return { diff: obs, p: (ge + 1) / (m + 1) };
}
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const fam = (v) => (/^(v\d+)/.exec(v) || [, v])[1];
const fmt = (n) => (n == null || Number.isNaN(n) ? '—' : (n >= 0 ? '+' : '-') + '$' + Math.abs(Math.round(n)).toLocaleString());

function analyze() {
  if (!fs.existsSync(CACHE)) { console.error(`no grid at ${CACHE} — run with --build --workers 8 first`); process.exit(1); }
  const G = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  const F = features(loadDays());
  const fByDate = new Map(F.map((f) => [f.date, f]));
  // align: days that have both a grid column and complete features (R needs 20 prior sessions)
  const idx = G.dates.map((d, i) => ({ d, i, f: fByDate.get(d) })).filter((x) => x.f && x.f.R != null && x.f.gap != null && x.f.c1130 != null);
  const N = idx.length, half = Math.floor(N / 2);
  const series = (v) => idx.map((x) => G.pnl[v][x.i]);
  const families = [...new Set(G.variants.map(fam))].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  const famSeries = (f) => { const vs = G.variants.filter((v) => fam(v) === f).map(series); return idx.map((_, j) => mean(vs.map((s) => s[j]))); };
  const labels = {}; for (const [s, fn] of Object.entries(SHAPES)) labels[s] = idx.map((x) => (fn(x.f) ? 1 : 0));

  console.log(`\nDAY-SHAPE STUDY — ${N} days (${idx[0].d} .. ${idx[N - 1].d}), ${G.variants.length} variants, data ${G.dataDir}`);
  console.log('Lift = mean P&L on shape days minus mean on all other days. p = circular-rotation p-value. halves = sign of the lift in each chronological half.\n');
  console.log('SHAPE FREQUENCY');
  for (const s of Object.keys(SHAPES)) {
    const k = labels[s].reduce((a, b) => a + b, 0);
    console.log(`  ${s.padEnd(11)} ${String(k).padStart(4)} days  (${(k / N * 100).toFixed(1)}%)${KNOWN[s] ? `   known by ${KNOWN[s]}` : '   known at the close'}`);
  }

  // FAMILY x SHAPE lift grid
  const fs_ = {}; for (const f of families) fs_[f] = famSeries(f);
  console.log('\nFAMILY LIFT BY SHAPE  ($/day vs that family\'s own other days; * p<0.05, ** p<0.01, ! halves disagree)');
  const shapes = Object.keys(SHAPES);
  console.log('family  ' + shapes.map((s) => s.padStart(11)).join(''));
  for (const f of families) {
    const cells = shapes.map((s) => {
      const r = rotationP(fs_[f], labels[s]);
      if (r.diff == null) return '—'.padStart(11);
      const h1 = rotationP(fs_[f].slice(0, half), labels[s].slice(0, half)).diff, h2 = rotationP(fs_[f].slice(half), labels[s].slice(half)).diff;
      const flag = (r.p < 0.01 ? '**' : r.p < 0.05 ? '*' : '') + (h1 != null && h2 != null && Math.sign(h1) !== Math.sign(h2) ? '!' : '');
      return (fmt(r.diff) + flag).padStart(11);
    });
    console.log(f.padEnd(8) + cells.join(''));
  }

  // per shape: family avg on shape days (absolute) + best/worst variants
  for (const s of shapes) {
    const lab = labels[s], k = lab.reduce((a, b) => a + b, 0);
    if (k < 3) continue;
    const famRows = families.map((f) => { const y = fs_[f]; const on = y.filter((_, j) => lab[j]); return { f, on: mean(on), all: mean(y) }; })
      .sort((a, b) => b.on - a.on);
    console.log(`\n── ${s} (${k} days${KNOWN[s] ? `, known by ${KNOWN[s]}` : ''}) — family avg P&L on these days vs its overall avg`);
    console.log('   ' + famRows.map((r) => `${r.f} ${fmt(r.on)} (${fmt(r.all)})`).join(' · '));
    const vr = G.variants.map((v) => { const y = series(v); const r = rotationP(y, lab); const on = y.filter((_, j) => lab[j]);
      const h1 = rotationP(y.slice(0, half), lab.slice(0, half)).diff, h2 = rotationP(y.slice(half), lab.slice(half)).diff;
      return { v, on: mean(on), win: on.filter((x) => x > 0).length / on.length, worst: Math.min(...on), lift: r.diff, p: r.p,
        stable: h1 != null && h2 != null && Math.sign(h1) === Math.sign(h2) }; }).sort((a, b) => b.on - a.on);
    const row = (r) => `   ${r.v.padEnd(14)} avg ${fmt(r.on).padStart(8)}  win ${(r.win * 100).toFixed(0).padStart(3)}%  worst ${fmt(r.worst).padStart(8)}  lift ${fmt(r.lift).padStart(8)}  p ${r.p.toFixed(3)}${r.stable ? '' : '  halves disagree'}`;
    console.log('   BEST'); vr.slice(0, TOP).forEach((r) => console.log(row(r)));
    console.log('   WORST'); vr.slice(-Math.min(TOP, 3)).forEach((r) => console.log(row(r)));
    if (SHOW_VARIANTS) { console.log('   ALL'); vr.forEach((r) => console.log(row(r))); }
  }
  // Multiple-testing note: shapes x families cells
  console.log(`\nNOTE: ${shapes.length} shapes x ${families.length} families = ${shapes.length * families.length} family cells; at p<0.05 about ${Math.round(shapes.length * families.length * 0.05)} would pass by chance alone.`);
  console.log('Variant cells (shape x 80) are far more numerous — read them as descriptions, not discoveries, unless the family agrees.\n');
}

// --labels [n]: print the last n days' features and shapes (sanity check the definitions on known days)
function labels() {
  const n = Number(arg('--labels', 15)) || 15;
  const F = features(loadDays()).filter((f) => f.R != null && f.gap != null).slice(-n);
  console.log('date        R     gap(R)  h1Low/high vs open  10:30(R) 11:30(R)  net(R)  ER    shapes');
  for (const f of F) {
    const sh = Object.entries(SHAPES).filter(([, fn]) => fn(f)).map(([k]) => k).join(' ');
    const r = (x) => (x / f.R).toFixed(2).padStart(6);
    console.log(`${f.date}  ${f.R.toFixed(0).padStart(4)} ${r(f.gap)}   ${r(f.h1Low - f.open)}/${r(f.h1High - f.open)}     ${r(f.c1030 - f.open)}  ${r(f.c1130 - f.open)} ${r(f.net)}  ${f.er.toFixed(2)}  ${sh}`);
  }
}

module.exports = { features, SHAPES, loadDays, rotationP };
if (require.main === module) {
  (async () => {
    if (process.argv.includes('--build')) await build();
    else if (process.argv.includes('--labels')) labels();
    else analyze();
  })();
}
