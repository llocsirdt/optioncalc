#!/usr/bin/env node

/**
 * Position Management Module
 * 
 * Handles position parsing, strategy determination, and enrichment
 */

const {
  checkSimple5mBBScoreOpen: strategyCheckSimple5mBBScoreOpen,
  checkSimple15mBBScoreOpen: strategyCheckSimple15mBBScoreOpen,
  checkSimple5mBBScoreCover: strategyCheckSimple5mBBScoreCover,
  checkSimple15mBBScoreCover: strategyCheckSimple15mBBScoreCover
} = require('./strategy-logic');

class PositionManager {
  /**
   * Parse position string into position object(s)
   * Format: "{qty}{p or c}{strike}@{cost}" or comma-separated multiple legs
   * Example: "1p100@2.50" = 1 put at $100 strike, $2.50 cost
   * Example: "1p25350@10000,-1p25250@-6000" = spread position
   */
  parsePositionString(positionString) {
    // Split by comma for multiple legs
    const legs = positionString.split(',').map(leg => leg.trim());
    const parsedLegs = [];
    
    for (const leg of legs) {
      const match = leg.match(/^(-?\d+)([pc])(\d+(?:\.\d+)?)@(-?\d+(?:\.\d+)?)$/);
      
      if (!match) {
        throw new Error(`Invalid position format: ${leg}. Expected format: {qty}{p or c}{strike}@{cost}`);
      }
      
      const [, qty, type, strike, cost] = match;
      
      parsedLegs.push({
        action: "initial",
        quantity: parseInt(qty),
        type: type.toUpperCase(), // 'P' or 'C'
        strike: parseFloat(strike),
        cost: parseFloat(cost),
        originalString: leg
      });
    }
    
    // Return single object for single leg, or array for multiple legs
    return parsedLegs.length === 1 ? parsedLegs[0] : parsedLegs;
  }

  /**
   * Determine if a position array is covered
   * A position is covered if it has both "initial" and non-"initial" actions
   */
  determineCovered(positionArray) {
    const hasInitial = positionArray.some(leg => leg.action === "initial");
    const hasNonInitial = positionArray.some(leg => leg.action !== "initial");
    
    return hasInitial && hasNonInitial;
  }

  /**
   * Determine the option strategy for a position array
   */
  determineStrategy(positionArray) {
    const legs = positionArray;
    
    if (legs.length === 1) {
      // Single leg strategies
      const leg = legs[0];
      const type = leg.type;
      const quantity = leg.quantity;
      
      if (type === 'C') {
        return quantity > 0 ? 'long_call' : 'short_call';
      } else if (type === 'P') {
        return quantity > 0 ? 'long_put' : 'short_put';
      }
    } else if (legs.length === 2) {
      // Two leg strategies - determine based on strikes and types
      const leg1 = legs[0];
      const leg2 = legs[1];
      
      // Both calls - vertical spread
      if (leg1.type === 'C' && leg2.type === 'C') {
        const lowerStrike = Math.min(leg1.strike, leg2.strike);
        const higherStrike = Math.max(leg1.strike, leg2.strike);
        
        const lowerStrikeLeg = legs.find(leg => leg.strike === lowerStrike);
        const higherStrikeLeg = legs.find(leg => leg.strike === higherStrike);
        
        // Bull call spread: long lower strike, short higher strike
        if (lowerStrikeLeg.quantity > 0 && higherStrikeLeg.quantity < 0) {
          return 'bull_call_spread';
        }
        // Bear call spread: short lower strike, long higher strike
        else if (lowerStrikeLeg.quantity < 0 && higherStrikeLeg.quantity > 0) {
          return 'bear_call_spread';
        }
      }
      // Both puts - vertical spread
      else if (leg1.type === 'P' && leg2.type === 'P') {
        const lowerStrike = Math.min(leg1.strike, leg2.strike);
        const higherStrike = Math.max(leg1.strike, leg2.strike);
        
        const lowerStrikeLeg = legs.find(leg => leg.strike === lowerStrike);
        const higherStrikeLeg = legs.find(leg => leg.strike === higherStrike);
        
        // Bear put spread: long higher strike, short lower strike
        if (higherStrikeLeg.quantity > 0 && lowerStrikeLeg.quantity < 0) {
          return 'bear_put_spread';
        }
        // Bull put spread: short higher strike, long lower strike
        else if (higherStrikeLeg.quantity < 0 && lowerStrikeLeg.quantity > 0) {
          return 'bull_put_spread';
        }
      }
    }
    
    return 'unknown';
  }

