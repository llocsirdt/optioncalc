'use strict';
// REMOTE STRATEGY CONTROL — which variants trade, in what mode, right now.
//
// Every existing switch is boot-time: CANDLE_SPREAD_DISABLED is read once, CANDLE_SPREAD_ARMED names ONE
// variant, and changing either needs an env edit plus a restart. This is the first control surface that can
// stand a single strategy down mid-session.
//
// WHAT MATTERS HERE IS THE FAIL-SAFE DIRECTION, not the happy path. Every one of these is a way the feature
// could be worse than not having it:
//   - an absent, empty, or unreadable file means EVERYTHING SIMULATES (never "no restrictions")
//   - a malformed file KEEPS the last known state (a half-saved edit must not release a halt)
//   - mode:'live' is a REQUEST the environment must already permit, so the file alone cannot arm real money
//   - an entry past its `until` reverts to simulate, so a forgotten arming expires
//   - a variant name that matches nothing is REPORTED, because a typo that governs nothing silently is how
//     "I thought I halted it" happens (same lesson as armedSelectionValid)
//
// Run: node server/tests/unit/candle-spread-strategy-control.test.js
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

const SC = require('../../src/candle-spread/strategy-control');
const ROSTER = ['v7-10', 'v6-20', 'v9-20', 'v4-40'];

// A stand-in archive, so this tests the CONTROL logic and not the SDK.
function fakeArchive(objects, behaviour = {}) {
  const store = new Map(Object.entries(objects || {}));
  return { store, PREFIX: 'runs', BUCKET: 'b', enabled: () => behaviour.disabled !== true,
    async getObjectRaw(key, opts) {
      if (behaviour.throws) return { ok: false, error: 'AccessDenied' };
      if (!store.has(key)) return { ok: false, missing: true };
      return { ok: true, body: store.get(key) };
    } };
}
const KEY = 'runs/_control/strategy-control.json';
const quiet = { log: () => {}, warn: () => {} };

