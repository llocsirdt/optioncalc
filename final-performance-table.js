#!/usr/bin/env node

/**
 * Generate a clean performance table from the truly fixed strategy analysis
 */

const fs = require('fs').promises;
const path = require('path');

async function generateFinalTable() {
  try {
    const dataPath = path.join(__dirname, 'strategy-analysis-truly-fixed-NDX-2026-01-15-to-2026-03-13.json');
    const content = await fs.readFile(dataPath, 'utf8');
    const data = JSON.parse(content);
    
    // Sort strategies by daily average P/L
    const sortedStrategies = data.strategyStats.sort((a, b) => b.avgDailyPL - a.avgDailyPL);
    
    console.log('FINAL CORRECTED Strategy Performance Table (1/15 - 3/13)');
    console.log('='.repeat(100));
    
    sortedStrategies.forEach((stat, index) => {
      // Find best and worst days
      const bestDay = stat.results.reduce((best, r) => r.totalProfitLoss > best.totalProfitLoss ? r : best);
      const worstDay = stat.results.reduce((worst, r) => r.totalProfitLoss < worst.totalProfitLoss ? r : worst);
      
      const lossDays = stat.totalDays - stat.profitableDays;
      
      console.log(`${(index + 1).toString().padStart(3)}. ${stat.strategy}`);
      console.log(`    Daily Avg: ${stat.avgDailyPL.toFixed(2)} pts`);
      console.log(`    Best Day: ${bestDay.date} (+${bestDay.totalProfitLoss.toFixed(2)})`);
      console.log(`    Worst Day: ${worstDay.date} (${worstDay.totalProfitLoss.toFixed(2)})`);
      console.log(`    Profitable Days: ${stat.profitableDays}/${stat.totalDays} (${stat.winRateDays}%)`);
      console.log(`    Loss Days: ${lossDays}`);
      console.log('');
    });
    
    // Summary statistics
    const totalStrategies = data.strategyStats.length;
    const profitableStrategies = data.strategyStats.filter(s => s.avgDailyPL > 0).length;
    const breakevenStrategies = data.strategyStats.filter(s => Math.abs(s.avgDailyPL) < 0.01).length;
    const losingStrategies = totalStrategies - profitableStrategies - breakevenStrategies;
    
    console.log('='.repeat(100));
    console.log('FINAL CORRECTED Overall Summary:');
    console.log(`Total Strategies: ${totalStrategies}`);
    console.log(`Profitable: ${profitableStrategies} (${Math.round(profitableStrategies/totalStrategies*100)}%)`);
    console.log(`Breakeven: ${breakevenStrategies} (${Math.round(breakevenStrategies/totalStrategies*100)}%)`);
    console.log(`Losing: ${losingStrategies} (${Math.round(losingStrategies/totalStrategies*100)}%)`);
    
    // Top 5 by daily average
    console.log('\nTop 5 by Daily Average:');
    sortedStrategies.slice(0, 5).forEach((stat, i) => {
      console.log(`${i+1}. ${stat.strategy}: ${stat.avgDailyPL.toFixed(2)} pts/day (${stat.profitableDays}/${stat.totalDays} profitable)`);
    });
    
    // Multi-day strategies (10+ days)
    const multiDayStrategies = sortedStrategies.filter(s => s.totalDays >= 10);
    console.log('\nMulti-Day Strategies (10+ days):');
    multiDayStrategies.forEach((stat, i) => {
      console.log(`${i+1}. ${stat.strategy}: ${stat.avgDailyPL.toFixed(2)} pts/day (${stat.profitableDays}/${stat.totalDays} profitable)`);
    });
    
    // State strategy variants
    const stateStrategies = sortedStrategies.filter(s => s.strategy.includes('State'));
    console.log('\nState Strategy Variants:');
    stateStrategies.forEach((stat, i) => {
      console.log(`${i+1}. ${stat.strategy}: ${stat.avgDailyPL.toFixed(2)} pts/day (${stat.profitableDays}/${stat.totalDays} profitable)`);
    });
    
  } catch (error) {
    console.error('Error:', error.message);
  }
}

generateFinalTable();
