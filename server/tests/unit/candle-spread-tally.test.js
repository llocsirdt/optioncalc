'use strict';
// THE STATUS COUNTERS MUST COUNT SUB-BAR ACTIVITY.
//
// A resting cover usually fills BETWEEN bars, in the 30s sub-bar pass, which records its decisions on a
// `resting_work` event rather than a `candle_close`. tallyRun filtered to candle_close, so on prod v7-10
// 2026-10-01 it reported coverFills: 11 against covered: 31 — 20 real fills invisible. That reads as a 66%
// cover failure on a day that covered 31 of 32 positions, and cover failure is the single most dangerous
// thing to be wrong about: live, an uncovered 0DTE position runs into settlement unbounded by lossMax.
//
// The filter predated the sub-bar worker emitting decisions, and the worker was dead from 2026-09-23 until
// the initRunSafe fix — so nothing contradicted the number for over a week.
//
// Run: node server/tests/unit/candle-spread-tally.test.js
const cs = require('../../src/candle-spread/index');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

const ev = (type, ...actions) => ({ type, decisions: actions.map((a) => ({ action: a })) });

// THE REAL SHAPE, from the prod v7-10 record of 2026-10-01: 32 opens, 32 cover-rest, and 31 cover-fills
// split 11 at a candle close / 20 in the sub-bar worker.
const record = { events: [
  ...Array.from({ length: 32 }, () => ev('candle_close', 'open', 'cover-rest')),
  ...Array.from({ length: 11 }, () => ev('candle_close', 'cover-fill')),
  ...Array.from({ length: 20 }, () => ev('resting_work', 'cover-fill')),
  // Noise that must NOT be counted: these are not the four tallied actions.
  ...Array.from({ length: 39 }, () => ev('resting_work', 'open-rest')),
  ...Array.from({ length: 10 }, () => ev('resting_work', 'cover-reprice')),
  ev('candle_close', 'neutral', 'open-skip-ceiling', 'open-skip-leg'),
  ev('eod_settlement'), ev('session_close'),
] };

const t = cs.tallyRun(record);
ok(t.coverFills === 31, `coverFills counts sub-bar fills too: want 31, got ${t.coverFills}`);
ok(t.coverFills !== 11, 'and is not the candle_close-only undercount that shipped');
ok(t.opens === 32, `opens: want 32, got ${t.opens}`);
ok(t.covers === 32, `covers: want 32, got ${t.covers}`);
ok(t.cancels === 0, `cancels: want 0, got ${t.cancels}`);

// NO DOUBLE-COUNTING. Dropping the event filter is only safe because the four tallied actions are each
// emitted once per occurrence; if a future event type ever echoes a decision, this catches it.
const one = cs.tallyRun({ events: [ev('candle_close', 'open'), ev('resting_work', 'cover-fill')] });
ok(one.opens === 1 && one.coverFills === 1, `one of each counts once (${JSON.stringify(one)})`);

// A cancel is a cancel wherever it is recorded.
const c = cs.tallyRun({ events: [ev('resting_work', 'cancel-open')] });
ok(c.cancels === 1, `a sub-bar cancel-open counts: got ${c.cancels}`);

// Empty and malformed records must not throw — status() calls this on every run, every poll.
ok(JSON.stringify(cs.tallyRun({ events: [] })) === '{"opens":0,"covers":0,"coverFills":0,"cancels":0}', 'empty record tallies zero');
ok(cs.tallyRun({}).opens === 0, 'a record with no events does not throw');
ok(cs.tallyRun({ events: [{ type: 'x' }] }).opens === 0, 'an event with no decisions does not throw');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
