/**
 * Candle Analysis Module
 * Fetches and displays candle analysis data for multiple timeframes
 */

let candleAnalysisInterval = null;

// Track collapse state for each candle analysis container
const candleAnalysisCollapseState = {
  'candle-analysis-1m': true,   // default collapsed
  'candle-analysis-5m': true,   // default collapsed
  'candle-analysis-15m': true,  // default collapsed
  'candle-analysis-60m': true   // default collapsed
};

/**
 * Get the API base URL (evaluates PROXY_URL at runtime)
 * @returns {string} API base URL
 */
function getCandleApiBase() {
  return (typeof PROXY_URL !== 'undefined' ? PROXY_URL : 'http://localhost:3001') + '/api/v1/marketdata';
}

/**
 * Fetch candle analysis for a symbol
 * @param {string} symbol - The symbol to analyze
 * @param {string} timeframe - Optional timeframe filter (1m, 5m, 15m, 60m)
 * @returns {Promise<Object>} Candle analysis data
 */
async function fetchCandleAnalysis(symbol, timeframe = null) {
  try {
    let url = `${getCandleApiBase()}/candleanalysis?symbol=${symbol}`;
    if (timeframe) {
      url += `&timeframe=${timeframe}`;
    }
    
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Error fetching candle analysis:', error);
    throw error;
  }
}

/**
 * Format a number to 2 decimal places
 * @param {number} value - The value to format
 * @returns {string} Formatted value
 */
function formatPrice(value) {
  if (value === null || value === undefined) {
    return '--';
  }
  return value.toFixed(2);
}

/**
 * Format trend score with color coding
 * @param {number} score - Trend score (-10 to +10)
 * @returns {string} HTML string with color
 */
function formatTrendScore(score) {
  if (score === null || score === undefined) {
    return '<span>--</span>';
  }
  
  let color = '#333';
  if (score > 6) {
    color = '#00aa00'; // Strong uptrend - light green
  } else if (score < -6) {
    color = '#aa0000'; // Strong downtrend - light red
  } else if (score > 3) {
    color = '#80ff80ff'; // Medium uptrend - green
  } else if (score < -3) {
    color = '#ff7f7fff'; // Medium downtrend - red
  } else if (score > 0) {
    color = '#88cc88'; // Weak downtrend - light green
  } else if (score < 0) {
    color = '#cc8888'; // Weak downtrend - light red
  }
  
  return `<span style="color: ${color}; font-weight: bold;">${score}</span>`;
}

/**
 * Format BB score with color coding
 * @param {number} score - BB score
 * @returns {string} HTML string with color
 */
function formatBBScore(score) {
  if (score === null || score === undefined) {
    return '<span>--</span>';
  }
  
  let color = '#333'; // default
  let label = '';
  
  if (score <= -0.8) {
    color = '#aa0000'; // At or above upper band - overbought
    label = ' (overbought)';
  } else if (score < -0.4) {
    color = '#cc8888'; // Approaching upper band
    label = ' (↓)';
  } else if (score >= 0.8) {
    color = '#00aa00'; // At or below lower band - oversold
    label = ' (oversold)';
  } else if (score > 0.4) {
    color = '#88cc88'; // Approaching lower band
    label = ' (↑)';
  }
  
  return `<span style="color: ${color}; font-weight: bold;">${score.toFixed(2)}${label}</span>`;
}

/**
 * Calculate background color based on trend score
 * @param {number} trendScore - Trend score (positive = bullish, negative = bearish)
 * @returns {string} Background color
 */
function getTrendBackgroundColor(trendScore) {
  if (trendScore > 0) {
    // Positive trend - shades of green
    const intensity = Math.min(Math.abs(trendScore) / 2, 1); // Normalize to 0-1
    return `rgba(0, 200, 0, ${intensity})`; // Light green with transparency
  } else if (trendScore < 0) {
    // Negative trend - shades of red
    const intensity = Math.min(Math.abs(trendScore) / 2, 1); // Normalize to 0-1
    return `rgba(200, 0, 0, ${intensity})`; // Light red with transparency
  } else {
    // Neutral - no color
    return 'transparent';
  }
}

/**
 * Calculate border color based on BB score
 * @param {number} bbScore - BB score (negative = oversold/green, positive = overbought/red)
 * @returns {string} Border color
 */
function getBBBorderColor(bbScore) {
  if (bbScore < 0) {
    // Negative BB score - oversold - shades of green
    const intensity = Math.min(Math.abs(bbScore) / 2, 1); // Normalize to 0-1
//    const greenValue = Math.min(255*intensity,255);
//    return `rgb(0, ${greenValue}, 0)`; // Green border
    return `rgba(0, 200, 0, ${intensity})`; // Light green with transparency
  } else if (bbScore > 0) {
    // Positive BB score - overbought - shades of red
    const intensity = Math.min(Math.abs(bbScore) / 2, 1); // Normalize to 0-1
//    const redValue = Math.min(255*intensity,255);
//    return `rgb(${redValue}, 0, 0)`; // Red border
    return `rgba(200, 0, 0, ${intensity})`; // Light red with transparency
  } else {
    // Neutral - default border
    return '#ddd';
  }
}

