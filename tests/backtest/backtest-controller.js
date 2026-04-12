#!/usr/bin/env node

/**
 * Backtest Controller
 * Validates trading strategies using historical data with correct candle aggregation
 */

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

// Load environment variables
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

// Import market client
const marketClientPath = path.resolve(__dirname, '../../server/src/persistence/market-client.js');
const { marketClient } = require(marketClientPath);

// Import production indicator calculation functions
const candleAnalyzerPath = path.resolve(__dirname, '../../server/src/persistence/candle-analyzer.js');
const { 
  analyzeCandles,
  calculateSMA, 
  calculateEMA, 
  calculateBollingerBands,
  aggregate30mTo60m,
  calculatePerCandleTrendScores
} = require(candleAnalyzerPath);

// Import production strategy logic functions
const strategyLogicPath = path.resolve(__dirname, '../../server/src/persistence/strategy-logic.js');
const strategyLogicModule = require(strategyLogicPath);
const {
  calculateBBScore,
  resetPriceTrailState,
  resetPriceTrailv2State,
  resetPriceTrailv3State
} = strategyLogicModule;

// Backward-compatibility aliases for legacy check* names
const LEGACY_STRATEGY_ALIASES = {
  checkSimple5mBBScoreOpen: 'strategySimple5mBBScoreOpen',
  checkSimple5mBBScoreCover: 'strategySimple5mBBScoreCover',
  checkSimple15mBBScoreOpen: 'strategySimple15mBBScoreOpen',
  checkSimple15mBBScoreCover: 'strategySimple15mBBScoreCover',
  checkSimple15and60mBBScoreOpen: 'strategySimple15and60mBBScoreOpen',
  checkSimple15and60mBBScoreCover: 'strategySimple15and60mBBScoreCover',
  check1m5m15mOpen: 'strategy1m5m15mOpen',
  check1m5m15mCover: 'strategy1m5m15mCover',
  checkPriceTrailOpen: 'strategyPriceTrailOpen',
  checkPriceTrailCover: 'strategyPriceTrailCover',
  checkPriceTrailv2Open: 'strategyPriceTrailv2Open',
  checkPriceTrailv2Cover: 'strategyPriceTrailv2Cover',
  checkPriceTrailv3Open: 'strategyPriceTrailv3Open',
  checkPriceTrailv3Cover: 'strategyPriceTrailv3Cover'
};

function getStrategyHandler(methodName) {
  const resolvedName = strategyLogicModule[methodName]
    ? methodName
    : LEGACY_STRATEGY_ALIASES[methodName];

  if (!resolvedName || !strategyLogicModule[resolvedName]) {
    throw new Error(`Strategy function "${methodName}" not found in strategy-logic.js`);
  }

  return {
    name: resolvedName,
    fn: strategyLogicModule[resolvedName]
  };
}

function simplifyStrategyName(method) {
  if (!method) return 'unknown';
  return method.replace(/^strategy/, '').replace(/(Open|Cover)$/i, '');
}

function sortObjectKeys(obj) {
  if (Array.isArray(obj)) return obj.map(sortObjectKeys);
  if (obj && typeof obj === 'object') {
    const sorted = {};
    Object.keys(obj).sort().forEach(k => {
      sorted[k] = sortObjectKeys(obj[k]);
    });
    return sorted;
  }
  return obj;
}

class BacktestController {
  constructor() {
    this.results = [];
    this.strategyActions = []; // Track only position changes (opens/covers)
    this.openPosition = null; // Track current open position {type: 'bull'|'bear', openedAt: timestamp, bbScore15m: value}
    this.positionState = {
      state: 'new',
      bias: 'neutral',
      covered: true,
      type: null,
      openedAt: null
    };
    this.aggregatedAnalysis = null; // Store aggregated analysis with trendSum/bbSum for strategies
  }

  // NOTE: Strategy functions (strategy...Open/Cover) now use production functions
  // imported from strategy-logic.js to ensure backtest uses exact production strategy logic

