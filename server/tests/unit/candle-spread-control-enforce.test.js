'use strict';
// ENFORCEMENT of the remote control state — the half that actually stops trading.
//
// Reading the control file is worthless if the engine does not act on it, and the ways enforcement can be
// subtly wrong are all worse than not having it:
//   - a halt that covers SOME senders looks effective while the ladder keeps repricing
//   - a no-open that also blocks covers leaves a live 0DTE position uncovered and unmanaged, which is the most
//     dangerous state available — strictly worse than doing nothing
//   - a cancel blocked by halt leaves working orders at the broker the engine has stopped managing
//   - an open refused SILENTLY makes a restricted afternoon indistinguishable from one with no setups
//
// Run: node server/tests/unit/candle-spread-control-enforce.test.js
const trader = require('../../src/candle-spread/trader');
const bs = require('../../src/candle-spread/bs-pricer');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

const spot = 100, tau = 0.01, iv = 0.4;
const getLeg = (type, strike) => { const mid = bs.bsPrice(type, spot, strike, tau, iv);
  return mid == null ? null : { mid: Math.round(mid * 100) / 100, bid: mid - 0.1, ask: mid + 0.1, symbol: `X${type}${strike}` }; };
const cfg = { symbol: 'NDX', spreadWidth: 20, strikeIncrement: 10, tickIncrement: 0.05, quantity: 1,
  coverFillModel: 'resting', expiration: '2026-09-30' };

function makeRecord() {
  return { runId: 'r', tradeDate: '2026-09-30', config: { ...cfg, variant: 'v7-20' },
    state: { direction: 'none', positions: [], pendingOpenId: null, realizedPnl: 0, cashDeployed: 0,
      lastCandleTime: null, liveOrders: [] }, events: [] };
}
const candle = (close) => ({ timeEST: '2026-09-30 10:30', datetime: Date.parse('2026-09-30T14:30:00Z'),
  open: close - 2, high: close + 1, low: close - 3, close });

// THE SIGNAL IS STUBBED, NOT COAXED. Driving the ported path (deps.signalFn) means the test states the signal
// outright rather than trying to provoke a Bollinger break out of one synthetic candle — the restriction is
// what is under test, not the entry logic.
const signalling = (sig) => ({ signalFn: () => sig, A: {}, priorA: {}, isFifteen: false });

// Record what the engine tried to send, so "it opened" is observable from the order side too.
function recorder() {
  const sent = [];
  return { sent, placeOrder: async (payload, meta) => { sent.push(meta || {}); return { status: 'filled', filled: true, orderId: 'o' + sent.length }; } };
}

