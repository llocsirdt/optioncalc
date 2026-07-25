/**
 * Curated Hedge/Offset Strategy
 *
 * Generates a small, labeled set of candidate offsetting spreads for a single
 * existing 2-leg vertical spread position — deliberately NOT an exhaustive
 * search of every possible spread combination (see shared/offset-calculations.js
 * for that), but the specific handful of trades an actual trader considers.
 *
 * Works for any 2-leg debit or credit vertical spread: bull call, bear call,
 * bull put, bear put — by generalizing the position down to (long leg strike,
 * short leg strike, type, width, direction) and mirroring the same shift/width
 * formula across all four.
 *
 * Two families of candidates, both using the opposite instrument type from the
 * original position:
 *  - "shift" family: same width as the original, swept from an exact
 *    "box spread" offset (locks in a fixed value at every price) out through
 *    a "straddle" anchor (short leg touching the original's short leg) and
 *    beyond into a genuine gap, stopping once cost exceeds the risk cap.
 *  - "width" family: anchored at the straddle point, widening the offsetting
 *    spread itself (1.5x, 2x, 2.5x... the original width) instead of moving
 *    it further away.
 *
 * Plus a "same side" family: a credit spread using the SAME instrument type as
 * the original, positioned just past the original's short strike (in the zone
 * where the original position has already reached its max value), reclaiming
 * capital instead of spending more.
 *
 * All locked-in-profit / profit-potential / score numbers are computed via
 * PortfolioRisk.analyzePortfolioRisk (shared/portfolio-risk.js) — the already
 * validated general payoff-curve engine — rather than hand-coded per-scenario
 * formulas, so this can't fall prey to the same class of bugs found earlier in
 * offset-calculations.js's pairwise scenario math.
 *
 * Works in both Node.js and browser environments.
 */

