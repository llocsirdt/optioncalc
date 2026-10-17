'use strict';
// STACK GATE on runDay5m (backtest-only, 2026-10-17): opts.stackGate gates ADDS (an open on side X while the book holds a
// same-side position; opts.stackScope 'uncovered' | 'any') on the RTH (or NQ) 15m/60m trend read.
// Off = identical; a first open on an empty side is never gated; notAgainst / oneWith / nqNotAgainst semantics; scope.
//
// Run: cd server && node tests/run-unit.js stack-gate
const { runDay5m } = require('../../src/candle-spread/backtest/backtest-v6-5m');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

const DAY0 = Date.UTC(2026, 9, 16, 4, 0, 0);   // EDT
// closes[k] = close of the bar stamped 09:35 + 5k. nqDir: +1 = NQ 15m/60m trend up, -1 = down.
function makeDay(closes, nqDir) {
  const bars = []; let prev = closes[0];
  for (let m = 9 * 60; m <= 16 * 60; m += 5) {
    const k = Math.max(0, (m - 575) / 5), c = m < 575 ? closes[0] : closes[Math.min(k, closes.length - 1)];
    const o = prev, f = { open: o, high: Math.max(o, c) + 2, low: Math.min(o, c) - 2, close: c, bbupper: c + 60, bblower: c - 60, bbmiddle: c, ema: c }; prev = c;
    const t = { open: c, high: c + 30, low: c - 30, close: c + 2 * nqDir, bbupper: c + 150, bblower: c - 150, bbmiddle: c, ema: c - 5 * nqDir };
    bars.push({ dt: DAY0 + m * 60000, analysis: { '1m': f, '5m': f, '15m': t, '60m': { ...t }, m }, px: null, fifteen: m % 15 === 0 });
  }
  return bars;
}
const priceOf = (b) => { const c = b.analysis['5m']; return { close: c.close, high: c.high, low: c.low }; };
// prior sessions: a steady ramp from `from` to `to` (RTH trend up when to > from and today sits above), or flat
const prior = (from, to) => { const bars = []; let n = 0; const N = 8 * 78;
  for (let s = 8; s >= 1; s--) for (let m = 575; m <= 960; m += 5) { const c = from + (to - from) * (n++ / N); bars.push({ day: `2026-10-${String(16 - s).padStart(2, '0')}`, min: m, open: c, high: c + 1, low: c - 1, close: c }); }
  return { priorBars: bars, priorClose: to }; };
const sig = (side, mins) => (A) => ({ openSide: mins.includes(A.m) ? side : null, cover: false });
const base = { rthActionOnly: true, priceOf, bidirectional: true, recordReplay: true };
const flat = Array.from({ length: 80 }, (_, k) => 20000 + (k % 2));
const RTH_UP = prior(19700, 19995), RTH_FLAT = prior(20000, 20000);
const strip = (r) => JSON.stringify({ t: r.terminal, o: r.opens, p: r.positions.map((p) => [p.side, p.limit, p.covered, p.coverLimit]) });

// 1) off = identical
{
  const bars = makeDay(flat, 1), fn = sig('bull', [600, 620, 640]);
  const a = runDay5m(bars, fn, { ...base, rthCtx: RTH_UP });
  const b = runDay5m(bars, fn, { ...base, rthCtx: RTH_UP, stackGate: 'off', stackScope: 'uncovered' });
  ok(a.opens === 3 && strip(a) === strip(b) && a.stackGate === undefined && b.stackGate === undefined, 'off = byte-identical, no telemetry');
}

