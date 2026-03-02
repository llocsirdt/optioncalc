#!/usr/bin/env node

/**
 * Validate that indicator values (SMA, EMA, Bollinger Bands) match between:
 * 1. Backtest output
 * 2. Production candle analysis
 * 
 * Only compares at complete candle boundaries where both sources have values:
 * - 5m: Every 5 minutes (9:30, 9:35, 9:40, etc.)
 * - 15m: Every 15 minutes (9:30, 9:45, 10:00, 10:15, etc.)
 * - 60m/1h: Hourly (9:30, 10:00, 11:00, etc.)
 */

const path = require('path');

// Load environment variables from project root (same as validateCandleDataConsistency.js)
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

// Import analyzeCandles directly like validateCandleDataConsistency does
const candleAnalyzerPath = path.resolve(__dirname, '../../server/src/persistence/candle-analyzer.js');
const { analyzeCandles } = require(candleAnalyzerPath);

// Test configuration - accept from command line or use defaults
const SYMBOL = process.argv[2] || 'NDX';
const BACKTEST_DATE = process.argv[3] || '2026-02-27';
const BACKTEST_FILE = path.join(__dirname, `backtest-${SYMBOL}-${BACKTEST_DATE}.json`);

/**
 * Load backtest results
 */
function loadBacktestResults() {
  try {
    const backtestData = require(BACKTEST_FILE);
    console.log(`📊 Loaded ${backtestData.length} backtest results from ${path.basename(BACKTEST_FILE)}`);
    return backtestData;
  } catch (error) {
    console.error(`❌ Error loading backtest file: ${error.message}`);
    process.exit(1);
  }
}

/**
 * Get production candle analysis by calling analyzeCandles() directly
 * (Same approach as validateCandleDataConsistency.js)
 */
async function getProductionAnalysis(symbol) {
  console.log(`🏭 Calling analyzeCandles() for ${symbol}...`);
  
  const result = await analyzeCandles(symbol);
  
  if (!result || !result.candleData) {
    throw new Error(`Production analysis failed: No candle data returned`);
  }
  
  console.log(`✅ Production analysis complete`);
  return result;
}

/**
 * Find matching candle in production data by datetime
 */
function findProductionCandle(productionData, timeframe, backtestDatetime) {
  const candles = productionData.candleData[timeframe]?.candles;
  if (!candles || candles.length === 0) return null;
  
  // Find by matching datetime value
  const match = candles.find(c => c.datetime === backtestDatetime);
  
  return match;
}

/**
 * Compare indicator values with tolerance for floating point differences
 */
function compareValues(backtestVal, productionVal, tolerance = 0.0001) {
  if (backtestVal === null && productionVal === null) return true;
  if (backtestVal === null || productionVal === null) return false;
  
  const diff = Math.abs(backtestVal - productionVal);
  return diff < tolerance;
}

/**
 * Validate indicators for a specific timeframe
 */
