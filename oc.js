// Global variables to store the full option data
let fullOptionArray = []; // Stores the original, uncombined options in the order they were entered
let combinedOptionMap = new Map(); // Stores the combined options for chart rendering
let fullCost = 0;
let fullMinStrike = 0;
let fullMaxStrike = 0;
let fullStrikeIncrement = 0;

// Schwab API integration variables
let schwabConnected = false;
let currentSymbol = '';
let liveDataEnabled = false;

// Restore last used symbol on page load
function restoreLastSymbol() {
  const lastSymbol = localStorage.getItem('lastSymbol');
  if (lastSymbol) {
    const symbolInput = document.getElementById('symbol-input');
    if (symbolInput) {
      symbolInput.value = lastSymbol;
      currentSymbol = lastSymbol;
      console.log('🔄 Restored last symbol:', lastSymbol);
    }
  }
}

// Save current symbol to localStorage
function saveCurrentSymbol(symbol) {
  if (symbol) {
    localStorage.setItem('lastSymbol', symbol);
    console.log('💾 Saved symbol:', symbol);
  }
}


// Function to update the chart based on slider value
function updateChartWithSlider() {
  const slider = document.getElementById('optionRange');
  const count = parseInt(slider.value);
  document.getElementById('optionCount').textContent = count;
  
  // Get a subset of the original options based on the slider value
  const visibleOptions = fullOptionArray.slice(0, count);
  
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
  
  // Calculate portfolio values with the filtered and combined options
  const data = ChartModule.calculatePortfolioValueAtExpiration(
    visibleCombinedOptions,
    fullMinStrike,
    fullMaxStrike,
    fullStrikeIncrement
  );
  
  // Draw the chart with the filtered data but show all original positions in the labels
  ChartModule.drawChart(data, fullCost, visibleOptions);
}

// Function to show all options
function showAllOptions() {
  const slider = document.getElementById('optionRange');
  slider.value = fullOptionArray.length;
  document.getElementById('optionCount').textContent = fullOptionArray.length;
  updateChartWithSlider();
}

// Schwab API Integration Functions

// Initialize Schwab API connection
async function initializeSchwab() {
  try {
    // The proxy server handles authentication automatically
    console.log('Schwab service ready - authentication handled by proxy server');
    return true;
  } catch (error) {
    console.error('Error initializing Schwab API:', error);
    updateSchwabStatus('Error', 'error');
    return false;
  }
}

// Test Schwab API connection
async function testSchwabConnection() {
  console.log('Testing Schwab API connection...');
  updateSchwabStatus('Testing...');
  
  try {
    // Test with a simple quote request
    const response = await fetch('http://localhost:3001/api/v1/marketdata/quotes?symbols=SPY');
    
    if (response.ok) {
      const data = await response.json();
      console.log('✅ Schwab API connection successful');
      updateSchwabStatus('Connected');
      schwabConnected = true;
    } else {
      console.error('❌ Schwab API connection failed:', response.status);
      updateSchwabStatus('Error');
      schwabConnected = false;
    }
  } catch (error) {
    console.error('❌ Schwab API connection error:', error);
    updateSchwabStatus('Error');
    schwabConnected = false;
  }
}

// Authenticate Schwab (simplified - just tests connection)
async function authenticateSchwab() {
  return testSchwabConnection();
}


// Update Schwab connection status in UI
function updateSchwabStatus(status, type) {
  const statusElement = document.getElementById('schwab-status');
  if (statusElement) {
    statusElement.textContent = status;
    statusElement.className = `status-${type}`;
  }
}

// Get real-time quote for underlying symbol
async function getUnderlyingQuote(symbol) {
  try {
    console.log(' Getting quote for symbol:', symbol);
    const response = await fetch(`http://localhost:3001/api/v1/marketdata/quotes?symbols=${symbol}`);
    
    if (!response.ok) {
      console.error('Quote API error:', response.status, response.statusText);
      return null;
    }
    
    const data = await response.json();
    console.log(' Raw quote response:', data);
    
    // Check if we got errors and try fallback symbol formats
    if (data.errors && data.errors.invalidSymbols) {
      console.log(' Invalid symbols:', data.errors.invalidSymbols);
      
      // Try alternative formats for index symbols
      const alternatives = [];
      if (symbol === 'NDX') {
        alternatives.push('NDX', '$NDX', 'NDX.X');
      } else if (symbol === 'SPX') {
        alternatives.push('SPX', '$SPX', 'SPX.X');
      } else if (symbol === 'DJX') {
        alternatives.push('DJX', '$DJX', 'DJX.X');
      }
      
      for (const altSymbol of alternatives) {
        console.log(` Trying alternative symbol: ${altSymbol}`);
        try {
          const altResponse = await fetch(`http://localhost:3001/api/v1/marketdata/quotes?symbols=${altSymbol}`);
          if (altResponse.ok) {
            const altData = await altResponse.json();
            if (!altData.errors) {
              console.log(` Alternative symbol worked: ${altSymbol}`);
              return altData;
            }
          }
        } catch (error) {
          console.log(` Alternative ${altSymbol} failed:`, error);
        }
      }
      
      return null; // All alternatives failed
    }
    
    return data;
  } catch (error) {
    console.error('Error getting quote:', error);
    return null;
  }
}