  /**
   * Fetch seed data from Schwab API with exact date ranges
   * - 1 day of 5m candles ending 2/26
   * - 1 day of 15m candles ending 2/26
   * - 3 days of 30m candles ending 2/26 (for 60m aggregation)
   * - 1 day of 1m candles for 2/27 (backtest day)
   */
  async fetchSeedData(symbol, backtestDate) {
    console.log(`📊 Fetching seed data from Schwab API for backtest on ${backtestDate}`);
    
    const indexSymbols = ['NDX', 'SPX', 'RUT', 'DJX', 'OEX', 'VIX'];
    const apiSymbol = symbol.startsWith('$') ? symbol : (indexSymbols.includes(symbol) ? `$${symbol}` : symbol);
    
    // Calculate dates - parse as YYYY-MM-DD and add time to ensure correct day
    const [year, month, day] = backtestDate.split('-').map(Number);
    const backtestDateObj = new Date(year, month - 1, day, 12, 0, 0); // Noon to avoid timezone issues
    const priorDayObj = new Date(year, month - 1, day - 1, 12, 0, 0);
    
    // Ensure prior day lands on a trading day (skip weekends)
    while (priorDayObj.getDay() === 0 || priorDayObj.getDay() === 6) {
      priorDayObj.setDate(priorDayObj.getDate() - 1);
    }
    
    const backtestDateMs = backtestDateObj.getTime();
    const priorDayMs = priorDayObj.getTime();
    
    console.log(`\n📅 Date Setup:`);
    console.log(`   Backtest date: ${backtestDate} (${backtestDateObj.toDateString()})`);
    console.log(`   Prior day: ${priorDayObj.toISOString().split('T')[0]} (${priorDayObj.toDateString()})`);
    
    const seedData = {};
    
    // 1. Fetch 1 day of 5m candles ending on prior day - base for BB calculations
    console.log(`\n🕯️  Fetching 5m candles (1 day ending ${priorDayObj.toISOString().split('T')[0]})...`);
    const data5m = await marketClient.priceHistory(apiSymbol, {
      periodType: 'day',
      period: 1,
      frequencyType: 'minute',
      frequency: 5,
      endDate: priorDayMs
    });
    seedData['5m'] = (data5m.candles || []).filter(c => c.open !== 0 || c.high !== 0 || c.low !== 0 || c.close !== 0);
    // Filter to market hours only (9:30 AM - 4:00 PM ET)
    seedData['5m'] = this.filterMarketHours(seedData['5m']);
    // Sort newest first
    seedData['5m'].sort((a, b) => b.datetime - a.datetime);
    console.log(`   ✅ Received ${seedData['5m'].length} candles (market hours only)`);
    if (seedData['5m'].length > 0) {
      const first = seedData['5m'][0];
      const last = seedData['5m'][seedData['5m'].length - 1];
      console.log(`   📍 Range: ${new Date(last.datetime).toISOString()} to ${new Date(first.datetime).toISOString()}`);
    }
    
    // 2. Fetch 5 days of 15m candles ending on prior day
    // Production fetches 5 days ending "now" (includes partial 2/27)
    // Backtest fetches 5 days ending 2/26 (complete days, no current day)
    // Both get same date range: production has 2/23-2/27, backtest has 2/22-2/26
    console.log(`\n🕯️  Fetching 15m candles (5 days ending ${priorDayObj.toISOString().split('T')[0]})...`);
    const data15m = await marketClient.priceHistory(apiSymbol, {
      periodType: 'day',
      period: 5,
      frequencyType: 'minute',
      frequency: 15,
      endDate: priorDayMs
    });
    seedData['15m'] = (data15m.candles || []).filter(c => c.open !== 0 || c.high !== 0 || c.low !== 0 || c.close !== 0);
    // Filter to market hours only (9:30 AM - 4:00 PM ET)
    seedData['15m'] = this.filterMarketHours(seedData['15m']);
    // Sort newest first
    seedData['15m'].sort((a, b) => b.datetime - a.datetime);
    
    // Filter to match production's date range
    // Production fetches 5 days ending "now" (2/27) = gets 2/23-2/27
    // Backtest fetches 5 days ending 2/26 = gets 2/20-2/26 (includes 2/20 which production doesn't have)
    // Keep only candles from 2/23 onwards to match production's historical range
    if (seedData['15m'].length > 0) {
      const cutoffDate = new Date(backtestDateObj);
      cutoffDate.setDate(cutoffDate.getDate() - 4); // 4 days before backtest date = 2/23
      cutoffDate.setHours(0, 0, 0, 0);
      
      seedData['15m'] = seedData['15m'].filter(c => {
        const candleDate = new Date(c.datetime);
        const candleDateOnly = new Date(candleDate.toLocaleDateString('en-US', { timeZone: 'America/New_York' }));
        return candleDateOnly >= cutoffDate;
      });
    }
    console.log(`   ✅ Received ${seedData['15m'].length} candles (filtered to match production date range)`);
    if (seedData['15m'].length > 0) {
      const first = seedData['15m'][0];
      const last = seedData['15m'][seedData['15m'].length - 1];
      console.log(`   📍 Range: ${new Date(last.datetime).toISOString()} to ${new Date(first.datetime).toISOString()}`);
    }
    
    // 3. Fetch 5 days of 30m candles ending on prior day (2/26) - for 60m aggregation
    // Production fetches 5 days of 30m and aggregates to 1h (35 candles)
    // Backtest fetches 5 days of 30m ending 2/26 and aggregates to 60m
    console.log(`\n🕯️  Fetching 30m candles (5 days ending ${priorDayObj.toISOString().split('T')[0]})...`);
    const data30m = await marketClient.priceHistory(apiSymbol, {
      periodType: 'day',
      period: 5,
      frequencyType: 'minute',
      frequency: 30,
      endDate: priorDayMs
    });
    const unfiltered30m = (data30m.candles || []).filter(c => c.open !== 0 || c.high !== 0 || c.low !== 0 || c.close !== 0);
    seedData['30m'] = [...unfiltered30m];
    // Filter to market hours only (9:30 AM - 4:00 PM ET)
    seedData['30m'] = this.filterMarketHours(seedData['30m']);
    // Sort newest first
    seedData['30m'].sort((a, b) => b.datetime - a.datetime);
    
    // Filter to match production's date range
    // Production: 5 days ending "now" (2/27) = 2/23-2/27
    // Backtest: 5 days ending 2/26 = 2/20-2/26 (includes 2/20 which production doesn't have)
    // Keep only candles from 2/23 onwards to match production's historical range
    if (seedData['30m'].length > 0) {
      const cutoffDate = new Date(backtestDateObj);
      cutoffDate.setDate(cutoffDate.getDate() - 4); // 4 days before backtest date = 2/23
      cutoffDate.setHours(0, 0, 0, 0);
      
      seedData['30m'] = seedData['30m'].filter(c => {
        const candleDate = new Date(c.datetime);
        const candleDateOnly = new Date(candleDate.toLocaleDateString('en-US', { timeZone: 'America/New_York' }));
        return candleDateOnly >= cutoffDate;
      });
      const unique30mDates = new Set(seedData['30m'].map(c => new Date(c.datetime).toDateString()));
      if (unique30mDates.size < 3) {
        console.log(`   ⚠️ 30m cutoff filter left only ${unique30mDates.size} trading day(s); restoring full seed range to maintain indicator history.`);
        seedData['30m'] = [...unfiltered30m];
      }
    }
    console.log(`   ✅ Received ${seedData['30m'].length} candles (filtered to match production date range)`);
    if (seedData['30m'].length > 0) {
      const first = seedData['30m'][0];
      const last = seedData['30m'][seedData['30m'].length - 1];
      console.log(`   📍 Range: ${new Date(last.datetime).toISOString()} to ${new Date(first.datetime).toISOString()}`);
    }
    
    // 4. Fetch 2 days of 1m candles (for future backtesting flexibility)
    console.log(`\n🕯️  Fetching 1m candles (2 days ending ${backtestDate})...`);
    const data1m = await marketClient.priceHistory(apiSymbol, {
      periodType: 'day',
      period: 2,
      frequencyType: 'minute',
      frequency: 1,
      endDate: backtestDateMs
    });
    seedData['1m'] = (data1m.candles || []).filter(c => c.open !== 0 || c.high !== 0 || c.low !== 0 || c.close !== 0);
    // Filter to market hours only (9:30 AM - 4:00 PM ET)
    seedData['1m'] = this.filterMarketHours(seedData['1m']);
    console.log(`   ✅ Received ${seedData['1m'].length} candles (market hours only)`);
    if (seedData['1m'].length > 0) {
      const first = seedData['1m'][0];
      const last = seedData['1m'][seedData['1m'].length - 1];
      console.log(`   📍 Range: ${new Date(last.datetime).toISOString()} to ${new Date(first.datetime).toISOString()}`);
    }
    
    // Verify date ranges
    console.log(`\n✅ Verification:`);
    this.verifySeedData(seedData, backtestDateObj, priorDayObj);
    
    return seedData;
  }

