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
    
    const callStrikes = Array.from(allCallStrikes).sort((a, b) => a - b);
    
    // Look for bull call spreads with same spread width
    for (const longCallStrike of callStrikes) {
      // Long call strike should be at or lower than the short put strike
      if (longCallStrike > shortPutStrike) {
        continue; // Skip if long call is higher than short put
      }
      
      const shortCallStrike = longCallStrike + spreadWidth;
      
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
      
      // Skip if spread cost exceeds offset budget
      if (spreadCost > offsetBudget) {
        continue;
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
        maxValue: spreadWidth * 100,
        description: `Bull Call Spread: Long ${longCallStrike}C @ ${longCallCost.toFixed(2)}, Short ${shortCallStrike}C @ ${shortCallCost.toFixed(2)}`
      };
      
      possibleOffsets.push(offsettingSpread);
    }
    return { strategy: 'bull_call_spread', possibleOffsets: possibleOffsets };
  }

  findOffsettingBearCallSpread(position, chainData) {
    // TODO: Implement bear call spread offsetting logic using chainData
    return { strategy: 'bear_call_spread', possibleOffsets: [] };
  }

  findOffsettingBullPutSpread(position, chainData) {
    // TODO: Implement bull put spread offsetting logic using chainData
    return { strategy: 'bull_put_spread', possibleOffsets: [] };
  }

  findOffsettingBearPutSpread(position, chainData) {
    // TODO: Implement bear put spread offsetting logic using chainData
    return { strategy: 'bear_put_spread', possibleOffsets: [] };
  }
}

module.exports = OffsetManager;
