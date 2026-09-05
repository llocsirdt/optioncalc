const express = require('express');
const cors = require('cors');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MarketApiClient, TradingApiClient } = require('schwab-client-js');
require('dotenv').config({ path: '../.env' });

// Import persistence manager
const PersistenceManager = require('./persistence/persistence');

// Import shared handlers and market client
const { handleChainsRequest } = require('./persistence/chains-handler');
const { handlePriceHistoryRequest } = require('./persistence/price-history-handler');
const { analyzeCandles, getRaw1m, streamingCandleSource } = require('./persistence/candle-analyzer');
const { getChartSeries } = require('./chart-series');
const { getBasis } = require('./nq-ndx-basis');
const candleSpread = require('./candle-spread');
const { marketClient } = require('./persistence/market-client');

const app = express();
const PORT = process.env.PORT || 3001;

// Keep this long-running server alive through transient failures in its background loops
// (position checks, streaming reconnects, candle-spread scheduler). In modern Node an unhandled
// promise rejection terminates the process by default — so a single Schwab call rejecting (e.g. on
// an expired token) would take the whole server down, which is the recurring "keeps going offline"
// symptom. Log loudly and stay up; the loops recover on their next tick.
process.on('unhandledRejection', (reason) => {
  console.error(`🛑 [${new Date().toISOString()}] unhandledRejection (kept process alive):`, (reason && reason.stack) || reason);
});
process.on('uncaughtException', (err) => {
  console.error(`🛑 [${new Date().toISOString()}] uncaughtException (kept process alive):`, (err && err.stack) || err);
});

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
    
    // Initialize streaming connection for real-time candle data
    console.log('🌊 Initializing streaming API connection...');
    const streamingInitialized = await streamingCandleSource.initialize();
    
    if (streamingInitialized) {
      // Wait a moment for authentication to complete, then subscribe
      setTimeout(() => {
        const symbols = ['NDX', 'SPX'];
        for (const symbol of symbols) {
          streamingCandleSource.subscribeSymbol(symbol);
        }
        console.log('✅ Streaming API symbols subscribed');
      }, 2000);
      console.log('✅ Streaming API ready');
    } else {
      console.warn('⚠️ Streaming API not available - will use REST API only');
    }
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

// Populated at deployment-package time (see scripts/create-deployment-package.sh)
// with the exact git commit that was zipped up — not present in local dev,
// since it's only written right before packaging, and gitignored so it never
// goes stale in the repo itself. Lets /health prove exactly what's actually
// running on a given environment instead of inferring it from behavior.
let buildInfo = { note: 'no build-info.json found — likely running from source, not a packaged deploy' };
try {
  buildInfo = require('../build-info.json');
} catch (err) {
  // Expected in local dev — build-info.json is only generated when packaging for deploy.
}

// Memory tracking so we can tell an OOM-causing leak from a steady-state footprint without
// digging through EB logs: /health reports current usage + the peak RSS since start, and a 60s
// sampler keeps a short rolling trend (GET /health?mem=full to dump the samples).
const memStartedAt = Date.now();
let peakRss = 0;
const MEM_SAMPLES = [];
const MEM_SAMPLE_CAP = 480;              // ~8h at 60s cadence
const MB = b => Math.round((b / 1048576) * 10) / 10;
function sampleMemory() {
  const rss = process.memoryUsage().rss;
  if (rss > peakRss) peakRss = rss;
  MEM_SAMPLES.push({ t: Date.now(), rss });
  if (MEM_SAMPLES.length > MEM_SAMPLE_CAP) MEM_SAMPLES.shift();
}
sampleMemory();
const memSampler = setInterval(sampleMemory, 60000);
if (memSampler.unref) memSampler.unref();

