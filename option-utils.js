// Option Trading Utility Functions
// Shared functions used across multiple modules

/**
 * Calculate appropriate strike increment based on underlying price
 * @param {number} underlyingPrice - Current underlying price
 * @returns {number} Strike increment (1, 5, or 10)
 */
function calculateStrikeIncrement(underlyingPrice) {
  if (underlyingPrice < 100) {
    return 1;   // For low-priced options (e.g., $0.50-$99)
  } else if (underlyingPrice <= 1000) {
    return 5;   // For mid-priced options (e.g., $100-$1000)
  } else {
    return 10;  // For high-priced options (e.g., $1000+)
  }
}

/**
 * Calculate locked-in value for single leg offsets
 * Formula: Value at overlap point - Total cost
 * @param {Array} originalPositions - Original single leg position
 * @param {Array} offsettingPositions - Offsetting single leg position  
 * @param {number} underlyingPrice - Current underlying price
 * @param {Array} marketData - Available market data
 * @param {number} originalCost - Cost of original position
 * @returns {Object} Object with spreadDifference, lockedProfit, and potentialProfit values
 */
function calculateSingleLegLockedValue(originalPositions, offsettingPositions, underlyingPrice, marketData, originalCost = 0) {
  console.log('🔍 Calculating locked-in value for single leg offset...');
  console.log('📊 Original positions:', originalPositions);
  console.log('📊 Offsetting positions:', offsettingPositions);
  console.log('💰 Original position cost:', originalCost);
  
  const originalPos = originalPositions[0];
  const offsettingPos = offsettingPositions[0];
  
  // Calculate offsetting cost
  const offsettingCost = offsettingPos.cost || 0;
  const totalCost = originalCost + offsettingCost;
  
  // For single leg offsets, the locked value is based on the value at the overlap point
  // where both positions would have intrinsic value
  let lockedValue = 0;
  let potentialValue = 0;
  
  if (originalPos.type === 'c' && offsettingPos.type === 'p') {
    // Original: Short call, Offsetting: Long put
    // Overlap point is at the put strike (below underlying price)
    const overlapPrice = offsettingPos.strike;
    const callValueAtOverlap = Math.max(0, overlapPrice - originalPos.strike) * 100 * Math.abs(originalPos.qty);
    const putValueAtOverlap = Math.max(0, offsettingPos.strike - overlapPrice) * 100 * Math.abs(offsettingPos.qty);
    
    lockedValue = putValueAtOverlap - callValueAtOverlap; // Long put value - Short call value
    potentialValue = putValueAtOverlap; // Maximum value is put value at its strike
    
    console.log(`🔄 Single leg overlap analysis:`);
    console.log(`  Overlap price: $${overlapPrice}`);
    console.log(`  Call value at overlap: $${callValueAtOverlap.toFixed(2)}`);
    console.log(`  Put value at overlap: $${putValueAtOverlap.toFixed(2)}`);
    console.log(`  Locked value: $${putValueAtOverlap.toFixed(2)} - $${callValueAtOverlap.toFixed(2)} = $${lockedValue.toFixed(2)}`);
    
  } else if (originalPos.type === 'p' && offsettingPos.type === 'c') {
    // Original: Long put, Offsetting: Long call
    // Overlap point is at the call strike (above underlying price)
    const overlapPrice = offsettingPos.strike;
    const putValueAtOverlap = Math.max(0, originalPos.strike - overlapPrice) * 100 * Math.abs(originalPos.qty);
    const callValueAtOverlap = Math.max(0, overlapPrice - offsettingPos.strike) * 100 * Math.abs(offsettingPos.qty);
    
    lockedValue = callValueAtOverlap + putValueAtOverlap; // Both legs have value
    potentialValue = callValueAtOverlap; // Maximum value is call value at its strike
    
    console.log(`🔄 Single leg overlap analysis:`);
    console.log(`  Overlap price: $${overlapPrice}`);
    console.log(`  Put value at overlap: $${putValueAtOverlap.toFixed(2)}`);
    console.log(`  Call value at overlap: $${callValueAtOverlap.toFixed(2)}`);
    console.log(`  Locked value: $${callValueAtOverlap.toFixed(2)} + $${putValueAtOverlap.toFixed(2)} = $${lockedValue.toFixed(2)}`);
  }
  
  // Calculate locked profit and potential profit
  const lockedProfit = Math.max(0, lockedValue - totalCost);
  const potentialProfit = Math.max(0, potentialValue - totalCost);
  
  console.log(`🔒 Single leg locked-in calculation:`);
  console.log(`  Original cost: $${originalCost}`);
  console.log(`  Offsetting cost: $${offsettingCost}`);
  console.log(`  Total cost: $${totalCost}`);
  console.log(`  Locked value: $${lockedValue.toFixed(2)}`);
  console.log(`  Potential value: $${potentialValue.toFixed(2)}`);
  console.log(`  Locked profit: $${lockedValue.toFixed(2)} - $${totalCost.toFixed(2)} = $${lockedProfit.toFixed(2)}`);
  console.log(`  Potential profit: $${potentialValue.toFixed(2)} - $${totalCost.toFixed(2)} = $${potentialProfit.toFixed(2)}`);
  
  return {
    spreadDifference: potentialValue,
    lockedProfit: lockedProfit,
    potentialProfit: potentialProfit
  };
}

