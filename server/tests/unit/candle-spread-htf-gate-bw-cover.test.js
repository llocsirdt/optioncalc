'use strict';
// HOURLY BAND GATE + BE-WRONG COVER (2026-10-12, both off by default). The user's reads of v7-10's 11:30 and 11:45
// opens: (1) no trend-continuation open in the direction the last completed hour already closed beyond its band;
// (2) when a be-wrong reversal also qualifies as an overextension reversal, cover the wrong-way side.
//
// Run: node server/tests/unit/candle-spread-htf-gate-bw-cover.test.js
const pat = require('../../src/candle-spread/signals/candle-patterns');
const { v4Signal } = require('../../src/candle-spread/signals/v4-signals');
const { v7Signal } = require('../../src/candle-spread/signals/v7-signals');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

// 11:30: the 15m 11:15-11:30 bar (red, below a falling midline + 9EMA) and the 10:00-11:00 hour closed under its band.
const h60 = { open: 30960.75, high: 30974.5, low: 30857.25, close: 30918.75, bbupper: 31322.29, bbmiddle: 31137.4, bblower: 30952.51, ema: 31049.62 };
ok(pat.htfOverextended({ '60m': h60 }, 'bear', 'close'), "'close': the hour closed below its lower band");
ok(!pat.htfOverextended({ '60m': h60 }, 'bear', null), 'off by default');
ok(!pat.htfOverextended({ '60m': { ...h60, close: 30960 } }, 'bear', 'close'), "'close': closed back inside -> no gate");
ok(pat.htfOverextended({ '60m': { ...h60, close: 30960 } }, 'bear', 'touch'), "'touch': the wick below the band is enough");
ok(!pat.htfOverextended({ '60m': h60 }, 'bull', 'touch'), 'the bear-side stretch never gates a bull open');

const A = { '15m': { open: 30904.75, high: 30921.5, low: 30885.25, close: 30886, bbupper: 31159, bbmiddle: 31003.18, bblower: 30853.18, ema: 30932.62 },
  '5m': { open: 30890, high: 30895, low: 30885.25, close: 30886, bbupper: 30960, bbmiddle: 30910, bblower: 30840, ema: 30900 }, '60m': h60 };
const P = { '15m': { open: 30919.75, high: 30928.25, low: 30890.25, close: 30905, bbmiddle: 31011.94, ema: 30944.28 }, '5m': A['5m'] };
const cfg0 = { widenFrac: null, activeCoverRadius: null };
ok(v4Signal(A, P, { heldDir: 'none', cfg: cfg0 }).reason === 'trend-cont-bear', 'without the gate: trend-cont-bear (what fired live)');
const g = v4Signal(A, P, { heldDir: 'none', cfg: { ...cfg0, htfGate: 'close' } });
ok(g.openSide === null && /htf-gate/.test(g.reason), `v4 with the gate: blocked (${g.reason})`);
const g7 = v7Signal(A, P, { heldBull: false, heldBear: false, isFifteen: true, cfg: { ...cfg0, htfGate: 'close' } });
ok(g7.openSide === null && /htf-gate/.test(g7.reason), `v7 with the gate: blocked (${g7.reason})`);

// 11:45: the 11:30-11:45 bar — bullish reversal breaking the prior high, wick to the 5m lower band, held bear.
const B = { '15m': { open: 30885.75, high: 30942.75, low: 30877.75, close: 30937.75, bbupper: 31150, bbmiddle: 30996.09, bblower: 30847.81, ema: 30933.65 },
  '5m': { open: 30900, high: 30942.75, low: 30877.75, close: 30937.75, bbupper: 30950, bbmiddle: 30915, bblower: 30880, ema: 30915 }, '60m': h60 };
const PB = { '15m': { open: 30904.75, high: 30921.5, low: 30885.25, close: 30886, bbmiddle: 31003.18, ema: 30932.62 }, '5m': A['5m'] };
const ctx = (c) => ({ heldBull: false, heldBear: true, isFifteen: true, cfg: { ...cfg0, beWrong: true, ...c } });
const base = v7Signal(B, PB, ctx({}));
ok(base.openSide === 'bull' && base.coverSide === null && /be-wrong/.test(base.reason), `live behaviour: be-wrong bull, bear left uncovered (${base.reason})`);
const rc = v7Signal(B, PB, ctx({ beWrongCover: 'reversal' }));
ok(rc.openSide === 'bull' && rc.coverSide === 'bear', "'reversal': the bar is also an overextension bottom -> cover the bear");
const noRev = { ...B, '5m': { ...B['5m'], bblower: 30800 } };   // wick nowhere near the 5m band: not a reversal
ok(v7Signal(noRev, PB, ctx({ beWrongCover: 'reversal' })).coverSide === null, "'reversal': no overextension -> stays a hedge");
ok(v7Signal(noRev, PB, ctx({ beWrongCover: 'always' })).coverSide === 'bear', "'always': covers on every be-wrong");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
