#!/usr/bin/env node
'use strict';
/**
 * Spread-WIDTH experiment: run the existing signals (v6, be-wrong) through the geometry-parameterized
 * engine at different widths + strike selection, to test the user's $40-spread idea (wider tents,
 * short leg near/just-inside the money → more premium paid but more terminal potential, easier to lock
 * profit on a favorable move). Reports the avg OPEN DEBIT (as % of width) so the pricing can be matched
 * to the real-world $22-23 on a $40, plus total/maxDD/worst-day/ret-maxDD.
 *
 * makeGeo shift (pts): 0 = ATM-centered (short OTM by width/2, our default); width/2 = short ~ATM
 * (long deeper ITM = the user's $40 selection). Usage: node backtest-width.js --dataDir <5m dir>
 */
const eng = require('./backtest-v4');
const { runDay5m, load5mDays } = require('./backtest-v6-5m');
const { v6Signal } = require('./v6-signals');
const { v7Signal } = require('./v7-signals');
const legsMark = eng.legsMark, round2 = eng.round2, roundTick = eng.roundTick, TICK = eng.TICK;

// General spread geometry: any WIDTH (10/20/40/60...) × any SHIFT (the positioning axis):
//   shift < 0     → OTM  (spread skewed toward/past the underlying; long leg less ITM → cheaper)
//   shift = 0     → ATM straddle (long ITM by width/2, short OTM by width/2 — the classic)
//   shift = W/2   → just ITM (short leg ~ATM, long leg W deep ITM — the "$40" selection)
//   shift > W/2   → deeper ITM (short leg ITM by shift−W/2, long even deeper)
// capFrac = the user's RISK/REWARD CEILING (never pay more than ~65% of width for a long debit spread).
// It GATES THE TRADE, it does not set the price: if the real mark is over the ceiling we DECLINE the open
// (`{skip:true}`) rather than booking at the cap. The old `limit = min(cap, mark)` booked BELOW MARKET
// whenever the cap bound — measured at 59.1% of bars for ATM-centred, 2.0%/7.7% for $20/$40 short-ATM —
// i.e. the backtest counted fills at prices the live engine's own limit order would never have gotten.
// One ceiling for every geometry now: the old auto-derive (0.525 + shift/width) existed only to stop the
// cap from binding on ITM spreads, which is unnecessary once the cap refuses instead of prices.
// Grid note: legs land on the `incr` grid only when W/2 and shift are multiples of incr (e.g. $10 ATM
// is off a 10-grid → use a shift or incr:5; $20/$40/$60 ATM are fine).
function makeGeo({ width, incr = 10, shift = 0, capFrac = 0.65 }) {
  const cf = capFrac;
  function buildOpen(side, S, tau, iv) {
    const center = Math.floor(S / incr) * incr;
    let lo, hi;
    if (side === 'bull') { hi = center + width / 2 - shift; lo = hi - width; }   // short C@hi, long C@lo
    else { lo = center - width / 2 + shift; hi = lo + width; }                    // short P@lo, long P@hi
    const legs = side === 'bull'
      ? [{ side: 'long', type: 'C', strike: lo }, { side: 'short', type: 'C', strike: hi }]
      : [{ side: 'long', type: 'P', strike: hi }, { side: 'short', type: 'P', strike: lo }];
    const mark = roundTick(legsMark(legs, S, tau, iv));
    // DECLINE, never book sub-market. A fixed geometry has no other strikes to walk to (that is what
    // makeAdaptiveGeo is for), so over the ceiling the only honest options are pay the mark or pass —
    // and the user's rule is pass: above ~65% of width the risk/reward isn't there.
    if (!(mark > 0)) return { skip: true, reason: 'non-positive mark', limit: 0 };
    if (mark > width * cf) return { skip: true, reason: `mark ${round2(mark)} over ${Math.round(cf * 100)}% of $${width}`, limit: 0, mark: round2(mark) };
    return { legs, shortStrike: side === 'bull' ? hi : lo, limit: Math.max(TICK, round2(mark)), fracOfWidth: mark / width };
  }
  const coverLegs = (side, shortStrike) => side === 'bull'
    ? [{ side: 'short', type: 'P', strike: shortStrike }, { side: 'long', type: 'P', strike: shortStrike + width }]
    : [{ side: 'short', type: 'C', strike: shortStrike }, { side: 'long', type: 'C', strike: shortStrike - width }];
  return { WIDTH: width, buildOpen, coverLegs };
}

