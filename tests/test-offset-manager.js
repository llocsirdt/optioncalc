#!/usr/bin/env node

/**
 * Test suite for OffsetManager functions
 * 
 * Tests each findOffsetting function with specific position and chain data scenarios
 * to ensure all offsetting logic works correctly across different position types.
 */

const OffsetManager = require('../server/src/persistence/offset-manager');

// Test utilities
class TestRunner {
  constructor() {
    this.tests = [];
    this.passed = 0;
    this.failed = 0;
  }

  test(name, fn) {
    this.tests.push({ name, fn });
  }

  async run() {
    console.log('\n🧪 Running OffsetManager Tests\n');
    console.log('='.repeat(80));
    console.log(`Running ${this.tests.length} tests...\n`);
    
    for (const test of this.tests) {
      try {
        await test.fn();
        this.passed++;
        console.log(`✅ ${test.name}`);
      } catch (error) {
        this.failed++;
        console.log(`❌ ${test.name}`);
        console.log(`   Error: ${error.message}`);
        if (error.expected !== undefined) {
          console.log(`   Expected: ${JSON.stringify(error.expected)}`);
          console.log(`   Received: ${JSON.stringify(error.received)}`);
        }
      }
    }
    
    console.log('\n' + '='.repeat(80));
    console.log(`\n📊 Results: ${this.passed} passed, ${this.failed} failed, ${this.tests.length} total\n`);
    
    return this.failed === 0;
  }
}

function assert(condition, message, expected, received) {
  if (!condition) {
    const error = new Error(message);
    error.expected = expected;
    error.received = received;
    throw error;
  }
}

function assertGreaterThan(actual, expected, message) {
  assert(actual > expected, message || `Expected ${actual} to be greater than ${expected}`, `> ${expected}`, actual);
}

function assertExists(value, message) {
  assert(value !== null && value !== undefined, message || 'Expected value to exist', 'defined value', value);
}

function assertArrayLength(array, length, message) {
  assert(Array.isArray(array) && array.length === length, 
    message || `Expected array length ${length}, got ${array?.length}`, 
    length, 
    array?.length);
}

// Static test data loader
function createStaticChainData() {
  try {
    const fs = require('fs');
    const path = require('path');
    const chainDataPath = path.join(__dirname, 'test-chain.json');
    const rawData = fs.readFileSync(chainDataPath, 'utf8');
    const chainFile = JSON.parse(rawData);
    
    // Transform the real data into the format expected by offset manager
    const transformedData = {
      call: {},
      put: {}
    };
    
    // Transform calls
    Object.entries(chainFile.data.call).forEach(([expiration, strikes]) => {
      transformedData.call[expiration] = {};
      Object.entries(strikes).forEach(([strike, options]) => {
        const option = options[0]; // Take first option
        transformedData.call[expiration][strike] = [{
          bid: option.bid,
          ask: option.ask,
          strike: parseFloat(strike)
        }];
      });
    });
    
    // Transform puts
    Object.entries(chainFile.data.put).forEach(([expiration, strikes]) => {
      transformedData.put[expiration] = {};
      Object.entries(strikes).forEach(([strike, options]) => {
        const option = options[0]; // Take first option
        transformedData.put[expiration][strike] = [{
          bid: option.bid,
          ask: option.ask,
          strike: parseFloat(strike)
        }];
      });
    });
    
        
    return transformedData;
  } catch (error) {
    console.error('Error loading static chain data:', error);
    throw new Error('Failed to load static chain data. Please ensure test-chain.json exists in tests folder.');
  }
}


function createBullCallSpread(longStrike, shortStrike, longCost, shortCost) {
  return {
    strategy: 'bull_call_spread',
    cost: longCost + shortCost,
    offsetBudget: Math.abs((shortStrike - longStrike) * 100 - Math.abs(longCost + shortCost)),
    spreadWidth: Math.abs(shortStrike - longStrike),
    maxValue: Math.abs(shortStrike - longStrike) * 100,
    legs: [
      {
        action: 'initial',
        quantity: 1,
        type: 'C',
        strike: longStrike,
        cost: longCost,
        originalString: `1c${longStrike}@${longCost}`
      },
      {
        action: 'initial',
        quantity: -1,
        type: 'C',
        strike: shortStrike,
        cost: shortCost,
        originalString: `-1c${shortStrike}@${shortCost}`
      }
    ]
  };
}

