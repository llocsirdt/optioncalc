const express = require('express');
const cors = require('cors');
const { MarketApiClient, TradingApiClient } = require('schwab-client-js');
require('dotenv').config({ path: '../.env' });

// Import persistence manager
const PersistenceManager = require('./persistence/persistence');

// Import shared handlers and market client
const { handleChainsRequest } = require('./persistence/chains-handler');
const { handlePriceHistoryRequest } = require('./persistence/price-history-handler');
const { analyzeCandles } = require('./persistence/candle-analyzer');
const { marketClient } = require('./persistence/market-client');

const app = express();
const PORT = process.env.PORT || 3001;

// Initialize persistence manager
const persistence = new PersistenceManager();

// Environment detection
const isDevMode = process.env.NODE_ENV === 'development' || !process.env.NODE_ENV;

// Dev-only middleware
function requireDevMode(req, res, next) {
  if (isDevMode) {
    next();
  } else {
    res.status(404).json({
      error: 'Endpoint not found',
      message: 'This endpoint is only available in development mode',
      timestamp: new Date().toISOString()
    });
  }
}

// Debug: Log environment variables (without exposing secrets)
console.log('🔍 Environment Variables Check:');
console.log('✅ SCHWAB_CLIENT_ID:', process.env.SCHWAB_CLIENT_ID ? 'SET' : 'MISSING');
console.log('✅ SCHWAB_CLIENT_SECRET:', process.env.SCHWAB_CLIENT_SECRET ? 'SET' : 'MISSING');
console.log('✅ SCHWAB_REFRESH_TOKEN:', process.env.SCHWAB_REFRESH_TOKEN ? 'SET' : 'MISSING');
console.log('✅ ACCOUNT_HASH:', process.env.ACCOUNT_HASH ? 'SET' : 'MISSING');
console.log('✅ PORT:', process.env.PORT || '3001 (default)');
console.log('🔧 Development Mode:', isDevMode ? 'ENABLED' : 'DISABLED');

// Get account hash from environment
const ACCOUNT_HASH = process.env.ACCOUNT_HASH;
if (!ACCOUNT_HASH) {
  console.log('⚠️  WARNING: ACCOUNT_HASH not set in environment variables');
  console.log('   Some endpoints will require manual hash specification');
} else {
  console.log('✅ Account Hash loaded from environment');
}

// Initialize persistence system
async function initializePersistence() {
  try {
    console.log('🔄 Initializing persistence system...');
    await persistence.loadState();
    
    // Log state summary
    const summary = persistence.getStateSummary();
    console.log('📊 State Summary:', JSON.stringify(summary, null, 2));
    
    // Clean up old data
    await persistence.cleanup();
    
    console.log('✅ Persistence system ready');
  } catch (error) {
    console.error('❌ Failed to initialize persistence:', error.message);
  }
}

