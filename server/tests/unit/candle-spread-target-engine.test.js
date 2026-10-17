'use strict';
// TARGET ENGINE (v10/v11, backtest-only; server/src/candle-spread/backtest/backtest-target.js).
// No lookahead on the RTH 15m/60m lines, the RTH series keeps the overnight gap, anchor entries fill only when the
// path reaches the anchor and cancel after entryBars, v11 strikes never beyond the magnet, covers follow the roster machinery (total <= W unless given up, <= W(1+giveUpMaxLoss) when given up),
// the cap blocks opens, and the result carries every key runDay5m returns.
//
// Run: cd server && node tests/run-unit.js target-engine
const TG = require('../../src/candle-spread/backtest/backtest-target');
const { runDay5m } = require('../../src/candle-spread/backtest/backtest-v6-5m');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

// 2026-10-16 is EDT (UTC-4): ET minute m -> epoch
const DAY0 = Date.UTC(2026, 9, 16, 4, 0, 0);
const at = (min, day0 = DAY0) => day0 + min * 60000;

// A synthetic day: closes[k] is the 5m close of the bar stamped 09:35 + 5k (bars before 09:35 sit at closes[0]).
// nq15/nq60 = the COMPLETED NQ candle carried on every bar (close/ema/high/low).
function makeDay(closes, { nq15, nq60, wick = 3, day0 = DAY0 } = {}) {
  const bars = [];
  let prev = closes[0] - (closes[1] - closes[0]);
  for (let m = 9 * 60; m <= 16 * 60; m += 5) {
    const k = Math.max(0, (m - 575) / 5), c = m < 575 ? closes[0] - (closes[1] - closes[0]) : (closes[Math.min(k, closes.length - 1)]);
    const o = prev, hi = Math.max(o, c) + wick, lo = Math.min(o, c) - wick; prev = c;
    const f = { open: o, high: hi, low: lo, close: c, bbupper: c + 60, bblower: c - 60, bbmiddle: c, ema: c };
    const c15 = { open: c, high: c + 10, low: c - 10, close: c, bbupper: c + 120, bblower: c - 120, bbmiddle: c, ema: c, ...(nq15 ? nq15(c, m) : {}) };
    const c60 = { open: c, high: c + 20, low: c - 20, close: c, bbupper: c + 200, bblower: c - 200, bbmiddle: c, ema: c, ...(nq60 ? nq60(c, m) : {}) };
    bars.push({ dt: at(m, day0), analysis: { '1m': f, '5m': f, '15m': c15, '60m': c60 }, px: null, fifteen: m % 15 === 0 });
  }
  return bars;
}
const priceOf = (b) => { const c = b.analysis['5m']; return { open: c.open, close: c.close, high: c.high, low: c.low }; };
const flatPrior = (level, nSessions = 8) => {
  const bars = [];
  for (let s = nSessions; s >= 1; s--) for (let m = 575; m <= 960; m += 5) bars.push({ day: `2026-10-${String(16 - s).padStart(2, '0')}`, min: m, open: level, high: level + 1, low: level - 1, close: level });
  return { priorBars: bars, priorClose: level };
};
// bullish NQ: completed candle closed above its 9EMA (slope up) and price above the EMA, pointing at an EMA above?
// For v10 the TARGET is the NQ 15m 9EMA, so a bull lean needs the EMA ABOVE spot.
const OFF = { rthGate: false, noGapFade: false, bookReject: false, fly: false, target60: false, gapRth60: false };

// 1) NO LOOKAHEAD on the RTH lines
{
  const rth = [];
  for (let m = 575; m <= 960; m += 5) rth.push({ day: '2026-10-16', min: m, open: m, high: m + 1, low: m - 1, close: m });
  const at600 = TG.aggregate(rth, 15, '2026-10-16', 600);
  const trunc = TG.aggregate(rth.filter((b) => b.min <= 600), 15, '2026-10-16', 600);
  ok(JSON.stringify(at600) === JSON.stringify(trunc), 'future bars do not change the completed 15m buckets');
  ok(at600.length === 2 && at600[1].close === 600, 'at 10:00 only 09:30-09:45 and 09:45-10:00 are complete');
  ok(TG.aggregate(rth, 15, '2026-10-16', 580).length === 0, 'at 09:40 the forming 09:30-09:45 bucket is excluded');
  const h = TG.aggregate(rth, 60, '2026-10-16', 960);
  ok(h.length === 7 && h[0].open === 575 && h[0].close === 630 && h[6].close === 960, '60m anchored at 09:30 (7 buckets, last 15:30-16:00)');
  ok(TG.aggregate(rth, 60, '2026-10-16', 625).length === 0, 'the 09:30-10:30 hour is not complete at 10:25');
}

