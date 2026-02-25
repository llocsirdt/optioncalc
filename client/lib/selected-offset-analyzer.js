/**
 * Selected Offset Analyzer
 * Analyzes selected options from the chain table and calculates profit metrics
 * using the same functions from offset-calculations.js
 */

// Function to analyze selected offsetting positions
function analyzeSelectedOffsetPosition(selectedPositions, initialPosition) {
  console.log('🧪 analyzeSelectedOffsetPosition called');
  console.log('🧪 selectedPositions:', selectedPositions);
  console.log('🧪 selectedPositions.size:', selectedPositions?.size);
  console.log('🧪 initialPosition:', initialPosition);
  
  if (!selectedPositions || selectedPositions.size === 0) {
    console.log('🧪 No positions selected, hiding analysis');
    hideSelectedOffsetAnalysis();
    return;
  }
  
  // Convert selected positions to array
  const positionsArray = Array.from(selectedPositions.values());
  console.log('🧪 positionsArray:', positionsArray);
  
  // Need at least 2 legs for a spread
  if (positionsArray.length < 2) {
    console.log('🧪 Less than 2 positions, hiding analysis');
    hideSelectedOffsetAnalysis();
    return;
  }
  
  // Determine if this is a valid offsetting spread
  const spreadInfo = identifySpreadType(positionsArray);
  console.log('🧪 spreadInfo:', spreadInfo);
  
  if (!spreadInfo) {
    console.log('🧪 No valid spread identified, hiding analysis');
    hideSelectedOffsetAnalysis();
    return;
  }
  
  console.log('🎯 Identified spread:', spreadInfo);
  
  // Calculate profit metrics using offset-calculations.js functions
  const metrics = calculateSpreadMetrics(spreadInfo, initialPosition);
  console.log('🧪 metrics:', metrics);
  
  if (metrics) {
    console.log('✅ Displaying selected offset analysis');
    displaySelectedOffsetAnalysis(spreadInfo, metrics);
  } else {
    console.log('🧪 No metrics calculated, hiding analysis');
    hideSelectedOffsetAnalysis();
  }
}

// Function to identify the type of spread from selected positions
function identifySpreadType(positions) {
  if (positions.length !== 2) return null;
  
  // Sort by strike
  const sorted = positions.sort((a, b) => a.strike - b.strike);
  const lower = sorted[0];
  const upper = sorted[1];
  
  // Check if both are same type (calls or puts)
  if (lower.type !== upper.type) return null;
  
  const optionType = lower.type; // 'c' or 'p'
  
  // Determine spread type based on sides
  const lowerIsLong = lower.side === 'long';
  const upperIsLong = upper.side === 'long';
  
  let spreadType = null;
  let shortStrike = null;
  let longStrike = null;
  let shortPrice = null;
  let longPrice = null;
  
  if (optionType === 'c') {
    // Call spreads
    if (lowerIsLong && !upperIsLong) {
      // Bull call spread: Long lower call, Short higher call
      spreadType = 'bull_call_spread';
      longStrike = lower.strike;
      shortStrike = upper.strike;
      longPrice = lower.price;
      shortPrice = upper.price;
    } else if (!lowerIsLong && upperIsLong) {
      // Bear call spread: Short lower call, Long higher call
      spreadType = 'bear_call_spread';
      shortStrike = lower.strike;
      longStrike = upper.strike;
      shortPrice = lower.price;
      longPrice = upper.price;
    }
  } else if (optionType === 'p') {
    // Put spreads
    if (!lowerIsLong && upperIsLong) {
      // Bear put spread: Short lower put, Long higher put
      spreadType = 'bear_put_spread';
      shortStrike = lower.strike;
      longStrike = upper.strike;
      shortPrice = lower.price;
      longPrice = upper.price;
    } else if (lowerIsLong && !upperIsLong) {
      // Bull put spread: Long lower put, Short higher put
      spreadType = 'bull_put_spread';
      longStrike = lower.strike;
      shortStrike = upper.strike;
      longPrice = lower.price;
      shortPrice = upper.price;
    }
  }
  
  if (!spreadType) return null;
  
  const spreadCredit = (shortPrice - longPrice) * 100;
  const spreadWidth = Math.abs(shortStrike - longStrike);
  const maxLoss = spreadWidth * 100;
  
  console.log('🧪 Spread calculation:', {
    spreadType,
    shortStrike,
    longStrike,
    shortPrice,
    longPrice,
    spreadCredit,
    lower,
    upper
  });
  
  return {
    type: spreadType,
    optionType: optionType,
    shortStrike: shortStrike,
    longStrike: longStrike,
    shortPrice: shortPrice,
    longPrice: longPrice,
    spreadCredit: spreadCredit,
    spreadWidth: spreadWidth,
    maxLoss: spreadType.includes('credit') || spreadType.includes('bull_put') || spreadType.includes('bear_call') ? -maxLoss : maxLoss
  };
}

