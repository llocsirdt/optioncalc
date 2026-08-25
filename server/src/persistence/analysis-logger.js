#!/usr/bin/env node

/**
 * Analysis Data Logger
 * 
 * Logs real-time position analysis data in the same format as backtest data files
 * for debugging and comparison purposes.
 */

const fs = require('fs').promises;
const path = require('path');

const ANALYSIS_DATA_DIR = path.join(__dirname);

class AnalysisLogger {
  constructor() {
    // Map of symbol-date to analysis data array
    this.analysisData = new Map();
  }

  /**
   * Log a position check cycle's analysis data
   * Ensures one entry per minute, matching backtest format
   * 
   * @param {string} symbol - Symbol (e.g., 'NDX', 'SPX')
   * @param {string} date - Date in YYYY-MM-DD format
   * @param {object} data - Analysis data to log
   */
  logAnalysis(symbol, date, data) {
    const key = `${symbol}_${date}`;
    
    if (!this.analysisData.has(key)) {
      this.analysisData.set(key, []);
    }
    
    const entries = this.analysisData.get(key);
    
    // Check if we already have an entry for this timestamp
    const existingIndex = entries.findIndex(entry => entry.timestamp === data.timestamp);
    
    if (existingIndex >= 0) {
      // Update existing entry to avoid duplicates
      entries[existingIndex] = data;
    } else {
      // Add new entry
      entries.push(data);
      
      // Sort by timestamp to maintain chronological order
      entries.sort((a, b) => {
        const timeA = new Date(`2026-01-01 ${a.timestamp}:00`).getTime();
        const timeB = new Date(`2026-01-01 ${b.timestamp}:00`).getTime();
        return timeA - timeB;
      });
    }
  }

/**
   * Build analysis entry matching backtest data format
   * 
   * @param {object} params - Parameters for building the entry
   * @returns {object} Analysis entry in backtest format
   */
  buildAnalysisEntry({
    timestamp,
    datetime,
    strategyMethod,
    opened,
    covered,
    hasOpenPosition,
    positionState,
    analysis,
    strategyAction = null,
    strategyReason = null,
    strategyExecuted = null
  }) {
    const entry = {
      timestamp,
      datetime,
      strategyMethod,
      opened: Boolean(opened),
      covered: Boolean(covered),
      hasOpenPosition: Boolean(hasOpenPosition),
      positionState: {
        state: positionState.state || 'new',
        bias: positionState.bias || 'neutral',
        covered: Boolean(positionState.covered),
        type: positionState.type || null,
        openedAt: positionState.openedAt || null
      },
      analysis: {}
    };
    
    // Add strategy result information if provided
    if (strategyAction !== null) {
      entry.strategyAction = strategyAction;
    }
    if (strategyReason !== null) {
      entry.strategyReason = strategyReason;
    }
    if (strategyExecuted !== null) {
      entry.strategyExecuted = Boolean(strategyExecuted);
    }

    // Add confirmation counters if present
    if (typeof positionState._confirmBull === 'number') {
      entry.positionState._confirmBull = positionState._confirmBull;
    }
    if (typeof positionState._confirmBear === 'number') {
      entry.positionState._confirmBear = positionState._confirmBear;
    }
    if (typeof positionState._elapsedOpen === 'number') {
      entry.positionState._elapsedOpen = positionState._elapsedOpen;
    }

    // Add analysis data for each timeframe
    const timeframes = ['1m', '5m', '15m', '60m'];
    for (const tf of timeframes) {
      if (analysis[tf]) {
        const candle = analysis[tf];
        entry.analysis[tf] = {
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          volume: candle.volume || 0,
          bbupper: candle.bbupper,
          bbmiddle: candle.bbmiddle,
          bblower: candle.bblower,
          sma: candle.sma,
          ema: candle.ema,
          bbScore: candle.bbScore,
          bbScoreDelta: candle.bbScoreDelta,
          trendScore: candle.trendScore
        };
      }
    }

    return entry;
  }

  /**
   * Extract analysis data from candle analysis result
   * 
   * @param {object} candleAnalysis - Candle analysis from analyzeCandles
   * @returns {object} Analysis data by timeframe
   */
  extractAnalysisFromCandles(candleAnalysis) {
    const analysis = {};
    
    if (!candleAnalysis || !candleAnalysis.candleData) {
      return analysis;
    }

    const timeframes = ['1m', '5m', '15m', '60m'];
    for (const tf of timeframes) {
      const tfData = candleAnalysis.candleData[tf];
      if (tfData && tfData.candles && tfData.candles.length > 0) {
        // Latest candle is at index 0 (newest first)
        const latest = tfData.candles[0];
        analysis[tf] = {
          open: latest.open,
          high: latest.high,
          low: latest.low,
          close: latest.close,
          volume: latest.volume || 0,
          bbupper: latest.bbupper,
          bbmiddle: latest.bbmiddle,
          bblower: latest.bblower,
          sma: latest.sma,
          ema: latest.ema,
          bbScore: latest.bbScore,
          bbScoreDelta: latest.bbScoreDelta,
          trendScore: latest.trendScore
        };
      }
    }

    return analysis;
  }

