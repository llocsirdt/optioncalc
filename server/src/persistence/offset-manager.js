#!/usr/bin/env node

/**
 * Offset Management Module
 * 
 * Handles finding and analyzing offsetting positions
 */

const OffsetCalculations = require('../../../shared/offset-calculations');

class OffsetManager {
  constructor() {
    this.positions = [];
  }

  
  /**
   * Find offsetting candidates for a single position — the strategy-specific
   * dispatch shared by both the account-wide sweep (findOffsettingPositions)
   * and direct single-position checks (PositionManager.analyzeOffsettingPositions).
   * Returns { strategies, possibleOffsets } (possibleOffsets sorted by
   * OffsetCalculations.sortOffsettingPositions — see that function's priority order).
   */
  findOffsettingForPosition(position, chainData) {
    if (position.covered === true) {
      return { strategies: [], possibleOffsets: [], message: 'Position is covered - no offsetting analysis performed' };
    }
    if (!chainData) {
      return { strategies: [], possibleOffsets: [], message: 'No chain data available' };
    }

    // Shared calculation functions expect leg.qty; stored positions use leg.quantity
    const transformedPosition = {
      ...position,
      legs: position.legs.map(leg => ({
        ...leg,
        qty: leg.quantity || leg.qty
      }))
    };

    // Each strategy is offset by searching the opposite-direction single legs
    // and spreads — see the module header comment for the full rationale.
    const searchesByStrategy = {
      long_call: () => [
        this.findOffsettingLongPut(transformedPosition, chainData),
        this.findOffsettingShortCall(transformedPosition, chainData),
        this.findOffsettingBearCallSpread(transformedPosition, chainData),
        this.findOffsettingBearPutSpread(transformedPosition, chainData),
      ],
      short_call: () => [
        this.findOffsettingLongCall(transformedPosition, chainData),
        this.findOffsettingShortPut(transformedPosition, chainData),
        this.findOffsettingBullCallSpread(transformedPosition, chainData),
        this.findOffsettingBullPutSpread(transformedPosition, chainData),
      ],
      long_put: () => [
        this.findOffsettingLongCall(transformedPosition, chainData),
        this.findOffsettingShortPut(transformedPosition, chainData),
        this.findOffsettingBearCallSpread(transformedPosition, chainData),
        this.findOffsettingBearPutSpread(transformedPosition, chainData),
      ],
      short_put: () => [
        this.findOffsettingLongCall(transformedPosition, chainData),
        this.findOffsettingShortCall(transformedPosition, chainData),
        this.findOffsettingBullCallSpread(transformedPosition, chainData),
        this.findOffsettingBullPutSpread(transformedPosition, chainData),
      ],
      bull_call_spread: () => [
        this.findOffsettingLongCall(transformedPosition, chainData),
        this.findOffsettingShortPut(transformedPosition, chainData),
        this.findOffsettingBearCallSpread(transformedPosition, chainData),
        this.findOffsettingBearPutSpread(transformedPosition, chainData),
      ],
      bear_call_spread: () => [
        this.findOffsettingLongPut(transformedPosition, chainData),
        this.findOffsettingShortCall(transformedPosition, chainData),
        this.findOffsettingBullCallSpread(transformedPosition, chainData),
        this.findOffsettingBullPutSpread(transformedPosition, chainData),
      ],
      bull_put_spread: () => [
        this.findOffsettingLongCall(transformedPosition, chainData),
        this.findOffsettingShortPut(transformedPosition, chainData),
        this.findOffsettingBearCallSpread(transformedPosition, chainData),
        this.findOffsettingBearPutSpread(transformedPosition, chainData),
      ],
      bear_put_spread: () => [
        this.findOffsettingLongCall(transformedPosition, chainData),
        this.findOffsettingShortPut(transformedPosition, chainData),
        this.findOffsettingBullCallSpread(transformedPosition, chainData),
        this.findOffsettingBullPutSpread(transformedPosition, chainData),
      ],
    };

    const buildSearches = searchesByStrategy[position.strategy];
    if (!buildSearches) {
      return { strategies: [], possibleOffsets: [], message: `Unknown strategy: ${position.strategy}` };
    }

    return this.aggregateOffsettingResults(buildSearches());
  }

  /**
   * Find offsetting positions across every open position for every symbol/expiration.
   */
  async findOffsettingPositions(positions, chainDataMap) {
    const results = {};

    console.log(`🔍 OffsetManager.findOffsettingPositions called with ${Object.keys(positions).length} symbol/expirations`);

    for (const symbolExpiration of Object.keys(positions)) {
      const chainData = chainDataMap[symbolExpiration];

      results[symbolExpiration] = {
        positions: positions[symbolExpiration].map(position => ({
          strategy: position.strategy,
          cost: position.cost,
          offsetBudget: position.offsetBudget,
          covered: position.covered,
          spreadWidth: position.spreadWidth,
          maxValue: position.maxValue,
          legs: position.legs, // Return full leg data with all fields
          offsettingAnalysis: this.findOffsettingForPosition(position, chainData)
        }))
      };
    }

    return results;
  }

  
  /**
   * Sort offsetting positions by custom priority (delegates to shared function)
   */
  sortOffsettingPositions(possibleOffsets) {
    return OffsetCalculations.sortOffsettingPositions(possibleOffsets);
  }


  /**
   * Aggregate multiple offsetting results into a single result
   */
  aggregateOffsettingResults(results) {
    return OffsetCalculations.aggregateOffsettingResults(results);
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
    // Delegate to shared function
    return OffsetCalculations.findOffsettingBullCallSpread(position, chainData);
  }

  findOffsettingBearCallSpread(position, chainData) {
    // Delegate to shared function
    return OffsetCalculations.findOffsettingBearCallSpread(position, chainData);
  }

  findOffsettingBullPutSpread(position, chainData) {
    // Delegate to shared function
    return OffsetCalculations.findOffsettingBullPutSpread(position, chainData);
  }

  findOffsettingBearPutSpread(position, chainData) {
    // Delegate to shared function
    return OffsetCalculations.findOffsettingBearPutSpread(position, chainData);
  }
}

module.exports = OffsetManager;