  /**
   * Enrich position array with covered and strategy properties
   */
  enrichPositionArray(positionArray) {
    // Convert single object to array if needed
    const positions = Array.isArray(positionArray) ? positionArray : [positionArray];
    
    // Add covered and strategy properties to the array level
    positions.covered = this.determineCovered(positions);
    positions.strategy = this.determineStrategy(positions);
    
    return positions;
  }

  /**
   * Format positions JSON for readability with custom formatting
   */
  formatPositionsJson(positions) {
    let result = '{\n';
    
    const keys = Object.keys(positions);
    keys.forEach((key, index) => {
      result += `  "${key}": [\n`;
      
      positions[key].forEach((positionArray, posIndex) => {
        result += '    {\n';
        
        // Add covered, strategy, cost, offsetBudget, spreadWidth, and maxValue on one line
        const spreadWidth = positionArray.spreadWidth !== undefined ? positionArray.spreadWidth : 0;
        const maxValue = positionArray.maxValue !== undefined ? positionArray.maxValue : 0;
        result += `      "covered": ${positionArray.covered}, "strategy": "${positionArray.strategy}", "cost": ${positionArray.cost}, "offsetBudget": ${positionArray.offsetBudget}, "spreadWidth": ${spreadWidth}, "maxValue": ${maxValue},\n`;
        result += '      "legs": [\n';
        
        // Add each leg on a single line
        positionArray.legs.forEach((leg, legIndex) => {
          result += '        ';
          result += JSON.stringify(leg);
          if (legIndex < positionArray.legs.length - 1) {
            result += ',';
          }
          result += '\n';
        });
        
        result += '      ]\n';
        result += '    }';
        if (posIndex < positions[key].length - 1) {
          result += ',';
        }
        result += '\n';
      });
      
      result += '  ]';
      if (index < keys.length - 1) {
        result += ',';
      }
      result += '\n';
    });
    
    result += '}';
    return result;
  }

  /**
   * Calculate spread width for spread positions
   * For single leg: 0 (no spread)
   * For multi-leg spreads: absolute difference between strikes
   */
  calculateSpreadWidth(positionArray) {
    const legs = Array.isArray(positionArray) ? positionArray : [positionArray];
    
    if (legs.length === 1) {
      return 0; // Single leg has no spread
    }
    
    // For spreads, calculate the difference between strikes
    const strikes = legs.map(leg => leg.strike);
    const maxStrike = Math.max(...strikes);
    const minStrike = Math.min(...strikes);
    
    return Math.abs(maxStrike - minStrike);
  }

  /**
   * Calculate maximum value potential of a spread position
   * For single leg: 0 (no spread, no max value)
   * For multi-leg spreads: difference between strikes * 100 * quantity
   */
  calculateMaximumValuePotential(positionArray) {
    const legs = Array.isArray(positionArray) ? positionArray : [positionArray];
    
    if (legs.length === 1) {
      return 0; // Single leg has no spread, no maximum value potential
    }
    
    // For spreads, calculate the difference between strikes
    const strikes = legs.map(leg => leg.strike);
    const maxStrike = Math.max(...strikes);
    const minStrike = Math.min(...strikes);
    const strikeDifference = maxStrike - minStrike;
    
    // Use absolute quantity for calculation (spreads are typically 1:1)
    const quantity = Math.abs(legs[0].quantity);
    
    return strikeDifference * 100 * quantity; // Options represent 100 shares
  }

  /**
   * Calculate offset budget for a position
   * Single leg: cost of the initial position (TODO: revisit this logic)
   * Spread: maximum value potential minus cost, but never less than 0
   */
  calculateOffsetBudget(positionArray) {
    const legs = Array.isArray(positionArray) ? positionArray : [positionArray];
    
    if (legs.length === 1) {
      // TODO: Revisit this logic for single leg offset budget
      return this.calculatePositionCost(positionArray);
    }
    
    const maxPotential = this.calculateMaximumValuePotential(positionArray);
    const cost = this.calculatePositionCost(positionArray);
    const offsetBudget = maxPotential - cost;
    
    // Ensure offset budget is never negative
    return Math.max(0, offsetBudget);
  }