  /**
   * Load existing analysis data from disk for a symbol-date
   * Called on startup to preserve data across server restarts
   * 
   * @param {string} symbol - Symbol (e.g., 'NDX', 'SPX')
   * @param {string} date - Date in YYYY-MM-DD format
   */
  async loadAnalysisData(symbol, date) {
    const key = `${symbol}_${date}`;
    const filename = `positions-analysis-data-${symbol}-${date}.json`;
    const filepath = path.join(ANALYSIS_DATA_DIR, filename);

    try {
      const fileContent = await fs.readFile(filepath, 'utf8');
      const existingData = JSON.parse(fileContent);
      
      if (Array.isArray(existingData) && existingData.length > 0) {
        this.analysisData.set(key, existingData);
        console.log(`📊 Loaded ${existingData.length} existing analysis entries from ${filename}`);
        return existingData.length;
      }
    } catch (error) {
      // File doesn't exist or is invalid - this is fine for new dates
      if (error.code !== 'ENOENT') {
        console.error(`⚠️ Failed to load analysis data for ${key}:`, error.message);
      }
    }
    
    return 0;
  }

  /**
   * Save analysis data to file
   * Merges with existing data on disk to preserve entries across restarts
   * 
   * @param {string} symbol - Symbol (e.g., 'NDX', 'SPX')
   * @param {string} date - Date in YYYY-MM-DD format
   */
  async saveAnalysisData(symbol, date) {
    const key = `${symbol}_${date}`;
    const data = this.analysisData.get(key);
    
    if (!data || data.length === 0) {
      return;
    }

    const filename = `positions-analysis-data-${symbol}-${date}.json`;
    const filepath = path.join(ANALYSIS_DATA_DIR, filename);

    try {
      // Load existing data from disk if not already in memory
      let existingData = [];
      try {
        const fileContent = await fs.readFile(filepath, 'utf8');
        existingData = JSON.parse(fileContent);
        if (!Array.isArray(existingData)) {
          existingData = [];
        }
      } catch (error) {
        // File doesn't exist yet - this is fine
        if (error.code !== 'ENOENT') {
          console.error(`⚠️ Failed to read existing analysis data: ${error.message}`);
        }
      }

      // Merge existing data with new data, avoiding duplicates by timestamp
      const mergedData = [...existingData];
      const existingTimestamps = new Set(existingData.map(e => e.timestamp));
      
      for (const entry of data) {
        if (!existingTimestamps.has(entry.timestamp)) {
          mergedData.push(entry);
        } else {
          // Update existing entry
          const index = mergedData.findIndex(e => e.timestamp === entry.timestamp);
          if (index >= 0) {
            mergedData[index] = entry;
          }
        }
      }

      // Sort by timestamp to maintain chronological order
      mergedData.sort((a, b) => {
        const timeA = new Date(`2026-01-01 ${a.timestamp}:00`).getTime();
        const timeB = new Date(`2026-01-01 ${b.timestamp}:00`).getTime();
        return timeA - timeB;
      });

      await fs.writeFile(filepath, JSON.stringify(mergedData, null, 2), 'utf8');
      console.log(`📊 Saved ${mergedData.length} analysis entries to ${filename} (${data.length} new, ${existingData.length} existing)`);

      // The merge above makes the on-disk file the source of truth, so drop the in-memory entries
      // now that they're persisted. Otherwise this Map accumulates the ENTIRE day (every symbol,
      // every past date, each entry embedding candle/indicator data) and never releases it — an
      // unbounded leak — while every ~60s save also re-merges the whole day. After clearing, the
      // next cycle re-adds only new entries and the next save merges just those into the file.
      this.analysisData.delete(key);
    } catch (error) {
      console.error(`❌ Failed to save analysis data for ${key}:`, error.message);
    }
  }

  /**
   * Save all pending analysis data
   */
  async saveAllAnalysisData() {
    for (const [key] of this.analysisData.entries()) {
      const [symbol, date] = key.split('_');
      await this.saveAnalysisData(symbol, date);
    }
  }

  /**
   * Clear analysis data for a specific symbol-date
   * 
   * @param {string} symbol - Symbol (e.g., 'NDX', 'SPX')
   * @param {string} date - Date in YYYY-MM-DD format
   */
  clearAnalysisData(symbol, date) {
    const key = `${symbol}_${date}`;
    this.analysisData.delete(key);
  }

  /**
   * Get current analysis data count for a symbol-date
   * 
   * @param {string} symbol - Symbol (e.g., 'NDX', 'SPX')
   * @param {string} date - Date in YYYY-MM-DD format
   * @returns {number} Number of analysis entries
   */
  getAnalysisCount(symbol, date) {
    const key = `${symbol}_${date}`;
    const data = this.analysisData.get(key);
    return data ? data.length : 0;
  }
}

// Export singleton instance
module.exports = new AnalysisLogger();
