#!/usr/bin/env node

/**
 * Data Persistence Module for Schwab Proxy Server
 * 
 * Handles saving and restoring server state across restarts
 */

const fs = require('fs').promises;
const path = require('path');

const PERSISTENCE_FILE = path.join(__dirname, 'server-state.json');
const BACKUP_FILE = path.join(__dirname, 'server-state.backup.json');
const CHAIN_CACHE_DIR = path.join(__dirname, 'chain-cache');

class PersistenceManager {
  constructor() {
    this.state = {
      // Account data
      accounts: {
        cached: {},
        lastUpdated: null,
        accountNumbers: []
      },
      
      // Order tracking
      orders: {
        active: [], // Track active orders for cleanup
        completed: [], // Track completed orders
        lastCleanup: null
      },
      
      // Session data
      session: {
        refreshToken: null,
        accessToken: null,
        tokenExpiry: null,
        lastRefresh: null
      },
      
      // Server configuration
      config: {
        port: 3001,
        environment: 'development',
        version: '1.0.0'
      },
      
      // Error tracking
      errors: {
        recent: [], // Keep last 50 errors
        errorCount: 0,
        lastError: null
      },
      
      // Chain cache metadata only (actual chains stored in separate files)
      chains: {
        cachedKeys: [], // Array of "SYMBOL_EXPIRATION" keys
        lastUpdated: {}, // Key: "SYMBOL_EXPIRATION", Value: timestamp
        cacheCount: 0
      },
      
      // Metadata
      metadata: {
        createdAt: new Date().toISOString(),
        lastSaved: null,
        restartCount: 0,
        totalUptime: 0
      }
    };
  }

  /**
   * Initialize chain cache directory
   */
  async initializeChainCache() {
    try {
      await fs.mkdir(CHAIN_CACHE_DIR, { recursive: true });
      console.log(`📁 Chain cache directory ready: ${CHAIN_CACHE_DIR}`);
    } catch (error) {
      console.error('❌ Failed to create chain cache directory:', error.message);
      throw error;
    }
  }

