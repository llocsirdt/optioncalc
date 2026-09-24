'use strict';
// A REJECTED ORDER IS NOT A POSITION.
//
// placeOrder returned `filled: true` from its catch so the state machine would keep simulating the
// intended strategy through a send failure — correct while nothing was real, exactly inverted once it is.
// Every caller reads the result as "the order exists", so one Schwab 4xx produced: a resting cover that
// later booked a floor into realizedPnl, a combo that booked two positions and a locked profit, a hedge
// holding budget, and an open that laddered a price nobody was quoting.
const os = require('os'), path = require('path'), fs = require('fs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-fs-'));
process.env.CANDLE_SPREAD_RUNS_DIR = tmp;
const store = require('../../src/candle-spread/store');
const trader = require('../../src/candle-spread/trader');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

const cfg = { symbol: 'NDX', expiration: '2026-09-24', spreadWidth: 20, strikeIncrement: 10, quantity: 1,
  tickIncrement: 0.05, coverSelector: 'fixed-mark', coverFillModel: 'resting', variant: 'fs' };
// Monotonic chain: calls fall as strike rises, puts rise. A 20-wide vertical marks 8.00.
const getLeg = (type, strike) => {
  const d = (strike - 22000) * 0.4;
  const mid = type === 'C' ? 400 - d : 400 + d;
  return { mid: Math.round(mid * 100) / 100, symbol: `NDX_${type}${strike}`, bid: mid - 0.2, ask: mid + 0.2 };
};
const legs = [{ side: 'long', type: 'C', strike: 21990 }, { side: 'short', type: 'C', strike: 22010 }];
const mkPos = () => ({ id: 'p1', side: 'bull', legs, quantity: 1, limit: 8.0, shortStrike: 22010,
  filled: true, covered: false, pendingCover: null, openTime: '09/24 10:00' });
const plan = { legs: [{ side: 'short', type: 'P', strike: 22010 }, { side: 'long', type: 'P', strike: 22030 }],
  limit: 9.0, mark: 9.0, geometry: 'tent', longStrike: 22030 };

const REJECT = async () => ({ status: 'error', filled: false, sent: false, error: 'Schwab 400' });
const ACCEPT = async () => ({ status: 'sent', filled: true, orderId: 'ok-1' });

(async () => {
  // A refused cover-rest must not attach a pendingCover, and must not burn its strikes.
  for (const [label, send, wantCover] of [['REJECTED', REJECT, false], ['accepted', ACCEPT, true]]) {
    const st = { positions: [], cashDeployed: 0 }, d = [];
    const pos = mkPos(); st.positions.push(pos);
    // The REAL ledger — a stub does not satisfy LL.resolveCover and the cover silently never places.
    const LL = require('../../src/candle-spread/leg-ledger');
    const backing = {};
    const real = LL.makeLegLedger(backing);
    const ledger = { recorded: [], record(l) { this.recorded.push(...l); real.record(l); },
      conflicts: (l) => real.conflicts(l), sideOf: (t, k) => real.sideOf(t, k), size: () => real.size() };
    await trader.placeRestingCover(pos, plan, cfg, { getLeg, placeOrder: send, enforceLegUniqueness: true,
      _ledger: ledger, capitalRecapture: false }, '09/24 10:05', d, 'continuous', 0, st);
    ok(!!pos.pendingCover === wantCover, `${label} send -> pendingCover ${wantCover ? 'attached' : 'NOT attached'}`);
    ok((ledger.recorded.length > 0) === wantCover,
      `${label} send -> strikes ${wantCover ? 'committed' : 'NOT committed'} to the leg ledger (got ${ledger.recorded.length})`);
    if (!wantCover) ok(d.some(x => x.action === 'cover-not-sent'), 'and the refusal is logged, not silent');
  }

  // The same for an OPEN: no position, and no ladder to walk.
  {
    const st = { positions: [], cashDeployed: 0, openN: 0 }, d = [];
    const res = { legs, limit: 8.05, mark: 8.0, lower: 21990, upper: 22010, shortStrike: 22010, cap: 13,
      payload: { orderType: 'NET_DEBIT', price: 8.05, orderLegCollection: [] } };
    await trader.openPosition(st, res, 'bull', cfg,
      { getLeg, placeOrder: REJECT, enforceLegUniqueness: false }, d, null);
    ok(st.positions.length === 0, 'a refused OPEN creates no position');
    ok(d.some(x => x.action === 'open-not-sent'), 'and says so');
  }

  // ---- A STRATEGY CANCEL MUST REACH THE BROKER ------------------------------------------------------
  // cancel-open deleted the position locally and left the order working at Schwab. The engine then opened
  // the OTHER side, so both were live and both could fill — double, opposed exposure on a view the engine
  // no longer held. A reversal is the core signal, so this happened on ordinary days.
  {
    const cancels = [];
    const cancelOrder = async (id, meta) => { cancels.push({ id, meta }); return { status: 'cancelled', orderId: id }; };
    const bands = { bollinger20_2: { upper: 22400, lower: 22100, middle: 22250 } };
    const mkRec = (variant) => store.initRun({ ...cfg, variant }, '2026-09-24');

    // A working BULL open, then a candle whose signal wants BEAR.
    const run = async (deps) => {
      const rec = mkRec('cx' + Math.random().toString(36).slice(2, 7));
      rec.state.positions = [{ id: 'p1', side: 'bull', legs, quantity: 1, limit: 8.0, filled: false,
        orderStatus: 'working', covered: false, pendingCover: null, orderId: 'brk-9', openTime: '09/24 10:00' }];
      rec.state.pendingOpenId = 'p1';
      await trader.processCandleClose(rec, { timeEST: '09/24 10:05', open: 1, high: 2, low: 0, close: 1, indicators: bands },
        { timeEST: '09/24 10:00', open: 2, high: 2, low: 1, close: 1, indicators: bands },
        { getLeg, placeOrder: ACCEPT, dryRun: true, underlying: 22000,
          signalFn: () => ({ openSide: 'bear' }), ...deps });
      return rec;
    };

    const rec = await run({ cancelOrder });
    const d = (rec.events || []).flatMap((e) => e.decisions || []);
    const co = d.find((x) => x.action === 'cancel-open');
    ok(!!co, 'a reversal still cancels the working open');
    ok(cancels.length === 1 && cancels[0].id === 'brk-9',
      `and the cancel reaches the broker against the recorded order id (${cancels.length} sent)`);
    ok(co && co.cancelSent === true, 'the decision records that it was sent');
    ok(!rec.state.positions.some((p) => p.id === 'p1'), 'and the position is gone locally');

    // No cancelOrder wired (dry run) — cancel locally, send nothing, never throw.
    cancels.length = 0;
    const rec2 = await run({});
    const co2 = (rec2.events || []).flatMap((e) => e.decisions || []).find((x) => x.action === 'cancel-open');
    ok(!!co2 && co2.cancelSent === false, 'with no sender it still cancels locally and says it did not send');
    ok(cancels.length === 0, 'and nothing went out');

    // A cancel that REJECTS must not break the tick — the local decision stands either way.
    cancels.length = 0;
    const rec3 = await run({ cancelOrder: async () => { throw new Error('already filled'); } });
    ok(!rec3.state.positions.some((p) => p.id === 'p1'), 'a failed cancel still removes the position locally');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL: threw ->', e && e.message); process.exit(1); });
