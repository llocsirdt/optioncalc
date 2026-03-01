#!/usr/bin/env node

/**
 * Backtest Controller
 * Validates trading strategies using historical data with correct candle aggregation
 */

const fs = require('fs').promises;
const path = require('path');

// Load environment variables
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

// Import market client
const marketClientPath = path.resolve(__dirname, '../../server/src/persistence/market-client.js');
const { marketClient } = require(marketClientPath);

// Import production indicator calculation functions
const candleAnalyzerPath = path.resolve(__dirname, '../../server/src/persistence/candle-analyzer.js');
const { 
  calculateSMA, 
  calculateEMA, 
  calculateBollingerBands,
  aggregate30mTo60m
} = require(candleAnalyzerPath);

// Import production strategy logic functions
const strategyLogicPath = path.resolve(__dirname, '../../server/src/persistence/strategy-logic.js');
const {
  calculateBBScore,
  checkSimple5mBBScoreOpen,
  checkSimple15mBBScoreOpen,
  checkSimple5mBBScoreCover,
  checkSimple15mBBScoreCover
} = require(strategyLogicPath);

class BacktestController {
  constructor() {
    this.results = [];
    this.openPosition = null; // Track current open position {type: 'bull'|'bear', openedAt: timestamp, bbScore15m: value}
  }

  // NOTE: Strategy functions (checkSimple...Open/Cover) now use production functions
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
    // Sort newest first
    seedData['5m'].sort((a, b) => b.datetime - a.datetime);
    console.log(`   ✅ Received ${seedData['5m'].length} candles`);
    if (seedData['5m'].length > 0) {
      const first = seedData['5m'][0];
      const last = seedData['5m'][seedData['5m'].length - 1];
      console.log(`   📍 Range: ${new Date(last.datetime).toISOString()} to ${new Date(first.datetime).toISOString()}`);
    }
    
    // 2. Fetch 1 day of 15m candles ending on prior day - base for BB calculations
    console.log(`\n🕯️  Fetching 15m candles (1 day ending ${priorDayObj.toISOString().split('T')[0]})...`);
    const data15m = await marketClient.priceHistory(apiSymbol, {
      periodType: 'day',
      period: 1,
      frequencyType: 'minute',
      frequency: 15,
      endDate: priorDayMs
    });
    seedData['15m'] = (data15m.candles || []).filter(c => c.open !== 0 || c.high !== 0 || c.low !== 0 || c.close !== 0);
    // Sort newest first
    seedData['15m'].sort((a, b) => b.datetime - a.datetime);
    console.log(`   ✅ Received ${seedData['15m'].length} candles`);
    if (seedData['15m'].length > 0) {
      const first = seedData['15m'][0];
      const last = seedData['15m'][seedData['15m'].length - 1];
      console.log(`   📍 Range: ${new Date(last.datetime).toISOString()} to ${new Date(first.datetime).toISOString()}`);
    }
    
