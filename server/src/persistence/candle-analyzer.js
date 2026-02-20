/**
 * Candle Analyzer Module
 * Provides analysis functions for price history candle data
 */

// Import price history handler
const { marketClient } = require('./market-client');

// In-memory cache for candle data (symbol -> date -> data)
const candleDataCache = new Map();

// Track if refresh loop is running
let refreshLoopRunning = false;
let refreshIntervalId = null;

/**
 * Get cache key for symbol and date
 * @param {string} symbol - The symbol
 * @param {string} date - The date in YYYY-MM-DD format
 * @returns {string} Cache key
 */
function getCacheKey(symbol, date) {
  return `${symbol}_${date}`;
}

/**
 * Check if cached data is valid for today
 * @param {string} symbol - The symbol
 * @returns {boolean} True if valid cached data exists for today
 */
function hasValidCache(symbol) {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const cacheKey = getCacheKey(symbol, today);
  
  const cached = candleDataCache.get(cacheKey);
  if (!cached) return false;
  
  // Check if data was fetched today
  const fetchDate = new Date(cached.fetchedAt).toISOString().split('T')[0];
  return fetchDate === today;
}

/**
 * Get cached candle data for symbol
 * @param {string} symbol - The symbol
 * @returns {Object|null} Cached data or null if not found/invalid
 */
function getCachedData(symbol) {
  const today = new Date().toISOString().split('T')[0];
  const cacheKey = getCacheKey(symbol, today);
  
  return candleDataCache.get(cacheKey) || null;
}

/**
 * Cache candle data for symbol
 * @param {string} symbol - The symbol
 * @param {Object} data - The candle data to cache
 */
function cacheCandleData(symbol, data) {
  const today = new Date().toISOString().split('T')[0];
  const cacheKey = getCacheKey(symbol, today);
  
  const cacheEntry = {
    ...data,
    cachedAt: new Date().toISOString(),
    date: today
  };
  
  candleDataCache.set(cacheKey, cacheEntry);
  console.log(`🕯️ Cached candle data for ${symbol} (${cacheKey})`);
}

/**
 * Clear old cache entries (not from today)
 */
function clearOldCache() {
  const today = new Date().toISOString().split('T')[0];
  let clearedCount = 0;
  
  for (const [key, data] of candleDataCache.entries()) {
    if (data.date !== today) {
      candleDataCache.delete(key);
      clearedCount++;
    }
  }
  
  if (clearedCount > 0) {
    console.log(`🕯️ Cleared ${clearedCount} old cache entries`);
  }
}

/**
 * Get all symbols that have cached data for today
 * @returns {Array<string>} Array of symbols
 */
function getCachedSymbols() {
  const today = new Date().toISOString().split('T')[0];
  const symbols = new Set();
  
  for (const [key, data] of candleDataCache.entries()) {
    if (data.date === today) {
      // Extract symbol from cache key (format: symbol_date)
      const symbol = key.split('_')[0];
      symbols.add(symbol);
    }
  }
  
  return Array.from(symbols);
}

/**
 * Aggregate 1-minute candles into a higher timeframe candle
 * @param {Array} oneMinCandles - Array of 1-minute candles to aggregate
 * @returns {Object} Aggregated candle
 */
function aggregateCandles(oneMinCandles) {
  if (!oneMinCandles || oneMinCandles.length === 0) {
    return null;
  }
  
  return {
    open: oneMinCandles[0].open,
    high: Math.max(...oneMinCandles.map(c => c.high)),
    low: Math.min(...oneMinCandles.map(c => c.low)),
    close: oneMinCandles[oneMinCandles.length - 1].close,
    volume: oneMinCandles.reduce((sum, c) => sum + c.volume, 0),
    datetime: oneMinCandles[0].datetime // Use the start time of the period
  };
}

/**
 * Check if a datetime is at a timeframe boundary
 * @param {number} datetime - Epoch milliseconds
 * @param {number} minutes - Timeframe in minutes (5, 15, 60)
 * @returns {boolean} True if at boundary
 */
function isAtTimeframeBoundary(datetime, minutes) {
  const date = new Date(datetime);
  const minute = date.getMinutes();
  return minute % minutes === 0;
}

/**
 * Build higher timeframe candles from 1-minute data
 * @param {Array} oneMinCandles - Array of 1-minute candles (with indicators stripped)
 * @param {number} timeframeMinutes - Timeframe in minutes (5, 15, 60)
 * @returns {Array} Array of aggregated candles
 */
