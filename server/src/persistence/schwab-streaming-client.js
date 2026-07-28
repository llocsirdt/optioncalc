/**
 * Custom Schwab Streaming WebSocket Client
 * Built from scratch using only vetted, safe dependencies
 * Based on Schwab/TD Ameritrade streaming protocol
 */

const WebSocket = require('ws');
const EventEmitter = require('events');

// Streaming protocol constants
const SERVICES = {
  ADMIN: 'ADMIN',
  CHART_EQUITY: 'CHART_EQUITY',
  QUOTE: 'QUOTE'
};

const COMMANDS = {
  LOGIN: 'LOGIN',
  LOGOUT: 'LOGOUT',
  SUBS: 'SUBS',
  UNSUBS: 'UNSUBS',
  QOS: 'QOS'
};

const STATES = {
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  AUTHENTICATED: 'authenticated',
  DISCONNECTING: 'disconnecting',
  DISCONNECTED: 'disconnected'
};

class SchwabStreamingClient extends EventEmitter {
  constructor() {
    super();
    this.socket = null;
    this.state = STATES.DISCONNECTED;
    this.config = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = Infinity; // Unlimited reconnect attempts
    this.requestId = 0;
    this.subscriptions = new Map();
    this.latestCandles = new Map();
    this.heartbeatTimer = null;
    this.lastHeartbeat = null;
    this.heartbeatTimeout = 60000; // 60 seconds
  }

  /**
   * Initialize streaming connection with Schwab streaming data
   */
  async connect(streamingData) {
    if (!streamingData) {
      throw new Error('Invalid streaming data');
    }

    this.config = streamingData;

    return new Promise((resolve, reject) => {
      try {
        let wsUrl = this.config.streamerSocketUrl;
        if (!/^wss?:\/\//.test(wsUrl)) {
          wsUrl = `wss://${wsUrl}/ws`;
        }

        console.log(`🌊 Connecting to Schwab streaming: ${wsUrl}`);
        this.state = STATES.CONNECTING;
        this.socket = new WebSocket(wsUrl);

        this.socket.on('open', () => {
          console.log('🌊 ✅ WebSocket connected');
          this.state = STATES.CONNECTED;
          this.login();
          resolve(true);
        });

        this.socket.on('message', (data) => {
          this.handleMessage(data);
        });

        this.socket.on('close', (code, reason) => {
          console.log(`🌊 ⚠️ WebSocket disconnected (code: ${code}, reason: ${reason || 'none'})`);
          this.state = STATES.DISCONNECTED;
          this.clearHeartbeatTimer();
          this.emit('disconnected');
          this.handleReconnect();
        });

        this.socket.on('error', (error) => {
          console.error('🌊 ❌ WebSocket error:', error.message);
          this.emit('error', error);
          reject(error);
        });

      } catch (error) {
        console.error('🌊 ❌ Failed to connect:', error);
        reject(error);
      }
    });
  }

  /**
   * Login to streaming service using Schwab format
   */
  login() {
    this.sendRequest([
      {
        service: SERVICES.ADMIN,
        command: COMMANDS.LOGIN,
        parameters: {
          Authorization: this.config.accessToken,
          SchwabClientChannel: this.config.channel,
          SchwabClientFunctionId: this.config.functionId
        }
      }
    ]);

    console.log('🌊 Login request sent');
  }

  /**
   * Logout from streaming service
   */
  logout() {
    if (this.state === STATES.AUTHENTICATED || this.state === STATES.CONNECTED) {
      this.sendRequest([
        {
          service: SERVICES.ADMIN,
          command: COMMANDS.LOGOUT,
          parameters: {}
        }
      ]);
    }
  }

  /**
   * Subscribe to 1-minute chart data for symbols
   */
  subscribeCharts(symbols) {
    const symbolArray = Array.isArray(symbols) ? symbols : [symbols];
    const keys = symbolArray.join(',');
    
    // Chart equity fields: 0=symbol, 1=open, 2=high, 3=low, 4=close, 5=volume, 6=sequence, 7=chartTime, 8=chartDay
    const fields = '0,1,2,3,4,5,6,7,8';

    this.sendRequest([
      {
        service: SERVICES.CHART_EQUITY,
        command: COMMANDS.SUBS,
        parameters: { keys, fields }
      }
    ]);

    symbolArray.forEach(symbol => {
      this.subscriptions.set(symbol, 'CHART_EQUITY');
    });

    console.log(`🌊 ✅ Subscribed to charts for: ${keys}`);
  }

