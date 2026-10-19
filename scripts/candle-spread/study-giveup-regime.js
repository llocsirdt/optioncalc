#!/usr/bin/env node
'use strict';
/**
 * GIVE-UP REGIME STUDY (2026-10-19, study only — no roster/default change).
 *
 * Question (user): when a give-up fires, can momentum or the 15m/60m Bollinger-band regime tell "truly give up —
 * cover at the mark now, pay the premium" from "wait — a pullback is still likely, cover later at a better price"?
 *
 * Method: run the roster v6-v9 x 10/20/40 through runDay5m (baseline settings: optsFor, ladder opens, 1m sub-bars)
 * with the read-only opts.giveUpTap hook. At the FIRST give-up of each position it records the cover legs being
 * worked, the open cost, the mark and the price the current rule would pay; every later bar it records the cover's
 * mark at that bar's favourable extreme / close / adverse extreme (same pricing as the engine). Features come from
 * the /NQ signal bars at the trigger; outcomes and counterfactual cover arms from the NDX-priced cover path.
 *
 * Counterfactual arms (per position, independent — the governor / book interactions are NOT re-simulated):
 *   payNow    cover now at mark + 1 tick, unbounded
 *   capK      the static current rule with allowance K x W: fill now at mark + tick when that is <= break-even + K x W,
 *             else rest at break-even + K x W and fill AT it on the first later bar whose favourable-extreme mark
 *             reaches it (cap0 = wait for break-even). capCur = K by width (10W 0.05 / 20W 0.075 / 40W 0.10).
 *   hold      never cover (settle)
 *   actual    what the engine did (ladder lapse, re-strikes, governor deferrals included)
 * Position P&L = (open payoff at settle - open cost + cover payoff at settle - cover price) x 100.
 *
 * Usage: node scripts/candle-spread/study-giveup-regime.js [--workers 8] [--variants v7-10,v9-10]
 *          [--out data/sweeps/giveup-regime-2026-10-19]
 */
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..', '..');
const { runDay5m, load5mDays, attachSub1m, etMinute } = require('../../server/src/candle-spread/backtest/backtest-v6-5m');
const eng = require('../../server/src/candle-spread/backtest/backtest-v4');
const bs = require('../../server/src/candle-spread/bs-pricer');
const TS = require('../../server/src/candle-spread/trend-state');
const { parallelMap, workerCount } = require('./lib/parallel');

const argVal = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const DIR = argVal('--dataDir', path.join(ROOT, 'tests', 'backtest', 'backtest-data-5m-combined'));
const SUB1M = argVal('--sub1m', path.join(ROOT, 'signal-lab-data', 'raw-1m'));
const OUT = argVal('--out', path.join(ROOT, 'data', 'sweeps', 'giveup-regime-2026-10-19'));
const VARS_ONLY = (argVal('--variants', '') || '').split(',').filter(Boolean);
const IS_CHILD = process.argv.includes('--_slice');
const TICK = eng.TICK;
const KS = [0, 0.025, 0.05, 0.075, 0.10, 0.15, 0.25];
const CUR_K = { 10: 0.05, 20: 0.075, 40: 0.10 };
const ZZ_THETA = 20;   // NQ points: zigzag reversal threshold for "run since the last swing"

