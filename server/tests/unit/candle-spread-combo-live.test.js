'use strict';
// 4-leg combo LIVE path (trader.tryComboLockAndOpen): a cap blocks a new open → lock ONE deep-ITM winner
// AND place the open as a SINGLE atomic CUSTOM order, booking BOTH on the one fill.
// Run: node server/tests/nogit/candle-spread-combo-live.test.js
const trader = require('../../src/candle-spread/trader');
const LL = require('../../src/candle-spread/leg-ledger');
const bs = require('../../src/candle-spread/bs-pricer');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

const spot = 100, tau = 0.01, iv = 0.4;
const getLeg = (type, strike) => { const mid = bs.bsPrice(type, spot, strike, tau, iv); return mid == null ? null : { mid: Math.round(mid * 100) / 100, symbol: `NDX_${type}${strike}`, bid: mid - 0.1, ask: mid + 0.1 }; };
const cfg = { spreadWidth: 20, strikeIncrement: 10, tickIncrement: 0.05, quantity: 1, capFrac: 0.8 };

// A deep-ITM bull winner (long C70 / short C90 at spot 100 → marks ~ the full $20 width), uncovered.
const winner = { id: 'pos-1', side: 'bull', shortStrike: 90, legs: [{ side: 'long', type: 'C', strike: 70 }, { side: 'short', type: 'C', strike: 90 }], limit: 5, quantity: 1, filled: true, covered: false, pendingCover: null };
const st = { positions: [winner], realizedPnl: 0, cashDeployed: 0, peakCashDeployed: 0, openN: 6, direction: 'bull', legLedger: {}, lastCandleTime: '2026-09-01T10:00:00', lastCandleEpoch: 1 };
const ledger = LL.makeLegLedger(st.legLedger); ledger.record(winner.legs);   // winner already on the ledger

// New open: slightly-OTM bull spread long C100 / short C120 — no strike overlap with the winner (70/90) or
// its credit cover (90/110), so it's a clean 4-leg combo.
const oLimit = Math.round((getLeg('C', 100).mid - getLeg('C', 120).mid) * 100) / 100;
const res = { legs: [{ side: 'long', type: 'C', strike: 100 }, { side: 'short', type: 'C', strike: 120 }], lower: 100, upper: 120, shortStrike: 120, mark: oLimit, cap: oLimit, limit: oLimit };

const sent = [];
const deps = {
  getLeg, enforceLegUniqueness: true, _ledger: ledger, comboOrders: true, comboSlip: 0.05,
  coverToStackMinFrac: 0.65, creditCoverFrac: 0.65, capitalRecapture: true, openAlternateEvery: 3,
  proactiveCoverFrac: 0.80, hardCap: 500 + Math.round(oLimit * 100) - 50,   // blocks now (winner uncov 500), fits once covered
  legMaxShift: 6, legMaxWing: 8,
  placeOrder: async (payload, meta) => { sent.push({ payload, meta }); return { status: 'filled', filled: true, orderId: 'ord-' + sent.length }; }
};