function createBearCallSpread(shortStrike, longStrike, shortCost, longCost) {
  return {
    strategy: 'bear_call_spread',
    cost: shortCost + longCost,
    offsetBudget: Math.abs(shortCost + longCost), // For credit spreads, budget is the credit collected
    spreadWidth: Math.abs(longStrike - shortStrike),
    maxValue: Math.abs(longStrike - shortStrike) * 100,
    legs: [
      {
        action: 'initial',
        quantity: 1,
        type: 'C',
        strike: longStrike,
        cost: longCost,
        originalString: `1c${longStrike}@${longCost}`
      },
      {
        action: 'initial',
        quantity: -1,
        type: 'C',
        strike: shortStrike,
        cost: shortCost,
        originalString: `-1c${shortStrike}@${shortCost}`
      }
    ]
  };
}

function createBullPutSpread(shortStrike, longStrike, shortCost, longCost) {
  return {
    strategy: 'bull_put_spread',
    cost: shortCost + longCost,
    offsetBudget: Math.abs(shortCost + longCost), // For credit spreads, budget is the credit collected
    spreadWidth: Math.abs(shortStrike - longStrike),
    maxValue: Math.abs(shortStrike - longStrike) * 100,
    legs: [
      {
        action: 'initial',
        quantity: -1,
        type: 'P',
        strike: shortStrike,
        cost: shortCost,
        originalString: `-1p${shortStrike}@${shortCost}`
      },
      {
        action: 'initial',
        quantity: 1,
        type: 'P',
        strike: longStrike,
        cost: longCost,
        originalString: `1p${longStrike}@${longCost}`
      }
    ]
  };
}

function createBearPutSpread(longStrike, shortStrike, longCost, shortCost) {
  return {
    strategy: 'bear_put_spread',
    cost: longCost + shortCost,
    offsetBudget: Math.abs((longStrike - shortStrike) * 100 - (longCost + shortCost)),
    spreadWidth: Math.abs(longStrike - shortStrike),
    maxValue: Math.abs(longStrike - shortStrike) * 100,
    legs: [
      {
        action: 'initial',
        quantity: 1,
        type: 'P',
        strike: longStrike,
        cost: longCost,
        originalString: `1p${longStrike}@${longCost}`
      },
      {
        action: 'initial',
        quantity: -1,
        type: 'P',
        strike: shortStrike,
        cost: shortCost,
        originalString: `-1p${shortStrike}@${shortCost}`
      }
    ]
  };
}

// Helper function to display chain data sample
function displayChainDataSample(chainData, expiration = '2026-03-31') {
  console.log('\n📊 Static SPX Chain Data (Expiration: ' + expiration + ')');
  console.log('─'.repeat(80));
  console.log('  Assumed underlying price: $6850 (SPX)');
  console.log('  Strike interval: 25 points (SPX range), 50 points (NDX range)');
  
  // Display call options
  const callStrikes = Object.keys(chainData.call[expiration] || {}).map(k => parseFloat(k)).sort((a, b) => a - b);
  console.log('\n  CALL OPTIONS (' + callStrikes.length + ' strikes):');
  console.log('  Strike    Bid      Ask      Mid      Moneyness');
  console.log('  ───────────────────────────────────────────────');
  
  callStrikes.forEach(strike => {
    const data = chainData.call[expiration][`${strike}.0`][0];
    const mid = ((data.bid + data.ask) / 2).toFixed(2);
    const moneyness = strike - 6850;
    const moneynessLabel = moneyness < 0 ? `${Math.abs(moneyness)} ITM` : moneyness > 0 ? `${moneyness} OTM` : 'ATM';
    console.log(`  ${strike.toString().padEnd(8)} $${data.bid.toFixed(2).padEnd(7)} $${data.ask.toFixed(2).padEnd(7)} $${mid.padEnd(8)} ${moneynessLabel}`);
  });
  
  // Display put options
  const putStrikes = Object.keys(chainData.put[expiration] || {}).map(k => parseFloat(k)).sort((a, b) => a - b);
  console.log('\n  PUT OPTIONS (' + putStrikes.length + ' strikes):');
  console.log('  Strike    Bid      Ask      Mid      Moneyness');
  console.log('  ───────────────────────────────────────────────');
  
  putStrikes.forEach(strike => {
    const data = chainData.put[expiration][`${strike}.0`][0];
    const mid = ((data.bid + data.ask) / 2).toFixed(2);
    const moneyness = 6850 - strike;
    const moneynessLabel = moneyness < 0 ? `${Math.abs(moneyness)} ITM` : moneyness > 0 ? `${moneyness} OTM` : 'ATM';
    console.log(`  ${strike.toString().padEnd(8)} $${data.bid.toFixed(2).padEnd(7)} $${data.ask.toFixed(2).padEnd(7)} $${mid.padEnd(8)} ${moneynessLabel}`);
  });
  
  console.log('\n─'.repeat(20) + '\n');
}

