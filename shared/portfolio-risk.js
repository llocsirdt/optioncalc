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

  // Weight given to "upside beyond the locked floor" vs. the locked floor
  // itself in rankCandidateScore below. 0.5 treats guaranteed and uncertain
  // profit as equally valuable — revisit this once there's a feel for how it
  // ranks real candidates in practice (e.g. weighting locked-in profit more
  // heavily, since it's guaranteed vs. merely possible).
  const UPSIDE_WEIGHT = 0.5;

  function findShortStrike(legs) {
    const shortLeg = (legs || []).find(leg => leg.qty < 0);
    return shortLeg ? shortLeg.strike : null;
  }

  // The upside beyond the locked floor is only realized if the underlying
  // closes between the existing position's strikes and the candidate's short
  // strike — the wider that gap, the more of the underlying's possible
  // closing prices actually land there rather than inside a linear transition
  // zone (where you get some blend of locked and upside instead), so a bigger
  // gap means that upside is more likely to actually be realized rather than
  // just theoretically reachable. A gap of zero (the candidate's short strike
  // exactly coincides with an existing strike) means the true peak is a
  // single knife-edge price, not a zone. Normalized against the combined
  // width of the position and the candidate so a gap on that same order
  // counts as "wide".
  function gapRealizationFactor(strikeGapWidth, combinedWidth) {
    if (!combinedWidth) return 0;
    return Math.max(0, Math.min(1, strikeGapWidth / combinedWidth));
  }

  // Ranks a candidate by how much of the combined position's theoretical max
  // value is locked in, plus a weighted share of whatever additional upside
  // exists beyond that floor, discounted by how likely that upside actually is
  // to be realized (see gapRealizationFactor). Deliberately NOT
  // lockedInProfit/profitPotential (that ratio rewards a small potential just
  // for being easy to be 100% of) and NOT a raw sum of the two (potential
  // already contains locked as its floor, so summing double-counts it) —
  // subtracting locked out of the upside term avoids that. Shared between
  // shared/spread-hedge-strategy.js (single 2-leg spread) and
  // findPortfolioHedgeCandidates below (arbitrary N-leg aggregate) so a
  // candidate that shows up in both places scores and sorts the same way.
  function rankCandidateScore(lockedInProfit, profitPotential, combinedMaxValue, strikeGapWidth, combinedWidth) {
    if (!combinedMaxValue) return 0;
    const lockedFraction = lockedInProfit / combinedMaxValue;
    const upsideFraction = (profitPotential - lockedInProfit) / combinedMaxValue;
    const gapFactor = gapRealizationFactor(strikeGapWidth, combinedWidth);
    return lockedFraction + upsideFraction * UPSIDE_WEIGHT * gapFactor;
  }

  // Width of one locked-profit tier, as a fraction of combinedMaxValue (so it
  // scales with the trade's own size rather than a fixed dollar amount). A
  // plain rankScore sort lets a candidate with a small locked loss but huge
  // upside/gap outrank one with a genuine locked profit but little upside —
  // tested against real chain data and found to have no real "middle ground"
  // to reweight toward (see git history: every LOCKED_WEIGHT tried either
  // left loss-locked candidates on top or buried every real-upside candidate
  // under a single trivial near-zero-upside box). Bucketing by locked-profit
  // tier first — sub-ordering within a tier by the existing rankScore — fixes
  // that structurally: candidates within ~5% of each other's locked-in floor
  // are treated as roughly equal and ranked by upside/gap, but a tier with a
  // meaningfully better floor always wins outright.
  const LOCKED_TIER_WIDTH = 0.05;

  function lockedTier(lockedFraction) {
    return Math.floor(lockedFraction / LOCKED_TIER_WIDTH);
  }

  // Sorts by locked-profit tier first (best floor wins outright), then by
  // rankScore (upside × gap) within a tier. Candidates must carry a
  // lockedFraction field (see evaluateCandidate / tryCandidate below).
  function compareCandidatesByTier(a, b) {
    const tierDiff = lockedTier(b.lockedFraction) - lockedTier(a.lockedFraction);
    if (tierDiff !== 0) return tierDiff;
    return b.rankScore - a.rankScore;
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
   * aggregate portfolio's risk curve, ranked by the same rankCandidateScore
   * used by shared/spread-hedge-strategy.js's curated single-spread search —
   * so a candidate surfaced here that's also shown in that panel scores (and
   * sorts) the same way in both places, instead of the old fully-locked/
   * highest-potential/balanced tiebreak order that had no relationship to it.
   */
  function findPortfolioHedgeCandidates(legs, chainData, options = {}) {
    const maxWidthStrikes = options.maxWidthStrikes ?? 6;
    const budget = options.budget ?? Infinity;
    // Beyond just improving on the baseline, a candidate whose worst case is
    // still a loss is only viable if that loss is small relative to what it's
    // risking for — a locked-in loss more than this fraction of the candidate's
    // own profit potential isn't a real hedge, it's a bet with bad odds.
    const maxLockedLossFraction = options.maxLockedLossFraction ?? 0.05;

    const baseline = analyzePortfolioRisk(legs, options);
    const baselineStrikes = legs.map(leg => leg.strike);
    const baselineWidth = Math.max(...baselineStrikes) - Math.min(...baselineStrikes);
    const candidates = [];

    function tryCandidate(strategy, lowerStrike, higherStrike, lowerMid, higherMid, optionTypeUpper) {
      const { legs: candidateLegs, cost } = buildSpreadLegs(strategy, lowerStrike, higherStrike, lowerMid, higherMid, optionTypeUpper);
      if (Math.abs(cost) > budget) return;

      const combinedLegs = legs.concat(candidateLegs);
      const result = analyzePortfolioRisk(combinedLegs, options);

      const improvementOverBaseline = (Number.isFinite(result.lockedInProfit) && Number.isFinite(baseline.lockedInProfit))
        ? result.lockedInProfit - baseline.lockedInProfit
        : (Number.isFinite(result.lockedInProfit) ? Infinity : -Infinity);

      const spreadWidth = higherStrike - lowerStrike;
      const combinedWidth = baselineWidth + spreadWidth;
      const combinedMaxValue = combinedWidth * 100;
      const candidateShortStrike = findShortStrike(candidateLegs);
      const strikeGapWidth = Math.min(...baselineStrikes.map(strike => Math.abs(strike - candidateShortStrike)));

      candidates.push({
        strategy,
        label: strategy.replace(/_/g, ' '),
        legs: candidateLegs,
        cost,
        spreadWidth,
        lockedInProfit: result.lockedInProfit,
        profitPotential: result.profitPotential,
        profitPotentialScore: result.profitPotentialScore,
        strikeGapWidth,
        lockedFraction: combinedMaxValue ? result.lockedInProfit / combinedMaxValue : 0,
        rankScore: rankCandidateScore(result.lockedInProfit, result.profitPotential, combinedMaxValue, strikeGapWidth, combinedWidth),
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

    const viableCandidates = candidates.filter(candidate => {
      if (candidate.improvementOverBaseline <= 0) return false;
      if (candidate.lockedInProfit >= 0) return true;
      // A locked-in loss with no positive potential to justify it is never viable.
      if (candidate.profitPotential <= 0) return false;
      return Math.abs(candidate.lockedInProfit) <= maxLockedLossFraction * candidate.profitPotential;
    });
    const sortedCandidates = viableCandidates.sort(compareCandidatesByTier);

    return { baseline, candidates: sortedCandidates };
  }

  // Worst P&L across a price sub-range — used to score each wing candidate by
  // its effect across its WHOLE half of the curve, not just at one far-out
  // point. Scoring against a single point was tried first and found to pick
  // narrow, cheap wings sitting too close to the edge: they'd raise that one
  // point but leave a gap between the wing's own reach and where the
  // baseline's own recovery begins, and that gap — now carrying the wing's
  // added cost with none of its benefit — became a NEW, worse low point (see
  // git history for the real numbers). Scoring across the whole half-range
  // catches that gap instead of missing it.
  function localWorstPnl(legs, loBound, hiBound, priceStep) {
    const normalizedLegs = legs.map(normalizeLeg);
    const totalCost = normalizedLegs.reduce((sum, leg) => sum + (leg.cost || 0), 0);
    const curve = calculatePortfolioValueAtExpiration(normalizedLegs, loBound, hiBound, priceStep);
    let worst = Infinity;
    curve.forEach(point => {
      const pnl = point.totalIntrinsicValue - totalCost;
      if (pnl < worst) worst = pnl;
    });
    return worst;
  }

  /**
   * Finds a call spread (above the money) + put spread (below the money)
   * added TOGETHER that lift a "double-tailed" position — one where both the
   * far-low and far-high price extremes are already underwater, so no single
   * 2-leg spread can fix both sides at once (findPortfolioHedgeCandidates only
   * ever adds one spread at a time). Not run at all unless both tails are
   * actually bad — a one-sided loss is already covered by the single-spread
   * search above, and this combinatorial search costs more to run.
   *
   * Search strategy: score call spreads and put spreads independently by how
   * much each improves the worst point across ITS OWN half of the curve (see
   * localWorstPnl), keep the best few from each side, then verify each
   * call+put PAIR together against the real combined curve via
   * analyzePortfolioRisk (only ~topPerSide^2 of those, so still cheap) and
   * keep only the pairs that actually improve the worst case.
   */
  function findTailRiskHedgeCandidates(legs, chainData, options = {}) {
    const maxWidthStrikes = options.maxWidthStrikes ?? 6;
    const budget = options.budget ?? Infinity;
    const maxLockedLossFraction = options.maxLockedLossFraction ?? 0.05;
    const topPerSide = options.topPerSide ?? 5;

    const baseline = analyzePortfolioRisk(legs, options);
    if (baseline.unboundedUpsideRisk || baseline.unboundedDownsideRisk) {
      // A bounded 2-leg-per-side hedge can't fix genuinely unbounded naked
      // exposure — that's a different problem than "both tails are underwater".
      return { baseline, candidates: [] };
    }

    const baselineStrikes = legs.map(leg => leg.strike);
    const minStrike = Math.min(...baselineStrikes);
    const maxStrike = Math.max(...baselineStrikes);
    const baselineWidth = maxStrike - minStrike;
    const padding = options.padding ?? Math.max(50, baselineWidth * 0.25);
    const priceStep = options.priceStep ?? Math.max(1, baselineWidth / 200 || 1);
    const lowExtreme = Math.max(0.01, minStrike - padding);
    const highExtreme = maxStrike + padding;
    // Split the curve into "left of the position" / "right of the position"
    // halves at the position's own midpoint — each wing only needs to fix its
    // own half; the other half is the other wing's job.
    const midpoint = (minStrike + maxStrike) / 2;

    const baselineRightWorst = localWorstPnl(legs, midpoint, highExtreme, priceStep);
    const baselineLeftWorst = localWorstPnl(legs, lowExtreme, midpoint, priceStep);
    if (baselineLeftWorst >= 0 || baselineRightWorst >= 0) {
      // Only one side (or neither) is actually underwater — the single-spread
      // search already covers that case.
      return { baseline, candidates: [] };
    }

    const callWingCandidates = [];
    if (chainData.call) {
      const callStrikes = collectSortedStrikes(chainData.call);
      for (let i = 0; i < callStrikes.length; i++) {
        for (let j = i + 1; j < callStrikes.length && j - i <= maxWidthStrikes; j++) {
          const lower = callStrikes[i];
          const higher = callStrikes[j];
          const lowerData = getStrikeMarketData(lower, chainData.call);
          const higherData = getStrikeMarketData(higher, chainData.call);
          if (!lowerData || !higherData) continue;
          const { legs: wingLegs, cost } = buildSpreadLegs('bull_call_spread', lower, higher, lowerData.mid, higherData.mid, 'C');
          if (Math.abs(cost) > budget) continue;
          const improvement = localWorstPnl(legs.concat(wingLegs), midpoint, highExtreme, priceStep) - baselineRightWorst;
          if (improvement > 0) {
            callWingCandidates.push({ legs: wingLegs, cost, spreadWidth: higher - lower, improvement });
          }
        }
      }
    }
    callWingCandidates.sort((a, b) => b.improvement - a.improvement);

    const putWingCandidates = [];
    if (chainData.put) {
      const putStrikes = collectSortedStrikes(chainData.put);
      for (let i = 0; i < putStrikes.length; i++) {
        for (let j = i + 1; j < putStrikes.length && j - i <= maxWidthStrikes; j++) {
          const lower = putStrikes[i];
          const higher = putStrikes[j];
          const lowerData = getStrikeMarketData(lower, chainData.put);
          const higherData = getStrikeMarketData(higher, chainData.put);
          if (!lowerData || !higherData) continue;
          const { legs: wingLegs, cost } = buildSpreadLegs('bear_put_spread', lower, higher, lowerData.mid, higherData.mid, 'P');
          if (Math.abs(cost) > budget) continue;
          const improvement = localWorstPnl(legs.concat(wingLegs), lowExtreme, midpoint, priceStep) - baselineLeftWorst;
          if (improvement > 0) {
            putWingCandidates.push({ legs: wingLegs, cost, spreadWidth: higher - lower, improvement });
          }
        }
      }
    }
    putWingCandidates.sort((a, b) => b.improvement - a.improvement);

    const candidates = [];
    callWingCandidates.slice(0, topPerSide).forEach(callWing => {
      putWingCandidates.slice(0, topPerSide).forEach(putWing => {
        const wingLegs = callWing.legs.concat(putWing.legs);
        const result = analyzePortfolioRisk(legs.concat(wingLegs), options);
        const improvementOverBaseline = (Number.isFinite(result.lockedInProfit) && Number.isFinite(baseline.lockedInProfit))
          ? result.lockedInProfit - baseline.lockedInProfit
          : (Number.isFinite(result.lockedInProfit) ? Infinity : -Infinity);
        if (improvementOverBaseline <= 0) return;
        if (result.lockedInProfit < 0) {
          if (result.profitPotential <= 0) return;
          if (Math.abs(result.lockedInProfit) > maxLockedLossFraction * result.profitPotential) return;
        }

        const cost = callWing.cost + putWing.cost;
        const spreadWidth = callWing.spreadWidth + putWing.spreadWidth;
        const combinedWidth = baselineWidth + spreadWidth;
        const combinedMaxValue = combinedWidth * 100;
        // A dual-wing hedge has two short strikes (one on each side) rather
        // than one — use whichever wing sits closer to an existing position
        // strike as the (more conservative) stand-in for "how much room is
        // there to land safely", same interpretation as the single-spread gap.
        const callShortStrike = findShortStrike(callWing.legs);
        const putShortStrike = findShortStrike(putWing.legs);
        const callGap = Math.min(...baselineStrikes.map(strike => Math.abs(strike - callShortStrike)));
        const putGap = Math.min(...baselineStrikes.map(strike => Math.abs(strike - putShortStrike)));
        const strikeGapWidth = Math.min(callGap, putGap);

        candidates.push({
          strategy: 'tail_risk_condor',
          label: 'Tail-risk condor hedge',
          family: 'tail-risk',
          legs: wingLegs,
          cost,
          spreadWidth,
          lockedInProfit: result.lockedInProfit,
          profitPotential: result.profitPotential,
          profitPotentialScore: result.profitPotentialScore,
          strikeGapWidth,
          lockedFraction: combinedMaxValue ? result.lockedInProfit / combinedMaxValue : 0,
          rankScore: rankCandidateScore(result.lockedInProfit, result.profitPotential, combinedMaxValue, strikeGapWidth, combinedWidth),
          improvementOverBaseline
        });
      });
    });

    return { baseline, candidates: candidates.sort(compareCandidatesByTier) };
  }

  const PortfolioRisk = {
    calculatePortfolioValueAtExpiration,
    analyzePortfolioRisk,
    findPortfolioHedgeCandidates,
    findTailRiskHedgeCandidates,
    findShortStrike,
    gapRealizationFactor,
    rankCandidateScore,
    compareCandidatesByTier
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