  /**
   * Load state from persistence file
   */
  async loadState() {
    try {
      // Try main file first
      const data = await fs.readFile(PERSISTENCE_FILE, 'utf8');
      const savedState = JSON.parse(data);
      
      // Merge with default state to handle new fields
      this.state = this.mergeStates(this.state, savedState);
      
      // Migrate old chain cache format to new file-based format
      await this.migrateChainCacheIfNeeded();
      
      // Update restart count and timestamps
      this.state.metadata.restartCount = (this.state.metadata.restartCount || 0) + 1;
      this.state.metadata.lastLoaded = new Date().toISOString();
      
      console.log(`📂 Loaded server state from ${PERSISTENCE_FILE}`);
      console.log(`🔄 Restart count: ${this.state.metadata.restartCount}`);
      
      return this.state;
      
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.log('📂 No existing state file found, starting fresh');
        return this.state;
      }
      
      // Try backup file if main file is corrupted
      try {
        console.log('📂 Main state file corrupted, trying backup...');
        const backupData = await fs.readFile(BACKUP_FILE, 'utf8');
        const savedState = JSON.parse(backupData);
        this.state = this.mergeStates(this.state, savedState);
        console.log('✅ Recovered from backup file');
        return this.state;
      } catch (backupError) {
        console.log('⚠️  No valid backup found, starting fresh');
        return this.state;
      }
    }
  }

  /**
   * Save current state to file
   */
  async saveState() {
    try {
      // Update timestamps
      this.state.metadata.lastSaved = new Date().toISOString();
      
      // Create backup before saving
      await this.createBackup();
      
      // Save main state
      const stateJson = JSON.stringify(this.state, null, 2);
      await fs.writeFile(PERSISTENCE_FILE, stateJson, 'utf8');
      
      console.log(`💾 Saved server state to ${PERSISTENCE_FILE}`);
      
    } catch (error) {
      console.error('❌ Failed to save state:', error.message);
      throw error;
    }
  }

  /**
   * Create backup of current state
   */
  async createBackup() {
    try {
      // Only create backup if main file exists
      try {
        await fs.access(PERSISTENCE_FILE);
        await fs.copyFile(PERSISTENCE_FILE, BACKUP_FILE);
      } catch (error) {
        // Main file doesn't exist, no backup needed
      }
    } catch (error) {
      console.warn('⚠️  Failed to create backup:', error.message);
    }
  }

  /**
   * Merge saved state with default state
   */
  mergeStates(defaultState, savedState) {
    const merged = JSON.parse(JSON.stringify(defaultState)); // Deep copy
    
    // Recursively merge objects
    const merge = (target, source) => {
      for (const key in source) {
        if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
          if (!target[key]) target[key] = {};
          merge(target[key], source[key]);
        } else {
          target[key] = source[key];
        }
      }
    };
    
    merge(merged, savedState);
    return merged;
  }

  /**
   * Update account information
   */
  updateAccounts(accountData) {
    this.state.accounts.cached = accountData;
    this.state.accounts.lastUpdated = new Date().toISOString();
    
    if (accountData.accountNumbers) {
      this.state.accounts.accountNumbers = accountData.accountNumbers;
    }
  }

  /**
   * Track order for cleanup
   */
  trackOrder(orderData, status = 'active') {
    const order = {
      id: orderData.orderId,
      symbol: orderData.symbol || 'UNKNOWN',
      type: orderData.orderType || 'UNKNOWN',
      status: status,
      createdAt: new Date().toISOString(),
      accountHash: orderData.accountHash || null
    };
    
    if (status === 'active') {
      // Remove from completed if it exists there
      this.state.orders.completed = this.state.orders.completed.filter(o => o.id !== order.id);
      // Add to active if not already there
      if (!this.state.orders.active.find(o => o.id === order.id)) {
        this.state.orders.active.push(order);
      }
    } else {
      // Move from active to completed
      this.state.orders.active = this.state.orders.active.filter(o => o.id !== order.id);
      if (!this.state.orders.completed.find(o => o.id === order.id)) {
        this.state.orders.completed.push(order);
      }
    }
    
    console.log(`📋 Tracked order: ${order.id} (${order.symbol}) - Status: ${status}`);
  }

  /**
   * Get active orders for cleanup
   */
  getActiveOrders() {
    return this.state.orders.active;
  }

  /**
   * Mark order as completed
   */
  completeOrder(orderId) {
    const order = this.state.orders.active.find(o => o.id === orderId);
    if (order) {
      this.trackOrder(order, 'completed');
    }
  }

  /**
   * Update session information
   */
  updateSession(sessionData) {
    this.state.session = {
      ...this.state.session,
      ...sessionData,
      lastRefresh: new Date().toISOString()
    };
  }

  /**
   * Log error for tracking
   */
  logError(error) {
    const errorEntry = {
      message: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString(),
      path: error.path || null,
      method: error.method || null
    };
    
    this.state.errors.recent.unshift(errorEntry);
    this.state.errors.recent = this.state.errors.recent.slice(0, 50); // Keep last 50
    this.state.errors.errorCount++;
    this.state.errors.lastError = errorEntry;
  }

  /**
   * Get recent errors
   */
  getRecentErrors(limit = 10) {
    return this.state.errors.recent.slice(0, limit);
  }

  /**
   * Clean up old data
   */
  async cleanup() {
    const now = new Date();
    const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    
    // Clean old completed orders (older than 1 week)
    this.state.orders.completed = this.state.orders.completed.filter(
      order => new Date(order.createdAt) > oneWeekAgo
    );
    
    // Clean old errors (older than 1 week)
    this.state.errors.recent = this.state.errors.recent.filter(
      error => new Date(error.timestamp) > oneWeekAgo
    );
    
    // Update cleanup timestamp
    this.state.orders.lastCleanup = now.toISOString();
    
    console.log('🧹 Cleaned up old data');
  }

  /**
   * Get state summary
   */
  getStateSummary() {
    return {
      accounts: {
        cachedCount: Object.keys(this.state.accounts.cached).length,
        lastUpdated: this.state.accounts.lastUpdated
      },
      orders: {
        activeCount: this.state.orders.active.length,
        completedCount: this.state.orders.completed.length,
        lastCleanup: this.state.orders.lastCleanup
      },
      session: {
        hasRefreshToken: !!this.state.session.refreshToken,
        lastRefresh: this.state.session.lastRefresh
      },
      errors: {
        recentCount: this.state.errors.recent.length,
        totalCount: this.state.errors.errorCount,
        lastError: this.state.errors.lastError?.timestamp
      },
      chains: {
        cacheCount: this.state.chains.cacheCount,
        cachedSymbols: [...new Set(this.state.chains.cachedKeys.map(key => key.split('_')[0]))],
        lastUpdated: Object.values(this.state.chains.lastUpdated).sort().pop() || null
      },
      metadata: {
        restartCount: this.state.metadata.restartCount,
        createdAt: this.state.metadata.createdAt,
        lastSaved: this.state.metadata.lastSaved
      }
    };
  }

  /**
   * Cache option chain data to separate file
   */
  async cacheChainData(symbol, expiration, chainData) {
    const key = `${symbol}_${expiration}`;
    const timestamp = new Date().toISOString();
    const filename = `${key}.json`;
    const filepath = path.join(CHAIN_CACHE_DIR, filename);
    
    try {
      // Ensure cache directory exists
      await this.initializeChainCache();
      
      // Save chain data to separate file
      const chainFileData = {
        symbol,
        expiration,
        data: chainData,
        cachedAt: timestamp
      };
      
      await fs.writeFile(filepath, JSON.stringify(chainFileData, null, 2), 'utf8');
      
      // Update metadata in main state
      if (!this.state.chains.cachedKeys.includes(key)) {
        this.state.chains.cachedKeys.push(key);
      }
      this.state.chains.lastUpdated[key] = timestamp;
      this.state.chains.cacheCount = this.state.chains.cachedKeys.length;
      
      console.log(`💾 Cached option chain for ${symbol} ${expiration} (${Object.keys(chainData.call || {}).length + Object.keys(chainData.put || {}).length} contracts)`);
      
      // Auto-save metadata after caching
      this.saveState().catch(error => {
        console.error('Failed to save state after caching chain:', error.message);
      });
      
    } catch (error) {
      console.error(`❌ Failed to cache chain data for ${key}:`, error.message);
      throw error;
    }
  }

  /**
   * Get cached option chain data from file
   */
  async getCachedChainData(symbol, expiration) {
    const key = `${symbol}_${expiration}`;
    const filename = `${key}.json`;
    const filepath = path.join(CHAIN_CACHE_DIR, filename);
    
    try {
      const data = await fs.readFile(filepath, 'utf8');
      const cached = JSON.parse(data);
      
      console.log(`📋 Retrieved cached option chain for ${symbol} ${expiration} (cached at ${cached.cachedAt})`);
      return cached.data;
      
    } catch (error) {
      if (error.code === 'ENOENT') {
        return null; // File doesn't exist, no cached data
      }
      console.error(`❌ Failed to read cached chain data for ${key}:`, error.message);
      return null;
    }
  }

  /**
   * Check if chain data is cached (file exists)
   */
  async hasCachedChainData(symbol, expiration) {
    const key = `${symbol}_${expiration}`;
    const filename = `${key}.json`;
    const filepath = path.join(CHAIN_CACHE_DIR, filename);
    
    try {
      await fs.access(filepath);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get chain cache summary
   */
  getChainCacheSummary() {
    return {
      cacheCount: this.state.chains.cacheCount,
      cachedSymbols: [...new Set(this.state.chains.cachedKeys.map(key => key.split('_')[0]))],
      cachedKeys: this.state.chains.cachedKeys,
      lastUpdated: this.state.chains.lastUpdated
    };
  }

  /**
   * Clear old chain cache entries (older than specified hours)
   */
  async clearOldChainCache(maxAgeHours = 24) {
    const cutoffTime = new Date(Date.now() - (maxAgeHours * 60 * 60 * 1000));
    const keysToDelete = [];
    
    // Check each cached key
    for (const key of this.state.chains.cachedKeys) {
      const filename = `${key}.json`;
      const filepath = path.join(CHAIN_CACHE_DIR, filename);
      
      try {
        const data = await fs.readFile(filepath, 'utf8');
        const cached = JSON.parse(data);
        const cachedTime = new Date(cached.cachedAt);
        
        if (cachedTime < cutoffTime) {
          keysToDelete.push(key);
        }
      } catch (error) {
        // File might be corrupted or missing, mark for deletion
        keysToDelete.push(key);
      }
    }
    
    // Delete old files and update metadata
    for (const key of keysToDelete) {
      const filename = `${key}.json`;
      const filepath = path.join(CHAIN_CACHE_DIR, filename);
      
      try {
        await fs.unlink(filepath);
      } catch (error) {
        // File might not exist, that's okay
      }
      
      // Remove from metadata
      this.state.chains.cachedKeys = this.state.chains.cachedKeys.filter(k => k !== key);
      delete this.state.chains.lastUpdated[key];
    }
    
    // Update cache count
    this.state.chains.cacheCount = this.state.chains.cachedKeys.length;
    
    if (keysToDelete.length > 0) {
      console.log(`🧹 Cleared ${keysToDelete.length} old chain cache entries`);
      this.saveState().catch(error => {
        console.error('Failed to save state after clearing old chains:', error.message);
      });
    }
    
    return keysToDelete.length;
  }

  /**
   * Migrate old chain cache format to new file-based format
   */
  async migrateChainCacheIfNeeded() {
    // Check if we have old format chain data in the state
    if (this.state.chains.cached && typeof this.state.chains.cached === 'object' && Object.keys(this.state.chains.cached).length > 0) {
      console.log('🔄 Migrating chain cache to new file-based format...');
      
      try {
        // Ensure cache directory exists
        await this.initializeChainCache();
        
        const oldCacheData = this.state.chains.cached;
        const totalEntries = Object.keys(oldCacheData).length;
        let migratedCount = 0;
        
        console.log(`📊 Found ${totalEntries} chain cache entries to migrate`);
        
        // Migrate each cached chain to separate file
        for (const [key, chainData] of Object.entries(oldCacheData)) {
          try {
            const filename = `${key}.json`;
            const filepath = path.join(CHAIN_CACHE_DIR, filename);
            
            await fs.writeFile(filepath, JSON.stringify(chainData, null, 2), 'utf8');
            migratedCount++;
            
            // Progress logging every 10 entries
            if (migratedCount % 10 === 0) {
              console.log(`📝 Migrated ${migratedCount}/${totalEntries} chain cache entries...`);
            }
            
          } catch (error) {
            console.error(`❌ Failed to migrate chain ${key}:`, error.message);
          }
        }
        
        // Update state structure
        this.state.chains.cachedKeys = Object.keys(oldCacheData);
        delete this.state.chains.cached; // Remove old format
        
        console.log(`✅ Migrated ${migratedCount}/${totalEntries} chain cache entries to separate files`);
        
        // Save the updated state immediately
        await this.saveState();
        
      } catch (error) {
        console.error('❌ Failed to migrate chain cache:', error.message);
        // If migration fails, clear the old cache to prevent restart loops
        console.log('🧹 Clearing old chain cache to prevent restart loop...');
        this.state.chains.cachedKeys = [];
        delete this.state.chains.cached;
        this.state.chains.cacheCount = 0;
        this.state.chains.lastUpdated = {};
      }
    }
  }

  /**
   * Export state for debugging
   */
  exportState() {
    return JSON.stringify(this.state, null, 2);
  }

  /**
   * Reset state (for testing/debugging)
   */
  async resetState() {
    this.state = {
      accounts: { cached: {}, lastUpdated: null, accountNumbers: [] },
      orders: { active: [], completed: [], lastCleanup: null },
      session: { refreshToken: null, accessToken: null, tokenExpiry: null, lastRefresh: null },
      config: { port: 3001, environment: 'development', version: '1.0.0' },
      errors: { recent: [], errorCount: 0, lastError: null },
      chains: { cachedKeys: [], lastUpdated: {}, cacheCount: 0 },
      metadata: { createdAt: new Date().toISOString(), lastSaved: null, restartCount: 0, totalUptime: 0 }
    };
    
    try {
      await fs.unlink(PERSISTENCE_FILE);
      await fs.unlink(BACKUP_FILE);
      
      // Clean up chain cache directory
      try {
        const files = await fs.readdir(CHAIN_CACHE_DIR);
        for (const file of files) {
          if (file.endsWith('.json')) {
            await fs.unlink(path.join(CHAIN_CACHE_DIR, file));
          }
        }
        console.log('🗑️  Cleared chain cache files');
      } catch (error) {
        // Directory might not exist, that's okay
      }
      
      console.log('🗑️  Reset persistence state');
    } catch (error) {
      // Files might not exist, that's okay
    }
  }
}

module.exports = PersistenceManager;
