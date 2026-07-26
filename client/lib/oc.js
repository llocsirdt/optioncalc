// Global variables to store the full option data
let fullOptionArray = []; // Stores the original, uncombined options in the order they were entered
let syntheticPositionArray = []; // Stores synthetic position for offsetting analysis (if provided)
let combinedOptionMap = new Map(); // Stores the combined options for chart rendering
let fullCost = 0;
let fullMinStrike = 0;
let fullMaxStrike = 0;
let fullStrikeIncrement = 0;

// Global variables for selected positions
let selectedTablePositions = new Map(); // key: "c100.5" or "p100.5", value: {strike, type, bid, ask, side}
let selectedPositionsCost = 0;
let currentOptionsData = []; // Store current options data for real-time updates

// Track textInput focus state to prevent updates while user is typing
let textInputHasFocus = false;

// Function to parse offsetting trade and click corresponding table cells
function clickOffsettingTrade(tradeDescription, tradeAction) {
  console.log('🎯 Clicking offsetting trade:', tradeDescription);
  console.log('📋 Trade action:', tradeAction);
  
  const clickedPositions = [];
  
  // First, try to parse the action string (server-side format)
  // Example: "Buy 1 Call 6850, Sell 1 Call 6950"
  // Example: "Buy 1 Put 6950, Sell 1 Put 6850"
  if (tradeAction && tradeAction.includes(',')) {
    console.log('🔍 Parsing action string (server-side format)');
    const actions = tradeAction.split(',').map(a => a.trim());
    
    for (const action of actions) {
      // Match: "Buy/Sell <qty> Call/Put <strike>"
      const actionMatch = action.match(/(Buy|Sell)\s+(\d+)\s+(Call|Put)\s+([\d.]+)/i);
      if (actionMatch) {
        const [, buySell, qty, optionType, strike] = actionMatch;
        const isBuy = buySell.toLowerCase() === 'buy';
        const type = optionType.toLowerCase() === 'call' ? 'c' : 'p';
        const bidAsk = isBuy ? 'ask' : 'bid';
        
        console.log(`  ${buySell} ${qty} ${optionType} ${strike} -> clicking ${type}${strike} ${bidAsk}`);
        
        const result = findAndClickOptionCell(type, parseFloat(strike), bidAsk);
        if (result) clickedPositions.push(result);
      }
    }
    
    if (clickedPositions.length > 0) {
      updateSelectedPositionsDisplay(currentOptionsData);
      console.log(`✅ Clicked ${clickedPositions.length} positions:`, clickedPositions);
      return true;
    }
  }
  
  // Try parsing new shared function format first
  // Examples:
  // "Bear Call Spread: Short 24800C @ 163.95, Long 24960C @ 70.60"
  // "Bear Put Spread: Long 24900P @ 123.45, Short 24800P @ 67.89"
  const newFormatMatch = tradeDescription.match(/(Bear|Bull)\s+(Call|Put)\s+Spread:\s+(.+)/i);
  if (newFormatMatch) {
    console.log('🔍 Parsing new shared function format');
    const [, direction, optionType, legsStr] = newFormatMatch;
    const type = optionType.toLowerCase() === 'call' ? 'c' : 'p';
    
    // Parse each leg: "Short 24800C @ 163.95" or "Long 24960C @ 70.60"
    const legMatches = legsStr.matchAll(/(Short|Long)\s+([\d.]+)[CP]\s+@\s+([\d.]+)/gi);
    
    for (const legMatch of legMatches) {
      const [, action, strike, price] = legMatch;
      const isBuy = action.toLowerCase() === 'long';
      const bidAsk = isBuy ? 'ask' : 'bid';
      
      console.log(`  ${action} ${strike} ${optionType} @ ${price} -> clicking ${type}${strike} ${bidAsk}`);
      
      const result = findAndClickOptionCell(type, parseFloat(strike), bidAsk);
      if (result) clickedPositions.push(result);
    }
    
    if (clickedPositions.length > 0) {
      updateSelectedPositionsDisplay(currentOptionsData);
      console.log(`✅ Clicked ${clickedPositions.length} positions:`, clickedPositions);
      return true;
    }
  }
  
  // Fall back to parsing the trade description (old client-side format)
  // Examples:
  // "Bull 1 130/135 call spread"
  // "Bear 1 120/115 put spread" 
  // "Long 1 130 calls"
  // "Long 1 120 puts"
  
  const callSpreadMatch = tradeDescription.match(/Bul[l]? (\d+) (\d+)\/(\d+) call spread/i);
  const putSpreadMatch = tradeDescription.match(/Bear (\d+) (\d+)\/(\d+) put spread/i);
  const singleCallMatch = tradeDescription.match(/Long (\d+) (\d+) calls?/i);
  const singlePutMatch = tradeDescription.match(/Long (\d+) (\d+) puts?/i);
  
  if (callSpreadMatch) {
    // Bull call spread: BUY lower strike CALL, SELL higher strike CALL
    const [, qty, lowerStrike, higherStrike] = callSpreadMatch;
    console.log(`🐂 Bull call spread: BUY ${qty} ${lowerStrike} CALL, SELL ${qty} ${higherStrike} CALL`);
    
    // Click ASK cell for long call (lower strike)
    const longCallResult = findAndClickOptionCell('c', parseFloat(lowerStrike), 'ask');
    if (longCallResult) clickedPositions.push(longCallResult);
    
    // Click BID cell for short call (higher strike)
    const shortCallResult = findAndClickOptionCell('c', parseFloat(higherStrike), 'bid');
    if (shortCallResult) clickedPositions.push(shortCallResult);
    
  } else if (putSpreadMatch) {
    // Bear put spread: BUY higher strike PUT, SELL lower strike PUT
    const [, qty, lowerStrike, higherStrike] = putSpreadMatch;
    console.log(`🐻 Bear put spread: BUY ${qty} ${higherStrike} PUT, SELL ${qty} ${lowerStrike} PUT`);
    
    // Click ASK cell for long put (higher strike)
    const longPutResult = findAndClickOptionCell('p', parseFloat(higherStrike), 'ask');
    if (longPutResult) clickedPositions.push(longPutResult);
    
    // Click BID cell for short put (lower strike)
    const shortPutResult = findAndClickOptionCell('p', parseFloat(lowerStrike), 'bid');
    if (shortPutResult) clickedPositions.push(shortPutResult);
    
  } else if (singleCallMatch) {
    // Single long call
    const [, qty, strike] = singleCallMatch;
    console.log(`📈 Long call: BUY ${qty} ${strike} CALL`);
    
    const callResult = findAndClickOptionCell('c', parseFloat(strike), 'ask');
    if (callResult) clickedPositions.push(callResult);
    
  } else if (singlePutMatch) {
    // Single long put
    const [, qty, strike] = singlePutMatch;
    console.log(`📉 Long put: BUY ${qty} ${strike} PUT`);
    
    const putResult = findAndClickOptionCell('p', parseFloat(strike), 'ask');
    if (putResult) clickedPositions.push(putResult);
    
  } else {
    console.warn('❌ Could not parse trade description:', tradeDescription);
    return false;
  }
  
  // Update the selected positions display
  updateSelectedPositionsDisplay(currentOptionsData);
  
  console.log(`✅ Clicked ${clickedPositions.length} positions:`, clickedPositions);
  return clickedPositions.length > 0;
}

// Function to find and click a specific option cell
function findAndClickOptionCell(optionType, strike, bidAsk) {
  console.log(`🔍 Looking for ${optionType}${strike} ${bidAsk} cell`);
  
  // Find the options table
  const table = document.querySelector('.options-table');
  if (!table) {
    console.warn('❌ Options table not found');
    return null;
  }
  
  // Find all rows with the target strike
  const rows = table.querySelectorAll('tr');
  let targetRow = null;
  let strikeIndex = -1;
  
  for (const row of rows) {
    const cells = row.getElementsByTagName('td');
    
    // Find the strike cell
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      if (cell.className.includes('strike-cell') && !cell.className.includes('strike-cell-p')) {
        const strikeText = cell.textContent.replace('$', '');
        const rowStrike = parseFloat(strikeText);
        
        if (Math.abs(rowStrike - strike) < 0.01) { // Account for floating point precision
          targetRow = row;
          strikeIndex = i;
          break;
        }
      }
    }
    
    if (targetRow) break;
  }
  
  if (!targetRow) {
    console.warn(`❌ Could not find row for strike ${strike}`);
    return null;
  }
  
  // Find the target cell based on option type and bid/ask
  const cells = targetRow.getElementsByTagName('td');
  let targetCell = null;
  
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    const cellClass = cell.className;
    
    // Check if this cell matches our criteria
    const isCallCell = i < strikeIndex; // Calls are to the left of strike
    const isPutCell = i > strikeIndex;  // Puts are to the right of strike
    const isBidCell = cellClass.includes('bid');
    const isAskCell = cellClass.includes('ask');
    
    if ((optionType === 'c' && isCallCell) || (optionType === 'p' && isPutCell)) {
      if ((bidAsk === 'bid' && isBidCell) || (bidAsk === 'ask' && isAskCell)) {
        targetCell = cell;
        break;
      }
    }
  }
  
  if (!targetCell) {
    console.warn(`❌ Could not find ${optionType}${strike} ${bidAsk} cell`);
    return null;
  }
  
  // Get cell info before clicking
  const priceText = targetCell.textContent.replace('$', '');
  const price = parseFloat(priceText);
  const side = bidAsk === 'bid' ? 'short' : 'long';
  
  console.log(`🎯 Clicking ${optionType}${strike} ${bidAsk} cell at price $${price}`);
  
  // Simulate click on the cell
  const clickEvent = new MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    view: window
  });
  targetCell.dispatchEvent(clickEvent);
  
  return {
    type: optionType,
    strike: strike,
    side: side,
    price: price,
    bidAsk: bidAsk
  };
}

// Function to handle clicking/tapping on bid/ask cells
function handleOptionCellClick(event, optionsData) {
  // Prevent default behavior for touch events to avoid interference
  if (event.type === 'touchstart' || event.type === 'touchend') {
    event.preventDefault();
    // Prevent multiple rapid touches
    const cell = event.target;
    if (cell.dataset.touchProcessed === 'true') {
      return;
    }
    cell.dataset.touchProcessed = 'true';
    setTimeout(() => {
      delete cell.dataset.touchProcessed;
    }, 300);
  }
  
  const cell = event.target;
  const cellClass = cell.className;
  
  // Only handle bid/ask cells
  if (!cellClass.includes('bid') && !cellClass.includes('ask')) {
    return;
  }
  
  // For touch events, verify the touch is actually within the cell bounds
  if (event.type === 'touchstart' && event.touches && event.touches.length > 0) {
    const touch = event.touches[0];
    const rect = cell.getBoundingClientRect();
    const scrollX = window.pageXOffset || document.documentElement.scrollLeft;
    const scrollY = window.pageYOffset || document.documentElement.scrollTop;
    
    // Check if touch is within cell bounds (with some tolerance for zoom)
    const tolerance = 10; // 10px tolerance
    const touchX = touch.clientX + scrollX;
    const touchY = touch.clientY + scrollY;
    const cellLeft = rect.left + scrollX;
    const cellRight = rect.right + scrollX;
    const cellTop = rect.top + scrollY;
    const cellBottom = rect.bottom + scrollY;
    
    if (touchX < cellLeft - tolerance || touchX > cellRight + tolerance ||
        touchY < cellTop - tolerance || touchY > cellBottom + tolerance) {
      console.log('🚫 Touch outside cell bounds, ignoring');
      return;
    }
  }
  
  const row = cell.closest('tr');
  const cells = row.getElementsByTagName('td');
  
  // Find the strike price (middle column)
  let strikeCell = null;
  let strikeIndex = -1;
  
  // The strike is in the middle column (index varies based on table structure)
  for (let i = 0; i < cells.length; i++) {
    if (cells[i].className.includes('strike-cell') && !cells[i].className.includes('strike-cell-p')) {
      strikeCell = cells[i];
      strikeIndex = i;
      break;
    }
  }
  
  if (!strikeCell) return;
  
  const strikeText = strikeCell.textContent.replace('$', '');
  const strike = parseFloat(strikeText);
  
  // Determine if this is a call or put based on cell position
  const isCall = cell.cellIndex < strikeIndex;
  const optionType = isCall ? 'c' : 'p';
  
  // Determine if this is bid or ask
  const isBid = cellClass.includes('bid');
  const side = isBid ? 'short' : 'long'; // Clicking bid = short, ask = long
  
  // Get the price from the cell
  const priceText = cell.textContent.replace('$', '');
  const price = parseFloat(priceText);
  
  // Find the option data from the options array instead of parsing the table
  let optionData = null;
  if (optionsData && optionsData.length > 0) {
    optionData = optionsData.find(option => {
      const optionStrike = option.strike;
      const optionType = option.type || option.optionType; // 'c'/'p' or 'call'/'put'
      
      return Math.abs(optionStrike - strike) < 0.01 && 
             ((isCall && (optionType === 'c' || optionType === 'call')) || 
              (!isCall && (optionType === 'p' || optionType === 'put')));
    });
  }
  
  // Calculate average price using the existing calculateOffsetCost function
  let averagePrice = price; // fallback to clicked price
  if (optionData && optionData.bid !== null && optionData.ask !== null) {
    // Use the existing calculateOffsetCost function to get the average price
    const costForOneContract = calculateOffsetCost(optionData, 1);
    averagePrice = costForOneContract / 100; // Convert back from cost*100 to price
  } else if (optionData) {
    // Fallback to available price
    averagePrice = optionData.bid || optionData.ask || price;
  }
  
  console.log(`💰 Option ${optionType}${strike}: Found data=${!!optionData}, Bid=${optionData?.bid}, Ask=${optionData?.ask}, Average=${averagePrice}`);
  
  // Create position key
  const positionKey = `${optionType}${strike}`;
  
  // Toggle selection
  if (selectedTablePositions.has(positionKey)) {
    // Remove selection
    selectedTablePositions.delete(positionKey);
    cell.classList.remove('selected-bid', 'selected-ask');
  } else {
    // Add selection
    const position = {
      strike: strike,
      type: optionType,
      bid: optionData?.bid || null,
      ask: optionData?.ask || null,
      side: side,
      price: averagePrice // Use average price from calculateOffsetCost
    };
    selectedTablePositions.set(positionKey, position);
    
    // Add highlighting class
    if (isBid) {
      cell.classList.add('selected-bid');
    } else {
      cell.classList.add('selected-ask');
    }
  }
  
  // Update the display
  updateSelectedPositionsDisplay(currentOptionsData);
}

