'use strict';
// THE LIVE STARTUP CHECK, AGAINST THE REAL ROSTER. assertDeps (index.js) refuses to boot when any roster
// field is not represented in buildEngineDeps — on 2026-10-05 placement G added five cfg-read fields, the
// backtest's contract was updated but this one was not, and prod returned 502 on every request after the
// deploy while all 61 unit suites passed (none of them boots the live path). This suite runs the exact
// check the server runs at startup, so that failure mode is caught here instead.
//
// Run: node server/tests/unit/candle-spread-startup-deps.test.js
const CS = require('../../src/candle-spread/index');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

const runs = CS.buildRuns();
let err = null;
try { CS.assertDeps(runs); } catch (e) { err = e; }
ok(!err, `the live startup check accepts every roster variant (${runs.length}) — ${err ? err.message : 'ok'}`);
// And it still bites: an unknown field must be refused, or the test above proves nothing.
let bit = null;
try { CS.assertDeps([{ ...runs[0], someFieldNobodyReads: 1 }]); } catch (e) { bit = e; }
ok(bit && /someFieldNobodyReads/.test(bit.message), 'an unforwarded field is still refused at startup');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
