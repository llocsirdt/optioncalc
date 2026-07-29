#!/usr/bin/env node

/**
 * Daily Strategy Comparison Runner
 * 
 * Executes run-all-strategies.js for all weekdays between specified date range
 * and compiles results into a comprehensive comparison report.
 */

const { execSync } = require('child_process');
const fs = require('fs').promises;
const path = require('path');

// Helper function to generate weekdays between two dates
function generateWeekdays(startDate, endDate) {
  const dates = [];
  const current = new Date(startDate);
  const end = new Date(endDate);
  
  while (current <= end) {
    // Skip weekends (0 = Sunday, 6 = Saturday)
    const dayOfWeek = current.getDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      dates.push(new Date(current).toISOString().split('T')[0]);
    }
    current.setDate(current.getDate() + 1);
  }
  
  return dates;
}

// Helper function to extract results from backtest actions file
async function extractResults(date, symbol = 'NDX') {
  try {
    const resultsDir = path.join(__dirname, 'tests/backtest/backtest-actions');
    const files = await fs.readdir(resultsDir);
    
    const dateFiles = files.filter(file => 
      file.includes(`-${symbol}-${date}-`) && 
      file.endsWith('.json')
    );
    
    const results = [];
    
    for (const file of dateFiles) {
      try {
        const filePath = path.join(resultsDir, file);
        const content = await fs.readFile(filePath, 'utf8');
        const data = JSON.parse(content);
        
        // Extract strategy name from filename
        const parts = file.split('-');
        const strategyName = parts.slice(4, -1).join('-').replace(/-/g, ' ');
        
        results.push({
          date,
          strategy: strategyName,
          file,
          totalActions: data.metadata?.totalActions || 0,
          totalProfitLoss: data.metadata?.totalProfitLoss || 0,
          winRate: calculateWinRate(data.actions || [])
        });
      } catch (error) {
        console.warn(`⚠️  Could not process ${file}: ${error.message}`);
      }
    }
    
    return results;
  } catch (error) {
    console.error(`❌ Error reading results for ${date}: ${error.message}`);
    return [];
  }
}

// Calculate win rate from actions
function calculateWinRate(actions) {
  if (actions.length === 0) return 0;
  
  const positions = [];
  let currentPosition = null;
  
  for (const action of actions) {
    if (action.action.includes('open')) {
      currentPosition = {
        type: action.action.replace('open_', ''),
        openedAt: action.timestamp,
        openPrice: action.closePrice
      };
    } else if (action.action === 'cover' && currentPosition) {
      currentPosition.closedAt = action.timestamp;
      currentPosition.closePrice = action.closePrice;
      currentPosition.pnl = currentPosition.type === 'bull' 
        ? currentPosition.closePrice - currentPosition.openPrice
        : currentPosition.openPrice - currentPosition.closePrice;
      positions.push(currentPosition);
      currentPosition = null;
    }
  }
  
  if (positions.length === 0) return 0;
  const wins = positions.filter(p => p.pnl > 0).length;
  return Math.round((wins / positions.length) * 100);
}

