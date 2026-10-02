'use strict';
// THE CONTROL FILE'S MODE MUST REACH THE ORDER SENDERS.
//
// The environment arms a variant (CANDLE_SPREAD_ARMED + CANDLE_SPREAD_ARMED_MODE) and that sets the CEILING.
// The control file may lower it. Lowering is the brake an operator reaches for when a live variant is
// misbehaving mid-session and halting outright would abandon an open 0DTE position.
//
// WHAT WENT WRONG, AND WHY NO EXISTING TEST SAW IT. All three senders did `const mode = run.dryRun` at
// closure-creation time and decided unfillable pricing from it. `run.dryRun` is the ROSTER value. So with the
// roster armed live, a control entry of `mode: paper` changed what the TRADER believed (it reads deps.dryRun)
// while the senders kept sending REAL FILLABLE orders, and fillSourceFor read the roster too and booked from
// the broker. Every enforcement test ran through the trader, where the mode was correct — the senders were
// never exercised with a control file that disagreed with the roster. This test does exactly that.
//
// Run: node server/tests/unit/candle-spread-control-mode.test.js

// The live gates are read at module load, so they must be set BEFORE the require.
process.env.CANDLE_SPREAD_LIVE = 'true';
process.env.CANDLE_SPREAD_ARMED = 'v7-10';
process.env.CANDLE_SPREAD_ARMED_MODE = 'live';

const cs = require('../../src/candle-spread/index');
const SC = require('../../src/candle-spread/strategy-control');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

// A tradingClient that records what price it was actually asked to send.
function client() {
  const sent = [];
  return { sent,
    placeOrderByAcct: async (_h, payload) => { sent.push(payload); return { orderId: 'o1' }; },
    updateOrderById: async (_h, _id, payload) => { sent.push(payload); return { orderId: 'o2' }; },
    cancelOrderByAcct: async () => ({}) };
}
// INSTALL A CONTROL FILE WITHOUT S3. This is exactly what refresh() does with the body it fetched
// (normalise -> state.variants), so the test exercises the real validation and the real clamp.
function install(file, baseline) {
  SC._reset();
  SC.seedBaseline(baseline);
  const n = SC.normalise(file, null, { liveAllowed: true, baseline });
  SC._state.variants = n.variants;
  return n;
}

const run = (dryRun) => ({ variant: 'v7-10', spreadWidth: 10, tickIncrement: 0.05, dryRun });
const record = () => ({ runId: 'r', config: { variant: 'v7-10' }, state: { liveOrders: [] }, events: [] });
const payload = () => ({ orderType: 'NET_DEBIT', price: 5.00, legs: [] });
const meta = () => ({ kind: 'open', legs: [] });