  /**
   * Verify that seed data has correct date ranges
   */
  verifySeedData(seedData, backtestDateObj, priorDayObj) {
    const backtestDateStr = backtestDateObj.toDateString();
    const priorDayStr = priorDayObj.toDateString();
    
    // Check 5m candles - should only have prior day
    const candles5m = seedData['5m'];
    const dates5m = new Set(candles5m.map(c => new Date(c.datetime).toDateString()));
    console.log(`   5m candles cover dates: ${Array.from(dates5m).join(', ')}`);
    const has5mBacktestDay = candles5m.some(c => new Date(c.datetime).toDateString() === backtestDateStr);
    const has5mPriorDay = candles5m.some(c => new Date(c.datetime).toDateString() === priorDayStr);
    console.log(`   5m has prior day (${priorDayStr}): ${has5mPriorDay ? '✅' : '❌'}`);
    console.log(`   5m has backtest day (${backtestDateStr}): ${has5mBacktestDay ? '❌ WRONG!' : '✅'}`);
    
    // Check 15m candles - should only have prior day
    const candles15m = seedData['15m'];
    const dates15m = new Set(candles15m.map(c => new Date(c.datetime).toDateString()));
    console.log(`   15m candles cover dates: ${Array.from(dates15m).join(', ')}`);
    const has15mBacktestDay = candles15m.some(c => new Date(c.datetime).toDateString() === backtestDateStr);
    const has15mPriorDay = candles15m.some(c => new Date(c.datetime).toDateString() === priorDayStr);
    console.log(`   15m has prior day (${priorDayStr}): ${has15mPriorDay ? '✅' : '❌'}`);
    console.log(`   15m has backtest day (${backtestDateStr}): ${has15mBacktestDay ? '❌ WRONG!' : '✅'}`);
    
    // Check 30m candles - should have 3 days ending on prior day
    const candles30m = seedData['30m'];
    const dates30m = new Set(candles30m.map(c => new Date(c.datetime).toDateString()));
    console.log(`   30m candles cover dates: ${Array.from(dates30m).join(', ')}`);
    const has30mBacktestDay = candles30m.some(c => new Date(c.datetime).toDateString() === backtestDateStr);
    const has30mPriorDay = candles30m.some(c => new Date(c.datetime).toDateString() === priorDayStr);
    console.log(`   30m has prior day (${priorDayStr}): ${has30mPriorDay ? '✅' : '❌'}`);
    console.log(`   30m has backtest day (${backtestDateStr}): ${has30mBacktestDay ? '❌ WRONG!' : '✅'}`);
    console.log(`   30m covers ${dates30m.size} days (expected 3): ${dates30m.size === 3 ? '✅' : '⚠️'}`);
    
    // Check 1m candles - should have both prior day and backtest day (2 days)
    const candles1m = seedData['1m'];
    const dates1m = new Set(candles1m.map(c => new Date(c.datetime).toDateString()));
    console.log(`   1m candles cover dates: ${Array.from(dates1m).join(', ')}`);
    const has1mBacktestDay = candles1m.some(c => new Date(c.datetime).toDateString() === backtestDateStr);
    const has1mPriorDay = candles1m.some(c => new Date(c.datetime).toDateString() === priorDayStr);
    console.log(`   1m has backtest day (${backtestDateStr}): ${has1mBacktestDay ? '✅' : '❌'}`);
    console.log(`   1m has prior day (${priorDayStr}): ${has1mPriorDay ? '✅' : '❌'}`);
    console.log(`   1m covers ${dates1m.size} days (expected 2): ${dates1m.size === 2 ? '✅' : '⚠️'}`);
  }