function buildHigherTimeframeCandles(oneMinCandles, timeframeMinutes) {
  if (!oneMinCandles || oneMinCandles.length === 0) {
    return [];
  }
  
  const higherTimeframeCandles = [];
  let currentPeriodCandles = [];
  
  for (let i = 0; i < oneMinCandles.length; i++) {
    const candle = oneMinCandles[i];
    currentPeriodCandles.push(candle);
    
    // Check if we're at the end of a period or the last candle
    const isLastCandle = i === oneMinCandles.length - 1;
    const nextCandleStartsNewPeriod = !isLastCandle && 
      isAtTimeframeBoundary(oneMinCandles[i + 1].datetime, timeframeMinutes);
    
    if (nextCandleStartsNewPeriod || isLastCandle) {
      // Aggregate the current period
      const aggregated = aggregateCandles(currentPeriodCandles);
      if (aggregated) {
        higherTimeframeCandles.push(aggregated);
      }
      currentPeriodCandles = [];
    }
  }
  
  return higherTimeframeCandles;
}

/**
 * Update higher timeframe candles from refreshed 1-minute data
 * @param {string} symbol - The symbol
 * @param {Array} oneMinCandles - Updated 1-minute candles (without indicators)
 */
function updateHigherTimeframes(symbol, oneMinCandles) {
  const cachedData = getCachedData(symbol);
  if (!cachedData) return;
  
  console.log(`🕯️ Updating higher timeframes for ${symbol} from 1m data...`);
  
  // Strip indicators from 1m candles for aggregation
  const rawOneMinCandles = oneMinCandles.map(c => ({
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
    datetime: c.datetime
  }));
  
  // Build and update each higher timeframe
  const timeframes = [
    { minutes: 5, name: '5m' },
    { minutes: 15, name: '15m' },
    { minutes: 60, name: '1h' }
  ];
  
  for (const tf of timeframes) {
    const aggregatedCandles = buildHigherTimeframeCandles(rawOneMinCandles, tf.minutes);
    
    if (aggregatedCandles.length === 0) {
      console.log(`🕯️ No ${tf.name} candles to update for ${symbol}`);
      continue;
    }
    
    // Calculate indicators for the aggregated candles
    const sma20 = calculateSMA(aggregatedCandles, 20);
    const sma50 = calculateSMA(aggregatedCandles, 50);
    const bollinger20_2 = calculateBollingerBands(aggregatedCandles, 20, 2);
    
    // Add indicators to each candle
    const enhancedCandles = aggregatedCandles.map((candle, index) => ({
      ...candle,
      indicators: {
        sma20: sma20[index],
        sma50: sma50[index],
        bollinger20_2: {
          upper: bollinger20_2.upper[index],
          middle: bollinger20_2.middle[index],
          lower: bollinger20_2.lower[index]
        }
      }
    }));
    
    // Update cached data for this timeframe
    cachedData[tf.name] = {
      timeframe: tf.name,
      data: { candles: aggregatedCandles },
      candles: enhancedCandles,
      count: enhancedCandles.length,
      indicators: {
        sma20: sma20,
        sma50: sma50,
        bollinger20_2: bollinger20_2
      },
      fetchedAt: cachedData[tf.name]?.fetchedAt || new Date().toISOString(),
      enhancedAt: new Date().toISOString(),
      lastRefreshed: new Date().toISOString(),
      derivedFrom: '1m'
    };
    
    console.log(`🕯️ ✅ Updated ${tf.name} with ${enhancedCandles.length} candles for ${symbol}`);
  }
  
  // Re-cache the updated data
  cacheCandleData(symbol, cachedData);
}

/**
 * Refresh 1-minute candle data for a symbol
 * @param {string} symbol - The symbol to refresh
 */