// Test function to demonstrate new optional parameters
async function testEnhancedOptionsChain() {
  if (!schwabConnected) {
    console.log('❌ Schwab API not connected');
    return;
  }
  
  console.log('🧪 Testing enhanced options chain parameters...');
  
  // Example 1: Get only 5 strikes, calls only
  console.log('\n📞 Example 1: 5 strikes, calls only');
  const callsOnly = await getOptionsChainFromSchwab('SPY', '2024-02-16', {
    strike_count: 5,
    contract_type: 'CALL'
  });
  
  // Example 2: Get ITM options only with underlying quote
  console.log('\n💰 Example 2: ITM options with underlying quote');
  const itmOnly = await getOptionsChainFromSchwab('SPY', '2024-02-16', {
    strike_range: 'ITM',
    include_underlying_quote: true
  });
  
  // Example 3: Get specific strike
  console.log('\n🎯 Example 3: Specific strike only');
  const specificStrike = await getOptionsChainFromSchwab('SPY', '2024-02-16', {
    strike: 450
  });
  
  console.log('✅ Enhanced options chain tests completed');
}

// Add this to your browser console to test: testEnhancedOptionsChain()

// Get options chain from Schwab
// Available optional parameters:
// strike_count - Number of strikes above/below ATM (e.g., 10)
// contract_type - CALL, PUT, ALL (e.g., CALL)
// include_underlying_quote - true/false (e.g., true)
// strategy - COVERED_CALL, VERTICAL_SPREAD, etc.
// strike_range - ITM, OTM, ITM_OTM, ALL (e.g., ITM)
// option_type - S, W, NS, ALL (Standard, Weekly, Non-Standard)
// strike - Specific strike price (e.g., 450)
// interval - Strike interval for spreads (e.g., 5)
// Example: ?symbol=SPY&expirationDate=2024-01-19&strike_count=10&contract_type=CALL&strike_range=ITM
async function getOptionsChainFromSchwab(symbol, expirationDate, optionalParams = {}) {
  if (!schwabConnected) {
    console.log('Schwab API not connected');
    return null;
  }

  try {
    console.log('⛓️ Getting options chain for:', symbol, 'exp:', expirationDate);
    
    // Build query string with optional parameters
    let queryString = `symbol=${symbol}&expirationDate=${encodeURIComponent(expirationDate)}`;
    
    // Add optional parameters if provided
    if (Object.keys(optionalParams).length > 0) {
      Object.entries(optionalParams).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          queryString += `&${key}=${encodeURIComponent(value)}`;
        }
      });
      console.log('🎯 Using optional parameters:', optionalParams);
    }
    
    console.log('🔗 DEBUG: Final query string:', queryString);
    console.log('🔗 DEBUG: Full URL:', `http://localhost:3001/api/v1/marketdata/chains?${queryString}`);
    
    const response = await fetch(`http://localhost:3001/api/v1/marketdata/chains?${queryString}`);
    
    if (!response.ok) {
      console.error('❌ Options chain API error:', response.status, response.statusText);
      return null;
    }
    
    // Safely parse JSON response
    let data;
    try {
      const responseText = await response.text();
      console.log('📄 Raw response text (first 500 chars):', responseText.substring(0, 500));
      
      data = JSON.parse(responseText);
      console.log('⛓️ Chain data:', data);
    } catch (parseError) {
      console.error('❌ JSON parse error in options chain:', parseError);
      console.error('❌ Response was not valid JSON');
      return null;
    }
    
    return data;
  } catch (error) {
    console.error('Error getting options chain:', error);
    return null;
  }
}

// Get option expirations from Schwab
async function getOptionExpirationsFromSchwab(symbol) {
  if (!schwabConnected) {
    console.log('Schwab API not connected');
    return null;
  }

  try {
    const response = await fetch(`http://localhost:3001/api/v1/marketdata/expirationchain?symbol=${symbol}`);
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Error getting option expirations:', error);
    return null;
  }
}

