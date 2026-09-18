// Strategy positions source: translate a candle-spread RUN RECORD (from /api/v1/candle-spread/runs)
// into the calculator's optionArray leg-string, plus a parallel positions-with-timestamps structure the
// future NQ-chart overlay will plot. The run's positions ARE the (paper) account for this source.
//
// Each filled position contributes its debit-CANONICAL legs (the run stores those regardless of any
// credit-recapture sends, so the P&L basis matches the strategy's own): open spread, plus the cover
// spread if covered (the locked tent). Net cost sits on the long leg of each spread (spreads only care
// about the net); cost is in dollars (× 100), sign follows the optionArray convention (+ debit / - credit).
// Pure + isomorphic (Node for tests, window for the browser).
(function (root) {
  'use strict';

  function fmtLeg(leg) { return `${leg.qty}${leg.type}${leg.strike}@${leg.cost}`; }

  // Human-readable spread string for the trade-details panel, e.g. "+1c29050 -1c29070" (signed by side).
  // LOWER STRIKE FIRST, always. The legs arrive in construction order, which differs by side and by
  // geometry — a bull spread builds long-then-short, a bear the other way — so the same structure read
  // "+1c29150 -1c29190" in one row and "-1p29190 +1p29230" in the next, and the eye had to re-derive
  // which leg was which every time. Sorting is display-only: this returns a string, and every consumer
  // that cares about leg ORDER uses the arrays directly.
  function fmtSpread(spreadLegs, qty) {
    return (spreadLegs || []).slice()
      .sort((a, b) => (a.strike || 0) - (b.strike || 0))
      .map(l => `${l.side === 'long' ? '+' : '-'}${qty}${String(l.type).toLowerCase()}${l.strike}`).join(' ');
  }


  // Fallback for runs recorded before openEpoch existed: an open's wall-clock (openedAt) floored to the
  // 5m grid equals the candle mark (the engine fires a few seconds after each 5m boundary), so it lands
  // on the correct NQ chart candle. Opens only — old positions carry no cover timestamp to salvage.
  const FIVE_MIN = 5 * 60 * 1000;
  function epochFrom5m(iso) {
    if (!iso) return null;
    const t = Date.parse(iso);
    return Number.isFinite(t) ? Math.floor(t / FIVE_MIN) * FIVE_MIN : null;
  }

  // Format an ISO timestamp as the "MM/DD HH:MM" ET candle string the run's own openTime/coverTime use, so
  // an unfilled cover's order-log time (raw UTC ISO) lines up with the filled rows in the trades table.
  function etCandleTime(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
    const g = (t) => (parts.find((p) => p.type === t) || {}).value || '';
    return `${g('month')}/${g('day')} ${g('hour')}:${g('minute')}`;
  }

  // pos.legs / pos.coverLegs entries are { side:'long'|'short', type:'C'|'P', strike }. Emit optionArray
  // legs { qty (signed × quantity), type ('c'|'p'), strike, cost (dollars, net on the long leg) }.
  function spreadToLegs(spreadLegs, netLimit, qty) {
    const netCost = Math.round((netLimit || 0) * 100 * qty);   // net debit in dollars (× 100)
    // THE NET COST BELONGS TO THE STRUCTURE, NOT TO EACH LONG LEG. It used to be attached to EVERY long
    // leg, which is right for a vertical (exactly one long) and double-counts anything with two: a fly or
    // condor booked its whole debit twice. On 2026-09-17 that overstated v6-20's cost by $732 — exactly
    // one fly's debit — and flies are live on 25 variants, so every one of them read too expensive.
    // Carried on the FIRST long leg so the per-leg rows still show where the money went.
    let assigned = false;
    return spreadLegs.map((l) => {
      const isLong = l.side === 'long';
      const cost = (isLong && !assigned) ? (assigned = true, netCost) : 0;
      return { qty: (isLong ? 1 : -1) * qty, type: String(l.type).toLowerCase(), strike: l.strike, cost };
    });
  }

  // run: the record from /api/v1/candle-spread/runs/:symbol/:expiration. opts.includeUnfilled (default
  // false) keeps never-filled opens out. Returns { optionArrayString, legs, positions, count, source }.
  // RECOVER A TIME FROM THE POSITION ID. Every id is `${prefix}-${Date.now()}-${seq}` (trader.nextId), so
  // a position written without openTime/openEpoch still carries its creation instant. Hedge positions
  // (floorOffset `off-*`, wing conversion `wing-*`) were created without those fields until 2026-09-08, so
  // every record before that sorts them to the top of the day with a blank timestamp — they look like the
  // first trades placed when they were bought mid-session. Stamping new positions fixes it going forward;
  // this recovers the ones already written. Verified against a position that HAS both: pos-1788875112380
  // derives to 09:45 ET, matching its recorded openTime exactly.
  function epochFromId(id) {
    const m = /^[a-z]+-(\d{13})-/.exec(String(id || ''));
    return m ? +m[1] : null;
  }
  function etCandleFromEpoch(ms) {
    if (!ms) return null;
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York',
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
      .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    const h = p.hour === '24' ? '00' : p.hour;
    // Floor to the 5m grid so it lines up with the candle times every other row shows.
    const mins = Math.floor(parseInt(p.minute, 10) / 5) * 5;
    return `${p.month}/${p.day} ${h}:${String(mins).padStart(2, '0')}`;
  }

  function strategyRunToOptionArray(run, opts) {
    const o = opts || {};
    // TIME SLICE (opts.asOfEpoch): reconstruct the book AS OF a 5m-mark epoch — include a position's OPEN
    // only if it was opened by then, and its COVER only if it booked by then (else it's still open at that
    // time). Used by the compare page's time-of-day slider. Unset → the full end-of-day book (unchanged).
    const asOf = o.asOfEpoch;
    const state = (run && run.state) || {};
    const cfg = (run && run.config) || {};
    const src = (run && run.variant) || cfg.variant || 'strategy';
    const allLegs = [];
    // Parallel to allLegs: the epoch each leg came into existence. Built HERE, beside the legs themselves,
    // because this is the only place that knows which of a position's legs are the OPEN and which are the
    // COVER — downstream all it sees is one flat array. Feeds the calculator's time-based playback slider.
    const allLegEpochs = [];
    const positions = [];
    // ORDERING CONVENTION: the optionArray (and the risk-curve playback slider) expects MOST RECENT
    // positions FIRST, oldest LAST — the order the Fidelity CSV already arrives in. The server's
    // state.positions is the opposite (chronological: opens are pushed as they fill → OLDEST first), so
    // reverse it here. Any future position source we parse must emit newest-first to preserve this.
    const ordered = [...(state.positions || [])].reverse();
    // EXACT cover orders from the order log (order_simulated in dry-run / order_sent live), keyed by the
    // position they cover (meta.of) — so a credit cover uses its REAL sent legs + credit price, not a guess.
    const coverByPos = new Map();
    for (const e of (run && run.events) || []) {
      if ((e.type === 'order_simulated' || e.type === 'order_sent') && e.meta && e.meta.of && e.meta.legs && /cover/.test(e.meta.kind || ''))
        coverByPos.set(e.meta.of, { legs: e.meta.legs, net: e.meta.net, limit: e.meta.limit, time: e.time });
    }
    for (const pos of ordered) {
      if (!pos || !pos.legs || !pos.legs.length) continue;
      if (!pos.filled && !o.includeUnfilled) continue;
      const oEpoch = pos.openEpoch || epochFrom5m(pos.openedAt) || epochFromId(pos.id);
      if (asOf != null && oEpoch != null && oEpoch > asOf) continue;   // not opened yet at asOf
      const coverByT = asOf == null || (pos.coverEpoch != null && pos.coverEpoch <= asOf);   // has it booked by asOf?
      const qty = pos.quantity || cfg.quantity || 1;
      // Emit each spread AS ACTUALLY SENT: a CREDIT order → its real credit-twin legs + a NEGATIVE cost
      // (cash received); a DEBIT → the debit legs + positive cost. So the optionArray total NETS the
      // recapture credits instead of summing gross debit-canonical costs (which overstates capital used).
      const oCredit = pos.sentNet === 'CREDIT' && pos.sentLegs && pos.sentLegs.length;
      const oLegs = oCredit ? pos.sentLegs : pos.legs;
      const oAmt = oCredit ? (pos.sentLimit || 0) : (pos.limit || 0);
      const legs = spreadToLegs(oLegs, oCredit ? -oAmt : oAmt, qty);
      const openLegCount = legs.length;         // everything after this index is cover
      let cLegs = null, cAmt = 0, cCredit = false, cEpoch = null;
      if (pos.covered && coverByT && pos.coverLegs && pos.coverLegs.length) {
        const ord = coverByPos.get(pos.id);   // kept for the TRADES TABLE (what was actually sent)
        // VALUED FROM THE POSITION, NOT THE LOG. The log is not a reliable description of what was
        // BOOKED: on 2026-09-17, 2 of 91 covers had log legs at different strikes than the cover actually
        // recorded (wing shifts and re-sends; the index keeps only the last matching event), so valuing
        // from it prices a cover that was never held. Worse, pairing the log's CREDIT twin legs with
        // pos.coverLimit — the DEBIT fill — and negating it is what put this page at -$975 on v7-10 at
        // 29447 where the engine said $2,840 for the same book.
        //
        // pos.coverLegs/coverLimit are what the engine wrote when the cover filled, and they are exact
        // rather than approximate: a credit twin at the same strikes satisfies
        // payoff(twin) + credit == payoff(debit pair) - debit whenever credit == W - debit, so the pair
        // values identically either way. Deriving the credit from the log's asking price instead moves
        // fleet P&L by thousands, always flatteringly — which is how this page briefly showed nearly
        // every variant profitable.
        cLegs = pos.coverLegs;
        cAmt = pos.coverLimit != null ? pos.coverLimit : 0;
        cCredit = false;                       // debit-canonical: positive cost, canonical legs
        // When the cover booked. coverEpoch is authoritative; older runs lack it, so fall back to the
        // cover ORDER's own time from the log, and only then to the open (never earlier than the open).
        cEpoch = pos.coverEpoch || (ord && epochFrom5m(ord.time)) || oEpoch;
        legs.push(...spreadToLegs(cLegs, cCredit ? -cAmt : cAmt, qty));
      }
      // UNFILLED cover: a resting cover order was placed for this position but never booked (its mark never
      // reached target), so it isn't a leg in the P&L — surface it (order-log legs/price/net + ET time) so the
      // trades table can show EVERY order sent, dimmed, and reconcile 1:1 against the broker's order list.
      let unfilledCover = null;
      if (!pos.covered) {
        const uc = coverByPos.get(pos.id);
        if (uc && uc.legs && uc.legs.length)
          unfilledCover = { legs: fmtSpread(uc.legs, qty), net: uc.net === 'CREDIT' ? 'CREDIT' : 'DEBIT', limit: uc.limit || 0, time: etCandleTime(uc.time), epoch: epochFrom5m(uc.time) };
      }
      allLegs.push(...legs);
      for (let i = 0; i < legs.length; i++) allLegEpochs.push(i < openLegCount ? oEpoch : cEpoch);
      positions.push({
        id: pos.id, side: pos.side, covered: !!(pos.covered && coverByT), shortStrike: pos.shortStrike, unfilledCover,
        openTime: pos.openTime || etCandleFromEpoch(epochFromId(pos.id)), coverTime: pos.coverTime || null,   // human CANDLE times (log/tooltip)
        // 5m-mark epoch ms → exact NQ-chart bar. openEpoch falls back to openedAt-floored for pre-epoch
        // runs (opens only; old covers have no timestamp to recover).
        openEpoch: oEpoch, coverEpoch: pos.coverEpoch || null,   // oEpoch already carries the id-derived fallback
        openLimit: oAmt, coverLimit: pos.covered ? cAmt : null, legs,           // ACTUAL sent amounts (magnitude)
        // Per-side leg strings (AS SENT) + qty for the trade-details validation panel.
        quantity: qty, openLegs: fmtSpread(oLegs, qty),
        coverLegs: cLegs ? fmtSpread(cLegs, qty) : null,
        openNet: oCredit ? 'CREDIT' : 'DEBIT', coverNet: cCredit ? 'CREDIT' : 'DEBIT',
      });
    }
    return {
      optionArrayString: allLegs.map(fmtLeg).join(','),
      legs: allLegs, legEpochs: allLegEpochs, positions, count: positions.length, source: src,
      tradeDate: run && run.tradeDate, symbol: (run && run.symbol) || cfg.symbol,
    };
  }

  const api = { strategyRunToOptionArray, spreadToLegs, fmtLeg, fmtSpread };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof root !== 'undefined') root.strategyRunToOptionArray = strategyRunToOptionArray;
  // EXPORTED so the debug page can render leg arrays that never became positions — a refused open,
  // offset, wing or fly exists only as a decision, so it has no position for this module to format, but
  // its legs must still read identically to every other row. Reusing the producer is the point: a
  // lookalike formatter in the page would drift from this one the first time either changed.
  if (typeof root !== 'undefined') root.fmtSpreadLegs = fmtSpread;
})(typeof window !== 'undefined' ? window : this);
