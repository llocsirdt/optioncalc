const express = require('express');
const cors = require('cors');
const { MarketApiClient, TradingApiClient } = require('schwab-client-js');
require('dotenv').config();

const app = express();
const PORT = 3001;

// Enable CORS for all routes
app.use(cors());
app.use(express.json());

// Initialize Schwab clients
const marketClient = new MarketApiClient('', '', process.env.SCHWAB_REFRESH_TOKEN);
const tradingClient = new TradingApiClient('', '', process.env.SCHWAB_REFRESH_TOKEN);

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
  console.log('=== MARKET DATA REQUEST ===');
  try {
    const path = req.path.replace('/api/v1/marketdata', '');
    const query = new URL(req.url, `http://localhost:${PORT}`).search;
    
    console.log(`Path: ${path}`);
    console.log(`Query: ${query}`);
    console.log(`Method: ${req.method}`);

    let result;

    // Route to appropriate SDK method
    if (path.startsWith('/quotes')) {
      const symbols = query.includes('symbols=') ? 
        query.split('symbols=')[1].split('&')[0].split(',') : ['SPY'];
      console.log(`Getting quotes for: ${symbols.join(', ')}`);
      result = await marketClient.quotes(symbols);
      
    } else if (path.startsWith('/expirationchain')) {
      const symbol = query.includes('symbol=') ? 
        query.split('symbol=')[1].split('&')[0] : 'SPY';
      console.log(`Getting expirations for: ${symbol}`);
      result = await marketClient.expirationChain(symbol);
      
    } else if (path.startsWith('/chains')) {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const symbol = url.searchParams.get('symbol') || 'SPY';
      const expirationDate = url.searchParams.get('expirationDate') || null;
      
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
        interval: parseInt(url.searchParams.get('interval')) || undefined
        // No fromDate/toDate - just pass expiration date
      };
      
      // Remove undefined parameters (but keep strikeCount)
      Object.keys(optionalParams).forEach(key => {
        if (optionalParams[key] === undefined && key !== 'strikeCount') {
          delete optionalParams[key];
        }
      });
      
      console.log(`Getting options chain for: ${symbol}, exp: ${expirationDate}`);
      console.log(`Optional params:`, optionalParams);
      
      // Build the chain options object for schwab-client-js SDK
      const chainOptions = {
        ...optionalParams
        // Don't include expirationDate - use fromDate/toDate instead
      };
      
      console.log(`Final chain options:`, chainOptions);
      
      // Pass expiration date separately like the original implementation
      result = await marketClient.chains(symbol, expirationDate, optionalParams);
      
    } else {
      throw new Error(`Unsupported market data endpoint: ${path}`);
    }

    console.log('✅ Market data request successful');
    res.json(result);

  } catch (error) {
    console.error('❌ Market data request failed:', error.message);
    
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
  console.log('=== TRADING REQUEST ===');
  try {
    const path = req.path.replace('/api/v1/trading', '');
    
    console.log(`Path: ${path}`);
    console.log(`Method: ${req.method}`);

    let result;

    // Route to appropriate SDK method
    if (path.startsWith('/accounts')) {
      console.log('Getting accounts');
      result = await tradingClient.accountsAll();
      
    } else if (path.startsWith('/orders')) {
      console.log('Getting orders');
      result = await tradingClient.orderAll();
      
    } else {
      throw new Error(`Unsupported trading endpoint: ${path}`);
    }

    console.log('✅ Trading request successful');
    res.json(result);

  } catch (error) {
    console.error('❌ Trading request failed:', error.message);
    res.status(500).json({
      error: 'Trading request failed',
      message: error.message,
      path: req.path
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
  console.log(`📊 Trading API: http://localhost:${PORT}/api/v1/trading/accounts`);
});
