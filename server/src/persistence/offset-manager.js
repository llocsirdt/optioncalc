#!/usr/bin/env node

/**
 * Offset Management Module
 * 
 * Handles finding and analyzing offsetting positions
 */

class OffsetManager {
  constructor() {
    this.positions = [];
  }

  
  /**
   * Find offsetting positions (placeholder function)
   * Currently just outputs position information for analysis
   */
  async findOffsettingPositions(positions, persistenceManager) {
    const results = {};
    
    for (const symbolExpiration of Object.keys(positions)) {
      const [symbol, expiration] = symbolExpiration.split('_');
      
      // Remove dollar sign from symbol for cache lookup (most symbols don't have it)
      const cacheSymbol = symbol.startsWith('$') ? symbol.substring(1) : symbol;
      const cacheKey = `${cacheSymbol}_${expiration}`;
      
      // Get or fetch fresh option chain data
      const chainData = await this.getOrFetchChainData(symbol, expiration, persistenceManager);
      
      results[symbolExpiration] = {
        positions: positions[symbolExpiration].map(position => {
          let offsettingAnalysis = {};
          
          // Skip offsetting analysis if position is covered
          if (position.covered === true) {
            return {
              ...position,
              offsettingAnalysis: {
                possibleOffsets: [],
                message: 'Position is covered - no offsetting analysis performed'
              }
            };
          }
          
          // Switch based on strategy to determine offsetting approach
          switch (position.strategy) {
            case 'long_call':
              // For long call: look for long put, short call, bear call spread, bear put spread
              const longPutOffsets = this.findOffsettingLongPut(position, chainData);
              const shortCallOffsets = this.findOffsettingShortCall(position, chainData);
              const bearCallSpreadOffsets = this.findOffsettingBearCallSpread(position, chainData);
              const bearPutSpreadOffsets = this.findOffsettingBearPutSpread(position, chainData);
              offsettingAnalysis = this.aggregateOffsettingResults([longPutOffsets, shortCallOffsets, bearCallSpreadOffsets, bearPutSpreadOffsets]);
              break;
            case 'short_call':
              // For short call: look for long call, short put, bull call spread, bull put spread
              const longCallOffsets1 = this.findOffsettingLongCall(position, chainData);
              const shortPutOffsets1 = this.findOffsettingShortPut(position, chainData);
              const bullCallSpreadOffsets1 = this.findOffsettingBullCallSpread(position, chainData);
              const bullPutSpreadOffsets1 = this.findOffsettingBullPutSpread(position, chainData);
              offsettingAnalysis = this.aggregateOffsettingResults([longCallOffsets1, shortPutOffsets1, bullCallSpreadOffsets1, bullPutSpreadOffsets1]);
              break;
            case 'long_put':
              // For long put: look for long call, short put, bear call spread, bear put spread
              const longCallOffsets2 = this.findOffsettingLongCall(position, chainData);
              const shortPutOffsets2 = this.findOffsettingShortPut(position, chainData);
              const bearCallSpreadOffsets2 = this.findOffsettingBearCallSpread(position, chainData);
              const bearPutSpreadOffsets2 = this.findOffsettingBearPutSpread(position, chainData);
              offsettingAnalysis = this.aggregateOffsettingResults([longCallOffsets2, shortPutOffsets2, bearCallSpreadOffsets2, bearPutSpreadOffsets2]);
              break;
            case 'short_put':
              // For short put: look for long call, short call, bull call spread, bull put spread
              const longCallOffsets3 = this.findOffsettingLongCall(position, chainData);
              const shortCallOffsets3 = this.findOffsettingShortCall(position, chainData);
              const bullCallSpreadOffsets3 = this.findOffsettingBullCallSpread(position, chainData);
              const bullPutSpreadOffsets3 = this.findOffsettingBullPutSpread(position, chainData);
              offsettingAnalysis = this.aggregateOffsettingResults([longCallOffsets3, shortCallOffsets3, bullCallSpreadOffsets3, bullPutSpreadOffsets3]);
              break;
            case 'bull_call_spread':
              // For bull call spread: look for long call, short put, bear call spread, bear put spread
              const longCallOffsets4 = this.findOffsettingLongCall(position, chainData);
              const shortPutOffsets4 = this.findOffsettingShortPut(position, chainData);
              const bearCallSpreadOffsets4 = this.findOffsettingBearCallSpread(position, chainData);
              const bearPutSpreadOffsets4 = this.findOffsettingBearPutSpread(position, chainData);
              offsettingAnalysis = this.aggregateOffsettingResults([longCallOffsets4, shortPutOffsets4, bearCallSpreadOffsets4, bearPutSpreadOffsets4]);
              break;
            case 'bear_call_spread':
              // For bear call spread: look for long put, short call, bull call spread, bull put spread
              const longPutOffsets3 = this.findOffsettingLongPut(position, chainData);
              const shortCallOffsets4 = this.findOffsettingShortCall(position, chainData);
              const bullCallSpreadOffsets4 = this.findOffsettingBullCallSpread(position, chainData);
              const bullPutSpreadOffsets4 = this.findOffsettingBullPutSpread(position, chainData);
              offsettingAnalysis = this.aggregateOffsettingResults([longPutOffsets3, shortCallOffsets4, bullCallSpreadOffsets4, bullPutSpreadOffsets4]);
              break;
            case 'bull_put_spread':
              // For bull put spread: look for long call, short put, bear call spread, bear put spread
              const longCallOffsets5 = this.findOffsettingLongCall(position, chainData);
              const shortPutOffsets5 = this.findOffsettingShortPut(position, chainData);
              const bearCallSpreadOffsets5 = this.findOffsettingBearCallSpread(position, chainData);
              const bearPutSpreadOffsets5 = this.findOffsettingBearPutSpread(position, chainData);
              offsettingAnalysis = this.aggregateOffsettingResults([longCallOffsets5, shortPutOffsets5, bearCallSpreadOffsets5, bearPutSpreadOffsets5]);
              break;
            case 'bear_put_spread':
              // For bear put spread: look for long call, short put, bull call spread, bull put spread
              const longCallOffsets6 = this.findOffsettingLongCall(position, chainData);
              const shortPutOffsets6 = this.findOffsettingShortPut(position, chainData);
              const bullCallSpreadOffsets6 = this.findOffsettingBullCallSpread(position, chainData);
              const bullPutSpreadOffsets6 = this.findOffsettingBullPutSpread(position, chainData);
              offsettingAnalysis = this.aggregateOffsettingResults([longCallOffsets6, shortPutOffsets6, bullCallSpreadOffsets6, bullPutSpreadOffsets6]);
              break;
            default:
              // TODO: Handle unknown strategies
              break;
          }
          
          return {
            strategy: position.strategy,
            cost: position.cost,
            offsetBudget: position.offsetBudget,
            covered: position.covered,
            spreadWidth: position.spreadWidth,
            maxValue: position.maxValue,
            legs: position.legs, // Return full leg data with all fields
            offsettingAnalysis
          };
        })
      };
    }
    
    return results;
  }

  /**
   * Get cached chain data or fetch fresh data if needed
   */
  async getOrFetchChainData(symbol, expiration, persistenceManager) {
    // Use consistent cache symbol logic (same as chains-handler)
    const cacheSymbol = symbol.startsWith('$') ? symbol.substring(1) : symbol;
    const cacheKey = `${cacheSymbol}_${expiration}`;
    const cachedData = persistenceManager.getChainCache(cacheKey);
    
    // Check if we have fresh data (less than 5 seconds old)
    const FRESHNESS_THRESHOLD = 5000; // 5 seconds
    const now = Date.now();
    
    if (cachedData && cachedData.timestamp && (now - cachedData.timestamp) < FRESHNESS_THRESHOLD) {
      console.log(`📊 Using fresh cached chain data for ${symbol} ${expiration}`);
      return cachedData.data;
    }
    
    // Fetch fresh data by calling chains-handler directly
    console.log(`🔄 Fetching fresh chain data for ${symbol} ${expiration}`);
    try {
      // Import at call time to avoid module-level circular dependency
      const { handleChainsRequest } = require('./chains-handler');
      const { marketClient } = require('./market-client');
      
      const query = `?symbol=${symbol}&expirationDate=${expiration}`;
      const timestamp = new Date().toISOString();
      
      console.log(`🔍 Calling handleChainsRequest for ${symbol} ${expiration}`);
      
      const result = await handleChainsRequest('/chains', query, timestamp, persistenceManager, marketClient);
      
      if (result && (result.callExpDateMap || result.putExpDateMap)) {
        console.log(`✅ Successfully fetched fresh chain data for ${symbol} ${expiration}`);
        
        const transformedData = {
          call: result.callExpDateMap || {},
          put: result.putExpDateMap || {}
        };
        
        await persistenceManager.cacheChainData(cacheSymbol, expiration, transformedData);
        
        return transformedData;
      } else {
        console.log(`⚠️ No chain data returned for ${symbol} ${expiration}`);
        return { call: {}, put: {} };
      }
    } catch (error) {
      console.error(`❌ Failed to fetch chain data for ${symbol} ${expiration}:`, error.message);
      return { call: {}, put: {} };
    }
  }

