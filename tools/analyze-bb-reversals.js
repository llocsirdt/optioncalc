const fs = require('fs');
const path = require('path');

/**
 * Analyze historical backtest data to count days with BB band reversal pattern:
 * - Open below 5m or 15m lower BB band, then close above the open
 * - OR open above 5m or 15m upper BB band, then close below the open
 */

const dataDir = path.join(__dirname, '..', 'tests', 'backtest', 'backtest-data');
const files = fs.readdirSync(dataDir).filter(f => f.startsWith('backtest-NDX-') && f.endsWith('.json'));

// Output to markdown file
const outputPath = path.join(__dirname, 'analysis-bb-reversals.md');
const lines = [];
const log = (msg) => lines.push(msg);

log(`# BB Band Reversal Analysis`);
log(``);
log(`**Analysis Date:** ${new Date().toISOString().split('T')[0]}`);
log(`**Files Found:** ${files.length}`);
log(`**Symbol:** NDX`);
log(``);

const reversalDays = [];
const nonReversalOutsideDays = []; // Opened outside BB but didn't reverse
const insideBandDays = []; // Opened inside BB bands

// Track three categories for outside BB opens
const outside5mOnly = []; // Outside 5m only, inside 15m
const outside15mOnly = []; // Outside 15m only, inside 5m
const outsideBoth = []; // Outside both 5m and 15m

const analyzedDays = [];
const skippedDates = []; // Dates without data

for (const file of files) {
  const filePath = path.join(dataDir, file);
  const date = file.match(/backtest-NDX-(\d{4}-\d{2}-\d{2})\.json/)[1];
  
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    
    if (!Array.isArray(data) || data.length === 0) {
      skippedDates.push(date);
      continue;
    }
    
    // Find the 9:30 candle (first candle of the day)
    const firstCandle = data.find(r => r.timestamp === '09:30');
    
    if (!firstCandle) {
      skippedDates.push(date);
      continue;
    }
    
    // Find the 15:59 candle (last candle of the day)
    const lastCandle = data.find(r => r.timestamp === '15:59');
    
    if (!lastCandle) {
      skippedDates.push(date);
      continue;
    }
    
    // Get 5m and 15m BB data for 9:30
    const bb5m = firstCandle.analysis['5m'];
    const bb15m = firstCandle.analysis['15m'];
    
    if (!bb5m || !bb15m) {
      skippedDates.push(date);
      continue;
    }
    
    const openPrice = firstCandle.analysis['1m'].close; // Using 1m close as the price at 9:30
    const dayClosePrice = lastCandle.analysis['1m'].close; // Last candle of the day (16:00)
    
    // Check pattern 1: Open below lower band, close above open
    const below5mLower = openPrice < bb5m.bblower;
    const below15mLower = openPrice < bb15m.bblower;
    const closeAboveOpen = dayClosePrice > openPrice;
    
    // Check pattern 2: Open above upper band, close below open
    const above5mUpper = openPrice > bb5m.bbupper;
    const above15mUpper = openPrice > bb15m.bbupper;
    const closeBelowOpen = dayClosePrice < openPrice;
    
    const pattern1 = (below5mLower || below15mLower) && closeAboveOpen;
    const pattern2 = (above5mUpper || above15mUpper) && closeBelowOpen;
    
    // Check if opened outside BB but didn't reverse
    const outsideBelowNoReverse = (below5mLower || below15mLower) && !closeAboveOpen;
    const outsideAboveNoReverse = (above5mUpper || above15mUpper) && !closeBelowOpen;
    const outsideNoReverse = outsideBelowNoReverse || outsideAboveNoReverse;
    
    // Check if opened inside BB bands
    const inside5m = openPrice >= bb5m.bblower && openPrice <= bb5m.bbupper;
    const inside15m = openPrice >= bb15m.bblower && openPrice <= bb15m.bbupper;
    const insideBands = inside5m || inside15m;
    
    // Categorize by which BB bands were outside
    let category = null;
    if (!inside5m && inside15m) {
      category = '5m_only';
    } else if (inside5m && !inside15m) {
      category = '15m_only';
    } else if (!inside5m && !inside15m) {
      category = 'both';
    }
    
    const isReversal = pattern1 || pattern2;
    
    analyzedDays.push({
      date,
      openPrice,
      dayClosePrice,
      bb5m: { upper: bb5m.bbupper, lower: bb5m.bblower },
      bb15m: { upper: bb15m.bbupper, lower: bb15m.bblower },
      pattern1: pattern1 ? '✅' : '❌',
      pattern2: pattern2 ? '✅' : '❌',
      isReversal,
      outsideNoReverse,
      insideBands
    });
    
    if (isReversal) {
      reversalDays.push({
        date,
        openPrice,
        dayClosePrice,
        dailyChange: dayClosePrice - openPrice,
        pattern1,
        pattern2,
        reason: pattern1 ? 'Below BB, closed above' : 'Above BB, closed below',
        category
      });
      // Add to category-specific arrays
      if (category === '5m_only') {
        outside5mOnly.push({ date, reversed: true, dailyChange: dayClosePrice - openPrice });
      } else if (category === '15m_only') {
        outside15mOnly.push({ date, reversed: true, dailyChange: dayClosePrice - openPrice });
      } else if (category === 'both') {
        outsideBoth.push({ date, reversed: true, dailyChange: dayClosePrice - openPrice });
      }
    } else if (outsideNoReverse) {
      nonReversalOutsideDays.push({
        date,
        openPrice,
        dayClosePrice,
        dailyChange: dayClosePrice - openPrice,
        reason: outsideBelowNoReverse ? 'Below BB, closed below' : 'Above BB, closed above',
        category
      });
      // Add to category-specific arrays
      if (category === '5m_only') {
        outside5mOnly.push({ date, reversed: false, dailyChange: dayClosePrice - openPrice });
      } else if (category === '15m_only') {
        outside15mOnly.push({ date, reversed: false, dailyChange: dayClosePrice - openPrice });
      } else if (category === 'both') {
        outsideBoth.push({ date, reversed: false, dailyChange: dayClosePrice - openPrice });
      }
    } else if (insideBands) {
      insideBandDays.push({
        date,
        openPrice,
        dayClosePrice,
        dailyChange: dayClosePrice - openPrice
      });
    }
    
  } catch (error) {
    skippedDates.push(date);
  }
}