// Parse Schwab options data and convert to calculator format
function parseSchwabOptionsData(chainData) {
  const options = [];
  
  console.log('🔍 Parsing chain data structure:', Object.keys(chainData));
  console.log('📊 Raw chain data type:', typeof chainData);
  
  // Safely stringify the data for debugging
  try {
    const jsonString = JSON.stringify(chainData, null, 2);
    console.log('📊 Raw chain data sample:', jsonString.substring(0, 1000) + '...');
  } catch (error) {
    console.error('❌ Error stringifying chainData:', error);
    console.log('📊 Raw chain data (string fallback):', String(chainData).substring(0, 1000) + '...');
  }
  
  // Validate input data
  if (!chainData) {
    console.log('❌ chainData is null or undefined');
    return options;
  }
  
  if (typeof chainData !== 'object') {
    console.log('❌ chainData is not an object:', typeof chainData);
    return options;
  }
  
  if (chainData && chainData.callExpDateMap && chainData.putExpDateMap) {
    // Get the first (closest) expiration date for calls and puts
    const callDates = Object.keys(chainData.callExpDateMap).sort();
    const putDates = Object.keys(chainData.putExpDateMap).sort();
    
    console.log('📅 All call expiration dates:', callDates);
    console.log('📅 All put expiration dates:', putDates);
    
    // Use the first (closest) date - they should be the same for calls and puts
    const closestDate = callDates[0];
    console.log('🎯 Using closest expiration date:', closestDate);
    
    // Show raw call data structure for the closest date
    console.log('🔍 Raw call data for closest date:');
    const callStrikes = chainData.callExpDateMap[closestDate];
    if (callStrikes && typeof callStrikes === 'object') {
      Object.entries(callStrikes).forEach(([strike, callArray]) => {
        if (Array.isArray(callArray) && callArray.length > 0) {
          const call = callArray[0];
          console.log(`    Strike ${strike}:`, {
            strike: call.strikePrice,
            bid: call.bid,
            ask: call.ask,
            last: call.last,
            volume: call.totalVolume,
            oi: call.openInterest
          });
        }
      });
    }
    
    // Show raw put data structure for the closest date
    console.log('🔍 Raw put data for closest date:');
    const putStrikes = chainData.putExpDateMap[closestDate];
    if (putStrikes && typeof putStrikes === 'object') {
      Object.entries(putStrikes).forEach(([strike, putArray]) => {
        if (Array.isArray(putArray) && putArray.length > 0) {
          const put = putArray[0];
          console.log(`    Strike ${strike}:`, {
            strike: put.strikePrice,
            bid: put.bid,
            ask: put.ask,
            last: put.last,
            volume: put.totalVolume,
            oi: put.openInterest
          });
        }
      });
    }
    
    // Process calls from the closest date only
    if (callStrikes && typeof callStrikes === 'object') {
      Object.entries(callStrikes).forEach(([strike, callArray]) => {
        try {
          if (Array.isArray(callArray) && callArray.length > 0) {
            const call = callArray[0];
            if (call.strikePrice && (call.last !== null && call.last !== undefined || call.bid || call.ask)) {
              options.push({
                type: 'c',
                strike: call.strikePrice,
                last: call.last || 0,
                bid: call.bid || 0,
                ask: call.ask || 0,
                volume: call.totalVolume || 0,
                openInterest: call.openInterest || 0,
                expirationDate: call.expirationDate // Add expiration date
              });
            }
          }
        } catch (error) {
          console.error('❌ Error processing call data for strike:', strike, error);
        }
      });
    }
    
    // Process puts from the closest date only
    if (putStrikes && typeof putStrikes === 'object') {
      Object.entries(putStrikes).forEach(([strike, putArray]) => {
        try {
          if (Array.isArray(putArray) && putArray.length > 0) {
            const put = putArray[0];
            if (put.strikePrice && (put.last !== null && put.last !== undefined || put.bid || put.ask)) {
              options.push({
                type: 'p',
                strike: put.strikePrice,
                last: put.last || 0,
                bid: put.bid || 0,
                ask: put.ask || 0,
                volume: put.totalVolume || 0,
                openInterest: put.openInterest || 0,
                expirationDate: put.expirationDate // Add expiration date
              });
            }
          }
        } catch (error) {
          console.error('❌ Error processing put data for strike:', strike, error);
        }
      });
    }
    
  } else {
    console.log('❌ Expected chainData structure not found');
    console.log('callExpDateMap exists:', !!chainData?.callExpDateMap);
    console.log('putExpDateMap exists:', !!chainData?.putExpDateMap);
  }
  
  console.log(`📊 Parsed ${options.length} options from single expiration date`);
  if (options.length > 0) {
    console.log('📊 Sample option:', options[0]);
  }
  return options;
}

// Map display symbols to API symbols for special cases
function mapSymbolForAPI(displaySymbol, endpoint) {
  // Different endpoints may need different symbol formats
  const quoteMap = {
    'NDX': '$NDX',     // Quotes use $ symbol without .X
    'SPX': '$SPX',
    'DJX': '$DJX',
    'RUT': '$RUT',
    'VIX': '$VIX'
  };
  
  const expirationsMap = {
    'NDX': '$NDX.X',   // Expirations need $ symbol with .X
    'SPX': '$SPX.X',
    'DJX': '$DJX.X',
    'RUT': '$RUT.X',
    'VIX': '$VIX.X'
  };
  
  const chainsMap = {
    'NDX': '%24NDX',     // Chains API requires %24 prefix
    'SPX': '%24SPX',
    'DJX': '%24DJX',
    'RUT': '%24RUT',
    'VIX': '%24VIX'
  };
  
  let apiSymbol = displaySymbol;
  
  if (endpoint === 'quote') {
    apiSymbol = quoteMap[displaySymbol] || displaySymbol;
  } else if (endpoint === 'expirations') {
    apiSymbol = expirationsMap[displaySymbol] || displaySymbol;
  } else if (endpoint === 'chains') {
    apiSymbol = chainsMap[displaySymbol] || displaySymbol;
  } else {
    // Default to options format for general use
    apiSymbol = expirationsMap[displaySymbol] || displaySymbol;
  }
  
  console.log(`🔄 Symbol mapping for ${endpoint}: ${displaySymbol} → ${apiSymbol}`);
  return apiSymbol;
}

// Update calculator with live Schwab data
async function updateCalculatorWithLiveData(symbol) {
  if (!schwabConnected) {
    console.log('Schwab API not connected');
    return;
  }

  console.log('🔄 Updating with live data for:', symbol);

  try {
    // Get underlying quote - use quote mapping
    const quoteSymbol = mapSymbolForAPI(symbol, 'quote');
    const quote = await getUnderlyingQuote(quoteSymbol);
    console.log('📊 Quote data:', quote);
    
    if (quote && quote[quoteSymbol] && quote[quoteSymbol].quote) {
      const lastPrice = quote[quoteSymbol].quote.lastPrice;
      console.log('💰 Last price:', lastPrice);
      updateUnderlyingPrice(lastPrice);
    } else {
      console.log('❌ Invalid quote data structure');
      console.log('Available keys in quote:', quote ? Object.keys(quote) : 'quote is null');
      console.log('Tried symbol:', quoteSymbol);
    }

    // Get options chain - use chains mapping
    const chainsSymbol = mapSymbolForAPI(symbol, 'chains');
    console.log('🔗 DEBUG: chainsSymbol for API call:', chainsSymbol);
    const expirations = await getOptionExpirationsFromSchwab(chainsSymbol);
    console.log('📅 Expirations data:', expirations);
    
    if (expirations && expirations.expirationList && expirations.expirationList.length > 0) {
      const nearestExpiration = expirations.expirationList[0]; // Use nearest expiration
      console.log('🎯 Nearest expiration:', nearestExpiration);
      
      const chainData = await getOptionsChainFromSchwab(chainsSymbol, nearestExpiration.expirationDate, {
      strike_count: 50
    });
    console.log('⛓️ Chain data (limited to 50 strikes):', chainData);
      
      if (chainData) {
        const options = parseSchwabOptionsData(chainData);
        console.log('📈 Parsed options:', options);
        updateOptionsChain(options);
      } else {
        // Handle case where chains API fails (common for index options like NDX)
        console.log('⚠️ Options chain data not available - this is common for index options');
        const chainElement = document.getElementById('options-chain');
        if (chainElement) {
          chainElement.innerHTML = `
            <div class="options-header">
              <h3>Options Chain - Not Available</h3>
            </div>
            <div class="options-unavailable">
              <p>Options data is not available for ${symbol} through the Schwab API.</p>
              <p>This is common for index symbols like NDX, SPX, etc.</p>
              <p>Quote data is available and shown above.</p>
            </div>
          `;
        }
      }
    } else {
      console.log('❌ No expirations found');
      const chainElement = document.getElementById('options-chain');
      if (chainElement) {
        chainElement.innerHTML = '<p>No options expirations available for this symbol</p>';
      }
    }
  } catch (error) {
    console.error('Error updating with live data:', error);
    const chainElement = document.getElementById('options-chain');
    if (chainElement) {
      chainElement.innerHTML = '<p>Error loading options data</p>';
    }
  }
}