// Main execution function
async function runDailyComparison(startDate, endDate, symbol = 'NDX') {
  const dates = generateWeekdays(startDate, endDate);
  
  console.log(`🔄 Running daily strategy comparison for ${symbol}`);
  console.log(`📅 Date range: ${startDate} to ${endDate}`);
  console.log(`📊 Total weekdays: ${dates.length}`);
  console.log('='.repeat(80));
  
  const allResults = [];
  
  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    console.log(`\n[${i + 1}/${dates.length}] Processing ${date}...`);
    
    try {
      // Run the backtest for this date
      console.log(`  📊 Running strategies for ${date}...`);
      const output = execSync(
        `node tests/backtest/run-all-strategies.js ${date}`,
        { 
          encoding: 'utf8', 
          stdio: 'pipe',
          cwd: __dirname 
        }
      );
      
      // Extract results from generated files
      const dateResults = await extractResults(date, symbol);
      allResults.push(...dateResults);
      
      console.log(`  ✅ Completed ${date} - ${dateResults.length} strategies`);
      
    } catch (error) {
      console.error(`  ❌ Failed to process ${date}: ${error.message}`);
    }
  }
  
  // Generate comprehensive report
  console.log('\n' + '='.repeat(80));
  console.log('📊 COMPREHENSIVE DAILY COMPARISON REPORT');
  console.log('='.repeat(80));
  
  // Group by strategy
  const strategyGroups = {};
  allResults.forEach(result => {
    if (!strategyGroups[result.strategy]) {
      strategyGroups[result.strategy] = [];
    }
    strategyGroups[result.strategy].push(result);
  });
  
  // Calculate strategy statistics
  const strategyStats = Object.entries(strategyGroups).map(([strategy, results]) => {
    const totalDays = results.length;
    const profitableDays = results.filter(r => r.totalProfitLoss > 0).length;
    const totalProfitLoss = results.reduce((sum, r) => sum + r.totalProfitLoss, 0);
    const totalActions = results.reduce((sum, r) => sum + r.totalActions, 0);
    const avgWinRate = results.reduce((sum, r) => sum + r.winRate, 0) / results.length;
    const avgDailyPL = totalProfitLoss / totalDays;
    
    return {
      strategy,
      totalDays,
      profitableDays,
      winRateDays: Math.round((profitableDays / totalDays) * 100),
      totalProfitLoss,
      avgDailyPL,
      totalActions,
      avgWinRate: Math.round(avgWinRate),
      results
    };
  });
  
  // Sort by total profit/loss
  strategyStats.sort((a, b) => b.totalProfitLoss - a.totalProfitLoss);
  
  console.log('\n🏆 Strategy Ranking (Total P/L):');
  strategyStats.forEach((stat, i) => {
    const arrow = stat.totalProfitLoss > 0 ? '📈' : stat.totalProfitLoss < 0 ? '📉' : '➖';
    console.log(`${i + 1}. ${arrow} ${stat.strategy}: ${stat.totalProfitLoss.toFixed(2)} pts (${stat.totalDays} days, ${stat.winRateDays}% profitable)`);
  });
  
  // Detailed breakdown
  console.log('\n📈 Detailed Strategy Performance:');
  strategyStats.forEach(stat => {
    console.log(`\n🎯 ${stat.strategy}:`);
    console.log(`  Total P/L: ${stat.totalProfitLoss.toFixed(2)} points`);
    console.log(`  Daily Avg: ${stat.avgDailyPL.toFixed(2)} points`);
    console.log(`  Profitable Days: ${stat.profitableDays}/${stat.totalDays} (${stat.winRateDays}%)`);
    console.log(`  Total Actions: ${stat.totalActions}`);
    console.log(`  Avg Win Rate: ${stat.avgWinRate}%`);
    
    // Show best and worst days
    const bestDay = stat.results.reduce((best, r) => r.totalProfitLoss > best.totalProfitLoss ? r : best);
    const worstDay = stat.results.reduce((worst, r) => r.totalProfitLoss < worst.totalProfitLoss ? r : worst);
    
    console.log(`  Best Day: ${bestDay.date} (+${bestDay.totalProfitLoss.toFixed(2)})`);
    console.log(`  Worst Day: ${worstDay.date} (${worstDay.totalProfitLoss.toFixed(2)})`);
  });
  
  // Save detailed results to file
  const reportFile = `strategy-comparison-${symbol}-${startDate}-to-${endDate}.json`;
  const reportPath = path.join(__dirname, reportFile);
  
  await fs.writeFile(reportPath, JSON.stringify({
    metadata: {
      symbol,
      startDate,
      endDate,
      totalDays: dates.length,
      generatedAt: new Date().toISOString()
    },
    strategyStats,
    allResults
  }, null, 2));
  
  console.log(`\n💾 Detailed results saved to: ${reportFile}`);
  
  // Summary statistics
  const totalStrategies = strategyStats.length;
  const profitableStrategies = strategyStats.filter(s => s.totalProfitLoss > 0).length;
  const totalPL = strategyStats.reduce((sum, s) => sum + s.totalProfitLoss, 0);
  
  console.log('\n📊 Overall Summary:');
  console.log(`  Strategies Tested: ${totalStrategies}`);
  console.log(`  Profitable Strategies: ${profitableStrategies} (${Math.round((profitableStrategies / totalStrategies) * 100)}%)`);
  console.log(`  Combined P/L: ${totalPL.toFixed(2)} points`);
  console.log(`  Trading Days: ${dates.length}`);
  
  return strategyStats;
}

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  
  if (args.length < 2) {
    console.log('Usage: node run-daily-strategy-comparison.js <startDate> <endDate> [symbol]');
    console.log('Example: node run-daily-strategy-comparison.js 2026-01-15 2026-03-13 NDX');
    process.exit(1);
  }
  
  return {
    startDate: args[0],
    endDate: args[1],
    symbol: args[2] || 'NDX'
  };
}

// Run the comparison
(async () => {
  try {
    const { startDate, endDate, symbol } = parseArgs();
    await runDailyComparison(startDate, endDate, symbol);
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
})();
