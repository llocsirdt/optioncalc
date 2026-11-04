#!/usr/bin/env node
'use strict';
/**
 * LATE-START SWEEP — BACKTEST ONLY. Every ROSTER variant (buildRuns(), exactly as build-backtest-baselines runs
 * it: optsFor, ladder opens, 1m sub-bar cover fills, intraday IV) switched ON at a later ET minute with an EMPTY
 * book (runDay5m opts.actionStartMin). Earlier bars still build the signal; nothing is carried from the morning,
 * so a late start's P&L is REST-OF-DAY only. The 09:30 arm leaves actionStartMin UNSET and must reproduce the
 * committed backtest-baselines-combined numbers exactly (checked and printed).
 *
 * Second table (the 2026-10-02 rest-of-day finding, day-shape-study.js labels): H2_SELLOFF days from 11:30,
 * H1_SELLOFF / H1_RALLY days from 10:30 — mean on shape days vs other days, lift, circular-rotation p, halves.
 *
 * Usage: node scripts/candle-spread/sweep-late-start.js --workers 8
 *          [--dataDir tests/backtest/backtest-data-5m-combined] [--sub1m signal-lab-data/raw-1m]
 *          [--starts 570,585,600,630,660,690] [--variants v7-10,...] [--out data/sweeps/late-start-2026-10-23]
 *        node scripts/candle-spread/sweep-late-start.js --summarize [--out ...]   # re-render from grid.json
 */
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..', '..');
const argVal = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const DIR = path.resolve(argVal('--dataDir', path.join(ROOT, 'tests', 'backtest', 'backtest-data-5m-combined')));
const SUB1M = path.resolve(argVal('--sub1m', path.join(ROOT, 'signal-lab-data', 'raw-1m')));
const OUT = path.resolve(argVal('--out', path.join(ROOT, 'data', 'sweeps', 'late-start-2026-10-23')));
const STARTS = argVal('--starts', '570,585,600,630,660,690').split(',').map(Number);
const VARS_ONLY = (argVal('--variants', '') || '').split(',').filter(Boolean);
const BASELINES = path.resolve(argVal('--baselines', path.join(ROOT, 'server', 'src', 'candle-spread', 'backtest-baselines-combined.json')));
const SUMMARIZE = process.argv.includes('--summarize');
const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const CONTROL = 570;

process.env.CANDLE_SPREAD_RUNS_DIR = process.env.CANDLE_SPREAD_RUNS_DIR || fs.mkdtempSync(path.join(require('os').tmpdir(), 'late-start-'));
const { runDay5m, load5mDays, attachSub1m } = require('../../server/src/candle-spread/backtest/backtest-v6-5m');
const { optsFor } = require('../../server/src/candle-spread/backtest/opts-for');
const { parallelMap, workerCount } = require('./lib/parallel');