  /**
   * Calculate total cost of a position
   * For single leg: cost of the leg
   * For multi-leg: sum of all leg costs
   */
  calculatePositionCost(positionArray) {
    const legs = Array.isArray(positionArray) ? positionArray : [positionArray];
    return legs.reduce((total, leg) => total + leg.cost, 0);
  }

  /**
   * Convert position array to response format with covered/strategy properties
   */
  toResponseFormat(positionArray) {
    const enriched = this.enrichPositionArray(positionArray);
    // Convert array properties to regular object properties for JSON serialization
    return {
      legs: Array.isArray(positionArray) ? positionArray : [positionArray],
      covered: enriched.covered,
      strategy: enriched.strategy,
      cost: this.calculatePositionCost(positionArray),
      offsetBudget: this.calculateOffsetBudget(positionArray),
      spreadWidth: this.calculateSpreadWidth(positionArray),
      maxValue: this.calculateMaximumValuePotential(positionArray)
    };
  }

  /**
   * Try to cover a bull position
   */
  async tryCoverBullPosition(symbolExpiration, position) {
    console.log(`🐂 Trying to cover bull position: ${symbolExpiration}`);
    // TODO: Implement bull position covering logic
  }

  /**
   * Try to cover a bear position
   */
  async tryCoverBearPosition(symbolExpiration, position) {
    console.log(`🐻 Trying to cover bear position: ${symbolExpiration}`);
    // TODO: Implement bear position covering logic
  }

  /**
   * Try to open a new bull position
   */
  async tryOpenBullPosition(symbol, expiration) {
    console.log(`🐂 Trying to open new bull position: ${symbol}_${expiration}`);
    // TODO: Implement bull position opening logic
  }

  /**
   * Try to open a new bear position
   */
  async tryOpenBearPosition(symbol, expiration) {
    console.log(`🐻 Trying to open new bear position: ${symbol}_${expiration}`);
    // TODO: Implement bear position opening logic
  }

  /**
   * Check if we should cover a specific position based on simple strategy
   * @param {string} symbolExpiration - The symbol_date combination
   * @param {Object} position - The position object
   * @returns {boolean} - True if covering was attempted, false otherwise
   */
  async checkSimpleCover(symbolExpiration, position) {
    const strategy = position.strategy || 'unknown';
    
    // Determine if it's a bull or bear position and call appropriate function
    if (strategy.includes('bull')) {
      await this.tryCoverBullPosition(symbolExpiration, position);
      return true;
    } else if (strategy.includes('bear')) {
      await this.tryCoverBearPosition(symbolExpiration, position);
      return true;
    } else {
      console.log(`❓ Unknown strategy for ${symbolExpiration}: ${strategy}`);
      return false;
    }
  }

  /**
   * Check if we should open a new position based on simple 5m BB score strategy
   * @param {string} symbol - The symbol to check
   * @param {string} expiration - The expiration date
   * @param {Object} candleAnalysis - Candle analysis data for the symbol
   * @returns {boolean} - True if conditions were met, false otherwise
   */
  async checkSimple5mBBScoreOpen(symbol, expiration, candleAnalysis) {
    if (candleAnalysis && candleAnalysis.success) {
      // Get the 5-minute candle data to check BB score
      const candleData5m = candleAnalysis.candleData['5m'];
      
      if (candleData5m && candleData5m.candles && candleData5m.candles.length > 0) {
        // Get the most recent candle (first in array since server returns newest first)
        const latestCandle = candleData5m.candles[0];
        const bbScore = latestCandle.bbScore;
        
        console.log(`  ${symbol}: Latest 5m BB score: ${bbScore}`);
        
        // Use strategy-logic function to make decision
        const analysis = { '5m': { bbScore } };
        const result = strategyCheckSimple5mBBScoreOpen(analysis);
        
        if (result.action === 'open_bull') {
          console.log(`  ${symbol}: 5m BB score indicates bull signal (bb > 1), opening bull position`);
          await this.tryOpenBullPosition(symbol, expiration);
          return true;
        } else if (result.action === 'open_bear') {
          console.log(`  ${symbol}: 5m BB score indicates bear signal (bb < -1), opening bear position`);
          await this.tryOpenBearPosition(symbol, expiration);
          return true;
        } else {
          console.log(`  ${symbol}: 5m BB score neutral, skipping position opening`);
          return false;
        }
      } else {
        console.log(`  ${symbol}: No 5m candle data available, skipping position opening`);
        return false;
      }
    } else {
      console.log(`  ${symbol}: No candle analysis available, skipping position opening`);
      return false;
    }
  }

