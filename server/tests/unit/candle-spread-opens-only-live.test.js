'use strict';
// OPENS-ONLY BB FADE, LIVE PORT (v20 / v21, 2026-10-23; simulate-only). Pins:
//   1) roster: exactly the backtested set (5 v20 shapes + 9 v21, each with a -unc twin = 28), built from the finished
//      v9 parents; every cover / hedge / floor-guard switch absent or off; kept fields equal the parent's; the shared
//      signal function; simulate-only (no control entry or armed slot can move them off paper)
//   2) engine parity: optsFor(v20/v21) == the 10/21 sweep's construction (opensOnlyOpts over optsFor(v9 parent), v21's
//      price-target geo) — and the open walk is ON (the 10/21 hole)
//   3) live gates (trader.processCandleClose through the real buildEngineDeps): the fade fires and is recorded with its
//      trace, one working open (refused BEFORE the cap, as runDay5m does), reversal cancels, the risk cap refuses with
//      the projected floor, -unc never refuses, nothing but opens ever happens, the open walk reprices up to its cap
//   4) v21 live strike pick on the real chain: closest to f x W, nearest the money on a tie, quote-gate refusals skipped,
//      walk cap = max(limit, (f + v9 cap - .50) x W), recorded on the open
//
// Run: node server/tests/run-unit.js opens-only-live
const os = require('os'), path = require('path'), fs = require('fs');
process.env.CANDLE_SPREAD_RUNS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-ool-'));
const store = require('../../src/candle-spread/store');
const trader = require('../../src/candle-spread/trader');
const cs = require('../../src/candle-spread');
const BF = require('../../src/candle-spread/signals/bb-fade');
const OO = require('../../src/candle-spread/backtest/opens-only');
const PT = require('../../src/candle-spread/price-target');
const FA = require('../../src/candle-spread/family-about');
const ST = require('../../src/candle-spread/signals/signal-trace');
const { optsFor } = require('../../src/candle-spread/backtest/opts-for');
const { makePriceTargetGeo } = require('../../src/candle-spread/backtest/backtest-width');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

const RUNS = cs.buildRuns();
const by = new Map(RUNS.map((r) => [r.variant, r]));
const NEW = RUNS.filter((r) => /^v2[01]-/.test(r.variant));
const parentOf = (name) => { const m = /^v2[01]-(\d+)(-cATM)?/.exec(name); return by.get(`v9-${m[1]}${m[2] || ''}`); };

