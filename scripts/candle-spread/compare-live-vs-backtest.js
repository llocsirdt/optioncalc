#!/usr/bin/env node
'use strict';
/**
 * compare-live-vs-backtest.js — WHERE do the live engine and the backtest diverge on the same session?
 *
 * The aggregate P&L difference says they disagree; it does not say why. Both sides record every position
 * with the candle it opened on, the strikes, the price paid, whether a cover filled and at what — so the
 * disagreement can be decomposed instead of guessed at:
 *
 *   SIGNALS   — did the same candles produce opens, on the same side? These SHOULD align almost perfectly:
 *               the signal is a pure function of the multi-TF `A` object, and the dual dataset feeds the
 *               engine the same /NQ series the live run saw. Any mismatch here is a signal-input problem
 *               (data gaps, warmup, cadence), and matters more than any pricing difference.
 *   STRIKES   — given the same signal, did both pick the same strikes? Divergence means geometry or
 *               leg-uniqueness resolution, not the model.
 *   PRICING   — same position, what did each pay? Live marks off the real chain, backtest off BS + the
 *               intraday-IV correction. This is the expected gap and the one worth quantifying.
 *   COVERS    — did the same positions get covered, at the same time, for the same price? The resting-fill
 *               rule is identical in both, so a fill-timing gap points at the mark that drives it.
 *
 * Usage: node scripts/candle-spread/compare-live-vs-backtest.js --date 2026-09-04 [--variant v6-20]
 */
const fs = require('fs');
const path = require('path');
const { runDay5m, load5mDays } = require('./backtest-v6-5m');
const { makeGeo } = require('./backtest-width');
const { buildRuns } = require('../../server/src/candle-spread/index');
const completeness = require('../../shared/run-completeness.js');

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const DATE = arg('--date', null);
const ONLY = arg('--variant', null);
// --force compares anyway. There are real reasons to (inspecting WHERE a run died), but the numbers are
// not a like-for-like decomposition, so it says so loudly rather than quietly producing a table.
const FORCE = process.argv.includes('--force');
if (!DATE) { console.error('need --date YYYY-MM-DD'); process.exit(1); }

const AR = path.join(__dirname, '..', '..', 'candle-spread-archive');
const DUAL = path.join(__dirname, '..', '..', 'tests', 'backtest', 'backtest-data-5m-nq-ndx');
const iso = d => { const [m, dd, y] = d.split('/'); return `${y}-${String(m).padStart(2, '0')}-${String(dd).padStart(2, '0')}`; };
const day = load5mDays(DUAL).find(d => iso(d.date) === DATE);
if (!day) { console.error(`${DATE} is not in the dual dataset (NQ signals + NDX pricing)`); process.exit(1); }

