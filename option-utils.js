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
 * Calculate true locked-in value by finding minimum combined position value
 * @param {Array} originalPositions - Original option positions
 * @param {Array} offsettingPositions - Offsetting option positions  
 * @param {number} underlyingPrice - Current underlying price
 * @param {Array} marketData - Available market data
 * @param {number} originalCost - Cost of original positions
 * @returns {number} Locked-in value
 */
function calculateLockedInValue(originalPositions, offsettingPositions, underlyingPrice, marketData, originalCost = 0) {
  console.log('🔍 Calculating true locked-in value...');
  console.log('📊 Original positions:', originalPositions);
  console.log('📊 Offsetting positions:', offsettingPositions);
  console.log('💰 Original position cost:', originalCost);
  
  // Combine all positions
  const allPositions = [...originalPositions, ...offsettingPositions];
  
  console.log('🔍 All positions being analyzed:', allPositions);
  
  // Find relevant price range to analyze
  const strikes = allPositions.map(p => p.strike).filter(s => s && typeof s === 'number');
  console.log('🔍 Valid strikes found:', strikes);
  
  const minStrike = Math.max(0, Math.min(...strikes, underlyingPrice) - 20);
  const maxStrike = Math.max(...strikes, underlyingPrice) + 20;
  
  console.log(`📈 Analyzing price range: $${minStrike} - $${maxStrike}`);
  
  // Calculate combined position value at different underlying prices
  let minValue = Infinity;
  let minPrice = underlyingPrice;
  
  // Test key price points: all strikes and current price
  const testPrices = [
    ...strikes,
    underlyingPrice,
    minStrike,
    maxStrike,
    // Add some intermediate points
    ...Array.from({length: 10}, (_, i) => minStrike + (maxStrike - minStrike) * i / 9)
  ].sort((a, b) => a - b);
  
  for (const price of testPrices) {
    let totalValue = 0;
    
    for (const position of allPositions) {
      if (position.type === 'c') {
        // Call option value
        const intrinsicValue = Math.max(0, price - position.strike) * 100;
        const positionValue = intrinsicValue * position.qty;
        totalValue += positionValue;
        console.log(`  📈 Call ${position.strike}: qty ${position.qty}, intrinsic $${intrinsicValue.toFixed(2)}, position value $${positionValue.toFixed(2)} at price $${price}`);
      } else if (position.type === 'p') {
        // Put option value  
        const intrinsicValue = Math.max(0, position.strike - price) * 100;
        const positionValue = intrinsicValue * position.qty;
        totalValue += positionValue;
        console.log(`  📉 Put ${position.strike}: qty ${position.qty}, intrinsic $${intrinsicValue.toFixed(2)}, position value $${positionValue.toFixed(2)} at price $${price}`);
      }
    }
    
    console.log(`💰 Total combined value at $${price}: $${totalValue.toFixed(2)}`);
    
    if (totalValue < minValue) {
      minValue = totalValue;
      minPrice = price;
    }
  }
  
  console.log(`🔒 Minimum combined value: $${minValue.toFixed(2)} at underlying price $${minPrice.toFixed(2)}`);
  
  // The locked-in value is the minimum combined position value minus total costs
  // Total costs = original position cost + offsetting position cost
  const offsettingCost = offsettingPositions.reduce((sum, pos) => sum + (pos.cost || 0), 0);
  const totalCost = originalCost + offsettingCost;
  const rawLockedInValue = minValue - totalCost;
  const lockedInValue = Math.max(0, rawLockedInValue);
  
  console.log(`💰 Locked-in value: $${lockedInValue.toFixed(2)} (min value $${minValue.toFixed(2)} - total cost $${totalCost.toFixed(2)} = original $${originalCost.toFixed(2)} + offset $${offsettingCost.toFixed(2)}, raw: $${rawLockedInValue.toFixed(2)})`);
  
  return lockedInValue;
}

// Export functions for use in other files
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    calculateStrikeIncrement,
    calculateLockedInValue
  };
}