  /**
   * Unsubscribe from chart data
   */
  unsubscribeCharts(symbols) {
    const symbolArray = Array.isArray(symbols) ? symbols : [symbols];
    const keys = symbolArray.join(',');

    this.sendRequest([
      {
        service: SERVICES.CHART_EQUITY,
        command: COMMANDS.UNSUBS,
        parameters: { keys }
      }
    ]);

    symbolArray.forEach(symbol => {
      this.subscriptions.delete(symbol);
      this.latestCandles.delete(symbol);
    });

    console.log(`🌊 ✅ Unsubscribed from charts for: ${keys}`);
  }

  /**
   * Send request to streaming server using Schwab format
   */
  sendRequest(commands) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      console.warn('🌊 ⚠️ Cannot send request - socket not open');
      return;
    }

    const requests = commands.map(cmd => ({
      ...cmd,
      requestid: this.getRequestId().toString(),
      SchwabClientCustomerId: this.config.customerId,
      SchwabClientCorrelId: this.config.correlId
    }));

    const message = JSON.stringify({ requests });
    this.socket.send(message);
  }

  /**
   * Handle incoming messages from streaming server
   */
  handleMessage(data) {
    try {
      const message = JSON.parse(data.toString());
      
      // Debug: Log all non-heartbeat messages to see what we're receiving
      if (!message.notify || !message.notify.some(n => n.heartbeat)) {
        console.log('🌊 [DEBUG] Received message:', JSON.stringify(message).substring(0, 500));
      }

      // Handle response messages
      if (message.response) {
        message.response.forEach(resp => {
          if (resp.command === 'LOGIN') {
            if (resp.content && resp.content.code === 0) {
              console.log('🌊 ✅ Login successful');
              this.state = STATES.AUTHENTICATED;
              this.emit('authenticated');
              this.reconnectAttempts = 0;
            } else {
              console.error('🌊 ❌ Login failed:', resp.content);
            }
          } else {
            console.log('🌊 [DEBUG] Response:', JSON.stringify(resp));
          }
        });
      }

      // Handle data messages
      if (message.data) {
        console.log('🌊 [DEBUG] Data message received:', JSON.stringify(message.data).substring(0, 500));
        message.data.forEach(dataItem => {
          if (dataItem.service === 'CHART_EQUITY') {
            this.handleChartData(dataItem);
          }
        });
      }

      // Handle notify messages
      if (message.notify) {
        message.notify.forEach(notification => {
          if (notification.heartbeat) {
            this.lastHeartbeat = Date.now();
            this.resetHeartbeatTimer();
          } else {
            console.log('🌊 Notification:', notification);
          }
        });
      }

    } catch (error) {
      console.error('🌊 ❌ Error parsing message:', error);
    }
  }

  /**
   * Handle chart equity data
   */
  handleChartData(dataItem) {
    if (!dataItem.content || !Array.isArray(dataItem.content)) {
      return;
    }

    dataItem.content.forEach(item => {
      // Actual Schwab field mapping based on received data:
      // key=symbol, 1=sequence?, 2=open, 3=high, 4=low, 5=close, 6=volume, 7=chartTime, 8=chartDay
      
      const symbol = item.key || item['0'];
      const open = item['2'];
      const high = item['3'];
      const low = item['4'];
      const close = item['5'];
      const volume = item['6'] || 0;
      const chartTime = item['7'];

      if (!symbol || !chartTime) {
        console.log('🌊 [DEBUG] Skipping item - missing symbol or time:', item);
        return;
      }

      const candle = {
        datetime: chartTime,
        open: parseFloat(open),
        high: parseFloat(high),
        low: parseFloat(low),
        close: parseFloat(close),
        volume: parseInt(volume, 10)
      };

      // Store latest candle
      this.latestCandles.set(symbol, candle);

      // Emit event
      this.emit('candle', { symbol, candle });

      const timeStr = new Date(candle.datetime).toLocaleTimeString('en-US', {
        timeZone: 'America/New_York',
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });

      console.log(`🌊 [STREAM] ${symbol} candle at ${timeStr}: O=${candle.open} H=${candle.high} L=${candle.low} C=${candle.close} V=${candle.volume}`);
    });
  }

  /**
   * Get latest candle for a symbol
   */
  getLatestCandle(symbol) {
    return this.latestCandles.get(symbol) || null;
  }

  /**
   * Check if we have a candle for symbol
   */
  hasLatestCandle(symbol) {
    return this.latestCandles.has(symbol);
  }

  /**
   * Disconnect from streaming service
   */
  disconnect() {
    if (this.socket) {
      this.logout();
      this.state = STATES.DISCONNECTING;
      this.socket.close();
      this.socket = null;
    }
    this.subscriptions.clear();
    this.latestCandles.clear();
  }

  /**
   * Returns true if current wall-clock time is within streaming hours (Mon-Fri 9:10 AM - 4:10 PM ET)
   */
  _isWithinStreamingHours() {
    const now = new Date();
    const estDate = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const day = estDate.getDay();
    if (day < 1 || day > 5) return false;
    const totalMinutes = estDate.getHours() * 60 + estDate.getMinutes();
    return totalMinutes >= 550 && totalMinutes <= 970; // 9:10 AM - 4:10 PM ET
  }

  /**
   * Handle reconnection logic
   */
  handleReconnect() {
    if (!this._isWithinStreamingHours()) {
      console.log('🌊 Outside streaming hours - skipping reconnect until market opens');
      return;
    }

    this.reconnectAttempts++;
    // Exponential backoff: 2s, 4s, 8s, 16s, 32s, then 60s max
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 60000);

    console.log(`🌊 🔄 Reconnecting in ${delay/1000}s (attempt ${this.reconnectAttempts})`);

    setTimeout(async () => {
      if (this.config) {
        try {
          // Refresh streaming credentials before reconnecting
          console.log('🌊 🔄 Refreshing streaming credentials...');
          const { getUserPreference, getAccessToken } = require('./market-client');
          const accessToken = await getAccessToken();
          const userPrefs = await getUserPreference();
          
          if (userPrefs && userPrefs.streamerInfo && userPrefs.streamerInfo[0]) {
            const streamerInfo = userPrefs.streamerInfo[0];
            this.config = {
              streamerSocketUrl: streamerInfo.streamerSocketUrl,
              accessToken: accessToken,
              customerId: streamerInfo.schwabClientCustomerId,
              correlId: streamerInfo.schwabClientCorrelId,
              channel: streamerInfo.schwabClientChannel,
              functionId: streamerInfo.schwabClientFunctionId
            };
            console.log('🌊 ✅ Streaming credentials refreshed');
          }
          
          // Capture symbols before connecting (subscriptions map may be modified during connect)
          const symbolsToResubscribe = Array.from(this.subscriptions.keys());

          await this.connect(this.config);
          
          // Wait for server-side login ACK before sending SUBS — otherwise the server
          // rejects the subscription with "STREAM CONNECTION NOT FOUND"
          if (symbolsToResubscribe.length > 0) {
            await new Promise((resolve) => {
              const timeout = setTimeout(() => {
                console.warn('🌊 ⚠️ Timed out waiting for login ACK before re-subscribing');
                resolve();
              }, 10000);

              this.once('authenticated', () => {
                clearTimeout(timeout);
                console.log(`🌊 🔄 Re-subscribing to ${symbolsToResubscribe.length} symbols...`);
                this.subscribeCharts(symbolsToResubscribe);
                resolve();
              });
            });
          }
          
          console.log('🌊 ✅ Reconnection successful');
        } catch (error) {
          console.error('🌊 ❌ Reconnect failed:', error.message);
          // Will retry on next disconnect or heartbeat timeout
        }
      }
    }, delay);
  }

  /**
   * Start heartbeat monitoring
   */
  resetHeartbeatTimer() {
    this.clearHeartbeatTimer();
    this.heartbeatTimer = setTimeout(() => {
      const timeSinceLastHeartbeat = Date.now() - (this.lastHeartbeat || 0);
      console.warn(`🌊 ⚠️ No heartbeat received for ${timeSinceLastHeartbeat}ms, reconnecting...`);
      if (this.socket) {
        this.socket.close();
      }
    }, this.heartbeatTimeout);
  }

  /**
   * Clear heartbeat timer
   */
  clearHeartbeatTimer() {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Build credential string for login
   */
  buildCredentialString(params) {
    return Object.entries(params)
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
      .join('&');
  }

  /**
   * Get next request ID
   */
  getRequestId() {
    return ++this.requestId;
  }

  /**
   * Check if connected and authenticated
   */
  isConnected() {
    return this.state === STATES.AUTHENTICATED;
  }
}

module.exports = { SchwabStreamingClient };
