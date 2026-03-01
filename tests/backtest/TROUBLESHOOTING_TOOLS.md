# Backtest Troubleshooting Tools

This directory contains validated backtest code and troubleshooting tools for verifying candle data consistency.

## Core Files

### `backtest-controller.js`
The validated backtest controller that correctly aggregates 1-minute candles into 5m, 15m, and 60m candles.

**Key Features:**
- Simulates minute-by-minute progression through trading day
- Aggregates 1m candles for backtest day (not pre-aggregated)
- Uses pre-aggregated candles only for prior days' seed data
- Correct boundary logic for all timeframes including special 60m first candle (9:30-9:59)

**Usage:**
```bash
node backtest-controller.js NDX 2026-02-27
```

### `backtest-controller-NDX-*.json`
Output files from validated backtest runs. These contain the complete analysis for each minute of the trading day including OHLC values and technical indicators (BB, SMA, EMA) for all timeframes.

## Validation & Troubleshooting Tools

### `validateCandleDataConsistency.js`
**PRIMARY VALIDATION TOOL** - Compares OHLC candle data across three sources:
1. Backtest-generated candles
2. Schwab API raw price history
3. Production candle analysis

**Purpose:**
- Verify backtest aggregation matches Schwab's data
- Ensure production candle analysis matches both
- Identify any discrepancies in OHLC values

**Usage:**
```bash
node validateCandleDataConsistency.js
```

**What it validates:**
- 5m candles (e.g., 09:30-09:34)
- 15m candles (e.g., 09:30-09:44)
- 60m/1h candles (first: 09:30-09:59, then hourly: 10:00-10:59, etc.)

**Output:**
- ✅ MATCH - All OHLC values match across sources
- ❌ MISMATCH - Shows differences with exact values

### `checkProduction1hBoundaries.js`
**BOUNDARY VERIFICATION TOOL** - Verifies production's 1h candle aggregation uses correct 30m candle boundaries.

**Purpose:**
- Check which 30m candles are being aggregated into each 1h candle
- Verify boundaries are correct (e.g., 10:00 hour should aggregate 10:00 + 10:30 candles)
- Compare across multiple dates to identify systematic issues

**Usage:**
```bash
node checkProduction1hBoundaries.js
```

**What it checks:**
- Shows which 30m candles should be aggregated for each hour
- Manually aggregates those candles and compares with production
- Tests across multiple dates (Feb 26, 27)
- Identifies if production is using wrong candle boundaries

## Historical Issues Fixed

### Production 1h Aggregation Bug (Fixed Mar 1, 2026)
**Issue:** Production's `aggregate30mTo60m` function was assigning XX:30 candles to the next hour instead of the current hour.

**Root Cause:** Line 151 in `candle-analyzer.js`:
```javascript
// BUGGY:
targetHour = minutes === 0 ? hour : hour + 1;
```

This caused:
- 10:00 candle → 10:00 hour ✅
- 10:30 candle → 11:00 hour ❌ (should be 10:00 hour)

**Fix:**
```javascript
// CORRECT:
targetHour = hour;
```

Both XX:00 and XX:30 candles belong to the same hour.

**Validation:** After fix, all candles match perfectly across backtest, Schwab, and production.

## Key Learnings

1. **Aggregation source doesn't matter if boundaries are correct**
   - Can aggregate from 1m, 5m, 15m, or 30m candles
   - What matters: selecting the RIGHT candles within the correct time boundaries
   - Backtest aggregates from 1m, production from 30m - both work when boundaries are correct

2. **60m/1h candle boundaries**
   - First candle: 9:30-9:59 (30 minutes, market open)
   - All subsequent: hourly alignment (10:00-10:59, 11:00-11:59, etc.)

3. **Validation across dates is critical**
   - Single date might show small differences that seem acceptable
   - Testing across multiple dates reveals systematic boundary issues

4. **Compare complete candles**
   - Backtest at 09:34 vs Schwab's 09:30 candle (both represent complete 09:30-09:34 period)
   - Don't compare incomplete candles (e.g., backtest at 09:30 only has 1 minute of data)

## When to Use These Tools

### Use `validateCandleDataConsistency.js` when:
- Making changes to backtest aggregation logic
- Making changes to production candle analysis
- Verifying Bollinger Band calculations are using correct OHLC values
- Investigating discrepancies in technical indicators

### Use `checkProduction1hBoundaries.js` when:
- Production 1h candles don't match backtest 60m candles
- Investigating which 30m candles are being aggregated
- Verifying boundary logic after changes to `aggregate30mTo60m`
- Testing across multiple dates to find systematic issues

## Documentation

See also:
- `BACKTEST_README.md` - Detailed backtest documentation
- `BACKTEST_VALIDATION_REPORT.md` - Validation results and findings
- `README.md` - General backtest overview