async function refresh1MinuteData(symbol) {
  try {
    const cachedData = getCachedData(symbol);
    if (!cachedData || !cachedData['1m']) {
      console.log(`🕯️ No cached 1m data for ${symbol}, skipping refresh`);
      return;
    }
    
    // Handle index symbols
    const indexSymbols = ['NDX', 'SPX', 'RUT', 'DJX', 'OEX', 'VIX'];
    const apiSymbol = symbol.startsWith('$') ? 
      symbol : 
      (indexSymbols.includes(symbol) ? `$${symbol}` : symbol);
    
    console.log(`🕯️ Refreshing 1m data for ${symbol}...`);
    
    // Fetch latest 1-minute data
    const freshData = await marketClient.priceHistory(
      apiSymbol,
      'day',
      5,
      'minute',
      1,
      undefined,
      undefined,
      undefined,
      undefined
    );
    
    if (!freshData || !freshData.candles || freshData.candles.length === 0) {
      console.log(`🕯️ No new 1m candles for ${symbol}`);
      return;
    }
    
    // Get existing candles
    const existingCandles = cachedData['1m'].candles || [];
    const existingTimes = new Set(existingCandles.map(c => c.datetime));
    
    // Filter out duplicate candles (only add new ones)
    const newCandles = freshData.candles.filter(candle => !existingTimes.has(candle.datetime));
    
    if (newCandles.length === 0) {
      console.log(`🕯️ No new 1m candles for ${symbol} (all duplicates)`);
      return;
    }
    
    console.log(`🕯️ Adding ${newCandles.length} new 1m candles for ${symbol}`);
    
    // Merge new candles with existing ones and sort by datetime
    const mergedCandles = [...existingCandles, ...newCandles].sort((a, b) => a.datetime - b.datetime);
    
    // Recalculate indicators for the updated 1m data
    const sma20 = calculateSMA(mergedCandles, 20);
    const sma50 = calculateSMA(mergedCandles, 50);
    const bollinger20_2 = calculateBollingerBands(mergedCandles, 20, 2);
    
    // Add indicators to each candle
    const enhancedCandles = mergedCandles.map((candle, index) => ({
      ...candle,
      indicators: {
        sma20: sma20[index],
        sma50: sma50[index],
        bollinger20_2: {
          upper: bollinger20_2.upper[index],
          middle: bollinger20_2.middle[index],
          lower: bollinger20_2.lower[index]
        }
      }
    }));
    
    // Update cached data
    cachedData['1m'] = {
      timeframe: '1m',
      data: { ...freshData, candles: mergedCandles },
      candles: enhancedCandles,
      count: enhancedCandles.length,
      indicators: {
        sma20: sma20,
        sma50: sma50,
        bollinger20_2: bollinger20_2
      },
      fetchedAt: cachedData['1m'].fetchedAt,
      enhancedAt: new Date().toISOString(),
      lastRefreshed: new Date().toISOString()
    };
    
    // Re-cache the updated data
    cacheCandleData(symbol, cachedData);
    
    console.log(`🕯️ ✅ Refreshed 1m data for ${symbol} (total: ${enhancedCandles.length} candles)`);
    
    // Update higher timeframes (5m, 15m, 1h) from the updated 1m data
    updateHigherTimeframes(symbol, enhancedCandles);
    
  } catch (error) {
    console.error(`🕯️ ❌ Failed to refresh 1m data for ${symbol}:`, error.message);
  }
}

/**
 * Refresh 1-minute data for all cached symbols
 */
async function refreshAllSymbols() {
  const symbols = getCachedSymbols();
  
  if (symbols.length === 0) {
    console.log(`🕯️ No symbols to refresh`);
    return;
  }
  
  console.log(`🕯️ Refreshing 1m data for ${symbols.length} symbols: ${symbols.join(', ')}`);
  
  // Refresh all symbols in parallel
  await Promise.all(symbols.map(symbol => refresh1MinuteData(symbol)));
  
  console.log(`🕯️ ✅ Refresh cycle completed`);
}

/**
 * Calculate milliseconds until next minute boundary
 * @returns {number} Milliseconds to wait
 */
function msUntilNextMinute() {
  const now = new Date();
  const nextMinute = new Date(now);
  nextMinute.setMinutes(now.getMinutes() + 1);
  nextMinute.setSeconds(0);
  nextMinute.setMilliseconds(0);
  
  return nextMinute - now;
}

/**
 * Start the automatic refresh loop
 */
function startRefreshLoop() {
  if (refreshLoopRunning) {
    console.log(`🕯️ Refresh loop already running`);
    return;
  }
  
  refreshLoopRunning = true;
  console.log(`🕯️ Starting automatic 1m candle refresh loop`);
  
  // Schedule first refresh at the next minute boundary
  const initialDelay = msUntilNextMinute();
  console.log(`🕯️ First refresh in ${Math.round(initialDelay / 1000)} seconds`);
  
  setTimeout(() => {
    // Execute first refresh
    refreshAllSymbols();
    
    // Then set up recurring refresh every minute
    refreshIntervalId = setInterval(() => {
      refreshAllSymbols();
    }, 60000); // 60 seconds
    
  }, initialDelay);
}

