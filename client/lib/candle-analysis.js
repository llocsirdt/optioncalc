/**
 * Candle Analysis Module
 * Fetches and displays candle analysis data for multiple timeframes
 */

let candleAnalysisInterval = null;

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
  
  let color = '#666';
  if (score > 5) {
    color = '#00aa00'; // Strong uptrend - green
  } else if (score > 0) {
    color = '#88cc88'; // Weak uptrend - light green
  } else if (score < -5) {
    color = '#aa0000'; // Strong downtrend - red
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
  
  let color = '#666';
  let label = '';
  
  if (score >= 1) {
    color = '#00aa00'; // At or below lower band - oversold
    label = ' (oversold)';
  } else if (score > 0.5) {
    color = '#88cc88'; // Approaching lower band
    label = ' (↓)';
  } else if (score <= -1) {
    color = '#aa0000'; // At or above upper band - overbought
    label = ' (overbought)';
  } else if (score < -0.5) {
    color = '#cc8888'; // Approaching upper band
    label = ' (↑)';
  }
  
  return `<span style="color: ${color}; font-weight: bold;">${score.toFixed(2)}${label}</span>`;
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
  
  const latestCandle = candles[candles.length - 1];
  const trendScore = candleData.trendScore || 0;
  const bbScore = candleData.bbScore || 0;
  
  // Get EST time
  const timeEST = latestCandle.timeEST || '--';
  
  // Build HTML - two lines: header with time/scores, OHLC values below
  const html = `
    <div class="candle-analysis-compact">
      <div class="candle-header-row">
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
    
    console.log('Candle analysis updated successfully');
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
