'use strict';
// LEG-UNIQUENESS ledger + resolver: a leg (type,strike) may only be traded one direction/day. Verifies
// the user's exact example — open bull 29300/29320 (long C29300), then a bull at 29280/29300 would SHORT
// C29300 → resolve to the parity TWIN (puts, same strikes); shift only when BOTH ladders are blocked.
//
// Run: node server/tests/nogit/candle-spread-leg-ledger.test.js
const { makeLegLedger, resolveOpen, resolveCover } = require('../../src/candle-spread/leg-ledger');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const OPT = { incr: 20, maxShift: 6, preferStyle: 'debit' };

const L = makeLegLedger();
const first = resolveOpen('bull', 29300, 29320, L, OPT);
ok(first.resolution === 'ideal' && first.style === 'debit', 'first open lands ideal debit calls');
L.record(first.legs);
ok(L.sideOf('C', 29300) === 'long' && L.sideOf('C', 29320) === 'short', 'ledger recorded C29300 long / C29320 short');

// The conflicting second open (would short C29300, already long) → parity twin on the put ladder.
const second = resolveOpen('bull', 29280, 29300, L, OPT);
ok(second.resolution === 'twin' && second.style === 'credit' && second.lo === 29280 && second.hi === 29300,
  `second open resolves to the parity twin at the same strikes (${second.resolution}/${second.style})`);
ok(second.legs.every(l => l.type === 'P'), 'twin uses PUT legs (the other ladder)');
ok(!L.conflicts(second.legs), 'twin legs are conflict-free');
L.record(second.legs);

// Force BOTH ladders blocked at 29300 → resolver must SHIFT the strikes.
const L2 = makeLegLedger();
L2.record([{ side: 'long', type: 'C', strike: 29300 }, { side: 'short', type: 'C', strike: 29320 }]);
L2.record([{ side: 'long', type: 'P', strike: 29300 }, { side: 'short', type: 'P', strike: 29280 }]);
const shifted = resolveOpen('bull', 29280, 29300, L2, OPT);
ok(shifted.resolution === 'shift' && shifted.hi !== 29300, `both ladders blocked → SHIFT (hi=${shifted.hi}, shift=${shifted.shift})`);
ok(!L2.conflicts(shifted.legs), 'shifted placement is conflict-free');

// Same-side re-open (stacking) is allowed.
ok(resolveOpen('bull', 29300, 29320, L, OPT).resolution === 'ideal', 'same-side re-open (stacking) allowed');

// Cover resolves to the credit twin when its debit legs conflict, else skip.
const L3 = makeLegLedger();
L3.record([{ side: 'long', type: 'P', strike: 29320 }]);   // debit bull cover would short P29320 → conflict
const cov = resolveCover('bull', 29320, 20, L3, { preferStyle: 'debit' });
ok(cov.resolution === 'twin' && cov.legs.every(l => l.type === 'C'), `cover flips to the credit (call) twin (${cov.resolution})`);

// Wing-shift: when the ideal wing conflicts in BOTH styles, move the long wing out to a free strike.
const L4 = makeLegLedger();
L4.record([{ side: 'long', type: 'P', strike: 29320 }]);   // debit cover long wing P29340? no — short P29320 conflict...
L4.record([{ side: 'short', type: 'C', strike: 29320 }]);  // credit cover would short C29300(ok) / long C29320 → conflict (already short)
// ideal debit (short P29300/long P29320) — P29320 is long here so long-P is fine but short P29300 free → actually resolves ideal.
// Force both width-wings blocked: play long P29320 (debit long-wing ok) AND make short P29300 conflict:
const L5 = makeLegLedger();
L5.record([{ side: 'long', type: 'P', strike: 29300 }]);   // debit cover short P29300 → conflict
L5.record([{ side: 'short', type: 'C', strike: 29320 }]);  // credit cover long C29320 → conflict (already short)
const wing = resolveCover('bull', 29300, 20, L5, { preferStyle: 'debit', incr: 10, maxWingShift: 8 });
ok(wing.resolution === 'shift' && wing.shift > 0, `both anchors blocked → slide ITM (shift=${wing.shift})`);
ok(!L5.conflicts(wing.legs), 'slid cover is conflict-free');
// THE POINT OF THE SLIDE: the cover must keep the POSITION'S width. A different-width cover does not
// cover — it leaves an untracked risk difference on the opposite side and breaks `W - open - cover`.
ok(wing.wing === 20, `slide keeps the width (wing=${wing.wing})`);
const ws = Math.abs(wing.legs[0].strike - wing.legs[1].strike);
ok(ws === 20, `slid cover legs are exactly 20 apart (got ${ws})`);
ok(wing.legs[0].strike > 29300, `bull cover slid deeper ITM (anchor=${wing.anchor})`);
// And the tent still floors at exactly W for the slid cover.
const pay = (legs, S) => legs.reduce((v, l) => v + (l.side === 'long' ? 1 : -1)
  * (l.type === 'C' ? Math.max(S - l.strike, 0) : Math.max(l.strike - S, 0)), 0);
const openLegs = [{ side: 'long', type: 'C', strike: 29280 }, { side: 'short', type: 'C', strike: 29300 }];
let fl = Infinity;
for (let S = 28900; S <= 29700; S += 5) fl = Math.min(fl, pay(openLegs, S) + pay(wing.legs, S));
ok(fl === 20, `slid cover still floors the tent at W (floor=${fl})`);

// A bear position slides the other way — deeper ITM for a CALL cover means LOWER strikes.
const L6 = makeLegLedger();
L6.record([{ side: 'long', type: 'C', strike: 29300 }]);
L6.record([{ side: 'short', type: 'P', strike: 29320 }]);
const bear = resolveCover('bear', 29300, 20, L6, { preferStyle: 'debit', incr: 10, maxWingShift: 8 });
if (bear.resolution === 'shift') {
  ok(bear.anchor < 29300, `bear cover slid deeper ITM downward (anchor=${bear.anchor})`);
  ok(Math.abs(bear.legs[0].strike - bear.legs[1].strike) === 20, 'bear slid cover keeps width 20');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
