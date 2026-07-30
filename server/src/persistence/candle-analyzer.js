/**
 * Candle Analyzer Module V2
 * New implementation with immutable base cache strategy
 */

const { marketClient } = require('./market-client');
const { streamingCandleSource } = require('./streaming-candle-source');

// IMMUTABLE base cache - populated ONCE per symbol, NEVER overwritten
const baseCandleCache = new Map();

const CACHE_VERSION = 46;

// Maximum number of candles to keep per timeframe
const CANDLE_LIMIT = 1000;

/**
 * Check if we have base cache for symbol
 */
function hasBaseCache(symbol) {
  return baseCandleCache.has(`${symbol}_v${CACHE_VERSION}`);
}

function getCandleStats(candle) {
  if (!candle) {
    return null;
  }
  const body = Math.abs(candle.close - candle.open);
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  const lowerWick = Math.min(candle.open, candle.close) - candle.low;
  const range = candle.high - candle.low;
  return { body, upperWick, lowerWick, range };
}

function isBullishEngulfing(prev, curr) {
  if (!prev || !curr) return false;
  const prevBear = prev.close < prev.open;
  const currBull = curr.close > curr.open;
  return prevBear && currBull && curr.open <= prev.close && curr.close >= prev.open;
}

function isBearishEngulfing(prev, curr) {
  if (!prev || !curr) return false;
  const prevBull = prev.close > prev.open;
  const currBear = curr.close < curr.open;
  return prevBull && currBear && curr.open >= prev.close && curr.close <= prev.open;
}

function isHammer(candle) {
  const stats = getCandleStats(candle);
  if (!stats || stats.range === 0) return false;
  const bodyRatio = stats.body / stats.range;
  return bodyRatio <= 0.3 && stats.lowerWick >= stats.body * 2 && stats.upperWick <= stats.body * 0.4;
}

function isShootingStar(candle) {
  const stats = getCandleStats(candle);
  if (!stats || stats.range === 0) return false;
  const bodyRatio = stats.body / stats.range;
  return bodyRatio <= 0.3 && stats.upperWick >= stats.body * 2 && stats.lowerWick <= stats.body * 0.4;
}

function isMorningStar(c1, c2, c3) {
  if (!c1 || !c2 || !c3) return false;
  const firstBear = c1.close < c1.open;
  const thirdBull = c3.close > c3.open;
  const gapDown = Math.max(c2.open, c2.close) < c1.close;
  const recovery = c3.close >= c1.open - (Math.abs(c1.open - c1.close) / 2);
  return firstBear && thirdBull && gapDown && recovery;
}

function isEveningStar(c1, c2, c3) {
  if (!c1 || !c2 || !c3) return false;
  const firstBull = c1.close > c1.open;
  const thirdBear = c3.close < c3.open;
  const gapUp = Math.min(c2.open, c2.close) > c1.close;
  const retrace = c3.close <= c1.open + (Math.abs(c1.close - c1.open) / 2);
  return firstBull && thirdBear && gapUp && retrace;
}

function analyzeCandlePatterns(candles = []) {
  if (!Array.isArray(candles) || candles.length === 0) {
    return { timestamp: null, bullish: [], bearish: [], detected: [] };
  }

  const ordered = [...candles].sort((a, b) => a.datetime - b.datetime);
  const latest = ordered[ordered.length - 1];
  const detected = [];

  const addPattern = (name, direction, confidence, involved) => {
    detected.push({
      name,
      direction,
      confidence,
      candles: involved.map(c => c.datetime)
    });
  };

  if (ordered.length >= 1) {
    if (isHammer(latest)) {
      addPattern('hammer', 'bullish', 'moderate', [latest]);
    }
    if (isShootingStar(latest)) {
      addPattern('shooting_star', 'bearish', 'moderate', [latest]);
    }
  }

  if (ordered.length >= 2) {
    const prev = ordered[ordered.length - 2];
    if (isBullishEngulfing(prev, latest)) {
      addPattern('bullish_engulfing', 'bullish', 'strong', [prev, latest]);
    }
    if (isBearishEngulfing(prev, latest)) {
      addPattern('bearish_engulfing', 'bearish', 'strong', [prev, latest]);
    }
  }

  if (ordered.length >= 3) {
    const c1 = ordered[ordered.length - 3];
    const c2 = ordered[ordered.length - 2];
    if (isMorningStar(c1, c2, latest)) {
      addPattern('morning_star', 'bullish', 'strong', [c1, c2, latest]);
    }
    if (isEveningStar(c1, c2, latest)) {
      addPattern('evening_star', 'bearish', 'strong', [c1, c2, latest]);
    }
  }

  return {
    timestamp: latest.datetime,
    bullish: detected.filter(p => p.direction === 'bullish').map(p => p.name),
    bearish: detected.filter(p => p.direction === 'bearish').map(p => p.name),
    detected
  };
}

/**
 * Populate base cache ONCE per symbol with historical data from Schwab API
 * Fetches 1m, 5m, 15m, 30m timeframes
 */