// Enable CORS for all routes
app.use(cors());
app.use(express.json());
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
  console.log(`[${timestamp}] 🔗 API Request: marketClient.expirationChain("${symbol}")`);
  return await marketClient.expirationChain(symbol);
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
      result = await handleChainsRequest(path, query, timestamp, persistence, marketClient);
      
    } else if (path.startsWith('/pricehistory')) {
      result = await handlePriceHistoryRequest(path, query, timestamp, marketClient);
      
    } else if (path.startsWith('/candleanalysis')) {
      const url = new URL(`http://localhost${query}`);
      const symbol = url.searchParams.get('symbol');
      const timeframe = url.searchParams.get('timeframe');
      
      if (!symbol) {
        throw new Error('symbol parameter is required (e.g., ?symbol=SPY)');
      }
      
      const options = {};
      if (timeframe) {
        // Validate timeframe
        const validTimeframes = ['1m', '5m', '15m', '60m', 'daily'];
        if (!validTimeframes.includes(timeframe)) {
          throw new Error(`Invalid timeframe '${timeframe}'. Valid options: ${validTimeframes.join(', ')}`);
        }
        options.timeframe = timeframe;
      }
      
      console.log(`[${timestamp}] Analyzing candles for: ${symbol}${timeframe ? ` (${timeframe})` : ''}`);
      result = await analyzeCandles(symbol, options);
      
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

// Proxy endpoint for Schwab Trading API (Development Only)
app.all('/api/v1/trading/*', requireDevMode, async (req, res) => {
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
        
        // Mark order as completed in persistence
        persistence.completeOrder(orderId);
        await persistence.saveState();
        console.log(`[${timestamp}] 📋 Order marked as completed in persistence: ${orderId}`);
        
        // Return success message for proper response handling
        result = { message: 'Order successfully canceled' };
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
      
    // Check for account-specific order placement: /{accountNumber}/orders (POST only)
    const accountOrderMatch = path.match(/^\/([^\/]+)\/orders$/);
    if (accountOrderMatch && req.method === 'POST') {
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
        
        // Track order in persistence
        if (result && result.orderId) {
          const orderData = {
            orderId: result.orderId,
            symbol: orderData.orderLegCollection?.[0]?.instrument?.symbol || 'UNKNOWN',
            orderType: orderData.orderType,
            accountHash: accountNumber
          };
          persistence.trackOrder(orderData, 'active');
          await persistence.saveState();
          console.log(`[${timestamp}] 📋 Order tracked for persistence: ${result.orderId}`);
        }
        
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
          const startDate = url.searchParams.get('startDate');
          const endDate = url.searchParams.get('endDate');
          const transactionType = url.searchParams.get('transactionType');
          const symbol = url.searchParams.get('symbol');
          
          // Build transaction parameters only with valid values
          const transactionParams = {};
          if (startDate && startDate.trim()) {
            transactionParams.startDate = startDate.trim();
          }
          if (endDate && endDate.trim()) {
            transactionParams.endDate = endDate.trim();
          }
          if (transactionType && transactionType.trim()) {
            transactionParams.transactionType = transactionType.trim();
          }
          if (symbol && symbol.trim()) {
            transactionParams.symbol = symbol.trim();
          }
          
          console.log(`[${timestamp}] Transaction parameters:`, transactionParams);
          
          // Use correct method name: transactByAcct
          // Only pass parameters if they exist, otherwise pass empty object
          const params = Object.keys(transactionParams).length > 0 ? transactionParams : {};
          result = await tradingClient.transactByAcct(accountNumber, params);
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
    
    // Log error to persistence
    persistence.logError({
      message: error.message,
      stack: error.stack,
      path: req.path,
      method: req.method,
      timestamp: new Date().toISOString()
    });
    
    // Save state with error info
    await persistence.saveState();
    
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

// Persistence management endpoints
app.get('/api/v1/admin/state', async (req, res) => {
  try {
    const summary = persistence.getStateSummary();
    const activeOrders = persistence.getActiveOrders();
    const recentErrors = persistence.getRecentErrors(10);
    
    res.json({
      summary,
      activeOrders,
      recentErrors,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get state',
      message: error.message
    });
  }
});

app.post('/api/v1/admin/state/save', async (req, res) => {
  try {
    await persistence.saveState();
    res.json({
      message: 'State saved successfully',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to save state',
      message: error.message
    });
  }
});

app.post('/api/v1/admin/state/cleanup', async (req, res) => {
  try {
    await persistence.cleanup();
    await persistence.saveState();
    res.json({
      message: 'Cleanup completed successfully',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to cleanup state',
      message: error.message
    });
  }
});

app.post('/api/v1/admin/state/reset', async (req, res) => {
  try {
    await persistence.resetState();
    res.json({
      message: 'State reset successfully',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to reset state',
      message: error.message
    });
  }
});

// Position management endpoints
app.post('/api/v1/positions', async (req, res) => {
  try {
    const { symbol, expiration, position } = req.body;
    
    // Validate required parameters
    if (!symbol || !expiration || !position) {
      return res.status(400).json({
        error: 'Missing required parameters',
        required: ['symbol', 'expiration', 'position']
      });
    }
    
    // Store the position
    const positionObj = await persistence.storePosition(symbol, expiration, position);
    
    res.json({
      message: 'Position stored successfully',
      position: positionObj,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    res.status(500).json({
      error: 'Failed to store position',
      message: error.message
    });
  }
});

app.get('/api/v1/positions/:symbol/:expiration', async (req, res) => {
  try {
    const { symbol, expiration } = req.params;
    
    const positions = await persistence.getPositions(symbol, expiration);
    
    res.json({
      symbol,
      expiration,
      positions,
      count: positions.length,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    res.status(500).json({
      error: 'Failed to retrieve positions',
      message: error.message
    });
  }
});

app.get('/api/v1/positions', async (req, res) => {
  try {
    const positions = await persistence.getAllPositions();
    
    res.json({
      positions,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    res.status(500).json({
      error: 'Failed to retrieve all positions',
      message: error.message
    });
  }
});

app.get('/api/v1/positions/offsetting', async (req, res) => {
  try {
    const { symbol, expiration } = req.query;
    let offsettingAnalysis = await persistence.findOffsettingPositions();
    
    // Filter by symbol and/or expiration if provided
    if (symbol || expiration) {
      const filtered = {};
      const filterKey = symbol && expiration ? `${symbol}_${expiration}` : null;
      
      for (const [key, value] of Object.entries(offsettingAnalysis)) {
        // If both symbol and expiration provided, match exact key
        if (filterKey && key === filterKey) {
          filtered[key] = value;
        }
        // If only symbol provided, match symbol prefix
        else if (symbol && !expiration && key.startsWith(`${symbol}_`)) {
          filtered[key] = value;
        }
        // If only expiration provided, match expiration suffix
        else if (expiration && !symbol && key.endsWith(`_${expiration}`)) {
          filtered[key] = value;
        }
      }
      
      offsettingAnalysis = filtered;
    }
    
    res.json({
      offsettingAnalysis,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    res.status(500).json({
      error: 'Failed to find offsetting positions',
      message: error.message
    });
  }
});

// Chains cache management endpoints
app.get('/api/v1/admin/chains', async (req, res) => {
  try {
    const summary = persistence.getChainCacheSummary();
    
    res.json({
      message: 'Chains cache summary',
      summary,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get chains cache summary',
      message: error.message
    });
  }
});

app.delete('/api/v1/admin/chains', async (req, res) => {
  try {
    const maxAgeHours = parseInt(req.query.maxAgeHours) || 24;
    const clearedCount = persistence.clearOldChainCache(maxAgeHours);
    
    res.json({
      message: `Cleared ${clearedCount} old chain cache entries`,
      clearedCount,
      maxAgeHours,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to clear chains cache',
      message: error.message
    });
  }
});

app.get('/api/v1/admin/chains/:symbol/:expiration', async (req, res) => {
  try {
    const { symbol, expiration } = req.params;
    const cachedData = persistence.getCachedChainData(symbol, expiration);
    
    if (!cachedData) {
      return res.status(404).json({
        error: 'Chain data not found',
        message: `No cached data for ${symbol} ${expiration}`,
        symbol,
        expiration
      });
    }
    
    res.json({
      message: 'Retrieved cached chain data',
      symbol,
      expiration,
      data: cachedData,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get cached chain data',
      message: error.message
    });
  }
});

// Development-only endpoints
app.get('/api/v1/dev/debug', requireDevMode, (req, res) => {
  res.json({
    message: 'Development debug endpoint',
    environment: process.env.NODE_ENV || 'development',
    isDevMode,
    timestamp: new Date().toISOString(),
    serverInfo: {
      nodeVersion: process.version,
      platform: process.platform,
      memory: process.memoryUsage(),
      uptime: process.uptime()
    }
  });
});

app.get('/api/v1/dev/env', requireDevMode, (req, res) => {
  const safeEnv = {
    NODE_ENV: process.env.NODE_ENV || 'development',
    PORT: process.env.PORT || 3001,
    // Only show safe environment variables
    SCHWAB_CLIENT_ID: process.env.SCHWAB_CLIENT_ID ? 'SET' : 'MISSING',
    SCHWAB_CLIENT_SECRET: process.env.SCHWAB_CLIENT_SECRET ? 'SET' : 'MISSING',
    SCHWAB_REFRESH_TOKEN: process.env.SCHWAB_REFRESH_TOKEN ? 'SET' : 'MISSING',
    ACCOUNT_HASH: process.env.ACCOUNT_HASH ? 'SET' : 'MISSING'
  };
  
  res.json({
    message: 'Environment variables (safe)',
    environment: safeEnv,
    timestamp: new Date().toISOString()
  });
});

app.post('/api/v1/dev/test-order', requireDevMode, async (req, res) => {
  try {
    // Test order placement for development
    const testOrder = {
      orderId: `DEV_TEST_${Date.now()}`,
      symbol: 'TEST',
      status: 'TEST',
      createdAt: new Date().toISOString(),
      isDevOnly: true
    };
    
    persistence.trackOrder(testOrder, 'active');
    
    res.json({
      message: 'Test order created',
      order: testOrder,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to create test order',
      message: error.message
    });
  }
});

app.delete('/api/v1/dev/cleanup', requireDevMode, async (req, res) => {
  try {
    // Clean up test data
    const state = persistence.exportState();
    const parsedState = JSON.parse(state);
    
    // Remove test orders
    parsedState.orders.active = parsedState.orders.active.filter(order => 
      !order.orderId.startsWith('DEV_TEST_')
    );
    parsedState.orders.completed = parsedState.orders.completed.filter(order => 
      !order.orderId.startsWith('DEV_TEST_')
    );
    
    res.json({
      message: 'Development cleanup completed',
      removedTestOrders: true,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to cleanup',
      message: error.message
    });
  }
});

// Start server
async function startServer() {
  try {
    // Initialize persistence first
    await initializePersistence();
    
    app.listen(PORT, () => {
      console.log(`🚀 Schwab SDK Proxy Server running on http://localhost:${PORT}`);
      console.log(`📊 Health check: http://localhost:${PORT}/health`);
      console.log(`🗄️ State Management: http://localhost:${PORT}/api/v1/admin/state`);
      console.log(` Chains Cache: http://localhost:${PORT}/api/v1/admin/chains`);
      console.log(`📈 Market Data API: http://localhost:${PORT}/api/v1/marketdata/quotes?symbols=SPY`);
      console.log(`📅 Option Expirations: http://localhost:${PORT}/api/v1/marketdata/expirationchain?symbol=SPY`);
      console.log(`💼 Options Chain: http://localhost:${PORT}/api/v1/marketdata/chains?symbol=SPY&expirationDate=2024-01-19`);
      console.log(`🎯 Enhanced Chain: http://localhost:${PORT}/api/v1/marketdata/chains?symbol=SPY&expirationDate=2024-01-19&strike_count=10&contract_type=CALL`);
      console.log(`📍 Position Management: POST http://localhost:${PORT}/api/v1/positions`);
      console.log(`📍 View Positions: GET http://localhost:${PORT}/api/v1/positions/SPY/2024-01-19`);
      console.log(`📍 All Positions: GET http://localhost:${PORT}/api/v1/positions`);
      console.log(`📍 Offsetting Analysis: GET http://localhost:${PORT}/api/v1/positions/offsetting`);
      
      if (isDevMode) {
        console.log(``);
        console.log(`💰 Trading & Account API (Development Only):`);
        console.log(`📋 All Accounts: http://localhost:${PORT}/api/v1/trading/accounts`);
        console.log(`🔐 Account Numbers (Hash Values): http://localhost:${PORT}/api/v1/trading/accounts/accountNumbers`);
        console.log(`💳 Account Details: http://localhost:${PORT}/api/v1/trading/accounts/HASH`);
        console.log(`💰 Account Balances: http://localhost:${PORT}/api/v1/trading/accounts/HASH/balances`);
        console.log(`📊 Account Positions: http://localhost:${PORT}/api/v1/trading/accounts/HASH/positions`);
        console.log(`📋 Account Orders: http://localhost:${PORT}/api/v1/trading/accounts/HASH/orders`);
        console.log(`📈 All Orders: http://localhost:${PORT}/api/v1/trading/orders`);
        console.log(` Account Transactions (THIS DOESNT WORK YET BUT WE DONT CARE FOR NOW): http://localhost:${PORT}/api/v1/trading/accounts/HASH/transactions`);
        console.log(``);
        console.log(`🔧 Additional Development-Only Endpoints:`);
        console.log(`🐛 Debug Info: http://localhost:${PORT}/api/v1/dev/debug`);
        console.log(`🔍 Environment Variables: http://localhost:${PORT}/api/v1/dev/env`);
        console.log(`🧪 Test Order: POST http://localhost:${PORT}/api/v1/dev/test-order`);
        console.log(`🧹 Cleanup Test Data: DELETE http://localhost:${PORT}/api/v1/dev/cleanup`);
      } else {
        console.log(``);
        console.log(`🔒 Trading endpoints disabled in production mode`);
      }
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error.message);
    process.exit(1);
  }
}

// Start the server
startServer();

// Export functions for use by other modules
module.exports = {
  handleChainsRequest,
  handleQuotesRequest,
  handleExpirationChainRequest
};
