'use strict';
// FEATURE-TEST FAMILIES (2026-10-19): v9sg-* (stack gate 'nqNotAgainst') and v9ob-* (open block against trend 'A') are
// complete copies of every v9 roster variant plus ONE flag. Pins: the copies differ from their v9 twin in nothing else,
// the live trader gates opens the way runDay5m does, the shared NQ read equals the backtest-target read it replaced,
// and the name parsers treat v9sg / v9ob as their own families.
//
// Run: node server/tests/run-unit.js feature-families
const os = require('os'), path = require('path'), fs = require('fs');
process.env.CANDLE_SPREAD_RUNS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-ff-'));
const store = require('../../src/candle-spread/store');
const trader = require('../../src/candle-spread/trader');
const TS = require('../../src/candle-spread/trend-state');
const TGT = require('../../src/candle-spread/backtest/backtest-target');
const cs = require('../../src/candle-spread');
const FA = require('../../src/candle-spread/family-about');
const alias = require('../../src/candle-spread/variant-alias');
const ST = require('../../src/candle-spread/signals/signal-trace');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

// ── 1) clone completeness ───────────────────────────────────────────────────────────────────────────────
{
  const V = cs.VARIANTS, by = new Map(V.map((v) => [v.variant, v]));
  const parents = V.filter((v) => /^v9-/.test(v.variant));
  ok(parents.length === 8, `v9 has 8 roster variants (${parents.length})`);
  const flags = { sg: { stackGate: 'nqNotAgainst' }, ob: { openTrendBlock: 'A' } };
  for (const [tag, f] of Object.entries(flags)) {
    const kids = V.filter((v) => v.variant.startsWith(`v9${tag}-`));
    ok(kids.length === parents.length, `v9${tag} copies every v9 variant (${kids.length})`);
    for (const p of parents) {
      const name = p.variant.replace(/^v9-/, `v9${tag}-`), c = by.get(name);
      if (!c) { ok(false, `${name} missing`); continue; }
      const keys = new Set([...Object.keys(p), ...Object.keys(c)]);
      const diff = [];
      for (const k of keys) {
        if (k === 'variant' || k === 'variantLabel' || k === 'dryRun' || k in f) continue;
        const a = p[k], b = c[k];
        if (typeof a === 'function' || typeof b === 'function') { if (a !== b) diff.push(k); continue; }
        if (JSON.stringify(a) !== JSON.stringify(b)) diff.push(k);
      }
      ok(diff.length === 0, `${name} equals ${p.variant} apart from the flag (differs on: ${diff.join(', ')})`);
      for (const [k, val] of Object.entries(f)) ok(c[k] === val && p[k] == null, `${name}.${k} = ${val}, parent unset`);
      ok(c.dryRun == null || c.dryRun === true, `${name} is never armed`);
      for (const k of Object.keys(c)) if (c[k] && typeof c[k] === 'object') ok(c[k] !== p[k], `${name}.${k} is not shared by reference`);
    }
  }
  ok(cs.listVariants().findIndex((x) => x.variant === 'v9sg-10') > cs.listVariants().findIndex((x) => x.variant === 'v9-40-cATM'),
    'listVariants sorts v9sg after v9');
}

// ── 2) shared NQ read == the backtest-target read it replaced ─────────────────────────────────────────────
{
  let same = 0, n = 0;
  for (let i = 0; i < 2000; i++) {
    const r = () => 100 + Math.round(Math.random() * 20);
    const A = { '5m': { close: r() }, '15m': { close: r(), ema: r() }, '60m': { close: r(), ema: r() } };
    if (i % 50 === 0) A['60m'].ema = null;
    const t = TS.nqStackTrend(A);
    const o15 = TGT.trendOf(A['5m'].close, A['15m'].ema, TGT.nqSlope(A['15m'])), o60 = TGT.trendOf(A['5m'].close, A['60m'].ema, TGT.nqSlope(A['60m']));
    n++; if (t.t15 === o15 && t.t60 === o60) same++;
  }
  ok(same === n, `nqStackTrend matches trendOf/nqSlope on ${same}/${n}`);
  ok(TS.stackGatePasses('bull', { t15: 0, t60: 1 }) && !TS.stackGatePasses('bull', { t15: -1, t60: 1 }) && !TS.stackGatePasses('bear', { t15: 0, t60: 1 }),
    'stackGatePasses: refused only when a timeframe points against the side');
}

// ── 3) name parsers ───────────────────────────────────────────────────────────────────────────────────────
{
  const d = FA.describeVariant('v9sg-20-cATM');
  ok(d && d.family === 'v9sg' && d.width === 20 && /stack gate/.test(d.what), 'family-about describes v9sg-20-cATM');
  ok(FA.describeVariant('v9ob-10-unc') && FA.describeVariant('v9ob-10-unc').family === 'v9ob', 'family-about describes v9ob-10-unc');
  ok(ST.traceFor('v9sg-10') === ST.traceFor('v9-10') && ST.traceFor('v9ob-40') === ST.traceFor('v9-10'), 'signal trace: v9sg/v9ob trace as v9');
  const roster = new Set(['v9-10', 'v9sg-10']);
  const a = alias.canonicalFor({ variant: 'v9sg-10-paper', spreadWidth: 10 }, roster);
  ok(a && a.variant === 'v9sg-10', `a v9sg alias stays in v9sg (${a && a.variant})`);
  ok(alias.canonicalFor({ variant: 'v9ob-10', spreadWidth: 10 }, roster) === null, 'a retired v9ob run is never filed under v9');
}

