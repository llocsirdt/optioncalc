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
   * Find offsetting positions (placeholder function)
   * Currently just outputs position information for analysis
   */
  async findOffsettingPositions(positions, chainDataMap) {
    const results = {};
    
    console.log(`🔍 OffsetManager.findOffsettingPositions called with ${Object.keys(positions).length} symbol/expirations`);
    
    for (const symbolExpiration of Object.keys(positions)) {
      const [symbol, expiration] = symbolExpiration.split('_');
      
      // Get chain data from the provided map
      const chainData = chainDataMap[symbolExpiration];
      
      console.log(`🔍 Processing ${symbolExpiration}:`, {
        hasChainData: !!chainData,
        callExpirations: chainData?.call ? Object.keys(chainData.call).length : 0,
        putExpirations: chainData?.put ? Object.keys(chainData.put).length : 0,
        positionCount: positions[symbolExpiration].length
      });
      
      // Skip if no chain data available
      if (!chainData) {
        console.warn(`⚠️ No chain data available for ${symbolExpiration}, skipping offsetting analysis`);
        results[symbolExpiration] = {
          positions: positions[symbolExpiration].map(position => ({
            ...position,
            offsettingAnalysis: {
              possibleOffsets: [],
              message: 'No chain data available'
            }
          }))
        };
        continue;
      }
      
      // Log chain data structure
      if (chainData.call) {
        const firstCallExp = Object.keys(chainData.call)[0];
        if (firstCallExp) {
          const callStrikes = Object.keys(chainData.call[firstCallExp]);
          console.log(`📊 Chain data for ${symbolExpiration} - Call strikes sample:`, callStrikes.slice(0, 5), '...', callStrikes.slice(-5));
        }
      }
      
      results[symbolExpiration] = {
        positions: positions[symbolExpiration].map(position => {
          let offsettingAnalysis = {};
          
          // Transform position legs to ensure qty property exists (shared functions expect qty, not quantity)
          const transformedPosition = {
            ...position,
            legs: position.legs.map(leg => ({
              ...leg,
              qty: leg.quantity || leg.qty
            }))
          };
          
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
              const longPutOffsets = this.findOffsettingLongPut(transformedPosition, chainData);
              const shortCallOffsets = this.findOffsettingShortCall(transformedPosition, chainData);
              const bearCallSpreadOffsets = this.findOffsettingBearCallSpread(transformedPosition, chainData);
              const bearPutSpreadOffsets = this.findOffsettingBearPutSpread(transformedPosition, chainData);
              offsettingAnalysis = this.aggregateOffsettingResults([longPutOffsets, shortCallOffsets, bearCallSpreadOffsets, bearPutSpreadOffsets]);
              break;
            case 'short_call':
              // For short call: look for long call, short put, bull call spread, bull put spread
              const longCallOffsets1 = this.findOffsettingLongCall(transformedPosition, chainData);
              const shortPutOffsets1 = this.findOffsettingShortPut(transformedPosition, chainData);
              const bullCallSpreadOffsets1 = this.findOffsettingBullCallSpread(transformedPosition, chainData);
              const bullPutSpreadOffsets1 = this.findOffsettingBullPutSpread(transformedPosition, chainData);
              offsettingAnalysis = this.aggregateOffsettingResults([longCallOffsets1, shortPutOffsets1, bullCallSpreadOffsets1, bullPutSpreadOffsets1]);
              break;
            case 'long_put':
              // For long put: look for long call, short put, bear call spread, bear put spread
              const longCallOffsets2 = this.findOffsettingLongCall(transformedPosition, chainData);
              const shortPutOffsets2 = this.findOffsettingShortPut(transformedPosition, chainData);
              const bearCallSpreadOffsets2 = this.findOffsettingBearCallSpread(transformedPosition, chainData);
              const bearPutSpreadOffsets2 = this.findOffsettingBearPutSpread(transformedPosition, chainData);
              offsettingAnalysis = this.aggregateOffsettingResults([longCallOffsets2, shortPutOffsets2, bearCallSpreadOffsets2, bearPutSpreadOffsets2]);
              break;
            case 'short_put':
              // For short put: look for long call, short call, bull call spread, bull put spread
              const longCallOffsets3 = this.findOffsettingLongCall(transformedPosition, chainData);
              const shortCallOffsets3 = this.findOffsettingShortCall(transformedPosition, chainData);
              const bullCallSpreadOffsets3 = this.findOffsettingBullCallSpread(transformedPosition, chainData);
              const bullPutSpreadOffsets3 = this.findOffsettingBullPutSpread(transformedPosition, chainData);
              offsettingAnalysis = this.aggregateOffsettingResults([longCallOffsets3, shortCallOffsets3, bullCallSpreadOffsets3, bullPutSpreadOffsets3]);
              break;
            case 'bull_call_spread':
              // For bull call spread: look for long call, short put, bear call spread, bear put spread
              console.log(`🔍 Analyzing bull_call_spread position:`, {
                cost: transformedPosition.cost,
                offsetBudget: transformedPosition.offsetBudget,
                spreadWidth: transformedPosition.spreadWidth,
                legs: transformedPosition.legs.map(l => `${l.qty} ${l.type} @ ${l.strike}`)
              });
              const longCallOffsets4 = this.findOffsettingLongCall(transformedPosition, chainData);
              const shortPutOffsets4 = this.findOffsettingShortPut(transformedPosition, chainData);
              const bearCallSpreadOffsets4 = this.findOffsettingBearCallSpread(transformedPosition, chainData);
              console.log(`📊 bearCallSpreadOffsets4:`, bearCallSpreadOffsets4.possibleOffsets?.length || 0, 'offsets');
              const bearPutSpreadOffsets4 = this.findOffsettingBearPutSpread(transformedPosition, chainData);
              console.log(`📊 bearPutSpreadOffsets4:`, bearPutSpreadOffsets4.possibleOffsets?.length || 0, 'offsets');
              offsettingAnalysis = this.aggregateOffsettingResults([longCallOffsets4, shortPutOffsets4, bearCallSpreadOffsets4, bearPutSpreadOffsets4]);
              console.log(`📊 Aggregated offsetting analysis:`, offsettingAnalysis.possibleOffsets?.length || 0, 'total offsets');
              break;
            case 'bear_call_spread':
              // For bear call spread: look for long put, short call, bull call spread, bull put spread
              const longPutOffsets3 = this.findOffsettingLongPut(transformedPosition, chainData);
              const shortCallOffsets4 = this.findOffsettingShortCall(transformedPosition, chainData);
              const bullCallSpreadOffsets4 = this.findOffsettingBullCallSpread(transformedPosition, chainData);
              const bullPutSpreadOffsets4 = this.findOffsettingBullPutSpread(transformedPosition, chainData);
              offsettingAnalysis = this.aggregateOffsettingResults([longPutOffsets3, shortCallOffsets4, bullCallSpreadOffsets4, bullPutSpreadOffsets4]);
              break;
            case 'bull_put_spread':
              // For bull put spread: look for long call, short put, bear call spread, bear put spread
              const longCallOffsets5 = this.findOffsettingLongCall(transformedPosition, chainData);
              const shortPutOffsets5 = this.findOffsettingShortPut(transformedPosition, chainData);
              const bearCallSpreadOffsets5 = this.findOffsettingBearCallSpread(transformedPosition, chainData);
              const bearPutSpreadOffsets5 = this.findOffsettingBearPutSpread(transformedPosition, chainData);
              offsettingAnalysis = this.aggregateOffsettingResults([longCallOffsets5, shortPutOffsets5, bearCallSpreadOffsets5, bearPutSpreadOffsets5]);
              break;
            case 'bear_put_spread':
              // For bear put spread: look for long call, short put, bull call spread, bull put spread
              const longCallOffsets6 = this.findOffsettingLongCall(transformedPosition, chainData);
              const shortPutOffsets6 = this.findOffsettingShortPut(transformedPosition, chainData);
              const bullCallSpreadOffsets6 = this.findOffsettingBullCallSpread(transformedPosition, chainData);
              const bullPutSpreadOffsets6 = this.findOffsettingBullPutSpread(transformedPosition, chainData);
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
