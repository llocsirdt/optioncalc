// Schwab API Integration Functions

// Proxy server configuration, Dynamically detect environment and set appropriate proxy URL
// For local development: 'http://localhost:3001'
// For AWS deployment: 'https://your-env-name.eba-region.amazonaws.com'
const PROXY_URL = (window.location.href.startsWith('http') ? "http://llocsirdt-optioncalc.us-east-1.elasticbeanstalk.com" : "http://localhost:3001");

// Schwab API integration variables
let schwabConnected = false;
let currentSymbol = '';
let liveDataEnabled = false;
let liveDataIntervalDuration = 3000;

// The raw chain data currently backing the "Live Options Chain" UI table —
// stashed here so other features (e.g. portfolio risk analysis) can reuse the
// exact same data instead of making their own independent fetch. Cleared
// whenever live data is disabled or a chain fetch fails.
let lastLiveChainData = null;

// Fetch offsetting analysis for symbol and expiration
async function fetchOffsettingAnalysis(symbol, expiration) {
  if (!symbol || !expiration) {
    console.log('⚠️ Cannot fetch offsetting analysis - missing symbol or expiration');
    return null;
  }
  
  try {
    console.log(`🔍 Fetching offsetting analysis for ${symbol} ${expiration}...`);
    const response = await fetch(`${PROXY_URL}/api/v1/positions/offsetting?symbol=${symbol}&expiration=${expiration}`);
    
    if (!response.ok) {
      console.error(`❌ Failed to fetch offsetting analysis: ${response.status}`);
      return null;
    }
    
    const data = await response.json();
    const key = `${symbol}_${expiration}`;
    
    if (data.offsettingAnalysis && data.offsettingAnalysis[key]) {
      const analysis = data.offsettingAnalysis[key];
      
      console.log(`✅ Offsetting Analysis for ${symbol} ${expiration}:`);
      console.log(`   Positions found: ${analysis.positions.length}`);
      
      // Generate HTML for UI
      let offsettingHtml = '';
      
      analysis.positions.forEach((position, posIdx) => {
        const offsets = position.offsettingAnalysis?.possibleOffsets || [];
        
        if (offsets.length > 0) {
          offsettingHtml += '<div class="offsetting-trades server-based">';
          
          // Format strategy name
          const strategyName = position.strategy.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
          offsettingHtml += `<h4>🎯 Risk Offsetting Opportunities (Server) - ${strategyName}</h4>`;
          
          // Build detailed position info
          offsettingHtml += '<div class="position-info">';
          offsettingHtml += `<div class="position-summary">`;
          
          // Show legs
          if (position.legs && position.legs.length > 0) {
            const legDescriptions = position.legs.map(leg => {
              const type = leg.type === 'C' ? 'Call' : 'Put';
              const action = leg.quantity > 0 ? 'Long' : 'Short';
              const qty = Math.abs(leg.quantity);
              return `${action} ${qty} ${type} @ ${leg.strike}`;
            }).join(' | ');
            offsettingHtml += `<div class="position-legs"><strong>Position:</strong> ${legDescriptions}</div>`;
          }
          
          // Show financials
          const costLabel = position.cost < 0 ? 'Credit' : 'Cost';
          const costValue = Math.abs(position.cost);
          offsettingHtml += `<div class="position-financials">`;
          offsettingHtml += `<span><strong>${costLabel}:</strong> $${costValue.toFixed(0)}</span> | `;
          offsettingHtml += `<span><strong>Offset Budget:</strong> $${position.offsetBudget.toFixed(0)}</span> | `;
          offsettingHtml += `<span><strong>Max Value:</strong> $${Math.abs(position.maxValue).toFixed(0)}</span> | `;
          offsettingHtml += `<span><strong>Width:</strong> ${position.spreadWidth}</span>`;
          offsettingHtml += `</div>`;
          
          offsettingHtml += `</div></div>`;
          
          // Show top 10 offsetting positions
          offsets.slice(0, 50).forEach((offset, index) => {
            const cost = Math.abs(offset.cost);
            const costLabel = offset.cost < 0 ? 'Credit' : 'Cost';
            const profitClass = offset.profitPotential > 0 ? 'profit-positive' : 'profit-neutral';
            
            // Check if locked profit is less than 10% of the cost (only for debit spreads)
            const tenPercentOfCost = cost * 0.1;
            const lowLockedClass = (offset.cost > 0 && offset.lockedInProfit < tenPercentOfCost) ? 'low-locked-profit' : '';
            
            // Check if cost is less than locked in value for green background
            const costLessThanLockedClass = cost < offset.lockedInProfit ? 'cost-less-than-locked' : '';
            const costLessThanLockedTooltip = costLessThanLockedClass ? ' (Cost less than locked value - great deal!)' : '';
            
            // Format strategy name for display
            const strategyDisplay = offset.strategy.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
            
            // Create description from legs
            let description = `${strategyDisplay}`;
            if (offset.legs && offset.legs.length > 0) {
              const strikes = offset.legs.map(leg => leg.strike).join('/');
              description += ` ${strikes}`;
            }
            
            // Generate action string for clicking strikes in the table
            let action = '';
            if (offset.legs && offset.legs.length > 0) {
              action = offset.legs.map(leg => {
                // Server-side now provides type property (C/P), same as client-side
                const type = leg.type === 'C' ? 'Call' : 'Put';
                // Server-side uses 'qty' property, not 'quantity'
                const qty = leg.qty || leg.quantity || 0;
                const side = qty > 0 ? 'Buy' : 'Sell';
                return `${side} ${Math.abs(qty)} ${type} ${leg.strike}`;
              }).join(', ');
            }
            
            offsettingHtml += `
              <div class="offset-trade server-offset ${offset.strategy} ${lowLockedClass} ${costLessThanLockedClass} clickable-offset-trade" 
                   data-description="${description.replace(/"/g, '&quot;')}"
                   data-action="${action.replace(/"/g, '&quot;')}"
                   data-index="${index}"
                   title="Click to select these options in the table${costLessThanLockedTooltip}">
                <div class="trade-description">
                  <strong>${description}</strong>
                  <div class="trade-action">${action}</div>
                  <div class="trade-cost">${costLabel}: $${cost.toFixed(2)}</div>
                </div>
                <div class="trade-metrics">
                  <div class="trade-potential">Potential: $${offset.profitPotential.toFixed(2)}</div>
                  <div class="trade-locked-profit">Locked: $${offset.lockedInProfit.toFixed(2)}</div>
                  <div class="trade-score">Score: ${offset.profitPotentialScore.toFixed(4)}</div>
                </div>
              </div>
            `;
          });
          
          offsettingHtml += '</div>';
        }
        
        // Console logging
        console.log(`\n   Position ${posIdx + 1}: ${position.strategy}`);
        console.log(`     Cost: $${position.cost}, Max Value: $${position.maxValue}`);
        console.log(`     Spread Width: ${position.spreadWidth}`);
        console.log(`     Total offsetting positions: ${offsets.length}`);
        
        // Count by strategy
        const strategies = {};
        offsets.forEach(o => {
          strategies[o.strategy] = (strategies[o.strategy] || 0) + 1;
        });
        
        if (Object.keys(strategies).length > 0) {
          console.log(`     Breakdown by strategy:`);
          Object.entries(strategies).sort().forEach(([strategy, count]) => {
            console.log(`       ${strategy}: ${count}`);
          });
        }
      });
      
      return {
        analysis: analysis,
        html: offsettingHtml
      };
    } else {
      console.log(`⚠️ No offsetting analysis found for ${symbol} ${expiration}`);
      return null;
    }
  } catch (error) {
    console.error('❌ Error fetching offsetting analysis:', error);
    return null;
  }
}

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
    // Clear expiration cache if symbol changed
    if (currentSymbol !== symbol) {
      console.log('🔄 Symbol changed from', currentSymbol, 'to', symbol);
      clearExpirationCache();
    }
    
    localStorage.setItem('lastSymbol', symbol);
    currentSymbol = symbol;
    console.log('💾 Saved symbol:', symbol);
  }
}

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
    const response = await fetch(`${PROXY_URL}/api/v1/marketdata/quotes?symbols=SPY`);
    
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
    statusElement.className = 'schwab-status';
    
    if (type === 'success') {
      statusElement.classList.add('connected');
    } else if (type === 'error') {
      statusElement.classList.add('error');
    } else if (type === 'testing') {
      statusElement.classList.add('testing');
    }
  }
}

