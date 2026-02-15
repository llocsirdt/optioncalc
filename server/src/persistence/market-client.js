/**
 * Shared MarketApiClient instance
 * Uses singleton pattern to avoid multiple instances
 * Note: .env should already be loaded by the main application
 */

const { MarketApiClient } = require('schwab-client-js');

// Singleton pattern - create only one instance
let marketClientInstance = null;

function getMarketClient() {
  if (!marketClientInstance) {
    console.log('🔧 Creating MarketApiClient singleton instance');
    marketClientInstance = new MarketApiClient(
      process.env.SCHWAB_CLIENT_ID, 
      process.env.SCHWAB_CLIENT_SECRET, 
      process.env.SCHWAB_REFRESH_TOKEN
    );
  }
  return marketClientInstance;
}

module.exports = {
  marketClient: getMarketClient()
};
