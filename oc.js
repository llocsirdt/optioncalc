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
let liveDataIntervalDuration = 3000;

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
    
    // Update test-connection button visibility
    if (typeof updateConnectionButtonVisibility === 'function') {
      updateConnectionButtonVisibility();
    }
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

// Adjust unrealistic bid/ask spreads by using neighboring strikes
function adjustBidAskSpread(bid, ask, allStrikes, currentStrike) {
  // If bid or ask is missing or invalid, return as-is
  if (!bid || !ask || bid <= 0 || ask <= 0 || bid >= ask) {
    console.log(`🔧 Skipping adjustment for strike ${currentStrike}: invalid bid/ask (bid: $${bid}, ask: $${ask})`);
    return { bid, ask };
  }
  
  // Calculate the spread percentage
  const spreadPercentage = ((ask - bid) / ask) * 100;
  
  // More aggressive threshold - adjust if spread > 25% (these are clearly wrong)
  if (spreadPercentage < 25) {
    //console.log(`🔧 No adjustment needed for strike ${currentStrike}: bid $${bid}, ask $${ask}, spread ${spreadPercentage.toFixed(1)}%`);
    return { bid, ask };
  }
  
  console.log(`🔧 Adjusting unrealistic spread for strike ${currentStrike}: bid $${bid}, ask $${ask}, spread ${spreadPercentage.toFixed(1)}%`);
  
  // Find neighboring strikes
  const strikes = Object.keys(allStrikes).map(s => parseFloat(s)).sort((a, b) => a - b);
  const currentIndex = strikes.indexOf(currentStrike);
  
  if (currentIndex === -1) {
    console.log(`❌ Could not find current strike ${currentStrike} in strikes array`);
    return { bid, ask };
  }
  
  // Get neighboring strikes
  const priorStrike = currentIndex > 0 ? strikes[currentIndex - 1] : null;
  const nextStrike = currentIndex < strikes.length - 1 ? strikes[currentIndex + 1] : null;
  
  console.log(`🔧 Neighboring strikes: prior ${priorStrike}, next ${nextStrike}`);
  
  let adjustedBid = bid;
  let adjustedAsk = ask;
  let bidAdjustments = 0;
  let askAdjustments = 0;
  
  // For extremely unrealistic spreads (>100%), completely ignore the bid and calculate from neighbors
  if (spreadPercentage > 100) {
    console.log(`🔧 Extreme spread detected (${spreadPercentage.toFixed(1)}%), recalculating bid from neighbors`);
    
    // Calculate bid as average of neighboring bids, or if no neighbors, set to 90% of ask
    let neighborBids = [];
    if (priorStrike && allStrikes[priorStrike.toString()] && allStrikes[priorStrike.toString()].bid) {
      neighborBids.push(allStrikes[priorStrike.toString()].bid);
    }
    if (nextStrike && allStrikes[nextStrike.toString()] && allStrikes[nextStrike.toString()].bid) {
      neighborBids.push(allStrikes[nextStrike.toString()].bid);
    }
    
    if (neighborBids.length > 0) {
      adjustedBid = neighborBids.reduce((sum, price) => sum + price, 0) / neighborBids.length;
      bidAdjustments = neighborBids.length;
    } else {
      adjustedBid = ask * 0.9; // Conservative 90% of ask
      bidAdjustments = 1;
    }
  } else {
    // For moderately unrealistic spreads (25-100%), use averaging approach
    // Adjust bid using average of neighboring bids
    if (priorStrike && allStrikes[priorStrike.toString()] && allStrikes[priorStrike.toString()].bid) {
      adjustedBid = (bid + allStrikes[priorStrike.toString()].bid) / 2;
      bidAdjustments++;
    }
    if (nextStrike && allStrikes[nextStrike.toString()] && allStrikes[nextStrike.toString()].bid) {
      adjustedBid = (adjustedBid + allStrikes[nextStrike.toString()].bid) / 2;
      bidAdjustments++;
    }
  }
  
  // Adjust ask using average of neighboring asks (but be more conservative)
  if (priorStrike && allStrikes[priorStrike.toString()] && allStrikes[priorStrike.toString()].ask) {
    adjustedAsk = (ask + allStrikes[priorStrike.toString()].ask) / 2;
    askAdjustments++;
  }
  if (nextStrike && allStrikes[nextStrike.toString()] && allStrikes[nextStrike.toString()].ask) {
    adjustedAsk = (adjustedAsk + allStrikes[nextStrike.toString()].ask) / 2;
    askAdjustments++;
  }
  
  console.log(`🔧 Bid adjustments: ${bidAdjustments}, Ask adjustments: ${askAdjustments}`);
  
  // Ensure bid < ask and both are positive
  if (adjustedBid >= adjustedAsk) {
    adjustedBid = adjustedAsk * 0.9; // Set bid to 90% of ask
    console.log(`🔧 Forced bid adjustment: bid >= ask, setting bid to 90% of ask`);
  }
  if (adjustedBid <= 0) adjustedBid = ask * 0.8; // More conservative fallback
  if (adjustedAsk <= 0) adjustedAsk = ask;
  
  const newSpreadPercentage = ((adjustedAsk - adjustedBid) / adjustedAsk) * 100;
  console.log(`🔧 Adjusted: bid $${adjustedBid.toFixed(2)}, ask $${adjustedAsk.toFixed(2)}, spread ${newSpreadPercentage.toFixed(1)}%`);
  
  return { bid: adjustedBid, ask: adjustedAsk };
}