  /**
   * Check if we should open a new position based on simple 15m BB score strategy
   * @param {string} symbol - The symbol to check
   * @param {string} expiration - The expiration date
   * @param {Object} candleAnalysis - Candle analysis data for the symbol
   * @returns {boolean} - True if conditions were met, false otherwise
   */
  async checkSimple15mBBScoreOpen(symbol, expiration, candleAnalysis) {
    if (candleAnalysis && candleAnalysis.success) {
      // Get the 15-minute candle data to check BB score
      const candleData15m = candleAnalysis.candleData['15m'];
      
      if (candleData15m && candleData15m.candles && candleData15m.candles.length > 0) {
        // Get the most recent candle (first in array since server returns newest first)
        const latestCandle = candleData15m.candles[0];
        const bbScore = latestCandle.bbScore;
        
        console.log(`  ${symbol}: Latest 15m BB score: ${bbScore}`);
        
        // Use strategy-logic function to make decision
        const analysis = { '15m': { bbScore } };
        const result = strategyCheckSimple15mBBScoreOpen(analysis);
        
        if (result.action === 'open_bull') {
          console.log(`  ${symbol}: 15m BB score indicates bull signal (bb > 1), opening bull position`);
          await this.tryOpenBullPosition(symbol, expiration);
          return true;
        } else if (result.action === 'open_bear') {
          console.log(`  ${symbol}: 15m BB score indicates bear signal (bb < -1), opening bear position`);
          await this.tryOpenBearPosition(symbol, expiration);
          return true;
        } else {
          console.log(`  ${symbol}: 15m BB score neutral, skipping position opening`);
          return false;
        }
      } else {
        console.log(`  ${symbol}: No 15m candle data available, skipping position opening`);
        return false;
      }
    } else {
      console.log(`  ${symbol}: No candle analysis available, skipping position opening`);
      return false;
    }
  }

  /**
   * Check if we should open a new position based on simple 15m and 60m BB score strategy
   * @param {string} symbol - The symbol to check
   * @param {string} expiration - The expiration date
   * @param {Object} candleAnalysis - Candle analysis data for the symbol
   * @returns {boolean} - True if conditions were met, false otherwise
   */
  async checkSimple15and60mBBScoreOpen(symbol, expiration, candleAnalysis) {
    if (candleAnalysis && candleAnalysis.success) {
      // Get the 15-minute and 60-minute candle data to check BB scores
      const candleData15m = candleAnalysis.candleData['15m'];
      const candleData60m = candleAnalysis.candleData['1h'];
      
      if (candleData15m && candleData15m.candles && candleData15m.candles.length > 0 &&
          candleData60m && candleData60m.candles && candleData60m.candles.length > 0) {
        
        // Get the most recent candles (first in array since server returns newest first)
        const latestCandle15m = candleData15m.candles[0];
        const latestCandle60m = candleData60m.candles[0];
        const bbScore15m = latestCandle15m.bbScore;
        const bbScore60m = latestCandle60m.bbScore;
        
        console.log(`  ${symbol}: Latest 15m BB score: ${bbScore15m}, 60m BB score: ${bbScore60m}`);
        
        // Make decision based on both BB scores - both must agree
        // Corrected logic: positive bbScore (>1) = oversold = open bull, negative bbScore (<-1) = overbought = open bear
        if (bbScore15m > 1 && bbScore60m > 1) {
          console.log(`  ${symbol}: Both 15m and 60m BB scores indicate bull signal (bb > 1), opening bull position`);
          await this.tryOpenBullPosition(symbol, expiration);
          return true;
        } else if (bbScore15m < -1 && bbScore60m < -1) {
          console.log(`  ${symbol}: Both 15m and 60m BB scores indicate bear signal (bb < -1), opening bear position`);
          await this.tryOpenBearPosition(symbol, expiration);
          return true;
        } else {
          console.log(`  ${symbol}: BB scores do not agree or are neutral (15m: ${bbScore15m}, 60m: ${bbScore60m}), skipping position opening`);
          return false;
        }
      } else {
        console.log(`  ${symbol}: Missing 15m or 60m candle data, skipping position opening`);
        return false;
      }
    } else {
      console.log(`  ${symbol}: No candle analysis available, skipping position opening`);
      return false;
    }
  }

