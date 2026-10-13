'use strict';
// SIGNAL TRACE PARITY (2026-10-13). signal-trace.v7Trace re-states v7Signal's conditions to show every trigger;
// this proves the trace's `fired` is the trigger v7Signal actually returned, on real bars, for every held state
// and several signal configs. A change to v7Signal not mirrored in the trace fails here.
//
// Run: node server/tests/unit/candle-spread-signal-trace.test.js
const fs = require('fs');
const path = require('path');
const { v7Signal } = require('../../src/candle-spread/signals/v7-signals');
const { v7Trace, traceFor } = require('../../src/candle-spread/signals/signal-trace');

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
ok(bars > 1000, `ran on real bars (${bars} evaluations over ${pick.length} days)`);
ok(firedSeen.size >= 8, `many different triggers exercised (${[...firedSeen].sort().join(', ')})`);
ok(traceFor('v7-10') === v7Trace && traceFor('v6-10') === null, 'traceFor: v7 only so far');

if (fails.length) console.log(fails.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
