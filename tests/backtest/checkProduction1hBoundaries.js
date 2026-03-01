#!/usr/bin/env node

/**
 * Check production 1h candle boundaries and which 30m candles are aggregated
 * Compare across multiple dates to identify boundary issues
 */

const path = require('path');
const fs = require('fs').promises;
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { analyzeCandles } = require('../../server/src/persistence/candle-analyzer.js');
const marketClientPath = path.resolve(__dirname, '../../server/src/persistence/market-client.js');
const { marketClient } = require(marketClientPath);

async function checkBoundaries() {
  try {
    console.log('🔍 Checking Production 1h Candle Boundaries\n');
    
    // Get production analysis
    const analysis = await analyzeCandles('NDX');
    
    // Get Schwab's 30m candles to see what production is aggregating
    const startDate = new Date('2026-02-25T00:00:00-05:00').getTime();
    const endDate = new Date('2026-02-27T23:59:59-05:00').getTime();
    
    console.log('📡 Fetching Schwab 30m candles...');
    const response30m = await marketClient.priceHistory('$NDX', {
      frequencyType: 'minute',
      frequency: 30,
      startDate: startDate,
      endDate: endDate
    });
    
    const schwab30m = response30m.candles || [];
    console.log(`✅ Got ${schwab30m.length} 30m candles\n`);
    
    // Get Schwab's 60m candles for comparison
    console.log('📡 Fetching Schwab 60m candles...');
    const response60m = await marketClient.priceHistory('$NDX', {
      frequencyType: 'minute',
      frequency: 30, // Use 30 to get hourly
      startDate: startDate,
      endDate: endDate
    });
    
    const schwab60m = response60m.candles || [];
    console.log(`✅ Got ${schwab60m.length} hourly candles\n`);
    
    // Load backtest data for Feb 26 and 27
    const backtest26 = JSON.parse(await fs.readFile(path.join(__dirname, 'backtest-correct-NDX-2026-02-26.json'), 'utf8'));
    const backtest27 = JSON.parse(await fs.readFile(path.join(__dirname, 'backtest-correct-NDX-2026-02-27.json'), 'utf8'));
    
    // Test specific hours across both dates
    const testCases = [
      { date: '2026-02-26', hour: 10, backtestTime: '10:59', schwabTime: '10:00', backtest: backtest26 },
      { date: '2026-02-26', hour: 14, backtestTime: '14:59', schwabTime: '14:00', backtest: backtest26 },
      { date: '2026-02-27', hour: 10, backtestTime: '10:59', schwabTime: '10:00', backtest: backtest27 },
      { date: '2026-02-27', hour: 11, backtestTime: '11:59', schwabTime: '11:00', backtest: backtest27 },
      { date: '2026-02-27', hour: 14, backtestTime: '14:59', schwabTime: '14:00', backtest: backtest27 },
    ];
    
    for (const test of testCases) {
      console.log(`\n${'='.repeat(80)}`);
      console.log(`📅 ${test.date} - ${test.hour}:00 hour (${test.hour}:00-${test.hour}:59)`);
      console.log(`${'='.repeat(80)}\n`);
      
      // Get backtest 60m candle
      const backtestEntry = test.backtest.find(e => e.timestamp === test.backtestTime);
      const backtest60m = backtestEntry?.analysis['60m'];
      
      if (backtest60m) {
        console.log('📊 Backtest 60m candle:');
        console.log(`   O=${backtest60m.open.toFixed(2)}, H=${backtest60m.high.toFixed(2)}, L=${backtest60m.low.toFixed(2)}, C=${backtest60m.close.toFixed(2)}`);
      }
      
      // Get Schwab 60m candle
      const schwabDate = new Date(`${test.date}T${test.schwabTime}:00-05:00`);
      const schwabTimestamp = schwabDate.getTime();
      const schwabCandle = schwab60m.find(c => c.datetime === schwabTimestamp);
      
      if (schwabCandle) {
        console.log('\n📊 Schwab 60m candle:');
        console.log(`   O=${schwabCandle.open.toFixed(2)}, H=${schwabCandle.high.toFixed(2)}, L=${schwabCandle.low.toFixed(2)}, C=${schwabCandle.close.toFixed(2)}`);
        
        if (backtest60m) {
          const match = Math.abs(backtest60m.high - schwabCandle.high) < 0.01 && 
                       Math.abs(backtest60m.close - schwabCandle.close) < 0.01;
          console.log(`   Backtest vs Schwab: ${match ? '✅ MATCH' : '❌ MISMATCH'}`);
        }
      }
      
      // Get production 1h candle
      const prodCandles1h = analysis.candleData['1h'].candles;
      const prodCandle = prodCandles1h.find(c => c.datetime === schwabTimestamp);
      
      if (prodCandle) {
        console.log('\n📊 Production 1h candle:');
        console.log(`   O=${prodCandle.open.toFixed(2)}, H=${prodCandle.high.toFixed(2)}, L=${prodCandle.low.toFixed(2)}, C=${prodCandle.close.toFixed(2)}`);
        
        if (backtest60m) {
          const match = Math.abs(backtest60m.high - prodCandle.high) < 0.01 && 
                       Math.abs(backtest60m.close - prodCandle.close) < 0.01;
          console.log(`   Backtest vs Production: ${match ? '✅ MATCH' : '❌ MISMATCH'}`);
          
          if (!match) {
            console.log(`   Differences:`);
            console.log(`     High:  Backtest=${backtest60m.high.toFixed(2)}, Production=${prodCandle.high.toFixed(2)}, Diff=${(backtest60m.high - prodCandle.high).toFixed(2)}`);
            console.log(`     Close: Backtest=${backtest60m.close.toFixed(2)}, Production=${prodCandle.close.toFixed(2)}, Diff=${(backtest60m.close - prodCandle.close).toFixed(2)}`);
          }
        }
      }
      
      // Show which 30m candles should be aggregated for this hour
      console.log(`\n🔍 30m candles that should be aggregated for ${test.hour}:00-${test.hour}:59:`);
      
      const hour1 = new Date(`${test.date}T${test.hour.toString().padStart(2, '0')}:00:00-05:00`).getTime();
      const hour2 = new Date(`${test.date}T${test.hour.toString().padStart(2, '0')}:30:00-05:00`).getTime();
      
      const candle1 = schwab30m.find(c => c.datetime === hour1);
      const candle2 = schwab30m.find(c => c.datetime === hour2);
      
      if (candle1) {
        const d = new Date(candle1.datetime);
        const est = d.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false });
        console.log(`   ${est}: O=${candle1.open.toFixed(2)}, H=${candle1.high.toFixed(2)}, L=${candle1.low.toFixed(2)}, C=${candle1.close.toFixed(2)}`);
      }
      
      if (candle2) {
        const d = new Date(candle2.datetime);
        const est = d.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false });
        console.log(`   ${est}: O=${candle2.open.toFixed(2)}, H=${candle2.high.toFixed(2)}, L=${candle2.low.toFixed(2)}, C=${candle2.close.toFixed(2)}`);
      }
      
      // Manually aggregate these two 30m candles
      if (candle1 && candle2) {
        const manualAgg = {
          open: candle1.open,
          high: Math.max(candle1.high, candle2.high),
          low: Math.min(candle1.low, candle2.low),
          close: candle2.close
        };
        
        console.log(`\n   Manual aggregation of these 2 candles:`);
        console.log(`   O=${manualAgg.open.toFixed(2)}, H=${manualAgg.high.toFixed(2)}, L=${manualAgg.low.toFixed(2)}, C=${manualAgg.close.toFixed(2)}`);
        
        if (prodCandle) {
          const match = Math.abs(manualAgg.high - prodCandle.high) < 0.01 && 
                       Math.abs(manualAgg.close - prodCandle.close) < 0.01;
          console.log(`   Manual vs Production: ${match ? '✅ MATCH' : '❌ MISMATCH'}`);
          
          if (!match) {
            console.log(`   Production is NOT using these 30m candles! ⚠️`);
          }
        }
        
        if (backtest60m) {
          const match = Math.abs(manualAgg.high - backtest60m.high) < 0.01 && 
                       Math.abs(manualAgg.close - backtest60m.close) < 0.01;
          console.log(`   Manual vs Backtest: ${match ? '✅ MATCH' : '❌ MISMATCH'}`);
        }
      }
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  }
}

checkBoundaries();
