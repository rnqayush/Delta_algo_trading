// Small, reusable functions used across the project.
// Keeping the Delta signing logic here means no other file has to know how it works.

const crypto = require('crypto');
const config = require('../config/env');

// ---------------------------------------------------------------------------
// Delta Exchange request signing
// Delta expects: HMAC_SHA256(secret, method + timestamp + path + query + body)
// ---------------------------------------------------------------------------

function buildQueryString(params) {
  if (!params) return '';

  return Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => {
      const flat = Array.isArray(value) ? value.join(',') : value;
      return `${encodeURIComponent(key)}=${encodeURIComponent(flat)}`;
    })
    .join('&');
}

function signRequest({ method, path, queryString = '', rawBody = '', timestamp, secret }) {
  const payload = `${String(method).toUpperCase()}${timestamp}${path}${queryString}${rawBody}`;
  return crypto
    .createHmac('sha256', secret || config.delta.apiSecret)
    .update(payload)
    .digest('hex');
}

// Headers for a private REST request.
function buildAuthHeaders({ method, path, queryString = '', rawBody = '' }) {
  const timestamp = Math.floor(Date.now() / 1000);

  return {
    'api-key': config.delta.apiKey,
    timestamp: String(timestamp),
    signature: signRequest({ method, path, queryString, rawBody, timestamp }),
    'Content-Type': 'application/json',
  };
}

// Headers for the private WebSocket connection.
// The signed string is "GET" + timestamp + "/live".
function buildWebSocketAuthHeaders() {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signRequest({ method: 'GET', path: '/live', timestamp });

  return {
    'api-key': config.delta.apiKey,
    timestamp: String(timestamp),
    signature,
  };
}

// ---------------------------------------------------------------------------
// HTTP response helpers — keeps every API response in the same shape
// ---------------------------------------------------------------------------

function sendSuccess(res, data = {}, statusCode = 200, message) {
  const body = { success: true, data };
  if (message) body.message = message;
  return res.status(statusCode).json(body);
}

function sendError(res, message, statusCode = 500) {
  return res.status(statusCode).json({ success: false, message });
}

// ---------------------------------------------------------------------------
// Trading signal helpers
// ---------------------------------------------------------------------------

const VALID_ACTIONS = ['BUY', 'SELL', 'HOLD'];

// A strategy must always return a normalised signal. This makes sure it did.
function isValidSignal(signal) {
  if (!signal || typeof signal !== 'object') {
    return { valid: false, reason: 'Trading signal must be an object' };
  }

  const action = String(signal.action || '').toUpperCase();
  if (!VALID_ACTIONS.includes(action)) {
    return { valid: false, reason: `Invalid trading signal action: ${signal.action}` };
  }
  if (action === 'HOLD') {
    return { valid: true, reason: 'Hold signal' };
  }
  if (!signal.symbol) {
    return { valid: false, reason: 'Trading signal is missing a symbol' };
  }

  const quantity = Number(signal.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return { valid: false, reason: 'Trading signal quantity must be a positive number' };
  }

  return { valid: true, reason: 'Valid signal' };
}

// Converts anything that looks like a signal into the project's standard shape.
// stopLoss / takeProfit / meta are carried through untouched so the execution
// engine can place a bracket and the trade manager can manage the position.
function normalizeSignal(signal = {}) {
  const price = Number(signal.price ?? signal.limitPrice);
  const stopLoss = Number(signal.stopLoss);
  const meta = signal.meta && typeof signal.meta === 'object' ? signal.meta : undefined;

  return {
    action: String(signal.action || 'HOLD').toUpperCase(),
    symbol: signal.symbol ? normalizeSymbol(signal.symbol) : undefined,
    quantity: Number(signal.quantity || 0),
    price: Number.isFinite(price) && price > 0 ? price : undefined,
    orderType: signal.orderType || 'market_order',
    stopLoss: Number.isFinite(stopLoss) && stopLoss > 0 ? stopLoss : undefined,
    takeProfit: Array.isArray(signal.takeProfit) ? signal.takeProfit : undefined,
    meta,
    strategyName: signal.strategyName || signal.strategy || 'manual',
    reason: signal.reason || '',
    clientOrderId: signal.clientOrderId || generateClientOrderId(),
  };
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

function normalizeSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase();
}

function generateClientOrderId(prefix = 'bot') {
  const random = crypto.randomBytes(4).toString('hex');
  return `${prefix}-${Date.now()}-${random}`;
}

// Delta order states are mapped to the statuses stored in MongoDB.
function mapDeltaOrderStatus(state) {
  const mapping = {
    open: 'open',
    pending: 'pending',
    closed: 'filled',
    cancelled: 'cancelled',
    rejected: 'rejected',
  };
  return mapping[String(state || '').toLowerCase()] || 'open';
}

function startOfToday() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(Number(value) * factor) / factor;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  buildQueryString,
  signRequest,
  buildAuthHeaders,
  buildWebSocketAuthHeaders,
  sendSuccess,
  sendError,
  isValidSignal,
  normalizeSignal,
  normalizeSymbol,
  generateClientOrderId,
  mapDeltaOrderStatus,
  startOfToday,
  round,
  sleep,
};