// Test suite
const runner = new TestRunner();
const offsetManager = new OffsetManager();

// Display static chain data once at the start
const sampleChainData = createStaticChainData();
displayChainDataSample(sampleChainData, '2026-03-31:43');



// Test 1: Bull Call Spread position - test findOffsettingBearPutSpread and findOffsettingBearCallSpread



runner.test('Bull Call Spread position - findOffsettingBearPutSpread & findOffsettingBearCallSpread', () => {
  // Create bull call spread with favorable debit cost to ensure offsets are found
  const position = createBullCallSpread(6800, 6900, 10000, -5000); // Lower cost: $4000 vs $5000
  const chainData = createStaticChainData();
  
  console.log('\n\n\n  📍 Testing Bull Call Spread Position');
  console.log('  Initial Position:', JSON.stringify({
    strategy: position.strategy,
    cost: position.cost,
    offsetBudget: position.offsetBudget,
    spreadWidth: position.spreadWidth,
    strikes: position.legs.map(l => `${l.quantity}${l.type}@${l.strike}`)
  }, null, 2));
  
  // Test findOffsettingBearPutSpread
  console.log('\n  Testing findOffsettingBearPutSpread:');
  const bearPutResult = offsetManager.findOffsettingBearPutSpread(position, chainData);
  console.log(`    Found ${bearPutResult.possibleOffsets.length} bear put spread offsets`);
  if (bearPutResult.possibleOffsets.length > 0) {
    //console.log('    Top 5 bear put offsets:');
    bearPutResult.possibleOffsets.slice(0, 5).forEach((offset, i) => {
      console.log(`      ${i+1}. ${offset.description || offset.strategy}`);
      console.log(`         Cost: ${offset.cost?.toFixed(0)}, Locked: ${offset.lockedInProfit?.toFixed(0)}, Potential: ${offset.profitPotential?.toFixed(0)}`);
    });
    if (bearPutResult.possibleOffsets.length > 5) {
      //console.log('    Every 5th bear put offset (up to 20 total):');
      for (let i = 9; i < Math.min(bearPutResult.possibleOffsets.length, 100); i += 10) {
        const offset = bearPutResult.possibleOffsets[i];
        console.log(`      ${i + 1}. ${offset.description || offset.strategy}`);
        console.log(`         Cost: ${offset.cost?.toFixed(0)}, Locked: ${offset.lockedInProfit?.toFixed(0)}, Potential: ${offset.profitPotential?.toFixed(0)}`);
      }
    }
  }
  
  // Test findOffsettingBearCallSpread
  console.log('\n  Testing findOffsettingBearCallSpread:');
  const bearCallResult = offsetManager.findOffsettingBearCallSpread(position, chainData);
  console.log(`    Found ${bearCallResult.possibleOffsets.length} bear call spread offsets`);
  if (bearCallResult.possibleOffsets.length > 0) {
    //console.log('    Top 5 bear call offsets:');
    bearCallResult.possibleOffsets.slice(0, 5).forEach((offset, i) => {
      console.log(`      ${i+1}. ${offset.description || offset.strategy}`);
      console.log(`         Cost: ${offset.cost?.toFixed(0)}, Locked: ${offset.lockedInProfit?.toFixed(0)}, Potential: ${offset.profitPotential?.toFixed(0)}`);
    });
    if (bearCallResult.possibleOffsets.length > 5) {
      //console.log('    Every 5th bear call offset (up to 20 total):');
      for (let i = 9; i < Math.min(bearCallResult.possibleOffsets.length, 100); i += 10) {
        const offset = bearCallResult.possibleOffsets[i];
        console.log(`      ${i + 1}. ${offset.description || offset.strategy}`);
        console.log(`         Cost: ${offset.cost?.toFixed(0)}, Locked: ${offset.lockedInProfit?.toFixed(0)}, Potential: ${offset.profitPotential?.toFixed(0)}`);
      }
    }
  }
  
  // Assertions
  assertExists(bearPutResult, 'Bear put result should exist');
  assertExists(bearCallResult, 'Bear call result should exist');
  assertGreaterThan(bearPutResult.possibleOffsets.length, 0, 'Should find bear put spread offsets');
  assertGreaterThan(bearCallResult.possibleOffsets.length, 0, 'Should find bear call spread offsets');
});




