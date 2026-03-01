# Backtest Directory

This directory contains all backtesting tools and validation scripts for the position management system.

## Directory Structure

```
tests/backtest/
├── README.md                           # This file
├── BACKTEST_README.md                  # Detailed backtest documentation
├── BACKTEST_VALIDATION_REPORT.md       # Validation results and report
├── final-backtest.js                   # Production-ready backtest engine
├── validate-5m.js                      # 5m BB score validation (100% accuracy)
├── validate-15m.js                     # 15m BB score validation (100% accuracy)
├── validate-60m.js                     # 60m BB score validation (87.5% accuracy)
├── detailed-comparison.js              # Detailed analysis tool
├── current-ndx-analysis.json           # Production candle data for validation
└── final-backtest-NDX-20260227.json    # Backtest results for Feb 27, 2026
```

## Quick Start

```bash
# Navigate to backtest directory
cd tests/backtest

# Run backtest
node final-backtest.js

# Validate 5m BB scores
node validate-5m.js

# Validate 15m BB scores
node validate-15m.js

# Validate 60m BB scores
node validate-60m.js
```

## File Descriptions

### Core Files

**`final-backtest.js`**
- Production-ready backtest engine
- Calculates BB scores for every minute of the trading day
- Uses production's exact BB calculation methods
- Outputs results to `final-backtest-NDX-20260227.json`

**`current-ndx-analysis.json`**
- Real production candle analysis data
- Used as ground truth for validation
- Contains 1m, 15m, and 60m candles with BB scores

**`final-backtest-NDX-20260227.json`**
- Complete backtest results for Feb 27, 2026
- Contains 391 minutes of BB scores (9:30 AM - 4:00 PM)
- Includes both 15m and 60m BB scores

### Validation Tools

**`validate-15m.js`**
- Validates 15m BB scores against production
- Shows 100% exact accuracy (27/27 matches)
- Compares backtest results at 15-minute boundaries

**`validate-60m.js`**
- Validates 60m BB scores against production
- Shows 87.5% close accuracy (7/8 within 0.1 tolerance)
- Compares backtest results at hourly boundaries

**`detailed-comparison.js`**
- Provides detailed minute-by-minute comparison
- Shows differences and match percentages
- Useful for debugging and analysis

### Documentation

**`BACKTEST_README.md`**
- Comprehensive backtest documentation
- Explains the architecture and approach
- Includes usage examples

**`BACKTEST_VALIDATION_REPORT.md`**
- Official validation report
- Documents accuracy results
- Technical implementation details
- Production readiness assessment

## Validation Results

### 5-Minute BB Scores
✅ **100% exact accuracy** (78/78 matches)

### 15-Minute BB Scores
✅ **100% exact accuracy** (27/27 matches)

### 60-Minute BB Scores
✅ **87.5% close accuracy** (7/8 within 0.1 tolerance)

## Adding New Backtest Files

All new backtest-related files should be placed in this directory:
- Use `__dirname` for file paths within scripts
- Follow the naming convention: `[purpose]-[symbol]-[date].js` or `.json`
- Update this README when adding new files

## Notes

- All scripts use `__dirname` for relative paths
- No production code is modified by these scripts
- Backtest data is separate from production data
- Safe to run without affecting live system