  /**
   * Filter candles to only include regular market hours (9:30 AM - 4:00 PM ET)
   * Excludes pre-market and after-hours candles
   */
  filterMarketHours(candles) {
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
   * Aggregate multiple 1m candles into a single OHLC candle
   * Candles should be in chronological order (oldest to newest)
   */
  aggregateCandles(candles) {
    if (!candles || candles.length === 0) return null;
    
    // Sort chronologically (oldest first) for proper aggregation
    const sorted = [...candles].sort((a, b) => a.datetime - b.datetime);
    
    return {
      datetime: sorted[0].datetime, // Use oldest timestamp (start of period) to match Schwab
      open: sorted[0].open,
      high: Math.max(...sorted.map(c => c.high)),
      low: Math.min(...sorted.map(c => c.low)),
      close: sorted[sorted.length - 1].close,
      volume: sorted.reduce((sum, c) => sum + c.volume, 0)
    };
  }

  // NOTE: SMA, EMA, Bollinger Bands, aggregate30mTo60m, and calculateBBScore
  // now use production functions to ensure backtest validates exact production code

  /**
   * Run backtest
   */
  async runBacktest(symbol, backtestDate, openMethod = 'strategySimple5mBBScoreOpen', coverMethod = 'strategySimple5mBBScoreCover', runtimeOptions = {}) {
    try {
      // Reset strategy state for new day
      const { name: openStrategyName, fn: openStrategyFn } = getStrategyHandler(openMethod);
      const { name: coverStrategyName, fn: coverStrategyFn } = getStrategyHandler(coverMethod);

      const runTimestamp = new Date().toISOString();
      console.log(`🧪 Starting Correct Algorithm Backtest`);
      console.log(`   Symbol: ${symbol}`);
      console.log(`   Backtest Date: ${backtestDate}`);
      const openLabel = openStrategyName === openMethod ? openStrategyName : `${openMethod} → ${openStrategyName}`;
      const coverLabel = coverStrategyName === coverMethod ? coverStrategyName : `${coverMethod} → ${coverStrategyName}`;
      console.log(`   Open Strategy: ${openLabel}`);
      console.log(`   Cover Strategy: ${coverLabel}`);

      const calculateDelta = (previous, current) => {
        if (
          previous === null || previous === undefined ||
          current === null || current === undefined
        ) {
          return null;
        }
        return current - previous;
      };

      // Use analyzeCandles with historical date to get candles + indicators + aggregated analysis
      console.log(`\n�️ Fetching historical candle analysis for ${backtestDate}...`);
      const analysis = await analyzeCandles(symbol, { date: backtestDate });
      
      if (analysis.status === 'error') {
        throw new Error(`Candle analysis failed: ${analysis.error}`);
      }
      
      const candleData = analysis.candleData;
      this.aggregatedAnalysis = analysis.aggregatedAnalysis;
      
      console.log(`\n📊 Candle Data Summary:`);
      console.log(`   1m candles: ${candleData['1m']?.candles?.length || 0}`);
      console.log(`   5m candles: ${candleData['5m']?.candles?.length || 0}`);
      console.log(`   15m candles: ${candleData['15m']?.candles?.length || 0}`);
      console.log(`   30m candles: ${candleData['30m']?.candles?.length || 0}`);
      console.log(`   60m candles: ${candleData['60m']?.candles?.length || 0}`);
      console.log(`   Aggregated analysis: ${this.aggregatedAnalysis?.candles?.length || 0} candles with trendSum/bbSum`);
      
      // Extract candle arrays for backward compatibility with existing code
      const seedData = {
        '1m': candleData['1m']?.candles || [],
        '5m': candleData['5m']?.candles || [],
        '15m': candleData['15m']?.candles || [],
        '30m': candleData['30m']?.candles || [],
        '60m': candleData['60m']?.candles || []
      };
      
      console.log(`\n✅ Historical candle analysis complete with indicators and aggregated data!`);
      
      // Sort 1m candles newest first for analysis
      const candles1m = [...seedData['1m']].sort((a, b) => b.datetime - a.datetime);
      
      console.log(`\n🔬 Starting minute-by-minute analysis...`);
      
      // Setup date for filtering
      const [year, month, day] = backtestDate.split('-').map(Number);
      const backtestDateObj = new Date(year, month - 1, day);
      const backtestDateStr = backtestDateObj.toDateString();
      
      // Initialize working candles storage for today's aggregated candles
      const workingCandles = {
        '5m': [],
        '15m': [],
        '60m': []
      };

      const previousBBScores = {
        '1m': null,
        '5m': null,
        '15m': null,
        '60m': null
      };
      
      // Get all backtest day 1m candles sorted newest first
      const backtestDay1mCandles = candles1m.filter(c => {
        const d = new Date(c.datetime);
        return d.toDateString() === backtestDateStr;
      });
      
      // Prepare seed data arrays (sorted newest first)
      const candles5m = [...seedData['5m']].sort((a, b) => b.datetime - a.datetime);
      const candles15m = [...seedData['15m']].sort((a, b) => b.datetime - a.datetime);
      
      // Process each minute from 9:30 to 16:00
      console.log(`\n🔄 Processing trading day minute-by-minute (9:30-16:00)...`);
      
      for (let hour = 9; hour <= 16; hour++) {
        const startMinute = (hour === 9) ? 30 : 0;
        const endMinute = (hour === 16) ? 0 : 59;
        
        for (let minute = startMinute; minute <= endMinute; minute++) {
          const timestamp = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
          
          // Only log every 5 minutes to reduce output
          if (minute % 5 === 0 || minute === 31) {
            console.log(`\n📊 Processing ${timestamp}...`);
          }
        
          // Find the current minute's 1m candle
          const currentCandle = candles1m.find(c => {
            const d = new Date(c.datetime);
            const estDate = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
            return d.toDateString() === backtestDateStr && 
                   estDate.getHours() === hour && 
                   estDate.getMinutes() === minute;
          });
          
          if (!currentCandle) {
            continue; // Skip if candle not found
          }
          
          const currentIndex = candles1m.findIndex(c => c.datetime === currentCandle.datetime);
          
          // === 1-MINUTE ANALYSIS ===
          const candles1mForBB = candles1m.slice(currentIndex, currentIndex + 21);
          const candles1mForEMA = candles1m.slice(currentIndex); // Use full array for rolling EMA
          const candles1mForTrend = candles1m.slice(currentIndex); // Use full array for trend score
          
          let bb1m = null, sma1m = null, bbScore1m = null, ema1m = null, trendScore1m = null;
          
          if (candles1mForBB.length >= 21) {
            bb1m = calculateBollingerBands(candles1mForBB, 20, 2);
            sma1m = calculateSMA(candles1mForBB, 20);
            bbScore1m = calculateBBScore(currentCandle.close, bb1m.upper[0], bb1m.middle[0], bb1m.lower[0]);
          }
          
          if (candles1mForEMA.length >= 9) {
            const emaArray = calculateEMA(candles1mForEMA, 9);
            ema1m = emaArray[0]; // Use value at index 0 (newest candle)
          }
          
          if (candles1mForTrend.length >= 2) {
            const trendScores = calculatePerCandleTrendScores(candles1mForTrend);
            trendScore1m = trendScores[0]; // Use value at index 0 (newest candle)
          }
          
          // === 5-MINUTE ANALYSIS ===
          // Aggregate 1m candles from backtest day into 5m candle
          // Boundary: 9:30-9:34, 9:35-9:39, 9:40-9:44, etc.
          let candle5m, candles5mForBB, candles5mForEMA;
          
          const currentTotalMin = hour * 60 + minute;
          const boundary5m = Math.floor(currentTotalMin / 5) * 5;
          const is5mBoundary = minute % 5 === 0 && currentTotalMin > 570; // After 9:30
          
          // At 5m boundary, save previous period's complete candle to working array
          if (is5mBoundary) {
            const prevBoundary = boundary5m - 5;
            const prevCandles = backtestDay1mCandles.filter(c => {
              const d = new Date(c.datetime);
              const estDate = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
              const totalMin = estDate.getHours() * 60 + estDate.getMinutes();
              return totalMin >= prevBoundary && totalMin < boundary5m;
            });
            if (prevCandles.length > 0) {
              const completeCandle = this.aggregateCandles(prevCandles);
              workingCandles['5m'].unshift(completeCandle); // Prepend (newest first)
            }
          }
          
          // Get all 1m candles from boundary start to current minute (partial candle)
          const candles5mPeriod = backtestDay1mCandles.filter(c => {
            const d = new Date(c.datetime);
            const estDate = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
            const totalMin = estDate.getHours() * 60 + estDate.getMinutes();
            return totalMin >= boundary5m && totalMin <= currentTotalMin;
          });
          
          // Aggregate into current 5m candle (partial or complete)
          candle5m = this.aggregateCandles(candles5mPeriod);
          
          // For BB/EMA: [current partial] + [working complete candles] + [seed data]
          candles5mForBB = [candle5m, ...workingCandles['5m'], ...candles5m].slice(0, 21);
          candles5mForEMA = [candle5m, ...workingCandles['5m'], ...candles5m]; // Use full array for rolling EMA
          const candles5mForTrend = [candle5m, ...workingCandles['5m'], ...candles5m]; // Use full array for trend score
          
          let bb5m = null, sma5m = null, bbScore5m = null, ema5m = null, trendScore5m = null;
          
          if (candles5mForBB.length >= 21) {
            bb5m = calculateBollingerBands(candles5mForBB, 20, 2);
            sma5m = calculateSMA(candles5mForBB, 20);
            bbScore5m = calculateBBScore(candle5m.close, bb5m.upper[0], bb5m.middle[0], bb5m.lower[0]);
          }
          
          if (candles5mForEMA.length >= 9) {
            const emaArray = calculateEMA(candles5mForEMA, 9);
            ema5m = emaArray[0]; // Use value at index 0 (newest candle)
          }
          
          if (candles5mForTrend.length >= 2) {
            const trendScores = calculatePerCandleTrendScores(candles5mForTrend);
            trendScore5m = trendScores[0]; // Use value at index 0 (newest candle)
          }
          
          // === 15-MINUTE ANALYSIS ===
          // Aggregate 1m candles from backtest day into 15m candle
          // Boundary: 9:30-9:44, 9:45-9:59, 10:00-10:14, etc.
          let candle15m, candles15mForBB, candles15mForEMA;
          
          // Calculate 15m boundary (aligned to market open at 9:30)
          const boundary15m = Math.floor((currentTotalMin - 570) / 15) * 15 + 570; // 570 = 9:30
          // Detect when a 15m period completes: :44, :59, :14, :29
          // These are 14 minutes after the start: 30+14=44, 45+14=59, 00+14=14, 15+14=29
          const is15mBoundary = (currentTotalMin - 584) % 15 === 0 && currentTotalMin >= 584; // 584 = 9:44
          
          // At 15m boundary, save previous period's complete candle to working array
          if (is15mBoundary) {
            const prevBoundary = boundary15m - 15;
            const prevCandles = backtestDay1mCandles.filter(c => {
              const d = new Date(c.datetime);
              const estDate = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
              const totalMin = estDate.getHours() * 60 + estDate.getMinutes();
              return totalMin >= prevBoundary && totalMin < boundary15m;
            });
            if (prevCandles.length > 0) {
              const completeCandle = this.aggregateCandles(prevCandles);
              workingCandles['15m'].unshift(completeCandle);
            }
          }
          
          // Get all 1m candles from boundary start to current minute (partial candle)
          const candles15mPeriod = backtestDay1mCandles.filter(c => {
            const d = new Date(c.datetime);
            const estDate = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
            const totalMin = estDate.getHours() * 60 + estDate.getMinutes();
            return totalMin >= boundary15m && totalMin <= currentTotalMin;
          });
          
          // Aggregate into current 15m candle (partial or complete)
          candle15m = this.aggregateCandles(candles15mPeriod);
          
          // For BB/EMA: [current partial] + [working complete candles] + [seed data]
          candles15mForBB = [candle15m, ...workingCandles['15m'], ...candles15m].slice(0, 21);
          candles15mForEMA = [candle15m, ...workingCandles['15m'], ...candles15m]; // Use full array for rolling EMA
          const candles15mForTrend = [candle15m, ...workingCandles['15m'], ...candles15m]; // Use full array for trend score
          
          let bb15m = null, sma15m = null, bbScore15m = null, ema15m = null, trendScore15m = null;
          
          if (candles15mForBB.length >= 21) {
            bb15m = calculateBollingerBands(candles15mForBB, 20, 2);
            sma15m = calculateSMA(candles15mForBB, 20);
            bbScore15m = calculateBBScore(candle15m.close, bb15m.upper[0], bb15m.middle[0], bb15m.lower[0]);
          }
          
          if (candles15mForEMA.length >= 9) {
            const emaArray = calculateEMA(candles15mForEMA, 9);
            ema15m = emaArray[0]; // Use value at index 0 (newest candle)
          }
          
          if (candles15mForTrend.length >= 2) {
            const trendScores = calculatePerCandleTrendScores(candles15mForTrend);
            trendScore15m = trendScores[0]; // Use value at index 0 (newest candle)
          }
          
          // === 60-MINUTE ANALYSIS ===
          // Aggregate 1m candles from backtest day into 60m candle
          // Boundary: First candle 9:30-9:59 (30 min), then hourly 10:00-10:59, 11:00-11:59, etc.
          let candle60m, candles60mForBB, candles60mForEMA;
          
          // Calculate 60m boundary
          // First candle: timestamp 09:00 but data from 09:30-09:59 (matches production)
          // After 10:00: align to clock hours (600, 660, 720, etc.)
          let boundary60m;
          if (currentTotalMin < 600) {
            boundary60m = 540; // 09:00 (timestamp, even though data starts at 09:30)
          } else {
            boundary60m = Math.floor(currentTotalMin / 60) * 60;
          }
          // Detect when 60m periods complete: 09:59, 10:59, 11:59, 12:59, 13:59, 14:59, 15:59
          const is60mBoundary = minute === 59 && hour >= 9;
          
          if (is60mBoundary && currentTotalMin > 599) {
            // At 10:59, save the PREVIOUS completed hour (09:00-09:59)
            // At 11:59, save the PREVIOUS completed hour (10:00-10:59)
            // The CURRENT hour (10:00-10:59 at 10:59) is the "current candle", not a working candle
            const currentHourStart = Math.floor(currentTotalMin / 60) * 60;
            const prevHourStart = currentHourStart - 60;
            const prevHourEnd = currentHourStart - 1;
            
            // Only add if we haven't already added this period
            // At 10:59: save 09:00-09:59 (if not already in working)
            // At 11:59: save 10:00-10:59 (if not already in working)
            const alreadyHasPrevHour = workingCandles['60m'].some(c => {
              const d = new Date(c.datetime);
              const estDate = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
              const totalMin = estDate.getHours() * 60 + estDate.getMinutes();
              return totalMin === prevHourStart || (prevHourStart === 540 && totalMin === 540);
            });
            
            if (!alreadyHasPrevHour) {
              const prevCandles = backtestDay1mCandles.filter(c => {
                const d = new Date(c.datetime);
                const estDate = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
                const totalMin = estDate.getHours() * 60 + estDate.getMinutes();
                // For 09:00-09:59, data only exists from 09:30-09:59
                if (prevHourStart === 540) {
                  return totalMin >= 570 && totalMin <= 599;
                }
                return totalMin >= prevHourStart && totalMin <= prevHourEnd;
              });
              if (prevCandles.length > 0) {
                const completeCandle = this.aggregateCandles(prevCandles);
                // Set datetime to hour start (09:00, 10:00, etc.)
                const backtestDateObj = new Date(backtestDate);
                const year = backtestDateObj.getFullYear();
                const month = backtestDateObj.getMonth();
                const day = backtestDateObj.getDate();
                const hour = Math.floor(prevHourStart / 60);
                completeCandle.datetime = new Date(year, month, day, hour, 0, 0).getTime();
                workingCandles['60m'].unshift(completeCandle);
              }
            }
          }
          
          // Get all 1m candles from boundary start to current minute (partial candle)
          const candles60mPeriod = backtestDay1mCandles.filter(c => {
            const d = new Date(c.datetime);
            const estDate = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
            const totalMin = estDate.getHours() * 60 + estDate.getMinutes();
            return totalMin >= boundary60m && totalMin <= currentTotalMin;
          });
          
          // Aggregate into current 60m candle (partial or complete)
          candle60m = this.aggregateCandles(candles60mPeriod);
          
          // Override datetime for first 60m candle to use 09:00 timestamp (matches production)
          if (currentTotalMin >= 570 && currentTotalMin < 600) {
            const backtestDateObj = new Date(backtestDate);
            const year = backtestDateObj.getFullYear();
            const month = backtestDateObj.getMonth();
            const day = backtestDateObj.getDate();
            candle60m.datetime = new Date(year, month, day, 9, 0, 0).getTime();
          }
          
          // For BB/EMA: [current partial] + [working complete candles] + [seed data]
          candles60mForBB = [candle60m, ...workingCandles['60m'], ...seedData['60m']].slice(0, 21);
          candles60mForEMA = [candle60m, ...workingCandles['60m'], ...seedData['60m']]; // Use full array for rolling EMA
          const candles60mForTrend = [candle60m, ...workingCandles['60m'], ...seedData['60m']]; // Use full array for trend score
          
          let bb60m = null, sma60m = null, bbScore60m = null, ema60m = null, trendScore60m = null;
          
          if (candles60mForBB.length >= 21) {
            bb60m = calculateBollingerBands(candles60mForBB, 20, 2);
            sma60m = calculateSMA(candles60mForBB, 20);
            bbScore60m = calculateBBScore(candle60m.close, bb60m.upper[0], bb60m.middle[0], bb60m.lower[0]);
          }
          
          if (candles60mForEMA.length >= 9) {
            const emaArray = calculateEMA(candles60mForEMA, 9);
            ema60m = emaArray[0]; // Use value at index 0 (newest candle)
          }
          
          if (candles60mForTrend.length >= 2) {
            const trendScores = calculatePerCandleTrendScores(candles60mForTrend);
            trendScore60m = trendScores[0]; // Use value at index 0 (newest candle)
          }
          
          // === STRATEGY EXECUTION ===
          this.runtimeOptions = runtimeOptions || {};
          let strategyMethod = null;
          let opened = false;
          let covered = false;
          
          // Build analysis object for strategy methods
          const bbScoreDelta1m = calculateDelta(previousBBScores['1m'], bbScore1m);
          const bbScoreDelta5m = calculateDelta(previousBBScores['5m'], bbScore5m);
          const bbScoreDelta15m = calculateDelta(previousBBScores['15m'], bbScore15m);
          const bbScoreDelta60m = calculateDelta(previousBBScores['60m'], bbScore60m);

          if (bbScore1m !== null && bbScore1m !== undefined) {
            previousBBScores['1m'] = bbScore1m;
          }
          if (bbScore5m !== null && bbScore5m !== undefined) {
            previousBBScores['5m'] = bbScore5m;
          }
          if (bbScore15m !== null && bbScore15m !== undefined) {
            previousBBScores['15m'] = bbScore15m;
          }
          if (bbScore60m !== null && bbScore60m !== undefined) {
            previousBBScores['60m'] = bbScore60m;
          }

          const analysisForStrategy = {
            '1m': { close: currentCandle.close, bbScore: bbScore1m, bbScoreDelta: bbScoreDelta1m, trendScore: trendScore1m },
            '5m': { close: candle5m.close, bbScore: bbScore5m, bbScoreDelta: bbScoreDelta5m, trendScore: trendScore5m },
            '15m': { close: candle15m.close, bbScore: bbScore15m, bbScoreDelta: bbScoreDelta15m, trendScore: trendScore15m },
            '60m': { close: candle60m.close, bbScore: bbScore60m, bbScoreDelta: bbScoreDelta60m, trendScore: trendScore60m }
          };

          const applyStateUpdates = (next = {}) => {
            if (next.nextState) {
              this.positionState.state = next.nextState;
            }
            if (next.nextBias) {
              this.positionState.bias = next.nextBias;
            }
            const patches = next.positionStateUpdates || next.positionPatches;
            if (patches && typeof patches === 'object') {
              Object.assign(this.positionState, patches);
            }
          };

          const isOpenState = this.positionState.state === 'open' && !this.positionState.covered;

          if (!isOpenState) {
            strategyMethod = openStrategyName;
            const openResult = openStrategyFn(this.positionState, analysisForStrategy, this.runtimeOptions) || {};
            applyStateUpdates(openResult);

            if (openResult.action === 'open_bull' || openResult.action === 'open_bear') {
              const positionType = openResult.action === 'open_bull' ? 'bull' : 'bear';
              const bias = openResult.action === 'open_bull' ? 'bullish' : 'bearish';

              this.positionState = {
                state: 'open',
                bias,
                covered: false,
                type: positionType,
                openedAt: timestamp,
                _elapsedOpen: 0
              };

              this.openPosition = {
                type: positionType,
                openedAt: timestamp,
                bbScore5m,
                bbScore15m
              };

              opened = true;

              this.strategyActions.push({
                timestamp,
                datetime: currentCandle.datetime,
                action: openResult.action,
                strategyMethod,
                closePrice: currentCandle.close,
                bbScore1m,
                bbScore5m,
                bbScore15m,
                bbScore60m,
                state: this.positionState.state,
                bias: this.positionState.bias,
                position: { ...this.openPosition }
              });
            }
          } else {
            strategyMethod = coverStrategyName;
            const coverResult = coverStrategyFn(this.positionState, analysisForStrategy, { positionType: this.positionState.type }, this.runtimeOptions) || {};
            applyStateUpdates(coverResult);

            if (coverResult.action === 'cover') {
              covered = true;

              this.strategyActions.push({
                timestamp,
                datetime: currentCandle.datetime,
                action: 'cover',
                strategyMethod,
                closePrice: currentCandle.close,
                bbScore1m,
                bbScore5m,
                bbScore15m,
                bbScore60m,
                openedPosition: {
                  type: this.positionState.type,
                  openedAt: this.positionState.openedAt
                },
                state: coverResult.nextState || 'covered',
                bias: this.positionState.bias
              });

              this.openPosition = null;
              this.positionState = {
                state: 'new',
                bias: 'neutral',
                covered: false,
                type: null,
                openedAt: null
              };
            }
          }

          const result = {
            timestamp,
            datetime: currentCandle.datetime,
            strategyMethod,
            opened,
            covered,
            hasOpenPosition: this.positionState.state === 'open' && !this.positionState.covered,
            positionState: { ...this.positionState },
            analysis: {
              '1m': {
                open: currentCandle.open,
                high: currentCandle.high,
                low: currentCandle.low,
                close: currentCandle.close,
                volume: currentCandle.volume,
                bbupper: bb1m ? bb1m.upper[0] : null,
                bbmiddle: bb1m ? bb1m.middle[0] : null,
                bblower: bb1m ? bb1m.lower[0] : null,
                sma: sma1m ? sma1m[0] : null,
                ema: ema1m,
                bbScore: bbScore1m,
                bbScoreDelta: bbScoreDelta1m,
                trendScore: trendScore1m
              },
              '5m': {
                open: candle5m.open,
                high: candle5m.high,
                low: candle5m.low,
                close: candle5m.close,
                volume: candle5m.volume,
                bbupper: bb5m ? bb5m.upper[0] : null,
                bbmiddle: bb5m ? bb5m.middle[0] : null,
                bblower: bb5m ? bb5m.lower[0] : null,
                sma: sma5m ? sma5m[0] : null,
                ema: ema5m,
                bbScore: bbScore5m,
                bbScoreDelta: bbScoreDelta5m,
                trendScore: trendScore5m
              },
              '15m': {
                open: candle15m.open,
                high: candle15m.high,
                low: candle15m.low,
                close: candle15m.close,
                volume: candle15m.volume,
                bbupper: bb15m ? bb15m.upper[0] : null,
                bbmiddle: bb15m ? bb15m.middle[0] : null,
                bblower: bb15m ? bb15m.lower[0] : null,
                sma: sma15m ? sma15m[0] : null,
                ema: ema15m,
                bbScore: bbScore15m,
                bbScoreDelta: bbScoreDelta15m,
                trendScore: trendScore15m
              },
              '60m': {
                open: candle60m.open,
                high: candle60m.high,
                low: candle60m.low,
                close: candle60m.close,
                volume: candle60m.volume,
                bbupper: bb60m ? bb60m.upper[0] : null,
                bbmiddle: bb60m ? bb60m.middle[0] : null,
                bblower: bb60m ? bb60m.lower[0] : null,
                sma: sma60m ? sma60m[0] : null,
                ema: ema60m,
                bbScore: bbScore60m,
                bbScoreDelta: bbScoreDelta60m,
                trendScore: trendScore60m
              }
            }
          };

          this.results.push(result);
          
          // Log progress at boundaries
          if (minute % 5 === 0 || minute === 31) {
            console.log(`   ✅ 1m: ${bbScore1m?.toFixed(3)}, 5m: ${bbScore5m?.toFixed(3)}, 15m: ${bbScore15m?.toFixed(3)}, 60m: ${bbScore60m?.toFixed(3)}`);
          }
        }
      }
      
      console.log(`\n✅ Completed full trading day analysis`);
      console.log(`📊 Total results: ${this.results.length}`);
      console.log(`📊 Strategy actions: ${this.strategyActions.length}`);
      
      // Add end-of-day entry if position still open at market close
      if (this.openPosition) {
        const lastResult = this.results[this.results.length - 1];
        this.strategyActions.push({
          timestamp: lastResult.timestamp,
          datetime: lastResult.datetime,
          action: 'eod_open',
          strategyMethod: 'N/A',
          closePrice: lastResult.analysis['1m'].close,
          position: { ...this.openPosition }
        });
        console.log(`📊 Position still open at market close - added EOD entry`);
      }
      
      // Calculate approximate profitability
      let totalProfitLoss = 0;
      let openPrice = null;
      let positionType = null;
      
      for (const action of this.strategyActions) {
        if (action.action === 'open_bull' || action.action === 'open_bear') {
          openPrice = action.closePrice;
          positionType = action.position.type;
        } else if (action.action === 'cover' && openPrice !== null) {
          const coverPrice = action.closePrice;
          const priceDiff = coverPrice - openPrice;
          
          // Bull: profit when price goes up (cover > open)
          // Bear: profit when price goes down (open > cover)
          const profitLoss = positionType === 'bull' ? priceDiff : -priceDiff;
          totalProfitLoss += profitLoss;
          
          openPrice = null;
          positionType = null;
        } else if (action.action === 'eod_open' && openPrice !== null) {
          // Calculate unrealized P&L for open position at EOD
          const eodPrice = action.closePrice;
          const priceDiff = eodPrice - openPrice;
          const unrealizedPL = positionType === 'bull' ? priceDiff : -priceDiff;
          totalProfitLoss += unrealizedPL;
        }
      }
      
      console.log(`📊 Total Profit/Loss (points): ${totalProfitLoss.toFixed(4)}`);
      
      // Save results to file
      const dataDir = path.join(__dirname, 'backtest-data');
      await fs.mkdir(dataDir, { recursive: true });
      const outputPath = path.join(dataDir, `backtest-${symbol}-${backtestDate}.json`);
      await fs.writeFile(outputPath, JSON.stringify(this.results, null, 2));
      console.log(`\n💾 Results saved to: ${outputPath}`);
      
      // Compute optional labeling for this run to avoid overwriting files across different configs
      const runLabel = this.runtimeOptions && this.runtimeOptions.runLabel ? String(this.runtimeOptions.runLabel) : null;
      const configForHash = this.runtimeOptions && this.runtimeOptions.config ? this.runtimeOptions.config : null;
      let configHash = null;
      if (configForHash) {
        try {
          const normalized = JSON.stringify(sortObjectKeys(configForHash));
          configHash = crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 8);
        } catch (e) {
          // noop - leave configHash null on serialization errors
        }
      }

      // Save strategy actions to separate file with metadata header
      const actionsOutput = {
        metadata: {
          symbol,
          backtestDate,
          openStrategy: openMethod,
          coverStrategy: coverMethod,
          runTimestamp,
          totalActions: this.strategyActions.length,
          totalProfitLoss: parseFloat(totalProfitLoss.toFixed(4)),
          runLabel: runLabel || null,
          configHash: configHash || null,
          config: configForHash || null
        },
        actions: this.strategyActions
      };
      
      // Create filename with strategy method names (simplified)
      const openMethodShort = simplifyStrategyName(openStrategyName);
      const coverMethodShort = simplifyStrategyName(coverStrategyName);
      const actionsDir = path.join(__dirname, 'backtest-actions');
      await fs.mkdir(actionsDir, { recursive: true });
      let suffix = '';
      if (runLabel) {
        const safe = runLabel.trim().replace(/\s+/g, '_').replace(/[^A-Za-z0-9_\-.]/g, '');
        if (safe) suffix = `-${safe}`;
      } else if (configHash) {
        suffix = `-cfg${configHash}`;
      }
      const actionsPath = path.join(actionsDir, `backtest-actions-${symbol}-${backtestDate}-${openMethodShort}-${coverMethodShort}${suffix}.json`);
      await fs.writeFile(actionsPath, JSON.stringify(actionsOutput, null, 2));
      console.log(`💾 Strategy actions saved to: ${actionsPath}`);
      
      // Show key timestamps
      console.log(`\n📊 Key Timestamp BB Scores:`);
      const keyTimestamps = ['09:30', '09:35', '09:40', '09:45', '10:00', '11:00', '14:00', '16:00'];
      keyTimestamps.forEach(ts => {
        const result = this.results.find(r => r.timestamp === ts);
        if (result) {
          console.log(`   ${ts}: 1m=${result.analysis['1m'].bbScore?.toFixed(3)}, 5m=${result.analysis['5m'].bbScore?.toFixed(3)}, 15m=${result.analysis['15m'].bbScore?.toFixed(3)}, 60m=${result.analysis['60m'].bbScore?.toFixed(3)}`);
        }
      });

      return {
        totalProfitLoss,
        strategyActions: [...this.strategyActions],
        results: [...this.results],
        actionsPath,
        dataPath: outputPath
      };
      
    } catch (error) {
      console.error('❌ Error:', error.message);
      console.error(error.stack);
      throw error;
    }
  }
}

// Run if called directly
if (require.main === module) {
  const symbol = process.argv[2] || 'NDX';
  const backtestDate = process.argv[3] || '2026-02-27';
  const openMethod = process.argv[4] || 'strategySimple5mBBScoreOpen';
  const coverMethod = process.argv[5] || 'strategySimple5mBBScoreCover';
  
  const backtest = new BacktestController();
  backtest.runBacktest(symbol, backtestDate, openMethod, coverMethod);
}

module.exports = { BacktestController };