const usd = n => (n == null ? '—' : (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US'));
const priceOf = b => b.px || { close: b.analysis['5m'].close, high: b.analysis['5m'].high, low: b.analysis['5m'].low };

// The config the deployed server ran — so a difference here is NOT a config difference.
function deployedOpts(v) {
  const o = { rthActionOnly: true, intradayIV: true, priceOf, hardCap: 20000,
    coverToStack: true, coverToStackVsRisk: true, coverToStackMinFrac: 0.65,
    recaptureAlternate: true, openAlternateEvery: 3, creditCoverFrac: 0.65,
    enforceLegUniqueness: true, legMaxShift: 6, legMaxWing: 8, recordReplay: true };
  if (v.bidirectional) o.bidirectional = true;
  if (v.exemptTrendStack) o.exemptTrendStack = true;
  if (v.proactiveCoverFrac != null) o.proactiveCoverFrac = v.proactiveCoverFrac;
  if (v.softCap != null) o.softCap = v.softCap;
  // v0-v3 differ ONLY by cover selector (fixed/greedy/joint/fixed-mark). Omitting it collapses all four
  // into one identical run — which reads as the backtest disagreeing with live when it is really the
  // comparison config being wrong.
  if (v.coverSelector) o.coverSelector = v.coverSelector;
  const w = v.spreadWidth, sh = v.spreadShift || 0, cf = v.capFrac;
  // Always explicit — the old conditional let a $20 shift-0 variant fall through to the base engine's own
  // geometry and silently miss changes made here. Same trap as in build-backtest-baselines.js.
  o.geo = makeGeo({ width: w || 20, shift: sh, capFrac: cf != null ? cf : undefined });
  return o;
}

const RUNS = buildRuns();
const files = fs.readdirSync(AR).filter(f => f.includes(`_${DATE}_`));
const rows = [];
const incomplete = [];   // live runs that never settled — excluded unless --force
for (const f of files) {
  const name = f.replace(/^NDX_[0-9-]+_[0-9-]+_/, '').replace('.json', '');
  if (ONLY && name !== ONLY) continue;
  const v = RUNS.find(r => r.variant === name);
  if (!v) continue;                                   // retired / pre-sweep variant naming
  let j; try { j = JSON.parse(fs.readFileSync(path.join(AR, f), 'utf8')); } catch (e) { continue; }
  // COMPLETENESS GATE. The backtest always runs the WHOLE session; a live run that died mid-afternoon did
  // not. Decomposing the two then attributes the missing hours to signals/strikes/pricing — the exact
  // wrong conclusion, and an invisible one, because a truncated run looks like a finished one.
  const comp = completeness.assessRun(j);
  if (!comp.complete) {
    incomplete.push({ name, detail: comp.detail });
    if (!FORCE) continue;
  }
  const fn = (A, p, ctx) => v.signalFn(A, p, { ...ctx, cfg: v.signalCfg || {} });
  const bt = runDay5m(day.bars, fn, deployedOpts(v));

  // Both sides as comparable position lists, keyed by the candle they opened on.
  const norm = (p, src) => ({
    src, time: p.openTime, side: p.side, lo: Math.min(...p.legs.map(l => l.strike)), hi: Math.max(...p.legs.map(l => l.strike)),
    limit: p.limit, covered: !!p.covered, coverTime: p.coverTime || null, coverLimit: p.coverLimit != null ? p.coverLimit : null,
  });
  const L = (j.state.positions || []).filter(p => p.filled).map(p => norm(p, 'live'));
  const B = (bt.positions || []).map(p => norm(p, 'bt'));
  rows.push({ name, L, B });
}
if (incomplete.length) {
  console.log(`\n${FORCE ? '!! COMPARING ANYWAY (--force)' : '!! EXCLUDED'} — ${incomplete.length} live run(s) never settled:`);
  for (const x of incomplete.slice(0, 6)) console.log(`   ${x.name.padEnd(14)} ${x.detail}`);
  if (incomplete.length > 6) console.log(`   …and ${incomplete.length - 6} more`);
  console.log(FORCE
    ? '   The backtest runs the FULL session; these did not. Differences below include missing time,\n   not just model divergence — this is not a like-for-like decomposition.\n'
    : '   The backtest runs the FULL session, so decomposing against a truncated live run charges the\n   missing hours to signals/strikes/pricing. Re-run with --force to inspect them anyway.\n');
}
if (!rows.length) {
  console.error(incomplete.length && !FORCE
    ? `no COMPLETE live runs for ${DATE} — every archived run that day is truncated (see above)`
    : `no comparable variants for ${DATE} (live archive may predate the width sweep)`);
  process.exit(1);
}

console.log(`LIVE vs BACKTEST decomposition — ${DATE} · ${rows.length} variant(s) · config matched to the deployed build\n`);

// ── aggregate: where does the disagreement live? ──────────────────────────────────────────────────────
let sigSame = 0, sigLiveOnly = 0, sigBtOnly = 0, strikeDiff = 0, priced = 0, priceGap = 0, absGap = 0;
let coverBoth = 0, coverLiveOnly = 0, coverBtOnly = 0, coverTimeSame = 0, coverGap = 0, coverPriced = 0;
const detail = [];
for (const r of rows) {
  const key = p => `${p.time}|${p.side}`;
  const lm = new Map(), bm = new Map();
  for (const p of r.L) { if (!lm.has(key(p))) lm.set(key(p), []); lm.get(key(p)).push(p); }
  for (const p of r.B) { if (!bm.has(key(p))) bm.set(key(p), []); bm.get(key(p)).push(p); }
  for (const [k, ls] of lm) {
    const bs = bm.get(k) || [];
    const n = Math.min(ls.length, bs.length);
    sigSame += n; sigLiveOnly += ls.length - n;
    for (let i = 0; i < n; i++) {
      const a = ls[i], b = bs[i];
      if (a.lo !== b.lo || a.hi !== b.hi) { strikeDiff++; if (detail.length < 12) detail.push(`${r.name} ${a.time} ${a.side}: strikes live ${a.lo}/${a.hi} vs bt ${b.lo}/${b.hi}`); }
      else { priced++; priceGap += (b.limit - a.limit); absGap += Math.abs(b.limit - a.limit); }
      if (a.covered && b.covered) { coverBoth++; if (a.coverTime === b.coverTime) coverTimeSame++;
        if (a.coverLimit != null && b.coverLimit != null) { coverPriced++; coverGap += (b.coverLimit - a.coverLimit); } }
      else if (a.covered) coverLiveOnly++; else if (b.covered) coverBtOnly++;
    }
  }
  for (const [k, bs] of bm) { const ls = lm.get(k) || []; if (bs.length > ls.length) sigBtOnly += bs.length - ls.length; }
}
const pct = (a, b) => b ? (a / b * 100).toFixed(0) + '%' : '—';
const totalOpens = sigSame + sigLiveOnly + sigBtOnly;
console.log('SIGNALS  (same candle + same side = the signal fired identically)');
console.log(`  matched ${sigSame}/${totalOpens} (${pct(sigSame, totalOpens)})   live-only ${sigLiveOnly}   backtest-only ${sigBtOnly}`);
console.log('');
console.log('STRIKES  (of the matched signals, did both pick the same legs?)');
console.log(`  same ${sigSame - strikeDiff}/${sigSame} (${pct(sigSame - strikeDiff, sigSame)})   differing ${strikeDiff}`);
console.log('');
console.log('PRICING  (same signal, same strikes — what did each pay?)');
console.log(`  n=${priced}   mean bt−live ${usd(priced ? priceGap / priced * 100 : 0)}/contract   mean |diff| ${usd(priced ? absGap / priced * 100 : 0)}   total ${usd(priceGap * 100)}`);
console.log('');
console.log('COVERS');
console.log(`  both covered ${coverBoth}   live-only ${coverLiveOnly}   backtest-only ${coverBtOnly}`);
console.log(`  of those both-covered: same candle ${coverTimeSame}/${coverBoth} (${pct(coverTimeSame, coverBoth)})   mean cover price bt−live ${usd(coverPriced ? coverGap / coverPriced * 100 : 0)}`);
if (detail.length) { console.log(''); console.log('first strike mismatches:'); detail.forEach(d => console.log('  ' + d)); }

// ── per-variant, when a single variant was asked for ──────────────────────────────────────────────────
if (ONLY && rows.length === 1) {
  const r = rows[0];
  console.log(`\nPOSITION TIMELINE — ${r.name}`);
  console.log('time         side   live strikes @ price      backtest strikes @ price     cover live / bt');
  const all = [...new Set([...r.L, ...r.B].map(p => p.time))].sort();
  for (const t of all) {
    const l = r.L.filter(p => p.time === t), b = r.B.filter(p => p.time === t);
    const n = Math.max(l.length, b.length);
    for (let i = 0; i < n; i++) {
      const a = l[i], c = b[i];
      const fmt = p => p ? `${p.lo}/${p.hi} @ ${p.limit.toFixed(2)}` : '—';
      const cov = p => p ? (p.covered ? `${p.coverTime || '?'}@${p.coverLimit != null ? p.coverLimit.toFixed(2) : '?'}` : 'naked') : '—';
      console.log(`${t}  ${((a || c).side || '').padEnd(5)}  ${fmt(a).padEnd(24)} ${fmt(c).padEnd(28)} ${cov(a)} / ${cov(c)}`);
    }
  }
}