// Function to calculate spread metrics using offset-calculations.js functions
function calculateSpreadMetrics(spreadInfo, initialPosition) {
  // If no initial position, create a dummy one to allow calculation
  if (!initialPosition || !initialPosition.strategy) {
    console.log('ℹ️ No initial position provided, using default values for calculation');
    initialPosition = {
      strategy: 'unknown',
      cost: 0,
      maxValue: 0,
      spreadWidth: 0,
      legs: []
    };
  }
  
  // Create a position object that matches the format expected by offset-calculations.js
  const position = {
    strategy: initialPosition.strategy,
    cost: initialPosition.cost || 0,
    maxValue: initialPosition.maxValue || 0,
    spreadWidth: initialPosition.spreadWidth || 0,
    legs: initialPosition.legs || []
  };
  
  let profitMetrics = null;
  
  // Call the appropriate calculate...ProfitMetrics function based on spread type
  // Use functions from OffsetCalculations namespace
  if (spreadInfo.type === 'bull_put_spread') {
    // Use calculateBullPutProfitMetrics from offset-calculations.js
    const bullPutMaxLoss = -(spreadInfo.spreadWidth * 100);
    
    // Create offsetting position object
    const offsettingPosition = {
      cost: -spreadInfo.spreadCredit,  // Bull put spread receives credit, so cost is negative
      maxValue: bullPutMaxLoss,
      strategy: 'bull_put_spread',
      legs: [
        { strike: spreadInfo.longStrike, qty: 1 },   // long leg (bought)
        { strike: spreadInfo.shortStrike, qty: -1 }  // short leg (sold)
      ]
    };
    
    profitMetrics = window.OffsetCalculations.calculateBullPutProfitMetrics(
      position,
      offsettingPosition
    );
    
  } else if (spreadInfo.type === 'bear_put_spread') {
    // Use calculateBearPutProfitMetrics from offset-calculations.js
    const bearPutMaxValue = spreadInfo.spreadWidth * 100;
    
    // Create offsetting position object
    const offsettingPosition = {
      cost: -spreadInfo.spreadCredit,  // Bear put spread is debit spread
      maxValue: bearPutMaxValue,
      strategy: 'bear_put_spread',
      legs: [
        { strike: spreadInfo.longStrike, qty: 1 },   // long leg (bought)
        { strike: spreadInfo.shortStrike, qty: -1 }  // short leg (sold)
      ]
    };
    
    profitMetrics = window.OffsetCalculations.calculateBearPutProfitMetrics(
      position,
      offsettingPosition
    );
    
  } else if (spreadInfo.type === 'bull_call_spread') {
    // Use calculateBullCallProfitMetrics from offset-calculations.js
    const bullCallMaxValue = spreadInfo.spreadWidth * 100;
    
    // Create offsetting position object
    const offsettingPosition = {
      cost: -spreadInfo.spreadCredit,  // Bull call spread is debit spread
      maxValue: bullCallMaxValue,
      strategy: 'bull_call_spread',
      legs: [
        { strike: spreadInfo.longStrike, qty: 1 },   // long leg (bought)
        { strike: spreadInfo.shortStrike, qty: -1 }  // short leg (sold)
      ]
    };
    
    profitMetrics = window.OffsetCalculations.calculateBullCallProfitMetrics(
      position,
      offsettingPosition
    );
    
  } else if (spreadInfo.type === 'bear_call_spread') {
    // Use calculateBearCallProfitMetrics from offset-calculations.js
    const bearCallMaxLoss = -(spreadInfo.spreadWidth * 100);
    
    // Create offsetting position object
    const offsettingPosition = {
      cost: -spreadInfo.spreadCredit,  // Bear call spread receives credit, so cost is negative
      maxValue: bearCallMaxLoss,
      strategy: 'bear_call_spread',
      legs: [
        { strike: spreadInfo.longStrike, qty: 1 },   // long leg (bought)
        { strike: spreadInfo.shortStrike, qty: -1 }  // short leg (sold)
      ]
    };
    
    profitMetrics = window.OffsetCalculations.calculateBearCallProfitMetrics(
      position,
      offsettingPosition
    );
  }
  
  return profitMetrics;
}

