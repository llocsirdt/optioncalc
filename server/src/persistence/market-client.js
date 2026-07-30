/**
 * Shared MarketApiClient and TradingApiClient instances
 * Uses singleton pattern to avoid multiple instances
 * Note: .env should already be loaded by the main application
 */

const { MarketApiClient, TradingApiClient } = require('schwab-client-js');

// Pristine reference to the real fetch, captured once before any monkey-patching.
// getAccessToken() temporarily swaps global.fetch to sniff the Bearer token; if it
// ever restored to "whatever global.fetch was on entry" instead of this, a failed
// call (which previously skipped the restore) would leave the wrapper installed, and
// the next call would wrap THAT wrapper. Those layers accumulated over uptime until a
// single fetch() recursed deep enough to throw "Maximum call stack size exceeded" —
// only cleared by a restart. Always restoring to (and calling through) this pristine
// reference makes nesting impossible.
const PRISTINE_FETCH = global.fetch;

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
  // Monkey-patch fetch to intercept the Authorization header. The wrapper always
  // delegates to PRISTINE_FETCH (never to the current global.fetch), so it can never
  // chain onto a previously-leaked wrapper.
  let capturedToken = null;

  global.fetch = async (url, options) => {
    if (options && options.headers && options.headers.Authorization) {
      const authHeader = options.headers.Authorization;
      if (authHeader.startsWith('Bearer ')) {
        capturedToken = authHeader.substring(7); // Remove 'Bearer ' prefix
      }
    }
    return PRISTINE_FETCH(url, options);
  };

  try {
    // Make a lightweight API call to trigger token usage
    const trading = getTradingClient();
    await trading.accountsNumbers();
  } catch (error) {
    console.error('❌ Error getting access token:', error.message);
    throw error;
  } finally {
    // Always restore, even if the call above threw. Restoring to the pristine
    // reference (not the on-entry value) guarantees no wrapper is ever left installed.
    global.fetch = PRISTINE_FETCH;
  }

  if (!capturedToken) {
    throw new Error('Failed to capture access token');
  }

  return capturedToken;
}

module.exports = {
  marketClient: getMarketClient(),
  tradingClient: getTradingClient(),
  getUserPreference,
  getAccessToken
};
