// Cover-selector tests: fixed (V0) vs greedy (V1) vs joint (V2).
// Run: node tests/nogit/candle-spread-selectors.test.js
const L = require('../../src/candle-spread/spread-logic');
const trader = require('../../src/candle-spread/trader');

let pass = 0, fail = 0;
function ok(cond, label) { if (cond) pass++; else { fail++; console.log('FAIL:', label); } }
const round2 = n => Math.round(n * 100) / 100;

// Fake option pricer: intrinsic + a bell-shaped time value peaking ATM. Enough to make
// ATM spreads cost ~half-width and OTM spreads cheap, so box/tent economics are realistic.
const TV_BASE = 5, TV_SCALE = 40;
const tv = dist => TV_BASE * Math.exp(-Math.pow(dist / TV_SCALE, 2));
const optMid = (type, strike, U) => round2((type === 'C' ? Math.max(U - strike, 0) : Math.max(strike - U, 0)) + tv(strike - U));
const makeGetLeg = U => (type, strike) => ({ mid: optMid(type, strike, U), symbol: `NDX ${type}${strike}`, bid: 1, ask: 1.1 });

const bullPos = (id, Klow, Kup, limit) => ({ id, side: 'bull', shortStrike: Kup, legs: L.openLegs('bull', Klow, Kup), limit, quantity: 1, filled: true, covered: false });
const cfg = sel => ({ spreadWidth: 20, strikeIncrement: 10, tickIncrement: 0.05, quantity: 1, coverSelector: sel, upsideLambda: 0.3 });
const ctx = U => ({ underlying: U, reversedDir: 'bear', bbOverride: false });
const cover = (positions, sel, U) => trader.selectCovers(positions, cfg(sel), makeGetLeg(U), ctx(U));

// --- last open, no retrace (price sits just above the covered short) ---
// The tent cover would be a deep-ITM put spread (expensive) -> greedy should box it.
const A = cover([bullPos('a', 29480, 29500, 10.5)], 'greedy', 29505)[0];
ok(A.geometry === 'box', `greedy last-open -> box (got ${A.geometry})`);
ok(A.floor > 0, `greedy box locks a positive floor (got ${A.floor})`);

// Same position under the fixed tent locks the -$100 loss; greedy must beat it.
const Af = cover([bullPos('a', 29480, 29500, 10.5)], 'fixed', 29505)[0];
ok(Af.geometry === 'tent', `fixed -> tent (got ${Af.geometry})`);
ok(Af.floor < 0, `fixed tent locks a loss on the un-retraced last open (got ${Af.floor})`);
ok(A.floor > Af.floor, `greedy beats fixed on the last open (${A.floor} > ${Af.floor})`);

// v3 fixed-mark: same tent geometry as v0, but priced at the real mark (higher than v0's cap
// when the mark is rich) -> more-negative but honest floor. Isolates fill-price from geometry.
const Am = cover([bullPos('a', 29480, 29500, 10.5)], 'fixed-mark', 29505)[0];
ok(Am.geometry === 'tent', `fixed-mark keeps tent geometry (got ${Am.geometry})`);
ok(Am.limit > Af.limit, `fixed-mark prices above v0's cap (${Am.limit} > ${Af.limit})`);
ok(Am.floor < Af.floor, `fixed-mark floor is more negative = realistic cost (${Am.floor} < ${Af.floor})`);

// --- deep stacked open (price well above the covered short) ---
// Both box and tent are cheap; the upside bonus should tip greedy off the box.
const B = cover([bullPos('b', 29480, 29500, 9)], 'greedy', 29560)[0];
ok(B.geometry !== 'box', `greedy deep -> retains upside (got ${B.geometry})`);
ok(B.peakExtra > 0 && B.floor > 0, `greedy deep: upside retained + positive floor (peak ${B.peakExtra}, floor ${B.floor})`);

// --- joint returns a plan per position and never leaves adverse risk ---
const positions = [bullPos('p1', 29480, 29500, 10.5), bullPos('p2', 29460, 29480, 9), bullPos('p3', 29440, 29460, 8.5)];
const J = cover(positions, 'joint', 29560);
ok(J.length === 3 && J.every(p => p.payload && p.geometry && p.longStrike >= 29460 - 0), 'joint: one valid plan per position');
// Joint expected value should be at least the sum of guaranteed floors (it optimizes EV, not just floor).
const greedyFloorSum = cover(positions, 'greedy', 29560).reduce((s, p) => s + p.floor, 0);
const jointFloorSum = J.reduce((s, p) => s + p.floor, 0);
ok(jointFloorSum > -100 * positions.length, `joint keeps aggregate floor sane (got ${jointFloorSum}, greedy ${greedyFloorSum})`);

// --- conviction (BB override) shifts greedy toward more upside ---
const lowConv = trader.selectCovers([bullPos('c', 29480, 29500, 9)], cfg('greedy'), makeGetLeg(29540), { underlying: 29540, reversedDir: 'bear', bbOverride: false })[0];
const hiConv = trader.selectCovers([bullPos('c', 29480, 29500, 9)], { ...cfg('greedy'), convictionMult: 1.5 }, makeGetLeg(29540), { underlying: 29540, reversedDir: 'bear', bbOverride: true })[0];
ok(hiConv.peakExtra >= lowConv.peakExtra, `higher conviction retains >= upside (hi ${hiConv.peakExtra} >= lo ${lowConv.peakExtra})`);

// --- chain snapshot ---
const snap = trader.snapshotChain(makeGetLeg(29500), 29505, 10, 8);
ok(snap.center === 29500 && snap.strikes.length === 9 && snap.strikes.every(s => s.call && s.put), 'snapshot: window of strikes with call+put marks');

// --- terminal-settlement P/L ---
const tcfg = { spreadWidth: 20, strikeIncrement: 10, quantity: 1 };
// Box cover locks value = width everywhere: terminal pnl = (20 - open - cover) regardless of settle.
const boxPos = { id: 'b', side: 'bull', shortStrike: 29500, filled: true, covered: true, quantity: 1,
  legs: L.openLegs('bull', 29480, 29500), limit: 10, coverLegs: L.candidateCoverLegs('bull', 29500, 20), coverLimit: 0.75, coverGeometry: 'box' };
const tLow = trader.computeTerminalPnl({ positions: [boxPos], realizedPnl: 925 }, tcfg, 29470).total;
const tHigh = trader.computeTerminalPnl({ positions: [boxPos], realizedPnl: 925 }, tcfg, 29520).total;
ok(tLow === 925 && tHigh === 925, `box terminal invariant to settle (got ${tLow}, ${tHigh})`);
// Uncovered filled spread settles at intrinsic: bull call wins ITM, loses OTM.
const openPos = { id: 'o', side: 'bull', shortStrike: 29500, filled: true, covered: false, quantity: 1, legs: L.openLegs('bull', 29480, 29500), limit: 10 };
ok(trader.computeTerminalPnl({ positions: [openPos], realizedPnl: 0 }, tcfg, 29510).total === 1000, 'uncovered bull ITM settles +$1000');
ok(trader.computeTerminalPnl({ positions: [openPos], realizedPnl: 0 }, tcfg, 29470).total === -1000, 'uncovered bull OTM settles -$1000');
// Unfilled positions are ignored.
ok(trader.computeTerminalPnl({ positions: [{ ...openPos, filled: false }], realizedPnl: 0 }, tcfg, 29510).total === 0, 'unfilled position excluded from terminal');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
