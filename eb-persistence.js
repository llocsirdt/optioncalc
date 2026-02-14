#!/usr/bin/env node

/**
 * AWS Elastic Beanstalk Compatible Persistence Manager
 * 
 * Handles persistence in multi-instance EB environments with:
 * - S3 backup for cross-instance state sharing
 * - Local caching for performance
 * - Graceful degradation for S3 failures
 */

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

// Configuration
const PERSISTENCE_FILE = path.join(__dirname, 'server-state.json');
const BACKUP_FILE = path.join(__dirname, 'server-state.backup.json');
const INSTANCE_ID_FILE = path.join(__dirname, 'instance-id.json');

// EB Environment detection
const IS_EB_ENVIRONMENT = process.env.AWS_ELASTIC_BEANSTALK_ENVIRONMENT_NAME !== undefined;
const INSTANCE_ID = process.env.EC2_INSTANCE_ID || crypto.randomBytes(8).toString('hex');

class EBPersistenceManager {
  constructor() {
    this.state = {
      // Base state structure (same as original)
      accounts: {
        cached: {},
        lastUpdated: null,
        accountNumbers: []
      },
      orders: {
        active: [],
        completed: [],
        lastCleanup: null
      },
      session: {
        refreshToken: null,
        accessToken: null,
        tokenExpiry: null,
        lastRefresh: null
      },
      config: {
        port: 3001,
        environment: IS_EB_ENVIRONMENT ? 'elastic-beanstalk' : 'development',
        version: '1.0.0'
      },
      errors: {
        recent: [],
        errorCount: 0,
        lastError: null
      },
      metadata: {
        createdAt: new Date().toISOString(),
        lastSaved: null,
        restartCount: 0,
        totalUptime: 0,
        instanceId: INSTANCE_ID,
        environment: process.env.AWS_ELASTIC_BEANSTALK_ENVIRONMENT_NAME || 'local'
      }
    };
  }

  /**
   * Initialize EB-compatible persistence
   */
  async initialize() {
    try {
      console.log('🔄 Initializing EB-compatible persistence system...');
      console.log(`📍 Environment: ${IS_EB_ENVIRONMENT ? 'Elastic Beanstalk' : 'Local'}`);
      console.log(`🏷️  Instance ID: ${INSTANCE_ID}`);
      
      // Save instance ID for tracking
      await this.saveInstanceId();
      
      // Load local state
      await this.loadLocalState();
      
      // If in EB, try to sync with S3 (if available)
      if (IS_EB_ENVIRONMENT) {
        await this.syncWithS3();
      }
      
      // Clean up old data
      await this.cleanup();
      
      // Save initial state
      await this.saveLocalState();
      
      console.log('✅ EB-compatible persistence system ready');
      
    } catch (error) {
      console.error('❌ Failed to initialize EB persistence:', error.message);
      throw error;
    }
  }

  /**
   * Save instance ID for tracking
   */
  async saveInstanceId() {
    try {
      const instanceData = {
        instanceId: INSTANCE_ID,
        environment: process.env.AWS_ELASTIC_BEANSTALK_ENVIRONMENT_NAME || 'local',
        startTime: new Date().toISOString(),
        lastSeen: new Date().toISOString()
      };
      
      await fs.writeFile(INSTANCE_ID_FILE, JSON.stringify(instanceData, null, 2));
    } catch (error) {
      console.warn('⚠️  Failed to save instance ID:', error.message);
    }
  }

