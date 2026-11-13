// Order lifecycle against Delta Exchange.
// This file only handles Delta's API shape — application logic lives in
// services/trading/orderManager.js.

const deltaClient = require('./deltaClient');
const deltaConfig = require('../../config/deltaConfig');
const logger = require('../../utils/logger');
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

// Delta does NOT accept "stop_market_order" / "stop_limit_order" /
// "take_profit_order" in `order_type` — the API only knows `market_order` and
// `limit_order` there. A stop order is a normal order PLUS a `stop_order_type`
// of "stop_loss_order" (a stop) or "take_profit_order" (a target) and a
// `stop_price` trigger. Sending the wrong shape comes back as "bad_schema",
// which is what silently killed every protective stop/target.
const STOP_ORDER_TYPES = {
  stop_market_order: 'stop_loss_order',
  stop_limit_order: 'stop_loss_order',
  take_profit_order: 'take_profit_order',
};

function validateOrderInput({ productId, size, side, orderType, limitPrice, stopPrice }) {
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
  if ((orderType === 'limit_order' || orderType === 'stop_limit_order') && !limitPrice) {
    throw new AppError('limitPrice is required for a limit order', 400);
  }
  if (STOP_ORDER_TYPES[orderType] && !stopPrice) {
    throw new AppError('stopPrice is required for a stop order', 400);
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
  bracketStopLossPrice,
  bracketTakeProfitPrice,
  bracketStopTriggerMethod,
}) {
  const order = {
    productId,
    size,
    side: String(side || '').toLowerCase(),
    orderType,
    limitPrice,
  };

  validateOrderInput({ ...order, stopPrice });

  const isStop = Boolean(STOP_ORDER_TYPES[orderType]);
  // A stop_limit_order stays a limit order once triggered; a stop_market_order
  // (and a take-profit) becomes a market order.
  const isLimitBase = orderType === 'limit_order' || orderType === 'stop_limit_order';

  const body = {
    product_id: Number(productId),
    size: Number(size),
    side: order.side,
    order_type: isStop ? (isLimitBase ? 'limit_order' : 'market_order') : orderType,
    client_order_id: clientOrderId || generateClientOrderId(),
  };

  if (isLimitBase) {
    body.limit_price = String(limitPrice);
    body.time_in_force = timeInForce;
  }
  if (isStop) body.stop_order_type = STOP_ORDER_TYPES[orderType];
  if (stopPrice) body.stop_price = String(stopPrice);
  if (reduceOnly) body.reduce_only = true;

  // An ATTACHED bracket: the same call that creates the entry also rests a fixed
  // stop and a fixed target on Delta, so the trade is never unprotected and
  // nothing has to be placed or moved afterwards.
  if (bracketStopLossPrice) body.bracket_stop_loss_price = String(bracketStopLossPrice);
  if (bracketTakeProfitPrice) body.bracket_take_profit_price = String(bracketTakeProfitPrice);
  if (bracketStopTriggerMethod) body.bracket_stop_trigger_method = bracketStopTriggerMethod;

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

// The ACCOUNT's leverage setting for a product, e.g. 5 for a 5x account. A
// strategy uses it to convert a return-on-margin target into an actual price.
// A failure here must never stop the bot from starting, so it falls back (the
// product's own default_leverage) and warns instead of throwing.
async function getLeverage({ productId, fallback = 1 } = {}) {
  const safeFallback = Number(fallback) > 0 ? Number(fallback) : 1;
  if (!productId) return safeFallback;

  try {
    const response = await deltaClient.get(deltaConfig.endpoints.productLeverage(productId));
    const leverage = Number(extractResult(response, {}).leverage);
    return leverage > 0 ? leverage : safeFallback;
  } catch (error) {
    logger.warn(
      `Could not read the account leverage for product ${productId} (${error.message}); ` +
        `assuming ${safeFallback}x`
    );
    return safeFallback;
  }
}

// Sets the ACCOUNT's leverage for a product. Delta expects {"leverage": "N"} on
// the same path used to read it. Called at startup so a strategy's pinned lot
// size fits inside the account — unlike getLeverage this one must surface a
// failure, so it throws instead of falling back.
async function setLeverage({ productId, leverage } = {}) {
  if (!productId) throw new AppError('productId is required to set leverage', 400);

  const value = Math.floor(Number(leverage));
  if (!Number.isFinite(value) || value < 1) {
    throw new AppError('leverage must be a positive whole number', 400);
  }

  const response = await deltaClient.post(deltaConfig.endpoints.productLeverage(productId), {
    leverage: String(value),
  });
  return extractResult(response);
}

module.exports = {
  placeOrder,
  cancelOrder,
  getOrder,
  getOpenOrders,
  getOrderHistory,
  getLeverage,
  setLeverage,
};
