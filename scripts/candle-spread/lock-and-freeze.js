#!/usr/bin/env node
'use strict';
/**
 * lock-and-freeze.js — how often does a day reach a GUARANTEED profit, and should we stop trading when it
 * does?
 *
 * Two questions, and the gap between them is the whole point:
 *   END   — % of days whose FINAL book has a floor >= 0 (no loss possible) or > 0 (profit guaranteed).
 *   EVER  — % of days that reached a positive floor at ANY point intraday.
 * EVER minus END is days that locked a win and then traded it back, which is the case for freezing.
 *
 * But "would freezing have been better" cannot be answered by counting: a frozen book still SETTLES
 * wherever price lands, between its floor and its peak. So the engine snapshots the book at the moment it
 * first qualifies and evaluates THAT book at the day's actual settle (`frozenTerminal`), which is directly
 * comparable to `terminal` — what continuing to trade actually produced.
 *
 * --peak N additionally requires the terminal POTENTIAL to be at least N at the freeze moment, testing the
 * "big upside with tiny risk is worth sitting on" posture rather than freezing on any scrap of a lock.
 *
 * Usage: node scripts/candle-spread/lock-and-freeze.js [--variants v7-10,v6-20] [--peak 0] [--floor 0]
 */
const path = require('path');
const { runDay5m, load5mDays } = require('./backtest-v6-5m');
const { makeGeo, makeAdaptiveGeo } = require('./backtest-width');
const { buildRuns } = require('../../server/src/candle-spread/index');
const VC = require('../../server/src/candle-spread/variant-contract');

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const DIR = arg('--dataDir', path.join(__dirname, '..', '..', 'tests', 'backtest', 'backtest-data-5m-nq'));
const PEAK = Number(arg('--peak', 0));
// --after HH:MM — only consider locking from this ET time onward.
const AFTER = (() => { const v = arg('--after', null); if (!v) return 0; const [h, m] = v.split(':').map(Number); return h * 60 + (m || 0); })();
// --peakVsAvg N — the threshold that adapts to each strategy instead of a flat dollar figure: require the
// current terminal potential to be at least N x that variant's OWN average best case (avgBestCase from the
// committed baselines). A $20k bar means something different to a $10 variant than to a $40 one; this asks
// "is this peak unusually good FOR THIS STRATEGY", which is the question that actually prevents early locks.
const PEAK_VS_AVG = Number(arg('--peakVsAvg', 0));
const BASE = (() => { try { return require(path.join(__dirname, '..', '..', 'server', 'src', 'candle-spread', 'backtest-baselines.json')).variants; } catch (e) { return {}; } })();
const FLOOR = Number(arg('--floor', 0));
const ONLY = arg('--variants', null);