log(`\n## Dates Analyzed`);
log(``);
log(`**Total files found:** ${files.length}`);
log(`**Dates analyzed:** ${analyzedDays.length}`);
log(`**Dates skipped (no data):** ${skippedDates.length}`);
log(``);
log(`### Analyzed Dates (${analyzedDays.length})`);
log(``);
analyzedDays.forEach(day => {
  const status = day.isReversal ? '✅ Reversal' : day.outsideNoReverse ? '⚠️ Outside BB (no reversal)' : '➖ Inside BB';
  log(`- ${day.date}: ${status}`);
});

if (skippedDates.length > 0) {
  log(``);
  log(`### Skipped Dates (${skippedDates.length})`);
  log(``);
  skippedDates.forEach(date => {
    log(`- ${date}: No data`);
  });
}

log(`\n---`);
log(`\n## BB Band Reversal Analysis Summary`);
log(``);
log(`**Total days analyzed:** ${analyzedDays.length}`);
log(`**Days with reversal pattern:** ${reversalDays.length} (${((reversalDays.length / analyzedDays.length) * 100).toFixed(1)}%)`);
log(`**Days opened outside BB but no reversal:** ${nonReversalOutsideDays.length} (${((nonReversalOutsideDays.length / analyzedDays.length) * 100).toFixed(1)}%)`);
log(`**Days opened inside BB bands:** ${insideBandDays.length} (${((insideBandDays.length / analyzedDays.length) * 100).toFixed(1)}%)`);

log(`\n---`);
log(`\n## Breakdown by BB Band Category`);
log(``);

// Calculate reversal rates for each category
const calcReversalRate = (arr) => {
  const reversed = arr.filter(d => d.reversed).length;
  const total = arr.length;
  return total > 0 ? `${reversed}/${total} (${((reversed/total)*100).toFixed(1)}%)` : '0/0 (0%)';
};

const calcAvgChange = (arr, reversed) => {
  const filtered = arr.filter(d => d.reversed === reversed);
  if (filtered.length === 0) return 'N/A';
  const avg = filtered.reduce((sum, d) => sum + d.dailyChange, 0) / filtered.length;
  return avg.toFixed(2) + ' pts';
};

log(`### 1️⃣  Outside 5m BB only (inside 15m): ${outside5mOnly.length} days`);
log(`- Reversal rate: ${calcReversalRate(outside5mOnly)}`);
log(`- Avg change when reversed: ${calcAvgChange(outside5mOnly, true)}`);
log(`- Avg change when no reversal: ${calcAvgChange(outside5mOnly, false)}`);

log(`\n### 2️⃣  Outside 15m BB only (inside 5m): ${outside15mOnly.length} days`);
log(`- Reversal rate: ${calcReversalRate(outside15mOnly)}`);
log(`- Avg change when reversed: ${calcAvgChange(outside15mOnly, true)}`);
log(`- Avg change when no reversal: ${calcAvgChange(outside15mOnly, false)}`);

log(`\n### 3️⃣  Outside both 5m and 15m BB: ${outsideBoth.length} days`);
log(`- Reversal rate: ${calcReversalRate(outsideBoth)}`);
log(`- Avg change when reversed: ${calcAvgChange(outsideBoth, true)}`);
log(`- Avg change when no reversal: ${calcAvgChange(outsideBoth, false)}`);

if (reversalDays.length > 0) {
  log(`\n---`);
  log(`\n## Reversal Days Details`);
  log(``);
  log(`| Date | Direction | Open | Close | Change | Pattern | Category |`);
  log(`|------|-----------|------|-------|--------|----------|----------|`);
  reversalDays.forEach(day => {
    const arrow = day.dailyChange > 0 ? '📈' : '📉';
    const direction = day.dailyChange > 0 ? 'Up' : 'Down';
    log(`| ${day.date} | ${arrow} ${direction} | ${day.openPrice.toFixed(2)} | ${day.dayClosePrice.toFixed(2)} | ${day.dailyChange.toFixed(2)} pts | ${day.reason} | ${day.category} |`);
  });
  
  const avgChange = reversalDays.reduce((sum, d) => sum + d.dailyChange, 0) / reversalDays.length;
  log(`\n**Average daily change on reversal days:** ${avgChange.toFixed(2)} pts`);
}

// Write results to markdown file
fs.writeFileSync(outputPath, lines.join('\n'), 'utf8');
console.log(`\n✅ Analysis results saved to: ${outputPath}`);
