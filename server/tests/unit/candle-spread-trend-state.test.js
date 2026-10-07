'use strict';
// NEVER FIGHT THE TREND (2026-10-07) — trend-state.js and where it acts.
//   1. live (contextFromSeries, from 1m) and backtest (makeTracker, from 5m bars) read the SAME trend context.
//   2. floor raise: in a bull trend a hedge may not lower the floor right of spot (puts refused, a call
//      spread that lifts the right side allowed); permission on a be-wrong reversal; neutral = no bias.
//   3. give-up urgency: a position fighting the trend goes to the give-up price before the points trigger.
//   4. the cover ladder never walks a working cover DOWN (the 2026-10-07 $5.20 <-> $4.70 flapping).
//
// Run: node server/tests/unit/candle-spread-trend-state.test.js
const path = require('path'), fs = require('fs');
const TS = require('../../src/candle-spread/trend-state');
const AB = require('../../src/candle-spread/analysis-builder');
const FR = require('../../src/candle-spread/floor-raise');
const RC = require('../../src/candle-spread/risk-curve');
const T = require('../../src/candle-spread/trader');
const fx = require('./fixtures/floor-raise-2026-10-05-1535.json');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

(async () => {
  // ── definitions ────────────────────────────────────────────────────────────────────────────────
  const bull = { t15: 1, hc: 1, hcHH: 1, hf: 1, hfBreak: 1 };
  ok(TS.state(bull, 'A') === 1 && TS.state({ ...bull, hc: -1 }, 'A') === 0 && TS.state({ ...bull, hc: -1 }, '15m') === 1,
    'A needs the 15m AND the completed hourly; 15m alone does not');
  ok(TS.state({ t15: -1, hc: -1, hcHH: 0, hf: -1, hfBreak: 0 }, 'AHH') === 0 && TS.state({ t15: -1, hc: -1, hcHH: -1 }, 'AHH') === -1,
    'AHH also needs the hourly to break the prior extreme');
  ok(TS.against('bear', 1) && TS.against('bull', -1) && !TS.against('bull', 1) && !TS.against('bear', 0), 'against()');

  // ── 1. live/backtest parity on real /NQ ────────────────────────────────────────────────────────
  {
    const dir = path.join(__dirname, '../../../signal-lab-data/raw-1m');
    const files = ['NQ-2026-10-05.json', 'NQ-2026-10-06.json', 'NQ-2026-10-07.json'].map((f) => path.join(dir, f));
    if (files.every((f) => fs.existsSync(f))) {
      const raw = [].concat(...files.map((f) => JSON.parse(fs.readFileSync(f)).candles)).sort((a, b) => a.datetime - b.datetime);
      const series = AB.buildSeries(raw);
      const bars = AB.buildBars(raw, 5).map((b) => ({ dt: b.datetime, analysis: b.analysis }));
      const step = TS.makeTracker();
      let n = 0, diff = 0, firstDiff = null;
      for (const b of bars) {
        const t = step(b.analysis, b.dt);
        if (b.dt < Date.parse('2026-10-07T13:35:00Z') || b.dt > Date.parse('2026-10-07T20:00:00Z')) continue;
        const l = TS.contextFromSeries(series, b.dt);
        n++;
        if (JSON.stringify(l) !== JSON.stringify(t)) { diff++; if (!firstDiff) firstDiff = { dt: new Date(b.dt).toISOString(), live: l, bt: t }; }
      }
      ok(n > 70 && diff === 0, `live and backtest trend contexts identical on every 5m bar of 2026-10-07 (${n - diff}/${n})${firstDiff ? ' first diff ' + JSON.stringify(firstDiff) : ''}`);
      // The day as the user read it: from 11:30 the 15m is up, and the 14:05 raise came after a green
      // hourly that broke the prior high.
      const at = (hhmm) => TS.contextFromSeries(series, Date.parse(`2026-10-07T${hhmm}:00-04:00`));
      ok(TS.state(at('14:05'), 'A') === 1, `14:05: trend A is BULL (${JSON.stringify(at('14:05'))})`);
      ok(TS.state(at('10:00'), 'A') === -1, `10:00: trend A is BEAR (${JSON.stringify(at('10:00'))})`);
    } else ok(true, 'raw /NQ absent — parity skipped');
  }

  // ── 2. floor raise side guard ───────────────────────────────────────────────────────────────────
  {
    const xs = []; for (let x = 31030; x <= 31130; x += 10) xs.push(x);
    const base = xs.map((x) => RC.bookPnl(fx.book, x));
    const put = { kind: 'vertical', legs: [{ side: 'long', type: 'P', strike: 31060 }, { side: 'short', type: 'P', strike: 31050 }] };
    const args = { xs, base, cands: [put], price: () => ({ debit: 1.05 }), qty: 1, minRatio: 2, budget: Infinity,
      gNow: RC.bookFloor(fx.book, null, 10), spot: fx.underlying, bandLo: 31030, bandHi: 31130, objective: 'valley', liftMetric: 'min',
      globalFloorWith: (legs, debit) => RC.bookFloor(fx.book, { legs, limit: debit, quantity: 1, covered: false }, 10) };
    ok(FR.pickBest(args).best != null, 'no trend: the downside put offset is bought (2026-10-05 replay)');
    const blocked = { n: 0 };
    ok(FR.pickBest({ ...args, sideGuard: { dir: 1, spot: fx.underlying, blocked } }).best == null && blocked.n === 1,
      'BULL trend: the same put hedge is refused — it would lower the floor right of spot');
    // In a BEAR trend the guard watches the LEFT side instead: this offset lifts the far valley but drops the
    // near one (31070-31090) by its premium, so it lowers the left-side floor too and is refused — the user's
    // "never increase risk to the downside when the trend is bearish".
    ok(FR.pickBest({ ...args, sideGuard: { dir: -1, spot: fx.underlying } }).best == null, 'BEAR trend: a hedge that deepens another downside valley is refused too');
    // A book short the rally (an uncovered bear) in a bull trend: a call spread over it lifts the right side.
    const short = [{ id: 'b', side: 'bear', filled: true, quantity: 1, limit: 5.0, covered: false,
      legs: [{ side: 'long', type: 'P', strike: 31100 }, { side: 'short', type: 'P', strike: 31090 }] }];
    const xs2 = []; for (let x = 31050; x <= 31200; x += 10) xs2.push(x);
    const base2 = xs2.map((x) => RC.bookPnl(short, x));
    const call = { kind: 'vertical', legs: [{ side: 'long', type: 'C', strike: 31090 }, { side: 'short', type: 'C', strike: 31100 }] };
    const r = FR.pickBest({ xs: xs2, base: base2, cands: [call], price: () => ({ debit: 2.0 }), qty: 1, minRatio: 0, budget: Infinity,
      gNow: RC.bookFloor(short, null, 10), spot: 31095, bandLo: 31050, bandHi: 31200, objective: 'band',
      globalFloorWith: (legs, debit) => RC.bookFloor(short, { legs, limit: debit, quantity: 1, covered: false }, 10),
      sideGuard: { dir: 1, spot: 31095 } });
    ok(r.best != null, 'BULL trend: a call spread that lifts the threatened right side is allowed');

    // Live wiring: raiseFloor on the real 10-05 book with a bull trend places nothing and says why.
    const st = { positions: JSON.parse(JSON.stringify(fx.book)), realizedPnl: 0, cashDeployed: 0, trendCtx: bull };
    const d = [];
    const A = { '15m': { bbupper: fx.underlying * 1.003, bblower: fx.underlying * 0.997, close: fx.underlying } };
    const strikeMap = new Map(fx.strikes.map((s) => [s.strike, s]));
    const getLeg = (t, k) => { const s = strikeMap.get(k); const q = s && s[t === 'C' ? 'call' : 'put']; return q && q.mid != null ? { ...q, symbol: `NDX_${t}${k}` } : null; };
    const cfg = { floorRaise: true, floorRaiseMinRatio: 2, floorRaiseTrend: 'A', spreadWidth: 10, strikeIncrement: 10, tickIncrement: 0.05, quantity: 1 };
    const deps = { getLeg, underlying: fx.underlying, A, nowMs: Date.parse(fx.time), strikeIncrement: 10, placeOrder: async () => ({ orderId: 'x' }) };
    const placed = await T.raiseFloor(st, cfg, deps, d, '10/05 15:35', null);
    ok(placed === 0 && d.some((x) => x.action === 'raise-blocked-trend'), `live: bull trend -> the downside raises are refused and logged (${placed})`);
    const fresh = () => ({ positions: JSON.parse(JSON.stringify(fx.book)), realizedPnl: 0, cashDeployed: 0, trendCtx: bull });
    const st2 = fresh();
    const placed2 = await T.raiseFloor(st2, cfg, deps, [], '10/05 15:35', { reason: 'be-wrong→bear (breaking lows + bearish candle)' });
    ok(placed2 === 0, 'permit off by default: a be-wrong signal does not unlock it');
    const st3 = fresh();
    const placed3 = await T.raiseFloor(st3, { ...cfg, floorRaiseTrendPermit: 'beWrong' }, deps, [], '10/05 15:35', { reason: 'be-wrong→bear (breaking lows + bearish candle)' });
    ok(placed3 > 0, `permit 'beWrong': the reversal unlocks the downside hedge (${placed3})`);
  }

  // ── 3 + 4. give-up urgency and the never-down ladder (live) ───────────────────────────────────
  {
    // A 10-wide bear P31030/31020 paid 5.29; cover = call spread 31010/31020 (debit). Spot 31015: the bear is
    // only 5 points through its short strike (points trigger needs 10) but the trend is BULL.
    const legs = [{ side: 'long', type: 'C', strike: 31010 }, { side: 'short', type: 'C', strike: 31020 }];
    const q = { 31010: { mid: 24.85, bid: 24.5, ask: 25.2 }, 31020: { mid: 20, bid: 19.7, ask: 20.3 } };
    const getLeg = (t, k) => (t === 'C' && q[k] ? { ...q[k], symbol: `NDX_C${k}` } : null);   // spread marks 4.85
    const mk = () => ({ positions: [{ id: 'p', side: 'bear', filled: true, limit: 5.29, quantity: 1, shortStrike: 31020, covered: false,
      legs: [{ side: 'long', type: 'P', strike: 31030 }, { side: 'short', type: 'P', strike: 31020 }],
      pendingCover: { legs, target: 3.71, openCost: 5.29, minLock: 1, placedEpoch: Date.now(), placedUnder: 31015, sentNet: 'DEBIT', orderId: 'o1' } }],
      trendCtx: bull, realizedPnl: 0 });
    const cfg = { spreadWidth: 10, tickIncrement: 0.05, quantity: 1, symbol: 'NDX' };
    const base = { getLeg, underlying: 31015, coverGiveUp: true, giveUpPoints: 10, giveUpMaxLoss: 0.05, coverLadder: true,
      replaceOrder: async () => ({ ok: true }), nowMs: Date.now() };
    let st = mk(); let d = [];
    await T.workRestingCovers(st, cfg, d, { ...base }, 31015);
    ok(!d.some((x) => x.action === 'cover-giveup'), 'without giveUpTrend: 5 points through, no give-up (the ladder walks)');
    st = mk(); d = [];
    await T.workRestingCovers(st, cfg, d, { ...base, giveUpTrend: 'A' }, 31015);
    const g = d.find((x) => x.action === 'cover-giveup');
    ok(g && g.to === 4.9 && g.trigger === 'trend', `giveUpTrend 'A': a bear fighting a bull trend goes to the market at once (to ${g && g.to}, mark + 1 tick, under break-even + 5% = 5.21)`);
    // never walk down: a cover already at 5.20 with no readable quote stays at 5.20
    st = mk(); st.positions[0].pendingCover.target = 5.2; d = [];
    await T.workRestingCovers(st, cfg, d, { ...base, getLeg: () => null }, 31015);
    ok(!d.some((x) => x.action === 'cover-reprice' && x.to < 5.2), 'the ladder never pulls a working cover below its current price');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
