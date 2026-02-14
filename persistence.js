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
   * Load state from persistence file
   */
  async loadState() {
    try {
      // Try main file first
      const data = await fs.readFile(PERSISTENCE_FILE, 'utf8');
      const savedState = JSON.parse(data);
      
      // Merge with default state to handle new fields
      this.state = this.mergeStates(this.state, savedState);
      
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
      metadata: {
        restartCount: this.state.metadata.restartCount,
        createdAt: this.state.metadata.createdAt,
        lastSaved: this.state.metadata.lastSaved
      }
    };
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
      metadata: { createdAt: new Date().toISOString(), lastSaved: null, restartCount: 0, totalUptime: 0 }
    };
    
    try {
      await fs.unlink(PERSISTENCE_FILE);
      await fs.unlink(BACKUP_FILE);
      console.log('🗑️  Reset persistence state');
    } catch (error) {
      // Files might not exist, that's okay
    }
  }
}

module.exports = PersistenceManager;
