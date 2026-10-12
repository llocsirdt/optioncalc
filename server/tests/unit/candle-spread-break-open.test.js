'use strict';
// GREEN-BREAKS-HIGH (2026-10-12) — the v0-v3 open rule as an extra, last-priority trigger for the v4 lineage
// (cfg.breakOpen 'flat' | 'any', off by default). Pins the rule, the held-side gate, and that it never overrides
// a v4 rule or fires when off.
//
// Run: node server/tests/unit/candle-spread-break-open.test.js
const pat = require('../../src/candle-spread/signals/candle-patterns');
const { v4Signal } = require('../../src/candle-spread/signals/v4-signals');
const { v7Signal } = require('../../src/candle-spread/signals/v7-signals');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

// Today's 11:00 bar: green, broke the prior high, ~100 pts under a falling midline.
const prior = { open: 30897, high: 30915.5, low: 30871.75, close: 30896.5 };
const bar = { open: 30896.5, high: 30927.75, low: 30891.25, close: 30918.75 };
ok(pat.breakOpen(bar, prior, null, false, false) === null, 'off by default');
ok(pat.breakOpen(bar, prior, 'flat', false, false).openSide === 'bull', 'green + higher high opens bull');
ok(pat.breakOpen(bar, prior, 'flat', false, true) === null, "'flat' does not open bull against a held bear");
ok(pat.breakOpen(bar, prior, 'any', false, true).openSide === 'bull', "'any' opens bull even against a held bear");
ok(pat.breakOpen({ ...bar, high: 30910 }, prior, 'flat', false, false) === null, 'green without a higher high: nothing');
ok(pat.breakOpen({ open: 30900, high: 30905, low: 30860, close: 30870 }, prior, 'flat', false, false).openSide === 'bear', 'red + lower low opens bear');

// Through the signals: 15m bands far above (no stab, no trend-cont), 5m band nowhere near the low.
const A = { '15m': { ...bar, bbupper: 31156, bbmiddle: 31021, bblower: 30885, ema: 30954 },
  '5m': { open: 30916, high: 30927, low: 30893, close: 30918, bbupper: 30960, bbmiddle: 30920, bblower: 30860, ema: 30915 } };
const P = { '15m': { ...prior, bbupper: 31160, bbmiddle: 31029, bblower: 30899, ema: 30963 }, '5m': A['5m'] };
const off = v4Signal(A, P, { heldDir: 'none', cfg: { widenFrac: null } });
ok(off.openSide === null, `v4 without the flag: no open (${off.reason})`);
const on = v4Signal(A, P, { heldDir: 'none', cfg: { widenFrac: null, breakOpen: 'flat' } });
ok(on.openSide === 'bull' && on.reason === 'green-breaks-high' && on.cover === false, `v4 with the flag: bull (${on.reason})`);
const v7 = v7Signal(A, P, { heldBull: false, heldBear: false, isFifteen: true, cfg: { widenFrac: null, breakOpen: 'flat' } });
ok(v7.openSide === 'bull' && v7.coverSide === null, `v7 with the flag: bull, no cover (${v7.reason})`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
