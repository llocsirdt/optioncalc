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
  function fmtSpread(spreadLegs, qty) {
    return (spreadLegs || []).map(l => `${l.side === 'long' ? '+' : '-'}${qty}${String(l.type).toLowerCase()}${l.strike}`).join(' ');
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
    return spreadLegs.map((l) => ({
      qty: (l.side === 'long' ? 1 : -1) * qty,
      type: String(l.type).toLowerCase(),
      strike: l.strike,
      cost: l.side === 'long' ? netCost : 0,
    }));
  }

  // run: the record from /api/v1/candle-spread/runs/:symbol/:expiration. opts.includeUnfilled (default
  // false) keeps never-filled opens out. Returns { optionArrayString, legs, positions, count, source }.
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
      const oEpoch = pos.openEpoch || epochFrom5m(pos.openedAt);
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
      let cLegs = null, cAmt = 0, cCredit = false;
      if (pos.covered && coverByT && pos.coverLegs && pos.coverLegs.length) {
        const ord = coverByPos.get(pos.id);   // the EXACT cover order (legs + price + net) from the log
        if (ord && ord.legs) { cCredit = ord.net === 'CREDIT'; cLegs = ord.legs; cAmt = ord.limit || 0; }
        else { cLegs = pos.coverLegs; cAmt = pos.coverLimit || 0; }   // fallback: debit-canonical
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
      positions.push({
        id: pos.id, side: pos.side, covered: !!(pos.covered && coverByT), shortStrike: pos.shortStrike, unfilledCover,
        openTime: pos.openTime || null, coverTime: pos.coverTime || null,       // human CANDLE times (log/tooltip)
        // 5m-mark epoch ms → exact NQ-chart bar. openEpoch falls back to openedAt-floored for pre-epoch
        // runs (opens only; old covers have no timestamp to recover).
        openEpoch: pos.openEpoch || epochFrom5m(pos.openedAt), coverEpoch: pos.coverEpoch || null,
        openLimit: oAmt, coverLimit: pos.covered ? cAmt : null, legs,           // ACTUAL sent amounts (magnitude)
        // Per-side leg strings (AS SENT) + qty for the trade-details validation panel.
        quantity: qty, openLegs: fmtSpread(oLegs, qty),
        coverLegs: cLegs ? fmtSpread(cLegs, qty) : null,
        openNet: oCredit ? 'CREDIT' : 'DEBIT', coverNet: cCredit ? 'CREDIT' : 'DEBIT',
      });
    }
    return {
      optionArrayString: allLegs.map(fmtLeg).join(','),
      legs: allLegs, positions, count: positions.length, source: src,
      tradeDate: run && run.tradeDate, symbol: (run && run.symbol) || cfg.symbol,
    };
  }

  const api = { strategyRunToOptionArray, spreadToLegs, fmtLeg };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof root !== 'undefined') root.strategyRunToOptionArray = strategyRunToOptionArray;
})(typeof window !== 'undefined' ? window : this);
