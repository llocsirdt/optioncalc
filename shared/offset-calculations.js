/**
 * Shared Offset Calculation Functions
 * 
 * Pure functions for calculating offsetting positions.
 * Works in both Node.js and browser environments.
 * No dependencies on external modules.
 */

(function(global) {
  'use strict';

  /**
   * Sort offsetting positions by custom priority:
   * Position 1: Highest locked-in profit with score = 1
   * Position 2: Highest profit potential
   * Remaining: Sorted by proximity to balanced score of 0.5
   */
  function sortOffsettingPositions(possibleOffsets) {
    if (!possibleOffsets || possibleOffsets.length === 0) {
      return [];
    }

    // Find the position with highest locked-in profit that has score = 1
    const perfectScorePositions = possibleOffsets.filter(p => 
      Math.abs(p.profitPotentialScore - 1.0) < 0.001
    );
    
    let topLockedProfit = null;
    if (perfectScorePositions.length > 0) {
      topLockedProfit = perfectScorePositions.reduce((max, p) => 
        p.lockedInProfit > max.lockedInProfit ? p : max
      );
    }

    // Find the position with highest profit potential (excluding the top locked profit)
    const remainingPositions = possibleOffsets.filter(p => p !== topLockedProfit);
    let topProfitPotential = null;
    if (remainingPositions.length > 0) {
      topProfitPotential = remainingPositions.reduce((max, p) => 
        p.profitPotential > max.profitPotential ? p : max
      );
    }

    // Sort remaining positions by proximity to 0.5 score
    const otherPositions = remainingPositions
      .filter(p => p !== topProfitPotential)
      .sort((a, b) => {
        const aDiff = Math.abs(a.profitPotentialScore - 0.5);
        const bDiff = Math.abs(b.profitPotentialScore - 0.5);
        return aDiff - bDiff;
      });

    // Combine in priority order
    const sorted = [];
    if (topLockedProfit) sorted.push(topLockedProfit);
    if (topProfitPotential) sorted.push(topProfitPotential);
    sorted.push(...otherPositions);

    return sorted;
  }

  /**
   * Aggregate multiple offsetting results into a single result
   */
  function aggregateOffsettingResults(results) {
    const aggregated = {
      strategies: [],
      possibleOffsets: []
    };

    results.forEach(result => {
      if (result.strategy) {
        aggregated.strategies.push(result.strategy);
      }
      if (result.possibleOffsets && Array.isArray(result.possibleOffsets)) {
        aggregated.possibleOffsets.push(...result.possibleOffsets);
      }
    });

    aggregated.possibleOffsets = sortOffsettingPositions(aggregated.possibleOffsets);

    return aggregated;
  }

  /**
   * Helper function to validate long call strike for bull call spread
   * Returns true if strike is valid and has market data, false otherwise
   */
  function isValidLongCallStrike(longCallStrike, referenceStrike, expirationStrikes) {
    // Check strike range - only consider long call strikes AT or BELOW the reference strike
    if (longCallStrike > referenceStrike) {
      return false;
    }
    
    // Check if market data exists for this strike
    for (const [expiration, strikes] of Object.entries(expirationStrikes)) {
      const longStrikeKey = longCallStrike.toString() + '.0';
      if (strikes[longStrikeKey]) {
        return true; // Found valid market data
      }
    }
    
    return false; // No market data found
  }

  /**
   * Helper function to validate short call strike for bear call spread
   * Returns true if strike is valid and has market data, false otherwise
   */
  function isValidShortCallStrike(shortCallStrike, referenceStrike, expirationStrikes) {
    // Check strike range - only consider short call strikes AT or ABOVE the reference strike
    if (shortCallStrike < referenceStrike) {
      return false;
    }
    
    // Check if market data exists for this strike
    for (const [expiration, strikes] of Object.entries(expirationStrikes)) {
      const shortStrikeKey = shortCallStrike.toString() + '.0';
      if (strikes[shortStrikeKey]) {
        return true; // Found valid market data
      }
    }
    
    return false; // No market data found
  }

  /**
   * Helper function to validate short put strike for bull put spread
   * Returns true if strike is valid and has market data, false otherwise
   */
  function isValidShortPutStrike(shortPutStrike, referenceStrike, expirationStrikes) {
    // Check strike range - only consider short put strikes BELOW the reference strike
    if (shortPutStrike >= referenceStrike) {
      return false;
    }
    
    // Check if market data exists for this strike
    for (const [expiration, strikes] of Object.entries(expirationStrikes)) {
      const shortStrikeKey = shortPutStrike.toString() + '.0';
      if (strikes[shortStrikeKey]) {
        return true; // Found valid market data
      }
    }
    
    return false; // No market data found
  }

  /**
   * Helper function to validate short put strike for bear put spread
   * Returns true if strike is valid and has market data, false otherwise
   */
  function isValidShortPutStrikeForBear(shortPutStrike, referenceStrike, expirationStrikes) {
    // Check strike range - only consider short put strikes AT or ABOVE the reference strike
    if (shortPutStrike < referenceStrike) {
      return false;
    }
    
    // Check if market data exists for this strike
    for (const [expiration, strikes] of Object.entries(expirationStrikes)) {
      const shortStrikeKey = shortPutStrike.toString() + '.0';
      if (strikes[shortStrikeKey]) {
        return true; // Found valid market data
      }
    }
    
    return false; // No market data found
  }

  /**
   * Helper function to validate short call strike for spread creation
   * Returns true if strike is valid for spread creation, false otherwise
   */
  function isValidShortCallForSpread(shortCallStrike, longCallStrike, currentSpreadWidth, spreadWidth, spreadKey, addedSpreads, expirationStrikes) {
    // Skip if narrower than original spread width
    if (currentSpreadWidth < spreadWidth) {
      return false;
    }
    
    if (addedSpreads.has(spreadKey)) {
      return false;
    }
    
    // Check if market data exists and is valid
    for (const [expiration, strikes] of Object.entries(expirationStrikes)) {
      const shortStrikeKey = shortCallStrike.toString() + '.0';
      if (strikes[shortStrikeKey]) {
        const shortCallData = strikes[shortStrikeKey][0];
        return shortCallData && shortCallData.bid && shortCallData.ask;
      }
    }
    
    return false; // No valid market data found
  }

  /**
   * Helper function to validate long call strike for bear call spread creation
   * Returns true if strike is valid for spread creation, false otherwise
   */
  function isValidLongCallForBearSpread(shortCallStrike, longCallStrike, currentSpreadWidth, spreadWidth, spreadKey, addedSpreads, expirationStrikes) {
    // Skip if narrower than original spread width
    if (currentSpreadWidth < spreadWidth) {
      return false;
    }
    
    if (addedSpreads.has(spreadKey)) {
      return false;
    }
    
    // Check if market data exists for this strike
    for (const [expiration, strikes] of Object.entries(expirationStrikes)) {
      const longStrikeKey = longCallStrike.toString() + '.0';
      if (strikes[longStrikeKey]) {
        return true; // Found valid market data
      }
    }
    
    return false; // No valid market data found
  }

  /**
   * Helper function to validate long put strike for bull put spread creation
   * Returns true if strike is valid for spread creation, false otherwise
   */
  function isValidLongPutForBullSpread(shortPutStrike, longPutStrike, currentSpreadWidth, spreadWidth, spreadKey, addedSpreads, expirationStrikes) {
    // Skip if narrower than original spread width
    if (currentSpreadWidth < spreadWidth) {
      return false;
    }
    
    if (addedSpreads.has(spreadKey)) {
      return false;
    }
    
    // Check if market data exists for this strike
    for (const [expiration, strikes] of Object.entries(expirationStrikes)) {
      const longStrikeKey = longPutStrike.toString() + '.0';
      if (strikes[longStrikeKey]) {
        return true; // Found valid market data
      }
    }
    
    return false; // No valid market data found
  }

  /**
   * Helper function to validate long put strike for bear put spread creation
   * Returns true if strike is valid for spread creation, false otherwise
   */
  function isValidLongPutForBearSpread(shortPutStrike, longPutStrike, currentSpreadWidth, spreadWidth, spreadKey, addedSpreads, expirationStrikes) {
    // Skip if narrower than original spread width
    if (currentSpreadWidth < spreadWidth) {
      return false;
    }
    
    if (addedSpreads.has(spreadKey)) {
      return false;
    }
    
    // Check if market data exists for this strike
    for (const [expiration, strikes] of Object.entries(expirationStrikes)) {
      const longStrikeKey = longPutStrike.toString() + '.0';
      if (strikes[longStrikeKey]) {
        return true; // Found valid market data
      }
    }
    
    return false; // No valid market data found
  }

  /**
   * Helper function to retrieve strike data and calculate cost
   * Returns object with data, cost, and index, or null if no data found
   */
  function getStrikeData(strike, strikesArray, expirationStrikes) {
    const strikeKey = strike.toString() + '.0';
    
    // Find market data
    let marketData = null;
    for (const [expiration, strikes] of Object.entries(expirationStrikes)) {
      if (strikes[strikeKey]) {
        marketData = strikes[strikeKey][0];
        break;
      }
    }
    
    if (!marketData) {
      return null;
    }
    
    // CRITICAL: Validate bid/ask prices are non-zero
    // Options with 0 bid or 0 ask are illiquid or have invalid market data
    // Using them creates invalid spread costs (credits when should be debits)
    const bid = marketData.bid || 0;
    const ask = marketData.ask || 0;
    
    if (bid <= 0 || ask <= 0) {
      // console.log(`⚠️ Skipping strike ${strike}: invalid bid/ask (bid=${bid}, ask=${ask})`);
      return null;
    }
    
    return {
      data: marketData,
      cost: (bid + ask) / 2,
      index: strikesArray.indexOf(strike)
    };
  }

  /**
   * Helper function to calculate profit metrics for bull call spread offsets
   * Returns object with lockedInProfit, profitPotential, and profitPotentialScore
   */
  function calculateBullCallProfitMetrics(position, offsettingPosition) {
    let lockedInProfit, profitPotential, profitPotentialScore;
    
    // Extract offsetting position properties
    const spreadCost = offsettingPosition.cost;
    const offsetMaxValue = offsettingPosition.maxValue;
    const offsetLegs = getShortLongLegs(offsettingPosition);
    const bullCallLongStrike = offsetLegs.longStrike;
    const bullCallShortStrike = offsetLegs.shortStrike;
    
    // Extract position properties
    const positionLegs = getShortLongLegs(position);
    const positionShortStrike = positionLegs.shortStrike;
    const positionLongStrike = positionLegs.longStrike;
    
    // Determine if positions are on same side or opposite sides of chain
    const offsetStrategy = offsettingPosition.strategy; // Always 'bull_call_spread' for this function
    const positionStrategy = position.strategy;
    
    // SCENARIO 1: OPPOSITE SIDES - Bull Call (offsetting) + Bear Put (position)
    // Puts on left, calls on right - opposite sides of chain
    if (positionStrategy === 'bear_put_spread') {
      const bearPutShortStrike = positionShortStrike;
      const bearPutLongStrike = positionLongStrike;
      const totalCost = position.cost + spreadCost;
      
      // Check if spreads overlap
      // Bear put: profitable below bearPutLongStrike, max value at bearPutShortStrike and below
      // Bull call: profitable above bullCallLongStrike, max value at bullCallShortStrike and above
      const spreadsOverlap = bullCallLongStrike < bearPutLongStrike;
      
      if (spreadsOverlap) {
        // SCENARIO 1A: OPPOSITE SIDES - OVERLAPPING
        // Worst case: one spread reaches max while the other is worthless
        const minMaxValue = Math.min(position.maxValue, offsetMaxValue);
        lockedInProfit = minMaxValue - totalCost;
        
        // Best case: both spreads reach max value, minus overlap at short legs
        // If short legs overlap, we subtract the double-counted region
        const shortLegsOverlap = bearPutShortStrike >= bullCallLongStrike && bearPutShortStrike <= bullCallShortStrike;
        
        if (shortLegsOverlap) {
          // Subtract the overlap region between the two short strikes
          const overlapAmount = Math.abs(bearPutShortStrike - bullCallShortStrike) * 100;
          const maxCombinedValue = position.maxValue + offsetMaxValue - overlapAmount;
          profitPotential = maxCombinedValue - totalCost;
        } else {
          // No overlap at short legs - both can reach full value independently
          const maxCombinedValue = position.maxValue + offsetMaxValue;
          profitPotential = maxCombinedValue - totalCost;
        }
      } else {
        // SCENARIO 1B: OPPOSITE SIDES - NON-OVERLAPPING (GAP BETWEEN SPREADS)
        // TODO: Determine correct calculation
        // Current logic from lines 330-336
        lockedInProfit = -totalCost; // Worst case: both worthless in the gap
        const combinedMaxValue = position.maxValue + offsetMaxValue;
        profitPotential = combinedMaxValue - totalCost;
      }
      
      profitPotentialScore = profitPotential !== 0 ? lockedInProfit / profitPotential : 0;
      
    // SCENARIO 2: SAME SIDE - Bull Call (offsetting) + Bear Call (position)
    // Both are call spreads - same side of chain
    } else if (positionStrategy === 'bear_call_spread') {
      const bearCallShortStrike = positionShortStrike;
      const bearCallLongStrike = positionLongStrike;
      
      const bearCallCredit = -position.cost;
      const netCredit = bearCallCredit - spreadCost;
      
      // Check if spreads overlap
      // Bear call: short at bearCallShortStrike, long at bearCallLongStrike (bearCallShortStrike < bearCallLongStrike)
      // Bull call: long at bullCallLongStrike, short at bullCallShortStrike (bullCallLongStrike < bullCallShortStrike)
      const spreadsOverlap = bullCallLongStrike < bearCallLongStrike && bearCallShortStrike < bullCallShortStrike;
      
      if (spreadsOverlap) {
        // SCENARIO 2A: SAME SIDE - OVERLAPPING
        // Bull call (debit) + Bear call (credit) on same side
        const bearCallMaxLoss = Math.abs(position.maxValue || 0);
        const bullCallMaxValue = offsetMaxValue;
        
        // Worst case: price goes very high (bull call maxes, bear call loses max)
        // OR price stays low (both expire worthless, keep net credit)
        const worstCaseHighPrice = bullCallMaxValue - bearCallMaxLoss + netCredit;
        const worstCaseLowPrice = netCredit;
        lockedInProfit = Math.min(worstCaseHighPrice, worstCaseLowPrice);
        
        // Best case: price lands at optimal point in overlap
        // At bearCallShortStrike: bull call has some value, bear call has no loss yet
        const bullCallValueAtBearShort = Math.max(0, (bearCallShortStrike - bullCallLongStrike) * 100);
        const profitAtBearShort = bullCallValueAtBearShort + netCredit;
        
        // At bullCallShortStrike: bull call maxes, bear call has some loss
        const bearCallLossAtBullShort = Math.max(0, (bullCallShortStrike - bearCallShortStrike) * 100);
        const profitAtBullShort = bullCallMaxValue - bearCallLossAtBullShort + netCredit;
        
        profitPotential = Math.max(netCredit, profitAtBearShort, profitAtBullShort);
      } else {
        // SCENARIO 2B: SAME SIDE - NON-OVERLAPPING
        // Bull call (debit) + Bear call (credit) on same side, no overlap
        // Short legs are at same strike or wider apart
        const bearCallMaxLoss = Math.abs(position.maxValue || 0);
        const bullCallMaxValue = offsetMaxValue;
        
        // Worst case: price goes very high (bull call maxes, bear call loses max)
        // OR price stays low (both expire worthless, net credit/cost)
        const worstCaseHighPrice = bullCallMaxValue - bearCallMaxLoss + netCredit;
        const worstCaseLowPrice = netCredit;
        lockedInProfit = Math.min(worstCaseHighPrice, worstCaseLowPrice);
        
        // Best case: price lands between the spreads or at optimal point
        // Since they don't overlap, best case is typically just the net credit
        // or bull call at max with no bear call loss (if bull call is lower)
        profitPotential = Math.max(netCredit, bullCallMaxValue + netCredit);
      }
      
      profitPotentialScore = profitPotential !== 0 ? lockedInProfit / profitPotential : 0;
      
    // SCENARIO 3 & 4: Bull Call (offsetting) + Bull Call or Bull Put (position)
    // These should not be valid offsetting scenarios for a bull call offset
    } else {
      // Invalid scenario - bull call cannot offset another bull call or bull put
      console.warn(`⚠️ Invalid offsetting scenario: Bull Call offset for ${positionStrategy}`);
      const minMaxValue = Math.min(position.maxValue || 0, offsetMaxValue);
      const maxMaxValue = Math.max(position.maxValue || 0, offsetMaxValue);
      const totalCost = position.cost + spreadCost;
      lockedInProfit = minMaxValue - totalCost;
      profitPotential = maxMaxValue - totalCost;
      profitPotentialScore = profitPotential !== 0 ? lockedInProfit / profitPotential : 0;
    }
    
    return {
      lockedInProfit,
      profitPotential,
      profitPotentialScore
    };
  }

  /**
   * Helper function to calculate profit metrics for bear call spread offsets
   * Returns object with lockedInProfit, profitPotential, and profitPotentialScore
   */
  function calculateBearCallProfitMetrics(position, offsettingPosition) {
    let lockedInProfit, profitPotential, profitPotentialScore;
    
    // Extract offsetting position properties
    const spreadCredit = -offsettingPosition.cost; // Bear call spread receives credit
    const offsetMaxValue = offsettingPosition.maxValue;
    const offsetLegs = getShortLongLegs(offsettingPosition);
    const bearCallShortStrike = offsetLegs.shortStrike;
    const bearCallLongStrike = offsetLegs.longStrike;
    
    // Extract position properties
    const positionLegs = getShortLongLegs(position);
    const positionShortStrike = positionLegs.shortStrike;
    const positionLongStrike = positionLegs.longStrike;
    
    // Determine if positions are on same side or opposite sides of chain
    const offsetStrategy = offsettingPosition.strategy; // Always 'bear_call_spread' for this function
    const positionStrategy = position.strategy;
    
    // SCENARIO 1: SAME SIDE - Bear Call (offsetting) + Bull Call (position)
    // Both are call spreads - same side of chain
    if (positionStrategy === 'bull_call_spread') {
      const bullCallLongStrike = positionLongStrike;
      const bullCallShortStrike = positionShortStrike;
      
      const netCost = position.cost - spreadCredit;
      
      // Check if spreads overlap
      // Bull call: long at bullCallLongStrike, short at bullCallShortStrike (bullCallLongStrike < bullCallShortStrike)
      // Bear call: short at bearCallShortStrike, long at bearCallLongStrike (bearCallShortStrike < bearCallLongStrike)
      const spreadsOverlap = bullCallLongStrike < bearCallLongStrike && bearCallShortStrike < bullCallShortStrike;
      
      if (spreadsOverlap) {
        // SCENARIO 1A: SAME SIDE - OVERLAPPING
        // Bear call (credit) + Bull call (debit) on same side
        const bullCallMaxValue = position.maxValue;
        const bearCallMaxLoss = Math.abs(offsetMaxValue);
        
        // Worst case: price goes very high (bull call maxes, bear call loses max)
        // OR price stays low (both expire worthless, net cost paid)
        const worstCaseHighPrice = bullCallMaxValue - bearCallMaxLoss - netCost;
        const worstCaseLowPrice = -netCost;
        lockedInProfit = Math.min(worstCaseHighPrice, worstCaseLowPrice);
        
        // Best case: price lands at optimal point in overlap
        // At bearCallShortStrike: bull call has some value, bear call has no loss yet
        const bullCallValueAtBearShort = Math.max(0, (bearCallShortStrike - bullCallLongStrike) * 100);
        const profitAtBearShort = bullCallValueAtBearShort - netCost;
        
        // At bullCallShortStrike: bull call maxes, bear call has some loss
        const bearCallLossAtBullShort = Math.max(0, (bullCallShortStrike - bearCallShortStrike) * 100);
        const profitAtBullShort = bullCallMaxValue - bearCallLossAtBullShort - netCost;
        
        profitPotential = Math.max(-netCost, profitAtBearShort, profitAtBullShort);
      } else {
        // SCENARIO 1B: SAME SIDE - NON-OVERLAPPING
        // Bear call (credit) + Bull call (debit) on same side, no overlap
        // Short legs are at same strike or wider apart
        const bullCallMaxValue = position.maxValue;
        const bearCallMaxLoss = Math.abs(offsetMaxValue);
        
        // Worst case: price goes very high (bull call maxes, bear call loses max)
        // OR price stays low (both expire worthless, net cost paid)
        const worstCaseHighPrice = bullCallMaxValue - bearCallMaxLoss - netCost;
        const worstCaseLowPrice = -netCost;
        lockedInProfit = Math.min(worstCaseHighPrice, worstCaseLowPrice);
        
        // Best case: price lands between the spreads or at optimal point
        // Since they don't overlap, best case is bull call at max with no bear call loss
        profitPotential = Math.max(-netCost, bullCallMaxValue - netCost);
      }
      
    // SCENARIO 2: OPPOSITE SIDES - Bear Call (offsetting) + Bull Put (position)
    // Puts on left, calls on right - opposite sides of chain
    } else if (positionStrategy === 'bull_put_spread') {
      const bullPutShortStrike = positionShortStrike;
      const bullPutLongStrike = positionLongStrike;
      
      const bullPutCredit = -position.cost;
      const totalCredit = bullPutCredit + spreadCredit;
      
      // Check if spreads overlap
      // Bull put: short at bullPutShortStrike, long at bullPutLongStrike (bullPutLongStrike < bullPutShortStrike)
      // Bear call: short at bearCallShortStrike, long at bearCallLongStrike (bearCallShortStrike < bearCallLongStrike)
      // Since puts are below calls, they typically don't overlap
      const spreadsOverlap = bullPutShortStrike > bearCallShortStrike;
      
      if (spreadsOverlap) {
        // SCENARIO 2A: OPPOSITE SIDES - OVERLAPPING
        // Bull put and bear call overlap (unusual - puts and calls on opposite sides)
        // This is rare but possible if strikes cross over
        const bullPutMaxLoss = Math.abs(position.maxValue || 0);
        const bearCallMaxLossAbs = Math.abs(offsetMaxValue);
        
        // Worst case: one spread loses max
        const maxLossWorstSpread = Math.max(bullPutMaxLoss, bearCallMaxLossAbs);
        lockedInProfit = -maxLossWorstSpread + totalCredit;
        
        // Best case: both spreads expire worthless, keep all credit
        profitPotential = totalCredit;
      } else {
        // SCENARIO 2B: OPPOSITE SIDES - NON-OVERLAPPING
        // Bull put (below) and bear call (above) with gap between
        // Both credit spreads on opposite sides
        const bullPutMaxLoss = Math.abs(position.maxValue || 0);
        const bearCallMaxLossAbs = Math.abs(offsetMaxValue);
        
        // Worst case: one spread loses max (price moves far in one direction)
        const maxLossWorstSpread = Math.max(bullPutMaxLoss, bearCallMaxLossAbs);
        lockedInProfit = -maxLossWorstSpread + totalCredit;
        
        // Best case: price stays in the gap, both spreads expire worthless
        profitPotential = totalCredit;
      }
      
    // SCENARIO 3 & 4: Bear Call (offsetting) + Bear Call or Bear Put (position)
    // These should not be valid offsetting scenarios for a bear call offset
    } else {
      // Invalid scenario - bear call cannot offset another bear call or bear put
      console.warn(`⚠️ Invalid offsetting scenario: Bear Call offset for ${positionStrategy}`);
      const positionMaxValue = position.maxValue || 0;
      lockedInProfit = positionMaxValue + offsetMaxValue + spreadCredit - position.cost;
      profitPotential = positionMaxValue + spreadCredit - position.cost;
    }
    
    profitPotentialScore = profitPotential !== 0 ? lockedInProfit / profitPotential : 0;
    
    return {
      lockedInProfit,
      profitPotential,
      profitPotentialScore
    };
  }

  /**
   * Helper function to calculate profit metrics for bull put spread offsets
   * Returns object with lockedInProfit, profitPotential, and profitPotentialScore
   */
  function calculateBullPutProfitMetrics(position, offsettingPosition) {
    let lockedInProfit, profitPotential, profitPotentialScore;
    
    // Extract offsetting position properties
    const spreadCredit = -offsettingPosition.cost; // Bull put spread receives credit
    const bullPutMaxLoss = offsettingPosition.maxValue;
    const offsetLegs = getShortLongLegs(offsettingPosition);
    const bullPutShortStrike = offsetLegs.shortStrike;
    const bullPutLongStrike = offsetLegs.longStrike;
    
    // Extract position properties
    const positionLegs = getShortLongLegs(position);
    const positionShortStrike = positionLegs.shortStrike;
    const positionLongStrike = positionLegs.longStrike;
    
    // Determine if positions are on same side or opposite sides of chain
    const offsetStrategy = offsettingPosition.strategy; // Always 'bull_put_spread' for this function
    const positionStrategy = position.strategy;
    
    // SCENARIO 1: SAME SIDE - Bull Put (offsetting) + Bear Put (position)
    // Both are put spreads - same side of chain
    if (positionStrategy === 'bear_put_spread') {
      const bearPutShortStrike = positionShortStrike;
      const bearPutLongStrike = positionLongStrike;
      
      const bearPutCost = position.cost;
      const netCost = bearPutCost - spreadCredit;
      
      // Check if spreads overlap
      // Bear put: long at bearPutLongStrike, short at bearPutShortStrike (bearPutLongStrike < bearPutShortStrike)
      // Bull put: long at bullPutLongStrike, short at bullPutShortStrike (bullPutLongStrike < bullPutShortStrike)
      const spreadsOverlap = bullPutShortStrike > bearPutShortStrike && bullPutLongStrike < bearPutLongStrike;
      
      if (spreadsOverlap) {
        // SCENARIO 1A: SAME SIDE - OVERLAPPING
        // Bear put (debit) + Bull put (credit) on same side
        const bearPutMaxValue = position.maxValue || (position.spreadWidth * 100);
        const bullPutMaxLossAbs = Math.abs(bullPutMaxLoss);
        
        // Worst case: price goes very low (bear put maxes, bull put loses max)
        // OR price stays high (both expire worthless, net cost paid)
        const worstCaseLowPrice = bearPutMaxValue - bullPutMaxLossAbs - netCost;
        const worstCaseHighPrice = -netCost;
        lockedInProfit = Math.min(worstCaseLowPrice, worstCaseHighPrice);
        
        // Best case: price lands at optimal point in overlap
        // At bullPutShortStrike: bear put has some value, bull put has no loss yet
        const bearPutValueAtBullShort = Math.max(0, (bearPutLongStrike - bullPutShortStrike) * 100);
        const profitAtBullShort = bearPutValueAtBullShort - netCost;
        
        // At bearPutShortStrike: bear put maxes, bull put has some loss
        const bullPutLossAtBearShort = Math.max(0, (bullPutShortStrike - bearPutShortStrike) * 100);
        const profitAtBearShort = bearPutMaxValue - bullPutLossAtBearShort - netCost;
        
        profitPotential = Math.max(-netCost, profitAtBullShort, profitAtBearShort);
      } else {
        // SCENARIO 1B: SAME SIDE - NON-OVERLAPPING
        // Bear put (debit) + Bull put (credit) on same side, no overlap
        // Short legs are at same strike or wider apart
        const bearPutMaxValue = position.maxValue || (position.spreadWidth * 100);
        const bullPutMaxLossAbs = Math.abs(bullPutMaxLoss);
        
        // Worst case: price goes very low (bear put maxes, bull put loses max)
        // OR price stays high (both expire worthless, net cost paid)
        const worstCaseLowPrice = bearPutMaxValue - bullPutMaxLossAbs - netCost;
        const worstCaseHighPrice = -netCost;
        lockedInProfit = Math.min(worstCaseLowPrice, worstCaseHighPrice);
        
        // Best case: price lands between the spreads or at optimal point
        // Since they don't overlap, best case is bear put at max with no bull put loss
        profitPotential = Math.max(-netCost, bearPutMaxValue - netCost);
      }
      
    // SCENARIO 2: OPPOSITE SIDES - Bull Put (offsetting) + Bear Call (position)
    // Puts on left, calls on right - opposite sides of chain
    } else if (positionStrategy === 'bear_call_spread') {
      const bearCallShortStrike = positionShortStrike;
      const bearCallLongStrike = positionLongStrike;
      
      const bearCallCredit = -position.cost;
      const totalCredit = bearCallCredit + spreadCredit;
      
      // Check if spreads overlap
      // Bull put: short at bullPutShortStrike, long at bullPutLongStrike (bullPutLongStrike < bullPutShortStrike)
      // Bear call: short at bearCallShortStrike, long at bearCallLongStrike (bearCallShortStrike < bearCallLongStrike)
      // Since puts are below calls, they typically don't overlap
      const spreadsOverlap = bullPutShortStrike > bearCallShortStrike;
      
      if (spreadsOverlap) {
        // SCENARIO 2A: OPPOSITE SIDES - OVERLAPPING
        // Bear call and bull put overlap (unusual - calls and puts on opposite sides)
        // This is rare but possible if strikes cross over
        const bearCallMaxLoss = Math.abs(position.maxValue || 0);
        const bullPutMaxLossAbs = Math.abs(bullPutMaxLoss);
        
        // Worst case: one spread loses max
        const maxLossWorstSpread = Math.max(bearCallMaxLoss, bullPutMaxLossAbs);
        lockedInProfit = -maxLossWorstSpread + totalCredit;
        
        // Best case: both spreads expire worthless, keep all credit
        profitPotential = totalCredit;
      } else {
        // SCENARIO 2B: OPPOSITE SIDES - NON-OVERLAPPING
        // Bear call (above) and bull put (below) with gap between
        // Both credit spreads on opposite sides - classic iron condor setup
        const bearCallMaxLoss = Math.abs(position.maxValue || 0);
        const bullPutMaxLossAbs = Math.abs(bullPutMaxLoss);
        
        // Worst case: one spread loses max (price moves far in one direction)
        const maxLossWorstSpread = Math.max(bearCallMaxLoss, bullPutMaxLossAbs);
        lockedInProfit = -maxLossWorstSpread + totalCredit;
        
        // Best case: price stays in the gap, both spreads expire worthless
        profitPotential = totalCredit;
      }
      
    // SCENARIO 3 & 4: Bull Put (offsetting) + Bull Put or Bull Call (position)
    // These should not be valid offsetting scenarios for a bull put offset
    } else {
      // Invalid scenario - bull put cannot offset another bull put or bull call
      console.warn(`⚠️ Invalid offsetting scenario: Bull Put offset for ${positionStrategy}`);
      const positionMaxValue = position.maxValue || 0;
      lockedInProfit = positionMaxValue + bullPutMaxLoss + spreadCredit - position.cost;
      profitPotential = positionMaxValue + spreadCredit - position.cost;
    }
    
    profitPotentialScore = profitPotential !== 0 ? lockedInProfit / profitPotential : 0;
    
    return {
      lockedInProfit,
      profitPotential,
      profitPotentialScore
    };
  }

  /**
   * Helper function to calculate profit metrics for bear put spread offsets
   * Returns object with lockedInProfit, profitPotential, and profitPotentialScore
   */
  function calculateBearPutProfitMetrics(position, offsettingPosition) {
    let lockedInProfit, profitPotential, profitPotentialScore;
    
    // Extract offsetting position properties
    const spreadCost = offsettingPosition.cost;
    const offsetMaxValue = offsettingPosition.maxValue;
    const offsetLegs = getShortLongLegs(offsettingPosition);
    const bearPutLongStrike = offsetLegs.longStrike;
    const bearPutShortStrike = offsetLegs.shortStrike;
    
    // Extract position properties
    const positionLegs = getShortLongLegs(position);
    const positionShortStrike = positionLegs.shortStrike;
    const positionLongStrike = positionLegs.longStrike;
    
    // Determine if positions are on same side or opposite sides of chain
    const offsetStrategy = offsettingPosition.strategy; // Always 'bear_put_spread' for this function
    const positionStrategy = position.strategy;
    
    // SCENARIO 1: OPPOSITE SIDES - Bear Put (offsetting) + Bull Call (position)
    // Puts on left, calls on right - opposite sides of chain
    if (positionStrategy === 'bull_call_spread') {
      const bullCallLongStrike = positionLongStrike;
      const bullCallShortStrike = positionShortStrike;
      const totalCost = position.cost + spreadCost;
      
      // Check if spreads overlap
      // Bull call: profitable above bullCallLongStrike, max value at bullCallShortStrike and above
      // Bear put: profitable below bearPutLongStrike, max value at bearPutShortStrike and below
      const spreadsOverlap = bullCallLongStrike < bearPutLongStrike;
      
      if (spreadsOverlap) {
        // SCENARIO 1A: OPPOSITE SIDES - OVERLAPPING
        // Worst case: one spread reaches max while the other is worthless
        const minMaxValue = Math.min(position.maxValue, offsetMaxValue);
        lockedInProfit = minMaxValue - totalCost;
        
        // Best case: both spreads reach max value, minus overlap at short legs
        // If short legs overlap, we subtract the double-counted region
        const shortLegsOverlap = bearPutShortStrike >= bullCallLongStrike && bearPutShortStrike <= bullCallShortStrike;
        
        if (shortLegsOverlap) {
          // Subtract the overlap region between the two short strikes
          const overlapAmount = Math.abs(bearPutShortStrike - bullCallShortStrike) * 100;
          const maxCombinedValue = position.maxValue + offsetMaxValue - overlapAmount;
          profitPotential = maxCombinedValue - totalCost;
        } else {
          // No overlap at short legs - both can reach full value independently
          const maxCombinedValue = position.maxValue + offsetMaxValue;
          profitPotential = maxCombinedValue - totalCost;
        }
      } else {
        // SCENARIO 1B: OPPOSITE SIDES - NON-OVERLAPPING (GAP BETWEEN SPREADS)
        // TODO: Determine correct calculation
        // Current logic from lines 708-714
        lockedInProfit = -totalCost; // Worst case: both worthless in the gap
        const combinedMaxValue = position.maxValue + offsetMaxValue;
        profitPotential = combinedMaxValue - totalCost;
      }
      
    // SCENARIO 2: SAME SIDE - Bear Put (offsetting) + Bull Put (position)
    // Both are put spreads - same side of chain
    } else if (positionStrategy === 'bull_put_spread') {
      const bullPutShortStrike = positionShortStrike;
      const bullPutLongStrike = positionLongStrike;
      
      const bullPutCredit = -position.cost;
      const netCredit = bullPutCredit - spreadCost;
      
      // Check if spreads overlap
      // Bull put: short at bullPutShortStrike, long at bullPutLongStrike (bullPutLongStrike < bullPutShortStrike)
      // Bear put: long at bearPutLongStrike, short at bearPutShortStrike (bearPutLongStrike < bearPutShortStrike)
      const spreadsOverlap = bearPutLongStrike >= bullPutLongStrike && bearPutLongStrike <= bullPutShortStrike;
      
      if (spreadsOverlap) {
        // SCENARIO 2A: SAME SIDE - OVERLAPPING
        // Bull put (credit) + Bear put (debit) on same side
        const bullPutMaxLoss = Math.abs(position.maxValue || 0);
        const bearPutMaxValue = offsetMaxValue;
        
        // Worst case: price goes very low (bear put maxes, bull put loses max)
        // OR price stays high (both expire worthless, keep net credit)
        const worstCaseLowPrice = bearPutMaxValue - bullPutMaxLoss + netCredit;
        const worstCaseHighPrice = netCredit;
        lockedInProfit = Math.min(worstCaseLowPrice, worstCaseHighPrice);
        
        // Best case: price lands at optimal point in overlap
        // At bullPutShortStrike: bear put has some value, bull put has no loss yet
        const bearPutValueAtBullShort = Math.max(0, (bearPutLongStrike - bullPutShortStrike) * 100);
        const profitAtBullShort = bearPutValueAtBullShort + netCredit;
        
        // At bearPutShortStrike: bear put maxes, bull put has some loss
        const bullPutLossAtBearShort = Math.max(0, (bullPutShortStrike - bearPutShortStrike) * 100);
        const profitAtBearShort = bearPutMaxValue - bullPutLossAtBearShort + netCredit;
        
        profitPotential = Math.max(netCredit, profitAtBullShort, profitAtBearShort);
      } else {
        // SCENARIO 2B: SAME SIDE - NON-OVERLAPPING
        // Bull put (credit) + Bear put (debit) on same side, no overlap
        // Short legs are at same strike or wider apart
        const bullPutMaxLoss = Math.abs(position.maxValue || 0);
        const bearPutMaxValue = offsetMaxValue;
        
        // Worst case: price goes very low (bear put maxes, bull put loses max)
        // OR price stays high (both expire worthless, keep net credit)
        const worstCaseLowPrice = bearPutMaxValue - bullPutMaxLoss + netCredit;
        const worstCaseHighPrice = netCredit;
        lockedInProfit = Math.min(worstCaseLowPrice, worstCaseHighPrice);
        
        // Best case: price lands between the spreads or at optimal point
        // Since they don't overlap, best case is typically just the net credit
        // or bear put at max with no bull put loss (if bear put is lower)
        profitPotential = Math.max(netCredit, bearPutMaxValue + netCredit);
      }
      
    // SCENARIO 3 & 4: Bear Put (offsetting) + Bear Put or Bear Call (position)
    // These should not be valid offsetting scenarios for a bear put offset
    } else {
      // Invalid scenario - bear put cannot offset another bear put or bear call
      console.warn(`⚠️ Invalid offsetting scenario: Bear Put offset for ${positionStrategy}`);
      const minMaxValue = Math.min(position.maxValue || 0, offsetMaxValue);
      const maxMaxValue = Math.max(position.maxValue || 0, offsetMaxValue);
      const totalCost = position.cost + spreadCost;
      lockedInProfit = minMaxValue - totalCost;
      profitPotential = maxMaxValue - totalCost;
    }
    
    profitPotentialScore = profitPotential !== 0 ? lockedInProfit / profitPotential : 0;
    
    return {
      lockedInProfit,
      profitPotential,
      profitPotentialScore
    };
  }

  /**
   * Helper function to create bull call spread object
   * Returns structured offsetting spread object
   */
  function createBullCallSpreadObject(longCallStrike, shortCallStrike, longCallCost, shortCallCost, spreadCost, currentSpreadWidth, offsetMaxValue, lockedInProfit, profitPotential, profitPotentialScore) {
    return {
      strategy: 'bull_call_spread',
      legs: [
        {
          action: 'offset',
          qty: 1,
          type: 'C',
          strike: longCallStrike,
          cost: longCallCost * 100,
          originalString: `1c${longCallStrike}@${longCallCost * 100}`
        },
        {
          action: 'offset',
          qty: -1,
          type: 'C',
          strike: shortCallStrike,
          cost: -shortCallCost * 100,
          originalString: `-1c${shortCallStrike}@${-shortCallCost * 100}`
        }
      ],
      cost: spreadCost,
      spreadWidth: currentSpreadWidth,
      maxValue: offsetMaxValue,
      lockedInProfit: lockedInProfit,
      profitPotential: profitPotential,
      profitPotentialScore: profitPotentialScore,
      description: `Bull Call Spread: Long ${longCallStrike}C @ ${longCallCost.toFixed(2)}, Short ${shortCallStrike}C @ ${shortCallCost.toFixed(2)}`
    };
  }

  /**
   * Helper function to create bear call spread object
   * Returns structured offsetting spread object
   */
  function createBearCallSpreadObject(shortCallStrike, longCallStrike, shortCallCredit, longCallCost, spreadCredit, currentSpreadWidth, offsetMaxValue, lockedInProfit, profitPotential, profitPotentialScore) {
    return {
      strategy: 'bear_call_spread',
      legs: [
        {
          action: 'offset',
          qty: -1,
          type: 'C',
          strike: shortCallStrike,
          cost: -shortCallCredit * 100,
          originalString: `-1c${shortCallStrike}@${-shortCallCredit * 100}`
        },
        {
          action: 'offset',
          qty: 1,
          type: 'C',
          strike: longCallStrike,
          cost: longCallCost * 100,
          originalString: `1c${longCallStrike}@${longCallCost * 100}`
        }
      ],
      cost: -spreadCredit,
      spreadWidth: currentSpreadWidth,
      maxValue: offsetMaxValue,
      lockedInProfit: lockedInProfit,
      profitPotential: profitPotential,
      profitPotentialScore: profitPotentialScore,
      description: `Bear Call Spread: Short ${shortCallStrike}C @ ${shortCallCredit.toFixed(2)}, Long ${longCallStrike}C @ ${longCallCost.toFixed(2)}`
    };
  }

  /**
   * Helper function to create bull put spread object
   * Returns structured offsetting spread object
   */
  function createBullPutSpreadObject(shortPutStrike, longPutStrike, shortPutCredit, longPutCost, spreadCredit, currentSpreadWidth, bullPutMaxLoss, lockedInProfit, profitPotential, profitPotentialScore) {
    return {
      strategy: 'bull_put_spread',
      legs: [
        {
          action: 'offset',
          qty: -1,
          type: 'P',
          strike: shortPutStrike,
          cost: -shortPutCredit * 100,
          originalString: `-1p${shortPutStrike}@${-shortPutCredit * 100}`
        },
        {
          action: 'offset',
          qty: 1,
          type: 'P',
          strike: longPutStrike,
          cost: longPutCost * 100,
          originalString: `1p${longPutStrike}@${longPutCost * 100}`
        }
      ],
      cost: -spreadCredit,
      spreadWidth: currentSpreadWidth,
      maxValue: bullPutMaxLoss,
      lockedInProfit: lockedInProfit,
      profitPotential: profitPotential,
      profitPotentialScore: profitPotentialScore,
      description: `Bull Put Spread: Short ${shortPutStrike}P @ ${shortPutCredit.toFixed(2)}, Long ${longPutStrike}P @ ${longPutCost.toFixed(2)}`
    };
  }

  /**
   * Helper function to create bear put spread object
   * Returns structured offsetting spread object
   */
  function createBearPutSpreadObject(longPutStrike, shortPutStrike, longPutCost, shortPutCost, spreadCost, currentSpreadWidth, offsetMaxValue, lockedInProfit, profitPotential, profitPotentialScore) {
    return {
      strategy: 'bear_put_spread',
      legs: [
        {
          action: 'offset',
          qty: 1,
          type: 'P',
          strike: longPutStrike,
          cost: longPutCost * 100,
          originalString: `1p${longPutStrike}@${longPutCost * 100}`
        },
        {
          action: 'offset',
          qty: -1,
          type: 'P',
          strike: shortPutStrike,
          cost: -shortPutCost * 100,
          originalString: `-1p${shortPutStrike}@${-shortPutCost * 100}`
        }
      ],
      cost: spreadCost,
      spreadWidth: currentSpreadWidth,
      maxValue: offsetMaxValue,
      lockedInProfit: lockedInProfit,
      profitPotential: profitPotential,
      profitPotentialScore: profitPotentialScore,
      description: `Bear Put Spread: Long ${longPutStrike}P @ ${longPutCost.toFixed(2)}, Short ${shortPutStrike}P @ ${shortPutCost.toFixed(2)}`
    };
  }

  /**
   * Helper function to correctly identify short and long legs using quantity
   * Returns object with shortLeg, longLeg, shortStrike, longStrike
   */
  function getShortLongLegs(position) {
    // Use qty-based leg identification
    const shortLeg = position.legs.find(leg => leg.qty < 0);
    const longLeg = position.legs.find(leg => leg.qty > 0);
    
    if (!shortLeg || !longLeg) {
      throw new Error('Position must have both short and long legs');
    }
    
    return {
      shortLeg,
      longLeg,
      shortStrike: shortLeg.strike,
      longStrike: longLeg.strike
    };
  }

  /**
   * Find offsetting Bull Call Spread positions
   */
  function findOffsettingBullCallSpread(position, chainData) {
    // console.log('🔍 SHARED: findOffsettingBullCallSpread START', {
    //   strategy: position.strategy,
    //   spreadWidth: position.spreadWidth,
    //   offsetBudget: position.offsetBudget
    // });
    
    const possibleOffsets = [];
    
    // Determine incoming position type and extract correct reference strikes
    let referenceStrike;
    let offsetBudget;
    const incomingStrategy = position.strategy;
    
    // OPTIMIZATION: Calculate shared variables once for all strategies
    const spreadWidth = position.spreadWidth || Math.abs(position.legs[0].strike - position.legs[1].strike);
    const callOptions = chainData.call || null;
    let allCallStrikes = new Set();
    const expirationStrikes = {};
    let callStrikes = [];
    const addedSpreads = new Set();
    
    // OPTIMIZATION: Validate data and transform into usable formats at the top
    // Check if call options exist
    if (!callOptions || Object.keys(callOptions).length === 0) {
      return { strategy: 'bull_call_spread', possibleOffsets: [] };
    }
    
    // Populate call strikes and expiration data
    for (const [expiration, strikes] of Object.entries(callOptions)) {
      const strikeList = Object.keys(strikes).map(strike => parseFloat(strike));
      strikeList.forEach(strike => allCallStrikes.add(strike));
      expirationStrikes[expiration] = strikes;
    }
    
    callStrikes = Array.from(allCallStrikes).sort((a, b) => b - a);
    
    if (incomingStrategy === 'bear_put_spread') {
      // =======================================================================
      // INCOMING: BEAR PUT SPREAD
      // Bear put spread = long higher strike put + short lower strike put
      // Goal: Find offsetting BULL CALL SPREAD positions
      // =======================================================================
      
      // Extract legs from incoming bear put spread using correct quantity-based logic
      const shortLongLegs = getShortLongLegs(position);
      const shortStrike = shortLongLegs.shortStrike;
      const longStrike = shortLongLegs.longStrike;
      
      // LOGIC VALIDATION: For bear put spread offset with bull call spread:
      // - Reference should be the SHORT put 
      // - This creates a "collar-like" structure where we're protected on both sides
      referenceStrike = shortStrike;
      
      // BUDGET LOGIC: For bear put spread offset with bull call spread:
      // - Bear put spread is a DEBIT spread (we paid money to enter)
      // - We can use the position's offsetBudget to buy bull call spreads
      // - Budget should be the available offsetBudget from the position
      offsetBudget = position.offsetBudget;
      
      // OPTIMIZATION: Calculate position-level variables ONCE for bear put spread
      
      console.log(`📊 BEAR PUT → BULL CALL: Reference=${referenceStrike}, Budget=${offsetBudget}`);
      console.log(`   Position strikes: Short=${shortStrike}, Long=${longStrike}`);
      
      // BEAR PUT SPREAD SPECIFIC LOGIC:
      // Incoming: Bear Put Spread = Long Higher Put + Short Lower Put
      // Example: Long 7050P + Short 7000P (debit spread, bearish)
      // 
      // We want: Bull Call Spread offsets
      // Target: Long Lower Call + Short Higher Call (debit spread, bullish)
      //
      // STRATEGY RATIONALE:
      // 1. The bear put spread profits when market goes DOWN
      // 2. The bull call spread profits when market goes UP  
      // 3. This creates opposing positions that can profit in different scenarios
      // 4. Reference strike (7000) becomes our boundary for finding call offsets
      //
      // OFFSET GENERATION LOGIC:
      // - Find call strikes AT or BELOW reference strike (7000)
      // - Long call strike must be ≤ reference strike 
      // - Short call strike must be > long call strike
      // - Spread width must be ≥ original spread width (50)
      //
      console.log(`🔍 BEAR PUT → BULL CALL: Reference strike set to ${referenceStrike} (short put leg)`);
      console.log(`   Incoming position: Long ${longStrike}P + Short ${shortStrike}P`);
      console.log(`   Will search for bull call spreads with long strike ≤ ${referenceStrike}`);
      
    } else if (incomingStrategy === 'bear_call_spread') {
      // =======================================================================
      // INCOMING: BEAR CALL SPREAD  
      // Bear call spread = short lower strike call + long higher strike call
      // Goal: Find offsetting BULL CALL SPREAD positions
      // =======================================================================
      
      // Extract legs from incoming bear call spread using correct quantity-based logic
      const shortLongLegs = getShortLongLegs(position);
      const shortStrike = shortLongLegs.shortStrike;
      const longStrike = shortLongLegs.longStrike;
      
      // LOGIC VALIDATION: For bear call spread offset with bull call spread:
      // - Reference should be the SHORT call 
      // - This creates opposing positions that can profit in different scenarios
      referenceStrike = shortStrike;
      
      // BUDGET LOGIC: For bear call spread offset with bull call spread:
      // - Bear call spread is a CREDIT spread (we received money to enter)
      // - We can use the credit received plus any additional offsetBudget to buy bull call spreads
      // - Budget should be the position's cost (negative) plus offsetBudget
      offsetBudget = position.offsetBudget;
      
      // OPTIMIZATION: Calculate position-level variables ONCE for bear call spread
      // Note: bear call spreads don't use bearPutShortStrike/bearPutLongStrike in calculations
      
      console.log(`📊 BEAR CALL → BULL CALL: Reference=${referenceStrike}, Budget=${offsetBudget}`);
      console.log(`   Position strikes: Short=${shortStrike}, Long=${longStrike}`);
      
      // BEAR CALL SPREAD SPECIFIC LOGIC:
      // Incoming: Bear Call Spread = Short Lower Call + Long Higher Call
      // Example: Short 7000C + Long 7050C (credit spread, bearish)
      //
      // We want: Bull Call Spread offsets
      // Target: Long Lower Call + Short Higher Call (debit spread, bullish)
      //
      // STRATEGY RATIONALE:
      // 1. The bear call spread profits when market goes DOWN (or stays flat)
      // 2. The bull call spread profits when market goes UP
      // 3. This creates opposing positions that can profit in different scenarios
      // 4. Reference strike (7000) becomes our boundary for finding call offsets
      //
      // OFFSET GENERATION LOGIC:
      // - Find call strikes AT or BELOW reference strike (7000)
      // - Long call strike must be ≤ reference strike
      // - Short call strike must be > long call strike
      // - Spread width must be ≥ original spread width (50)
      //
      console.log(`🔍 BEAR CALL → BULL CALL: Reference strike set to ${referenceStrike} (short call leg)`);
      console.log(`   Incoming position: Short ${shortStrike}C + Long ${longStrike}C`);
      console.log(`   Will search for bull call spreads with long strike ≤ ${referenceStrike}`);
      
    } else {
      // =======================================================================
      // INVALID STRATEGY - ONLY BEAR STRATEGIES SHOULD OFFSET TO BULL CALLS
      // =======================================================================
      console.log(`⚠️  INVALID STRATEGY: ${incomingStrategy} - only bear_put_spread or bear_call_spread can offset to bull_call_spread`);
      return { strategy: 'bull_call_spread', possibleOffsets: [] };
    }
    
    // Data validation and transformation already handled at the top of the function
    
    // Single unified loop: for each long strike, test all possible short strikes (original width and wider)
    for (const longCallStrike of callStrikes) {
      // =======================================================================
      // KEY VALIDATION: This implements our bear put spread offset strategy
      // =======================================================================
      // For BEAR PUT → BULL CALL offsets:
      // - We only consider long call strikes AT or BELOW the reference strike
      // - Reference strike = short put leg (e.g., 7000)
      // - This ensures long call strike ≤ 7000, creating proper bullish offset
      // =======================================================================
      
      // Use helper function to validate strike and check market data availability
      if (!isValidLongCallStrike(longCallStrike, referenceStrike, expirationStrikes)) {
        continue;
      }
      
      // Get long call data using helper function
      const longCallStrikeData = getStrikeData(longCallStrike, callStrikes, expirationStrikes);
      if (!longCallStrikeData) {
        continue; // Should not happen since validation already passed
      }
      
      const longCallData = longCallStrikeData.data;
      const longCallCost = longCallStrikeData.cost;
      const longCallStrikeIndex = longCallStrikeData.index;
      
      // Test all possible short strikes starting from original width and going wider
      for (let i = longCallStrikeIndex - 1; i >= 0; i--) {
        const shortCallStrike = callStrikes[i];
        const currentSpreadWidth = shortCallStrike - longCallStrike;
        const spreadKey = `${longCallStrike}-${shortCallStrike}`;
        
        // Use helper function to validate spread creation
        if (!isValidShortCallForSpread(shortCallStrike, longCallStrike, currentSpreadWidth, spreadWidth, spreadKey, addedSpreads, expirationStrikes)) {
          continue;
        }
        
        // Get short call data using helper function
        const shortCallStrikeData = getStrikeData(shortCallStrike, callStrikes, expirationStrikes);
        if (!shortCallStrikeData) {
          continue; // Should not happen since validation already passed
        }
        
        const shortCallData = shortCallStrikeData.data;
        const shortCallCost = shortCallStrikeData.cost;
        const spreadCost = (longCallCost - shortCallCost) * 100;
        
        // OPTIMIZATION: Move budget validation and offset calculation higher up
        // console.log(`🔍 SHARED: Spread ${longCallStrike}-${shortCallStrike}: cost=$${spreadCost.toFixed(2)}, budget=$${offsetBudget}`);
        
        if (spreadCost > offsetBudget) {
          // console.log(`🔍 SHARED: Spread cost $${spreadCost.toFixed(2)} > budget $${offsetBudget} - SKIPPING`);
          continue;
        }
        
        // console.log(`🔍 SHARED: Spread ${longCallStrike}-${shortCallStrike} passed budget check, calculating locked profit...`);
        
        const offsetMaxValue = currentSpreadWidth * 100;
        
        // Create offsetting position object
        const offsettingPosition = {
          cost: spreadCost,
          maxValue: offsetMaxValue,
          strategy: 'bull_call_spread',
          legs: [
            { strike: longCallStrike, qty: 1, type: 'C' },  // long leg (bought)
            { strike: shortCallStrike, qty: -1, type: 'C' }  // short leg (sold)
          ]
        };
        
        // OPTIMIZATION: Use helper function to calculate profit metrics
        const profitMetrics = calculateBullCallProfitMetrics(position, offsettingPosition);
        
        const { lockedInProfit, profitPotential, profitPotentialScore } = profitMetrics;
        
        if (lockedInProfit < 0) {
          continue;
        }
        
        // OPTIMIZATION: Use helper function to create offsetting spread object
        const offsettingSpread = createBullCallSpreadObject(
          longCallStrike, shortCallStrike, longCallCost, shortCallCost, spreadCost, currentSpreadWidth, offsetMaxValue, lockedInProfit, profitPotential, profitPotentialScore
        );
        
        possibleOffsets.push(offsettingSpread);
        addedSpreads.add(spreadKey);
      }
    }
    
    return { strategy: 'bull_call_spread', possibleOffsets };
  }

  /**
   * Find offsetting Bear Call Spread positions
   */
  function findOffsettingBearCallSpread(position, chainData) {
    // console.log('🔍 DEBUG findOffsettingBearCallSpread: Starting with position', {
    //   strategy: position.strategy,
    //   offsetBudget: position.offsetBudget
    // });
    
    const possibleOffsets = [];
    
    // Determine incoming position type and extract correct reference strikes
    let referenceStrike;
    let offsetBudget;
    const incomingStrategy = position.strategy;
    
    // OPTIMIZATION: Calculate shared variables once for all strategies
    const spreadWidth = position.spreadWidth || Math.abs(position.legs[0].strike - position.legs[1].strike);
    const callOptions = chainData.call || null;
    let allCallStrikes = new Set();
    const expirationStrikes = {};
    let callStrikes = [];
    const addedSpreads = new Set();
    
    // OPTIMIZATION: Calculate position-level variables ONCE instead of repeating in loops
    const isBullCallSpread = incomingStrategy === 'bull_call_spread';
    const isBullPutSpread = incomingStrategy === 'bull_put_spread';
    
    // OPTIMIZATION: Validate data and transform into usable formats at the top
    // Check if call options exist
    if (!callOptions || Object.keys(callOptions).length === 0) {
      return { strategy: 'bear_call_spread', possibleOffsets: [] };
    }
    
    // Populate call strikes and expiration data
    for (const [expiration, strikes] of Object.entries(callOptions)) {
      const strikeList = Object.keys(strikes).map(strike => parseFloat(strike));
      strikeList.forEach(strike => allCallStrikes.add(strike));
      expirationStrikes[expiration] = strikes;
    }
    
    callStrikes = Array.from(allCallStrikes).sort((a, b) => a - b);
    
    if (incomingStrategy === 'bull_call_spread') {
      // =======================================================================
      // INCOMING: BULL CALL SPREAD
      // Bull call spread = long lower strike call + short higher strike call
      // Goal: Find offsetting BEAR CALL SPREAD positions
      // =======================================================================
      
      // Extract legs from incoming bull call spread using correct quantity-based logic
      const shortLongLegs = getShortLongLegs(position);
      const shortStrike = shortLongLegs.shortStrike;
      const longStrike = shortLongLegs.longStrike;
      
      // LOGIC VALIDATION: For bull call spread offset with bear call spread:
      // - Reference should be the SHORT call 
      // - This creates opposing positions that can profit in different scenarios
      referenceStrike = shortStrike;
      
      // BUDGET LOGIC: For bull call spread offset with bear call spread:
      // - Bull call spread is a DEBIT spread (we paid money to enter)
      // - We can use the position's offsetBudget to sell bear call spreads (generate credit)
      // - Budget should be the available offsetBudget from the position
      offsetBudget = position.offsetBudget;
      
      // BULL CALL SPREAD SPECIFIC LOGIC:
      // Incoming: Bull Call Spread = Long Lower Call + Short Higher Call
      // Example: Long 7000C + Short 7050C (debit spread, bullish)
      //
      // We want: Bear Call Spread offsets
      // Target: Short Lower Call + Long Higher Call (credit spread, bearish)
      //
      // STRATEGY RATIONALE:
      // 1. The bull call spread profits when market goes UP
      // 2. The bear call spread profits when market goes DOWN (or stays flat)
      // 3. This creates opposing positions that can profit in different scenarios
      // 4. Reference strike (7050) becomes our boundary for finding call offsets
      //
      // OFFSET GENERATION LOGIC:
      // - Find call strikes AT or ABOVE reference strike (7050)
      // - Short call strike must be ≥ reference strike
      // - Long call strike must be > short call strike
      // - Spread width must be ≥ original spread width (50)
      //
      console.log(`🔍 BULL CALL → BEAR CALL: Reference strike set to ${referenceStrike} (short call leg)`);
      console.log(`   Incoming position: Long ${longStrike}C + Short ${shortStrike}C`);
      console.log(`   Will search for bear call spreads with short strike ≥ ${referenceStrike}`);
      
    } else if (incomingStrategy === 'bull_put_spread') {
      // =======================================================================
      // INCOMING: BULL PUT SPREAD
      // Bull put spread = short higher strike put + long lower strike put
      // Goal: Find offsetting BEAR CALL SPREAD positions
      // =======================================================================
      
      // Extract legs from incoming bull put spread using correct quantity-based logic
      const shortLongLegs = getShortLongLegs(position);
      const shortStrike = shortLongLegs.shortStrike;
      const longStrike = shortLongLegs.longStrike;
      
      // LOGIC VALIDATION: For bull put spread offset with bear call spread:
      // - Reference should be the SHORT put 
      // - This creates opposing positions that can profit in different scenarios
      referenceStrike = shortStrike;
      
      // BUDGET LOGIC: For bull put spread offset with bear call spread:
      // - Bull put spread is a CREDIT spread (we received money to enter)
      // - We can use the credit received plus any additional offsetBudget to sell bear call spreads
      // - Budget should be the position's cost (negative) plus offsetBudget
      offsetBudget = position.offsetBudget;
      
      // BULL PUT SPREAD SPECIFIC LOGIC:
      // Incoming: Bull Put Spread = Short Higher Put + Long Lower Put
      // Example: Short 7050P + Long 7000P (credit spread, bullish)
      //
      // We want: Bear Call Spread offsets
      // Target: Short Lower Call + Long Higher Call (credit spread, bearish)
      //
      // STRATEGY RATIONALE:
      // 1. The bull put spread profits when market goes UP (or stays flat)
      // 2. The bear call spread profits when market goes DOWN (or stays flat)
      // 3. This creates opposing positions that can profit in different scenarios
      // 4. Reference strike (7050) becomes our boundary for finding call offsets
      //
      // OFFSET GENERATION LOGIC:
      // - Find call strikes AT or ABOVE reference strike (7050)
      // - Short call strike must be ≥ reference strike
      // - Long call strike must be > short call strike
      // - Spread width must be ≥ original spread width (50)
      //
      console.log(`🔍 BULL PUT → BEAR CALL: Reference strike set to ${referenceStrike} (short put leg)`);
      console.log(`   Incoming position: Short ${shortStrike}P + Long ${longStrike}P`);
      console.log(`   Will search for bear call spreads with short strike ≥ ${referenceStrike}`);
      
    } else {
      // =======================================================================
      // INVALID STRATEGY - ONLY BULL STRATEGIES SHOULD OFFSET TO BEAR CALLS
      // =======================================================================
      console.log(`⚠️  INVALID STRATEGY: ${incomingStrategy} - only bull_call_spread or bull_put_spread can offset to bear_call_spread`);
      return { strategy: 'bear_call_spread', possibleOffsets: [] };
    }
    
    // Data validation and transformation already handled at the top of the function
    
    // Single unified loop: for each short strike, test all possible long strikes (original width and wider)
    for (const shortLowerCallStrike of callStrikes) {
      // Use helper function to validate strike and check market data availability
      if (!isValidShortCallStrike(shortLowerCallStrike, referenceStrike, expirationStrikes)) {
        continue;
      }
      
      // Get short call data using helper function
      const shortLowerCallStrikeData = getStrikeData(shortLowerCallStrike, callStrikes, expirationStrikes);
      if (!shortLowerCallStrikeData) {
        continue; // Should not happen since validation already passed
      }
      
      const shortLowerCallData = shortLowerCallStrikeData.data;
      const shortLowerCallCredit = shortLowerCallStrikeData.cost;
      const shortLowerCallStrikeIndex = shortLowerCallStrikeData.index;
      
      // Test all possible long strikes starting from original width and going wider
      for (let i = shortLowerCallStrikeIndex + 1; i < callStrikes.length; i++) {
        const longHigherCallStrike = callStrikes[i];
        const currentSpreadWidth = longHigherCallStrike - shortLowerCallStrike;
        const spreadKey = `${shortLowerCallStrike}-${longHigherCallStrike}`;
        
        // Use helper function to validate spread creation
        if (!isValidLongCallForBearSpread(shortLowerCallStrike, longHigherCallStrike, currentSpreadWidth, spreadWidth, spreadKey, addedSpreads, expirationStrikes)) {
          continue;
        }
        
        // Get long call data using helper function
        const longHigherCallStrikeData = getStrikeData(longHigherCallStrike, callStrikes, expirationStrikes);
        if (!longHigherCallStrikeData) {
          continue; // Should not happen since validation already passed
        }
        
        const longHigherCallData = longHigherCallStrikeData.data;
        const longHigherCallCost = longHigherCallStrikeData.cost;
        const spreadCredit = (shortLowerCallCredit - longHigherCallCost) * 100;
        
        if (spreadCredit <= 0) {
          continue;
        }
        
        const offsetMaxValue = -(currentSpreadWidth * 100);
        
        // Create offsetting position object
        const offsettingPosition = {
          cost: -spreadCredit,  // Bear call spread receives credit, so cost is negative
          maxValue: offsetMaxValue,
          strategy: 'bear_call_spread',
          legs: [
            { strike: shortLowerCallStrike, qty: -1, type: 'C' },  // short leg (sold)
            { strike: longHigherCallStrike, qty: 1, type: 'C' }    // long leg (bought)
          ]
        };
        
        // OPTIMIZATION: Use helper function to calculate profit metrics
        const profitMetrics = calculateBearCallProfitMetrics(position, offsettingPosition);
        
        const { lockedInProfit, profitPotential, profitPotentialScore } = profitMetrics;
        
        // console.log(`🔍 SHARED: Spread ${longCallStrike}-${shortCallStrike}: lockedInProfit=$${lockedInProfit.toFixed(2)}, profitPotential=$${profitPotential.toFixed(2)}`);
        
        if (lockedInProfit < 0) {
          // console.log(`🔍 BEAR CALL: Skipping spread ${shortLowerCallStrike}-${longHigherCallStrike} due to negative locked profit: $${lockedInProfit.toFixed(2)}`);
          continue;
        }
        
        // OPTIMIZATION: Use helper function to create offsetting spread object
        const offsettingSpread = createBearCallSpreadObject(
          shortLowerCallStrike, longHigherCallStrike, shortLowerCallCredit, longHigherCallCost, spreadCredit, currentSpreadWidth, offsetMaxValue, lockedInProfit, profitPotential, profitPotentialScore
        );
        
        possibleOffsets.push(offsettingSpread);
        addedSpreads.add(spreadKey);
      }
    }
    
    return { strategy: 'bear_call_spread', possibleOffsets };
  }

  /**
   * Find offsetting Bull Put Spread positions
   */
  function findOffsettingBullPutSpread(position, chainData) {
    const possibleOffsets = [];
    
    // Determine incoming position type and extract correct reference strikes
    let referenceStrike;
    let offsetBudget;
    const incomingStrategy = position.strategy;
    
    // OPTIMIZATION: Calculate shared variables once for all strategies
    const spreadWidth = position.spreadWidth || Math.abs(position.legs[0].strike - position.legs[1].strike);
    const putOptions = chainData.put || null;
    let allPutStrikes = new Set();
    const expirationStrikes = {};
    let putStrikes = [];
    const addedSpreads = new Set();
    
    // OPTIMIZATION: Calculate position-level variables ONCE instead of repeating in loops
    const isBearPutSpread = incomingStrategy === 'bear_put_spread';
    const isBearCallSpread = incomingStrategy === 'bear_call_spread';
    
    // OPTIMIZATION: Validate data and transform into usable formats at the top
    // Check if put options exist
    if (!putOptions || Object.keys(putOptions).length === 0) {
      return { strategy: 'bull_put_spread', possibleOffsets: [] };
    }
    
    // Populate put strikes and expiration data
    for (const [expiration, strikes] of Object.entries(putOptions)) {
      const strikeList = Object.keys(strikes).map(strike => parseFloat(strike));
      strikeList.forEach(strike => allPutStrikes.add(strike));
      expirationStrikes[expiration] = strikes;
    }
    
    putStrikes = Array.from(allPutStrikes).sort((a, b) => b - a);
    
    if (incomingStrategy === 'bear_put_spread') {
      // =======================================================================
      // INCOMING: BEAR PUT SPREAD
      // Bear put spread = long higher strike put + short lower strike put
      // Goal: Find offsetting BULL PUT SPREAD positions
      // =======================================================================
      
      // Extract legs from incoming bear put spread using correct quantity-based logic
      const shortLongLegs = getShortLongLegs(position);
      const shortStrike = shortLongLegs.shortStrike;
      const longStrike = shortLongLegs.longStrike;
      
      // LOGIC VALIDATION: For bear put spread offset with bull put spread:
      // - Reference should be the LONG put 
      // - This creates opposing positions that can profit in different scenarios
      referenceStrike = longStrike;
      
      // BUDGET LOGIC: For bear put spread offset with bull put spread:
      // - Bear put spread is a DEBIT spread (we paid money to enter)
      // - We can use the position's offsetBudget to sell bull put spreads (generate credit)
      // - Budget should be the available offsetBudget from the position
      offsetBudget = position.offsetBudget;
      
      // BEAR PUT SPREAD SPECIFIC LOGIC:
      // Incoming: Bear Put Spread = Long Higher Put + Short Lower Put
      // Example: Long 7050P + Short 7000P (debit spread, bearish)
      //
      // We want: Bull Put Spread offsets
      // Target: Short Higher Put + Long Lower Put (credit spread, bullish)
      //
      // STRATEGY RATIONALE:
      // 1. The bear put spread profits when market goes DOWN
      // 2. The bull put spread profits when market goes UP (or stays flat)
      // 3. This creates opposing positions that can profit in different scenarios
      // 4. Reference strike (7050) becomes our boundary for finding put offsets
      //
      // OFFSET GENERATION LOGIC:
      // - Find put strikes AT or BELOW reference strike (7050)
      // - Short put strike must be ≤ reference strike
      // - Long put strike must be < short put strike
      // - Spread width must be ≥ original spread width (50)
      //
      console.log(`🔍 BEAR PUT → BULL PUT: Reference strike set to ${referenceStrike} (long put leg)`);
      console.log(`   Incoming position: Long ${longStrike}P + Short ${shortStrike}P`);
      console.log(`   Will search for bull put spreads with short strike ≤ ${referenceStrike}`);
      
    } else if (incomingStrategy === 'bear_call_spread') {
      // =======================================================================
      // INCOMING: BEAR CALL SPREAD
      // Bear call spread = short lower strike call + long higher strike call
      // Goal: Find offsetting BULL PUT SPREAD positions
      // =======================================================================
      
      // Extract legs from incoming bear call spread using correct quantity-based logic
      const shortLongLegs = getShortLongLegs(position);
      const shortStrike = shortLongLegs.shortStrike;
      const longStrike = shortLongLegs.longStrike;
      
      // LOGIC VALIDATION: For bear call spread offset with bull put spread:
      // - Reference should be the LONG call 
      // - This creates opposing positions that can profit in different scenarios
      referenceStrike = longStrike;
      
      // BUDGET LOGIC: For bear call spread offset with bull put spread:
      // - Bear call spread is a CREDIT spread (we received money to enter)
      // - We can use the credit received plus any additional offsetBudget to sell bull put spreads
      // - Budget should be the position's cost (negative) plus offsetBudget
      offsetBudget = position.offsetBudget;
      
      // BEAR CALL SPREAD SPECIFIC LOGIC:
      // Incoming: Bear Call Spread = Short Lower Call + Long Higher Call
      // Example: Short 7000C + Long 7050C (credit spread, bearish)
      //
      // We want: Bull Put Spread offsets
      // Target: Short Higher Put + Long Lower Put (credit spread, bullish)
      //
      // STRATEGY RATIONALE:
      // 1. The bear call spread profits when market goes DOWN (or stays flat)
      // 2. The bull put spread profits when market goes UP (or stays flat)
      // 3. This creates opposing positions that can profit in different scenarios
      // 4. Reference strike (7050) becomes our boundary for finding put offsets
      //
      // OFFSET GENERATION LOGIC:
      // - Find put strikes AT or BELOW reference strike (7050)
      // - Short put strike must be ≤ reference strike
      // - Long put strike must be < short put strike
      // - Spread width must be ≥ original spread width (50)
      //
      console.log(`🔍 BEAR CALL → BULL PUT: Reference strike set to ${referenceStrike} (long call leg)`);
      console.log(`   Incoming position: Short ${shortStrike}C + Long ${longStrike}C`);
      console.log(`   Will search for bull put spreads with short strike ≤ ${referenceStrike}`);
      
    } else {
      // =======================================================================
      // INVALID STRATEGY - ONLY BEAR STRATEGIES SHOULD OFFSET TO BULL PUTS
      // =======================================================================
      console.log(`⚠️  INVALID STRATEGY: ${incomingStrategy} - only bear_put_spread or bear_call_spread can offset to bull_put_spread`);
      return { strategy: 'bull_put_spread', possibleOffsets: [] };
    }
    
    // Data validation and transformation already handled at the top of the function
    
    // Single unified loop: for each short strike, test all possible long strikes (original width and wider)
    for (const shortHigherPutStrike of putStrikes) {
      // console.log(`🔍 BULL PUT: Testing shortHigherPutStrike ${shortHigherPutStrike} vs referenceStrike ${referenceStrike}`);
      
      // Use helper function to validate strike and check market data availability
      if (!isValidShortPutStrike(shortHigherPutStrike, referenceStrike, expirationStrikes)) {
        continue;
      }
      
      // Get short put data using helper function
      const shortHigherPutStrikeData = getStrikeData(shortHigherPutStrike, putStrikes, expirationStrikes);
      if (!shortHigherPutStrikeData) {
        continue; // Should not happen since validation already passed
      }
      
      const shortHigherPutData = shortHigherPutStrikeData.data;
      const shortHigherPutCredit = shortHigherPutStrikeData.cost;
      const shortHigherPutStrikeIndex = shortHigherPutStrikeData.index;
      
      // Test all possible long strikes starting from original width and going wider
      for (let i = shortHigherPutStrikeIndex + 1; i < putStrikes.length; i++) {
        const longLowerPutStrike = putStrikes[i];
        const currentSpreadWidth = shortHigherPutStrike - longLowerPutStrike;
        const spreadKey = `${shortHigherPutStrike}-${longLowerPutStrike}`;
        // console.log(`🔍 BULL PUT: Trying spread ${shortHigherPutStrike}-${longLowerPutStrike}`);
        
        // Use helper function to validate spread creation
        if (!isValidLongPutForBullSpread(shortHigherPutStrike, longLowerPutStrike, currentSpreadWidth, spreadWidth, spreadKey, addedSpreads, expirationStrikes)) {
          continue;
        }
        
        // Get long put data using helper function
        const longLowerPutStrikeData = getStrikeData(longLowerPutStrike, putStrikes, expirationStrikes);
        if (!longLowerPutStrikeData) {
          continue; // Should not happen since validation already passed
        }
        
        const longLowerPutData = longLowerPutStrikeData.data;
        const longLowerPutCost = longLowerPutStrikeData.cost;
        const spreadCredit = (shortHigherPutCredit - longLowerPutCost) * 100;
      
        // console.log(`🔍 BULL PUT: Spread ${shortHigherPutStrike}-${longLowerPutStrike}: credit=$${spreadCredit.toFixed(2)}, budget=$${offsetBudget}`);
        
        if (spreadCredit <= 0) {
          // console.log(`🔍 BULL PUT: Spread credit $${spreadCredit.toFixed(2)} <= 0 - SKIPPING`);
          continue;
        }
        
        // For credit spreads, we want the credit to be within our budget
        // Reject if the credit required is MORE than our budget
        if (spreadCredit > offsetBudget) {
          // console.log(`🔍 BULL PUT: Spread credit $${spreadCredit.toFixed(2)} > budget $${offsetBudget} - EXCEEDS BUDGET`);
          continue;
        }
        
        const bullPutMaxLoss = -(currentSpreadWidth * 100);
        
        // Create offsetting position object
        const offsettingPosition = {
          cost: -spreadCredit,  // Bull put spread receives credit, so cost is negative
          maxValue: bullPutMaxLoss,
          strategy: 'bull_put_spread',
          legs: [
            { strike: shortHigherPutStrike, qty: -1, type: 'P' },  // short leg (sold)
            { strike: longLowerPutStrike, qty: 1, type: 'P' }      // long leg (bought)
          ]
        };
        
        // OPTIMIZATION: Use helper function to calculate profit metrics
        const profitMetrics = calculateBullPutProfitMetrics(position, offsettingPosition);
        
        const { lockedInProfit, profitPotential, profitPotentialScore } = profitMetrics;
        
        if (lockedInProfit < 0) {
          continue;
        }
        
        // OPTIMIZATION: Use helper function to create offsetting spread object
        const offsettingSpread = createBullPutSpreadObject(
          shortHigherPutStrike, longLowerPutStrike, shortHigherPutCredit, longLowerPutCost, spreadCredit, currentSpreadWidth, bullPutMaxLoss, lockedInProfit, profitPotential, profitPotentialScore
        );
        
        possibleOffsets.push(offsettingSpread);
        addedSpreads.add(spreadKey);
      }
    }
    
    return { strategy: 'bull_put_spread', possibleOffsets };
  }

  /**
   * Find offsetting Bear Put Spread positions
   */
  function findOffsettingBearPutSpread(position, chainData) {
    const possibleOffsets = [];
    
    // Determine incoming position type and extract correct reference strikes
    let referenceStrike;
    let offsetBudget;
    const incomingStrategy = position.strategy;
    
    // OPTIMIZATION: Calculate shared variables once for all strategies
    const spreadWidth = position.spreadWidth || Math.abs(position.legs[0].strike - position.legs[1].strike);
    const putOptions = chainData.put || null;
    let allPutStrikes = new Set();
    const expirationStrikes = {};
    let putStrikes = [];
    const addedSpreads = new Set();
    
    // OPTIMIZATION: Calculate position-level variables ONCE instead of repeating in loops
    const isBullCallSpread = incomingStrategy === 'bull_call_spread';
    const isBullPutSpread = incomingStrategy === 'bull_put_spread';
    
        
    // OPTIMIZATION: Validate data and transform into usable formats at the top
    // Check if put options exist
    if (!putOptions || Object.keys(putOptions).length === 0) {
      return { strategy: 'bear_put_spread', possibleOffsets: [] };
    }
    
    // Populate put strikes and expiration data
    for (const [expiration, strikes] of Object.entries(putOptions)) {
      const strikeList = Object.keys(strikes).map(strike => parseFloat(strike));
      strikeList.forEach(strike => allPutStrikes.add(strike));
      expirationStrikes[expiration] = strikes;
    }
    
    putStrikes = Array.from(allPutStrikes).sort((a, b) => a - b);
    
    if (incomingStrategy === 'bull_call_spread') {
      // =======================================================================
      // INCOMING: BULL CALL SPREAD
      // Bull call spread = long lower strike call + short higher strike call
      // Goal: Find offsetting BEAR PUT SPREAD positions
      // =======================================================================
      
      // Extract legs from incoming bull call spread using correct quantity-based logic
      const shortLongLegs = getShortLongLegs(position);
      const shortStrike = shortLongLegs.shortStrike;
      const longStrike = shortLongLegs.longStrike;
      
      // LOGIC VALIDATION: For bull call spread offset with bear put spread:
      // - Reference should be the LONG call 
      // - This creates opposing positions that can profit in different scenarios
      referenceStrike = longStrike;
      
      // BUDGET LOGIC: For bull call spread offset with bear put spread:
      // - Bull call spread is a DEBIT spread (we paid money to enter)
      // - We can use the position's offsetBudget to buy bear put spreads
      // - Budget should be the available offsetBudget from the position
      offsetBudget = position.offsetBudget;
      
      // BULL CALL SPREAD SPECIFIC LOGIC:
      // Incoming: Bull Call Spread = Long Lower Call + Short Higher Call
      // Example: Long 7000C + Short 7050C (debit spread, bullish)
      //
      // We want: Bear Put Spread offsets
      // Target: Long Higher Put + Short Lower Put (debit spread, bearish)
      //
      // STRATEGY RATIONALE:
      // 1. The bull call spread profits when market goes UP
      // 2. The bear put spread profits when market goes DOWN
      // 3. This creates opposing positions that can profit in different scenarios
      // 4. Reference strike (7000) becomes our boundary for finding put offsets
      //
      // OFFSET GENERATION LOGIC:
      // - Find put strikes AT or ABOVE reference strike (7000)
      // - Long put strike must be ≥ reference strike
      // - Short put strike must be < long put strike
      // - Spread width must be ≥ original spread width (50)
      //
      console.log(`🔍 BULL CALL → BEAR PUT: Reference strike set to ${referenceStrike} (long call leg)`);
      console.log(`   Incoming position: Long ${longStrike}C + Short ${shortStrike}C`);
      console.log(`   Will search for bear put spreads with long strike ≥ ${referenceStrike}`);
      
    } else if (incomingStrategy === 'bull_put_spread') {
      // =======================================================================
      // INCOMING: BULL PUT SPREAD
      // Bull put spread = short higher strike put + long lower strike put
      // Goal: Find offsetting BEAR PUT SPREAD positions
      // =======================================================================
      
      // Extract legs from incoming bull put spread using correct quantity-based logic
      const shortLongLegs = getShortLongLegs(position);
      const shortStrike = shortLongLegs.shortStrike;
      const longStrike = shortLongLegs.longStrike;
      
      // LOGIC VALIDATION: For bull put spread offset with bear put spread:
      // - Reference should be the LONG put 
      // - This creates opposing positions that can profit in different scenarios
      referenceStrike = longStrike;
      
      // BUDGET LOGIC: For bull put spread offset with bear put spread:
      // - Bull put spread is a CREDIT spread (we received money to enter)
      // - We can use the credit received plus any additional offsetBudget to buy bear put spreads
      // - Budget should be the position's cost (negative) plus offsetBudget
      offsetBudget = position.offsetBudget;
      
      // BULL PUT SPREAD SPECIFIC LOGIC:
      // Incoming: Bull Put Spread = Short Higher Put + Long Lower Put
      // Example: Short 7050P + Long 7000P (credit spread, bullish)
      //
      // We want: Bear Put Spread offsets
      // Target: Long Higher Put + Short Lower Put (debit spread, bearish)
      //
      // STRATEGY RATIONALE:
      // 1. The bull put spread profits when market goes UP (or stays flat)
      // 2. The bear put spread profits when market goes DOWN
      // 3. This creates opposing positions that can profit in different scenarios
      // 4. Reference strike (7000) becomes our boundary for finding put offsets
      //
      // OFFSET GENERATION LOGIC:
      // - Find put strikes AT or ABOVE reference strike (7000)
      // - Long put strike must be ≥ reference strike
      // - Short put strike must be < long put strike
      // - Spread width must be ≥ original spread width (50)
      //
      console.log(`🔍 BULL PUT → BEAR PUT: Reference strike set to ${referenceStrike} (long put leg)`);
      console.log(`   Incoming position: Short ${shortStrike}P + Long ${longStrike}P`);
      console.log(`   Will search for bear put spreads with long strike ≥ ${referenceStrike}`);
      
    } else {
      // =======================================================================
      // INVALID STRATEGY - ONLY BULL STRATEGIES SHOULD OFFSET TO BEAR PUTS
      // =======================================================================
      console.log(`⚠️  INVALID STRATEGY: ${incomingStrategy} - only bull_call_spread or bull_put_spread can offset to bear_put_spread`);
      return { strategy: 'bear_put_spread', possibleOffsets: [] };
    }
    
    // console.log(`🔍 BEAR PUT: findOffsettingBearPutSpread START {strategy: '${position.strategy}', referenceStrike: ${referenceStrike}, spreadWidth: ${spreadWidth}, offsetBudget: ${offsetBudget}}`);
        
    // Data validation and transformation already handled at the top of the function
    
    // console.log(`🔍 BEAR PUT: Testing ${putStrikes.length} put strikes`);
    
    // Single unified loop: for each short strike, test all possible long strikes (original width and wider)
    for (const shortPutStrike of putStrikes) {
      // console.log(`🔍 BEAR PUT: Testing shortPutStrike ${shortPutStrike} vs referenceStrike ${referenceStrike}`);
      
      // Use helper function to validate strike and check market data availability
      if (!isValidShortPutStrikeForBear(shortPutStrike, referenceStrike, expirationStrikes)) {
        continue;
      }
      
      // Get short put data using helper function
      const shortPutStrikeData = getStrikeData(shortPutStrike, putStrikes, expirationStrikes);
      if (!shortPutStrikeData) {
        continue; // Should not happen since validation already passed
      }
      
      const shortPutData = shortPutStrikeData.data;
      const shortPutCost = shortPutStrikeData.cost;
      const shortPutStrikeIndex = shortPutStrikeData.index;
      
      // Test all possible long strikes starting from original width and going wider
      for (let i = shortPutStrikeIndex + 1; i < putStrikes.length; i++) {
        const longPutStrike = putStrikes[i];
        const currentSpreadWidth = longPutStrike - shortPutStrike;
        const spreadKey = `${longPutStrike}-${shortPutStrike}`;
        
        // Use helper function to validate spread creation
        if (!isValidLongPutForBearSpread(shortPutStrike, longPutStrike, currentSpreadWidth, spreadWidth, spreadKey, addedSpreads, expirationStrikes)) {
          continue;
        }
        
        // Get long put data using helper function
        const longPutStrikeData = getStrikeData(longPutStrike, putStrikes, expirationStrikes);
        if (!longPutStrikeData) {
          continue; // Should not happen since validation already passed
        }
        
        const longPutData = longPutStrikeData.data;
        const longPutCost = longPutStrikeData.cost;
        const spreadCost = (longPutCost - shortPutCost) * 100;
      
        // console.log(`🔍 BEAR PUT: Spread ${longPutStrike}-${shortPutStrike}: cost=$${spreadCost.toFixed(2)}, budget=$${offsetBudget}`);
        
        if (spreadCost > offsetBudget) {
          // console.log(`🔍 BEAR PUT: Spread cost $${spreadCost.toFixed(2)} > budget $${offsetBudget} - SKIPPING`);
          continue;
        }
        
        const offsetMaxValue = currentSpreadWidth * 100;
        
        // Create offsetting position object
        const offsettingPosition = {
          cost: spreadCost,
          maxValue: offsetMaxValue,
          strategy: 'bear_put_spread',
          legs: [
            { strike: longPutStrike, qty: 1, type: 'P' },   // long leg (bought)
            { strike: shortPutStrike, qty: -1, type: 'P' }  // short leg (sold)
          ]
        };
        
        // OPTIMIZATION: Use helper function to calculate profit metrics
        const profitMetrics = calculateBearPutProfitMetrics(position, offsettingPosition);
        
        const { lockedInProfit, profitPotential, profitPotentialScore } = profitMetrics;
        
        if (lockedInProfit < 0) {
          continue;
        }
        
        // OPTIMIZATION: Use helper function to create offsetting spread object
        const offsettingSpread = createBearPutSpreadObject(
          longPutStrike, shortPutStrike, longPutCost, shortPutCost, spreadCost, currentSpreadWidth, offsetMaxValue, lockedInProfit, profitPotential, profitPotentialScore
        );
        
        possibleOffsets.push(offsettingSpread);
        addedSpreads.add(spreadKey);
      }
    }
    
    return { strategy: 'bear_put_spread', possibleOffsets };
  }

  // Export functions for both environments
  const OffsetCalculations = {
    sortOffsettingPositions,
    aggregateOffsettingResults,
    findOffsettingBullCallSpread,
    findOffsettingBearCallSpread,
    findOffsettingBullPutSpread,
    findOffsettingBearPutSpread,
    // Export profit metrics calculation functions for use in selected-offset-analyzer
    calculateBullCallProfitMetrics,
    calculateBearCallProfitMetrics,
    calculateBullPutProfitMetrics,
    calculateBearPutProfitMetrics
  };

  // Node.js / CommonJS
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = OffsetCalculations;
  }
  
  // Browser / Global
  if (typeof window !== 'undefined') {
    window.OffsetCalculations = OffsetCalculations;
  }
  
  // Generic global
  if (typeof global !== 'undefined') {
    global.OffsetCalculations = OffsetCalculations;
  }

})(typeof window !== 'undefined' ? window : typeof global !== 'undefined' ? global : this);