  /**
   * Check if we should cover a position based on simple 5m BB score strategy
   * @param {string} symbolExpiration - The symbol_date combination
   * @param {Object} position - The position object
   * @param {Object} candleAnalysis - Candle analysis data for the symbol
   * @returns {boolean} - True if covering was attempted, false otherwise
   */
  async checkSimple5mBBScoreCover(symbolExpiration, position, candleAnalysis) {
    if (candleAnalysis && candleAnalysis.success) {
      // Get the 5-minute candle data to check BB score
      const candleData5m = candleAnalysis.candleData['5m'];
      
      if (candleData5m && candleData5m.candles && candleData5m.candles.length > 0) {
        // Get the most recent candle (first in array since server returns newest first)
        const latestCandle = candleData5m.candles[0];
        const bbScore = latestCandle.bbScore;
        
        const [symbol] = symbolExpiration.split('_');
        console.log(`  ${symbol}: Latest 5m BB score: ${bbScore}`);
        
        // Use strategy-logic function to make decision
        const analysis = { '5m': { bbScore } };
        const result = strategyCheckSimple5mBBScoreCover(position, analysis);
        
        if (result.action === 'cover') {
          if (position.type === 'bull') {
            console.log(`  ${symbol}: 5m BB score indicates cover bull position (bb < -1), covering bull position`);
            await this.tryCoverBullPosition(symbolExpiration, position);
          } else if (position.type === 'bear') {
            console.log(`  ${symbol}: 5m BB score indicates cover bear position (bb > 1), covering bear position`);
            await this.tryCoverBearPosition(symbolExpiration, position);
          }
          return true;
        } else {
          console.log(`  ${symbol}: 5m BB score neutral, skipping position covering`);
          return false;
        }
      } else {
        console.log(`  ${symbol}: No 5m candle data available, skipping position covering`);
        return false;
      }
    } else {
      console.log(`  ${symbol}: No candle analysis available, skipping position covering`);
      return false;
    }
  }

  /**
   * Check if we should cover a position based on simple 15m BB score strategy
   * @param {string} symbolExpiration - The symbol_date combination
   * @param {Object} position - The position object
   * @param {Object} candleAnalysis - Candle analysis data for the symbol
   * @returns {boolean} - True if covering was attempted, false otherwise
   */
  async checkSimple15mBBScoreCover(symbolExpiration, position, candleAnalysis) {
    if (candleAnalysis && candleAnalysis.success) {
      // Get the 15-minute candle data to check BB score
      const candleData15m = candleAnalysis.candleData['15m'];
      
      if (candleData15m && candleData15m.candles && candleData15m.candles.length > 0) {
        // Get the most recent candle (first in array since server returns newest first)
        const latestCandle = candleData15m.candles[0];
        const bbScore = latestCandle.bbScore;
        
        const [symbol] = symbolExpiration.split('_');
        console.log(`  ${symbol}: Latest 15m BB score: ${bbScore}`);
        
        // Use strategy-logic function to make decision
        const analysis = { '15m': { bbScore } };
        const result = strategyCheckSimple15mBBScoreCover(position, analysis);
        
        if (result.action === 'cover') {
          if (position.type === 'bull') {
            console.log(`  ${symbol}: 15m BB score indicates cover bull position (bb < -1), covering bull position`);
            await this.tryCoverBullPosition(symbolExpiration, position);
          } else if (position.type === 'bear') {
            console.log(`  ${symbol}: 15m BB score indicates cover bear position (bb > 1), covering bear position`);
            await this.tryCoverBearPosition(symbolExpiration, position);
          }
          return true;
        } else {
          console.log(`  ${symbol}: 15m BB score neutral, skipping position covering`);
          return false;
        }
      } else {
        console.log(`  ${symbol}: No 15m candle data available, skipping position covering`);
        return false;
      }
    } else {
      console.log(`  ${symbol}: No candle analysis available, skipping position covering`);
      return false;
    }
  }