(function(global) {
  'use strict';

  const PortfolioRisk = (typeof require === 'function' && typeof module !== 'undefined')
    ? require('./portfolio-risk')
    : global.PortfolioRisk;

  function oppositeType(type) {
    return type === 'c' ? 'p' : 'c';
  }

  /**
   * Extract the long/short legs, type, width, and direction from a 2-leg
   * vertical spread position. `direction` is +1 when the short leg strike is
   * above the long leg strike (bull call, bull put) and -1 when it's below
   * (bear call, bear put) — this single sign generalizes the shift/width
   * formula across all four spread types.
   */
  function identifySpread(position) {
    const legs = (position.legs || []).map(leg => ({ ...leg, type: (leg.type || '').toLowerCase() }));
    if (legs.length !== 2) {
      throw new Error('identifySpread expects a position with exactly 2 legs');
    }

    const longLeg = legs.find(leg => leg.qty > 0);
    const shortLeg = legs.find(leg => leg.qty < 0);
    if (!longLeg || !shortLeg) {
      throw new Error('Spread must have exactly one long leg (qty > 0) and one short leg (qty < 0)');
    }
    if (longLeg.type !== shortLeg.type) {
      throw new Error('Spread legs must be the same option type');
    }
    if (longLeg.strike === shortLeg.strike) {
      throw new Error('Spread legs must be at different strikes');
    }

    const positionType = longLeg.type;
    const positionLongStrike = longLeg.strike;
    const positionShortStrike = shortLeg.strike;
    const width = Math.abs(positionShortStrike - positionLongStrike);
    const direction = Math.sign(positionShortStrike - positionLongStrike);

    return { positionType, positionLongStrike, positionShortStrike, width, direction, legs };
  }

  function getStrikeMid(chainSide, strike) {
    const key = strike.toString() + '.0';
    for (const strikeMap of Object.values(chainSide || {})) {
      if (strikeMap[key] && strikeMap[key][0]) {
        const marketData = strikeMap[key][0];
        const bid = marketData.bid || 0;
        const ask = marketData.ask || 0;
        if (bid > 0 && ask > 0) return (bid + ask) / 2;
      }
    }
    return null;
  }

  // Smallest gap between listed strikes near a reference strike, on a given
  // side of the chain — increments vary by underlying/strike zone, so this is
  // read from the actual chain rather than assumed.
  function findLocalStrikeIncrement(chainSide, referenceStrike) {
    const strikeSet = new Set();
    Object.values(chainSide || {}).forEach(strikeMap => {
      Object.keys(strikeMap).forEach(k => strikeSet.add(parseFloat(k)));
    });
    const sorted = Array.from(strikeSet).sort((a, b) => a - b);
    if (sorted.length < 2) return null;

    let closestIndex = 0;
    let closestDist = Infinity;
    sorted.forEach((s, i) => {
      const dist = Math.abs(s - referenceStrike);
      if (dist < closestDist) {
        closestDist = dist;
        closestIndex = i;
      }
    });

    const gaps = [];
    for (let i = Math.max(0, closestIndex - 2); i < Math.min(sorted.length - 1, closestIndex + 2); i++) {
      gaps.push(sorted[i + 1] - sorted[i]);
    }
    return gaps.length ? Math.min(...gaps) : null;
  }

  function buildCandidateLegs(type, shortStrike, longStrike, chainSide) {
    const shortMid = getStrikeMid(chainSide, shortStrike);
    const longMid = getStrikeMid(chainSide, longStrike);
    if (shortMid === null || longMid === null) return null;

    return [
      { qty: 1, type, strike: longStrike, cost: Math.round(longMid * 100 * 100) / 100 },
      { qty: -1, type, strike: shortStrike, cost: Math.round(-shortMid * 100 * 100) / 100 }
    ];
  }

  // Weight given to "upside beyond the locked floor" vs. the locked floor
  // itself in rankCandidateScore below. 0.5 treats guaranteed and uncertain
  // profit as equally valuable — revisit this once there's a feel for how it
  // ranks real candidates in practice (e.g. weighting locked-in profit more
  // heavily, since it's guaranteed vs. merely possible).
  const UPSIDE_WEIGHT = 0.5;

  // Ranks a candidate by how much of the combined position's theoretical max
  // value (both spreads' widths) is locked in, plus a weighted share of
  // whatever additional upside exists beyond that floor. Deliberately NOT
  // lockedInProfit/profitPotential (that ratio rewards a small potential just
  // for being easy to be 100% of — see git history) and NOT a raw sum of the
  // two (potential already contains locked as its floor, so summing double-
  // counts it) — subtracting locked out of the upside term avoids that.
  function rankCandidateScore(lockedInProfit, profitPotential, combinedMaxValue) {
    if (!combinedMaxValue) return 0;
    const lockedFraction = lockedInProfit / combinedMaxValue;
    const upsideFraction = (profitPotential - lockedInProfit) / combinedMaxValue;
    return lockedFraction + upsideFraction * UPSIDE_WEIGHT;
  }

  function evaluateCandidate(label, family, positionLegs, candidateLegs, positionWidth, candidateWidth, meta) {
    const combinedLegs = positionLegs.concat(candidateLegs);
    const analysis = PortfolioRisk.analyzePortfolioRisk(combinedLegs);
    const cost = candidateLegs.reduce((sum, leg) => sum + leg.cost, 0);
    const combinedMaxValue = positionWidth * 100 + candidateWidth * 100;

    return {
      label,
      family,
      legs: candidateLegs,
      cost,
      lockedInProfit: analysis.lockedInProfit,
      profitPotential: analysis.profitPotential,
      profitPotentialScore: analysis.profitPotentialScore,
      rankScore: rankCandidateScore(analysis.lockedInProfit, analysis.profitPotential, combinedMaxValue),
      meta
    };
  }

  // Hard stop per family, independent of the cost cap — found via testing that a
  // perfectly linear/idealized chain never makes the 110% cost cap bind (shifting a
  // same-width spread doesn't change its cost under linear pricing), so this ceiling
  // is what actually keeps results curated rather than the cost check alone. Real
  // market skew should make the cost cap bind well before this in most cases.
  const MAX_SWEEP_STEPS = 5;

  /**
   * Generate the curated set of hedge candidates for a single spread position.
   * @param {Object} position - { legs: [{qty, type, strike, cost}, {qty, type, strike, cost}] }
   * @param {Object} chainData - { call: {...}, put: {...} } (Schwab callExpDateMap/putExpDateMap shape)
   * @param {Object} options - { minLockedInProfit?: number (default 0) — beyond the always-shown
   *   tiers, stop extending once a candidate's worst case would fall below this }
   */
  function findHedgeCandidates(position, chainData, options = {}) {
    const minLockedInProfit = options.minLockedInProfit ?? 0;
    const spec = identifySpread(position);
    const { positionType, positionLongStrike, positionShortStrike, width, direction, legs } = spec;

    const oppType = oppositeType(positionType);
    const oppChainSide = oppType === 'c' ? chainData.call : chainData.put;
    const sameChainSide = positionType === 'c' ? chainData.call : chainData.put;

    const candidates = [];

    // --- "shift" family: fixed width, shift the anchor from the box (S=0)
    // out through the straddle point (S=W) and beyond (S=1.5W, 2W, ...) ---
    const shiftLabels = { 0: 'Exact offset', 0.5: 'Balanced offset', 1: 'Same-strike offset' };
    for (let step = 0, shiftMultiplier = 0; step < MAX_SWEEP_STEPS; step++, shiftMultiplier += 0.5) {
      const S = shiftMultiplier * width;
      const offsetShortStrike = positionLongStrike + direction * S;
      const offsetLongStrike = offsetShortStrike + direction * width;

      const candidateLegs = buildCandidateLegs(oppType, offsetShortStrike, offsetLongStrike, oppChainSide);
      if (!candidateLegs) continue; // no market data at this strike pair — skip, keep sweeping

      const candidate = evaluateCandidate(
        shiftLabels[shiftMultiplier] || (shiftMultiplier === 1.5 ? 'First extended offset' : 'Further extended offset'),
        'shift', legs, candidateLegs, width, width, { S, shiftMultiplier }
      );

      // The first three tiers (box / balanced / straddle) are always shown
      // regardless of outcome; beyond the straddle point, stop extending once
      // a candidate would actually lock in a loss (checking cost against a
      // cap was found to not reliably track this — see git history).
      if (shiftMultiplier > 1 && candidate.lockedInProfit < minLockedInProfit) break;

      candidates.push(candidate);
    }

    // --- "width" family: anchored at the straddle point (S=W), widen the
    // offsetting spread itself instead of moving it further away ---
    for (let step = 0, widthMultiplier = 1.5; step < MAX_SWEEP_STEPS; step++, widthMultiplier += 0.5) {
      const offsetShortStrike = positionShortStrike; // straddle anchor
      const candidateWidth = widthMultiplier * width;
      const offsetLongStrike = offsetShortStrike + direction * candidateWidth;

      const candidateLegs = buildCandidateLegs(oppType, offsetShortStrike, offsetLongStrike, oppChainSide);
      if (!candidateLegs) continue;

      const candidate = evaluateCandidate('Wider offset', 'width', legs, candidateLegs, width, candidateWidth, { widthMultiplier });
      if (candidate.lockedInProfit < minLockedInProfit) break;

      candidates.push(candidate);
    }

    // --- "same side" family: same instrument type, credit spread positioned
    // just past the original's short strike (already-max-value territory) ---
    const localIncrement = findLocalStrikeIncrement(sameChainSide, positionShortStrike) || (width / 2);
    const sameSideOffsets = [];
    const firstOffset = Math.min(localIncrement, width / 2);
    if (firstOffset < width / 2) sameSideOffsets.push(firstOffset);
    for (let m = 0.5; sameSideOffsets.length < MAX_SWEEP_STEPS; m += 0.5) {
      sameSideOffsets.push(m * width);
    }

    let validSameSideCount = 0;
    for (let i = 0; i < sameSideOffsets.length; i++) {
      const offset = sameSideOffsets[i];
      const offsetShortStrike = positionShortStrike + direction * offset;
      const offsetLongStrike = offsetShortStrike + direction * width;

      const candidateLegs = buildCandidateLegs(positionType, offsetShortStrike, offsetLongStrike, sameChainSide);
      if (!candidateLegs) continue; // strike not actually listed — skip, don't count against labeling

      const label = validSameSideCount === 0 ? 'Credit offset' : 'Extended credit offset';
      const candidate = evaluateCandidate(label, 'same-side', legs, candidateLegs, width, width, { offset });
      if (validSameSideCount > 0 && candidate.lockedInProfit < minLockedInProfit) break;

      candidates.push(candidate);
      validSameSideCount++;
    }

    return candidates.sort((a, b) => b.rankScore - a.rankScore);
  }

  const SpreadHedgeStrategy = {
    identifySpread,
    findHedgeCandidates
  };

  // Node.js / CommonJS
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = SpreadHedgeStrategy;
  }

  // Browser / Global
  if (typeof window !== 'undefined') {
    window.SpreadHedgeStrategy = SpreadHedgeStrategy;
  }

  // Generic global
  if (typeof global !== 'undefined') {
    global.SpreadHedgeStrategy = SpreadHedgeStrategy;
  }

})(typeof window !== 'undefined' ? window : typeof global !== 'undefined' ? global : this);
