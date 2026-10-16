// Order lifecycle against Delta Exchange.
// This file only handles Delta's API shape — application logic lives in
// services/trading/orderManager.js.

const deltaClient = require('./deltaClient');
const deltaConfig = require('../../config/deltaConfig');
const { AppError } = require('../../utils/errorHandler');
const { generateClientOrderId, normalizeSymbol } = require('../../utils/helpers');

const { extractResult } = deltaClient;

const VALID_SIDES = ['buy', 'sell'];
const VALID_ORDER_TYPES = [
  'market_order',
  'limit_order',
  'stop_market_order',
  'stop_limit_order',
  'take_profit_order',
];

function validateOrderInput({ productId, size, side, orderType, limitPrice }) {
  if (!productId) throw new AppError('productId is required to place an order', 400);
  if (!Number.isFinite(Number(size)) || Number(size) <= 0) {
    throw new AppError('Order size must be a positive number', 400);
  }
  if (!VALID_SIDES.includes(side)) {
    throw new AppError(`Order side must be one of: ${VALID_SIDES.join(', ')}`, 400);
  }
  if (!VALID_ORDER_TYPES.includes(orderType)) {
    throw new AppError(`Unsupported order type: ${orderType}`, 400);
  }
  if (orderType === 'limit_order' && !limitPrice) {
    throw new AppError('limitPrice is required for a limit order', 400);
  }
}

// Sends a real order to Delta Exchange.
async function placeOrder({
  symbol,
  productId,
  size,
  side,
  orderType = 'market_order',
  limitPrice,
  stopPrice,
  timeInForce = 'gtc',
  reduceOnly = false,
  clientOrderId,
}) {
  const order = {
    productId,
    size,
    side: String(side || '').toLowerCase(),
    orderType,
    limitPrice,
  };

  validateOrderInput(order);

  const body = {
    product_id: Number(productId),
    size: Number(size),
    side: order.side,
    order_type: orderType,
    client_order_id: clientOrderId || generateClientOrderId(),
  };

  if (orderType === 'limit_order') {
    body.limit_price = String(limitPrice);
    body.time_in_force = timeInForce;
  }
  if (stopPrice) body.stop_price = String(stopPrice);
  if (reduceOnly) body.reduce_only = true;

  const response = await deltaClient.post(deltaConfig.endpoints.orders, body);
  return extractResult(response);
}

// Delta requires both the order id and the product id to cancel an order.
async function cancelOrder({ orderId, productId }) {
  if (!orderId) throw new AppError('orderId is required to cancel an order', 400);
  if (!productId) throw new AppError('productId is required to cancel an order', 400);

  const response = await deltaClient.delete(deltaConfig.endpoints.orders, {
    id: Number(orderId),
    product_id: Number(productId),
  });

  return extractResult(response);
}

async function getOrder(orderId) {
  if (!orderId) throw new AppError('orderId is required', 400);

  const response = await deltaClient.get(deltaConfig.endpoints.order(orderId));
  return extractResult(response);
}

async function getOpenOrders({ productId } = {}) {
  const params = productId ? { product_ids: productId } : undefined;

  const response = await deltaClient.get(deltaConfig.endpoints.orders, params);
  return extractResult(response, []);
}

async function getOrderHistory({ symbol, productId, start, end, pageSize } = {}) {
  const params = {};
  if (productId) params.product_ids = productId;
  if (start) params.start_time = start;
  if (end) params.end_time = end;
  if (pageSize) params.page_size = pageSize;

  const response = await deltaClient.get(deltaConfig.endpoints.ordersHistory, params);
  const orders = extractResult(response, []);

  // Delta can also filter server-side, but this keeps the service predictable.
  if (symbol && Array.isArray(orders)) {
    const wanted = normalizeSymbol(symbol);
    return orders.filter((order) => order.product_symbol === wanted);
  }
  return orders;
}

module.exports = {
  placeOrder,
  cancelOrder,
  getOrder,
  getOpenOrders,
  getOrderHistory,
};
