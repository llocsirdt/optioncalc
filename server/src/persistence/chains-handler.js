/**
 * Shared chain request handler
 * Uses MarketApiClient passed as parameter to avoid circular dependencies
 */

/**
 * Handle chains request - shared function for both API endpoints and offset manager
 * @param {string} path - The request path
 * @param {string} query - The query string
 * @param {string} timestamp - The timestamp for logging
 * @param {Object} persistenceManager - The persistence manager instance
 * @param {Object} marketClient - The MarketApiClient instance
 * @returns {Promise<Object>} The chain data
 */
async function handleChainsRequest(path, query, timestamp, persistenceManager, marketClient) {
  // Parse the query string directly since we're not building a full URL
  const queryString = query.startsWith('?') ? query.substring(1) : query;
  
  // Extract symbol and expiration date from query
  const symbol = queryString.includes('symbol=') ? 
    queryString.split('symbol=')[1].split('&')[0] : null;
  const expirationDate = queryString.includes('expirationDate=') ? 
    queryString.split('expirationDate=')[1].split('&')[0] : null;
  
  if (!symbol || !expirationDate) {
    return null;
  }
  
  if (!symbol || symbol === '') {
    throw new Error('symbol parameter is required (e.g., ?symbol=SPY)');
  }
  
  if (!expirationDate || expirationDate === '') {
    throw new Error('expirationDate parameter is required (e.g., ?symbol=SPY&expirationDate=2024-01-19)');
  }
  
  // Decode the symbol for Schwab API
  // Only index symbols need $ prefix for Schwab API
  const indexSymbols = ['NDX', 'SPX', 'RUT', 'DJX', 'OEX']; // Known index symbols
  const apiSymbol = (symbol.startsWith('$') || indexSymbols.includes(symbol)) ? 
    (symbol.startsWith('$') ? symbol : `$${symbol}`) : 
    symbol;
  
  // Use original symbol for cache key (without $ prefix)
  const cacheSymbol = symbol.startsWith('$') ? symbol.substring(1) : symbol;
  
  console.log(`[${timestamp}] 🔍 DEBUG: Original symbol: ${symbol}, API symbol: ${apiSymbol}, Cache symbol: ${cacheSymbol}`);
  
  // Check if we have cached data first
  console.log(`[${timestamp}] Checking cache for option chain ${cacheSymbol} ${expirationDate}`);
  const cachedData = await persistenceManager.getCachedChainData(cacheSymbol, expirationDate);
  
  if (cachedData) {
    console.log(`[${timestamp}] 📋 Returning cached option chain for ${cacheSymbol} ${expirationDate}`);
    return cachedData;
  }
  
  console.log(`[${timestamp}] Fetching fresh option chain for ${apiSymbol} ${expirationDate}`);
  
  // Extract optional parameters using SDK documentation names
  const params = new URLSearchParams(queryString);
  const strikeCountParam = params.get('strikeCount') || params.get('strike_count');
  const optionalParams = {
    strikeCount: strikeCountParam ? parseInt(strikeCountParam) : 75, // Default to 75 strikes if not provided
    contractType: params.get('contractType') || params.get('contract_type') || undefined, // From SDK docs
    includeUnderlyingQuote: params.get('includeUnderlyingQuote') === 'true' || params.get('include_underlying_quote') === 'true',
    strategy: params.get('strategy') || undefined,
    range: params.get('range') || params.get('strike_range') || undefined, // From SDK docs
    optionType: params.get('optionType') || params.get('option_type') || undefined,
    strike: parseFloat(params.get('strike')) || undefined,
    interval: parseInt(params.get('interval')) || undefined,
    // Include expirationDate in the options object
    expirationDate: expirationDate
    // No fromDate/toDate - just pass expiration date
  };
  
  // Remove undefined parameters (but keep strikeCount)
  Object.keys(optionalParams).forEach(key => {
    if (optionalParams[key] === undefined && key !== 'strikeCount') {
      delete optionalParams[key];
    }
  });
  
  console.log(`[${timestamp}] Getting options chain for: ${apiSymbol}, exp: ${expirationDate}`);
  console.log(`[${timestamp}] Optional params:`, optionalParams);
  
  // Build the chain options object for schwab-client-js SDK
  const chainOptions = {
    ...optionalParams
    // Don't include expirationDate - use fromDate/toDate instead
  };
  
  console.log(`[${timestamp}] Final chain options:`, chainOptions);
  
  // Log the exact API request being made
  console.log(`[${timestamp}] 🔗 API Request: marketClient.chains("${apiSymbol}", ${JSON.stringify(optionalParams)})`);
  
  console.log(`[${timestamp}] Getting options chain for: ${apiSymbol}`);
  console.log(`[${timestamp}] Options object:`, optionalParams);
  
  // Fetch fresh data from Schwab API
  const result = await marketClient.chains(apiSymbol, optionalParams);
  
  // Cache the result for storage purposes (only if successful)
  if (result) {
    await persistenceManager.cacheChainData(cacheSymbol, expirationDate, result);
    console.log(`[${timestamp}] ✅ Successfully cached chain data for ${cacheSymbol} ${expirationDate}`);
  }
  
  // Debug: Check what expiration date we actually got back
  if (result && result.callExpDateMap) {
    const expirationDates = Object.keys(result.callExpDateMap);
    if (expirationDates.length > 0) {
      // console.log(`[${timestamp}] 🎯 DEBUG: Requested: ${expirationDate}, Got: ${expirationDates[0]}`);
    }
  }
  
  return result;
}

module.exports = {
  handleChainsRequest
};