async function populateBaseCache(symbol) {
  const cacheKey = `${symbol}_v${CACHE_VERSION}`;
  
  if (baseCandleCache.has(cacheKey)) {
    console.log(`🕯️ ⚠️ Base cache already exists for ${symbol}, skipping`);
    return;
  }
  
  console.log(`🕯️ 📦 Populating IMMUTABLE base cache for ${symbol}`);
  
  const now = Date.now();
  const timeframes = [
    { periodType: 'day', period: 2, frequencyType: 'minute', frequency: 1, endDate: now, name: '1m' },
    { periodType: 'day', period: 3, frequencyType: 'minute', frequency: 5, endDate: now, name: '5m' },
    { periodType: 'day', period: 5, frequencyType: 'minute', frequency: 15, endDate: now, name: '15m' },
    { periodType: 'day', period: 5, frequencyType: 'minute', frequency: 30, endDate: now, name: '30m' }
  ];
  
  const indexSymbols = ['NDX', 'SPX', 'RUT', 'DJX', 'OEX', 'VIX'];
  const apiSymbol = symbol.startsWith('$') ? symbol : (indexSymbols.includes(symbol) ? `$${symbol}` : symbol);
  
  const baseCandleData = {};
  
  for (const tf of timeframes) {
    try {
      const options = {
        periodType: tf.periodType,
        period: tf.period,
        frequencyType: tf.frequencyType,
        frequency: tf.frequency,
        endDate: tf.endDate
      };
      
      console.log(`🕯️ Fetching ${tf.name} for base cache (period: ${tf.period} days)...`);
      const data = await marketClient.priceHistory(apiSymbol, options);
      
      let candles = data.candles || [];
      const rawCount = candles.length;
      
      // Filter out zero-value candles
      candles = candles.filter(c => c.open !== 0 || c.high !== 0 || c.low !== 0 || c.close !== 0);
      const afterZeroFilter = candles.length;
      
      // Filter to market hours only (9:30 AM - 4:00 PM ET)
      // This removes invalid extended hours data that sometimes appears in API responses
      candles = filterMarketHours(candles);
      const afterMarketHoursFilter = candles.length;
      
      // Sort newest first
      candles.sort((a, b) => b.datetime - a.datetime);
      
      // Log date range of candles
      if (candles.length > 0) {
        const oldestDate = new Date(candles[candles.length - 1].datetime).toISOString().split('T')[0];
        const newestDate = new Date(candles[0].datetime).toISOString().split('T')[0];
        console.log(`🕯️   ${tf.name}: ${rawCount} raw → ${afterZeroFilter} after zero-filter → ${afterMarketHoursFilter} after market-hours-filter`);
        console.log(`🕯️   ${tf.name}: Date range: ${oldestDate} to ${newestDate}`);
      } else {
        console.log(`🕯️   ${tf.name}: ${rawCount} raw → ${afterZeroFilter} after zero-filter → ${afterMarketHoursFilter} after market-hours-filter (NO CANDLES)`);
      }
      
      // TODO: Investigate Schwab API duplicate issue - surprising that API returns exact duplicates
      // Each timestamp appears twice in the response. Need to verify if this is:
      // 1. Temporary API issue specific to certain days/conditions
      // 2. Change in API behavior 
      // 3. Related to request parameters (periodType, frequency, etc.)
      // Monitor this in future testing and remove deduplication if API is fixed
      
      // Check for duplicates in the raw data from Schwab
      const timestamps = {};
      candles.forEach(c => {
        timestamps[c.timeEST || toESTTime(c.datetime)] = (timestamps[c.timeEST || toESTTime(c.datetime)] || 0) + 1;
      });
      const dupCount = Object.values(timestamps).filter(count => count > 1).length;
      if (dupCount > 0) {
        console.log(`🕯️ ⚠️ Found ${dupCount} duplicate timestamps in ${tf.name} data from Schwab API`);
      }
      
      // Remove duplicates by keeping only the first occurrence
      const seenTimestamps = new Set();
      candles = candles.filter(candle => {
        const timeEST = candle.timeEST || toESTTime(candle.datetime);
        if (seenTimestamps.has(timeEST)) {
          return false; // Skip duplicate
        }
        seenTimestamps.add(timeEST);
        return true;
      });
      console.log(`🕯️   ${tf.name}: ${data.candles?.length || 0} candles from API, ${candles.length} after deduplication`);
      
      baseCandleData[tf.name] = {
        candles: candles,
        count: candles.length
      };
      
      if (candles.length > 0) {
        console.log(`🕯️   ${tf.name}: ${candles.length} candles, newest: ${new Date(candles[0].datetime).toISOString()}`);
      }
    } catch (error) {
      console.error(`🕯️ ❌ Failed to fetch ${tf.name}:`, error.message);
      baseCandleData[tf.name] = { candles: [], count: 0, error: error.message };
    }
  }
  
  // Store in IMMUTABLE cache
  baseCandleCache.set(cacheKey, {
    candleData: baseCandleData,
    cachedAt: new Date().toISOString()
  });
  
  console.log(`🕯️ ✅ Base cache populated for ${symbol} (IMMUTABLE)`);
}

/**
 * Get latest 1m candles since a given time
 * Tries streaming API first for real-time data, falls back to REST API
 */