// Parse Schwab options data and convert to calculator format
function parseSchwabOptionsData(chainData, requestedExpiration = null) {
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
    
    // Use the requested expiration if available, otherwise use the first (closest) date
    let targetDate = null;
    if (requestedExpiration) {
      // Look for the requested date in the format "YYYY-MM-DD:X"
      const requestedKey = callDates.find(date => date.startsWith(requestedExpiration));
      if (requestedKey) {
        targetDate = requestedKey;
        // console.log('🎯 Using requested expiration date:', targetDate);
      } else {
        // console.log('⚠️ Requested expiration not found, falling back to closest date');
        targetDate = callDates[0];
      }
    } else {
      targetDate = callDates[0];
    }
    
    // console.log('🎯 Using expiration date:', targetDate);
    
    // Show raw call data structure for the closest date
    //console.log('🔍 Raw call data for target date:');
    const callStrikes = chainData.callExpDateMap[targetDate];
    if (callStrikes && typeof callStrikes === 'object') {
      Object.entries(callStrikes).forEach(([strike, callArray]) => {
        if (Array.isArray(callArray) && callArray.length > 0) {
          const call = callArray[0];
          // console.log(`    Strike ${strike}:`, {
          //   strike: call.strikePrice,
          //   bid: call.bid,
          //   ask: call.ask,
          //   last: call.last,
          //   volume: call.totalVolume,
          //   oi: call.openInterest
          // });
        }
      });
    }
    
    // Show raw put data structure for the closest date
    //console.log('🔍 Raw put data for target date:');
    const putStrikes = chainData.putExpDateMap[targetDate];
    if (putStrikes && typeof putStrikes === 'object') {
      Object.entries(putStrikes).forEach(([strike, putArray]) => {
        if (Array.isArray(putArray) && putArray.length > 0) {
          const put = putArray[0];
          // console.log(`    Strike ${strike}:`, {
          //   strike: put.strikePrice,
          //   bid: put.bid,
          //   ask: put.ask,
          //   last: put.last,
          //   volume: put.totalVolume,
          //   oi: put.openInterest
          // });
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
              
              // Adjust unrealistic bid/ask spreads
              const adjustedPrices = adjustBidAskSpread(call.bid, call.ask, callStrikes, call.strikePrice);
              
              options.push({
                type: 'c',
                strike: call.strikePrice,
                last: call.last || 0,
                bid: adjustedPrices.bid || 0,
                ask: adjustedPrices.ask || 0,
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
              
              // Adjust unrealistic bid/ask spreads
              const adjustedPrices = adjustBidAskSpread(put.bid, put.ask, putStrikes, put.strikePrice);
              
              options.push({
                type: 'p',
                strike: put.strikePrice,
                last: put.last || 0,
                bid: adjustedPrices.bid || 0,
                ask: adjustedPrices.ask || 0,
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
      // Check if user has selected an expiration from dropdown
      const selectedExpiration = getSelectedExpiration ? getSelectedExpiration() : null;
      
      let targetExpiration = null;
      
      if (selectedExpiration) {
        // Use the user-selected expiration
        targetExpiration = expirations.expirationList.find(exp => exp.expirationDate === selectedExpiration);
        if (targetExpiration) {
          console.log('🎯 Using user-selected expiration:', targetExpiration.expirationDate);
        } else {
          console.log('⚠️ Selected expiration not found, falling back to nearest');
          targetExpiration = expirations.expirationList[0];
        }
      } else {
        // Fallback to today's date logic if no dropdown selection
        const today = new Date();
        const todayString = today.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD format in EST/EDT
        // console.log('🎯 Using today as expiration:', todayString);
        
        // Debug: Show all available expirations
        // console.log('📅 Available expirations:');
        expirations.expirationList.forEach((exp, index) => {
          // console.log(`  ${index + 1}. ${exp.expirationDate} (days: ${exp.daysToExpiration})`);
        });
        
        // Try to find today's expiration in the available list
        targetExpiration = expirations.expirationList.find(exp => exp.expirationDate === todayString);
        
        // If today's expiration not found, fall back to nearest expiration
        if (!targetExpiration) {
          targetExpiration = expirations.expirationList[0]; // Use nearest expiration
          // console.log('🎯 Today not available, using nearest expiration:', targetExpiration.expirationDate);
          // console.log(`🔍 Nearest expiration details: ${targetExpiration.expirationDate}, days: ${targetExpiration.daysToExpiration}`);
        } else {
          // console.log('🎯 Found today in expirations list:', targetExpiration.expirationDate);
          // console.log(`🔍 Today expiration details: ${targetExpiration.expirationDate}, days: ${targetExpiration.daysToExpiration}`);
        }
      }
      
      const chainData = await getOptionsChainFromSchwab(chainsSymbol, targetExpiration.expirationDate, {
        strike_count: 75
      });
    console.log('⛓️ Chain data (limited to 50 strikes):', chainData);
      
      if (chainData) {
        const options = parseSchwabOptionsData(chainData, targetExpiration.expirationDate);
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

// Find offsetting trades that neutralize risk
function findOffsettingTrades(currentPositions, marketData) {
  console.log('🔍 Analyzing offsetting trades for:', currentPositions);
  console.log('📊 Market data available:', marketData.length, 'options');
  
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
      
      if (longCall.qty > 0 && shortCall.qty < 0 && 
          Math.abs(longCall.qty) === Math.abs(shortCall.qty)) {
        
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
        
        maxPotentialProfit = Math.max(maxPotentialProfit, spreadProfit);
        
        console.log(`📈 Found call spread: long ${longCall.qty} ${longCall.strike}c @ $${longCallPremium.toFixed(2)}, short ${shortCall.qty} ${shortCall.strike}c @ $${shortCallPremium.toFixed(2)}`);
        console.log(`💰 Spread width: $${spreadWidth}, max value: $${spreadMaxValue.toFixed(2)}`);
        console.log(`💸 Spread cost: long $${longCallCost.toFixed(2)} + short $${shortCallCredit.toFixed(2)} = $${spreadCost.toFixed(2)}`);
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
        
        console.log(`📉 Found put spread: long ${longPut.qty} ${longPut.strike}p @ $${longPutPremium.toFixed(2)}, short ${shortPut.qty} ${shortPut.strike}p @ $${shortPutPremium.toFixed(2)}`);
        console.log(`💰 Spread width: $${spreadWidth}, max value: $${spreadMaxValue.toFixed(2)}`);
        console.log(`💸 Spread cost: long $${longPutCost.toFixed(2)} + short $${shortPutCredit.toFixed(2)} = $${spreadCost.toFixed(2)}`);
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
  
  // Detect if this is a bull call spread position
  const hasLongCall = callPositions.some(cp => cp.qty > 0);
  const hasShortCall = callPositions.some(cp => cp.qty < 0);
  const isBullCallSpread = hasLongCall && hasShortCall;
  
  console.log(`🔍 Spread detection debug:`);
  console.log(`  callPositions:`, callPositions);
  console.log(`  hasLongCall: ${hasLongCall}`);
  console.log(`  hasShortCall: ${hasShortCall}`);
  console.log(`  isBullCallSpread: ${isBullCallSpread}`);
  
  // Detect if this is a bear put spread position
  const hasLongPut = putPositions.some(pp => pp.qty > 0);
  const hasShortPut = putPositions.some(pp => pp.qty < 0);
  const isBearPutSpread = hasLongPut && hasShortPut;
  
  if (isBullCallSpread) {
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
    
    // For bull call spreads, we want bearish offsets: bear put spreads or long puts
    const lowestCallStrike = Math.min(...callPositions.map(cp => cp.strike));
    console.log(`🔍 Lowest call strike in position: $${lowestCallStrike}`);
    
    // Find the long call strike (lower strike) for range calculation
    const lowerCallStrike = longCall ? longCall.strike : lowestCallStrike;
    const putStrikeRange = lowerCallStrike - 100; // Start 10 strikes below lower call strike (10 strikes × $10 = $100)
    
    console.log(`🔍 Looking for puts starting $${putStrikeRange} (100 points below lower call $${lowerCallStrike})`);
    
    // Put spread offset: bear put spread (buy higher strike, sell lower strike)
    const availablePuts = marketData.filter(opt => {
      return opt.type === 'p' && opt.strike >= putStrikeRange && Number.isInteger(opt.strike) && opt.strike % 10 === 0;
    });
    
    console.log(`🔍 Found ${availablePuts.length} put strikes for bear put spreads:`, availablePuts.slice(0, 10).map(p => `${p.strike}@$${((p.bid + p.ask) / 2).toFixed(2)}`).join(', '));
    
    // Extract put strikes from availablePuts
    const putStrikes = availablePuts.map(p => p.strike);
    
    // Sort puts by strike (ascending) for proper spread construction
    const sortedPuts = availablePuts.sort((a, b) => a.strike - b.strike);
    console.log(`🔍 Sorted puts:`, sortedPuts.map(p => `${p.strike}@$${((p.bid + p.ask) / 2).toFixed(2)}`));
    
    // Check multiple spread combinations
    const minSpreadWidth = 10;  // Minimum $10 spread width
    const spreadIncrement = 10; // Check in $10 increments
    const maxSpreadsToCheck = 20; // Increase limit to check more spreads
    
    let spreadCount = 0;
    
    console.log(`🔍 Starting bear put spread analysis:`);
    console.log(`  putStrikes length: ${putStrikes.length}`);
    console.log(`  maxSpreadsToCheck: ${maxSpreadsToCheck}`);
    
    for (let i = 0; i < putStrikes.length && spreadCount < maxSpreadsToCheck; i++) {
      const shortPutStrike = putStrikes[i]; // Lower strike (sell)
      
      for (let j = i + 1; j < putStrikes.length && spreadCount < maxSpreadsToCheck; j++) {
        const longPutStrike = putStrikes[j]; // Higher strike (buy)
        const spreadWidth = longPutStrike - shortPutStrike;
        
        console.log(`🔍 Checking spread ${shortPutStrike}/${longPutStrike} (width: $${spreadWidth})`);
        
        // Only check spreads within minimum width range and in $10 increments
        if (spreadWidth >= minSpreadWidth && spreadWidth % spreadIncrement === 0) {
          
          console.log(`✅ Processing spread ${shortPutStrike}/${longPutStrike} (width: $${spreadWidth})`);
            
          // Only process spreads up to $500 width to avoid excessive calculations
          if (spreadWidth > 500) {
            console.log(`⏭️ Skipping spread ${shortPutStrike}/${longPutStrike} - width $${spreadWidth} exceeds $500 limit`);
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
            
            // Locked profit is the minimum of (budget - cost) or (potential - budget - cost)
            const lockedProfit = Math.min(offsetBudget - spreadCost, potentialValue - offsetBudget - spreadCost);
            
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
      return option.type === 'p' && option.strike >= singleLegPutRange && Number.isInteger(option.strike) && option.strike % 10 === 0;
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
      
      // Locked profit is the minimum of (budget - cost) or (potential - budget - cost)
      const lockedProfit = Math.min(offsetBudget - offsetCost, potentialValue - offsetBudget - offsetCost);
      
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
    
    // Continue with the rest of the bull call spread logic
    // Don't return here - let the function continue to the end
  }
  
  if (isBearPutSpread) {
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
    
    // For bear put spreads, we want bullish offsets: bull call spreads or long calls
    const highestPutStrike = Math.max(...putPositions.map(pp => pp.strike));
    console.log(`🔍 Highest put strike in position: $${highestPutStrike}`);
    
    // Find the long put strike (higher strike) for range calculation
    const higherPutStrike = longPut ? longPut.strike : highestPutStrike;
    const callStrikeRange = higherPutStrike + 100; // Start 100 points above higher put strike
    
    console.log(`🔍 Looking for calls starting $${callStrikeRange} (100 points above higher put $${higherPutStrike})`);
    
    // Call spread offset: bull call spread (buy lower strike, sell higher strike)
    const availableCalls = marketData.filter(opt => {
      return opt.type === 'c' && opt.strike >= callStrikeRange && Number.isInteger(opt.strike) && opt.strike % 10 === 0;
    });
    
    console.log(`🔍 Found ${availableCalls.length} call strikes for bull call spreads:`, availableCalls.slice(0, 10).map(c => `${c.strike}@$${((c.bid + c.ask) / 2).toFixed(2)}`).join(', '));
    
    // Extract call strikes from availableCalls
    const callStrikes = availableCalls.map(c => c.strike);
    
    // Sort calls by strike (ascending) for proper spread construction
    const sortedCalls = availableCalls.sort((a, b) => a.strike - b.strike);
    console.log(`🔍 Sorted calls:`, sortedCalls.map(c => `${c.strike}@$${((c.bid + c.ask) / 2).toFixed(2)}`));
    
    // Check multiple spread combinations
    const minSpreadWidth = 10;  // Minimum $10 spread width
    const spreadIncrement = 10; // Check in $10 increments
    const maxSpreadsToCheck = 20; // Increase limit to check more spreads
    
    let spreadCount = 0;
    
    console.log(`🔍 Starting bull call spread analysis for bear put spread hedge:`);
    console.log(`  callStrikes length: ${callStrikes.length}`);
    console.log(`  maxSpreadsToCheck: ${maxSpreadsToCheck}`);
    
    for (let i = 0; i < callStrikes.length && spreadCount < maxSpreadsToCheck; i++) {
      const longCallStrike = callStrikes[i]; // Lower strike (buy)
      
      for (let j = i + 1; j < callStrikes.length && spreadCount < maxSpreadsToCheck; j++) {
        const shortCallStrike = callStrikes[j]; // Higher strike (sell)
        const spreadWidth = shortCallStrike - longCallStrike;
        
        console.log(`🔍 Checking spread ${longCallStrike}/${shortCallStrike} (width: $${spreadWidth})`);
        
        // Only check spreads within minimum width range and in $10 increments
        if (spreadWidth >= minSpreadWidth && spreadWidth % spreadIncrement === 0) {
          
          console.log(`✅ Processing spread ${longCallStrike}/${shortCallStrike} (width: $${spreadWidth})`);
          
          // Only process spreads up to $500 width to avoid excessive calculations
          if (spreadWidth > 500) {
            console.log(`⏭️ Skipping spread ${longCallStrike}/${shortCallStrike} - width $${spreadWidth} exceeds $500 limit`);
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
            
            // Locked profit is the minimum of (budget - cost) or (potential - budget - cost)
            const lockedProfit = Math.min(offsetBudget - spreadCost, potentialValue - offsetBudget - spreadCost);
            
            // Calculate additional profit potential for the spread based on realistic scenarios
            // For bull call spreads: maximum value is the spread width (difference between strikes)
            const upside = spreadMaxValue - lockedProfit - spreadCost; // Additional profit beyond locked profit
            
            // Total profit potential = locked profit + upside
            const totalProfitPotential = lockedProfit + upside;
            
            console.log(`🤔 Spread ${longCallStrike}/${shortCallStrike}: cost $${spreadCost.toFixed(2)}, locked profit $${lockedProfit.toFixed(2)}, upside $${upside.toFixed(2)} (max value: $${spreadMaxValue.toFixed(2)}), total potential $${totalProfitPotential.toFixed(2)}`);
            
            if (spreadCost <= offsetBudget && lockedProfit >= 0) {
              console.log(`✅ Risk-free spread offset found!`);
              console.log(`   Locked profit: $${lockedProfit.toFixed(2)}`);
              console.log(`   Cost vs budget: $${spreadCost.toFixed(2)} vs $${offsetBudget.toFixed(2)}`);
              offsettingTrades.push({
                type: 'spread',
                description: `Bull ${Math.abs(spreadQty)} ${longCallStrike}/${shortCallStrike} call spread`,
                action: `BUY ${Math.abs(spreadQty)} ${longCallStrike} CALL @ $${longCallPrice.toFixed(2)} & <br/>SELL ${Math.abs(spreadQty)} ${shortCallStrike} CALL @ $${shortCallPrice.toFixed(2)}`,
                cost: spreadCost,
                lockedProfit: lockedProfit,
                potentialValue: potentialValue,
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
    // For single leg hedges, use the long put strike (not expanded range)
    const singleLegCallRange = higherPutStrike; // Start at long put strike
    
    console.log(`🔍 Looking for calls starting $${singleLegCallRange} (at long put strike $${higherPutStrike})`);
    
    const qualifyingCalls = marketData.filter(option => {
      return option.type === 'c' && option.strike >= singleLegCallRange && Number.isInteger(option.strike) && option.strike % 10 === 0;
    });
    
    console.log(`🔍 Found ${qualifyingCalls.length} calls at or above ${singleLegCallRange} for single leg hedge:`, qualifyingCalls.slice(0, 10).map(c => `${c.strike}@$${((c.bid + c.ask) / 2).toFixed(2)}`).join(', '));
    
    qualifyingCalls.forEach(option => {
      const callPrice = (option.bid + option.ask) / 2;
      const offsetCost = callPrice * Math.abs(spreadQty) * 100; // Cost to buy calls
      
      // For bear put spreads, calculate additional profit potential based on realistic scenarios
      // For calls: calculate value at the lowest put strike (most bearish scenario for the original position)
      const lowestPutStrike = Math.min(...putPositions.map(pp => pp.strike));
      const callValueAtLowestPut = Math.max(0, option.strike - lowestPutStrike) * 100 * Math.abs(spreadQty);
      
      // Potential value is the call's value at the lowest put strike
      const potentialValue = callValueAtLowestPut;
      
      // Locked profit is the minimum of (budget - cost) or (potential - budget - cost)
      const lockedProfit = Math.min(offsetBudget - offsetCost, potentialValue - offsetBudget - offsetCost);
      
      const upside = callValueAtLowestPut - lockedProfit - offsetCost; // Additional profit beyond locked profit
      
      // Total profit potential = locked profit + upside
      const totalProfitPotential = lockedProfit + upside;
      
      console.log(`🤔 Call ${option.strike}: cost $${offsetCost.toFixed(2)}, locked profit $${lockedProfit.toFixed(2)}, upside $${upside.toFixed(2)} (value at $${lowestPutStrike}), total potential $${totalProfitPotential.toFixed(2)}`);
      
      if (offsetCost <= offsetBudget && lockedProfit >= 0) {
        console.log(`✅ Risk-free call offset found!`);
        console.log(`   Locked profit: $${lockedProfit.toFixed(2)}`);
        console.log(`   Cost vs budget: $${offsetCost.toFixed(2)} vs $${offsetBudget.toFixed(2)}`);
        offsettingTrades.push({
          type: 'single_leg',
          description: `Long ${Math.abs(spreadQty)} ${option.strike} calls`,
          action: `BUY ${Math.abs(spreadQty)} ${option.strike} CALL @ $${callPrice.toFixed(2)}`,
          cost: offsetCost,
          lockedProfit: lockedProfit,
          potentialValue: potentialValue,
          additionalProfitPotential: upside,
          totalProfitPotential: totalProfitPotential,
          riskNeutralized: true,
          originalPosition: `Bear put spread ${spreadQty} ${shortPut ? shortPut.strike : 'N/A'}/${longPutStrike}p`,
          offsettingPosition: `Long ${Math.abs(spreadQty)} ${option.strike} calls`
        });
      }
    });
    
    console.log(`🔍 Bear put spread offsetting analysis completed`);
    console.log(`  Total offsetting trades found: ${offsettingTrades.length}`);
    
    // Don't return here - let the function continue to the end
  }
  
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
      
      console.log(`🔍 Looking for puts starting $${putStrikeRange} (100 points above higher call $${higherCallStrike})`);
      
      // Single leg offset: long put at same or higher strike
      // For single leg hedges, use the short call strike (not expanded range)
      const singleLegPutRange = higherCallStrike; // Start at short call strike
      
      console.log(`🔍 Looking for puts starting $${singleLegPutRange} (at short call strike $${higherCallStrike})`);
      
      const qualifyingPuts = marketData.filter(option => {
        return option.type === 'p' && option.strike >= singleLegPutRange && Number.isInteger(option.strike) && option.strike % 10 === 0;
      });
      
      console.log(`🔍 Found ${qualifyingPuts.length} puts at or above ${singleLegPutRange}:`, 
        qualifyingPuts.map(p => `${p.strike}@$${((p.bid + p.ask) / 2).toFixed(2)}`));
      
      qualifyingPuts.forEach(option => {
        const putPrice = (option.bid + option.ask) / 2;
        const offsetCost = putPrice * Math.abs(positionQty) * 100; // Cost to buy puts
        
        // Calculate additional profit potential based on realistic scenarios
        // For puts: calculate value at the lowest call strike (most bullish scenario for the original position)
        const lowestCallStrike = Math.min(...callPositions.map(cp => cp.strike));
        const putValueAtLowestCall = Math.max(0, option.strike - lowestCallStrike) * 100 * Math.abs(positionQty);
        
        // Maximum potential value of the new put trade
        const potentialValue = putValueAtLowestCall;
        
        // Filter out puts where potential value is less than the position being offset
        // For short calls, the position's potential value is the premium received
        const shortCall = callPositions.find(cp => cp.strike === shortCallStrike);
        const positionPotentialValue = shortCall ? shortCall.premium * 100 * Math.abs(shortCall.qty) : 0;
        
        if (potentialValue < positionPotentialValue) {
          console.log(`❌ Long put rejected: potential value $${potentialValue.toFixed(2)} < short call potential $${positionPotentialValue.toFixed(2)}`);
          return; // Skip this put
        }
        
        // Locked profit is the minimum of (budget - cost) or (potential - budget - cost)
        const lockedProfit = Math.min(offsetBudget - offsetCost, potentialValue - offsetBudget - offsetCost);
        
        const upside = putValueAtLowestCall - lockedProfit - offsetCost; // Additional profit beyond locked profit
        
        // Total profit potential = locked profit + upside
        const totalProfitPotential = lockedProfit + upside;
        
        console.log(`🤔 Put ${option.strike}: cost $${offsetCost.toFixed(2)}, locked profit $${lockedProfit.toFixed(2)}, upside $${upside.toFixed(2)} (value at $${lowestCallStrike}), total potential $${totalProfitPotential.toFixed(2)}`);
        
        if (offsetCost <= offsetBudget && lockedProfit >= 0) {
          console.log(`✅ Risk-free single leg offset found!`);
          console.log(`   Locked profit: $${lockedProfit.toFixed(2)}`);
          console.log(`   Cost vs budget: $${offsetCost.toFixed(2)} vs $${offsetBudget.toFixed(2)}`);
          offsettingTrades.push({
            type: 'single_leg',
            description: `Long ${Math.abs(positionQty)} ${option.strike} puts`,
            action: `BUY ${Math.abs(positionQty)} ${option.strike} PUT @ $${putPrice.toFixed(2)}`,
            cost: offsetCost,
            lockedProfit: lockedProfit,
            potentialValue: potentialValue,
            additionalProfitPotential: upside,
            totalProfitPotential: totalProfitPotential,
            riskNeutralized: true,
            originalPosition: `Short ${Math.abs(positionQty)} ${shortCallStrike} calls`,
            offsettingPosition: `Long ${Math.abs(positionQty)} ${option.strike} puts`
          });
        }
      });
      
      // Spread offset: bear put spread (buy higher strike, sell lower strike)
      // Use the same outerCallStrike and putStrikeRange from single leg logic
      
      const availablePuts = marketData.filter(opt => opt.type === 'p' && opt.strike >= putStrikeRange && Number.isInteger(opt.strike) && opt.strike % 10 === 0);
      
      console.log(`🔍 Checking bear put spreads with ${availablePuts.length} puts`);
      console.log(`🔍 Available puts:`, availablePuts.map(p => `${p.strike}@$${((p.bid + p.ask) / 2).toFixed(2)}`));
      
      // Sort puts by strike (ascending) for proper spread construction
      const sortedPuts = availablePuts.sort((a, b) => a.strike - b.strike);
      console.log(`🔍 Sorted puts:`, sortedPuts.map(p => `${p.strike}@$${((p.bid + p.ask) / 2).toFixed(2)}`));
      
      // Check multiple spread combinations
      const minSpreadWidth = 10;  // Minimum $10 spread width
      const spreadIncrement = 10; // Check in $10 increments
      const maxSpreadsToCheck = 50; // Increase limit to show more options
      
      let spreadCount = 0;
      
      for (let i = 0; i < sortedPuts.length && spreadCount < maxSpreadsToCheck; i++) {
        const shortPut = sortedPuts[i]; // Lower strike (sell)
        
        for (let j = i + 1; j < sortedPuts.length && spreadCount < maxSpreadsToCheck; j++) {
          const longPut = sortedPuts[j]; // Higher strike (buy)
          const spreadWidth = longPut.strike - shortPut.strike;
          
          // Only check spreads within minimum width range and in $10 increments
          if (spreadWidth >= minSpreadWidth && spreadWidth % spreadIncrement === 0) {
            
            //console.log(`🔍 Checking spread: buy ${longPut.strike} put, sell ${shortPut.strike} put (width: $${spreadWidth})`);
            
            const longPutPrice = (longPut.bid + longPut.ask) / 2;
            const shortPutPrice = (shortPut.bid + shortPut.ask) / 2;
            
            // Bear put spread: buy higher strike, sell lower strike
            // This costs money: (higher strike price - lower strike price) * quantity * 100
            const spreadCost = (longPutPrice - shortPutPrice) * Math.abs(positionQty) * 100;
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
              //console.log(`❌ Put spread rejected: potential value $${spreadMaxValue.toFixed(2)} < position potential $${positionPotentialValue.toFixed(2)}`);
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
                lockedProfit: lockedProfit,
                potentialValue: potentialValue,
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
      
      // For long puts, we want bullish offsets: bull call spreads or long calls
      const putStrike = longPutStrike;
      const callStrikeRange = putStrike + 100; // Start 100 points above put strike
      
      console.log(`🔍 Looking for calls starting $${callStrikeRange} (100 points above put $${putStrike})`);
      
      // Call spread offset: bull call spread (buy lower strike, sell higher strike)
      const availableCalls = marketData.filter(opt => {
        return opt.type === 'c' && opt.strike >= callStrikeRange && Number.isInteger(opt.strike) && opt.strike % 10 === 0;
      });
      
      console.log(`🔍 Found ${availableCalls.length} call strikes for bull call spreads:`, availableCalls.slice(0, 10).map(c => `${c.strike}@$${((c.bid + c.ask) / 2).toFixed(2)}`).join(', '));
      
      // Extract call strikes from availableCalls
      const callStrikes = availableCalls.map(c => c.strike);
      
      // Sort calls by strike (ascending) for proper spread construction
      const sortedCalls = availableCalls.sort((a, b) => a.strike - b.strike);
      console.log(`🔍 Sorted calls:`, sortedCalls.map(c => `${c.strike}@$${((c.bid + c.ask) / 2).toFixed(2)}`));
      
      // Check multiple spread combinations
      const minSpreadWidth = 10;  // Minimum $10 spread width
      const spreadIncrement = 10; // Check in $10 increments
      const maxSpreadsToCheck = 20; // Increase limit to check more spreads
      
      let spreadCount = 0;
      
      console.log(`🔍 Starting bull call spread analysis for long put hedge:`);
      console.log(`  callStrikes length: ${callStrikes.length}`);
      console.log(`  maxSpreadsToCheck: ${maxSpreadsToCheck}`);
      
      for (let i = 0; i < callStrikes.length && spreadCount < maxSpreadsToCheck; i++) {
        const longCallStrike = callStrikes[i]; // Lower strike (buy)
        
        for (let j = i + 1; j < callStrikes.length && spreadCount < maxSpreadsToCheck; j++) {
          const shortCallStrike = callStrikes[j]; // Higher strike (sell)
          const spreadWidth = shortCallStrike - longCallStrike;
          
          console.log(`🔍 Checking spread ${longCallStrike}/${shortCallStrike} (width: $${spreadWidth})`);
          
          // Only check spreads within minimum width range and in $10 increments
          if (spreadWidth >= minSpreadWidth && spreadWidth % spreadIncrement === 0) {
            
            console.log(`✅ Processing spread ${longCallStrike}/${shortCallStrike} (width: $${spreadWidth})`);
            
            // Only process spreads up to $500 width to avoid excessive calculations
            if (spreadWidth > 500) {
              console.log(`⏭️ Skipping spread ${longCallStrike}/${shortCallStrike} - width $${spreadWidth} exceeds $500 limit`);
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
              const spreadCost = (longCallPrice - shortCallPrice) * Math.abs(positionQty) * 100;
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
              
              // Locked profit is the minimum of (budget - cost) or (potential - budget - cost)
              const lockedProfit = Math.min(offsetBudget - spreadCost, potentialValue - offsetBudget - spreadCost);
              
              // Calculate additional profit potential for the spread based on realistic scenarios
              // For bull call spreads: maximum value is the spread width (difference between strikes)
              const upside = spreadMaxValue - lockedProfit - spreadCost; // Additional profit beyond locked profit
              
              // Total profit potential = locked profit + upside
              const totalProfitPotential = lockedProfit + upside;
              
              console.log(`🤔 Spread ${longCallStrike}/${shortCallStrike}: cost $${spreadCost.toFixed(2)}, locked profit $${lockedProfit.toFixed(2)}, upside $${upside.toFixed(2)} (max value: $${spreadMaxValue.toFixed(2)}), total potential $${totalProfitPotential.toFixed(2)}`);
              
              if (spreadCost <= offsetBudget && lockedProfit >= 0) {
                console.log(`✅ Risk-free spread offset found!`);
                console.log(`   Locked profit: $${lockedProfit.toFixed(2)}`);
                console.log(`   Cost vs budget: $${spreadCost.toFixed(2)} vs $${offsetBudget.toFixed(2)}`);
                offsettingTrades.push({
                  type: 'spread',
                  description: `Bull ${Math.abs(positionQty)} ${longCallStrike}/${shortCallStrike} call spread`,
                  action: `BUY ${Math.abs(positionQty)} ${longCallStrike} CALL @ $${longCallPrice.toFixed(2)} & <br/>SELL ${Math.abs(positionQty)} ${shortCallStrike} CALL @ $${shortCallPrice.toFixed(2)}`,
                  cost: spreadCost,
                  lockedProfit: lockedProfit,
                  potentialValue: potentialValue,
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
      // For single leg hedges, use the put strike (not expanded range)
      const singleLegCallRange = putStrike; // Start at put strike
      
      console.log(`🔍 Looking for calls starting $${singleLegCallRange} (at put strike $${putStrike})`);
      
      const qualifyingCalls = marketData.filter(option => {
        return option.type === 'c' && option.strike >= singleLegCallRange && Number.isInteger(option.strike) && option.strike % 10 === 0;
      });
      
      console.log(`🔍 Found ${qualifyingCalls.length} calls at or above ${singleLegCallRange} for single leg hedge:`, qualifyingCalls.slice(0, 10).map(c => `${c.strike}@$${((c.bid + c.ask) / 2).toFixed(2)}`).join(', '));
      
      qualifyingCalls.forEach(option => {
        const callPrice = (option.bid + option.ask) / 2;
        const offsetCost = callPrice * Math.abs(positionQty) * 100; // Cost to buy calls
        
        // For long puts, calculate additional profit potential based on realistic scenarios
        // For calls: calculate value at the put strike (most bearish scenario for the original position)
        const callValueAtPutStrike = Math.max(0, option.strike - putStrike) * 100 * Math.abs(positionQty);
        
        // Potential value is the call's value at the put strike
        const potentialValue = callValueAtPutStrike;
        
        // Locked profit is the minimum of (budget - cost) or (potential - budget - cost)
        const lockedProfit = Math.min(offsetBudget - offsetCost, potentialValue - offsetBudget - offsetCost);
        
        const upside = callValueAtPutStrike - lockedProfit - offsetCost; // Additional profit beyond locked profit
        
        // Total profit potential = locked profit + upside
        const totalProfitPotential = lockedProfit + upside;
        
        console.log(`🤔 Call ${option.strike}: cost $${offsetCost.toFixed(2)}, locked profit $${lockedProfit.toFixed(2)}, upside $${upside.toFixed(2)} (value at $${putStrike}), total potential $${totalProfitPotential.toFixed(2)}`);
        
        if (offsetCost <= offsetBudget && lockedProfit >= 0) {
          console.log(`✅ Risk-free call offset found!`);
          console.log(`   Locked profit: $${lockedProfit.toFixed(2)}`);
          console.log(`   Cost vs budget: $${offsetCost.toFixed(2)} vs $${offsetBudget.toFixed(2)}`);
          offsettingTrades.push({
            type: 'single_leg',
            description: `Long ${Math.abs(positionQty)} ${option.strike} calls`,
            action: `BUY ${Math.abs(positionQty)} ${option.strike} CALL @ $${callPrice.toFixed(2)}`,
            cost: offsetCost,
            lockedProfit: lockedProfit,
            potentialValue: potentialValue,
            additionalProfitPotential: upside,
            totalProfitPotential: totalProfitPotential,
            riskNeutralized: true,
            originalPosition: `Long ${positionQty} ${longPutStrike} puts`,
            offsettingPosition: `Long ${Math.abs(positionQty)} ${option.strike} calls`
          });
        }
      });
      
      console.log(`🔍 Long put offsetting analysis completed`);
      console.log(`  Total offsetting trades found: ${offsettingTrades.length}`);
    }
  });
  
  // Separate trades by cost sign first
  const positiveCostTrades = offsettingTrades.filter(trade => trade.cost >= 0);
  const negativeCostTrades = offsettingTrades.filter(trade => trade.cost < 0);
  console.log(`💰 Cost separation: ${positiveCostTrades.length} positive cost, ${negativeCostTrades.length} negative cost`);
  
  // Apply Pareto optimization to positive cost trades
  let positiveParetoOptimal = [];
  let positiveDominated = [];
  
  if (positiveCostTrades.length > 0) {
    positiveParetoOptimal = findParetoOptimal(positiveCostTrades);
    positiveDominated = positiveCostTrades.filter(trade => !positiveParetoOptimal.includes(trade));
    
    console.log(`📈 Positive cost trades: ${positiveParetoOptimal.length} Pareto optimal, ${positiveDominated.length} dominated`);
  }
  
  // Apply Pareto optimization to negative cost trades
  let negativeParetoOptimal = [];
  let negativeDominated = [];
  
  if (negativeCostTrades.length > 0) {
    negativeParetoOptimal = findParetoOptimal(negativeCostTrades);
    negativeDominated = negativeCostTrades.filter(trade => !negativeParetoOptimal.includes(trade));
    
    console.log(`📉 Negative cost trades: ${negativeParetoOptimal.length} Pareto optimal, ${negativeDominated.length} dominated`);
  }
  
  // Combine results: Pareto optimal positive cost first, then Pareto optimal negative cost
  const sortedTrades = [
    ...positiveParetoOptimal,
    ...negativeParetoOptimal
  ];
  
  // Log top optimal trades
  // console.log(`🏆 Best positive cost trades:`);
  // positiveParetoOptimal.slice(0, 3).forEach((trade, index) => {
  //   console.log(`  ${index + 1}. ${trade.description}: Locked $${trade.lockedProfit.toFixed(2)}, Potential $${trade.totalProfitPotential.toFixed(2)}, Total $${(trade.lockedProfit + trade.totalProfitPotential).toFixed(2)}`);
  // });
  
  console.log('🎯 Found offsetting trades:', sortedTrades);
  console.log(`📊 Total offsetting opportunities: ${sortedTrades.length}`);
  
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

// Update the testSchwabConnection function to update button visibility
const originalTestSchwabConnection = testSchwabConnection;
if (typeof originalTestSchwabConnection === 'function') {
  testSchwabConnection = function() {
    originalTestSchwabConnection();
    // Update button visibility after connection test
    setTimeout(updateConnectionButtonVisibility, 1000);
  };
}
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
        console.log('📊 fullOptionArray length:', fullOptionArray.length);
        console.log('📊 options length:', options.length);
        
        const offsettingTrades = findOffsettingTrades(fullOptionArray, options);
        console.log('🔍 findOffsettingTrades returned:', offsettingTrades);
        console.log('🔍 offsettingTrades type:', typeof offsettingTrades);
        
        if (offsettingTrades && offsettingTrades.length > 0) {
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
  
  // Update every 10 seconds
  liveDataInterval = setInterval(() => {
    if (liveDataEnabled && currentSymbol && schwabConnected) {
      updateCalculatorWithLiveData(currentSymbol);
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