// 2) the RTH series keeps the gap
{
  const mk = (iso, level) => ({ iso, rth: [575, 580, 960].map((m) => ({ day: iso, min: m, open: level, high: level, low: level, close: level })), close: level });
  const C = TG.buildRthContexts([mk('2026-10-14', 100), mk('2026-10-15', 120), mk('2026-10-16', 200)], 8);
  const c = C.get('2026-10-16');
  ok(c.priorClose === 120 && c.priorIso === '2026-10-15', 'prior close = the prior session close');
  ok(c.priorBars.every((b) => b.close === 100 || b.close === 120), 'no overnight bars enter the RTH series');
  const C2 = TG.buildRthContexts([mk('2026-01-02', 100), mk('2026-07-21', 200)], 8);
  ok(C2.get('2026-07-21').priorClose == null, 'a chain with a > 5 day hole is cut (no fake gap)');
  // today's run: gap measured against the prior close
  const bars = makeDay(new Array(80).fill(20100));
  const r = TG.runDayTarget(bars, { family: 'v10', width: 20, priceOf, rthCtx: flatPrior(20000), ...OFF });
  ok(r.gap === 100 && r.gapDay === true, `gap = today open - prior close (got ${r.gap})`);
}

// 3) ANCHOR entry: fills only when the path reaches the anchor, cancels after entryBars
{
  // steadily rising: every bar's low is the prior close, above the prior bar's mid -> the anchor is never reached
  const up = Array.from({ length: 80 }, (_, k) => 20000 + 10 * k);
  const nq15 = (c) => ({ ema: c + 60, close: c + 61, high: c + 80, low: c - 40 });   // T above spot; chase-safe
  const r = TG.runDayTarget(makeDay(up, { nq15, wick: 0 }), { family: 'v10', width: 20, priceOf, rthCtx: flatPrior(20000), ...OFF, maxStack: 9 });
  ok(r.decisions.anchorPlaced > 0 && r.decisions.anchorFilled === 0 && r.opens === 0, `rising path never fills (placed ${r.decisions.anchorPlaced}, filled ${r.decisions.anchorFilled})`);
  ok(r.decisions.anchorCanceled >= r.decisions.anchorPlaced - 1, 'each unfilled anchor is cancelled');
  // entryBars: placed at bar i, works i+1..i+3, cancelled at the close of i+3 -> re-placed every 3 bars
  ok(Math.abs(r.decisions.anchorPlaced - Math.ceil(r.decisions.decisions / 3)) <= 2, `one placement per entryBars window (placed ${r.decisions.anchorPlaced}, decisions ${r.decisions.decisions})`);
  // a dip back to the anchor fills it, and only then
  const dip = up.slice(); for (let k = 20; k < 80; k++) dip[k] = up[19] - 30;   // 11:15 bar falls through the prior mid
  const r2 = TG.runDayTarget(makeDay(dip, { nq15, wick: 0 }), { family: 'v10', width: 20, priceOf, rthCtx: flatPrior(20000), ...OFF, recordReplay: true });
  const first = r2.positions[0];
  ok(first && TG.etMin(first.openEpoch) === 675, `first fill on the 11:15 dip bar (got ${first && TG.etMin(first.openEpoch)})`);
  const mkt = TG.runDayTarget(makeDay(up, { nq15, wick: 0 }), { family: 'v10', width: 20, priceOf, rthCtx: flatPrior(20000), ...OFF, entry: 'market' });
  ok(mkt.opens > 0 && mkt.decisions.marketFilled > 0, 'market entry fills on the rising path');
}

