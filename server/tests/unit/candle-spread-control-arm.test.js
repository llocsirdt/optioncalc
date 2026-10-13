'use strict';
// MOVING THE ARMED SLOT FROM THE CONTROL PAGE (2026-10-12, user: "change/set the live strategy via the control
// page. Same token should apply ... and we should have some validation that the set variant is valid").
//
// Pins:
//   1. strategy-control stores `armed` and resolves it by date: before `from` the previous selection applies
//   2. an off-roster armed selection is refused at write time and ignored at read time
//   3. the handler needs the token; refuses unknown, uncapped and already-armed variants
//   4. 'now' moves the slot (the new variant gets the env's armed mode, the old one simulates, the old one's
//      control entry is dropped) — only while neither session has started
//   5. once a session is under way, 'now' is refused (409) and 'next-session' schedules the move for tomorrow,
//      leaving today on the outgoing variant; arming the current variant again cancels the scheduled move
//
// Run: node server/tests/unit/candle-spread-control-arm.test.js
const os = require('os'), path = require('path'), fs = require('fs');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-arm-'));
process.env.CANDLE_SPREAD_RUNS_DIR = DIR;
process.env.CANDLE_SPREAD_CONTROL_TOKEN = 'tkn';
process.env.CANDLE_SPREAD_LIVE = 'true';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

const SC = require('../../src/candle-spread/strategy-control');
const _l = console.log, _w = console.warn; console.log = () => {}; console.warn = () => {};
const I = require('../../src/candle-spread/index');
const RA = require('../../src/candle-spread/run-archive');
const store = require('../../src/candle-spread/store');
console.log = _l;

const KEY = 'runs/_control/strategy-control.json';
const bucket = new Map();
RA.enabled = () => true;
RA.PREFIX = 'runs';
RA.getObjectRaw = async (k) => (bucket.has(k) ? { ok: true, body: bucket.get(k) } : { ok: false, missing: true });
RA.putObjectRaw = async (k, b) => { bucket.set(k, b); return { ok: true }; };

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const req = (body, tok = 'tkn') => ({ params: {}, query: {}, body, get: (h) => (h.toLowerCase() === 'x-control-token' ? tok : undefined) });

(async () => {
  // ── 1 + 2. STRATEGY-CONTROL ───────────────────────────────────────────────────────────────────────
  {
    const n = SC.normalise({ variants: {}, armed: { variant: 'v9-99' } }, ['v7-10', 'v4-20']);
    ok(!n.armed && /not on the roster/.test(n.armedRejected || ''), `an off-roster armed selection is rejected (${n.armedRejected})`);
    SC._reset();
    SC._state.armed = { variant: 'v4-20', from: '2026-10-13', prev: 'v7-10' };
    ok(SC.armedVariant('2026-10-12', 'v7-10') === 'v7-10', 'before `from`, the previous selection applies');
    ok(SC.armedVariant('2026-10-13', 'v7-10') === 'v4-20', 'from `from`, the new one');
    SC._state.armed = null;
    ok(SC.armedVariant('2026-10-13', 'v7-10') === 'v7-10', 'no selection = the environment default');
    SC._reset();
    const w = await SC.applyPatch({ armed: { variant: 'v9-99' } }, { archive: RA, knownVariants: ['v7-10'], liveAllowed: true, log() {}, warn() {} });
    ok(!w.ok && w.status === 400, `writing an off-roster selection is refused (${w.status} ${w.error})`);
  }

  // ── 3–5. THE HANDLER ──────────────────────────────────────────────────────────────────────────────
  const runs = I.buildRuns();
  I._setRuns(runs);
  SC._reset(); bucket.clear();
  bucket.set(KEY, JSON.stringify({ variants: { 'v7-10': { mode: 'live', note: 'LIVE press' } } }));
  I.applyArmedSelection();
  const r710 = runs.find((r) => r.variant === 'v7-10'), r420 = runs.find((r) => r.variant === 'v4-20');
  ok(I.armedVariant() === 'v7-10' && r710.dryRun === 'test' && r420.dryRun === true, 'starts on the env default');

  let o = await I.handleControlArm(req({ variant: 'v4-20' }, 'wrong'));
  ok(o.status === 401, `the token is required (${o.status})`);
  o = await I.handleControlArm(req({}));
  ok(o.status === 400, 'a variant is required');
  o = await I.handleControlArm(req({ variant: 'v4-2O' }));
  ok(o.status === 400 && /not on the roster/.test(o.body.error), `a typo is refused (${o.body.error})`);
  o = await I.handleControlArm(req({ variant: 'v2-20-unc' }));
  ok(o.status === 400 && /loss cap/.test(o.body.error), `an uncapped variant is refused (${o.body.error})`);
  o = await I.handleControlArm(req({ variant: 'v7-10' }));
  ok(o.status === 400 && /already/.test(o.body.error), 'the current one is refused');
  o = await I.handleControlArm(req({ variant: 'v4-20', when: 'later' }));
  ok(o.status === 400, 'an unknown `when` is refused');

  // 4. before any session: moves now
  o = await I.handleControlArm(req({ variant: 'v4-20', when: 'now' }));
  ok(o.status === 200 && o.body.armedNow === 'v4-20', `moved now (${o.status} ${o.body.error || o.body.armedNow})`);
  ok(r420.dryRun === 'test' && r710.dryRun === true, `the slot moved: v4-20 ${r420.dryRun}, v7-10 ${r710.dryRun}`);
  const file = JSON.parse(bucket.get(KEY));
  ok(file.armed && file.armed.variant === 'v4-20' && !file.variants['v7-10'], 'stored, and the outgoing variant\'s entry dropped');
  const cs = I.controlState();
  ok(cs.armed.variant === 'v4-20' && cs.armed.envDefault === 'v7-10' && !cs.armed.pending, 'the control state reports it');
  ok(cs.armed.armableVariants.includes('v7-10') && !cs.armed.armableVariants.includes('v2-20-unc'), 'and lists only armable variants');

  // 5. v4-20's session is under way with an uncovered position: 'now' is refused, 'next-session' schedules
  const rec = { runId: store.makeRunId('NDX', today, today, 'v4-20'), config: { variant: 'v4-20' },
    events: [{ type: 'candle_close' }], state: { positions: [{ filled: true, covered: false }] } };
  fs.writeFileSync(path.join(DIR, `${rec.runId}.json`), JSON.stringify(rec));
  o = await I.handleControlArm(req({ variant: 'v7-10', when: 'now' }));
  ok(o.status === 409 && /uncovered/.test(o.body.error), `refused mid-session (${o.status} ${o.body.error})`);
  o = await I.handleControlArm(req({ variant: 'v7-10', when: 'next-session' }));
  ok(o.status === 200 && o.body.armedNow === 'v4-20' && o.body.from > today, `scheduled for ${o.body.from}; today stays v4-20`);
  ok(r420.dryRun === 'test' && r710.dryRun === true, 'nothing moved today');
  ok(I.controlState().armed.pending && I.controlState().armed.pending.variant === 'v7-10', 'the pending move is shown');
  o = await I.handleControlArm(req({ variant: 'v4-20', when: 'now' }));
  ok(o.status === 200 && !I.controlState().armed.pending && I.armedVariant() === 'v4-20', 'arming the current variant cancels the scheduled move');

  console.log = _l; console.warn = _w;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