// Update connection button visibility based on connection status
function updateConnectionButtonVisibility() {
  const testButton = document.getElementById('test-connection');
  const statusElement = document.getElementById('schwab-status');
  
  if (testButton && statusElement) {
    const currentStatus = statusElement.textContent;
    
    if (currentStatus === 'Connected') {
      testButton.style.display = 'none';
      console.log('🔗 Connection active - hiding test button');
    } else {
      testButton.style.display = 'inline-block';
      console.log('🔗 Not connected - showing test button');
    }
  }
}

// Get real-time quote for underlying symbol
async function getUnderlyingQuote(symbol) {
  try {
    console.log(' Getting quote for symbol:', symbol);
    const response = await fetch(`${PROXY_URL}/api/v1/marketdata/quotes?symbols=${symbol}`);
    
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
          const altResponse = await fetch(`${PROXY_URL}/api/v1/marketdata/quotes?symbols=${altSymbol}`);
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
    console.log('🔗 DEBUG: Full URL:', `${PROXY_URL}/api/v1/marketdata/chains?${queryString}`);
    
    const response = await fetch(`${PROXY_URL}/api/v1/marketdata/chains?${queryString}`);
    
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
    const response = await fetch(`${PROXY_URL}/api/v1/marketdata/expirationchain?symbol=${symbol}`);
    
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

// Market hours tracking (shared with oc.js)
let lastApiSymbol = '';
let lastApiExpiration = '';
let hasCalledApiToday = false;

// Check if current time is within market hours (9 AM - 4 PM EST)
function isMarketHours() {
  const now = new Date();
  // Convert to EST (UTC-5 or UTC-4 during EDT)
  const estTime = new Date(now.toLocaleString("en-US", {timeZone: "America/New_York"}));
  const hour = estTime.getHours();
  const day = estTime.getDay();
  
  // Check if it's a weekday (Monday = 1, Friday = 5)
  if (day < 1 || day > 5) {
    console.log(`🕐 Weekend detected (day ${day}), market closed`);
    return false; // Weekend
  }
  
  // Market hours: 9 AM (9) to 4 PM (16) EST
  const inMarketHours = hour >= 9 && hour < 16;
  console.log(`🕐 Current EST time: ${hour}:00, market hours: ${inMarketHours ? 'OPEN' : 'CLOSED'}`);
  return inMarketHours;
}

// Check if we should make an API call based on market hours and data changes
function shouldMakeApiCall(symbol, expiration) {
  const marketHours = isMarketHours();
  
  console.log(`🤔 API Call Check - Symbol: "${symbol}", Expiration: "${expiration}", HasCalledToday: ${hasCalledApiToday}, LastSymbol: "${lastApiSymbol}", LastExpiration: "${lastApiExpiration}"`);
  
  // Always make initial call or if symbol/expiration changed
  if (!hasCalledApiToday || symbol !== lastApiSymbol || expiration !== lastApiExpiration) {
    console.log('✅ Making API call - initial call or data changed');
    hasCalledApiToday = true;
    lastApiSymbol = symbol;
    lastApiExpiration = expiration;
    return true;
  }
  
  // Outside market hours, skip additional calls
  if (!marketHours) {
    console.log('🕐 Outside market hours (9 AM - 4 PM EST), skipping API call');
    return false;
  }
  
  // During market hours, allow calls
  console.log('✅ During market hours, allowing API call');
  return true;
}

// Reset API call tracking (call when symbol or expiration changes intentionally)
function resetApiCallTracking() {
  hasCalledApiToday = false;
  lastApiSymbol = '';
  lastApiExpiration = '';
  console.log('🔄 API call tracking reset');
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
  
  const chainsMap__NO$ = {
    'NDX': 'NDX',     // Chains API requires %24 prefix
    'SPX': 'SPX',
    'DJX': 'DJX',
    'RUT': 'RUT',
    'VIX': 'VIX'
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

// Global variables for tracking current symbol and expirations
let currentSymbolForExpirations = null;
let cachedExpirations = null;

// Clear cached expirations (useful when switching symbols or refreshing)
function clearExpirationCache() {
  console.log('🗑️ Clearing expiration cache');
  currentSymbolForExpirations = null;
  cachedExpirations = null;
}

// Update calculator with live Schwab data
async function updateCalculatorWithLiveData(symbol) {
  if (!schwabConnected) {
    console.log('Schwab API not connected');
    return;
  }

  // Get current selected expiration
  const selectedExpiration = getSelectedExpiration ? getSelectedExpiration() : null;
  
  // Check if we should make an API call based on market hours and data changes
  if (!shouldMakeApiCall(symbol, selectedExpiration)) {
    return; // Skip API call if outside market hours and no data changes
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

    // Use cached expirations or load if symbol changed
    let expirations = cachedExpirations;
    const chainsSymbol = mapSymbolForAPI(symbol, 'chains'); // Define here for use later
    
    if (!expirations || currentSymbolForExpirations !== symbol) {
      console.log('🔄 Symbol changed or no cached expirations, loading expirations for:', symbol);
      console.log('🔗 DEBUG: chainsSymbol for API call:', chainsSymbol);
      expirations = await getOptionExpirationsFromSchwab(chainsSymbol);
      console.log('📅 Expirations data:', expirations);
      
      // Cache the expirations for this symbol
      if (expirations) {
        cachedExpirations = expirations;
        currentSymbolForExpirations = symbol;
        console.log('💾 Cached expirations for symbol:', symbol);
      }
    } else {
      console.log('📋 Using cached expirations for symbol:', symbol);
    }
    
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
        lastLiveChainData = {
          symbol: chainsSymbol,
          expiration: targetExpiration.expirationDate,
          raw: chainData,
          fetchedAt: Date.now()
        };

        const options = parseSchwabOptionsData(chainData, targetExpiration.expirationDate);
        console.log('📈 Parsed options:', options);
        console.log('🔄 Calling updateOptionsChain with', options.length, 'options');
        updateOptionsChain(options);
      } else {
        // Handle case where chains API fails (common for index options like NDX)
        lastLiveChainData = null;
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

// Global exports for browser
window.resetApiCallTracking = resetApiCallTracking;
window.isMarketHours = isMarketHours;
window.shouldMakeApiCall = shouldMakeApiCall;