/**
 * Stop the automatic refresh loop
 */
function stopRefreshLoop() {
  if (refreshIntervalId) {
    clearInterval(refreshIntervalId);
    refreshIntervalId = null;
  }
  refreshLoopRunning = false;
  console.log(`🕯️ Stopped automatic refresh loop`);
}

/**
 * Fetch candle data for multiple timeframes
 * @param {string} symbol - The symbol to fetch data for
 * @returns {Promise<Object>} Candle data for all timeframes
 */
async function fetchCandleData(symbol) {
  console.log(`🕯️ Fetching candle data for: ${symbol}`);
  
  // Check cache first
  if (hasValidCache(symbol)) {
    console.log(`🕯️ Using cached data for ${symbol}`);
    return getCachedData(symbol);
  }
  
  // Clear old cache entries
  clearOldCache();
  
  const timeframes = [
    { periodType: 'day', period: 5, frequencyType: 'minute', frequency: 1, name: '1m' },
    { periodType: 'day', period: 5, frequencyType: 'minute', frequency: 5, name: '5m' },
    { periodType: 'day', period: 5, frequencyType: 'minute', frequency: 15, name: '15m' },
    { periodType: 'day', period: 5, frequencyType: 'minute', frequency: 60, name: '1h' },
    { periodType: 'month', period: 1, frequencyType: 'daily', frequency: 1, name: 'daily' }
  ];
  
  const candleData = {};
  
  // Handle index symbols - Schwab API requires $ prefix for index symbols
  const indexSymbols = ['NDX', 'SPX', 'RUT', 'DJX', 'OEX', 'VIX'];
  const apiSymbol = symbol.startsWith('$') ? 
    symbol : 
    (indexSymbols.includes(symbol) ? `$${symbol}` : symbol);
  
  console.log(`🕯️ Using API symbol: ${apiSymbol} for ${symbol}`);
  
  // Fetch data for each timeframe
  for (const timeframe of timeframes) {
    try {
      console.log(`🕯️ Fetching ${timeframe.name} data for ${symbol}...`);
      
      const data = await marketClient.priceHistory(
        apiSymbol,
        timeframe.periodType,
        timeframe.period,
        timeframe.frequencyType,
        timeframe.frequency,
        undefined, // startDate
        undefined, // endDate
        undefined, // needExtendedHoursData
        undefined  // needPreviousClose
      );
      
      candleData[timeframe.name] = {
        timeframe: timeframe.name,
        data: data,
        candles: data.candles || [],
        count: data.candles ? data.candles.length : 0,
        fetchedAt: new Date().toISOString()
      };
      
      console.log(`🕯️ ✅ Fetched ${candleData[timeframe.name].count} ${timeframe.name} candles`);
      
    } catch (error) {
      console.error(`🕯️ ❌ Failed to fetch ${timeframe.name} data for ${symbol}:`, error.message);
      candleData[timeframe.name] = {
        timeframe: timeframe.name,
        error: error.message,
        fetchedAt: new Date().toISOString()
      };
    }
  }
  
  // Cache the fetched data
  cacheCandleData(symbol, candleData);
  
  return candleData;
}

/**
 * Calculate Simple Moving Average (SMA) for candle data
 * @param {Array} candles - Array of candle objects with close prices
 * @param {number} period - Number of periods for SMA
 * @returns {Array} Array of SMA values (same length as candles, null for periods without enough data)
 */
function calculateSMA(candles, period) {
  const sma = [];
  
  for (let i = 0; i < candles.length; i++) {
    if (i < period - 1) {
      sma.push(null); // Not enough data for SMA
    } else {
      const sum = candles.slice(i - period + 1, i + 1).reduce((acc, candle) => acc + candle.close, 0);
      sma.push(sum / period);
    }
  }
  
  return sma;
}

/**
 * Calculate Bollinger Bands for candle data
 * @param {Array} candles - Array of candle objects with close prices
 * @param {number} period - Number of periods for SMA (typically 20)
 * @param {number} stdDev - Number of standard deviations (typically 2)
 * @returns {Object} Object containing upper, middle, and lower bands
 */
