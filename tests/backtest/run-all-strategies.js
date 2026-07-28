const { BacktestController } = require('./backtest-controller');

// Helper function to match BacktestController's filename generation
function simplifyStrategyName(method) {
  if (!method) return 'unknown';
  return method.replace(/^strategy/, '').replace(/(Open|Cover)$/i, '');
}

// All available strategy pairs
const strategies = [
  {
    name: 'Simple 5m BB Score',
    open: 'strategySimple5mBBScoreOpen',
    cover: 'strategySimple5mBBScoreCover'
  },
  {
    name: 'Simple 15m BB Score',
    open: 'strategySimple15mBBScoreOpen',
    cover: 'strategySimple15mBBScoreCover'
  },
  {
    name: 'Simple 15m+60m BB Score',
    open: 'strategySimple15and60mBBScoreOpen',
    cover: 'strategySimple15and60mBBScoreCover'
  },
  {
    name: '1m-5m-15m Multi',
    open: 'strategy1m5m15mOpen',
    cover: 'strategy1m5m15mCover'
  },
  {
    name: 'State Strategy (Baseline)',
    open: 'strategyStateOpen',
    cover: 'strategyStateCover',
    config: {},
    runLabel: 'baseline'
  },
  {
    name: 'State Strategy (Min3)',
    open: 'strategyStateOpen',
    cover: 'strategyStateCover',
    config: { open: { minConfirmations: 3 } },
    runLabel: 'min3'
  },
  {
    name: 'State Strategy (Min4)',
    open: 'strategyStateOpen',
    cover: 'strategyStateCover',
    config: { open: { minConfirmations: 4 } },
    runLabel: 'min4'
  },
  {
    name: 'State Strategy (Min5)',
    open: 'strategyStateOpen',
    cover: 'strategyStateCover',
    config: { open: { minConfirmations: 5 } },
    runLabel: 'min5'
  },
  {
    name: 'State Strategy (M3 Gate Strict)',
    open: 'strategyStateOpen',
    cover: 'strategyStateCover',
    config: { open: { minConfirmations: 3, enableTrendGate: true, strongTrendThreshold: 4, allowCounterTrendIfExtreme: false } },
    runLabel: 'm3-gate-strict'
  },
  {
    name: 'State Strategy (M3 Gate Relax)',
    open: 'strategyStateOpen',
    cover: 'strategyStateCover',
    config: { open: { minConfirmations: 3, enableTrendGate: true, strongTrendThreshold: 4, allowCounterTrendIfExtreme: true, counterTrendExtremeBB5m: 1.2 } },
    runLabel: 'm3-gate-relax'
  },
  {
    name: 'State Strategy (M3 Cover Strong)',
    open: 'strategyStateOpen',
    cover: 'strategyStateCover',
    config: { open: { minConfirmations: 3 }, cover: { strengthen1mThreshold: true, minAbsBB5mFor1mThreshold: 0.4, minHoldMinutesFor1mThreshold: 3 } },
    runLabel: 'm3-cover-strong'
  },
  {
    name: 'State Strategy (M4 Gate Relax)',
    open: 'strategyStateOpen',
    cover: 'strategyStateCover',
    config: { open: { minConfirmations: 4, enableTrendGate: true, strongTrendThreshold: 4, allowCounterTrendIfExtreme: true, counterTrendExtremeBB5m: 1.2 } },
    runLabel: 'm4-gate-relax'
  },
  {
    name: 'State Strategy (M4 Cover Strong)',
    open: 'strategyStateOpen',
    cover: 'strategyStateCover',
    config: { open: { minConfirmations: 4 }, cover: { strengthen1mThreshold: true, minAbsBB5mFor1mThreshold: 0.4, minHoldMinutesFor1mThreshold: 3 } },
    runLabel: 'm4-cover-strong'
  },
  {
    name: 'State Strategy (M5 Gate Cover)',
    open: 'strategyStateOpen',
    cover: 'strategyStateCover',
    config: { open: { minConfirmations: 5, enableTrendGate: true, strongTrendThreshold: 4, allowCounterTrendIfExtreme: true, counterTrendExtremeBB5m: 1.2 }, cover: { strengthen1mThreshold: true, minAbsBB5mFor1mThreshold: 0.3, minHoldMinutesFor1mThreshold: 2 } },
    runLabel: 'm5-gate-cover'
  },
  {
    name: 'Price Trail v1',
    open: 'strategyPriceTrailOpen',
    cover: 'strategyPriceTrailCover'
  },
  {
    name: 'Price Trail v2',
    open: 'strategyPriceTrailv2Open',
    cover: 'strategyPriceTrailv2Cover'
  },
  {
    name: 'Price Trail v3',
    open: 'strategyPriceTrailv3Open',
    cover: 'strategyPriceTrailv3Cover'
  },
  {
    name: 'Aggregate Scores',
    open: 'strategyAggregateScoresOpen',
    cover: 'strategyAggregateScoresCover'
  }
];

