'use strict';
/**
 * BOOK VALUE — what the book is worth at a given underlying price. One implementation, four callers.
 *
 * THE RISK CURVE IS THIS FUNCTION, sampled. The value of a book at price S is the payoff of the contracts
 * actually held at S, less the cash actually paid for them. Sample it across a price range and you have
 * the curve; evaluate it at the settle and you have the day's terminal P&L; evaluate it at the underlying
 * as of some moment and you have what the scrubber shows. Same question every time, so: same code.
 *
 * WHY IT EXISTS. On 2026-09-17 the same v7-10 book at NDX 29447 read +$3,140 on the debug page, -$975 on
 * the compare page, $2,840 from the engine's own eodSettlement and $4,120 from RC.bookPnl — four answers,
 * four hand-written copies of one calculation. RC.bookPnl was not wrong, it was answering with different
 * INPUTS; compare was genuinely wrong, pairing the credit twin's legs with the debit-canonical price and
 * then negating it. Every copy of a shared calculation in this repo has drifted sooner or later (optsFor
 * did exactly this), so this is the single source and the others call it.
 *
 * AS-SENT, NOT DEBIT-CANONICAL. What the book is worth depends on the contracts REALLY held and the cash
 * REALLY exchanged. Capital recapture alternates an open between a debit vertical and its CREDIT twin at
 * the same strikes; the position RECORD stays debit-canonical so floor/cap/cover logic is byte-identical,
 * but the twin is what is at the broker. The two are equal only while sentLimit == W - debitLimit, and on
 * 2026-09-17 that held for just 20 of 60 twins. So value the sent legs against the sent cash.
 * See feedback_use_real_numbers_not_derived.
 *
 * NOT TO BE CONFUSED WITH THE FLOOR. RC.bookFloor is the MINIMUM of this curve across all strikes and
 * tails — the governor's input, a worst case. This is the curve itself.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;   // server
  if (root) root.BookValue = api;                                          // browser global
})(typeof window !== 'undefined' ? window : null, function () {

  const r2 = (n) => Math.round(n * 100) / 100;
  const intrinsic = (leg, S) => (leg.type === 'C' ? Math.max(S - leg.strike, 0) : Math.max(leg.strike - S, 0));

  // Payoff of a leg set at settle S, per 1x, in POINTS (not dollars).
  function legsPayoff(legs, S) {
    let v = 0;
    for (const l of legs || []) v += (l.side === 'long' ? 1 : -1) * intrinsic(l, S);
    return v;
  }

  // Index the cover ORDERS out of a run's event log. A credit cover's real legs exist only here — the
  // position keeps the debit-canonical pair — so this is the only way to value what is actually held.
  function coverOrders(events) {
    const m = new Map();
    for (const e of events || []) {
      if ((e.type === 'order_simulated' || e.type === 'order_sent') && e.meta && e.meta.of
        && e.meta.legs && /cover/.test(e.meta.kind || '')) m.set(e.meta.of, e.meta);
    }
    return m;
  }

  /**
   * The book as it stood at `asOfEpoch` (null/undefined = final), reduced to what valuing it needs.
   *
   * opts:
   *   asOfEpoch      include only positions opened by then, and apply a cover only if it booked by then
   *   quantity       fallback contract count when a position carries none
   *   includeUnfilled treat working orders as held (default false — an unfilled order is not a position)
   * Covers are always valued from the position's own record — see the note at the cover branch for why
   * the order log cannot be trusted for this.
   */
  function heldBook(record, opts) {
    const o = opts || {};
    const state = (record && record.state) || {};
    const cfg = (record && record.config) || {};
    const asOf = o.asOfEpoch != null ? o.asOfEpoch : null;
    const byPos = coverOrders(record && record.events);
    const legs = [];           // every contract held, with its own quantity
    let cash = 0;              // dollars: positive = paid out, negative = received
    const parts = [];
    for (const pos of state.positions || []) {
      if (!pos || !pos.legs || !pos.legs.length) continue;
      if (!pos.filled && !o.includeUnfilled) continue;
      const opened = pos.openEpoch != null ? pos.openEpoch : null;
      if (asOf != null && opened != null && opened > asOf) continue;
      const qty = pos.quantity || cfg.quantity || o.quantity || 1;
      // OPEN — the credit twin is the real order when capital recapture sent one.
      const oCredit = pos.sentNet === 'CREDIT' && pos.sentLegs && pos.sentLegs.length;
      const oLegs = oCredit ? pos.sentLegs : pos.legs;
      const oCost = oCredit ? -(pos.sentLimit || 0) : (pos.limit || 0);
      for (const l of oLegs) legs.push({ ...l, quantity: qty });
      cash += oCost * 100 * qty;
      // COVER — only if it had actually booked by `asOf`.
      const coveredNow = pos.covered && (asOf == null || (pos.coverEpoch != null && pos.coverEpoch <= asOf));
      let cLegs = null, cCost = 0;
      if (coveredNow && pos.coverLegs && pos.coverLegs.length) {
        // THE COVER IS VALUED FROM THE POSITION, NOT THE ORDER LOG.
        //
        // The log is not a reliable description of what was BOOKED: on 2026-09-17, 2 of 91 covers had log
        // legs at different strikes than the cover actually recorded (wing shifts and re-sends, and the
        // index keeps only the last matching event), so valuing from it prices a cover that was never
        // held. pos.coverLegs/coverLimit are what the engine wrote when the cover filled.
        //
        // This is DEBIT-CANONICAL, and that is exact rather than an approximation: a credit twin at the
        // same strikes satisfies payoff(twin) + credit == payoff(debit pair) - debit whenever
        // credit == W - debit, so the pair values identically either way. The residual is the real
        // credit-vs-debit pricing gap, which the record simply does not preserve — and inventing it from
        // the log's asking price, as an earlier pass here did, moved fleet P&L by thousands in the
        // flattering direction. Better to be exactly parity-correct than approximately real.
        cLegs = pos.coverLegs;
        cCost = pos.coverLimit != null ? pos.coverLimit : 0;
        for (const l of cLegs) legs.push({ ...l, quantity: qty });
        cash += cCost * 100 * qty;
      }
      parts.push({ id: pos.id, side: pos.side, covered: !!coveredNow, qty,
        openLegs: oLegs, openCost: oCost, coverLegs: cLegs, coverCost: cCost,
        geometry: pos.coverGeometry || null });
    }
    return { legs, cash, parts };
  }

  // Dollar value of a held book at underlying S.
  function valueAt(book, S) {
    let v = 0;
    for (const l of book.legs || []) v += (l.side === 'long' ? 1 : -1) * intrinsic(l, S) * 100 * (l.quantity || 1);
    return r2(v - (book.cash || 0));
  }

  // The curve as [[S, value], ...]. `strikes` are included exactly because the payoff is piecewise-linear
  // with kinks ONLY at strikes — sampling a uniform grid alone can miss a peak between two samples.
  function curve(book, lo, hi, step) {
    const xs = new Set();
    const st = step || Math.max(1, (hi - lo) / 240);
    for (let x = lo; x <= hi; x += st) xs.add(r2(x));
    for (const l of book.legs || []) if (l.strike >= lo && l.strike <= hi) xs.add(l.strike);
    return [...xs].sort((a, b) => a - b).map((x) => [x, valueAt(book, x)]);
  }

  // Convenience: terminal P&L at the settle, in the shape eodSettlement reports.
  function terminalAt(record, settle, opts) {
    const book = heldBook(record, opts);
    const positions = book.parts.map((p) => {
      const value = r2(legsPayoff(p.openLegs, settle) + (p.coverLegs ? legsPayoff(p.coverLegs, settle) : 0));
      const cost = r2(p.openCost + p.coverCost);
      return { id: p.id, side: p.side, covered: p.covered, geometry: p.geometry,
        value, cost, pnl: r2((value - cost) * 100 * p.qty) };
    });
    return { settle, total: r2(positions.reduce((a, p) => a + p.pnl, 0)), positions };
  }

  return { heldBook, valueAt, curve, terminalAt, legsPayoff, coverOrders };
});
