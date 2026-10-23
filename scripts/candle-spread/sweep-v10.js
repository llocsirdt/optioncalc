#!/usr/bin/env node
'use strict';
/**
 * v10 / v11 SWEEP — BACKTEST ONLY. Runs the target engine (backtest-target.js) per family x width variant x arm, plus
 * the v6-v9 roster CONTROLS through runDay5m on the SAME days with the baseline build's settings (optsFor, ladder
 * opens, 1m sub-bar fills). Never writes the canon baselines and never touches the live roster.
 *
 * Usage: node scripts/candle-spread/sweep-v10.js [--dataDir tests/backtest/backtest-data-5m-combined]
 *          [--sub1m signal-lab-data/raw-1m] [--subBarFill 1m] [--openFillModel ladder] [--workers 8]
 *          [--out data/sweeps/v10-v11-2026-10-16] [--arms base,market,...] [--variants v10-20,v11-sig,...] [--noControls]
 */
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..', '..');
const { runDay5m, load5mDays, attachSub1m } = require('../../server/src/candle-spread/backtest/backtest-v6-5m');
const TG = require('../../server/src/candle-spread/backtest/backtest-target');
const { parallelMap, workerCount } = require('./lib/parallel');

const argVal = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const DIR = argVal('--dataDir', path.join(ROOT, 'tests', 'backtest', 'backtest-data-5m-combined'));
const SUB1M = argVal('--sub1m', path.join(ROOT, 'signal-lab-data', 'raw-1m'));
const SUB_FILL = argVal('--subBarFill', '1m');
const OPEN_FILL = argVal('--openFillModel', 'ladder');
const OUT = argVal('--out', path.join(ROOT, 'data', 'sweeps', 'v10-v11-2026-10-16'));
const ARMS_ONLY = (argVal('--arms', '') || '').split(',').filter(Boolean);
const VARS_ONLY = (argVal('--variants', '') || '').split(',').filter(Boolean);
const NO_CONTROLS = process.argv.includes('--noControls');
const IS_CHILD = process.argv.includes('--_slice');
// --overlay: the v11 TOUCH OVERLAY on the roster v6-v9 engines (runDay5m opts.touch*), instead of the target engines.
// --stackGate: the NDX-trend gate on ADDS (runDay5m opts.stackGate / stackScope) on the same roster variants.
const STACK = process.argv.includes('--stackGate');
// --natural: the v12/v13 natural-cover families (runDay5m opts.natural on the v6-W roster config) + v6/v7 controls +
// the v7 reference arm with per-position covers off.
const NATURAL = process.argv.includes('--natural');
// --roster v9,v9sg,v9ob: every ROSTER variant of those families, as configured (feature-test families, 2026-10-19).
const ROSTER_FAMS = (argVal('--roster', '') || '').split(',').filter(Boolean);
// --takeNow: give-up TAKE-NOW (runDay5m opts.giveUpTakeNowFrac, 2026-10-20) on v6-v9 (+ v9sg/v9ob) roster variants.
const TAKENOW = process.argv.includes('--takeNow');
// --bbFade: v20 / v21 BB-FADE families (2026-10-21, backtest only): open on a 5m close beyond BOTH the 15m and 60m
// bands (signals/bb-fade.js), everything after the open = the v9 roster machinery. v20 = v9 strike placement (sATM +
// cATM); v21 = strike priced closest to f x W (backtest-width.makePriceTargetGeo), f from --fFracs (default .50,.55,.60).
// The v9 roster variants run alongside as controls.
const BBFADE = process.argv.includes('--bbFade');
// --opensOnly (with --bbFade; user 2026-10-21): v20/v21 carry NO v9 machinery — opens held to expiry, no covers or hedges;
// risk cap + open walk ladder kept (backtest/opens-only.js). Each gets a -unc twin (no cap). v9 controls unchanged.
const OPENS_ONLY = process.argv.includes('--opensOnly');
const F_FRACS = (argVal('--fFracs', '0.50,0.55,0.60') || '').split(',').filter(Boolean).map(Number);
const OVERLAY = process.argv.includes('--overlay') || STACK || NATURAL || TAKENOW || BBFADE || ROSTER_FAMS.length > 0;