const t0 = Date.now();
const allDays = load5mDays(DIR);
const n1m = fs.existsSync(SUB1M) ? attachSub1m(allDays, SUB1M) : 0;
const HAS_PX = allDays.some((d) => d.bars.some((b) => b.px));
const days = allDays.filter((d) => d.bars.some((b) => { const m = etMinute(b.dt); return m >= 570 && m < 960; }));
const isoOf = (d) => { const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(d.date); return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`; };
const era = days.map((d) => (d.bars.some((b) => b.px) ? '2026' : 'pre'));

const VARIANTS = ['v6', 'v7', 'v8', 'v9'].flatMap((f) => [10, 20, 40].map((w) => `${f}-${w}`)).filter((v) => !VARS_ONLY.length || VARS_ONLY.includes(v));
const units = VARIANTS.map((v) => ({ key: v, variant: v }));

const ivAt = (iv, S) => (typeof iv === 'function' ? iv('C', S) : iv);
const r2 = (x) => Math.round(x * 100) / 100;

// Signal-side features at bar i for a position on `side` ('bull' loses as price falls). Every directional feature is
// oriented ADVERSE: positive = the market moving / sitting against the position.
function features(bars, i, side, ctxTrend, ev) {
  const dir = side === 'bull' ? -1 : 1;   // adverse direction in price
  const A = bars[i].analysis, c5 = A['5m'];
  const cl = (j) => bars[Math.max(0, j)].analysis['5m'].close;
  const adv = (n) => (c5.close - cl(i - n)) * dir;
  const ivB = ivAt(ev.iv, ev.S);
  const tauNow = bs.tauFromTime(bars[i].dt), tau15 = bs.tauFromTime(bars[i].dt + 15 * 60000);
  const sig15 = c5.close * ivB * Math.sqrt(Math.max(1e-9, tauNow - tau15));
  // zigzag on 5m closes since the session's first bar: length of the live leg, signed adverse
  let zz = { d: 0, piv: cl(0), ext: cl(0) };
  for (let j = 1; j <= i; j++) {
    const c = cl(j);
    if (zz.d === 0) { if (Math.abs(c - zz.piv) >= ZZ_THETA) { zz.d = Math.sign(c - zz.piv); zz.ext = c; } }
    else if (zz.d > 0) { if (c > zz.ext) zz.ext = c; else if (zz.ext - c >= ZZ_THETA) { zz.d = -1; zz.piv = zz.ext; zz.ext = c; } }
    else if (c < zz.ext) zz.ext = c; else if (c - zz.ext >= ZZ_THETA) { zz.d = 1; zz.piv = zz.ext; zz.ext = c; }
  }
  const legLen = zz.d === 0 ? 0 : Math.abs(c5.close - zz.piv);
  const runAdv = zz.d === 0 ? 0 : (zz.d === dir ? legLen : -legLen);
  const pbAdv = (tf) => { const a = A[tf]; const w = a.bbupper - a.bblower; if (!(w > 0)) return null; const pb = (c5.close - a.bblower) / w; return dir < 0 ? 1 - pb : pb; };
  const dLine = (tf, k) => { const a = A[tf]; const hw = (a.bbupper - a.bblower) / 2; return hw > 0 ? r2((c5.close - a[k]) * dir / hw) : null; };
  let ride15 = 0, ride60 = 0;
  for (let j = Math.max(0, i - 5); j <= i; j++) {
    const Aj = bars[j].analysis, cj = Aj['5m'].close;
    for (const [tf, set] of [['15m', (v) => { ride15 += v; }], ['60m', (v) => { ride60 += v; }]]) {
      const a = Aj[tf], w = a.bbupper - a.bblower; if (!(w > 0)) continue;
      const pb = (cj - a.bblower) / w; set((dir < 0 ? 1 - pb : pb) >= 0.9 ? 1 : 0);
    }
  }
  const orient = (t) => (t === 0 ? 0 : t === dir ? -1 : 1);   // +1 = trend WITH the position, -1 = against
  return {
    tod: etMinute(bars[i].dt), adv5: r2(adv(1)), adv15: r2(adv(3)), adv45: r2(adv(9)), z15: sig15 > 0 ? r2(adv(3) / sig15) : null,
    runAdv: r2(runAdv), pb15: pbAdv('15m') != null ? r2(pbAdv('15m')) : null, pb60: pbAdv('60m') != null ? r2(pbAdv('60m')) : null,
    ride15, ride60, t15: orient(TS.trendOf(A['15m'])), t60: orient(TS.trendOf(A['60m'])), tA: orient(TS.state(ctxTrend, 'A')),
    dEma15: dLine('15m', 'ema'), dMid15: dLine('15m', 'bbmiddle'), dEma60: dLine('60m', 'ema'), dMid60: dLine('60m', 'bbmiddle'),
    ivB: r2(ivB * 100) / 100,
  };
}

function computeUnit(u) {
  const { buildRuns } = require('../../server/src/candle-spread/index');
  const { optsFor } = require('../../server/src/candle-spread/backtest/opts-for');
  const run = buildRuns().find((r) => r.variant === u.variant);
  const o = optsFor(run, { intradayIV: true, hasPx: HAS_PX, where: 'study-giveup-regime', openFillModel: 'ladder', subBarFill: '1m' });
  const fn = (A, p, ctx) => run.signalFn(A, p, { ...ctx, cfg: run.signalCfg || {} });
  const W = run.spreadWidth;
  const out = [];
  let terminal = 0;
  days.forEach((d, di) => {
    const bars = d.bars, active = [];
    const trk = TS.makeTracker(); const ctxAt = [];
    for (let j = 0; j < bars.length; j++) ctxAt.push(trk(bars[j].analysis, bars[j].dt));
    const tap = {
      bar(i, S, px, tau, iv) {
        for (const e of active) {
          if (i <= e.i) continue;
          const fav = e.side === 'bull' ? px.high : px.low, advX = e.side === 'bull' ? px.low : px.high;
          e.path.push([i, eng.legsMark(e.legs, fav, tau, iv), eng.legsMark(e.legs, S, tau, iv), eng.legsMark(e.legs, advX, tau, iv)]);
        }
      },
      trigger(t) {
        const p = t.pos;
        active.push({ pos: p, i: t.i, side: p.side, legs: t.legs, openLegs: p.legs, openCost: t.openCost != null ? t.openCost : p.limit,
          mark0: t.mark, lim: t.lim, through: t.through, src: t.src, S: t.S, iv: t.iv, tau: t.tau, nowET: t.nowET,
          openMark0: eng.legsMark(p.legs, t.S, t.tau, t.iv), path: [] });
      },
    };
    const r = runDay5m(bars, fn, { ...o, giveUpTap: tap });
    terminal += r.terminal;
    const settle = r.settle;
    for (const e of active) {
      const BE = W - e.openCost;
      const openPay = eng.legsPayoff(e.openLegs, settle) - e.openCost;
      const covPay = eng.legsPayoff(e.legs, settle);
      const pnl = (cp) => Math.round((openPay + (cp == null ? 0 : covPay - cp)) * 100);
      const now = eng.roundTick(e.mark0 + TICK);
      const minFut = e.path.length ? Math.min(...e.path.map((x) => x[1])) : null;
      const maxAdvFut = e.path.length ? Math.max(...e.path.map((x) => x[3])) : null;
      const arms = { payNow: pnl(now), hold: pnl(null) };
      const fillBar = {};
      for (const K of KS) {
        const L = r2(BE + K * W);
        let cp = null, fb = null;
        if (now <= L + 1e-9) { cp = now; fb = e.i; }
        else for (const x of e.path) if (x[1] <= L + 1e-9) { cp = eng.roundTick(L); fb = x[0]; break; }
        arms['cap' + K] = pnl(cp); fillBar['cap' + K] = fb;
      }
      const p = e.pos;
      // ACTUAL: the engine's own cover (legs may differ — re-strike / wing-shift) or uncovered
      const actCov = p.covered && p.coverLegs ? Math.round((eng.legsPayoff(p.coverLegs, settle) - p.coverLimit) * 100) : 0;
      const actual = Math.round(openPay * 100) + actCov;
      out.push({
        di, date: isoOf(d), era: era[di], side: e.side, src: e.src, et: e.nowET.slice(-5), W,
        f: features(bars, e.i, e.side, ctxAt[e.i], e),
        through: r2(e.through), openFrac: r2(e.openMark0 / W), mark0: r2(e.mark0), BE: r2(BE), overBE: r2((now - BE) / W),
        minFut: minFut != null ? r2(minFut) : null, cameBackBE: minFut != null && minFut <= BE + 1e-9 ? 1 : 0,
        betterLater: minFut != null && minFut < now - 1e-9 ? 1 : 0, gainLater: minFut != null ? r2(Math.max(0, now - minFut) / W) : 0,
        maeFut: maxAdvFut != null ? r2((maxAdvFut - now) / W) : null, covSettle: r2(covPay), settleLossIfHold: arms.hold,
        arms, fillBarCur: fillBar['cap' + CUR_K[W]] != null ? fillBar['cap' + CUR_K[W]] - e.i : null,
        actual, actCovered: p.covered ? 1 : 0, actCoverMin: p.covered && p.coverEpoch ? Math.round((p.coverEpoch - bars[e.i].dt) / 60000) : null,
      });
    }
  });
  return { events: out, terminal: Math.round(terminal) };
}

// ── analysis ──
const sum = (a) => a.reduce((x, y) => x + y, 0);
const pctl = (a, q) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const usd = (n) => (n == null ? '' : (n < 0 ? '-' : '') + Math.abs(Math.round(n)).toLocaleString('en-US'));
let _seed = 12345; const rnd = () => { _seed = (_seed * 1103515245 + 12345) & 0x7fffffff; return _seed / 0x7fffffff; };
// day-clustered bootstrap CI (95%) of the SUM of x over events
function bootCI(evs, x, B = 400) {
  const byDay = new Map(); for (const e of evs) { const k = e.date; byDay.set(k, (byDay.get(k) || 0) + x(e)); }
  const v = [...byDay.values()]; if (!v.length) return [0, 0];
  const sims = []; for (let b = 0; b < B; b++) { let s = 0; for (let k = 0; k < v.length; k++) s += v[Math.floor(rnd() * v.length)]; sims.push(s); }
  return [pctl(sims, 0.025), pctl(sims, 0.975)];
}
const ciStr = (ci) => `[${usd(ci[0])}, ${usd(ci[1])}]`;
const ARM_ORDER = ['actual', 'capCur', 'payNow', 'cap0', 'cap0.025', 'cap0.05', 'cap0.075', 'cap0.1', 'cap0.15', 'cap0.25', 'hold'];
const armVal = (e, a) => (a === 'actual' ? e.actual : a === 'capCur' ? e.arms['cap' + CUR_K[e.W]] : e.arms[a]);
const uncovered = (e, a) => {
  if (a === 'actual') return e.actCovered ? 0 : 1;
  if (a === 'hold') return 1;
  if (a === 'payNow') return 0;
  const k = a === 'capCur' ? CUR_K[e.W] : Number(a.slice(3));
  const L = e.BE + k * e.W; const now = eng.roundTick(e.mark0 + TICK);
  return now <= L + 1e-9 || (e.minFut != null && e.minFut <= L + 1e-9) ? 0 : 1;
};

const BUCKETS = {
  z15: [-Infinity, 0, 0.5, 1, 1.5, 2, Infinity],
  adv15: [-Infinity, 0, 10, 20, 35, 60, Infinity],
  adv45: [-Infinity, 0, 20, 40, 70, 110, Infinity],
  adv5: [-Infinity, 0, 5, 10, 20, Infinity],
  runAdv: [-Infinity, 0, 40, 80, 120, Infinity],
  pb15: [-Infinity, 0.2, 0.5, 0.8, 1.0, Infinity],
  pb60: [-Infinity, 0.2, 0.5, 0.8, 1.0, Infinity],
  ride15: [-Infinity, 0.5, 1.5, 3.5, Infinity],
  ride60: [-Infinity, 0.5, 1.5, 3.5, Infinity],
  t15: [-Infinity, -0.5, 0.5, Infinity], t60: [-Infinity, -0.5, 0.5, Infinity], tA: [-Infinity, -0.5, 0.5, Infinity],
  dEma15: [-Infinity, -0.5, 0, 0.5, 1, Infinity], dMid15: [-Infinity, -0.5, 0, 0.5, 1, Infinity],
  dEma60: [-Infinity, -0.5, 0, 0.5, 1, Infinity], dMid60: [-Infinity, -0.5, 0, 0.5, 1, Infinity],
  tod: [570, 630, 720, 840, 900, 960],
  overBE: [-Infinity, 0, 0.05, 0.10, 0.2, Infinity],
  openFrac: [-Infinity, 0.15, 0.3, 0.45, Infinity],
};
const getF = (e, k) => (k === 'overBE' || k === 'openFrac' ? e[k] : e.f[k]);
const bucketOf = (k, v) => { if (v == null) return null; const ed = BUCKETS[k]; for (let j = 0; j < ed.length - 1; j++) if (v >= ed[j] && v < ed[j + 1]) return j; return null; };
const bLabel = (k, j) => { const ed = BUCKETS[k]; const f = (x) => (x === Infinity ? '+inf' : x === -Infinity ? '-inf' : k === 'tod' ? `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}` : x); return `[${f(ed[j])},${f(ed[j + 1])})`; };

(async () => {
  if (!IS_CHILD) console.log(`GIVE-UP REGIME — ${days.length} days (${era.filter((e) => e === '2026').length} NDX 2026), 1m sub-bars on ${n1m} days; ${units.length} variants on ${Math.min(workerCount(), units.length)} worker(s)`);
  // --cache <file>: reuse a previous run's events (analysis iterations only; the cache is not an output)
  const CACHE = argVal('--cache', null);
  let res;
  if (CACHE && fs.existsSync(CACHE)) res = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  else { res = await parallelMap(units, computeUnit); if (CACHE) fs.writeFileSync(CACHE, JSON.stringify(res)); }
  fs.mkdirSync(OUT, { recursive: true });
  const md = [];
  const P = (s) => { md.push(s); console.log(s); };
  P(`# Give-up regime study (2026-10-19, study only)\n`);
  P(`Days ${days.length} (${days[0].date}..${days[days.length - 1].date}; ${era.filter((e) => e === '2026').length} real-NDX 2026). Roster v6-v9 x 10/20/40, baseline settings (optsFor, ladder opens, 1m sub-bars). Event = the FIRST give-up of a position. Arms are per-position counterfactuals (governor/book effects not re-simulated); actual = what the engine did. $ = position P&L (open + cover at settle) x100, summed.\n`);
  P(`Terminal check (tap must be inert; compare backtest-baselines-combined): ` + VARIANTS.map((v) => `${v} ${usd(res[v].terminal)}`).join(' | ') + '\n');

  // CSV of every event
  const csvCols = ['variant', 'date', 'era', 'side', 'src', 'et', 'W', 'through', 'openFrac', 'mark0', 'BE', 'overBE', 'minFut', 'cameBackBE', 'betterLater', 'gainLater', 'maeFut', 'covSettle',
    ...Object.keys(BUCKETS).filter((k) => k !== 'overBE' && k !== 'openFrac'), 'actual', 'actCovered', 'actCoverMin', 'fillBarCur', ...ARM_ORDER.filter((a) => a !== 'actual')];
  const csv = [csvCols.join(',')];
  let all = [];
  for (const v of VARIANTS) for (const e of res[v].events) {
    e.variant = v; all.push(e);
    csv.push(csvCols.map((c) => (c === 'variant' ? v : c in e ? e[c] : c in e.f ? e.f[c] : (ARM_ORDER.includes(c) ? armVal(e, c) : ''))).map((x) => (x == null ? '' : x)).join(','));
  }
  fs.writeFileSync(path.join(OUT, 'events.csv'), csv.join('\n') + '\n');

  // 1. counts
  P(`## 1. Events per variant\n`);
  P('```');
  P('variant   events  /day  points  c2o  other  within-cur-allow%  cameBackBE%  betterLater%  actual-uncov%  hold-loss-med  actCoverMin-med');
  for (const v of VARIANTS) {
    const E = res[v].events; if (!E.length) { P(`${v} 0`); continue; }
    const W = E[0].W, within = E.filter((e) => e.overBE <= CUR_K[W] + 1e-9).length;
    P([v.padEnd(8), String(E.length).padStart(6), (E.length / days.length).toFixed(2).padStart(5), String(E.filter((e) => e.src === 'points').length).padStart(7), String(E.filter((e) => e.src === 'c2o').length).padStart(4), String(E.filter((e) => e.src === 'other').length).padStart(6),
      (100 * within / E.length).toFixed(1).padStart(18), (100 * sum(E.map((e) => e.cameBackBE)) / E.length).toFixed(1).padStart(12), (100 * sum(E.map((e) => e.betterLater)) / E.length).toFixed(1).padStart(13),
      (100 * E.filter((e) => !e.actCovered).length / E.length).toFixed(1).padStart(14), usd(pctl(E.map((e) => e.arms.hold), 0.5)).padStart(14), String(pctl(E.filter((e) => e.actCoverMin != null).map((e) => e.actCoverMin), 0.5)).padStart(16)].join(' '));
  }
  P('```\n');

  // 2. arms per variant
  P(`## 2. Counterfactual arms per variant (sum $ | uncovered at close | worst position | 5th pct)\n`);
  P(`capCur = static current allowance (10W 5% / 20W 7.5% / 40W 10%); cap0 = wait for break-even; payNow = mark + tick unbounded. CI = day-clustered 95% bootstrap of (arm - capCur).\n`);
  P('```');
  for (const v of VARIANTS) for (const src of ['points', 'c2o']) {
    const E = res[v].events.filter((e) => e.src === src); if (!E.length) continue;
    P(`${v} ${src} (${E.length} events)`);
    for (const a of ARM_ORDER) {
      const vals = E.map((e) => armVal(e, a));
      const ci = a === 'capCur' ? null : bootCI(E, (e) => armVal(e, a) - armVal(e, 'capCur'));
      P(`  ${a.padEnd(9)} ${usd(sum(vals)).padStart(11)}  uncov ${String(sum(E.map((e) => uncovered(e, a)))).padStart(5)}  worst ${usd(Math.min(...vals)).padStart(7)}  p5 ${usd(pctl(vals, 0.05)).padStart(7)}${ci ? `  d vs capCur ${usd(sum(vals) - sum(E.map((e) => armVal(e, 'capCur')))).padStart(9)} CI ${ciStr(ci)}` : ''}`);
    }
  }
  P('```\n');

  // 3. per-feature buckets, pooled by width. Decision columns:
  //   came back % ; mean $ (payNow - cap0) = what paying now is worth vs waiting for break-even ; mean $ (payNow - capCur)
  // Sections 3-5: TRUE give-ups only (the points trigger). Cover-to-open escalations (src c2o, v6-v8) are a different
  // decision (an open is waiting on them) and are reported in section 2 only.
  const allEv = all; all = allEv.filter((e) => e.src === 'points');
  P(`Sections 3-5 use the ${all.length} points-trigger give-ups only (c2o escalations: ${allEv.length - all.length}, section 2 only).\n`);
  P(`## 3. Feature buckets (pooled v6-v9, per width)\n`);
  P(`n | cameBackBE% | mean gainLater (x W) | sum (payNow - cap0) $ [CI] | sum (payNow - capCur) $ [CI] | hold-loss mean. Positive (payNow - X) = paying now beat X in that bucket.\n`);
  const bucketRows = [];
  for (const W of [10, 20, 40]) {
    const E = all.filter((e) => e.W === W);
    P(`### ${W}W (${E.length} events)\n`); P('```');
    for (const k of Object.keys(BUCKETS)) {
      P(`${k}`);
      const ed = BUCKETS[k];
      for (let j = 0; j < ed.length - 1; j++) {
        const B = E.filter((e) => bucketOf(k, getF(e, k)) === j); if (B.length < 20) continue;
        const d0 = (e) => e.arms.payNow - e.arms.cap0, dc = (e) => e.arms.payNow - armVal(e, 'capCur');
        const ci0 = bootCI(B, d0, 200), cic = bootCI(B, dc, 200);
        const row = { W, feature: k, bucket: bLabel(k, j), n: B.length, cameBackPct: r2(100 * sum(B.map((e) => e.cameBackBE)) / B.length), gainLater: r2(sum(B.map((e) => e.gainLater)) / B.length),
          payNowMinusCap0: sum(B.map(d0)), ci0, payNowMinusCur: sum(B.map(dc)), cic, holdMean: Math.round(sum(B.map((e) => e.arms.hold)) / B.length) };
        bucketRows.push(row);
        P(`  ${row.bucket.padEnd(14)} n ${String(B.length).padStart(5)}  back ${row.cameBackPct.toFixed(1).padStart(5)}%  gain ${row.gainLater.toFixed(3)}  pay-cap0 ${usd(row.payNowMinusCap0).padStart(9)} ${ciStr(ci0).padEnd(22)} pay-cur ${usd(row.payNowMinusCur).padStart(9)} ${ciStr(cic).padEnd(22)} hold ${usd(row.holdMean)}`);
      }
    }
    P('```\n');
  }
  fs.writeFileSync(path.join(OUT, 'buckets.csv'), ['W,feature,bucket,n,cameBackPct,gainLater,payNowMinusCap0,ci0lo,ci0hi,payNowMinusCur,ciclo,cichi,holdMean']
    .concat(bucketRows.map((r) => [r.W, r.feature, `"${r.bucket}"`, r.n, r.cameBackPct, r.gainLater, r.payNowMinusCap0, r.ci0[0], r.ci0[1], r.payNowMinusCur, r.cic[0], r.cic[1], r.holdMean].join(','))).join('\n') + '\n');

  // 4. rule search: "pay now when feature in its top/bottom region, else wait at break-even (cap0)" — and the mirror
  //    "pay capCur by default, but wait for break-even when ..." — chosen on the EARLY half, scored on LATE half + 2026.
  P(`## 4. Simple regime rules (selected on the early half of pre-2026 days, tested on the late half and on 2026)\n`);
  P(`Rule R(feature, thr, dirn, hi, lo): event with feature on the 'hi' side of thr -> arm hi, else arm lo. Score = sum $ vs capCur and uncovered-at-close vs capCur (negative uncov = fewer uncovered).\n`);
  const preDays = [...new Set(all.filter((e) => e.era === 'pre').map((e) => e.date))].sort();
  const mid = preDays[Math.floor(preDays.length / 2)];
  const half = (e) => (e.era === '2026' ? '2026' : e.date < mid ? 'early' : 'late');
  const ARMPAIRS = [['payNow', 'capCur'], ['payNow', 'cap0'], ['capCur', 'cap0'], ['cap0.15', 'cap0'], ['cap0.15', 'capCur'], ['payNow', 'cap0.05']];
  const feats = Object.keys(BUCKETS).filter((k) => !['t15', 't60', 'tA'].includes(k)).concat(['t15', 't60', 'tA']);
  const ruleRows = [];
  P('```');
  for (const W of [10, 20, 40]) {
    const E = all.filter((e) => e.W === W);
    const parts = { early: E.filter((e) => half(e) === 'early'), late: E.filter((e) => half(e) === 'late'), y2026: E.filter((e) => half(e) === '2026') };
    const score = (S, fn) => { let d = 0, u = 0; for (const e of S) { const a = fn(e); d += armVal(e, a) - armVal(e, 'capCur'); u += uncovered(e, a) - uncovered(e, 'capCur'); } return { d: Math.round(d), u }; };
    const cands = [];
    for (const k of feats) {
      const vals = E.map((e) => getF(e, k)).filter((x) => x != null);
      const lo = Math.min(...vals), hi = Math.max(...vals);
      const thrs = [...new Set([0.2, 0.4, 0.6, 0.8].map((q) => pctl(vals, q)))].filter((t) => t > lo && t <= hi);
      for (const thr of thrs) for (const [hi, lo] of ARMPAIRS) for (const flip of [false, true]) {
        const fn = (e) => { const x = getF(e, k); const isHi = x != null && (flip ? x < thr : x >= thr); return isHi ? hi : lo; };
        cands.push({ k, thr, flip, hi, lo, fn, early: score(parts.early, fn) });
      }
    }
    // also the plain arms as reference
    for (const a of ['payNow', 'cap0', 'cap0.15', 'hold']) cands.push({ k: '(all)', thr: '', flip: false, hi: a, lo: a, fn: () => a, early: score(parts.early, () => a) });
    cands.sort((x, y) => y.early.d - x.early.d);
    const riskSorted = [...cands].sort((x, y) => (x.early.u - y.early.u) || (y.early.d - x.early.d));
    P(`${W}W — early ${parts.early.length} / late ${parts.late.length} / 2026 ${parts.y2026.length} events. Top 6 by $ on early, then top 6 by fewest uncovered on early:`);
    const show = (c) => { const L = score(parts.late, c.fn), Y = score(parts.y2026, c.fn);
      const lbl = c.k === '(all)' ? `all -> ${c.hi}` : `${c.k} ${c.flip ? '<' : '>='} ${c.thr} -> ${c.hi}, else ${c.lo}`;
      ruleRows.push({ W, rule: lbl, earlyD: c.early.d, earlyU: c.early.u, lateD: L.d, lateU: L.u, y26D: Y.d, y26U: Y.u });
      P(`  ${lbl.padEnd(46)} early ${usd(c.early.d).padStart(9)} u${String(c.early.u).padStart(5)} | late ${usd(L.d).padStart(9)} u${String(L.u).padStart(5)} | 2026 ${usd(Y.d).padStart(8)} u${String(Y.u).padStart(4)}`); };
    cands.slice(0, 6).forEach(show); P('  --'); riskSorted.slice(0, 6).forEach(show);
    P('  -- reference'); cands.filter((c) => c.k === '(all)').forEach(show);
  }
  P('```\n');
  fs.writeFileSync(path.join(OUT, 'rules.csv'), ['W,rule,earlyD,earlyU,lateD,lateU,y26D,y26U'].concat(ruleRows.map((r) => [r.W, `"${r.rule}"`, r.earlyD, r.earlyU, r.lateD, r.lateU, r.y26D, r.y26U].join(','))).join('\n') + '\n');

  // 6. two-feature rules + hand-written candidates, scored with DAY-level risk (sum of the give-up positions' P&L per day)
  P(`## 6. Hand-written regime rules and best two-feature rules (day-level risk)\n`);
  P(`Per rule and part: sum $ vs capCur | uncovered-at-close vs capCur | worst day and 5th-pct day of the give-up positions' summed P&L (rule vs capCur). Two-feature rules are selected on the EARLY half (top 4 by $, then top 4 by fewest uncovered with $ >= capCur), tested on late + 2026.\n`);
  const dayRisk = (S, fn) => { const m = new Map(); for (const e of S) m.set(e.date, (m.get(e.date) || 0) + armVal(e, fn(e))); const v = [...m.values()]; return { worst: v.length ? Math.min(...v) : 0, p5: pctl(v, 0.05) || 0 }; };
  const full = (S, fn) => { let d = 0, u = 0; for (const e of S) { const a = fn(e); d += armVal(e, a) - armVal(e, 'capCur'); u += uncovered(e, a) - uncovered(e, 'capCur'); }
    const r = dayRisk(S, fn), c = dayRisk(S, () => 'capCur'); return { d: Math.round(d), u, w: Math.round(r.worst - c.worst), p5: Math.round(r.p5 - c.p5) }; };
  const fmt = (x) => `${usd(x.d).padStart(9)} u${String(x.u).padStart(5)} wd${usd(x.w).padStart(7)} p5d${usd(x.p5).padStart(7)}`;
  const HAND = [
    ['tod>=15:00 -> payNow, else capCur', (e) => (e.f.tod >= 900 ? 'payNow' : 'capCur')],
    ['tod>=14:00 -> payNow, else capCur', (e) => (e.f.tod >= 840 ? 'payNow' : 'capCur')],
    ['tod>=15:00 -> payNow, else cap0', (e) => (e.f.tod >= 900 ? 'payNow' : 'cap0')],
    ['overBE<0.12 -> payNow, else cap0', (e) => (e.overBE < 0.12 ? 'payNow' : 'cap0')],
    ['overBE<0.12 -> payNow, else capCur', (e) => (e.overBE < 0.12 ? 'payNow' : 'capCur')],
    ['z15>=2 & pb15>=1 -> payNow, else capCur', (e) => (e.f.z15 >= 2 && e.f.pb15 >= 1 ? 'payNow' : 'capCur')],
    ['z15>=2 & ride15>=4 -> payNow, else capCur', (e) => (e.f.z15 >= 2 && e.f.ride15 >= 4 ? 'payNow' : 'capCur')],
    ['z15>=1.5 & t60 against -> payNow, else capCur', (e) => (e.f.z15 >= 1.5 && e.f.t60 < 0 ? 'payNow' : 'capCur')],
    ['z15>=1.5 & tA against -> payNow, else capCur', (e) => (e.f.z15 >= 1.5 && e.f.tA < 0 ? 'payNow' : 'capCur')],
    ['z15<1 & pb15>=0.8 -> cap0, else capCur', (e) => (e.f.z15 < 1 && e.f.pb15 >= 0.8 ? 'cap0' : 'capCur')],
    ['pb15>=1 | pb60>=1 -> cap0, else capCur', (e) => (e.f.pb15 >= 1 || e.f.pb60 >= 1 ? 'cap0' : 'capCur')],
    ['runAdv>=80 -> cap0, else capCur', (e) => (e.f.runAdv >= 80 ? 'cap0' : 'capCur')],
    ['all -> cap0', () => 'cap0'], ['all -> payNow', () => 'payNow'], ['all -> cap0.15', () => 'cap0.15'],
  ];
  const F2 = ['z15', 'adv15', 'adv45', 'runAdv', 'pb15', 'pb60', 'ride15', 'ride60', 't60', 'tA', 'dEma15', 'dMid60', 'tod', 'openFrac', 'overBE'];
  P('```');
  for (const W of [10, 20, 40]) {
    const E = all.filter((e) => e.W === W);
    const parts = { early: E.filter((e) => half(e) === 'early'), late: E.filter((e) => half(e) === 'late'), y2026: E.filter((e) => half(e) === '2026') };
    P(`${W}W                                              early                                   | late                                    | 2026`);
    const line = (lbl, fn, early) => { const a = early || full(parts.early, fn); P(`  ${lbl.padEnd(46)} ${fmt(a)} | ${fmt(full(parts.late, fn))} | ${fmt(full(parts.y2026, fn))}`);
      ruleRows.push({ W, rule: lbl, earlyD: a.d, earlyU: a.u, lateD: null, lateU: null, y26D: null, y26U: null }); };
    for (const [lbl, fn] of HAND) line(lbl, fn);
    // conditions: feature >= q-threshold or < q-threshold
    const conds = [];
    for (const k of F2) {
      const vals = E.map((e) => getF(e, k)).filter((x) => x != null); const lo = Math.min(...vals), hi = Math.max(...vals);
      for (const q of [0.2, 0.5, 0.8]) { const t = pctl(vals, q); if (!(t > lo && t <= hi)) continue;
        conds.push({ lbl: `${k}>=${t}`, fn: (e) => { const x = getF(e, k); return x != null && x >= t; }, k });
        conds.push({ lbl: `${k}<${t}`, fn: (e) => { const x = getF(e, k); return x != null && x < t; }, k }); }
    }
    const cands2 = [];
    const AP = [['payNow', 'capCur'], ['cap0', 'capCur'], ['payNow', 'cap0'], ['capCur', 'cap0']];
    // fast early scoring: precompute per-event deltas per arm
    const early = parts.early;
    const dl = {}; for (const a of ['payNow', 'capCur', 'cap0']) dl[a] = early.map((e) => [armVal(e, a) - armVal(e, 'capCur'), uncovered(e, a) - uncovered(e, 'capCur')]);
    const mask = conds.map((c) => early.map((e) => c.fn(e)));
    for (let x = 0; x < conds.length; x++) for (let y = x + 1; y < conds.length; y++) {
      if (conds[x].k === conds[y].k) continue;
      for (const [hiA, loA] of AP) {
        let d = 0, u = 0;
        for (let n = 0; n < early.length; n++) { const a = mask[x][n] && mask[y][n] ? hiA : loA; d += dl[a][n][0]; u += dl[a][n][1]; }
        cands2.push({ x, y, hiA, loA, d, u });
      }
    }
    const byD = [...cands2].sort((p1, p2) => p2.d - p1.d).slice(0, 4);
    const byU = cands2.filter((c) => c.d >= 0).sort((p1, p2) => (p1.u - p2.u) || (p2.d - p1.d)).slice(0, 4);
    P('  -- best two-feature by $ (early), then fewest uncovered with $ >= capCur (early)');
    for (const c of byD.concat(byU)) {
      const fn = (e) => (conds[c.x].fn(e) && conds[c.y].fn(e) ? c.hiA : c.loA);
      line(`${conds[c.x].lbl} & ${conds[c.y].lbl} -> ${c.hiA}, else ${c.loA}`, fn);
    }
  }
  P('```\n');

  // 5. did it come back? logistic-free separation: cameBackBE% by the two strongest features, cross-tab (pooled per width)
  P(`## 5. Came-back rate cross-tab: z15 bucket x pb15 bucket (pooled, per width) — n / cameBackBE%\n`);
  P('```');
  for (const W of [10, 20, 40]) {
    const E = all.filter((e) => e.W === W); P(`${W}W`);
    const zb = BUCKETS.z15, pb = BUCKETS.pb15;
    P('  z15\\pb15      ' + Array.from({ length: pb.length - 1 }, (_, j) => bLabel('pb15', j).padStart(15)).join(''));
    for (let a = 0; a < zb.length - 1; a++) {
      let line = '  ' + bLabel('z15', a).padEnd(13);
      for (let b = 0; b < pb.length - 1; b++) { const B = E.filter((e) => bucketOf('z15', e.f.z15) === a && bucketOf('pb15', e.f.pb15) === b); line += (B.length ? `${B.length}/${(100 * sum(B.map((e) => e.cameBackBE)) / B.length).toFixed(0)}%` : '-').padStart(15); }
      P(line);
    }
  }
  P('```\n');
  P(`Wall ${Math.round((Date.now() - t0) / 1000)}s, workers ${workerCount()}. Script: scripts/candle-spread/study-giveup-regime.js (hook: runDay5m opts.giveUpTap, default unset = inert).`);
  fs.writeFileSync(path.join(OUT, 'summary.md'), md.join('\n') + '\n');
  console.log(`wrote ${OUT}`);
})().catch((e) => { console.error(e); process.exit(1); });
