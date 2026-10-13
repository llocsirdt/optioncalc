'use strict';
// SIGNAL TRACE PARITY (2026-10-13). signal-trace.v7Trace re-states v7Signal's conditions to show every trigger;
// this proves the trace's `fired` is the trigger v7Signal actually returned, on real bars, for every held state
// and several signal configs. A change to v7Signal not mirrored in the trace fails here.
//
// Run: node server/tests/unit/candle-spread-signal-trace.test.js
const fs = require('fs');
const path = require('path');
const { v7Signal } = require('../../src/candle-spread/signals/v7-signals');
const { v6Signal } = require('../../src/candle-spread/signals/v6-signals');
const { v5Signal } = require('../../src/candle-spread/signals/v5-signals');
const { v4Signal } = require('../../src/candle-spread/signals/v4-signals');
const { classicSignal } = require('../../src/candle-spread/signals/classic-signal');
const ST = require('../../src/candle-spread/signals/signal-trace');
const { v7Trace, traceFor } = ST;
// index.js's at15 wrapper: v0-v5 do nothing between 15m closes.
const at15 = (fn) => (A, p, ctx) => (ctx.isFifteen === false ? { openSide: null, cover: false } : fn(A, p, ctx));

let pass = 0, fail = 0; const fails = [];
const ok = (c, m) => { if (c) pass++; else { fail++; if (fails.length < 10) fails.push(m); } };

