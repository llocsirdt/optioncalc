/**
 * Candle Data Validation Test
 * This script validates that candle data includes today's data for all timeframes
 */

const { marketClient } = require('../server/src/persistence/market-client');

// Get today's date info
const now = new Date();
const todayStart = new Date(now);
todayStart.setHours(0, 0, 0, 0);
const marketOpen = new Date(now);
marketOpen.setHours(9, 30, 0, 0); // 9:30 AM

console.log('\n=== CANDLE DATA VALIDATION TEST ===');
console.log(`Current time: ${now.toISOString()}`);
console.log(`Today start: ${todayStart.toISOString()}`);
console.log(`Market open: ${marketOpen.toISOString()}`);
console.log(`Time since market open: ${Math.floor((now - marketOpen) / 1000 / 60)} minutes\n`);

async function testCandleData() {
  const symbol = '$NDX';
  const timeframes = [
    { periodType: 'day', period: 1, frequencyType: 'minute', frequency: 1, name: '1m' },
    { periodType: 'day', period: 2, frequencyType: 'minute', frequency: 5, name: '5m' },
    { periodType: 'day', period: 5, frequencyType: 'minute', frequency: 15, name: '15m' },
    { periodType: 'day', period: 5, frequencyType: 'minute', frequency: 30, name: '30m' }
  ];

  for (const tf of timeframes) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Testing ${tf.name} timeframe`);
    console.log(`${'='.repeat(60)}`);
    
    try {
      const options = {
        periodType: tf.periodType,
        period: tf.period,
        frequencyType: tf.frequencyType,
        frequency: tf.frequency,
        endDate: Date.now()
      };
      
      console.log(`API Request:`, options);
      
      const data = await marketClient.priceHistory(symbol, options);
      
      if (!data || !data.candles || data.candles.length === 0) {
        console.log(`❌ NO DATA RECEIVED`);
        continue;
      }
      
      console.log(`\n✅ Received ${data.candles.length} candles`);
      
      // Filter out zero-value candles
      const validCandles = data.candles.filter(c => 
        c.open !== 0 || c.high !== 0 || c.low !== 0 || c.close !== 0
      );
      const zeroCandles = data.candles.length - validCandles.length;
      
      console.log(`Valid candles: ${validCandles.length}`);
      console.log(`Zero-value candles: ${zeroCandles}`);
      
      if (validCandles.length === 0) {
        console.log(`❌ NO VALID CANDLES`);
        continue;
      }
      
      // Sort by datetime ascending to find first and last
      const sorted = [...validCandles].sort((a, b) => a.datetime - b.datetime);
      const firstCandle = sorted[0];
      const lastCandle = sorted[sorted.length - 1];
      
      const firstDate = new Date(firstCandle.datetime);
      const lastDate = new Date(lastCandle.datetime);
      
      console.log(`\nFirst candle: ${firstDate.toISOString()}`);
      console.log(`  OHLC: ${firstCandle.open} / ${firstCandle.high} / ${firstCandle.low} / ${firstCandle.close}`);
      
      console.log(`\nLast candle: ${lastDate.toISOString()}`);
      console.log(`  OHLC: ${lastCandle.open} / ${lastCandle.high} / ${lastCandle.low} / ${lastCandle.close}`);
      
      // Check if we have today's data
      const hasToday = lastDate >= todayStart;
      const hasTodayAfterMarketOpen = lastDate >= marketOpen;
      
      console.log(`\n📊 Today's Data Check:`);
      console.log(`  Has data from today: ${hasToday ? '✅' : '❌'}`);
      console.log(`  Has data after market open: ${hasTodayAfterMarketOpen ? '✅' : '❌'}`);
      
      if (hasTodayAfterMarketOpen) {
        const minutesSinceMarketOpen = Math.floor((now - marketOpen) / 1000 / 60);
        const expectedCandles = Math.floor(minutesSinceMarketOpen / tf.frequency);
        const todayCandles = validCandles.filter(c => new Date(c.datetime) >= marketOpen);
        
        console.log(`  Expected candles since market open: ~${expectedCandles}`);
        console.log(`  Actual candles since market open: ${todayCandles.length}`);
        console.log(`  Coverage: ${((todayCandles.length / expectedCandles) * 100).toFixed(1)}%`);
        
        // Show last 3 candles
        console.log(`\n  Last 3 candles:`);
        const last3 = sorted.slice(-3);
        last3.forEach((c, i) => {
          const date = new Date(c.datetime);
          console.log(`    ${i + 1}. ${date.toISOString()} - Close: ${c.close}`);
        });
      }
      
    } catch (error) {
      console.log(`❌ ERROR: ${error.message}`);
      console.log(error.stack);
    }
  }
  
  // Now test the candle analysis endpoint
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Testing Candle Analysis Endpoint`);
  console.log(`${'='.repeat(60)}`);
  
  try {
    const response = await fetch('http://localhost:3001/api/v1/marketdata/candleanalysis?symbol=NDX');
    const analysis = await response.json();
    
    if (!analysis || !analysis.candleData) {
      console.log(`❌ NO ANALYSIS DATA`);
      return;
    }
    
    console.log(`\nAnalysis timestamp: ${analysis.timestamp}`);
    console.log(`Available timeframes: ${Object.keys(analysis.candleData).join(', ')}`);
    
    for (const [tfName, tfData] of Object.entries(analysis.candleData)) {
      if (tfData.error || !tfData.candles || tfData.candles.length === 0) {
        console.log(`\n${tfName}: ❌ NO DATA`);
        continue;
      }
      
      // Candles are sorted newest-first in the analysis
      const newestCandle = tfData.candles[0];
      const oldestCandle = tfData.candles[tfData.candles.length - 1];
      
      const newestDate = new Date(newestCandle.datetime);
      const oldestDate = new Date(oldestCandle.datetime);
      
      console.log(`\n${tfName}: ${tfData.candles.length} candles`);
      console.log(`  Newest: ${newestDate.toISOString()} - Close: ${newestCandle.close}`);
      console.log(`  Oldest: ${oldestDate.toISOString()} - Close: ${oldestCandle.close}`);
      
      const hasToday = newestDate >= todayStart;
      const hasTodayAfterMarketOpen = newestDate >= marketOpen;
      
      console.log(`  Has data from today: ${hasToday ? '✅' : '❌'}`);
      console.log(`  Has data after market open: ${hasTodayAfterMarketOpen ? '✅' : '❌'}`);
      
      if (!hasTodayAfterMarketOpen) {
        console.log(`  ⚠️  MISSING TODAY'S DATA - Last candle is ${Math.floor((now - newestDate) / 1000 / 60)} minutes old`);
      }
      
      // Check for indicators
      if (tfData.indicators) {
        const hasIndicators = tfData.indicators.sma20 && tfData.indicators.sma20.length > 0;
        console.log(`  Has indicators: ${hasIndicators ? '✅' : '❌'}`);
      }
    }
    
  } catch (error) {
    console.log(`❌ ERROR: ${error.message}`);
    console.log(error.stack);
  }
}

// Run the test
testCandleData()
  .then(() => {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Test completed`);
    console.log(`${'='.repeat(60)}\n`);
    process.exit(0);
  })
  .catch(error => {
    console.error(`\n❌ Test failed:`, error);
    process.exit(1);
  });