// ── 1) roster ─────────────────────────────────────────────────────────────────────────────────────────────
{
  const want = [];
  for (const sh of ['10', '20', '40', '20-cATM', '40-cATM']) want.push(`v20-${sh}`, `v20-${sh}-unc`);
  for (const w of [10, 20, 40]) for (const f of ['f50', 'f55', 'f60']) want.push(`v21-${w}-${f}`, `v21-${w}-${f}-unc`);
  ok(want.length === 28 && NEW.length === 28, `28 new variants (${NEW.length})`);
  ok(want.every((n) => by.has(n)), `exactly the backtested names (missing: ${want.filter((n) => !by.has(n)).join(', ')})`);
  // 124 when v20/v21 landed; + 16 natural-cover v12/v13 (2026-10-23, candle-spread-natural-live) = 140
  ok(RUNS.length === 140, `roster 96 + 28 + 16 = 140 (${RUNS.length})`);
  const OFF_ABSENT = ['coverGiveUp', 'giveUpPoints', 'stallCoverMin', 'lateFloorAfterMin', 'floorRaise', 'wingConvert', 'flyConvert',
    'proactiveCoverFrac', 'reopenOnCover', 'coverToOpenWait', 'coverLadder', 'floorRatchet', 'trendFloor', 'stackGate', 'openTrendBlock',
    'creditCapitalTrigger', 'continuousCoverMinLockFrac', 'coverGeometry', 'giveUpGeometry', 'coverRangeInside', 'floorRaiseWings'];
  for (const v of NEW) {
    const p = parentOf(v.variant), unc = /-unc$/.test(v.variant);
    ok(!!p, `${v.variant}: parent found`);
    ok(v.signalFn === BF.OPENS_ONLY_SIGNAL, `${v.variant}: the shared fade signal (same function object the backtest runs)`);
    ok(v.opensOnly === true && v.simulateOnly === true && v.dryRun === true, `${v.variant}: opens-only, simulate-only, paper`);
    for (const k of OFF_ABSENT) ok(v[k] == null || v[k] === false, `${v.variant}: ${k} off (${JSON.stringify(v[k])})`);
    ok(v.continuousCover === false && v.coverToStack === false && v.floorOffset === false && v.capitalRecapture === false && v.lossTarget == null,
      `${v.variant}: the BASE_RUNS machinery defaults are switched off`);
    ok(v.openLadder === true, `${v.variant}: open walk on`);
    ok(unc ? v.lossMax == null : v.lossMax === p.lossMax && v.lossMax > 0, `${v.variant}: lossMax ${v.lossMax} (${unc ? 'none' : `parent ${p.lossMax}`})`);
    for (const k of ['spreadWidth', 'openWalkCapFrac', 'openRestrikeMin', 'openFallbackUntilMin', 'ladderStepSeconds', 'ladderStepPoints',
      'ladderStepDollars', 'bidirectional', 'enforceLegUniqueness', 'openNeverOtm', 'simOpenFillMinLooks', 'simFillAtLimit'])
      ok(JSON.stringify(v[k]) === JSON.stringify(p[k]), `${v.variant}: ${k} = parent's (${JSON.stringify(v[k])})`);
    if (/^v20-/.test(v.variant)) {
      for (const k of ['adaptiveGeo', 'capFrac', 'minDebitFrac', 'maxItmStrikes', 'maxOtmStrikes', 'spreadShift'])
        ok(JSON.stringify(v[k]) === JSON.stringify(p[k]), `${v.variant}: placement ${k} = v9's`);
    } else {
      const f = Number(/-f(\d+)/.exec(v.variant)[1]) / 100;
      ok(v.openPriceTarget === f, `${v.variant}: price target ${f}`);
      ok(Math.abs(v.capFrac - (f + p.capFrac - 0.5)) < 1e-9, `${v.variant}: walk cap ${v.capFrac} = f + v9 cap - .50`);
      ok(!v.adaptiveGeo, `${v.variant}: no adaptive placement`);
    }
    for (const k of Object.keys(v)) if (v[k] && typeof v[k] === 'object') ok(v[k] !== p[k], `${v.variant}.${k} not shared by reference`);
  }
  // simulate-only guards
  const v = by.get('v20-10');
  ok(cs.effectiveDryRun(v) === true, 'effectiveDryRun: simulate-only is paper');
  ok(/simulate-only/.test(cs.armableReason('v20-10') || ''), 'armableReason refuses a simulate-only variant');
  ok(cs.buildEngineDeps(v, {}).dryRun === true, 'buildEngineDeps: dryRun true');
  ok(cs.fillSourceFor(v) === 'mark', 'fills from the mark (never the broker)');
  let threw = null; try { cs.assertDeps(RUNS); } catch (e) { threw = e.message; }
  ok(threw === null, `startup check accepts the roster (${threw})`);
  // name parsers
  ok(FA.describeVariant('v21-10-f55-unc') && FA.describeVariant('v21-10-f55-unc').priceTarget === 0.55, 'family-about: v21-10-f55-unc');
  ok(FA.describeVariant('v20-40-cATM-unc') && FA.describeVariant('v20-40-cATM-unc').family === 'v20', 'family-about: v20-40-cATM-unc');
  ok(ST.traceFor('v21-20-f60') === BF.bbFadeTrace && ST.traceFor('v20-10') === BF.bbFadeTrace, 'signal trace: v20/v21 -> bbFadeTrace');
  const names = cs.listVariants().map((x) => x.variant);
  ok(names.indexOf('v21-10-f50') < names.indexOf('v21-20-f50') && names.indexOf('v21-40-f50') < names.indexOf('v21-10-f55')
    && names.indexOf('v20-40-cATM-unc') < names.indexOf('v21-10-f50'), 'listVariants: v20 then v21 grouped by target');
}