const etMin = (ms) => { const d = new Date(new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York' })); return d.getHours() * 60 + d.getMinutes(); };
const isoOf = (s) => { const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s); return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : s; };

// ── aggregation (sweep-v10 agg / build-backtest-baselines definitions) ──
function rollingDD(daily, W) { const cum = [0]; for (let i = 0; i < daily.length; i++) cum.push(cum[i] + daily[i]); let mx = 0;
  for (let b = 1; b < cum.length; b++) { let pk = -Infinity; for (let a = Math.max(0, b - W); a < b; a++) if (cum[a] > pk) pk = cum[a]; if (pk - cum[b] > mx) mx = pk - cum[b]; } return -Math.round(mx); }
function agg(recs) {
  const n = recs.length; if (!n) return null;
  const daily = recs.map((r) => r.t), total = daily.reduce((a, b) => a + b, 0), sorted = [...daily].sort((a, b) => a - b);
  const tr = recs.filter((r) => r.tr), nt = Math.max(1, tr.length), traded = recs.filter((r) => r.o > 0);
  const per = (x) => Math.round(x / n * 100) / 100;
  return {
    days: n, total: Math.round(total), avgDaily: Math.round(total / n), worst: Math.round(sorted[0]), maxDD30: rollingDD(daily, 30),
    intradayFloorAvg: Math.round(tr.reduce((a, r) => a + (r.ifa || 0), 0) / nt), ifNonNegPct: Math.round(tr.reduce((a, r) => a + (r.ifp || 0), 0) / nt * 10) / 10,
    avgEndFloor: traded.length ? Math.round(traded.reduce((a, r) => a + r.ef, 0) / traded.length) : null,
    lockedPct: traded.length ? Math.round(1000 * traded.filter((r) => r.ef > 0).length / traded.length) / 10 : null,
    lockedRatio: traded.length ? traded.filter((r) => r.ef > 0).length / traded.length : null,
    uncoveredEodPerDay: per(recs.reduce((a, r) => a + (r.ue || 0), 0)), opensPerDay: per(recs.reduce((a, r) => a + r.o, 0)),
    avgTradesPerDayExact: Math.round(recs.reduce((a, r) => a + r.o, 0) / n * 100) / 100, winPct: Math.round(100 * daily.filter((x) => x > 0).length / n), tradedDays: traded.length,
  };
}

// ── conditional (day-shape-study labels + its circular-rotation p) ──
function conditional(G) {
  const DS = require('./day-shape-study');
  const F = DS.features(G._days);
  const fBy = new Map(F.map((f) => [f.date, f]));
  const idx = G.dates.map((d, i) => ({ i, f: fBy.get(d) })).filter((x) => x.f && x.f.R != null && x.f.gap != null && x.f.c1130 != null);
  const half = Math.floor(idx.length / 2);
  const tests = [['H2_SELLOFF', 690], ['H1_SELLOFF', 630], ['H1_RALLY', 630]];
  const out = { days: idx.length, from: G.dates[idx[0].i], to: G.dates[idx[idx.length - 1].i], tests: {} };
  for (const [shape, start] of tests) {
    const lab = idx.map((x) => (DS.SHAPES[shape](x.f) ? 1 : 0));
    const rows = {};
    for (const v of G.variants) {
      for (const s of [start, CONTROL]) {
        const series = G.daily[`${v}|${s}`]; if (!series) continue;
        const y = idx.map((x) => series[x.i]);
        const r = DS.rotationP(y, lab);
        const on = y.filter((_, j) => lab[j]), off = y.filter((_, j) => !lab[j]);
        const h1 = DS.rotationP(y.slice(0, half), lab.slice(0, half)).diff, h2 = DS.rotationP(y.slice(half), lab.slice(half)).diff;
        const m = (a) => Math.round(a.reduce((p, q) => p + q, 0) / a.length);
        rows[`${v}|${s}`] = { on: m(on), off: m(off), lift: Math.round(r.diff), p: r.p, h1: h1 == null ? null : Math.round(h1), h2: h2 == null ? null : Math.round(h2), worstOn: Math.min(...on) };
      }
    }
    out.tests[shape] = { start, n: lab.reduce((a, b) => a + b, 0), rows };
  }
  return out;
}

// 2026-10-02 reference (memory project_roadmap_backlog, 4fdea00; 765d NQ-priced set, 80-variant roster of that day)
const OLD = { H2_SELLOFF: { 'v7-10': '+909 p.001 (on +2,251)', 'v6-10': '+711 p.004', 'v8-10': '+517 p.001', 'v9-20': '+920 p.058' },
  H1_SELLOFF: { 'v7-10': '+853 p.011' }, H1_RALLY: { 'v4-10': '+465 p.029', 'v9-20': '+1,466 p.041', 'v7-10': '-411 ns' } };

function render(G, C, check) {
  const f = (n) => (n == null ? '' : (n < 0 ? '-' : '') + String(Math.abs(Math.round(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ','));
  const sg = (n) => (n == null ? '' : (n > 0 ? '+' : '') + f(n));
  const sp = (n) => (n == null ? '' : (n > 0 ? '+' : '') + n.toFixed(1));
  const pad = (s, n) => String(s).padStart(n);
  const L = [];
  L.push(`# Late start — rest-of-day P&L by switch-on time (${G.meta.days} days ${G.meta.from}..${G.meta.to}; ${G.meta.n2026} NDX-priced 2026)\n`);
  L.push(`Engine: runDay5m opts.actionStartMin (empty book at the start, earlier bars build the signal only). Roster = buildRuns() at ${G.meta.commit}`);
  L.push(`(${G.variants.length} variants), optsFor + ladder opens + 1m sub-bar cover fill + intraday IV, as build-backtest-baselines. A late start skips the`);
  L.push('morning entirely: its P&L is rest-of-day only, nothing carried. 09:30 = control (actionStartMin unset).\n');
  L.push(`**Control check vs ${path.basename(BASELINES)}:** ${check.ok}/${check.n} variants match exactly on total, avg/day, worst, maxDD30, locked %, end floor, opens/day${check.bad.length ? ` — MISMATCH: ${check.bad.join(', ')}` : ''}.\n`);
  L.push('Columns: worst day, maxDD30, IF avg (intraday book floor avg over bars holding positions, traded days), IF>=0% (share of those bars with floor >= 0),');
  L.push('end floor (avg EOD book floor, traded days), locked % (traded days ending floor > 0), uncov/d (uncovered positions at EOD per day), opens/d, avg/d, total;');
  L.push('then Δ vs that variant\'s 09:30 control on worst, maxDD30, IF>=0% (pts), total. Per variant, never averaged.\n');
  const hdr = 'variant         start    worst  maxDD30   IFavg  IF>=0%  endFl  lock%  uncov/d  opens/d  avg/d      total |  Δworst  ΔmaxDD30  ΔIF>=0   Δtotal';
  for (const [era, key] of [['All days', 'all'], ['2026 only (NDX-priced)', 'y2026']]) {
    L.push(`## ${era}\n\n\`\`\`\n${hdr}`);
    for (const v of G.variants) {
      const c = G.rows[`${v}|${CONTROL}`][key];
      for (const s of G.starts) {
        const a = G.rows[`${v}|${s}`][key]; if (!a) continue;
        const d = s === CONTROL ? '' : ` | ${pad(sg(a.worst - c.worst), 7)} ${pad(sg(a.maxDD30 - c.maxDD30), 9)} ${pad(sp(a.ifNonNegPct - c.ifNonNegPct), 7)} ${pad(sg(a.total - c.total), 9)}`;
        L.push(`${v.padEnd(15)} ${hm(s)} ${pad(f(a.worst), 8)} ${pad(f(a.maxDD30), 8)} ${pad(f(a.intradayFloorAvg), 7)} ${pad(a.ifNonNegPct, 7)} ${pad(f(a.avgEndFloor), 6)} ${pad(a.lockedPct, 6)} ${pad(a.uncoveredEodPerDay, 8)} ${pad(a.opensPerDay, 8)} ${pad(f(a.avgDaily), 6)} ${pad(f(a.total), 10)}${d}`);
      }
    }
    L.push('```\n');
    // best start per variant
    L.push(`### Best start per variant (${era}) — by IF>=0% and by worst day (ties -> earlier start)\n\n\`\`\``);
    L.push('variant         | IF>=0%: best  (val / 09:30)   | worst: best  (val / 09:30)      | maxDD30: best (val / 09:30)');
    const tally = { if: {}, worst: {}, dd: {} };
    for (const v of G.variants) {
      const c = G.rows[`${v}|${CONTROL}`][key];
      const pick = (m) => { let b = null; for (const s of G.starts) { const a = G.rows[`${v}|${s}`][key]; if (a && (b == null || a[m] > b.a[m])) b = { s, a }; } return b; };
      const bi = pick('ifNonNegPct'), bw = pick('worst'), bd = pick('maxDD30');
      tally.if[bi.s] = (tally.if[bi.s] || 0) + 1; tally.worst[bw.s] = (tally.worst[bw.s] || 0) + 1; tally.dd[bd.s] = (tally.dd[bd.s] || 0) + 1;
      L.push(`${v.padEnd(15)} | ${hm(bi.s)} (${pad(bi.a.ifNonNegPct, 5)} / ${pad(c.ifNonNegPct, 5)})     | ${hm(bw.s)} (${pad(f(bw.a.worst), 7)} / ${pad(f(c.worst), 7)})     | ${hm(bd.s)} (${pad(f(bd.a.maxDD30), 8)} / ${pad(f(c.maxDD30), 8)})`);
    }
    const t = (o) => G.starts.map((s) => `${hm(s)} ${o[s] || 0}`).join('  ');
    L.push(`\ncount of variants whose best start is ...\n  IF>=0%  : ${t(tally.if)}\n  worst   : ${t(tally.worst)}\n  maxDD30 : ${t(tally.dd)}`);
    L.push('```\n');
  }
  if (C) {
    L.push(`## Conditional rest-of-day (day-shape-study labels) — ${C.days} labelled days ${C.from}..${C.to}\n`);
    L.push('on = mean rest-of-day P&L on shape days, off = mean on other days, lift = on - off, p = circular-rotation p, h1/h2 = lift in each chronological half.');
    L.push('"full-day" columns = the same variant at the 09:30 control on the same days (full-day P&L, includes the morning) for reference.');
    L.push('Ref 10-02 = what the 2026-10-02 run found (765d NQ-priced set, roster of that day).\n');
    for (const [shape, T] of Object.entries(C.tests)) {
      L.push(`### ${shape} from ${hm(T.start)} — ${T.n} days\n\n\`\`\`\nvariant              on      off     lift      p      h1      h2  worstOn | full-day on   lift      p | ref 10-02`);
      for (const v of G.variants) {
        const r = T.rows[`${v}|${T.start}`], c = T.rows[`${v}|${CONTROL}`]; if (!r) continue;
        const star = r.p < 0.01 ? '**' : r.p < 0.05 ? '*' : '  ';
        L.push(`${v.padEnd(15)} ${pad(sg(r.on), 8)} ${pad(sg(r.off), 8)} ${pad(sg(r.lift), 8)}${star} ${r.p.toFixed(3)} ${pad(sg(r.h1), 7)} ${pad(sg(r.h2), 7)} ${pad(f(r.worstOn), 8)} | ${pad(sg(c.on), 8)} ${pad(sg(c.lift), 7)} ${c.p.toFixed(3)} | ${(OLD[shape] && OLD[shape][v]) || ''}`);
      }
      L.push('```\n');
    }
  }
  return L.join('\n');
}

(async () => {
  const days = load5mDays(DIR).filter((d) => d.bars.some((b) => { const m = etMin(b.dt); return m >= 570 && m < 960; }));
  if (SUMMARIZE) {
    const G = JSON.parse(fs.readFileSync(path.join(OUT, 'grid.json'), 'utf8'));
    G._days = days;
    const C = conditional(G);
    const md = render(G, C, G.check);
    fs.writeFileSync(path.join(OUT, 'summary.md'), md + '\n');
    fs.writeFileSync(path.join(OUT, 'conditional.json'), JSON.stringify(C, null, 1));
    console.log(md);
    return;
  }
  const n1m = fs.existsSync(SUB1M) ? attachSub1m(days, SUB1M) : 0;
  const HAS_PX = days.some((d) => d.bars.some((b) => b.px));
  const era = days.map((d) => (d.bars.some((b) => b.px) ? '2026' : 'pre'));
  const { buildRuns } = require('../../server/src/candle-spread/index');
  const RUNS = buildRuns().filter((r) => !VARS_ONLY.length || VARS_ONLY.includes(r.variant));
  const env = { intradayIV: true, hasPx: HAS_PX, where: 'sweep-late-start', openFillModel: 'ladder', subBarFill: '1m' };
  const units = [];
  for (const r of RUNS) for (const s of STARTS) units.push({ key: `${r.variant}|${s}`, variant: r.variant, start: s });
  const slim = (r) => ({ t: r.terminal, o: r.opens, ue: r.uncoveredEod || 0, tr: r.lock && r.lock.traded ? 1 : 0, ef: r.lock ? r.lock.endBookFloor : null,
    ifa: r.intradayFloorAvg, ifp: r.intradayFloorNonNegPct });
  const t0 = Date.now();
  if (!process.argv.includes('--_slice')) console.log(`LATE-START SWEEP — ${RUNS.length} variants x ${STARTS.length} starts (${STARTS.map(hm).join(', ')}) x ${days.length} days, 1m sub-bars on ${n1m} days, ${workerCount()} worker(s)`);
  const res = await parallelMap(units, (u) => {
    const run = buildRuns().find((r) => r.variant === u.variant);
    const o = optsFor(run, env);
    if (u.start !== CONTROL) o.actionStartMin = u.start;   // control: UNSET (byte-identical to the baselines)
    const fn = (A, p, ctx) => run.signalFn(A, p, { ...ctx, cfg: run.signalCfg || {} });
    return days.map((d) => slim(runDay5m(d.bars, fn, o)));
  });
  let commit = 'nogit';
  try { commit = require('child_process').execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim(); } catch (e) { /* */ }
  const G = { meta: { generatedAt: new Date().toISOString(), commit, dataDir: path.basename(DIR), days: days.length, from: isoOf(days[0].date), to: isoOf(days[days.length - 1].date),
    n2026: era.filter((e) => e === '2026').length, sub1mDays: n1m, workers: workerCount(), wallSec: Math.round((Date.now() - t0) / 1000) },
    variants: RUNS.map((r) => r.variant), starts: STARTS, dates: days.map((d) => isoOf(d.date)), rows: {}, daily: {} };
  for (const u of units) {
    const recs = res[u.key];
    G.rows[u.key] = { all: agg(recs), y2026: agg(recs.filter((_, i) => era[i] === '2026')), pre: agg(recs.filter((_, i) => era[i] === 'pre')) };
    G.daily[u.key] = recs.map((r) => Math.round(r.t));
  }
  // CONTROL CHECK vs the committed baselines
  const B = JSON.parse(fs.readFileSync(BASELINES, 'utf8'));
  const check = { n: 0, ok: 0, bad: [] };
  for (const v of G.variants) {
    const a = G.rows[`${v}|${CONTROL}`] && G.rows[`${v}|${CONTROL}`].all, b = B.variants[v];
    if (!a || !b) continue; check.n++;
    const same = a.days === b.days && a.total === b.total && a.avgDaily === b.avgDaily && a.worst === b.worst && a.maxDD30 === b.maxDD30
      && Math.abs(a.lockedRatio - b.lockedPct) < 1e-12 && a.avgEndFloor === b.avgEndFloor && a.avgTradesPerDayExact === b.avgTradesPerDay;
    if (same) check.ok++; else check.bad.push(`${v} (total ${a.total} vs ${b.total}, worst ${a.worst} vs ${b.worst}, maxDD30 ${a.maxDD30} vs ${b.maxDD30})`);
  }
  G.check = check;
  console.log(`CONTROL CHECK: ${check.ok}/${check.n} exact${check.bad.length ? '\n  ' + check.bad.join('\n  ') : ''}`);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'grid.json'), JSON.stringify(G));
  const cols = ['worst', 'maxDD30', 'intradayFloorAvg', 'ifNonNegPct', 'avgEndFloor', 'lockedPct', 'uncoveredEodPerDay', 'opensPerDay', 'avgDaily', 'total', 'winPct', 'tradedDays', 'days'];
  const lines = [['variant', 'start', 'era', ...cols, 'dWorst', 'dMaxDD30', 'dIfNonNegPct', 'dTotal'].join(',')];
  for (const v of G.variants) for (const s of STARTS) for (const e of ['all', 'y2026', 'pre']) {
    const a = G.rows[`${v}|${s}`][e], c = G.rows[`${v}|${CONTROL}`] && G.rows[`${v}|${CONTROL}`][e]; if (!a) continue;
    const d = c ? [a.worst - c.worst, a.maxDD30 - c.maxDD30, Math.round((a.ifNonNegPct - c.ifNonNegPct) * 10) / 10, a.total - c.total] : ['', '', '', ''];
    lines.push([v, hm(s), e === 'y2026' ? '2026' : e, ...cols.map((k) => (a[k] == null ? '' : a[k])), ...d].join(','));
  }
  fs.writeFileSync(path.join(OUT, 'late-start.csv'), lines.join('\n') + '\n');
  const S = { meta: G.meta, check, variants: G.variants, starts: STARTS, rows: G.rows };
  fs.writeFileSync(path.join(OUT, 'late-start.json'), JSON.stringify(S, null, 1));
  G._days = days;
  const C = conditional(G);
  fs.writeFileSync(path.join(OUT, 'conditional.json'), JSON.stringify(C, null, 1));
  const md = render(G, C, check);
  fs.writeFileSync(path.join(OUT, 'summary.md'), md + '\n');
  console.log(md);
  console.log(`wrote ${OUT} in ${G.meta.wallSec}s`);
})().catch((e) => { console.error(e); process.exit(1); });