function calculateBollingerBands(candles, period = 20, stdDev = 2) {
  const upper = [];
  const middle = [];
  const lower = [];
  
  // Calculate SMA (middle band)
  const sma = calculateSMA(candles, period);
  
  for (let i = 0; i < candles.length; i++) {
    if (i < period - 1) {
      upper.push(null);
      middle.push(null);
      lower.push(null);
    } else {
      const currentSMA = sma[i];
      const recentCandles = candles.slice(i - period + 1, i + 1);
      
      // Calculate standard deviation
      const squaredDiffs = recentCandles.map(candle => Math.pow(candle.close - currentSMA, 2));
      const variance = squaredDiffs.reduce((acc, diff) => acc + diff, 0) / period;
      const standardDeviation = Math.sqrt(variance);
      
      upper.push(currentSMA + (standardDeviation * stdDev));
      middle.push(currentSMA);
      lower.push(currentSMA - (standardDeviation * stdDev));
    }
  }
  
  return { upper, middle, lower };
}

/**
 * Enhance candle data with technical indicators
 * @param {string} symbol - The symbol being analyzed
 * @param {Object} candleData - Candle data object with timeframes
 * @returns {Object} Enhanced candle data with indicators
 */
function enhanceCandleDataWithIndicators(symbol, candleData) {
  console.log(`🕯️ Enhancing candle data with technical indicators...`);
  
  const enhancedData = {};
  
  for (const [timeframe, data] of Object.entries(candleData)) {
    if (data.error) {
      // Skip timeframes with errors
      enhancedData[timeframe] = data;
      continue;
    }
    
    const candles = data.candles;
    
    if (!candles || candles.length === 0) {
      enhancedData[timeframe] = {
        ...data,
        indicators: { message: 'No candles available for indicators' }
      };
      continue;
    }
    
    console.log(`🕯️ Calculating indicators for ${timeframe} (${candles.length} candles)`);
    
    // Calculate indicators
    const sma20 = calculateSMA(candles, 20);
    const sma50 = calculateSMA(candles, 50);
    const bollinger20_2 = calculateBollingerBands(candles, 20, 2);
    
    // Add indicators to each candle
    const enhancedCandles = candles.map((candle, index) => ({
      ...candle,
      indicators: {
        sma20: sma20[index],
        sma50: sma50[index],
        bollinger20_2: {
          upper: bollinger20_2.upper[index],
          middle: bollinger20_2.middle[index],
          lower: bollinger20_2.lower[index]
        }
      }
    }));
    
    enhancedData[timeframe] = {
      ...data,
      candles: enhancedCandles,
      indicators: {
        sma20: sma20,
        sma50: sma50,
        bollinger20_2: bollinger20_2
      },
      enhancedAt: new Date().toISOString()
    };
    
    console.log(`🕯️ ✅ Enhanced ${timeframe} with indicators`);
  }
  
  // Cache the enhanced data
  cacheCandleData(symbol, enhancedData);
  
  return enhancedData;
}

/**
 * Analyze candles for a given symbol
 * @param {string} symbol - The symbol to analyze
 * @returns {Promise<Object>} Analysis results
 */
async function analyzeCandles(symbol) {
  console.log(`🕯️ Starting candle analysis for: ${symbol}`);
  
  try {
    // Start refresh loop on first call
    if (!refreshLoopRunning) {
      startRefreshLoop();
    }
    
    // Step 1: Fetch candle data for all timeframes
    const candleData = await fetchCandleData(symbol);
    
    // Step 2: Enhance with technical indicators
    const enhancedCandleData = enhanceCandleDataWithIndicators(symbol, candleData);
    
    const analysis = {
      symbol: symbol,
      timestamp: new Date().toISOString(),
      status: 'analysis_complete',
      candleData: enhancedCandleData,
      message: 'Candle analysis completed with technical indicators'
    };
    
    console.log(`🕯️ ✅ Candle analysis completed for ${symbol}`);
    return analysis;
    
  } catch (error) {
    console.error(`🕯️ ❌ Candle analysis failed for ${symbol}:`, error.message);
    
    const analysis = {
      symbol: symbol,
      timestamp: new Date().toISOString(),
      status: 'error',
      error: error.message,
      message: 'Failed to complete candle analysis'
    };
    
    return analysis;
  }
}

module.exports = {
  analyzeCandles,
  clearOldCache,
  hasValidCache,
  getCachedData,
  startRefreshLoop,
  stopRefreshLoop,
  refreshAllSymbols
};