// Update underlying price in UI
function updateUnderlyingPrice(price) {
  const priceElement = document.getElementById('underlying-price');
  if (priceElement) {
    priceElement.textContent = `$${price.toFixed(2)}`;
  }
}

// Find offsetting trades that neutralize risk
function findOffsettingTrades(currentPositions, marketData) {
  console.log('🔍 Analyzing offsetting trades for:', currentPositions);
  console.log('📊 Market data available:', marketData.length, 'options');
  
  const offsettingTrades = [];
  
  // Group current positions by type (calls vs puts)
  const callPositions = currentPositions.filter(p => p.type === 'c');
  const putPositions = currentPositions.filter(p => p.type === 'p');
  
  console.log('📈 Call positions:', callPositions);
  console.log('📉 Put positions:', putPositions);
  
  // Calculate net exposure and find total cost adjustment
  const netExposure = new Map();
  let totalCostPaid = 0;
  
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
    // Sort calls by strike to identify spread
    const sortedCalls = callPositions.sort((a, b) => a.strike - b.strike);
    
    // Look for debit spreads (long lower strike, short higher strike)
    for (let i = 0; i < sortedCalls.length - 1; i++) {
      const longCall = sortedCalls[i];
      const shortCall = sortedCalls[i + 1];
      
      if (longCall.qty > 0 && shortCall.qty < 0 && 
          Math.abs(longCall.qty) === Math.abs(shortCall.qty)) {
        
        // This is a call debit spread
        const spreadWidth = shortCall.strike - longCall.strike;
        const spreadMaxValue = spreadWidth * 100 * Math.abs(longCall.qty);
        const spreadProfit = spreadMaxValue - totalCostPaid;
        
        maxPotentialProfit = Math.max(maxPotentialProfit, spreadProfit);
        
        console.log(`📈 Found call spread: long ${longCall.qty} ${longCall.strike}c, short ${shortCall.qty} ${shortCall.strike}c`);
        console.log(`💰 Spread width: $${spreadWidth}, max value: $${spreadMaxValue.toFixed(2)}, cost: $${totalCostPaid.toFixed(2)}`);
        console.log(`🎯 Spread max profit: $${spreadProfit.toFixed(2)}`);
      }
    }
  }
  
  // For put spreads, calculate the actual max profit
  if (putPositions.length >= 2) {
    // Sort puts by strike to identify spread
    const sortedPuts = putPositions.sort((a, b) => a.strike - b.strike);
    
    // Look for debit spreads (long higher strike, short lower strike)
    for (let i = 0; i < sortedPuts.length - 1; i++) {
      const shortPut = sortedPuts[i];
      const longPut = sortedPuts[i + 1];
      
      if (shortPut.qty < 0 && longPut.qty > 0) {
        // Found a bear put spread
        const spreadWidth = longPut.strike - shortPut.strike;
        const spreadMaxValue = spreadWidth * 100 * Math.abs(longPut.qty);
        const spreadProfit = spreadMaxValue - totalCostPaid;
        
        maxPotentialProfit = Math.max(maxPotentialProfit, spreadProfit);
        
        console.log(`📉 Found put spread: long ${longPut.qty} ${longPut.strike}p, short ${shortPut.qty} ${shortPut.strike}p`);
        console.log(`💰 Spread width: $${spreadWidth}, max value: $${spreadMaxValue.toFixed(2)}, cost: $${totalCostPaid.toFixed(2)}`);
        console.log(`🎯 Spread max profit: $${spreadProfit.toFixed(2)}`);
      }
    }
  }
  
  // For individual positions, calculate max profit differently
  callPositions.forEach(pos => {
    if (pos.qty < 0) { // Short calls - max profit is premium received (but we paid for spread)
      // For short calls in a spread context, the max profit comes from the spread
      // So we don't add individual short call profit here
    } else if (pos.qty > 0 && maxPotentialProfit === 0) { // Long calls - unlimited profit
      // If no spread was found, treat as individual long call
      maxPotentialProfit = Math.max(maxPotentialProfit, totalCostPaid * 3); // Conservative estimate
    }
  });
  
  console.log('💰 Maximum potential profit (offset budget):', maxPotentialProfit);
  
  // Find offsetting opportunities
  currentPositions.forEach(position => {
    const qty = position.qty;
    const strike = position.strike;
    const type = position.type;
    
    console.log(`🔍 Analyzing position: ${qty} ${type} @ ${strike}`);
    
    if (qty === 0) return; // Skip zero quantities
    if (type === null || strike === null) return; // Skip cost adjustment entries
    
    // For short calls, look for long puts at same or higher strike
    if (type === 'c' && qty < 0) { // Short calls
      const shortCallStrike = strike;
      console.log(`🔍 Looking for offsets for short ${Math.abs(qty)} ${shortCallStrike} calls`);
      
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
      
      // Single leg offset: long put at same or higher strike
      const lowestCallStrike = Math.min(...callPositions.map(cp => cp.strike));
      const qualifyingPuts = marketData.filter(option => {
        return option.type === 'p' && option.strike >= lowestCallStrike && Number.isInteger(option.strike) && option.strike % 10 === 0;
      });
      
      console.log(`🔍 Found ${qualifyingPuts.length} puts at or above ${shortCallStrike}:`, 
        qualifyingPuts.map(p => `${p.strike}@$${((p.bid + p.ask) / 2).toFixed(2)}`));
      
      qualifyingPuts.forEach(option => {
        const putPrice = (option.bid + option.ask) / 2;
        const offsetCost = putPrice * Math.abs(qty) * 100; // Cost to buy puts
        
        // Calculate additional profit potential based on realistic scenarios
        // For puts: calculate value at the lowest call strike (most bullish scenario for the original position)
        const lowestCallStrike = Math.min(...callPositions.map(cp => cp.strike));
        const putValueAtLowestCall = Math.max(0, option.strike - lowestCallStrike) * 100 * Math.abs(qty);
        
        // Maximum potential value of the new put trade
        const potentialValue = putValueAtLowestCall;
        
        // Locked profit is the minimum of (budget - cost) or (potential - budget - cost)
        const lockedProfit = Math.min(offsetBudget - offsetCost, potentialValue - offsetBudget - offsetCost);
        
        const upside = putValueAtLowestCall - lockedProfit - offsetCost; // Additional profit beyond locked profit
        
        // Total profit potential = locked profit + upside
        const totalProfitPotential = lockedProfit + upside;
        
        console.log(`🤔 Put ${option.strike}: cost $${offsetCost.toFixed(2)}, locked profit $${lockedProfit.toFixed(2)}, upside $${upside.toFixed(2)} (value at $${lowestCallStrike}), total potential $${totalProfitPotential.toFixed(2)}`);
        
        if (offsetCost < offsetBudget && lockedProfit > 0) {
          console.log(`✅ Profitable single leg offset found!`);
          offsettingTrades.push({
            type: 'single_leg',
            description: `Long ${Math.abs(qty)} ${option.strike} puts`,
            action: `BUY ${Math.abs(qty)} ${option.strike} PUT @ $${putPrice.toFixed(2)}`,
            cost: offsetCost,
            lockedProfit: lockedProfit,
            potentialValue: potentialValue,
            additionalProfitPotential: upside,
            totalProfitPotential: totalProfitPotential,
            riskNeutralized: true,
            originalPosition: `Short ${Math.abs(qty)} ${shortCallStrike} calls`,
            offsettingPosition: `Long ${Math.abs(qty)} ${option.strike} puts`
          });
        }
      });
      
      // Spread offset: bear put spread (buy higher strike, sell lower strike)
      const availablePuts = marketData.filter(opt => opt.type === 'p' && opt.strike >= lowestCallStrike && Number.isInteger(opt.strike) && opt.strike % 10 === 0);
      
      console.log(`🔍 Checking bear put spreads with ${availablePuts.length} puts`);
      console.log(`🔍 Available puts:`, availablePuts.map(p => `${p.strike}@$${((p.bid + p.ask) / 2).toFixed(2)}`));
      
      // Sort puts by strike (ascending) for proper spread construction
      const sortedPuts = availablePuts.sort((a, b) => a.strike - b.strike);
      console.log(`🔍 Sorted puts:`, sortedPuts.map(p => `${p.strike}@$${((p.bid + p.ask) / 2).toFixed(2)}`));
      
      // Check multiple spread combinations
      const maxSpreadWidth = 50; // Maximum $50 spread width
      const minSpreadWidth = 10;  // Minimum $10 spread width
      const spreadIncrement = 10; // Check in $10 increments
      const maxSpreadsToCheck = 50; // Increase limit to show more options
      
      let spreadCount = 0;
      
      for (let i = 0; i < sortedPuts.length && spreadCount < maxSpreadsToCheck; i++) {
        const shortPut = sortedPuts[i]; // Lower strike (sell)
        
        for (let j = i + 1; j < sortedPuts.length && spreadCount < maxSpreadsToCheck; j++) {
          const longPut = sortedPuts[j]; // Higher strike (buy)
          const spreadWidth = longPut.strike - shortPut.strike;
          
          // Only check spreads within our desired width range and in $10 increments
          if (spreadWidth >= minSpreadWidth && spreadWidth <= maxSpreadWidth && 
              spreadWidth % spreadIncrement === 0) {
            
            console.log(`🔍 Checking spread: buy ${longPut.strike} put, sell ${shortPut.strike} put (width: $${spreadWidth})`);
            
            const longPutPrice = (longPut.bid + longPut.ask) / 2;
            const shortPutPrice = (shortPut.bid + shortPut.ask) / 2;
            
            // Bear put spread: buy higher strike, sell lower strike
            // This costs money: (higher strike price - lower strike price) * quantity * 100
            const spreadCost = (longPutPrice - shortPutPrice) * Math.abs(qty) * 100;
            const spreadMaxValue = (longPut.strike - shortPut.strike) * 100 * Math.abs(qty);
            
            // Filter out spreads where cost is more than 95% of max value
            if (spreadCost > spreadMaxValue * 0.95) {
              console.log(`❌ Spread rejected: cost $${spreadCost.toFixed(2)} is too high (${(spreadCost/spreadMaxValue*100).toFixed(1)}% of max value $${spreadMaxValue.toFixed(2)})`);
              continue;
            }
            
            // Maximum potential value of the new put spread (value at lower strike)
            const potentialValue = spreadMaxValue;
            
            // Locked profit is the minimum of (budget - cost) or (potential - budget - cost)
            const lockedProfit = Math.min(offsetBudget - spreadCost, potentialValue - offsetBudget - spreadCost);
            
            // Calculate additional profit potential for the spread based on realistic scenarios
            // For bear put spreads: maximum value is the spread width (difference between strikes)
            const upside = spreadMaxValue - lockedProfit - spreadCost; // Additional profit beyond locked profit
            
            // Total profit potential = locked profit + upside
            const totalProfitPotential = lockedProfit + upside;
            
            console.log(`🤔 Spread ${shortPut.strike}/${longPut.strike}: cost $${spreadCost.toFixed(2)}, locked profit $${lockedProfit.toFixed(2)}, upside $${upside.toFixed(2)} (max value: $${spreadMaxValue.toFixed(2)}), total potential $${totalProfitPotential.toFixed(2)}`);
            console.log(`🔍 Spread conditions: cost < budget? ${spreadCost < offsetBudget}, locked profit > 0? ${lockedProfit > 0}`);
            
            if (spreadCost < offsetBudget && lockedProfit > 0) {
              console.log(`✅ Profitable spread offset found!`);
              offsettingTrades.push({
                type: 'spread',
                description: `Bear ${Math.abs(qty)} ${shortPut.strike}/${longPut.strike} put spread`,
                action: `BUY ${Math.abs(qty)} ${longPut.strike} PUT @ $${longPutPrice.toFixed(2)} & SELL ${Math.abs(qty)} ${shortPut.strike} PUT @ $${shortPutPrice.toFixed(2)}`,
                cost: spreadCost,
                lockedProfit: lockedProfit,
                potentialValue: potentialValue,
                additionalProfitPotential: upside,
                totalProfitPotential: totalProfitPotential,
                riskNeutralized: true,
                originalPosition: `Short ${Math.abs(qty)} ${shortCallStrike} calls`,
                offsettingPosition: `Bear ${Math.abs(qty)} ${shortPut.strike}/${longPut.strike} put spread`
              });
              spreadCount++;
            } else {
              console.log(`❌ Spread rejected: cost too high or no locked profit`);
            }
          }
        }
      }
    }
    
    // For long puts, look for short calls at same or lower strike
    if (type === 'p' && qty > 0) { // Long puts
      const longPutStrike = strike;
      console.log(`🔍 Looking for offsets for long ${qty} ${longPutStrike} puts`);
      
      // For long puts, the offset budget is also the max potential profit
      const offsetBudget = maxPotentialProfit;
      
      if (offsetBudget <= 0) {
        console.log(`❌ No offset budget available (max profit: $${offsetBudget})`);
        return;
      }
      
      console.log(`💰 Offset budget from max profit: $${offsetBudget.toFixed(2)}`);
      
      // Single leg offset: long call at same or lower strike
      const qualifyingCalls = marketData.filter(option => {
        return option.type === 'c' && option.strike <= longPutStrike && Number.isInteger(option.strike) && option.strike % 10 === 0;
      });
      
      console.log(`🔍 Found ${qualifyingCalls.length} calls at or below ${longPutStrike}:`,
        qualifyingCalls.map(c => `${c.strike}@$${((c.bid + c.ask) / 2).toFixed(2)}`));
      
      qualifyingCalls.forEach(option => {
        const callPrice = (option.bid + option.ask) / 2;
        const offsetCost = callPrice * qty * 100; // Cost to buy calls
        
        // For long puts, calculate additional profit potential based on realistic scenarios
        // For calls: calculate value at the highest put strike (most bullish scenario for the original position)
        const highestPutStrike = Math.max(...putPositions.map(pp => pp.strike));
        const callValueAtHighestPut = Math.max(0, highestPutStrike - option.strike) * 100 * qty;
        
        // Maximum potential value of the new call trade
        const potentialValue = callValueAtHighestPut;
        
        // Locked profit is the minimum of (budget - cost) or (potential - budget - cost)
        const lockedProfit = Math.min(offsetBudget - offsetCost, potentialValue - offsetBudget - offsetCost);
        
        // Upside is the potential value minus locked profit minus cost
        const upside = potentialValue - lockedProfit - offsetCost;
        
        // Total profit potential = locked profit + upside
        const totalProfitPotential = lockedProfit + upside;
        
        console.log(`🤔 Call ${option.strike}: cost $${offsetCost.toFixed(2)}, locked profit $${lockedProfit.toFixed(2)}, upside $${upside.toFixed(2)} (value at $${highestPutStrike}), total potential $${totalProfitPotential.toFixed(2)}`);
        
        if (offsetCost < offsetBudget && (lockedProfit > 0 || upside > 0)) {
          console.log(`✅ Profitable call offset found!`);
          offsettingTrades.push({
            type: 'single_leg',
            description: `Long ${qty} ${option.strike} calls`,
            action: `BUY ${qty} ${option.strike} CALL @ $${callPrice.toFixed(2)}`,
            cost: offsetCost,
            lockedProfit: lockedProfit,
            potentialValue: potentialValue,
            additionalProfitPotential: upside,
            totalProfitPotential: totalProfitPotential,
            riskNeutralized: true,
            originalPosition: `Long ${qty} ${longPutStrike} puts`,
            offsettingPosition: `Long ${qty} ${option.strike} calls`
          });
        }
      });
      
      // Spread offset: bull call spread (buy lower strike, sell higher strike)
      const availableCalls = marketData.filter(opt => opt.type === 'c' && opt.strike <= longPutStrike && Number.isInteger(opt.strike) && opt.strike % 10 === 0);
      
      console.log(`🔍 Checking bull call spreads with ${availableCalls.length} calls`);
      console.log(`🔍 Available calls:`, availableCalls.map(c => `${c.strike}@$${((c.bid + c.ask) / 2).toFixed(2)}`));
      
      // Sort calls by strike (ascending) for proper spread construction
      const sortedCalls = availableCalls.sort((a, b) => a.strike - b.strike);
      console.log(`🔍 Sorted calls:`, sortedCalls.map(c => `${c.strike}@$${((c.bid + c.ask) / 2).toFixed(2)}`));
      
      // Check multiple spread combinations
      const maxSpreadWidth = 50; // Maximum $50 spread width
      const minSpreadWidth = 10;  // Minimum $10 spread width
      const spreadIncrement = 10; // Check in $10 increments
      const maxSpreadsToCheck = 50; // Increase limit to show more options
      
      let spreadCount = 0;
      
      for (let i = 0; i < sortedCalls.length && spreadCount < maxSpreadsToCheck; i++) {
        const longCall = sortedCalls[i]; // Lower strike (buy)
        
        for (let j = i + 1; j < sortedCalls.length && spreadCount < maxSpreadsToCheck; j++) {
          const shortCall = sortedCalls[j]; // Higher strike (sell)
          const spreadWidth = shortCall.strike - longCall.strike;
          
          // Only check spreads within our desired width range and in $10 increments
          if (spreadWidth >= minSpreadWidth && spreadWidth <= maxSpreadWidth && 
              spreadWidth % spreadIncrement === 0) {
            
            console.log(`🔍 Checking spread: buy ${longCall.strike} call, sell ${shortCall.strike} call (width: $${spreadWidth})`);
            
            const longCallPrice = (longCall.bid + longCall.ask) / 2;
            const shortCallPrice = (shortCall.bid + shortCall.ask) / 2;
            
            // Bull call spread: buy lower strike, sell higher strike
            // This costs money: (higher strike price - lower strike price) * quantity * 100
            const spreadCost = (longCallPrice - shortCallPrice) * qty * 100;
            const spreadMaxValue = (shortCall.strike - longCall.strike) * 100 * qty;
            
            // Filter out spreads where cost is more than 95% of max value
            if (spreadCost > spreadMaxValue * 0.95) {
              console.log(`❌ Spread rejected: cost $${spreadCost.toFixed(2)} is too high (${(spreadCost/spreadMaxValue*100).toFixed(1)}% of max value $${spreadMaxValue.toFixed(2)})`);
              continue;
            }
            
            // Maximum potential value of the new call spread (value at higher strike)
            const potentialValue = spreadMaxValue;
            
            // Locked profit is the minimum of (budget - cost) or (potential - budget - cost)
            const lockedProfit = Math.min(offsetBudget - spreadCost, potentialValue - offsetBudget - spreadCost);
            
            // Calculate additional profit potential for the spread based on realistic scenarios
            // For bull call spreads: maximum value is the spread width (difference between strikes)
            const upside = spreadMaxValue - lockedProfit - spreadCost; // Additional profit beyond locked profit
            
            // Total profit potential = locked profit + upside
            const totalProfitPotential = lockedProfit + upside;
            
            console.log(`🤔 Spread ${longCall.strike}/${shortCall.strike}: cost $${spreadCost.toFixed(2)}, locked profit $${lockedProfit.toFixed(2)}, upside $${upside.toFixed(2)} (max value: $${spreadMaxValue.toFixed(2)}), total potential $${totalProfitPotential.toFixed(2)}`);
            console.log(`🔍 Spread conditions: cost < budget? ${spreadCost < offsetBudget}, locked profit > 0? ${lockedProfit > 0}`);
            
            if (spreadCost < offsetBudget && lockedProfit > 0) {
              console.log(`✅ Profitable spread offset found!`);
              offsettingTrades.push({
                type: 'spread',
                description: `Bull ${qty} ${longCall.strike}/${shortCall.strike} call spread`,
                action: `BUY ${qty} ${longCall.strike} CALL @ $${longCallPrice.toFixed(2)} & SELL ${qty} ${shortCall.strike} CALL @ $${shortCallPrice.toFixed(2)}`,
                cost: spreadCost,
                lockedProfit: lockedProfit,
                potentialValue: potentialValue,
                additionalProfitPotential: upside,
                totalProfitPotential: totalProfitPotential,
                riskNeutralized: true,
                originalPosition: `Long ${qty} ${longPutStrike} puts`,
                offsettingPosition: `Bull ${qty} ${longCall.strike}/${shortCall.strike} call spread`
              });
              spreadCount++;
            } else {
              console.log(`❌ Spread rejected: cost too high or no locked profit`);
            }
          }
        }
      }
    }
  });
  
  // Sort by total profit potential (highest first)
  offsettingTrades.sort((a, b) => b.totalProfitPotential - a.totalProfitPotential);
  
  console.log('🎯 Found offsetting trades:', offsettingTrades);
  console.log(`📊 Total offsetting opportunities: ${offsettingTrades.length}`);
  
  return offsettingTrades;
}