// Disk tracking so we can tell a /tmp-fill (the leading suspect for the 2026-08-28 deploy hang)
// from a memory problem without shell access. Filesystem free/used for / and /tmp, plus the size of
// the candle-spread run store (the most likely thing to grow over uptime). Cached ~30s so EB's
// frequent health pings don't re-stat the dir every time.
const CANDLE_RUNS_DIR = process.env.CANDLE_SPREAD_RUNS_DIR || '/tmp/candle-spread-runs';
let diskCache = null, diskCacheAt = 0;
function fsUsage(p) {
  try {
    if (typeof fs.statfsSync !== 'function') return null;   // Node < 18.15 — feature unavailable
    const s = fs.statfsSync(p);
    const total = s.blocks * s.bsize, avail = s.bavail * s.bsize;
    return { totalMB: MB(total), freeMB: MB(avail), usedPct: total ? Math.round((1 - avail / total) * 100) : null };
  } catch (e) { return null; }
}
function dirStats(dir) {
  // Always report the PATH (so /health confirms whether the run store is on the root disk vs /tmp
  // — i.e. that the relocation took effect); files/sizeMB are null until the dir exists. `newest` = the
  // most-recent file mtime, so we can tell a populated store from an empty/just-reset one at a glance.
  try {
    const files = fs.readdirSync(dir);
    let bytes = 0, count = 0, newest = 0;
    for (const f of files) {
      try { const st = fs.statSync(dir + '/' + f); if (st.isFile()) { bytes += st.size; count++; if (st.mtimeMs > newest) newest = st.mtimeMs; } } catch (e) { /* skip */ }
    }
    return { path: dir, files: count, sizeMB: MB(bytes), newest: newest ? new Date(newest).toISOString() : null };
  } catch (e) { return { path: dir, files: null, sizeMB: null, newest: null }; }   // dir not created yet
}
// Every location the candle-spread run store could plausibly live, across the code's history: the ACTIVE
// dir, the durable root-disk dir, the old /tmp (tmpfs) dir, and the in-app fallback (wiped on deploy). If
// a restart/deploy/instance-swap ever loses runs again, /health shows exactly which dir has them (if any)
// — turning a forensic guess into a direct read. See TODO in candle-spread/store.js re: durable backing.
const RUN_DIR_CANDIDATES = [...new Set([
  CANDLE_RUNS_DIR,
  '/var/optioncalc-data/candle-spread-runs',
  '/tmp/candle-spread-runs',
  path.join(__dirname, 'persistence', 'candle-spread-runs')
])];
function diskUsage() {
  const now = Date.now();
  if (diskCache && now - diskCacheAt < 30000) return diskCache;
  diskCache = {
    host: os.hostname(),                          // changes on instance replacement — spot a disk-reset swap
    bootedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    root: fsUsage('/'), tmp: fsUsage('/tmp'),
    candleRuns: dirStats(CANDLE_RUNS_DIR),         // the ACTIVE store dir (what the server reads/writes)
    candleRunsProbe: RUN_DIR_CANDIDATES.map(dirStats)   // all candidate locations — catch a location mismatch
  };
  diskCacheAt = now;
  return diskCache;
}