async function runAllStrategies(date) {
  // Use provided date or default to today
  const targetDate = date || new Date().toISOString().split('T')[0]; // Format: YYYY-MM-DD
  console.log(`🔄 Running all strategies for ${targetDate}`);
  console.log('='.repeat(80));
  
  const results = [];
  
  for (const strategy of strategies) {
    console.log(`\n📊 Testing ${strategy.name}...`);
    
    try {
      const backtest = new BacktestController();
      
      // Build runtime options for state strategy configs
      const runtimeOptions = {};
      if (strategy.config) {
        runtimeOptions.config = strategy.config;
      }
      if (strategy.runLabel) {
        runtimeOptions.runLabel = strategy.runLabel;
      }
      
      await backtest.runBacktest('NDX', targetDate, strategy.open, strategy.cover, Object.keys(runtimeOptions).length > 0 ? runtimeOptions : undefined);
      
      // Read the results - use runLabel if present for filename
      const openMethodShort = simplifyStrategyName(strategy.open);
      const coverMethodShort = simplifyStrategyName(strategy.cover);
      const labelSuffix = strategy.runLabel ? `-${strategy.runLabel}` : '';
      const actionsPath = `./tests/backtest/backtest-actions/backtest-actions-NDX-${targetDate}-${openMethodShort}-${coverMethodShort}${labelSuffix}.json`;
      const actionsData = require('fs').readFileSync(actionsPath, 'utf8');
      const actions = JSON.parse(actionsData);
      
      const result = {
        name: strategy.name,
        open: strategy.open,
        cover: strategy.cover,
        totalActions: actions.metadata.totalActions,
        totalProfitLoss: actions.metadata.totalProfitLoss,
        winRate: calculateWinRate(actions.actions),
        avgTrade: actions.metadata.totalActions > 0 ? actions.metadata.totalProfitLoss / actions.metadata.totalActions : 0
      };
      
      results.push(result);
      console.log(`✅ ${strategy.name}: ${result.totalActions} actions, P/L: ${result.totalProfitLoss.toFixed(2)}, Win Rate: ${result.winRate}%`);
      
    } catch (error) {
      console.error(`❌ ${strategy.name}: ${error.message}`);
      results.push({
        name: strategy.name,
        open: strategy.open,
        cover: strategy.cover,
        totalActions: 0,
        totalProfitLoss: 0,
        winRate: 0,
        avgTrade: 0,
        error: error.message
      });
    }
  }
  
  // Sort by profit/loss
  results.sort((a, b) => b.totalProfitLoss - a.totalProfitLoss);
  
  console.log('\n' + '='.repeat(80));
  console.log('📊 STRATEGY COMPARISON RESULTS');
  console.log('='.repeat(80));
  
  console.log('\n🏆 Ranking by P/L:');
  results.forEach((result, i) => {
    const arrow = result.totalProfitLoss > 0 ? '📈' : result.totalProfitLoss < 0 ? '📉' : '➖';
    const status = result.error ? '❌' : '✅';
    console.log(`${i+1}. ${status} ${arrow} ${result.name}: ${result.totalProfitLoss.toFixed(2)} pts (${result.totalActions} actions, ${result.winRate}% win rate)`);
  });
  
  console.log('\n📈 Detailed Analysis:');
  const profitable = results.filter(r => r.totalProfitLoss > 0);
  const losing = results.filter(r => r.totalProfitLoss < 0);
  const flat = results.filter(r => r.totalProfitLoss === 0);
  
  console.log(`✅ Profitable strategies: ${profitable.length}`);
  console.log(`❌ Losing strategies: ${losing.length}`);
  console.log(`➖ Flat strategies: ${flat.length}`);
  
  if (profitable.length > 0) {
    console.log('\n🎯 Best Performers:');
    profitable.slice(0, 3).forEach((result, i) => {
      console.log(`  ${i+1}. ${result.name}: +${result.totalProfitLoss.toFixed(2)} pts (${result.totalActions} actions)`);
    });
  }
  
  if (losing.length > 0) {
    console.log('\n⚠️  Worst Performers:');
    losing.slice(-3).reverse().forEach((result, i) => {
      console.log(`  ${i+1}. ${result.name}: ${result.totalProfitLoss.toFixed(2)} pts (${result.totalActions} actions)`);
    });
  }
  
  console.log('\n🏅 Overall Winner:');
  const winner = results[0];
  if (winner.totalProfitLoss > 0) {
    console.log(`🎉 ${winner.name} with ${winner.totalProfitLoss.toFixed(2)} points profit!`);
  } else {
    console.log(`😞 No profitable strategies today. Best was ${winner.name} with ${winner.totalProfitLoss.toFixed(2)} points.`);
  }
}

function calculateWinRate(actions) {
  if (actions.length === 0) return 0;
  
  // Group actions by position (open/close pairs)
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

// Get date from command line arguments or use today
const targetDate = process.argv[2];

runAllStrategies(targetDate).catch(console.error);