async function getLatest1mCandles(symbol, sinceTime) {
  const indexSymbols = ['NDX', 'SPX', 'RUT', 'DJX', 'OEX', 'VIX'];
  const apiSymbol = symbol.startsWith('$') ? symbol : (indexSymbols.includes(symbol) ? `$${symbol}` : symbol);
  
  // Try to get latest candle from streaming API first
  let streamCandle = null;
  if (streamingCandleSource.isConnected && streamingCandleSource.hasLatestCandle(symbol)) {
    streamCandle = streamingCandleSource.getLatestCandle(symbol);
    
    // Only use streaming candle if it's newer than sinceTime
    if (streamCandle && streamCandle.datetime > sinceTime) {
      const timeStr = new Date(streamCandle.datetime).toLocaleTimeString('en-US', {
        timeZone: 'America/New_York',
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
      console.log(`🌊 Using streaming candle for ${symbol} at ${timeStr}`);
      
      // Return streaming candle as single-element array
      return [streamCandle];
    }
  }
  
  // Fall back to REST API
  const fetchTime = Date.now();
  const options = {
    periodType: 'day',
    period: 2,
    frequencyType: 'minute',
    frequency: 1,
    endDate: fetchTime
  };
  
  const data = await marketClient.priceHistory(apiSymbol, options);
  let candles = data.candles || [];
  
  // Filter to only candles after sinceTime
  candles = candles.filter(c => c.datetime > sinceTime);
  
  // Filter out zero-value candles
  candles = candles.filter(c => c.open !== 0 || c.high !== 0 || c.low !== 0 || c.close !== 0);
  
  // Filter to market hours only (9:30 AM - 4:00 PM ET)
  candles = filterMarketHours(candles);
  
  // Sort newest first
  candles.sort((a, b) => b.datetime - a.datetime);
  
  // DIAGNOSTIC: Log candle freshness to identify API delay issues
  const now = new Date(fetchTime);
  const currentMinute = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes(), 0, 0);
  
  if (candles.length > 0) {
    const latestCandle = candles[0];
    const candleTime = new Date(latestCandle.datetime);
    const candleMinute = new Date(candleTime.getFullYear(), candleTime.getMonth(), candleTime.getDate(), candleTime.getHours(), candleTime.getMinutes(), 0, 0);
    const minutesDiff = Math.floor((currentMinute - candleMinute) / 60000);
    
    const timeStr = now.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const candleTimeStr = candleTime.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' });
    
    if (minutesDiff > 0) {
      console.log(`⚠️ [CANDLE DELAY] ${symbol} at ${timeStr}: Latest candle is ${candleTimeStr} (${minutesDiff} min old) - API data is stale`);
    } else if (minutesDiff === 0) {
      console.log(`✅ [CANDLE FRESH] ${symbol} at ${timeStr}: Latest candle is ${candleTimeStr} (current minute) - API data is fresh`);
    }
  } else {
    const timeStr = now.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    console.log(`❌ [NO NEW CANDLES] ${symbol} at ${timeStr}: No new candles since ${new Date(sinceTime).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false })}`);
  }
  
  return candles;
}

/**
 * Aggregate 30m candles into 60m candles
 */
function aggregate30mTo60m(candles30m) {
  if (!candles30m || candles30m.length === 0) return [];
  
  const aggregated = [];
  
  // Group candles by hour to prevent duplicates
  const hourlyGroups = new Map();
  
  // Process each 30-minute candle
  for (const candle of candles30m) {
    const candleTime = new Date(candle.datetime);
    const hour = candleTime.getHours();
    const minutes = candleTime.getMinutes();
    
    // Determine which hour this candle belongs to
    let targetHour;
    
    // Special case: 9:30 AM candle belongs to 9:00 AM hour (market opens at 9:30)
    if (hour === 9 && minutes === 30) {
      targetHour = 9;
    } else {
      // For all other cases: 
      // Both XX:00 and XX:30 candles belong to the same hour
      // Example: 10:00 and 10:30 both belong to 10:00 hour
      targetHour = hour;
    }
    
    // Create hour boundary timestamp
    const hourBoundary = new Date(candleTime);
    hourBoundary.setHours(targetHour, 0, 0, 0);
    const hourKey = hourBoundary.getTime();
    
    // Initialize hour group if not exists
    if (!hourlyGroups.has(hourKey)) {
      hourlyGroups.set(hourKey, {
        datetime: hourKey,
        candles: [],
        is9amHour: targetHour === 9
      });
    }
    
    // Add candle to the appropriate hour group
    hourlyGroups.get(hourKey).candles.push(candle);
  }
  
  // Convert each hour group into a 60m candle
  for (const [hourKey, group] of hourlyGroups) {
    const { candles, is9amHour } = group;
    
    if (is9amHour && candles.length === 1 && new Date(candles[0].datetime).getHours() === 9) {
      // 9:00 AM special case: only have 9:30 AM candle
      const candle930 = candles[0];
      aggregated.push({
        datetime: hourKey,
        open: candle930.open,
        high: candle930.high,
        low: candle930.low,
        close: candle930.close,
        volume: candle930.volume
      });
    } else if (candles.length >= 1) {
      // Normal case: aggregate all candles in this hour
      // Sort candles by time to ensure proper open/close
      candles.sort((a, b) => a.datetime - b.datetime);
      
      const open = candles[0].open;
      const close = candles[candles.length - 1].close;
      const high = Math.max(...candles.map(c => c.high));
      const low = Math.min(...candles.map(c => c.low));
      const volume = candles.reduce((sum, c) => sum + c.volume, 0);
      
      aggregated.push({
        datetime: hourKey,
        open,
        high,
        low,
        close,
        volume
      });
    }
  }
  
  // Sort newest first
  aggregated.sort((a, b) => b.datetime - a.datetime);
  
  return aggregated;
}

/**
 * Aggregate 1m candles into higher timeframe
 */
function aggregateToTimeframe(oneMinCandles, targetMinutes) {
  if (!oneMinCandles || oneMinCandles.length === 0) return [];
  
  // Group candles by timeframe boundary
  const groups = new Map();
  
  for (const candle of oneMinCandles) {
    const date = new Date(candle.datetime);
    const estDate = new Date(date.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const minutes = estDate.getHours() * 60 + estDate.getMinutes();
    const boundary = Math.floor(minutes / targetMinutes) * targetMinutes;
    const boundaryKey = `${estDate.toDateString()}_${boundary}`;
    
    if (!groups.has(boundaryKey)) {
      groups.set(boundaryKey, []);
    }
    groups.get(boundaryKey).push(candle);
  }
  
  // Aggregate each group
  const aggregated = [];
  for (const [key, candles] of groups.entries()) {
    if (candles.length === 0) continue;
    
    // Candles are sorted oldest first from API, but may be mixed in groups
    const sorted = [...candles].sort((a, b) => a.datetime - b.datetime);
    
    // Use the timestamp from the first candle in the group as the boundary
    // The API already provides correct UTC timestamps that align to boundaries
    const boundaryTimestamp = sorted[0].datetime;
    
    aggregated.push({
      datetime: boundaryTimestamp,
      open: sorted[0].open,
      high: Math.max(...sorted.map(c => c.high)),
      low: Math.min(...sorted.map(c => c.low)),
      close: sorted[sorted.length - 1].close,
      volume: sorted.reduce((sum, c) => sum + c.volume, 0)
    });
  }
  
  // Sort newest first
  aggregated.sort((a, b) => b.datetime - a.datetime);
  
  return aggregated;
}

/**
 * Create historical working data for a specific date (backtest mode)
 * Simplified approach: Fetch only 1m candles and aggregate to all other timeframes
 * @param {string} symbol - Symbol to fetch data for
 * @param {string} date - Date in YYYY-MM-DD format (the backtest date)
 */
async function createHistoricalWorkingData(symbol, date) {
  const indexSymbols = ['NDX', 'SPX', 'RUT', 'DJX', 'OEX', 'VIX'];
  const apiSymbol = symbol.startsWith('$') ? symbol : (indexSymbols.includes(symbol) ? `$${symbol}` : symbol);
  
  console.log(`🕯️ Fetching historical candles for backtest on ${date}`);
  
  // Parse backtest date
  const [year, month, day] = date.split('-').map(Number);
  const backtestDateObj = new Date(year, month - 1, day, 12, 0, 0);
  
  // Fetch 5 days of 1m candles to ensure we have enough historical data
  // This covers the backtest day plus sufficient prior days for indicator calculations
  console.log(`🕯️   Fetching 1m candles (5 days ending ${date})...`);
  const data1m = await marketClient.priceHistory(apiSymbol, {
    periodType: 'day',
    period: 5,
    frequencyType: 'minute',
    frequency: 1,
    endDate: backtestDateObj.getTime()
  });
  
  // Filter out zero candles and keep in original order (oldest first from API)
  let candles1m = (data1m.candles || []).filter(c => c.open !== 0 || c.high !== 0 || c.low !== 0 || c.close !== 0);
  
  // Add timeEST to all candles
  candles1m = candles1m.map(c => ({ ...c, timeEST: toESTTime(c.datetime) }));
  
  console.log(`🕯️   1m: ${candles1m.length} candles (raw)`);
  
  // Filter to market hours BEFORE aggregation (9:30 AM - 4:00 PM ET)
  // ALL data should be market hours only - no extended hours
  candles1m = candles1m.filter(c => {
    const d = new Date(c.datetime);
    const estDate = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const hour = estDate.getHours();
    const minute = estDate.getMinutes();
    const totalMinutes = hour * 60 + minute;
    // Market hours: 9:30 AM (570 min) to 4:00 PM (960 min)
    // 4:00 PM is market close, so we include up to 3:59 PM (959 min)
    return totalMinutes >= 570 && totalMinutes < 960;
  });
  
  console.log(`🕯️   1m: ${candles1m.length} candles (market hours only)`);
  
  // Store complete market-hours 1m for 30m restore and 60m aggregation
  const unfilteredMarketHours1m = [...candles1m];
  
  // Aggregate 1m to higher timeframes
  console.log(`🕯️   Aggregating 1m to higher timeframes...`);
  let candles5m = aggregateToTimeframe(candles1m, 5);
  let candles15m = aggregateToTimeframe(candles1m, 15);
  let candles30m = aggregateToTimeframe(candles1m, 30);
  let candles60m = aggregateToTimeframe(candles1m, 60);
  
  // Filter to match fetchSeedData's date ranges
  // Identify actual trading days from the 1m data (handles weekends AND holidays)
  const tradingDays = [...new Set(unfilteredMarketHours1m.map(c => {
    const d = new Date(c.datetime);
    return d.toLocaleDateString('en-US', { timeZone: 'America/New_York' });
  }))].sort((a, b) => new Date(b) - new Date(a)); // newest first
  
  console.log(`🕯️   Detected ${tradingDays.length} trading days in 1m data`);
  
  // Find the prior trading day (the day before backtest date that has market data)
  const backtestDateStr = backtestDateObj.toLocaleDateString('en-US', { timeZone: 'America/New_York' });
  const priorDayStr = tradingDays.find(d => new Date(d) < new Date(backtestDateStr));
  const priorDayObj = priorDayStr ? new Date(priorDayStr + ' 12:00:00') : new Date(year, month - 1, day - 1, 12, 0, 0);
  
  console.log(`🕯️   Prior trading day: ${priorDayObj.toLocaleDateString('en-US', { timeZone: 'America/New_York' })}`);
  
  // 1m: Keep only last 2 trading days (prior day + backtest day)
  // This matches fetchSeedData which fetches period=2 ending on backtest date
  const priorDayStart1m = new Date(priorDayObj);
  priorDayStart1m.setHours(0, 0, 0, 0);
  const backtestDayEnd = new Date(backtestDateObj);
  backtestDayEnd.setHours(23, 59, 59, 999);
  candles1m = candles1m.filter(c => {
    const candleDate = new Date(c.datetime);
    const candleDateOnly = new Date(candleDate.toLocaleDateString('en-US', { timeZone: 'America/New_York' }));
    return candleDateOnly >= priorDayStart1m && candleDateOnly <= backtestDayEnd;
  });
  // Sort newest-first for consistency across all timeframes
  candles1m.sort((a, b) => b.datetime - a.datetime);
  console.log(`🕯️   1m: ${candles1m.length} candles (after date filter)`);
  
  // 5m: Keep candles from prior day through backtest day (for aggregated analysis)
  // Note: fetchSeedData only uses prior day, but we need backtest day for aggregation
  const priorDayStart = new Date(priorDayObj);
  priorDayStart.setHours(0, 0, 0, 0);
  const backtestDayEnd5m = new Date(backtestDateObj);
  backtestDayEnd5m.setHours(23, 59, 59, 999);
  candles5m = candles5m.filter(c => {
    const candleDate = new Date(c.datetime);
    const candleDateOnly = new Date(candleDate.toLocaleDateString('en-US', { timeZone: 'America/New_York' }));
    return candleDateOnly >= priorDayStart && candleDateOnly <= backtestDayEnd5m;
  });
  // Sort newest first to match fetchSeedData
  candles5m.sort((a, b) => b.datetime - a.datetime);
  
  // 15m and 30m: Keep last 4 days before backtest date, plus backtest day for aggregation
  const fourDaysAgo = new Date(backtestDateObj);
  fourDaysAgo.setDate(fourDaysAgo.getDate() - 4);
  fourDaysAgo.setHours(0, 0, 0, 0);
  const backtestDayEnd15m = new Date(backtestDateObj);
  backtestDayEnd15m.setHours(23, 59, 59, 999);
  
  candles15m = candles15m.filter(c => {
    const candleDate = new Date(c.datetime);
    const candleDateOnly = new Date(candleDate.toLocaleDateString('en-US', { timeZone: 'America/New_York' }));
    return candleDateOnly >= fourDaysAgo && candleDateOnly <= backtestDayEnd15m;
  });
  // Sort newest first to match fetchSeedData
  candles15m.sort((a, b) => b.datetime - a.datetime);
  
  const priorDayEnd30m = new Date(priorDayObj);
  priorDayEnd30m.setHours(23, 59, 59, 999);
  candles30m = candles30m.filter(c => {
    const candleDate = new Date(c.datetime);
    const candleDateOnly = new Date(candleDate.toLocaleDateString('en-US', { timeZone: 'America/New_York' }));
    return candleDateOnly >= fourDaysAgo && candleDateOnly <= priorDayEnd30m;
  });
  // Sort newest first to match fetchSeedData
  candles30m.sort((a, b) => b.datetime - a.datetime);
  
  // Check if 30m has fewer than 3 trading days - if so, keep all candles (restore logic)
  const unique30mDates = new Set(candles30m.map(c => new Date(c.datetime).toDateString()));
  if (unique30mDates.size < 3) {
    console.log(`🕯️   ⚠️ 30m filter left only ${unique30mDates.size} trading day(s); keeping all available candles`);
    // Restore from complete market-hours 1m candles (no extended hours)
    candles30m = aggregateToTimeframe(unfilteredMarketHours1m, 30);
    candles30m.sort((a, b) => b.datetime - a.datetime);
  }
  
  // 60m: Aggregate from the filtered 30m candles
  const priorDayEnd60m = new Date(priorDayObj);
  priorDayEnd60m.setHours(23, 59, 59, 999);
  candles60m = aggregateToTimeframe(unfilteredMarketHours1m, 60).filter(c => {
    const candleDate = new Date(c.datetime);
    const candleDateOnly = new Date(candleDate.toLocaleDateString('en-US', { timeZone: 'America/New_York' }));
    return candleDateOnly >= fourDaysAgo && candleDateOnly <= priorDayEnd60m;
  });
  // Sort newest first to match fetchSeedData
  candles60m.sort((a, b) => b.datetime - a.datetime);
  
  console.log(`🕯️   5m: ${candles5m.length} candles`);
  console.log(`🕯️   15m: ${candles15m.length} candles`);
  console.log(`🕯️   30m: ${candles30m.length} candles`);
  console.log(`🕯️   60m: ${candles60m.length} candles`);
  
  // Build historical data structure
  const historicalData = {
    '1m': {
      candles: candles1m,
      count: candles1m.length,
      timeframe: '1m',
      raw: true
    },
    '5m': {
      candles: candles5m,
      count: candles5m.length,
      timeframe: '5m',
      raw: true
    },
    '15m': {
      candles: candles15m,
      count: candles15m.length,
      timeframe: '15m',
      raw: true
    },
    '30m': {
      candles: candles30m,
      count: candles30m.length,
      timeframe: '30m',
      raw: true
    },
    '1h': {
      candles: candles60m,
      count: candles60m.length,
      timeframe: '1h',
      raw: true
    },
    '60m': {
      candles: candles60m,
      count: candles60m.length,
      timeframe: '60m',
      raw: true
    }
  };
  
  console.log(`🕯️ ✅ Historical data loaded for ${symbol} on ${date}`);
  return historicalData;
}

/**
 * Create working data from base cache + latest 1m candles
 * @param {string} symbol - Symbol to fetch data for
 * @param {string} [date] - Optional date in YYYY-MM-DD format for historical analysis (backtest mode)
 */
async function createWorkingData(symbol, date = null) {
  // If date is provided, fetch historical data for that specific date
  if (date) {
    console.log(`🕯️ Historical mode: Fetching candles for ${symbol} on ${date}`);
    return await createHistoricalWorkingData(symbol, date);
  }
  
  // Default behavior: use base cache + latest candles
  // Ensure base cache exists
  if (!hasBaseCache(symbol)) {
    await populateBaseCache(symbol);
  }
  
  // Get deep copy of base cache
  const cacheKey = `${symbol}_v${CACHE_VERSION}`;
  const baseCache = baseCandleCache.get(cacheKey);
  const workingData = JSON.parse(JSON.stringify(baseCache.candleData));
  
  // Get the newest candle time from base 1m cache
  const base1m = workingData['1m'];
  if (!base1m || !base1m.candles || base1m.candles.length === 0) {
    return workingData;
  }
  
  const newestBase1mTime = base1m.candles[0].datetime;
  
  // Fetch new 1m candles since the newest base candle
  const new1mCandles = await getLatest1mCandles(symbol, newestBase1mTime);
  
  if (new1mCandles.length > 0) {
    console.log(`🕯️   New 1m newest: ${new Date(new1mCandles[0].datetime).toISOString()}`);
    
    // Prepend new candles to working 1m data (newest first)
    workingData['1m'].candles = [...new1mCandles, ...workingData['1m'].candles];
    workingData['1m'].count = workingData['1m'].candles.length;
  }
  
  // Ensure 1m has proper structure
  workingData['1m'].timeframe = '1m';
  workingData['1m'].raw = true;
  
  // For 5m, 15m, 30m - use base cache data (has more history) and update with new 1m candles
  // Only aggregate the NEW 1m candles and prepend to base cache data
  
  // Always build 1h from 30m data (whether we have new candles or not)
  workingData['1h'] = {
    timeframe: '1h',
    candles: aggregate30mTo60m(workingData['30m'].candles),
    count: 0,
    raw: true
  };
  
  // Add 60m alias for strategy compatibility
  workingData['60m'] = {
    ...workingData['1h'],
    timeframe: '60m'
  };
  
  // Update 1h count after initialization
  workingData['1h'].count = workingData['1h'].candles.length;
  workingData['60m'].count = workingData['60m'].candles.length;
  
  if (new1mCandles.length > 0) {
    console.log(`🕯️   Updating higher timeframes with ${new1mCandles.length} new 1m candles`);
    
    // Aggregate new 1m candles for each timeframe
    const new5m = aggregateToTimeframe(new1mCandles, 5);
    const new15m = aggregateToTimeframe(new1mCandles, 15);
    const new30m = aggregateToTimeframe(new1mCandles, 30);
    const new1h = aggregateToTimeframe(new1mCandles, 60);
    
    // Debug: Check for duplicates in base cache before processing
    console.log(`🕯️   Base cache 5m candles: ${workingData['5m'].candles.length}`);
    console.log(`🕯️   Base cache 15m candles: ${workingData['15m'].candles.length}`);
    
    // Remove overlapping candles from base cache before prepending new ones
    // This prevents duplicates when aggregation boundaries overlap
    const removeOverlappingCandles = (existingCandles, newCandles) => {
      if (!newCandles || newCandles.length === 0) return existingCandles;
      
      // Get the oldest timestamp from new candles
      const oldestNewTimestamp = newCandles[newCandles.length - 1].datetime;
      
      // Filter out existing candles that are newer than or equal to the oldest new candle
      const filtered = existingCandles.filter(candle => candle.datetime < oldestNewTimestamp);
      console.log(`🕯️   Removed ${existingCandles.length - filtered.length} overlapping candles`);
      return filtered;
    };
    
    // Apply overlap removal and prepend new aggregated candles
    workingData['5m'].candles = [...new5m, ...removeOverlappingCandles(workingData['5m'].candles, new5m)];
    workingData['15m'].candles = [...new15m, ...removeOverlappingCandles(workingData['15m'].candles, new15m)];
    workingData['30m'].candles = [...new30m, ...removeOverlappingCandles(workingData['30m'].candles, new30m)];
    workingData['1h'].candles = [...new1h, ...removeOverlappingCandles(workingData['1h'].candles, new1h)];
    
    // Update 60m alias to match 1h
    workingData['60m'].candles = [...workingData['1h'].candles];
    workingData['60m'].count = workingData['1h'].candles.length;
    
    // Debug: Check for duplicates after processing
    const checkDuplicates = (candles, name) => {
      const timestamps = {};
      candles.forEach(c => {
        timestamps[c.timeEST] = (timestamps[c.timeEST] || 0) + 1;
      });
      const dupCount = Object.values(timestamps).filter(count => count > 1).length;
      console.log(`🕯️   ${name} duplicates after processing: ${dupCount}`);
    };
    
    checkDuplicates(workingData['5m'].candles, '5m');
    checkDuplicates(workingData['15m'].candles, '15m');
    checkDuplicates(workingData['30m'].candles, '30m');
    checkDuplicates(workingData['1h'].candles, '1h');
    
    // Update counts
    workingData['5m'].count = workingData['5m'].candles.length;
    workingData['15m'].count = workingData['15m'].candles.length;
    workingData['30m'].count = workingData['30m'].candles.length;
    workingData['1h'].count = workingData['1h'].candles.length;
    workingData['60m'].count = workingData['60m'].candles.length;
  }
  workingData['15m'].timeframe = '15m';
  workingData['15m'].raw = true;
  workingData['15m'].count = workingData['15m'].candles.length;
  
  workingData['30m'].timeframe = '30m';
  workingData['30m'].raw = true;
  workingData['30m'].count = workingData['30m'].candles.length;
  
  // Update counts and add metadata
  workingData['5m'].timeframe = '5m';
  workingData['5m'].raw = true;
  workingData['5m'].count = workingData['5m'].candles.length;
  
  workingData['30m'].raw = true;
  workingData['30m'].count = workingData['30m'].candles.length;
  
  workingData['1h'].count = workingData['1h'].candles.length;
  
  return workingData;
}

/**
 * Convert epoch milliseconds to a compact EST datetime string (MM/DD HH:MM)
 * Used for duplicate detection - must include date to avoid treating same time on different days as duplicates.
 * Omits year (all data is current-year intraday) and seconds (candles are minute-aligned) to keep UI tables narrow.
 */
function toESTTime(datetime) {
  const date = new Date(datetime);
  const estDateTime = date.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    month: '2-digit',
    day: '2-digit',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit'
  });
  return estDateTime.replace(', ', ' ');
}

