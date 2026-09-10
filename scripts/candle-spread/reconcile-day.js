#!/usr/bin/env node
'use strict';
/**
 * reconcile-day.js — run the BACKTEST for one date and compare it to what the LIVE engine actually did.
 *
 * WHY (user, 2026-09-10): "the backtest performance of the strategies is much better than reality can ever
 * be if orders are placed wishfully… am I missing an aspect of this?" Two live days measured against
 * 765-day averages is an anecdote. This puts the backtest and the live run on the SAME DAY, same variant,
 * same candles — so the difference is execution and pricing, not market luck.
 *
 * The two engines see the same signal series (/NQ) and price on cash NDX, so a residual gap is:
 *   - PRICING: the backtest marks with Black-Scholes (skew-corrected), live gets real chain quotes and
 *     crosses a real spread. This is irreducible; the question is its size.
 *   - EXECUTION: the backtest fills a resting cover when the modelled mark reaches the limit; live needs a
 *     real counterparty at a real price. FILL RATE is the headline comparison.
 *   - DECISIONS: opens/covers the two engines chose differently at all. Any large divergence here is a
 *     PARITY bug, not a modelling difference — see audit-engine-parity.js.
 *
 * Usage:
 *   node scripts/candle-spread/reconcile-day.js --date 2026-09-09 [--variants v6-20,v7-10] [--json <file>]
 *   node scripts/candle-spread/reconcile-day.js --date 2026-09-09 --base https://…   (live source)
 */
const fs = require('fs');
const path = require('path');
const { runDay5m, load5mDays } = require('./backtest-v6-5m');
const { makeGeo, makeAdaptiveGeo } = require('./backtest-width');
const { buildRuns } = require('../../server/src/candle-spread/index');
const VC = require('../../server/src/candle-spread/variant-contract');

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const DATE = arg('--date', null);
const BASE = arg('--base', 'https://d1kbxyxn33vpw2.cloudfront.net');
const ONLY = arg('--variants', null);
const JSONOUT = arg('--json', null);
// Prefer the DUAL set (signals /NQ, pricing cash NDX) — that is the live model. Fall back to the
// NQ-priced history, and SAY SO, because an NQ-priced backtest is answering a different question.
const DIRS = [
  { dir: path.join(__dirname, '..', '..', 'tests', 'backtest', 'backtest-data-5m-nq-ndx'), model: 'dual (NQ signal / NDX pricing)' },
  { dir: path.join(__dirname, '..', '..', 'tests', 'backtest', 'backtest-data-5m-nq'), model: 'NQ-priced (NOT the live model)' },
];
if (!DATE) { console.error('need --date YYYY-MM-DD'); process.exit(2); }

