#!/usr/bin/env node

/**
 * Validate OHLC Candle Data Consistency
 * Compares candle data from three sources:
 * 1. Backtest candle processing
 * 2. Raw Schwab API price history
 * 3. Production candle analysis
 */

const fs = require('fs').promises;
const path = require('path');

// Load environment variables
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

// Import market client and candle analyzer
const marketClientPath = path.resolve(__dirname, '../../server/src/persistence/market-client.js');
const { marketClient } = require(marketClientPath);

const candleAnalyzerPath = path.resolve(__dirname, '../../server/src/persistence/candle-analyzer.js');
const { analyzeCandles } = require(candleAnalyzerPath);

class CandleDataValidator {
  constructor() {
    // No need to instantiate - analyzeCandles is a function
  }

  /**
   * Format timestamp for display
   */
  formatTime(datetime) {
    const date = new Date(datetime);
    return date.toLocaleString('en-US', { 
      timeZone: 'America/New_York',
      month: '2-digit',
      day: '2-digit',
      year: 'numeric',
      hour: '2-digit', 
      minute: '2-digit',
      second: '2-digit',
      hour12: false 
    });
  }

  /**
   * Get candle from backtest data
   */
  async getBacktestCandle(timestamp, timeframe) {
    const backtestFile = path.join(__dirname, 'backtest-controller-NDX-2026-02-27.json');
    const backtestData = JSON.parse(await fs.readFile(backtestFile, 'utf8'));
    
    const entry = backtestData.find(e => e.timestamp === timestamp);
    if (!entry) {
      return null;
    }
    
    const candle = entry.analysis[timeframe];
    // Add datetime from the entry for comparison
    if (candle) {
      candle.datetime = entry.datetime;
    }
    return candle;
  }