  /**
   * Check if we should cover a position based on simple 15m and 60m BB score strategy
   * @param {string} symbolExpiration - The symbol_date combination
   * @param {Object} position - The position object
   * @param {Object} candleAnalysis - Candle analysis data for the symbol
   * @returns {boolean} - True if covering was attempted, false otherwise
   */
  async checkSimple15and60mBBScoreCover(symbolExpiration, position, candleAnalysis) {
    if (candleAnalysis && candleAnalysis.success) {
      // Get the 15-minute and 60-minute candle data to check BB scores
      const candleData15m = candleAnalysis.candleData['15m'];
      const candleData60m = candleAnalysis.candleData['1h'];
      
      if (candleData15m && candleData15m.candles && candleData15m.candles.length > 0 &&
          candleData60m && candleData60m.candles && candleData60m.candles.length > 0) {
        
        // Get the most recent candles (first in array since server returns newest first)
        const latestCandle15m = candleData15m.candles[0];
        const latestCandle60m = candleData60m.candles[0];
        const bbScore15m = latestCandle15m.bbScore;
        const bbScore60m = latestCandle60m.bbScore;
        
        const [symbol] = symbolExpiration.split('_');
        console.log(`  ${symbol}: Latest 15m BB score: ${bbScore15m}, 60m BB score: ${bbScore60m}`);
        
        // Make decision based on both BB scores - both must agree, opposite of opening logic
        // Corrected logic: bull covers when bbScore < -1 (price moved up), bear covers when bbScore > 1 (price moved down)
        if (position.type === 'bull' && bbScore15m < -1 && bbScore60m < -1) {
          console.log(`  ${symbol}: Both 15m and 60m BB scores indicate cover bull position (bb < -1), covering bull position`);
          await this.tryCoverBullPosition(symbolExpiration, position);
          return true;
        } else if (position.type === 'bear' && bbScore15m > 1 && bbScore60m > 1) {
          console.log(`  ${symbol}: Both 15m and 60m BB scores indicate cover bear position (bb > 1), covering bear position`);
          await this.tryCoverBearPosition(symbolExpiration, position);
          return true;
        } else {
          console.log(`  ${symbol}: BB scores do not agree or are neutral (15m: ${bbScore15m}, 60m: ${bbScore60m}), skipping position covering`);
          return false;
        }
      } else {
        console.log(`  ${symbol}: Missing 15m or 60m candle data, skipping position covering`);
        return false;
      }
    } else {
      console.log(`  ${symbol}: No candle analysis available, skipping position covering`);
      return false;
    }
  }

