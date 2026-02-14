const express = require('express');
const cors = require('cors');
const { MarketApiClient, TradingApiClient } = require('schwab-client-js');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// Debug: Log environment variables (without exposing secrets)
console.log('🔍 Environment Variables Check:');
console.log('✅ SCHWAB_CLIENT_ID:', process.env.SCHWAB_CLIENT_ID ? 'SET' : 'MISSING');
console.log('✅ SCHWAB_CLIENT_SECRET:', process.env.SCHWAB_CLIENT_SECRET ? 'SET' : 'MISSING');
console.log('✅ SCHWAB_REFRESH_TOKEN:', process.env.SCHWAB_REFRESH_TOKEN ? 'SET' : 'MISSING');
console.log('✅ ACCOUNT_HASH:', process.env.ACCOUNT_HASH ? 'SET' : 'MISSING');
console.log('✅ PORT:', process.env.PORT || '3001 (default)');

// Get account hash from environment
const ACCOUNT_HASH = process.env.ACCOUNT_HASH;
if (!ACCOUNT_HASH) {
  console.log('⚠️  WARNING: ACCOUNT_HASH not set in environment variables');
  console.log('   Some endpoints will require manual hash specification');
} else {
  console.log('✅ Account Hash loaded from environment');
}

// Enable CORS for all routes
app.use(cors());
app.use(express.json());

// Initialize Schwab clients
const marketClient = new MarketApiClient(
  process.env.SCHWAB_CLIENT_ID, 
  process.env.SCHWAB_CLIENT_SECRET, 
  process.env.SCHWAB_REFRESH_TOKEN
);
const tradingClient = new TradingApiClient(
  process.env.SCHWAB_CLIENT_ID, 
  process.env.SCHWAB_CLIENT_SECRET, 
  process.env.SCHWAB_REFRESH_TOKEN
);

// Handler Methods
const handleQuotesRequest = async (path, query, timestamp) => {
  const symbols = query.includes('symbols=') ? 
    query.split('symbols=')[1].split('&')[0].split(',') : null;
  
  if (!symbols || symbols.length === 0 || symbols[0] === '') {
    throw new Error('symbols parameter is required (e.g., ?symbols=AAPL,SPY)');
  }
  
  console.log(`[${timestamp}] Getting quotes for: ${symbols.join(', ')}`);
  console.log(`[${timestamp}] 🔗 API Request: marketClient.quotes(["${symbols.join('", "')}"])`);
  return await marketClient.quotes(symbols);
};

const handleExpirationChainRequest = async (path, query, timestamp) => {
  const symbol = query.includes('symbol=') ? 
    query.split('symbol=')[1].split('&')[0] : null;
  
  if (!symbol) {
    throw new Error('symbol parameter is required (e.g., ?symbol=SPY)');
  }
  
  console.log(`[${timestamp}] Getting expiration chain for: ${symbol}`);
  console.log(`[${timestamp}] 🔗 API Request: marketClient.optionExpirations("${symbol}")`);
  return await marketClient.optionExpirations(symbol);
};