function optsFor(v, days) {
  const o = { rthActionOnly: true, intradayIV: true };
  if (v.ivSkew) o.ivSkew = true;
  if (v.bidirectional) o.bidirectional = true;
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
  if (v.openNeverOtm) o.openNeverOtm = true;
  if (v.coverToStack) { o.coverToStack = true; o.coverToStackVsRisk = true; if (v.coverToStackMinFrac != null) o.coverToStackMinFrac = v.coverToStackMinFrac; }
  // NOTE the ALIAS: live calls this capitalRecapture, the backtest recaptureAlternate. Same feature.
  if (v.capitalRecapture) { o.recaptureAlternate = true; if (v.openAlternateEvery != null) o.openAlternateEvery = v.openAlternateEvery; if (v.creditCoverFrac != null) o.creditCoverFrac = v.creditCoverFrac; }
  if (v.enforceLegUniqueness) { o.enforceLegUniqueness = true; if (v.legMaxShift != null) o.legMaxShift = v.legMaxShift; if (v.legMaxWing != null) o.legMaxWing = v.legMaxWing; }
  if (v.wingConvert) { o.wingConvert = true; for (const k of ['wingMinRatio', 'wingAfterMin', 'wingBudgetFrac', 'wingNaked', 'wingUpsideLambda', 'wingOutSteps', 'wingMaxWings', 'wingQty', 'wingStep', 'wingBandSig']) if (v[k] != null) o[k] = v[k]; }
  o.geo = v.adaptiveGeo
    ? makeAdaptiveGeo({ width: v.spreadWidth || 20, incr: 10, maxDebitFrac: v.capFrac != null ? v.capFrac : 0.65, maxItmStrikes: v.maxItmStrikes != null ? v.maxItmStrikes : 3 })
    : makeGeo({ width: v.spreadWidth || 20, shift: v.spreadShift || 0, capFrac: v.capFrac != null ? v.capFrac : undefined });
  const hasPx = !!(days[0] && days[0].bars && days[0].bars[0] && days[0].bars[0].px);
  if (hasPx) o.priceOf = (b) => b.px || { close: b.analysis['5m'].close, high: b.analysis['5m'].high, low: b.analysis['5m'].low };
  VC.assertForwarded(v, Object.keys(o), 'reconcile-day optsFor',
    ['capitalRecapture', 'openAlternateEvery', 'creditCoverFrac', 'coverToStackMinFrac']);
  return o;
}
const wrap = (v) => (A, p, ctx) => v.signalFn(A, p, { ...ctx, cfg: v.signalCfg || {} });
const usd = (n) => (n == null ? '—' : (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US'));

(async () => {
  // --- backtest side
  let picked = null, day = null;
  for (const cand of DIRS) {
    if (!fs.existsSync(cand.dir)) continue;
    const days = load5mDays(cand.dir);
    // load5mDays reports dates as M/D/YYYY, the API takes YYYY-MM-DD. Normalise both rather than
    // assuming either — matching on the raw string silently found nothing.
    const iso = (v) => {
      if (!v) return null;
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
      const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
      return m ? `${m[3]}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}` : v;
    };
    const d = days.find(x => iso(x.date) === iso(DATE));
    if (d) { picked = { ...cand, days }; day = d; break; }
  }
  if (!day) { console.error(`No backtest dataset covers ${DATE}. Checked:\n  ` + DIRS.map(d => d.dir).join('\n  ')); process.exit(2); }

  const runs = buildRuns().filter(v => !ONLY || ONLY.split(',').includes(v.variant));
  const bt = {};
  for (const v of runs) {
    try {
      const r = runDay5m(day.bars, wrap(v), optsFor(v, picked.days));
      const placed = r.coverBySrc ? Object.values(r.coverBySrc).reduce((a, b) => a + b, 0) : 0;
      bt[v.variant] = { total: Math.round(r.terminal), floor: Math.round(r.floor || 0), opens: r.opens || 0,
        placed, pending: r.coverPending || 0, fill: placed ? Math.round((placed - (r.coverPending || 0)) / placed * 100) : null };
    } catch (e) { bt[v.variant] = { err: (e && e.message || 'run failed').slice(0, 60) }; }
  }

  // --- live side
  const live = {};
  for (const v of runs) {
    try {
      const res = await fetch(`${BASE}/api/v1/candle-spread/runs/NDX/${DATE}?date=${DATE}&variant=${v.variant}&cb=${Date.now()}`);
      if (!res.ok) continue;
      const j = await res.json();
      if (!j || !j.state) continue;
      const se = (j.events || []).filter(e => e.type === 'eod_settlement').pop();
      const pos = j.state.positions || [];
      const covered = pos.filter(p => p.covered).length, unf = pos.filter(p => p.pendingCover && !p.covered).length;
      live[v.variant] = { total: se && se.terminalPnl != null ? se.terminalPnl : null,
        floor: se && se.floorPnl != null ? se.floorPnl : null, opens: pos.length,
        placed: covered + unf, fill: (covered + unf) ? Math.round(covered / (covered + unf) * 100) : null,
        settled: !!se };
    } catch (e) { /* skip */ }
  }

  const both = runs.map(v => v.variant).filter(v => bt[v] && !bt[v].err && live[v] && live[v].total != null);
  console.log(`\nDAY RECONCILIATION — ${DATE}   backtest model: ${picked.model}`);
  console.log(`live source: ${BASE}\n`);
  if (!both.length) { console.log('  no variant has BOTH a backtest run and a settled live run for this date.'); process.exit(0); }

  console.log('variant'.padEnd(14) + 'BACKTEST'.padStart(12) + 'LIVE'.padStart(12) + 'gap'.padStart(12)
    + '  |' + 'bt opens'.padStart(9) + 'live'.padStart(6) + '  |' + 'bt fill'.padStart(8) + 'live'.padStart(6));
  let sb = 0, sl = 0;
  const rows = [];
  for (const v of both) {
    const b = bt[v], l = live[v];
    sb += b.total; sl += l.total;
    rows.push({ variant: v, bt: b.total, live: l.total, gap: l.total - b.total, btFill: b.fill, liveFill: l.fill, btOpens: b.opens, liveOpens: l.opens });
    console.log(v.padEnd(14) + usd(b.total).padStart(12) + usd(l.total).padStart(12)
      + ((l.total >= b.total ? '+' : '') + usd(l.total - b.total)).padStart(12)
      + '  |' + String(b.opens).padStart(9) + String(l.opens).padStart(6)
      + '  |' + ((b.fill == null ? '—' : b.fill + '%')).padStart(8) + ((l.fill == null ? '—' : l.fill + '%')).padStart(6));
  }
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const bf = rows.filter(r => r.btFill != null).map(r => r.btFill), lf = rows.filter(r => r.liveFill != null).map(r => r.liveFill);
  console.log('\n' + '-'.repeat(76));
  console.log('TOTAL'.padEnd(14) + usd(sb).padStart(12) + usd(sl).padStart(12) + ((sl >= sb ? '+' : '') + usd(sl - sb)).padStart(12));
  console.log(`\n  variants compared      ${both.length}`);
  console.log(`  mean cover fill        backtest ${Math.round(mean(bf))}%   live ${Math.round(mean(lf))}%   (the execution gap)`);
  console.log(`  mean opens             backtest ${Math.round(mean(rows.map(r => r.btOpens)))}   live ${Math.round(mean(rows.map(r => r.liveOpens)))}   (a big gap here is a PARITY bug, not modelling)`);
  const beat = rows.filter(r => r.live >= r.bt).length;
  console.log(`  live met/beat backtest ${beat}/${rows.length}`);
  if (JSONOUT) { fs.writeFileSync(JSONOUT, JSON.stringify({ date: DATE, model: picked.model, rows }, null, 2)); console.log(`\n  wrote ${JSONOUT}`); }
  console.log('');
})();
