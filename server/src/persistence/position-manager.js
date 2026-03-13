#!/usr/bin/env node

/**
 * Position Management Module
 * 
 * Handles position parsing, strategy determination, and enrichment
 */

const fs = require('fs').promises;
const path = require('path');

const POSITIONS_FILE = path.join(__dirname, 'positions.json');

const { resetPriceTrailState: strategyResetPriceTrailState } = require('./strategy-logic');
const strategyChecks = require('./strategy-check');

class PositionManager {
  constructor() {
    this.priceTrailState = new Map(); // Tracks PT v1 per symbolExpiration
    this.positionsCache = null; // In-memory positions cache
    this.cacheInitialized = false;
  }

  /**
   * Reset PT v1 strategy state for new trading day
   * Call this at 9:30 AM ET or when server starts
   */
  resetStrategyStateForNewTradingDay() {
    if (strategyResetPriceTrailState) {
      strategyResetPriceTrailState();
      console.log(' PT v1 strategy state reset for new trading day');
    }
    this.priceTrailState.clear();
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
        
        // Add core metadata with fallbacks (supports placeholder working positions)
        const bias = positionArray.bias ? positionArray.bias : 'neutral';
        const covered = typeof positionArray.covered === 'boolean' ? positionArray.covered : false;
        const strategy = positionArray.strategy ? positionArray.strategy : 'unknown';
        const cost = Number.isFinite(positionArray.cost) ? positionArray.cost : 0;
        const offsetBudget = Number.isFinite(positionArray.offsetBudget) ? positionArray.offsetBudget : 0;
        const spreadWidth = Number.isFinite(positionArray.spreadWidth) ? positionArray.spreadWidth : 0;
        const maxValue = Number.isFinite(positionArray.maxValue) ? positionArray.maxValue : 0;
        const legs = Array.isArray(positionArray.legs) ? positionArray.legs : [];
        let state = positionArray.state || 'new';
        if (legs.length > 0 && !covered && state !== 'open') {
          state = 'open';
        }

        // Include strategy state tracking fields if present
        const confirmBull = typeof positionArray._confirmBull === 'number' ? positionArray._confirmBull : undefined;
        const confirmBear = typeof positionArray._confirmBear === 'number' ? positionArray._confirmBear : undefined;
        const elapsedOpen = typeof positionArray._elapsedOpen === 'number' ? positionArray._elapsedOpen : undefined;
        
        result += `      "state": ${JSON.stringify(state)}, "bias": ${JSON.stringify(bias)}, "covered": ${covered}, "strategy": ${JSON.stringify(strategy)}, "cost": ${cost}, "offsetBudget": ${offsetBudget}, "spreadWidth": ${spreadWidth}, "maxValue": ${maxValue}`;
        
        // Add strategy tracking fields if they exist
        if (confirmBull !== undefined) {
          result += `, "_confirmBull": ${confirmBull}`;
        }
        if (confirmBear !== undefined) {
          result += `, "_confirmBear": ${confirmBear}`;
        }
        if (elapsedOpen !== undefined) {
          result += `, "_elapsedOpen": ${elapsedOpen}`;
        }
        
        result += ', \n';
        result += '      "legs": [\n';
        
        // Add each leg on a single line
        legs.forEach((leg, legIndex) => {
          result += '        ';
          result += JSON.stringify(leg);
          if (legIndex < legs.length - 1) {
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
  calculateSpreadStrikes(underlyingPrice, spreadWidth = 40) {
    if (underlyingPrice == null) {
      throw new Error('underlyingPrice is required for calculateSpreadStrikes');
    }
    const center = Math.round(underlyingPrice / 10) * 10;
    const half = spreadWidth / 2;
    return { lower: center - half, upper: center + half };
  }

  getLatestPositionEntry(positionArray) {
    if (!Array.isArray(positionArray) || positionArray.length === 0) {
      return null;
    }
    return positionArray[positionArray.length - 1];
  }

  getLatestUncoveredEntry(positionArray) {
    if (!Array.isArray(positionArray) || positionArray.length === 0) {
      return null;
    }
    for (let i = positionArray.length - 1; i >= 0; i--) {
      const entry = positionArray[i];
      const legs = Array.isArray(entry?.legs) ? entry.legs : [];
      const hasInitialLeg = legs.some(leg => leg.action === 'initial');
      if (!entry.covered && hasInitialLeg) {
        return entry;
      }
    }
    return null;
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
  async tryOpenBullPosition(symbol, expiration, underlyingPrice, persistenceManager, options = {}) {
    if (underlyingPrice == null) {
      console.warn(`🐂 Cannot open bull position for ${symbol}_${expiration}: underlyingPrice missing`);
      return;
    }
    const width = Number.isFinite(options.spreadWidth) ? options.spreadWidth : 40;
    const { lower, upper } = this.calculateSpreadStrikes(underlyingPrice, width);
    const positionString = `1c${lower}@2000,-1c${upper}@0`;
    console.log(`🐂 Opening bull call spread: ${positionString} (underlying=${underlyingPrice.toFixed(2)})`);
    
    if (persistenceManager) {
      try {
        await persistenceManager.storePosition(symbol, expiration, positionString);
        console.log(`🐂 ✅ Bull call spread stored for ${symbol}_${expiration}`);
      } catch (error) {
        console.error(`🐂 ❌ Failed to store bull call spread: ${error.message}`);
      }
    } else {
      console.warn(`🐂 No persistence manager provided; bull call spread not stored`);
    }
  }

  /**
   * Try to open a new bear position (bear put debit spread)
   * Buy upper strike put, sell lower strike put
   */
  async tryOpenBearPosition(symbol, expiration, underlyingPrice, persistenceManager, options = {}) {
    if (underlyingPrice == null) {
      console.warn(`🐻 Cannot open bear position for ${symbol}_${expiration}: underlyingPrice missing`);
      return;
    }
    const width = Number.isFinite(options.spreadWidth) ? options.spreadWidth : 40;
    const { lower, upper } = this.calculateSpreadStrikes(underlyingPrice, width);
    const positionString = `1p${upper}@2000,-1p${lower}@0`;
    console.log(`🐻 Opening bear put spread: ${positionString} (underlying=${underlyingPrice.toFixed(2)})`);
    
    if (persistenceManager) {
      try {
        await persistenceManager.storePosition(symbol, expiration, positionString);
        console.log(`🐻 ✅ Bear put spread stored for ${symbol}_${expiration}`);
      } catch (error) {
        console.error(`🐻 ❌ Failed to store bear put spread: ${error.message}`);
      }
    } else {
      console.warn(`🐻 No persistence manager provided; bear put spread not stored`);
    }
  }

  /**
   * Try to cover a bull position (bear call credit spread)
   * Sell lower strike call, buy upper strike call
   * Adds cover legs to existing position in positions.json
   */
  async tryCoverBullPosition(symbolExpiration, position, underlyingPrice, options = {}) {
    const source = options.source || 'unknown';
    const contextLabel = options.context ? ` context=${JSON.stringify(options.context)}` : '';
    const legsCount = Array.isArray(position?.legs) ? position.legs.length : 0;
    console.log(
      `🐂 [cover:${source}] ${symbolExpiration}: requested cover (state=${position?.state || 'unknown'}, ` +
      `legs=${legsCount}, underlying=${underlyingPrice ?? 'n/a'})${contextLabel}`
    );

    if (underlyingPrice == null) {
      console.log(`🐂 [cover:${source}] ${symbolExpiration}: missing underlying price, skipping`);
      return false;
    }

    try {
      let positions = {};
      try {
        const data = await fs.readFile(POSITIONS_FILE, 'utf8');
        positions = JSON.parse(data);
      } catch (error) {
        console.error(`🐂 [cover:${source}] ❌ Failed to read positions file: ${error.message}`);
        return false;
      }
      
      const posArray = positions[symbolExpiration];
      if (!posArray || posArray.length === 0) {
        console.error(`🐂 [cover:${source}] ❌ No position found for ${symbolExpiration}`);
        return false;
      }
      
      const entry = this.getLatestUncoveredEntry(posArray);
      if (!entry) {
        console.warn(`🐂 [cover:${source}] ⚠️ No open bull position with initial legs for ${symbolExpiration}, skipping cover`);
        return false;
      }
      const priorLegCount = Array.isArray(entry.legs) ? entry.legs.length : 0;
      
      const initialLegs = Array.isArray(entry.legs) ? entry.legs.filter(l => l.action === 'initial') : [];
      const existingWidth = this.calculateSpreadWidth(initialLegs);
      const width = Number.isFinite(options.spreadWidth) ? options.spreadWidth : (existingWidth || 40);
      const { lower, upper } = this.calculateSpreadStrikes(underlyingPrice, width);
      
      const timestamp = new Date().toISOString();
      entry.legs.push(
        { action: "cover", quantity: -1, type: "C", strike: lower, cost: -2000, originalString: `-1c${lower}@-2000`, timestamp, symbol: entry.legs[0]?.symbol || symbolExpiration.split('_')[0], expiration: entry.legs[0]?.expiration || symbolExpiration.split('_')[1] },
        { action: "cover", quantity: 1, type: "C", strike: upper, cost: 0, originalString: `1c${upper}@0`, timestamp, symbol: entry.legs[0]?.symbol || symbolExpiration.split('_')[0], expiration: entry.legs[0]?.expiration || symbolExpiration.split('_')[1] }
      );
      entry.covered = true;
      
      await fs.writeFile(POSITIONS_FILE, this.formatPositionsJson(positions), 'utf8');
      const newLegCount = entry.legs.length;
      console.log(
        `🐂 [cover:${source}] ✅ Bull position covered for ${symbolExpiration} (legs ${priorLegCount}→${newLegCount}, ` +
        `strikes ${lower}/${upper})`
      );
      return true;
    } catch (error) {
      console.error(`🐂 [cover:${source}] ❌ Failed to cover bull position: ${error.message}`);
      return false;
    }
  }

  /**
   * Try to cover a bear position (bull put credit spread)
   * Sell upper strike put, buy lower strike put
   * Adds cover legs to existing position in positions.json
   */
  async tryCoverBearPosition(symbolExpiration, position, underlyingPrice, options = {}) {
    const source = options.source || 'unknown';
    const contextLabel = options.context ? ` context=${JSON.stringify(options.context)}` : '';
    const legsCount = Array.isArray(position?.legs) ? position.legs.length : 0;
    console.log(
      `🐻 [cover:${source}] ${symbolExpiration}: requested cover (state=${position?.state || 'unknown'}, ` +
      `legs=${legsCount}, underlying=${underlyingPrice ?? 'n/a'})${contextLabel}`
    );

    if (underlyingPrice == null) {
      console.log(`🐻 [cover:${source}] ${symbolExpiration}: missing underlying price, skipping`);
      return false;
    }

    try {
      let positions = {};
      try {
        const data = await fs.readFile(POSITIONS_FILE, 'utf8');
        positions = JSON.parse(data);
      } catch (error) {
        console.error(`🐻 [cover:${source}] ❌ Failed to read positions file: ${error.message}`);
        return false;
      }
      
      const posArray = positions[symbolExpiration];
      if (!posArray || posArray.length === 0) {
        console.error(`🐻 [cover:${source}] ❌ No position found for ${symbolExpiration}`);
        return false;
      }
      
      const entry = this.getLatestUncoveredEntry(posArray);
      if (!entry) {
        console.warn(`🐻 [cover:${source}] ⚠️ No open bear position with initial legs for ${symbolExpiration}, skipping cover`);
        return false;
      }
      const priorLegCount = Array.isArray(entry.legs) ? entry.legs.length : 0;
      
      const initialLegs = Array.isArray(entry.legs) ? entry.legs.filter(l => l.action === 'initial') : [];
      const existingWidth = this.calculateSpreadWidth(initialLegs);
      const width = Number.isFinite(options.spreadWidth) ? options.spreadWidth : (existingWidth || 40);
      const { lower, upper } = this.calculateSpreadStrikes(underlyingPrice, width);
      
      const timestamp = new Date().toISOString();
      entry.legs.push(
        { action: "cover", quantity: -1, type: "P", strike: upper, cost: -2000, originalString: `-1p${upper}@-2000`, timestamp, symbol: entry.legs[0]?.symbol || symbolExpiration.split('_')[0], expiration: entry.legs[0]?.expiration || symbolExpiration.split('_')[1] },
        { action: "cover", quantity: 1, type: "P", strike: lower, cost: 0, originalString: `1p${lower}@0`, timestamp, symbol: entry.legs[0]?.symbol || symbolExpiration.split('_')[0], expiration: entry.legs[0]?.expiration || symbolExpiration.split('_')[1] }
      );
      entry.covered = true;
      
      await fs.writeFile(POSITIONS_FILE, this.formatPositionsJson(positions), 'utf8');
      const newLegCount = entry.legs.length;
      console.log(
        `🐻 [cover:${source}] ✅ Bear position covered for ${symbolExpiration} (legs ${priorLegCount}→${newLegCount}, ` +
        `strikes ${upper}/${lower})`
      );
      return true;
    } catch (error) {
      console.error(`🐻 [cover:${source}] ❌ Failed to cover bear position: ${error.message}`);
      return false;
    }
  }

  async checkPriceTrailCover(symbolExpiration, position, candleAnalysis, persistenceManager) {
    return strategyChecks.checkPriceTrailCover.call(this, symbolExpiration, position, candleAnalysis, persistenceManager);
  }

  /**
   * Check if we should open based on PT v1 strategy
   */
  async checkPriceTrailOpen(symbol, expiration, candleAnalysis, persistenceManager, hasExistingPositions = false) {
    return strategyChecks.checkPriceTrailOpen.call(this, symbol, expiration, candleAnalysis, persistenceManager, hasExistingPositions);
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
      if (position.legs.length === 0) {
        return 'unknown';
      }
      // For single leg positions
      if (position.legs.length === 1) {
        const leg = position.legs[0];
        const legType = leg.type?.toUpperCase?.() || leg.type;
        if (legType === 'C' && leg.quantity > 0) return 'bull';
        if (legType === 'P' && leg.quantity > 0) return 'bear';
      }
      
      // For multi-leg positions (spreads), look at the overall position
      // This is simplified - in reality we'd need to analyze the spread structure
      const netDelta = position.legs.reduce((sum, leg) => {
        const legType = leg.type?.toUpperCase?.() || leg.type;
        const multiplier = legType === 'C' ? 1 : -1;
        return sum + (leg.quantity * multiplier);
      }, 0);
      
      if (netDelta === 0) {
        return 'unknown';
      }

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
    return strategyChecks.checkSimpleCover.call(this, symbolExpiration, position);
  }

  /**
   * Open a specific offsetting position as a cover
   * @param {string} symbolExpiration - Symbol and expiration (e.g., "NDX_2026-03-31")
   * @param {Object} offsettingPosition - The offsetting position to open as cover
   * @param {Object} options - Options including persistence manager
   * @returns {boolean} - True if successful, false otherwise
   */
  async tryOpenOffsettingCover(symbolExpiration, offsettingPosition, options = {}) {
    const source = options.source || 'offsetting-analysis';
    const persistenceManager = options.persistenceManager;
    
    console.log(`🔄 [cover:${source}] ${symbolExpiration}: Opening offsetting position as cover`);
    
    if (!offsettingPosition || !offsettingPosition.legs || !Array.isArray(offsettingPosition.legs)) {
      console.error(`🔄 [cover:${source}] ❌ Invalid offsetting position provided`);
      return false;
    }
    
    if (!persistenceManager) {
      console.error(`🔄 [cover:${source}] ❌ No persistence manager provided`);
      return false;
    }
    
    try {
      // Store the covering legs using the new method
      const updatedEntry = await persistenceManager.storeCoveringLegs(
        symbolExpiration,
        offsettingPosition.legs,
        { entryIndex: -1 } // Use latest uncovered entry
      );
      
      console.log(
        `🔄 [cover:${source}] ✅ Offsetting position stored as cover for ${symbolExpiration} ` +
        `(total legs: ${updatedEntry.legs.length})`
      );
      
      return true;
      
    } catch (error) {
      console.error(`🔄 [cover:${source}] ❌ Failed to store offsetting cover: ${error.message}`);
      return false;
    }
  }

  /**
   * Analyze offsetting positions for a given position and group by score buckets
   * @param {string} symbolExpiration - The symbol_date combination
   * @param {Object} position - The position object
   * @returns {Object} - Analysis result with bucket counts, total available, and raw positions
   */
  async analyzeOffsettingPositions(symbolExpiration, position) {
    try {
      // Extract symbol from symbolExpiration (e.g., "NDX_2026-03-31" -> "NDX")
      const symbol = symbolExpiration.split('_')[0];
      
      // Fetch offsetting positions from the server API
      const offsetUrl = `http://localhost:3001/api/v1/positions/offsetting?symbol=${symbol}`;
      const response = await fetch(offsetUrl);
      
      if (!response.ok) {
        console.warn(`⚠️ Failed to fetch offsetting positions for ${symbol}: ${response.statusText}`);
        return { totalAvailable: 0, buckets: {}, positions: [] };
      }
      
      const data = await response.json();
      const offsettingPositions = data.offsettingPositions || [];
      
      // Group by score buckets (0-0.1, 0.1-0.2, ..., 0.9-1.0)
      const buckets = {};
      let totalAvailable = 0;
      
      for (const pos of offsettingPositions) {
        const score = pos.score ?? 0;
        const bucketKey = Math.floor(score * 10) / 10; // Rounds down to nearest 0.1
        const bucketLabel = `${bucketKey}-${bucketKey + 0.1}`;
        
        if (!buckets[bucketLabel]) {
          buckets[bucketLabel] = 0;
        }
        buckets[bucketLabel]++;
        totalAvailable++;
      }
      
      // Log the results
      console.log(`📊 Offset analysis for ${symbolExpiration}:`);
      console.log(`  Total available offsetting positions: ${totalAvailable}`);
      if (totalAvailable > 0) {
        console.log(`  Score distribution:`);
        Object.entries(buckets)
          .sort(([a], [b]) => parseFloat(a) - parseFloat(b))
          .forEach(([bucket, count]) => {
            console.log(`    ${bucket}: ${count} positions`);
          });
      }
      
      return { totalAvailable, buckets, positions: offsettingPositions };
      
    } catch (error) {
      console.error(`❌ Error analyzing offsetting positions for ${symbolExpiration}: ${error.message}`);
      return { totalAvailable: 0, buckets: {}, positions: [] };
    }
  }

  /**
   * Check if we should cover based on combined 1m/5m/15m analysis
   */
  async check1m5m15mCover(symbolExpiration, position, candleAnalysis) {
    return strategyChecks.check1m5m15mCover.call(this, symbolExpiration, position, candleAnalysis);
  }

  /**
   * Check if we should open based on combined 1m/5m/15m analysis
   */
  async check1m5m15mOpen(symbol, expiration, candleAnalysis) {
    return strategyChecks.check1m5m15mOpen.call(this, symbol, expiration, candleAnalysis);
  }

  /**
   * Check if we should open a new position based on simple 5m BB score strategy
   * @param {string} symbol - The symbol to check
   * @param {string} expiration - The expiration date
   * @param {Object} candleAnalysis - Candle analysis data for the symbol
   * @returns {boolean} - True if conditions were met, false otherwise
   */
  async checkSimple5mBBScoreOpen(symbol, expiration, candleAnalysis) {
    return strategyChecks.checkSimple5mBBScoreOpen.call(this, symbol, expiration, candleAnalysis);
  }

  /**
   * Check if we should open a new position based on simple 15m BB score strategy
   * @param {string} symbol - The symbol to check
   * @param {string} expiration - The expiration date
   * @param {Object} candleAnalysis - Candle analysis data for the symbol
   * @returns {boolean} - True if conditions were met, false otherwise
   */
  async checkSimple15mBBScoreOpen(symbol, expiration, candleAnalysis) {
    return strategyChecks.checkSimple15mBBScoreOpen.call(this, symbol, expiration, candleAnalysis);
  }

  /**
   * Check if we should open a new position based on simple 15m and 60m BB score strategy
   * @param {string} symbol - The symbol to check
   * @param {string} expiration - The expiration date
   * @param {Object} candleAnalysis - Candle analysis data for the symbol
   * @returns {boolean} - True if conditions were met, false otherwise
   */
  async checkSimple15and60mBBScoreOpen(symbol, expiration, candleAnalysis) {
    return strategyChecks.checkSimple15and60mBBScoreOpen.call(this, symbol, expiration, candleAnalysis);
  }

  /**
   * Check if we should cover a position based on simple 5m BB score strategy
   * @param {string} symbolExpiration - The symbol_date combination
   * @param {Object} position - The position object
   * @param {Object} candleAnalysis - Candle analysis data for the symbol
   * @returns {boolean} - True if covering was attempted, false otherwise
   */
  async checkSimple5mBBScoreCover(symbolExpiration, position, candleAnalysis) {
    return strategyChecks.checkSimple5mBBScoreCover.call(this, symbolExpiration, position, candleAnalysis);
  }

  /**
   * Check if we should cover a position based on simple 15m BB score strategy
   * @param {string} symbolExpiration - The symbol_date combination
   * @param {Object} position - The position object
   * @param {Object} candleAnalysis - Candle analysis data for the symbol
   * @returns {boolean} - True if covering was attempted, false otherwise
   */
  async checkSimple15mBBScoreCover(symbolExpiration, position, candleAnalysis) {
    return strategyChecks.checkSimple15mBBScoreCover.call(this, symbolExpiration, position, candleAnalysis);
  }

  /**
   * Check if we should cover a position based on simple 15m and 60m BB score strategy
   * @param {string} symbolExpiration - The symbol_date combination
   * @param {Object} position - The position object
   * @param {Object} candleAnalysis - Candle analysis data for the symbol
   * @returns {boolean} - True if covering was attempted, false otherwise
   */
  async checkSimple15and60mBBScoreCover(symbolExpiration, position, candleAnalysis) {
    return strategyChecks.checkSimple15and60mBBScoreCover.call(this, symbolExpiration, position, candleAnalysis);
  }

  /**
   * Check positions and log summary data using PT v1 strategy
   * This method will be called by the server loop every 10 seconds
   */
  async checkPositionsBKUP(persistenceManager) {
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
          const position = this.getLatestPositionEntry(positionArray);
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
            const position = this.getLatestPositionEntry(positionArray);
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
        const latestPosition = hasExistingPositions ? positionArray[positionArray.length - 1] : null;
        if (latestPosition && !latestPosition.covered) {
          console.log(`  ${symbol}: Skipping PT v1 open for ${expiration} - latest position still uncovered`);
          continue;
        }
        
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

  async checkPositions(persistenceManager) {
    try {
      // Import candle analyzer
      const { analyzeCandles } = require('./candle-analyzer');
      
      // Get positions from persistence manager
      if (!persistenceManager) {
        console.log('📊 Position Check: No persistence manager provided');
        return;
      }
      
      // Initialize cache from disk on first run, otherwise use in-memory cache
      let positions;
      if (!this.cacheInitialized) {
        positions = await persistenceManager.getAllPositions();
        this.positionsCache = positions;
        this.cacheInitialized = true;
        console.log('📊 Initialized positions cache from disk');
      } else {
        // Use in-memory cache
        positions = this.positionsCache;
        
        // Sync critical fields from disk (legs, covered status) in case of external changes
        const diskPositions = await persistenceManager.getAllPositions();
        for (const [symbolExpiration, diskArray] of Object.entries(diskPositions)) {
          if (!positions[symbolExpiration]) {
            // New position added externally
            positions[symbolExpiration] = diskArray;
            console.log(`📊 Added new position from disk: ${symbolExpiration}`);
          } else {
            // Sync legs and covered status for existing positions
            const memArray = positions[symbolExpiration];
            diskArray.forEach((diskPos, index) => {
              if (memArray[index]) {
                // Preserve in-memory state tracking fields, but sync execution results
                const legs = diskPos.legs || [];
                const covered = diskPos.covered || false;
                if (JSON.stringify(memArray[index].legs) !== JSON.stringify(legs)) {
                  memArray[index].legs = legs;
                  console.log(`📊 Synced legs from disk for ${symbolExpiration}[${index}]`);
                }
                if (memArray[index].covered !== covered) {
                  memArray[index].covered = covered;
                  console.log(`📊 Synced covered status from disk for ${symbolExpiration}[${index}]`);
                }
              } else {
                // Position added externally at this index
                memArray[index] = diskPos;
                console.log(`📊 Added position from disk: ${symbolExpiration}[${index}]`);
              }
            });
          }
        }
      }
      
      if (!positions || Object.keys(positions).length === 0) {
        console.log('📊 Position Check: No positions available');
        return;
      }

      // Initialize working position objects for each symbol_date
      // STATE CHANGE: Creates new working positions with 'new' state when:
      // 1) Position array is empty (first time seeing this symbol/expiration)
      // 2) Latest position is covered (previous cycle completed)
      let positionsModified = false;
      for (const [symbolExpiration, positionArray] of Object.entries(positions)) {
        if (!Array.isArray(positionArray)) continue;

        if (positionArray.length === 0) {
          // Empty array - initialize first working position
          positionArray.push({ state: 'new', bias: 'neutral' });
          console.log(`  ${symbolExpiration}: Initialized new working position`);
          positionsModified = true;
        } else {
          // Check if latest position is covered - if so, create next working position
          const latestPosition = positionArray[positionArray.length - 1];
          if (latestPosition.covered) {
            positionArray.push({ state: 'new', bias: 'neutral' });
            console.log(`  ${symbolExpiration}: Previous position covered, initialized next working position`);
            positionsModified = true;
          }
        }
      }

      // Normalize existing position states to match reality
      // STATE CHANGE: Corrects mismatched states based on actual position data
      // Criteria: covered=true -> state='covered', legs>0 -> state='open', otherwise -> state='new'
      for (const [symbolExpiration, positionArray] of Object.entries(positions)) {
        if (!Array.isArray(positionArray)) continue;

        positionArray.forEach((position, index) => {
          if (!position || typeof position !== 'object') return;

          const legs = Array.isArray(position.legs) ? position.legs : [];
          const covered = Boolean(position.covered);

          let expectedState = 'new';
          if (covered) {
            expectedState = 'covered';
          } else if (legs.length > 0) {
            expectedState = 'open';
          } else if (position.state && position.state.startsWith('ready_open')) {
            expectedState = position.state;
          }

          if (position.state !== expectedState) {
            console.log(`🔄 STATE CHANGE [${symbolExpiration}[${index}]]: Normalizing state '${position.state}' -> '${expectedState}' (covered=${covered}, legs=${legs.length})`);
            position.state = expectedState;
            positionsModified = true;
            console.log(`  ${symbolExpiration}[${index}]: Normalized state -> ${expectedState}`);
          }
        });
      }

      // Persist any newly initialized working positions
      if (positionsModified) {
        await persistenceManager.saveAllPositions(positions);
        console.log('💾 Saved initialized working positions');
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
          const position = this.getLatestPositionEntry(positionArray);
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
      
      // Run state-driven strategy across working positions
      // STATE CHANGES: All state updates below are queued and applied atomically at the end
      const pendingStateUpdates = new Map();
      const queueStateUpdate = (symbolExpiration, index, updates) => {
        const key = `${symbolExpiration}__${index}`;
        const existing = pendingStateUpdates.get(key) || {};
        pendingStateUpdates.set(key, { ...existing, ...updates });
      };

      for (const symbolExpiration of summary.symbolExpirations) {
        const positionArray = positions[symbolExpiration];
        if (!Array.isArray(positionArray) || positionArray.length === 0) {
          continue;
        }

        const [symbol, expiration] = symbolExpiration.split('_');
        const candleAnalysis = candleAnalysisResults[symbol];
        if (!candleAnalysis || !candleAnalysis.success) {
          console.log(`  ${symbol}: Missing candle analysis, skipping state strategy`);
          continue;
        }

        const workingIndex = positionArray.length - 1;
        const workingPosition = positionArray[workingIndex];
        if (!workingPosition || typeof workingPosition !== 'object') {
          continue;
        }

        const legs = Array.isArray(workingPosition.legs) ? workingPosition.legs : [];
        const covered = Boolean(workingPosition.covered);
        const hasOpenLegs = legs.length > 0 && !covered;

        // Determine current state if not set
        let currentState = workingPosition.state;
        if (!currentState) {
          currentState = covered ? 'covered' : (hasOpenLegs ? 'open' : 'new');
        }

        // OPEN STATE LOGIC: Check if we should try to open new positions
        // STATE CHANGE: Sets 'ready_open_bull'/'ready_open_bear' when strategy suggests opening but execution fails
        // STATE CHANGE: Updates to strategy's nextState when strategy provides explicit next state
        // Criteria: !covered AND (state='new' OR state starts with 'ready_open' OR no legs exist)
        const shouldCheckOpen = !covered && (currentState === 'new' || currentState.startsWith('ready_open') || legs.length === 0);
        if (shouldCheckOpen) {
          const ts1m = candleAnalysis?.candleData?.['1m']?.candles?.[0]?.datetime;
          const withinMarket = this.isWithinOpeningWindow(ts1m);
          if (!withinMarket) {
            console.log(`⏰ ${symbol}: Outside market hours (${ts1m || 'n/a'}), skipping state open`);
            continue;
          }
          const openResult = await strategyChecks.checkStateOpen.call(this, symbol, expiration, workingPosition, candleAnalysis, persistenceManager);
          const openAction = openResult?.action;
          const executedOpen = Boolean(openResult?.executed);

          try {
            const dbgNextState = openResult?.nextState || workingPosition.state;
            const dbgNextBias = openResult?.nextBias || workingPosition.bias;
            console.log(`🧪 [diag/open] ${symbolExpiration}[${workingIndex}]: action=${openAction || 'hold'}, nextState=${dbgNextState}, nextBias=${dbgNextBias}, executed=${executedOpen}, reason=${openResult?.reason || 'n/a'}`);
          } catch (_) {}

          const stateUpdatesOpen = openResult?.positionStateUpdates || openResult?.positionPatches;
          if (stateUpdatesOpen && typeof stateUpdatesOpen === 'object') {
            try {
              Object.assign(workingPosition, stateUpdatesOpen);
              queueStateUpdate(symbolExpiration, workingIndex, stateUpdatesOpen);
              const cBull = stateUpdatesOpen._confirmBull ?? workingPosition._confirmBull ?? 0;
              const cBear = stateUpdatesOpen._confirmBear ?? workingPosition._confirmBear ?? 0;
              console.log(`🧪 [diag/open] ${symbolExpiration}[${workingIndex}] patches: _confirmBull=${cBull}, _confirmBear=${cBear}`);
            } catch (_) {}
          }

          // STATE CHANGE: Fallback to ready state when strategy wants to open but doesn't execute
          // Criteria: action='open_bull'/'open_bear' AND executed=false
          if ((openAction === 'open_bull' || openAction === 'open_bear') && !executedOpen) {
            const fallbackState = openAction === 'open_bull' ? 'ready_open_bull' : 'ready_open_bear';
            const fallbackBias = openAction === 'open_bull' ? 'bullish' : 'bearish';
            if (workingPosition.state !== fallbackState) {
              console.log(`🔄 STATE CHANGE [${symbolExpiration}[${workingIndex}]]: Fallback to ready state '${workingPosition.state}' -> '${fallbackState}' (action=${openAction}, executed=false)`);
              workingPosition.state = fallbackState;
              queueStateUpdate(symbolExpiration, workingIndex, { state: fallbackState });
            }
            if (workingPosition.bias !== fallbackBias) {
              console.log(`🔄 BIAS CHANGE [${symbolExpiration}[${workingIndex}]]: '${workingPosition.bias}' -> '${fallbackBias}' (fallback for ${openAction})`);
              workingPosition.bias = fallbackBias;
              queueStateUpdate(symbolExpiration, workingIndex, { bias: fallbackBias });
            }
            continue;
          }

          // STATE CHANGE: Follow strategy's explicit next state recommendation
          // Criteria: strategy provides nextState AND it differs from current state
          if (openResult?.nextState && openResult.nextState !== workingPosition.state) {
            console.log(`🔄 STATE CHANGE [${symbolExpiration}[${workingIndex}]]: Strategy next state '${workingPosition.state}' -> '${openResult.nextState}' (open strategy)`);
            workingPosition.state = openResult.nextState;
            queueStateUpdate(symbolExpiration, workingIndex, { state: openResult.nextState });
          }

          // STATE CHANGE: Update bias based on strategy recommendation
          // Criteria: strategy provides nextBias AND it differs from current bias
          if (openResult?.nextBias && openResult.nextBias !== workingPosition.bias) {
            console.log(`🔄 BIAS CHANGE [${symbolExpiration}[${workingIndex}]]: '${workingPosition.bias}' -> '${openResult.nextBias}' (strategy recommendation)`);
            workingPosition.bias = openResult.nextBias;
            queueStateUpdate(symbolExpiration, workingIndex, { bias: openResult.nextBias });
          }

          continue;
        }

        // COVER STATE LOGIC: Check if we should cover existing open positions
        // STATE CHANGE: Updates to strategy's nextState when cover is executed
        // STATE CHANGE: Sets covered=true when cover execution succeeds
        // Criteria: !covered AND state='open' AND has legs
        if (!covered && currentState === 'open') {
          if (!hasOpenLegs) {
            console.log(`  ${symbol}: State marked open but no legs recorded for ${expiration}, skipping cover`);
            continue;
          }

          const ts1m = candleAnalysis?.candleData?.['1m']?.candles?.[0]?.datetime;
          const withinMarket = this.isWithinOpeningWindow(ts1m);
          if (!withinMarket) {
            console.log(`⏰ ${symbol}: Outside market hours (${ts1m || 'n/a'}), skipping state cover`);
            continue;
          }

          const coverResult = await strategyChecks.checkStateCover.call(this, symbolExpiration, workingPosition, candleAnalysis);

          try {
            console.log(`🧪 [diag/cover] ${symbolExpiration}[${workingIndex}]: action=${coverResult?.action || 'hold'}, executed=${coverResult?.executed ? 'true' : 'false'}, reason=${coverResult?.reason || 'n/a'}`);
          } catch (_) {}

          const stateUpdatesCover = coverResult?.positionStateUpdates || coverResult?.positionPatches;
          if (stateUpdatesCover && typeof stateUpdatesCover === 'object') {
            try {
              Object.assign(workingPosition, stateUpdatesCover);
              queueStateUpdate(symbolExpiration, workingIndex, stateUpdatesCover);
              const elapsed = stateUpdatesCover._elapsedOpen ?? workingPosition._elapsedOpen;
              if (elapsed !== undefined) {
                console.log(`🧪 [diag/cover] ${symbolExpiration}[${workingIndex}] patches: _elapsedOpen=${elapsed}`);
              }
            } catch (_) {}
          }

          // STATE CHANGE: Follow strategy's next state when cover was executed
          // Criteria: cover executed AND strategy provides nextState AND it differs from current state
          if (coverResult?.nextState && coverResult.executed && coverResult.nextState !== workingPosition.state) {
            console.log(`🔄 STATE CHANGE [${symbolExpiration}[${workingIndex}]]: Cover executed, state '${workingPosition.state}' -> '${coverResult.nextState}' (cover strategy)`);
            workingPosition.state = coverResult.nextState;
            queueStateUpdate(symbolExpiration, workingIndex, { state: coverResult.nextState });
          }

          // STATE CHANGE: Mark position as covered when cover execution succeeds
          // Criteria: cover executed AND position not already marked as covered
          if (coverResult.executed && !workingPosition.covered) {
            console.log(`🔄 COVERED CHANGE [${symbolExpiration}[${workingIndex}]]: false -> true (cover executed)`);
            workingPosition.covered = true;
            queueStateUpdate(symbolExpiration, workingIndex, { covered: true });
          }
          
          // FALLBACK: Try simple cover if state cover didn't execute
          // Criteria: !covered AND state='open' AND checkStateCover didn't execute
          if (!coverResult.executed && !workingPosition.covered && currentState === 'open') {
            console.log(`  ${symbol}: State cover took no action, trying simple cover fallback`);
            try {
              const simpleResult = await strategyChecks.checkSimpleCover.call(this, symbolExpiration, workingPosition);
              if (simpleResult) {
                console.log(`  ${symbol}: Simple cover executed successfully`);
              }
            } catch (error) {
              console.error(`  ${symbol}: Simple cover fallback failed - ${error.message}`);
            }
          }
        }
      }

      // Apply all queued state updates atomically
      // STATE CHANGES: This is where all queued state changes are actually applied to the in-memory cache
      // The queue prevents race conditions and ensures all changes for a cycle are applied together
      if (pendingStateUpdates.size > 0) {
        let appliedUpdates = 0;

        for (const [key, updates] of pendingStateUpdates.entries()) {
          const [symbolExpiration, indexStr] = key.split('__');
          const index = parseInt(indexStr, 10);
          if (!Number.isInteger(index)) {
            continue;
          }

          const entryList = positions[symbolExpiration];
          if (!Array.isArray(entryList) || !entryList[index]) {
            continue;
          }

          // STATE CHANGE: Apply all queued updates (state, bias, covered, confirmation counters) to the position
          const oldState = entryList[index].state || 'undefined';
          const oldBias = entryList[index].bias || 'undefined';
          const oldCovered = entryList[index].covered;
          entryList[index] = { ...entryList[index], ...updates };
          console.log(`💾 APPLYING STATE [${symbolExpiration}[${index}]]: state: '${oldState}' -> '${entryList[index].state}', bias: '${oldBias}' -> '${entryList[index].bias}', covered: ${oldCovered} -> ${entryList[index].covered}`);
          appliedUpdates++;
        }

        if (appliedUpdates > 0) {
          // Save in-memory cache to disk
          await persistenceManager.saveAllPositions(positions);
          console.log(`💾 Saved ${appliedUpdates} state update(s)`);
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