  /**
   * Sort offsetting positions by custom priority:
   * Position 1: Highest locked-in profit with score = 1
   * Position 2: Highest profit potential
   * Remaining: Sorted by proximity to balanced score of 0.5
   */
  sortOffsettingPositions(possibleOffsets) {
    if (!possibleOffsets || possibleOffsets.length === 0) {
      return [];
    }

    // Find the best locked-in profit position (with score = 1)
    const bestLockedInProfit = possibleOffsets.reduce((best, current) => {
      if (current.profitPotentialScore === 1.0) {
        return (!best || current.lockedInProfit > best.lockedInProfit) ? current : best;
      }
      return best;
    }, null);
    
    // Find the best profit potential position
    const bestProfitPotential = possibleOffsets.reduce((best, current) => {
      return (!best || current.profitPotential > best.profitPotential) ? current : best;
    }, null);
    
    // Sort all positions by proximity to 0.5
    const sortedByProximity = [...possibleOffsets].sort((a, b) => {
      const aDistance = Math.abs(a.profitPotentialScore - 0.5);
      const bDistance = Math.abs(b.profitPotentialScore - 0.5);
      return aDistance - bDistance;
    });
    
    // Remove the top two from their current positions
    const filteredOffsets = sortedByProximity.filter(o => 
      o !== bestLockedInProfit && o !== bestProfitPotential
    );
    
    // Place them at the top
    const finalSortedOffsets = [];
    if (bestLockedInProfit) finalSortedOffsets.push(bestLockedInProfit);
    if (bestProfitPotential && bestProfitPotential !== bestLockedInProfit) {
      finalSortedOffsets.push(bestProfitPotential);
    }
    finalSortedOffsets.push(...filteredOffsets);
    
    return finalSortedOffsets;
  }

  /**
   * Aggregate results from multiple offsetting find methods
   */
  aggregateOffsettingResults(resultsArray) {
    const aggregated = {
      strategies: [],
      possibleOffsets: []
    };

    resultsArray.forEach(result => {
      if (result.strategy) {
        aggregated.strategies.push(result.strategy);
      }
      if (result.possibleOffsets && Array.isArray(result.possibleOffsets)) {
        aggregated.possibleOffsets.push(...result.possibleOffsets);
      }
    });

    // Sort all aggregated positions together
    aggregated.possibleOffsets = this.sortOffsettingPositions(aggregated.possibleOffsets);

    return aggregated;
  }

  // Placeholder methods for finding offsetting strategies
  
  findOffsettingLongCall(position, chainData) {
    // TODO: Implement long call offsetting logic using chainData
    // Chain data available: chainData.call and chainData.put with strike prices
    return { strategy: 'long_call', possibleOffsets: [] };
  }

  findOffsettingShortCall(position, chainData) {
    // TODO: Implement short call offsetting logic using chainData
    return { strategy: 'short_call', possibleOffsets: [] };
  }

  findOffsettingLongPut(position, chainData) {
    // TODO: Implement long put offsetting logic using chainData
    // Chain data available: chainData.call and chainData.put with strike prices
    return { strategy: 'long_put', possibleOffsets: [] };
  }

  findOffsettingShortPut(position, chainData) {
    // TODO: Implement short put offsetting logic using chainData
    return { strategy: 'short_put', possibleOffsets: [] };
  }