  /**
   * Get candle from Schwab API using specific date range
   */
  async getSchwabCandle(symbol, datetime, timeframe) {
    const targetDate = new Date(datetime);
    const targetDateStr = targetDate.toLocaleDateString('en-US', { timeZone: 'America/New_York' });
    
    console.log(`  📡 Fetching ${timeframe} candles from Schwab API for ${targetDateStr}...`);
    
    // Calculate date range: we need data from the prior day to build historical context
    // For Feb 27, we need Feb 26 data as well
    const estDate = new Date(targetDate.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const startDate = new Date(estDate);
    startDate.setDate(startDate.getDate() - 1); // Get prior day for context
    startDate.setHours(0, 0, 0, 0);
    
    const endDate = new Date(estDate);
    endDate.setHours(23, 59, 59, 999);
    
    console.log(`    Date range: ${startDate.toISOString()} to ${endDate.toISOString()}`);
    
    // Map timeframe to frequency parameters
    const frequencyMap = {
      '1m': { frequencyType: 'minute', frequency: 1 },
      '5m': { frequencyType: 'minute', frequency: 5 },
      '15m': { frequencyType: 'minute', frequency: 15 },
      '60m': { frequencyType: 'minute', frequency: 30 } // We'll aggregate 30m to 60m
    };
    
    const freq = frequencyMap[timeframe];
    if (!freq) {
      throw new Error(`Unknown timeframe: ${timeframe}`);
    }
    
    // Add $ prefix for index symbols
    const indexSymbols = ['NDX', 'SPX', 'RUT', 'DJX', 'OEX', 'VIX'];
    const apiSymbol = indexSymbols.includes(symbol) ? `$${symbol}` : symbol;
    
    const options = {
      frequencyType: freq.frequencyType,
      frequency: freq.frequency,
      startDate: startDate.getTime(),
      endDate: endDate.getTime()
    };
    
    console.log(`    API call: marketClient.priceHistory("${apiSymbol}", ${JSON.stringify(options)})`);
    
    const response = await marketClient.priceHistory(apiSymbol, options);
    
    if (!response || !response.candles) {
      return null;
    }
    
    // For 60m, we need to aggregate 30m candles
    let candles = response.candles;
    if (timeframe === '60m') {
      candles = this.aggregate30mTo60m(candles);
    }
    
    // Find the candle matching the datetime
    const targetTime = new Date(datetime).getTime();
    
    // Debug: Show what we're looking for and what's available
    console.log(`    Looking for datetime: ${this.formatTime(targetTime)} (${targetTime})`);
    console.log(`    Available candles: ${candles.length}`);
    if (candles.length > 0) {
      console.log(`    First candle: ${this.formatTime(candles[0].datetime)} (${candles[0].datetime})`);
      console.log(`    Last candle: ${this.formatTime(candles[candles.length - 1].datetime)} (${candles[candles.length - 1].datetime})`);
    }
    
    // Try exact match first
    let candle = candles.find(c => c.datetime === targetTime);
    
    // If no exact match, try finding by time string (accounting for timestamp format differences)
    if (!candle) {
      const targetTimeStr = this.formatTime(targetTime);
      candle = candles.find(c => {
        const candleTimeStr = this.formatTime(c.datetime);
        return candleTimeStr === targetTimeStr;
      });
      
      if (candle) {
        console.log(`    ✅ Found by time string match`);
      } else {
        console.log(`    ❌ No match found for ${targetTimeStr}`);
      }
    } else {
      console.log(`    ✅ Found by exact datetime match`);
    }
    
    return candle;
  }

  /**
   * Aggregate 30m to 60m (from production)
   */
  aggregate30mTo60m(candles30m) {
    const candles60m = [];
    const grouped = new Map();
    
    for (const candle of candles30m) {
      const date = new Date(candle.datetime);
      const estDate = new Date(date.toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const hour = estDate.getHours();
      
      let groupKey;
      if (hour === 9 && estDate.getMinutes() === 0) {
        groupKey = `${estDate.toDateString()}_9:00`;
      } else {
        const hourKey = hour < 10 ? hour + 9 : hour;
        groupKey = `${estDate.toDateString()}_${hourKey}:00`;
      }
      
      if (!grouped.has(groupKey)) {
        grouped.set(groupKey, []);
      }
      grouped.get(groupKey).push(candle);
    }
    
    for (const [key, group] of grouped.entries()) {
      if (group.length === 0) continue;
      
      const sorted = [...group].sort((a, b) => a.datetime - b.datetime);
      candles60m.push({
        datetime: sorted[0].datetime,
        open: sorted[0].open,
        high: Math.max(...sorted.map(c => c.high)),
        low: Math.min(...sorted.map(c => c.low)),
        close: sorted[sorted.length - 1].close,
        volume: sorted.reduce((sum, c) => sum + c.volume, 0)
      });
    }
    
    return candles60m;
  }

  /**
   * Get candle from production candle analysis
   * Note: Production uses '1h' timeframe while backtest uses '60m'
   * Production uses clock-hour boundaries (9:00-9:59, 10:00-10:59)
   * Backtest uses market-aligned boundaries (9:30-9:59, 10:00-10:59)
   */
  async getProductionCandle(symbol, datetime, timeframe) {
    console.log(`  🏭 Fetching candle analysis from production...`);
    
    const analysis = await analyzeCandles(symbol);
    
    if (!analysis || !analysis.candleData) {
      return null;
    }
    
    // Map 60m to 1h for production
    const productionTimeframe = timeframe === '60m' ? '1h' : timeframe;
    
    if (!analysis.candleData[productionTimeframe]) {
      return null;
    }
    
    const candles = analysis.candleData[productionTimeframe].candles;
    const targetTime = new Date(datetime).getTime();
    
    // For 60m/1h, production uses clock hours (9:00, 10:00, 11:00)
    // Backtest uses market-aligned (9:30, 10:00, 11:00)
    // Production's "9:00 AM" candle (9:00-9:59) = Backtest's 9:30-9:59 candle
    let searchTime = targetTime;
    if (timeframe === '60m') {
      const d = new Date(targetTime);
      const estDate = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const hour = estDate.getHours();
      const minute = estDate.getMinutes();
      
      // If looking for backtest's 9:30 candle, search for production's 9:00 candle
      if (hour === 9 && minute === 30) {
        const prodDate = new Date(estDate);
        prodDate.setHours(9, 0, 0, 0);
        searchTime = prodDate.getTime();
      }
      // For other hours (10:00, 11:00, etc.), they align
    }
    
    // Try exact match
    let candle = candles.find(c => c.datetime === searchTime);
    
    // Try by formatted time
    if (!candle) {
      const targetTimeStr = this.formatTime(searchTime);
      candle = candles.find(c => {
        const candleTimeStr = this.formatTime(c.datetime);
        return candleTimeStr === targetTimeStr;
      });
    }
    
    return candle;
  }

  /**
   * Compare OHLC values
   */
  compareOHLC(source1, source2, name1, name2) {
    if (!source1 || !source2) {
      return { match: false, reason: 'Missing data' };
    }
    
    const fields = ['open', 'high', 'low', 'close'];
    const diffs = {};
    let allMatch = true;
    
    for (const field of fields) {
      const val1 = source1[field];
      const val2 = source2[field];
      const diff = Math.abs(val1 - val2);
      diffs[field] = {
        [name1]: val1,
        [name2]: val2,
        diff: diff,
        match: diff < 0.01
      };
      if (diff >= 0.01) {
        allMatch = false;
      }
    }
    
    return { match: allMatch, diffs };
  }

  /**
   * Validate a specific candle
   */
  async validateCandle(symbol, timestamp, timeframe, schwabTime = null) {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`🔍 Validating ${timeframe} candle at ${timestamp}`);
    if (schwabTime) {
      console.log(`   (Comparing backtest at ${timestamp} vs Schwab's ${schwabTime} candle)`);
    }
    console.log(`${'='.repeat(80)}`);
    
    // Get candle from backtest first to get the datetime
    const backtest = await this.getBacktestCandle(timestamp, timeframe);
    
    if (!backtest || !backtest.datetime) {
      console.log('\n❌ No backtest data found for this timestamp');
      return;
    }
    
    // For Schwab, use schwabTime if provided (for comparing complete candles)
    // Otherwise use the backtest datetime
    let schwabDatetime = backtest.datetime;
    if (schwabTime) {
      // Parse schwabTime (HH:MM format) and construct datetime for Feb 27, 2026
      const [hours, minutes] = schwabTime.split(':').map(Number);
      const schwabDate = new Date('2026-02-27T00:00:00-05:00');
      schwabDate.setHours(hours, minutes, 0, 0);
      schwabDatetime = schwabDate.getTime();
    }
    
    const schwab = await this.getSchwabCandle(symbol, schwabDatetime, timeframe);
    // Production uses Schwab timestamps, not backtest timestamps
    const production = await this.getProductionCandle(symbol, schwabDatetime, timeframe);
    
    console.log('\n📊 Data Retrieved:');
    console.log(`  Backtest:   ${backtest ? '✅' : '❌'}`);
    console.log(`  Schwab API: ${schwab ? '✅' : '❌'}`);
    console.log(`  Production: ${production ? '✅' : '❌'}`);
    
    if (!backtest && !schwab && !production) {
      console.log('\n❌ No data found from any source');
      return;
    }
    
    // Compare backtest vs Schwab
    if (backtest && schwab) {
      console.log('\n📈 Backtest vs Schwab API:');
      const comparison = this.compareOHLC(backtest, schwab, 'Backtest', 'Schwab');
      
      if (comparison.match) {
        console.log('  ✅ MATCH - All OHLC values match');
      } else {
        console.log('  ❌ MISMATCH - Differences found:');
        for (const [field, data] of Object.entries(comparison.diffs)) {
          if (!data.match) {
            console.log(`    ${field.toUpperCase()}: Backtest=${data.Backtest.toFixed(4)}, Schwab=${data.Schwab.toFixed(4)}, Diff=${data.diff.toFixed(4)}`);
          }
        }
      }
    }
    
    // Compare backtest vs Production
    if (backtest && production) {
      console.log('\n📈 Backtest vs Production:');
      const comparison = this.compareOHLC(backtest, production, 'Backtest', 'Production');
      
      if (comparison.match) {
        console.log('  ✅ MATCH - All OHLC values match');
      } else {
        console.log('  ❌ MISMATCH - Differences found:');
        for (const [field, data] of Object.entries(comparison.diffs)) {
          if (!data.match) {
            console.log(`    ${field.toUpperCase()}: Backtest=${data.Backtest.toFixed(4)}, Production=${data.Production.toFixed(4)}, Diff=${data.diff.toFixed(4)}`);
          }
        }
      }
    }
    
    // Compare Schwab vs Production
    if (schwab && production) {
      console.log('\n📈 Schwab API vs Production:');
      const comparison = this.compareOHLC(schwab, production, 'Schwab', 'Production');
      
      if (comparison.match) {
        console.log('  ✅ MATCH - All OHLC values match');
      } else {
        console.log('  ❌ MISMATCH - Differences found:');
        for (const [field, data] of Object.entries(comparison.diffs)) {
          if (!data.match) {
            console.log(`    ${field.toUpperCase()}: Schwab=${data.Schwab.toFixed(4)}, Production=${data.Production.toFixed(4)}, Diff=${data.diff.toFixed(4)}`);
          }
        }
      }
    }
    
    // Show full candle data for debugging
    console.log('\n📋 Full Candle Data:');
    if (backtest) {
      console.log('\n  Backtest:');
      console.log(`    Datetime (raw): ${backtest.datetime}`);
      console.log(`    Datetime (formatted): ${this.formatTime(backtest.datetime)}`);
      console.log(`    Open:   ${backtest.open?.toFixed(4) || 'N/A'}`);
      console.log(`    High:   ${backtest.high?.toFixed(4) || 'N/A'}`);
      console.log(`    Low:    ${backtest.low?.toFixed(4) || 'N/A'}`);
      console.log(`    Close:  ${backtest.close?.toFixed(4) || 'N/A'}`);
      console.log(`    Volume: ${backtest.volume || 'N/A'}`);
    }
    
    if (schwab) {
      console.log('\n  Schwab API:');
      console.log(`    Datetime (raw): ${schwab.datetime}`);
      console.log(`    Datetime (formatted): ${this.formatTime(schwab.datetime)}`);
      console.log(`    Open:     ${schwab.open?.toFixed(4) || 'N/A'}`);
      console.log(`    High:     ${schwab.high?.toFixed(4) || 'N/A'}`);
      console.log(`    Low:      ${schwab.low?.toFixed(4) || 'N/A'}`);
      console.log(`    Close:    ${schwab.close?.toFixed(4) || 'N/A'}`);
      console.log(`    Volume:   ${schwab.volume || 'N/A'}`);
    }
    
    if (production) {
      console.log('\n  Production:');
      console.log(`    Datetime (raw): ${production.datetime}`);
      console.log(`    Datetime (formatted): ${this.formatTime(production.datetime)}`);
      console.log(`    Open:     ${production.open?.toFixed(4) || 'N/A'}`);
      console.log(`    High:     ${production.high?.toFixed(4) || 'N/A'}`);
      console.log(`    Low:      ${production.low?.toFixed(4) || 'N/A'}`);
      console.log(`    Close:    ${production.close?.toFixed(4) || 'N/A'}`);
      console.log(`    Volume:   ${production.volume || 'N/A'}`);
    }
  }

  /**
   * Run validation for multiple test cases
   */
  async runValidation() {
    console.log('🧪 Starting Candle Data Consistency Validation\n');
    
    const testCases = [
      { symbol: 'NDX', timestamp: '09:34', timeframe: '5m', description: 'First complete 5m candle (09:30-09:34)', schwabTime: '09:30' },
      { symbol: 'NDX', timestamp: '09:44', timeframe: '15m', description: 'First complete 15m candle (09:30-09:44)', schwabTime: '09:30' },
      { symbol: 'NDX', timestamp: '09:59', timeframe: '60m', description: 'First complete 60m candle (09:30-09:59)', schwabTime: '09:30' },
      { symbol: 'NDX', timestamp: '10:59', timeframe: '60m', description: 'Second complete 60m candle (10:00-10:59)', schwabTime: '10:00' },
      { symbol: 'NDX', timestamp: '12:04', timeframe: '5m', description: 'Midday 5m candle (12:00-12:04)', schwabTime: '12:00' },
      { symbol: 'NDX', timestamp: '14:44', timeframe: '15m', description: 'Afternoon 15m candle (14:30-14:44)', schwabTime: '14:30' },
    ];
    
    for (const testCase of testCases) {
      try {
        console.log(`\n📝 Test: ${testCase.description}`);
        await this.validateCandle(testCase.symbol, testCase.timestamp, testCase.timeframe, testCase.schwabTime);
      } catch (error) {
        console.error(`\n❌ Error validating ${testCase.description}:`, error.message);
      }
    }
    
    console.log('\n' + '='.repeat(80));
    console.log('✅ Validation complete');
    console.log('='.repeat(80));
  }
}

// Run validation
const validator = new CandleDataValidator();
validator.runValidation().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