/**
 * Calculate Simple Moving Average (SMA) for candle data
 */
function calculateSMA(candles, period) {
  const sma = [];
  for (let i = 0; i < candles.length; i++) {
    if (i + period > candles.length) {
      sma.push(null);
    } else {
      const sum = candles.slice(i, i + period).reduce((acc, candle) => acc + candle.close, 0);
      sma.push(sum / period);
    }
  }
  return sma;
}

/**
 * Calculate Exponential Moving Average (EMA) for candle data
 */
function calculateEMA(candles, period) {
  const multiplier = 2 / (period + 1);
  const emaReversed = [];
  
  for (let i = candles.length - 1; i >= 0; i--) {
    const chronologicalIndex = candles.length - 1 - i;
    
    if (chronologicalIndex < period - 1) {
      emaReversed.push(null);
    } else if (chronologicalIndex === period - 1) {
      let sum = 0;
      for (let j = 0; j < period; j++) {
        sum += candles[candles.length - 1 - j].close;
      }
      emaReversed.push(sum / period);
    } else {
      const prevEMA = emaReversed[chronologicalIndex - 1];
      const currentEMA = (candles[i].close - prevEMA) * multiplier + prevEMA;
      emaReversed.push(currentEMA);
    }
  }
  
  return emaReversed.reverse();
}

