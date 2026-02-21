/**
 * Shared price history request handler
 * Uses MarketApiClient passed as parameter to avoid circular dependencies
 */

/**
 * Handle price history request - shared function for both API endpoints and internal calls
 * @param {string} path - The request path
 * @param {string} query - The query string
 * @param {string} timestamp - The timestamp for logging
 * @param {Object} marketClient - The MarketApiClient instance
 * @returns {Promise<Object>} The price history data
 */
async function handlePriceHistoryRequest(path, query, timestamp, marketClient) {
  const url = new URL(`http://localhost${query}`);
  const symbol = url.searchParams.get('symbol');
  
  if (!symbol) {
    throw new Error('symbol parameter is required (e.g., ?symbol=AAPL)');
  }
  
  // Handle index symbols - Schwab API requires $ prefix for index symbols
  const indexSymbols = ['NDX', 'SPX', 'RUT', 'DJX', 'OEX', 'VIX'];
  
  // If symbol already has $ prefix, use it as-is
  // If it's an index symbol without $ prefix, add it
  // Otherwise, use symbol as-is
  const apiSymbol = symbol.startsWith('$') ? 
    symbol : 
    (indexSymbols.includes(symbol) ? `$${symbol}` : symbol);
  
  console.log(`[${timestamp}] 🔍 DEBUG: Original symbol: ${symbol}, API symbol: ${apiSymbol}`);
  
  // Extract optional parameters
  const periodType = url.searchParams.get('periodType') || undefined;
  const period = url.searchParams.get('period') ? parseInt(url.searchParams.get('period')) : undefined;
  const frequencyType = url.searchParams.get('frequencyType') || undefined;
  const frequency = url.searchParams.get('frequency') ? parseInt(url.searchParams.get('frequency')) : undefined;
  const startDate = url.searchParams.get('startDate') ? parseInt(url.searchParams.get('startDate')) : undefined;
  const endDate = url.searchParams.get('endDate') ? parseInt(url.searchParams.get('endDate')) : undefined;
  const needExtendedHoursData = url.searchParams.get('needExtendedHoursData') === 'true' ? true : undefined;
  const needPreviousClose = url.searchParams.get('needPreviousClose') === 'true' ? true : undefined;
  
  console.log(`[${timestamp}] Getting price history for: ${apiSymbol}`);
  console.log(`[${timestamp}] Parameters:`, {
    periodType,
    period,
    frequencyType,
    frequency,
    startDate: startDate ? new Date(startDate).toISOString() : undefined,
    endDate: endDate ? new Date(endDate).toISOString() : undefined,
    needExtendedHoursData,
    needPreviousClose
  });
  
  // Build options object (only include defined values)
  const options = {};
  if (periodType !== undefined) options.periodType = periodType;
  if (period !== undefined) options.period = period;
  if (frequencyType !== undefined) options.frequencyType = frequencyType;
  if (frequency !== undefined) options.frequency = frequency;
  if (startDate !== undefined) options.startDate = startDate;
  if (endDate !== undefined) options.endDate = endDate;
  if (needExtendedHoursData !== undefined) options.needExtendedHoursData = needExtendedHoursData;
  if (needPreviousClose !== undefined) options.needPreviousClose = needPreviousClose;
  
  console.log(`[${timestamp}] 🔗 API Request: marketClient.priceHistory("${apiSymbol}", ${JSON.stringify(options)})`);
  
  return await marketClient.priceHistory(apiSymbol, options);
}

module.exports = {
  handlePriceHistoryRequest
};