// ── ADAPTIVE (time-of-day) STRIKE PLACEMENT ─────────────────────────────────────────────────────────
// The user's actual strike selection: early in the session the short leg sits ON or IN the money — often
// a strike or two ITM — and as the day goes on the chosen strikes walk toward the money until, by about
// 1-2pm, spreads merely STRADDLE it. Never skewed OTM on an OPEN (OTM is only for covering / raising the
// floor). The driver is a single price ceiling: never pay more than ~65% of width for a long debit spread,
// because above that the risk/reward isn't there.
//
// ONE RULE REPRODUCES ALL OF IT: pick the MOST ITM placement whose real mark is still <= maxDebitFrac x W,
// floored at straddle; if even that is too expensive, DON'T OPEN. It is self-adjusting — a given ITM skew
// gets more expensive relative to width as expiry approaches, so the choice drifts ITM -> ATM on its own.
// Measured (200d): the median mark for a fixed short-ATM placement rises through the day and crosses 65%
// at ~14:00 ($20) / ~13:00 ($40), which is exactly the user's "rarely opening ITM by 1-2pm".
//
// IMPORTANT: this prices at the REAL mark of the chosen placement — the ceiling changes WHICH STRIKES we
// trade, which is what the user actually does. makeGeo now honours the same "never book sub-market" rule,
// but being a FIXED geometry it can only decline; here we walk the placement toward the money first.
function makeAdaptiveGeo({ width, incr = 10, maxDebitFrac = 0.65, maxItmStrikes = 3 }) {
  // Least-ITM placement allowed = straddle the money (long leg ITM, short leg OTM). On a coarse grid the
  // exact straddle can be off-grid (e.g. $10 width on a 10-pt grid), in which case short-at-the-money is
  // the least-ITM placement available — still never OTM.
  const halfOnGrid = Math.floor((width / 2) / incr) * incr;
  function buildOpen(side, S, tau, iv) {
    const center = Math.floor(S / incr) * incr;
    // Candidate SHORT strikes, ordered MOST ITM first. Bull: lower short strike = deeper ITM = pricier.
    for (let k = -maxItmStrikes; k <= halfOnGrid / incr; k++) {
      const off = k * incr;
      const shortStrike = side === 'bull' ? center + off : center - off;
      const lo = side === 'bull' ? shortStrike - width : shortStrike;
      const hi = side === 'bull' ? shortStrike : shortStrike + width;
      const legs = side === 'bull'
        ? [{ side: 'long', type: 'C', strike: lo }, { side: 'short', type: 'C', strike: hi }]
        : [{ side: 'long', type: 'P', strike: hi }, { side: 'short', type: 'P', strike: lo }];
      const mark = legsMark(legs, S, tau, iv);
      if (!(mark > 0)) continue;
      if (mark <= maxDebitFrac * width) {
        return { legs, shortStrike, limit: Math.max(TICK, roundTick(mark)), itmStrikes: -k, fracOfWidth: mark / width };
      }
    }
    // Every placement from deep-ITM through straddle is above the ceiling → decline rather than overpay.
    return { skip: true, reason: 'no placement within ' + Math.round(maxDebitFrac * 100) + '% of width', limit: 0 };
  }
  const coverLegs = (side, shortStrike) => side === 'bull'
    ? [{ side: 'short', type: 'P', strike: shortStrike }, { side: 'long', type: 'P', strike: shortStrike + width }]
    : [{ side: 'short', type: 'C', strike: shortStrike }, { side: 'long', type: 'C', strike: shortStrike - width }];
  return { WIDTH: width, buildOpen, coverLegs, adaptive: true };
}

const di = process.argv.indexOf('--dataDir');
const days = load5mDays(di >= 0 ? process.argv[di + 1] : eng.DATA_DIR);
const usd = n => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');
const v6 = (A, p, c) => v6Signal(A, p, { ...c, cfg: { fiveMin: true } });
const bw = (A, p, c) => v7Signal(A, p, { ...c, cfg: { fiveMin: true, beWrong: true } });

function avgDebit(geo) {   // sample the ATM open debit across days (first bar of each) → % of width
  let s = 0, n = 0;
  for (const d of days) { const b = d.bars[0], A = b.analysis; const iv = eng.bs.ivFromRelBandWidth((A['15m'].bbupper - A['15m'].bblower) / A['15m'].close); s += geo.buildOpen('bull', A['5m'].close, eng.bs.tauFromTime(b.dt), iv).limit; n++; }
  return s / n;
}
function stat(arr) { let t = 0, cum = 0, pk = 0, dd = 0, w = 1e9; for (const x of arr) { t += x; cum += x; pk = Math.max(pk, cum); dd = Math.max(dd, pk - cum); w = Math.min(w, x); } return { t, dd, w, ret: dd > 0 ? t / dd : 0 }; }

module.exports = { makeGeo, makeAdaptiveGeo };

if (require.main === module) {
  const geos = [
    ['$20 ATM (baseline)', makeGeo({ width: 20, shift: 0 })],
    ['$40 ATM-centered', makeGeo({ width: 40, shift: 0 })],
    ['$40 short-slightly-ITM (+10)', makeGeo({ width: 40, shift: 10 })],
    ['$40 short-ATM (+20)', makeGeo({ width: 40, shift: 20 })],
  ];
  console.log(`SPREAD-WIDTH EXPERIMENT — ${days.length} days, 5m engine, QTY=1\n`);
  for (const sig of [['v6', v6], ['be-wrong', bw]]) {
    console.log(`=== ${sig[0]} ===`);
    console.log('geometry'.padEnd(30) + 'avgDebit'.padEnd(18) + 'total'.padEnd(13) + 'maxDD'.padEnd(12) + 'worstDay'.padEnd(12) + 'ret/maxDD');
    for (const [label, geo] of geos) {
      const opts = { geo };
      if (sig[0] === 'be-wrong') opts.bidirectional = true;
      const arr = days.map(d => runDay5m(d.bars, sig[1], opts).terminal), s = stat(arr);
      const dbt = avgDebit(geo);
      console.log(label.padEnd(30) + `$${dbt.toFixed(1)} (${Math.round(dbt / geo.WIDTH * 100)}% of $${geo.WIDTH})`.padEnd(18) + usd(s.t).padEnd(13) + usd(s.dd).padEnd(12) + usd(s.w).padEnd(12) + s.ret.toFixed(1));
    }
    console.log();
  }
}