const handleChainsRequest = async (path, query, timestamp) => {
  const url = new URL(`http://localhost:${PORT}${path}${query}`);
  // Parse raw query string to avoid auto-decoding
  const queryString = url.searchParams.toString();
  const symbolMatch = queryString.match(/symbol=([^&]+)/);
  const rawSymbol = symbolMatch ? symbolMatch[1] : null;
  const expirationDate = url.searchParams.get('expirationDate') || null;
  
  if (!rawSymbol || rawSymbol === '') {
    throw new Error('symbol parameter is required (e.g., ?symbol=SPY)');
  }
  
  if (!expirationDate || expirationDate === '') {
    throw new Error('expirationDate parameter is required (e.g., ?symbol=SPY&expirationDate=2024-01-19)');
  }
  
  // Extract optional parameters using SDK documentation names
  const strikeCountParam = url.searchParams.get('strikeCount') || url.searchParams.get('strike_count');
  const optionalParams = {
    strikeCount: strikeCountParam ? parseInt(strikeCountParam) : 100, // Default to 100 strikes if not provided
    contractType: url.searchParams.get('contractType') || url.searchParams.get('contract_type') || undefined, // From SDK docs
    includeUnderlyingQuote: url.searchParams.get('includeUnderlyingQuote') === 'true' || url.searchParams.get('include_underlying_quote') === 'true',
    strategy: url.searchParams.get('strategy') || undefined,
    range: url.searchParams.get('range') || url.searchParams.get('strike_range') || undefined, // From SDK docs
    optionType: url.searchParams.get('optionType') || url.searchParams.get('option_type') || undefined,
    strike: parseFloat(url.searchParams.get('strike')) || undefined,
    interval: parseInt(url.searchParams.get('interval')) || undefined,
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
  
  console.log(`[${timestamp}] Getting options chain for: ${rawSymbol}, exp: ${expirationDate}`);
  console.log(`[${timestamp}] Optional params:`, optionalParams);
  
  // Build the chain options object for schwab-client-js SDK
  const chainOptions = {
    ...optionalParams
    // Don't include expirationDate - use fromDate/toDate instead
  };
  
  console.log(`[${timestamp}] Final chain options:`, chainOptions);
  
  // Log the exact API request being made
  console.log(`[${timestamp}] 🔗 API Request: marketClient.chains("${rawSymbol}", ${JSON.stringify(optionalParams)})`);
  
  // Decode the symbol for Schwab SDK (e.g., %24NDX -> $NDX)
  const decodedSymbol = decodeURIComponent(rawSymbol);
  console.log(`[${timestamp}] Getting options chain for: ${decodedSymbol}`);
  console.log(`[${timestamp}] Options object:`, optionalParams);
  
  // Pass symbol and options object to Schwab SDK
  const result = await marketClient.chains(decodedSymbol, optionalParams);
  
  // Debug: Check what expiration date we actually got back
  if (result && result.callExpDateMap) {
    const expirationDates = Object.keys(result.callExpDateMap);
    if (expirationDates.length > 0) {
      // console.log(`[${timestamp}] 🎯 DEBUG: Requested: ${expirationDate}, Got: ${expirationDates[0]}`);
    }
  }
  
  return result;
};

// Debug middleware to log all requests
app.use((req, res, next) => {
  console.log(`${req.method} ${req.path}`);
  next();
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    sdk: 'schwab-client-js',
    endpoints: {
      marketData: true,
      trading: true
    }
  });
});

// Proxy endpoint for Schwab Market Data API
app.all('/api/v1/marketdata/*', async (req, res) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] === MARKET DATA REQUEST ===`);
  try {
    const path = req.path.replace('/api/v1/marketdata', '');
    const query = new URL(req.url, `http://localhost:${PORT}`).search;
    
    console.log(`[${timestamp}] Path: ${path}`);
    console.log(`[${timestamp}] Query: ${query}`);
    console.log(`[${timestamp}] Method: ${req.method}`);

    let result;

    // Route to appropriate SDK method
    if (path.startsWith('/quotes')) {
      result = await handleQuotesRequest(path, query, timestamp);
      
    } else if (path.startsWith('/expirationchain')) {
      result = await handleExpirationChainRequest(path, query, timestamp);
      
    } else if (path.startsWith('/chains')) {
      result = await handleChainsRequest(path, query, timestamp);
      
    } else {
      throw new Error(`Unsupported market data endpoint: ${path}`);
    }

    console.log(`[${timestamp}] ✅ Market data request successful`);
    res.json(result);

  } catch (error) {
    console.error(`[${timestamp}] ❌ Market data request failed:`, error.message);
    
    // Special handling for options chain 502 errors
    if (req.path.includes('/chains') && error.message.includes('502')) {
      res.status(503).json({
        error: 'Options chain temporarily unavailable',
        message: 'Schwab options chain endpoint is experiencing issues. This is a known Schwab API issue. Please try again later.',
        path: req.path,
        fallback: 'You can still get quotes and option expirations, but detailed chains may be temporarily unavailable.'
      });
    } else {
      res.status(500).json({
        error: 'Market data request failed',
        message: error.message,
        path: req.path
      });
    }
  }
});