// Function to update the selected positions display
function updateSelectedPositionsDisplay(optionsData = null) {
  const displayArea = document.getElementById('selected-positions-display');
  if (!displayArea) return;
  
  console.log('🎨 updateSelectedPositionsDisplay called with optionsData:', !!optionsData);
  if (optionsData) {
    console.log('📊 Options data received:', optionsData.length, 'options');
  }
  
  if (selectedTablePositions.size === 0) {
    displayArea.innerHTML = '<div class="selected-positions-empty">Click bid/ask cells to select positions</div>';
    selectedPositionsCost = 0;
    // Clear tempOptionArray from textInput when no positions selected
    updateTextInputWithTempPositions([]);
    return;
  }
  
  let html = '<div class="selected-positions-header">Selected Positions: <button onclick="clearSelectedPositions()" style="font-size: 12px; padding: 4px 8px; margin-left: 10px; background: #dc3545; color: white; border: none; border-radius: 3px; cursor: pointer;">Clear All</button></div>';
  html += '<div class="selected-positions-list">';
  
  let totalCost = 0;
  const tempPositions = [];
  
  // Sort by strike then type
  const sortedPositions = Array.from(selectedTablePositions.entries()).sort((a, b) => {
    const [keyA, posA] = a;
    const [keyB, posB] = b;
    if (posA.strike !== posB.strike) {
      return posA.strike - posB.strike;
    }
    return posA.type.localeCompare(posB.type);
  });
  
  sortedPositions.forEach(([key, position]) => {
    const optionName = position.type === 'c' ? 'Call' : 'Put';
    const sideSymbol = position.side === 'long' ? '+' : '-';
    
    // Recalculate average price using fresh options data if available
    let currentPrice = position.price; // fallback to stored price
    
    if (optionsData && optionsData.length > 0) {
      console.log(`🔍 Looking for option: ${position.type}${position.strike}`);
      console.log(`📊 Available strikes:`, optionsData.slice(0, 5).map(o => `${o.type}${o.strike}`));
      
      const optionData = optionsData.find(option => {
        const optionStrike = option.strike;
        const optionType = option.optionType || option.type; // Handle both field names
        
        console.log(`🔍 Checking option: ${optionType}${optionStrike} against ${position.type}${position.strike}`);
        
        const matches = Math.abs(optionStrike - position.strike) < 0.01 && 
               ((position.type === 'c' && (optionType === 'c' || optionType === 'call')) || 
                (position.type === 'p' && (optionType === 'p' || optionType === 'put')));
        
        if (matches) {
          console.log(`✅ Found matching option: strike=${optionStrike}, type=${optionType}, bid=${option.bid}, ask=${option.ask}`);
        }
        
        return matches;
      });
      
      if (optionData && optionData.bid !== null && optionData.ask !== null) {
        // Use the existing calculateOffsetCost function to get the fresh average price
        const costForOneContract = calculateOffsetCost(optionData, 1);
        currentPrice = costForOneContract / 100; // Convert back from cost*100 to price
        console.log(`🔄 Updated price for ${position.type}${position.strike}: ${position.price} → ${currentPrice} (bid: ${optionData.bid}, ask: ${optionData.ask})`);
      } else {
        console.log(`❌ No matching option data found for ${position.type}${position.strike}`);
        // Let's find the closest strike as a fallback
        const closestOption = optionsData.reduce((closest, option) => {
          const optionType = option.optionType || option.type;
          const typeMatches = (position.type === 'c' && (optionType === 'c' || optionType === 'call')) || 
                            (position.type === 'p' && (optionType === 'p' || optionType === 'put'));
          
          if (!typeMatches) return closest;
          
          const currentDiff = Math.abs(option.strike - position.strike);
          const closestDiff = closest ? Math.abs(closest.strike - position.strike) : Infinity;
          
          return currentDiff < closestDiff ? option : closest;
        }, null);
        
        if (closestOption) {
          console.log(`🎯 Found closest option: ${closestOption.type}${closestOption.strike} (diff: ${Math.abs(closestOption.strike - position.strike)})`);
        }
      }
    } else {
      console.log(`📝 No options data provided, using stored price: ${currentPrice}`);
    }
    
    const cost = position.side === 'long' ? currentPrice * 100 : -currentPrice * 100; // Long = positive cost, Short = negative cost, multiplied by 100
    totalCost += cost;
    
    // Create position string for tempOptionArray with cost
    // Format: +1c100@250 or -1c110@-120 (costs are multiplied by 100)
    // Cost should be positive for long positions, negative for short positions
    const costString = cost >= 0 ? `@${cost.toFixed(0)}` : `@${cost.toFixed(0)}`;
    const positionString = `${sideSymbol}1${position.type}${position.strike.toFixed(0)}${costString}`;
    tempPositions.push(positionString);
    
    html += `
      <div class="selected-position-item">
        <span class="position-type">${optionName} $${position.strike.toFixed(2)}</span>
        <span class="position-side ${position.side}">${sideSymbol}${currentPrice.toFixed(2)}${optionsData ? ' (avg)' : ''}</span>
        <span class="position-cost ${cost >= 0 ? 'credit' : 'debit'}">${cost >= 0 ? '+' : ''}$${Math.abs(cost).toFixed(0)}</span>
      </div>
    `;
  });
  
  html += '</div>';
  html += `<div class="selected-positions-total">Total Cost: <span class="${totalCost >= 0 ? 'credit' : 'debit'}">${totalCost >= 0 ? '+' : ''}$${Math.abs(totalCost).toFixed(2)}</span></div>`;
  
  displayArea.innerHTML = html;
  selectedPositionsCost = totalCost;
  
  // Update textInput with tempOptionArray
  updateTextInputWithTempPositions(tempPositions);
  
  // Analyze selected positions for offsetting opportunities
  console.log('🧪 Checking if analyzeSelectedOffsetPosition exists:', typeof analyzeSelectedOffsetPosition);
  if (typeof analyzeSelectedOffsetPosition === 'function') {
    // Get the initial position from textInput
    const textInput = document.getElementById('textInput');
    let initialPosition = null;
    
    console.log('🧪 textInput value:', textInput?.value);
    
    if (textInput && textInput.value) {
      try {
        // The textInput already contains a JavaScript object, not a JSON string
        // We need to evaluate it or parse it differently
        let inputData;
        
        // Try to parse as JSON first
        try {
          inputData = JSON.parse(textInput.value);
        } catch (jsonError) {
          // If JSON parsing fails, try to extract optionArray using regex
          console.log('🧪 JSON parse failed, trying regex extraction');
          const optionArrayMatch = textInput.value.match(/"optionArray"\s*:\s*"([^"]+)"/); 
          if (optionArrayMatch) {
            inputData = { optionArray: optionArrayMatch[1] };
          }
          // Also try to extract syntheticPosition
          const syntheticMatch = textInput.value.match(/"syntheticPosition"\s*:\s*"([^"]+)"/); 
          if (syntheticMatch) {
            inputData = inputData || {};
            inputData.syntheticPosition = syntheticMatch[1];
          }
        }
        
        console.log('🧪 Parsed inputData:', inputData);
        console.log('🔍 syntheticPosition value:', inputData?.syntheticPosition);
        console.log('🔍 optionArray value:', inputData?.optionArray);
        
        // Prefer syntheticPosition if provided, otherwise use optionArray
        if (inputData && inputData.syntheticPosition) {
          console.log('🎯 Using syntheticPosition as initial position');
          console.log('🎯 syntheticPosition string:', inputData.syntheticPosition);
          initialPosition = parseInitialPositionForAnalysis(inputData.syntheticPosition);
          console.log('🎯 Parsed synthetic position result:', initialPosition);
        } else if (inputData && inputData.optionArray) {
          console.log('📊 Using optionArray as initial position (no syntheticPosition found)');
          console.log('📊 optionArray string:', inputData.optionArray);
          initialPosition = parseInitialPositionForAnalysis(inputData.optionArray);
          console.log('📊 Parsed initial position result:', initialPosition);
        } else {
          console.log('⚠️ No syntheticPosition or optionArray found in inputData');
        }
      } catch (e) {
        console.log('Could not parse initial position for offset analysis:', e);
      }
    }
    
    console.log('🧪 Calling analyzeSelectedOffsetPosition with:', selectedTablePositions.size, 'positions');
    analyzeSelectedOffsetPosition(selectedTablePositions, initialPosition);
  } else {
    console.warn('⚠️ analyzeSelectedOffsetPosition function not found!');
  }
}

// Function to parse initial position for offset analysis
function parseInitialPositionForAnalysis(optionArrayString) {
  console.log('🔧 parseInitialPositionForAnalysis called with:', optionArrayString);
  
  if (!optionArrayString) {
    console.log('⚠️ optionArrayString is null/undefined');
    return null;
  }
  
  // Parse the option array string to extract legs
  const legs = [];
  const positions = optionArrayString.split(',').map(s => s.trim()).filter(s => s);
  console.log('🔧 Split positions:', positions);
  
  for (const pos of positions) {
    // Match format: +1c100@250 or -1p200@-150
    const match = pos.match(/^([+-]?)(\d+)([cp])(\d+)@(-?\d+)$/);
    if (match) {
      const [, sign, qty, type, strike, cost] = match;
      const quantity = parseInt(qty) * (sign === '-' ? -1 : 1);
      const leg = {
        qty: quantity,
        quantity: quantity,
        type: type.toUpperCase(),
        strike: parseFloat(strike),
        cost: parseFloat(cost)
      };
      console.log('🔧 Parsed leg from', pos, ':', leg);
      legs.push(leg);
    } else {
      console.log('⚠️ Could not parse position:', pos);
    }
  }
  
  if (legs.length === 0) {
    console.log('⚠️ No legs parsed, returning null');
    return null;
  }
  
  console.log('🔧 Total legs parsed:', legs.length);
  
  // Determine strategy
  let strategy = 'unknown';
  let totalCost = legs.reduce((sum, leg) => sum + leg.cost, 0);
  let spreadWidth = 0;
  let maxValue = 0;
  
  if (legs.length === 2) {
    const sorted = legs.sort((a, b) => a.strike - b.strike);
    const lower = sorted[0];
    const upper = sorted[1];
    spreadWidth = upper.strike - lower.strike;
    
    if (lower.type === upper.type) {
      if (lower.type === 'P') {
        // Put spread
        if (lower.quantity < 0 && upper.quantity > 0) {
          strategy = 'bear_put_spread';
          maxValue = spreadWidth * 100;
        } else if (lower.quantity > 0 && upper.quantity < 0) {
          strategy = 'bull_put_spread';
          maxValue = spreadWidth * 100;
        }
      } else if (lower.type === 'C') {
        // Call spread
        if (lower.quantity > 0 && upper.quantity < 0) {
          strategy = 'bull_call_spread';
          maxValue = spreadWidth * 100;
        } else if (lower.quantity < 0 && upper.quantity > 0) {
          strategy = 'bear_call_spread';
          maxValue = spreadWidth * 100;
        }
      }
    }
  }
  
  const result = {
    strategy: strategy,
    cost: totalCost,
    maxValue: maxValue,
    spreadWidth: spreadWidth,
    legs: legs
  };
  
  console.log('🔧 parseInitialPositionForAnalysis result:', result);
  return result;
}

// Function to update textInput textarea with tempOptionArray while preserving formatting
function updateTextInputWithTempPositions(tempPositions) {
  const textInput = document.getElementById('textInput');
  if (!textInput) return;
  
  // Don't update textInput while user is typing
  if (textInputHasFocus) {
    console.log('⏸️ Skipping textInput update - user is typing');
    return;
  }
  
  const currentText = textInput.value;
  const tempOptionArrayValue = tempPositions.join(',');
  
  // If no positions selected, remove tempOptionArray field entirely
  if (tempPositions.length === 0) {
    // Remove tempOptionArray line while preserving other formatting
    const updatedText = currentText.replace(/,\s*"tempOptionArray"\s*:\s*"[^"]*"/g, '') // Remove with comma
                              .replace(/"tempOptionArray"\s*:\s*"[^"]*"/g, '') // Remove without comma
                              .replace(/,\s*\n\s*\}/g, '\n}') // Clean up trailing comma before closing brace
                              .replace(/\n\s*\n\s*\}/g, '\n}'); // Clean up extra newlines before closing brace
    
    textInput.value = updatedText;
    console.log('📝 Removed tempOptionArray from textInput');
    return;
  }
  
  // Try to preserve existing formatting by updating only the tempOptionArray field
  const tempArrayRegex = /"tempOptionArray"\s*:\s*"[^"]*"/;
  
  if (tempArrayRegex.test(currentText)) {
    // Update existing tempOptionArray field
    const updatedText = currentText.replace(tempArrayRegex, `"tempOptionArray": "${tempOptionArrayValue}"`);
    textInput.value = updatedText;
    console.log('📝 Updated existing tempOptionArray in textInput:', tempOptionArrayValue);
  } else {
    // Add tempOptionArray field to existing JSON
    try {
      // Check if the text looks like valid JSON
      const cleanText = currentText.replace(/\r\n|\r|\n/g, '').replace(/\s+/g, ' ').trim();
      if (cleanText && cleanText.startsWith('{') && cleanText.endsWith('}')) {
        // Add tempOptionArray before the closing brace, preserving formatting
        const lastBraceIndex = currentText.lastIndexOf('}');
        const beforeBrace = currentText.substring(0, lastBraceIndex);
        const afterBrace = currentText.substring(lastBraceIndex);
        
        // Check if we need to add a comma
        const needsComma = !beforeBrace.trim().endsWith(',') && !beforeBrace.trim().endsWith('{');
        const separator = needsComma ? ',\n  ' : '\n  ';
        
        const updatedText = beforeBrace + separator + `"tempOptionArray": "${tempOptionArrayValue}"` + afterBrace;
        textInput.value = updatedText;
        console.log('📝 Added tempOptionArray to existing JSON:', tempOptionArrayValue);
      } else {
        // Not valid JSON, create new structure
        const newJson = `{\n  "tempOptionArray": "${tempOptionArrayValue}"\n}`;
        textInput.value = newJson;
        console.log('📝 Created new JSON with tempOptionArray:', tempOptionArrayValue);
      }
    } catch (error) {
      console.warn('⚠️ Could not parse existing text, creating new JSON:', error.message);
      const newJson = `{\n  "tempOptionArray": "${tempOptionArrayValue}"\n}`;
      textInput.value = newJson;
    }
  }
}

// Function to preserve selections when table is redrawn
function preserveTableSelections() {
  // This function will be called before table redraw to save current selections
  // The selections are already stored in selectedTablePositions map
  console.log('Preserving', selectedTablePositions.size, ' table selections');
}

// Function to restore selections after table is redrawn
function restoreTableSelections() {
  // Re-apply highlighting to the new table
  selectedTablePositions.forEach((position, key) => {
    // Find cells in the new table and re-apply classes
    const table = document.querySelector('.options-table');
    if (!table) return;
    
    const rows = table.getElementsByTagName('tr');
    for (let row of rows) {
      const cells = row.getElementsByTagName('td');
      
      // Find strike cell
      let strikeCell = null;
      let strikeIndex = -1;
      
      for (let i = 0; i < cells.length; i++) {
        if (cells[i].className.includes('strike-cell') && !cells[i].className.includes('strike-cell-p')) {
          const strikeText = cells[i].textContent.replace('$', '');
          const strike = parseFloat(strikeText);
          if (Math.abs(strike - position.strike) < 0.01) {
            strikeCell = cells[i];
            strikeIndex = i;
            break;
          }
        }
      }
      
      if (strikeCell && Math.abs(parseFloat(strikeCell.textContent.replace('$', '')) - position.strike) < 0.01) {
        // Found the correct row, now find and highlight the bid/ask cell
        const isCall = position.type === 'c';
        const targetCellIndex = isCall ? 
          (position.side === 'short' ? strikeIndex - 3 : strikeIndex - 2) : // Call side: bid(2), ask(3) from strike
          (position.side === 'short' ? strikeIndex + 2 : strikeIndex + 3); // Put side: bid(7), ask(8) from strike
        
        console.log(`🎯 Restoring selection: ${position.type}${position.strike} ${position.side}, strikeIndex: ${strikeIndex}, targetCellIndex: ${targetCellIndex}`);
        
        if (targetCellIndex >= 0 && targetCellIndex < cells.length) {
          const targetCell = cells[targetCellIndex];
          if (position.side === 'short') {
            targetCell.classList.add('selected-bid');
          } else {
            targetCell.classList.add('selected-ask');
          }
        }
        break;
      }
    }
  });
  
  // Note: updateSelectedPositionsDisplay is called later in updateOptionsChain with fresh data
}