// Update options chain in UI
function updateOptionsChain(options) {
  console.log('🎨 Updating options chain UI with', options.length, 'options');
  
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
          html += `<td class="${callClass}">${call.volume || 0}</td>`;
          html += `<td class="${callClass}">$${call.bid.toFixed(2)}</td>`;
          html += `<td class="${callClass}">$${call.ask.toFixed(2)}</td>`;
        } else {
          html += '<td>-</td><td>-</td><td>-</td><td>-</td>';
        }
        
        // Strike (middle) with P columns showing positions
        const callPClass = callPositionQty > 0 ? 'position-long' : callPositionQty < 0 ? 'position-short' : 'strike-cell-p';
        const putPClass = putPositionQty > 0 ? 'position-long' : putPositionQty < 0 ? 'position-short' : 'strike-cell-p';
        
        html += `<td class="${callPClass}">${callPositionQty !== 0 ? callPositionQty : ''}</td>`; // P column for calls
        html += `<td class="strike-cell">$${strike.toFixed(2)}</td>`; // Strike
        html += `<td class="${putPClass}">${putPositionQty !== 0 ? putPositionQty : ''}</td>`; // P column for puts
        
        // Put side (right)
        if (put) {
          const putClass = putITM ? 'itm-cell' : '';
          html += `<td class="${putClass}">$${put.bid.toFixed(2)}</td>`;
          html += `<td class="${putClass}">$${put.ask.toFixed(2)}</td>`;
          html += `<td class="${putClass}">${put.volume || 0}</td>`;
          html += `<td class="${putClass}">${put.openInterest || 0}</td>`;
        } else {
          html += '<td>-</td><td>-</td><td>-</td><td>-</td>';
        }
        
        html += '</tr>';
      });
      
      html += '</tbody></table>';
      
      // Find and display offsetting trades
      if (fullOptionArray && fullOptionArray.length > 0) {
        console.log('🔍 Analyzing offsetting trades...');
        const offsettingTrades = findOffsettingTrades(fullOptionArray, options);
        
        if (offsettingTrades.length > 0) {
          html += '<div class="offsetting-trades">';
          html += '<h4>🎯 Risk Offsetting Opportunities</h4>';
          
          offsettingTrades.forEach(trade => {
            const profitClass = trade.totalProfitPotential > 0 ? 'profit-positive' : 'profit-neutral';
            html += `
              <div class="offset-trade ${trade.type}">
                <div class="trade-description">
                  <strong>${trade.description}</strong>
                  <div class="trade-action">${trade.action}</div>
                  <div class="trade-cost">Cost: $${trade.cost.toFixed(2)}</div>
                </div>
                <div class="trade-metrics">
                  <div class="trade-potential">Potential: $${trade.potentialValue.toFixed(2)}</div>
                  <div class="trade-locked-profit">Locked: $${trade.lockedProfit.toFixed(2)}</div>
                  <div class="trade-total-profit ${profitClass}">Total: $${trade.totalProfitPotential.toFixed(2)}</div>
                </div>
              </div>
            `;
          });
          
          html += '</div>';
        }
      }
      
      console.log('🖼️ Generated HTML length:', html.length);
      console.log('🖼️ Generated HTML sample:', html.substring(0, 200) + '...');
      
      chainElement.innerHTML = html;
      console.log('✅ Options chain updated in UI');
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
  
  // Update every 5 seconds
  liveDataInterval = setInterval(() => {
    if (liveDataEnabled && currentSymbol && schwabConnected) {
      updateCalculatorWithLiveData(currentSymbol);
    }
  }, 5000);
}