    // 3. Fetch 3 days of 30m candles ending on prior day (2/26) - for 60m aggregation
    console.log(`\n🕯️  Fetching 30m candles (3 days ending ${priorDayObj.toISOString().split('T')[0]})...`);
    const data30m = await marketClient.priceHistory(apiSymbol, {
      periodType: 'day',
      period: 3,
      frequencyType: 'minute',
      frequency: 30,
      endDate: priorDayMs
    });
    seedData['30m'] = (data30m.candles || []).filter(c => c.open !== 0 || c.high !== 0 || c.low !== 0 || c.close !== 0);
    console.log(`   ✅ Received ${seedData['30m'].length} candles`);
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
    console.log(`   ✅ Received ${seedData['1m'].length} candles`);
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
   * Aggregate multiple 1m candles into a single OHLC candle
   * Candles should be in chronological order (oldest to newest)
   */
  aggregateCandles(candles) {
    if (!candles || candles.length === 0) return null;
    
    // Sort chronologically (oldest first) for proper aggregation
    const sorted = [...candles].sort((a, b) => a.datetime - b.datetime);
    
    return {
      datetime: sorted[sorted.length - 1].datetime, // Use newest timestamp
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
  async runBacktest(symbol, backtestDate) {
    try {
      console.log(`🧪 Starting Correct Algorithm Backtest`);
      console.log(`   Symbol: ${symbol}`);
      console.log(`   Backtest Date: ${backtestDate}`);
      
      const seedData = await this.fetchSeedData(symbol, backtestDate);
      
      console.log(`\n📊 Seed Data Summary:`);
      console.log(`   5m candles: ${seedData['5m'].length}`);
      console.log(`   15m candles: ${seedData['15m'].length}`);
      console.log(`   30m candles: ${seedData['30m'].length}`);
      console.log(`   1m candles: ${seedData['1m'].length}`);
      
      // Aggregate 30m to 60m
      console.log(`\n🔄 Aggregating 30m candles to 60m...`);
      const aggregated60m = aggregate30mTo60m(seedData['30m']);
      console.log(`   ✅ Created ${aggregated60m.length} 60m candles`);
      
      // Display 60m candles to verify
      console.log(`\n📊 60m Candles (newest first):`);
      for (let i = 0; i < Math.min(10, aggregated60m.length); i++) {
        const c = aggregated60m[i];
        const time = new Date(c.datetime);
        const timeStr = time.toLocaleTimeString('en-US', { 
          hour: '2-digit', 
          minute: '2-digit', 
          hour12: false,
          timeZone: 'America/New_York'
        });
        const dateStr = time.toLocaleDateString('en-US', { timeZone: 'America/New_York' });
        console.log(`   [${i}] ${dateStr} ${timeStr}: O=${c.open.toFixed(2)} H=${c.high.toFixed(2)} L=${c.low.toFixed(2)} C=${c.close.toFixed(2)}`);
      }
      
      // Check for 9:00 AM candle specifically
      const candle9am = aggregated60m.find(c => {
        const time = new Date(c.datetime);
        return time.getHours() === 9 && time.getMinutes() === 0;
      });
      if (candle9am) {
        console.log(`\n✅ Special 9:00 AM candle found (from single 9:30 AM 30m candle)`);
        console.log(`   Datetime: ${new Date(candle9am.datetime).toISOString()}`);
        console.log(`   Close: ${candle9am.close.toFixed(2)}`);
      }
      
      seedData['60m'] = aggregated60m;
      
      console.log(`\n✅ Seed data fetched, verified, and 60m candles aggregated!`);
      
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
          const candles1mForEMA = candles1m.slice(currentIndex, currentIndex + 10);
          
          let bb1m = null, sma1m = null, bbScore1m = null, ema1m = null;
          
          if (candles1mForBB.length >= 21) {
            bb1m = calculateBollingerBands(candles1mForBB, 20, 2);
            sma1m = calculateSMA(candles1mForBB, 20);
            bbScore1m = calculateBBScore(currentCandle.close, bb1m.upper[0], bb1m.middle[0], bb1m.lower[0]);
          }
          
          if (candles1mForEMA.length >= 10) {
            ema1m = calculateEMA(candles1mForEMA, 10);
          }
          
          // === 5-MINUTE ANALYSIS ===
          // Aggregate 1m candles from backtest day into 5m candle
          // Boundary: 9:30-9:34, 9:35-9:39, 9:40-9:44, etc.
          let candle5m, candles5mForBB, candles5mForEMA;
          
          const currentTotalMin = hour * 60 + minute;
          const boundary5m = Math.floor(currentTotalMin / 5) * 5;
          const is5mBoundary = minute % 5 === 0 && minute > 30;
          
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
          candles5mForEMA = [candle5m, ...workingCandles['5m'], ...candles5m].slice(0, 10);
          
          let bb5m = null, sma5m = null, bbScore5m = null, ema5m = null;
          
          if (candles5mForBB.length >= 21) {
            bb5m = calculateBollingerBands(candles5mForBB, 20, 2);
            sma5m = calculateSMA(candles5mForBB, 20);
            bbScore5m = calculateBBScore(candle5m.close, bb5m.upper[0], bb5m.middle[0], bb5m.lower[0]);
          }
          
          if (candles5mForEMA.length >= 10) {
            ema5m = calculateEMA(candles5mForEMA, 10);
          }
          
          // === 15-MINUTE ANALYSIS ===
          // Aggregate 1m candles from backtest day into 15m candle
          // Boundary: 9:30-9:44, 9:45-9:59, 10:00-10:14, etc.
          let candle15m, candles15mForBB, candles15mForEMA;
          
          // Calculate 15m boundary (aligned to market open at 9:30)
          const boundary15m = Math.floor((currentTotalMin - 570) / 15) * 15 + 570; // 570 = 9:30
          const is15mBoundary = (minute === 45 || (minute === 0 && hour > 9)) && minute > 30;
          
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
          candles15mForEMA = [candle15m, ...workingCandles['15m'], ...candles15m].slice(0, 10);
          
          let bb15m = null, sma15m = null, bbScore15m = null, ema15m = null;
          
          if (candles15mForBB.length >= 21) {
            bb15m = calculateBollingerBands(candles15mForBB, 20, 2);
            sma15m = calculateSMA(candles15mForBB, 20);
            bbScore15m = calculateBBScore(candle15m.close, bb15m.upper[0], bb15m.middle[0], bb15m.lower[0]);
          }
          
          if (candles15mForEMA.length >= 10) {
            ema15m = calculateEMA(candles15mForEMA, 10);
          }
          
          // === 60-MINUTE ANALYSIS ===
          // Aggregate 1m candles from backtest day into 60m candle
          // Boundary: First candle 9:30-9:59 (30 min), then hourly 10:00-10:59, 11:00-11:59, etc.
          let candle60m, candles60mForBB, candles60mForEMA;
          
          // Calculate 60m boundary
          // First candle: 9:30-9:59 (boundary = 570)
          // After 10:00: align to clock hours (600, 660, 720, etc.)
          let boundary60m;
          if (currentTotalMin < 600) {
            // Before 10:00 - use 9:30 boundary
            boundary60m = 570;
          } else {
            // 10:00 and after - align to clock hours
            boundary60m = Math.floor(currentTotalMin / 60) * 60;
          }
          
          // Boundary detection: at 10:00, 11:00, 12:00, etc.
          const is60mBoundary = currentTotalMin >= 600 && minute === 0;
          
          // At 60m boundary, save previous period's complete candle to working array
          if (is60mBoundary) {
            let prevBoundary;
            if (currentTotalMin === 600) {
              // At 10:00, save the first candle (9:30-9:59)
              prevBoundary = 570;
            } else {
              // At 11:00, 12:00, etc., save the previous hour
              prevBoundary = boundary60m - 60;
            }
            
            const prevCandles = backtestDay1mCandles.filter(c => {
              const d = new Date(c.datetime);
              const estDate = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
              const totalMin = estDate.getHours() * 60 + estDate.getMinutes();
              return totalMin >= prevBoundary && totalMin < boundary60m;
            });
            if (prevCandles.length > 0) {
              const completeCandle = this.aggregateCandles(prevCandles);
              workingCandles['60m'].unshift(completeCandle);
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
          
          // For BB/EMA: [current partial] + [working complete candles] + [seed data]
          candles60mForBB = [candle60m, ...workingCandles['60m'], ...seedData['60m']].slice(0, 21);
          candles60mForEMA = [candle60m, ...workingCandles['60m'], ...seedData['60m']].slice(0, 10);
          
          let bb60m = null, sma60m = null, bbScore60m = null, ema60m = null;
          
          if (candles60mForBB.length >= 21) {
            bb60m = calculateBollingerBands(candles60mForBB, 20, 2);
            sma60m = calculateSMA(candles60mForBB, 20);
            bbScore60m = calculateBBScore(candle60m.close, bb60m.upper[0], bb60m.middle[0], bb60m.lower[0]);
          }
          
          if (candles60mForEMA.length >= 10) {
            ema60m = calculateEMA(candles60mForEMA, 10);
          }
          
          // === STRATEGY EXECUTION ===
          let strategyMethod = null;
          let opened = false;
          let covered = false;
          
          // Build analysis object for strategy methods
          const analysisForStrategy = {
            '1m': { bbScore: bbScore1m },
            '5m': { bbScore: bbScore5m },
            '15m': { bbScore: bbScore15m },
            '60m': { bbScore: bbScore60m }
          };
          
          if (!this.openPosition) {
            // No open position - check if we should open one
            strategyMethod = 'checkSimple5mBBScoreOpen';
            const openResult = checkSimple5mBBScoreOpen(analysisForStrategy);
            
            if (openResult.action === 'open_bull') {
              this.openPosition = {
                type: 'bull',
                openedAt: timestamp,
                bbScore5m: openResult.bbScore5m
              };
              opened = true;
            } else if (openResult.action === 'open_bear') {
              this.openPosition = {
                type: 'bear',
                openedAt: timestamp,
                bbScore5m: openResult.bbScore5m
              };
              opened = true;
            }
          } else {
            // Have open position - check if we should cover it
            strategyMethod = 'checkSimple5mBBScoreCover';
            const coverResult = checkSimple5mBBScoreCover(this.openPosition, analysisForStrategy);
            
            if (coverResult.action === 'cover') {
              this.openPosition = null;
              covered = true;
            }
          }
          
          // Create result
          const result = {
            timestamp,
            datetime: currentCandle.datetime,
            strategyMethod,
            opened,
            covered,
            hasOpenPosition: this.openPosition !== null,
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
                ema: ema1m ? ema1m[0] : null,
                bbScore: bbScore1m
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
                ema: ema5m ? ema5m[0] : null,
                bbScore: bbScore5m
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
                ema: ema15m ? ema15m[0] : null,
                bbScore: bbScore15m
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
                ema: ema60m ? ema60m[0] : null,
                bbScore: bbScore60m
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
      
      // Save results to file
      const outputPath = path.join(__dirname, `backtest-controller-${symbol}-${backtestDate}.json`);
      await fs.writeFile(outputPath, JSON.stringify(this.results, null, 2));
      console.log(`\n💾 Results saved to: ${outputPath}`);
      
      // Show key timestamps
      console.log(`\n📊 Key Timestamp BB Scores:`);
      const keyTimestamps = ['09:30', '09:35', '09:40', '09:45', '10:00', '11:00', '14:00', '16:00'];
      keyTimestamps.forEach(ts => {
        const result = this.results.find(r => r.timestamp === ts);
        if (result) {
          console.log(`   ${ts}: 1m=${result.analysis['1m'].bbScore?.toFixed(3)}, 5m=${result.analysis['5m'].bbScore?.toFixed(3)}, 15m=${result.analysis['15m'].bbScore?.toFixed(3)}, 60m=${result.analysis['60m'].bbScore?.toFixed(3)}`);
        }
      });
      
    } catch (error) {
      console.error('❌ Error:', error.message);
      console.error(error.stack);
    }
  }
}

// Run if called directly
if (require.main === module) {
  const symbol = process.argv[2] || 'NDX';
  const backtestDate = process.argv[3] || '2026-02-27';
  
  const backtest = new BacktestController();
  backtest.runBacktest(symbol, backtestDate);
}

module.exports = { BacktestController };
