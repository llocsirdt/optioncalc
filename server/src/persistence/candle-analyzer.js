/**
 * Candle Analyzer Module
 * Provides analysis functions for price history candle data
 */

// Import price history handler
const { marketClient } = require('./market-client');

// In-memory cache for candle data (symbol -> date -> data)
const candleDataCache = new Map();

// Cache version - increment this to invalidate all cached data after logic changes
const CACHE_VERSION = 26;

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
  return `${symbol}_${date}_v${CACHE_VERSION}`;
}

/**
 * Check if we have raw candle data for today (for seeding, not analysis)
 * @param {string} symbol - The symbol
 * @returns {boolean} True if we have raw candle data for today
 */
function hasRawCandleData(symbol) {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const cacheKey = getCacheKey(symbol, today);
  
  const cached = candleDataCache.get(cacheKey);
  if (!cached) return false;
  
  // Check if we have raw candle data
  return cached.rawCandleData && Object.keys(cached.rawCandleData).length > 0;
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
 * Cache raw candle data for symbol and date (separate from analysis)
 * @param {string} symbol - The symbol
 * @param {Object} rawData - The raw candle data to cache
 */
function cacheCandleData(symbol, rawData) {
  const today = new Date().toISOString().split('T')[0];
  const cacheKey = getCacheKey(symbol, today);
  
  // Check if we already have cached data for today
  const existing = candleDataCache.get(cacheKey);
  
  const cacheEntry = {
    rawCandleData: rawData,
    lastUpdated: new Date().toISOString(),
    date: today,
    // Preserve any existing metadata
    ...(existing || {})
  };
  
  candleDataCache.set(cacheKey, cacheEntry);
  console.log(`🕯️ Cached raw candle data for ${symbol} (${cacheKey})`);
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
  
  // NOTE: Input candles are in descending order (newest first)
  // So we need to reverse the logic:
  // - First candle (index 0) is the NEWEST (has the close price)
  // - Last candle (index length-1) is the OLDEST (has the open price)
  return {
    open: oneMinCandles[oneMinCandles.length - 1].open,  // Oldest candle's open
    high: Math.max(...oneMinCandles.map(c => c.high)),
    low: Math.min(...oneMinCandles.map(c => c.low)),
    close: oneMinCandles[0].close,  // Newest candle's close
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
  if (isNaN(date.getTime())) {
    console.error(`🕯️ Invalid datetime value: ${datetime}`);
    return false;
  }
  const minute = date.getMinutes();
  return minute % minutes === 0;
}

/**
 * Get the period start time for a given datetime and timeframe
 * @param {number} datetime - Epoch milliseconds
 * @param {number} minutes - Timeframe in minutes (5, 15, 60)
 * @returns {number} Period start time in epoch milliseconds
 */
function getPeriodStartTime(datetime, minutes) {
  const date = new Date(datetime);
  const minute = date.getMinutes();
  const hour = date.getHours();
  
  // Calculate the start minute of the period
  const periodStartMinute = Math.floor(minute / minutes) * minutes;
  
  // Create a new date at the period start
  const periodStart = new Date(date);
  periodStart.setMinutes(periodStartMinute);
  periodStart.setSeconds(0);
  periodStart.setMilliseconds(0);
  
  return periodStart.getTime();
}

/**
 * Build higher timeframe candles from source candles
 * @param {Array} sourceCandles - Array of source candles (can be 1m, 30m, etc.)
 * @param {number} timeframeMinutes - Target timeframe in minutes (5, 15, 60)
 * @param {number} sourceCandleMinutes - Source candle timeframe in minutes (default 1)
 * @returns {Array} Array of aggregated candles
 */
function buildHigherTimeframeCandles(sourceCandles, timeframeMinutes, sourceCandleMinutes = 1) {
  if (!sourceCandles || sourceCandles.length === 0) {
    return [];
  }
  
  // Group candles by their period start time
  const periodGroups = new Map();
  
  for (const candle of sourceCandles) {
    const periodStart = getPeriodStartTime(candle.datetime, timeframeMinutes);
    
    if (!periodGroups.has(periodStart)) {
      periodGroups.set(periodStart, []);
    }
    
    periodGroups.get(periodStart).push(candle);
  }
  
  // Aggregate each period's candles
  const higherTimeframeCandles = [];
  
  // Sort by period start time to maintain chronological order
  const sortedPeriods = Array.from(periodGroups.keys()).sort((a, b) => a - b);
  
  // Calculate expected candle count based on source timeframe
  const expectedCandleCount = timeframeMinutes / sourceCandleMinutes;
  
  for (let i = 0; i < sortedPeriods.length; i++) {
    const periodStart = sortedPeriods[i];
    const periodCandles = periodGroups.get(periodStart);
    
    // Keep all periods including incomplete ones - they have valid OHLC data up to current time
    // The most recent period may be incomplete but still contains valid data
    const isLastPeriod = i === sortedPeriods.length - 1;
    const hasIncompletePeriod = periodCandles.length < expectedCandleCount;
    
    if (isLastPeriod && hasIncompletePeriod) {
      console.log(`🕯️ Including incomplete last period: ${periodCandles.length}/${expectedCandleCount} candles at ${new Date(periodStart).toISOString()}`);
    }
    
    const aggregated = aggregateCandles(periodCandles);
    
    if (aggregated) {
      // Use the period start time as the candle datetime
      aggregated.datetime = periodStart;
      higherTimeframeCandles.push(aggregated);
    }
  }
  
  // Debug: Log the last TWO periods to verify aggregation
  if (higherTimeframeCandles.length > 1 && timeframeMinutes === 5) {
    console.log(`🕯️ DEBUG: Last 2 ${timeframeMinutes}m period aggregations:`);
    
    for (let i = Math.max(0, sortedPeriods.length - 2); i < sortedPeriods.length; i++) {
      const periodStart = sortedPeriods[i];
      const periodCandles = periodGroups.get(periodStart);
      const aggregated = higherTimeframeCandles[i];
      
      console.log(`\n  Period ${i + 1}:`);
      console.log(`    Period start: ${new Date(periodStart).toISOString()}`);
      console.log(`    Number of 1m candles: ${periodCandles.length}`);
      console.log(`    1m candles:`, periodCandles.map(c => ({
        time: new Date(c.datetime).toISOString(),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close
      })));
      console.log(`    Aggregated:`, {
        datetime: new Date(aggregated.datetime).toISOString(),
        open: aggregated.open,
        high: aggregated.high,
        low: aggregated.low,
        close: aggregated.close
      });
    }
  }
  
  // Return in descending order (newest first) for trend analysis
  return higherTimeframeCandles.sort((a, b) => b.datetime - a.datetime);
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
    
    // Update cached raw data for this timeframe (analysis will happen on request)
    cachedData.rawCandleData[tf.name] = {
      timeframe: tf.name,
      candles: aggregatedCandles,
      count: aggregatedCandles.length,
      derivedFrom: '1m'
    };
    
    console.log(`🕯️ ✅ Updated ${tf.name} raw data with ${aggregatedCandles.length} candles for ${symbol}`);
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
    if (!cachedData || !cachedData.rawCandleData || !cachedData.rawCandleData['1m']) {
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
    // CRITICAL: Must include endDate=Date.now() to get current day data!
    // Without endDate, Schwab API defaults to "market close of previous business day"
    // Note: period=1 gives better OHLC data quality for current day vs period=5
    const options = {
      periodType: 'day',
      period: 1,
      frequencyType: 'minute',
      frequency: 1,
      endDate: Date.now()
    };
    
    const freshData = await marketClient.priceHistory(apiSymbol, options);
    
    if (!freshData || !freshData.candles || freshData.candles.length === 0) {
      console.log(`🕯️ No new 1m candles for ${symbol}`);
      return;
    }
    
    // Get existing candles
    const existingCandles = cachedData.rawCandleData['1m'].candles || [];
    const existingTimes = new Set(existingCandles.map(c => c.datetime));
    
    // Filter out duplicate candles (only add new ones)
    const newCandles = freshData.candles.filter(candle => !existingTimes.has(candle.datetime));
    
    if (newCandles.length === 0) {
      console.log(`🕯️ No new 1m candles for ${symbol} (all duplicates)`);
      return;
    }
    
    console.log(`🕯️ Adding ${newCandles.length} new 1m candles for ${symbol}`);
    
    // Merge new candles with existing ones and sort by datetime (newest first for trend analysis)
    const mergedCandles = [...existingCandles, ...newCandles].sort((a, b) => b.datetime - a.datetime);
    
    // Update only the raw 1m candle data (analysis will happen on request)
    cachedData.rawCandleData['1m'] = {
      candles: mergedCandles,
      timeframe: '1m'
    };
    
    // Re-cache the updated data
    cacheCandleData(symbol, cachedData);
    
    console.log(`🕯️ ✅ Refreshed 1m raw data for ${symbol} (total: ${mergedCandles.length} candles)`);
    
    // Update higher timeframes (5m, 15m, 1h) from the updated 1m data
    updateHigherTimeframes(symbol, mergedCandles);
    
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
 * Fetch raw candle data for multiple timeframes (seeds cache if needed)
 * @param {string} symbol - The symbol to fetch data for
 * @returns {Promise<Object>} Raw candle data for all timeframes
 */
async function fetchCandleData(symbol) {
  console.log(`🕯️ Fetching raw candle data for: ${symbol}`);
  
  // Check if we have raw candle data for today
  if (hasRawCandleData(symbol)) {
    const cached = getCachedData(symbol);
    console.log(`🕯️ Using existing raw candle data for ${symbol}`);
    return cached.rawCandleData;
  }
  
  // Clear old cache entries
  clearOldCache();
  
  console.log(`🕯️ No raw candle data for today - seeding cache for ${symbol}`);
  
  // Fetch timeframes from API
  // IMPORTANT: schwab-client-js expects: priceHistory(symbol: string, options?: PriceHistoryOptions)
  // where PriceHistoryOptions is a SINGLE object with: periodType, period, frequencyType, frequency, endDate
  // 
  // CRITICAL: Must include endDate=Date.now() to get current day data!
  // Without endDate, Schwab API defaults to "market close of previous business day" per their docs.
  // 
  // For current day minute data: periodType='day', period=1, endDate=Date.now()
  // Note: period=1 gives better OHLC data quality for current day
  // Confirmed working periods: 1m=1day, 5m=2days, 15m=5days, 30m=5days (testing)
  // Note: For minute data, valid frequencies are 1, 5, 10, 15, 30 (not 60)
  // For 1h, we'll fetch 30m and aggregate to 1h
  // For daily, we need periodType=month or year
  const now = Date.now();
  const timeframes = [
    { periodType: 'day', period: 1, frequencyType: 'minute', frequency: 1, endDate: now, name: '1m' },
    { periodType: 'day', period: 2, frequencyType: 'minute', frequency: 5, endDate: now, name: '5m' },
    { periodType: 'day', period: 5, frequencyType: 'minute', frequency: 15, endDate: now, name: '15m' },
    { periodType: 'day', period: 5, frequencyType: 'minute', frequency: 30, endDate: now, name: '30m' },
    { periodType: 'month', period: 1, frequencyType: 'daily', frequency: 1, name: 'daily' }
  ];
  
  const candleData = {};
  
  // Handle index symbols - Schwab API requires $ prefix for index symbols
  const indexSymbols = ['NDX', 'SPX', 'RUT', 'DJX', 'OEX', 'VIX'];
  const apiSymbol = symbol.startsWith('$') ? 
    symbol : 
    (indexSymbols.includes(symbol) ? `$${symbol}` : symbol);
  
  console.log(`🕯️ Using API symbol: ${apiSymbol} for ${symbol}`);
  
  // Fetch all timeframes from API
  for (const timeframe of timeframes) {
    try {
      console.log(`🕯️ Fetching ${timeframe.name} data for ${symbol}...`);
      
      // Build options object with frequency parameters
      const options = {
        frequencyType: timeframe.frequencyType,
        frequency: timeframe.frequency
      };
      
      // Add periodType, period, and endDate if specified
      if (timeframe.periodType) options.periodType = timeframe.periodType;
      if (timeframe.period) options.period = timeframe.period;
      if (timeframe.endDate) options.endDate = timeframe.endDate;
      
      const data = await marketClient.priceHistory(apiSymbol, options);
      
      // Keep all candles including incomplete ones - they have valid OHLC data up to current time
      let candles = data.candles || [];
      
      // Sort candles in descending order (newest first) for trend analysis
      candles = candles.sort((a, b) => b.datetime - a.datetime);
      
      // Store only raw candle data (no indicators yet)
      candleData[timeframe.name] = {
        timeframe: timeframe.name,
        candles: candles,
        count: candles.length,
        fetchedAt: new Date().toISOString(),
        raw: true // Flag to indicate this is raw data without indicators
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
  
  // Build 1h candles from 30m data (API doesn't support 60-minute frequency)
  if (candleData['30m'] && candleData['30m'].candles && candleData['30m'].candles.length > 0) {
    console.log(`🕯️ Building 1h candles from 30m data...`);
    const aggregated1h = buildHigherTimeframeCandles(candleData['30m'].candles, 60, 30);
    candleData['1h'] = {
      timeframe: '1h',
      candles: aggregated1h,
      count: aggregated1h.length,
      fetchedAt: new Date().toISOString(),
      derivedFrom: '30m',
      raw: true
    };
    console.log(`🕯️ ✅ Built ${aggregated1h.length} 1h candles from 30m data`);
  }
  
  // Cache the fetched data
  cacheCandleData(symbol, candleData);
  
  return candleData;
}

/**
 * Convert epoch milliseconds to EST time string (H:M:S)
 * @param {number} datetime - Epoch milliseconds
 * @returns {string} Time in EST format (H:M:S)
 */
function toESTTime(datetime) {
  const date = new Date(datetime);
  
  // Convert to EST (America/New_York) and format time directly
  const estTime = date.toLocaleTimeString('en-US', { 
    timeZone: 'America/New_York',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  
  return estTime;
}

/**
 * Filter out incomplete last candle from API data
 * Checks if the last candle starts a new period but has no subsequent candles
 * @param {Array} candles - Array of candles
 * @param {number} timeframeMinutes - Timeframe in minutes (1, 5, 15, 30)
 * @returns {Array} Filtered candles
 */
function filterIncompleteLastCandle(candles, timeframeMinutes) {
  if (!candles || candles.length < 2) {
    return candles;
  }
  
  const lastCandle = candles[candles.length - 1];
  const secondLastCandle = candles[candles.length - 2];
  
  // Calculate expected time difference between candles
  const expectedDiff = timeframeMinutes * 60 * 1000; // milliseconds
  const actualDiff = lastCandle.datetime - secondLastCandle.datetime;
  
  // If the last candle is at the start of a new period (time difference matches),
  // but it's the only candle in that period, remove it
  if (actualDiff >= expectedDiff) {
    console.log(`🕯️ Filtering incomplete last candle at ${new Date(lastCandle.datetime).toISOString()}`);
    return candles.slice(0, -1);
  }
  
  return candles;
}

/**
 * Calculate Bollinger Band score for most recent candle
 * Measures proximity of current close to BB bands relative to middle band
 * Positive scores indicate bullish conditions (near/below lower band = oversold)
 * Negative scores indicate bearish conditions (near/above upper band = overbought)
 * @param {Array} candles - Array of candle objects
 * @param {Object} bollingerBands - Bollinger band data (upper, middle, lower arrays)
 * @returns {number} BB score
 *   0 = at middle band (neutral)
 *   Positive = near/below lower band (bullish/oversold)
 *   Negative = near/above upper band (bearish/overbought)
 *   Higher positive = more bullish (further below lower band)
 *   Higher negative = more bearish (further above upper band)
 */
function calculateBBScore(candles, bollingerBands) {
  if (!candles || candles.length === 0) {
    return 0;
  }
  
  if (!bollingerBands || !bollingerBands.upper || !bollingerBands.middle || !bollingerBands.lower) {
    return 0;
  }
  
  // Get the most recent candle's close price
  const currentClose = candles[candles.length - 1].close;
  
  // Get the most recent Bollinger Band values
  const upperBand = bollingerBands.upper[bollingerBands.upper.length - 1];
  const middleBand = bollingerBands.middle[bollingerBands.middle.length - 1];
  const lowerBand = bollingerBands.lower[bollingerBands.lower.length - 1];
  
  // Handle null values (not enough data for BB calculation)
  if (upperBand === null || middleBand === null || lowerBand === null) {
    return 0;
  }
  
  // Calculate the distance from middle to each band
  const upperDistance = upperBand - middleBand;
  const lowerDistance = middleBand - lowerBand;
  
  // Avoid division by zero
  if (upperDistance === 0 || lowerDistance === 0) {
    return 0;
  }
  
  // If price is at or above middle band, calculate score relative to upper band
  if (currentClose >= middleBand) {
    // Distance from middle to current price
    const priceDistanceFromMiddle = currentClose - middleBand;
    // Ratio: negative as we approach upper band
    const score = -(priceDistanceFromMiddle / upperDistance);
    return score;
  } else {
    // Price is below middle band, calculate score relative to lower band
    const priceDistanceFromMiddle = middleBand - currentClose;
    // Ratio: positive as we approach lower band
    const score = priceDistanceFromMiddle / lowerDistance;
    return score;
  }
}

/**
 * Calculate BB scores for each candle in the array
 * Returns an array of BB scores, one for each candle
 * Positive scores indicate bullish conditions (near/below lower band = oversold)
 * Negative scores indicate bearish conditions (near/above upper band = overbought)
 * @param {Array} candles - Array of candle objects
 * @param {Object} bollingerBands - Bollinger Bands object with upper, middle, lower arrays
 * @returns {Array} Array of BB scores
 */
function calculatePerCandleBBScores(candles, bollingerBands) {
  const scores = [];
  
  if (!candles || candles.length === 0) {
    return scores;
  }
  
  if (!bollingerBands || !bollingerBands.upper || !bollingerBands.middle || !bollingerBands.lower) {
    return candles.map(() => 0);
  }
  
  for (let i = 0; i < candles.length; i++) {
    const currentClose = candles[i].close;
    const upperBand = bollingerBands.upper[i];
    const middleBand = bollingerBands.middle[i];
    const lowerBand = bollingerBands.lower[i];
    
    // Handle null values (not enough data for BB calculation)
    if (upperBand === null || middleBand === null || lowerBand === null) {
      scores.push(0);
      continue;
    }
    
    // Calculate the distance from middle to each band
    const upperDistance = upperBand - middleBand;
    const lowerDistance = middleBand - lowerBand;
    
    // Avoid division by zero
    if (upperDistance === 0 || lowerDistance === 0) {
      scores.push(0);
      continue;
    }
    
    // If price is at or above middle band, calculate score relative to upper band
    if (currentClose >= middleBand) {
      const priceDistanceFromMiddle = currentClose - middleBand;
      const score = -(priceDistanceFromMiddle / upperDistance);
      scores.push(score);
    } else {
      // Price is below middle band, calculate score relative to lower band
      const priceDistanceFromMiddle = middleBand - currentClose;
      const score = priceDistanceFromMiddle / lowerDistance;
      scores.push(score);
    }
  }
  
  return scores;
}

/**
 * Calculate trend score using iterative candle comparison algorithm
 * Starts from most recent candle and works backwards, comparing each candle to the previous one
 * For each candle: compares high, low, and close vs open to previous candle (+1/-1 each)
 * Stops when a single candle changes the score by 3 points in the opposite direction of the trend
 * @param {Array} candles - Array of candle objects
 * @returns {number} Trend score
 */
function calculateTrendScore(candles) {
  if (!candles || candles.length < 2) {
    return 0;
  }
  
  let score = 0;
  
  // Start from the most recent candle and work backwards
  for (let i = candles.length - 1; i > 0; i--) {
    const current = candles[i];
    const previous = candles[i - 1];
    
    let candleScoreChange = 0;
    
    // High comparison: add 1 if current high > previous high, deduct 1 if lower
    if (current.high > previous.high) {
      candleScoreChange += 1;
    } else if (current.high < previous.high) {
      candleScoreChange -= 1;
    }
    
    // Low comparison: add 1 if current low > previous low, deduct 1 if lower
    if (current.low > previous.low) {
      candleScoreChange += 1;
    } else if (current.low < previous.low) {
      candleScoreChange -= 1;
    }
    
    // Close vs Open comparison: add 1 if close > open, deduct 1 if close < open
    if (current.close > current.open) {
      candleScoreChange += 1;
    } else if (current.close < current.open) {
      candleScoreChange -= 1;
    }
    
    // Apply the score change
    score += candleScoreChange;
    
    // Stop conditions:
    // If we had a positive score and this candle deducts 3 or more, stop
    if (score - candleScoreChange > 0 && candleScoreChange <= -3) {
      break;
    }
    // If we had a negative score and this candle adds 3 or more, stop  
    if (score - candleScoreChange < 0 && candleScoreChange >= 3) {
      break;
    }
  }
  
  return score;
}

/**
 * Calculate trend scores for each candle in the array
 * Returns an array of trend scores, one for each candle
 * @param {Array} candles - Array of candle objects
 * @returns {Array} Array of trend scores
 */
function calculatePerCandleTrendScores(candles) {
  const scores = [];
  
  for (let i = 0; i < candles.length; i++) {
    if (i < 1) {
      // Not enough data for first candle
      scores.push(0);
    } else {
      // Get candles up to and including current index
      const candlesUpToNow = candles.slice(0, i + 1);
      // Calculate trend score for this position using new algorithm
      const score = calculateTrendScore(candlesUpToNow);
      scores.push(score);
    }
  }
  
  return scores;
}

/**
 * Calculate Simple Moving Average (SMA) for candle data
 * @param {Array} candles - Array of candle objects with close prices
 * @param {number} period - Number of periods for SMA
 * @returns {Array} Array of SMA values (same length as candles, null for periods without enough data)
 */
function calculateSMA(candles, period) {
  const sma = [];
  
  // NOTE: Candles are in descending order (newest first)
  // For each candle, we need to look forward in the array to get prior candles
  for (let i = 0; i < candles.length; i++) {
    // Check if we have enough prior candles (forward in array)
    if (i + period > candles.length) {
      sma.push(null); // Not enough prior data for SMA
    } else {
      // Get current candle + (period-1) prior candles (indices i to i+period-1)
      const sum = candles.slice(i, i + period).reduce((acc, candle) => acc + candle.close, 0);
      sma.push(sum / period);
    }
  }
  
  return sma;
}

/**
 * Calculate Exponential Moving Average (EMA) for candle data
 * @param {Array} candles - Array of candle objects with close prices
 * @param {number} period - Number of periods for EMA
 * @returns {Array} Array of EMA values (same length as candles)
 */
function calculateEMA(candles, period) {
  // NOTE: Candles are in descending order (newest first)
  // EMA needs to be calculated from oldest to newest, then reversed
  
  const multiplier = 2 / (period + 1);
  const emaReversed = [];
  
  // Work backwards through array (oldest to newest chronologically)
  for (let i = candles.length - 1; i >= 0; i--) {
    const chronologicalIndex = candles.length - 1 - i;
    
    if (chronologicalIndex < period - 1) {
      emaReversed.push(null);
    } else if (chronologicalIndex === period - 1) {
      // First EMA value is SMA of first 'period' candles
      let sum = 0;
      for (let j = 0; j < period; j++) {
        sum += candles[candles.length - 1 - j].close;
      }
      emaReversed.push(sum / period);
    } else {
      // Calculate EMA based on previous EMA
      const prevEMA = emaReversed[chronologicalIndex - 1];
      const currentEMA = (candles[i].close - prevEMA) * multiplier + prevEMA;
      emaReversed.push(currentEMA);
    }
  }
  
  // Reverse to match newest-first order
  return emaReversed.reverse();
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
  
  // Calculate SMA (middle band) - already handles newest-first order
  const sma = calculateSMA(candles, period);
  
  // NOTE: Candles are in descending order (newest first)
  for (let i = 0; i < candles.length; i++) {
    // Check if we have enough prior candles (forward in array)
    if (i + period > candles.length) {
      upper.push(null);
      middle.push(null);
      lower.push(null);
    } else {
      const currentSMA = sma[i];
      // Get current candle + (period-1) prior candles (indices i to i+period-1)
      const recentCandles = candles.slice(i, i + period);
      
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
    const ema9 = calculateEMA(candles, 9);
    const bollinger20_2 = calculateBollingerBands(candles, 20, 2);
    
    // Calculate per-candle scores
    const perCandleTrendScores = calculatePerCandleTrendScores(candles);
    const perCandleBBScores = calculatePerCandleBBScores(candles, bollinger20_2);
    
    // Overall scores are the most recent candle's scores (index 0 since newest-first)
    const trendScore = perCandleTrendScores[0] || 0;
    const bbScore = perCandleBBScores[0] || 0;
    
    // Add indicators and EST time to each candle
    const enhancedCandles = candles.map((candle, index) => ({
      ...candle,
      timeEST: toESTTime(candle.datetime),
      indicators: {
        sma20: sma20[index],
        sma50: sma50[index],
        ema9: ema9[index],
        bollinger20_2: {
          upper: bollinger20_2.upper[index],
          middle: bollinger20_2.middle[index],
          lower: bollinger20_2.lower[index]
        }
      },
      trendScore: perCandleTrendScores[index],
      bbScore: perCandleBBScores[index]
    }));
    
    enhancedData[timeframe] = {
      ...data,
      candles: enhancedCandles,
      indicators: {
        sma20: sma20,
        sma50: sma50,
        ema9: ema9,
        bollinger20_2: bollinger20_2
      },
      trendScore: trendScore,
      bbScore: bbScore,
      enhancedAt: new Date().toISOString()
    };
    
    console.log(`🕯️ ✅ Enhanced ${timeframe} with indicators`);
  }
  
  // Don't cache here - we cache the raw data in fetchCandleData
  // This allows us to apply limiting on each request without storing huge datasets
  
  return enhancedData;
}

/**
 * Limit candles to most recent N candles
 * @param {Object} candleData - Candle data object with timeframes
 * @param {number} limit - Maximum number of candles to return per timeframe
 * @returns {Object} Limited candle data
 */
function limitCandleData(candleData, limit = 100) {
  const limitedData = {};
  
  console.log(`🕯️ Limiting candle data to ${limit} candles per timeframe...`);
  
  for (const [timeframe, data] of Object.entries(candleData)) {
    if (data.error || !data.candles) {
      limitedData[timeframe] = data;
      continue;
    }
    
    const candles = data.candles;
    console.log(`🕯️ ${timeframe}: ${candles.length} candles before limiting`);
    const limitedCandles = candles.slice(0, limit); // Get first N candles (newest first)
    console.log(`🕯️ ${timeframe}: ${limitedCandles.length} candles after limiting`);
    
    // Update indicators arrays to match limited candles
    const indicators = data.indicators || {};
    const limitedIndicators = {};
    
    for (const [key, values] of Object.entries(indicators)) {
      if (Array.isArray(values)) {
        limitedIndicators[key] = values.slice(0, limit);
      } else if (typeof values === 'object' && values !== null) {
        // Handle nested objects like bollinger bands
        limitedIndicators[key] = {};
        for (const [subKey, subValues] of Object.entries(values)) {
          if (Array.isArray(subValues)) {
            limitedIndicators[key][subKey] = subValues.slice(0, limit);
          } else {
            limitedIndicators[key][subKey] = subValues;
          }
        }
      } else {
        limitedIndicators[key] = values;
      }
    }
    
    limitedData[timeframe] = {
      ...data,
      candles: limitedCandles,
      count: limitedCandles.length,
      indicators: limitedIndicators,
      limited: true,
      limitedTo: limit
    };
  }
  
  return limitedData;
}

/**
 * Filter candle data to specific timeframe
 * @param {Object} candleData - Candle data object with timeframes
 * @param {string} timeframe - Timeframe to filter (1m, 5m, 15m, 60m, daily)
 * @returns {Object} Filtered candle data
 */
function filterTimeframe(candleData, timeframe) {
  // Normalize timeframe (60m -> 1h)
  const normalizedTimeframe = timeframe === '60m' ? '1h' : timeframe;
  
  if (!candleData[normalizedTimeframe]) {
    return {
      error: `Timeframe '${timeframe}' not found`,
      availableTimeframes: Object.keys(candleData)
    };
  }
  
  return {
    [normalizedTimeframe]: candleData[normalizedTimeframe]
  };
}

/**
 * Analyze candles for a given symbol
 * @param {string} symbol - The symbol to analyze
 * @param {Object} options - Analysis options
 * @param {string} options.timeframe - Optional specific timeframe to return (1m, 5m, 15m, 60m, daily)
 * @returns {Promise<Object>} Analysis results
 */
async function analyzeCandles(symbol, options = {}) {
  console.log(`🕯️ Starting candle analysis for: ${symbol}`);
  
  try {
    // Start refresh loop on first call
    if (!refreshLoopRunning) {
      try {
        startRefreshLoop();
      } catch (refreshError) {
        console.error(`🕯️ Failed to start refresh loop:`, refreshError);
        // Continue anyway - this is not critical for the first analysis
      }
    }
    
    // Step 1: Fetch candle data for all timeframes
    console.log(`🕯️ Step 1: Fetching candle data...`);
    const candleData = await fetchCandleData(symbol);
    console.log(`🕯️ Step 1 complete: Fetched data for ${Object.keys(candleData).length} timeframes`);
    
    // Step 2: Enhance with technical indicators
    console.log(`🕯️ Step 2: Enhancing with technical indicators...`);
    let enhancedCandleData = enhanceCandleDataWithIndicators(symbol, candleData);
    console.log(`🕯️ Step 2 complete: Enhanced ${Object.keys(enhancedCandleData).length} timeframes`);
    
    // Step 3: Limit to most recent 100 candles per timeframe
    console.log(`🕯️ Step 3: Limiting to 100 candles per timeframe...`);
    enhancedCandleData = limitCandleData(enhancedCandleData, 100);
    console.log(`🕯️ Step 3 complete`);
    
    // Step 4: Filter to specific timeframe if requested
    if (options.timeframe) {
      console.log(`🕯️ Step 4: Filtering to ${options.timeframe} timeframe...`);
      enhancedCandleData = filterTimeframe(enhancedCandleData, options.timeframe);
      console.log(`🕯️ Step 4 complete`);
    }
    
    const analysis = {
      symbol: symbol,
      timestamp: new Date().toISOString(),
      status: 'analysis_complete',
      candleData: enhancedCandleData,
      message: options.timeframe 
        ? `Candle analysis completed for ${options.timeframe} timeframe (limited to 100 candles)`
        : 'Candle analysis completed with technical indicators (limited to 100 candles per timeframe)'
    };
    
    console.log(`🕯️ ✅ Candle analysis completed for ${symbol}${options.timeframe ? ` (${options.timeframe})` : ''}`);
    return analysis;
    
  } catch (error) {
    console.error(`🕯️ ❌ Candle analysis failed for ${symbol}:`, error);
    console.error(`🕯️ Error stack:`, error.stack);
    
    const analysis = {
      symbol: symbol,
      timestamp: new Date().toISOString(),
      status: 'error',
      error: error.message,
      stack: error.stack,
      message: 'Failed to complete candle analysis'
    };
    
    return analysis;
  }
}

module.exports = {
  analyzeCandles,
  clearOldCache,
  hasRawCandleData,
  getCachedData,
  startRefreshLoop,
  stopRefreshLoop,
  refreshAllSymbols
};
