'use strict';
// NATURAL COVER, LIVE PORT (v12 / v13, 2026-10-23; simulate-only). Pins:
//   1) roster: the complete v6 family shape for each (10/20/40, -unc 10/20/40, -cATM 20/40 = 8 + 8), every field the v6
//      parent's except natural / coverAfterMin / guardMedianIv; simulate-only (no control entry or armed slot moves them
//      off paper); the startup check accepts the roster; name parsers
//   2) engine parity: optsFor(v12/v13-*) == the 2026-10-17 sweep's construction (optsFor({...v6 parent, natural}) + the
//      median IV), for every shape
//   3) shared rules: natural-cover.liveContext builds the same RTH lines and zigzag the backtest feeds bar by bar
//   4) live gates through trader.processCandleClose and the real buildEngineDeps: the 'natural' record on every candle,
//      ADD gate refusal, REV at the pair's short with its trace row, a working REV kept through a signal flip, the REV fill
//      offsets its pair, v12 never covers (continuous / signal), v13 covers only after 30 min and never an offset pair,
//      the jump guard fires and records, -unc never guards
//
// Run: node server/tests/run-unit.js natural-live
const os = require('os'), path = require('path'), fs = require('fs');
process.env.CANDLE_SPREAD_RUNS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-nat-'));
const store = require('../../src/candle-spread/store');
const trader = require('../../src/candle-spread/trader');
const cs = require('../../src/candle-spread');
const NCM = require('../../src/candle-spread/natural-cover');
const FA = require('../../src/candle-spread/family-about');
const ST = require('../../src/candle-spread/signals/signal-trace');
const TG = require('../../src/candle-spread/backtest/backtest-target');
const { optsFor } = require('../../src/candle-spread/backtest/opts-for');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

const RUNS = cs.buildRuns();
const by = new Map(RUNS.map((r) => [r.variant, r]));
const NEW = RUNS.filter((r) => /^v1[23]-/.test(r.variant));
const parentOf = (name) => by.get(name.replace(/^v1[23]-/, 'v6-'));
const MEDIAN_IV = 0.198593702534246;   // data/sweeps/v12-v13-2026-10-17 meta.medianIv15mBand