function validateTimeframe(backtestData, productionData, backtestTimeframe, productionTimeframe, boundaryMinutes) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`📊 Validating ${backtestTimeframe} indicators at ${boundaryMinutes}-minute boundaries`);
  console.log(`${'='.repeat(80)}`);
  
  let totalTests = 0;
  let passedTests = 0;
  const mismatches = [];
  
  // Get production candles for this timeframe
  const productionCandles = productionData.candleData[productionTimeframe]?.candles || [];
  if (productionCandles.length === 0) {
    console.log(`\n⚠️  No production candles found for ${productionTimeframe}`);
    return { totalTests: 0, passedTests: 0, mismatches: [] };
  }
  
  // Backtest stores complete candles at the END of the period (e.g., 09:34 for 09:30-09:34)
  // Production stores complete candles at the START of the period (e.g., 09:30 for 09:30-09:34)
  // We need to match backtest's "end of period" entries with production's "start of period" entries
  
  // For each production candle, find the corresponding backtest entry
  // Production datetime + boundary minutes = backtest datetime
  const boundaryMs = boundaryMinutes * 60 * 1000;
  
  // Filter backtest entries to only complete candle boundaries
  // For 5m: timestamps ending in :34, :39, :44, :49, :54, :59, :04, :09, etc.
  // For 15m: timestamps ending in :44, :59, :14, :29
  // For 60m: timestamps at :59 (first candle 09:59), then :00 (10:00, 11:00, etc.)
  const completeBoundaries = backtestData.filter(entry => {
    if (!entry.analysis[backtestTimeframe]) return false;
    
    // Parse timestamp to get minute
    const [hour, minute] = entry.timestamp.split(':').map(Number);
    const totalMin = hour * 60 + minute;
    
    if (backtestTimeframe === '5m') {
      // Complete 5m boundaries: :34, :39, :44, :49, :54, :59, :04, :09, etc.
      // These are 4 minutes after the start: 30+4=34, 35+4=39, etc.
      return (totalMin - 574) % 5 === 0; // 574 = 9:34 (first complete 5m boundary)
    } else if (backtestTimeframe === '15m') {
      // Complete 15m boundaries: :44, :59, :14, :29
      // These are 14 minutes after the start: 30+14=44, 45+14=59, 00+14=14, 15+14=29
      return (totalMin - 584) % 15 === 0; // 584 = 9:44 (first complete 15m boundary)
    } else if (backtestTimeframe === '1h' || backtestTimeframe === '60m') {
      // Complete 60m boundaries: 09:59, 10:59, 11:59, 12:59, 13:59, 14:59, 15:59
      // All periods complete at :59
      return minute === 59 && hour >= 9;
    }
    return false;
  });
  
  console.log(`\n🔍 Found ${completeBoundaries.length} complete ${backtestTimeframe} candle boundaries in backtest data`);
  
  for (const backtestEntry of completeBoundaries) {
    const backtestAnalysis = backtestEntry.analysis[backtestTimeframe];
    if (!backtestAnalysis) continue;
    
    // Find matching production candle
    // Backtest entry is at end of period, production is at start
    // So backtest 09:34 matches production 09:30 (both represent 09:30-09:34 period)
    let productionDatetime;
    if (backtestTimeframe === '60m') {
      // All 60m boundaries are at :59
      // Both backtest and production use clock-hour timestamps (09:00, 10:00, 11:00, etc.)
      // even though first candle only has data from 09:30-09:59
      // Backtest 09:59 → Production 09:00 (59 min earlier)
      // Backtest 10:59 → Production 10:00 (59 min earlier)
      // Backtest 11:59 → Production 11:00 (59 min earlier)
      productionDatetime = backtestEntry.datetime - (59 * 60 * 1000);
    } else {
      // 5m and 15m: backtest end-of-period → production start-of-period
      const boundaryMs = boundaryMinutes * 60 * 1000;
      productionDatetime = backtestEntry.datetime - (boundaryMs - 60000);
    }
    const productionCandle = findProductionCandle(productionData, productionTimeframe, productionDatetime);
    if (!productionCandle) {
      console.log(`⚠️  No production candle found for ${backtestEntry.timestamp} (backtest datetime: ${backtestEntry.datetime}, production datetime: ${productionDatetime})`);
      continue;
    }
    
    totalTests++;
    
    // Production stores indicators under indicators object with different field names
    const prodIndicators = productionCandle.indicators || {};
    const prodBB = prodIndicators.bollinger20_2 || {};
    
    // Compare SMA (production uses sma20)
    const smaMatch = compareValues(backtestAnalysis.sma, prodIndicators.sma20);
    
    // Compare EMA (production uses ema9, backtest uses ema10 - these won't match exactly)
    const emaMatch = compareValues(backtestAnalysis.ema, prodIndicators.ema9);
    
    // Compare Bollinger Bands (backtest stores as bbupper/bbmiddle/bblower)
    const bbUpperMatch = compareValues(backtestAnalysis.bbupper, prodBB.upper);
    const bbMiddleMatch = compareValues(backtestAnalysis.bbmiddle, prodBB.middle);
    const bbLowerMatch = compareValues(backtestAnalysis.bblower, prodBB.lower);
    const bbScoreMatch = compareValues(backtestAnalysis.bbScore, productionCandle.bbScore, 0.001);
    
    // Compare trendScore
    const trendScoreMatch = compareValues(backtestAnalysis.trendScore, productionCandle.trendScore);
    
    const allMatch = smaMatch && emaMatch && bbUpperMatch && bbMiddleMatch && bbLowerMatch && bbScoreMatch && trendScoreMatch;
    
    if (allMatch) {
      passedTests++;
    } else {
      mismatches.push({
        timestamp: backtestEntry.timestamp,
        backtest: backtestAnalysis,
        production: {
          open: productionCandle.open,
          high: productionCandle.high,
          low: productionCandle.low,
          close: productionCandle.close,
          sma: prodIndicators.sma20,
          ema: prodIndicators.ema9,
          bb: prodBB,
          bbScore: productionCandle.bbScore,
          trendScore: productionCandle.trendScore
        },
        mismatches: {
          sma: !smaMatch,
          ema: !emaMatch,
          bbUpper: !bbUpperMatch,
          bbMiddle: !bbMiddleMatch,
          bbLower: !bbLowerMatch,
          bbScore: !bbScoreMatch,
          trendScore: !trendScoreMatch
        }
      });
    }
  }
  
  // Report results
  console.log(`\n📈 Results for ${backtestTimeframe}:`);
  console.log(`   Total tests: ${totalTests}`);
  console.log(`   Passed: ${passedTests}`);
  console.log(`   Failed: ${totalTests - passedTests}`);
  
  if (mismatches.length > 0) {
    console.log(`\n❌ Mismatches found:`);
    for (const mismatch of mismatches.slice(0, 5)) { // Show first 5
      console.log(`\n   Timestamp: ${mismatch.timestamp}`);
      console.log(`   Mismatched fields: ${Object.keys(mismatch.mismatches).filter(k => mismatch.mismatches[k]).join(', ')}`);
      
      // Show OHLC values first to verify candle data matches
      console.log(`   OHLC: backtest=[${mismatch.backtest.open?.toFixed(2)}, ${mismatch.backtest.high?.toFixed(2)}, ${mismatch.backtest.low?.toFixed(2)}, ${mismatch.backtest.close?.toFixed(2)}]`);
      console.log(`         production=[${mismatch.production.open?.toFixed(2)}, ${mismatch.production.high?.toFixed(2)}, ${mismatch.production.low?.toFixed(2)}, ${mismatch.production.close?.toFixed(2)}]`);
      
      if (mismatch.mismatches.sma) {
        console.log(`   SMA: backtest=${mismatch.backtest.sma?.toFixed(4)}, production=${mismatch.production.sma?.toFixed(4)}`);
      }
      if (mismatch.mismatches.ema) {
        console.log(`   EMA: backtest=${mismatch.backtest.ema?.toFixed(4)}, production=${mismatch.production.ema?.toFixed(4)}`);
      }
      if (mismatch.mismatches.bbScore) {
        console.log(`   BB Score: backtest=${mismatch.backtest.bbScore?.toFixed(4)}, production=${mismatch.production.bbScore?.toFixed(4)}`);
      }
    }
    if (mismatches.length > 5) {
      console.log(`\n   ... and ${mismatches.length - 5} more mismatches`);
    }
  } else {
    console.log(`   ✅ All indicators match!`);
  }
  
  return { totalTests, passedTests, mismatches };
}

