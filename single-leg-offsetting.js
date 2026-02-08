/**
 * Process single leg call offsetting for long put positions
 * @param {Array} putPositions - Put positions array
 * @param {Array} callPositions - Call positions array  
 * @param {Array} marketData - Available market data
 * @param {number} underlyingPrice - Current underlying price
 * @param {number} maxPotentialProfit - Maximum potential profit for budget
 * @param {number} totalCostPaid - Total cost paid for original positions
 * @param {number} originalSpreadWidth - Original spread width (if applicable)
 * @param {Array} offsettingTrades - Array to store offsetting trades
 * @param {Function} calculateSingleLegLockedValue - Function to calculate single leg locked-in value
 */
function processSingleLegCallOffsetting(
  putPositions,
  callPositions,
  marketData,
  underlyingPrice,
  maxPotentialProfit,
  totalCostPaid,
  originalSpreadWidth,
  offsettingTrades,
  calculateSingleLegLockedValue,
  strikeIncrement,
  calculateOffsetCost
) {
  console.log('🔍 Processing single leg call offsetting for long put positions...');
  
  // Find the long put position
  const longPut = putPositions.find(pp => pp.qty > 0);
  if (!longPut) {
    console.log('❌ No long put position found for single leg call offsetting');
    return;
  }
  
  const putStrike = longPut.strike;
  const positionQty = longPut.qty;
  
  console.log(`📊 Long put position: ${positionQty} @ ${putStrike}`);
  
  // Use the maximum potential profit as the budget for offsetting trades
  const offsetBudget = maxPotentialProfit;
  
  if (offsetBudget <= 0) {
    console.log(`❌ No offset budget available (max profit: $${offsetBudget})`);
    return;
  }
  
  console.log(`💰 Offset budget from max profit: $${offsetBudget.toFixed(2)}`);
  
  // Any offsetting trade that costs less than the max profit creates locked-in profit
  console.log(`🎯 Any offsetting trade costing less than $${offsetBudget.toFixed(2)} creates locked-in profit`);
  
  // Use the passed strikeIncrement parameter
  console.log(`🔧 Using passed strike increment: $${strikeIncrement}`);
  
  // For single leg hedges, use calls with strikes LOWER than the put position
  const singleLegCallRange = putStrike - 100; // Start 100 points below put strike
  const maxSingleLegCallStrike = putStrike - 10; // Don't go too close to put strike
  
  console.log(`🔍 Looking for single leg calls up to $${maxSingleLegCallStrike} (lower than put $${putStrike})`);
  
  const qualifyingCalls = marketData.filter(option => {
    return option.type === 'c' && option.strike >= singleLegCallRange && option.strike <= maxSingleLegCallStrike && Number.isInteger(option.strike) && option.strike % strikeIncrement === 0;
  });
  
  console.log(`🔍 Found ${qualifyingCalls.length} calls up to $${maxSingleLegCallStrike} for single leg hedge:`, qualifyingCalls.slice(0, 10).map(c => `${c.strike}@$${((c.bid + c.ask) / 2).toFixed(2)}`).join(', '));
  
  let callCount = 0;
  
  qualifyingCalls.forEach(option => {
    console.log(`🔍 Analyzing single leg call offset: ${option.strike}c`);
    
    const offsetCost = calculateOffsetCost(option, positionQty); // Cost to buy calls
    
    console.log(`   Call price: $${((option.bid + option.ask) / 2).toFixed(2)}, offset cost: $${offsetCost.toFixed(2)}`);
    
    // For long puts, calculate additional profit potential based on realistic scenarios
    // For calls: calculate value at the put strike (most bearish scenario for the original position)
    const callValueAtPutStrike = Math.max(0, option.strike - putStrike) * 100 * Math.abs(positionQty);
    
    console.log(`   Put strike: $${putStrike}, call value at that strike: $${callValueAtPutStrike.toFixed(2)}`);
    
    // Potential value is the call's value at the put strike
    const potentialValue = callValueAtPutStrike;
    
    console.log(`   Potential Value: $${potentialValue.toFixed(2)} VS Position cost: $${totalCostPaid.toFixed(2)}`);
    
    if (potentialValue < totalCostPaid) {
      console.log(`   Skipping call ${option.strike}c: potential value $${potentialValue.toFixed(2)} < position cost $${totalCostPaid.toFixed(2)}`);
      return; // Skip this call
    }
    
    // Calculate true locked-in value by analyzing combined position
    const originalPositions = [
      { type: 'p', strike: putStrike, qty: positionQty }
    ];
    
    const offsettingPositions = [
      { type: 'c', strike: option.strike, qty: Math.abs(positionQty), cost: calculateOffsetCost(option, positionQty) }
    ];
    
    const lockedValueResult = calculateSingleLegLockedValue(originalPositions, offsettingPositions, underlyingPrice, marketData, totalCostPaid);
    const spreadDifference = lockedValueResult.spreadDifference;
    const lockedProfit = lockedValueResult.lockedProfit;
    const potentialProfit = lockedValueResult.potentialProfit;
    
    const upside = callValueAtPutStrike - lockedProfit - offsetCost; // Additional profit beyond locked profit
    
    // Total profit potential = locked profit + upside
    const totalProfitPotential = lockedProfit + upside;
    
    console.log(`🤔 Call ${option.strike}: cost $${offsetCost.toFixed(2)}, spread difference $${spreadDifference.toFixed(2)}, potential profit $${potentialProfit.toFixed(2)}, locked profit $${lockedProfit.toFixed(2)}, upside $${upside.toFixed(2)} (value at $${putStrike}), total potential $${totalProfitPotential.toFixed(2)}`);
    
    if (offsetCost <= offsetBudget && lockedProfit >= 0) {
      console.log(`✅ Risk-free call offset found!`);
      console.log(`   Locked profit: $${lockedProfit.toFixed(2)}`);
      console.log(`   Cost vs budget: $${offsetCost.toFixed(2)} vs $${offsetBudget.toFixed(2)}`);
      offsettingTrades.push({
        type: 'single_leg',
        description: `Long ${Math.abs(positionQty)} ${option.strike} calls`,
        action: `BUY ${Math.abs(positionQty)} ${option.strike} CALL @ $${((option.bid + option.ask) / 2).toFixed(2)}`,
        cost: offsetCost,
        potentialValue: potentialValue, // Keep original logic
        spreadDifference: spreadDifference, // Add new field for spread difference value
        lockedProfit: lockedProfit,
        potentialProfit: potentialProfit, // Add new field for potential profit
        upside: upside,
        totalProfitPotential: totalProfitPotential,
        riskNeutralized: true,
        originalPosition: `Long ${positionQty} ${putStrike} puts`,
        offsettingPosition: `Long ${Math.abs(positionQty)} ${option.strike} calls`
      });
      callCount++;
    }
  });
  
  console.log(`🔍 Single leg call analysis completed:`);
  console.log(`  Calls checked: ${callCount}`);
  console.log(`  Offsetting trades so far: ${offsettingTrades.length}`);
}