// ── 1) roster ─────────────────────────────────────────────────────────────────────────────────────────────
{
  const shapes = ['10', '20', '40', '10-unc', '20-unc', '40-unc', '20-cATM', '40-cATM'];
  const want = ['v12', 'v13'].flatMap((f) => shapes.map((s) => `${f}-${s}`));
  ok(NEW.length === 16 && want.every((n) => by.has(n)), `16 natural variants (${NEW.length}; missing ${want.filter((n) => !by.has(n)).join(', ')})`);
  ok(RUNS.length === 140, `roster 124 + 16 = 140 (${RUNS.length})`);
  ok(RUNS.filter((r) => /^v6-/.test(r.variant)).length === 8, 'the v6 parent has exactly these 8 shapes');
  const OWN = new Set(['variant', 'variantLabel', 'natural', 'coverAfterMin', 'guardMedianIv', 'simulateOnly', 'dryRun', 'reopenOnCover']);
  // reopenOnCover is the family's own: false (v6 has it on since 2026-11-06; natural cover never reopens).
  for (const v of NEW) {
    const p = parentOf(v.variant), fam = v.variant.slice(0, 3);
    ok(!!p, `${v.variant}: parent ${v.variant.replace(/^v1[23]/, 'v6')}`);
    ok(v.natural === fam && v.guardMedianIv === MEDIAN_IV && (fam === 'v13' ? v.coverAfterMin === 30 : v.coverAfterMin == null),
      `${v.variant}: natural ${v.natural}, guard IV ${v.guardMedianIv}, coverAfterMin ${v.coverAfterMin}`);
    ok(v.simulateOnly === true && v.dryRun === true, `${v.variant}: simulate-only, paper`);
    ok(v.reopenOnCover === false, `${v.variant}: no reopen after cover`);
    ok(v.signalFn === p.signalFn, `${v.variant}: the v6 signal function`);
    const diff = [...new Set([...Object.keys(v), ...Object.keys(p)])].filter((k) => !OWN.has(k) && JSON.stringify(v[k]) !== JSON.stringify(p[k]));
    ok(diff.length === 0, `${v.variant}: every other field is v6's (${diff.join(', ')})`);
    for (const k of Object.keys(v)) if (v[k] && typeof v[k] === 'object') ok(v[k] !== p[k], `${v.variant}.${k} not shared by reference`);
  }
  const v = by.get('v12-10');
  ok(cs.effectiveDryRun(v) === true, 'effectiveDryRun: simulate-only is paper');
  ok(/simulate-only/.test(cs.armableReason('v13-20') || ''), 'armableReason refuses a simulate-only variant');
  ok(cs.buildEngineDeps(v, {}).dryRun === true, 'buildEngineDeps: dryRun true');
  ok(cs.buildEngineDeps(by.get('v13-40-cATM'), {}).natural === 'v13' && cs.buildEngineDeps(v, {}).guardMedianIv === MEDIAN_IV, 'deps carry the mode and the guard IV');
  ok(cs.buildEngineDeps(by.get('v6-10'), {}).natural === null, 'v6 deps: natural off');
  let threw = null; try { cs.assertDeps(RUNS); } catch (e) { threw = e.message; }
  ok(threw === null, `startup check accepts the roster (${threw})`);
  ok(FA.describeVariant('v12-10-unc') && FA.describeVariant('v12-10-unc').family === 'v12' && FA.describeVariant('v13-40-cATM').family === 'v13', 'family-about: v12 / v13');
  ok(ST.traceFor('v12-20') === ST.v6Trace && ST.traceFor('v13-10-unc') === ST.v6Trace, 'signal trace: v12/v13 -> v6Trace');
  const names = cs.listVariants().map((x) => x.variant);
  ok(names.indexOf('v9ob-40-cATM') < names.indexOf('v12-10') && names.indexOf('v13-40-cATM') < names.indexOf('v20-10'), 'listVariants: v12, v13 between v9ob and v20');
}

// ── 2) engine parity with the sweep construction ─────────────────────────────────────────────────────────────
{
  const env = { intradayIV: true, hasPx: true, where: 'test', openFillModel: 'ladder', subBarFill: '1m' };
  for (const v of NEW) {
    const p = parentOf(v.variant);
    // reopenOnCover: false — v6 carries reopen since 2026-11-06; the natural families never did (the sweep had none).
    const ref = optsFor({ ...p, natural: v.natural, reopenOnCover: false, ...(v.coverAfterMin != null ? { coverAfterMin: v.coverAfterMin } : {}) }, env);
    ref.guardMedianIv = MEDIAN_IV;   // sweep-v10: o.guardMedianIv = MEDIAN_IV
    const got = optsFor(v, env);
    ok(Object.keys(ref).sort().join() === Object.keys(got).sort().join(), `${v.variant}: same opt keys as the sweep`);
    for (const k of Object.keys(ref)) if (k !== 'geo' && k !== 'priceOf') ok(JSON.stringify(ref[k]) === JSON.stringify(got[k]), `${v.variant}: opt ${k}`);
    let same = true;
    for (const S of [20000.3, 21555]) for (const side of ['bull', 'bear']) for (const iv of [0.12, 0.25])
      if (JSON.stringify(ref.geo.buildOpen(side, S, 0.01, iv)) !== JSON.stringify(got.geo.buildOpen(side, S, 0.01, iv))) same = false;
    ok(same, `${v.variant}: same placement as v6`);
    const po = optsFor(p, env);
    ok(po.natural === undefined && po.guardMedianIv === undefined, `${p.variant}: parent opts untouched`);
  }
}

