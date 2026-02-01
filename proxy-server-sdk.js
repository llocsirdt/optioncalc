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
      const symbol = query.includes('symbol=') ? 
        query.split('symbol=')[1].split('&')[0] : 'SPY';
      const expirationDate = query.includes('expirationDate=') ? 
        query.split('expirationDate=')[1].split('&')[0] : null;
      console.log(`Getting options chain for: ${symbol}, exp: ${expirationDate}`);
      
      if (expirationDate) {
        result = await marketClient.chains(symbol, expirationDate);
      } else {
        // Get nearest expiration if none specified
        console.log('No expiration date provided, getting nearest...');
        const expirations = await marketClient.expirationChain(symbol);
        const nearestExp = expirations.expirationList[0]?.expirationDate;
        console.log(`Nearest expiration found: ${nearestExp}`);
        if (nearestExp) {
          result = await marketClient.chains(symbol, nearestExp);
        } else {
          throw new Error('No expirations available');
        }
      }
      
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
  console.log(`💼 Trading API: http://localhost:${PORT}/api/v1/trading/accounts`);
});