// Test 2: Bear Put Spread position - test findOffsettingBullCallSpread and findOffsettingBullPutSpread



runner.test('Bear Put Spread position - findOffsettingBullCallSpread & findOffsettingBullPutSpread', () => {
  // Create bear put spread with favorable cost to ensure offsets are found
  const position = createBearPutSpread(7000, 6900, 10000, -7000); // Lower cost: $2000 vs $3000
  const chainData = createStaticChainData();
  
  console.log('\n\n\n  📍 Testing Bear Put Spread Position');
  console.log('  Initial Position:', JSON.stringify({
    strategy: position.strategy,
    cost: position.cost,
    offsetBudget: position.offsetBudget,
    spreadWidth: position.spreadWidth,
    strikes: position.legs.map(l => `${l.quantity}${l.type}@${l.strike}`)
  }, null, 2));
  
  // Test findOffsettingBullCallSpread
  console.log('\n  Testing findOffsettingBullCallSpread:');
  const bullCallResult = offsetManager.findOffsettingBullCallSpread(position, chainData);
  console.log(`    Found ${bullCallResult.possibleOffsets.length} bull call spread offsets`);
  if (bullCallResult.possibleOffsets.length > 0) {
    //console.log('    Top 5 bull call offsets:');
    bullCallResult.possibleOffsets.slice(0, 5).forEach((offset, i) => {
      console.log(`      ${i+1}. ${offset.description || offset.strategy}`);
      console.log(`         Cost: ${offset.cost?.toFixed(0)}, Locked: ${offset.lockedInProfit?.toFixed(0)}, Potential: ${offset.profitPotential?.toFixed(0)}`);
    });
    if (bullCallResult.possibleOffsets.length > 5) {
      //console.log('    Every 5th bull call offset (up to 20 total):');
      for (let i = 9; i < Math.min(bullCallResult.possibleOffsets.length, 100); i += 10) {
        const offset = bullCallResult.possibleOffsets[i];
        console.log(`      ${i + 1}. ${offset.description || offset.strategy}`);
        console.log(`         Cost: ${offset.cost?.toFixed(0)}, Locked: ${offset.lockedInProfit?.toFixed(0)}, Potential: ${offset.profitPotential?.toFixed(0)}`);
      }
    }
  }
  
  // Test findOffsettingBullPutSpread
  console.log('\n  Testing findOffsettingBullPutSpread:');
  const bullPutResult = offsetManager.findOffsettingBullPutSpread(position, chainData);
  console.log(`    Found ${bullPutResult.possibleOffsets.length} bull put spread offsets`);
  if (bullPutResult.possibleOffsets.length > 0) {
    //console.log('    Top 5 bull put offsets:');
    bullPutResult.possibleOffsets.slice(0, 5).forEach((offset, i) => {
      console.log(`      ${i+1}. ${offset.description || offset.strategy}`);
      console.log(`         Cost: ${offset.cost?.toFixed(0)}, Locked: ${offset.lockedInProfit?.toFixed(0)}, Potential: ${offset.profitPotential?.toFixed(0)}`);
    });
    if (bullPutResult.possibleOffsets.length > 5) {
      //console.log('    Every 5th bull put offset (up to 20 total):');
      for (let i = 9; i < Math.min(bullPutResult.possibleOffsets.length, 100); i += 10) {
        const offset = bullPutResult.possibleOffsets[i];
        console.log(`      ${i + 1}. ${offset.description || offset.strategy}`);
        console.log(`         Cost: ${offset.cost?.toFixed(0)}, Locked: ${offset.lockedInProfit?.toFixed(0)}, Potential: ${offset.profitPotential?.toFixed(0)}`);
      }
    }
  }
  
  // Assertions
  assertExists(bullCallResult, 'Bull call result should exist');
  assertExists(bullPutResult, 'Bull put result should exist');
  assertGreaterThan(bullCallResult.possibleOffsets.length, 0, 'Should find bull call spread offsets');
  assertGreaterThan(bullPutResult.possibleOffsets.length, 0, 'Should find bull put spread offsets');
});