// ── days (same filter as the baselines) ──
const t0 = Date.now();
const allDays = load5mDays(DIR);
const n1m = SUB_FILL === '1m' && fs.existsSync(SUB1M) ? attachSub1m(allDays, SUB1M) : 0;
const HAS_PX = allDays.some((d) => d.bars.some((b) => b.px));
const priceOf = (b) => b.px || { open: b.analysis['5m'].open, close: b.analysis['5m'].close, high: b.analysis['5m'].high, low: b.analysis['5m'].low };
const etMin = TG.etMin;
const days = allDays.filter((d) => d.bars.some((b) => { const m = etMin(b.dt); return m >= 570 && m < 960; }));
const isoOf = (d) => { const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(d.date); return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`; };
const era = days.map((d) => (d.bars.some((b) => b.px) ? '2026' : 'pre'));

// ── NDX-RTH context: dataset sessions + raw-1m NDX sessions the dataset lacks (2026-07-06..07-20) ──
let settles = {};
try { settles = JSON.parse(fs.readFileSync(path.join(DIR, 'settles.json'), 'utf8')); } catch (e) { /* none */ }
const sessions = [];
const have = new Set();
for (const d of days) { const iso = isoOf(d); const s = TG.sessionFromBars(iso, d.bars, priceOf, settles); if (s) { sessions.push(s); have.add(iso); } }
let rawAdded = 0;
if (fs.existsSync(SUB1M)) {
  for (const f of fs.readdirSync(SUB1M)) {
    const mm = /^NDX-(\d{4}-\d{2}-\d{2})\.json$/.exec(f); if (!mm || have.has(mm[1])) continue;
    try { const s = TG.sessionFrom1m(mm[1], JSON.parse(fs.readFileSync(path.join(SUB1M, f), 'utf8')).candles, settles); if (s) { sessions.push(s); rawAdded++; } } catch (e) { /* skip */ }
  }
}
const CTX = TG.buildRthContexts(sessions, 8);
// MEDIAN 15m-band IV over every RTH bar of the dataset (the jump guard's IV scale; runDay5m ivOf = ivFromRelBandWidth)
const MEDIAN_IV = (() => { const bsP = require('../../server/src/candle-spread/bs-pricer'), v = [];
  for (const d of days) for (const b of d.bars) { const m = etMin(b.dt); if (m >= 575 && m <= 955) { const a = b.analysis['15m']; v.push(bsP.ivFromRelBandWidth((a.bbupper - a.bblower) / a.close)); } }
  v.sort((x, y) => x - y); return v[Math.floor(v.length / 2)]; })();

// ── variants / arms ──
const FAMS = ['v10', 'v11'];
const WIDTHS = [10, 20, 40, 'sig', 'mix'];
const VARIANTS = [];
for (const fam of FAMS) for (const w of WIDTHS) VARIANTS.push({ name: `${fam}-${w}`, family: fam, width: w });
const ARMS = {
  v10: [['base', {}], ['market', { entry: 'market' }], ['rthGateOff', { rthGate: false }], ['noGapFadeOff', { noGapFade: false }],
    ['bookRejectOff', { bookReject: false }], ['farOtmBanOff', { farOtmBan: false }], ['flyOff', { fly: false }], ['target60Off', { target60: false }],
    ['prem05', { giveUpMaxLoss: 0.05 }], ['prem10', { giveUpMaxLoss: 0.10 }], ['prem15', { giveUpMaxLoss: 0.15 }], ['guPointsOff', { giveUpPoints: false }]],
  v11: [['base', {}], ['market', { entry: 'market' }], ['noGapFadeOff', { noGapFade: false }], ['bookRejectOff', { bookReject: false }],
    ['trendBothOff', { trendBoth: false }], ['eodFlatOff', { eodFlat: false }], ['f33', { f: 0.33 }], ['f67', { f: 0.67 }], ['cut1030', { v11Cutoff: 630 }],
    ['prem05', { giveUpMaxLoss: 0.05 }], ['prem10', { giveUpMaxLoss: 0.10 }], ['prem15', { giveUpMaxLoss: 0.15 }],
    ['minDist10', { minDist: 0.10 }], ['maxDist15', { maxDist: 1.5 }], ['trendBothOffLadder', { trendBoth: false, v11Next: 'ladder' }], ['noChase', { chase: false }], ['guPointsOff', { giveUpPoints: false }], ['nextLadder', { v11Next: 'ladder' }], ['nextTrend', { v11Next: 'trend' }],
    ['reentry0', { reentryBars: 0 }], ['reentry3', { reentryBars: 3 }]],
};
const CONTROLS = ['v6', 'v7', 'v8', 'v9'].flatMap((f) => [10, 20, 40].map((w) => `${f}-${w}`));

const OVERLAY_ARMS = [['base', {}], ['touchBe', { touchCover: 'be' }], ['touchGu', { touchCover: 'gu' }], ['touchBeAny', { touchCover: 'be', touchAnyTime: true }],
  ['touchBeLadder', { touchCover: 'be', touchTarget: 'ladder' }], ['filterBlock', { touchFilter: 'block-against' }], ['filterRequire', { touchFilter: 'require' }],
  ['touchBeFilterBlock', { touchCover: 'be', touchFilter: 'block-against' }]];
const STACK_ARMS = [['base', {}], ['notAgainst', { stackGate: 'notAgainst' }], ['oneWith', { stackGate: 'oneWith' }], ['rth15', { stackGate: 'rth15' }],
  ['rth60', { stackGate: 'rth60' }], ['nqNotAgainst', { stackGate: 'nqNotAgainst' }], ['notAgainstAny', { stackGate: 'notAgainst', stackScope: 'any' }],
  ['oneWithAny', { stackGate: 'oneWith', stackScope: 'any' }]];
const NAT_ARMS = [['base', {}], ['revTouchAny', { revTouch: 'any' }], ['revTouchOff', { revTouch: 'off' }], ['revWindowOff', { revWindowMin: false }],
  ['revRunOff', { revRun: false }], ['revRun25', { revRun: 25 }], ['revStrikeCurve', { revStrike: 'curve' }], ['revStrikeCost', { revStrike: 'cost' }],
  ['jumpGuardOff', { jumpGuard: false }], ['guardX1.5', { guardMult: 1.5 }], ['guard50', { guardFixed: 50 }], ['guard100', { guardFixed: 100 }], ['guardAtTarget', { guardAt: 'target' }],
  ['addGateOff', { addGate: false }]];
const NAT_V13 = [['coverAfter15', { coverAfterMin: 15 }], ['coverAfter60', { coverAfterMin: 60 }]];
const TAKENOW_ARMS = [['off', {}], ['tn08', { giveUpTakeNowFrac: 0.08 }], ['tn10', { giveUpTakeNowFrac: 0.10 }], ['tn12', { giveUpTakeNowFrac: 0.12 }],
  ['tn15', { giveUpTakeNowFrac: 0.15 }]];
const units = [];
if (BBFADE) {
  const { buildRuns } = require('../../server/src/candle-spread/index');
  const shapes = ['10', '20', '40', '10-cATM', '20-cATM', '40-cATM'];
  const has = (n) => buildRuns().some((r) => r.variant === n);
  const want = (n) => !VARS_ONLY.length || VARS_ONLY.includes(n);
  for (const sh of shapes) if (has(`v9-${sh}`) && want(`v9-${sh}`)) units.push({ key: `v9-${sh}|control`, kind: 'control', variant: `v9-${sh}`, arm: 'control' });
  const arm = OPENS_ONLY ? 'opensOnly' : 'bbFade';
  const twins = OPENS_ONLY ? ['', '-unc'] : [''];
  for (const sh of shapes) for (const t of twins) if (has(`v9-${sh}`) && want(`v20-${sh}${t}`)) units.push({ key: `v20-${sh}${t}|${arm}`, kind: 'control', variant: `v9-${sh}`, label: `v20-${sh}${t}`, arm, bbFade: true, opensOnly: OPENS_ONLY, unc: t === '-unc' });
  for (const w of [10, 20, 40]) for (const f of F_FRACS) for (const t of twins) {
    const name = `v21-${w}-f${Math.round(f * 100)}${t}`;
    if (has(`v9-${w}`) && want(name)) units.push({ key: `${name}|${arm}`, kind: 'control', variant: `v9-${w}`, label: name, arm, bbFade: true, priceF: f, opensOnly: OPENS_ONLY, unc: t === '-unc' });
  }
} else
if (TAKENOW) {
  const { buildRuns } = require('../../server/src/candle-spread/index');
  const fams = ['v6', 'v7', 'v8', 'v9', 'v9sg', 'v9ob'];
  for (const fam of fams) for (const w of [10, 20, 40]) {
    const c = `${fam}-${w}`;
    if (!buildRuns().some((r) => r.variant === c)) continue;
    for (const [arm, over] of TAKENOW_ARMS) {
      if ((VARS_ONLY.length && !VARS_ONLY.includes(c)) || (ARMS_ONLY.length && !ARMS_ONLY.includes(arm))) continue;
      units.push({ key: `${c}|${arm}`, kind: 'control', variant: c, arm, over });
    }
  }
} else
if (ROSTER_FAMS.length) {
  const { buildRuns } = require('../../server/src/candle-spread/index');
  for (const r of buildRuns()) {
    const fam = (/^(v\d+[a-z]*)-/.exec(r.variant) || [])[1];
    if (ROSTER_FAMS.includes(fam)) units.push({ key: `${r.variant}|roster`, kind: 'control', variant: r.variant, arm: 'roster' });
  }
} else
if (NATURAL) {
  for (const w of [10, 20, 40]) {
    for (const fam of ['v12', 'v13']) for (const [arm, over] of NAT_ARMS.concat(fam === 'v13' ? NAT_V13 : [])) {
      const name = `${fam}-${w}`;
      if ((VARS_ONLY.length && !VARS_ONLY.includes(name)) || (ARMS_ONLY.length && !ARMS_ONLY.includes(arm))) continue;
      units.push({ key: `${name}|${arm}`, kind: 'control', variant: `v6-${w}`, label: name, arm, over: { natural: fam, ...over } });
    }
    for (const c of [`v6-${w}`, `v7-${w}`]) if (!VARS_ONLY.length || VARS_ONLY.includes(c)) units.push({ key: `${c}|control`, kind: 'control', variant: c, arm: 'control' });
    if (!VARS_ONLY.length || VARS_ONLY.includes(`v7-${w}-nocov`)) units.push({ key: `v7-${w}-nocov|reference`, kind: 'control', variant: `v7-${w}`, label: `v7-${w}-nocov`, arm: 'reference', over: { perPositionCovers: false } });
  }
} else
if (OVERLAY) {
  for (const c of CONTROLS) for (const [arm, over] of (STACK ? STACK_ARMS : OVERLAY_ARMS)) {
    if ((VARS_ONLY.length && !VARS_ONLY.includes(c)) || (ARMS_ONLY.length && !ARMS_ONLY.includes(arm))) continue;
    units.push({ key: `${c}|${arm}`, kind: 'control', variant: c, arm, over });
  }
} else
for (const v of VARIANTS) {
  if (VARS_ONLY.length && !VARS_ONLY.includes(v.name)) continue;
  for (const [arm, over] of ARMS[v.family]) {
    if (ARMS_ONLY.length && !ARMS_ONLY.includes(arm)) continue;
    units.push({ key: `${v.name}|${arm}`, kind: 'target', v, arm, over });
  }
}
if (!NO_CONTROLS && !OVERLAY) for (const c of CONTROLS) if (!VARS_ONLY.length || VARS_ONLY.includes(c)) units.push({ key: `${c}|control`, kind: 'control', variant: c, arm: 'control' });

// one compact record per day
const slim = (r) => ({ t: r.terminal, o: r.opens, f: r.filled, n: r.naked, ue: r.uncoveredEod || 0, tn: r.giveUpTakeNow || 0, tr: r.lock && r.lock.traded ? 1 : 0, ef: r.lock ? r.lock.endBookFloor : null,
  nl: r.lock && r.lock.endFloorNoLoss ? 1 : 0, ifa: r.intradayFloorAvg, ifp: r.intradayFloorNonNegPct, te: r.tents || 0,
  op: r.openLadder ? [r.openLadder.placed, r.openLadder.filled] : null, d: r.decisions || null, gd: r.gapDay ? 1 : 0,
  th: r.touch ? [r.touch.hits, r.touch.coverFills, r.touch.blocked, r.touch.setupBars] : null,
  sg: r.stackGate ? [r.stackGate.blocked, r.stackGate.alsoC2o, r.stackGate.adds] : null,
  nc: r.natural ? [r.natural.adds, r.natural.rev, r.natural.revFilled, r.natural.guard, r.natural.offset, r.natural.v13Covered, r.natural.never, r.natural.revSameHit,
    r.natural.revTouch, r.natural.revWindow, r.natural.revRun, r.natural.addBlocked, r.natural.revSkipTotal, r.natural.revMidOnly, r.natural.positions] : null });

// COVER CONFIG FROM THE ROSTER: the v6-W run through optsFor, sliced to the cover keys — so a v10/v11 vertical is
// covered exactly as a v6 vertical of that width (target/minLock, geometry, ladder, give-up, c2o, stall, fill rules).
let _coverCfg = null;
function coverCfg() {
  if (_coverCfg) return _coverCfg;
  const { buildRuns } = require('../../server/src/candle-spread/index');
  const { optsFor } = require('../../server/src/candle-spread/backtest/opts-for');
  _coverCfg = {};
  for (const w of [10, 20, 40]) {
    const o = optsFor(buildRuns().find((r) => r.variant === `v6-${w}`), { intradayIV: true, hasPx: HAS_PX, where: 'sweep-v10 cover', openFillModel: 'ladder', subBarFill: '1m' });
    _coverCfg[w] = {}; for (const k of TG.COVER_KEYS) if (o[k] !== undefined) _coverCfg[w][k] = o[k];
  }
  return _coverCfg;
}
function computeUnit(u) {
  if (u.kind === 'target') {
    const opts = { family: u.v.family, width: u.v.width, priceOf, intradayIV: true, ivSkew: true, subBarFill: SUB_FILL === 'none' ? null : SUB_FILL,
      coverCfg: coverCfg(), ...u.over };
    return days.map((d) => slim(TG.runDayTarget(d.bars, { ...opts, rthCtx: CTX.get(isoOf(d)) })));
  }
  const { buildRuns } = require('../../server/src/candle-spread/index');
  const { optsFor } = require('../../server/src/candle-spread/backtest/opts-for');
  const run = { ...buildRuns().find((r) => r.variant === u.variant), ...(u.over || {}) };
  const env = { intradayIV: true, hasPx: HAS_PX, where: 'sweep-v10' };
  if (OPEN_FILL !== 'immediate') env.openFillModel = OPEN_FILL;
  if (SUB_FILL !== 'none') env.subBarFill = SUB_FILL;
  let o = optsFor(run, env);
  const fn = (A, p, ctx) => run.signalFn(A, p, { ...ctx, cfg: run.signalCfg || {} });
  if (NATURAL) o.guardMedianIv = MEDIAN_IV;
  if (BBFADE) {
    const BF = require('../../server/src/candle-spread/signals/bb-fade');
    // opens-only: the pure fade (no parent signal -> no signal covers) and the whitelisted opts (no covers / hedges)
    const sfn = u.opensOnly ? BF.OPENS_ONLY_SIGNAL : u.bbFade ? BF.bbFadeSignal(fn) : fn;   // OPENS_ONLY_SIGNAL = the rostered v20/v21 signalFn
    if (u.opensOnly) { const OO = require('../../server/src/candle-spread/backtest/opens-only'); o = OO.opensOnlyOpts(o, { capped: !u.unc }); }
    if (u.priceF != null) {
      // v21: the strike is picked by price. Walk room above the placed price = the v9 twin's (its ceiling over the 50% band centre).
      const { makePriceTargetGeo } = require('../../server/src/candle-spread/backtest/backtest-width');
      o.geo = makePriceTargetGeo({ width: run.spreadWidth, incr: run.strikeIncrement || 10, f: u.priceF, walkCapFrac: u.priceF + ((run.capFrac != null ? run.capFrac : 0.55) - 0.5) });
    }
    // signals/day = qualifying 5m closes inside the engine's action window (09:30-15:55 ET), counted whether or not they open
    const nSig = (d) => d.bars.reduce((a, b) => { const m = etMin(b.dt); return a + (m >= 570 && m <= 955 && !b.officialClose && BF.bbFadeSide(b.analysis) ? 1 : 0); }, 0);
    return days.map((d) => {
      const full = runDay5m(d.bars, sfn, { ...o, rthCtx: CTX.get(isoOf(d)) }), r = slim(full);
      if (u.bbFade) r.sig = nSig(d);
      if (u.opensOnly) {
        // HARD CHECK: nothing but signal opens in the book — no cover filled, no hedge / wing / offset / fly position
        const ol = full.openLadder || {};
        if (full.filled !== 0 || full.opens !== ol.filled || (full.governor && (full.governor.offsets || full.governor.wings || full.governor.covers)))
          throw new Error(`${u.label} ${d.date}: opens-only book holds non-open positions (filled ${full.filled}, opens ${full.opens}, ladder filled ${ol.filled})`);
        r.cap = [full.governor ? full.governor.blocked : 0, full.governor ? full.governor.firstBlockMin : null, ol.walkGovBlocked || 0,
          full.capital ? Math.round(full.capital.peakDebit) : 0, full.governor ? full.governor.worstFloor : null];
      }
      return r;
    });
  }
  if (OVERLAY) return days.map((d) => slim(runDay5m(d.bars, fn, { ...o, rthCtx: CTX.get(isoOf(d)) })));
  return days.map((d) => slim(runDay5m(d.bars, fn, o)));
}

// ── aggregation (writeSummaryCsv + measure() definitions) ──
function rollingDD(daily, W) { const cum = [0]; for (let i = 0; i < daily.length; i++) cum.push(cum[i] + daily[i]); let mx = 0;
  for (let b = 1; b < cum.length; b++) { let pk = -Infinity; for (let a = Math.max(0, b - W); a < b; a++) if (cum[a] > pk) pk = cum[a]; if (pk - cum[b] > mx) mx = pk - cum[b]; } return -Math.round(mx); }
function agg(recs) {
  const n = recs.length; if (!n) return null;
  const daily = recs.map((r) => r.t), total = daily.reduce((a, b) => a + b, 0), sorted = [...daily].sort((a, b) => a - b);
  const cum = [0]; daily.forEach((x, i) => cum.push(cum[i] + x));
  const worstWin = (N) => { let v = Infinity; for (let i = N; i < cum.length; i++) v = Math.min(v, cum[i] - cum[i - N]); return v === Infinity ? 0 : Math.round(v); };
  let pk = -Infinity, mdd = 0; for (const c of cum) { if (c > pk) pk = c; if (pk - c > mdd) mdd = pk - c; }
  const wins = daily.filter((x) => x > 0), losses = daily.filter((x) => x < 0);
  const avgWin = wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : null, avgLoss = losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : null;
  const tr = recs.filter((r) => r.tr), nt = Math.max(1, tr.length);
  const traded = recs.filter((r) => r.o > 0);
  const filled = recs.reduce((a, r) => a + r.f, 0), naked = recs.reduce((a, r) => a + r.n, 0);
  const D = {}; let hasD = false;
  for (const r of recs) if (r.d) { hasD = true; for (const k in r.d) D[k] = (D[k] || 0) + r.d[k]; }
  const per = (x) => Math.round(x / n * 100) / 100;
  const out = {
    days: n, total: Math.round(total), lockedPct: traded.length ? Math.round(1000 * traded.filter((r) => r.ef > 0).length / traded.length) / 10 : null,
    avgEndFloor: traded.length ? Math.round(traded.reduce((a, r) => a + r.ef, 0) / traded.length) : null,
    avgDaily: Math.round(total / n), median: Math.round(sorted[Math.floor(n / 2)]), worst5: worstWin(5), worst10: worstWin(10),
    maxDD: -Math.round(mdd), maxDD30: rollingDD(daily, 30), worst: Math.round(sorted[0]), best: Math.round(sorted[n - 1]),
    winPct: Math.round(100 * wins.length / n), opensPerDay: per(recs.reduce((a, r) => a + r.o, 0)),
    payoff: avgWin != null && avgLoss ? Math.round(avgWin / Math.abs(avgLoss) * 100) / 100 : null,
    intradayFloorAvg: Math.round(tr.reduce((a, r) => a + (r.ifa || 0), 0) / nt), ifNonNegPct: Math.round(tr.reduce((a, r) => a + (r.ifp || 0), 0) / nt * 10) / 10,
    eodLockedPct: Math.round(1000 * tr.filter((r) => r.nl).length / nt) / 10, tentsPerDay: Math.round(tr.reduce((a, r) => a + r.te, 0) / nt * 10) / 10,
    uncoveredEodPerDay: per(recs.reduce((a, r) => a + (r.ue || 0), 0)), takeNowPerDay: per(recs.reduce((a, r) => a + (r.tn || 0), 0)),
    coverFillRate: filled + naked ? Math.round(1000 * filled / (filled + naked)) / 10 : null, tradedDays: tr.length,
  };
  if (recs[0] && recs[0].cap) {   // opens-only CAP columns
    const blk = recs.filter((r) => r.cap[0] > 0), fm = blk.map((r) => r.cap[1]).filter((x) => x != null).sort((a, b) => a - b);
    const pk = recs.map((r) => r.cap[3]).sort((a, b) => a - b);
    const hm = (m) => (m == null ? null : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
    out.capBindPct = Math.round(1000 * blk.length / n) / 10; out.capBlockedPerDay = per(recs.reduce((a, r) => a + r.cap[0], 0));
    out.capWalkBlockedPerDay = per(recs.reduce((a, r) => a + r.cap[2], 0));
    out.capFirstBlockMedian = fm.length ? hm(fm[Math.floor(fm.length / 2)]) : null;
    out.peakCapitalMedian = pk[Math.floor(n / 2)]; out.peakCapitalMax = pk[n - 1];
  }
  if (recs[0] && recs[0].sig != null) out.signalsPerDay = per(recs.reduce((a, r) => a + (r.sig || 0), 0));
  if (hasD) {
    out.anchorFillRate = D.anchorPlaced ? Math.round(1000 * D.anchorFilled / D.anchorPlaced) / 10 : null;
    out.touchesPerDay = per(D.touches); out.reentriesPerDay = per(D.reentries);
    out.opensBeforeTouchPerDay = per(D.opensBeforeTouch); out.opensAfterTouchPerDay = per(D.opensAfterTouch);
    out.decisionsPerDay = {}; for (const k in D) out.decisionsPerDay[k] = per(D[k]);
  } else {
    if (recs[0] && recs[0].nc) { const t = Array.from({ length: 15 }, (_, j) => recs.reduce((a, r) => a + (r.nc ? r.nc[j] : 0), 0));
      out.addsPerDay = per(t[0]); out.revsPerDay = per(t[1]); out.revFilledPerDay = per(t[2]); out.guardPerDay = per(t[3]);
      const np = t[4] + t[5] + t[6]; out.offsetShare = np ? Math.round(1000 * t[4] / np) / 10 : null; out.v13CoveredShare = np ? Math.round(1000 * t[5] / np) / 10 : null;
      out.neverShare = np ? Math.round(1000 * t[6] / np) / 10 : null; out.revSameHitPerDay = per(t[7]);
      out.revTouchBarsPerDay = per(t[8]); out.revWindowBarsPerDay = per(t[9]); out.revRunBarsPerDay = per(t[10]); out.addBlockedPerDay = per(t[11]);
      out.revSkipTotalPerDay = per(t[12]); out.revMidOnlyPerDay = per(t[13]); }
    if (recs[0] && recs[0].sg) { const t = [0, 1, 2].map((j) => recs.reduce((a, r) => a + (r.sg ? r.sg[j] : 0), 0));
      out.blockedAddsPerDay = per(t[0]); out.alsoC2oPerDay = per(t[1]); out.addsPerDay = per(t[2]); }
    if (recs[0] && recs[0].th) { const t = [0, 1, 2, 3].map((j) => recs.reduce((a, r) => a + (r.th ? r.th[j] : 0), 0));
      out.touchHitsPerDay = per(t[0]); out.touchCoverFillsPerDay = per(t[1]); out.touchBlockedPerDay = per(t[2]); out.setupBarsPerDay = per(t[3]); }
    const pl = recs.reduce((a, r) => a + (r.op ? r.op[0] : 0), 0), fl = recs.reduce((a, r) => a + (r.op ? r.op[1] : 0), 0);
    out.openFillRate = pl ? Math.round(1000 * fl / pl) / 10 : null;
    if (pl) { out.openPlacedPerDay = per(pl); out.openFilledPerDay = per(fl); }
  }
  return out;
}

(async () => {
  if (!IS_CHILD) {
    console.log('  cover config (v6-W roster):', JSON.stringify(coverCfg()));
    console.log(`v10/v11 SWEEP — ${days.length} trading days (${era.filter((e) => e === '2026').length} NDX-priced 2026, ${era.filter((e) => e === 'pre').length} NQ-priced pre-2026), 1m sub-bars on ${n1m} days, ${rawAdded} raw-1m NDX context sessions added`);
    console.log(`  ${units.length} units on ${Math.min(workerCount(), units.length)} worker(s); controls: opens ${OPEN_FILL}, sub-bar ${SUB_FILL}`);
  }
  const res = await parallelMap(units, computeUnit);
  const rows = [];
  for (const u of units) {
    const recs = res[u.key];
    const name = u.kind === 'target' ? u.v.name : (u.label || u.variant);
    rows.push({ variant: name, arm: u.arm, all: agg(recs), y2026: agg(recs.filter((_, i) => era[i] === '2026')), pre: agg(recs.filter((_, i) => era[i] === 'pre')) });
  }
  fs.mkdirSync(OUT, { recursive: true });
  const meta = { generatedAt: new Date().toISOString(), days: days.length, from: days[0].date, to: days[days.length - 1].date, n2026: era.filter((e) => e === '2026').length,
    sub1mDays: n1m, medianIv15mBand: typeof MEDIAN_IV !== "undefined" ? MEDIAN_IV : null, wallSec: Math.round((Date.now() - t0) / 1000), workers: workerCount() };
  const tag = ARMS_ONLY.length ? '-' + ARMS_ONLY.join('_').slice(0, 40) : '';
  fs.writeFileSync(path.join(OUT, `sweep${tag}.json`), JSON.stringify({ meta, rows }, null, 1));
  const cols = ['days', 'total', 'lockedPct', 'avgEndFloor', 'avgDaily', 'median', 'worst5', 'worst10', 'maxDD', 'maxDD30', 'worst', 'best', 'winPct', 'opensPerDay', 'payoff',
    'intradayFloorAvg', 'ifNonNegPct', 'eodLockedPct', 'tentsPerDay', 'uncoveredEodPerDay', 'takeNowPerDay', 'signalsPerDay', 'capBindPct', 'capBlockedPerDay', 'capWalkBlockedPerDay', 'capFirstBlockMedian', 'peakCapitalMedian', 'peakCapitalMax', 'openPlacedPerDay', 'openFilledPerDay', 'coverFillRate', 'anchorFillRate', 'openFillRate', 'touchesPerDay', 'reentriesPerDay', 'opensBeforeTouchPerDay', 'opensAfterTouchPerDay', 'touchHitsPerDay', 'touchCoverFillsPerDay', 'touchBlockedPerDay', 'setupBarsPerDay', 'blockedAddsPerDay', 'alsoC2oPerDay', 'addsPerDay', 'revsPerDay', 'revFilledPerDay', 'guardPerDay', 'offsetShare', 'v13CoveredShare', 'neverShare',
    'revSameHitPerDay', 'revTouchBarsPerDay', 'revWindowBarsPerDay', 'revRunBarsPerDay', 'addBlockedPerDay', 'revSkipTotalPerDay', 'revMidOnlyPerDay'];
  const lines = [['variant', 'arm', 'era', ...cols].join(',')];
  for (const r of rows) for (const [e, a] of [['all', r.all], ['2026', r.y2026], ['pre', r.pre]]) if (a) lines.push([r.variant, r.arm, e, ...cols.map((c) => (a[c] == null ? '' : a[c]))].join(','));
  fs.writeFileSync(path.join(OUT, `sweep${tag}.csv`), lines.join('\n') + '\n');
  console.log(`wrote ${path.join(OUT, `sweep${tag}.json`)} (+ .csv) in ${meta.wallSec}s`);
  const usd = (n) => (n == null ? '' : (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US'));
  console.log('variant|arm|worst|maxDD30|IF>=0%|endFloor|locked%|total|avg/day|opens|touch|reent');
  for (const r of rows) { const a = r.all; console.log([r.variant, r.arm, usd(a.worst), usd(a.maxDD30), a.ifNonNegPct, usd(a.avgEndFloor), a.lockedPct, usd(a.total), usd(a.avgDaily), a.opensPerDay, a.touchesPerDay, a.reentriesPerDay].join('|')); }
})().catch((e) => { console.error(e); process.exit(1); });
