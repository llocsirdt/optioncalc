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

function makeGeo({ width, incr = 10, shift = 0, capFrac = 0.8 }) {
  function buildOpen(side, S, tau, iv) {
    const center = Math.floor(S / incr) * incr;
    let lo, hi;
    if (side === 'bull') { hi = center + width / 2 - shift; lo = hi - width; }   // short C@hi, long C@lo
    else { lo = center - width / 2 + shift; hi = lo + width; }                    // short P@lo, long P@hi
    const legs = side === 'bull'
      ? [{ side: 'long', type: 'C', strike: lo }, { side: 'short', type: 'C', strike: hi }]
      : [{ side: 'long', type: 'P', strike: hi }, { side: 'short', type: 'P', strike: lo }];
    const limit = round2(Math.min(width * capFrac, roundTick(legsMark(legs, S, tau, iv))));
    return { legs, shortStrike: side === 'bull' ? hi : lo, limit: Math.max(TICK, limit) };
  }
  const coverLegs = (side, shortStrike) => side === 'bull'
    ? [{ side: 'short', type: 'P', strike: shortStrike }, { side: 'long', type: 'P', strike: shortStrike + width }]
    : [{ side: 'short', type: 'C', strike: shortStrike }, { side: 'long', type: 'C', strike: shortStrike - width }];
  return { WIDTH: width, buildOpen, coverLegs };
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

module.exports = { makeGeo };

if (require.main === module) {
  const geos = [
    ['$20 ATM (baseline)', makeGeo({ width: 20, shift: 0, capFrac: 0.525 })],
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