  /**
   * Check positions and log summary data
   * This method will be called by the server loop every 10 seconds
   */
  async checkPositions(persistenceManager) {
    try {
      // Import candle analyzer
      const { analyzeCandles } = require('./candle-analyzer');
      
      // Get positions from persistence manager
      if (!persistenceManager) {
        console.log('📊 Position Check: No persistence manager provided');
        return;
      }
      
      const positions = await persistenceManager.getAllPositions();
      
      if (!positions || Object.keys(positions).length === 0) {
        console.log('📊 Position Check: No positions available');
        return;
      }
      
      // Generate summary and track covered/uncovered positions
      const summary = {
        totalPositions: Object.keys(positions).length,
        symbolExpirations: Object.keys(positions),
        totalLegs: 0,
        strategies: {},
        totalCost: 0,
        coveredPositions: [], // Reset each cycle
        uncoveredPositions: [] // Reset each cycle
      };
      
      // Analyze each position
      for (const [symbolExpiration, positionArray] of Object.entries(positions)) {
        // The positions.json file contains enriched position objects with strategy already calculated
        if (Array.isArray(positionArray) && positionArray.length > 0) {
          // Use the first position in the array (most recent)
          const position = positionArray[0];
          summary.totalLegs += position.legs ? position.legs.length : 1;
          
          // Use the already-calculated strategy and cost
          const strategy = position.strategy || 'unknown';
          const cost = position.cost || 0;
          summary.totalCost += cost;
          
          // Count strategies
          summary.strategies[strategy] = (summary.strategies[strategy] || 0) + 1;
          
          // Track covered vs uncovered positions
          if (position.covered) {
            summary.coveredPositions.push(symbolExpiration);
          } else {
            summary.uncoveredPositions.push(symbolExpiration);
          }
        }
      }
      
      // Get candle analysis for each position symbol
      console.log('🕯️ Getting candle analysis for position symbols...');
      const candleAnalysisResults = {};
      
      for (const symbolExpiration of summary.symbolExpirations) {
        const [symbol] = symbolExpiration.split('_');
        try {
          console.log(`  🕯️ Analyzing ${symbol}...`);
          const candleAnalysis = await analyzeCandles(`$${symbol}`); // No timeframe filter - get all timeframes
          candleAnalysisResults[symbol] = {
            success: true,
            availableTimeframes: candleAnalysis.candleData ? Object.keys(candleAnalysis.candleData) : [],
            lastUpdate: candleAnalysis.timestamp,
            candleData: candleAnalysis.candleData // Store full candle data for BB score analysis
          };
          console.log(`    ✅ ${symbol} analysis complete`);
        } catch (error) {
          console.error(`    ❌ Error analyzing ${symbol}:`, error.message);
          candleAnalysisResults[symbol] = {
            success: false,
            error: error.message
          };
        }
      }

      // Log candle analysis results
      console.log('🕯️ Candle Analysis Results:');
      for (const [symbol, result] of Object.entries(candleAnalysisResults)) {
        if (result.success) {
          console.log(`  ${symbol}: ✅ Available timeframes: ${result.availableTimeframes.join(', ')}`);
        } else {
          console.log(`  ${symbol}: ❌ Error - ${result.error}`);
        }
      }
      
      // Process uncovered positions
      if (summary.uncoveredPositions.length > 0) {
        console.log('🔄 Processing uncovered positions...');
        
        for (const symbolExpiration of summary.uncoveredPositions) {
          // Get the position data
          const positionArray = positions[symbolExpiration];
          if (Array.isArray(positionArray) && positionArray.length > 0) {
            const position = positionArray[0];
            
            // Use the strategy function to determine if we should cover this position
            const coverResult = await this.checkSimpleCover(symbolExpiration, position);
            console.log(`🔄 Cover strategy function returned: ${coverResult}`);
          }
        }
      }
      
      // Try to open new positions for covered symbol_date combinations
      console.log('🔄 Checking for opportunities to open new positions...');
      
      // Find symbol_date combinations that are covered but not uncovered
      // These are valid candidates for opening new positions
      for (const symbolExpiration of summary.coveredPositions) {
        if (!summary.uncoveredPositions.includes(symbolExpiration)) {
          // This symbol_date is covered but not uncovered, so we can try to open a new position
          const [symbol, expiration] = symbolExpiration.split('_');
          
          console.log(`  ${symbol}: Found covered position for ${expiration}, checking candle analysis for new position`);
          
          // Get candle analysis for this symbol
          const candleAnalysis = candleAnalysisResults[symbol];
          
          // Use the strategy function to determine if we should open a position
          const simple15mResponse = await this.checkSimple15mBBScoreOpen(symbol, expiration, candleAnalysis);
          const simple15m60mResponse = await this.checkSimple15and60mBBScoreOpen(symbol, expiration, candleAnalysis);
          
          // For now, just log the result - we'll react to it later
          console.log(`  ${symbol}: checkSimple15mBBScoreOpen Strategy function returned: ${simple15mResponse}`);
          console.log(`  ${symbol}: checkSimple15and60mBBScoreOpenStrategy function returned: ${simple15m60mResponse}`);
        } else {
          console.log(`  ${symbol}: No candle analysis available, skipping position opening`);
        }
      }
      
      // Log summary
      console.log('📊 Position Check Summary:');
      console.log(`  Total Positions: ${summary.totalPositions}, Total Legs: ${summary.totalLegs}, Total Cost: $${summary.totalCost.toFixed(2)}`);
      console.log(`  Strategies: ${JSON.stringify(summary.strategies)}`);
      console.log(`  Symbol/Expirations: ${summary.symbolExpirations.join(', ')}`);
      console.log(`  Covered Positions: ${summary.coveredPositions.length > 0 ? summary.coveredPositions.join(', ') : 'None'}`);
      console.log(`  Uncovered Positions: ${summary.uncoveredPositions.length > 0 ? summary.uncoveredPositions.join(', ') : 'None'}`);

      
    } catch (error) {
      console.error('❌ Error checking positions:', error.message);
    }
  }
}

module.exports = PositionManager;