// 4) v11 strikes: f of the way to M, never beyond it; 5) cover totals bounded
{
  // RTH 15m mid ~ 20060 (prior sessions flat at 20060), today sits at 20000; NQ 15m and 60m trend UP toward it
  const nq = (c) => ({ ema: c - 5, close: c + 2, high: c + 30, low: c - 30 });
  const bars = makeDay(Array.from({ length: 80 }, (_, k) => 20000 + (k % 2)), { nq15: nq, nq60: nq });
  const base = { family: 'v11', width: 20, priceOf, rthCtx: flatPrior(20060), noGapFade: false, bookReject: false, recordReplay: true };
  const r = TG.runDayTarget(bars, { ...base, f: 0.5 });
  ok(r.opens > 0, `v11 opens toward M (opens ${r.opens}, ${JSON.stringify({ d: r.decisions.distOut, t: r.decisions.trendFail })})`);
  ok(r.positions.every((p) => p.side === 'bull' && p.shortStrike <= p.target + 1e-9), 'bull short never above M');
  ok(r.positions.every((p) => Math.abs(p.shortStrike - Math.round((20000 + 0.5 * (p.target - 20000)) / 10) * 10) <= 10), 'short ~ halfway (rounded to the strike grid)');
  const r1 = TG.runDayTarget(bars, { ...base, f: 1.0 });
  ok(r1.positions.length && r1.positions.every((p) => p.shortStrike <= p.target && p.target - p.shortStrike < 10), 'f=1 rounds DOWN to the last strike inside M');
  const capOk = (rr, gu) => rr.positions.filter((p) => p.kind === 'vert' && p.covered).every((p) => p.limit + p.coverLimit <= p.W * (p._gu ? 1 + gu : 1) + 1e-9);
  { // a rally into M: the touch is counted and, when the tent then locks >= the normal target, covered at mark + 1 tick
    const path = Array.from({ length: 80 }, (_, k) => (k < 30 ? 20000 + (k % 2) : Math.min(20080, 20000 + 10 * (k - 29))));
    const rt = TG.runDayTarget(makeDay(path, { nq15: nq, nq60: nq }), { ...base, f: 0.5, coverToOpen: false, coverCfg: { 20: { ...TG.DEFAULT_COVER[20], stallCoverMin: null } } });
    const tc = rt.positions.filter((p) => p.touched);
    ok(rt.decisions.touches > 0 && tc.length > 0, `v11 touches counted (${rt.decisions.touches}, touch covers ${rt.decisions.touchCovers})`);
    ok(tc.every((p) => !p.covered || p.limit + p.coverLimit <= p.W + 1e-9), 'touched positions never covered past break-even (touch or normal target)');
  }
  ok(capOk(r, 0.075) && capOk(r1, 0.075), 'v11 cover total <= W (normal / touch) and <= W(1+giveUpMaxLoss) on give-up');
  const v10 = TG.runDayTarget(makeDay(Array.from({ length: 80 }, (_, k) => 20000 + 15 * Math.sin(k / 3)), { nq15: (c) => ({ ema: c + 60, close: c + 61, high: c + 80, low: c - 40 }) }),
    { family: 'v10', width: 20, priceOf, rthCtx: flatPrior(20000), ...OFF, recordReplay: true });
  const cov = v10.positions.filter((p) => p.covered);
  ok(cov.length > 0 && cov.every((p) => p.limit + p.coverLimit <= p.W * (p._gu ? 1.075 : 1) + 1e-9), `v10 cover total <= W, give-ups <= W(1+0.075) (${cov.length} covered)`);
  ok(cov.some((p) => !p._gu && p.W - p.limit - p.coverLimit > 0), 'the normal target locks a POSITIVE tent (W - open - cover > 0)');
  ok(cov.every((p) => { const sh = p.coverLegs.find((l) => l.side === 'short').strike, lg = p.coverLegs.find((l) => l.side === 'long').strike;
    const k = (sh - p.shortStrike) / 10 * (p.side === 'bull' ? 1 : -1);
    return Math.abs(sh - lg) === p.W && Number.isInteger(k) && k >= -(p.W / 10 - 1) && k <= 2; }), 'covers keep constant width W, short within the rostered range');
  // 10-wide: offset1 geometry (cover short one strike beyond), give-up re-strikes to the tent
  const v10n = TG.runDayTarget(makeDay(Array.from({ length: 80 }, (_, k) => 20000 + 15 * Math.sin(k / 3)), { nq15: (c) => ({ ema: c + 60, close: c + 61, high: c + 80, low: c - 40 }) }),
    { family: 'v10', width: 10, priceOf, rthCtx: flatPrior(20000), ...OFF, recordReplay: true });
  const c10 = v10n.positions.filter((p) => p.covered && !p._gu);
  ok(c10.length && c10.every((p) => { const sh = p.coverLegs.find((l) => l.side === 'short').strike; return sh === p.shortStrike + (p.side === 'bull' ? 10 : -10); }), `10W normal covers use offset1 (${c10.length})`);
}

// 6) the cap blocks opens
{
  const nq15 = (c) => ({ ema: c + 60, close: c + 61, high: c + 80, low: c - 40 });
  const bars = makeDay(Array.from({ length: 80 }, (_, k) => 20000 + 15 * Math.sin(k / 3)), { nq15 });
  const r = TG.runDayTarget(bars, { family: 'v10', width: 20, priceOf, rthCtx: flatPrior(20000), ...OFF, lossMax: 100 });
  ok(r.opens === 0 && r.decisions.capBlock > 0, `lossMax $100 blocks every 20-wide open (capBlock ${r.decisions.capBlock})`);
}

// 7) result shape: every key runDay5m returns
{
  const bars = makeDay(new Array(80).fill(20000));
  const a = runDay5m(bars, () => ({ openSide: null, cover: false }), { rthActionOnly: true, priceOf });
  const b = TG.runDayTarget(bars, { family: 'v10', width: 20, priceOf, rthCtx: flatPrior(20000) });
  const missing = Object.keys(a).filter((k) => !(k in b));
  ok(!missing.length, `result keys match runDay5m (missing: ${missing.join(',')})`);
  for (const k of ['endBookFloor', 'endFloorNoLoss', 'endFloorProfit', 'bestFloor', 'everPositive', 'traded']) ok(k in b.lock, `lock.${k}`);
  ok(b.capital && 'peakReal' in b.capital && 'avgReal' in b.capital && b.wings.count === 0 && b.decisions, 'capital / wings / decision counters');
}

console.log(`target engine: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
