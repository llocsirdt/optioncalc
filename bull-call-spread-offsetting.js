// Bull Call Spread Offsetting Logic
// Extracted from findOffsettingTrades function

/**
 * Process bull call spread offsetting logic
 * @param {Array} callPositions - Call positions in the spread
 * @param {Array} putPositions - Put positions (for context)
 * @param {Array} marketData - Available options data
 * @param {number} underlyingPrice - Current underlying price
 * @param {number} maxPotentialProfit - Maximum profit of the original spread
 * @param {number} totalCostPaid - Cost paid for the original spread
 * @param {number} originalSpreadWidth - Width of the original spread
 * @param {Array} offsettingTrades - Array to store offsetting trades
 * @param {Function} calculateLockedInValue - Function to calculate locked-in value
 */
function processBullCallSpreadOffsetting(
  callPositions, 
  putPositions, 
  marketData, 
  underlyingPrice, 
  maxPotentialProfit, 
  totalCostPaid, 
  originalSpreadWidth, 
  offsettingTrades, 
  calculateLockedInValue
) {
  console.log('🎯 Detected bull call spread position - using spread offsetting logic only');
  
  // Process bull call spread offsetting logic
  // Find the long call strike (lower strike)
  const longCall = callPositions.find(cp => cp.qty > 0);
  const shortCall = callPositions.find(cp => cp.qty < 0);
  const longCallStrike = longCall ? longCall.strike : Math.min(...callPositions.map(cp => cp.strike));
  const spreadQty = longCall ? longCall.qty : 1;
  
  console.log(`🔍 Looking for offsets for bull call spread: long ${spreadQty} ${longCallStrike}c / short ${shortCall ? shortCall.strike : 'N/A'}c`);
  
  // For bull call spreads, the offset budget should be based on the actual cost paid, not calculated spread profit
  const offsetBudget = Math.max(0, maxPotentialProfit - Math.abs(totalCostPaid));
  
  if (offsetBudget <= 0) {
    console.log(`❌ No offset budget available for bull call spread (max profit: $${maxPotentialProfit.toFixed(2)}, cost: $${totalCostPaid.toFixed(2)})`);
    return;
  }
  
  console.log(`💰 Offset budget for bull call spread: $${offsetBudget.toFixed(2)}`);
  
  // Calculate dynamic strike increment based on underlying price
  const strikeIncrement = calculateStrikeIncrement(underlyingPrice);
  console.log(`🔧 Using strike increment: $${strikeIncrement} (based on underlying price $${underlyingPrice})`);
  
  // For bull call spreads, we want bearish offsets: bear put spreads or long puts
  const lowestCallStrike = Math.min(...callPositions.map(cp => cp.strike));
  console.log(`🔍 Lowest call strike in position: $${lowestCallStrike}`);
  
  // Find the long call strike (lower strike) for range calculation
  const lowerCallStrike = longCall ? longCall.strike : lowestCallStrike;
  const putStrikeRange = lowerCallStrike - 100; // Start 10 strikes below lower call strike (10 strikes × $10 = $100)
  
  console.log(`🔍 Looking for puts starting $${putStrikeRange} (100 points below lower call $${lowerCallStrike})`);
  
  // Put spread offset: bear put spread (buy higher strike, sell lower strike)
  const availablePuts = marketData.filter(option => {
    return option.type === 'p' && option.strike >= putStrikeRange && Number.isInteger(option.strike) && option.strike % strikeIncrement === 0;
  });
  
  console.log(`🔍 Found ${availablePuts.length} put strikes for bear put spreads:`, availablePuts.slice(0, 10).map(p => `${p.strike}@$${((p.bid + p.ask) / 2).toFixed(2)}`).join(', '));
  
  // Extract put strikes from availablePuts
  const putStrikes = availablePuts.map(p => p.strike);
  
  // Sort puts by strike (ascending) for proper spread construction
  const sortedPuts = availablePuts.sort((a, b) => a.strike - b.strike);
  console.log(`🔍 Sorted puts:`, sortedPuts.map(p => `${p.strike}@$${((p.bid + p.ask) / 2).toFixed(2)}`));
  
  // Check multiple spread combinations
  const minSpreadWidth = strikeIncrement;  // Minimum spread width equals strike increment
  const spreadIncrement = strikeIncrement; // Dynamic increment based on price
  const maxSpreadWidth = originalSpreadWidth * 2; // Limit to twice the original spread width
  
  let spreadCount = 0;
  
  console.log(`🔍 Starting bear put spread analysis:`);
  console.log(`  putStrikes length: ${putStrikes.length}`);
  console.log(`  Original spread width: $${originalSpreadWidth}`);
  console.log(`  Max spread width: $${maxSpreadWidth} (2x original)`);
  console.log(`  No limit on number of spreads to check`);
  
  for (let i = 0; i < putStrikes.length; i++) {
    const shortPutStrike = putStrikes[i]; // Lower strike (sell)
    
    for (let j = i + 1; j < putStrikes.length; j++) {
      const longPutStrike = putStrikes[j]; // Higher strike (buy)
      const spreadWidth = longPutStrike - shortPutStrike;
      
      console.log(`🔍 Checking spread ${shortPutStrike}/${longPutStrike} (width: $${spreadWidth})`);
      
      // Only check spreads within minimum width range and in $10 increments
      if (spreadWidth >= minSpreadWidth && spreadWidth % spreadIncrement === 0) {
        
        // For bull call spreads: offsetting bear put spread must have at least one leg at or above highest call strike
        const highestCallStrike = shortCall ? shortCall.strike : longCallStrike;
        if (longPutStrike < highestCallStrike && shortPutStrike < highestCallStrike) {
          console.log(`⏭️ Skipping spread ${shortPutStrike}/${longPutStrike} - both legs below highest call strike $${highestCallStrike}`);
          continue;
        }
        
        console.log(`✅ Processing spread ${shortPutStrike}/${longPutStrike} (width: $${spreadWidth}) - meets protection requirement`);
          
        // Only process spreads up to the calculated maximum width
        if (spreadWidth > maxSpreadWidth) {
          console.log(`⏭️ Skipping spread ${shortPutStrike}/${longPutStrike} - width $${spreadWidth} exceeds max limit $${maxSpreadWidth}`);
          continue;
        }
        
        const shortPut = marketData.find(option => option.type === 'p' && option.strike === shortPutStrike);
        const longPut = marketData.find(option => option.type === 'p' && option.strike === longPutStrike);
        
        if (shortPut && longPut) {
          console.log(`📊 Found put options: short ${shortPutStrike}@$${((shortPut.bid + shortPut.ask) / 2).toFixed(2)}, long ${longPutStrike}@$${((longPut.bid + longPut.ask) / 2).toFixed(2)}`);
          const shortPutPrice = (shortPut.bid + shortPut.ask) / 2;
          const longPutPrice = (longPut.bid + longPut.ask) / 2;
          
          // Bear put spread: buy higher strike, sell lower strike
          // This costs money: (higher strike price - lower strike price) * quantity * 100
          const spreadCost = (longPutPrice - shortPutPrice) * Math.abs(spreadQty) * 100;
          const spreadMaxValue = (longPutStrike - shortPutStrike) * 100 * Math.abs(spreadQty);
          
          console.log(`💰 Spread ${shortPutStrike}/${longPutStrike}: cost $${spreadCost.toFixed(2)}, max value $${spreadMaxValue.toFixed(2)}`);
          
          // Filter out spreads where cost is more than 95% of max value
          if (spreadCost > spreadMaxValue * 0.95) {
            console.log(`❌ Spread rejected: cost $${spreadCost.toFixed(2)} is too high (${(spreadCost/spreadMaxValue*100).toFixed(1)}% of max value $${spreadMaxValue.toFixed(2)})`);
            continue;
          }
          
          // Filter out spreads where potential value is less than the position being offset
          // For bull call spreads, the position's potential value is the spread width
          const longCall = callPositions.find(cp => cp.strike === longCallStrike && cp.qty > 0);
          const shortCall = callPositions.find(cp => cp.strike > longCallStrike && cp.qty < 0);
          
          let positionPotentialValue = 0;
          if (longCall && shortCall) {
            positionPotentialValue = (shortCall.strike - longCall.strike) * 100 * Math.abs(spreadQty);
          }
          
          if (spreadMaxValue < positionPotentialValue) {
            continue;
          }
          
          // Maximum potential value of the new put spread (value at lower strike)
          const potentialValue = spreadMaxValue;
          
          // Calculate true locked-in value by analyzing combined position
          const originalPositions = [
            { type: 'c', strike: longCallStrike, qty: spreadQty },
            { type: 'c', strike: shortCall ? shortCall.strike : 260, qty: -spreadQty }
          ];
          
          const offsettingPositions = [
            { type: 'p', strike: shortPutStrike, qty: Math.abs(spreadQty), cost: spreadCost },
            { type: 'p', strike: longPutStrike, qty: -Math.abs(spreadQty) }
          ];
          
          const lockedProfit = calculateLockedInValue(originalPositions, offsettingPositions, underlyingPrice, marketData, totalCostPaid);
          
          // Calculate additional profit potential for the spread based on realistic scenarios
          // For bear put spreads: maximum value is the spread width (difference between strikes)
          const upside = spreadMaxValue - lockedProfit - spreadCost; // Additional profit beyond locked profit
          
          // Total profit potential = locked profit + upside
          const totalProfitPotential = lockedProfit + upside;
          
          console.log(`🤔 Spread ${shortPutStrike}/${longPutStrike}: cost $${spreadCost.toFixed(2)}, locked profit $${lockedProfit.toFixed(2)}, upside $${upside.toFixed(2)} (max value: $${spreadMaxValue.toFixed(2)}), total potential $${totalProfitPotential.toFixed(2)}`);
          
          if (spreadCost <= offsetBudget && lockedProfit >= 0) {
            console.log(`✅ Risk-free spread offset found!`);
            console.log(`   Locked profit: $${lockedProfit.toFixed(2)}`);
            console.log(`   Cost vs budget: $${spreadCost.toFixed(2)} vs $${offsetBudget.toFixed(2)}`);
            offsettingTrades.push({
              type: 'spread',
              description: `Bear ${Math.abs(spreadQty)} ${shortPutStrike}/${longPutStrike} put spread`,
              action: `BUY ${Math.abs(spreadQty)} ${longPutStrike} PUT @ $${longPutPrice.toFixed(2)} & <br/>SELL ${Math.abs(spreadQty)} ${shortPutStrike} PUT @ $${shortPutPrice.toFixed(2)}`,
              cost: spreadCost,
              lockedProfit: lockedProfit,
              potentialValue: potentialValue,
              additionalProfitPotential: upside,
              totalProfitPotential: totalProfitPotential,
              riskNeutralized: true,
              originalPosition: `Bull call spread ${spreadQty} ${longCallStrike}/${shortCall ? shortCall.strike : 'N/A'}c`,
              offsettingPosition: `Bear ${Math.abs(spreadQty)} ${shortPutStrike}/${longPutStrike} put spread`
            });
            spreadCount++;
          }
        }
      }
    }
  }
  
  console.log(`🔍 Bear put spread analysis completed:`);
  console.log(`  Spreads checked: ${spreadCount}`);
  console.log(`  Offsetting trades so far: ${offsettingTrades.length}`);
  
  // Also consider single leg long puts for simpler hedge
  // For single leg hedges, use the long call strike (not expanded range)
  const singleLegPutRange = lowerCallStrike; // Start at long call strike
  
  console.log(`🔍 Looking for puts starting $${singleLegPutRange} (at long call strike $${lowerCallStrike})`);
  
  const qualifyingPuts = marketData.filter(option => {
    return option.type === 'p' && option.strike >= singleLegPutRange && Number.isInteger(option.strike) && option.strike % strikeIncrement === 0;
  });
  
  console.log(`🔍 Found ${qualifyingPuts.length} puts at or above ${singleLegPutRange} for single leg hedge:`, 
    qualifyingPuts.map(p => `${p.strike}@$${((p.bid + p.ask) / 2).toFixed(2)}`));
  
  qualifyingPuts.forEach(option => {
    const putPrice = (option.bid + option.ask) / 2;
    const offsetCost = putPrice * Math.abs(spreadQty) * 100; // Cost to buy puts
    
    // For bull call spreads, calculate additional profit potential based on realistic scenarios
    // For puts: calculate value at the lowest call strike (most bearish scenario for the original position)
    const lowestCallStrike = Math.min(...callPositions.map(cp => cp.strike));
    const putValueAtLowestCall = Math.max(0, option.strike - lowestCallStrike) * 100 * Math.abs(spreadQty);
    
    // Maximum potential value of the new put trade
    const potentialValue = putValueAtLowestCall;
    
    // Filter out puts where potential value is less than the position being offset
    // For bull call spreads, the position's potential value is the spread width
    const longCall = callPositions.find(cp => cp.strike === longCallStrike && cp.qty > 0);
    const shortCall = callPositions.find(cp => cp.strike > longCallStrike && cp.qty < 0);
    
    let positionPotentialValue = 0;
    if (longCall && shortCall) {
      positionPotentialValue = (shortCall.strike - longCall.strike) * 100 * Math.abs(spreadQty);
    }
    
    if (potentialValue < positionPotentialValue) {
      return; // Skip this put
    }
    
    // Calculate true locked-in value by analyzing combined position
    const originalPositions = [
      { type: 'c', strike: longCallStrike, qty: spreadQty },
      { type: 'c', strike: shortCall ? shortCall.strike : 0, qty: -spreadQty }
    ];
    
    const offsettingPositions = [
      { type: 'p', strike: option.strike, qty: Math.abs(spreadQty) }
    ];
    
    const lockedProfit = calculateLockedInValue(originalPositions, offsettingPositions, underlyingPrice, marketData, totalCostPaid);
    
    // Upside is the potential value minus locked profit minus cost
    const upside = potentialValue - lockedProfit - offsetCost;
    
    // Total profit potential = locked profit + upside
    const totalProfitPotential = lockedProfit + upside;
    
    console.log(`🤔 Put ${option.strike}: cost $${offsetCost.toFixed(2)}, locked profit $${lockedProfit.toFixed(2)}, upside $${upside.toFixed(2)} (value at $${lowestCallStrike}), total potential $${totalProfitPotential.toFixed(2)}`);
    
    if (offsetCost <= offsetBudget && lockedProfit >= 0) {
      console.log(`✅ Risk-free put offset found!`);
      console.log(`   Locked profit: $${lockedProfit.toFixed(2)}`);
      console.log(`   Cost vs budget: $${offsetCost.toFixed(2)} vs $${offsetBudget.toFixed(2)}`);
      offsettingTrades.push({
        type: 'single_leg',
        description: `Long ${Math.abs(spreadQty)} ${option.strike} puts`,
        action: `BUY ${Math.abs(spreadQty)} ${option.strike} PUT @ $${putPrice.toFixed(2)}`,
        cost: offsetCost,
        lockedProfit: lockedProfit,
        potentialValue: potentialValue,
        additionalProfitPotential: upside,
        totalProfitPotential: totalProfitPotential,
        riskNeutralized: true,
        originalPosition: `Bull call spread ${spreadQty} ${longCallStrike}/${shortCall ? shortCall.strike : 'N/A'}c`,
        offsettingPosition: `Long ${Math.abs(spreadQty)} ${option.strike} puts`
      });
    }
  });
  
  console.log(`🔍 Bull call spread offsetting analysis completed`);
}

// Export for use in main file
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    processBullCallSpreadOffsetting
  };
}