// ── 3) shared context: liveContext == the backtest's bar-by-bar feed ─────────────────────────────────────────
{
  // 9 sessions of synthetic NDX 1m (RTH), the last one = "today" up to 11:00
  const ET = (iso, min) => Date.parse(`${iso}T00:00:00-04:00`) + min * 60000;
  const days = ['2026-10-09', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22'];
  const candles = []; let n = 0;
  for (const iso of days) for (let m = 570; m < 960; m++) { const c = 25000 + 120 * Math.sin(n / 37) + 15 * Math.sin(n / 3); n++; candles.push({ datetime: ET(iso, m), open: c - 1, high: c + 2, low: c - 2, close: c }); }
  const T = ET('2026-10-22', 660);
  const live = NCM.liveContext(candles, T);
  // backtest feed: the dataset sessions -> buildRthContexts -> makeRthLines, today's bars pushed one by one, zigzag per bar
  const sessions = days.slice(0, -1).map((iso) => TG.sessionFrom1m(iso, candles.filter((c) => TG.etIso(c.datetime) === iso), null));
  const todayC = candles.filter((c) => TG.etIso(c.datetime) === '2026-10-22' && c.datetime < T);
  const todayS = TG.sessionFrom1m('2026-10-22', todayC, null);
  const ctx = TG.buildRthContexts(sessions.concat([todayS]), 8).get('2026-10-22');
  const rl = TG.makeRthLines(ctx.priorBars), zz = NCM.newZigzag();
  let r5, r15, r60;
  for (const b of todayS.rth) {
    if (b.min < 575 || b.min > 660) continue;
    rl.push(b);
    r5 = rl.lines(5, '2026-10-22', b.min); r15 = rl.lines(15, '2026-10-22', b.min); r60 = rl.lines(60, '2026-10-22', b.min);
    NCM.zigzagFeed(zz, todayC.filter((c) => c.datetime >= ET('2026-10-22', b.min - 5) && c.datetime < ET('2026-10-22', b.min)).map((c) => c.close), 20);
  }
  ok(live.priorUsed === 8 && live.todayBars === 18, `8 prior sessions, 18 bars today (${live.priorUsed}, ${live.todayBars})`);
  ok(JSON.stringify(live.r5) === JSON.stringify(r5) && JSON.stringify(live.r15) === JSON.stringify(r15) && JSON.stringify(live.r60) === JSON.stringify(r60), 'RTH 5/15/60 lines equal the backtest feed');
  ok(JSON.stringify(live.zz) === JSON.stringify(zz) && zz.last != null, 'zigzag equals the bar-by-bar fold');
  const early = NCM.liveContext(candles, ET('2026-10-22', 570));
  ok(early.todayBars === 0 && early.priorUsed === 8 && early.r5 && early.r5.n >= 20, '09:30: no bar today, the prior sessions still give the lines');
}

// ── 4) live gates ─────────────────────────────────────────────────────────────────────────────────────────────
const bs = require('../../src/candle-spread/bs-pricer');
const TAU = 3 / (24 * 365);
const legFor = (U) => (type, strike) => {
  const mid = bs.bsPrice(type, U, strike, TAU, 0.2);
  return { mid: Math.round(mid * 100) / 100, symbol: `NDX_${type}${strike}`, bid: Math.round((mid - 0.05) * 100) / 100, ask: Math.round((mid + 0.05) * 100) / 100 };
};
// NQ candles centred on px (basis 0 vs NDX): at15 = the 15m candle at its upper band; nq60 = the 60m at its upper band.
const Afor = (px, { at15 = false, nq60 = false } = {}) => {
  const c = (hiBand) => ({ open: px, high: px + 1, low: px - 1, close: px, bbupper: px + hiBand, bblower: px - 300, bbmiddle: px - 150, ema: px - 140 });
  return { '1m': c(300), '5m': c(300), '15m': c(at15 ? 2 : 300), '60m': c(nq60 ? 2 : 300) };
};
const placeOrder = async () => ({ status: 'simulated', filled: true });
let clock = Date.UTC(2026, 9, 23, 14, 0);   // 10:00 ET
const sig = { open: null, cover: null };
const stubSignal = () => ({ openSide: sig.open, coverSide: sig.cover, reason: sig.open ? `stub-${sig.open}` : sig.cover ? `stub-cover-${sig.cover}` : 'neutral' });
const runOf = (variant, extra) => ({ ...by.get(variant), signalFn: stubSignal, ...(extra || {}) });
const cfgOf = (variant, extra) => { const r = { ...by.get(variant), expiration: '2026-10-23', captureChain: false, ...(extra || {}) }; delete r.signalFn; return r; };
const zzUp = (U, len) => ({ dir: 1, hi: U, lo: U - len, piv: U - len, ext: U, last: null });
async function step(rec, run, U, o = {}) {
  clock += o.advanceMs != null ? o.advanceMs : 5 * 60000;
  sig.open = o.open || null; sig.cover = o.cover || null;
  const d = new Date(clock);
  const et = `${String(d.getUTCHours() - 4).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  const candle = { timeEST: `10/23 ${et}`, datetime: clock, open: U, high: U + 1, low: U - 1, close: U };
  const natCtx = o.ctx !== undefined ? o.ctx : { r5: null, r15: null, r60: null, zz: o.zz || NCM.newZigzag(), priorUsed: 8, todayBars: 6, oneMin: 30, last1m: clock - 60000 };
  const deps = cs.buildEngineDeps(run, { getLeg: legFor(U), placeOrder, A: Afor(U, o), priorA: null, underlying: U, isFifteen: true, nowMs: clock, natCtx });
  const r = await trader.processCandleClose(rec, candle, null, deps);
  const ev = rec.events[rec.events.length - 1];
  return { acts: r.decisions.map((x) => x.action), dec: r.decisions, ev, nat: r.decisions.find((x) => x.action === 'natural') };
}
const P = (rec, id) => rec.state.positions.find((p) => p.id === id);

(async () => {
  // v12: the record, the ADD gate, a REV at the pair's short, kept through a flip, offsets its pair; never a cover
  {
    const run = runOf('v12-20'), rec = store.initRun(cfgOf('v12-20'), '2026-10-23');
    const s1 = await step(rec, run, 22000, { open: 'bull' });
    ok(s1.nat && s1.nat.mode === 'v12' && /first-open/.test(s1.nat.outcome) && s1.acts.includes('open'), `candle 1: natural record + the first bull opens (${s1.nat && s1.nat.outcome})`);
    const s2 = await step(rec, run, 22000);
    const bull = rec.state.positions.find((p) => p.side === 'bull');
    ok(bull && bull.filled && !bull.pendingCover, `the bull fills and NO continuous cover rests on it (${s2.acts.join(',')})`);
    // (the fill landed in step (1) of this candle, after the natural read — live's order; the 30s worker usually fills first)
    ok(s2.nat && s2.nat.rev && s2.nat.rev.why === 'flat', `REV not evaluated on a flat book (${s2.nat && s2.nat.rev && s2.nat.rev.why})`);
    const s3 = await step(rec, run, 22000, { open: 'bull' });
    ok(s3.nat && s3.nat.rev.evaluated && s3.nat.rev.why === 'no-touch' && s3.nat.rev.bias === 'bull', `REV evaluated on the bull book, no touch (${s3.nat && s3.nat.rev.why})`);
    const sk = s3.dec.find((x) => x.action === 'open-skip-natural-add');
    ok(sk && sk.reason === 'blocked' && sk.same === 1 && !s3.acts.includes('open'), `an ADD without the 15m outer band is refused and recorded (${s3.acts.join(',')})`);
    const s3b = await step(rec, run, 22000, { cover: 'bull' });
    ok(s3b.acts.includes('cover-skip-natural') && !bull.pendingCover, 'a signal cover is refused and recorded (v12 places no covers)');
    // a 70-pt up run with the NQ 60m at its upper band, within 30 min of the bull -> REV bear at the bull's short
    const U = 22070;
    const s4 = await step(rec, run, U, { nq60: true, zz: zzUp(U, 70) });
    ok(s4.nat && s4.nat.outcome === 'rev' && s4.nat.rev.touch.nq60 && s4.nat.rev.runOk && s4.nat.rev.winOk, `REV fires (${s4.nat && s4.nat.outcome}; run ${s4.nat && s4.nat.rev.run}/${s4.nat && s4.nat.rev.runNeed})`);
    const rev = rec.state.positions.find((p) => p.natural === 'rev');
    ok(rev && rev.side === 'bear' && rev.shortStrike === bull.shortStrike && rev.natPair === bull.id && !rev.filled,
      `the REV is a bear at the bull's short ${bull.shortStrike} (${rev && rev.shortStrike}), tagged with its pair, working`);
    ok(s4.nat.strike && s4.nat.strike.via === 'same' && s4.nat.strike.sameHit && s4.nat.strike.total <= 1.15 * 20, `strike record: same short, pair+REV ${s4.nat.strike && s4.nat.strike.total}`);
    const tr = s4.ev.signal && s4.ev.signal.trace;
    ok(tr && tr.triggers.some((t) => t.id === 'nat-rev' && t.parts.length >= 6) && (tr.firedAll || []).includes('nat-rev'), 'the signal trace carries the FIRED nat-rev row with every condition');
    ok(/^natural-rev/.test(s4.ev.signal.reason), `signal reason says natural-rev (${s4.ev.signal.reason})`);
    // the v6 signal turns back to bull (an allowed add): the working REV is NOT cancelled; it fills and offsets the bull
    const s5 = await step(rec, run, U, { open: 'bull', at15: true });
    ok(s5.acts.includes('natural-open-kept') && !s5.acts.includes('cancel-open'), `a working REV is kept through a signal flip (${s5.acts.join(',')})`);
    ok(rev.filled && bull.natOffset === true && s5.dec.some((x) => x.action === 'natural-offset' && x.positionId === bull.id), 'the REV fills and marks its pair offset');
    ok(s5.nat.rev.why === 'rev-working', 'no second REV evaluation while one works');
    // offset pair is no longer live: bias recomputed from the REV alone
    const s6 = await step(rec, run, U);
    ok(s6.nat && !s6.nat.live.includes(`bull:${bull.id}`) && s6.nat.live.includes(`bear:${rev.id}`), `offset pair leaves the live book (${s6.nat && s6.nat.live})`);
    ok(rec.state.positions.every((p) => !p.pendingCover && !p.covered), 'v12: nothing covered, nothing resting, all day');
    // the sub-bar worker's cover-on-fill path places nothing either
    const d0 = [];
    await trader.placeContinuousCovers(rec.state, rec.config, cs.buildEngineDeps(run, { getLeg: legFor(U), placeOrder, nowMs: clock }), d0, '10/23 11:00', U);
    ok(d0.length === 0 && rec.state.positions.every((p) => !p.pendingCover), 'placeContinuousCovers is a no-op for v12');
  }
  // v13: the continuous cover waits 30 min from the fill, and never goes on an offset pair
  {
    const run = runOf('v13-20'), rec = store.initRun(cfgOf('v13-20'), '2026-10-23');
    await step(rec, run, 22000, { open: 'bull' });
    await step(rec, run, 22000);
    const bull = rec.state.positions.find((p) => p.side === 'bull');
    ok(bull.filled && !bull.pendingCover, 'v13: filled, no cover at 0 min');
    let s, waited = 0;
    for (let i = 0; i < 5; i++) { s = await step(rec, run, 22020); if (!bull.pendingCover) waited++; }
    ok(waited === 5 && s.nat.v13 && s.nat.v13[0].hold === 'young', `still waiting at 25 min (${s.nat.v13 && JSON.stringify(s.nat.v13[0])})`);
    s = await step(rec, run, 22020);
    ok(bull.pendingCover && s.acts.includes('cover-rest'), `the cover rests once the position is 30 min old (${s.acts.join(',')})`);
    ok(bull.pendingCover && rec.state.positions.every((p) => p === bull || !p.pendingCover), 'only the old live position is covered');
    // a v13 offset pair is never covered
    const rec2 = store.initRun(cfgOf('v13-20', { variant: 'v13-20-o' }), '2026-10-23');
    await step(rec2, run, 22000, { open: 'bull' }); await step(rec2, run, 22000);
    const b2 = rec2.state.positions.find((p) => p.side === 'bull');
    await step(rec2, run, 22070, { nq60: true, zz: zzUp(22070, 70) });
    await step(rec2, run, 22070);
    ok(b2.natOffset === true, 'v13: REV filled, pair offset');
    for (let i = 0; i < 8; i++) await step(rec2, run, 22070);
    const r2 = rec2.state.positions.find((p) => p.natural === 'rev');
    ok(!b2.pendingCover && !b2.covered, 'the offset pair is never covered, even past 30 min');
    ok(r2 && r2.filled && (r2.pendingCover || r2.covered), 'the REV itself is a live position and gets its cover after 30 min');
  }
  // jump guard: book mark at spot -X through the guard limit opens the protective bear; -unc never guards
  {
    const run = runOf('v12-20', { guardFixed: 60, guardAt: 200 }), rec = store.initRun(cfgOf('v12-20', { variant: 'v12-20-g' }), '2026-10-23');
    await step(rec, run, 22000, { open: 'bull' });
    const s2 = await step(rec, run, 22000);
    const g = s2.dec.find((x) => x.action === 'natural-guard');
    ok(s2.nat.guard && s2.nat.guard.breach && s2.nat.guard.X === 60 && s2.nat.guard.limit === -200, `the guard reads X / marks / limit on the record (${JSON.stringify(s2.nat.guard)})`);
    ok(g && g.side === 'bear' && g.floorWith > g.floorBefore, `the guard opens the protective bear and raises the floor (${g && JSON.stringify({ b: g.floorBefore, w: g.floorWith })})`);
    const gp = rec.state.positions.find((p) => p.natural === 'guard');
    ok(gp && gp.side === 'bear' && rec.state.direction === 'bull', 'the guard position is tagged and the held stance is unchanged');
    const runU = runOf('v12-20-unc', { guardFixed: 60, guardAt: undefined }), recU = store.initRun(cfgOf('v12-20-unc', { variant: 'v12-20-unc-g' }), '2026-10-23');
    await step(recU, runU, 22000, { open: 'bull' });
    const u2 = await step(recU, runU, 22000);
    ok(u2.nat.guard && u2.nat.guard.breach === false && u2.nat.guard.limit === null && !u2.acts.includes('natural-guard'), '-unc: no lossMax, the guard never fires');
  }
  // no RTH context: recorded, the REV cannot fire (it needs the run), the ADD gate still works
  {
    const run = runOf('v12-10'), rec = store.initRun(cfgOf('v12-10'), '2026-10-23');
    const s = await step(rec, run, 22000, { open: 'bull', ctx: { error: 'fetch failed' } });
    ok(s.nat && s.nat.ctx.error === 'fetch failed' && s.acts.includes('open'), 'a missing context is recorded; the first open still goes');
  }
  // a non-natural variant never records a natural decision
  {
    const run = runOf('v6-20'), rec = store.initRun(cfgOf('v6-20', { variant: 'v6-20-x' }), '2026-10-23');
    const s = await step(rec, run, 22000, { open: 'bull' });
    ok(!s.nat && !s.acts.some((a) => /natural/.test(a)), 'v6: no natural decisions');
  }

  console.log(`natural live: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