(async () => {
  // ── 1. THE DEFAULT IS SIMULATION, FOR EVERY ABSENCE ───────────────────────────────────────────────
  {
    SC._reset();
    await SC.refresh({ archive: fakeArchive({}), knownVariants: ROSTER, liveAllowed: true, ...quiet });
    ok(SC.health().source === 'absent', 'no file at all -> source "absent", not an error');
    ok(SC.health().error === null, 'and it is NOT reported as an error — an absent file is a valid state');
    for (const v of ROSTER) ok(SC.forVariant(v).mode === 'simulate', `${v} simulates when unlisted`);
    ok(SC.dryRunFor('v7-10') === true, 'dryRun true = simulate');
    ok(SC.canOpen('v7-10') === true && SC.canSendOrders('v7-10') === true,
      'simulation is not a restriction — it may still open and send (nothing reaches a broker)');
  }

  // ── 2. MODES MAP ONTO THE ENGINE'S dryRun VOCABULARY ──────────────────────────────────────────────
  {
    SC._reset();
    const file = JSON.stringify({ updatedBy: 'tdriscoll', updatedAt: '2026-09-30T13:40:00Z',
      variants: { 'v7-10': { mode: 'paper', note: 'first funded week' },
                  'v6-20': { mode: 'live', note: 'small size' },
                  'v9-20': 'simulate' } });
    await SC.refresh({ archive: fakeArchive({ [KEY]: file }), knownVariants: ROSTER, liveAllowed: true, ...quiet });
    ok(SC.dryRunFor('v7-10') === 'test', "paper -> dryRun 'test' (real orders, unfillable prices)");
    ok(SC.dryRunFor('v6-20') === false, 'live -> dryRun false (real fillable orders)');
    ok(SC.dryRunFor('v9-20') === true, 'simulate -> dryRun true');
    ok(SC.dryRunFor('v4-40') === true, 'and an unlisted variant is still simulate');
    ok(SC.health().updatedBy === 'tdriscoll', 'provenance is carried through for the audit trail');
    ok(SC.health().live.join() === 'v6-20' && SC.health().paper.join() === 'v7-10',
      'health names what is live and what is paper at a glance');
  }

  // ── 3. `live` IS A REQUEST THE ENVIRONMENT MUST GRANT ─────────────────────────────────────────────
  // The asymmetry: stopping is fast and remote, STARTING real money stays deliberate. Without this, anyone
  // who can write the bucket — or one mistyped line — arms real trading in a single edit.
  {
    SC._reset();
    const file = JSON.stringify({ variants: { 'v6-20': { mode: 'live' } } });
    await SC.refresh({ archive: fakeArchive({ [KEY]: file }), knownVariants: ROSTER, liveAllowed: false, ...quiet });
    ok(SC.forVariant('v6-20').mode === 'paper', 'live is DOWNGRADED to paper when the env master is off');
    ok(SC.forVariant('v6-20').requestedMode === 'live', 'while recording what was actually asked for');
    ok(SC.dryRunFor('v6-20') === 'test', 'so no real fillable order can be sent');
    const d = SC.health().downgraded;
    ok(d.length === 1 && d[0].variant === 'v6-20' && /CANDLE_SPREAD_LIVE/.test(d[0].why),
      'and the downgrade is reported with the reason');
  }

  // ── 4. restrict IS ORTHOGONAL TO mode, AND no-open IS THE SAFE REFLEX ─────────────────────────────
  // A live variant holding an uncovered 0DTE position that stops acting is the most dangerous state there is.
  // no-open lets the cover logic finish; halt is the fire alarm.
  {
    SC._reset();
    const file = JSON.stringify({ variants: {
      'v7-10': { mode: 'live', restrict: 'no-open', note: 'winding down' },
      'v6-20': { mode: 'live', restrict: 'halt', note: 'fills looked wrong' } } });
    await SC.refresh({ archive: fakeArchive({ [KEY]: file }), knownVariants: ROSTER, liveAllowed: true, ...quiet });
    ok(SC.canOpen('v7-10') === false, 'no-open blocks new opens');
    ok(SC.canSendOrders('v7-10') === true, 'but STILL sends orders — covers must be able to finish');
    ok(SC.dryRunFor('v7-10') === false, 'and it is still a live strategy, not demoted');
    ok(SC.canOpen('v6-20') === false && SC.canSendOrders('v6-20') === false, 'halt blocks both');
    ok(SC.health().halted.join() === 'v6-20' && SC.health().noOpen.join() === 'v7-10',
      'health separates halted from no-open — they are different situations');
  }

  // ── 5. AN ENTRY PAST `until` REVERTS TO SIMULATE ──────────────────────────────────────────────────
  {
    SC._reset();
    const file = JSON.stringify({ variants: {
      'v6-20': { mode: 'live', until: '2020-01-01' },
      'v7-10': { mode: 'live', until: '2999-12-31' } } });
    await SC.refresh({ archive: fakeArchive({ [KEY]: file }), knownVariants: ROSTER, liveAllowed: true, ...quiet });
    ok(SC.forVariant('v6-20').mode === 'simulate' && SC.forVariant('v6-20').listed === false,
      'an expired arming is gone, not merely flagged — a forgotten one cannot run for a month');
    ok(SC.forVariant('v7-10').mode === 'live', 'a future date still applies');
    ok(SC.health().expired.length === 1 && SC.health().expired[0].variant === 'v6-20',
      'and the expiry is reported rather than silent');
  }

  // ── 6. A MALFORMED FILE KEEPS THE LAST KNOWN STATE ────────────────────────────────────────────────
  // THE ONE THAT MATTERS MOST. A half-saved edit must not read as "no restrictions" and release every halt.
  {
    SC._reset();
    const good = JSON.stringify({ variants: { 'v6-20': { mode: 'simulate', restrict: 'halt' } } });
    const arch = fakeArchive({ [KEY]: good });
    await SC.refresh({ archive: arch, knownVariants: ROSTER, liveAllowed: true, ...quiet });
    ok(SC.canSendOrders('v6-20') === false, 'control arm: v6-20 is halted');
    arch.store.set(KEY, '{ "variants": { "v6-20": { "mode": ');      // truncated mid-save
    await SC.refresh({ archive: arch, knownVariants: ROSTER, liveAllowed: true, ...quiet });
    ok(SC.canSendOrders('v6-20') === false, 'after a truncated write the halt is STILL in force');
    ok(SC.health().source === 'stale-cache', 'and the state is labelled stale rather than current');
    ok(/not valid JSON/.test(SC.health().error || ''), 'with the parse error reported');
  }

  // ── 7. AN UNREADABLE BUCKET ALSO KEEPS THE LAST STATE ─────────────────────────────────────────────
  // A network blip must not change behaviour in EITHER direction: it cannot release a halt, and it cannot
  // invent one.
  {
    SC._reset();
    const good = JSON.stringify({ variants: { 'v6-20': { mode: 'live' } } });
    await SC.refresh({ archive: fakeArchive({ [KEY]: good }), knownVariants: ROSTER, liveAllowed: true, ...quiet });
    ok(SC.dryRunFor('v6-20') === false, 'control arm: v6-20 is live');
    await SC.refresh({ archive: fakeArchive({ [KEY]: good }, { throws: true }), knownVariants: ROSTER, liveAllowed: true, ...quiet });
    ok(SC.dryRunFor('v6-20') === false, 'a failed read leaves the previous state in force');
    ok(SC.health().source === 'stale-cache' && SC.health().readFails === 1, 'labelled stale, failure counted');
  }
  // With NO previous state, a failure must leave everything simulating rather than defaulting open.
  {
    SC._reset();
    await SC.refresh({ archive: fakeArchive({}, { throws: true }), knownVariants: ROSTER, liveAllowed: true, ...quiet });
    ok(SC.forVariant('v6-20').mode === 'simulate', 'a first-read failure leaves everything in simulation');
  }

  // ── 8. NAMES AND VALUES THAT MEAN NOTHING ARE REPORTED, NOT GUESSED ───────────────────────────────
  {
    SC._reset();
    const file = JSON.stringify({ variants: {
      'v7-1O': { mode: 'live' },                       // letter O, not zero — the classic
      'v6-20': { mode: 'lives' },                      // not a mode
      'v9-20': { mode: 'live', restrict: 'stop' },     // not a restrict
      'v4-40': { mode: 'live', until: '10/03/2026' } } });  // not ISO
    await SC.refresh({ archive: fakeArchive({ [KEY]: file }), knownVariants: ROSTER, liveAllowed: true, ...quiet });
    ok(SC.health().unknownVariants.join() === 'v7-1O', 'a variant name off the roster is named in health');
    ok(SC.health().rejected.length === 3, `and each unusable entry is rejected with a reason (${SC.health().rejected.length})`);
    for (const v of ROSTER) ok(SC.forVariant(v).mode === 'simulate', `${v} was NOT armed by an entry we could not read`);
  }

  // ── 9. AN ARCHIVE THAT IS NOT CONFIGURED AT ALL ───────────────────────────────────────────────────
  {
    SC._reset();
    await SC.refresh({ archive: fakeArchive({}, { disabled: true }), knownVariants: ROSTER, liveAllowed: true, ...quiet });
    ok(SC.forVariant('v7-10').mode === 'simulate', 'no archive -> everything simulates');
    ok(/not configured/.test(SC.health().error || ''), 'and it says why rather than looking healthy');
  }

  // ── 9b. AN UNLISTED VARIANT REPORTS WHAT THE ROSTER GIVES IT, NOT 'simulate' ──────────────────────
  // The control file is not the only thing that arms a variant: CANDLE_SPREAD_ARMED puts v7-10 in paper and the
  // file says nothing about it. Reporting unlisted as `simulate` made the control page say "SIMULATE / nothing
  // listed" while the engine was placing paper orders.
  //
  // AND IT WAS NOT ONLY A DISPLAY BUG. `halt` and `wind-down` preserve the CURRENT mode and read it from here,
  // so without the baseline, halting env-armed v7-10 wrote { mode: 'simulate', restrict: 'halt' } — demoting it
  // — and `resume` then left it explicitly at simulate. A kill switch that quietly changes what a strategy IS
  // is worse than no kill switch.
  {
    SC._reset();
    SC.seedBaseline({ 'v7-10': 'paper', 'v6-20': 'simulate', 'v9-20': 'simulate' });
    await SC.refresh({ archive: fakeArchive({}), knownVariants: ROSTER, liveAllowed: true, ...quiet });
    const c = SC.forVariant('v7-10');
    ok(c.mode === 'paper', `an unlisted but env-armed variant reports paper (${c.mode})`);
    ok(c.listed === false && c.source === 'roster', 'flagged as coming from the roster, not the file');
    ok(SC.forVariant('v6-20').mode === 'simulate', 'a genuinely unarmed variant still reports simulate');
    // health().effective is what the page reads; it must include the env-armed one.
    const eff = SC.health().effective;
    ok(eff.length === 1 && eff[0].variant === 'v7-10' && eff[0].mode === 'paper',
      `health().effective includes it (${JSON.stringify(eff)})`);
    ok(SC.health().listed.length === 0, 'while health().listed stays empty — the file really has no entry');
    // The baseline must not override an explicit entry.
    await SC.refresh({ archive: fakeArchive({ [KEY]: JSON.stringify({ variants: { 'v7-10': { mode: 'simulate' } } }) }),
      knownVariants: ROSTER, liveAllowed: true, ...quiet });
    ok(SC.forVariant('v7-10').mode === 'simulate' && SC.forVariant('v7-10').source === 'control',
      'an explicit control entry overrides the roster baseline');
  }

  // ── 10. THE KEY IS NESTED SO IT CANNOT BE MISTAKEN FOR A RUN RECORD ───────────────────────────────
  ok(SC.controlKey('optioncalc-runs') === 'optioncalc-runs/_control/strategy-control.json',
    `the control key is nested under _control/ (${SC.controlKey('optioncalc-runs')})`);

  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
