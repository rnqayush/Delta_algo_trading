// Real-time Delta Exchange data over WebSocket.
// The service ONLY handles the connection, subscriptions and reconnection.
// It emits events (ticker, orderUpdate, positionUpdate, connected, ...) which
// the trading engine and managers consume. No strategy logic lives here.

const EventEmitter = require('events');
const WebSocket = require('ws');
const config = require('../../config/env');
const deltaConfig = require('../../config/deltaConfig');
const logger = require('../../utils/logger');
const { buildWebSocketAuthHeaders } = require('../../utils/helpers');

class DeltaWebSocket extends EventEmitter {
  constructor(options = {}) {
    super();
    this.url = options.url || deltaConfig.wsUrl;
    this.maxReconnectAttempts = options.maxReconnectAttempts || 10;
    this.socket = null;
    this.connected = false;
    this.closingManually = false;
    this.reconnectAttempts = 0;
    this.subscriptions = new Set(); // remembered so we can re-subscribe after a reconnect
    this.heartbeatTimer = null;
  }

  isConnected() {
    return this.connected;
  }

  connect() {
    if (this.connected) return;
    if (this.socket && this.socket.readyState === WebSocket.CONNECTING) return;

    this.closingManually = false;

    const headers = deltaConfig.apiKey && deltaConfig.apiSecret ? buildWebSocketAuthHeaders() : {};
    logger.info(`Connecting to Delta WebSocket at ${this.url}`);

    this.socket = new WebSocket(this.url, { headers });

    this.socket.on('open', () => this.handleOpen());
    this.socket.on('message', (raw) => this.handleMessage(raw));
    this.socket.on('error', (error) => this.handleSocketError(error));
    this.socket.on('close', (code, reason) => this.handleClose(code, reason));
    this.socket.on('pong', () => logger.debug('Delta WebSocket pong received'));
  }

  handleOpen() {
    this.connected = true;
    this.reconnectAttempts = 0;

    logger.info('Delta WebSocket connected');
    this.emit('connected');

    // Re-subscribe everything that was requested before the (re)connect.
    for (const payload of this.subscriptions) {
      this.send(payload);
    }

    this.startHeartbeat();
  }

  handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch (error) {
      logger.warn('Received invalid JSON from Delta WebSocket');
      return;
    }

    if (message.type === 'heartbeat') return;

    if (message.type === 'error' || message.success === false) {
      logger.error('Delta WebSocket returned an error message', message);
      this.emit('errorMessage', message);
      return;
    }

    const payload = message.data !== undefined ? message.data : message;

    if (message.type === deltaConfig.wsChannels.ticker) {
      this.emit('ticker', { ...payload, symbol: message.symbol || payload.symbol });
      return;
    }
    if (message.type === deltaConfig.wsChannels.orders) {
      this.emit('orderUpdate', payload);
      return;
    }
    if (message.type === deltaConfig.wsChannels.positions) {
      this.emit('positionUpdate', payload);
      return;
    }

    this.emit('update', message);
  }

  handleSocketError(error) {
    // Note: 'error' is not emitted directly because EventEmitter throws when
    // an 'error' event has no listener.
    logger.error(`Delta WebSocket error: ${error.message}`);
    this.emit('socketError', error);
  }

  handleClose(code, reason) {
    this.connected = false;
    this.stopHeartbeat();
    logger.warn(`Delta WebSocket disconnected (code: ${code})`);
    this.emit('disconnected', { code, reason: reason?.toString() });

    if (this.closingManually) return;
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error('Delta WebSocket gave up reconnecting. Call connect() again to retry.');
      this.emit('reconnectFailed');
      return;
    }

    this.reconnectAttempts += 1;

    // Exponential backoff capped at 30 seconds.
    const delay = Math.min(1000 * 2 ** (this.reconnectAttempts - 1), 30000);
    logger.info(`Reconnecting to Delta WebSocket in ${delay}ms (attempt ${this.reconnectAttempts})`);

    setTimeout(() => {
      if (!this.closingManually) this.connect();
    }, delay);
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        this.socket.ping();
      }
    }, 30000);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  send(payload) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      logger.debug('Delta WebSocket not open yet — subscription will be sent after connect');
      return false;
    }

    this.socket.send(JSON.stringify(payload));
    return true;
  }

  // -------------------------------------------------------------------------
  // Subscriptions
  // -------------------------------------------------------------------------

  subscribe(channels) {
    const payload = { type: 'subscribe', payload: { channels } };
    this.subscriptions.add(JSON.stringify(payload));
    this.send(payload);
    return payload;
  }

  unsubscribe(channels) {
    const payload = { type: 'unsubscribe', payload: { channels } };
    this.subscriptions.delete(JSON.stringify({ type: 'subscribe', payload: { channels } }));
    this.send(payload);
    return payload;
  }

  subscribeTickers(symbols) {
    const list = Array.isArray(symbols) ? symbols : [symbols];
    return this.subscribe(
      list.map((symbol) => ({ name: deltaConfig.wsChannels.ticker, symbols: [symbol] }))
    );
  }

  // Private channels need valid API keys in the environment.
  subscribeOrderUpdates() {
    return this.subscribe([{ name: deltaConfig.wsChannels.orders }]);
  }

  subscribePositionUpdates() {
    return this.subscribe([{ name: deltaConfig.wsChannels.positions }]);
  }

  disconnect() {
    this.closingManually = true;
    this.stopHeartbeat();

    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.connected = false;
    logger.info('Delta WebSocket disconnected manually');
  }
}

// A single shared instance is exported so the whole app uses one connection.
const deltaWebSocket = new DeltaWebSocket();

module.exports = deltaWebSocket;
module.exports.DeltaWebSocket = DeltaWebSocket;