// Test 3: Bear Call Spread position - test findOffsettingBullPutSpread and findOffsettingBullCallSpread



runner.test('Bear Call Spread position - findOffsettingBullPutSpread & findOffsettingBullCallSpread', () => {
  // Create bear call spread with reasonable credit (20% higher than spread value)
  const position = createBearCallSpread(7000, 7100, -10000, 4000); // Credit: -$6000, offset budget: $4000
  const chainData = createStaticChainData();
  
  console.log('\n\n\n  📍 Testing Bear Call Spread Position');
  console.log('  Initial Position:', JSON.stringify({
    strategy: position.strategy,
    cost: position.cost,
    offsetBudget: position.offsetBudget,
    spreadWidth: position.spreadWidth,
    strikes: position.legs.map(l => `${l.quantity}${l.type}@${l.strike}`)
  }, null, 2));
  
  // Test findOffsettingBullPutSpread with debug info
  console.log('\n  Testing findOffsettingBullPutSpread:');
  console.log(`    Position reference strike (should be short call): ${Math.min(...position.legs.map(l => l.strike))}`);
  console.log(`    Position offset budget: $${position.offsetBudget}`);
  console.log(`    Chain data put keys: ${Object.keys(chainData.put)}`);
  console.log(`    Chain data has put options: ${!!chainData.put}`);
  console.log(`    Chain data put options type: ${typeof chainData.put}`);
  
  const referenceStrike = Math.min(...position.legs.map(l => l.strike));
  const allPutStrikes = Object.keys(chainData.put['2026-03-31:43'] || chainData.put[Object.keys(chainData.put)[0]] || {}).map(k => parseFloat(k));
  const availablePutStrikes = allPutStrikes.filter(s => s < referenceStrike);
  console.log(`    All put strikes count: ${allPutStrikes.length}`);
  console.log(`    Available put strikes below reference: ${availablePutStrikes.slice(0, 10)}`);
  console.log(`    Available put strikes count: ${availablePutStrikes.length}`);
  
  let bullPutResult;
  try {
    bullPutResult = offsetManager.findOffsettingBullPutSpread(position, chainData);
    console.log(`    Offset manager call successful`);
  } catch (error) {
    console.log(`    Offset manager error: ${error.message}`);
    throw error;
  }
  console.log(`    Found ${bullPutResult.possibleOffsets.length} bull put spread offsets`);
  if (bullPutResult.possibleOffsets.length > 0) {
    //console.log('    Top 5 bull put offsets:');
    bullPutResult.possibleOffsets.slice(0, 5).forEach((offset, i) => {
      console.log(`      ${i+1}. ${offset.description || offset.strategy}`);
      console.log(`         Cost: ${offset.cost?.toFixed(0)}, Locked: ${offset.lockedInProfit?.toFixed(0)}, Potential: ${offset.profitPotential?.toFixed(0)}`);
    });
    if (bullPutResult.possibleOffsets.length > 5) {
      //console.log('    Every 5th bull put offset (up to 20 total):');
      for (let i = 9; i < Math.min(bullPutResult.possibleOffsets.length, 100); i += 10) {
        const offset = bullPutResult.possibleOffsets[i];
        console.log(`      ${i + 1}. ${offset.description || offset.strategy}`);
        console.log(`         Cost: ${offset.cost?.toFixed(0)}, Locked: ${offset.lockedInProfit?.toFixed(0)}, Potential: ${offset.profitPotential?.toFixed(0)}`);
      }
    }
  } else {
    console.log('    ⚠️  No bull put offsets found - manual check:');
    console.log(`    availablePutStrikes.length: ${availablePutStrikes.length}`);
    if (availablePutStrikes.length > 0) {
      const testStrike = availablePutStrikes[0];
      const longStrike = testStrike - 100;
      const putData = chainData.put['2026-03-31:43'];
      
      console.log(`    Test strike: ${testStrike}, Long strike: ${longStrike}`);
      console.log(`    putData keys available: ${Object.keys(putData).slice(0, 10)}`);
      console.log(`    Short strike data exists: ${!!putData[`${testStrike}.0`]}`);
      console.log(`    Long strike data exists: ${!!putData[`${longStrike}.0`]}`);
      
      if (putData[`${testStrike}.0`] && putData[`${longStrike}.0`]) {
        const shortCredit = (putData[`${testStrike}.0`][0].bid + putData[`${testStrike}.0`][0].ask) / 2;
        const longCost = (putData[`${longStrike}.0`][0].bid + putData[`${longStrike}.0`][0].ask) / 2;
        const spreadCredit = (shortCredit - longCost) * 100;
        
        console.log(`      Test spread ${testStrike}/${longStrike}:`);
        console.log(`        Short credit: $${shortCredit.toFixed(2)}, Long cost: $${longCost.toFixed(2)}`);
        console.log(`        Spread credit: $${spreadCredit.toFixed(2)}, Budget: $${position.offsetBudget}`);
        console.log(`        Within budget: ${spreadCredit <= position.offsetBudget}`);
        console.log(`        Spread credit positive: ${spreadCredit > 0}`);
      }
    }
  }
  
  // Test findOffsettingBullCallSpread
  console.log('\n  Testing findOffsettingBullCallSpread:');
  console.log(`    Position offset budget: $${position.offsetBudget}`);
  console.log(`    Looking for bull call spreads with spreadWidth: ${position.spreadWidth}`);
  const bullCallResult = offsetManager.findOffsettingBullCallSpread(position, chainData);
  console.log(`    Found ${bullCallResult.possibleOffsets.length} bull call spread offsets`);
  if (bullCallResult.possibleOffsets.length > 0) {
    //console.log('    Top 5 bull call offsets:');
    bullCallResult.possibleOffsets.slice(0, 5).forEach((offset, i) => {
      console.log(`      ${i+1}. ${offset.description || offset.strategy}`);
      console.log(`         Cost: ${offset.cost?.toFixed(0)}, Locked: ${offset.lockedInProfit?.toFixed(0)}, Potential: ${offset.profitPotential?.toFixed(0)}`);
    });
    if (bullCallResult.possibleOffsets.length > 5) {
      //console.log('    Every 5th bull call offset (up to 20 total):');
      for (let i = 9; i < Math.min(bullCallResult.possibleOffsets.length, 100); i += 10) {
        const offset = bullCallResult.possibleOffsets[i];
        console.log(`      ${i + 1}. ${offset.description || offset.strategy}`);
        console.log(`         Cost: ${offset.cost?.toFixed(0)}, Locked: ${offset.lockedInProfit?.toFixed(0)}, Potential: ${offset.profitPotential?.toFixed(0)}`);
      }
    }
  }
  
  // Assertions
  assertExists(bullPutResult, 'Bull put result should exist');
  assertExists(bullCallResult, 'Bull call result should exist');
  assertGreaterThan(bullCallResult.possibleOffsets.length, 0, 'Should find bull call spread offsets');
  assertGreaterThan(bullPutResult.possibleOffsets.length, 0, 'Should find bull put spread offsets');
});




