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
    
    return {
      data: marketData,
      cost: (marketData.bid + marketData.ask) / 2,
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
    const longCallStrike = offsetLegs.longStrike;
    const shortCallStrike = offsetLegs.shortStrike;
    
    // Determine position strategy
    const isBearPutSpread = position.strategy === 'bear_put_spread';
    const isBearCallSpread = position.strategy === 'bear_call_spread';
    
    if (isBearPutSpread) {
      const totalCost = position.cost + spreadCost;
      
      const bullCallLongStrike = longCallStrike;
      const bullCallShortStrike = shortCallStrike;
      
      // Calculate bear put strikes using quantity-based logic
      const shortLongLegs = getShortLongLegs(position);
      const bearPutShortStrike = shortLongLegs.shortStrike;
      const bearPutLongStrike = shortLongLegs.longStrike;
      
      // Check if strikes overlap in a way where both can be worthless
      // Bear put is worthless above bearPutLongStrike
      // Bull call is worthless below bullCallLongStrike
      // If bullCallLongStrike >= bearPutLongStrike, there's a gap where both are worthless
      if (bullCallLongStrike >= bearPutLongStrike) {
        // Both spreads can be worthless between bearPutLongStrike and bullCallLongStrike
        lockedInProfit = -totalCost; // Worst case: both worthless
        
        // Best case: both spreads can reach full value at different price points
        const combinedMaxValue = position.maxValue + offsetMaxValue;
        profitPotential = combinedMaxValue - totalCost;
      } else {
        // Strikes overlap - at least one spread will have value at any price
        const strikesOverlap = bullCallLongStrike < bearPutLongStrike && bearPutShortStrike < bullCallShortStrike;
        
        if (strikesOverlap) {
          const minMaxValue = Math.min(position.maxValue, offsetMaxValue);
          lockedInProfit = minMaxValue - totalCost;
          
          let maxCombinedValue = 0;
          
          if (bullCallShortStrike >= bearPutShortStrike && bullCallShortStrike <= bearPutLongStrike) {
            const bearPutValueAtBullCallShort = (bearPutLongStrike - bullCallShortStrike) * 100;
            const bullCallValueAtShort = offsetMaxValue;
            maxCombinedValue = Math.max(maxCombinedValue, bearPutValueAtBullCallShort + bullCallValueAtShort);
          }
          
          if (bearPutShortStrike >= bullCallLongStrike && bearPutShortStrike <= bullCallShortStrike) {
            const bearPutValueAtShort = position.maxValue;
            const bullCallValueAtBearPutShort = (bearPutShortStrike - bullCallLongStrike) * 100;
            maxCombinedValue = Math.max(maxCombinedValue, bearPutValueAtShort + bullCallValueAtBearPutShort);
          }
          
          if (maxCombinedValue === 0) {
            maxCombinedValue = Math.max(position.maxValue, offsetMaxValue);
          }
          
          profitPotential = maxCombinedValue - totalCost;
        } else {
          const minMaxValue = Math.min(position.maxValue, offsetMaxValue);
          const combinedMaxValue = position.maxValue + offsetMaxValue;
          lockedInProfit = minMaxValue - totalCost;
          profitPotential = combinedMaxValue - totalCost;
        }
      }
      
      profitPotentialScore = profitPotential !== 0 ? lockedInProfit / profitPotential : 0;
      
    } else if (isBearCallSpread) {
      const positionLegs = getShortLongLegs(position);
      const bearCallShortStrike = positionLegs.shortStrike;
      const bearCallLongStrike = positionLegs.longStrike;
      const bullCallLongStrike = longCallStrike;
      const bullCallShortStrike = shortCallStrike;
      
      const bearCallCredit = -position.cost;
      const netCredit = bearCallCredit - spreadCost;
      
      const bearCallMaxLoss = Math.abs(position.maxValue || 0);
      const bullCallMaxValue = offsetMaxValue;
      
      const worstCaseHighPrice = bullCallMaxValue - bearCallMaxLoss + netCredit;
      const worstCaseLowPrice = netCredit;
      
      lockedInProfit = Math.min(worstCaseHighPrice, worstCaseLowPrice);
      
      let bestCaseProfit = netCredit;
      
      if (bullCallShortStrike >= bearCallShortStrike && bullCallShortStrike <= bearCallLongStrike) {
        const bullCallValueAtShort = bullCallMaxValue;
        const bearCallLossAtBullShort = (bullCallShortStrike - bearCallShortStrike) * 100;
        bestCaseProfit = Math.max(bestCaseProfit, bullCallValueAtShort - bearCallLossAtBullShort + netCredit);
      }
      
      if (bearCallShortStrike >= bullCallLongStrike && bearCallShortStrike <= bullCallShortStrike) {
        const bullCallValueAtBearShort = (bearCallShortStrike - bullCallLongStrike) * 100;
        const bearCallLossAtShort = 0;
        bestCaseProfit = Math.max(bestCaseProfit, bullCallValueAtBearShort + netCredit);
      }
      
      if (bullCallShortStrike < bearCallShortStrike) {
        bestCaseProfit = Math.max(bestCaseProfit, bullCallMaxValue + netCredit);
      }
      
      profitPotential = bestCaseProfit;
      profitPotentialScore = profitPotential !== 0 ? lockedInProfit / profitPotential : 0;
      
    } else {
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
    let worstCase, bestCase;
    
    // Extract offsetting position properties
    const spreadCredit = -offsettingPosition.cost; // Bear call spread receives credit
    const offsetMaxValue = offsettingPosition.maxValue;
    const offsetLegs = getShortLongLegs(offsettingPosition);
    const shortCallStrike = offsetLegs.shortStrike;
    const longCallStrike = offsetLegs.longStrike;
    
    // Determine position strategy
    const isBullCallSpread = position.strategy === 'bull_call_spread';
    const isBullPutSpread = position.strategy === 'bull_put_spread';
    
    if (isBullCallSpread) {
      const positionLegs = getShortLongLegs(position);
      const bullCallLongStrike = positionLegs.longStrike;
      const bullCallShortStrike = positionLegs.shortStrike;
      const bearCallShortStrike = shortCallStrike;
      const bearCallLongStrike = longCallStrike;
      
      const netCost = position.cost - spreadCredit;
      const strikesOverlap = bullCallLongStrike < bearCallLongStrike && bearCallShortStrike < bullCallShortStrike;
      
      if (strikesOverlap) {
        worstCase = position.maxValue + offsetMaxValue - netCost;
        
        if (bearCallShortStrike >= bullCallLongStrike && bearCallShortStrike <= bullCallShortStrike) {
          const bullCallValueAtBearCallShort = (bearCallShortStrike - bullCallLongStrike) * 100;
          bestCase = bullCallValueAtBearCallShort - netCost;
        } else {
          bestCase = position.maxValue - netCost;
        }
      } else {
        worstCase = position.maxValue + offsetMaxValue - netCost;
        bestCase = position.maxValue - netCost;
      }
      
    } else if (isBullPutSpread) {
      const bullPutCredit = -position.cost;
      const bullPutMaxLoss = Math.abs(position.maxValue || 0);
      const bearCallMaxLossAbs = Math.abs(offsetMaxValue);
      
      const totalCredit = bullPutCredit + spreadCredit;
      const maxLossWorstSpread = Math.max(bullPutMaxLoss, bearCallMaxLossAbs);
      
      worstCase = -maxLossWorstSpread + totalCredit;
      bestCase = totalCredit;
      
    } else {
      const positionMaxValue = position.maxValue || 0;
      worstCase = positionMaxValue + offsetMaxValue + spreadCredit - position.cost;
      bestCase = positionMaxValue + spreadCredit - position.cost;
    }
    
    const lockedInProfit = worstCase;
    const profitPotential = bestCase;
    const profitPotentialScore = profitPotential !== 0 ? lockedInProfit / profitPotential : 0;
    
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
    let worstCase, bestCase;
    
    // Extract offsetting position properties
    const spreadCredit = -offsettingPosition.cost; // Bull put spread receives credit
    const bullPutMaxLoss = offsettingPosition.maxValue;
    const offsetLegs = getShortLongLegs(offsettingPosition);
    const shortPutStrike = offsetLegs.shortStrike;
    const longPutStrike = offsetLegs.longStrike;
    
    // Determine position strategy
    const isBearPutSpread = position.strategy === 'bear_put_spread';
    const isBearCallSpread = position.strategy === 'bear_call_spread';
    
    if (isBearPutSpread) {
      const positionLegs = getShortLongLegs(position);
      const bearPutShortStrike = positionLegs.shortStrike;
      const bearPutLongStrike = positionLegs.longStrike;
      const bullPutShortStrike = shortPutStrike;
      const bullPutLongStrike = longPutStrike;
      const bearPutCost = position.cost;
      const netCost = bearPutCost - spreadCredit;
      
      const bearPutMaxValue = position.maxValue || (position.spreadWidth * 100);
      const bullPutMaxLossAbs = Math.abs(bullPutMaxLoss);
      
      const worstCaseLowPrice = bearPutMaxValue - bullPutMaxLossAbs - netCost;
      const worstCaseHighPrice = -netCost;
      
      worstCase = Math.min(worstCaseLowPrice, worstCaseHighPrice);
      
      let bestCaseProfit = -netCost;
      
      if (bearPutLongStrike >= bullPutLongStrike && bearPutLongStrike <= bullPutShortStrike) {
        const bearPutValueAtLong = bearPutMaxValue;
        const bullPutLossAtBearLong = (bullPutShortStrike - bearPutLongStrike) * 100;
        bestCaseProfit = Math.max(bestCaseProfit, bearPutValueAtLong - bullPutLossAtBearLong - netCost);
      }
      
      if (bullPutShortStrike >= bearPutShortStrike && bullPutShortStrike <= bearPutLongStrike) {
        const bearPutValueAtBullShort = (bearPutLongStrike - bullPutShortStrike) * 100;
        bestCaseProfit = Math.max(bestCaseProfit, bearPutValueAtBullShort - netCost);
      }
      
      if (bearPutLongStrike < bullPutLongStrike) {
        // Non-overlapping spreads - both can reach full value at different price points
        const combinedMaxValue = bearPutMaxValue + Math.abs(bullPutMaxLoss);
        bestCaseProfit = Math.max(bestCaseProfit, combinedMaxValue - netCost);
      } else {
        // Check if the bull put spread strikes are within the bear put spread range
        const strikesOverlap = bullPutShortStrike > bearPutShortStrike && bullPutLongStrike < bearPutLongStrike;
        
        if (strikesOverlap) {
          // Bull put spread is completely inside bear put spread
          // Best case is already calculated in the specific price point checks above
          // Don't add combined max value since they can't both be at max simultaneously
        } else {
          const combinedMaxValue = bearPutMaxValue + Math.abs(bullPutMaxLoss);
          bestCaseProfit = Math.max(bestCaseProfit, combinedMaxValue - netCost);
        }
      }
      
      bestCase = bestCaseProfit;
      
    } else if (isBearCallSpread) {
      const bearCallCredit = -position.cost;
      const bearCallMaxLoss = Math.abs(position.maxValue || 0);
      const bullPutMaxLossAbs = Math.abs(bullPutMaxLoss);
      
      const totalCredit = bearCallCredit + spreadCredit;
      const maxLossWorstSpread = Math.max(bearCallMaxLoss, bullPutMaxLossAbs);
      
      worstCase = -maxLossWorstSpread + totalCredit;
      bestCase = totalCredit;
      
    } else {
      const positionMaxValue = position.maxValue || 0;
      worstCase = positionMaxValue + bullPutMaxLoss + spreadCredit - position.cost;
      bestCase = positionMaxValue + spreadCredit - position.cost;
    }
    
    const lockedInProfit = worstCase;
    const profitPotential = bestCase;
    const profitPotentialScore = profitPotential !== 0 ? lockedInProfit / profitPotential : 0;
    
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
    let worstCase, bestCase;
    
    // Extract offsetting position properties
    const spreadCost = offsettingPosition.cost;
    const offsetMaxValue = offsettingPosition.maxValue;
    const offsetLegs = getShortLongLegs(offsettingPosition);
    const longPutStrike = offsetLegs.longStrike;
    const shortPutStrike = offsetLegs.shortStrike;
    
    // Determine position strategy
    const isBullCallSpread = position.strategy === 'bull_call_spread';
    const isBullPutSpread = position.strategy === 'bull_put_spread';
    
    if (isBullCallSpread) {
      const totalCost = position.cost + spreadCost;
      
      const positionLegs = getShortLongLegs(position);
      const bullCallLongStrike = positionLegs.longStrike;
      const bullCallShortStrike = positionLegs.shortStrike;
      const bearPutShortStrike = shortPutStrike;
      const bearPutLongStrike = longPutStrike;
      
      // Check if strikes overlap in a way where both can be worthless
      // Bull call is worthless below bullCallLongStrike
      // Bear put is worthless above bearPutLongStrike
      // If bullCallLongStrike >= bearPutLongStrike, there's a gap where both are worthless
      if (bullCallLongStrike >= bearPutLongStrike) {
        // Both spreads can be worthless between bearPutLongStrike and bullCallLongStrike
        worstCase = -totalCost; // Worst case: both worthless
        
        // Best case: both spreads can reach full value at different price points
        const combinedMaxValue = position.maxValue + offsetMaxValue;
        bestCase = combinedMaxValue - totalCost;
      } else {
        // Strikes overlap - at least one spread will have value at any price
        const strikesOverlap = bullCallLongStrike < bearPutLongStrike && bearPutShortStrike < bullCallShortStrike;
        
        if (strikesOverlap) {
          const minMaxValue = Math.min(position.maxValue, offsetMaxValue);
          worstCase = minMaxValue - totalCost;
          
          let maxCombinedValue = 0;
          
          if (bearPutShortStrike >= bullCallLongStrike && bearPutShortStrike <= bullCallShortStrike) {
            const bullCallValueAtBearPutShort = (bearPutShortStrike - bullCallLongStrike) * 100;
            const bearPutValueAtShort = offsetMaxValue;
            maxCombinedValue = Math.max(maxCombinedValue, bullCallValueAtBearPutShort + bearPutValueAtShort);
          }
          
          if (bullCallShortStrike >= bearPutShortStrike && bullCallShortStrike <= bearPutLongStrike) {
            const bullCallValueAtShort = position.maxValue;
            const bearPutValueAtBullCallShort = (bearPutLongStrike - bullCallShortStrike) * 100;
            maxCombinedValue = Math.max(maxCombinedValue, bullCallValueAtShort + bearPutValueAtBullCallShort);
          }
          
          if (maxCombinedValue === 0) {
            maxCombinedValue = Math.max(position.maxValue, offsetMaxValue);
          }
          
          bestCase = maxCombinedValue - totalCost;
        } else {
          const minMaxValue = Math.min(position.maxValue, offsetMaxValue);
          const combinedMaxValue = position.maxValue + offsetMaxValue;
          worstCase = minMaxValue - totalCost;
          bestCase = combinedMaxValue - totalCost;
        }
      }
      
    } else if (isBullPutSpread) {
      const positionLegs = getShortLongLegs(position);
      const bullPutShortStrike = positionLegs.shortStrike;
      const bullPutLongStrike = positionLegs.longStrike;
      const bearPutLongStrike = longPutStrike;
      const bearPutShortStrike = shortPutStrike;
      
      const bullPutCredit = -position.cost;
      const netCredit = bullPutCredit - spreadCost;
      
      const bullPutMaxLoss = Math.abs(position.maxValue || 0);
      const bearPutMaxValue = offsetMaxValue;
      
      const worstCaseLowPrice = bearPutMaxValue - bullPutMaxLoss + netCredit;
      const worstCaseHighPrice = netCredit;
      
      worstCase = Math.min(worstCaseLowPrice, worstCaseHighPrice);
      
      let bestCaseProfit = netCredit;
      
      if (bearPutLongStrike >= bullPutLongStrike && bearPutLongStrike <= bullPutShortStrike) {
        const bearPutValueAtLong = bearPutMaxValue;
        const bullPutLossAtBearLong = (bullPutShortStrike - bearPutLongStrike) * 100;
        bestCaseProfit = Math.max(bestCaseProfit, bearPutValueAtLong - bullPutLossAtBearLong + netCredit);
      }
      
      if (bullPutShortStrike >= bearPutShortStrike && bullPutShortStrike <= bearPutLongStrike) {
        const bearPutValueAtBullShort = (bearPutLongStrike - bullPutShortStrike) * 100;
        bestCaseProfit = Math.max(bestCaseProfit, bearPutValueAtBullShort + netCredit);
      }
      
      if (bearPutLongStrike < bullPutLongStrike) {
        bestCaseProfit = Math.max(bestCaseProfit, bearPutMaxValue + netCredit);
      }
      
      bestCase = bestCaseProfit;
      
    } else {
      const minMaxValue = Math.min(position.maxValue || 0, offsetMaxValue);
      const maxMaxValue = Math.max(position.maxValue || 0, offsetMaxValue);
      const totalCost = position.cost + spreadCost;
      worstCase = minMaxValue - totalCost;
      bestCase = maxMaxValue - totalCost;
    }
    
    const lockedInProfit = worstCase;
    const profitPotential = bestCase;
    const profitPotentialScore = profitPotential !== 0 ? lockedInProfit / profitPotential : 0;
    
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
          quantity: 1,
          type: 'C',
          strike: longCallStrike,
          cost: longCallCost * 100,
          originalString: `1c${longCallStrike}@${longCallCost * 100}`
        },
        {
          action: 'offset',
          quantity: -1,
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
          quantity: -1,
          type: 'C',
          strike: shortCallStrike,
          cost: -shortCallCredit * 100,
          originalString: `-1c${shortCallStrike}@${-shortCallCredit * 100}`
        },
        {
          action: 'offset',
          quantity: 1,
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
          quantity: -1,
          type: 'P',
          strike: shortPutStrike,
          cost: -shortPutCredit * 100,
          originalString: `-1p${shortPutStrike}@${-shortPutCredit * 100}`
        },
        {
          action: 'offset',
          quantity: 1,
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
          quantity: 1,
          type: 'P',
          strike: longPutStrike,
          cost: longPutCost * 100,
          originalString: `1p${longPutStrike}@${longPutCost * 100}`
        },
        {
          action: 'offset',
          quantity: -1,
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
    // Debug: Log the position structure
    console.log('🔍 getShortLongLegs - Position structure:', position);
    console.log('🔍 getShortLongLegs - Position legs:', position.legs);
    console.log('🔍 getShortLongLegs - Legs count:', position.legs.length);
    
    // Debug: Check each leg
    position.legs.forEach((leg, index) => {
      console.log(`🔍 Leg ${index}:`, leg);
      console.log(`  - qty: ${leg.qty}`);
      console.log(`  - qty < 0: ${leg.qty < 0}`);
      console.log(`  - qty > 0: ${leg.qty > 0}`);
    });
    
    // Use qty-based leg identification only
    const shortLeg = position.legs.find(leg => leg.qty < 0);
    const longLeg = position.legs.find(leg => leg.qty > 0);
    
    console.log('🔍 Found shortLeg:', shortLeg);
    console.log('🔍 Found longLeg:', longLeg);
    
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
            { strike: longCallStrike, qty: 1 },  // long leg (bought)
            { strike: shortCallStrike, qty: -1 }  // short leg (sold)
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
            { strike: shortLowerCallStrike, qty: -1 },  // short leg (sold)
            { strike: longHigherCallStrike, qty: 1 }    // long leg (bought)
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
            { strike: shortHigherPutStrike, qty: -1 },  // short leg (sold)
            { strike: longLowerPutStrike, qty: 1 }      // long leg (bought)
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
            { strike: longPutStrike, qty: 1 },   // long leg (bought)
            { strike: shortPutStrike, qty: -1 }  // short leg (sold)
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
