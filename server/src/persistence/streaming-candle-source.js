/**
 * Schwab Streaming API integration for real-time 1m candle data
 * Uses custom WebSocket client with direct API credential fetching
 */

const { SchwabStreamingClient } = require('./schwab-streaming-client');
const { getUserPreference, getAccessToken } = require('./market-client');

class StreamingCandleSource {
  constructor() {
    this.streamer = null;
    this.isConnected = false;
  }

  async initialize() {
    try {
      console.log('🌊 Initializing Schwab streaming connection...');
      
      // Get streaming credentials directly from Schwab API
      console.log('🌊 Fetching user preferences for streaming credentials...');
      const userPrefs = await getUserPreference();
      
      if (!userPrefs || !userPrefs.streamerInfo || !Array.isArray(userPrefs.streamerInfo)) {
        console.error('🌊 ❌ Invalid user preferences - missing streamerInfo');
        return false;
      }

      const streamerInfo = userPrefs.streamerInfo[0];
      
      // Get the current live OAuth access token from the trading client
      // This ensures we have a fresh token that hasn't expired
      console.log('🌊 Extracting live OAuth access token...');
      const accessToken = await getAccessToken();
      
      if (!accessToken) {
        console.error('🌊 ❌ Failed to get live access token');
        return false;
      }
      
      console.log('🌊 ✅ Live access token retrieved');
      
      // Extract streaming configuration
      const streamingConfig = {
        streamerSocketUrl: streamerInfo.streamerSocketUrl,
        customerId: streamerInfo.schwabClientCustomerId,
        correlId: streamerInfo.schwabClientCorrelId,
        channel: streamerInfo.schwabClientChannel,
        functionId: streamerInfo.schwabClientFunctionId,
        accessToken: accessToken
      };
      
      console.log('🌊 ✅ Streaming credentials configured');

      // Create custom streaming client
      this.streamer = new SchwabStreamingClient();
      
      // Set up event handlers
      this.streamer.on('authenticated', () => {
        console.log('🌊 ✅ Streaming authenticated');
        this.isConnected = true;
      });

      this.streamer.on('disconnected', () => {
        console.log('🌊 ⚠️ Streaming connection lost');
        this.isConnected = false;
      });

      this.streamer.on('error', (error) => {
        console.error('🌊 ❌ Streaming error:', error.message);
      });

      this.streamer.on('candle', ({ symbol, candle }) => {
        // Candle data is already stored in the client
      });

      // Connect to streaming service
      await this.streamer.connect(streamingConfig);
      
      console.log('🌊 ✅ Streaming candle source initialized');
      return true;
    } catch (error) {
      console.error('🌊 ❌ Failed to initialize streaming:', error.message);
      console.error('🌊 Error stack:', error.stack);
      return false;
    }
  }

  subscribeSymbol(symbol) {
    if (!this.isConnected || !this.streamer) {
      console.warn(`🌊 ⚠️ Cannot subscribe to ${symbol} - not connected`);
      return false;
    }

    try {
      const indexSymbols = ['NDX', 'SPX', 'RUT', 'DJX', 'OEX', 'VIX'];
      const streamSymbol = symbol.startsWith('$') ? symbol : (indexSymbols.includes(symbol) ? `$${symbol}` : symbol);
      
      this.streamer.subscribeCharts(streamSymbol);
      return true;
    } catch (error) {
      console.error(`🌊 ❌ Failed to subscribe to ${symbol}:`, error.message);
      return false;
    }
  }

  unsubscribeSymbol(symbol) {
    if (!this.isConnected || !this.streamer) {
      return false;
    }

    try {
      const indexSymbols = ['NDX', 'SPX', 'RUT', 'DJX', 'OEX', 'VIX'];
      const streamSymbol = symbol.startsWith('$') ? symbol : (indexSymbols.includes(symbol) ? `$${symbol}` : symbol);
      
      this.streamer.unsubscribeCharts(streamSymbol);
      return true;
    } catch (error) {
      console.error(`🌊 ❌ Failed to unsubscribe from ${symbol}:`, error.message);
      return false;
    }
  }

  getLatestCandle(symbol) {
    if (!this.streamer) return null;
    return this.streamer.getLatestCandle(symbol);
  }

  hasLatestCandle(symbol) {
    if (!this.streamer) return false;
    return this.streamer.hasLatestCandle(symbol);
  }

  async disconnect() {
    if (this.streamer && this.isConnected) {
      try {
        this.streamer.disconnect();
        console.log('🌊 ✅ Streaming connection closed');
      } catch (error) {
        console.error('🌊 ❌ Error disconnecting:', error.message);
      }
    }
    this.isConnected = false;
  }
}

const streamingCandleSource = new StreamingCandleSource();

module.exports = {
  streamingCandleSource
};
