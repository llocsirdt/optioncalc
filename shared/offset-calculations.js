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
    const possibleOffsets = [];
    
    const shortPutStrike = Math.min(...position.legs.map(leg => leg.strike));
    const longPutStrike = Math.max(...position.legs.map(leg => leg.strike));
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
    
    for (const longCallStrike of callStrikes) {
      if (longCallStrike > longPutStrike) {
        continue;
      }
      
      const shortCallStrike = longCallStrike + spreadWidth;
      const spreadKey = `${longCallStrike}-${shortCallStrike}`;
      
      if (addedSpreads.has(spreadKey)) {
        continue;
      }
      
      let longCallData = null;
      let shortCallData = null;
      
      for (const [expiration, strikes] of Object.entries(expirationStrikes)) {
        const longStrikeKey = longCallStrike.toString() + '.0';
        const shortStrikeKey = shortCallStrike.toString() + '.0';
        
        if (strikes[longStrikeKey] && strikes[shortStrikeKey]) {
          longCallData = strikes[longStrikeKey][0];
          shortCallData = strikes[shortStrikeKey][0];
          break;
        }
      }
      
      if (!longCallData || !shortCallData) {
        continue;
      }
      
      const longCallCost = (longCallData.bid + longCallData.ask) / 2;
      const shortCallCost = (shortCallData.bid + shortCallData.ask) / 2;
      const spreadCost = (longCallCost - shortCallCost) * 100;
      
      if (spreadCost > offsetBudget) {
        break;
      }
      
      const offsetMaxValue = spreadWidth * 100;
      
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
          
          // Best case: one of them reaches max value
          const maxMaxValue = Math.max(position.maxValue, offsetMaxValue);
          profitPotential = maxMaxValue - totalCost;
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
            const maxMaxValue = Math.max(position.maxValue, offsetMaxValue);
            lockedInProfit = minMaxValue - totalCost;
            profitPotential = maxMaxValue - totalCost;
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
        spreadWidth: spreadWidth,
        maxValue: offsetMaxValue,
        lockedInProfit: lockedInProfit,
        profitPotential: profitPotential,
        profitPotentialScore: profitPotentialScore,
        description: `Bull Call Spread: Long ${longCallStrike}C @ ${longCallCost.toFixed(2)}, Short ${shortCallStrike}C @ ${shortCallCost.toFixed(2)}`
      };
      
      possibleOffsets.push(offsettingSpread);
      addedSpreads.add(spreadKey);
    }
    
    return { strategy: 'bull_call_spread', possibleOffsets };
  }

  /**
   * Find offsetting Bear Call Spread positions
   */
  function findOffsettingBearCallSpread(position, chainData) {
    const possibleOffsets = [];
    
    const shortCallStrike = Math.max(...position.legs.map(leg => leg.strike));
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
    const addedSpreads = new Set();
    
    for (const shortLowerCallStrike of callStrikes) {
      const longCallStrike = Math.min(...position.legs.map(leg => leg.strike));
      if (shortLowerCallStrike < longCallStrike) {
        continue;
      }
      
      const longHigherCallStrike = shortLowerCallStrike + spreadWidth;
      const spreadKey = `${shortLowerCallStrike}-${longHigherCallStrike}`;
      
      if (addedSpreads.has(spreadKey)) {
        continue;
      }
      
      let shortLowerCallData = null;
      let longHigherCallData = null;
      
      for (const [expiration, strikes] of Object.entries(expirationStrikes)) {
        const shortStrikeKey = shortLowerCallStrike.toString() + '.0';
        const longStrikeKey = longHigherCallStrike.toString() + '.0';
        
        if (strikes[shortStrikeKey] && strikes[longStrikeKey]) {
          shortLowerCallData = strikes[shortStrikeKey][0];
          longHigherCallData = strikes[longStrikeKey][0];
          break;
        }
      }
      
      if (!shortLowerCallData || !longHigherCallData) {
        continue;
      }
      
      const shortLowerCallCredit = (shortLowerCallData.bid + shortLowerCallData.ask) / 2;
      const longHigherCallCost = (longHigherCallData.bid + longHigherCallData.ask) / 2;
      const spreadCredit = (shortLowerCallCredit - longHigherCallCost) * 100;
      
      if (spreadCredit <= 0) {
        continue;
      }
      
      const offsetMaxValue = -(spreadWidth * 100);
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
      
      if (lockedInProfit < 0) {
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
        spreadWidth: spreadWidth,
        maxValue: offsetMaxValue,
        lockedInProfit: lockedInProfit,
        profitPotential: profitPotential,
        profitPotentialScore: profitPotentialScore,
        description: `Bear Call Spread: Short ${shortLowerCallStrike}C @ ${shortLowerCallCredit.toFixed(2)}, Long ${longHigherCallStrike}C @ ${longHigherCallCost.toFixed(2)}`
      };
      
      possibleOffsets.push(offsettingSpread);
      addedSpreads.add(spreadKey);
      
      const shortLowerCallStrikeIndex = callStrikes.indexOf(shortLowerCallStrike);
      if (shortLowerCallStrikeIndex !== -1) {
        for (let i = shortLowerCallStrikeIndex + 1; i < callStrikes.length; i++) {
          const widerLongHigherCallStrike = callStrikes[i];
          const widerSpreadWidth = widerLongHigherCallStrike - shortLowerCallStrike;
          
          if (widerSpreadWidth <= spreadWidth) {
            continue;
          }
          
          const widerSpreadKey = `${shortLowerCallStrike}-${widerLongHigherCallStrike}`;
          
          if (addedSpreads.has(widerSpreadKey)) {
            continue;
          }
          
          let widerLongHigherCallData = null;
          
          for (const [expiration, strikes] of Object.entries(expirationStrikes)) {
            const widerLongStrikeKey = widerLongHigherCallStrike.toString() + '.0';
            
            if (strikes[widerLongStrikeKey]) {
              widerLongHigherCallData = strikes[widerLongStrikeKey][0];
              break;
            }
          }
          
          if (!widerLongHigherCallData) {
            continue;
          }
          
          const widerLongHigherCallCost = (widerLongHigherCallData.bid + widerLongHigherCallData.ask) / 2;
          const widerSpreadCredit = (shortLowerCallCredit - widerLongHigherCallCost) * 100;
          
          if (widerSpreadCredit <= 0) {
            continue;
          }
          
          const widerOffsetMaxValue = -(widerSpreadWidth * 100);
          const widerBearCallMaxLoss = widerOffsetMaxValue;
          
          let widerWorstCase, widerBestCase;
          
          if (isBullCallSpread) {
            const bullCallLongStrike = Math.min(...position.legs.map(leg => leg.strike));
            const bullCallShortStrike = Math.max(...position.legs.map(leg => leg.strike));
            const bearCallShortStrike = shortLowerCallStrike;
            const bearCallLongStrike = widerLongHigherCallStrike;
            
            const widerNetCost = position.cost - widerSpreadCredit;
            const strikesOverlap = bullCallLongStrike < bearCallLongStrike && bearCallShortStrike < bullCallShortStrike;
            
            if (strikesOverlap) {
              widerWorstCase = position.maxValue + widerBearCallMaxLoss - widerNetCost;
              
              if (bearCallShortStrike >= bullCallLongStrike && bearCallShortStrike <= bullCallShortStrike) {
                const bullCallValueAtBearCallShort = (bearCallShortStrike - bullCallLongStrike) * 100;
                widerBestCase = bullCallValueAtBearCallShort - widerNetCost;
              } else {
                widerBestCase = position.maxValue - widerNetCost;
              }
            } else {
              widerWorstCase = position.maxValue + widerBearCallMaxLoss - widerNetCost;
              widerBestCase = position.maxValue - widerNetCost;
            }
            
          } else if (isBullPutSpread) {
            const bullPutCredit = -position.cost;
            const bullPutMaxLoss = Math.abs(position.maxValue || 0);
            const widerBearCallMaxLossAbs = Math.abs(widerBearCallMaxLoss);
            
            const totalCredit = bullPutCredit + widerSpreadCredit;
            const maxLossWorstSpread = Math.max(bullPutMaxLoss, widerBearCallMaxLossAbs);
            
            widerWorstCase = -maxLossWorstSpread + totalCredit;
            widerBestCase = totalCredit;
            
          } else {
            const positionMaxValue = position.maxValue || 0;
            widerWorstCase = positionMaxValue + widerBearCallMaxLoss + widerSpreadCredit - position.cost;
            widerBestCase = positionMaxValue + widerSpreadCredit - position.cost;
          }
          
          const widerLockedInProfit = widerWorstCase;
          const widerProfitPotential = widerBestCase;
          const widerProfitPotentialScore = widerProfitPotential !== 0 ? widerLockedInProfit / widerProfitPotential : 0;
          
          if (widerLockedInProfit < 0) {
            continue;
          }
          
          const widerOffsetSpread = {
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
                strike: widerLongHigherCallStrike,
                cost: widerLongHigherCallCost * 100,
                originalString: `1c${widerLongHigherCallStrike}@${widerLongHigherCallCost * 100}`
              }
            ],
            cost: -widerSpreadCredit,
            spreadWidth: widerSpreadWidth,
            maxValue: widerOffsetMaxValue,
            lockedInProfit: widerLockedInProfit,
            profitPotential: widerProfitPotential,
            profitPotentialScore: widerProfitPotentialScore,
            description: `Bear Call Spread: Short ${shortLowerCallStrike}C @ ${shortLowerCallCredit.toFixed(2)}, Long ${widerLongHigherCallStrike}C @ ${widerLongHigherCallCost.toFixed(2)}`
          };
          
          possibleOffsets.push(widerOffsetSpread);
          addedSpreads.add(widerSpreadKey);
        }
      }
    }
    
    return { strategy: 'bear_call_spread', possibleOffsets };
  }

  /**
   * Find offsetting Bull Put Spread positions
   */
  function findOffsettingBullPutSpread(position, chainData) {
    const possibleOffsets = [];
    
    const isBearPutSpread = position.strategy === 'bear_put_spread';
    const isBearCallSpread = position.strategy === 'bear_call_spread';
    
    const spreadWidth = position.spreadWidth || Math.abs(position.legs[0].strike - position.legs[1].strike);
    const offsetBudget = Math.abs(position.offsetBudget || position.cost);
    
    let referenceStrike;
    if (isBearPutSpread) {
      referenceStrike = Math.min(...position.legs.map(leg => leg.strike));
    } else if (isBearCallSpread) {
      referenceStrike = Math.min(...position.legs.map(leg => leg.strike));
    } else {
      referenceStrike = Math.min(...position.legs.map(leg => leg.strike));
    }
        
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
    
    for (const shortHigherPutStrike of putStrikes) {
      if (shortHigherPutStrike >= referenceStrike) {
        continue;
      }
      
      const longLowerPutStrike = shortHigherPutStrike - spreadWidth;
      const spreadKey = `${shortHigherPutStrike}-${longLowerPutStrike}`;
      
      if (addedSpreads.has(spreadKey)) {
        continue;
      }
      
      let shortHigherPutData = null;
      let longLowerPutData = null;
      
      for (const [expiration, strikes] of Object.entries(expirationStrikes)) {
        const shortStrikeKey = shortHigherPutStrike.toString() + '.0';
        const longStrikeKey = longLowerPutStrike.toString() + '.0';
        
        if (strikes[shortStrikeKey] && strikes[longStrikeKey]) {
          shortHigherPutData = strikes[shortStrikeKey][0];
          longLowerPutData = strikes[longStrikeKey][0];
          break;
        }
      }
      
      if (!shortHigherPutData || !longLowerPutData) {
        continue;
      }
      
      const shortHigherPutCredit = (shortHigherPutData.bid + shortHigherPutData.ask) / 2;
      const longLowerPutCost = (longLowerPutData.bid + longLowerPutData.ask) / 2;
      const spreadCredit = (shortHigherPutCredit - longLowerPutCost) * 100;
      
      if (spreadCredit <= 0) {
        continue;
      }
      
      if (spreadCredit > offsetBudget) {
        continue;
      }
      
      const bullPutMaxLoss = -(spreadWidth * 100);
      let worstCase, bestCase;
      
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
          bestCaseProfit = Math.max(bestCaseProfit, bearPutMaxValue - netCost);
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
        spreadWidth: spreadWidth,
        maxValue: bullPutMaxLoss,
        lockedInProfit: lockedInProfit,
        profitPotential: profitPotential,
        profitPotentialScore: profitPotentialScore,
        description: `Bull Put Spread: Short ${shortHigherPutStrike}P @ ${shortHigherPutCredit.toFixed(2)}, Long ${longLowerPutStrike}P @ ${longLowerPutCost.toFixed(2)}`
      };
      
      possibleOffsets.push(offsettingSpread);
      addedSpreads.add(spreadKey);
      
      const shortHigherPutStrikeIndex = putStrikes.indexOf(shortHigherPutStrike);
      if (shortHigherPutStrikeIndex !== -1) {
        for (let i = shortHigherPutStrikeIndex + 1; i < putStrikes.length; i++) {
          const widerLongLowerPutStrike = putStrikes[i];
          const widerSpreadWidth = shortHigherPutStrike - widerLongLowerPutStrike;
          
          if (widerSpreadWidth <= spreadWidth) {
            continue;
          }
          
          const widerSpreadKey = `${shortHigherPutStrike}-${widerLongLowerPutStrike}`;
          
          if (addedSpreads.has(widerSpreadKey)) {
            continue;
          }
          
          let widerLongLowerPutData = null;
          
          for (const [expiration, strikes] of Object.entries(expirationStrikes)) {
            const widerLongStrikeKey = widerLongLowerPutStrike.toString() + '.0';
            
            if (strikes[widerLongStrikeKey]) {
              widerLongLowerPutData = strikes[widerLongStrikeKey][0];
              break;
            }
          }
          
          if (!widerLongLowerPutData) {
            continue;
          }
          
          const widerLongLowerPutCost = (widerLongLowerPutData.bid + widerLongLowerPutData.ask) / 2;
          const widerSpreadCredit = (shortHigherPutCredit - widerLongLowerPutCost) * 100;
          
          if (widerSpreadCredit <= 0) {
            continue;
          }
          
          if (widerSpreadCredit > offsetBudget) {
            continue;
          }
          
          const widerBullPutMaxLoss = -(widerSpreadWidth * 100);
          let widerWorstCase, widerBestCase;
          
          if (isBearPutSpread) {
            const bearPutMaxValue = position.maxValue || (spreadWidth * 100);
            widerWorstCase = bearPutMaxValue + widerBullPutMaxLoss + widerSpreadCredit - position.cost;
            widerBestCase = bearPutMaxValue + widerSpreadCredit - position.cost;
          } else if (isBearCallSpread) {
            const bearCallCredit = -position.cost;
            const bearCallMaxLoss = -(spreadWidth * 100);
            
            const totalCredit = bearCallCredit + widerSpreadCredit;
            const maxLossEitherSpread = Math.abs(bearCallMaxLoss);
            
            widerWorstCase = -maxLossEitherSpread + totalCredit;
            widerBestCase = totalCredit;
          } else {
            const positionMaxValue = position.maxValue || 0;
            widerWorstCase = positionMaxValue + widerBullPutMaxLoss + widerSpreadCredit - position.cost;
            widerBestCase = positionMaxValue + widerSpreadCredit - position.cost;
          }
          
          const widerLockedInProfit = widerWorstCase;
          const widerProfitPotential = widerBestCase;
          const widerProfitPotentialScore = widerProfitPotential !== 0 ? widerLockedInProfit / widerProfitPotential : 0;
          
          if (widerLockedInProfit < 0) {
            continue;
          }
          
          const widerOffsetSpread = {
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
                strike: widerLongLowerPutStrike,
                cost: widerLongLowerPutCost * 100,
                originalString: `1p${widerLongLowerPutStrike}@${widerLongLowerPutCost * 100}`
              }
            ],
            cost: -widerSpreadCredit,
            spreadWidth: widerSpreadWidth,
            maxValue: widerBullPutMaxLoss,
            lockedInProfit: widerLockedInProfit,
            profitPotential: widerProfitPotential,
            profitPotentialScore: widerProfitPotentialScore,
            description: `Bull Put Spread: Short ${shortHigherPutStrike}P @ ${shortHigherPutCredit.toFixed(2)}, Long ${widerLongLowerPutStrike}P @ ${widerLongLowerPutCost.toFixed(2)}`
          };
          
          possibleOffsets.push(widerOffsetSpread);
          addedSpreads.add(widerSpreadKey);
        }
      }
    }
    
    return { strategy: 'bull_put_spread', possibleOffsets };
  }

  /**
   * Find offsetting Bear Put Spread positions
   */
  function findOffsettingBearPutSpread(position, chainData) {
    const possibleOffsets = [];
    
    const longCallStrike = Math.min(...position.legs.map(leg => leg.strike));
    const spreadWidth = position.spreadWidth || Math.abs(position.legs[0].strike - position.legs[1].strike);
    const offsetBudget = position.offsetBudget;
        
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
    
    for (const shortPutStrike of putStrikes) {
      if (shortPutStrike < longCallStrike) {
        continue;
      }
      
      const longPutStrike = shortPutStrike + spreadWidth;
      const spreadKey = `${longPutStrike}-${shortPutStrike}`;
      
      if (addedSpreads.has(spreadKey)) {
        continue;
      }
      
      let shortPutData = null;
      let longPutData = null;
      
      for (const [expiration, strikes] of Object.entries(expirationStrikes)) {
        const shortStrikeKey = shortPutStrike.toString() + '.0';
        const longStrikeKey = longPutStrike.toString() + '.0';
        
        if (strikes[shortStrikeKey] && strikes[longStrikeKey]) {
          shortPutData = strikes[shortStrikeKey][0];
          longPutData = strikes[longStrikeKey][0];
          break;
        }
      }
      
      if (!shortPutData || !longPutData) {
        continue;
      }
      
      const longPutCost = (longPutData.bid + longPutData.ask) / 2;
      const shortPutCost = (shortPutData.bid + shortPutData.ask) / 2;
      const spreadCost = (longPutCost - shortPutCost) * 100;
      
      if (spreadCost > offsetBudget) {
        break;
      }
      
      const offsetMaxValue = spreadWidth * 100;
      
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
          
          // Best case: one of them reaches max value
          const maxMaxValue = Math.max(position.maxValue, offsetMaxValue);
          profitPotential = maxMaxValue - totalCost;
        } else {
          // Strikes overlap - at least one spread will have value at any price
          const strikesOverlap = bullCallLongStrike < bearPutLongStrike && bearPutShortStrike < bullCallShortStrike;
          
          if (strikesOverlap) {
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
            const minMaxValue = Math.min(position.maxValue, offsetMaxValue);
            const maxMaxValue = Math.max(position.maxValue, offsetMaxValue);
            lockedInProfit = minMaxValue - totalCost;
            profitPotential = maxMaxValue - totalCost;
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
        spreadWidth: spreadWidth,
        maxValue: offsetMaxValue,
        lockedInProfit: lockedInProfit,
        profitPotential: profitPotential,
        profitPotentialScore: profitPotentialScore,
        description: `Bear Put Spread: Long ${longPutStrike}P @ ${longPutCost.toFixed(2)}, Short ${shortPutStrike}P @ ${shortPutCost.toFixed(2)}`
      };
      
      possibleOffsets.push(offsettingSpread);
      addedSpreads.add(spreadKey);
      
      const longPutStrikeIndex = putStrikes.indexOf(longPutStrike);
      if (longPutStrikeIndex !== -1) {
        for (let i = longPutStrikeIndex + 1; i < putStrikes.length; i++) {
          const widerLongPutStrike = putStrikes[i];
          const widerSpreadWidth = widerLongPutStrike - shortPutStrike;
          
          if (widerSpreadWidth <= spreadWidth) {
            continue;
          }
          
          const widerSpreadKey = `${widerLongPutStrike}-${shortPutStrike}`;
          
          if (addedSpreads.has(widerSpreadKey)) {
            continue;
          }
          
          let widerLongPutData = null;
          
          for (const [expiration, strikes] of Object.entries(expirationStrikes)) {
            const widerLongStrikeKey = widerLongPutStrike.toString() + '.0';
            
            if (strikes[widerLongStrikeKey]) {
              widerLongPutData = strikes[widerLongStrikeKey][0];
              break;
            }
          }
          
          if (!widerLongPutData) {
            continue;
          }
          
          const widerLongPutCost = (widerLongPutData.bid + widerLongPutData.ask) / 2;
          const widerSpreadCost = (widerLongPutCost - shortPutCost) * 100;
          
          if (widerSpreadCost > offsetBudget) {
            break;
          }
          
          const widerOffsetMaxValue = widerSpreadWidth * 100;
          
          let widerLockedInProfit, widerProfitPotential, widerProfitPotentialScore;
          
          if (isBullCallSpread) {
            const widerTotalCost = position.cost + widerSpreadCost;
            
            const bullCallLongStrike = Math.min(...position.legs.map(leg => leg.strike));
            const bullCallShortStrike = Math.max(...position.legs.map(leg => leg.strike));
            const bearPutShortStrike = shortPutStrike;
            const bearPutLongStrike = widerLongPutStrike;
            
            const strikesOverlap = bearPutShortStrike >= bullCallLongStrike && bearPutLongStrike >= bullCallShortStrike;
            
            if (strikesOverlap) {
              const widerMinMaxValue = Math.min(position.maxValue, widerOffsetMaxValue);
              widerLockedInProfit = widerMinMaxValue - widerTotalCost;
              
              let maxCombinedValue = 0;
              
              if (bearPutShortStrike >= bullCallLongStrike && bearPutShortStrike <= bullCallShortStrike) {
                const bullCallValueAtBearPutShort = (bearPutShortStrike - bullCallLongStrike) * 100;
                const bearPutValueAtShort = widerOffsetMaxValue;
                maxCombinedValue = Math.max(maxCombinedValue, bullCallValueAtBearPutShort + bearPutValueAtShort);
              }
              
              if (bullCallShortStrike >= bearPutShortStrike && bullCallShortStrike <= bearPutLongStrike) {
                const bullCallValueAtShort = position.maxValue;
                const bearPutValueAtBullCallShort = (bearPutLongStrike - bullCallShortStrike) * 100;
                maxCombinedValue = Math.max(maxCombinedValue, bullCallValueAtShort + bearPutValueAtBullCallShort);
              }
              
              if (maxCombinedValue === 0) {
                maxCombinedValue = Math.max(position.maxValue, widerOffsetMaxValue);
              }
              
              widerProfitPotential = maxCombinedValue - widerTotalCost;
            } else {
              const widerMinMaxValue = Math.min(position.maxValue, widerOffsetMaxValue);
              const widerMaxMaxValue = Math.max(position.maxValue, widerOffsetMaxValue);
              widerLockedInProfit = widerMinMaxValue - widerTotalCost;
              widerProfitPotential = widerMaxMaxValue - widerTotalCost;
            }
            
            widerProfitPotentialScore = widerProfitPotential !== 0 ? widerLockedInProfit / widerProfitPotential : 0;
            
          } else if (isBullPutSpread) {
            const bullPutShortStrike = Math.max(...position.legs.map(leg => leg.strike));
            const bullPutLongStrike = Math.min(...position.legs.map(leg => leg.strike));
            const bearPutLongStrike = widerLongPutStrike;
            const bearPutShortStrike = shortPutStrike;
            
            const bullPutCredit = -position.cost;
            const widerNetCredit = bullPutCredit - widerSpreadCost;
            
            const bullPutMaxLoss = Math.abs(position.maxValue || 0);
            const bearPutMaxValue = widerOffsetMaxValue;
            
            const worstCaseLowPrice = bearPutMaxValue - bullPutMaxLoss + widerNetCredit;
            const worstCaseHighPrice = widerNetCredit;
            
            widerLockedInProfit = Math.min(worstCaseLowPrice, worstCaseHighPrice);
            
            let bestCaseProfit = widerNetCredit;
            
            if (bearPutLongStrike >= bullPutLongStrike && bearPutLongStrike <= bullPutShortStrike) {
              const bearPutValueAtLong = bearPutMaxValue;
              const bullPutLossAtBearLong = (bullPutShortStrike - bearPutLongStrike) * 100;
              bestCaseProfit = Math.max(bestCaseProfit, bearPutValueAtLong - bullPutLossAtBearLong + widerNetCredit);
            }
            
            if (bullPutShortStrike >= bearPutShortStrike && bullPutShortStrike <= bearPutLongStrike) {
              const bearPutValueAtBullShort = (bearPutLongStrike - bullPutShortStrike) * 100;
              bestCaseProfit = Math.max(bestCaseProfit, bearPutValueAtBullShort + widerNetCredit);
            }
            
            if (bearPutLongStrike < bullPutLongStrike) {
              bestCaseProfit = Math.max(bestCaseProfit, bearPutMaxValue + widerNetCredit);
            }
            
            widerProfitPotential = bestCaseProfit;
            widerProfitPotentialScore = widerProfitPotential !== 0 ? widerLockedInProfit / widerProfitPotential : 0;
            
          } else {
            const widerMinMaxValue = Math.min(position.maxValue || 0, widerOffsetMaxValue);
            const widerMaxMaxValue = Math.max(position.maxValue || 0, widerOffsetMaxValue);
            const widerTotalCost = position.cost + widerSpreadCost;
            widerLockedInProfit = widerMinMaxValue - widerTotalCost;
            widerProfitPotential = widerMaxMaxValue - widerTotalCost;
            widerProfitPotentialScore = widerProfitPotential !== 0 ? widerLockedInProfit / widerProfitPotential : 0;
          }
          
          if (widerLockedInProfit < 0) {
            continue;
          }
          
          const widerOffsetSpread = {
            strategy: 'bear_put_spread',
            legs: [
              {
                action: 'offset',
                quantity: 1,
                type: 'P',
                strike: widerLongPutStrike,
                cost: widerLongPutCost * 100,
                originalString: `1p${widerLongPutStrike}@${widerLongPutCost * 100}`
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
            cost: widerSpreadCost,
            spreadWidth: widerSpreadWidth,
            maxValue: widerOffsetMaxValue,
            lockedInProfit: widerLockedInProfit,
            profitPotential: widerProfitPotential,
            profitPotentialScore: widerProfitPotentialScore,
            description: `Bear Put Spread: Long ${widerLongPutStrike}P @ ${widerLongPutCost.toFixed(2)}, Short ${shortPutStrike}P @ ${shortPutCost.toFixed(2)}`
          };
          
          possibleOffsets.push(widerOffsetSpread);
          addedSpreads.add(widerSpreadKey);
        }
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
