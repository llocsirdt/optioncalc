# Indicator Validation

This document explains how to validate that indicator values (SMA, EMA, Bollinger Bands) match between the backtest and production candle analysis.

## Overview

The backtest and production systems now use the **exact same functions** for calculating indicators:
- `calculateSMA()` - Simple Moving Average
- `calculateEMA()` - Exponential Moving Average  
- `calculateBollingerBands()` - Bollinger Bands (upper, middle, lower)
- `calculateBBScore()` - BB Score calculation

Since both systems use identical code, their indicator values should match at complete candle boundaries.

## Complete Candle Boundaries

Indicators can only be compared when both systems have **complete candles** at the same timestamp:

| Timeframe | Complete Boundaries | Example Timestamps |
|-----------|-------------------|-------------------|
| 5m | Every 5 minutes | 9:30, 9:35, 9:40, 9:45, 10:00, ... |
| 15m | Every 15 minutes | 9:30, 9:45, 10:00, 10:15, 10:30, ... |
| 60m/1h | Hourly (after first candle) | 9:30, 10:00, 11:00, 12:00, ... |

**Why?** The backtest simulates minute-by-minute progression. At 9:32, the 5m candle (9:30-9:34) is incomplete. Production only stores indicators for complete candles.

## Validation Script

### Prerequisites

1. **API credentials configured** in `.env` file (same as `validateCandleDataConsistency.js`)
2. **Backtest must be completed** for the date you want to validate

### Run Validation

Compare indicator values between backtest and production candle analysis:

```bash
cd tests/backtest
node validateIndicators.js
```

The script will:
1. Load backtest results from `backtest-controller-NDX-2026-02-27.json`
2. Call `analyzeCandles()` directly (same as `validateCandleDataConsistency.js`)
3. Compare indicators at complete candle boundaries for each timeframe
4. Report matches/mismatches

**Note:** This calls `analyzeCandles()` directly (not the API endpoint) to ensure it's comparing against the same data source that `validateCandleDataConsistency.js` validated.

### Expected Output

```
📊 Validating 5m indicators at 5-minute boundaries
================================================================================
🔍 Found 78 complete 5m candle boundaries in backtest data

📈 Results for 5m:
   Total tests: 78
   Passed: 78
   Failed: 0
   ✅ All indicators match!

📊 Validating 15m indicators at 15-minute boundaries
================================================================================
...

📊 Overall Summary
================================================================================
   5m: 78/78 passed (100.0%)
   15m: 26/26 passed (100.0%)
   60m: 7/7 passed (100.0%)

   Overall: 111/111 passed (100.0%)

✅ All indicator values match between backtest and production!
```

## What Gets Compared

For each complete candle boundary, the script compares:

| Indicator | Description | Tolerance |
|-----------|-------------|-----------|
| SMA | 20-period Simple Moving Average | 0.0001 |
| EMA | 10-period Exponential Moving Average | 0.0001 |
| BB Upper | Upper Bollinger Band | 0.0001 |
| BB Middle | Middle Bollinger Band (same as SMA) | 0.0001 |
| BB Lower | Lower Bollinger Band | 0.0001 |
| BB Score | Normalized position within bands | 0.001 |

**Tolerance:** Small floating-point differences are allowed due to JavaScript number precision.

## Troubleshooting

### "Failed to fetch production analysis"

Ensure the production server is running:
```bash
cd server
npm start
```

The server should be accessible at `http://localhost:3001`

### Mismatches Found

If indicators don't match, check:

1. **Are you comparing the right dates?** Backtest and production analysis must be for the same date
2. **Did you run backtest after the refactoring?** Old backtest files used different indicator functions
3. **Is production using the latest code?** Restart the server to ensure it's using updated functions

## Files

| File | Purpose | Gitignored? |
|------|---------|-------------|
| `validateIndicators.js` | Main validation script | No |
| `backtest-controller-NDX-*.json` | Backtest output | Yes |
| `INDICATOR_VALIDATION.md` | This documentation | No |

## Why This Matters

Validating that indicators match ensures:
- ✅ Backtest uses **exact production code**
- ✅ No drift between backtest and production implementations
- ✅ Backtest results are **truly representative** of production behavior
- ✅ Strategy testing validates the **actual trading logic**

This is critical for confidence that backtest results will translate to production performance.