/**
 * Toggle collapse state of candle analysis container
 * @param {string} divId - The div ID to toggle
 */
function toggleCandleAnalysis(divId) {
  const detailsDiv = document.getElementById(`${divId}-details`);
  const toggleBtn = document.getElementById(`${divId}-toggle`);
  
  if (detailsDiv && toggleBtn) {
    const isExpanded = detailsDiv.style.display !== 'none';
    const newState = !isExpanded; // true = collapsed, false = expanded
    
    detailsDiv.style.display = isExpanded ? 'none' : 'block';
    toggleBtn.textContent = isExpanded ? '▼' : '▲';
    
    // Save the state
    candleAnalysisCollapseState[divId] = newState;
  }
}

/**
 * Display candle analysis data in a div
 * @param {string} divId - The div ID to update
 * @param {Object} candleData - Candle data for the timeframe
 * @param {string} timeframe - Timeframe label
 */
function displayCandleAnalysis(divId, candleData, timeframe) {
  const div = document.getElementById(divId);
  if (!div) {
    console.error(`Div ${divId} not found`);
    return;
  }
  
  if (!candleData || candleData.error) {
    div.innerHTML = `<div class="candle-analysis-error">Error loading ${timeframe} data</div>`;
    return;
  }
  
  // Get the most recent candle
  const candles = candleData.candles;
  if (!candles || candles.length === 0) {
    div.innerHTML = `<div class="candle-analysis-error">No ${timeframe} data available</div>`;
    return;
  }
  
  const latestCandle = candles[0]; // Server returns newest first
  const trendScore = candleData.trendScore || 0;
  const bbScore = candleData.bbScore || 0;
  
  // Get EST time
  const timeEST = latestCandle.timeEST || '--';
  
  // Get first 50 candles (server returns newest first, so we take from start)
  const recentCandles = candles.slice(0, 50);
  
  // Build OHLC table rows for recent candles with indicators
  // Display with most recent at top, going back in time (same order as server returns)
  let tableRows = '';
  for (let i = 0; i < recentCandles.length; i++) {
    const candle = recentCandles[i];
    const candleTime = candle.timeEST || '--';
    const indicators = candle.indicators || {};
    const bb = indicators.bollinger20_2 || {};
    const trendScore = candle.trendScore !== undefined ? candle.trendScore : '--';
    const bbScore = candle.bbScore !== undefined ? candle.bbScore.toFixed(2) : '--';
    
    tableRows += `
      <tr>
        <td>${candleTime}</td>
        <td>${formatPrice(candle.open)}</td>
        <td>${formatPrice(candle.high)}</td>
        <td>${formatPrice(candle.low)}</td>
        <td>${formatPrice(candle.close)}</td>
        <td>${formatPrice(indicators.sma20)}</td>
        <td>${formatPrice(indicators.ema9)}</td>
        <td>${formatPrice(bb.upper)}</td>
        <td>${formatPrice(bb.lower)}</td>
        <td>${trendScore}</td>
        <td>${bbScore}</td>
        <td>${candleTime}</td>
      </tr>
    `;
  }
  
  // Calculate colors based on scores
  const backgroundColor = getTrendBackgroundColor(trendScore);
  const borderColor = getBBBorderColor(bbScore);
  
  // Preserve the current collapse state by checking the actual DOM
  const existingDetails = document.getElementById(`${divId}-details`);
  let currentState = candleAnalysisCollapseState[divId]; // default to saved state
  
  // If element exists, use its actual display state
  if (existingDetails) {
    currentState = existingDetails.style.display === 'none';
    // Update saved state to match reality
    candleAnalysisCollapseState[divId] = currentState;
  }
  
  const html = `
    <div class="candle-analysis-container">
      <div class="candle-analysis-compact" style="background-color: ${backgroundColor}; border: 2px solid ${borderColor};">
        <div class="candle-header-row">
          <button id="${divId}-toggle" class="collapse-toggle" onclick="toggleCandleAnalysis('${divId}')" title="Toggle details">${currentState ? '▼' : '▲'}</button>
          <span class="timeframe-label">${timeframe}</span>
          <span class="time-est">${timeEST}</span>
          <span class="score-label">Trend:</span><span class="score-value">${formatTrendScore(trendScore)}</span>
          <span class="score-label">BB:</span><span class="score-value">${formatBBScore(bbScore)}</span>
        </div>
        <div class="candle-ohlc-row">
          <span class="ohlc-label">O:</span><span class="ohlc-value">${formatPrice(latestCandle.open)}</span>
          <span class="ohlc-label">H:</span><span class="ohlc-value">${formatPrice(latestCandle.high)}</span>
          <span class="ohlc-label">L:</span><span class="ohlc-value">${formatPrice(latestCandle.low)}</span>
          <span class="ohlc-label">C:</span><span class="ohlc-value">${formatPrice(latestCandle.close)}</span>
        </div>
      </div>
      <div id="${divId}-details" class="candle-details" style="display: ${currentState ? 'none' : 'block'};">
        <table class="candle-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Open</th>
              <th>High</th>
              <th>Low</th>
              <th>Close</th>
              <th>SMA20</th>
              <th>EMA9</th>
              <th>BB Upper</th>
              <th>BB Lower</th>
              <th>Trend</th>
              <th>BB Score</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
            ${tableRows}
          </tbody>
        </table>
      </div>
    </div>
  `;
  
  div.innerHTML = html;
}