(async () => {
  // ── 1. THE ROSTER IS LIVE AND THE FILE IS SILENT -> A REAL FILLABLE ORDER ─────────────────────────
  // The control arm. Without it, everything below proves only that nothing ever sends.
  install({ variants: {} }, { 'v7-10': 'live' });
  const c1 = client();
  cs._setDeps({ isProd: true, tradingClient: c1, accountHash: 'h' });
  ok(cs._liveArmed() === true, 'the live gate is armed for this test');
  {
    const r = run(false);
    const out = await cs.makePlaceOrder(r, record())(payload(), meta());
    ok(out.status === 'sent', `roster live + file silent sends live (got ${out.status})`);
    ok(c1.sent.length === 1 && c1.sent[0].price === 5.00,
      `and at the REAL price (got ${c1.sent.length ? c1.sent[0].price : 'nothing'})`);
    ok(cs.fillSourceFor(r) === 'broker', 'and books fills from the broker');
    ok(cs.effectiveDryRun(r) === false, 'effective mode is live');
  }

  // ── 2. THE FILE LOWERS IT TO PAPER -> THE PRICE MUST BECOME UNFILLABLE ───────────────────────────
  // THE BUG. Pre-fix this sent 5.00 — a real fillable order on a variant the operator had just put in paper.
  {
    install({ variants: { 'v7-10': { mode: 'paper', note: 'brake' } } }, { 'v7-10': 'live' });
    ok(SC.forVariant('v7-10').mode === 'paper', 'the file lowered v7-10 to paper (clamp permits lowering)');

    const r = run(false);                     // the ROSTER still says live — this is the disagreement
    ok(cs.effectiveDryRun(r) === 'test', `effective mode follows the FILE, not the roster (got ${JSON.stringify(cs.effectiveDryRun(r))})`);

    const c2 = client();
    cs._setDeps({ isProd: true, tradingClient: c2, accountHash: 'h' });
    const out = await cs.makePlaceOrder(r, record())(payload(), meta());
    ok(out.status === 'test-sent', `the send is marked test, not live (got ${out.status})`);
    ok(c2.sent.length === 1, 'a real order still reaches the broker — paper means unfillable, not unsent');
    ok(c2.sent.length === 1 && c2.sent[0].price !== 5.00,
      `and the price was rewritten away from the real 5.00 (got ${c2.sent.length ? c2.sent[0].price : 'nothing'})`);
    ok(c2.sent.length === 1 && c2.sent[0].price < 5.00,
      'downward, so a NET_DEBIT cannot fill');
    ok(cs.fillSourceFor(r) === 'mark',
      'and fills are booked from marks — the broker is not authoritative for an order that cannot fill');
  }

  // ── 3. THE REPLACE LADDER HONOURS IT TOO ─────────────────────────────────────────────────────────
  // A halt that covers SOME senders looks effective while the ladder keeps repricing. Same for a mode.
  {
    const c3 = client();
    cs._setDeps({ isProd: true, tradingClient: c3, accountHash: 'h' });
    const rec = record();
    rec.state.liveOrders = [{ orderId: 'o1', status: 'WORKING' }];
    const out = await cs.makeReplaceOrder(run(false), rec)('o1', payload(), meta());
    ok(out.status === 'test-replaced', `the replace is marked test too (got ${out.status})`);
    ok(c3.sent.length === 1 && c3.sent[0].price < 5.00,
      `and walks an unfillable price (got ${c3.sent.length ? c3.sent[0].price : 'nothing'})`);
  }

  // ── 4. THE FILE CANNOT RAISE ABOVE THE ROSTER ────────────────────────────────────────────────────
  // The other half of the rule, and the one already shipped: a file asking for live on a paper-armed variant
  // must not get it. Checked here because this test is where the two halves meet.
  {
    install({ variants: { 'v7-10': { mode: 'live' } } }, { 'v7-10': 'paper' });
    ok(SC.forVariant('v7-10').mode === 'paper', 'a file asking live on a paper-armed variant is clamped to paper');
    const r = run('test');
    ok(cs.effectiveDryRun(r) === 'test', 'and the senders see paper');
    const c4 = client();
    cs._setDeps({ isProd: true, tradingClient: c4, accountHash: 'h' });
    const out = await cs.makePlaceOrder(r, record())(payload(), meta());
    ok(out.status === 'test-sent', `so the send stays test (got ${out.status})`);
    ok(c4.sent.length === 1 && c4.sent[0].price < 5.00, 'at an unfillable price');
  }

  // ── 5. SIMULATE SENDS NOTHING AT ALL ─────────────────────────────────────────────────────────────
  {
    install({ variants: { 'v7-10': { mode: 'simulate' } } }, { 'v7-10': 'live' });
    const c5 = client();
    cs._setDeps({ isProd: true, tradingClient: c5, accountHash: 'h' });
    const out = await cs.makePlaceOrder(run(false), record())(payload(), meta());
    ok(String(out.status).startsWith('simulated:'), `simulate sends nothing (got ${out.status})`);
    ok(c5.sent.length === 0, 'the broker saw no order');
    ok(cs.fillSourceFor(run(false)) === 'mark', 'and fills come from marks');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