const idOf = (reason) => {
  const r = String(reason || '');
  if (r === 'neutral' || r === 'intra-5m hold' || r === 'no-15m') return null;
  if (/^5m\+15m flip→bear|^5m early-cover \(2-bar down\)/.test(r)) return '5m-turn-bull';
  if (/^5m\+15m flip→bull|^5m early-cover \(2-bar up\)/.test(r)) return '5m-turn-bear';
  if (/^fast-cover \(5m (turned down|lost)/.test(r)) return 'fast-cover-bull';
  if (/^fast-cover/.test(r)) return 'fast-cover-bear';
  if (r === 'trend-flip→bear') return 'trend-flip-bear';
  if (r === 'trend-flip→bull') return 'trend-flip-bull';
  if (/^be-wrong→bear \(breaking/.test(r)) return 'be-wrong-bear';
  if (/^be-wrong→bull \(breaking/.test(r)) return 'be-wrong-bull';
  if (/^be-wrong→bear \(centerline/.test(r)) return 'be-wrong-cross-bear';
  if (/^be-wrong→bull \(centerline/.test(r)) return 'be-wrong-cross-bull';
  if (/^overext-bottom/.test(r)) return 'overext-bottom';
  if (/^overext-top/.test(r)) return 'overext-top';
  if (/^grind-top/.test(r)) return 'grind-top';
  if (/^grind-bottom/.test(r)) return 'grind-bottom';
  if (/^candle-top/.test(r)) return 'candle-top';
  if (/^candle-bottom/.test(r)) return 'candle-bottom';
  if (/^active-cover into resistance/.test(r)) return 'active-cover-bull';
  if (/^active-cover into support/.test(r)) return 'active-cover-bear';
  if (/^htf-gate \(60m above|^open-veto \(5m turned down|^pause-into-resistance|^trend-cont-bull/.test(r)) return 'trend-cont-bull';
  if (/^htf-gate \(60m below|^open-veto \(5m turned up|^pause-into-support|^trend-cont-bear/.test(r)) return 'trend-cont-bear';
  return 'break-open';
};

const dir = path.join(__dirname, '..', '..', '..', 'tests', 'backtest', 'backtest-data-5m-combined');
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^backtest-NQ-.*\.json$/.test(f)).sort() : [];
const pick = files.filter((f, i) => i % 25 === 0 || i >= files.length - 6);
const cfgs = [{ fiveMin: true, beWrong: true },
  { fiveMin: true, beWrong: true, centerlineCross: 'either', candleConfluenceRadius: 10, fastCover5m: 'trend', breakOpen: 'any', htfGate: 'close', openGate5m: true },
  { trendTf: 'both', beWrong: true, flipMomentum: true, beWrongStrong: true }];
const held = [[false, false], [true, false], [false, true], [true, true]];
let bars = 0, firedSeen = new Set();
for (const f of pick) {
  const arr = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  for (let i = 1; i < arr.length; i++) {
    const A = arr[i].analysis, prior = arr[i - 1].analysis;
    const isFifteen = new Date(arr[i].datetime).getMinutes() % 15 === 0;
    for (const cfg of cfgs) for (const [hb, hr] of held) {
      const ctx = { heldBull: hb, heldBear: hr, isFifteen, cfg };
      const sig = v7Signal(A, prior, ctx), tr = v7Trace(A, prior, ctx);
      const want = idOf(sig.reason);
      ok(tr.fired === want, `${f} #${i} ${JSON.stringify(cfg)} held ${hb}/${hr}: signal "${sig.reason}" (${want}) vs trace ${tr.fired}`);
      if (tr.fired) firedSeen.add(tr.fired);
      bars++;
    }
  }
}
ok(bars > 1000, `v7: ran on real bars (${bars} evaluations over ${pick.length} days)`);
ok(firedSeen.size >= 8, `v7: many different triggers exercised (${[...firedSeen].sort().join(', ')})`);

// ── v4 / v5 / v6 (single held direction) and classic ────────────────────────────────────────────────────
const FAMS = [['v6', v6Signal, ST.v6Trace], ['v5', at15(v5Signal), ST.v5Trace], ['v4', at15(v4Signal), ST.v4Trace]];
const cfgs6 = [{ fiveMin: true }, { fiveMin: true, fastCover5m: 'trend', trendTf: 'both', openGate5m: true, htfGate: 'close', breakOpen: 'any', candleConfluenceRadius: 10, revTrendGate: true },
  { flipMomentum: true, trendTf: '5m', fastCover5m: 'ema' }];
const famSeen = {};
let n2 = 0, nc = 0, classicSeen = new Set();
for (const f of pick) {
  const arr = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  for (let i = 1; i < arr.length; i++) {
    const A = arr[i].analysis, prior = arr[i - 1].analysis;
    const isFifteen = new Date(arr[i].datetime).getMinutes() % 15 === 0;
    for (const heldDir of ['none', 'bull', 'bear']) {
      for (const [fam, sigFn, trFn] of FAMS) for (const cfg of cfgs6) {
        // The live caller passes per-side flags too; a v4-v6 trace must ignore them, as the signal does.
        const ctx = { heldDir, heldBull: true, heldBear: true, isFifteen, cfg };
        const sig = sigFn(A, prior, ctx) || {}, tr = trFn(A, prior, ctx);
        const want = sig.reason == null ? null : idOf(sig.reason);
        ok(tr.fired === want, `${fam} ${f} #${i} ${JSON.stringify(cfg)} held ${heldDir}: signal "${sig.reason}" (${want}) vs trace ${tr.fired}`);
        if (tr.fired) (famSeen[fam] = famSeen[fam] || new Set()).add(tr.fired);
        n2++;
      }
      const sig = at15(classicSignal)(A, prior, { heldDir, isFifteen }), tr = ST.classicTrace(A, prior, { heldDir, isFifteen });
      const open = tr.firedAll.find((x) => /^classic-open-/.test(x)), cov = tr.firedAll.some((x) => /^classic-cover-/.test(x));
      ok((open ? open.replace('classic-open-', '') : null) === (sig.openSide || null) && cov === !!sig.cover,
        `classic ${f} #${i} held ${heldDir}: signal open ${sig.openSide} cover ${sig.cover} vs trace ${tr.firedAll.join(',')}`);
      for (const x of tr.firedAll) classicSeen.add(x);
      nc++;
    }
  }
}
ok(n2 > 1000 && nc > 300, `v4-v6 + classic ran on real bars (${n2} + ${nc} evaluations)`);
for (const [fam] of FAMS) ok(famSeen[fam] && famSeen[fam].size >= 5, `${fam}: many triggers exercised (${famSeen[fam] ? [...famSeen[fam]].sort().join(', ') : 'none'})`);
ok(classicSeen.size === 4, `classic: all four triggers exercised (${[...classicSeen].join(', ')})`);
ok(traceFor('v7-10') === v7Trace && traceFor('v9-20') === v7Trace && traceFor('v8-40-cATM') === ST.v6Trace
  && traceFor('v2-20') === ST.classicTrace && traceFor('v4-10-unc') === ST.v4Trace, 'traceFor maps every family (v8 -> v6, v9 -> v7)');

if (fails.length) console.log(fails.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