// Function to clear all selected positions
function clearSelectedPositions() {
  selectedTablePositions.clear();
  
  // Remove highlighting from all cells
  const selectedCells = document.querySelectorAll('.selected-bid, .selected-ask');
  selectedCells.forEach(cell => {
    cell.classList.remove('selected-bid', 'selected-ask');
  });
  
  // Hide the selected offset analysis
  if (typeof hideSelectedOffsetAnalysis === 'function') {
    hideSelectedOffsetAnalysis();
  }
  
  // Update display
  updateSelectedPositionsDisplay(currentOptionsData);
}

// Import single leg offsetting functions
// Note: In browser environment, these will be loaded via script tags

// Note: Schwab API functions (restoreLastSymbol, saveCurrentSymbol) are now in schwab-api.js


// Function to update the chart based on slider value
function updateChartWithSlider() {
  const slider = document.getElementById('optionRange');
  const count = parseInt(slider.value);
  document.getElementById('optionCount').textContent = count;
  
  // Get a subset of the original options based on the slider value
  //const visibleOptions = fullOptionArray.slice(0, count);
  const visibleOptions = fullOptionArray.slice(-count); // show positions from the end of the array

  // Create a map to combine the visible options for chart rendering
  const visibleCombinedMap = new Map();
  
  visibleOptions.forEach(option => {
    // Only process real options, not standalone cost adjustments
    if (option.type && option.strike !== null) {
      const key = `${option.type}${option.strike}`;
      if (visibleCombinedMap.has(key)) {
        visibleCombinedMap.get(key).qty += option.qty;
      } else {
        visibleCombinedMap.set(key, { ...option });
      }
    }
  });
  
  const visibleCombinedOptions = Array.from(visibleCombinedMap.values());
  
  // Calculate the cost for only the visible positions
  let visibleCost = 0;
  visibleOptions.forEach(option => {
    if (option.costAdjustment) {
      visibleCost += option.costAdjustment;
    }
  });
  
  // Calculate portfolio values with the filtered and combined options
  const data = ChartModule.calculatePortfolioValueAtExpiration(
    visibleCombinedOptions,
    fullMinStrike,
    fullMaxStrike,
    fullStrikeIncrement
  );
  
  // Get current underlying price from the UI for chart
  const priceElement = document.getElementById('underlying-price');
  let underlyingPrice = 0;
  if (priceElement) {
    const priceText = priceElement.textContent;
    underlyingPrice = parseFloat(priceText.replace('$', '')) || 0;
  }
  
  // Draw the chart with the filtered data and visible cost
  ChartModule.drawChart(data, visibleCost, visibleOptions, null, underlyingPrice);
}

// Function to show all options
function showAllOptions() {
  const slider = document.getElementById('optionRange');
  slider.value = fullOptionArray.length;
  document.getElementById('optionCount').textContent = fullOptionArray.length;
  updateChartWithSlider();
}

// Note: All Schwab API functions are now in schwab-api.js

// Get validated premium using neighboring ask prices as reference
function getValidatedPremium(position, positions) {
  const storedPremium = position.premium;
  const averageAsk = getAverageAskPrice(position.strike, positions);
  
  // If no stored premium, use calculated average
  if (!storedPremium) {
    console.log(`🔧 No stored premium for ${position.type}${position.strike}, using average ask: $${averageAsk.toFixed(2)}`);
    return averageAsk;
  }
  
  // If no average ask available, use stored premium
  if (averageAsk === 0) {
    console.log(`🔧 No neighboring ask prices for ${position.type}${position.strike}, using stored premium: $${storedPremium.toFixed(2)}`);
    return storedPremium;
  }
  
  // Compare stored premium to average ask
  const percentageDifference = Math.abs((storedPremium - averageAsk) / averageAsk) * 100;
  
  if (percentageDifference > 3) {
    console.log(`🔧 Stored premium unrealistic for ${position.type}${position.strike}: $${storedPremium.toFixed(2)} vs average ask $${averageAsk.toFixed(2)} (${percentageDifference.toFixed(1)}% difference)`);
    console.log(`🔧 Using calculated average ask instead: $${averageAsk.toFixed(2)}`);
    return averageAsk;
  }
  
  console.log(`✅ Stored premium valid for ${position.type}${position.strike}: $${storedPremium.toFixed(2)} vs average ask $${averageAsk.toFixed(2)} (${percentageDifference.toFixed(1)}% difference)`);
  return storedPremium;
}
function getAverageAskPrice(currentStrike, positions) {
  const strikes = positions.map(p => p.strike).sort((a, b) => a - b);
  const currentIndex = strikes.indexOf(currentStrike);
  
  if (currentIndex === -1) {
    console.log(`❌ Could not find strike ${currentStrike} in positions array`);
    return 0;
  }
  
  const priorStrike = currentIndex > 0 ? strikes[currentIndex - 1] : null;
  const nextStrike = currentIndex < strikes.length - 1 ? strikes[currentIndex + 1] : null;
  
  let askPrices = [];
  
  // Get ask prices from neighboring strikes
  if (priorStrike) {
    const priorPosition = positions.find(p => p.strike === priorStrike);
    if (priorPosition && priorPosition.ask) {
      askPrices.push(priorPosition.ask);
    }
  }
  
  if (nextStrike) {
    const nextPosition = positions.find(p => p.strike === nextStrike);
    if (nextPosition && nextPosition.ask) {
      askPrices.push(nextPosition.ask);
    }
  }
  
  if (askPrices.length === 0) {
    console.log(`❌ No ask prices found for neighbors of strike ${currentStrike}`);
    return 0;
  }
  
  const averageAsk = askPrices.reduce((sum, price) => sum + price, 0) / askPrices.length;
  console.log(`🔧 Calculated average ask for strike ${currentStrike}: $${averageAsk.toFixed(2)} from [${askPrices.map(p => `$${p.toFixed(2)}`).join(', ')}]`);
  
  return averageAsk;
}

// Helper function to format position summary HTML
function formatPositionSummary(position) {
  if (!position || !position.legs || position.legs.length === 0) {
    return '';
  }
  
  let html = '<div class="position-info">';
  html += '<div class="position-summary">';
  
  // Show legs
  const legDescriptions = position.legs.map(leg => {
    const type = leg.type === 'C' || leg.type === 'c' ? 'Call' : 'Put';
    const action = leg.qty > 0 ? 'Long' : 'Short';
    const qty = Math.abs(leg.qty);
    return `${action} ${qty} ${type} @ ${leg.strike}`;
  }).join(' | ');
  html += `<div class="position-legs"><strong>Position:</strong> ${legDescriptions}</div>`;
  
  // Show financials
  const costLabel = position.cost < 0 ? 'Credit' : 'Cost';
  const costValue = Math.abs(position.cost);
  html += '<div class="position-financials">';
  html += `<span><strong>${costLabel}:</strong> $${costValue.toFixed(0)}</span> | `;
  if (position.offsetBudget !== undefined) {
    html += `<span><strong>Offset Budget:</strong> $${position.offsetBudget.toFixed(0)}</span> | `;
  }
  html += `<span><strong>Max Value:</strong> $${Math.abs(position.maxValue).toFixed(0)}</span> | `;
  html += `<span><strong>Width:</strong> ${position.spreadWidth}</span>`;
  html += '</div>';
  
  html += '</div></div>';
  
  return html;
}

// Find offsetting trades that neutralize risk
function findOffsettingTrades(currentPositions, marketData, underlyingPrice) {
  console.log('::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::');
  console.log('🔍 findOffsettingTrades START :: Analyzing offsetting trades for:', currentPositions);
  console.log('📊 Market data available:', marketData.length, 'options');
  console.log('💰 Underlying price:', underlyingPrice);
  
  // Convert client positions and marketData to format expected by shared functions
  const position = convertClientPositionToSharedFormat(currentPositions);
  const chainData = convertMarketDataToChainData(marketData);
  
  if (!position) {
    console.log('❌ No valid position detected');
    return [];
  }
  
  console.log('📊 Detected strategy:', position.strategy);
  console.log('💰 Position cost:', position.cost);
  console.log('📏 Spread width:', position.spreadWidth);
  console.log('💵 Offset budget:', position.offsetBudget);
  
  // Call appropriate shared offset functions based on strategy
  let offsettingAnalysis = {};
  
  console.log('🔍 Calling shared offset functions for strategy:', position.strategy);
  console.log('📊 Position data:', position);
  console.log('📊 ChainData structure:', {
    callExpirations: Object.keys(chainData.call),
    putExpirations: Object.keys(chainData.put),
    callStrikeCount: Object.keys(chainData.call[Object.keys(chainData.call)[0]] || {}).length,
    putStrikeCount: Object.keys(chainData.put[Object.keys(chainData.put)[0]] || {}).length
  });
  
  switch (position.strategy) {
    case 'bull_call_spread':
      console.log('🔍 Finding bear call spread offsets...');
      const bearCallSpreadOffsets = OffsetCalculations.findOffsettingBearCallSpread(position, chainData);
      console.log('📊 Bear call spread results:', bearCallSpreadOffsets);
      
      console.log('🔍 Finding bear put spread offsets...');
      const bearPutSpreadOffsets = OffsetCalculations.findOffsettingBearPutSpread(position, chainData);
      console.log('📊 Bear put spread results:', bearPutSpreadOffsets);
      
      offsettingAnalysis = OffsetCalculations.aggregateOffsettingResults([bearCallSpreadOffsets, bearPutSpreadOffsets]);
      console.log('📊 Aggregated results:', offsettingAnalysis);
      break;
    case 'bear_put_spread':
      console.log('🔍 DEBUG: bear_put_spread case - calling findOffsettingBullCallSpread');
      console.log('🔍 DEBUG: Available call strikes:', Object.keys(chainData.call[Object.keys(chainData.call)[0]] || {}).map(k => parseFloat(k)).sort((a, b) => a - b));
      console.log('🔍 DEBUG: Position short strike:', position.legs.find(l => l.qty < 0).strike);
      const bullCallSpreadOffsets = OffsetCalculations.findOffsettingBullCallSpread(position, chainData);
      console.log('🔍 DEBUG: bear_put_spread case - calling findOffsettingBullPutSpread');
      const bullPutSpreadOffsets = OffsetCalculations.findOffsettingBullPutSpread(position, chainData);
      console.log('🔍 DEBUG: bear_put_spread case - aggregating results');
      console.log('🔍 DEBUG: bullCallSpreadOffsets found:', bullCallSpreadOffsets.possibleOffsets?.length || 0);
      console.log('🔍 DEBUG: bullPutSpreadOffsets found:', bullPutSpreadOffsets.possibleOffsets?.length || 0);
      if (bullCallSpreadOffsets.possibleOffsets?.length > 0) {
        console.log('🔍 DEBUG: First bull call offset:', bullCallSpreadOffsets.possibleOffsets[0].description);
      } else {
        console.log('🔍 DEBUG: No bull call offsets found - checking why...');
        // Debug why no offsets found
        const expirationKey = Object.keys(chainData.call)[0];
        const callStrikes = Object.keys(chainData.call[expirationKey]).map(k => parseFloat(k));
        const shortStrike = position.legs.find(l => l.qty < 0).strike;
        const validLongStrikes = callStrikes.filter(strike => strike < shortStrike);
        console.log('🔍 DEBUG: Short strike:', shortStrike);
        console.log('🔍 DEBUG: Valid long strikes (< short strike):', validLongStrikes);
        console.log('🔍 DEBUG: Offset budget:', position.offsetBudget);
        
        // Check a few specific strikes
        validLongStrikes.slice(0, 3).forEach(longStrike => {
          const longData = chainData.call[expirationKey][`${longStrike}.0`][0];
          const shortStrikes = callStrikes.filter(s => s > longStrike);
          console.log(`🔍 DEBUG: Long ${longStrike}: bid=${longData.bid}, ask=${longData.ask}, short options: ${shortStrikes.join(', ')}`);
          
          // Check if there's a matching short strike at spreadWidth distance
          const expectedShortStrike = longStrike + position.spreadWidth;
          const hasMatchingShort = shortStrikes.includes(expectedShortStrike);
          console.log(`🔍 DEBUG: Expected short strike ${expectedShortStrike}: ${hasMatchingShort ? '✅ Found' : '❌ Not found'}`);
          
          if (hasMatchingShort) {
            const shortData = chainData.call[expirationKey][`${expectedShortStrike}.0`][0];
            const spreadCost = (longData.bid + longData.ask)/2 + (shortData.bid + shortData.ask)/2;
            console.log(`🔍 DEBUG: Spread cost: $${spreadCost.toFixed(2)}, Budget: $${position.offsetBudget}, Within budget: ${spreadCost <= position.offsetBudget}`);
          }
        });
      }
      offsettingAnalysis = OffsetCalculations.aggregateOffsettingResults([bullCallSpreadOffsets, bullPutSpreadOffsets]);
      break;
    case 'bear_call_spread':
      // console.log('🔍 BEAR CALL SPREAD detected - calling findOffsettingBullCallSpread and findOffsettingBullPutSpread');
      const bullCallSpreadOffsets2 = OffsetCalculations.findOffsettingBullCallSpread(position, chainData);
      // console.log('📊 Bull call spread offsets:', bullCallSpreadOffsets2);
      const bullPutSpreadOffsets2 = OffsetCalculations.findOffsettingBullPutSpread(position, chainData);
      // console.log('📊 Bull put spread offsets:', bullPutSpreadOffsets2);
      offsettingAnalysis = OffsetCalculations.aggregateOffsettingResults([bullCallSpreadOffsets2, bullPutSpreadOffsets2]);
      // console.log('📊 Aggregated offsets:', offsettingAnalysis);
      break;
    case 'bull_put_spread':
      const bearCallSpreadOffsets2 = OffsetCalculations.findOffsettingBearCallSpread(position, chainData);
      const bearPutSpreadOffsets2 = OffsetCalculations.findOffsettingBearPutSpread(position, chainData);
      offsettingAnalysis = OffsetCalculations.aggregateOffsettingResults([bearCallSpreadOffsets2, bearPutSpreadOffsets2]);
      break;
    default:
      console.log('⚠️ Strategy not supported for offsetting:', position.strategy);
      return [];
  }
  
  // Convert shared format results back to client format
  const offsettingTrades = convertSharedOffsetsToClientFormat(offsettingAnalysis.possibleOffsets, position);
  
  console.log('🎯 Found offsetting trades:', offsettingTrades);
  console.log(`📊 Total offsetting opportunities: ${offsettingTrades.length}`);
  
  return {
    position: position,
    trades: offsettingTrades
  };
}