// ── 4) live gates (trader.processCandleClose) ─────────────────────────────────────────────────────────────
const base = { symbol: 'NDX', expiration: '2026-10-19', spreadWidth: 10, strikeIncrement: 10, quantity: 1, tickIncrement: 0.05,
  coverSelector: 'fixed-mark', coverFillModel: 'resting', captureChain: false };
const legFor = (U) => (type, strike) => {
  const tv = 2.5 * Math.exp(-Math.abs(U - strike) / 25);
  const mid = (type === 'C' ? Math.max(0, U - strike) : Math.max(0, strike - U)) + tv;
  return { mid: Math.round(mid * 20) / 20, symbol: `NDX_${type}${strike}`, bid: mid - 0.05, ask: mid + 0.05 };
};
const placeOrder = async () => ({ status: 'sim', filled: true });
// NQ read: `dir` +1 = 5m close and 15m/60m closes above their EMAs (up), -1 = below (down)
const Aof = (U, dir) => ({ '5m': { close: U, open: U, high: U + 5, low: U - 5 },
  '15m': { close: U + dir * 5, ema: U - dir * 10 }, '60m': { close: U + dir * 5, ema: U - dir * 10 } });
let n = 0;
async function step(rec, U, side, extra, nqDir = 0) {
  const candle = { timeEST: `10/19 10:${String(n++ % 60).padStart(2, '0')}`, open: U, high: U + 5, low: U - 5, close: U };
  return trader.processCandleClose(rec, candle, null, { getLeg: legFor(U), placeOrder, signalFn: () => ({ openSide: side }),
    A: Aof(U, nqDir), priorA: null, underlying: U, isFifteen: true, bidirectional: true, ...extra });
}
const filled = (rec, side) => rec.state.positions.filter((p) => p.side === side && p.filled);
const acts = (r) => ((r && r.decisions) || []).map((x) => x.action);

(async () => {
  // STACK GATE
  {
    const rec = store.initRun({ ...base, variant: 'sg-on' }, '2026-10-19');
    const sg = { stackGate: 'nqNotAgainst' };
    const r1 = await step(rec, 22000, 'bull', sg, -1);
    ok(filled(rec, 'bull').length === 1 && !acts(r1).includes('open-skip-stack-gate'), 'a FIRST bull opens even with NQ down');
    const r2 = await step(rec, 22000, 'bull', sg, -1);
    ok(acts(r2).includes('open-skip-stack-gate') && filled(rec, 'bull').length === 1, 'an ADD to the bull side is refused while NQ points down');
    const d = r2.decisions.find((x) => x.action === 'open-skip-stack-gate');
    ok(d && d.nq15 === -1 && d.nq60 === -1 && d.gate === 'nqNotAgainst', 'the skip records the NQ reads');
    const r3 = await step(rec, 22000, 'bull', sg, 1);
    ok(!acts(r3).includes('open-skip-stack-gate') && filled(rec, 'bull').length === 2, 'the add goes on once NQ points up');
    const r4 = await step(rec, 22000, 'bear', sg, 1);
    ok(!acts(r4).includes('open-skip-stack-gate') && filled(rec, 'bear').length === 1, 'a first bear opens against NQ up (not an add)');
    for (const p of filled(rec, 'bear')) p.covered = true;
    const r5 = await step(rec, 22000, 'bear', sg, 1);
    ok(!acts(r5).includes('open-skip-stack-gate'), 'a covered same-side position does not make an add (scope: uncovered)');
    const r6 = await step(rec, 22000, 'bull', sg, 0);
    ok(!acts(r6).includes('open-skip-stack-gate'), 'a flat NQ read never blocks');
  }
  {
    const rec = store.initRun({ ...base, variant: 'sg-off' }, '2026-10-19');
    await step(rec, 22000, 'bull', {}, -1);
    const r = await step(rec, 22000, 'bull', {}, -1);
    ok(!acts(r).includes('open-skip-stack-gate') && filled(rec, 'bull').length === 2, 'off by default: the add goes on');
  }
  // OPEN TREND BLOCK
  {
    const rec = store.initRun({ ...base, variant: 'ob-on' }, '2026-10-19');
    const down = { t15: -1, hc: -1, hcHH: 0, hf: 0, hfBreak: 0 }, up = { t15: 1, hc: 1, hcHH: 0, hf: 0, hfBreak: 0 };
    const r1 = await step(rec, 22000, 'bull', { openTrendBlock: 'A', trendCtx: down });
    ok(acts(r1).includes('open-skip-trend-block') && filled(rec, 'bull').length === 0, 'a bull against trend A is dropped');
    const d = r1.decisions.find((x) => x.action === 'open-skip-trend-block');
    ok(d && d.def === 'A' && d.trend === -1, 'the skip records the trend');
    const r2 = await step(rec, 22000, 'bear', { openTrendBlock: 'A', trendCtx: down });
    ok(!acts(r2).includes('open-skip-trend-block') && filled(rec, 'bear').length === 1, 'a bear with the trend opens');
    const r3 = await step(rec, 22000, 'bull', { openTrendBlock: 'A', trendCtx: { ...down, hc: 1 } });
    ok(!acts(r3).includes('open-skip-trend-block') && filled(rec, 'bull').length === 1, 'no trend A (15m and hourly disagree): the bull opens');
    const r4 = await step(rec, 22000, 'bull', { openTrendBlock: 'A', trendCtx: up });
    ok(!acts(r4).includes('open-skip-trend-block'), 'a bull in an up trend opens');
  }
  {
    const rec = store.initRun({ ...base, variant: 'ob-off' }, '2026-10-19');
    const r = await step(rec, 22000, 'bull', { trendCtx: { t15: -1, hc: -1 } });
    ok(!acts(r).includes('open-skip-trend-block') && filled(rec, 'bull').length === 1, 'off by default: the bull opens');
  }

  console.log(`feature families: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