// Stop live data updates
function stopLiveDataUpdates() {
  if (liveDataInterval) {
    clearInterval(liveDataInterval);
    liveDataInterval = null;
  }
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

// Initialize slider when the DOM is loaded
document.addEventListener('DOMContentLoaded', async () => {
  initSlider();
  
  // Load saved input if it exists
  const savedInput = localStorage.getItem('savedOptionInput');
  if (savedInput) {
    document.getElementById('textInput').value = savedInput;
  }
});

// Process input from the text input field
function processInput() {
  const inputText = document.getElementById('textInput').value;
  const outputDiv = document.getElementById('output');
  
  // Clear previous output
  outputDiv.innerHTML = '';
  
  // Store the input in local storage
  localStorage.setItem('savedOptionInput', inputText);

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
      
      // Calculate portfolio values for the combined options
      combinedData = ChartModule.calculatePortfolioValueAtExpiration(
        allOptions,
        fullMinStrike,
        fullMaxStrike,
        fullStrikeIncrement
      );
    }
    
    // Draw the chart with both datasets if there's combined data, otherwise just the main data
    if (combinedData.length > 0) {
      ChartModule.drawChart(data, fullCost, fullOptionArray, combinedData);
    } else {
      ChartModule.drawChart(data, fullCost, fullOptionArray);
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

    let outputStr = `
      <strong>Processed Output:</strong><br>
      <strong>Position Count:</strong> ${fullOptionArray.length}<br>
      <strong>Total Cost:</strong> $${fullCost.toFixed(2)}<br><br>
      <strong>Value Curve (optionArray):</strong><br>
      <pre>${formatCurve(data)}</pre>
    `;

    if (keyPoints.length > 0) {
      outputStr += `
        <strong>Key Points on Curve:</strong><br>
        <pre>${formatKeyPoints(keyPoints)}</pre>
      `;
    }

    if (combinedData.length > 0) {
      outputStr += `
        <strong>Value Curve (optionArray + tempOptionArray):</strong><br>
        <pre>${formatCurve(combinedData)}</pre>
      `;
      
      // Find key points on combined curve as well
      const combinedKeyPoints = ChartModule.findKeyPointsOnCurve(combinedData, fullCost);
      if (combinedKeyPoints.length > 0) {
        outputStr += `
          <strong>Key Points on Combined Curve:</strong><br>
          <pre>${formatKeyPoints(combinedKeyPoints)}</pre>
        `;
      }
    }

    outputDiv.innerHTML = outputStr;
    
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
