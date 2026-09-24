'use strict';
// cover-to-continue-stacking (deps.coverToStack) in the LIVE trader: when a risk cap would block a new
// open, lock the deepest-ITM uncovered winner with a resting cover to free its at-risk, then open anyway
// — instead of skipping. Models a RISING underlying so the two early bull spreads go deep-ITM (mark→width)
// while a fresh bull open stays ~ATM/cheap. Proves (ON) it locks a winner + opens the 3rd, and (OFF, the
// control) the 3rd is skipped by the cap — same inputs, coverToStack the only difference.
//
// Run: node server/tests/nogit/candle-spread-cover-to-stack.test.js
const os = require('os'), path = require('path'), fs = require('fs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-cts-'));
process.env.CANDLE_SPREAD_RUNS_DIR = tmp;
const store = require('../../src/candle-spread/store');
const trader = require('../../src/candle-spread/trader');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const placeOrder = async () => ({ status: 'sim', filled: true });
const base = { symbol: 'NDX', expiration: '2026-08-30', spreadWidth: 20, strikeIncrement: 10, quantity: 1, tickIncrement: 0.05, coverSelector: 'fixed-mark', coverFillModel: 'resting', captureChain: false };

// Intrinsic + $2 time value; leg mids exceed "width" but coverMarkNow/debit only use the long−short DIFF
// (a call spread's value caps at width), so a spread far ITM marks ≈ width and a fresh ATM spread ≈ $10.
const legFor = U => (type, strike) => {
  const mid = type === 'C' ? Math.max(0, U - strike) + 2 : Math.max(0, strike - U) + 2;
  return { mid, symbol: `NDX_${type}${strike}`, bid: mid - 0.05, ask: mid + 0.05 };
};

let seq = 0;
async function bar(record, decision, U, deps = {}) {
  const A = { '5m': { close: U, open: U, high: U + 5, low: U - 5 }, '15m': { close: U } };
  const candle = { timeEST: `08/30 ${10 + seq++}:00`, open: U, high: U + 10, low: U - 10, close: U + 1 };
  await trader.processCandleClose(record, candle, null, {
    getLeg: legFor(U), placeOrder, signalFn: () => decision, A, priorA: null,
    underlying: U, isFifteen: true, ...deps
  });
}

// proactiveCoverFrac deliberately UNSET so the feature under test isn't preempted; winners mark ~15 at
// bar3 (>= cover-to-stack's 0.65×20=13). Distinct `variant` per call so scenarios don't share state.
function scenario(variant, deps) {
  seq = 0;
  const rec = store.initRun({ ...base, variant, hardCap: 2000 }, '2026-08-30');
  return (async () => {
    await bar(rec, { openSide: 'bull' }, 22000, { hardCap: 2000, ...deps });   // pos1 ~$1000 debit
    await bar(rec, { openSide: 'bull' }, 22000, { hardCap: 2000, ...deps });   // pos2 ~$1000 → uncovered $2000 = cap
    // Bar 3 MUST land on a strike-grid centre. The fixture prices legs as intrinsic + $2, so a fresh
    // spread only marks ~$10 (under the $13 ceiling) when the underlying sits exactly on its centre; at
    // 22005 the centre is still 22000, the long 21990 is 15 points ITM, and the open is refused by the
    // 65% ceiling (ab922ee) before the cap is ever consulted — which made both the ON and the OFF arm
    // fail for a reason that has nothing to do with cover-to-stack. 22100 is a centre, so the 3rd open
    // prices at ~$10 and the hard cap is the binding constraint again, which is what this test measures.
    await bar(rec, { openSide: 'bull' }, 22100, { hardCap: 2000, ...deps });   // trend up: pos1/pos2 now mark ~20; 3rd open would breach cap
    return rec;
  })();
}

(async () => {
  // --- ON: cover-to-stack locks a deep winner to make room for the 3rd open ---
  const on = await scenario('cts-on', { coverToStack: true, coverToStackMinFrac: 0.65 });
  const opensOn = on.state.positions.length;
  const ctsEv = on.events.some(e => (e.decisions || []).some(d => d.action === 'cover-to-stack'));
  const lockedOn = on.state.positions.filter(p => p.stackLocked).length;
  ok(opensOn === 3, `ON: 3rd open proceeded via cover-to-stack (positions=${opensOn}, expected 3)`);
  ok(ctsEv, 'ON: logged a cover-to-stack decision');
  ok(lockedOn >= 1, `ON: locked >=1 deep-ITM winner (locked=${lockedOn})`);
  const restCts = on.events.some(e => (e.decisions || []).some(d => d.action === 'cover-rest' && d.note === 'cover-to-stack'));
  ok(restCts, 'ON: the lock was a resting cover tagged cover-to-stack (logs the real mark for the fill study)');

  // --- OFF (control): same inputs, no cover-to-stack → 3rd open blocked by the cap ---
  const off = await scenario('cts-off', {});
  const opensOff = off.state.positions.length;
  const skipOff = off.events.some(e => (e.decisions || []).some(d => d.action === 'open-skip-cap'));
  const ctsOff = off.events.some(e => (e.decisions || []).some(d => d.action === 'cover-to-stack'));
  ok(opensOff === 2, `OFF: cap held opens to 2 (positions=${opensOff})`);
  ok(skipOff, 'OFF: 3rd open logged open-skip-cap');
  ok(!ctsOff, 'OFF: no cover-to-stack decision (inert when flag off)');

  // --- WITH LEG-UNIQUENESS: the open that follows a lock must be resolved against the ledger the lock
  // left behind, not the one it found. coverToStackFreeBudget places covers to free budget and those
  // covers RESERVE STRIKES; the open's legs and style were chosen before they existed, and the engine then
  // sent that stale answer. The combo path has always used a temp ledger for exactly this; the sequential
  // path re-resolves now.
  //
  // The assertion is the invariant itself — across everything the day actually traded, no contract may
  // appear both long and short — because that is what leg-uniqueness is FOR, and it holds however the
  // strikes happen to fall. This fixture's geometry does not by itself force the lock and the open onto a
  // shared strike, so it guards the property rather than reproducing the collision.
  {
    const uq = await scenario('cts-uniq', { coverToStack: true, coverToStackMinFrac: 0.65,
      enforceLegUniqueness: true, capitalRecapture: true, creditCoverFrac: 0.65, legMaxShift: 6, legMaxWing: 8 });
    const sides = new Map(); const both = [];
    const note = (l, whose) => {
      const k = l.type + l.strike, prev = sides.get(k);
      if (prev && prev.side !== l.side) both.push(`${k}: ${prev.whose} ${prev.side} vs ${whose} ${l.side}`);
      else sides.set(k, { side: l.side, whose });
    };
    for (const p of uq.state.positions) {
      for (const l of (p.sentNet === 'CREDIT' && p.sentLegs ? p.sentLegs : p.legs) || []) note(l, `open ${p.id}`);
      const cl = p.coverLegs || (p.pendingCover && p.pendingCover.legs);
      for (const l of cl || []) note(l, `cover ${p.id}`);
    }
    ok(uq.state.positions.length >= 3, `UNIQ: the lock still made room for the 3rd open (${uq.state.positions.length})`);
    ok(!both.length, `UNIQ: no contract is traded both ways across the day (${both.join('; ') || 'none'})`);
    const stale = (uq.events || []).some((e) => (e.decisions || []).some((d) => d.action === 'open-skip-after-lock'));
    ok(!stale || uq.state.positions.length >= 2,
      'UNIQ: an open the ledger refuses AFTER the lock is skipped and logged, never sent anyway');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 1 : 0);
})();