// Helper: Convert client positions to shared format
function convertClientPositionToSharedFormat(currentPositions) {
  console.log('🔍 convertClientPositionToSharedFormat - Input positions:', currentPositions);
  
  const callPositions = currentPositions.filter(p => p.type === 'c' && p.strike !== null);
  const putPositions = currentPositions.filter(p => p.type === 'p' && p.strike !== null);
  
  console.log('📞 Call positions:', callPositions);
  console.log('📉 Put positions:', putPositions);
  
  // Detect strategy
  const hasLongCall = callPositions.some(cp => cp.qty > 0);
  const hasShortCall = callPositions.some(cp => cp.qty < 0);
  const hasLongPut = putPositions.some(pp => pp.qty > 0);
  const hasShortPut = putPositions.some(pp => pp.qty < 0);
  
  console.log('🔍 Strategy detection:', { hasLongCall, hasShortCall, hasLongPut, hasShortPut });
  
  let strategy = null;
  let legs = [];
  let cost = 0;
  let maxValue = 0;
  let spreadWidth = 0;
  
  // Bull call spread: long lower call, short higher call (debit spread)
  if (hasLongCall && hasShortCall && callPositions.length === 2) {
    console.log('✅ Detected call spread with 2 positions');
    
    // Identify long and short based on quantity sign, not strike order
    const longCall = callPositions.find(cp => cp.qty > 0);
    const shortCall = callPositions.find(cp => cp.qty < 0);
    
    console.log('📊 Long call:', longCall);
    console.log('📊 Short call:', shortCall);
    
    // Use costAdjustment if available (already in total dollars), otherwise calculate from premium
    let longCallCost, shortCallCredit, longCallPremium, shortCallPremium;
    
    if (longCall.costAdjustment !== undefined) {
      longCallCost = Math.abs(longCall.costAdjustment);
      shortCallCredit = shortCall.costAdjustment; // Already negative for short positions
      longCallPremium = longCallCost / 100; // For logging
      shortCallPremium = Math.abs(shortCallCredit) / 100; // For logging
    } else {
      longCallPremium = getValidatedPremium(longCall, callPositions);
      shortCallPremium = getValidatedPremium(shortCall, callPositions);
      longCallCost = longCallPremium * 100 * Math.abs(longCall.qty);
      shortCallCredit = shortCallPremium * 100 * Math.abs(shortCall.qty);
    }
    
    const netCost = longCallCost + shortCallCredit; // shortCallCredit is negative
    
    console.log('💰 Cost breakdown:', {
      longCallPremium,
      shortCallPremium,
      longCallCost,
      shortCallCredit,
      netCost
    });
    
    // Bull call spread is a debit spread (positive cost)
    if (netCost > 0) {
      strategy = 'bull_call_spread';
      spreadWidth = shortCall.strike - longCall.strike;
      maxValue = spreadWidth * 100 * Math.abs(longCall.qty);
      cost = netCost;
      
      console.log('✅ Detected BULL CALL SPREAD:', { strategy, spreadWidth, maxValue, cost });
      
      legs = [
        { qty: Math.abs(longCall.qty), type: 'C', strike: longCall.strike },
        { qty: -Math.abs(shortCall.qty), type: 'C', strike: shortCall.strike }
      ];
    }
    // Bear call spread is a credit spread (negative cost)
    else {
      strategy = 'bear_call_spread';
      spreadWidth = Math.abs(shortCall.strike - longCall.strike);
      maxValue = spreadWidth * 100 * Math.abs(longCall.qty);
      cost = netCost; // Negative value
      
      console.log('✅ Detected BEAR CALL SPREAD:', { strategy, spreadWidth, maxValue, cost });
      
      legs = [
        { qty: -Math.abs(longCall.qty), type: 'C', strike: longCall.strike },
        { qty: Math.abs(shortCall.qty), type: 'C', strike: shortCall.strike }
      ];
    }
  }
  // Put spreads
  else if (hasLongPut && hasShortPut && putPositions.length === 2) {
    // Identify long and short based on quantity sign, not strike order
    const longPut = putPositions.find(pp => pp.qty > 0);
    const shortPut = putPositions.find(pp => pp.qty < 0);
    
    // Use costAdjustment if available (already in total dollars), otherwise calculate from premium
    let longPutCost, shortPutCredit;
    
    if (longPut.costAdjustment !== undefined) {
      longPutCost = Math.abs(longPut.costAdjustment);
      shortPutCredit = shortPut.costAdjustment; // Already negative for short positions
    } else {
      const longPutPremium = getValidatedPremium(longPut, putPositions);
      const shortPutPremium = getValidatedPremium(shortPut, putPositions);
      longPutCost = longPutPremium * 100 * Math.abs(longPut.qty);
      shortPutCredit = shortPutPremium * 100 * Math.abs(shortPut.qty);
    }
    
    const netCost = longPutCost + shortPutCredit; // shortPutCredit is negative
    
    // Bear put spread is a debit spread (positive cost)
    if (netCost > 0) {
      strategy = 'bear_put_spread';
      spreadWidth = longPut.strike - shortPut.strike;
      maxValue = spreadWidth * 100 * Math.abs(longPut.qty);
      cost = netCost;
      
      legs = [
        { qty: Math.abs(longPut.qty), type: 'P', strike: longPut.strike },
        { qty: -Math.abs(shortPut.qty), type: 'P', strike: shortPut.strike }
      ];
    }
    // Bull put spread is a credit spread (negative cost)
    else {
      strategy = 'bull_put_spread';
      spreadWidth = Math.abs(longPut.strike - shortPut.strike);
      maxValue = spreadWidth * 100 * Math.abs(longPut.qty);
      cost = netCost; // Negative value
      
      legs = [
        { qty: -Math.abs(longPut.qty), type: 'P', strike: longPut.strike },
        { qty: Math.abs(shortPut.qty), type: 'P', strike: shortPut.strike }
      ];
    }
  }
  
  if (!strategy) {
    console.log('❌ No strategy detected, returning null');
    return null;
  }
  
  // For credit spreads, budget is the credit collected
  // For debit spreads, budget is the remaining profit potential
  const isCreditSpread = cost < 0;
  const offsetBudget = isCreditSpread ? Math.abs(cost) : (maxValue - cost);
  
  console.log('✅ Final position object:', {
    strategy,
    legs,
    cost,
    maxValue,
    spreadWidth,
    offsetBudget
  });
  
  return {
    strategy,
    legs,
    cost,
    maxValue,
    spreadWidth,
    offsetBudget
  };
}

// Helper: Convert marketData to chainData format
function convertMarketDataToChainData(marketData) {
  const chainData = { call: {}, put: {} };
  
  // Group by expiration (we'll use a single expiration key since client doesn't track expirations separately)
  const expirationKey = '2025-01-01:1'; // Placeholder expiration
  chainData.call[expirationKey] = {};
  chainData.put[expirationKey] = {};
  
  marketData.forEach(option => {
    const strikeKey = option.strike.toString() + '.0';
    const optionData = {
      bid: option.bid || 0,
      ask: option.ask || 0,
      last: option.last || 0,
      mark: (option.bid + option.ask) / 2
    };
    
    if (option.type === 'c') {
      chainData.call[expirationKey][strikeKey] = [optionData];
    } else if (option.type === 'p') {
      chainData.put[expirationKey][strikeKey] = [optionData];
    }
  });
  
  return chainData;
}

// Helper: Convert shared format offsets back to client format
function convertSharedOffsetsToClientFormat(sharedOffsets, originalPosition) {
  if (!sharedOffsets || sharedOffsets.length === 0) {
    return [];
  }
  
  return sharedOffsets.map(offset => {
    // Determine if this is a debit spread (positive cost) for opacity logic
    const isDebitSpread = originalPosition.cost > 0;
    const tenPercentOfCost = Math.abs(originalPosition.cost) * 0.1;
    const lowLockedClass = (isDebitSpread && offset.lockedInProfit < tenPercentOfCost) ? 'low-locked-profit' : '';
    
    return {
      type: 'spread',
      description: offset.description,
      action: formatOffsetAction(offset),
      cost: offset.cost,
      potentialValue: offset.profitPotential,
      lockedProfit: offset.lockedInProfit,
      profitPotential: offset.profitPotential,
      profitPotentialScore: offset.profitPotentialScore,
      totalProfitPotential: offset.profitPotential,
      riskNeutralized: offset.lockedInProfit >= 0,
      lowLockedClass: lowLockedClass,
      strategy: offset.strategy,
      legs: offset.legs
    };
  });
}

// Helper: Format offset action for display
function formatOffsetAction(offset) {
  const lines = [];
  offset.legs.forEach(leg => {
    const action = leg.quantity > 0 ? 'BUY' : 'SELL';
    const qty = Math.abs(leg.quantity);
    const type = leg.type === 'C' ? 'CALL' : 'PUT';
    const price = Math.abs(leg.cost) / 100;
    lines.push(`${action} ${qty} ${leg.strike} ${type} @ $${price.toFixed(2)}`);
  });
  return lines.join(' & <br/>');
}