/**
 * Update all candle analysis displays
 * @param {string} symbol - The symbol to analyze
 */
async function updateAllCandleAnalysis(symbol) {
  if (!symbol) {
    console.error('No symbol provided for candle analysis');
    return;
  }
  
  try {
    console.log(`Fetching candle analysis for ${symbol}...`);
    const analysis = await fetchCandleAnalysis(symbol);
    
    if (analysis.status === 'error') {
      console.error('Candle analysis error:', analysis.error);
      return;
    }
    
    const candleData = analysis.candleData;
    
    // Debug: Log what we received
    console.log('Candle data received:', {
      '1m': candleData['1m'] ? `${candleData['1m'].candles?.length} candles` : 'missing',
      '5m': candleData['5m'] ? `${candleData['5m'].candles?.length} candles` : 'missing',
      '15m': candleData['15m'] ? `${candleData['15m'].candles?.length} candles` : 'missing',
      '1h': candleData['1h'] ? `${candleData['1h'].candles?.length} candles` : 'missing'
    });
    
    // Debug: Log latest candle for each timeframe
    if (candleData['1m']?.candles?.length > 0) {
      console.log('1m latest:', candleData['1m'].candles[candleData['1m'].candles.length - 1]);
    }
    if (candleData['5m']?.candles?.length > 0) {
      console.log('5m latest:', candleData['5m'].candles[candleData['5m'].candles.length - 1]);
    }
    if (candleData['15m']?.candles?.length > 0) {
      console.log('15m latest:', candleData['15m'].candles[candleData['15m'].candles.length - 1]);
    }
    if (candleData['1h']?.candles?.length > 0) {
      console.log('1h latest:', candleData['1h'].candles[candleData['1h'].candles.length - 1]);
    }
    
    // Update each timeframe display
    if (candleData['1m']) {
      displayCandleAnalysis('candle-analysis-1m', candleData['1m'], '1m');
    }
    if (candleData['5m']) {
      displayCandleAnalysis('candle-analysis-5m', candleData['5m'], '5m');
    }
    if (candleData['15m']) {
      displayCandleAnalysis('candle-analysis-15m', candleData['15m'], '15m');
    }
    if (candleData['1h']) {
      displayCandleAnalysis('candle-analysis-60m', candleData['1h'], '60m');
    }
    
    console.log('✅ Candle analysis updated successfully - scores:', {
  '1m': candleData['1m']?.candles?.[candleData['1m'].candles.length - 1]?.trendScore,
  '5m': candleData['5m']?.candles?.[candleData['5m'].candles.length - 1]?.trendScore,
  '15m': candleData['15m']?.candles?.[candleData['15m'].candles.length - 1]?.trendScore,
  '60m': candleData['1h']?.candles?.[candleData['1h'].candles.length - 1]?.trendScore
});
  } catch (error) {
    console.error('Failed to update candle analysis:', error);
  }
}

/**
 * Start auto-updating candle analysis
 * @param {string} symbol - The symbol to track
 * @param {number} intervalMs - Update interval in milliseconds (default 60000 = 1 minute)
 */
function startCandleAnalysisUpdates(symbol, intervalMs = 60000) {
  // Stop any existing interval
  stopCandleAnalysisUpdates();
  
  // Initial update
  updateAllCandleAnalysis(symbol);
  
  // Set up recurring updates
  candleAnalysisInterval = setInterval(() => {
    console.log(`🕯️ Updating candle analysis for ${symbol}...`);
    updateAllCandleAnalysis(symbol);
  }, intervalMs);
  
  console.log(`Started candle analysis auto-update for ${symbol} (every ${intervalMs}ms)`);
}

/**
 * Stop auto-updating candle analysis
 */
function stopCandleAnalysisUpdates() {
  if (candleAnalysisInterval) {
    clearInterval(candleAnalysisInterval);
    candleAnalysisInterval = null;
    console.log('Stopped candle analysis auto-update');
  }
}