// ── 2) engine parity with the sweep construction ─────────────────────────────────────────────────────────────
{
  const env = { intradayIV: true, hasPx: true, where: 'test', openFillModel: 'ladder', subBarFill: '1m' };
  for (const v of NEW) {
    const p = parentOf(v.variant), unc = /-unc$/.test(v.variant), fm = /-f(\d+)/.exec(v.variant);
    let ref = OO.opensOnlyOpts(optsFor(p, env), { capped: !unc });
    if (fm) {
      const f = Number(fm[1]) / 100;
      ref = { ...ref, geo: makePriceTargetGeo({ width: p.spreadWidth, incr: p.strikeIncrement || 10, f, walkCapFrac: f + (p.capFrac - 0.5) }) };
    }
    const got = optsFor(v, env);
    ok(Object.keys(ref).sort().join() === Object.keys(got).sort().join(), `${v.variant}: same opt keys as the sweep`);
    for (const k of Object.keys(ref)) if (k !== 'geo' && k !== 'priceOf') ok(JSON.stringify(ref[k]) === JSON.stringify(got[k]), `${v.variant}: opt ${k}`);
    let same = true;
    for (const S of [20000.3, 20013.7, 21555]) for (const side of ['bull', 'bear']) for (const tau of [0.02, 0.005]) for (const iv of [0.12, 0.25])
      if (JSON.stringify(ref.geo.buildOpen(side, S, tau, iv)) !== JSON.stringify(got.geo.buildOpen(side, S, tau, iv))) same = false;
    ok(same, `${v.variant}: same placement as the sweep`);
    ok(got.openLadder === true && got.openFillModel === 'ladder', `${v.variant}: the open walk is on in the backtest too`);
    ok(unc ? got.lossMax === undefined : got.lossMax === v.lossMax, `${v.variant}: backtest cap`);
  }
}

