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
    const state = (run && run.state) || {};
    const cfg = (run && run.config) || {};
    const src = (run && run.variant) || cfg.variant || 'strategy';
    const allLegs = [];
    const positions = [];
    for (const pos of state.positions || []) {
      if (!pos || !pos.legs || !pos.legs.length) continue;
      if (!pos.filled && !o.includeUnfilled) continue;
      const qty = pos.quantity || cfg.quantity || 1;
      const legs = spreadToLegs(pos.legs, pos.limit, qty);
      if (pos.covered && pos.coverLegs && pos.coverLegs.length) {
        legs.push(...spreadToLegs(pos.coverLegs, pos.coverLimit, qty));
      }
      allLegs.push(...legs);
      positions.push({
        id: pos.id, side: pos.side, covered: !!pos.covered, shortStrike: pos.shortStrike,
        openTime: pos.openTime || null, coverTime: pos.coverTime || null,      // human CANDLE times (log/tooltip)
        openEpoch: pos.openEpoch || null, coverEpoch: pos.coverEpoch || null,   // 5m-mark epoch ms → exact NQ-chart bar
        openLimit: pos.limit, coverLimit: pos.covered ? pos.coverLimit : null, legs,
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
