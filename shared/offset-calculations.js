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
    const incomingStrategy = position.strategy;
    
    if (incomingStrategy === 'bear_put_spread') {
      // Bear put spread: long higher strike, short lower strike
      const legs = position.legs;
      const higherStrike = Math.max(...legs.map(leg => leg.strike));
      const lowerStrike = Math.min(...legs.map(leg => leg.strike));
      const higherStrikeLeg = legs.find(leg => leg.strike === higherStrike);
      const lowerStrikeLeg = legs.find(leg => leg.strike === lowerStrike);
      
      // For bear put spread, reference is the short put (lower strike)
      referenceStrike = lowerStrike;
      
    } else if (incomingStrategy === 'bear_call_spread') {
      // Bear call spread: short lower strike, long higher strike  
      const legs = position.legs;
      const lowerStrike = Math.min(...legs.map(leg => leg.strike));
      const higherStrike = Math.max(...legs.map(leg => leg.strike));
      const lowerStrikeLeg = legs.find(leg => leg.strike === lowerStrike);
      const higherStrikeLeg = legs.find(leg => leg.strike === higherStrike);
      
      // For bear call spread, reference is the short call (lower strike)
      referenceStrike = lowerStrike;
      
    } else {
      // Fallback - shouldn't happen with proper input
      referenceStrike = Math.min(...position.legs.map(leg => leg.strike));
    }
    
    const spreadWidth = position.spreadWidth || Math.abs(position.legs[0].strike - position.legs[1].strike);
    const offsetBudget = position.offsetBudget;
        
    const callOptions = chainData.call || null;
    if (!callOptions || Object.keys(callOptions).length === 0) {
      return { strategy: 'bull_call_spread', possibleOffsets: [] };
    }
    
    let allCallStrikes = new Set();
    const expirationStrikes = {};
    
    for (const [expiration, strikes] of Object.entries(callOptions)) {
      const strikeList = Object.keys(strikes).map(strike => parseFloat(strike));
      strikeList.forEach(strike => allCallStrikes.add(strike));
      expirationStrikes[expiration] = strikes;
    }
    
    const callStrikes = Array.from(allCallStrikes).sort((a, b) => b - a);
    const addedSpreads = new Set();
    
    // Single unified loop: for each long strike, test all possible short strikes (original width and wider)
    for (const longCallStrike of callStrikes) {
      // console.log(`🔍 SHARED: Testing longCallStrike ${longCallStrike} vs referenceStrike ${referenceStrike}`);
      if (longCallStrike > referenceStrike) {
        // console.log(`🔍 SHARED: Skipping ${longCallStrike} > ${referenceStrike}`);
        continue;
      }
      
      // Get long call data once for this strike
      let longCallData = null;
      for (const [expiration, strikes] of Object.entries(expirationStrikes)) {
        const longStrikeKey = longCallStrike.toString() + '.0';
        if (strikes[longStrikeKey]) {
          longCallData = strikes[longStrikeKey][0];
          break;
        }
      }
      
      if (!longCallData) {
        continue;
      }
      
      const longCallCost = (longCallData.bid + longCallData.ask) / 2;
      const longCallStrikeIndex = callStrikes.indexOf(longCallStrike);
      
      // Test all possible short strikes starting from original width and going wider
      for (let i = longCallStrikeIndex - 1; i >= 0; i--) {
        const shortCallStrike = callStrikes[i];
        const currentSpreadWidth = shortCallStrike - longCallStrike;
        
        // Skip if narrower than original spread width
        if (currentSpreadWidth < spreadWidth) {
          continue;
        }
        
        const spreadKey = `${longCallStrike}-${shortCallStrike}`;
        if (addedSpreads.has(spreadKey)) {
          continue;
        }
        
        // Get short call data
        let shortCallData = null;
        for (const [expiration, strikes] of Object.entries(expirationStrikes)) {
          const shortStrikeKey = shortCallStrike.toString() + '.0';
          if (strikes[shortStrikeKey]) {
            shortCallData = strikes[shortStrikeKey][0];
            break;
          }
        }
        
        if (!shortCallData || !shortCallData.bid || !shortCallData.ask) {
          continue;
        }
        
        const shortCallCost = (shortCallData.bid + shortCallData.ask) / 2;
        const spreadCost = (longCallCost - shortCallCost) * 100;
        
        // console.log(`🔍 SHARED: Spread ${longCallStrike}-${shortCallStrike}: cost=$${spreadCost.toFixed(2)}, budget=$${offsetBudget}`);
        
        if (spreadCost > offsetBudget) {
          // console.log(`🔍 SHARED: Spread cost $${spreadCost.toFixed(2)} > budget $${offsetBudget} - SKIPPING`);
          continue;
        }
        
        // console.log(`🔍 SHARED: Spread ${longCallStrike}-${shortCallStrike} passed budget check, calculating locked profit...`);
        
        const offsetMaxValue = currentSpreadWidth * 100;
        
        const isBearPutSpread = position.strategy === 'bear_put_spread';
        const isBearCallSpread = position.strategy === 'bear_call_spread';
        
        let lockedInProfit, profitPotential, profitPotentialScore;
        
        if (isBearPutSpread) {
          const totalCost = position.cost + spreadCost;
          
          const bearPutShortStrike = Math.min(...position.legs.map(leg => leg.strike));
          const bearPutLongStrike = Math.max(...position.legs.map(leg => leg.strike));
          const bullCallLongStrike = longCallStrike;
          const bullCallShortStrike = shortCallStrike;
          
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
            // console.log(`🔍 SHARED: Overlap check: ${bullCallLongStrike} < ${bearPutLongStrike} = ${bullCallLongStrike < bearPutLongStrike}, ${bearPutShortStrike} < ${bullCallShortStrike} = ${bearPutShortStrike < bullCallShortStrike}, Overlap = ${strikesOverlap}`);
            
            if (strikesOverlap) {
              // console.log('🔍 SHARED: Using OVERLAPPING calculation');
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
              // console.log(`🔍 SHARED: Spread ${longCallStrike}-${shortCallStrike}: lockedInProfit=$${lockedInProfit.toFixed(2)}, profitPotential=$${profitPotential.toFixed(2)}`);
            } else {
              // console.log('🔍 SHARED: Using NON-OVERLAPPING calculation');
              const minMaxValue = Math.min(position.maxValue, offsetMaxValue);
              const combinedMaxValue = position.maxValue + offsetMaxValue;
              lockedInProfit = minMaxValue - totalCost;
              profitPotential = combinedMaxValue - totalCost;
              // console.log(`🔍 SHARED: Spread ${longCallStrike}-${shortCallStrike}: lockedInProfit=$${lockedInProfit.toFixed(2)}, profitPotential=$${profitPotential.toFixed(2)}`);
            }
          }
          
          profitPotentialScore = profitPotential !== 0 ? lockedInProfit / profitPotential : 0;
          
        } else if (isBearCallSpread) {
          const bearCallShortStrike = Math.min(...position.legs.map(leg => leg.strike));
          const bearCallLongStrike = Math.max(...position.legs.map(leg => leg.strike));
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
        
        if (lockedInProfit < 0) {
          continue;
        }
        
        const offsettingSpread = {
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
    const addedSpreads = new Set();
    
    // Determine incoming position type and extract correct reference strikes
    let referenceStrike;
    const incomingStrategy = position.strategy;
    
    if (incomingStrategy === 'bull_call_spread') {
      // Bull call spread: long lower strike, short higher strike
      const legs = position.legs;
      const lowerStrike = Math.min(...legs.map(leg => leg.strike));
      const higherStrike = Math.max(...legs.map(leg => leg.strike));
      const lowerStrikeLeg = legs.find(leg => leg.strike === lowerStrike);
      const higherStrikeLeg = legs.find(leg => leg.strike === higherStrike);
      
      // For bull call spread, reference is the short call (higher strike)
      referenceStrike = higherStrike;
      
    } else if (incomingStrategy === 'bull_put_spread') {
      // Bull put spread: short higher strike, long lower strike
      const legs = position.legs;
      const higherStrike = Math.max(...legs.map(leg => leg.strike));
      const lowerStrike = Math.min(...legs.map(leg => leg.strike));
      const higherStrikeLeg = legs.find(leg => leg.strike === higherStrike);
      const lowerStrikeLeg = legs.find(leg => leg.strike === lowerStrike);
      
      // For bull put spread, reference is the short put (higher strike)
      referenceStrike = higherStrike;
      
    } else {
      // Fallback - shouldn't happen with proper input
      referenceStrike = Math.max(...position.legs.map(leg => leg.strike));
    }
    
    const spreadWidth = position.spreadWidth || Math.abs(position.legs[0].strike - position.legs[1].strike);
    const offsetBudget = position.offsetBudget;
        
    const callOptions = chainData.call || null;
    if (!callOptions || Object.keys(callOptions).length === 0) {
      return { strategy: 'bear_call_spread', possibleOffsets: [] };
    }
    
    let allCallStrikes = new Set();
    const expirationStrikes = {};
    
    for (const [expiration, strikes] of Object.entries(callOptions)) {
      const strikeList = Object.keys(strikes).map(strike => parseFloat(strike));
      strikeList.forEach(strike => allCallStrikes.add(strike));
      expirationStrikes[expiration] = strikes;
    }
    
    const callStrikes = Array.from(allCallStrikes).sort((a, b) => a - b);
    
    // Single unified loop: for each short strike, test all possible long strikes (original width and wider)
    for (const shortLowerCallStrike of callStrikes) {
      if (shortLowerCallStrike < referenceStrike) {
        continue;
      }
      
      // Get short call data once for this strike
      let shortLowerCallData = null;
      for (const [expiration, strikes] of Object.entries(expirationStrikes)) {
        const shortStrikeKey = shortLowerCallStrike.toString() + '.0';
        if (strikes[shortStrikeKey]) {
          shortLowerCallData = strikes[shortStrikeKey][0];
          break;
        }
      }
      
      if (!shortLowerCallData) {
        continue;
      }
      
      const shortLowerCallCredit = (shortLowerCallData.bid + shortLowerCallData.ask) / 2;
      const shortLowerCallStrikeIndex = callStrikes.indexOf(shortLowerCallStrike);
      
      // Test all possible long strikes starting from original width and going wider
      for (let i = shortLowerCallStrikeIndex + 1; i < callStrikes.length; i++) {
        const longHigherCallStrike = callStrikes[i];
        const currentSpreadWidth = longHigherCallStrike - shortLowerCallStrike;
        
        // Skip if narrower than original spread width
        if (currentSpreadWidth < spreadWidth) {
          continue;
        }
        
        const spreadKey = `${shortLowerCallStrike}-${longHigherCallStrike}`;
        if (addedSpreads.has(spreadKey)) {
          continue;
        }
        
        // Get long call data
        let longHigherCallData = null;
        for (const [expiration, strikes] of Object.entries(expirationStrikes)) {
          const longStrikeKey = longHigherCallStrike.toString() + '.0';
          if (strikes[longStrikeKey]) {
            longHigherCallData = strikes[longStrikeKey][0];
            break;
          }
        }
        
        if (!longHigherCallData) {
          continue;
        }
        
        const longHigherCallCost = (longHigherCallData.bid + longHigherCallData.ask) / 2;
        const spreadCredit = (shortLowerCallCredit - longHigherCallCost) * 100;
        
        if (spreadCredit <= 0) {
          continue;
        }
        
        const offsetMaxValue = -(currentSpreadWidth * 100);
        const bearCallMaxLoss = offsetMaxValue;
        
        const isBullCallSpread = position.strategy === 'bull_call_spread';
        const isBullPutSpread = position.strategy === 'bull_put_spread';
        
        let worstCase, bestCase;
        
        if (isBullCallSpread) {
          const bullCallLongStrike = Math.min(...position.legs.map(leg => leg.strike));
          const bullCallShortStrike = Math.max(...position.legs.map(leg => leg.strike));
          const bearCallShortStrike = shortLowerCallStrike;
          const bearCallLongStrike = longHigherCallStrike;
          
          const netCost = position.cost - spreadCredit;
          const strikesOverlap = bullCallLongStrike < bearCallLongStrike && bearCallShortStrike < bullCallShortStrike;
          
          if (strikesOverlap) {
            worstCase = position.maxValue + bearCallMaxLoss - netCost;
            
            if (bearCallShortStrike >= bullCallLongStrike && bearCallShortStrike <= bullCallShortStrike) {
              const bullCallValueAtBearCallShort = (bearCallShortStrike - bullCallLongStrike) * 100;
              bestCase = bullCallValueAtBearCallShort - netCost;
            } else {
              bestCase = position.maxValue - netCost;
            }
          } else {
            worstCase = position.maxValue + bearCallMaxLoss - netCost;
            bestCase = position.maxValue - netCost;
          }
          
        } else if (isBullPutSpread) {
          const bullPutCredit = -position.cost;
          const bullPutMaxLoss = Math.abs(position.maxValue || 0);
          const bearCallMaxLossAbs = Math.abs(bearCallMaxLoss);
          
          const totalCredit = bullPutCredit + spreadCredit;
          const maxLossWorstSpread = Math.max(bullPutMaxLoss, bearCallMaxLossAbs);
          
          worstCase = -maxLossWorstSpread + totalCredit;
          bestCase = totalCredit;
          
        } else {
          const positionMaxValue = position.maxValue || 0;
          worstCase = positionMaxValue + bearCallMaxLoss + spreadCredit - position.cost;
          bestCase = positionMaxValue + spreadCredit - position.cost;
        }
        
        const lockedInProfit = worstCase;
        const profitPotential = bestCase;
        const profitPotentialScore = profitPotential !== 0 ? lockedInProfit / profitPotential : 0;
        
        // console.log(`🔍 SHARED: Spread ${longCallStrike}-${shortCallStrike}: lockedInProfit=$${lockedInProfit.toFixed(2)}, profitPotential=$${profitPotential.toFixed(2)}`);
        
        if (lockedInProfit < 0) {
          // console.log(`🔍 BEAR CALL: Skipping spread ${shortLowerCallStrike}-${longHigherCallStrike} due to negative locked profit: $${lockedInProfit.toFixed(2)}`);
          continue;
        }
        
        const offsettingSpread = {
          strategy: 'bear_call_spread',
          legs: [
            {
              action: 'offset',
              quantity: -1,
              type: 'C',
              strike: shortLowerCallStrike,
              cost: -shortLowerCallCredit * 100,
              originalString: `-1c${shortLowerCallStrike}@${-shortLowerCallCredit * 100}`
            },
            {
              action: 'offset',
              quantity: 1,
              type: 'C',
              strike: longHigherCallStrike,
              cost: longHigherCallCost * 100,
              originalString: `1c${longHigherCallStrike}@${longHigherCallCost * 100}`
            }
          ],
          cost: -spreadCredit,
          spreadWidth: currentSpreadWidth,
          maxValue: offsetMaxValue,
          lockedInProfit: lockedInProfit,
          profitPotential: profitPotential,
          profitPotentialScore: profitPotentialScore,
          description: `Bear Call Spread: Short ${shortLowerCallStrike}C @ ${shortLowerCallCredit.toFixed(2)}, Long ${longHigherCallStrike}C @ ${longHigherCallCost.toFixed(2)}`
        };
        
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
    const incomingStrategy = position.strategy;
    
    if (incomingStrategy === 'bear_put_spread') {
      // Bear put spread: long higher strike, short lower strike
      const legs = position.legs;
      const higherStrike = Math.max(...legs.map(leg => leg.strike));
      const lowerStrike = Math.min(...legs.map(leg => leg.strike));
      const higherStrikeLeg = legs.find(leg => leg.strike === higherStrike);
      const lowerStrikeLeg = legs.find(leg => leg.strike === lowerStrike);
      
      // For bear put spread, reference is the long put (higher strike)
      referenceStrike = higherStrike;
      
    } else if (incomingStrategy === 'bear_call_spread') {
      // Bear call spread: short lower strike, long higher strike
      const legs = position.legs;
      const lowerStrike = Math.min(...legs.map(leg => leg.strike));
      const higherStrike = Math.max(...legs.map(leg => leg.strike));
      const lowerStrikeLeg = legs.find(leg => leg.strike === lowerStrike);
      const higherStrikeLeg = legs.find(leg => leg.strike === higherStrike);
      
      // For bear call spread, reference is the long call (higher strike)
      referenceStrike = higherStrike;
      
    } else {
      // Fallback - shouldn't happen with proper input
      referenceStrike = Math.max(...position.legs.map(leg => leg.strike));
    }
    
    const spreadWidth = position.spreadWidth || Math.abs(position.legs[0].strike - position.legs[1].strike);
    const offsetBudget = Math.abs(position.offsetBudget || position.cost);
        
    const putOptions = chainData.put || null;
    if (!putOptions || Object.keys(putOptions).length === 0) {
      return { strategy: 'bull_put_spread', possibleOffsets: [] };
    }
    
    let allPutStrikes = new Set();
    const expirationStrikes = {};
    
    for (const [expiration, strikes] of Object.entries(putOptions)) {
      const strikeList = Object.keys(strikes).map(strike => parseFloat(strike));
      strikeList.forEach(strike => allPutStrikes.add(strike));
      expirationStrikes[expiration] = strikes;
    }
    
    const putStrikes = Array.from(allPutStrikes).sort((a, b) => b - a);
    const addedSpreads = new Set();
    
    // Single unified loop: for each short strike, test all possible long strikes (original width and wider)
    for (const shortHigherPutStrike of putStrikes) {
      // console.log(`🔍 BULL PUT: Testing shortHigherPutStrike ${shortHigherPutStrike} vs referenceStrike ${referenceStrike}`);
      if (shortHigherPutStrike >= referenceStrike) {
        // console.log(`🔍 BULL PUT: Skipping ${shortHigherPutStrike} >= ${referenceStrike} - bull put strikes must be lower than bear put strikes`);
        continue;
      }
      
      // Get short put data once for this strike
      let shortHigherPutData = null;
      for (const [expiration, strikes] of Object.entries(expirationStrikes)) {
        const shortStrikeKey = shortHigherPutStrike.toString() + '.0';
        if (strikes[shortStrikeKey]) {
          shortHigherPutData = strikes[shortStrikeKey][0];
          break;
        }
      }
      
      if (!shortHigherPutData) {
        continue;
      }
      
      const shortHigherPutCredit = (shortHigherPutData.bid + shortHigherPutData.ask) / 2;
      const shortHigherPutStrikeIndex = putStrikes.indexOf(shortHigherPutStrike);
      
      // Test all possible long strikes starting from original width and going wider
      for (let i = shortHigherPutStrikeIndex + 1; i < putStrikes.length; i++) {
        const longLowerPutStrike = putStrikes[i];
        const currentSpreadWidth = shortHigherPutStrike - longLowerPutStrike;
        
        // Skip if narrower than original spread width
        if (currentSpreadWidth < spreadWidth) {
          continue;
        }
        
        const spreadKey = `${shortHigherPutStrike}-${longLowerPutStrike}`;
        // console.log(`🔍 BULL PUT: Trying spread ${shortHigherPutStrike}-${longLowerPutStrike}`);
        
        if (addedSpreads.has(spreadKey)) {
          continue;
        }
        
        // Get long put data
        let longLowerPutData = null;
        for (const [expiration, strikes] of Object.entries(expirationStrikes)) {
          const longStrikeKey = longLowerPutStrike.toString() + '.0';
          if (strikes[longStrikeKey]) {
            longLowerPutData = strikes[longStrikeKey][0];
            break;
          }
        }
        
        if (!longLowerPutData) {
          // console.log(`🔍 BULL PUT: Missing data for ${shortHigherPutStrike}-${longLowerPutStrike}: short=${!!shortHigherPutData}, long=${!!longLowerPutData}`);
          continue;
        }
        
        const longLowerPutCost = (longLowerPutData.bid + longLowerPutData.ask) / 2;
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
        let worstCase, bestCase;
        
        const isBearPutSpread = position.strategy === 'bear_put_spread';
        const isBearCallSpread = position.strategy === 'bear_call_spread';
        
        if (isBearPutSpread) {
          const bearPutShortStrike = Math.min(...position.legs.map(leg => leg.strike));
          const bearPutLongStrike = Math.max(...position.legs.map(leg => leg.strike));
          const bullPutShortStrike = shortHigherPutStrike;
          const bullPutLongStrike = longLowerPutStrike;
          const bearPutCost = position.cost;
          const netCost = bearPutCost - spreadCredit;
          
          const bearPutMaxValue = position.maxValue || (spreadWidth * 100);
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
            // Strikes overlap - check if they overlap
            const strikesOverlap = bullPutShortStrike > bearPutLongStrike && bullPutLongStrike < bearPutShortStrike;
            // console.log(`🔍 BULL PUT: Overlap check: ${bullPutShortStrike} > ${bearPutLongStrike} = ${bullPutShortStrike > bearPutLongStrike}, ${bullPutLongStrike} < ${bearPutShortStrike} = ${bullPutLongStrike < bearPutShortStrike}, Overlap = ${strikesOverlap}`);
            
            if (strikesOverlap) {
              // console.log('🔍 BULL PUT: Using OVERLAPPING calculation');
              const minMaxValue = Math.min(bearPutMaxValue, Math.abs(bullPutMaxLoss));
              bestCaseProfit = Math.max(bestCaseProfit, minMaxValue - netCost);
            } else {
              // console.log('🔍 BULL PUT: Using NON-OVERLAPPING calculation');
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
        
        if (lockedInProfit < 0) {
          continue;
        }
        
        const offsettingSpread = {
          strategy: 'bull_put_spread',
          legs: [
            {
              action: 'offset',
              quantity: -1,
              type: 'P',
              strike: shortHigherPutStrike,
              cost: -shortHigherPutCredit * 100,
              originalString: `-1p${shortHigherPutStrike}@${-shortHigherPutCredit * 100}`
            },
            {
              action: 'offset',
              quantity: 1,
              type: 'P',
              strike: longLowerPutStrike,
              cost: longLowerPutCost * 100,
              originalString: `1p${longLowerPutStrike}@${longLowerPutCost * 100}`
            }
          ],
          cost: -spreadCredit,
          spreadWidth: currentSpreadWidth,
          maxValue: bullPutMaxLoss,
          lockedInProfit: lockedInProfit,
          profitPotential: profitPotential,
          profitPotentialScore: profitPotentialScore,
          description: `Bull Put Spread: Short ${shortHigherPutStrike}P @ ${shortHigherPutCredit.toFixed(2)}, Long ${longLowerPutStrike}P @ ${longLowerPutCost.toFixed(2)}`
        };
        
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
    const incomingStrategy = position.strategy;
    
    if (incomingStrategy === 'bull_call_spread') {
      // Bull call spread: long lower strike, short higher strike
      const legs = position.legs;
      const lowerStrike = Math.min(...legs.map(leg => leg.strike));
      const higherStrike = Math.max(...legs.map(leg => leg.strike));
      const lowerStrikeLeg = legs.find(leg => leg.strike === lowerStrike);
      const higherStrikeLeg = legs.find(leg => leg.strike === higherStrike);
      
      // For bull call spread, reference is the long call (lower strike)
      referenceStrike = lowerStrike;
      
    } else if (incomingStrategy === 'bull_put_spread') {
      // Bull put spread: short higher strike, long lower strike
      const legs = position.legs;
      const higherStrike = Math.max(...legs.map(leg => leg.strike));
      const lowerStrike = Math.min(...legs.map(leg => leg.strike));
      const higherStrikeLeg = legs.find(leg => leg.strike === higherStrike);
      const lowerStrikeLeg = legs.find(leg => leg.strike === lowerStrike);
      
      // For bull put spread, reference is the long put (lower strike)
      referenceStrike = lowerStrike;
      
    } else {
      // Fallback - shouldn't happen with proper input
      referenceStrike = Math.min(...position.legs.map(leg => leg.strike));
    }
    
    const spreadWidth = position.spreadWidth || Math.abs(position.legs[0].strike - position.legs[1].strike);
    const offsetBudget = position.offsetBudget;
    
    // console.log(`🔍 BEAR PUT: findOffsettingBearPutSpread START {strategy: '${position.strategy}', referenceStrike: ${referenceStrike}, spreadWidth: ${spreadWidth}, offsetBudget: ${offsetBudget}}`);
        
    const putOptions = chainData.put || null;
    if (!putOptions || Object.keys(putOptions).length === 0) {
      return { strategy: 'bear_put_spread', possibleOffsets: [] };
    }
    
    let allPutStrikes = new Set();
    const expirationStrikes = {};
    
    for (const [expiration, strikes] of Object.entries(putOptions)) {
      const strikeList = Object.keys(strikes).map(strike => parseFloat(strike));
      strikeList.forEach(strike => allPutStrikes.add(strike));
      expirationStrikes[expiration] = strikes;
    }
    
    const putStrikes = Array.from(allPutStrikes).sort((a, b) => a - b);
    const addedSpreads = new Set();
    
    // console.log(`🔍 BEAR PUT: Testing ${putStrikes.length} put strikes`);
    
    // Single unified loop: for each short strike, test all possible long strikes (original width and wider)
    for (const shortPutStrike of putStrikes) {
      // console.log(`🔍 BEAR PUT: Testing shortPutStrike ${shortPutStrike} vs referenceStrike ${referenceStrike}`);
      if (shortPutStrike < referenceStrike) {
        // console.log(`🔍 BEAR PUT: Skipping ${shortPutStrike} < ${referenceStrike}`);
        continue;
      }
      
      // Get short put data once for this strike
      let shortPutData = null;
      for (const [expiration, strikes] of Object.entries(expirationStrikes)) {
        const shortStrikeKey = shortPutStrike.toString() + '.0';
        if (strikes[shortStrikeKey]) {
          shortPutData = strikes[shortStrikeKey][0];
          break;
        }
      }
      
      if (!shortPutData) {
        continue;
      }
      
      const shortPutCost = (shortPutData.bid + shortPutData.ask) / 2;
      const shortPutStrikeIndex = putStrikes.indexOf(shortPutStrike);
      
      // Test all possible long strikes starting from original width and going wider
      for (let i = shortPutStrikeIndex + 1; i < putStrikes.length; i++) {
        const longPutStrike = putStrikes[i];
        const currentSpreadWidth = longPutStrike - shortPutStrike;
        
        // Skip if narrower than original spread width
        if (currentSpreadWidth < spreadWidth) {
          continue;
        }
        
        const spreadKey = `${longPutStrike}-${shortPutStrike}`;
        
        if (addedSpreads.has(spreadKey)) {
          continue;
        }
        
        // Get long put data
        let longPutData = null;
        for (const [expiration, strikes] of Object.entries(expirationStrikes)) {
          const longStrikeKey = longPutStrike.toString() + '.0';
          if (strikes[longStrikeKey]) {
            longPutData = strikes[longStrikeKey][0];
            break;
          }
        }
        
        if (!longPutData) {
          continue;
        }
        
        const longPutCost = (longPutData.bid + longPutData.ask) / 2;
        const spreadCost = (longPutCost - shortPutCost) * 100;
      
        // console.log(`🔍 BEAR PUT: Spread ${longPutStrike}-${shortPutStrike}: cost=$${spreadCost.toFixed(2)}, budget=$${offsetBudget}`);
        
        if (spreadCost > offsetBudget) {
          // console.log(`🔍 BEAR PUT: Spread cost $${spreadCost.toFixed(2)} > budget $${offsetBudget} - SKIPPING`);
          continue;
        }
        
        const offsetMaxValue = currentSpreadWidth * 100;
        
        const isBullCallSpread = position.strategy === 'bull_call_spread';
        const isBullPutSpread = position.strategy === 'bull_put_spread';
        
        let lockedInProfit, profitPotential, profitPotentialScore;
        
        if (isBullCallSpread) {
          const totalCost = position.cost + spreadCost;
          
          const bullCallLongStrike = Math.min(...position.legs.map(leg => leg.strike));
          const bullCallShortStrike = Math.max(...position.legs.map(leg => leg.strike));
          const bearPutShortStrike = shortPutStrike;
          const bearPutLongStrike = longPutStrike;
          
          // Check if strikes overlap in a way where both can be worthless
          // Bull call is worthless below bullCallLongStrike
          // Bear put is worthless above bearPutLongStrike
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
            console.log(`🔍 SHARED: Overlap check: ${bullCallLongStrike} < ${bearPutLongStrike} = ${bullCallLongStrike < bearPutLongStrike}, ${bearPutShortStrike} < ${bullCallShortStrike} = ${bearPutShortStrike < bullCallShortStrike}, Overlap = ${strikesOverlap}`);
            
            if (strikesOverlap) {
              console.log('🔍 SHARED: Using OVERLAPPING calculation');
              const minMaxValue = Math.min(position.maxValue, offsetMaxValue);
              lockedInProfit = minMaxValue - totalCost;
              
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
              
              profitPotential = maxCombinedValue - totalCost;
            } else {
              console.log('🔍 SHARED: Using NON-OVERLAPPING calculation');
              const minMaxValue = Math.min(position.maxValue, offsetMaxValue);
              const combinedMaxValue = position.maxValue + offsetMaxValue;
              lockedInProfit = minMaxValue - totalCost;
              profitPotential = combinedMaxValue - totalCost;
            }
          }
          
          profitPotentialScore = profitPotential !== 0 ? lockedInProfit / profitPotential : 0;
          
        } else if (isBullPutSpread) {
          const bullPutShortStrike = Math.max(...position.legs.map(leg => leg.strike));
          const bullPutLongStrike = Math.min(...position.legs.map(leg => leg.strike));
          const bearPutLongStrike = longPutStrike;
          const bearPutShortStrike = shortPutStrike;
          
          const bullPutCredit = -position.cost;
          const netCredit = bullPutCredit - spreadCost;
          
          const bullPutMaxLoss = Math.abs(position.maxValue || 0);
          const bearPutMaxValue = offsetMaxValue;
          
          const worstCaseLowPrice = bearPutMaxValue - bullPutMaxLoss + netCredit;
          const worstCaseHighPrice = netCredit;
          
          lockedInProfit = Math.min(worstCaseLowPrice, worstCaseHighPrice);
          
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
        
        if (lockedInProfit < 0) {
          continue;
        }
        
        const offsettingSpread = {
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
    findOffsettingBearPutSpread
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
