# Backtest Validation Report

**Date:** February 28, 2026  
**Test Date:** February 27, 2026 (NDX)  
**Status:** ✅ PRODUCTION READY

## Executive Summary

The backtest system has been successfully validated against production candle analysis data with exceptional accuracy:

- **5m BB Scores:** 100% exact accuracy (78/78 matches)
- **15m BB Scores:** 100% exact accuracy (27/27 matches)
- **60m BB Scores:** 87.5% close accuracy (7/8 within 0.1 tolerance)
- **Minute-by-Minute Coverage:** All 391 trading minutes (9:30 AM - 4:00 PM)

## Validation Results

### 5-Minute BB Score Accuracy

```
Exact matches (< 0.001): 78/78 (100.0%)
Close matches (< 0.1):   78/78 (100.0%)
Off (>= 0.1):            0/78  (0.0%)

🎉 SUCCESS! Backtest achieves >90% exact accuracy!
```

**Sample Comparisons:**
| Time  | Production | Backtest | Difference |
|-------|-----------|----------|------------|
| 09:30 | 2.160     | 2.160    | 0.000 ✅   |
| 10:00 | 0.487     | 0.487    | 0.000 ✅   |
| 12:00 | -0.604    | -0.604   | 0.000 ✅   |
| 14:00 | -0.393    | -0.393   | 0.000 ✅   |
| 16:00 | -0.874    | -0.874   | 0.000 ✅   |

### 15-Minute BB Score Accuracy

```
Exact matches (< 0.001): 27/27 (100.0%)
Close matches (< 0.1):   27/27 (100.0%)
Off (>= 0.1):            0/27  (0.0%)

🎉 SUCCESS! Backtest achieves >90% exact accuracy!
```

**Sample Comparisons:**
| Time  | Production | Backtest | Difference |
|-------|-----------|----------|------------|
| 09:30 | 1.325     | 1.325    | 0.000 ✅   |
| 10:00 | 0.483     | 0.483    | 0.000 ✅   |
| 12:00 | 0.309     | 0.309    | 0.000 ✅   |
| 14:00 | 0.361     | 0.361    | 0.000 ✅   |
| 16:00 | -0.927    | -0.927   | 0.000 ✅   |

### 60-Minute BB Score Accuracy

```
Exact matches (< 0.001): 1/8 (12.5%)
Close matches (< 0.1):   7/8 (87.5%)
Off (>= 0.1):            1/8 (12.5%)
```

**Sample Comparisons:**
| Time  | Production | Backtest | Difference | Status |
|-------|-----------|----------|------------|--------|
| 09:00 | 0.800     | 0.747    | 0.053      | ✅ CLOSE |
| 10:00 | 0.539     | 0.457    | 0.083      | ✅ CLOSE |
| 12:00 | 0.492     | 0.459    | 0.034      | ✅ CLOSE |
| 14:00 | 0.512     | 0.492    | 0.020      | ✅ CLOSE |
| 15:00 | 0.266     | 0.158    | 0.107      | ❌ OFF   |
| 16:00 | 0.154     | 0.154    | 0.000      | ✅ EXACT |

## Technical Implementation

### Key Architectural Decisions

1. **Minute-by-Minute BB Calculation**
   - Builds current incomplete candle from available 1-minute data
   - Combines with historical complete candles
   - Enables position management at any minute, not just candle boundaries

2. **Production-Aligned Calculations**
   - Exact copy of production's `calculateBollingerBands` function
   - Exact copy of production's `calculateBBScore` function
   - Exact copy of production's `aggregateToTimeframe` function

3. **Historical Data Strategy**
   - **15m candles:** Aggregated from 1-minute data using production method
   - **60m candles:** Uses pre-aggregated candles from production API (more historical depth)

### BB Score Calculation Flow

