#!/usr/bin/env node

/**
 * Position Management Module
 * 
 * Handles position parsing, strategy determination, and enrichment
 */

const fs = require('fs').promises;
const path = require('path');

const POSITIONS_FILE = path.join(__dirname, 'positions.json');

const {
  checkSimple5mBBScoreOpen: strategyCheckSimple5mBBScoreOpen,
  checkSimple15mBBScoreOpen: strategyCheckSimple15mBBScoreOpen,
  checkSimple15and60mBBScoreOpen: strategyCheckSimple15and60mBBScoreOpen,
  checkSimple5mBBScoreCover: strategyCheckSimple5mBBScoreCover,
  checkSimple15mBBScoreCover: strategyCheckSimple15mBBScoreCover,
  checkSimple15and60mBBScoreCover: strategyCheckSimple15and60mBBScoreCover,
  check1m5m15mOpen: strategyCheck1m5m15mOpen,
  check1m5m15mCover: strategyCheck1m5m15mCover,
  checkPriceTrailOpen: strategyCheckPriceTrailOpen,
  checkPriceTrailCover: strategyCheckPriceTrailCover,
  resetPriceTrailState: strategyResetPriceTrailState
} = require('./strategy-logic');

class PositionManager {
  /**
   * Reset PT v1 strategy state for new trading day
   * Call this at 9:30 AM ET or when server starts
   */
  resetStrategyStateForNewTradingDay() {
    if (strategyResetPriceTrailState) {
      strategyResetPriceTrailState();
      console.log(' PT v1 strategy state reset for new trading day');
    }
  }

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
   * Calculate spread strikes from underlying price
   * 40 points wide, centered at nearest $10
   */
  calculateSpreadStrikes(underlyingPrice) {
    const center = Math.round(underlyingPrice / 10) * 10;
    return { lower: center - 20, upper: center + 20 };
  }