// Test 4: Bull Put Spread position - test findOffsettingBearCallSpread and findOffsettingBearPutSpread



runner.test('Bull Put Spread position - findOffsettingBearCallSpread & findOffsettingBearPutSpread', () => {
  // Create bull put spread with favorable credit to ensure offsets are found
  const position = createBullPutSpread(6850, 6750, -10000, 5000); // Higher credit: -$5000 vs -$4000
  const chainData = createStaticChainData();
  
  console.log('\n\n\n  📍 Testing Bull Put Spread Position');
  console.log('  Initial Position:', JSON.stringify({
    strategy: position.strategy,
    cost: position.cost,
    offsetBudget: position.offsetBudget,
    spreadWidth: position.spreadWidth,
    strikes: position.legs.map(l => `${l.quantity}${l.type}@${l.strike}`)
  }, null, 2));
  
  // Test findOffsettingBearCallSpread
  console.log('\n  Testing findOffsettingBearCallSpread:');
  const bearCallResult = offsetManager.findOffsettingBearCallSpread(position, chainData);
  console.log(`    Found ${bearCallResult.possibleOffsets.length} bear call spread offsets`);
  if (bearCallResult.possibleOffsets.length > 0) {
    //console.log('    Top 5 bear call offsets:');
    bearCallResult.possibleOffsets.slice(0, 5).forEach((offset, i) => {
      console.log(`      ${i+1}. ${offset.description || offset.strategy}`);
      console.log(`         Cost: ${offset.cost?.toFixed(0)}, Locked: ${offset.lockedInProfit?.toFixed(0)}, Potential: ${offset.profitPotential?.toFixed(0)}`);
    });
    if (bearCallResult.possibleOffsets.length > 5) {
      //console.log('    Every 5th bear call offset (up to 20 total):');
      for (let i = 9; i < Math.min(bearCallResult.possibleOffsets.length, 100); i += 10) {
        const offset = bearCallResult.possibleOffsets[i];
        console.log(`      ${i + 1}. ${offset.description || offset.strategy}`);
        console.log(`         Cost: ${offset.cost?.toFixed(0)}, Locked: ${offset.lockedInProfit?.toFixed(0)}, Potential: ${offset.profitPotential?.toFixed(0)}`);
      }
    }
  }
  
  // Test findOffsettingBearPutSpread
  console.log('\n  Testing findOffsettingBearPutSpread:');
  const bearPutResult = offsetManager.findOffsettingBearPutSpread(position, chainData);
  console.log(`    Found ${bearPutResult.possibleOffsets.length} bear put spread offsets`);
  if (bearPutResult.possibleOffsets.length > 0) {
    //console.log('    Top 5 bear put offsets:');
    bearPutResult.possibleOffsets.slice(0, 5).forEach((offset, i) => {
      console.log(`      ${i+1}. ${offset.description || offset.strategy}`);
      console.log(`         Cost: ${offset.cost?.toFixed(0)}, Locked: ${offset.lockedInProfit?.toFixed(0)}, Potential: ${offset.profitPotential?.toFixed(0)}`);
    });
    if (bearPutResult.possibleOffsets.length > 5) {
      //console.log('    Every 5th bear put offset (up to 20 total):');
      for (let i = 9; i < Math.min(bearPutResult.possibleOffsets.length, 100); i += 10) {
        const offset = bearPutResult.possibleOffsets[i];
        console.log(`      ${i + 1}. ${offset.description || offset.strategy}`);
        console.log(`         Cost: ${offset.cost?.toFixed(0)}, Locked: ${offset.lockedInProfit?.toFixed(0)}, Potential: ${offset.profitPotential?.toFixed(0)}`);
      }
    }
  }
  
  // Assertions
  assertExists(bearCallResult, 'Bear call result should exist');
  assertExists(bearPutResult, 'Bear put result should exist');
  assertGreaterThan(bearCallResult.possibleOffsets.length, 0, 'Should find bear call spread offsets');
  assertGreaterThan(bearPutResult.possibleOffsets.length, 0, 'Should find bear put spread offsets');
});



// Run all tests
runner.run().then(success => {
  process.exit(success ? 0 : 1);
});