// Proxy endpoint for Schwab Trading API
app.all('/api/v1/trading/*', async (req, res) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] === TRADING REQUEST ===`);
  try {
    const path = req.path.replace('/api/v1/trading', '');
    const query = new URL(req.url, `http://localhost:${PORT}`).search;
    
    console.log(`[${timestamp}] Path: ${path}`);
    console.log(`[${timestamp}] Query: ${query}`);
    console.log(`[${timestamp}] Method: ${req.method}`);

    let result;

    // Route to appropriate SDK method
    // Check for DELETE order with orderId first: /{accountNumber}/orders/{orderId}
    const deleteOrderMatch = path.match(/^\/([^\/]+)\/orders\/(\d+)$/);
    if (deleteOrderMatch && req.method === 'DELETE') {
      let accountNumber = deleteOrderMatch[1];
      const orderId = deleteOrderMatch[2];
      
      // If accountNumber is "HASH", use environment ACCOUNT_HASH
      if (accountNumber === 'HASH') {
        if (!ACCOUNT_HASH) {
          throw new Error('ACCOUNT_HASH not set in environment variables');
        }
        accountNumber = ACCOUNT_HASH;
        console.log(`[${timestamp}] Using ACCOUNT_HASH from environment for delete: ${accountNumber.substring(0, 10)}...`);
      }
      
      console.log(`[${timestamp}] Canceling order ${orderId} for account: ${accountNumber.substring(0, 10)}...`);
      
      try {
        result = await tradingClient.orderDelete(accountNumber, orderId);
        console.log(`[${timestamp}] Order ${orderId} successfully canceled`);
      } catch (apiError) {
        console.error(`[${timestamp}] 🔍 Schwab API Error Details:`);
        console.error(`[${timestamp}] Error message:`, apiError.message);
        console.error(`[${timestamp}] Error stack:`, apiError.stack);
        
        if (apiError.response) {
          console.error(`[${timestamp}] Response status:`, apiError.response.status);
          console.error(`[${timestamp}] Response headers:`, apiError.response.headers);
          console.error(`[${timestamp}] Response data:`, apiError.response.data);
        }
        
        if (apiError.request) {
          console.error(`[${timestamp}] Request data:`, apiError.request);
        }
        
        // Re-throw with enhanced info
        throw apiError;
      }
    }
      
    // Check for account-specific order placement first: /{accountNumber}/orders
    const accountOrderMatch = path.match(/^\/([^\/]+)\/orders$/);
    if (accountOrderMatch) {
      let accountNumber = accountOrderMatch[1];
      
      // If accountNumber is "HASH", use environment ACCOUNT_HASH
      if (accountNumber === 'HASH') {
        if (!ACCOUNT_HASH) {
          throw new Error('ACCOUNT_HASH not set in environment variables');
        }
        accountNumber = ACCOUNT_HASH;
        console.log(`[${timestamp}] Using ACCOUNT_HASH from environment: ${accountNumber.substring(0, 10)}...`);
      }
      
      console.log(`[${timestamp}] Placing order for account: ${accountNumber.substring(0, 10)}...`);
      
      if (req.method === 'POST') {
        // PLACE ORDER for specific account
        console.log(`[${timestamp}] Placing new order`);
        const orderData = req.body;
        console.log(`[${timestamp}] Order data:`, JSON.stringify(orderData, null, 2));
        
        // Validate required fields
        const requiredFields = ['orderType', 'session', 'duration', 'orderStrategyType'];
        const missingFields = requiredFields.filter(field => !orderData[field]);
        
        // complexOrderStrategyType is only required for multi-leg orders
        if (orderData.orderLegCollection && orderData.orderLegCollection.length > 1) {
          requiredFields.push('complexOrderStrategyType');
        }
        
        const finalMissingFields = requiredFields.filter(field => !orderData[field]);
        
        if (finalMissingFields.length > 0) {
          throw new Error(`Missing required fields: ${finalMissingFields.join(', ')}`);
        }
        
        // Check for correct field name: orderLegCollection (not leg)
        if (!orderData.orderLegCollection || !Array.isArray(orderData.orderLegCollection) || orderData.orderLegCollection.length === 0) {
          throw new Error('Order must contain orderLegCollection array with at least one leg');
        }
        
        // Validate each leg
        orderData.orderLegCollection.forEach((leg, index) => {
          if (!leg.instrument || !leg.instrument.symbol) {
            throw new Error(`Leg ${index + 1}: Missing instrument symbol`);
          }
          if (!leg.instruction) {
            throw new Error(`Leg ${index + 1}: Missing instruction (use BUY, SELL, BUY_TO_OPEN, SELL_TO_OPEN, etc.)`);
          }
          if (!leg.quantity || leg.quantity <= 0) {
            throw new Error(`Leg ${index + 1}: Invalid quantity`);
          }
          
          // Validate asset type
          if (!leg.instrument.assetType || !['EQUITY', 'OPTION'].includes(leg.instrument.assetType)) {
            throw new Error(`Leg ${index + 1}: Invalid assetType (must be EQUITY or OPTION)`);
          }
        });
        
        console.log(`[${timestamp}] Order validation passed, placing order for account: ${accountNumber}`);
        
        try {
          result = await tradingClient.placeOrderByAcct(accountNumber, orderData);
        } catch (apiError) {
          console.error(`[${timestamp}] 🔍 Schwab API Error Details:`);
          console.error(`[${timestamp}] Error message:`, apiError.message);
          console.error(`[${timestamp}] Error stack:`, apiError.stack);
          
          if (apiError.response) {
            console.error(`[${timestamp}] Response status:`, apiError.response.status);
            console.error(`[${timestamp}] Response headers:`, apiError.response.headers);
            console.error(`[${timestamp}] Response data:`, apiError.response.data);
          }
          
          if (apiError.request) {
            console.error(`[${timestamp}] Request data:`, apiError.request);
          }
          
          // Re-throw with enhanced info
          throw apiError;
        }
        
      } else if (req.method === 'DELETE') {
        // DELETE ORDER - Cancel order for specific account
        console.log(`[${timestamp}] Canceling order for account: ${accountNumber.substring(0, 10)}...`);
        
        // Extract orderId from path: /{accountNumber}/orders/{orderId}
        const pathMatch = path.match(/^\/([^\/]+)\/orders\/(\d+)$/);
        if (!pathMatch) {
          throw new Error('Invalid DELETE order path. Expected format: /{accountNumber}/orders/{orderId}');
        }
        
        const orderId = pathMatch[2];
        console.log(`[${timestamp}] Canceling order ID: ${orderId}`);
        
        // Handle HASH environment variable for accountNumber
        let deleteAccountNumber = accountNumber;
        if (deleteAccountNumber === 'HASH') {
          if (!ACCOUNT_HASH) {
            throw new Error('ACCOUNT_HASH not set in environment variables');
          }
          deleteAccountNumber = ACCOUNT_HASH;
          console.log(`[${timestamp}] Using ACCOUNT_HASH from environment for delete: ${deleteAccountNumber.substring(0, 10)}...`);
        }
        
        try {
          result = await tradingClient.cancelOrder(deleteAccountNumber, orderId);
          console.log(`[${timestamp}] Order ${orderId} successfully canceled`);
        } catch (apiError) {
          console.error(`[${timestamp}] 🔍 Schwab API Error Details:`);
          console.error(`[${timestamp}] Error message:`, apiError.message);
          console.error(`[${timestamp}] Error stack:`, apiError.stack);
          
          if (apiError.response) {
            console.error(`[${timestamp}] Response status:`, apiError.response.status);
            console.error(`[${timestamp}] Response headers:`, apiError.response.headers);
            console.error(`[${timestamp}] Response data:`, apiError.response.data);
          }
          
          if (apiError.request) {
            console.error(`[${timestamp}] Request data:`, apiError.request);
          }
          
          // Re-throw with enhanced info
          throw apiError;
        }
        
      } else {
        // GET ORDERS for specific account
        console.log(`[${timestamp}] Getting orders for account: ${accountNumber}`);
        
        // Parse query parameters for orders
        const url = new URL(req.url, `http://localhost:${PORT}`);
        const fromDateTime = url.searchParams.get('fromDateTime') || url.searchParams.get('fromEnteredTime');
        const toDateTime = url.searchParams.get('toDateTime') || url.searchParams.get('toEnteredTime');
        const status = url.searchParams.get('status') || null;
        const maxResults = url.searchParams.get('maxResults') || null;
        
        // Set default values for required parameters if not provided
        const defaultFromTime = fromDateTime || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days ago
        const defaultToTime = toDateTime || new Date().toISOString(); // Now
        
        console.log(`[${timestamp}] Order parameters: from=${defaultFromTime}, to=${defaultToTime}, status=${status}, maxResults=${maxResults}`);
        result = await tradingClient.ordersByAccount(accountNumber, defaultFromTime, defaultToTime, status, maxResults);
      }
      
    } else if (path.startsWith('/orders')) {
      console.log(`[${timestamp}] Getting all orders`);
      
      // Parse query parameters for orders
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const fromDateTime = url.searchParams.get('fromDateTime') || url.searchParams.get('fromEnteredTime');
      const toDateTime = url.searchParams.get('toDateTime') || url.searchParams.get('toEnteredTime');
      const status = url.searchParams.get('status') || null;
      const maxResults = url.searchParams.get('maxResults') || null;
      
      // Set default values for required parameters if not provided
      const defaultFromTime = fromDateTime || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days ago
      const defaultToTime = toDateTime || new Date().toISOString(); // Now
      
      console.log(`[${timestamp}] Order parameters: from=${defaultFromTime}, to=${defaultToTime}, status=${status}, maxResults=${maxResults}`);
      
      if (req.method === 'POST') {
        // PLACE ORDER
        console.log(`[${timestamp}] Placing new order`);
        const orderData = req.body;
        console.log(`[${timestamp}] Order data:`, JSON.stringify(orderData, null, 2));
        
        // Extract account number from order data or path
        let accountNumber = orderData.accountNumber;
        if (!accountNumber && path.includes('/')) {
          const pathMatch = path.match(/^\/([^\/]+)/);
          if (pathMatch) {
            accountNumber = pathMatch[1];
            // If accountNumber is "HASH", use environment ACCOUNT_HASH
            if (accountNumber === 'HASH') {
              if (!ACCOUNT_HASH) {
                throw new Error('ACCOUNT_HASH not set in environment variables');
              }
              accountNumber = ACCOUNT_HASH;
              console.log(`[${timestamp}] Using ACCOUNT_HASH from environment: ${accountNumber.substring(0, 10)}...`);
            }
          }
        }
        
        if (!accountNumber) {
          throw new Error('Account number is required for order placement');
        }
        
        console.log(`[${timestamp}] Placing order for account: ${accountNumber}`);
        result = await tradingClient.placeOrderByAcct(accountNumber, orderData);
        
      } else {
        // GET ORDERS
        result = await tradingClient.orderAll(defaultFromTime, defaultToTime, status, maxResults);
      }
      
    } else if (path.startsWith('/accounts')) {
      
      if (path === '/accounts' || path === '/accounts/') {
        console.log(`[${timestamp}] Getting all accounts`);
        result = await tradingClient.accountsAll();
        
      } else if (path === '/accounts/accountNumbers') {
        console.log(`[${timestamp}] Getting account numbers and hash values`);
        result = await tradingClient.accountsNumbers();
        
      } else if (path.match(/^\/accounts\/[^\/]+$/)) {
        // Handle /accounts/{accountNumber} - single account details
        const accountMatch = path.match(/\/accounts\/([^\/]+)/);
        if (accountMatch) {
          let accountNumber = accountMatch[1];
          
          // If accountNumber is "HASH", use environment ACCOUNT_HASH
          if (accountNumber === 'HASH') {
            if (!ACCOUNT_HASH) {
              throw new Error('ACCOUNT_HASH not set in environment variables');
            }
            accountNumber = ACCOUNT_HASH;
            console.log(`[${timestamp}] Using ACCOUNT_HASH from environment: ${accountNumber.substring(0, 10)}...`);
          }
          
          console.log(`[${timestamp}] Getting account details for: ${accountNumber.substring(0, 10)}...`);
          result = await tradingClient.accountsDetails(accountNumber);
        } else {
          throw new Error('Account number required for account details endpoint');
        }
        
      } else if (path.includes('/balances')) {
        // Extract account number from path
        const accountMatch = path.match(/\/accounts\/([^\/]+)\/balances/);
        if (accountMatch) {
          let accountNumber = accountMatch[1];
          
          // If accountNumber is "HASH", use environment ACCOUNT_HASH
          if (accountNumber === 'HASH') {
            if (!ACCOUNT_HASH) {
              throw new Error('ACCOUNT_HASH not set in environment variables');
            }
            accountNumber = ACCOUNT_HASH;
            console.log(`[${timestamp}] Using ACCOUNT_HASH from environment: ${accountNumber.substring(0, 10)}...`);
          }
          
          console.log(`[${timestamp}] Getting account details (including balances) for account: ${accountNumber.substring(0, 10)}...`);
          // Use accountsDetails which includes balance information
          result = await tradingClient.accountsDetails(accountNumber);
        } else {
          throw new Error('Account number required for balances endpoint');
        }
        
      } else if (path.includes('/positions')) {
        // Extract account number from path
        const accountMatch = path.match(/\/accounts\/([^\/]+)\/positions/);
        if (accountMatch) {
          let accountNumber = accountMatch[1];
          
          // If accountNumber is "HASH", use environment ACCOUNT_HASH
          if (accountNumber === 'HASH') {
            if (!ACCOUNT_HASH) {
              throw new Error('ACCOUNT_HASH not set in environment variables');
            }
            accountNumber = ACCOUNT_HASH;
            console.log(`[${timestamp}] Using ACCOUNT_HASH from environment: ${accountNumber.substring(0, 10)}...`);
          }
          
          console.log(`[${timestamp}] Getting account details (including positions) for account: ${accountNumber.substring(0, 10)}...`);
          // Use accountsDetails which includes position information
          result = await tradingClient.accountsDetails(accountNumber);
        } else {
          throw new Error('Account number required for positions endpoint');
        }
        
      } else if (path.includes('/orders')) {
        // Extract account number from path
        const accountMatch = path.match(/\/accounts\/([^\/]+)\/orders/);
        if (accountMatch) {
          let accountNumber = accountMatch[1];
          
          // If accountNumber is "HASH", use environment ACCOUNT_HASH
          if (accountNumber === 'HASH') {
            if (!ACCOUNT_HASH) {
              throw new Error('ACCOUNT_HASH not set in environment variables');
            }
            accountNumber = ACCOUNT_HASH;
            console.log(`[${timestamp}] Using ACCOUNT_HASH from environment: ${accountNumber.substring(0, 10)}...`);
          }
          
          console.log(`[${timestamp}] Getting orders for account: ${accountNumber.substring(0, 10)}...`);
          
          // Parse query parameters for orders
          const url = new URL(req.url, `http://localhost:${PORT}`);
          const fromDateTime = url.searchParams.get('fromDateTime') || url.searchParams.get('fromEnteredTime');
          const toDateTime = url.searchParams.get('toDateTime') || url.searchParams.get('toEnteredTime');
          const status = url.searchParams.get('status') || null;
          const maxResults = url.searchParams.get('maxResults') || null;
          
          // Set default values for required parameters if not provided
          const defaultFromTime = fromDateTime || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days ago
          const defaultToTime = toDateTime || new Date().toISOString(); // Now
          
          console.log(`[${timestamp}] Order parameters: from=${defaultFromTime}, to=${defaultToTime}, status=${status}, maxResults=${maxResults}`);
          // Use correct method name: ordersByAccount with required parameters
          result = await tradingClient.ordersByAccount(accountNumber, defaultFromTime, defaultToTime, status, maxResults);
        } else {
          throw new Error('Account number required for orders endpoint');
        }
        
      } else if (path.includes('/transactions')) {
        // Extract account number from path
        const accountMatch = path.match(/\/accounts\/([^\/]+)\/transactions/);
        if (accountMatch) {
          let accountNumber = accountMatch[1];
          
          // If accountNumber is "HASH", use environment ACCOUNT_HASH
          if (accountNumber === 'HASH') {
            if (!ACCOUNT_HASH) {
              throw new Error('ACCOUNT_HASH not set in environment variables');
            }
            accountNumber = ACCOUNT_HASH;
            console.log(`[${timestamp}] Using ACCOUNT_HASH from environment: ${accountNumber.substring(0, 10)}...`);
          }
          
          console.log(`[${timestamp}] Getting transactions for account: ${accountNumber.substring(0, 10)}...`);
          
          // Parse query parameters for transactions
          const url = new URL(req.url, `http://localhost:${PORT}`);
          const startDate = url.searchParams.get('startDate') || null;
          const endDate = url.searchParams.get('endDate') || null;
          const transactionType = url.searchParams.get('transactionType') || null;
          const symbol = url.searchParams.get('symbol') || null;
          
          const transactionParams = {};
          if (startDate) transactionParams.startDate = startDate;
          if (endDate) transactionParams.endDate = endDate;
          if (transactionType) transactionParams.transactionType = transactionType;
          if (symbol) transactionParams.symbol = symbol;
          
          console.log(`[${timestamp}] Transaction parameters:`, transactionParams);
          // Use correct method name: transactByAcct
          result = await tradingClient.transactByAcct(accountNumber, transactionParams);
        } else {
          throw new Error('Account number required for transactions endpoint');
        }
        
      } else {
        // Try to extract account number for general account info
        const accountMatch = path.match(/\/accounts\/([^\/]+)/);
        if (accountMatch) {
          const accountNumber = accountMatch[1];
          console.log(`[${timestamp}] Getting account details for: ${accountNumber}`);
          // Use correct method name: accountsDetails
          result = await tradingClient.accountsDetails(accountNumber);
        } else {
          throw new Error(`Unsupported trading endpoint: ${path}`);
        }
      }
      
    } else {
      throw new Error(`Unsupported trading endpoint: ${path}`);
    }

    console.log(`[${timestamp}] ✅ Trading request successful`);
    res.json(result);

  } catch (error) {
    console.error(`[${timestamp}] ❌ Trading request failed:`, error.message);
    
    // Enhanced error logging for validation errors
    if (error.message.includes('validation error') || error.message.includes('400')) {
      console.error(`[${timestamp}] 🔍 Validation Error Details:`);
      if (error.response && error.response.data) {
        console.error(`[${timestamp}] Response data:`, JSON.stringify(error.response.data, null, 2));
      }
      if (error.response && error.response.status) {
        console.error(`[${timestamp}] HTTP Status: ${error.response.status}`);
      }
      console.error(`[${timestamp}] Request path: ${req.path}`);
      console.error(`[${timestamp}] Request method: ${req.method}`);
      if (req.body) {
        console.error(`[${timestamp}] Request body:`, JSON.stringify(req.body, null, 2));
      }
    }
    
    res.status(500).json({
      error: 'Trading request failed',
      message: error.message,
      path: req.path,
      timestamp: timestamp,
      details: error.response ? error.response.data : null
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Schwab SDK Proxy Server running on http://localhost:${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`📈 Market Data API: http://localhost:${PORT}/api/v1/marketdata/quotes?symbols=SPY`);
  console.log(`📅 Option Expirations: http://localhost:${PORT}/api/v1/marketdata/expirationchain?symbol=SPY`);
  console.log(`💼 Options Chain: http://localhost:${PORT}/api/v1/marketdata/chains?symbol=SPY&expirationDate=2024-01-19`);
  console.log(`🎯 Enhanced Chain: http://localhost:${PORT}/api/v1/marketdata/chains?symbol=SPY&expirationDate=2024-01-19&strike_count=10&contract_type=CALL`);
  console.log(``);
  console.log(`💰 Trading & Account API:`);
  console.log(`📋 All Accounts: http://localhost:${PORT}/api/v1/trading/accounts`);
  console.log(`🔐 Account Numbers (Hash Values): http://localhost:${PORT}/api/v1/trading/accounts/accountNumbers`);
  console.log(`💳 Account Details: http://localhost:${PORT}/api/v1/trading/accounts/HASH`);
  console.log(`💰 Account Balances: http://localhost:${PORT}/api/v1/trading/accounts/HASH/balances`);
  console.log(`📊 Account Positions: http://localhost:${PORT}/api/v1/trading/accounts/HASH/positions`);
  console.log(`📋 Account Orders: http://localhost:${PORT}/api/v1/trading/accounts/HASH/orders`);
  console.log(`📈 All Orders: http://localhost:${PORT}/api/v1/trading/orders`);
  console.log(`� Account Transactions: http://localhost:${PORT}/api/v1/trading/accounts/HASH/transactions`);
  console.log(`🎯 Place Order: POST http://localhost:${PORT}/api/v1/trading/HASH/orders`);
  console.log(`🎯 Place Order (Account): POST http://localhost:${PORT}/api/v1/trading/{accountNumber}/orders`);
  console.log(``);
  console.log(`🌍 Environment-Based Endpoints (uses ACCOUNT_HASH from .env):`);
  console.log(`✅ Use "HASH" instead of full hash value`);
  console.log(`✅ Example: /accounts/HASH instead of /accounts/D7F05FFF...`);
  console.log(`✅ Example: /HASH/orders instead of /D7F05FFF.../orders`);
  console.log(``);
  console.log(`🔍 Query Parameters:`);
  console.log(`📋 Orders: ?fromDateTime=2024-01-01T00:00:00Z&toDateTime=2024-01-31T23:59:59Z&status=FILLED`);
  console.log(`💰 Transactions: ?startDate=2024-01-01&endDate=2024-01-31&transactionType=TRADE&symbol=AAPL`);
  console.log(``);
  console.log(`📋 Spread Order Examples:`);
  console.log(`curl -X POST http://localhost:3001/api/v1/trading/orders \\`);
  console.log(`  -H "Content-Type: application/json" \\`);
  console.log(`  -d '{"orderType": "NET_DEBIT", "session": "NORMAL", "duration": "DAY", "complexOrderStrategyType": "VERTICAL", "price": "2.50", "quantity": 1, "leg": [{"instrument": {"symbol": "SPY", "assetType": "OPTION"}, "orderLegType": "BUY_TO_OPEN", "quantity": 1, "openClose": "OPEN", "positionEffect": "OPEN"}, {"instrument": {"symbol": "SPY", "assetType": "OPTION"}, "orderLegType": "SELL_TO_OPEN", "quantity": 1, "openClose": "OPEN", "positionEffect": "OPEN"}]}'`);
  console.log(`curl -X POST http://localhost:3001/api/v1/trading/46860914/orders \\`);
  console.log(`  -H "Content-Type: application/json" \\`);
  console.log(`  -d '{"orderType": "NET_DEBIT", "session": "NORMAL", "duration": "DAY", "complexOrderStrategyType": "VERTICAL", "price": "0.05", "quantity": 1, "leg": [{"instrument": {"symbol": "SPY_021926C690", "assetType": "OPTION"}, "orderLegType": "BUY_TO_OPEN", "quantity": 1}, {"instrument": {"symbol": "SPY_021926C695", "assetType": "OPTION"}, "orderLegType": "SELL_TO_OPEN", "quantity": 1}]}'`);
});