  /**
   * Determine if the provided timestamp falls within the PT v1 opening window
   * Market hours: 9:30 AM - 4:00 PM ET, but forbid opening in the final minute (15:59)
   */
  isWithinOpeningWindow(timestamp) {
    if (!timestamp) {
      return false;
    }

    const candleDate = new Date(timestamp);
    const estDate = new Date(candleDate.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const day = estDate.getDay();

    // Only Monday (1) through Friday (5)
    if (day < 1 || day > 5) {
      return false;
    }

    const totalMinutes = estDate.getHours() * 60 + estDate.getMinutes();

    // Allow openings from 9:30 AM (570) through 3:58 PM (958). Skip 3:59 PM (959) and later.
    return totalMinutes >= 570 && totalMinutes < 959;
  }

  /**
   * Try to open a new bull position (bull call debit spread)
   * Buy lower strike call, sell upper strike call
   */
  async tryOpenBullPosition(symbol, expiration, underlyingPrice, persistenceManager) {
    const { lower, upper } = this.calculateSpreadStrikes(underlyingPrice);
    const positionString = `1c${lower}@2000,-1c${upper}@0`;
    console.log(`🐂 Opening bull call spread: ${positionString} (underlying=${underlyingPrice.toFixed(2)})`);
    
    try {
      await persistenceManager.storePosition(symbol, expiration, positionString);
      console.log(`🐂 ✅ Bull call spread stored for ${symbol}_${expiration}`);
    } catch (error) {
      console.error(`🐂 ❌ Failed to store bull call spread: ${error.message}`);
    }
  }

  /**
   * Try to open a new bear position (bear put debit spread)
   * Buy upper strike put, sell lower strike put
   */
  async tryOpenBearPosition(symbol, expiration, underlyingPrice, persistenceManager) {
    const { lower, upper } = this.calculateSpreadStrikes(underlyingPrice);
    const positionString = `1p${upper}@2000,-1p${lower}@0`;
    console.log(`🐻 Opening bear put spread: ${positionString} (underlying=${underlyingPrice.toFixed(2)})`);
    
    try {
      await persistenceManager.storePosition(symbol, expiration, positionString);
      console.log(`🐻 ✅ Bear put spread stored for ${symbol}_${expiration}`);
    } catch (error) {
      console.error(`🐻 ❌ Failed to store bear put spread: ${error.message}`);
    }
  }

  /**
   * Try to cover a bull position (bear call credit spread)
   * Sell lower strike call, buy upper strike call
   * Adds cover legs to existing position in positions.json
   */
  async tryCoverBullPosition(symbolExpiration, position, underlyingPrice) {
    const { lower, upper } = this.calculateSpreadStrikes(underlyingPrice);
    console.log(`🐂 Covering bull with bear call credit spread: -1c${lower}/1c${upper} (underlying=${underlyingPrice.toFixed(2)})`);
    
    try {
      let positions = {};
      try {
        const data = await fs.readFile(POSITIONS_FILE, 'utf8');
        positions = JSON.parse(data);
      } catch (error) {
        console.error(`🐂 ❌ Failed to read positions file: ${error.message}`);
        return;
      }
      
      const posArray = positions[symbolExpiration];
      if (!posArray || posArray.length === 0) {
        console.error(`🐂 ❌ No position found for ${symbolExpiration}`);
        return;
      }
      
      // Add cover legs to the first (uncovered) position entry
      const entry = posArray[0];
      entry.legs.push(
        { action: "cover", quantity: -1, type: "C", strike: lower, cost: -2000, originalString: `-1c${lower}@-2000` },
        { action: "cover", quantity: 1, type: "C", strike: upper, cost: 0, originalString: `1c${upper}@0` }
      );
      entry.covered = true;
      entry.strategy = 'bull_call_spread';
      entry.cost += -2000; // Credit reduces cost
      
      await fs.writeFile(POSITIONS_FILE, this.formatPositionsJson(positions), 'utf8');
      console.log(`🐂 ✅ Bull position covered for ${symbolExpiration}`);
    } catch (error) {
      console.error(`🐂 ❌ Failed to cover bull position: ${error.message}`);
    }
  }

  /**
   * Try to cover a bear position (bull put credit spread)
   * Sell upper strike put, buy lower strike put
   * Adds cover legs to existing position in positions.json
   */
  async tryCoverBearPosition(symbolExpiration, position, underlyingPrice) {
    const { lower, upper } = this.calculateSpreadStrikes(underlyingPrice);
    console.log(`🐻 Covering bear with bull put credit spread: -1p${upper}/1p${lower} (underlying=${underlyingPrice.toFixed(2)})`);
    
    try {
      let positions = {};
      try {
        const data = await fs.readFile(POSITIONS_FILE, 'utf8');
        positions = JSON.parse(data);
      } catch (error) {
        console.error(`🐻 ❌ Failed to read positions file: ${error.message}`);
        return;
      }
      
      const posArray = positions[symbolExpiration];
      if (!posArray || posArray.length === 0) {
        console.error(`🐻 ❌ No position found for ${symbolExpiration}`);
        return;
      }
      
      // Add cover legs to the first (uncovered) position entry
      const entry = posArray[0];
      entry.legs.push(
        { action: "cover", quantity: -1, type: "P", strike: upper, cost: -2000, originalString: `-1p${upper}@-2000` },
        { action: "cover", quantity: 1, type: "P", strike: lower, cost: 0, originalString: `1p${lower}@0` }
      );
      entry.covered = true;
      entry.strategy = 'bear_put_spread';
      entry.cost += -2000; // Credit reduces cost
      
      await fs.writeFile(POSITIONS_FILE, this.formatPositionsJson(positions), 'utf8');
      console.log(`🐻 ✅ Bear position covered for ${symbolExpiration}`);
    } catch (error) {
      console.error(`🐻 ❌ Failed to cover bear position: ${error.message}`);
    }
  }

  /**
   * Check if we should cover based on PT v1 strategy
   */
  async checkPriceTrailCover(symbolExpiration, position, candleAnalysis, persistenceManager) {
    if (!candleAnalysis || !candleAnalysis.success) {
      console.log(`  ${symbolExpiration}: No candle analysis available, skipping PT v1 cover check`);
      return false;
    }

    // Extract BB scores for each timeframe
    const latest = {};
    for (const tf of ['1m', '5m', '15m', '1h']) {
      const tfData = candleAnalysis.candleData[tf];
      if (!tfData || tfData.candles.length === 0) {
        console.log(`  ${symbolExpiration}: Missing ${tf} candle data, skipping PT v1 cover check`);
        return false;
      }
      const candle = tfData.candles[0];
      latest[tf] = { 
        close: candle.close,
        bbScore: candle.bbScore, 
        bbScoreDelta: tfData.candles.length > 1 ? candle.bbScore - tfData.candles[1].bbScore : null,
        trendScore: candle.trendScore 
      };
    }

    // Get underlying price from 1m close for spread strike calculation
    const underlyingPrice = latest['1m'].close;

    console.log(`  ${symbolExpiration}: PT v1 cover bbScores = 1m:${latest['1m'].bbScore.toFixed(3)}, 5m:${latest['5m'].bbScore.toFixed(3)}, 15m:${latest['15m'].bbScore.toFixed(3)}`);

    // Add position type for PT v1 strategy
    const positionWithStrategy = {
      ...position,
      type: this.determinePositionType(position)
    };

    const result = strategyCheckPriceTrailCover(positionWithStrategy, latest);

    if (result.action === 'cover') {
      const positionType = this.determinePositionType(position);
      if (positionType === 'bull') {
        console.log(`  ${symbolExpiration}: PT v1 signals indicate covering bull position`);
        await this.tryCoverBullPosition(symbolExpiration, position, underlyingPrice);
      } else if (positionType === 'bear') {
        console.log(`  ${symbolExpiration}: PT v1 signals indicate covering bear position`);
        await this.tryCoverBearPosition(symbolExpiration, position, underlyingPrice);
      }
      return true;
    }

    console.log(`  ${symbolExpiration}: PT v1 signals do not call for covering`);
    return false;
  }

  /**
   * Check if we should open based on PT v1 strategy
   */
  async checkPriceTrailOpen(symbol, expiration, candleAnalysis, persistenceManager, hasExistingPositions = false) {
    if (!candleAnalysis || !candleAnalysis.success) {
      console.log(`  ${symbol}: No candle analysis available, skipping PT v1 open check`);
      return false;
    }

    // Extract BB scores for each timeframe
    const latest = {};
    for (const tf of ['1m', '5m', '15m', '1h']) {
      const tfData = candleAnalysis.candleData[tf];
      if (!tfData || tfData.candles.length === 0) {
        console.log(`  ${symbol}: Missing ${tf} candle data, skipping PT v1 open check`);
        return false;
      }
      const candle = tfData.candles[0];
      latest[tf] = { 
        close: candle.close,
        bbScore: candle.bbScore, 
        bbScoreDelta: tfData.candles.length > 1 ? candle.bbScore - tfData.candles[1].bbScore : null,
        trendScore: candle.trendScore,
        timestamp: candle.datetime
      };
    }

    // Get underlying price from 1m close for spread strike calculation
    const underlyingPrice = latest['1m'].close;

    // Guardrails: only open positions during market hours window
    if (!this.isWithinOpeningWindow(latest['1m'].timestamp)) {
      console.log(`  ${symbol}: Outside opening window (${latest['1m'].timestamp}), skipping PT v1 open check`);
      return false;
    }

    console.log(`  ${symbol}: PT v1 open bbScores = 1m:${latest['1m'].bbScore.toFixed(3)}, 5m:${latest['5m'].bbScore.toFixed(3)}, 15m:${latest['15m'].bbScore.toFixed(3)}`);

    const result = strategyCheckPriceTrailOpen(latest, hasExistingPositions);

    if (result.action === 'open_bull') {
      console.log(`  ${symbol}: PT v1 signals indicate opening bull position`);
      await this.tryOpenBullPosition(symbol, expiration, underlyingPrice, persistenceManager);
      return true;
    } else if (result.action === 'open_bear') {
      console.log(`  ${symbol}: PT v1 signals indicate opening bear position`);
      await this.tryOpenBearPosition(symbol, expiration, underlyingPrice, persistenceManager);
      return true;
    }

    console.log(`  ${symbol}: PT v1 signals do not call for opening`);
    return false;
  }

  /**
   * Determine position type (bull/bear) from position object
   */
  determinePositionType(position) {
    // Try to determine from strategy field first
    if (position.strategy) {
      if (position.strategy.toLowerCase().includes('bull')) return 'bull';
      if (position.strategy.toLowerCase().includes('bear')) return 'bear';
    }
    
    // Try to determine from legs
    if (position.legs && Array.isArray(position.legs)) {
      // For single leg positions
      if (position.legs.length === 1) {
        const leg = position.legs[0];
        if (leg.type === 'call' && leg.quantity > 0) return 'bull';
        if (leg.type === 'put' && leg.quantity > 0) return 'bear';
      }
      
      // For multi-leg positions (spreads), look at the overall position
      // This is simplified - in reality we'd need to analyze the spread structure
      const netDelta = position.legs.reduce((sum, leg) => {
        const multiplier = leg.type === 'call' ? 1 : -1;
        return sum + (leg.quantity * multiplier);
      }, 0);
      
      return netDelta > 0 ? 'bull' : 'bear';
    }
    
    // Default to unknown
    return 'unknown';
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
   * Check if we should cover based on combined 1m/5m/15m analysis
   */
  async check1m5m15mCover(symbolExpiration, position, candleAnalysis) {
    const [symbol] = symbolExpiration.split('_');

    if (!candleAnalysis || !candleAnalysis.success) {
      console.log(`  ${symbol}: No candle analysis available, skipping 1m/5m/15m cover check`);
      return false;
    }

    const requiredTimeframes = ['1m', '5m', '15m'];
    const latest = {};

    for (const tf of requiredTimeframes) {
      const tfData = candleAnalysis.candleData[tf];
      if (!tfData || !tfData.candles || tfData.candles.length === 0) {
        console.log(`  ${symbol}: Missing ${tf} candle data, skipping 1m/5m/15m cover check`);
        return false;
      }
      const candle = tfData.candles[0];
      latest[tf] = { bbScore: candle.bbScore, trendScore: candle.trendScore };
    }

    console.log(`  ${symbol}: 1m/5m/15m cover bbScores = ${latest['1m'].bbScore}, ${latest['5m'].bbScore}, ${latest['15m'].bbScore}`);

    const result = strategyCheck1m5m15mCover(position, latest);

    if (result.action === 'cover') {
      if (position.type === 'bull') {
        console.log(`  ${symbol}: 1m/5m/15m signals indicate covering bull position`);
        await this.tryCoverBullPosition(symbolExpiration, position);
      } else if (position.type === 'bear') {
        console.log(`  ${symbol}: 1m/5m/15m signals indicate covering bear position`);
        await this.tryCoverBearPosition(symbolExpiration, position);
      }
      return true;
    }

    console.log(`  ${symbol}: 1m/5m/15m signals do not call for covering`);
    return false;
  }

  /**
   * Check if we should open based on combined 1m/5m/15m analysis
   */
  async check1m5m15mOpen(symbol, expiration, candleAnalysis) {
    if (!candleAnalysis || !candleAnalysis.success) {
      console.log(`  ${symbol}: No candle analysis available, skipping 1m/5m/15m open check`);
      return false;
    }

    const requiredTimeframes = ['1m', '5m', '15m'];
    const latest = {};

    for (const tf of requiredTimeframes) {
      const tfData = candleAnalysis.candleData[tf];
      if (!tfData || !tfData.candles || tfData.candles.length === 0) {
        console.log(`  ${symbol}: Missing ${tf} candle data, skipping 1m/5m/15m open check`);
        return false;
      }
      const candle = tfData.candles[0];
      latest[tf] = { bbScore: candle.bbScore, trendScore: candle.trendScore };
    }

    console.log(`  ${symbol}: 1m/5m/15m bbScores = ${latest['1m'].bbScore}, ${latest['5m'].bbScore}, ${latest['15m'].bbScore}`);

    const result = strategyCheck1m5m15mOpen(latest);

    if (result.action === 'open_bull') {
      console.log(`  ${symbol}: 1m/5m/15m signals aligned bullish, opening bull position`);
      await this.tryOpenBullPosition(symbol, expiration);
      return true;
    }
    if (result.action === 'open_bear') {
      console.log(`  ${symbol}: 1m/5m/15m signals aligned bearish, opening bear position`);
      await this.tryOpenBearPosition(symbol, expiration);
      return true;
    }

    console.log(`  ${symbol}: 1m/5m/15m signals neutral/mixed, skipping position opening`);
    return false;
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
        
        const analysis = {
          '15m': { bbScore: bbScore15m },
          '60m': { bbScore: bbScore60m }
        };
        const result = strategyCheckSimple15and60mBBScoreOpen(analysis);
        
        if (result.action === 'open_bull') {
          console.log(`  ${symbol}: Both 15m and 60m BB scores indicate bull signal (bb > 1), opening bull position`);
          await this.tryOpenBullPosition(symbol, expiration);
          return true;
        } else if (result.action === 'open_bear') {
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
        
        const analysis = {
          '15m': { bbScore: bbScore15m },
          '60m': { bbScore: bbScore60m }
        };
        const result = strategyCheckSimple15and60mBBScoreCover(position, analysis);
        
        if (result.action === 'cover') {
          if (position.type === 'bull') {
            console.log(`  ${symbol}: Both 15m and 60m BB scores indicate cover bull position (bb < -1), covering bull position`);
            await this.tryCoverBullPosition(symbolExpiration, position);
          } else if (position.type === 'bear') {
            console.log(`  ${symbol}: Both 15m and 60m BB scores indicate cover bear position (bb > 1), covering bear position`);
            await this.tryCoverBearPosition(symbolExpiration, position);
          }
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
   * Check positions and log summary data using PT v1 strategy
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
      
      // Process uncovered positions using PT v1 strategy
      if (summary.uncoveredPositions.length > 0) {
        console.log('🔄 Processing uncovered positions with PT v1 strategy...');
        
        for (const symbolExpiration of summary.uncoveredPositions) {
          // Get the position data
          const positionArray = positions[symbolExpiration];
          if (Array.isArray(positionArray) && positionArray.length > 0) {
            const position = positionArray[0];
            const [symbol] = symbolExpiration.split('_');
            const candleAnalysis = candleAnalysisResults[symbol];
            
            // Use PT v1 strategy to cover position
            const coverResult = await this.checkPriceTrailCover(symbolExpiration, position, candleAnalysis, persistenceManager);
            console.log(`🔄 PT v1 cover result for ${symbolExpiration}: ${coverResult}`);
          }
        }
      }
      
      // Try to open new positions using PT v1 strategy
      console.log('🔄 Checking for opportunities to open new positions with PT v1 strategy...');
      
      // Check all symbol/expiration combinations (both covered and empty) for opening opportunities
      // Skip uncovered positions since those are being processed for covering above
      for (const symbolExpiration of summary.symbolExpirations) {
        if (summary.uncoveredPositions.includes(symbolExpiration)) {
          continue;
        }
        
        // Get candle analysis for this symbol
        const [symbol, expiration] = symbolExpiration.split('_');
        const candleAnalysis = candleAnalysisResults[symbol];
        
        if (!candleAnalysis || !candleAnalysis.success) {
          console.log(`  ${symbol}: No candle analysis available, skipping position opening`);
          continue;
        }
        
        // Determine if this symbol/date has existing positions
        const positionArray = positions[symbolExpiration];
        const hasExistingPositions = Array.isArray(positionArray) && positionArray.length > 0;
        
        console.log(`  ${symbol}: Checking PT v1 for ${expiration} (hasExistingPositions=${hasExistingPositions})`);
        
        const openResult = await this.checkPriceTrailOpen(symbol, expiration, candleAnalysis, persistenceManager, hasExistingPositions);
        console.log(`  ${symbol}: PT v1 open strategy result: ${openResult}`);
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