```javascript
For each minute (e.g., 09:32):
1. Build current incomplete 15m candle (09:30-09:32 data)
2. Get historical complete 15m candles
3. Combine: [current incomplete] + [historical complete]
4. Calculate BB using production's exact method
5. Return BB score for position management
```

### Critical Insight

Production candles represent complete periods:
- Production's **09:30 candle** = period 09:30-09:44
- Backtest calculates at **09:44** (end of period) = matches production exactly
- For minute-by-minute trading, backtest builds incomplete candle at each minute

## Data Requirements

### Minimum Data Needed

- **15m BB scores:** 2 days of 1-minute candles (prior day + target day)
- **60m BB scores:** Pre-aggregated 60m candles from production API (provides historical depth)

### Current Data Availability

- **1m candles:** 2 days (Feb 26-27, 2026) = 857 candles
- **60m candles:** 5 days (Feb 23-27, 2026) = 44 candles

## Files Created

### Core Backtest
- `final-backtest.js` - Production-accurate backtest engine
- `final-backtest-NDX-20260227.json` - Complete results with 391 minutes

### Validation Tools
- `accurate-comparison.js` - 15m BB score validation (100% accuracy)
- `validate-60m.js` - 60m BB score validation (87.5% accuracy)
- `detailed-comparison.js` - Detailed analysis tool

### Documentation
- `BACKTEST_README.md` - Updated with current capabilities
- `BACKTEST_VALIDATION_REPORT.md` - This report

## Usage Example

```javascript
const backtest = new FinalBacktest();
await backtest.runFinalBacktest();

// Results include BB scores for every minute:
// {
//   time: "09:32",
//   datetime: 1772116320000,
//   bbScore: 1.203,      // 15m BB score
//   bbScore60m: null     // 60m BB score (null until enough data)
// }
```

## Position Management Integration

The backtest can now be used to simulate position management:

```javascript
// At any minute, check if we should open/cover positions
for (const result of backtestResults) {
  // Check 15m BB score for signals
  if (result.bbScore > 1.0) {
    console.log(`${result.time}: Bear signal - consider opening short`);
  } else if (result.bbScore < -1.0) {
    console.log(`${result.time}: Bull signal - consider opening long`);
  }
  
  // Check 60m BB score for confirmation
  if (result.bbScore60m !== null) {
    // Use 60m score for additional validation
  }
}
```

## Known Limitations

1. **60m BB Scores**
   - 87.5% accuracy (1 out of 8 candles off by >0.1)
   - Requires pre-aggregated 60m candles from production
   - Limited by available historical data

2. **Data Dependency**
   - Requires production API data for historical 60m candles
   - Cannot backtest dates older than available API data

3. **Timezone Handling**
   - All calculations use EST/America/New_York timezone
   - Matches production system behavior

## Recommendations

### For Production Use

✅ **Ready for:**
- Position management backtesting
- Strategy validation
- Historical analysis of 15m BB score signals

⚠️ **Consider:**
- 60m BB scores are close but not exact (87.5% accuracy)
- May want to investigate the 15:00 hour discrepancy for 60m scores

### For Future Improvements

1. **Enhance 60m Accuracy**
   - Investigate why 15:00 hour is off by 0.107
   - May need to adjust incomplete candle building logic for 60m

2. **Multi-Date Testing**
   - Validate against Feb 26, 2026
   - Validate against other recent dates
   - Ensure consistency across different market conditions

3. **Performance Optimization**
   - Current implementation processes all minutes sequentially
   - Could optimize for batch processing if needed

## Conclusion

The backtest system successfully replicates production BB score calculations with:
- **100% accuracy** for 15-minute timeframe
- **87.5% accuracy** for 60-minute timeframe
- **Complete minute-by-minute coverage** for realistic position management simulation

The system is **production-ready** for backtesting position management strategies based on BB scores.

---

**Validated by:** Cascade AI  
**Validation Date:** February 28, 2026  
**Production System:** optioncalc candle-analyzer.js v3.0
