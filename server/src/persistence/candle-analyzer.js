/**
 * Candle Analyzer Module
 * Provides analysis functions for price history candle data
 */

// Import price history handler
const { marketClient } = require('./market-client');

// In-memory cache for candle data (symbol -> date -> data)
const candleDataCache = new Map();

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
  getCachedData
};
