/**
 * Candle Analyzer Module V2
 * New implementation with immutable base cache strategy
 */

const { marketClient } = require('./market-client');

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
      
      console.log(`🕯️ Fetching ${tf.name} for base cache...`);
      const data = await marketClient.priceHistory(apiSymbol, options);
      
      let candles = data.candles || [];
      
      // Filter out zero-value candles
      candles = candles.filter(c => c.open !== 0 || c.high !== 0 || c.low !== 0 || c.close !== 0);
      
      // Filter to market hours only (9:30 AM - 4:00 PM ET)
      candles = filterMarketHours(candles);
      
      // Sort newest first
      candles.sort((a, b) => b.datetime - a.datetime);
      
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
 */
async function getLatest1mCandles(symbol, sinceTime) {
  const indexSymbols = ['NDX', 'SPX', 'RUT', 'DJX', 'OEX', 'VIX'];
  const apiSymbol = symbol.startsWith('$') ? symbol : (indexSymbols.includes(symbol) ? `$${symbol}` : symbol);
  
  const options = {
    periodType: 'day',
    period: 2,
    frequencyType: 'minute',
    frequency: 1,
    endDate: Date.now()
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
    
    // Candles are sorted newest first, so reverse for aggregation
    const sorted = [...candles].sort((a, b) => a.datetime - b.datetime);
    
    // Calculate the proper boundary timestamp
    // Use the first (oldest) candle in the group to determine the boundary
    const firstCandle = sorted[0];
    const firstDate = new Date(firstCandle.datetime);
    
    // Get EST time components
    const estString = firstDate.toLocaleString('en-US', { 
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    
    // Parse EST components
    const [datePart, timePart] = estString.split(', ');
    const [month, day, year] = datePart.split('/');
    const [hours, minutes] = timePart.split(':');
    
    // Calculate boundary minutes
    const totalMinutes = parseInt(hours) * 60 + parseInt(minutes);
    const boundaryMinutes = Math.floor(totalMinutes / targetMinutes) * targetMinutes;
    const boundaryHours = Math.floor(boundaryMinutes / 60);
    const boundaryMins = boundaryMinutes % 60;
    
    // Create ISO string in EST and convert to UTC timestamp
    const estISOString = `${year}-${month}-${day}T${boundaryHours.toString().padStart(2, '0')}:${boundaryMins.toString().padStart(2, '0')}:00`;
    const boundaryTimestamp = new Date(estISOString + '-05:00').getTime(); // EST is UTC-5
    
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
 * Create working data from base cache + latest 1m candles
 */
async function createWorkingData(symbol) {
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
  
  if (new1mCandles.length > 0) {
    console.log(`🕯️   Updating higher timeframes with ${new1mCandles.length} new 1m candles`);
    
    // Aggregate new 1m candles for each timeframe
    const new5m = aggregateToTimeframe(new1mCandles, 5);
    const new15m = aggregateToTimeframe(new1mCandles, 15);
    const new30m = aggregateToTimeframe(new1mCandles, 30);
    const new1h = aggregateToTimeframe(new1mCandles, 60);
    
    // Prepend new aggregated candles to base cache data
    workingData['5m'].candles = [...new5m, ...workingData['5m'].candles];
    workingData['15m'].candles = [...new15m, ...workingData['15m'].candles];
    workingData['30m'].candles = [...new30m, ...workingData['30m'].candles];
  }
  
  // Always build 1h from 30m data (whether we have new candles or not)
  workingData['1h'] = {
    timeframe: '1h',
    candles: aggregate30mTo60m(workingData['30m'].candles),
    count: 0,
    raw: true
  };
  
  // Update counts and add metadata
  workingData['5m'].timeframe = '5m';
  workingData['5m'].raw = true;
  workingData['5m'].count = workingData['5m'].candles.length;
  
  workingData['15m'].timeframe = '15m';
  workingData['15m'].raw = true;
  workingData['15m'].count = workingData['15m'].candles.length;
  
  workingData['30m'].timeframe = '30m';
  workingData['30m'].raw = true;
  workingData['30m'].count = workingData['30m'].candles.length;
  
  workingData['1h'].count = workingData['1h'].candles.length;
  
  return workingData;
}

/**
 * Convert epoch milliseconds to EST time string (H:M:S)
 */
function toESTTime(datetime) {
  const date = new Date(datetime);
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
  const scores = [];
  
  for (let i = 0; i < candles.length; i++) {
    let score = 0;
    
    for (let j = i; j < candles.length - 1; j++) {
      const current = candles[j];
      const previous = candles[j + 1];
      
      let candleScoreChange = 0;
      
      if (current.high > previous.high) candleScoreChange += 1;
      else if (current.high < previous.high) candleScoreChange -= 1;
      
      if (current.low > previous.low) candleScoreChange += 1;
      else if (current.low < previous.low) candleScoreChange -= 1;
      
      if (current.close > current.open) {
        if (current.close > previous.close) candleScoreChange += 1;
        else if (current.close < previous.close) candleScoreChange -= 1;
      } else {
        if (current.close > previous.close) candleScoreChange += 1;
        else if (current.close < previous.close) candleScoreChange -= 1;
      }
      
      score += candleScoreChange;
      
      if ((score > 0 && candleScoreChange <= -3) || (score < 0 && candleScoreChange >= 3)) {
        break;
      }
    }
    
    scores.push(score);
  }
  
  return scores;
}

/**
 * Enhance candle data with technical indicators
 */
function enhanceCandleDataWithIndicators(symbol, candleData) {
  const enhancedData = {};
  
  for (const [timeframe, data] of Object.entries(candleData)) {
    
    if (data.error) {
      enhancedData[timeframe] = data;
      continue;
    }
    
    const candles = data.candles;
    
    if (!candles || candles.length === 0) {
      console.log(`🕯️ Skipping ${timeframe}: No candles available`);
      enhancedData[timeframe] = {
        ...data,
        indicators: { message: 'No candles available for indicators' }
      };
      continue;
    }
    
    console.log(`🕯️ Calculating indicators for ${timeframe} (${candles.length} candles)`);
    
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
    
    console.log(`🕯️ ✅ Enhanced ${timeframe} with indicators`);
  }
  
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
 * Analyze candles for a given symbol
 */
async function analyzeCandles(symbol, options = {}) {
  console.log(`🕯️ Starting candle analysis for: ${symbol}`);
  
  try {
    const candleData = await createWorkingData(symbol);
    
    let enhancedCandleData = enhanceCandleDataWithIndicators(symbol, candleData);
    enhancedCandleData = limitCandleData(enhancedCandleData, CANDLE_LIMIT);
    
    if (options.timeframe) {
      enhancedCandleData = filterTimeframe(enhancedCandleData, options.timeframe);
    }
    
    const analysis = {
      symbol: symbol,
      timestamp: new Date().toISOString(),
      status: 'analysis_complete',
      candleData: enhancedCandleData,
      message: options.timeframe 
        ? `Candle analysis completed for ${options.timeframe} timeframe (limited to ${CANDLE_LIMIT} candles)`
        : `Candle analysis completed with technical indicators (limited to ${CANDLE_LIMIT} candles per timeframe)`
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
  getCachedSymbols,
  enhanceCandleDataWithIndicators,
  calculateSMA,
  calculateEMA,
  calculateBollingerBands,
  calculatePerCandleBBScores,
  calculatePerCandleTrendScores,
  aggregate30mTo60m,
  clearBaseCache: (symbol) => {
    const cacheKey = `${symbol}_v${CACHE_VERSION}`;
    baseCandleCache.delete(cacheKey);
    console.log(`🕯️ Cleared base cache for ${symbol}`);
  }
};