/**
 * Calculate locked-in value for offsetting spreads
 * Formula: MIN(Bull Call Max Profit, Bear Put Max Profit) - Initial Cost - Offsetting Cost
 * @param {Array} originalPositions - Original option positions
 * @param {Array} offsettingPositions - Offsetting option positions  
 * @param {number} underlyingPrice - Current underlying price
 * @param {Array} marketData - Available market data
 * @param {number} originalCost - Cost of original positions
 * @returns {Object} Object with spreadDifference, lockedProfit, and potentialProfit values
 */
function calculateLockedInValue(originalPositions, offsettingPositions, underlyingPrice, marketData, originalCost = 0) {
  console.log('🔍 Calculating locked-in value for offsetting spread...');
  console.log('📊 Original positions:', originalPositions);
  console.log('📊 Offsetting positions:', offsettingPositions);
  console.log('💰 Original position cost:', originalCost);
  
  // Separate by option type to identify individual spreads
  const callPositions = [...originalPositions, ...offsettingPositions].filter(pos => pos.type === 'c');
  const putPositions = [...originalPositions, ...offsettingPositions].filter(pos => pos.type === 'p');
  
  console.log('📈 Call positions:', callPositions.map(pos => `${pos.type}${pos.strike}(qty:${pos.qty})`));
  console.log('📉 Put positions:', putPositions.map(pos => `${pos.type}${pos.strike}(qty:${pos.qty})`));
  
  // Calculate Bull Call Spread Max Profit (if present)
  let bullCallMaxProfit = 0;
  if (callPositions.length >= 2) {
    // Sort calls by strike (ascending)
    const sortedCalls = callPositions.sort((a, b) => a.strike - b.strike);
    const longCall = sortedCalls.find(pos => pos.qty > 0);  // Lower strike, positive qty
    const shortCall = sortedCalls.find(pos => pos.qty < 0); // Higher strike, negative qty
    
    if (longCall && shortCall) {
      const spreadWidth = shortCall.strike - longCall.strike;
      const callCost = Math.abs(longCall.qty) * (longCall.cost || 0) + Math.abs(shortCall.qty) * (shortCall.cost || 0);
      bullCallMaxProfit = spreadWidth * 100 - callCost;
      console.log(`🐂 Bull Call Spread: ${longCall.strike}/${shortCall.strike}, width: $${spreadWidth}, cost: $${callCost.toFixed(2)}, max profit: $${bullCallMaxProfit.toFixed(2)}`);
    }
  }
  
  // Calculate Bear Put Spread Max Profit (if present)
  let bearPutMaxProfit = 0;
  if (putPositions.length >= 2) {
    // Sort puts by strike (descending)
    const sortedPuts = putPositions.sort((a, b) => b.strike - a.strike);
    const longPut = sortedPuts.find(pos => pos.qty > 0);   // Higher strike, positive qty
    const shortPut = sortedPuts.find(pos => pos.qty < 0);  // Lower strike, negative qty
    
    if (longPut && shortPut) {
      const spreadWidth = longPut.strike - shortPut.strike;
      const putCost = Math.abs(longPut.qty) * (longPut.cost || 0) + Math.abs(shortPut.qty) * (shortPut.cost || 0);
      bearPutMaxProfit = spreadWidth * 100 - putCost;
      console.log(`🐻 Bear Put Spread: ${shortPut.strike}/${longPut.strike}, width: $${spreadWidth}, cost: $${putCost.toFixed(2)}, max profit: $${bearPutMaxProfit.toFixed(2)}`);
    }
  }
  
  // Calculate offsetting cost
  const offsettingCost = offsettingPositions.reduce((sum, pos) => sum + (pos.cost || 0), 0);
  
  // Calculate short call/short put overlap (if both exist)
  let shortLegOverlap = 0;
  const shortCall = callPositions.find(pos => pos.qty < 0);
  const shortPut = putPositions.find(pos => pos.qty < 0);
  
  if (shortCall && shortPut) {
    shortLegOverlap = Math.abs(shortCall.strike - shortPut.strike) * 100;
    console.log(`🔄 Short leg overlap: ${shortCall.strike} - ${shortPut.strike} = $${shortLegOverlap.toFixed(2)}`);
  }
  
  // Calculate potential profit: sum of max profits minus short leg overlap minus total cost
  const totalCost = originalCost + offsettingCost;
  const potentialProfit = bullCallMaxProfit + bearPutMaxProfit - shortLegOverlap - totalCost;
  
  // Locked profit is the MIN of the two spread max profits, minus costs
  const minMaxProfit = Math.min(bullCallMaxProfit, bearPutMaxProfit);
  const rawLockedInValue = minMaxProfit - originalCost - offsettingCost;
  const lockedProfit = Math.max(0, rawLockedInValue);
  
  // For display purposes, calculate the spread difference (sum of both spread widths)
  const totalSpreadWidth = (bullCallMaxProfit > 0 ? (callPositions.length >= 2 ? Math.max(...callPositions.map(p => p.strike)) - Math.min(...callPositions.map(p => p.strike)) : 0) : 0) +
                          (bearPutMaxProfit > 0 ? (putPositions.length >= 2 ? Math.max(...putPositions.map(p => p.strike)) - Math.min(...putPositions.map(p => p.strike)) : 0) : 0);
  const spreadDifferenceValue = totalSpreadWidth * 100;
  
  console.log(`🔒 Locked-in value calculation:`);
  console.log(`  Bull call max profit: $${bullCallMaxProfit.toFixed(2)}`);
  console.log(`  Bear put max profit: $${bearPutMaxProfit.toFixed(2)}`);
  console.log(`  Short leg overlap: $${shortLegOverlap.toFixed(2)}`);
  console.log(`  Original cost: $${originalCost}`);
  console.log(`  Offsetting cost: $${offsettingCost}`);
  console.log(`  Total cost: $${totalCost.toFixed(2)}`);
  console.log(`  Potential profit: $${bullCallMaxProfit.toFixed(2)} + $${bearPutMaxProfit.toFixed(2)} - $${shortLegOverlap.toFixed(2)} - $${totalCost.toFixed(2)} = $${potentialProfit.toFixed(2)}`);
  console.log(`  Min of max profits: $${minMaxProfit.toFixed(2)}`);
  console.log(`  Total spread width: $${totalSpreadWidth}`);
  console.log(`  Spread difference value: $${spreadDifferenceValue.toFixed(2)}`);
  console.log(`  Raw locked-in: $${minMaxProfit.toFixed(2)} - $${originalCost.toFixed(2)} - $${offsettingCost.toFixed(2)} = $${rawLockedInValue.toFixed(2)}`);
  console.log(`  Final locked profit: $${lockedProfit.toFixed(2)}`);
  
  return {
    spreadDifference: spreadDifferenceValue,
    lockedProfit: lockedProfit,
    potentialProfit: potentialProfit
  };
}

// Export functions for use in other files
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    calculateStrikeIncrement,
    calculateLockedInValue,
    calculateSingleLegLockedValue
  };
}
