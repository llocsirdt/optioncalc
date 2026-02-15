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
            legs: position.legs.map(leg => ({
              originalString: leg.originalString
            })),
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
    
    // Get the short leg strike of the bear put spread (the lower strike)
    const shortPutStrike = Math.min(...position.legs.map(leg => leg.strike));
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
      // Long call strike should be at or lower than the short put strike
      if (longCallStrike > shortPutStrike) {
        continue; // Skip if long call is higher than short put
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
      const minMaxValue = Math.min(position.maxValue, offsetMaxValue);
      const maxMaxValue = Math.max(position.maxValue, offsetMaxValue);
      const totalCost = position.cost + spreadCost;
      const lockedInProfit = minMaxValue - totalCost;
      const profitPotential = maxMaxValue - totalCost;
      const profitPotentialScore = profitPotential !== 0 ? lockedInProfit / profitPotential : 0;
      
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
        const widerMinMaxValue = Math.min(position.maxValue, widerOffsetMaxValue);
        const widerMaxMaxValue = Math.max(position.maxValue, widerOffsetMaxValue);
        const widerTotalCost = position.cost + widerSpreadCost;
        const widerLockedInProfit = widerMinMaxValue - widerTotalCost;
        const widerProfitPotential = widerMaxMaxValue - widerTotalCost;
        const widerProfitPotentialScore = widerProfitPotential !== 0 ? widerLockedInProfit / widerProfitPotential : 0;
        
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
      
      // When offsetting bull call spread with bear call spread:
      // Worst case: Market goes up - bull call wins max, bear call loses max
      //   Profit = position.maxValue + offsetMaxValue + spreadCredit - position.cost
      // Best case: Market lands between the two short strikes - bull call at max, bear call expires worthless
      //   Profit = position.maxValue + spreadCredit - position.cost
      const worstCase = position.maxValue + offsetMaxValue + spreadCredit - position.cost;
      const bestCase = position.maxValue + spreadCredit - position.cost;
      
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
          
          // Worst case: Market goes up - both spreads hit max
          // Best case: Market lands between short strikes - bull call at max, bear call expires worthless
          const widerWorstCase = position.maxValue + widerOffsetMaxValue + widerSpreadCredit - position.cost;
          const widerBestCase = position.maxValue + widerSpreadCredit - position.cost;
          
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
    
    // Get the short leg strike of the bear put spread (the lower strike)
    const shortPutStrike = Math.min(...position.legs.map(leg => leg.strike));
    const spreadWidth = position.spreadWidth || Math.abs(position.legs[0].strike - position.legs[1].strike);
    const offsetBudget = position.offsetBudget;
        
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
      // Short put strike should be lower than the initial bear put spread's short strike
      if (shortHigherPutStrike >= shortPutStrike) {
        continue; // Skip if at or above the initial position
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
      
      // Calculate locked-in profit and profit potential
      // Bull put spread maxValue is the max loss = -(spread width × 100)
      const offsetMaxValue = -(spreadWidth * 100);
      
      // When offsetting bear put spread with bull put spread:
      // Worst case: Market goes down - bear put wins max, bull put loses max
      //   Profit = position.maxValue + offsetMaxValue + spreadCredit - position.cost
      // Best case: Market lands between the two short strikes - bear put at max, bull put expires worthless
      //   Profit = position.maxValue + spreadCredit - position.cost
      const worstCase = position.maxValue + offsetMaxValue + spreadCredit - position.cost;
      const bestCase = position.maxValue + spreadCredit - position.cost;
      
      const lockedInProfit = worstCase; // Worst case scenario
      const profitPotential = bestCase; // Best case scenario (sweet spot between short strikes)
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
        maxValue: offsetMaxValue, // Negative spread width × 100
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
          
          // Calculate locked-in profit and profit potential for wider spread
          const widerOffsetMaxValue = -(widerSpreadWidth * 100);
          
          // Worst case: Market goes down - both spreads hit max
          // Best case: Market lands between short strikes - bear put at max, bull put expires worthless
          const widerWorstCase = position.maxValue + widerOffsetMaxValue + widerSpreadCredit - position.cost;
          const widerBestCase = position.maxValue + widerSpreadCredit - position.cost;
          
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
            maxValue: widerOffsetMaxValue, // Negative spread width × 100
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
      const minMaxValue = Math.min(position.maxValue, offsetMaxValue);
      const maxMaxValue = Math.max(position.maxValue, offsetMaxValue);
      const totalCost = position.cost + spreadCost;
      const lockedInProfit = minMaxValue - totalCost;
      const profitPotential = maxMaxValue - totalCost;
      const profitPotentialScore = profitPotential !== 0 ? lockedInProfit / profitPotential : 0;
      
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
          const widerMinMaxValue = Math.min(position.maxValue, widerOffsetMaxValue);
          const widerMaxMaxValue = Math.max(position.maxValue, widerOffsetMaxValue);
          const widerTotalCost = position.cost + widerSpreadCost;
          const widerLockedInProfit = widerMinMaxValue - widerTotalCost;
          const widerProfitPotential = widerMaxMaxValue - widerTotalCost;
          const widerProfitPotentialScore = widerProfitPotential !== 0 ? widerLockedInProfit / widerProfitPotential : 0;
          
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