// Function to display the selected offset analysis
function displaySelectedOffsetAnalysis(spreadInfo, metrics) {
  const container = document.getElementById('selected-offset-analysis');
  const content = document.getElementById('selected-offset-content');
  
  if (!container || !content) return;
  
  // Format spread description
  const spreadName = spreadInfo.type.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  const optionTypeName = spreadInfo.optionType === 'c' ? 'CALL' : 'PUT';
  
  const description = `${spreadName}: Short ${spreadInfo.shortStrike}${spreadInfo.optionType.toUpperCase()} @ ${spreadInfo.shortPrice.toFixed(2)}, Long ${spreadInfo.longStrike}${spreadInfo.optionType.toUpperCase()} @ ${spreadInfo.longPrice.toFixed(2)}`;
  
  const action = spreadInfo.spreadCredit >= 0 ? 
    `SELL 1 ${spreadInfo.shortStrike} ${optionTypeName} @ $${spreadInfo.shortPrice.toFixed(2)} &\nBUY 1 ${spreadInfo.longStrike} ${optionTypeName} @ $${spreadInfo.longPrice.toFixed(2)}` :
    `BUY 1 ${spreadInfo.longStrike} ${optionTypeName} @ $${spreadInfo.longPrice.toFixed(2)} &\nSELL 1 ${spreadInfo.shortStrike} ${optionTypeName} @ $${spreadInfo.shortPrice.toFixed(2)}`;
  
  const profitClass = metrics.profitPotential > 0 ? 'profit-positive' : 'profit-neutral';
  const cost = spreadInfo.spreadCredit >= 0 ? -spreadInfo.spreadCredit : -spreadInfo.spreadCredit;
  
  const html = `
    <div class="offset-trade ${spreadInfo.type} selected-offset">
      <div class="trade-description">
        <strong>${description}</strong>
        <div class="trade-action">${action}</div>
        <div class="trade-cost">Cost: $${cost.toFixed(2)}</div>
      </div>
      <div class="trade-metrics">
        <div class="trade-potential">Potential: $${metrics.profitPotential.toFixed(2)}</div>
        <div class="trade-locked-profit">Locked: $${metrics.lockedInProfit.toFixed(2)}</div>
        <div class="trade-score ${profitClass}">Score: ${(metrics.profitPotentialScore * 100).toFixed(1)}%</div>
      </div>
    </div>
  `;
  
  content.innerHTML = html;
  container.style.display = 'block';
  
  console.log('✅ Displayed selected offset analysis');
}

// Function to hide the selected offset analysis
function hideSelectedOffsetAnalysis() {
  const container = document.getElementById('selected-offset-analysis');
  if (container) {
    container.style.display = 'none';
  }
}

// Export functions for use in oc.js
if (typeof window !== 'undefined') {
  window.analyzeSelectedOffsetPosition = analyzeSelectedOffsetPosition;
  window.hideSelectedOffsetAnalysis = hideSelectedOffsetAnalysis;
}
