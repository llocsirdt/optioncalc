/**
 * Shared Portfolio Risk Functions
 *
 * Computes the combined P&L payoff curve for an arbitrary set of option legs —
 * unlike shared/offset-calculations.js's pairwise bull/bear spread math (which
 * only reasons about ONE position plus ONE candidate offset), this works for
 * any number of legs, which is what's needed once many positions have been
 * opened (e.g. imported from a brokerage CSV) and we want to see the combined
 * risk curve and find trades that clean up whatever risk remains.
 * Works in both Node.js and browser environments.
 */

(function(global) {
  'use strict';

  /**
   * Calculate the intrinsic value of an options portfolio at expiration across a range of prices.
   * (Moved from client/lib/chart.js so server-side code can share the identical math.)
   * @param {Array<Object>} optionsPositions - Array of option positions with qty, type, and strike.
   * @param {number} minPrice - The minimum underlying price to calculate.
   * @param {number} maxPrice - The maximum underlying price to calculate.
   * @param {number} priceStep - The increment for each price point in the range.
   * @returns {Array<object>} An array of objects, each with 'closingPrice' and 'totalIntrinsicValue'.
   */
  function calculatePortfolioValueAtExpiration(optionsPositions, minPrice, maxPrice, priceStep) {
    if (!Array.isArray(optionsPositions) || optionsPositions.length === 0) {
      throw new Error("optionsPositions must be a non-empty array of option configurations.");
    }

    const valueCurve = [];

    if (minPrice >= maxPrice) {
      throw new Error("minPrice must be less than maxPrice");
    }

    if (priceStep <= 0) {
      throw new Error("priceStep must be greater than 0");
    }

    for (let closingPrice = minPrice; closingPrice <= maxPrice; closingPrice += priceStep) {
      let portfolioTotalIntrinsicValue = 0;

      for (const position of optionsPositions) {
        const { qty, type, strike } = position;

        if (type === 'c') {
          const callIntrinsicValue = Math.max(0, closingPrice - strike);
          portfolioTotalIntrinsicValue += callIntrinsicValue * qty * 100;
        } else if (type === 'p') {
          const putIntrinsicValue = Math.max(0, strike - closingPrice);
          portfolioTotalIntrinsicValue += putIntrinsicValue * qty * 100;
        }
      }

      valueCurve.push({
        closingPrice: parseFloat(closingPrice.toFixed(2)),
        totalIntrinsicValue: parseFloat(portfolioTotalIntrinsicValue.toFixed(2))
      });
    }

    return valueCurve;
  }

  // calculatePortfolioValueAtExpiration only recognizes lowercase 'c'/'p' (matching
  // the client's optionArray convention) — but legs pulled from persisted positions
  // use uppercase 'C'/'P'. Normalize here rather than touching the function above,
  // which stays byte-identical to its original chart.js behavior.
  function normalizeLeg(leg) {
    return { ...leg, type: (leg.type || '').toLowerCase() };
  }

  /**
   * Analyze the aggregate risk curve for a set of option legs: the worst-case
   * (lockedInProfit) and best-case (profitPotential) P&L across the sampled
   * price range, plus whether either tail is unbounded (naked short exposure).
   */
  function analyzePortfolioRisk(legs, options = {}) {
    if (!Array.isArray(legs) || legs.length === 0) {
      throw new Error('legs must be a non-empty array');
    }

    const normalizedLegs = legs.map(normalizeLeg);
    const strikes = normalizedLegs.map(leg => leg.strike);
    const minStrike = Math.min(...strikes);
    const maxStrike = Math.max(...strikes);
    const strikeRange = maxStrike - minStrike;
    const padding = options.padding ?? Math.max(50, strikeRange * 0.25);
    const priceStep = options.priceStep ?? Math.max(1, strikeRange / 200 || 1);

    const minPrice = Math.max(0.01, minStrike - padding);
    const maxPrice = maxStrike + padding;

    const totalCostBasis = normalizedLegs.reduce((sum, leg) => sum + (leg.cost || 0), 0);
    const valueCurve = calculatePortfolioValueAtExpiration(normalizedLegs, minPrice, maxPrice, priceStep);

    let lockedInProfit = Infinity;
    let worstCasePrice = null;
    let profitPotential = -Infinity;
    let bestCasePrice = null;

    valueCurve.forEach(point => {
      const pnl = point.totalIntrinsicValue - totalCostBasis;
      if (pnl < lockedInProfit) {
        lockedInProfit = pnl;
        worstCasePrice = point.closingPrice;
      }
      if (pnl > profitPotential) {
        profitPotential = pnl;
        bestCasePrice = point.closingPrice;
      }
    });

    // Beyond the sampled window the payoff is exactly linear (no more strikes left
    // to bend the curve) — check the net tail exposure directly rather than trusting
    // the finite sample window, so a naked leg shows up as unbounded risk instead of
    // silently looking safe just because we didn't sample far enough.
    const netCallQty = normalizedLegs.filter(leg => leg.type === 'c').reduce((sum, leg) => sum + leg.qty, 0);
    const netPutQty = normalizedLegs.filter(leg => leg.type === 'p').reduce((sum, leg) => sum + leg.qty, 0);
    const unboundedUpsideRisk = netCallQty < 0; // naked short calls: loss grows as price rises without limit
    const unboundedDownsideRisk = netPutQty < 0; // naked short puts: loss grows as price falls toward zero

    if (unboundedUpsideRisk || unboundedDownsideRisk) {
      lockedInProfit = -Infinity;
    }

    const profitPotentialScore = (Number.isFinite(lockedInProfit) && Number.isFinite(profitPotential) && profitPotential !== 0)
      ? lockedInProfit / profitPotential
      : (unboundedUpsideRisk || unboundedDownsideRisk ? -Infinity : 0);

    return {
      lockedInProfit,
      profitPotential,
      profitPotentialScore,
      worstCasePrice,
      bestCasePrice,
      unboundedUpsideRisk,
      unboundedDownsideRisk,
      totalCostBasis
    };
  }

  function getStrikeMarketData(strike, expirationStrikes) {
    const key = strike.toString() + '.0';
    for (const strikes of Object.values(expirationStrikes)) {
      if (strikes[key] && strikes[key][0]) {
        const marketData = strikes[key][0];
        const bid = marketData.bid || 0;
        const ask = marketData.ask || 0;
        if (bid > 0 && ask > 0) {
          return { mid: (bid + ask) / 2 };
        }
      }
    }
    return null;
  }

  function collectSortedStrikes(optionsChainSide) {
    const strikeSet = new Set();
    Object.values(optionsChainSide || {}).forEach(strikes => {
      Object.keys(strikes).forEach(strikeKey => strikeSet.add(parseFloat(strikeKey)));
    });
    return Array.from(strikeSet).sort((a, b) => a - b);
  }

  // Leg/cost-sign conventions here match the (verified) create*SpreadObject
  // helpers in offset-calculations.js: positive cost = debit paid, negative = credit received.
  function buildSpreadLegs(strategy, lowerStrike, higherStrike, lowerMid, higherMid, optionTypeUpper) {
    if (strategy === 'bull_call_spread') {
      // Long lower call (debit) + short higher call (credit received) — net debit
      const spreadCost = (lowerMid - higherMid) * 100;
      return {
        legs: [
          { qty: 1, type: optionTypeUpper, strike: lowerStrike, cost: lowerMid * 100 },
          { qty: -1, type: optionTypeUpper, strike: higherStrike, cost: -higherMid * 100 }
        ],
        cost: spreadCost
      };
    }
    if (strategy === 'bear_call_spread') {
      // Short lower call (credit received) + long higher call (debit) — net credit
      const spreadCredit = (lowerMid - higherMid) * 100;
      return {
        legs: [
          { qty: -1, type: optionTypeUpper, strike: lowerStrike, cost: -lowerMid * 100 },
          { qty: 1, type: optionTypeUpper, strike: higherStrike, cost: higherMid * 100 }
        ],
        cost: -spreadCredit
      };
    }
    if (strategy === 'bull_put_spread') {
      // Short higher put (credit received) + long lower put (debit) — net credit
      const spreadCredit = (higherMid - lowerMid) * 100;
      return {
        legs: [
          { qty: -1, type: optionTypeUpper, strike: higherStrike, cost: -higherMid * 100 },
          { qty: 1, type: optionTypeUpper, strike: lowerStrike, cost: lowerMid * 100 }
        ],
        cost: -spreadCredit
      };
    }
    if (strategy === 'bear_put_spread') {
      // Long higher put (debit) + short lower put (credit received) — net debit
      const spreadCost = (higherMid - lowerMid) * 100;
      return {
        legs: [
          { qty: 1, type: optionTypeUpper, strike: higherStrike, cost: higherMid * 100 },
          { qty: -1, type: optionTypeUpper, strike: lowerStrike, cost: -lowerMid * 100 }
        ],
        cost: spreadCost
      };
    }
    throw new Error(`Unknown spread strategy: ${strategy}`);
  }

  /**
   * Search the live option chain for 2-leg spread candidates that improve the
   * aggregate portfolio's risk curve, ranked with OffsetCalculations.sortOffsettingPositions
   * (same priority order the single-position engine already uses: fully-locked first,
   * then highest profit potential, then balanced).
   */
  function findPortfolioHedgeCandidates(legs, chainData, options = {}) {
    const maxWidthStrikes = options.maxWidthStrikes ?? 6;
    const budget = options.budget ?? Infinity;
    const OffsetCalculations = (typeof require === 'function' && typeof module !== 'undefined')
      ? require('./offset-calculations')
      : global.OffsetCalculations;

    const baseline = analyzePortfolioRisk(legs, options);
    const candidates = [];

    function tryCandidate(strategy, lowerStrike, higherStrike, lowerMid, higherMid, optionTypeUpper) {
      const { legs: candidateLegs, cost } = buildSpreadLegs(strategy, lowerStrike, higherStrike, lowerMid, higherMid, optionTypeUpper);
      if (Math.abs(cost) > budget) return;

      const combinedLegs = legs.concat(candidateLegs);
      const result = analyzePortfolioRisk(combinedLegs, options);

      const improvementOverBaseline = (Number.isFinite(result.lockedInProfit) && Number.isFinite(baseline.lockedInProfit))
        ? result.lockedInProfit - baseline.lockedInProfit
        : (Number.isFinite(result.lockedInProfit) ? Infinity : -Infinity);

      candidates.push({
        strategy,
        legs: candidateLegs,
        cost,
        spreadWidth: higherStrike - lowerStrike,
        lockedInProfit: result.lockedInProfit,
        profitPotential: result.profitPotential,
        profitPotentialScore: result.profitPotentialScore,
        improvementOverBaseline
      });
    }

    if (chainData.call) {
      const callStrikes = collectSortedStrikes(chainData.call);
      for (let i = 0; i < callStrikes.length; i++) {
        for (let j = i + 1; j < callStrikes.length && j - i <= maxWidthStrikes; j++) {
          const lower = callStrikes[i];
          const higher = callStrikes[j];
          const lowerData = getStrikeMarketData(lower, chainData.call);
          const higherData = getStrikeMarketData(higher, chainData.call);
          if (!lowerData || !higherData) continue;
          tryCandidate('bull_call_spread', lower, higher, lowerData.mid, higherData.mid, 'C');
          tryCandidate('bear_call_spread', lower, higher, lowerData.mid, higherData.mid, 'C');
        }
      }
    }

    if (chainData.put) {
      const putStrikes = collectSortedStrikes(chainData.put);
      for (let i = 0; i < putStrikes.length; i++) {
        for (let j = i + 1; j < putStrikes.length && j - i <= maxWidthStrikes; j++) {
          const lower = putStrikes[i];
          const higher = putStrikes[j];
          const lowerData = getStrikeMarketData(lower, chainData.put);
          const higherData = getStrikeMarketData(higher, chainData.put);
          if (!lowerData || !higherData) continue;
          tryCandidate('bull_put_spread', lower, higher, lowerData.mid, higherData.mid, 'P');
          tryCandidate('bear_put_spread', lower, higher, lowerData.mid, higherData.mid, 'P');
        }
      }
    }

    const improvingCandidates = candidates.filter(candidate => candidate.improvementOverBaseline > 0);
    const sortedCandidates = OffsetCalculations.sortOffsettingPositions(improvingCandidates);

    return { baseline, candidates: sortedCandidates };
  }

  const PortfolioRisk = {
    calculatePortfolioValueAtExpiration,
    analyzePortfolioRisk,
    findPortfolioHedgeCandidates
  };

  // Node.js / CommonJS
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = PortfolioRisk;
  }

  // Browser / Global
  if (typeof window !== 'undefined') {
    window.PortfolioRisk = PortfolioRisk;
  }

  // Generic global
  if (typeof global !== 'undefined') {
    global.PortfolioRisk = PortfolioRisk;
  }

})(typeof window !== 'undefined' ? window : typeof global !== 'undefined' ? global : this);
