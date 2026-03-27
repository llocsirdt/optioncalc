/**
 * Shared MarketApiClient and TradingApiClient instances
 * Uses singleton pattern to avoid multiple instances
 * Note: .env should already be loaded by the main application
 */

const { MarketApiClient, TradingApiClient } = require('schwab-client-js');

// Singleton pattern - create only one instance
let marketClientInstance = null;
let tradingClientInstance = null;

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

function getTradingClient() {
  if (!tradingClientInstance) {
    console.log('🔧 Creating TradingApiClient singleton instance');
    tradingClientInstance = new TradingApiClient(
      process.env.SCHWAB_CLIENT_ID, 
      process.env.SCHWAB_CLIENT_SECRET, 
      process.env.SCHWAB_REFRESH_TOKEN
    );
  }
  return tradingClientInstance;
}

/**
 * Get user preferences including streaming credentials
 * This is a direct API call to get streaming info
 */
async function getUserPreference() {
  try {
    const trading = getTradingClient();
    const data = await trading.prefs();
    return data;
  } catch (error) {
    console.error('❌ Error getting user preferences:', error.message);
    throw error;
  }
}

/**
 * Get current access token by making a lightweight API call
 * The schwab-client-js library manages tokens internally, so we need to
 * intercept the token during an API call
 */
async function getAccessToken() {
  try {
    // Monkey-patch fetch to intercept the Authorization header
    let capturedToken = null;
    const originalFetch = global.fetch;
    
    global.fetch = async (url, options) => {
      if (options && options.headers && options.headers.Authorization) {
        const authHeader = options.headers.Authorization;
        if (authHeader.startsWith('Bearer ')) {
          capturedToken = authHeader.substring(7); // Remove 'Bearer ' prefix
        }
      }
      return originalFetch(url, options);
    };

    // Make a lightweight API call to trigger token usage
    const trading = getTradingClient();
    await trading.accountsNumbers();

    // Restore original fetch
    global.fetch = originalFetch;

    if (!capturedToken) {
      throw new Error('Failed to capture access token');
    }

    return capturedToken;
  } catch (error) {
    console.error('❌ Error getting access token:', error.message);
    throw error;
  }
}

module.exports = {
  marketClient: getMarketClient(),
  tradingClient: getTradingClient(),
  getUserPreference,
  getAccessToken
};
