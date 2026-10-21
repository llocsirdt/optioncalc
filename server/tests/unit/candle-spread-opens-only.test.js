'use strict';
// OPENS-ONLY mode (backtest/opens-only.js; v20/v21 BB-fade, user 2026-10-21): no covers or hedges of any kind, every
// open held to the settle; the risk cap (governor lossMax) and the open walk ladder are kept; -unc drops the cap.
//   - opensOnlyOpts: whitelist strips every cover / hedge / floor-guard flag, switches off the two default-on paths
//     (cover-to-stack, per-position covers), keeps the open ladder + placement; never mutates its input
//   - engine on real days: no cover fills, no hedge positions, book = ladder-filled opens; capped day loss >= -lossMax
//   - debit vs credit under the backtest pricer: same strikes -> credit = W - debit exactly (r = 0, strike-only skew),
//     identical settle P&L and identical max loss (what the governor caps); only the cash sign differs
//
// Run: node server/tests/run-unit.js opens-only
const path = require('path'), fs = require('fs');
const E = require('../../src/candle-spread/backtest/backtest-v6-5m');
const OO = require('../../src/candle-spread/backtest/opens-only');
const BF = require('../../src/candle-spread/signals/bb-fade');
const CL = require('../../src/candle-spread/capital-legs');
const bs = require('../../src/candle-spread/bs-pricer');
const { optsFor } = require('../../src/candle-spread/backtest/opts-for');
const { buildRuns } = require('../../src/candle-spread/index');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

const v = buildRuns().find((r) => r.variant === 'v9-20');
const base = optsFor(v, { intradayIV: true, hasPx: true, where: 'test', openFillModel: 'ladder', subBarFill: '1m' });

// ── opts whitelist ───────────────────────────────────────────────────────────────────────────────────
{
  const before = JSON.stringify(Object.keys(base));
  const o = OO.opensOnlyOpts(base, { capped: true }), u = OO.opensOnlyOpts(base, { capped: false });
  ok(JSON.stringify(Object.keys(base)) === before, 'input not mutated');
  for (const k of ['continuousCover', 'coverGiveUp', 'coverLadder', 'stallCoverMin', 'proactiveCoverFrac', 'floorRaise', 'wingConvert', 'floorOffset',
    'flyConvert', 'coverToOpen', 'coverToOpenWait', 'lateFloorAfterMin', 'lossTarget', 'recaptureAlternate', 'coverGeometry', 'giveUpPoints'])
    ok(o[k] === undefined, `capped: ${k} stripped`);
  ok(o.perPositionCovers === false && o.coverToStack === false, 'default-on cover paths switched off');
  ok(o.lossMax === base.lossMax && base.lossMax > 0, 'capped keeps the risk cap (lossMax)');
  ok(u.lossMax === undefined && u.lossTarget === undefined, '-unc has no cap');
  ok(o.openFillModel === 'ladder' && o.openWalkCapFrac === base.openWalkCapFrac && o.geo === base.geo && o.ladderStepSeconds === base.ladderStepSeconds, 'open ladder + placement kept');
  ok(OO.guardsFor(o).some(([g, on]) => /risk cap/.test(g) && on) && !OO.guardsFor(u).some(([g, on]) => /risk cap/.test(g) && on), 'guard list reflects the cap');
}

// ── engine, on real days when the dataset is present ─────────────────────────────────────────────────
const DIR = path.join(__dirname, '../../../tests/backtest/backtest-data-5m-combined');
if (fs.existsSync(DIR)) {
  const days = E.load5mDays(DIR).slice(-15);
  const sig = BF.bbFadeSignal(null);
  let anyOpen = 0;
  for (const d of days) {
    const c = E.runDay5m(d.bars, sig, OO.opensOnlyOpts(base, { capped: true }));
    const u = E.runDay5m(d.bars, sig, OO.opensOnlyOpts(base, { capped: false }));
    for (const [r, tag] of [[c, 'capped'], [u, 'unc']]) {
      ok(r.filled === 0, `${tag} ${d.date}: no cover filled`);
      ok(r.opens === r.openLadder.filled, `${tag} ${d.date}: book = ladder-filled opens only`);
    }
    ok(c.governor && c.governor.offsets === 0 && c.governor.wings === 0 && c.governor.covers === 0, `${d.date}: governor bought nothing`);
    ok(c.terminal >= -base.lossMax - 1, `${d.date}: capped day loss within lossMax (${c.terminal})`);
    ok(u.governor === null, `${d.date}: -unc ungoverned`);
    anyOpen += c.opens;
    if (c.governor.blocked) ok(c.governor.firstBlockMin >= 570 && c.governor.firstBlockMin <= 955, `${d.date}: first block inside the action window`);
  }
  ok(anyOpen > 0, 'opens happen on the sample');
}

// ── debit vs credit (same strikes): parity under the backtest pricer ─────────────────────────────────
{
  const S = 20037, tau = 3 / (24 * 365);
  const skew = (K) => 0.18 * (1 + 0.4 * Math.max(-1, Math.min(1, (20037 - K) / 200)));   // strike-only, like opts.ivSkew
  const mark = (t, k) => bs.bsPrice(t, S, k, tau, skew(k));
  for (const [side, lo, hi] of [['bull', 20000, 20020], ['bull', 20050, 20090], ['bear', 19990, 20030], ['bear', 20040, 20050]]) {
    const W = hi - lo, deb = CL.openLegsFor(side, lo, hi, 'debit'), cre = CL.openLegsFor(side, lo, hi, 'credit');
    const D = CL.entryMark(deb, mark), C = -CL.entryMark(cre, mark);
    ok(Math.abs(D + C - W) < 1e-9, `${side} ${lo}/${hi}: credit = W - debit (parity)`);
    ok(Math.abs(CL.maxLoss(deb, mark, W) - CL.maxLoss(cre, mark, W)) < 1e-9, `${side} ${lo}/${hi}: same max loss`);
    let same = true; for (let X = lo - 50; X <= hi + 50; X += 5) if (Math.abs((CL.payoff(deb, X) - D) - (CL.payoff(cre, X) + C)) > 1e-9) same = false;
    ok(same, `${side} ${lo}/${hi}: identical settle P&L`);
    ok(D > 0 && C > 0, 'cash sign differs: debit pays, credit receives');
  }
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