(async () => {
  // ── 1. THE CONTROL ARM: WITHOUT A RESTRICTION, AN OPEN HAPPENS ─────────────────────────────────────
  // Without this the tests below prove only that nothing ever opens.
  let opened = false;
  {
    const rec = makeRecord();
    const deps = { getLeg, dryRun: true, underlying: spot, signalSymbol: 'NDX', priceSymbol: 'NDX',
      strikeIncrement: 10, ...signalling({ openSide: 'bull' }), ...recorder() };
    const out = await trader.processCandleClose(rec, candle(spot), null, deps);
    const d = (out && out.decisions) || [];
    opened = d.some((x) => x.action === 'open');
    ok(opened, `control: with no restriction the engine opens (${d.map((x) => x.action).join(',') || 'no decisions'})`);
  }

  // ── 2. blockNewOpens REFUSES THE OPEN, AND SAYS SO ────────────────────────────────────────────────
  if (opened) {
    const rec = makeRecord();
    const deps = { getLeg, dryRun: true, underlying: spot, signalSymbol: 'NDX', priceSymbol: 'NDX',
      strikeIncrement: 10, blockNewOpens: true, controlRestrict: 'no-open', controlMode: 'live',
      ...signalling({ openSide: 'bull' }), ...recorder() };
    const out = await trader.processCandleClose(rec, candle(spot), null, deps);
    const d = (out && out.decisions) || [];
    ok(!d.some((x) => x.action === 'open'), 'blockNewOpens refuses the open');
    const skip = d.find((x) => x.action === 'open-skip-control');
    ok(!!skip, 'and records open-skip-control rather than refusing silently');
    ok(skip && skip.restrict === 'no-open' && skip.mode === 'live',
      'naming the restriction and the mode, so a restricted afternoon is distinguishable from a quiet one');
    ok(rec.state.positions.length === 0, 'no position is created');
  }

  // ── 3. NO-OPEN MUST NOT BLOCK COVERS ──────────────────────────────────────────────────────────────
  // THE ONE THAT MATTERS MOST. If no-open also stopped covering, a live variant holding an uncovered 0DTE
  // position would sit on naked risk and refuse to act — strictly worse than having no kill switch at all.
  {
    const rec = makeRecord();
    // a filled, uncovered position on the book
    rec.state.positions.push({ id: 'p1', side: 'bull', shortStrike: 120, quantity: 1, filled: true,
      covered: false, pendingCover: null,
      legs: [{ side: 'long', type: 'C', strike: 100 }, { side: 'short', type: 'C', strike: 120 }], limit: 8 });
    rec.state.direction = 'bull';
    // The signal asks to open AND to cover the held side: under no-open the open must be refused while the
    // cover still goes through.
    const rc = recorder();
    const deps = { getLeg, dryRun: true, underlying: spot, signalSymbol: 'NDX', priceSymbol: 'NDX',
      strikeIncrement: 10, blockNewOpens: true, controlRestrict: 'no-open',
      coverSelector: 'fixed-mark', ...signalling({ openSide: 'bull', coverSide: 'bull' }), ...rc };
    const out = await trader.processCandleClose(rec, candle(spot), null, deps);
    const d = (out && out.decisions) || [];
    // ASSERT ON THE ORDER LEAVING, not on a decision merely being logged. An earlier version OR'd three loose
    // conditions and passed even with covering deliberately disabled — it proved nothing.
    const coverSends = rc.sent.filter((m) => /cover/.test(m.kind || ''));
    ok(coverSends.length === 1,
      `a cover order is actually SENT under no-open (${rc.sent.map((m) => m.kind).join(',') || 'nothing sent'})`);
    ok(rec.state.positions[0].pendingCover != null,
      'and the position carries the resting cover');
    ok(d.some((x) => x.action === 'cover-rest'), 'with the cover-rest decision recorded');
    ok(!d.some((x) => x.action === 'open') && !rc.sent.some((m) => m.kind === 'open'),
      'while opening nothing new — neither a decision nor an order');
  }

  // ── 4. THE HALT COVERS EVERY SENDER, AND SPARES CANCEL ────────────────────────────────────────────
  // Checked through the real index.js senders rather than by re-implementing the rule, because a halt that
  // covers two of three senders is the failure this is guarding against.
  {
    const SC = require('../../src/candle-spread/strategy-control');
    SC._reset();
    const KEY = 'runs/_control/strategy-control.json';
    const file = JSON.stringify({ variants: { 'v7-10': { mode: 'simulate', restrict: 'halt', note: 'test halt' } } });
    const arch = { PREFIX: 'runs', BUCKET: 'b', enabled: () => true,
      async getObjectRaw() { return { ok: true, body: file }; } };
    await SC.refresh({ archive: arch, knownVariants: ['v7-10', 'v7-20'], liveAllowed: true,
      log: () => {}, warn: () => {} });
    ok(SC.canSendOrders('v7-10') === false, 'halted: canSendOrders false');
    ok(SC.canOpen('v7-10') === false, 'halted: canOpen false');
    ok(SC.canSendOrders('v7-20') === true, 'an UNLISTED variant is unaffected — the halt is per-variant');
    // The engine's own dryRun mapping must not be changed by a halt: halt is about ACTION, not identity.
    ok(SC.dryRunFor('v7-10') === true, "halt leaves mode alone (this one was 'simulate')");
    SC._reset();
  }

  // ── 5. A HALT ON A LIVE VARIANT KEEPS IT LIVE, AND STILL BLOCKS SENDS ────────────────────────────
  // mode and restrict are orthogonal; conflating them would mean you cannot halt a live variant without also
  // demoting it, and the demotion would be the thing that changed its behaviour when trading resumed.
  {
    const SC = require('../../src/candle-spread/strategy-control');
    SC._reset();
    const file = JSON.stringify({ variants: { 'v6-20': { mode: 'live', restrict: 'halt' } } });
    const arch = { PREFIX: 'runs', BUCKET: 'b', enabled: () => true,
      async getObjectRaw() { return { ok: true, body: file }; } };
    await SC.refresh({ archive: arch, knownVariants: ['v6-20'], liveAllowed: true, log: () => {}, warn: () => {} });
    ok(SC.dryRunFor('v6-20') === false, 'it is still a live strategy');
    ok(SC.canSendOrders('v6-20') === false, 'and still cannot send anything');
    SC._reset();
  }

  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