const days = load5mDays(DIR);
const HAS_PX = !!(days[0] && days[0].bars && days[0].bars[0] && days[0].bars[0].px);
const usd = (n) => (n == null ? '—' : (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US'));

function optsFor(v) {
  const avgPeak = (BASE[v.variant] && BASE[v.variant].avgBestCase) || 0;
  const peakMin = PEAK_VS_AVG ? PEAK_VS_AVG * avgPeak : PEAK;
  const o = { rthActionOnly: true, intradayIV: true, lockFloorAt: FLOOR, lockPeakMin: peakMin, lockAfterMin: AFTER };
  if (v.ivSkew) o.ivSkew = true;
  if (v.bidirectional) o.bidirectional = true;
  // exemptTrendStack and capitalCeiling belong here too: v8 is the ONLY family carrying
  // exemptTrendStack, and omitting it applies its softCap WITHOUT the escape hatch, so the control
  // stopped reproducing v8's committed baseline ($880,590 vs $956,024) while every other variant
  // matched. Caught by the standing check that an analysis script must reproduce the baseline.
  for (const k of ['riskCap', 'softCap', 'hardCap', 'capitalCeiling', 'proactiveCoverFrac', 'lossTarget', 'lossMax']) if (v[k] != null) o[k] = v[k];
  if (v.exemptTrendStack) o.exemptTrendStack = true;
  if (v.floorOffset) o.floorOffset = true;
  if (v.continuousCover) o.continuousCover = true;
  if (v.continuousCoverMinLockFrac != null) o.continuousCoverMinLockFrac = v.continuousCoverMinLockFrac;
  if (v.lockCoverMode) o.lockCoverMode = v.lockCoverMode;
  if (v.coverGeometry) o.coverGeometry = v.coverGeometry;
  if (v.continuousCoverArmFrac != null) o.continuousCoverArmFrac = v.continuousCoverArmFrac;
  if (v.continuousCoverOppRatio != null) o.continuousCoverOppRatio = v.continuousCoverOppRatio;
  if (v.coverSelector) o.coverSelector = v.coverSelector;
  if (v.coverToStack) { o.coverToStack = true; o.coverToStackVsRisk = true; if (v.coverToStackMinFrac != null) o.coverToStackMinFrac = v.coverToStackMinFrac; }
  if (v.capitalRecapture) { o.recaptureAlternate = true; if (v.openAlternateEvery != null) o.openAlternateEvery = v.openAlternateEvery; if (v.creditCoverFrac != null) o.creditCoverFrac = v.creditCoverFrac; }
  if (v.enforceLegUniqueness) { o.enforceLegUniqueness = true; if (v.legMaxShift != null) o.legMaxShift = v.legMaxShift; if (v.legMaxWing != null) o.legMaxWing = v.legMaxWing; }
  o.geo = v.adaptiveGeo
    ? makeAdaptiveGeo({ width: v.spreadWidth || 20, incr: 10, maxDebitFrac: v.capFrac != null ? v.capFrac : 0.65, maxItmStrikes: v.maxItmStrikes != null ? v.maxItmStrikes : 3 })
    : makeGeo({ width: v.spreadWidth || 20, shift: v.spreadShift || 0, capFrac: v.capFrac != null ? v.capFrac : undefined });
  if (HAS_PX) o.priceOf = (b) => b.px || { close: b.analysis['5m'].close, high: b.analysis['5m'].high, low: b.analysis['5m'].low };
  // Guard: fail loudly if this variant carries a capability optsFor does not forward. extraOk
  // lists what this script deliberately controls itself (its swept dimension) or handles under
  // another name — everything else missing here would be a silent no-op, not a null result.
  VC.assertForwarded(v, Object.keys(o), 'lock-and-freeze optsFor',
    ['capitalRecapture', 'openAlternateEvery', 'creditCoverFrac', 'coverToStackMinFrac']);
  return o;
}
const wrap = (v) => (A, p, ctx) => v.signalFn(A, p, { ...ctx, cfg: v.signalCfg || {} });

const RUNS = buildRuns().filter((v) => (ONLY ? ONLY.split(',').includes(v.variant) : /^v[0-9]-(10|20|40)$/.test(v.variant)));
console.log(`\nLOCK & FREEZE — ${days.length} days` + (PEAK ? ` · peak >= ${usd(PEAK)}` : '')
  + (PEAK_VS_AVG ? ` · peak >= ${PEAK_VS_AVG}x the variant's OWN avg best case` : '')
  + (AFTER ? ` · not before ${String(Math.floor(AFTER / 60)).padStart(2, '0')}:${String(AFTER % 60).padStart(2, '0')} ET` : '')
  + (FLOOR ? ` · floor >= ${usd(FLOOR)}` : ''));
console.log('END = final book has a guaranteed profit · EVER = reached one at any point intraday');
console.log('FREEZE = what the book AT THAT MOMENT would have paid at the day\'s actual settle, vs what continuing paid\n');
const H = 'variant'.padEnd(9) + 'traded'.padStart(7) + 'END>=0'.padStart(8) + 'END>0'.padStart(7) + 'EVER'.padStart(6)
  + 'gaveBack'.padStart(9) + 'medEpis'.padStart(8) + 'multi'.padStart(7)
  + 'FIRST tot'.padStart(12) + 'win%'.padStart(6) + 'LAST tot'.padStart(12) + 'win%'.padStart(6) + 'BEST tot'.padStart(12);
console.log(H); console.log('-'.repeat(H.length));
const med = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);

for (const v of RUNS) {
  const opts = optsFor(v), fn = wrap(v);
  let traded = 0, endNo = 0, endPro = 0, ever = 0, gaveBack = 0, multi = 0;
  let fWin = 0, lWin = 0;
  const eps = [], dF = [], dL = [], dB = [];
  for (const d of days) {
    const r = runDay5m(d.bars, fn, opts), L = r.lock;
    if (!L.traded) continue;
    traded++;
    if (L.endFloorNoLoss) endNo++;
    if (L.endFloorProfit) endPro++;
    if (!L.everPositive) continue;
    ever++;
    eps.push(L.episodes);
    if (L.episodes > 1) multi++;
    if (!L.endFloorProfit) gaveBack++;
    const a = L.frozenTerminal - r.terminal, b = L.frozenAtLast - r.terminal, c = L.frozenAtBest - r.terminal;
    dF.push(a); dL.push(b); dB.push(c);
    if (a > 0) fWin++;
    if (b > 0) lWin++;
  }
  const p = (n) => (traded ? (n / traded * 100).toFixed(0) + '%' : '-');
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  console.log(v.variant.padEnd(9) + String(traded).padStart(7) + p(endNo).padStart(8) + p(endPro).padStart(7) + p(ever).padStart(6)
    + p(gaveBack).padStart(9) + String(med(eps) ?? '-').padStart(8) + ((ever ? (multi / ever * 100).toFixed(0) : '0') + '%').padStart(7)
    + usd(sum(dF)).padStart(12) + ((ever ? (fWin / ever * 100).toFixed(0) : '0') + '%').padStart(6)
    + usd(sum(dL)).padStart(12) + ((ever ? (lWin / ever * 100).toFixed(0) : '0') + '%').padStart(6)
    + usd(sum(dB)).padStart(12));
}
console.log('\ngaveBack = locked a guaranteed profit intraday but did NOT finish with one');
console.log('multi    = share of locking days that entered the qualifying state MORE THAN ONCE');
console.log('FIRST/LAST/BEST tot = total P&L change across the history if every qualifying day had frozen at');
console.log('  that episode. FIRST and LAST are implementable live; BEST needs hindsight and is the ceiling.');