// 2) only ADDS are gated: RTH trend UP, bears are 'against'
{
  const r = runDay5m(makeDay(flat, 1), sig('bear', [600, 620, 640]), { ...base, rthCtx: RTH_UP, stackGate: 'notAgainst' });
  ok(r.opens === 1 && r.stackGate.blocked === 2 && r.stackGate.adds === 2, `first bear opens, the two bear adds are refused (opens ${r.opens}, blocked ${r.stackGate.blocked})`);
  const bull = runDay5m(makeDay(flat, 1), sig('bull', [600, 620, 640]), { ...base, rthCtx: RTH_UP, stackGate: 'notAgainst' });
  ok(bull.opens === 3 && bull.stackGate.blocked === 0, 'with-trend bull adds pass notAgainst');
  const ow = runDay5m(makeDay(flat, 1), sig('bull', [600, 620, 640]), { ...base, rthCtx: RTH_UP, stackGate: 'oneWith' });
  ok(ow.opens === 3, 'with-trend bull adds pass oneWith');
}

// 3) notAgainst vs oneWith on a MIXED RTH read (flat prior, flat day): notAgainst passes, oneWith refuses the adds
{
  const fn = sig('bull', [600, 620, 640]);
  const still = new Array(80).fill(20000);   // exactly on the lines: neither TF with nor against
  const na = runDay5m(makeDay(still, 1), fn, { ...base, rthCtx: RTH_FLAT, stackGate: 'notAgainst' });
  const ow = runDay5m(makeDay(still, 1), fn, { ...base, rthCtx: RTH_FLAT, stackGate: 'oneWith' });
  ok(na.opens === 3 && ow.opens === 1 && ow.stackGate.blocked === 2, `mixed RTH: notAgainst ${na.opens} opens, oneWith ${ow.opens}`);
  // NQ read: NQ trend DOWN while the RTH read is UP -> bull adds pass notAgainst (RTH) but fail nqNotAgainst
  const rth = runDay5m(makeDay(flat, -1), fn, { ...base, rthCtx: RTH_UP, stackGate: 'notAgainst' });
  const nq = runDay5m(makeDay(flat, -1), fn, { ...base, rthCtx: RTH_UP, stackGate: 'nqNotAgainst' });
  ok(rth.opens === 3 && nq.opens === 1 && nq.stackGate.blocked === 2, `NQ down / RTH up: notAgainst ${rth.opens}, nqNotAgainst ${nq.opens}`);
  const r15 = runDay5m(makeDay(flat, 1), sig('bear', [600, 620]), { ...base, rthCtx: RTH_UP, stackGate: 'rth15' });
  ok(r15.opens === 1 && r15.stackGate.blocked === 1, 'rth15 refuses an against-trend add');
}

// 4) scope: a COVERED same-side position is an add only under scope 'any'
{
  // falling day, bears covered on the drop; NQ trend UP so a bear add fails nqNotAgainst
  const fall = Array.from({ length: 80 }, (_, k) => (k < 2 ? 20000 : Math.max(19850, 20000 - 8 * (k - 1))));
  const cov = { continuousCover: true, continuousCoverMinLockFrac: 0, coverLadder: true, ladderStepSeconds: 120, ladderStepPoints: 10, ladderLossCapFrac: 0,
    ladderStepDollars: 0.05, simFillAtLimit: true, coverFillAtResting: true, subBarFill: 'path' };
  const fn = sig('bear', [580, 720]);
  const unc = runDay5m(makeDay(fall, 1), fn, { ...base, ...cov, rthCtx: RTH_FLAT, stackGate: 'nqNotAgainst' });
  const any = runDay5m(makeDay(fall, 1), fn, { ...base, ...cov, rthCtx: RTH_FLAT, stackGate: 'nqNotAgainst', stackScope: 'any' });
  const firstCovered = unc.positions[0] && unc.positions[0].covered && unc.positions[0].coverEpoch < DAY0 + 720 * 60000;
  ok(firstCovered, 'the first bear is covered before the second signal');
  ok(unc.opens === 2 && unc.stackGate.adds === 0, `scope uncovered: a covered same-side position is not an add (opens ${unc.opens})`);
  ok(any.opens === 1 && any.stackGate.blocked === 1, `scope any: it is, and the against-NQ add is refused (opens ${any.opens})`);
}

console.log(`stack gate: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