/**
 * Main validation
 */
async function validateIndicators() {
  console.log(`\n🧪 Validating Indicator Values Between Backtest and Production`);
  console.log(`   Date: ${BACKTEST_DATE}`);
  console.log(`   Symbol: ${SYMBOL}\n`);
  
  // Load backtest data
  const backtestData = loadBacktestResults();
  
  // Get production analysis
  const productionData = await getProductionAnalysis(SYMBOL);
  
  // Validate each timeframe at appropriate boundaries
  const results = {
    '5m': validateTimeframe(backtestData, productionData, '5m', '5m', 5),
    '15m': validateTimeframe(backtestData, productionData, '15m', '15m', 15),
    '60m': validateTimeframe(backtestData, productionData, '60m', '1h', 60) // Backtest uses '60m', production uses '1h'
  };
  
  // Overall summary
  console.log(`\n${'='.repeat(80)}`);
  console.log(`📊 Overall Summary`);
  console.log(`${'='.repeat(80)}`);
  
  let totalTests = 0;
  let totalPassed = 0;
  
  for (const [timeframe, result] of Object.entries(results)) {
    totalTests += result.totalTests;
    totalPassed += result.passedTests;
    const percentage = result.totalTests > 0 ? ((result.passedTests / result.totalTests) * 100).toFixed(1) : 0;
    console.log(`   ${timeframe}: ${result.passedTests}/${result.totalTests} passed (${percentage}%)`);
  }
  
  const overallPercentage = totalTests > 0 ? ((totalPassed / totalTests) * 100).toFixed(1) : 0;
  console.log(`\n   Overall: ${totalPassed}/${totalTests} passed (${overallPercentage}%)`);
  
  if (totalPassed === totalTests) {
    console.log(`\n✅ All indicator values match between backtest and production!`);
  } else {
    console.log(`\n⚠️  Some indicator values do not match - review mismatches above`);
  }
  
  console.log(`\n${'='.repeat(80)}\n`);
}

// Run validation
validateIndicators().catch(error => {
  console.error(`\n❌ Validation failed: ${error.message}`);
  console.error(error.stack);
  process.exit(1);
});