// Legacy function - keeping for backwards compatibility but simplified
function findOffsettingTradesLegacy(currentPositions, marketData, underlyingPrice) {
  console.log('::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::');
  console.log('🔍 findOffsettingTradesLegacy START :: Using legacy logic');
  console.log('📊 Market data available:', marketData.length, 'options');
  console.log('💰 Underlying price:', underlyingPrice);
  
  // Calculate dynamic strike increment once and pass to all functions
  const strikeIncrement = calculateStrikeIncrement(underlyingPrice);
  console.log(`🔧 Using global strike increment: $${strikeIncrement} (based on underlying price $${underlyingPrice})`);
  
  // Debug: Log the structure of currentPositions
  console.log('🔍 Current positions structure:');
  currentPositions.forEach((pos, index) => {
    console.log(`  [${index}] Type: ${pos.type}, Strike: ${pos.strike}, Qty: ${pos.qty}, Premium: ${pos.premium}, Bid: ${pos.bid}, Ask: ${pos.ask}, Last: ${pos.last}`);
  });
  
  const offsettingTrades = [];
  
  // Group current positions by type (calls vs puts)
  const callPositions = currentPositions.filter(p => p.type === 'c' && p.strike !== null);
  const putPositions = currentPositions.filter(p => p.type === 'p' && p.strike !== null);
  
  console.log('📈 Call positions:', callPositions);
  console.log('📉 Put positions:', putPositions);
  
  // Calculate net exposure and find total cost adjustment
  const netExposure = new Map();
  let totalCostPaid = 0;

  // Set default spread width for individual positions (no spread detected)
  let originalSpreadWidth = 100; // Default for individual positions

  
  currentPositions.forEach(pos => {
    const key = `${pos.type}${pos.strike}`;
    netExposure.set(key, (netExposure.get(key) || 0) + pos.qty);
    
    // Look for cost adjustment entries (type: null, strike: null)
    if (pos.type === null && pos.strike === null && pos.costAdjustment) {
      totalCostPaid += pos.costAdjustment;
    }
  });
  
  console.log('📊 Net exposure by strike:', netExposure);
  console.log('💰 Total cost paid:', totalCostPaid);
  
  // Calculate maximum potential profit for the position
  // This is the "budget" we can spend on offsetting trades
  let maxPotentialProfit = 0;
  
  // For call spreads, calculate the actual max profit
  if (callPositions.length >= 2) {
    console.log(`📈 Processing ${callPositions.length} call positions for spreads`);
    // Sort calls by strike to identify spread
    const sortedCalls = callPositions.sort((a, b) => a.strike - b.strike);
    
    console.log(`📈 Sorted call positions:`, sortedCalls.map(p => `${p.qty} @ ${p.strike}`));
    
    // Look for debit spreads (long lower strike, short higher strike)
    for (let i = 0; i < sortedCalls.length - 1; i++) {
      const longCall = sortedCalls[i];
      const shortCall = sortedCalls[i + 1];
      
      console.log(`🔍 Checking call spread pair: long ${longCall.qty} @ ${longCall.strike}, short ${shortCall.qty} @ ${shortCall.strike}`);
      
      if (longCall.qty > 0 && shortCall.qty < 0) {
        
        console.log(`✅ Found valid call spread configuration!`);
        // This is a call debit spread
        const spreadWidth = shortCall.strike - longCall.strike;
        const spreadMaxValue = spreadWidth * 100 * Math.abs(longCall.qty);
        
        // Calculate the actual cost of this specific spread
        const longCallPremium = getValidatedPremium(longCall, callPositions);
        const shortCallPremium = getValidatedPremium(shortCall, callPositions);
        const longCallCost = longCallPremium * 100 * Math.abs(longCall.qty);
        const shortCallCredit = shortCallPremium * 100 * Math.abs(shortCall.qty);
        const spreadCost = longCallCost + shortCallCredit; // shortCallCredit is negative, so this is net cost
        const spreadProfit = spreadMaxValue - spreadCost;
        
        // console.log(`   shortCallPremium: $${shortCallPremium.toFixed(2)}`);
        // console.log(`   longCallCost: $${longCallCost.toFixed(2)}`);
        // console.log(`   shortCallCredit: $${shortCallCredit.toFixed(2)}`);
        // console.log(`   spreadCost: $${spreadCost.toFixed(2)}`);
        // console.log(`   spreadMaxValue: $${spreadMaxValue.toFixed(2)}`);
        // console.log(`   spreadProfit: $${spreadProfit.toFixed(2)}`);
        
        maxPotentialProfit = Math.max(maxPotentialProfit, spreadProfit);
        
        // Store the original spread width for offsetting trade limits
        originalSpreadWidth = spreadWidth;
        
        console.log(`📈 Found call spread: long ${longCall.qty} ${longCall.strike}c @ $${longCallPremium.toFixed(2)}, short ${shortCall.qty} ${shortCall.strike}c @ $${shortCallPremium.toFixed(2)}`);
        console.log(`💰 Spread width: $${spreadWidth}, max value: $${spreadMaxValue.toFixed(2)}`);
        console.log(`💸 Spread cost: long $${longCallCost.toFixed(2)} + short $${shortCallCredit.toFixed(2)} = $${spreadCost.toFixed(2)}`);
        console.log(`🎯 Spread max profit: $${spreadProfit.toFixed(2)}`);
      }
    }
  }
  
  // For put spreads, calculate the actual max profit
  if (putPositions.length >= 2) {
    console.log(`📈 Processing ${putPositions.length} put positions for spreads`);

    // Sort puts by strike to identify spread
    const sortedPuts = putPositions.sort((a, b) => a.strike - b.strike);
    
    console.log(`📈 Sorted put positions:`, sortedPuts.map(p => `${p.qty} @ ${p.strike}`));
    
    // Look for debit spreads (long higher strike, short lower strike)
    for (let i = 0; i < sortedPuts.length - 1; i++) {
      const shortPut = sortedPuts[i];
      const longPut = sortedPuts[i + 1];
      
      console.log(`🔍 Checking put spread pair: long ${longPut.qty} @ ${longPut.strike}, short ${shortPut.qty} @ ${shortPut.strike}`);
      
      if (shortPut.qty < 0 && longPut.qty > 0) {
        
        console.log(`✅ Found valid put spread configuration!`);
        
        // Found a bear put spread
        const spreadWidth = longPut.strike - shortPut.strike;
        const spreadMaxValue = spreadWidth * 100 * Math.abs(longPut.qty);
        
        // Calculate the actual cost of this specific spread
        const longPutPremium = getValidatedPremium(longPut, putPositions);
        const shortPutPremium = getValidatedPremium(shortPut, putPositions);
        const longPutCost = longPutPremium * 100 * Math.abs(longPut.qty);
        const shortPutCredit = shortPutPremium * 100 * Math.abs(shortPut.qty);
        const spreadCost = longPutCost + shortPutCredit; // shortPutCredit is negative, so this is net cost
        const spreadProfit = spreadMaxValue - spreadCost;
        
        // console.log(`🔍 DEBUG: Bear put spread cost calculation:`);
        // console.log(`   longPutPremium: $${longPutPremium.toFixed(2)}`);
        // console.log(`   shortPutPremium: $${shortPutPremium.toFixed(2)}`);
        // console.log(`   longPutCost: $${longPutCost.toFixed(2)}`);
        // console.log(`   shortPutCredit: $${shortPutCredit.toFixed(2)}`);
        // console.log(`   spreadCost: $${spreadCost.toFixed(2)}`);
        // console.log(`   spreadMaxValue: $${spreadMaxValue.toFixed(2)}`);
        // console.log(`   spreadProfit: $${spreadProfit.toFixed(2)}`);
        
        maxPotentialProfit = Math.max(maxPotentialProfit, spreadProfit);
        
        // Store the original spread width for offsetting trade limits
        originalSpreadWidth = spreadWidth;
        
        console.log(`📉 Found put spread: long ${longPut.qty} ${longPut.strike}p @ $${longPutPremium.toFixed(2)}, short ${shortPut.qty} ${shortPut.strike}p @ $${shortPutPremium.toFixed(2)}`);
        console.log(`💰 Spread width: $${spreadWidth}, max value: $${spreadMaxValue.toFixed(2)}`);
        console.log(`💸 Spread cost: long $${longPutCost.toFixed(2)} + short $${shortPutCredit.toFixed(2)} = $${spreadCost.toFixed(2)}`);
        console.log(`🎯 Spread max profit: $${spreadProfit.toFixed(2)}`);
      }
    }
  }

  
  console.log('💰 Maximum potential profit (offset budget):', maxPotentialProfit);

    
  // Detect if this is a bull call spread position
  const hasLongCall = callPositions.some(cp => cp.qty > 0);
  const hasShortCall = callPositions.some(cp => cp.qty < 0);
  const isBullCallSpread = hasLongCall && hasShortCall;
  
  // Detect if this is a bear put spread position
  const hasLongPut = putPositions.some(pp => pp.qty > 0);
  const hasShortPut = putPositions.some(pp => pp.qty < 0);
  const isBearPutSpread = hasLongPut && hasShortPut;
  
    
  console.log(`🔍 Spread detection debug:`);

  console.log(`  callPositions:`, callPositions,`  hasLongCall: ${hasLongCall}`,`  hasShortCall: ${hasShortCall}`);
  console.log(`  isBullCallSpread: ${isBullCallSpread}`);

  console.log(`  putPositions:`, putPositions,`  hasLongPut: ${hasLongPut}`,`  hasShortPut: ${hasShortPut}`);
  console.log(`  isBearPutSpread: ${isBearPutSpread}`);

  // Find offsetting opportunities
  currentPositions.forEach(position => {
    const positionQty = position.qty;
    const strike = position.strike;
    const type = position.type;
    
    console.log(`🔍 Analyzing position: ${positionQty} ${type} @ ${strike}`);
    
    if (positionQty === 0) return; // Skip zero quantities
    if (type === null || strike === null) return; // Skip cost adjustment entries
    
    // For short calls, look for long puts at same or higher strike
    if (type === 'c' && positionQty < 0) { // Short calls
      // Skip if this is part of a bull call spread
      if (isBullCallSpread) {
        console.log(`⏭️ Skipping individual short call processing - part of bull call spread`);
        return;
      }
      
      const shortCallStrike = strike;
      console.log(`🔍 Looking for offsets for short ${Math.abs(positionQty)} ${shortCallStrike} calls`);
      
      // Use the maximum potential profit as the budget for offsetting trades
      const offsetBudget = maxPotentialProfit;
      
      if (offsetBudget <= 0) {
        console.log(`❌ No offset budget available (max profit: $${offsetBudget})`);
        return;
      }
      
      console.log(`💰 Offset budget from max profit: $${offsetBudget.toFixed(2)}`);
      
      // Any offsetting trade that costs less than the max profit creates locked-in profit
      // The remaining budget (max profit - offset cost) becomes the guaranteed profit
      console.log(`🎯 Any offsetting trade costing less than $${offsetBudget.toFixed(2)} creates locked-in profit`);
      
      // Find the short call strike (higher strike) for range calculation
      const shortCall = callPositions.find(cp => cp.qty < 0);
      const highestCallStrike = Math.max(...callPositions.map(cp => cp.strike));
      const higherCallStrike = shortCall ? shortCall.strike : highestCallStrike;
      const putStrikeRange = higherCallStrike + 100; // Start 10 strikes above higher call strike (10 strikes × $10 = $100)
      
      // Single leg offset: long put at same or higher strike
      processSingleLegPutOffsetting(
        callPositions,
        putPositions,
        marketData,
        underlyingPrice,
        maxPotentialProfit,
        totalCostPaid,
        originalSpreadWidth,
        offsettingTrades
      );
      
      // Spread offset: bear put spread (buy higher strike, sell lower strike)
      // Use the same outerCallStrike and putStrikeRange from single leg logic
      
      const availablePuts = marketData.filter(option => option.type === 'p' && option.strike >= putStrikeRange && Number.isInteger(option.strike) && option.strike % strikeIncrement === 0);
      
      console.log(`🔍 Checking bear put spreads with ${availablePuts.length} puts`);
      console.log(`🔍 Available puts:`, availablePuts.map(p => `${p.strike}@$${((p.bid + p.ask) / 2).toFixed(2)}`));
      
      // Sort puts by strike (ascending) for proper spread construction
      const sortedPuts = availablePuts.sort((a, b) => a.strike - b.strike);
      console.log(`🔍 Sorted puts:`, sortedPuts.map(p => `${p.strike}@$${((p.bid + p.ask) / 2).toFixed(2)}`));
      
      // Check multiple spread combinations
      const maxSpreadWidth = originalSpreadWidth * 2; // Limit to twice the original spread width
      
      let spreadCount = 0;
      
      console.log(`🔍 Starting bear put spread analysis for individual long put hedge:`);
      console.log(`  sortedPuts length: ${sortedPuts.length}`);
      console.log(`  Original spread width: $${originalSpreadWidth}`);
      console.log(`  Max spread width: $${maxSpreadWidth} (2x original)`);
      console.log(`  No limit on number of spreads to check`);
      
      for (let i = 0; i < sortedPuts.length; i++) {
        const shortPut = sortedPuts[i]; // Lower strike (sell)
        
        for (let j = i + 1; j < sortedPuts.length; j++) {
          const longPut = sortedPuts[j]; // Higher strike (buy)
          const spreadWidth = longPut.strike - shortPut.strike;
          
          // Only check spreads within minimum width range and in $10 increments
          if (spreadWidth >= strikeIncrement && spreadWidth % strikeIncrement === 0) {
            
            // For individual long puts hedging short calls: offsetting bear put spread must have at least one leg at or above the short call strike
            if (longPut.strike < higherCallStrike && shortPut.strike < higherCallStrike) {
              console.log(`⏭️ Skipping spread ${shortPut.strike}/${longPut.strike} - both legs below short call strike $${higherCallStrike}`);
              continue;
            }
            
            // Only process spreads up to the calculated maximum width
            if (spreadWidth > maxSpreadWidth) {
              console.log(`⏭️ Skipping spread ${shortPut.strike}/${longPut.strike} - width $${spreadWidth} exceeds max limit $${maxSpreadWidth}`);
              continue;
            }
            
            //console.log(`🔍 Checking spread: buy ${longPut.strike} put, sell ${shortPut.strike} put (width: $${spreadWidth})`);
            
            const longPutPrice = (longPut.bid + longPut.ask) / 2;
            const shortPutPrice = (shortPut.bid + shortPut.ask) / 2;
            
            // Bear put spread: buy higher strike, sell lower strike
            // This costs money: (higher strike price - lower strike price) * quantity * 100
            const spreadCost = calculateVerticalSpreadCost(longPutPrice, shortPutPrice, positionQty);
            const spreadMaxValue = (longPut.strike - shortPut.strike) * 100 * Math.abs(positionQty);
            
            console.log(`💰 Spread ${shortPut.strike}/${longPut.strike}: cost $${spreadCost.toFixed(2)}, max value $${spreadMaxValue.toFixed(2)}`);
            
            // Filter out spreads where cost is more than 95% of max value
            if (spreadCost > spreadMaxValue * 0.95) {
              console.log(`❌ Spread rejected: cost $${spreadCost.toFixed(2)} is too high (${(spreadCost/spreadMaxValue*100).toFixed(1)}% of max value $${spreadMaxValue.toFixed(2)})`);
              continue;
            }
            
            // Filter out spreads where potential value is less than the position being offset
            // For short calls, the position's potential value is the premium received
            const shortCall = callPositions.find(cp => cp.strike === shortCallStrike);
            const positionPotentialValue = shortCall ? shortCall.premium * 100 * Math.abs(shortCall.qty) : 0;
            
            if (spreadMaxValue < positionPotentialValue) {
              console.log(`❌ Put spread rejected: potential value $${spreadMaxValue.toFixed(2)} < position potential $${positionPotentialValue.toFixed(2)}`);
              continue;
            }
            
            // Maximum potential value of the new put spread (value at lower strike)
            const potentialValue = spreadMaxValue;
            
            // Calculate true locked-in value by analyzing combined position
            const originalPositions = [
              { type: 'p', strike: putStrike, qty: positionQty }
            ];
            
            const offsettingPositions = [
              { type: 'p', strike: shortPut.strike, qty: -Math.abs(positionQty), cost: -calculateOffsetCost({bid: shortPut.bid, ask: shortPut.ask}, positionQty) },  // Short put (lower strike)
              { type: 'p', strike: longPut.strike, qty: Math.abs(positionQty), cost: calculateOffsetCost({bid: longPut.bid, ask: longPut.ask}, positionQty) }  // Long put (higher strike)
            ];
            
            const lockedValueResult = calculateLockedInValue(originalPositions, offsettingPositions, underlyingPrice, marketData, totalCostPaid);
            const spreadDifference = lockedValueResult.spreadDifference;
            const lockedProfit = lockedValueResult.lockedProfit;
            const potentialProfit = lockedValueResult.potentialProfit;
            
            // Calculate additional profit potential for the spread based on realistic scenarios
            // For bear put spreads: maximum value is the spread width (difference between strikes)
            const upside = spreadMaxValue - lockedProfit - spreadCost; // Additional profit beyond locked profit
            
            // Total profit potential = locked profit + upside
            const totalProfitPotential = lockedProfit + upside;
            
            console.log(`🤔 Spread ${shortPut.strike}/${longPut.strike}: cost $${spreadCost.toFixed(2)}, spread difference $${spreadDifference.toFixed(2)}, potential profit $${potentialProfit.toFixed(2)}, locked profit $${lockedProfit.toFixed(2)}, upside $${upside.toFixed(2)} (max value: $${spreadMaxValue.toFixed(2)}), total potential $${totalProfitPotential.toFixed(2)}`);
            //console.log(`🔍 Spread conditions: cost < budget? ${spreadCost < offsetBudget}, locked profit > 0? ${lockedProfit > 0}`);
            
            if (spreadCost <= offsetBudget && lockedProfit >= 0) {
              console.log(`✅ Risk-free spread offset found!`);
              console.log(`   Locked profit: $${lockedProfit.toFixed(2)}`);
              console.log(`   Cost vs budget: $${spreadCost.toFixed(2)} vs $${offsetBudget.toFixed(2)}`);
              offsettingTrades.push({
                type: 'spread',
                description: `Bear ${Math.abs(positionQty)} ${shortPut.strike}/${longPut.strike} put spread`,
                action: `BUY ${Math.abs(positionQty)} ${longPut.strike} PUT @ $${longPutPrice.toFixed(2)} & <br/>SELL ${Math.abs(positionQty)} ${shortPut.strike} PUT @ $${shortPutPrice.toFixed(2)}`,
                cost: spreadCost,
                potentialValue: potentialValue, // Keep original logic
                spreadDifference: spreadDifference, // Add new field for spread difference value
                potentialProfit: potentialProfit, // Add new field for correct potential profit
                lockedProfit: lockedProfit,
                additionalProfitPotential: upside,
                totalProfitPotential: totalProfitPotential,
                riskNeutralized: true,
                originalPosition: `Long ${positionQty} ${longPutStrike} puts`,
                offsettingPosition: `Bull ${positionQty} ${longCall.strike}/${shortCall.strike} call spread`
              });
              spreadCount++;
            } else {
              //console.log(`❌ Spread rejected: cost too high or no locked profit`);
            }
          }
        }
      }
    }
    
    // For long puts, look for bull call spreads or long calls
    if (type === 'p' && positionQty > 0) { // Long puts
      // Skip if this is part of a bear put spread
      if (isBearPutSpread) {
        console.log(`⏭️ Skipping individual long put processing - part of bear put spread`);
        return;
      }
      
      const longPutStrike = strike;
      console.log(`🔍 Looking for offsets for long ${Math.abs(positionQty)} ${longPutStrike} puts`);
      
      // Use the maximum potential profit as the budget for offsetting trades
      const offsetBudget = maxPotentialProfit;
      
      if (offsetBudget <= 0) {
        console.log(`❌ No offset budget available (max profit: $${offsetBudget})`);
        return;
      }
      
      console.log(`💰 Offset budget for long put: $${offsetBudget.toFixed(2)}`);
      
      // Use the global strikeIncrement parameter
      console.log(`🔧 Using global strike increment: $${strikeIncrement}`);
      
      // For long puts, we want bullish offsets: bull call spreads or long calls
      const putStrike = longPutStrike;
      
      // For single leg calls: look at calls with strikes LOWER than the put position
      const singleLegCallRange = 0; // Start from lowest available call
      const maxSingleLegCallStrike = putStrike; // Upper limit is put strike
      
      console.log(`🔍 Looking for single leg calls up to $${maxSingleLegCallStrike} (lower than put $${putStrike})`);
      
      // For call spreads: start 10 strikes HIGHER than the put position
      // but also include calls BELOW that point to build spreads
      const callStrikeRange = putStrike + 100; // Start 100 points above put strike
      
      console.log(`🔍 Looking for call spreads starting $${callStrikeRange} (100 points above put $${putStrike})`);
      
      // For long puts, we need calls starting from the starting point AND below it
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
      
      console.log(`🔍 Starting bull call spread analysis for long put hedge:`);
      console.log(`  callStrikes length: ${callStrikes.length}`);
      console.log(`  Original spread width: $${originalSpreadWidth}`);
      console.log(`  Max spread width: $${maxSpreadWidth} (2x original)`);
      console.log(`  No limit on number of spreads to check`);
      
      // For long puts: find spreads where the HIGHER strike is the starting point
      // and the LOWER strike is below it
      for (let i = 0; i < callStrikes.length; i++) {
        const shortCallStrike = callStrikes[i]; // Higher strike (sell) - this is our starting point
        
        // Look for lower strikes to pair with this higher strike
        for (let j = i - 1; j >= 0; j--) {
          const longCallStrike = callStrikes[j]; // Lower strike (buy)
          const spreadWidth = shortCallStrike - longCallStrike;

          // For individual long puts: offsetting bull call spread must have at least one leg at or above the put strike
          if (shortCallStrike < putStrike && longCallStrike < putStrike) {
            console.log(`⏭️ Skipping spread ${longCallStrike}/${shortCallStrike} - both legs below put strike $${putStrike}`);
            continue;
          }

          // Only process spreads up to the calculated maximum width
          if (spreadWidth > maxSpreadWidth) {
            console.log(`⏭️ Skipping spread ${longCallStrike}/${shortCallStrike} - width $${spreadWidth} exceeds max limit $${maxSpreadWidth}`);
            continue;
          }

          console.log(`🔍 Checking spread ${longCallStrike}/${shortCallStrike} (width: $${spreadWidth})`);
          
          // Only check spreads within minimum width range and in $10 increments
          if (spreadWidth >= strikeIncrement && spreadWidth % strikeIncrement === 0) {
            
            console.log(`✅ Processing spread ${longCallStrike}/${shortCallStrike} (width: $${spreadWidth}) - meets protection requirement`);
            
            const longCall = marketData.find(option => option.type === 'c' && option.strike === longCallStrike);
            const shortCall = marketData.find(option => option.type === 'c' && option.strike === shortCallStrike);
            
            if (longCall && shortCall) {
              console.log(`📊 Found call options: long ${longCallStrike}@$${((longCall.bid + longCall.ask) / 2).toFixed(2)}, short ${shortCallStrike}@$${((shortCall.bid + shortCall.ask) / 2).toFixed(2)}`);
              const longCallPrice = (longCall.bid + longCall.ask) / 2;
              const shortCallPrice = (shortCall.bid + shortCall.ask) / 2;
              
              // Bull call spread: buy lower strike, sell higher strike
              // This costs money: (higher strike price - lower strike price) * quantity * 100
              const spreadCost = calculateVerticalSpreadCost(longCallPrice, shortCallPrice, positionQty);
              const spreadMaxValue = (shortCallStrike - longCallStrike) * 100 * Math.abs(positionQty);
              
              console.log(`💰 Spread ${longCallStrike}/${shortCallStrike}: cost $${spreadCost.toFixed(2)}, max value $${spreadMaxValue.toFixed(2)}`);
              
              // Filter out spreads where cost is more than 95% of max value
              if (spreadCost > spreadMaxValue * 0.95) {
                console.log(`❌ Spread rejected: cost $${spreadCost.toFixed(2)} is too high (${(spreadCost/spreadMaxValue*100).toFixed(1)}% of max value $${spreadMaxValue.toFixed(2)})`);
                continue;
              }
              
              // Filter out spreads where potential value is less than the position being offset
              // For long puts, the position's potential value is the strike price
              const positionPotentialValue = longPutStrike * 100 * Math.abs(positionQty);
              
              if (spreadMaxValue < positionPotentialValue) {
                console.log(`❌ Call spread rejected: potential value $${spreadMaxValue.toFixed(2)} < position potential $${positionPotentialValue.toFixed(2)}`);
                continue;
              }
              
              // Maximum potential value of the new call spread (value at higher strike)
              const potentialValue = spreadMaxValue;
              
              // Calculate true locked-in value by analyzing combined position
              const originalPositions = [
                { type: 'c', strike: shortCallStrike, qty: positionQty }
              ];
              
              const offsettingPositions = [
                { type: 'c', strike: longCallStrike, qty: Math.abs(positionQty), cost: calculateOffsetCost({bid: longCall.bid, ask: longCall.ask}, positionQty) },
                { type: 'c', strike: shortCallStrike, qty: -Math.abs(positionQty), cost: -calculateOffsetCost({bid: shortCall.bid, ask: shortCall.ask}, positionQty) }
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
                  description: `Bull ${Math.abs(positionQty)} ${longCallStrike}/${shortCallStrike} call spread`,
                  action: `BUY ${Math.abs(positionQty)} ${longCallStrike} CALL @ $${longCallPrice.toFixed(2)} & <br/>SELL ${Math.abs(positionQty)} ${shortCallStrike} CALL @ $${shortCallPrice.toFixed(2)}`,
                  cost: spreadCost,
                  potentialValue: potentialValue, // Keep original logic
                  spreadDifference: spreadDifference, // Add new field for spread difference value
                  potentialProfit: potentialProfit, // Add new field for correct potential profit
                  lockedProfit: lockedProfit,
                  additionalProfitPotential: upside,
                  totalProfitPotential: totalProfitPotential,
                  riskNeutralized: true,
                  originalPosition: `Long ${positionQty} ${longPutStrike} puts`,
                  offsettingPosition: `Bull ${Math.abs(positionQty)} ${longCallStrike}/${shortCallStrike} call spread`
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
      processSingleLegCallOffsetting(
        putPositions,
        callPositions,
        marketData,
        underlyingPrice,
        maxPotentialProfit,
        totalCostPaid,
        originalSpreadWidth,
        offsettingTrades
      );
      
      console.log(`🔍 Long put offsetting analysis completed`);
      console.log(`  Total offsetting trades found: ${offsettingTrades.length}`);
    }
  });
  
  // Separate trades by cost sign first
  const positiveCostTrades = offsettingTrades.filter(trade => trade.cost >= 0);
  const negativeCostTrades = offsettingTrades.filter(trade => trade.cost < 0);
  console.log(`💰 Cost separation: ${positiveCostTrades.length} positive cost, ${negativeCostTrades.length} negative cost`);
  
  // Apply Pareto optimization to positive cost trades (for sorting only, no filtering)
  let positiveParetoOptimal = [];
  let positiveDominated = [];
  
  // DEBUG: Set this to false to see all trades without Pareto filtering
  const enableParetoOptimization = false;
  
  if (positiveCostTrades.length > 0 && enableParetoOptimization) {
    positiveParetoOptimal = findParetoOptimal(positiveCostTrades);
    positiveDominated = positiveCostTrades.filter(trade => !positiveParetoOptimal.includes(trade));
    
    console.log(`📈 Positive cost trades: ${positiveParetoOptimal.length} Pareto optimal, ${positiveDominated.length} dominated`);
  } else if (positiveCostTrades.length > 0) {
    // Skip Pareto optimization filtering - keep all trades but sort them by quality
    positiveParetoOptimal = [...positiveCostTrades].sort((a, b) => {
      // Sort by combined score (locked profit + total profit potential) descending
      const scoreA = a.lockedProfit + a.totalProfitPotential;
      const scoreB = b.lockedProfit + b.totalProfitPotential;
      return scoreB - scoreA;
    });
    console.log(`📈 Positive cost trades: ${positiveParetoOptimal.length} (sorted by quality, no filtering)`);
  }
  
  // Apply Pareto optimization to negative cost trades (for sorting only, no filtering)
  let negativeParetoOptimal = [];
  let negativeDominated = [];
  
  if (negativeCostTrades.length > 0 && enableParetoOptimization) {
    negativeParetoOptimal = findParetoOptimal(negativeCostTrades);
    negativeDominated = negativeCostTrades.filter(trade => !negativeParetoOptimal.includes(trade));
    
    console.log(`📉 Negative cost trades: ${negativeParetoOptimal.length} Pareto optimal, ${negativeDominated.length} dominated`);
  } else if (negativeCostTrades.length > 0) {
    // Skip Pareto optimization filtering - keep all trades but sort them by quality
    negativeParetoOptimal = [...negativeCostTrades].sort((a, b) => {
      // Sort by combined score (locked profit + total profit potential) descending
      const scoreA = a.lockedProfit + a.totalProfitPotential;
      const scoreB = b.lockedProfit + b.totalProfitPotential;
      return scoreB - scoreA;
    });
    console.log(`📉 Negative cost trades: ${negativeParetoOptimal.length} (sorted by quality, no filtering)`);
  }
  
  // Combine results: Pareto optimal positive cost first, then Pareto optimal negative cost
  const allTrades = [
    ...positiveParetoOptimal,
    ...negativeParetoOptimal
  ];
  
  // Sort to prioritize top 3 highest potential and top 3 highest locked values
  const sortedByPotential = [...allTrades].sort((a, b) => (b.potentialProfit || 0) - (a.potentialProfit || 0));
  const sortedByLocked = [...allTrades].sort((a, b) => (b.lockedProfit || 0) - (a.lockedProfit || 0));
  
  // Get top 3 from each category (avoiding duplicates)
  const top3Potential = [];
  const top3Locked = [];
  const seenTrades = new Set();
  
  // Add top 3 potential trades
  for (const trade of sortedByPotential) {
    const tradeKey = `${trade.description}_${trade.cost}`;
    if (!seenTrades.has(tradeKey) && top3Potential.length < 3) {
      top3Potential.push(trade);
      seenTrades.add(tradeKey);
    }
  }
  
  // Add top 3 locked trades
  for (const trade of sortedByLocked) {
    const tradeKey = `${trade.description}_${trade.cost}`;
    if (!seenTrades.has(tradeKey) && top3Locked.length < 3) {
      top3Locked.push(trade);
      seenTrades.add(tradeKey);
    }
  }
  
  // Add remaining trades (sorted by combined score)
  const remainingTrades = allTrades.filter(trade => {
    const tradeKey = `${trade.description}_${trade.cost}`;
    return !seenTrades.has(tradeKey);
  }).sort((a, b) => (b.lockedProfit + (b.totalProfitPotential || 0)) - (a.lockedProfit + (a.totalProfitPotential || 0)));
  
  // Final sorted trades: top potential + top locked + remaining
  const sortedTrades = [
    ...top3Potential,
    ...top3Locked,
    ...remainingTrades
  ];
  
  console.log(`🏆 Top 3 by potential profit:`, top3Potential.map(t => `${t.description} ($${(t.potentialProfit || 0).toFixed(2)})`));
  console.log(`🔒 Top 3 by locked profit:`, top3Locked.map(t => `${t.description} ($${(t.lockedProfit || 0).toFixed(2)})`));
  console.log(`📊 Remaining trades: ${remainingTrades.length}`);
  
  // Log top optimal trades
  // console.log(`🏆 Best positive cost trades:`);
  // positiveParetoOptimal.slice(0, 3).forEach((trade, index) => {
  //   console.log(`  ${index + 1}. ${trade.description}: Locked $${trade.lockedProfit.toFixed(2)}, Potential $${trade.totalProfitPotential.toFixed(2)}, Total $${(trade.lockedProfit + trade.totalProfitPotential).toFixed(2)}`);
  // });
  
  console.log('🎯 Found offsetting trades:', sortedTrades);
  console.log(`📊 Total offsetting opportunities: ${sortedTrades.length}`);
  
  // Debug: Show sorting results (no filtering applied)
  const totalFound = offsettingTrades.length;
  const totalSorted = sortedTrades.length;
  
  console.log(`📊 Sorted ${totalSorted} trades by quality (no filtering applied)`);
  console.log(`🔍 Best trade: ${sortedTrades[0]?.description} (Score: ${(sortedTrades[0]?.lockedProfit + sortedTrades[0]?.totalProfitPotential).toFixed(2)})`);
  console.log(`🔍 Worst trade: ${sortedTrades[sortedTrades.length-1]?.description} (Score: ${(sortedTrades[sortedTrades.length-1]?.lockedProfit + sortedTrades[sortedTrades.length-1]?.totalProfitPotential).toFixed(2)})`);
  
  // Return the final sorted offsetting trades
  console.log('🔍 Returning offsetting trades array:', sortedTrades);
  return sortedTrades;
}

// Find Pareto optimal trades (not dominated by any other trade)
function findParetoOptimal(trades) {
  const paretoOptimal = [];
  
  trades.forEach(trade => {
    let isDominated = false;
    
    for (const other of trades) {
      if (other !== trade &&
          other.lockedProfit >= trade.lockedProfit &&
          other.totalProfitPotential >= trade.totalProfitPotential &&
          (other.lockedProfit > trade.lockedProfit || other.totalProfitPotential > trade.totalProfitPotential)) {
        isDominated = true;
        break;
      }
    }
    
    if (!isDominated) {
      paretoOptimal.push(trade);
    }
  });
  
  console.log(`🎯 Pareto analysis: ${paretoOptimal.length} optimal trades out of ${trades.length} total`);
  
  // Sort Pareto optimal trades by combined score (locked + potential)
  return paretoOptimal.sort((a, b) => {
    const scoreA = a.lockedProfit + a.totalProfitPotential;
    const scoreB = b.lockedProfit + b.totalProfitPotential;
    return scoreB - scoreA;
  });
}

// Formats a bid/ask price for display: 1 decimal place once the price is
// $10 or more (extra precision isn't meaningful there), otherwise 2.
function formatOptionPrice(value) {
  return value >= 10 ? value.toFixed(1) : value.toFixed(2);
}

// Returns a CSS class for color-coding a volume cell by liquidity: light red
// above 500, progressively darker at 1000/1500/2000.
function getVolumeColorClass(volume) {
  if (volume > 2000) return 'volume-darkest';
  if (volume > 1500) return 'volume-deep';
  if (volume > 1000) return 'volume-medium';
  if (volume > 500) return 'volume-light';
  return '';
}

// Note: testSchwabConnection function is now in schwab-api.js
function updateOptionsChain(options) {
  console.log('🎨 Updating options chain UI with', options.length, 'options');
  
  // Store current options data for real-time updates
  currentOptionsData = options;
  console.log('💾 Stored current options data:', currentOptionsData.length, 'options');
  
  const chainElement = document.getElementById('options-chain');
  console.log('🔍 Chain element found:', !!chainElement);
  
  if (chainElement) {
    console.log('📋 Options array length:', options.length);
    console.log('📊 First option sample:', options[0]);
    
    if (options.length > 0) {
      // Get the expiration date from the first option (they're all from the same date)
      let expirationDate = 'Unknown';
      if (options.length > 0 && options[0].expirationDate) {
        // Format the date nicely
        const date = new Date(options[0].expirationDate);
        expirationDate = date.toLocaleDateString('en-US', { 
          month: 'short', 
          day: 'numeric', 
          year: 'numeric' 
        });
        
        // console.log(`🔍 DEBUG: UI expiration display:`);
        // console.log(`   Raw expirationDate from options[0]: ${options[0].expirationDate}`);
        // console.log(`   Formatted expirationDate: ${expirationDate}`);
        // console.log(`   Total options: ${options.length}`);
        // console.log(`   First option details:`, options[0]);
      }
      
      // Group options by strike price
      const strikeGroups = new Map();
      
      options.forEach(option => {
        const strike = option.strike;
        if (!strikeGroups.has(strike)) {
          strikeGroups.set(strike, {});
        }
        strikeGroups.get(strike)[option.type] = option;
      });
      
      // Group fullOptionArray by strike and type to get position quantities
      const positionMap = new Map();
      if (fullOptionArray && fullOptionArray.length > 0) {
        fullOptionArray.forEach(option => {
          const key = `${option.type}${option.strike}`;
          if (!positionMap.has(key)) {
            positionMap.set(key, 0);
          }
          positionMap.set(key, positionMap.get(key) + option.qty);
        });
      }
      
      // Sort strikes
      const sortedStrikes = Array.from(strikeGroups.keys()).sort((a, b) => a - b);
      
      // Get current underlying price from the UI
      const priceElement = document.getElementById('underlying-price');
      let underlyingPrice = 0;
      if (priceElement) {
        const priceText = priceElement.textContent;
        underlyingPrice = parseFloat(priceText.replace('$', '')) || 0;
      }
      console.log('💰 Current underlying price:', underlyingPrice);
      
      // Create HTML table with calls and puts side by side
      let html = `<div class="options-header">`;
      html += `<h3>Options Chain - ${expirationDate}</h3>`;
      html += `</div>`;
      
      // Add selected positions display area
      html += `<div id="selected-positions-display" class="selected-positions-container">`;
      html += '<div class="selected-positions-empty">Click bid/ask cells to select positions</div>';
      html += `</div>`;
      
      // Preserve current selections before redrawing
      preserveTableSelections();
      
      html += '<table class="options-table"><thead><tr>';
      html += '<th colspan="5" class="call-header">CALLS</th>';
      html += '<th class="strike-header">STRIKE</th>';
      html += '<th colspan="5" class="put-header">PUTS</th>';
      html += '</tr><tr>';
      html += '<th>OI</th><th>Vol</th><th>Bid</th><th>Ask</th>';
      html += '<th>P</th><th></th><th>P</th>';
      html += '<th>Bid</th><th>Ask</th><th>Vol</th><th>OI</th>';
      html += '</tr></thead><tbody>';
      
      sortedStrikes.forEach(strike => {
        const group = strikeGroups.get(strike);
        const call = group.c;
        const put = group.p;
        
        // Get position quantities for this strike
        const callPositionKey = `c${strike}`;
        const putPositionKey = `p${strike}`;
        const callPositionQty = positionMap.get(callPositionKey) || 0;
        const putPositionQty = positionMap.get(putPositionKey) || 0;
        
        // Determine if options are in-the-money
        const callITM = strike < underlyingPrice; // Calls below underlying are ITM
        const putITM = strike > underlyingPrice;  // Puts above underlying are ITM
        
        html += '<tr>';
        
        // Call side (left)
        if (call) {
          const callClass = callITM ? 'itm-cell' : '';
          html += `<td class="${callClass}">${call.openInterest || 0}</td>`;
          html += `<td class="${callClass} ${getVolumeColorClass(call.volume || 0)}">${call.volume || 0}</td>`;
          html += `<td class="${callClass} bid-cell clickable" data-strike="${strike}" data-type="c" data-price="${call.bid.toFixed(2)}">${formatOptionPrice(call.bid)}</td>`;
          html += `<td class="${callClass} ask-cell clickable" data-strike="${strike}" data-type="c" data-price="${call.ask.toFixed(2)}">${formatOptionPrice(call.ask)}</td>`;
        } else {
          html += '<td>-</td><td>-</td><td>-</td><td>-</td>';
        }
        
        // Strike (middle) with P columns showing positions
        const callPClass = callPositionQty > 0 ? 'position-long' : callPositionQty < 0 ? 'position-short' : 'strike-cell-p';
        const putPClass = putPositionQty > 0 ? 'position-long' : putPositionQty < 0 ? 'position-short' : 'strike-cell-p';
        
        html += `<td class="${callPClass}">${callPositionQty !== 0 ? callPositionQty : ''}</td>`; // P column for calls
        html += `<td class="strike-cell">${strike.toFixed(1)}</td>`; // Strike
        html += `<td class="${putPClass}">${putPositionQty !== 0 ? putPositionQty : ''}</td>`; // P column for puts
        
        // Put side (right)
        if (put) {
          const putClass = putITM ? 'itm-cell' : '';
          html += `<td class="${putClass} bid-cell clickable" data-strike="${strike}" data-type="p" data-price="${put.bid.toFixed(2)}">${formatOptionPrice(put.bid)}</td>`;
          html += `<td class="${putClass} ask-cell clickable" data-strike="${strike}" data-type="p" data-price="${put.ask.toFixed(2)}">${formatOptionPrice(put.ask)}</td>`;
          html += `<td class="${putClass} ${getVolumeColorClass(put.volume || 0)}">${put.volume || 0}</td>`;
          html += `<td class="${putClass}">${put.openInterest || 0}</td>`;
        } else {
          html += '<td>-</td><td>-</td><td>-</td><td>-</td>';
        }
        
        html += '</tr>';
      });
      
      html += '</tbody></table>';

      // Insert options chain HTML (without offsetting trades)
      chainElement.innerHTML = html;
      console.log('✅ Options chain updated in UI');
      
      // Set up click and touch handlers for bid/ask cells
      const clickableCells = chainElement.querySelectorAll('.clickable');
      clickableCells.forEach(cell => {
        // Mouse events for desktop
        cell.addEventListener('click', (event) => handleOptionCellClick(event, options));
        
        // Touch events for mobile devices (only touchstart to prevent double-firing)
        cell.addEventListener('touchstart', function(event) {
          // Additional verification using elementFromPoint for zoomed scenarios
          if (event.touches && event.touches.length > 0) {
            const touch = event.touches[0];
            const element = document.elementFromPoint(touch.clientX, touch.clientY);
            if (element !== this && !this.contains(element)) {
              console.log('🚫 Touch not on target element, ignoring');
              return;
            }
          }
          
          handleOptionCellClick.call(this, event, options);
        }, { passive: false });
      });
      
      // Render curated hedge candidates (see hedge-strategy-ui.js) in place of
      // the old exhaustive server+client offsetting search.
      updateHedgeCandidatesUI();

      // Restore selections after table is rendered
      restoreTableSelections();
      
      // Update selected positions display with new options data
      if (selectedTablePositions.size > 0) {
        console.log('🔄 Updating selected positions display with new options data');
        console.log('📊 Options data length:', options.length);
        console.log('📋 Selected positions count:', selectedTablePositions.size);
        console.log('💰 Sample option data:', options[0]);
        console.log('🎯 Selected positions:', Array.from(selectedTablePositions.keys()));
        updateSelectedPositionsDisplay(options);
      } else {
        console.log('📝 No selected positions to update');
      }
    } else {
      console.log('❌ No options to display');
      chainElement.innerHTML = '<p>No options data available</p>';
    }
  } else {
    console.log('❌ Chain element not found in DOM');
  }
}

// Toggle live data updates
function toggleLiveData() {
  // Get the symbol from the input field
  const symbolInput = document.getElementById('symbol-input');
  if (symbolInput) {
    currentSymbol = symbolInput.value.trim().toUpperCase();
    // Save the symbol for next time
    saveCurrentSymbol(currentSymbol);
  }
  
  if (!currentSymbol) {
    alert('Please enter a symbol');
    return;
  }
  
  // Auto-test connection if not already connected
  if (!schwabConnected) {
    console.log('🔄 Auto-testing connection before starting live data...');
    testSchwabConnection().then(() => {
      // Only proceed with live data if connection was successful
      if (schwabConnected) {
        proceedWithLiveData();
      } else {
        console.log('❌ Cannot start live data - connection failed');
      }
    });
  } else {
    proceedWithLiveData();
  }
}

// Separate function to handle live data toggle after connection check
function proceedWithLiveData() {
  liveDataEnabled = !liveDataEnabled;
  const toggleButton = document.getElementById('live-data-toggle');
  
  if (toggleButton) {
    toggleButton.textContent = liveDataEnabled ? 'Stop Live Data' : 'Start Live Data';
    toggleButton.className = liveDataEnabled ? 'button-stop' : 'button-start';
  }
  
  if (liveDataEnabled && currentSymbol) {
    startLiveDataUpdates();
  } else {
    stopLiveDataUpdates();
  }
}

// Start live data updates
let liveDataInterval = null;
function startLiveDataUpdates() {
  if (liveDataInterval) {
    clearInterval(liveDataInterval);
  }
  
  // Initial candle analysis update
  if (typeof startCandleAnalysisUpdates === 'function') {
    startCandleAnalysisUpdates(currentSymbol, 10000); // Update every 10 seconds to match main data
  }
  
  // Update every 10 seconds
  liveDataInterval = setInterval(() => {
    console.log('⏰ Live data interval check:', { liveDataEnabled, currentSymbol, schwabConnected });
    if (liveDataEnabled && currentSymbol && schwabConnected) {
      console.log('🔄 Triggering live data update for:', currentSymbol);
      updateCalculatorWithLiveData(currentSymbol);
    } else {
      console.log('⏸️ Skipping live data update - conditions not met');
    }
  }, liveDataIntervalDuration);

  // kick it off immediately
  if (liveDataEnabled && currentSymbol && schwabConnected) {
    updateCalculatorWithLiveData(currentSymbol);
  }
}

// Stop live data updates
function stopLiveDataUpdates() {
  if (liveDataInterval) {
    clearInterval(liveDataInterval);
    liveDataInterval = null;
  }

  // Stop candle analysis updates
  if (typeof stopCandleAnalysisUpdates === 'function') {
    stopCandleAnalysisUpdates();
  }

  // Don't let stale chain data be reused (e.g. by portfolio risk analysis)
  // once live data is turned off.
  lastLiveChainData = null;
}

// Initialize slider event listeners
function initSlider() {
  const slider = document.getElementById('optionRange');
  const showAllBtn = document.getElementById('showAllBtn');
  
  if (slider) {
    slider.addEventListener('input', updateChartWithSlider);
  }
  
  if (showAllBtn) {
    showAllBtn.addEventListener('click', showAllOptions);
  }
}

// Use global utility functions (for file:// protocol compatibility)
// Functions are available via window object from option-utils.js and other files

// Initialize slider when the DOM is loaded
document.addEventListener('DOMContentLoaded', async () => {
  initSlider();
  
  // Set up focus/blur handlers for textInput to prevent updates while typing
  const textInput = document.getElementById('textInput');
  if (textInput) {
    textInput.addEventListener('focus', () => {
      textInputHasFocus = true;
      console.log('✏️ textInput focused - updates paused');
    });
    
    textInput.addEventListener('blur', () => {
      textInputHasFocus = false;
      console.log('✅ textInput blurred - updates resumed');
    });
  }
  
  // Load appropriate input on page load
  const symbol = document.getElementById('symbol-input')?.value.trim();
  const expiration = document.getElementById('expiration-dropdown')?.value;
  restoreAppropriateInput(symbol, expiration);
});

// Helper function to restore appropriate input based on symbol and expiration
function restoreAppropriateInput(symbol, expiration) {
  // console.log(`🔍 restoreAppropriateInput called with symbol: "${symbol}", expiration: "${expiration}"`);
  
  const textInput = document.getElementById('textInput');
  if (!textInput) {
    // console.log('❌ textInput element not found');
    return;
  }
  
  if (symbol && expiration) {
    // Try to get symbol+expiration specific input (case-insensitive)
    const symbolExpirationKey = `${symbol.toUpperCase()}-${expiration}`;
    const specificInput = localStorage.getItem(symbolExpirationKey);
    
    // console.log(`🔍 Checking specific key: ${symbolExpirationKey}`);
    // console.log(`🔍 Found specific input: ${specificInput ? 'YES' : 'NO'}`);
    
    if (specificInput) {
      textInput.value = specificInput;
      // console.log(`📥 Restored specific input for ${symbol} ${expiration} from key: ${symbolExpirationKey}`);
      return;
    }
  }
  
  // Fallback to default saved input
  const defaultInput = localStorage.getItem('savedOptionInput');
  // console.log(`🔍 Checking default key: savedOptionInput`);
  // console.log(`🔍 Found default input: ${defaultInput ? 'YES' : 'NO'}`);
  
  if (defaultInput) {
    textInput.value = defaultInput;
    // console.log('📥 Restored default saved input');
  } else {
    // console.log('⚠️ No saved input found');
  }
}

// Debug function to show all stored option inputs
function debugStoredInputs() {
  console.log('🔍 Debug: Stored option inputs in localStorage:');
  const keys = Object.keys(localStorage).filter(key => 
    key === 'savedOptionInput' || (key.includes('-') && key.length > 10 && !key.includes('schwab') && !key.includes('lastSymbol'))
  );
  keys.forEach(key => {
    const type = key === 'savedOptionInput' ? '(Default)' : '(Symbol-Expiration)';
    console.log(`  ${key} ${type}: ${localStorage.getItem(key)}`);
  });
  console.log('💡 Tip: Symbol keys are stored in UPPERCASE for case-insensitive matching');
}

// Test function for manual debugging
function testInputRestoration() {
  console.log('🧪 Testing input restoration...');
  
  // Test current values
  const symbol = document.getElementById('symbol-input')?.value.trim();
  const expiration = document.getElementById('expiration-dropdown')?.value;
  const currentInput = document.getElementById('textInput')?.value;
  
  console.log(`Current state:`);
  console.log(`  Symbol: "${symbol}"`);
  console.log(`  Expiration: "${expiration}"`);
  console.log(`  Current input: "${currentInput}"`);
  
  // Show all stored inputs
  debugStoredInputs();
  
  // Test restoration
  if (typeof restoreAppropriateInput === 'function') {
    console.log('🧪 Calling restoreAppropriateInput...');
    restoreAppropriateInput(symbol, expiration);
  } else {
    console.log('❌ restoreAppropriateInput function not found');
  }
}

// Process input from the text input field
function processInput() {

  const inputText = document.getElementById('textInput').value;
  const outputDiv = document.getElementById('output');
  
  // Clear previous output
  outputDiv.innerHTML = '';
  
  // Store the input in local storage with default key
  localStorage.setItem('savedOptionInput', inputText);
  
  // Also store with symbol+expiration key if applicable
  const symbol = document.getElementById('symbol-input')?.value.trim();
  const expiration = document.getElementById('expiration-dropdown')?.value;
  if (symbol && expiration) {
    const symbolExpirationKey = `${symbol.toUpperCase()}-${expiration}`;
    localStorage.setItem(symbolExpirationKey, inputText);
    // console.log(`💾 Saved input for ${symbol} ${expiration} with key: ${symbolExpirationKey}`);
  }

  // Reset API call tracking since positions changed
  if (typeof resetApiCallTracking === 'function') {
    resetApiCallTracking();
  }

  try {
    // Clean the input text by removing newlines and other whitespace that could break JSON parsing
    const cleanInputText = inputText
      .replace(/\r\n|\r|\n/g, '')  // Remove all newline characters
      .replace(/\s+/g, ' ')      // Replace multiple spaces with a single space
      .trim();                    // Trim leading/trailing spaces
      
    const processedJSON = JSON.parse(cleanInputText);
    console.log(processedJSON);
    
    // Process options array, combining quantities for same type and strike
    const optionMap = new Map();
    
    // Helper function to process a single option string
    const processOptionString = (str) => {
      // Check for standalone cost adjustment
      const costMatch = str.match(/^@([+-]?\d+(?:\.\d+)?)$/i);
      if (costMatch) {
        return {
          qty: 0,
          type: null,
          strike: null,
          costAdjustment: parseFloat(costMatch[1])
        };
      }
      
      // Check for option with optional cost adjustment
      const match = str.match(/^([+-]?\d+)([cp])(\d+)(?:@([+-]?\d+(?:\.\d+)?))?$/i);
      if (!match) {
        throw new Error(`Invalid option format: ${str}. Expected format like 1c100, -1p110, 1c100@2000, or @2000`);
      }
      return {
        qty: parseInt(match[1], 10),
        type: match[2].toLowerCase(),
        strike: parseFloat(match[3]),
        costAdjustment: match[4] ? parseFloat(match[4]) : 0
      };
    };
    
    // Process the input based on its type
    let totalCostAdjustment = 0;
    
    if (typeof processedJSON.optionArray === 'string') {
      // Handle comma-separated string format
      processedJSON.optionArray
        .split(',')
        .map(optionStr => optionStr.trim())
        .filter(optionStr => optionStr)
        .forEach(optionStr => {
          const option = processOptionString(optionStr);
          totalCostAdjustment += option.costAdjustment;
          
          // Only add to optionMap if it's a real option (not standalone cost adjustment)
          if (option.qty !== 0 && option.type && option.strike !== null) {
            const key = `${option.type}${option.strike}`;
            if (optionMap.has(key)) {
              optionMap.get(key).qty += option.qty;
            } else {
              optionMap.set(key, { ...option });
            }
          }
        });
    } else if (Array.isArray(processedJSON.optionArray)) {
      // Handle array format (strings or objects)
      processedJSON.optionArray.forEach(option => {
        let processedOption;
        
        if (typeof option === 'string') {
          processedOption = processOptionString(option.trim());
          totalCostAdjustment += processedOption.costAdjustment;
        } else if (typeof option === 'object' && option !== null) {
          processedOption = {
            qty: typeof option.qty === 'string' ? 
              parseInt(option.qty.trim(), 10) : (option.qty || 1),
            type: option.type?.toString()?.toLowerCase()?.trim(),
            strike: typeof option.strike === 'string' ? 
              parseFloat(option.strike.trim()) : option.strike,
            costAdjustment: option.costAdjustment ? parseFloat(option.costAdjustment) : 0
          };
          totalCostAdjustment += processedOption.costAdjustment;
          
          // Validate the processed option (skip validation for standalone cost adjustments)
          if (processedOption.type && (!['c', 'p'].includes(processedOption.type) || 
              isNaN(processedOption.strike))) {
            throw new Error(`Invalid option object: ${JSON.stringify(option)}`);
          }
        } else {
          throw new Error(`Invalid option format: ${JSON.stringify(option)}`);
        }
        
        // Only add to optionMap if it's a real option (not standalone cost adjustment)
        if (processedOption.qty !== 0 && processedOption.type && processedOption.strike !== null) {
          const key = `${processedOption.type}${processedOption.strike}`;
          if (optionMap.has(key)) {
            optionMap.get(key).qty += processedOption.qty;
          } else {
            optionMap.set(key, processedOption);
          }
        }
      });
    } else {
      throw new Error('optionArray must be either a string or an array');
    }
    
    // Convert map to array and filter out zero quantities
    const combinedOptions = Array.from(optionMap.values())
      .filter(opt => opt.qty !== 0);
      
    if (combinedOptions.length === 0) {
      throw new Error('No valid options provided in optionArray');
    }

    // Store the combined options for chart rendering
    combinedOptionMap = new Map(combinedOptions.map(opt => [`${opt.type}${opt.strike}`, { ...opt }]));
    
    // Store the original uncombined options in the order they were entered
    fullOptionArray = [];
    if (typeof processedJSON.optionArray === 'string') {
      fullOptionArray = processedJSON.optionArray
        .split(',')
        .map(optionStr => optionStr.trim())
        .filter(optionStr => optionStr)
        .map(optionStr => processOptionString(optionStr));
    } else if (Array.isArray(processedJSON.optionArray)) {
      processedJSON.optionArray.forEach(option => {
        if (typeof option === 'string') {
          fullOptionArray.push(processOptionString(option.trim()));
        } else if (typeof option === 'object' && option !== null) {
          fullOptionArray.push({
            qty: typeof option.qty === 'string' ? 
              parseInt(option.qty.trim(), 10) : (option.qty || 1),
            type: option.type?.toString()?.toLowerCase()?.trim(),
            strike: typeof option.strike === 'string' ? 
              parseFloat(option.strike.trim()) : option.strike
          });
        }
      });
    }
    
    // Process tempOptionArray if it exists
    let tempOptionArray = [];
    if (processedJSON.tempOptionArray) {
      if (typeof processedJSON.tempOptionArray === 'string') {
        tempOptionArray = processedJSON.tempOptionArray
          .split(',')
          .map(optionStr => optionStr.trim())
          .filter(optionStr => optionStr)
          .map(optionStr => processOptionString(optionStr));
      } else if (Array.isArray(processedJSON.tempOptionArray)) {
        processedJSON.tempOptionArray.forEach(option => {
          if (typeof option === 'string') {
            tempOptionArray.push(processOptionString(option.trim()));
          } else if (typeof option === 'object' && option !== null) {
            tempOptionArray.push({
              qty: typeof option.qty === 'string' ? 
                parseInt(option.qty.trim(), 10) : (option.qty || 1),
              type: option.type?.toString()?.toLowerCase()?.trim(),
              strike: typeof option.strike === 'string' ? 
                parseFloat(option.strike.trim()) : option.strike,
              costAdjustment: option.costAdjustment ? parseFloat(option.costAdjustment) : 0
            });
          }
        });
      }
    }
    
    // Process syntheticPosition if it exists
    syntheticPositionArray = [];
    if (processedJSON.syntheticPosition) {
      console.log('🎯 Found syntheticPosition in input:', processedJSON.syntheticPosition);
      if (typeof processedJSON.syntheticPosition === 'string') {
        syntheticPositionArray = processedJSON.syntheticPosition
          .split(',')
          .map(optionStr => optionStr.trim())
          .filter(optionStr => optionStr)
          .map(optionStr => processOptionString(optionStr));
      } else if (Array.isArray(processedJSON.syntheticPosition)) {
        processedJSON.syntheticPosition.forEach(option => {
          if (typeof option === 'string') {
            syntheticPositionArray.push(processOptionString(option.trim()));
          } else if (typeof option === 'object' && option !== null) {
            syntheticPositionArray.push({
              qty: typeof option.qty === 'string' ? 
                parseInt(option.qty.trim(), 10) : (option.qty || 1),
              type: option.type?.toString()?.toLowerCase()?.trim(),
              strike: typeof option.strike === 'string' ? 
                parseFloat(option.strike.trim()) : option.strike,
              costAdjustment: option.costAdjustment ? parseFloat(option.costAdjustment) : 0
            });
          }
        });
      }
      console.log('🎯 Parsed syntheticPositionArray:', syntheticPositionArray);
    } else {
      console.log('📊 No syntheticPosition found, will use fullOptionArray for offsetting analysis');
    }
    
    fullCost = (processedJSON.cost || 0) + totalCostAdjustment;
    const rangeStr = processedJSON.range;
    if (rangeStr != null && typeof rangeStr !== 'string') {
      throw new Error('range must be a string like "500-1000"');
    }
    if (typeof rangeStr === 'string' && rangeStr.trim() !== '') {
      const rangeMatch = rangeStr.match(/^\s*(-?\d+(?:\.\d+)?)\s*-\s*(-?\d+(?:\.\d+)?)\s*$/);
      if (!rangeMatch) {
        throw new Error('Invalid range format. Expected "minStrike-maxStrike" (example: "500-1000")');
      }
      fullMinStrike = parseFloat(rangeMatch[1]);
      fullMaxStrike = parseFloat(rangeMatch[2]);
      if (!Number.isFinite(fullMinStrike) || !Number.isFinite(fullMaxStrike)) {
        throw new Error('Invalid range values. minStrike and maxStrike must be numbers.');
      }
      if (fullMinStrike >= fullMaxStrike) {
        throw new Error('Invalid range values. minStrike must be less than maxStrike.');
      }
    } else {
      const strikes = [];
      combinedOptions.forEach(opt => strikes.push(opt.strike));
      tempOptionArray.forEach(opt => strikes.push(opt.strike));

      const finiteStrikes = strikes.filter(s => Number.isFinite(s));
      if (finiteStrikes.length === 0) {
        throw new Error('Unable to infer range: no valid strikes found in optionArray/tempOptionArray');
      }

      const minStrikeProvided = Math.min(...finiteStrikes);
      const maxStrikeProvided = Math.max(...finiteStrikes);
      fullMinStrike = minStrikeProvided - 50;
      fullMaxStrike = maxStrikeProvided + 50;
    }
    fullStrikeIncrement = processedJSON.inc || 10;

    // Initialize the slider
    const sliderContainer = document.getElementById('sliderContainer');
    const slider = document.getElementById('optionRange');
    
    if (fullOptionArray.length > 1) {
      // Show the slider if there are multiple options
      sliderContainer.style.display = 'block';
      slider.min = 1;
      slider.max = fullOptionArray.length;
      slider.value = fullOptionArray.length; // Default to showing all options
      document.getElementById('optionCount').textContent = fullOptionArray.length;
    } else {
      // Hide the slider if there's only one option
      sliderContainer.style.display = 'none';
    }
    
    // Calculate and display the portfolio values with all options combined
    const data = ChartModule.calculatePortfolioValueAtExpiration(
      combinedOptions,
      fullMinStrike,
      fullMaxStrike,
      fullStrikeIncrement
    );
    
    // Calculate the combined portfolio values (optionArray + tempOptionArray)
    let combinedData = [];
    let combinedCost = fullCost;
    
    if (tempOptionArray.length > 0) {
      // Create a map of all options (from both arrays)
      const allOptionsMap = new Map();
      
      // First add all options from the main optionArray
      combinedOptions.forEach(option => {
        const key = `${option.type}${option.strike}`;
        allOptionsMap.set(key, { ...option });
      });
      
      // Then add or combine with options from tempOptionArray
      tempOptionArray.forEach(option => {
        const key = `${option.type}${option.strike}`;
        if (allOptionsMap.has(key)) {
          allOptionsMap.get(key).qty += option.qty;
        } else {
          allOptionsMap.set(key, { ...option });
        }
      });
      
      const allOptions = Array.from(allOptionsMap.values());
      
      // Calculate combined cost (fullCost + temp position costs)
      combinedCost = fullCost;
      tempOptionArray.forEach(option => {
        if (option.costAdjustment) {
          combinedCost += option.costAdjustment;
        }
      });
      
      // Calculate portfolio values for the combined options
      combinedData = ChartModule.calculatePortfolioValueAtExpiration(
        allOptions,
        fullMinStrike,
        fullMaxStrike,
        fullStrikeIncrement
      );
    }
    
    // Get current underlying price from the UI for chart
    const priceElement = document.getElementById('underlying-price');
    let underlyingPrice = 0;
    if (priceElement) {
      const priceText = priceElement.textContent;
      underlyingPrice = parseFloat(priceText.replace('$', '')) || 0;
    }
    console.log('💰 Using underlying price for chart:', underlyingPrice);
    
    // Draw the chart with both datasets if there's combined data, otherwise just the main data
    if (combinedData.length > 0) {
      ChartModule.drawChart(data, fullCost, fullOptionArray, combinedData, underlyingPrice, combinedCost);
    } else {
      ChartModule.drawChart(data, fullCost, fullOptionArray, null, underlyingPrice);
    }
    
    // Display the processed output
    const formatCurve = (curve) => curve
      .map(p => {
        const diff = p.totalIntrinsicValue - fullCost;
        const diffStr = diff >= 0 ? `+${diff.toFixed(2)}` : diff.toFixed(2);
        return `${p.closingPrice}: ${p.totalIntrinsicValue} (${diffStr})`;
      })
      .join('\n');

    // Find key points on the main curve
    const keyPoints = ChartModule.findKeyPointsOnCurve(data, fullCost);
    const formatKeyPoints = (points) => points
      .map(p => `${p.description}: $${p.closingPrice.toFixed(2)} (Value: $${p.totalIntrinsicValue.toFixed(2)})`)
      .join('\n');

    // Format positions list: strike (+/- qty), sorted by strike low to high, calls before puts
    const formatPositionsList = (options) => {
      // Group by strike
      const strikeGroups = new Map();
      options.forEach(opt => {
        if (!strikeGroups.has(opt.strike)) {
          strikeGroups.set(opt.strike, { calls: [], puts: [] });
        }
        if (opt.type === 'c') {
          strikeGroups.get(opt.strike).calls.push(opt);
        } else {
          strikeGroups.get(opt.strike).puts.push(opt);
        }
      });
      
      // Sort strikes low to high
      const sortedStrikes = Array.from(strikeGroups.keys()).sort((a, b) => a - b);
      
      // Build formatted list
      const lines = [];
      sortedStrikes.forEach(strike => {
        const group = strikeGroups.get(strike);
        
        // Calls first
        group.calls.forEach(opt => {
          const sign = opt.qty >= 0 ? '+' : '';
          lines.push(`${strike} (${sign}${opt.qty} Call)`);
        });
        
        // Then puts
        group.puts.forEach(opt => {
          const sign = opt.qty >= 0 ? '+' : '';
          lines.push(`${strike} (${sign}${opt.qty} Put)`);
        });
      });
      
      return lines.join('<br>');
    };

    let outputStr = `
      <strong>Processed Output:</strong><br>
      <strong>Position Count:</strong> ${fullOptionArray.length}<br>
      <strong>Total Cost:</strong> $${fullCost.toFixed(2)}<br><br>
      <strong>Value Curve:</strong><br><br>
    `;

    if (keyPoints.length > 0) {
      outputStr += `
        <strong>Key Points on Curve (optionArray):</strong><br>
        <pre>${formatKeyPoints(keyPoints)}</pre>
      `;
    }

    outputStr += `
      <pre>${formatCurve(data)}</pre>
    `;

    if (combinedData.length > 0) {

      // Find key points on combined curve as well
      const combinedKeyPoints = ChartModule.findKeyPointsOnCurve(combinedData, fullCost);
      if (combinedKeyPoints.length > 0) {
        outputStr += `
          <strong>Key Points on Combined Curve (optionArray + tempOptionArray):</strong><br>
          <pre>${formatKeyPoints(combinedKeyPoints)}</pre>
        `;
      }

      outputStr += `
        <pre>${formatCurve(combinedData)}</pre>
      `;
    }

    outputStr += `
      <strong>Positions:</strong><br><br>
      ${formatPositionsList(fullOptionArray)}<br>
    `;

    outputDiv.innerHTML = outputStr;

    // Keep Portfolio Risk in sync with whatever position was just submitted,
    // not just whatever was loaded when the panel was last opened.
    if (typeof analyzePortfolioRiskUI === 'function') {
      analyzePortfolioRiskUI();
    }

  } catch (error) {
    console.error('Error processing input:', error);
    outputDiv.innerHTML = `
<strong>Error:</strong> ${error.message}<br><br>
<strong>Expected format:</strong><br>
<pre>{
  "cost": 20000,
  "range": "500-1000",
  "inc": 10,
  "optionArray": "
1c620,-1c820,@2000,
1c620,-1c800,@-1000,
1p960,-1p800,
",
"tempOptionArray": "
1c650,-1c750,
"
}"</pre>
      Or as a comma-separated string in the optionArray: <code>"1c22720,1c22740,1p22860,1p22820"</code>                                                                                         `;
  }
}

// Initialize the page when DOM is ready
document.addEventListener('DOMContentLoaded', function() {
  console.log('🚀 Page loaded, initializing...');
  restoreLastSymbol();
  initSlider();
  
  // Auto-test connection on page load
  console.log('🔄 Auto-testing connection on page load...');
  testSchwabConnection();
  
  // Add event listener to save symbol when input changes
  const symbolInput = document.getElementById('symbol-input');
  if (symbolInput) {
    symbolInput.addEventListener('input', function() {
      const symbol = this.value.trim().toUpperCase();
      if (symbol) {
        saveCurrentSymbol(symbol);
      }
    });
  }
});

// Export functions for use in other files (global approach)
window.restoreAppropriateInput = restoreAppropriateInput;
window.debugStoredInputs = debugStoredInputs;
window.testInputRestoration = testInputRestoration;
window.processInput = processInput;
window.handleOptionCellClick = handleOptionCellClick;
window.updateSelectedPositionsDisplay = updateSelectedPositionsDisplay;
window.clearSelectedPositions = clearSelectedPositions;
window.clickOffsettingTrade = clickOffsettingTrade;
window.findAndClickOptionCell = findAndClickOptionCell;
window.updateTextInputWithTempPositions = updateTextInputWithTempPositions;
