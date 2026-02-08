// Bear Put Spread Offsetting Logic
// Extracted from findOffsettingTrades function

/**
 * Process bear put spread offsetting logic
 * @param {Array} callPositions - Call positions (for context)
 * @param {Array} putPositions - Put positions in the spread
 * @param {Array} marketData - Available options data
 * @param {number} underlyingPrice - Current underlying price
 * @param {number} maxPotentialProfit - Maximum profit of the original spread
 * @param {number} totalCostPaid - Cost paid for the original spread
 * @param {number} originalSpreadWidth - Width of the original spread
 * @param {Array} offsettingTrades - Array to store offsetting trades
 * @param {Function} calculateLockedInValue - Function to calculate locked-in value
 */
function processBearPutSpreadOffsetting(
  callPositions, 
  putPositions, 
  marketData, 
  underlyingPrice, 
  maxPotentialProfit, 
  totalCostPaid, 
  originalSpreadWidth, 
  offsettingTrades, 
  calculateLockedInValue,
  strikeIncrement
) {
  console.log('🎯 Detected bear put spread position - using spread offsetting logic only');
  
  // Process bear put spread offsetting logic
  // Find the long put strike (higher strike)
  const longPut = putPositions.find(pp => pp.qty > 0);
  const shortPut = putPositions.find(pp => pp.qty < 0);
  const longPutStrike = longPut ? longPut.strike : Math.max(...putPositions.map(pp => pp.strike));
  const spreadQty = longPut ? longPut.qty : 1;
  
  console.log(`🔍 Looking for offsets for bear put spread: long ${spreadQty} ${longPutStrike}p / short ${shortPut ? shortPut.strike : 'N/A'}p`);
  
  // For bear put spreads, the offset budget should be based on the actual cost paid
  const offsetBudget = Math.max(0, maxPotentialProfit - Math.abs(totalCostPaid));
  
  if (offsetBudget <= 0) {
    console.log(`❌ No offset budget available for bear put spread (max profit: $${maxPotentialProfit.toFixed(2)}, cost: $${totalCostPaid.toFixed(2)})`);
    return;
  }
  
  console.log(`💰 Offset budget for bear put spread: $${offsetBudget.toFixed(2)}`);
  
  // Use the passed strikeIncrement parameter
  console.log(`🔧 Using passed strike increment: $${strikeIncrement}`);
  
  // For bear put spreads, we want bullish offsets: bull call spreads or long calls
  const highestPutStrike = Math.max(...putPositions.map(pp => pp.strike));
  console.log(`🔍 Highest put strike in position: $${highestPutStrike}`);
  
  // Find the long put strike (higher strike) for range calculation
  const higherPutStrike = longPut ? longPut.strike : highestPutStrike;
  
  // For single leg calls: look at calls with strikes LOWER than the highest put position
  const singleLegCallRange = 0; // Start from lowest available call
  const maxSingleLegCallStrike = higherPutStrike; // Upper limit is highest put strike
  
  console.log(`🔍 Looking for single leg calls up to $${maxSingleLegCallStrike} (lower than highest put $${higherPutStrike})`);
  
  // For call spreads: start 10 strikes HIGHER than the highest put position
  // but also include calls BELOW that point to build spreads
  const callStrikeRange = higherPutStrike + 100; // Start 100 points above higher put strike
  
  console.log(`🔍 Looking for call spreads starting $${callStrikeRange} (100 points above highest put $${higherPutStrike})`);
  
  // For bear put spreads, we need calls starting from the starting point AND below it
  // Get calls from the starting point and above for the short leg
  const availableCallsForShort = marketData.filter(option => {
    return option.type === 'c' && option.strike >= callStrikeRange && Number.isInteger(option.strike) && option.strike % strikeIncrement === 0;
  });
  
  // Get calls below the starting point for the long leg
  const availableCallsForLong = marketData.filter(option => {
    return option.type === 'c' && option.strike < callStrikeRange && option.strike >= 0 && Number.isInteger(option.strike) && option.strike % strikeIncrement === 0;
  });
  
  console.log(`🔍 Found ${availableCallsForShort.length} call strikes for short leg:`, availableCallsForShort.slice(0, 10).map(c => `${c.strike}@$${((c.bid + c.ask) / 2).toFixed(2)}`).join(', '));
  console.log(`🔍 Found ${availableCallsForLong.length} call strikes for long leg:`, availableCallsForLong.slice(-10).map(c => `${c.strike}@$${((c.bid + c.ask) / 2).toFixed(2)}`).join(', '));
  
  // Combine both sets for processing
  const allAvailableCalls = [...availableCallsForLong, ...availableCallsForShort];
  
  // Extract call strikes from all available calls
  const callStrikes = allAvailableCalls.map(c => c.strike);
  
  // Sort calls by strike (ascending) for proper spread construction
  const sortedCalls = allAvailableCalls.sort((a, b) => a.strike - b.strike);
  console.log(`🔍 Sorted calls:`, sortedCalls.map(c => `${c.strike}@$${((c.bid + c.ask) / 2).toFixed(2)}`));
  
  // Check multiple spread combinations
  const maxSpreadWidth = originalSpreadWidth * 2; // Limit to twice the original spread width
  
  let spreadCount = 0;
  
  console.log(`🔍 Starting bull call spread analysis for bear put spread hedge:`);
  console.log(`  callStrikes length: ${callStrikes.length}`);
  console.log(`  Original spread width: $${originalSpreadWidth}`);
  console.log(`  Max spread width: $${maxSpreadWidth} (2x original)`);
  console.log(`  No limit on number of spreads to check`);
  
  // For bear put spreads: find spreads where the HIGHER strike is the starting point
  // and the LOWER strike is below it
  for (let i = 0; i < callStrikes.length; i++) {
    const shortCallStrike = callStrikes[i]; // Higher strike (sell) - this is our starting point
    
    // Look for lower strikes to pair with this higher strike
    for (let j = i - 1; j >= 0; j--) {
      const longCallStrike = callStrikes[j]; // Lower strike (buy)
      const spreadWidth = shortCallStrike - longCallStrike;
      
      console.log(`🔍 Checking spread ${longCallStrike}/${shortCallStrike} (width: $${spreadWidth})`);
      
      // Only check spreads within minimum width range and in $10 increments
      if (spreadWidth >= strikeIncrement && spreadWidth % strikeIncrement === 0) {
        
        // For bear put spreads: offsetting bull call spread must have at least one leg at or below lowest put strike
        const lowestPutStrike = shortPut ? shortPut.strike : longPutStrike;
        if (shortCallStrike > lowestPutStrike && longCallStrike > lowestPutStrike) {
          console.log(`⏭️ Skipping spread ${longCallStrike}/${shortCallStrike} - both legs above lowest put strike $${lowestPutStrike}`);
          continue;
        }
        
        console.log(`✅ Processing spread ${longCallStrike}/${shortCallStrike} (width: $${spreadWidth}) - meets protection requirement (at or below lowest put $${lowestPutStrike})`);
        
        // Only process spreads up to the calculated maximum width
        if (spreadWidth > maxSpreadWidth) {
          console.log(`⏭️ Skipping spread ${longCallStrike}/${shortCallStrike} - width $${spreadWidth} exceeds max limit $${maxSpreadWidth}`);
          continue;
        }
        
        const longCall = marketData.find(option => option.type === 'c' && option.strike === longCallStrike);
        const shortCall = marketData.find(option => option.type === 'c' && option.strike === shortCallStrike);
        
        if (longCall && shortCall) {
          console.log(`📊 Found call options: long ${longCallStrike}@$${((longCall.bid + longCall.ask) / 2).toFixed(2)}, short ${shortCallStrike}@$${((shortCall.bid + shortCall.ask) / 2).toFixed(2)}`);
          const longCallPrice = (longCall.bid + longCall.ask) / 2;
          const shortCallPrice = (shortCall.bid + shortCall.ask) / 2;
          
          // Bull call spread: buy lower strike, sell higher strike
          // This costs money: (higher strike price - lower strike price) * quantity * 100
          const spreadCost = (longCallPrice - shortCallPrice) * Math.abs(spreadQty) * 100;
          const spreadMaxValue = (shortCallStrike - longCallStrike) * 100 * Math.abs(spreadQty);
          
          console.log(`💰 Spread ${longCallStrike}/${shortCallStrike}: cost $${spreadCost.toFixed(2)}, max value $${spreadMaxValue.toFixed(2)}`);
          
          // Filter out spreads where cost is more than 95% of max value
          if (spreadCost > spreadMaxValue * 0.95) {
            console.log(`❌ Spread rejected: cost $${spreadCost.toFixed(2)} is too high (${(spreadCost/spreadMaxValue*100).toFixed(1)}% of max value $${spreadMaxValue.toFixed(2)})`);
            continue;
          }
          
          // Filter out spreads where potential value is less than the position being offset
          // For bear put spreads, the position's potential value is the spread width
          const longPut = putPositions.find(pp => pp.strike === longPutStrike && pp.qty > 0);
          const shortPut = putPositions.find(pp => pp.strike < longPutStrike && pp.qty < 0);
          
          let positionPotentialValue = 0;
          if (longPut && shortPut) {
            positionPotentialValue = (longPut.strike - shortPut.strike) * 100 * Math.abs(longPut.qty);
          }
          
          if (spreadMaxValue < positionPotentialValue) {
            console.log(`❌ Call spread rejected: potential value $${spreadMaxValue.toFixed(2)} < position potential $${positionPotentialValue.toFixed(2)}`);
            continue;
          }
          
          // Maximum potential value of the new call spread (value at higher strike)
          const potentialValue = spreadMaxValue;
          
          // Calculate true locked-in value by analyzing combined position
          // todo: get rid of the default 160 in "shortPut ? shortPut.strike : 160"
          const originalPositions = [
            { type: 'p', strike: longPutStrike, qty: spreadQty },        // Long put at higher strike
            { type: 'p', strike: shortPut ? shortPut.strike : 160, qty: -spreadQty }  // Short put at lower strike
          ];
          
          const offsettingPositions = [
            { type: 'c', strike: longCallStrike, qty: Math.abs(spreadQty), cost: longCallPrice * Math.abs(spreadQty) * 100 },
            { type: 'c', strike: shortCallStrike, qty: -Math.abs(spreadQty), cost: -(shortCallPrice * Math.abs(spreadQty) * 100) }
          ];
          
          const lockedValueResult = calculateLockedInValue(originalPositions, offsettingPositions, underlyingPrice, marketData, totalCostPaid);
          const spreadDifference = lockedValueResult.spreadDifference;
          const lockedProfit = lockedValueResult.lockedProfit;
          const potentialProfit = lockedValueResult.potentialProfit;
          
          // Calculate additional profit potential for the spread based on realistic scenarios
          // For bull call spreads: maximum value is the spread width (difference between strikes)
          const upside = spreadMaxValue - lockedProfit - spreadCost; // Additional profit beyond locked profit
          
          // Total profit potential = locked profit + upside
          const totalProfitPotential = lockedProfit + upside;
          
          console.log(`🤔 Spread ${longCallStrike}/${shortCallStrike}: cost $${spreadCost.toFixed(2)}, spread difference $${spreadDifference.toFixed(2)}, potential profit $${potentialProfit.toFixed(2)}, locked profit $${lockedProfit.toFixed(2)}, upside $${upside.toFixed(2)} (max value: $${spreadMaxValue.toFixed(2)}), total potential $${totalProfitPotential.toFixed(2)}`);
          
          if (spreadCost <= offsetBudget && lockedProfit >= 0) {
            console.log(`✅ Risk-free spread offset found!`);
            console.log(`   Locked profit: $${lockedProfit.toFixed(2)}`);
            console.log(`   Cost vs budget: $${spreadCost.toFixed(2)} vs $${offsetBudget.toFixed(2)}`);
            offsettingTrades.push({
              type: 'spread',
              description: `Bull ${Math.abs(spreadQty)} ${longCallStrike}/${shortCallStrike} call spread`,
              action: `BUY ${Math.abs(spreadQty)} ${longCallStrike} CALL @ $${longCallPrice.toFixed(2)} & <br/>SELL ${Math.abs(spreadQty)} ${shortCallStrike} CALL @ $${shortCallPrice.toFixed(2)}`,
              cost: spreadCost,
              potentialValue: spreadMaxValue, // Keep original logic: max value of offsetting spread
              spreadDifference: spreadDifference, // Add new field for spread difference value
              potentialProfit: potentialProfit, // Add new field for correct potential profit
              lockedProfit: lockedProfit,
              additionalProfitPotential: upside,
              totalProfitPotential: totalProfitPotential,
              riskNeutralized: true,
              originalPosition: `Bear put spread ${spreadQty} ${shortPut ? shortPut.strike : 'N/A'}/${longPutStrike}p`,
              offsettingPosition: `Bull ${Math.abs(spreadQty)} ${longCallStrike}/${shortCallStrike} call spread`
            });
            spreadCount++;
          }
        }
      }
    }
  }
  
  console.log(`🔍 Bull call spread analysis completed:`);
  console.log(`  Spreads checked: ${spreadCount}`);
  console.log(`  Offsetting trades so far: ${offsettingTrades.length}`);
  
  // Also consider single leg long calls for simpler hedge
  // For single leg hedges, use calls with strikes LOWER than the highest put position
  console.log(`🔍 Looking for single leg calls up to $${maxSingleLegCallStrike} (lower than highest put $${higherPutStrike})`);
  
  const qualifyingCalls = marketData.filter(option => {
    return option.type === 'c' && option.strike >= singleLegCallRange && option.strike <= maxSingleLegCallStrike && Number.isInteger(option.strike) && option.strike % strikeIncrement === 0;
  });
  
  console.log(`🔍 Found ${qualifyingCalls.length} calls up to $${maxSingleLegCallStrike} for single leg hedge:`, qualifyingCalls.slice(0, 10).map(c => `${c.strike}@$${((c.bid + c.ask) / 2).toFixed(2)}`).join(', '));
  
  qualifyingCalls.forEach(option => {
    console.log(`🔍 Analyzing single leg call offset: ${option.strike}c`);
    
    const callPrice = (option.bid + option.ask) / 2;
    const offsetCost = callPrice * Math.abs(spreadQty) * 100; // Cost to buy calls
    
    console.log(`   Call price: $${callPrice.toFixed(2)}, offset cost: $${offsetCost.toFixed(2)}`);

    // For bear put spreads, calculate additional profit potential based on realistic scenarios
    // For calls: calculate value at the highest put strike (most bullish scenario for the original position)
    const callValueAtHighestPut = Math.max(0, highestPutStrike - option.strike) * 100 * Math.abs(spreadQty);
    
    console.log(`   Highest put strike: $${highestPutStrike}, call value at that strike: $${callValueAtHighestPut.toFixed(2)}`);

    // Filter out calls where potential value is less than the position being offset
    // For bear put spreads, the position's potential value is the spread width
    const longPut = putPositions.find(pp => pp.strike === longPutStrike && pp.qty > 0);
    const shortPut = putPositions.find(pp => pp.strike < longPutStrike && pp.qty < 0);

    // Potential value is the call's value at the highest put strike
    const potentialValue = callValueAtHighestPut;
    
    // Calculate true locked-in value by analyzing combined position
    const originalPositions = [
      { type: 'p', strike: longPutStrike, qty: spreadQty },        // Long put at higher strike
      { type: 'p', strike: shortPut ? shortPut.strike : 160, qty: -spreadQty }  // Short put at lower strike
    ];
    
    console.log(`   Original spread: long ${longPutStrike}p, short ${shortPut.strike}p`);
    
    
    let positionPotentialValue = 0;
    if (longPut && shortPut) {
      positionPotentialValue = (higherPutStrike - highestPutStrike) * 100 * Math.abs(spreadQty);
      console.log(`   Potential Value: $${potentialValue.toFixed(2)} VS Position potential value: $${positionPotentialValue.toFixed(2)} (spread width: $${higherPutStrike - highestPutStrike})`);
    }
    
    if (potentialValue < positionPotentialValue) {
      console.log(`   Skipping call ${option.strike}c: potential value $${potentialValue.toFixed(2)} < position potential value $${positionPotentialValue.toFixed(2)}`);
      return; // Skip this call
    }
    
    const offsettingPositions = [
      { type: 'c', strike: option.strike, qty: Math.abs(spreadQty), cost: callPrice * Math.abs(spreadQty) * 100 }
    ];
    
    const lockedValueResult = calculateSingleLegLockedValue(originalPositions, offsettingPositions, underlyingPrice, marketData, totalCostPaid);
    const spreadDifference = lockedValueResult.spreadDifference;
    const lockedProfit = lockedValueResult.lockedProfit;
    const potentialProfit = lockedValueResult.potentialProfit;
    
    const upside = callValueAtHighestPut - lockedProfit - offsetCost; // Additional profit beyond locked profit
    
    // Total profit potential = locked profit + upside
    const totalProfitPotential = lockedProfit + upside;
    
    console.log(`🤔 Call ${option.strike}: cost $${offsetCost.toFixed(2)}, spread difference $${spreadDifference.toFixed(2)}, potential profit $${potentialProfit.toFixed(2)}, locked profit $${lockedProfit.toFixed(2)}, upside $${upside.toFixed(2)} (value at $${highestPutStrike}), total potential $${totalProfitPotential.toFixed(2)}`);
    
    if (offsetCost <= offsetBudget && lockedProfit >= 0) {
      console.log(`✅ Risk-free call offset found!`);
      console.log(`   Locked profit: $${lockedProfit.toFixed(2)}`);
      console.log(`   Cost vs budget: $${offsetCost.toFixed(2)} vs $${offsetBudget.toFixed(2)}`);
      offsettingTrades.push({
        type: 'single_leg',
        description: `Long ${Math.abs(spreadQty)} ${option.strike} calls`,
        action: `BUY ${Math.abs(spreadQty)} ${option.strike} CALL @ $${callPrice.toFixed(2)}`,
        cost: offsetCost,
        potentialValue: potentialValue, // Keep original logic
        spreadDifference: spreadDifference, // Add new field for spread difference value
        potentialProfit: potentialProfit, // Add new field for correct potential profit
        lockedProfit: lockedProfit,
        additionalProfitPotential: upside,
        totalProfitPotential: totalProfitPotential,
        riskNeutralized: true,
        originalPosition: `Bear put spread ${spreadQty} ${higherPutStrike}/${highestPutStrike}p`,
        offsettingPosition: `Long ${Math.abs(spreadQty)} ${option.strike} calls`
      });
    }
  });
  
  console.log(`🔍 Bear put spread offsetting analysis completed`);
}

// Export for use in main file
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    processBearPutSpreadOffsetting
  };
}