// Health check endpoint
app.get('/health', (req, res) => {
  const m = process.memoryUsage();
  const memory = {
    rssMB: MB(m.rss),
    heapUsedMB: MB(m.heapUsed),
    heapTotalMB: MB(m.heapTotal),
    externalMB: MB(m.external),
    arrayBuffersMB: MB(m.arrayBuffers || 0),
    peakRssMB: MB(peakRss),
    uptimeMin: Math.round(process.uptime() / 60)
  };
  if (req.query.mem === 'full') {
    memory.samples = MEM_SAMPLES.map(s => ({ min: Math.round((s.t - memStartedAt) / 60000), rssMB: MB(s.rss) }));
  }
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    sdk: 'schwab-client-js',
    build: buildInfo,
    memory,
    disk: diskUsage(),
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

    } else if (path.startsWith('/chartseries')) {
      // Deep, chart-ready OHLC + Bollinger(20,2) + 9EMA per timeframe, independent of the
      // engine's candle-analyzer base cache (see chart-series.js). Used by the custom NQ chart.
      const url = new URL(`http://localhost${query}`);
      const symbol = url.searchParams.get('symbol');
      const timeframe = url.searchParams.get('timeframe') || '15m';
      const fresh = ['1', 'true'].includes(url.searchParams.get('fresh'));  // bypass the short TTL cache
      // Optional historical window (ms epoch): fetch a deep range around a past date instead of the
      // default recent window — the on-demand deep fetch the chart's date-jump uses. Ignored unless both parse.
      const fromMs = Number(url.searchParams.get('from')), toMs = Number(url.searchParams.get('to'));
      const range = (isFinite(fromMs) && isFinite(toMs) && toMs > fromMs) ? { startDate: fromMs, endDate: toMs } : null;
      if (!symbol) throw new Error('symbol parameter is required (e.g., ?symbol=/NQ)');
      console.log(`[${timestamp}] Chart series for: ${symbol} (${timeframe})${fresh ? ' [fresh]' : ''}${range ? ` [range ${new Date(fromMs).toISOString().slice(0, 10)}..${new Date(toMs).toISOString().slice(0, 10)}]` : ''}`);
      const candles = await getChartSeries(symbol, timeframe, { fresh, range });
      // For NQ, include the held NQ↔NDX basis so the client can optionally re-label to NDX terms.
      const basis = /nq/i.test(symbol) ? await getBasis() : null;
      result = { symbol, timeframe, candles, basis };

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
    console.log(`🔍 Offsetting request for symbol=${symbol}, expiration=${expiration}`);
    let offsettingAnalysis = await persistence.findOffsettingPositions();
    console.log(`📊 findOffsettingPositions returned:`, Object.keys(offsettingAnalysis));
    console.log(`📊 Full offsettingAnalysis:`, JSON.stringify(offsettingAnalysis, null, 2));
    
    // Filter by symbol and/or expiration if provided
    if (symbol || expiration) {
      const filtered = {};
      const filterKey = symbol && expiration ? `${symbol}_${expiration}` : null;
      console.log(`🔍 Filtering with key: ${filterKey}`);
      
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

// Candle-spread trader — read-only status/log endpoints (NOT dev-gated, so the
// production UI can poll them). The engine itself runs internally; these only read.
app.get('/api/v1/candle-spread/runs', (req, res) => {
  try {
    // `variants` = the canonical roster the server is configured to trade (with which one is armed for
    // the live pipe). The runs store also holds records for RETIRED variants, so the UI filters against
    // this rather than against the run files, and takes its ordering + default selection from it.
    res.json({ runs: candleSpread.listRuns(), variants: candleSpread.listVariants(), timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ error: 'Failed to list candle-spread runs', message: error.message });
  }
});

// Compact live status for the UI to poll (mode/gates + per-strategy activity today) — lets you
// validate at a glance that the server is doing what's expected (esp. the prod test-mode session).
app.get('/api/v1/candle-spread/status', (req, res) => {
  try {
    res.json(candleSpread.status());
  } catch (error) {
    res.status(500).json({ error: 'Failed to read candle-spread status', message: error.message });
  }
});

// ?date= defaults to the expiration (0DTE). ?variant=v0|v1|v2 selects a shadow strategy;
// omit it to read a pre-variant (single-strategy) run.
app.get('/api/v1/candle-spread/runs/:symbol/:expiration', (req, res) => {
  try {
    const { symbol, expiration } = req.params;
    const date = req.query.date || expiration;
    const record = candleSpread.getRun(symbol, expiration, date, req.query.variant);
    if (!record) {
      return res.status(404).json({ error: 'Run not found', symbol, expiration, date, variant: req.query.variant || null });
    }
    res.json(record);
  } catch (error) {
    res.status(500).json({ error: 'Failed to read candle-spread run', message: error.message });
  }
});

// Per-variant backtest BASELINES (avg daily P&L + the risk-potential metrics) for the comparison page's
// backtest overlay. Reads the JSON fresh each request (it's regenerated out-of-band by the backtest script).
app.get('/api/v1/candle-spread/baselines', (req, res) => {
  try {
    const p = require('path').join(__dirname, 'candle-spread', 'backtest-baselines.json');
    res.type('application/json').send(require('fs').readFileSync(p, 'utf8'));
  } catch (error) {
    res.status(error.code === 'ENOENT' ? 404 : 500).json({ error: 'Failed to read baselines', message: error.message });
  }
});

// BACKTEST REPLAYS — one historical day rendered as run records in the LIVE record shape, so the
// compare-strategies page can drive its time-of-day slider over a backtest day exactly as it does over
// today's shadow runs. Generated out-of-band by scripts/candle-spread/backtest-replay.js into
// data/backtest-replays/<date>.json (the 5m dataset those are built from is local-only and gitignored,
// so in practice this serves from a dev machine, not the deployed instance).
//   GET /api/v1/candle-spread/replays          -> { dates: [...] }
//   GET /api/v1/candle-spread/replay?date=...  -> the day's bundle
const REPLAY_DIR = require('path').join(__dirname, '..', '..', 'data', 'backtest-replays');
app.get('/api/v1/candle-spread/replays', (req, res) => {
  try {
    const fs = require('fs');
    if (!fs.existsSync(REPLAY_DIR)) return res.json({ dates: [] });
    const dates = fs.readdirSync(REPLAY_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f => f.slice(0, 10)).sort();
    res.json({ dates });
  } catch (error) {
    res.status(500).json({ error: 'Failed to list backtest replays', message: error.message });
  }
});
app.get('/api/v1/candle-spread/replay', (req, res) => {
  const date = String(req.query.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date=YYYY-MM-DD required' });
  try {
    const p = require('path').join(REPLAY_DIR, `${date}.json`);
    res.type('application/json').send(require('fs').readFileSync(p, 'utf8'));
  } catch (error) {
    res.status(error.code === 'ENOENT' ? 404 : 500).json({ error: 'Replay not generated for that date', date, message: error.message });
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

    // Start the candle-spread trader (dry-run) — internal engine, separate from the
    // paper-sim position-manager. Orders are built + logged but NOT sent while dryRun.
    candleSpread.start({
      analyzeCandles,
      getRaw1m,   // deep raw 1m for the v4-v9 live analysis-builder (5m cadence)
      getOrFetchChainData: (symbol, expiration) => persistence.getOrFetchChainData(symbol, expiration),
      // Official index CLOSE for EOD 0DTE settlement — the $NDX quote's lastPrice (the 4:00 close, the
      // actual settlement value), NOT the last 5m candle mark and NOT `closePrice` (Schwab's PRIOR close).
      getSettlementPrice: async (symbol) => {
        try {
          const IDX = ['NDX', 'SPX', 'RUT', 'DJX', 'OEX', 'VIX'];
          const q = symbol.startsWith('$') ? symbol : (IDX.includes(symbol) ? '$' + symbol : symbol);
          const res = await marketClient.quotes([q]);
          const quote = res && (res[q] || res[symbol]) && (res[q] || res[symbol]).quote;
          const v = quote && quote.lastPrice;
          return (typeof v === 'number' && v > 0) ? v : null;
        } catch (e) { return null; }
      },
      tradingClient,
      accountHash: process.env.ACCOUNT_HASH,
      // Real order sending is prod-only; dev mode never sends (avoids duplicate orders
      // when a local dev server runs alongside prod).
      isProd: !isDevMode
    });

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
      
      // Load existing analysis data for today to preserve data across server restarts
      console.log(``);
      console.log(`📊 Loading existing analysis data for today...`);
      (async () => {
        try {
          const analysisLogger = require('./persistence/analysis-logger');
          const today = new Date().toISOString().split('T')[0];
          
          // Load analysis data for tracked symbols (NDX, SPX)
          const symbols = ['NDX', 'SPX'];
          for (const symbol of symbols) {
            await analysisLogger.loadAnalysisData(symbol, today);
          }
        } catch (error) {
          console.error('⚠️ Failed to load existing analysis data:', error.message);
        }
      })();
      
      // Start position check loop at :30 seconds each minute
      console.log(``);
      console.log(`🔄 Starting position check loop (runs at :30 seconds each minute)...`);
      let positionCheckInterval = null;
      
      // Helper to get ET market time info
      const getETTimeInfo = () => {
        const etDate = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
        const day = etDate.getDay();
        const totalMinutes = etDate.getHours() * 60 + etDate.getMinutes();
        return {
          isWeekday: day >= 1 && day <= 5,
          totalMinutes,
          isPreMarket: day >= 1 && day <= 5 && totalMinutes >= 555 && totalMinutes < 570,  // 9:15-9:30 AM
          isMarketHours: day >= 1 && day <= 5 && totalMinutes >= 570 && totalMinutes < 960, // 9:30 AM-3:59 PM
          isAfterClose: day >= 1 && day <= 5 && totalMinutes >= 965,                        // After 4:05 PM
          // Active window we run checkPositions in: pre-market 9:15 through ~4:05 PM ET,
          // weekdays. Off-hours we skip the (candle-based) position check entirely — there
          // are no new candles, so it only wastes compute + Schwab priceHistory calls.
          isActiveWindow: day >= 1 && day <= 5 && totalMinutes >= 555 && totalMinutes < 965,
        };
      };

      // Manage stream connection based on time of day
      const manageStreamConnection = async () => {
        try {
          const { isPreMarket, isAfterClose } = getETTimeInfo();
          if (isPreMarket && !streamingCandleSource.isConnected) {
            console.log('🌊 Pre-market: stream not connected, attempting to connect...');
            try {
              const initialized = await streamingCandleSource.initialize();
              if (initialized) {
                setTimeout(() => {
                  ['NDX', 'SPX'].forEach(sym => streamingCandleSource.subscribeSymbol(sym));
                  console.log('🌊 Pre-market: stream connected and symbols subscribed');
                }, 2000);
              }
            } catch (err) {
              console.warn('🌊 Pre-market connect failed:', err.message);
            }
          } else if (isAfterClose && streamingCandleSource.isConnected) {
            console.log('🌊 Market closed: disconnecting stream...');
            await streamingCandleSource.disconnect();
          }
        } catch (err) {
          // Never let stream management reject into the caller's un-try/catch'd await (would crash).
          console.warn('🌊 manageStreamConnection error (ignored):', err && err.message);
        }
      };

      // Execution state tracking for diagnostics
      let isCheckingPositions = false;
      let lastCheckStartTime = null;
      let lastCheckEndTime = null;
      let checkCount = 0;
      let overlapCount = 0;
      
      // Calculate delay to next :30 second mark
      const now = new Date();
      const currentSeconds = now.getSeconds();
      let msToNext30Seconds;
      
      if (currentSeconds < 30) {
        // Wait until :30 of current minute
        msToNext30Seconds = (30 - currentSeconds) * 1000 - now.getMilliseconds();
      } else {
        // Wait until :30 of next minute
        msToNext30Seconds = (90 - currentSeconds) * 1000 - now.getMilliseconds();
      }
      
      // Wait until :30 seconds, then start interval
      // Running at :30 ensures the previous minute's candle is always available from the API
      setTimeout(() => {
        // Run immediately at :30 seconds
        (async () => {
          await manageStreamConnection();

          const now = new Date();
          const timeStr = now.toLocaleTimeString('en-US', { 
            timeZone: 'America/New_York', 
            hour12: false, 
            hour: '2-digit', 
            minute: '2-digit',
            second: '2-digit'
          });
          
          checkCount++;
          
          if (isCheckingPositions) {
            overlapCount++;
            const elapsedSinceStart = lastCheckStartTime ? Date.now() - lastCheckStartTime : 0;
            console.warn(`⚠️ [OVERLAP #${overlapCount}] checkPositions already running at ${timeStr} (started ${(elapsedSinceStart/1000).toFixed(1)}s ago, check #${checkCount})`);
            return; // Don't start another execution
          }
          
          // Off-hours: skip the (candle-based) position check entirely — stream
          // management above already ran. Cuts overnight/weekend compute + Schwab calls.
          if (!getETTimeInfo().isActiveWindow) return;

          isCheckingPositions = true;
          lastCheckStartTime = Date.now();
          console.log(`🔄 [CHECK #${checkCount}] Starting checkPositions at ${timeStr}`);
          
          try {
            await persistence.positionManager.checkPositions(persistence);
            
            const elapsed = Date.now() - lastCheckStartTime;
            lastCheckEndTime = Date.now();
            const endTimeStr = new Date().toLocaleTimeString('en-US', { 
              timeZone: 'America/New_York', 
              hour12: false, 
              hour: '2-digit', 
              minute: '2-digit',
              second: '2-digit'
            });
            console.log(`✅ [CHECK #${checkCount}] Completed checkPositions at ${endTimeStr} (took ${(elapsed/1000).toFixed(2)}s)`);
            
            if (elapsed > 60000) {
              console.warn(`⚠️ [SLOW EXECUTION] checkPositions took ${(elapsed/1000).toFixed(2)}s (>60s threshold)`);
            }
          } catch (error) {
            console.error(`❌ [CHECK #${checkCount}] Error in position check loop:`, error.message);
          } finally {
            isCheckingPositions = false;
          }
        })();
        
        // Then run every minute at :30 seconds
        if (!positionCheckInterval) {
          positionCheckInterval = setInterval(async () => {
            await manageStreamConnection();

            const now = new Date();
            const timeStr = now.toLocaleTimeString('en-US', { 
              timeZone: 'America/New_York', 
              hour12: false, 
              hour: '2-digit', 
              minute: '2-digit',
              second: '2-digit'
            });
            
            checkCount++;
            
            if (isCheckingPositions) {
              overlapCount++;
              const elapsedSinceStart = lastCheckStartTime ? Date.now() - lastCheckStartTime : 0;
              console.warn(`⚠️ [OVERLAP #${overlapCount}] checkPositions already running at ${timeStr} (started ${(elapsedSinceStart/1000).toFixed(1)}s ago, check #${checkCount})`);
              return; // Don't start another execution
            }
            
            // Off-hours: skip the (candle-based) position check entirely — stream
            // management above already ran. Cuts overnight/weekend compute + Schwab calls.
            if (!getETTimeInfo().isActiveWindow) return;

            isCheckingPositions = true;
            lastCheckStartTime = Date.now();
            console.log(`🔄 [CHECK #${checkCount}] Starting checkPositions at ${timeStr}`);
            
            try {
              await persistence.positionManager.checkPositions(persistence);
              
              const elapsed = Date.now() - lastCheckStartTime;
              lastCheckEndTime = Date.now();
              const endTimeStr = new Date().toLocaleTimeString('en-US', { 
                timeZone: 'America/New_York', 
                hour12: false, 
                hour: '2-digit', 
                minute: '2-digit',
                second: '2-digit'
              });
              console.log(`✅ [CHECK #${checkCount}] Completed checkPositions at ${endTimeStr} (took ${(elapsed/1000).toFixed(2)}s)`);
              
              if (elapsed > 60000) {
                console.warn(`⚠️ [SLOW EXECUTION] checkPositions took ${(elapsed/1000).toFixed(2)}s (>60s threshold)`);
              }
            } catch (error) {
              console.error(`❌ [CHECK #${checkCount}] Error in position check loop:`, error.message);
            } finally {
              isCheckingPositions = false;
            }
          }, 60000);
          
          console.log(`✅ Position check loop started (runs at :30 seconds each minute for reliable candle data)`);
        }
      }, msToNext30Seconds);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error.message);
    process.exit(1);
  }
}

// Graceful shutdown handler
const gracefulShutdown = async (signal) => {
  console.log(`\n🛑 Received ${signal}, shutting down server...`);
  
  // Disconnect streaming
  if (streamingCandleSource.isConnected) {
    console.log('🌊 Disconnecting streaming API...');
    await streamingCandleSource.disconnect();
  }
  
  // Save persistence state
  console.log('💾 Saving persistence state...');
  await persistence.saveState();
  
  console.log('✅ Shutdown complete');
  process.exit(0);
};

// Handle both SIGINT (Ctrl+C) and SIGTERM (AWS EB, Docker, etc.)
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Start the server
startServer();

// Export functions for use by other modules
module.exports = {
  handleChainsRequest,
  handleQuotesRequest,
  handleExpirationChainRequest
};
