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
 * Calculate locked-in value for offsetting spreads
 * Formula: MIN(Bull Call Max Profit, Bear Put Max Profit) - Initial Cost - Offsetting Cost
 * @param {Array} originalPositions - Original option positions
 * @param {Array} offsettingPositions - Offsetting option positions  
 * @param {number} underlyingPrice - Current underlying price
 * @param {Array} marketData - Available market data
 * @param {number} originalCost - Cost of original positions
 * @returns {Object} Object with spreadDifference and lockedProfit values
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
    calculateLockedInValue
  };
}