/**
 * Process single leg put offsetting for short call positions
 * @param {Array} callPositions - Call positions array
 * @param {Array} putPositions - Put positions array  
 * @param {Array} marketData - Available market data
 * @param {number} underlyingPrice - Current underlying price
 * @param {number} maxPotentialProfit - Maximum potential profit for budget
 * @param {number} totalCostPaid - Total cost paid for original positions
 * @param {number} originalSpreadWidth - Original spread width (if applicable)
 * @param {Array} offsettingTrades - Array to store offsetting trades
 * @param {Function} calculateSingleLegLockedValue - Function to calculate single leg locked-in value
 */
function processSingleLegPutOffsetting(
  callPositions,
  putPositions,
  marketData,
  underlyingPrice,
  maxPotentialProfit,
  totalCostPaid,
  originalSpreadWidth,
  offsettingTrades,
  calculateSingleLegLockedValue,
  strikeIncrement,
  calculateOffsetCost
) {
  console.log('🔍 Processing single leg put offsetting for short call positions...');
  
  // Find the short call position
  const shortCall = callPositions.find(cp => cp.qty < 0);
  if (!shortCall) {
    console.log('❌ No short call position found for single leg put offsetting');
    return;
  }
  
  const shortCallStrike = shortCall.strike;
  const positionQty = shortCall.qty;
  
  console.log(`📊 Short call position: ${positionQty} @ ${shortCallStrike}`);
  
  // Use the maximum potential profit as the budget for offsetting trades
  const offsetBudget = maxPotentialProfit;
  
  if (offsetBudget <= 0) {
    console.log(`❌ No offset budget available (max profit: $${offsetBudget})`);
    return;
  }
  
  console.log(`💰 Offset budget from max profit: $${offsetBudget.toFixed(2)}`);
  
  // Any offsetting trade that costs less than the max profit creates locked-in profit
  console.log(`🎯 Any offsetting trade costing less than $${offsetBudget.toFixed(2)} creates locked-in profit`);
  
  // Use the passed strikeIncrement parameter
  console.log(`🔧 Using passed strike increment: $${strikeIncrement}`);
  
  // Find the short call strike (higher strike) for range calculation
  const highestCallStrike = Math.max(...callPositions.map(cp => cp.strike));
  const higherCallStrike = shortCall ? shortCall.strike : highestCallStrike;
  const singleLegPutRange = higherCallStrike; // Start at short call strike
  
  console.log(`🔍 Looking for puts starting $${singleLegPutRange} (at short call strike $${higherCallStrike})`);
  
  const qualifyingPuts = marketData.filter(option => {
    return option.type === 'p' && option.strike >= singleLegPutRange && Number.isInteger(option.strike) && option.strike % strikeIncrement === 0;
  });
  
  console.log(`🔍 Found ${qualifyingPuts.length} puts at or above ${singleLegPutRange}:`, 
    qualifyingPuts.map(p => `${p.strike}@$${((p.bid + p.ask) / 2).toFixed(2)}`));
  
  let putCount = 0;
  
  qualifyingPuts.forEach(option => {
    console.log(`🔍 Analyzing single leg put offset: ${option.strike}p`);
    
    const offsetCost = calculateOffsetCost(option, positionQty); // Cost to buy puts
    
    console.log(`   Put price: $${((option.bid + option.ask) / 2).toFixed(2)}, offset cost: $${offsetCost.toFixed(2)}`);
    
    // Calculate additional profit potential based on realistic scenarios
    // For puts: calculate value at the lowest call strike (most bullish scenario for the original position)
    const lowestCallStrike = Math.min(...callPositions.map(cp => cp.strike));
    const putValueAtLowestCall = Math.max(0, option.strike - lowestCallStrike) * 100 * Math.abs(positionQty);
    
    console.log(`   Lowest call strike: $${lowestCallStrike}, put value at that strike: $${putValueAtLowestCall.toFixed(2)}`);
    
    // Maximum potential value of the new put trade
    const potentialValue = putValueAtLowestCall;
    
    console.log(`   Potential Value: $${potentialValue.toFixed(2)} VS Position cost: $${totalCostPaid.toFixed(2)}`);
    
    if (potentialValue < totalCostPaid) {
      console.log(`   Skipping put ${option.strike}p: potential value $${potentialValue.toFixed(2)} < position cost $${totalCostPaid.toFixed(2)}`);
      return; // Skip this put
    }
    
    // Calculate true locked-in value by analyzing combined position
    const originalPositions = [
      { type: 'c', strike: higherCallStrike, qty: positionQty }
    ];
    
    const offsettingPositions = [
      { type: 'p', strike: option.strike, qty: Math.abs(positionQty), cost: calculateOffsetCost(option, positionQty) }
    ];
    
    const lockedValueResult = calculateSingleLegLockedValue(originalPositions, offsettingPositions, underlyingPrice, marketData, totalCostPaid);
    const spreadDifference = lockedValueResult.spreadDifference;
    const lockedProfit = lockedValueResult.lockedProfit;
    const potentialProfit = lockedValueResult.potentialProfit;
    
    const upside = putValueAtLowestCall - lockedProfit - offsetCost; // Additional profit beyond locked profit
    
    // Total profit potential = locked profit + upside
    const totalProfitPotential = lockedProfit + upside;
    
    console.log(`🤔 Put ${option.strike}: cost $${offsetCost.toFixed(2)}, spread difference $${spreadDifference.toFixed(2)}, potential profit $${potentialProfit.toFixed(2)}, locked profit $${lockedProfit.toFixed(2)}, upside $${upside.toFixed(2)} (value at $${lowestCallStrike}), total potential $${totalProfitPotential.toFixed(2)}`);
    
    if (offsetCost <= offsetBudget && lockedProfit >= 0) {
      console.log(`✅ Risk-free put offset found!`);
      console.log(`   Locked profit: $${lockedProfit.toFixed(2)}`);
      console.log(`   Cost vs budget: $${offsetCost.toFixed(2)} vs $${offsetBudget.toFixed(2)}`);
      offsettingTrades.push({
        type: 'single_leg',
        description: `Long ${Math.abs(positionQty)} ${option.strike} puts`,
        action: `BUY ${Math.abs(positionQty)} ${option.strike} PUT @ $${((option.bid + option.ask) / 2).toFixed(2)}`,
        cost: offsetCost,
        potentialValue: potentialValue, // Keep original logic
        spreadDifference: spreadDifference, // Add new field for spread difference value
        lockedProfit: lockedProfit,
        potentialProfit: potentialProfit, // Add new field for potential profit
        upside: upside,
        totalProfitPotential: totalProfitPotential,
        riskNeutralized: true,
        originalPosition: `Short ${positionQty} ${higherCallStrike} calls`,
        offsettingPosition: `Long ${Math.abs(positionQty)} ${option.strike} puts`
      });
      putCount++;
    }
  });
  
  console.log(`🔍 Single leg put analysis completed:`);
  console.log(`  Puts checked: ${putCount}`);
  console.log(`  Offsetting trades so far: ${offsettingTrades.length}`);
}

// Export for use in main file
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    processSingleLegCallOffsetting,
    processSingleLegPutOffsetting
  };
}