// ── 3/4) live gates ───────────────────────────────────────────────────────────────────────────────────────────
// Synthetic NDX chain: Black-Scholes mids (3h to the close, 20% vol: a 10-wide at the money ~ $5), tight quotes.
const bs = require('../../src/candle-spread/bs-pricer');
const TAU = 3 / (24 * 365);
const legFor = (U, broken) => (type, strike) => {
  if (broken && broken(type, strike)) return { mid: 0.05, bid: 0, ask: 0.1, symbol: `NDX_${type}${strike}` };
  const mid = bs.bsPrice(type, U, strike, TAU, 0.2);
  return { mid: Math.round(mid * 100) / 100, symbol: `NDX_${type}${strike}`, bid: Math.round((mid - 0.05) * 100) / 100, ask: Math.round((mid + 0.05) * 100) / 100 };
};
// NQ analysis: 5m close vs the 15m / 60m bands. side 'bull' = below both lowers, 'bear' = above both uppers.
const C = (close, lo, hi) => ({ open: close, high: close + 1, low: close - 1, close, bblower: lo, bbupper: hi, bbmiddle: (lo + hi) / 2, ema: close });
const Aof = (side) => {
  const x = side === 'bull' ? 21880 : side === 'bear' ? 22120 : 22000;
  return { '1m': C(x, 0, 1e9), '5m': C(x, 21900, 22100), '15m': C(22000, 21900, 22100), '60m': C(22000, 21890, 22110) };
};
const placeOrder = async () => ({ status: 'simulated', filled: true });
let clock = Date.UTC(2026, 9, 23, 14, 0);   // 10:00 ET
const cfgOf = (variant, extra) => { const r = { ...by.get(variant), expiration: '2026-10-23', captureChain: false, ...(extra || {}) }; delete r.signalFn; return r; };
async function step(rec, run, U, side, opt = {}) {
  clock += opt.advanceMs != null ? opt.advanceMs : 5 * 60000;
  const d = new Date(clock);
  const et = `${String(d.getUTCHours() - 4).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  const candle = { timeEST: `10/23 ${et}`, datetime: clock, open: U, high: U + 1, low: U - 1, close: U };
  const deps = cs.buildEngineDeps(run, { getLeg: legFor(U, opt.broken), placeOrder, A: Aof(side), priorA: null, underlying: U,
    isFifteen: true, nowMs: clock });
  const r = await trader.processCandleClose(rec, candle, null, deps);
  const ev = rec.events[rec.events.length - 1];
  return { acts: r.decisions.map((x) => x.action), dec: r.decisions, ev };
}
const filledN = (rec, side) => rec.state.positions.filter((p) => p.filled && (!side || p.side === side)).length;

(async () => {
  // SIGNAL, RECORD, ONE WORKING OPEN, REVERSAL
  {
    const run = by.get('v20-10'), rec = store.initRun(cfgOf('v20-10'), '2026-10-23');
    const s1 = await step(rec, run, 22000, 'bull');
    ok(s1.acts.includes('open') && rec.state.pendingOpenId, 'the fade fires a bull open, which rests');
    ok(s1.ev.signal && s1.ev.signal.reason === 'bb-fade-bull', `candle records the signal reason (${s1.ev.signal && s1.ev.signal.reason})`);
    ok(s1.ev.signal.trace && s1.ev.signal.trace.fired === 'bb-fade-bull' && s1.ev.signal.trace.triggers.length === 2,
      'candle records the bb-fade trace (both triggers, fired = bull)');
    ok(s1.ev.signal.trace.inputs.c15.lower === 21900 && s1.ev.signal.trace.inputs.c60.lower === 21890, 'trace carries the 15m / 60m bands');
    const s2 = await step(rec, run, 22030, 'bull');   // the market ran away: the open does not fill, the slot is held
    ok(s2.acts.includes('open-skip-pending') && !s2.acts.includes('open-skip-governor') && !s2.acts.includes('open'),
      `a repeat signal while the open works is refused for the working open (${s2.acts.join(',')})`);
    const s3 = await step(rec, run, 22030, 'bear');
    ok(s3.acts.includes('cancel-open') && s3.acts.includes('open') && rec.state.positions.find((p) => p.id === rec.state.pendingOpenId).side === 'bear',
      `a reversal cancels the working bull and opens the bear (${s3.acts.join(',')})`);
    const s4 = await step(rec, run, 22030, 'none');
    ok(s4.acts.includes('neutral') && s4.ev.signal.reason === 'neutral', 'no fade -> neutral, recorded');
  }
  // NOTHING BUT OPENS, AND THE WALK
  {
    const run = by.get('v20-10'), rec = store.initRun(cfgOf('v20-10', { variant: 'v20-10-x' }), '2026-10-23');
    const all = [];
    let s = await step(rec, run, 22000, 'bull'); all.push(...s.acts);
    s = await step(rec, run, 22000, 'none'); all.push(...s.acts);
    ok(filledN(rec, 'bull') === 1, 'the open fills on a later look');
    for (let i = 0; i < 12; i++) { s = await step(rec, run, 22000 + 15 * (i + 1), 'none'); all.push(...s.acts); }   // runs deep ITM
    const bad = all.filter((a) => /cover|hedge|raise|wing|fly|offset|give|stall|c2o|reopen|lock|late|ratchet|trend-floor/.test(a));
    ok(bad.length === 0, `no cover / hedge / guard action, ever (${[...new Set(bad)].join(',')})`);
    ok(rec.state.positions.every((p) => !p.pendingCover && !p.covered && !p.hedge), 'the book holds only the uncovered open');
    // walk: place a bear while the market runs away from it, then let time pass
    const r2 = store.initRun(cfgOf('v20-10', { variant: 'v20-10-w' }), '2026-10-23');
    await step(r2, run, 22000, 'bear');
    const pos = r2.state.positions[0];
    let reps = 0;
    for (let i = 0; i < 12; i++) { const t = await step(r2, run, 21990 - 2 * i, 'none', { advanceMs: 120000 }); reps += t.acts.filter((a) => a === 'open-reprice').length; }
    ok(reps > 0 && pos.limit > pos.ladderBase, `the open walk reprices (${reps}x, ${pos.ladderBase} -> ${pos.limit})`);
    ok(pos.limit <= pos.cap + 1e-9 && Math.abs(pos.cap - run.openWalkCapFrac * run.spreadWidth) < 1e-9, `never past the walk cap ${pos.cap}`);
  }
  // THE RISK CAP (capped refuses with the projected floor; -unc never refuses)
  for (const [variant, capped] of [['v20-10', true], ['v20-10-unc', false]]) {
    const run = by.get(variant), rec = store.initRun(cfgOf(variant, { variant: `${variant}-cap` }), '2026-10-23');
    let refused = null, opens = 0;
    for (let i = 0; i < 8; i++) {
      const s = await step(rec, run, 22000, 'bull');
      if (s.acts.includes('open')) opens++;
      const g = s.dec.find((x) => x.action === 'open-skip-governor');
      if (g && !refused) refused = g;
      await step(rec, run, 22000, 'none');   // let it fill, freeing the slot
    }
    if (capped) {
      ok(refused && refused.projectedFloor < -run.lossMax && refused.lossMax === run.lossMax,
        `${variant}: the cap refuses an open that would take the floor through lossMax (${refused && refused.projectedFloor} vs ${run.lossMax})`);
      ok(filledN(rec) * 5.5 * 100 <= run.lossMax + 1e-9, `${variant}: the book stays inside the cap (${filledN(rec)} filled)`);
    } else ok(!refused && opens === 8, `${variant}: no cap, every signal opens (${opens})`);
  }

  // v21 LIVE STRIKE PICK
  {
    const run = by.get('v21-10-f55'), cfg = cfgOf('v21-10-f55');
    const U = 22003, getLeg = legFor(U);
    const res = trader.buildOpenPriceTarget('bull', U, cfg, getLeg);
    // brute force over the same window, on the live pricer's marks
    let best = null;
    for (let k = -PT.SPAN; k <= PT.SPAN; k++) {
      const sk = 22000 + k * 10, r = trader.priceTargetAtStrikes('bull', sk - 10, sk, cfg, getLeg, U);
      if (r.error || !(r.mark > 0)) continue;
      const e = Math.abs(r.mark - 5.5), dist = Math.abs(sk - 5 - U);
      if (!best || e < best.e - 1e-9 || (Math.abs(e - best.e) < 1e-9 && dist < best.dist)) best = { sk, e, dist, mark: r.mark };
    }
    ok(res && !res.error && res.shortStrike === best.sk, `picks the spread priced closest to 0.55 x W (short ${res.shortStrike}, mark ${res.mark}; expected ${best.sk} @ ${best.mark})`);
    ok(Math.abs(res.cap - Math.max(res.limit, Math.round(run.capFrac * 10 * 100) / 100)) < 1e-9 && res.cap === 6, `walk cap = max(limit, 0.60 x 10) (${res.cap})`);
    ok(res.priceTarget === 0.55 && res.targetPrice === 5.5 && res.candidatesPriced > 10, 'records the target and how many candidates were priced');
    // tie -> nearest the money: a symmetric chain around U = 22005 prices the 21990/22000 and 22010/22020 bulls symmetric
    // about 5.00 for f = .50; pickByPrice must take the one whose centre is nearer U.
    const tie = PT.pickByPrice('bull', 22005, 10, 0.5, (legs) => ({ 21995: 5.6, 22005: 5.0, 22015: 4.4, 21985: 6.2 })[(legs[0].strike + legs[1].strike) / 2] || 9, { incr: 10, span: 3 });
    ok(tie && tie.shortStrike === 22010, `exact price wins (${tie && tie.shortStrike})`);
    const tie2 = PT.pickByPrice('bull', 22003, 10, 0.5, (legs) => ({ 21995: 5.3, 22005: 4.7 })[(legs[0].strike + legs[1].strike) / 2] || 9, { incr: 10, span: 3 });
    ok(tie2 && tie2.shortStrike === 22010, `equal distance from the target -> the spread nearer the money (${tie2 && tie2.shortStrike})`);
    // a candidate the quote gates refuse is skipped, never picked
    const brokenK = res.shortStrike;
    const r2 = trader.buildOpenPriceTarget('bull', U, cfg, legFor(U, (type, k) => type === 'C' && k === brokenK));
    ok(r2 && !r2.error && r2.shortStrike !== brokenK && r2.lower !== brokenK, `a refused quote is skipped (picked ${r2.shortStrike} instead of ${brokenK})`);
    // through the trader: the open records the pick
    const rec = store.initRun(cfgOf('v21-10-f55'), '2026-10-23');
    const s = await step(rec, run, U, 'bull');
    const o = s.dec.find((x) => x.action === 'open');
    ok(o && o.priceTarget === 0.55 && o.walkCap === 6 && o.legs[1].strike === res.shortStrike, `the v21 open records target, walk cap and strikes (${o && JSON.stringify({ t: o.priceTarget, w: o.walkCap })})`);
    const p = rec.state.positions[0];
    ok(p && p.cap === 6, `the working open walks to the v21 walk cap (${p && p.cap})`);
  }

  console.log(`opens-only live: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