/**
 * Calculate Bollinger Bands for candle data
 */
function calculateBollingerBands(candles, period = 20, stdDev = 2) {
  const upper = [];
  const middle = [];
  const lower = [];
  const sma = calculateSMA(candles, period);
  
  for (let i = 0; i < candles.length; i++) {
    if (i + period > candles.length) {
      upper.push(null);
      middle.push(null);
      lower.push(null);
    } else {
      const currentSMA = sma[i];
      const recentCandles = candles.slice(i, i + period);
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
 * Calculate BB scores for each candle
 */
function calculatePerCandleBBScores(candles, bollingerBands) {
  const scores = [];
  
  if (!candles || candles.length === 0 || !bollingerBands) {
    return candles ? candles.map(() => 0) : scores;
  }
  
  for (let i = 0; i < candles.length; i++) {
    const currentClose = candles[i].close;
    const upperBand = bollingerBands.upper[i];
    const middleBand = bollingerBands.middle[i];
    const lowerBand = bollingerBands.lower[i];
    
    if (upperBand === null || middleBand === null || lowerBand === null) {
      scores.push(0);
      continue;
    }
    
    const upperDistance = upperBand - middleBand;
    const lowerDistance = middleBand - lowerBand;
    
    if (upperDistance === 0 || lowerDistance === 0) {
      scores.push(0);
      continue;
    }
    
    if (currentClose >= middleBand) {
      const priceDistanceFromMiddle = currentClose - middleBand;
      const score = -(priceDistanceFromMiddle / upperDistance);
      scores.push(score);
    } else {
      const priceDistanceFromMiddle = middleBand - currentClose;
      const score = priceDistanceFromMiddle / lowerDistance;
      scores.push(score);
    }
  }
  
  return scores;
}

/**
 * Calculate trend scores for each candle
 */
function calculatePerCandleTrendScores(candles) {
  if (!candles || candles.length === 0) {
    return [];
  }

  const MAX_WINDOW = 10; // compare at most the next 10 candles so scores stay reactive
  const scores = [];

  for (let i = 0; i < candles.length; i++) {
    let rawScore = 0;
    let comparisons = 0;

    const windowEnd = Math.min(candles.length - 1, i + MAX_WINDOW);
    for (let j = i; j < windowEnd; j++) {
      const current = candles[j];
      const previous = candles[j + 1];
      if (!current || !previous) {
        break;
      }

      // Reward higher highs/lows and closes, penalize lower ones
      if (current.high > previous.high) rawScore += 1;
      else if (current.high < previous.high) rawScore -= 1;

      if (current.low > previous.low) rawScore += 1;
      else if (current.low < previous.low) rawScore -= 1;

      if (current.close > previous.close) rawScore += 2;
      else if (current.close < previous.close) rawScore -= 2;

      comparisons += 1;
    }

    if (comparisons === 0) {
      scores.push(0);
      continue;
    }

    //const averageScore = rawScore / comparisons; // expose raw average so we can study the natural range

    // keep two decimal places so downstream logs remain readable
    //scores.push(Number(averageScore.toFixed(2)));
    scores.push(Number(rawScore));
  }

  return scores;
}

/**
 * Enhance candle data with technical indicators
 */
function enhanceCandleDataWithIndicators(symbol, candleData) {
  const enhancedData = {};
  const timeframes = Object.keys(candleData);
  console.log(`🕯️ Calculating indicators for ${timeframes.length} timeframes: ${timeframes.join(', ')}`);
  
  for (const [timeframe, data] of Object.entries(candleData)) {
    
    if (data.error) {
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
    
    const sma20 = calculateSMA(candles, 20);
    const sma50 = calculateSMA(candles, 50);
    const ema9 = calculateEMA(candles, 9);
    const bollinger20_2 = calculateBollingerBands(candles, 20, 2);
    const perCandleTrendScores = calculatePerCandleTrendScores(candles);
    const perCandleBBScores = calculatePerCandleBBScores(candles, bollinger20_2);
    const perCandleBBSScoreDeltas = perCandleBBScores.map((score, index) => {
      const previousScore = perCandleBBScores[index + 1];
      if (
        score === null || score === undefined ||
        previousScore === null || previousScore === undefined
      ) {
        return null;
      }
      return score - previousScore;
    });

    const trendScore = perCandleTrendScores[0] || 0;
    const bbScore = perCandleBBScores[0] || 0;
    const bbScoreDelta = perCandleBBSScoreDeltas[0] ?? null;
    
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
      bbScore: perCandleBBScores[index],
      bbScoreDelta: perCandleBBSScoreDeltas[index]
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
      bbScoreDelta: bbScoreDelta,
      enhancedAt: new Date().toISOString()
    };
  }
  
  console.log(`🕯️ ✅ Enhanced ${timeframes.length} timeframes with indicators`);
  
  return enhancedData;
}

/**
 * Filter candles to only include regular market hours (9:30 AM - 4:00 PM ET)
 * Excludes pre-market and after-hours candles
 */
function filterMarketHours(candles) {
  return candles.filter(c => {
    const d = new Date(c.datetime);
    const estDate = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const hour = estDate.getHours();
    const minute = estDate.getMinutes();
    const totalMinutes = hour * 60 + minute;
    
    // Market hours: 9:30 AM (570 min) to 4:00 PM (960 min)
    // 4:00 PM is market close, so we include up to 3:59 PM (959 min)
    return totalMinutes >= 570 && totalMinutes < 960;
  });
}

/**
 * Limit candles to most recent N candles
 */
function limitCandleData(candleData, limit = CANDLE_LIMIT) {
  const limitedData = {};
  
  for (const [timeframe, data] of Object.entries(candleData)) {
    if (data.error || !data.candles) {
      limitedData[timeframe] = data;
      continue;
    }
    
    const candles = data.candles;
    const limitedCandles = candles.slice(0, limit);
    
    const indicators = data.indicators || {};
    const limitedIndicators = {};
    
    for (const [key, values] of Object.entries(indicators)) {
      if (Array.isArray(values)) {
        limitedIndicators[key] = values.slice(0, limit);
      } else if (typeof values === 'object' && values !== null) {
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
      indicators: limitedIndicators
    };
  }
  
  return limitedData;
}

/**
 * Filter to specific timeframe
 */
function filterTimeframe(candleData, timeframe) {
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
 * Create aggregated analysis combining 1m candles with 5m and 15m scores
 * Each 1m candle gets the BB score and trend score from its corresponding 5m and 15m candles
 */
function createAggregatedAnalysis(candleData) {
  const candles1m = candleData['1m']?.candles;
  const candles5m = candleData['5m']?.candles;
  const candles15m = candleData['15m']?.candles;
  
  if (!candles1m || candles1m.length === 0) {
    return {
      candles: [],
      message: 'No 1m candles available for aggregation'
    };
  }
  
  console.log(`🔄 Creating aggregated analysis from ${candles1m.length} 1m candles`);
  
  let debugCount = 0;
  const aggregatedCandles = candles1m.map(candle1m => {
    const timestamp1m = candle1m.datetime;
    
    // Find the 5m candle that contains this 1m timestamp
    let bbScore5m = null;
    let trendScore5m = null;
    if (candles5m) {
      const candle5m = candles5m.find(c => {
        const candleStart = c.datetime;
        const candleEnd = candleStart + (5 * 60 * 1000); // 5 minutes in ms
        return timestamp1m >= candleStart && timestamp1m < candleEnd;
      });
      if (candle5m) {
        bbScore5m = candle5m.bbScore;
        trendScore5m = candle5m.trendScore;
      } else if (debugCount < 3) {
        console.log(`🔍 No 5m match for 1m timestamp ${new Date(timestamp1m).toISOString()}`);
        console.log(`   First 5m candle: ${new Date(candles5m[0]?.datetime).toISOString()}`);
        debugCount++;
      }
    }
    
    // Find the 15m candle that contains this 1m timestamp
    let bbScore15m = null;
    let trendScore15m = null;
    if (candles15m) {
      const candle15m = candles15m.find(c => {
        const candleStart = c.datetime;
        const candleEnd = candleStart + (15 * 60 * 1000); // 15 minutes in ms
        return timestamp1m >= candleStart && timestamp1m < candleEnd;
      });
      if (candle15m) {
        bbScore15m = candle15m.bbScore;
        trendScore15m = candle15m.trendScore;
      }
    }
    
    // Calculate sums of trend and BB scores across timeframes
    const trendSum = (candle1m.trendScore || 0) + (trendScore5m || 0) + (trendScore15m || 0);
    const bbSum = (candle1m.bbScore || 0) + (bbScore5m || 0) + (bbScore15m || 0);
    
    return {
      ...candle1m,
      bbScore5m,
      trendScore5m,
      bbScore15m,
      trendScore15m,
      trendSum,
      bbSum
    };
  });
  
  console.log(`🔄 ✅ Created aggregated analysis with ${aggregatedCandles.length} candles`);
  
  return {
    candles: aggregatedCandles,
    message: `Aggregated ${aggregatedCandles.length} 1m candles with 5m and 15m scores`
  };
}

/**
 * Analyze candles for a given symbol
 * @param {string} symbol - Symbol to analyze
 * @param {Object} options - Analysis options
 * @param {string} [options.timeframe] - Optional timeframe filter
 * @param {string} [options.date] - Optional date in YYYY-MM-DD format for historical analysis
 */
async function analyzeCandles(symbol, options = {}) {
  const dateStr = options.date ? ` on ${options.date}` : '';
  console.log(`🕯️ Starting candle analysis for: ${symbol}${dateStr}`);
  
  try {
    const candleData = await createWorkingData(symbol, options.date);
    
    let enhancedCandleData = enhanceCandleDataWithIndicators(symbol, candleData);
    enhancedCandleData = limitCandleData(enhancedCandleData, CANDLE_LIMIT);
    
    // Create aggregated analysis combining 1m with 5m and 15m scores
    const aggregatedAnalysis = createAggregatedAnalysis(enhancedCandleData);
    
    if (options.timeframe) {
      enhancedCandleData = filterTimeframe(enhancedCandleData, options.timeframe);
    }
    
    const analysis = {
      symbol: symbol,
      timestamp: new Date().toISOString(),
      date: options.date || null,
      status: 'analysis_complete',
      candleData: enhancedCandleData,
      aggregatedAnalysis: aggregatedAnalysis,
      message: options.timeframe 
        ? `Candle analysis completed for ${options.timeframe} timeframe${dateStr} (limited to ${CANDLE_LIMIT} candles)`
        : `Candle analysis completed with technical indicators${dateStr} (limited to ${CANDLE_LIMIT} candles per timeframe)`
    };
    
    console.log(`🕯️ ✅ Candle analysis completed for ${symbol}${dateStr}${options.timeframe ? ` (${options.timeframe})` : ''}`);
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

/**
 * Get all symbols that have base cache
 */
function getCachedSymbols() {
  const symbols = new Set();
  for (const [key] of baseCandleCache.entries()) {
    const symbol = key.replace(`_v${CACHE_VERSION}`, '');
    symbols.add(symbol);
  }
  return Array.from(symbols);
}

module.exports = {
  analyzeCandles,
  createWorkingData,
  populateBaseCache,
  hasBaseCache,
  analyzeCandlePatterns,
  enhanceCandleDataWithIndicators,
  limitCandleData,
  filterTimeframe,
  getCachedSymbols,
  calculateSMA,
  calculateEMA,
  calculateBollingerBands,
  calculatePerCandleBBScores,
  calculatePerCandleTrendScores,
  aggregate30mTo60m,
  streamingCandleSource,
  clearBaseCache: (symbol) => {
    const cacheKey = `${symbol}_v${CACHE_VERSION}`;
    baseCandleCache.delete(cacheKey);
    console.log(`🕯️ Cleared base cache for ${symbol}`);
  }
};