(async () => {
  const decisions = [];
  const placed = await trader.tryComboLockAndOpen(st, res, 'bull', cfg, deps, decisions, '2026-09-01T10:00:00');
  ok(placed === true, `combo placed (returned ${placed})`);
  ok(sent.length === 1, `exactly ONE order sent (${sent.length})`);
  const p = sent[0] && sent[0].payload;
  ok(p && p.complexOrderStrategyType === 'CUSTOM', 'order is a CUSTOM combo');
  ok(p && p.orderLegCollection.length === 4, `4 legs in one order (${p && p.orderLegCollection.length})`);
  ok(p && (p.orderType === 'NET_DEBIT' || p.orderType === 'NET_CREDIT'), `net type set (${p && p.orderType})`);
  ok(winner.covered === true && winner.coverLimit != null && winner.coverLegs, 'winner covered with legs + limit');
  ok(st.realizedPnl > 0, `locked floor booked (realizedPnl ${st.realizedPnl})`);
  const newPos = st.positions.find(x => x.id !== 'pos-1');
  ok(newPos && newPos.side === 'bull' && newPos.viaCombo === 'pos-1', 'new open added, tagged viaCombo');
  ok(newPos && newPos.filled === true, 'new open marked filled');
  ok(st.legLedger['C110'] && st.legLedger['C100'] && st.legLedger['C120'], 'ledger recorded cover + open legs');
  const dec = decisions.find(d => d.action === 'combo-lock-open');
  ok(dec && dec.openId === (newPos && newPos.id), 'combo-lock-open decision logged');

  // ── THE PRICE BELONGS TO THE SPREAD THAT INCURRED IT ────────────────────────────────────────────
  // cn.side/cn.limit describe the whole FOUR-LEG order. Both halves were stamped with them, so a
  // credit-style cover inside a net-DEBIT combo recorded coverSentNet 'DEBIT' — and every valuation then
  // priced the debit twin of legs that were never sent — while the open recorded the combo's own net as
  // its sentLimit, which book-value reads as `-sentLimit` for a credit open: one position carrying the
  // cash of the entire order.
  {
    const dec = decisions.find((d) => d.action === 'combo-lock-open');
    ok(dec.coverNet === (winner.coverLegs && winner.coverSentNet),
      `the decision and the position agree on the cover's own net (${dec.coverNet} / ${winner.coverSentNet})`);
    ok(['DEBIT', 'CREDIT'].includes(winner.coverSentNet), 'the cover carries a net of its own');
    ok(winner.coverSentNet !== 'DEBIT' || !winner.coverSentCredit,
      'a debit cover carries no credit figure');
    // The two shares must reconstruct the order exactly — that is what makes them an attribution rather
    // than two more guesses.
    const signed = (net, amt) => (net === 'CREDIT' ? -amt : amt);
    const sum = Math.round((signed(dec.coverNet, dec.coverPart) + signed(dec.openNet, dec.openPart)) * 100) / 100;
    const orderSigned = signed(dec.net, dec.limit);
    ok(Math.abs(sum - orderSigned) < 0.011,
      `cover share ${dec.coverPart} ${dec.coverNet} + open share ${dec.openPart} ${dec.openNet} = the order's ${orderSigned}`);
    ok(newPos.sentLimit === dec.openPart && newPos.sentNet === dec.openNet,
      `the open records its OWN share (${newPos.sentLimit} ${newPos.sentNet}), not the combo's ${dec.limit} ${dec.net}`);
    ok(newPos.comboLimit === dec.limit && newPos.comboNet === dec.net,
      'while still carrying the order-level figure, so the fill can be reconciled');
  }

  // ── A SLID COVER SENDS THE STRIKES IT RESERVED ──────────────────────────────────────────────────
  // coverSentLegs and coverBookLegs were both built at winner.shortStrike, ignoring rc.anchor. When the
  // resolver slid the cover deeper ITM to dodge a leg conflict, the ORDER went out at the unslid strikes
  // while deps._ledger.record(rc.legs) reserved the slid ones — an instrument nothing had validated, and
  // strikes reserved that were never traded.
  {
    const w2 = { id: 'pos-9', side: 'bull', shortStrike: 90,
      legs: [{ side: 'long', type: 'C', strike: 70 }, { side: 'short', type: 'C', strike: 90 }],
      limit: 5, quantity: 1, filled: true, covered: false, pendingCover: null };
    const st3 = { positions: [w2], realizedPnl: 0, cashDeployed: 0, peakCashDeployed: 0, openN: 6,
      direction: 'bull', legLedger: {}, lastCandleTime: 't', lastCandleEpoch: 1 };
    const led3 = LL.makeLegLedger(st3.legLedger);
    led3.record(w2.legs);
    // Block BOTH ideal covers at the 90 anchor, so the resolver has to SLIDE: long P90 collides with the
    // debit cover's short P90, and short C110 collides with the credit twin's long C110. The resolver
    // answers anchor 100 / shift 10 / credit — and note what the OLD code would have sent at
    // winner.shortStrike: short C90 / long C110, i.e. the exact leg the ledger had just refused.
    led3.record([{ side: 'long', type: 'P', strike: 90 }, { side: 'short', type: 'C', strike: 110 }]);
    const preLedger = { ...st3.legLedger };
    const sent3 = [];
    const deps3 = { ...deps, _ledger: led3,
      placeOrder: async (payload, meta) => { sent3.push({ payload, meta }); return { status: 'filled', filled: true, orderId: 'x' }; } };
    const d3 = [];
    const okPlaced = await trader.tryComboLockAndOpen(st3, res, 'bull', cfg, deps3, d3, 't');
    const dec3 = d3.find((d) => d.action === 'combo-lock-open');
    if (!okPlaced || !dec3) {
      ok(sent3.length === 0, 'a cover that cannot be resolved sends nothing at all');
    } else {
      const sentStrikes = (sent3[0].meta.coverLegs || []).map((l) => l.type + l.strike).sort().join(' ');
      const recorded = Object.keys(st3.legLedger).sort();
      const inLedger = (sent3[0].meta.coverLegs || []).every((l) => recorded.includes(l.type + l.strike));
      ok(inLedger, `every cover leg SENT is a leg the ledger reserved (sent ${sentStrikes})`);
      ok(dec3.coverShift > 0, `the resolver really slid (anchor ${dec3.coverAnchor}, shift ${dec3.coverShift}) — otherwise this case proves nothing`);
      // The point of the resolver is that the order never contradicts a strike already held the other way.
      const clash = (sent3[0].meta.coverLegs || []).filter((l) => {
        const held = preLedger[l.type + l.strike];
        return held && held !== l.side && held.side !== l.side;
      });
      ok(!clash.length, `no SENT cover leg contradicts a strike already held (${clash.map((l) => l.side[0] + l.type + l.strike).join(' ') || 'none'})`);
      const bookShort = (w2.coverLegs || []).find((l) => l.side === 'short');
      ok(bookShort && bookShort.strike === dec3.coverAnchor,
        `and the BOOKED cover sits at that same anchor (${bookShort && bookShort.strike})`);
    }
  }

  // NEGATIVE: with comboOrders off / no winner deep enough, it declines (returns false, sends nothing)
  const st2 = { positions: [], realizedPnl: 0, legLedger: {}, openN: 0 };
  const sent2 = [];
  const deps2 = { ...deps, _ledger: LL.makeLegLedger(st2.legLedger), placeOrder: async (pl) => { sent2.push(pl); return { status: 'filled', filled: true }; } };
  const none = await trader.tryComboLockAndOpen(st2, res, 'bull', cfg, deps2, [], 't');
  ok(none === false && sent2.length === 0, 'no lockable winner → declines, sends nothing');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