  findOffsettingBullCallSpread(position, chainData) {
    const possibleOffsets = [];
    
    // Get the short and long leg strikes of the bear put spread
    const shortPutStrike = Math.min(...position.legs.map(leg => leg.strike));
    const longPutStrike = Math.max(...position.legs.map(leg => leg.strike));
    const spreadWidth = position.spreadWidth || Math.abs(position.legs[0].strike - position.legs[1].strike);
    const offsetBudget = position.offsetBudget;
        
    // Get call options from chain data - handle nested expiration structure
    const callOptions = chainData.call || null;
    if (!callOptions || Object.keys(callOptions).length === 0) {
      return { strategy: 'bull_call_spread', possibleOffsets: [] };
    }
    
    // Find all available expirations and their strikes
    let allCallStrikes = new Set();
    const expirationStrikes = {};
    
    for (const [expiration, strikes] of Object.entries(callOptions)) {
      const strikeList = Object.keys(strikes).map(strike => parseFloat(strike));
      strikeList.forEach(strike => allCallStrikes.add(strike));
      expirationStrikes[expiration] = strikes;
    }
    
    const callStrikes = Array.from(allCallStrikes).sort((a, b) => b - a); // Sort descending (high to low)
    
    // Track which spread combinations we've already added to avoid duplicates
    const addedSpreads = new Set();
    
    // Look for bull call spreads starting from highest strikes
    // Start from highest strikes and work down - once we exceed budget, all deeper ITM spreads will be more expensive
    for (const longCallStrike of callStrikes) {
      // Long call strike should be at or lower than the long put strike to capture overlapping positions
      if (longCallStrike > longPutStrike) {
        continue; // Skip if long call is higher than long put
      }
      
      const shortCallStrike = longCallStrike + spreadWidth;
      const spreadKey = `${longCallStrike}-${shortCallStrike}`;
      
      // Skip if we've already added this spread
      if (addedSpreads.has(spreadKey)) {
        continue;
      }
      
      // Check if short call strike exists in any expiration
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
      
      // Calculate cost using bid-ask average
      const longCallCost = (longCallData.bid + longCallData.ask) / 2;
      const shortCallCost = (shortCallData.bid + shortCallData.ask) / 2;
      const spreadCost = (longCallCost - shortCallCost) * 100; // Multiply by 100 for contract multiplier
      
      // If spread cost exceeds offset budget, stop looking - all deeper ITM spreads will be more expensive
      if (spreadCost > offsetBudget) {
        break;
      }
      
      // Calculate locked-in profit and profit potential
      const offsetMaxValue = spreadWidth * 100;
      
      // Determine position type
      const isBearPutSpread = position.strategy === 'bear_put_spread';
      const isBearCallSpread = position.strategy === 'bear_call_spread';
      
      let lockedInProfit, profitPotential, profitPotentialScore;
      
      if (isBearPutSpread) {
        // Bear put spread (debit): long higher put, short lower put
        // Bull call spread (debit): long lower call, short higher call
        const totalCost = position.cost + spreadCost;
        
        // Get strike prices for overlap detection
        const bearPutShortStrike = Math.min(...position.legs.map(leg => leg.strike));
        const bearPutLongStrike = Math.max(...position.legs.map(leg => leg.strike));
        const bullCallLongStrike = longCallStrike;
        const bullCallShortStrike = shortCallStrike;
        
        // Check if strikes overlap: standard range overlap check
        // Bear put range: [bearPutShortStrike, bearPutLongStrike]
        // Bull call range: [bullCallLongStrike, bullCallShortStrike]
        const strikesOverlap = bullCallLongStrike < bearPutLongStrike && bearPutShortStrike < bullCallShortStrike;
        
        if (strikesOverlap) {
          // Overlapping strikes: both spreads can profit simultaneously in the overlap zone
          // Worst case: one spread at min value, other worthless
          const minMaxValue = Math.min(position.maxValue, offsetMaxValue);
          lockedInProfit = minMaxValue - totalCost;
          
          // Best case: find the price point that maximizes combined value
          // For bear put (long higher, short lower) + bull call (long lower, short higher)
          // Maximum combined value occurs at the bull call short strike (if within bear put range)
          // or at the bear put short strike (if within bull call range)
          let maxCombinedValue = 0;
          
          // Check value at bull call short strike
          if (bullCallShortStrike >= bearPutShortStrike && bullCallShortStrike <= bearPutLongStrike) {
            const bearPutValueAtBullCallShort = (bearPutLongStrike - bullCallShortStrike) * 100;
            const bullCallValueAtShort = offsetMaxValue;
            maxCombinedValue = Math.max(maxCombinedValue, bearPutValueAtBullCallShort + bullCallValueAtShort);
          }
          
          // Check value at bear put short strike
          if (bearPutShortStrike >= bullCallLongStrike && bearPutShortStrike <= bullCallShortStrike) {
            const bearPutValueAtShort = position.maxValue;
            const bullCallValueAtBearPutShort = (bearPutShortStrike - bullCallLongStrike) * 100;
            maxCombinedValue = Math.max(maxCombinedValue, bearPutValueAtShort + bullCallValueAtBearPutShort);
          }
          
          // If no overlap point found, use standard max
          if (maxCombinedValue === 0) {
            maxCombinedValue = Math.max(position.maxValue, offsetMaxValue);
          }
          
          profitPotential = maxCombinedValue - totalCost;
        } else {
          // Non-overlapping strikes: standard calculation
          const minMaxValue = Math.min(position.maxValue, offsetMaxValue);
          const maxMaxValue = Math.max(position.maxValue, offsetMaxValue);
          lockedInProfit = minMaxValue - totalCost;
          profitPotential = maxMaxValue - totalCost;
        }
        
        profitPotentialScore = profitPotential !== 0 ? lockedInProfit / profitPotential : 0;
        
      } else if (isBearCallSpread) {
        // Bear call spread (credit): short lower call, long higher call
        // Bull call spread (debit): long lower call, short higher call
        // These are OPPOSING spreads - when one profits, the other loses
        
        // Get strike prices
        const bearCallShortStrike = Math.min(...position.legs.map(leg => leg.strike));
        const bearCallLongStrike = Math.max(...position.legs.map(leg => leg.strike));
        const bullCallLongStrike = longCallStrike;
        const bullCallShortStrike = shortCallStrike;
        
        // Net credit/cost
        const bearCallCredit = -position.cost; // position.cost is negative for credit spreads
        const netCredit = bearCallCredit - spreadCost; // Total credit collected minus debit paid
        
        // Worst case: price moves to maximize one spread's loss
        // If price > bearCallLongStrike: bear call loses max, bull call wins max
        // If price < bullCallLongStrike: bull call worthless, bear call keeps credit
        const bearCallMaxLoss = Math.abs(position.maxValue || 0); // Negative value, so take absolute
        const bullCallMaxValue = offsetMaxValue;
        
        // When both spreads are at their extremes, they offset each other
        // Worst case is when the net position is smallest
        const worstCaseHighPrice = bullCallMaxValue - bearCallMaxLoss + netCredit; // Price above both spreads
        const worstCaseLowPrice = netCredit; // Price below both spreads, both expire worthless
        
        lockedInProfit = Math.min(worstCaseHighPrice, worstCaseLowPrice);
        
        // Best case: price lands in optimal zone
        // Check if strikes overlap and find the sweet spot
        let bestCaseProfit = netCredit;
        
        // If bull call short strike is between bear call strikes, that's a good zone
        if (bullCallShortStrike >= bearCallShortStrike && bullCallShortStrike <= bearCallLongStrike) {
          const bullCallValueAtShort = bullCallMaxValue;
          const bearCallLossAtBullShort = (bullCallShortStrike - bearCallShortStrike) * 100;
          bestCaseProfit = Math.max(bestCaseProfit, bullCallValueAtShort - bearCallLossAtBullShort + netCredit);
        }
        
        // If bear call short strike is between bull call strikes, check that zone
        if (bearCallShortStrike >= bullCallLongStrike && bearCallShortStrike <= bullCallShortStrike) {
          const bullCallValueAtBearShort = (bearCallShortStrike - bullCallLongStrike) * 100;
          const bearCallLossAtShort = 0; // Bear call expires worthless below its short strike
          bestCaseProfit = Math.max(bestCaseProfit, bullCallValueAtBearShort + netCredit);
        }
        
        // If spreads don't overlap (bull call short < bear call short), best case is bull call at max, bear call worthless
        if (bullCallShortStrike < bearCallShortStrike) {
          bestCaseProfit = Math.max(bestCaseProfit, bullCallMaxValue + netCredit);
        }
        
        profitPotential = bestCaseProfit;
        profitPotentialScore = profitPotential !== 0 ? lockedInProfit / profitPotential : 0;
        
      } else {
        // Default calculation for other position types
        const minMaxValue = Math.min(position.maxValue || 0, offsetMaxValue);
        const maxMaxValue = Math.max(position.maxValue || 0, offsetMaxValue);
        const totalCost = position.cost + spreadCost;
        lockedInProfit = minMaxValue - totalCost;
        profitPotential = maxMaxValue - totalCost;
        profitPotentialScore = profitPotential !== 0 ? lockedInProfit / profitPotential : 0;
      }
      
      // Add to possible offsets
      const offsettingSpread = {
        strategy: 'bull_call_spread',
        legs: [
          {
            action: 'offset',
            quantity: 1,
            type: 'C',
            strike: longCallStrike,
            cost: longCallCost * 100, // Store actual dollar cost
            originalString: `1c${longCallStrike}@${longCallCost * 100}`
          },
          {
            action: 'offset',
            quantity: -1,
            type: 'C',
            strike: shortCallStrike,
            cost: -shortCallCost * 100, // Store actual dollar cost
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
      
      // Test wider spreads: keep same short call leg, move long call leg deeper ITM
      const currentStrikeIndex = callStrikes.indexOf(longCallStrike);
      for (let i = currentStrikeIndex + 1; i < callStrikes.length; i++) {
        const widerLongCallStrike = callStrikes[i];
        const widerSpreadKey = `${widerLongCallStrike}-${shortCallStrike}`;
        
        // Skip if we've already added this spread
        if (addedSpreads.has(widerSpreadKey)) {
          continue;
        }
        
        // Check if wider long call strike exists in chain data
        let widerLongCallData = null;
        
        for (const [expiration, strikes] of Object.entries(expirationStrikes)) {
          const widerLongStrikeKey = widerLongCallStrike.toString() + '.0';
          
          if (strikes[widerLongStrikeKey]) {
            widerLongCallData = strikes[widerLongStrikeKey][0];
            break;
          }
        }
        
        if (!widerLongCallData) {
          continue; // No data for this strike, try next one
        }
        
        // Calculate cost for wider spread
        const widerLongCallCost = (widerLongCallData.bid + widerLongCallData.ask) / 2;
        const widerSpreadCost = (widerLongCallCost - shortCallCost) * 100;
        
        // If wider spread exceeds budget, stop testing wider spreads for this short leg
        if (widerSpreadCost > offsetBudget) {
          break;
        }
        
        // Calculate locked-in profit and profit potential for wider spread
        const widerSpreadWidth = shortCallStrike - widerLongCallStrike;
        const widerOffsetMaxValue = widerSpreadWidth * 100;
        
        let widerLockedInProfit, widerProfitPotential, widerProfitPotentialScore;
        
        if (isBearPutSpread) {
          // Bear put spread (debit): both are debit spreads
          const widerTotalCost = position.cost + widerSpreadCost;
          
          // Get strike prices for overlap detection
          const bearPutShortStrike = Math.min(...position.legs.map(leg => leg.strike));
          const bearPutLongStrike = Math.max(...position.legs.map(leg => leg.strike));
          const bullCallLongStrike = widerLongCallStrike;
          const bullCallShortStrike = shortCallStrike;
          
          // Check if strikes overlap
          const strikesOverlap = bullCallLongStrike <= bearPutShortStrike && bullCallShortStrike >= bearPutShortStrike;
          
          if (strikesOverlap) {
            // Overlapping strikes: both spreads can profit simultaneously
            const widerMinMaxValue = Math.min(position.maxValue, widerOffsetMaxValue);
            widerLockedInProfit = widerMinMaxValue - widerTotalCost;
            
            // Find the price point that maximizes combined value
            let maxCombinedValue = 0;
            
            // Check value at bull call short strike
            if (bullCallShortStrike >= bearPutShortStrike && bullCallShortStrike <= bearPutLongStrike) {
              const bearPutValueAtBullCallShort = (bearPutLongStrike - bullCallShortStrike) * 100;
              const bullCallValueAtShort = widerOffsetMaxValue;
              maxCombinedValue = Math.max(maxCombinedValue, bearPutValueAtBullCallShort + bullCallValueAtShort);
            }
            
            // Check value at bear put short strike
            if (bearPutShortStrike >= bullCallLongStrike && bearPutShortStrike <= bullCallShortStrike) {
              const bearPutValueAtShort = position.maxValue;
              const bullCallValueAtBearPutShort = (bearPutShortStrike - bullCallLongStrike) * 100;
              maxCombinedValue = Math.max(maxCombinedValue, bearPutValueAtShort + bullCallValueAtBearPutShort);
            }
            
            if (maxCombinedValue === 0) {
              maxCombinedValue = Math.max(position.maxValue, widerOffsetMaxValue);
            }
            
            widerProfitPotential = maxCombinedValue - widerTotalCost;
          } else {
            // Non-overlapping strikes: standard calculation
            const widerMinMaxValue = Math.min(position.maxValue, widerOffsetMaxValue);
            const widerMaxMaxValue = Math.max(position.maxValue, widerOffsetMaxValue);
            widerLockedInProfit = widerMinMaxValue - widerTotalCost;
            widerProfitPotential = widerMaxMaxValue - widerTotalCost;
          }
          
          widerProfitPotentialScore = widerProfitPotential !== 0 ? widerLockedInProfit / widerProfitPotential : 0;
          
        } else if (isBearCallSpread) {
          // Bear call spread (credit): offsetting with bull call spread (debit)
          // These are OPPOSING spreads - when one profits, the other loses
          
          // Get strike prices
          const bearCallShortStrike = Math.min(...position.legs.map(leg => leg.strike));
          const bearCallLongStrike = Math.max(...position.legs.map(leg => leg.strike));
          const bullCallLongStrike = widerLongCallStrike;
          const bullCallShortStrike = shortCallStrike;
          
          // Net credit/cost
          const bearCallCredit = -position.cost;
          const widerNetCredit = bearCallCredit - widerSpreadCost;
          
          // Worst case calculations
          const bearCallMaxLoss = Math.abs(position.maxValue || 0);
          const bullCallMaxValue = widerOffsetMaxValue;
          
          const worstCaseHighPrice = bullCallMaxValue - bearCallMaxLoss + widerNetCredit;
          const worstCaseLowPrice = widerNetCredit;
          
          widerLockedInProfit = Math.min(worstCaseHighPrice, worstCaseLowPrice);
          
          // Best case: find optimal zone
          let bestCaseProfit = widerNetCredit;
          
          if (bullCallShortStrike >= bearCallShortStrike && bullCallShortStrike <= bearCallLongStrike) {
            const bullCallValueAtShort = bullCallMaxValue;
            const bearCallLossAtBullShort = (bullCallShortStrike - bearCallShortStrike) * 100;
            bestCaseProfit = Math.max(bestCaseProfit, bullCallValueAtShort - bearCallLossAtBullShort + widerNetCredit);
          }
          
          if (bearCallShortStrike >= bullCallLongStrike && bearCallShortStrike <= bullCallShortStrike) {
            const bullCallValueAtBearShort = (bearCallShortStrike - bullCallLongStrike) * 100;
            bestCaseProfit = Math.max(bestCaseProfit, bullCallValueAtBearShort + widerNetCredit);
          }
          
          // If spreads don't overlap (bull call short < bear call short), best case is bull call at max, bear call worthless
          if (bullCallShortStrike < bearCallShortStrike) {
            bestCaseProfit = Math.max(bestCaseProfit, bullCallMaxValue + widerNetCredit);
          }
          
          widerProfitPotential = bestCaseProfit;
          widerProfitPotentialScore = widerProfitPotential !== 0 ? widerLockedInProfit / widerProfitPotential : 0;
          
        } else {
          // Default calculation
          const widerMinMaxValue = Math.min(position.maxValue || 0, widerOffsetMaxValue);
          const widerMaxMaxValue = Math.max(position.maxValue || 0, widerOffsetMaxValue);
          const widerTotalCost = position.cost + widerSpreadCost;
          widerLockedInProfit = widerMinMaxValue - widerTotalCost;
          widerProfitPotential = widerMaxMaxValue - widerTotalCost;
          widerProfitPotentialScore = widerProfitPotential !== 0 ? widerLockedInProfit / widerProfitPotential : 0;
        }
        
        // Add wider spread to possible offsets
        const widerOffsetSpread = {
          strategy: 'bull_call_spread',
          legs: [
            {
              action: 'offset',
              quantity: 1,
              type: 'C',
              strike: widerLongCallStrike,
              cost: widerLongCallCost * 100,
              originalString: `1c${widerLongCallStrike}@${widerLongCallCost * 100}`
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
          cost: widerSpreadCost,
          spreadWidth: widerSpreadWidth,
          maxValue: widerOffsetMaxValue,
          lockedInProfit: widerLockedInProfit,
          profitPotential: widerProfitPotential,
          profitPotentialScore: widerProfitPotentialScore,
          description: `Bull Call Spread: Long ${widerLongCallStrike}C @ ${widerLongCallCost.toFixed(2)}, Short ${shortCallStrike}C @ ${shortCallCost.toFixed(2)}`
        };
        
        possibleOffsets.push(widerOffsetSpread);
        addedSpreads.add(widerSpreadKey);
      }
    }
    
    return { strategy: 'bull_call_spread', possibleOffsets };
  }

  findOffsettingBearCallSpread(position, chainData) {
    const possibleOffsets = [];
    
    // Get the short leg strike of the bull call spread (the higher strike)
    const shortCallStrike = Math.max(...position.legs.map(leg => leg.strike));
    const spreadWidth = position.spreadWidth || Math.abs(position.legs[0].strike - position.legs[1].strike);
    const offsetBudget = position.offsetBudget;
        
    // Get call options from chain data
    const callOptions = chainData.call || null;
    if (!callOptions || Object.keys(callOptions).length === 0) {
      return { strategy: 'bear_call_spread', possibleOffsets: [] };
    }
    
    // Find all available expirations and their strikes
    let allCallStrikes = new Set();
    const expirationStrikes = {};
    
    for (const [expiration, strikes] of Object.entries(callOptions)) {
      const strikeList = Object.keys(strikes).map(strike => parseFloat(strike));
      strikeList.forEach(strike => allCallStrikes.add(strike));
      expirationStrikes[expiration] = strikes;
    }
    
    const callStrikes = Array.from(allCallStrikes).sort((a, b) => a - b); // Sort ascending (low to high)
    
    // Track which spread combinations we've already added to avoid duplicates
    const addedSpreads = new Set();
    
    // Look for bear call spreads that can offset the bull call spread
    // Bear call spread: short lower call, long higher call (generates credit)
    // The bear call short strike can be at or below the bull call short strike
    // to create a zone where bull call is at max and bear call expires worthless
    for (const shortLowerCallStrike of callStrikes) {
      // Skip strikes that are too low (below the bull call's long strike)
      const longCallStrike = Math.min(...position.legs.map(leg => leg.strike));
      if (shortLowerCallStrike < longCallStrike) {
        continue;
      }
      
      const longHigherCallStrike = shortLowerCallStrike + spreadWidth;
      const spreadKey = `${shortLowerCallStrike}-${longHigherCallStrike}`;
      
      // Skip if we've already added this spread
      if (addedSpreads.has(spreadKey)) {
        continue;
      }
      
      // Check if both strikes exist in any expiration
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
      
      // Calculate credit using bid-ask average
      // Bear call spread: sell lower call (credit), buy higher call (debit)
      const shortLowerCallCredit = (shortLowerCallData.bid + shortLowerCallData.ask) / 2;
      const longHigherCallCost = (longHigherCallData.bid + longHigherCallData.ask) / 2;
      const spreadCredit = (shortLowerCallCredit - longHigherCallCost) * 100; // Net credit (positive value)
      
      // If spread credit is negative (would cost money), skip it
      if (spreadCredit <= 0) {
        continue;
      }
      
      // Calculate locked-in profit and profit potential
      // Bear call spread maxValue is the max loss = -(spread width × 100)
      const offsetMaxValue = -(spreadWidth * 100);
      const bearCallMaxLoss = offsetMaxValue; // Negative value
      
      // Determine position type
      const isBullCallSpread = position.strategy === 'bull_call_spread';
      const isBullPutSpread = position.strategy === 'bull_put_spread';
      
      let worstCase, bestCase;
      
      if (isBullCallSpread) {
        // Bull call spread (debit): long lower call, short higher call
        // Bear call spread (credit): short lower call, long higher call
        
        // Get strike prices for overlap detection
        const bullCallLongStrike = Math.min(...position.legs.map(leg => leg.strike));
        const bullCallShortStrike = Math.max(...position.legs.map(leg => leg.strike));
        const bearCallShortStrike = shortLowerCallStrike;
        const bearCallLongStrike = longHigherCallStrike;
        
        // Net cost = debit paid - credit collected
        const netCost = position.cost - spreadCredit;
        
        // Check if strikes overlap: standard range overlap check
        // Bull call range: [bullCallLongStrike, bullCallShortStrike]
        // Bear call range: [bearCallShortStrike, bearCallLongStrike]
        const strikesOverlap = bullCallLongStrike < bearCallLongStrike && bearCallShortStrike < bullCallShortStrike;
        
        if (strikesOverlap) {
          // Overlapping strikes: need to find optimal price point
          
          // Worst case: price above bear call long strike
          // Bull call at max, bear call at max loss
          worstCase = position.maxValue + bearCallMaxLoss - netCost;
          
          // Best case: price at bear call short strike (if within bull call range)
          // Bull call has value, bear call expires worthless
          if (bearCallShortStrike >= bullCallLongStrike && bearCallShortStrike <= bullCallShortStrike) {
            const bullCallValueAtBearCallShort = (bearCallShortStrike - bullCallLongStrike) * 100;
            bestCase = bullCallValueAtBearCallShort - netCost;
          } else {
            // Price at bull call short strike
            bestCase = position.maxValue - netCost;
          }
        } else {
          // Non-overlapping strikes
          // Worst case: Market goes up - bull call wins max, bear call loses max
          worstCase = position.maxValue + bearCallMaxLoss - netCost;
          // Best case: Market between spreads - bull call at max, bear call expires worthless
          bestCase = position.maxValue - netCost;
        }
        
      } else if (isBullPutSpread) {
        // Bull put spread (credit): short higher put, long lower put
        // Bear call spread (credit): short lower call, long higher call
        // For two credit spreads, worst case is when one spread hits max loss
        // but we keep the total credit collected from both spreads
        const bullPutCredit = -position.cost; // Position cost is negative for credit spreads
        const bullPutMaxLoss = Math.abs(position.maxValue || 0); // Absolute value of max loss
        const bearCallMaxLossAbs = Math.abs(bearCallMaxLoss); // Absolute value of max loss
        
        const totalCredit = bullPutCredit + spreadCredit;
        
        // Worst case: The spread with the larger max loss hits max loss, but we keep total credit
        const maxLossWorstSpread = Math.max(bullPutMaxLoss, bearCallMaxLossAbs);
        
        // Worst case: One spread hits max loss, but we keep total credit
        worstCase = -maxLossWorstSpread + totalCredit;
        // Best case: Both spreads expire worthless, we keep total credit
        bestCase = totalCredit;
        
      } else {
        // Default calculation for other position types
        const positionMaxValue = position.maxValue || 0;
        worstCase = positionMaxValue + bearCallMaxLoss + spreadCredit - position.cost;
        bestCase = positionMaxValue + spreadCredit - position.cost;
      }
      
      const lockedInProfit = worstCase; // Worst case scenario
      const profitPotential = bestCase; // Best case scenario (sweet spot between short strikes)
      const profitPotentialScore = profitPotential !== 0 ? lockedInProfit / profitPotential : 0;
      
      // Skip spreads with negative locked-in profit
      if (lockedInProfit < 0) {
        continue;
      }
      
      // Add to possible offsets
      const offsettingSpread = {
        strategy: 'bear_call_spread',
        legs: [
          {
            action: 'offset',
            quantity: -1, // Short the lower strike
            type: 'C',
            strike: shortLowerCallStrike,
            cost: -shortLowerCallCredit * 100,
            originalString: `-1c${shortLowerCallStrike}@${-shortLowerCallCredit * 100}`
          },
          {
            action: 'offset',
            quantity: 1, // Long the higher strike
            type: 'C',
            strike: longHigherCallStrike,
            cost: longHigherCallCost * 100,
            originalString: `1c${longHigherCallStrike}@${longHigherCallCost * 100}`
          }
        ],
        cost: -spreadCredit, // Negative cost = credit received
        spreadWidth: spreadWidth,
        maxValue: offsetMaxValue, // Negative spread width × 100
        lockedInProfit: lockedInProfit,
        profitPotential: profitPotential,
        profitPotentialScore: profitPotentialScore,
        description: `Bear Call Spread: Short ${shortLowerCallStrike}C @ ${shortLowerCallCredit.toFixed(2)}, Long ${longHigherCallStrike}C @ ${longHigherCallCost.toFixed(2)}`
      };
      
      possibleOffsets.push(offsettingSpread);
      addedSpreads.add(spreadKey);
      
      // Test wider spreads: keep same short call leg, move long call leg higher
      // Only test strikes that create spreads WIDER than the initial spread width
      const shortLowerCallStrikeIndex = callStrikes.indexOf(shortLowerCallStrike);
      if (shortLowerCallStrikeIndex !== -1) {
        // Only test wider spreads if we found the shortLowerCallStrike in the array
        for (let i = shortLowerCallStrikeIndex + 1; i < callStrikes.length; i++) {
          const widerLongHigherCallStrike = callStrikes[i];
          const widerSpreadWidth = widerLongHigherCallStrike - shortLowerCallStrike;
          
          // Skip if this spread is not wider than the initial spread
          if (widerSpreadWidth <= spreadWidth) {
            continue;
          }
          
          const widerSpreadKey = `${shortLowerCallStrike}-${widerLongHigherCallStrike}`;
          
          // Skip if we've already added this spread
          if (addedSpreads.has(widerSpreadKey)) {
            continue;
          }
          
          // Check if wider long call strike exists in chain data
          let widerLongHigherCallData = null;
          
          for (const [expiration, strikes] of Object.entries(expirationStrikes)) {
            const widerLongStrikeKey = widerLongHigherCallStrike.toString() + '.0';
            
            if (strikes[widerLongStrikeKey]) {
              widerLongHigherCallData = strikes[widerLongStrikeKey][0];
              break;
            }
          }
          
          if (!widerLongHigherCallData) {
            continue; // No data for this strike, try next one
          }
          
          // Calculate credit for wider spread
          const widerLongHigherCallCost = (widerLongHigherCallData.bid + widerLongHigherCallData.ask) / 2;
          const widerSpreadCredit = (shortLowerCallCredit - widerLongHigherCallCost) * 100;
          
          // If wider spread credit is negative, skip it
          if (widerSpreadCredit <= 0) {
            continue;
          }
          
          // Calculate locked-in profit and profit potential for wider spread
          const widerOffsetMaxValue = -(widerSpreadWidth * 100);
          const widerBearCallMaxLoss = widerOffsetMaxValue; // Negative value
          
          let widerWorstCase, widerBestCase;
          
          if (isBullCallSpread) {
            // Bull call spread (debit): long lower call, short higher call
            // Bear call spread (credit): short lower call, long higher call
            
            // Get strike prices for overlap detection
            const bullCallLongStrike = Math.min(...position.legs.map(leg => leg.strike));
            const bullCallShortStrike = Math.max(...position.legs.map(leg => leg.strike));
            const bearCallShortStrike = shortLowerCallStrike;
            const bearCallLongStrike = widerLongHigherCallStrike;
            
            // Net cost = debit paid - credit collected
            const widerNetCost = position.cost - widerSpreadCredit;
            
            // Check if strikes overlap: standard range overlap check
            // Bull call range: [bullCallLongStrike, bullCallShortStrike]
            // Bear call range: [bearCallShortStrike, bearCallLongStrike]
            const strikesOverlap = bullCallLongStrike < bearCallLongStrike && bearCallShortStrike < bullCallShortStrike;
            
            if (strikesOverlap) {
              // Overlapping strikes: need to find optimal price point
              
              // Worst case: price above bear call long strike
              // Bull call at max, bear call at max loss
              widerWorstCase = position.maxValue + widerBearCallMaxLoss - widerNetCost;
              
              // Best case: price at bear call short strike (if within bull call range)
              // Bull call has value, bear call expires worthless
              if (bearCallShortStrike >= bullCallLongStrike && bearCallShortStrike <= bullCallShortStrike) {
                const bullCallValueAtBearCallShort = (bearCallShortStrike - bullCallLongStrike) * 100;
                widerBestCase = bullCallValueAtBearCallShort - widerNetCost;
              } else {
                // Price at bull call short strike
                widerBestCase = position.maxValue - widerNetCost;
              }
            } else {
              // Non-overlapping strikes
              widerWorstCase = position.maxValue + widerBearCallMaxLoss - widerNetCost;
              widerBestCase = position.maxValue - widerNetCost;
            }
            
          } else if (isBullPutSpread) {
            // Bull put spread (credit): short higher put, long lower put
            // Bear call spread (credit): short lower call, long higher call
            const bullPutCredit = -position.cost;
            const bullPutMaxLoss = Math.abs(position.maxValue || 0); // Absolute value of max loss
            const widerBearCallMaxLossAbs = Math.abs(widerBearCallMaxLoss); // Absolute value of max loss
            
            const totalCredit = bullPutCredit + widerSpreadCredit;
            
            // Worst case: The spread with the larger max loss hits max loss, but we keep total credit
            const maxLossWorstSpread = Math.max(bullPutMaxLoss, widerBearCallMaxLossAbs);
            
            // Worst case: One spread hits max loss, but we keep total credit
            widerWorstCase = -maxLossWorstSpread + totalCredit;
            // Best case: Both spreads expire worthless, we keep total credit
            widerBestCase = totalCredit;
            
          } else {
            // Default calculation for other position types
            const positionMaxValue = position.maxValue || 0;
            widerWorstCase = positionMaxValue + widerBearCallMaxLoss + widerSpreadCredit - position.cost;
            widerBestCase = positionMaxValue + widerSpreadCredit - position.cost;
          }
          
          const widerLockedInProfit = widerWorstCase;
          const widerProfitPotential = widerBestCase;
          const widerProfitPotentialScore = widerProfitPotential !== 0 ? widerLockedInProfit / widerProfitPotential : 0;
          
          // Skip wider spreads with negative locked-in profit
          if (widerLockedInProfit < 0) {
            continue;
          }
          
          // Add wider spread to possible offsets
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
            maxValue: widerOffsetMaxValue, // Negative spread width × 100
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

  findOffsettingBullPutSpread(position, chainData) {
    const possibleOffsets = [];
    
    // Determine if this is a bear put spread or bear call spread
    const isBearPutSpread = position.strategy === 'bear_put_spread';
    const isBearCallSpread = position.strategy === 'bear_call_spread';
    
    const spreadWidth = position.spreadWidth || Math.abs(position.legs[0].strike - position.legs[1].strike);
    const offsetBudget = Math.abs(position.offsetBudget || position.cost);
    
    // For bear put spread: reference strike is the short put (lower strike)
    // For bear call spread: reference strike is the short call (lower strike)
    let referenceStrike;
    if (isBearPutSpread) {
      referenceStrike = Math.min(...position.legs.map(leg => leg.strike));
    } else if (isBearCallSpread) {
      referenceStrike = Math.min(...position.legs.map(leg => leg.strike));
    } else {
      // Default behavior for other position types
      referenceStrike = Math.min(...position.legs.map(leg => leg.strike));
    }
        
    // Get put options from chain data
    const putOptions = chainData.put || null;
    if (!putOptions || Object.keys(putOptions).length === 0) {
      return { strategy: 'bull_put_spread', possibleOffsets: [] };
    }
    
    // Find all available expirations and their strikes
    let allPutStrikes = new Set();
    const expirationStrikes = {};
    
    for (const [expiration, strikes] of Object.entries(putOptions)) {
      const strikeList = Object.keys(strikes).map(strike => parseFloat(strike));
      strikeList.forEach(strike => allPutStrikes.add(strike));
      expirationStrikes[expiration] = strikes;
    }
    
    const putStrikes = Array.from(allPutStrikes).sort((a, b) => b - a); // Sort descending (high to low)
    
    // Track which spread combinations we've already added to avoid duplicates
    const addedSpreads = new Set();
    
    // Look for bull put spreads starting from highest strikes below the initial position
    // Bull put spread: short higher put, long lower put (generates credit)
    for (const shortHigherPutStrike of putStrikes) {
      // Short put strike should be lower than the reference strike
      if (shortHigherPutStrike >= referenceStrike) {
        continue; // Skip if at or above the reference strike
      }
      
      const longLowerPutStrike = shortHigherPutStrike - spreadWidth;
      const spreadKey = `${shortHigherPutStrike}-${longLowerPutStrike}`;
      
      // Skip if we've already added this spread
      if (addedSpreads.has(spreadKey)) {
        continue;
      }
      
      // Check if both strikes exist in any expiration
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
      
      // Calculate credit using bid-ask average
      // Bull put spread: sell higher put (credit), buy lower put (debit)
      const shortHigherPutCredit = (shortHigherPutData.bid + shortHigherPutData.ask) / 2;
      const longLowerPutCost = (longLowerPutData.bid + longLowerPutData.ask) / 2;
      const spreadCredit = (shortHigherPutCredit - longLowerPutCost) * 100; // Net credit (positive value)
      
      // If spread credit is negative (would cost money), skip it
      if (spreadCredit <= 0) {
        continue;
      }
      
      // Check if spread credit is within budget
      if (spreadCredit > offsetBudget) {
        continue;
      }
      
      // Calculate locked-in profit and profit potential based on position type
      const bullPutMaxLoss = -(spreadWidth * 100);
      let worstCase, bestCase;
      
      if (isBearPutSpread) {
        // Bear put spread (debit): long higher put, short lower put
        // Bull put spread (credit): short higher put, long lower put
        // These are OPPOSING spreads - when one profits, the other loses
        
        // Get strike prices
        const bearPutShortStrike = Math.min(...position.legs.map(leg => leg.strike));
        const bearPutLongStrike = Math.max(...position.legs.map(leg => leg.strike));
        const bullPutShortStrike = shortHigherPutStrike;
        const bullPutLongStrike = longLowerPutStrike;
        
        // Net credit/cost
        const bearPutCost = position.cost; // Debit spread has positive cost
        const netCost = bearPutCost - spreadCredit; // Debit paid minus credit collected
        
        // Worst case: price moves to maximize one spread's value
        const bearPutMaxValue = position.maxValue || (spreadWidth * 100);
        const bullPutMaxLossAbs = Math.abs(bullPutMaxLoss);
        
        // When both spreads are at their extremes, they offset each other
        const worstCaseLowPrice = bearPutMaxValue - bullPutMaxLossAbs - netCost; // Price below both spreads
        const worstCaseHighPrice = -netCost; // Price above both spreads, both expire worthless
        
        worstCase = Math.min(worstCaseLowPrice, worstCaseHighPrice);
        
        // Best case: find optimal zone
        let bestCaseProfit = -netCost;
        
        // If bear put long strike is between bull put strikes, check that zone
        if (bearPutLongStrike >= bullPutLongStrike && bearPutLongStrike <= bullPutShortStrike) {
          const bearPutValueAtLong = bearPutMaxValue;
          const bullPutLossAtBearLong = (bullPutShortStrike - bearPutLongStrike) * 100;
          bestCaseProfit = Math.max(bestCaseProfit, bearPutValueAtLong - bullPutLossAtBearLong - netCost);
        }
        
        // If bull put short strike is between bear put strikes, check that zone
        if (bullPutShortStrike >= bearPutShortStrike && bullPutShortStrike <= bearPutLongStrike) {
          const bearPutValueAtBullShort = (bearPutLongStrike - bullPutShortStrike) * 100;
          const bullPutLossAtShort = 0; // Bull put expires worthless above its short strike
          bestCaseProfit = Math.max(bestCaseProfit, bearPutValueAtBullShort - netCost);
        }
        
        // If spreads don't overlap (bear put long < bull put long), best case is bear put at max, bull put worthless
        if (bearPutLongStrike < bullPutLongStrike) {
          bestCaseProfit = Math.max(bestCaseProfit, bearPutMaxValue - netCost);
        }
        
        bestCase = bestCaseProfit;
        
      } else if (isBearCallSpread) {
        // Bear call spread (credit): short lower call, long higher call
        // Bull put spread (credit): short higher put, long lower put
        // For two credit spreads, the worst case is when one spread hits max loss
        // but we keep the total credit collected from both spreads
        const bearCallCredit = -position.cost; // Position cost is negative for credit spreads
        const bearCallMaxLoss = Math.abs(position.maxValue || 0); // Absolute value of max loss
        const bullPutMaxLossAbs = Math.abs(bullPutMaxLoss); // Absolute value of max loss
        
        const totalCredit = bearCallCredit + spreadCredit;
        
        // Worst case: The spread with the larger max loss hits max loss, but we keep total credit
        const maxLossWorstSpread = Math.max(bearCallMaxLoss, bullPutMaxLossAbs);
        
        // Worst case: One spread hits max loss, but we keep total credit
        worstCase = -maxLossWorstSpread + totalCredit;
        // Best case: Both spreads expire worthless, we keep total credit
        bestCase = totalCredit;
        
      } else {
        // Default calculation for other position types
        const positionMaxValue = position.maxValue || 0;
        worstCase = positionMaxValue + bullPutMaxLoss + spreadCredit - position.cost;
        bestCase = positionMaxValue + spreadCredit - position.cost;
      }
      
      const lockedInProfit = worstCase;
      const profitPotential = bestCase;
      const profitPotentialScore = profitPotential !== 0 ? lockedInProfit / profitPotential : 0;
      
      // Skip spreads with negative locked-in profit
      if (lockedInProfit < 0) {
        continue;
      }
      
      // Add to possible offsets
      const offsettingSpread = {
        strategy: 'bull_put_spread',
        legs: [
          {
            action: 'offset',
            quantity: -1, // Short the higher strike
            type: 'P',
            strike: shortHigherPutStrike,
            cost: -shortHigherPutCredit * 100,
            originalString: `-1p${shortHigherPutStrike}@${-shortHigherPutCredit * 100}`
          },
          {
            action: 'offset',
            quantity: 1, // Long the lower strike
            type: 'P',
            strike: longLowerPutStrike,
            cost: longLowerPutCost * 100,
            originalString: `1p${longLowerPutStrike}@${longLowerPutCost * 100}`
          }
        ],
        cost: -spreadCredit, // Negative cost = credit received
        spreadWidth: spreadWidth,
        maxValue: bullPutMaxLoss, // Negative spread width × 100
        lockedInProfit: lockedInProfit,
        profitPotential: profitPotential,
        profitPotentialScore: profitPotentialScore,
        description: `Bull Put Spread: Short ${shortHigherPutStrike}P @ ${shortHigherPutCredit.toFixed(2)}, Long ${longLowerPutStrike}P @ ${longLowerPutCost.toFixed(2)}`
      };
      
      possibleOffsets.push(offsettingSpread);
      addedSpreads.add(spreadKey);
      
      // Test wider spreads: keep same short put leg, move long put leg lower
      // Only test strikes that create spreads WIDER than the initial spread width
      const shortHigherPutStrikeIndex = putStrikes.indexOf(shortHigherPutStrike);
      if (shortHigherPutStrikeIndex !== -1) {
        // Only test wider spreads if we found the shortHigherPutStrike in the array
        for (let i = shortHigherPutStrikeIndex + 1; i < putStrikes.length; i++) {
          const widerLongLowerPutStrike = putStrikes[i];
          const widerSpreadWidth = shortHigherPutStrike - widerLongLowerPutStrike;
          
          // Skip if this spread is not wider than the initial spread
          if (widerSpreadWidth <= spreadWidth) {
            continue;
          }
          
          const widerSpreadKey = `${shortHigherPutStrike}-${widerLongLowerPutStrike}`;
          
          // Skip if we've already added this spread
          if (addedSpreads.has(widerSpreadKey)) {
            continue;
          }
          
          // Check if wider long put strike exists in chain data
          let widerLongLowerPutData = null;
          
          for (const [expiration, strikes] of Object.entries(expirationStrikes)) {
            const widerLongStrikeKey = widerLongLowerPutStrike.toString() + '.0';
            
            if (strikes[widerLongStrikeKey]) {
              widerLongLowerPutData = strikes[widerLongStrikeKey][0];
              break;
            }
          }
          
          if (!widerLongLowerPutData) {
            continue; // No data for this strike, try next one
          }
          
          // Calculate credit for wider spread
          const widerLongLowerPutCost = (widerLongLowerPutData.bid + widerLongLowerPutData.ask) / 2;
          const widerSpreadCredit = (shortHigherPutCredit - widerLongLowerPutCost) * 100;
          
          // If wider spread credit is negative, skip it
          if (widerSpreadCredit <= 0) {
            continue;
          }
          
          // Check if wider spread credit is within budget
          if (widerSpreadCredit > offsetBudget) {
            continue;
          }
          
          // Calculate locked-in profit and profit potential for wider spread based on position type
          const widerBullPutMaxLoss = -(widerSpreadWidth * 100);
          let widerWorstCase, widerBestCase;
          
          if (isBearPutSpread) {
            const bearPutMaxValue = position.maxValue || (spreadWidth * 100);
            widerWorstCase = bearPutMaxValue + widerBullPutMaxLoss + widerSpreadCredit - position.cost;
            widerBestCase = bearPutMaxValue + widerSpreadCredit - position.cost;
          } else if (isBearCallSpread) {
            const bearCallCredit = -position.cost;
            const bearCallMaxLoss = -(spreadWidth * 100);
            
            // For two credit spreads, the worst case is when one spread hits max loss
            // but we keep the total credit collected from both spreads
            const totalCredit = bearCallCredit + widerSpreadCredit;
            const maxLossEitherSpread = Math.abs(bearCallMaxLoss); // Use original spread width for max loss
            
            // Worst case: One spread hits max loss, but we keep total credit
            widerWorstCase = -maxLossEitherSpread + totalCredit;
            // Best case: Both spreads expire worthless, we keep total credit
            widerBestCase = totalCredit;
          } else {
            const positionMaxValue = position.maxValue || 0;
            widerWorstCase = positionMaxValue + widerBullPutMaxLoss + widerSpreadCredit - position.cost;
            widerBestCase = positionMaxValue + widerSpreadCredit - position.cost;
          }
          
          const widerLockedInProfit = widerWorstCase;
          const widerProfitPotential = widerBestCase;
          const widerProfitPotentialScore = widerProfitPotential !== 0 ? widerLockedInProfit / widerProfitPotential : 0;
          
          // Skip wider spreads with negative locked-in profit
          if (widerLockedInProfit < 0) {
            continue;
          }
          
          // Add wider spread to possible offsets
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
            maxValue: widerBullPutMaxLoss, // Negative spread width × 100
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

  findOffsettingBearPutSpread(position, chainData) {
    const possibleOffsets = [];
    
    // Get the long leg strike of the bull call spread (the lower strike)
    const longCallStrike = Math.min(...position.legs.map(leg => leg.strike));
    const spreadWidth = position.spreadWidth || Math.abs(position.legs[0].strike - position.legs[1].strike);
    const offsetBudget = position.offsetBudget;
        
    // Get put options from chain data
    const putOptions = chainData.put || null;
    if (!putOptions || Object.keys(putOptions).length === 0) {
      return { strategy: 'bear_put_spread', possibleOffsets: [] };
    }
    
    // Find all available expirations and their strikes
    let allPutStrikes = new Set();
    const expirationStrikes = {};
    
    for (const [expiration, strikes] of Object.entries(putOptions)) {
      const strikeList = Object.keys(strikes).map(strike => parseFloat(strike));
      strikeList.forEach(strike => allPutStrikes.add(strike));
      expirationStrikes[expiration] = strikes;
    }
    
    const putStrikes = Array.from(allPutStrikes).sort((a, b) => a - b); // Sort ascending (low to high)
    
    // Track which spread combinations we've already added to avoid duplicates
    const addedSpreads = new Set();
    
    // Look for bear put spreads starting from lowest strikes
    // Start from lowest strikes and work up - once we exceed budget, all higher OTM spreads will be more expensive
    for (const shortPutStrike of putStrikes) {
      // Short put strike should be at or higher than the long call strike
      if (shortPutStrike < longCallStrike) {
        continue; // Skip if short put is lower than long call
      }
      
      const longPutStrike = shortPutStrike + spreadWidth;
      const spreadKey = `${longPutStrike}-${shortPutStrike}`;
      
      // Skip if we've already added this spread
      if (addedSpreads.has(spreadKey)) {
        continue;
      }
      
      // Check if long put strike exists in any expiration
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
      
      // Calculate cost using bid-ask average
      const longPutCost = (longPutData.bid + longPutData.ask) / 2;
      const shortPutCost = (shortPutData.bid + shortPutData.ask) / 2;
      const spreadCost = (longPutCost - shortPutCost) * 100; // Multiply by 100 for contract multiplier
      
      // If spread cost exceeds offset budget, stop looking - all higher OTM spreads will be more expensive
      if (spreadCost > offsetBudget) {
        break;
      }
      
      // Calculate locked-in profit and profit potential
      const offsetMaxValue = spreadWidth * 100;
      
      // Determine position type
      const isBullCallSpread = position.strategy === 'bull_call_spread';
      const isBullPutSpread = position.strategy === 'bull_put_spread';
      
      let lockedInProfit, profitPotential, profitPotentialScore;
      
      if (isBullCallSpread) {
        // Bull call spread (debit): long lower call, short higher call
        // Bear put spread (debit): long higher put, short lower put
        const totalCost = position.cost + spreadCost;
        
        // Get strike prices for overlap detection
        const bullCallLongStrike = Math.min(...position.legs.map(leg => leg.strike));
        const bullCallShortStrike = Math.max(...position.legs.map(leg => leg.strike));
        const bearPutShortStrike = shortPutStrike;
        const bearPutLongStrike = longPutStrike;
        
        // Check if strikes overlap: standard range overlap check
        // Bull call range: [bullCallLongStrike, bullCallShortStrike]
        // Bear put range: [bearPutShortStrike, bearPutLongStrike]
        const strikesOverlap = bullCallLongStrike < bearPutLongStrike && bearPutShortStrike < bullCallShortStrike;
        
        if (strikesOverlap) {
          // Overlapping strikes: both spreads can profit simultaneously in the overlap zone
          // Worst case: one spread at min value, other worthless
          const minMaxValue = Math.min(position.maxValue, offsetMaxValue);
          lockedInProfit = minMaxValue - totalCost;
          
          // Best case: find the price point that maximizes combined value
          // For bull call (long lower, short higher) + bear put (long higher, short lower)
          // Maximum combined value occurs at the bear put short strike (if within bull call range)
          // or at the bull call short strike (if within bear put range)
          let maxCombinedValue = 0;
          
          // Check value at bear put short strike
          if (bearPutShortStrike >= bullCallLongStrike && bearPutShortStrike <= bullCallShortStrike) {
            const bullCallValueAtBearPutShort = (bearPutShortStrike - bullCallLongStrike) * 100;
            const bearPutValueAtShort = offsetMaxValue;
            maxCombinedValue = Math.max(maxCombinedValue, bullCallValueAtBearPutShort + bearPutValueAtShort);
          }
          
          // Check value at bull call short strike
          if (bullCallShortStrike >= bearPutShortStrike && bullCallShortStrike <= bearPutLongStrike) {
            const bullCallValueAtShort = position.maxValue;
            const bearPutValueAtBullCallShort = (bearPutLongStrike - bullCallShortStrike) * 100;
            maxCombinedValue = Math.max(maxCombinedValue, bullCallValueAtShort + bearPutValueAtBullCallShort);
          }
          
          // If no overlap point found, use standard max
          if (maxCombinedValue === 0) {
            maxCombinedValue = Math.max(position.maxValue, offsetMaxValue);
          }
          
          profitPotential = maxCombinedValue - totalCost;
        } else {
          // Non-overlapping strikes: standard calculation
          const minMaxValue = Math.min(position.maxValue, offsetMaxValue);
          const maxMaxValue = Math.max(position.maxValue, offsetMaxValue);
          lockedInProfit = minMaxValue - totalCost;
          profitPotential = maxMaxValue - totalCost;
        }
        
        profitPotentialScore = profitPotential !== 0 ? lockedInProfit / profitPotential : 0;
        
      } else if (isBullPutSpread) {
        // Bull put spread (credit): short higher put, long lower put
        // Bear put spread (debit): long higher put, short lower put
        // These are OPPOSING spreads - when one profits, the other loses
        
        // Get strike prices
        const bullPutShortStrike = Math.max(...position.legs.map(leg => leg.strike));
        const bullPutLongStrike = Math.min(...position.legs.map(leg => leg.strike));
        const bearPutLongStrike = longPutStrike;
        const bearPutShortStrike = shortPutStrike;
        
        // Net credit/cost
        const bullPutCredit = -position.cost; // position.cost is negative for credit spreads
        const netCredit = bullPutCredit - spreadCost; // Total credit minus debit paid
        
        // Worst case: price moves to maximize one spread's value
        // If price < bullPutLongStrike: bull put loses max, bear put wins max → they cancel out
        // If price > bearPutLongStrike: both expire worthless → net = netCredit
        const bullPutMaxLoss = Math.abs(position.maxValue || 0);
        const bearPutMaxValue = offsetMaxValue;
        
        // When both spreads are at their extremes, they offset each other
        // Worst case is when the net position is smallest
        const worstCaseLowPrice = bearPutMaxValue - bullPutMaxLoss + netCredit; // Price below both spreads
        const worstCaseHighPrice = netCredit; // Price above both spreads, both expire worthless
        
        lockedInProfit = Math.min(worstCaseLowPrice, worstCaseHighPrice);
        
        // Best case: find optimal zone
        let bestCaseProfit = netCredit;
        
        // If bear put long strike is between bull put strikes, check that zone
        if (bearPutLongStrike >= bullPutLongStrike && bearPutLongStrike <= bullPutShortStrike) {
          const bearPutValueAtLong = bearPutMaxValue;
          const bullPutLossAtBearLong = (bullPutShortStrike - bearPutLongStrike) * 100;
          bestCaseProfit = Math.max(bestCaseProfit, bearPutValueAtLong - bullPutLossAtBearLong + netCredit);
        }
        
        // If bull put short strike is between bear put strikes, check that zone
        if (bullPutShortStrike >= bearPutShortStrike && bullPutShortStrike <= bearPutLongStrike) {
          const bearPutValueAtBullShort = (bearPutLongStrike - bullPutShortStrike) * 100;
          const bullPutLossAtShort = 0; // Bull put expires worthless above its short strike
          bestCaseProfit = Math.max(bestCaseProfit, bearPutValueAtBullShort + netCredit);
        }
        
        // If spreads don't overlap (bear put long < bull put short), best case is bear put at max, bull put worthless
        if (bearPutLongStrike < bullPutLongStrike) {
          bestCaseProfit = Math.max(bestCaseProfit, bearPutMaxValue + netCredit);
        }
        
        profitPotential = bestCaseProfit;
        profitPotentialScore = profitPotential !== 0 ? lockedInProfit / profitPotential : 0;
        
      } else {
        // Default calculation for other position types
        const minMaxValue = Math.min(position.maxValue || 0, offsetMaxValue);
        const maxMaxValue = Math.max(position.maxValue || 0, offsetMaxValue);
        const totalCost = position.cost + spreadCost;
        lockedInProfit = minMaxValue - totalCost;
        profitPotential = maxMaxValue - totalCost;
        profitPotentialScore = profitPotential !== 0 ? lockedInProfit / profitPotential : 0;
      }
      
      // Skip spreads with negative locked-in profit (cost exceeds guaranteed value)
      if (lockedInProfit < 0) {
        continue;
      }
      
      // Add to possible offsets
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
      
      // Test wider spreads: keep same short put leg, move long put leg higher
      // Only test strikes that create spreads WIDER than the initial spread width
      // Start from the strike AFTER longPutStrike to ensure we only test wider spreads
      const longPutStrikeIndex = putStrikes.indexOf(longPutStrike);
      if (longPutStrikeIndex !== -1) {
        // Only test wider spreads if we found the longPutStrike in the array
        for (let i = longPutStrikeIndex + 1; i < putStrikes.length; i++) {
          const widerLongPutStrike = putStrikes[i];
          const widerSpreadWidth = widerLongPutStrike - shortPutStrike;
          
          // Double-check: Skip if this spread is not wider than the initial spread
          if (widerSpreadWidth <= spreadWidth) {
            continue;
          }
          
          const widerSpreadKey = `${widerLongPutStrike}-${shortPutStrike}`;
          
          // Skip if we've already added this spread
          if (addedSpreads.has(widerSpreadKey)) {
            continue;
          }
          
          // Check if wider long put strike exists in chain data
          let widerLongPutData = null;
          
          for (const [expiration, strikes] of Object.entries(expirationStrikes)) {
            const widerLongStrikeKey = widerLongPutStrike.toString() + '.0';
            
            if (strikes[widerLongStrikeKey]) {
              widerLongPutData = strikes[widerLongStrikeKey][0];
              break;
            }
          }
          
          if (!widerLongPutData) {
            continue; // No data for this strike, try next one
          }
          
          // Calculate cost for wider spread
          const widerLongPutCost = (widerLongPutData.bid + widerLongPutData.ask) / 2;
          const widerSpreadCost = (widerLongPutCost - shortPutCost) * 100;
          
          // If wider spread exceeds budget, stop testing wider spreads for this short leg
          if (widerSpreadCost > offsetBudget) {
            break;
          }
          
          // Calculate locked-in profit and profit potential for wider spread
          const widerOffsetMaxValue = widerSpreadWidth * 100;
          
          let widerLockedInProfit, widerProfitPotential, widerProfitPotentialScore;
          
          if (isBullCallSpread) {
            // Bull call spread (debit): both are debit spreads
            const widerTotalCost = position.cost + widerSpreadCost;
            
            // Get strike prices for overlap detection
            const bullCallLongStrike = Math.min(...position.legs.map(leg => leg.strike));
            const bullCallShortStrike = Math.max(...position.legs.map(leg => leg.strike));
            const bearPutShortStrike = shortPutStrike;
            const bearPutLongStrike = widerLongPutStrike;
            
            // Check if strikes overlap
            const strikesOverlap = bearPutShortStrike >= bullCallLongStrike && bearPutLongStrike >= bullCallShortStrike;
            
            if (strikesOverlap) {
              // Overlapping strikes: both spreads can profit simultaneously
              const widerMinMaxValue = Math.min(position.maxValue, widerOffsetMaxValue);
              widerLockedInProfit = widerMinMaxValue - widerTotalCost;
              
              // Find the price point that maximizes combined value
              let maxCombinedValue = 0;
              
              // Check value at bear put short strike
              if (bearPutShortStrike >= bullCallLongStrike && bearPutShortStrike <= bullCallShortStrike) {
                const bullCallValueAtBearPutShort = (bearPutShortStrike - bullCallLongStrike) * 100;
                const bearPutValueAtShort = widerOffsetMaxValue;
                maxCombinedValue = Math.max(maxCombinedValue, bullCallValueAtBearPutShort + bearPutValueAtShort);
              }
              
              // Check value at bull call short strike
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
              // Non-overlapping strikes: standard calculation
              const widerMinMaxValue = Math.min(position.maxValue, widerOffsetMaxValue);
              const widerMaxMaxValue = Math.max(position.maxValue, widerOffsetMaxValue);
              widerLockedInProfit = widerMinMaxValue - widerTotalCost;
              widerProfitPotential = widerMaxMaxValue - widerTotalCost;
            }
            
            widerProfitPotentialScore = widerProfitPotential !== 0 ? widerLockedInProfit / widerProfitPotential : 0;
            
          } else if (isBullPutSpread) {
            // Bull put spread (credit): short higher put, long lower put
            // Bear put spread (debit): long higher put, short lower put
            // These are OPPOSING spreads - when one profits, the other loses
            
            // Get strike prices
            const bullPutShortStrike = Math.max(...position.legs.map(leg => leg.strike));
            const bullPutLongStrike = Math.min(...position.legs.map(leg => leg.strike));
            const bearPutLongStrike = widerLongPutStrike;
            const bearPutShortStrike = shortPutStrike;
            
            // Net credit/cost
            const bullPutCredit = -position.cost;
            const widerNetCredit = bullPutCredit - widerSpreadCost;
            
            // Worst case calculations
            const bullPutMaxLoss = Math.abs(position.maxValue || 0);
            const bearPutMaxValue = widerOffsetMaxValue;
            
            const worstCaseLowPrice = bearPutMaxValue - bullPutMaxLoss + widerNetCredit;
            const worstCaseHighPrice = widerNetCredit;
            
            widerLockedInProfit = Math.min(worstCaseLowPrice, worstCaseHighPrice);
            
            // Best case: find optimal zone
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
            // Default calculation
            const widerMinMaxValue = Math.min(position.maxValue || 0, widerOffsetMaxValue);
            const widerMaxMaxValue = Math.max(position.maxValue || 0, widerOffsetMaxValue);
            const widerTotalCost = position.cost + widerSpreadCost;
            widerLockedInProfit = widerMinMaxValue - widerTotalCost;
            widerProfitPotential = widerMaxMaxValue - widerTotalCost;
            widerProfitPotentialScore = widerProfitPotential !== 0 ? widerLockedInProfit / widerProfitPotential : 0;
          }
          
          // Skip wider spreads with negative locked-in profit
          if (widerLockedInProfit < 0) {
            continue;
          }
          
          // Add wider spread to possible offsets
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
}

module.exports = OffsetManager;