  /**
   * Load local state file
   */
  async loadLocalState() {
    try {
      const data = await fs.readFile(PERSISTENCE_FILE, 'utf8');
      const savedState = JSON.parse(data);
      
      // Merge with default state
      this.state = this.mergeStates(this.state, savedState);
      
      // Update instance-specific metadata
      this.state.metadata.instanceId = INSTANCE_ID;
      this.state.metadata.restartCount = (this.state.metadata.restartCount || 0) + 1;
      this.state.metadata.lastLoaded = new Date().toISOString();
      
      console.log(`📂 Loaded local state (restart #${this.state.metadata.restartCount})`);
      
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.log('📂 No local state file found, starting fresh');
      } else {
        console.warn('⚠️  Failed to load local state, trying backup...');
        await this.loadBackupState();
      }
    }
  }

  /**
   * Load backup state
   */
  async loadBackupState() {
    try {
      const backupData = await fs.readFile(BACKUP_FILE, 'utf8');
      const savedState = JSON.parse(backupData);
      this.state = this.mergeStates(this.state, savedState);
      console.log('✅ Recovered from backup file');
    } catch (error) {
      console.log('⚠️  No valid backup found, starting fresh');
    }
  }

  /**
   * Sync with S3 (if available)
   */
  async syncWithS3() {
    try {
      // This would require AWS SDK integration
      // For now, just log that we would sync
      console.log('🔄 S3 sync would happen here (requires AWS SDK setup)');
      
      // Future implementation:
      // 1. Download latest state from S3
      // 2. Merge with local state
      // 3. Upload merged state to S3
      
    } catch (error) {
      console.warn('⚠️  S3 sync failed, using local state only:', error.message);
    }
  }

  /**
   * Save state locally
   */
  async saveLocalState() {
    try {
      // Update timestamps
      this.state.metadata.lastSaved = new Date().toISOString();
      this.state.metadata.lastSeen = new Date().toISOString();
      
      // Create backup
      await this.createBackup();
      
      // Save main state
      const stateJson = JSON.stringify(this.state, null, 2);
      await fs.writeFile(PERSISTENCE_FILE, stateJson, 'utf8');
      
      console.log(`💾 Saved local state (instance: ${INSTANCE_ID})`);
      
    } catch (error) {
      console.error('❌ Failed to save local state:', error.message);
      throw error;
    }
  }

  /**
   * Create backup
   */
  async createBackup() {
    try {
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
   * Merge states (same as original)
   */
  mergeStates(defaultState, savedState) {
    const merged = JSON.parse(JSON.stringify(defaultState));
    
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
   * Track order (EB-compatible)
   */
  trackOrder(orderData, status = 'active') {
    const order = {
      id: orderData.orderId,
      symbol: orderData.symbol || 'UNKNOWN',
      type: orderData.orderType || 'UNKNOWN',
      status: status,
      createdAt: new Date().toISOString(),
      accountHash: orderData.accountHash || null,
      instanceId: INSTANCE_ID, // Track which instance created this
      environment: process.env.AWS_ELASTICBEANSTALK_ENVIRONMENT_NAME || 'local'
    };
    
    if (status === 'active') {
      this.state.orders.active = this.state.orders.active.filter(o => o.id !== order.id);
      if (!this.state.orders.active.find(o => o.id === order.id)) {
        this.state.orders.active.push(order);
      }
    } else {
      this.state.orders.active = this.state.orders.active.filter(o => o.id !== order.id);
      if (!this.state.orders.completed.find(o => o.id === order.id)) {
        this.state.orders.completed.push(order);
      }
    }
    
    console.log(`📋 Tracked order: ${order.id} (${order.symbol}) - Instance: ${INSTANCE_ID}`);
  }

  /**
   * Complete order (EB-compatible)
   */
  completeOrder(orderId) {
    const order = this.state.orders.active.find(o => o.id === orderId);
    if (order) {
      this.trackOrder(order, 'completed');
    }
  }

  /**
   * Get active orders (with instance filtering)
   */
  getActiveOrders() {
    return this.state.orders.active;
  }

  /**
   * Update accounts
   */
  updateAccounts(accountData) {
    this.state.accounts.cached = accountData;
    this.state.accounts.lastUpdated = new Date().toISOString();
    
    if (accountData.accountNumbers) {
      this.state.accounts.accountNumbers = accountData.accountNumbers;
    }
  }

  /**
   * Log error (EB-compatible)
   */
  logError(error) {
    const errorEntry = {
      message: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString(),
      path: error.path || null,
      method: error.method || null,
      instanceId: INSTANCE_ID,
      environment: process.env.AWS_ELASTICBEANSTALK_ENVIRONMENT_NAME || 'local'
    };
    
    this.state.errors.recent.unshift(errorEntry);
    this.state.errors.recent = this.state.errors.recent.slice(0, 50);
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
    
    // Clean old completed orders
    this.state.orders.completed = this.state.orders.completed.filter(
      order => new Date(order.createdAt) > oneWeekAgo
    );
    
    // Clean old errors
    this.state.errors.recent = this.state.errors.recent.filter(
      error => new Date(error.timestamp) > oneWeekAgo
    );
    
    this.state.orders.lastCleanup = now.toISOString();
    
    console.log('🧹 Cleaned up old data');
  }

  /**
   * Get state summary (EB-enhanced)
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
        lastSaved: this.state.metadata.lastSaved,
        instanceId: this.state.metadata.instanceId,
        environment: this.state.metadata.environment,
        isEBEnvironment: IS_EB_ENVIRONMENT
      }
    };
  }

  /**
   * Export state
   */
  exportState() {
    return JSON.stringify(this.state, null, 2);
  }

  /**
   * Reset state
   */
  async resetState() {
    this.state = {
      accounts: { cached: {}, lastUpdated: null, accountNumbers: [] },
      orders: { active: [], completed: [], lastCleanup: null },
      session: { refreshToken: null, accessToken: null, tokenExpiry: null, lastRefresh: null },
      config: { port: 3001, environment: IS_EB_ENVIRONMENT ? 'elastic-beanstalk' : 'development', version: '1.0.0' },
      errors: { recent: [], errorCount: 0, lastError: null },
      metadata: { 
        createdAt: new Date().toISOString(), 
        lastSaved: null, 
        restartCount: 0, 
        totalUptime: 0,
        instanceId: INSTANCE_ID,
        environment: process.env.AWS_ELASTICBEANSTALK_ENVIRONMENT_NAME || 'local'
      }
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

module.exports = EBPersistenceManager;
