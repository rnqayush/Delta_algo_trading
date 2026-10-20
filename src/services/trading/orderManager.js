// Application level order logic.
// It decides WHAT should happen with a signal (risk check, paper vs live,
// duplicate protection) while services/delta/orderService.js only knows HOW to
// talk to Delta Exchange.

const config = require('../../config/env');
const Order = require('../../models/Order');
const Trade = require('../../models/Trade');
const Position = require('../../models/Position');
const riskManager = require('./riskManager');
const positionManager = require('./positionManager');
const orderService = require('../delta/orderService');
const marketService = require('../delta/marketService');
const logger = require('../../utils/logger');
const { AppError } = require('../../utils/errorHandler');
const {
  isValidSignal,
  normalizeSignal,
  normalizeSymbol,
  mapDeltaOrderStatus,
  generateClientOrderId,
  startOfToday,
} = require('../../utils/helpers');

const OPEN_ORDER_STATUSES = ['pending', 'open', 'partially_filled'];
const DUPLICATE_LOOKBACK_MS = 5 * 60 * 1000;

// Order types that rest on the book until the market reaches their price.
// They are stored as "open" and are only filled on a later tick.
const RESTING_ORDER_TYPES = ['limit_order', 'stop_limit_order', 'take_profit_order'];

// In-memory guard against two identical orders being processed at the same time.
const ordersInFlight = new Set();

function isRestingOrderType(orderType) {
  return RESTING_ORDER_TYPES.includes(String(orderType || '').toLowerCase());
}

// Delta rejects a limit price that is not a whole multiple of the product's
// tick size (BTCUSD tick_size = 0.5), so snap the price before submitting.
// Without this every live entry is refused with an invalid-price error.
function roundToTick(price, tickSize) {
  const tick = Number(tickSize);
  const value = Number(price);
  if (!Number.isFinite(tick) || tick <= 0 || !Number.isFinite(value) || value <= 0) return value || 0;

  const decimals = (String(tick).split('.')[1] || '').length;
  return Number((Math.round(value / tick) * tick).toFixed(decimals));
}

// How long a resting entry stays alive before it is cancelled (4 x 15m by default).
function entryValidityMs() {
  return Number(config.strategy.entryValidityMinutes || 60) * 60 * 1000;
}

// The bracket / trade plan that must travel with the entry so the position can
// be managed (stop, partials, trail) once the order fills.
function buildBracket(signal, options = {}) {
  return {
    stopLoss: signal.stopLoss ?? null,
    takeProfit: Array.isArray(signal.takeProfit) ? signal.takeProfit : [],
    meta: signal.meta && typeof signal.meta === 'object' ? signal.meta : {},
    purpose: options.reduceOnly ? 'exit' : 'entry',
    reduceOnly: Boolean(options.reduceOnly),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// The single entry point used by the trading engine and the manual order route.
async function execute(rawSignal, options = {}) {
  const signal = normalizeSignal(rawSignal);
  const mode = options.mode || config.trading.mode;

  const signalCheck = isValidSignal(signal);
  if (!signalCheck.valid) {
    throw new AppError(signalCheck.reason, 400);
  }
  if (signal.action === 'HOLD') {
    return { executed: false, reason: 'Signal is HOLD — nothing to do', signal };
  }

  assertNotDuplicateInFlight(signal.clientOrderId);
  ordersInFlight.add(signal.clientOrderId);

  try {
    const existing = await Order.findOne({ clientOrderId: signal.clientOrderId });
    if (existing) {
      throw new AppError('Duplicate order blocked: this order was already submitted', 409);
    }

    // Concurrency gate. A strategy may hold up to `maxConcurrentPositions`
    // positions at once; each new entry is assigned the lowest free slot so the
    // trade manager can keep the slots independent. Reduce-only exits are exempt.
    if (!options.reduceOnly) {
      const gate = await concurrencyGate(signal.symbol);
      if (!gate.allowed) {
        logger.warn(`Order blocked: ${gate.reason}`);
        return { executed: false, reason: gate.reason, signal };
      }
      signal.meta = { ...(signal.meta || {}), slot: gate.slot };
    }

    const context = await buildRiskContext(signal, options);
    const decision = await riskManager.validate(signal, context);

    if (!decision.allowed) {
      logger.warn(`Risk rejection for ${signal.action} ${signal.symbol}: ${decision.reason}`);
      return { executed: false, reason: decision.reason, signal };
    }

    return mode === 'paper'
      ? await executePaperOrder(signal, context, options)
      : await executeLiveOrder(signal, options);
  } finally {
    ordersInFlight.delete(signal.clientOrderId);
  }
}

// Cancels an order. Paper orders are only cancelled locally.
async function cancelOrder({ orderId }) {
  const order = await Order.findById(orderId);
  if (!order) throw new AppError('Order not found', 404);

  if (order.status === 'cancelled') {
    throw new AppError('Order is already cancelled', 400);
  }

  if (!OPEN_ORDER_STATUSES.includes(order.status)) {
    throw new AppError(`Order cannot be cancelled because its status is "${order.status}"`, 400);
  }

  if (order.mode === 'live') {
    if (!config.trading.isLive) {
      throw new AppError('Cancelling a live order is blocked because live trading is not enabled', 403);
    }
    await orderService.cancelOrder({ orderId: order.deltaOrderId, productId: order.productId });
  }

  order.status = 'cancelled';
  await order.save();

  logger.info(`Order cancelled: ${order._id} (${order.symbol})`);
  return order;
}

// Keeps MongoDB in sync when the WebSocket reports an order update.
async function handleOrderUpdate(payload = {}) {
  const deltaOrderId = String(payload.id ?? payload.order_id ?? '');
  if (!deltaOrderId) return null;

  const order = await Order.findOne({ deltaOrderId });
  if (!order) {
    logger.debug(`WebSocket order update for an order we do not track (${deltaOrderId})`);
    return null;
  }

  // Delta repeats updates for an order (e.g. a later "closed" state). The books
  // must only be touched on the one transition into "filled", otherwise the
  // same fill is counted twice.
  const wasFilled = order.status === 'filled';

  if (payload.state) {
    order.deltaStatus = payload.state;
    order.status = mapDeltaOrderStatus(payload.state);
  }
  const averagePrice = Number(payload.average_fill_price || 0);
  if (averagePrice > 0) order.averagePrice = averagePrice;
  if (order.status === 'filled' && !order.filledAt) order.filledAt = new Date();

  await order.save();
  logger.info(`Order ${deltaOrderId} updated from WebSocket -> ${order.status}`);

  if (!wasFilled && order.status === 'filled') {
    await positionManager.applyOrder(order);
  }
  return order;
}

// Returns the resting order currently working for `symbol`, if any.
// The trading engine uses it to avoid opening a second position while an entry
// is still waiting on the book.
async function findLiveOrder(symbol) {
  const target = normalizeSymbol(symbol);
  if (!target) return null;

  return Order.findOne({ symbol: target, status: { $in: OPEN_ORDER_STATUSES } }).sort({ createdAt: -1 });
}

// All live ENTRY orders for a symbol (reduce-only exits excluded) — a symbol
// can have several when a strategy holds concurrent slots.
async function findLiveEntries(symbol) {
  const target = normalizeSymbol(symbol);
  if (!target) return [];

  return Order.find({
    symbol: target,
    status: { $in: OPEN_ORDER_STATUSES },
    reduceOnly: { $ne: true },
  }).sort({ createdAt: -1 });
}

// Drives resting PAPER orders forward: a limit entry fills as soon as the
// market trades through its price. Returns how many orders were filled.
async function handlePaperTick(symbol, price) {
  const target = normalizeSymbol(symbol);
  const mark = Number(price);
  if (!target || !Number.isFinite(mark) || mark <= 0) return 0;

  const resting = await Order.find({
    symbol: target,
    mode: 'paper',
    status: { $in: OPEN_ORDER_STATUSES },
  });

  let filled = 0;
  for (const order of resting) {
    if (!isRestingOrderType(order.orderType)) continue;

    const limit = Number(order.price);
    if (!limit) continue;

    // A buy limit only fills at or below its price; a sell limit at or above it.
    const touched = order.side === 'buy' ? mark <= limit : mark >= limit;
    if (!touched) continue;

    order.status = 'filled';
    order.averagePrice = limit;
    order.filledAt = new Date();
    order.expiresAt = null;
    await order.save();

    logger.info(`Paper limit filled: ${order.side} ${order.quantity} ${order.symbol} @ ${limit}`);

    try {
      await positionManager.applyOrder(order);
    } catch (error) {
      logger.error('Could not update the position for this filled limit order', error);
    }

    filled += 1;
  }

  return filled;
}

// Cancels resting orders whose validity window has passed (the 4-candle rule).
// Returns how many orders were cancelled.
async function cancelExpiredOrders(symbol) {
  const target = normalizeSymbol(symbol);
  const filter = {
    status: { $in: OPEN_ORDER_STATUSES },
    expiresAt: { $ne: null, $lte: new Date() },
  };
  if (target) filter.symbol = target;

  const expired = await Order.find(filter);

  let cancelled = 0;
  for (const order of expired) {
    if (order.mode === 'live' && order.deltaOrderId) {
      if (!config.trading.isLive) {
        logger.warn(`Expired live order ${order._id} was not cancelled — live trading is disabled`);
        continue;
      }
      try {
        await orderService.cancelOrder({ orderId: order.deltaOrderId, productId: order.productId });
      } catch (error) {
        logger.warn(`Could not cancel the expired live order ${order._id}: ${error.message}`);
        continue;
      }
    }

    order.status = 'cancelled';
    await order.save();
    logger.info(`Resting order expired and cancelled: ${order._id} (${order.symbol})`);
    cancelled += 1;
  }

  return cancelled;
}

// Resting protective stop for an open position.
//
// A protective stop is a reduce-only stop_market_order sitting on the opposite
// side of the position. It is a *safety net*: it lives on Delta, so the position
// stays protected even if this process is down when the stop is reached, and it
// is what moveProtectiveStop keeps in sync with the trailed level.
//
// It is deliberately NOT run through execute(): it is not a new entry, so it
// must skip the risk checks, the concurrency gate and the duplicate guard.
async function placeProtectiveStop(position) {
  if (!position) return null;

  const symbol = normalizeSymbol(position.symbol);
  const stopPrice = Number(position.initialStopLoss ?? position.stopLoss);
  const quantity = Math.abs(Number(position.quantity));
  if (!symbol || !Number.isFinite(stopPrice) || stopPrice <= 0 || !quantity) return null;

  // A protective stop always sits on the opposite side of the position.
  const side = position.side === 'long' ? 'sell' : 'buy';
  const positionId = String(position._id);
  const isLive = position.mode === 'live';

  // Never stack a second stop for the same position.
  const existing = await Order.findOne({
    symbol,
    purpose: 'stop',
    status: { $in: OPEN_ORDER_STATUSES },
    'meta.positionId': positionId,
  });
  if (existing) return existing;

  // Live orders need the product id and a tick-aligned stop price.
  let productId = position.productId || null;
  let tickSize = null;
  if (isLive) {
    const product = await marketService.getProduct(symbol);
    productId = productId || product.id;
    tickSize = product.tick_size ?? product.tickSize ?? null;
    position.productId = productId;
  }

  const clientOrderId = generateClientOrderId();
  const order = await Order.create({
    user: position.user || null,
    clientOrderId,
    symbol,
    productId,
    side,
    orderType: 'stop_market_order',
    quantity,
    price: stopPrice,
    status: isLive ? 'pending' : 'open',
    mode: position.mode,
    purpose: 'stop',
    reduceOnly: true,
    stopLoss: stopPrice,
    // Links the stop back to the slot it protects so a fill closes the right
    // position (see positionManager.applyOrder).
    meta: { positionId },
    strategyName: position.strategyName || 'manual',
    reason: 'Protective stop for the open position',
  });

  if (!isLive) {
    logger.info(`Paper protective stop resting at ${stopPrice} for ${symbol}`);
    return order;
  }

  if (!config.trading.isLive) {
    logger.warn(`Protective stop for ${symbol} was not placed — live trading is disabled`);
    return order;
  }

  try {
    const response = await orderService.placeOrder({
      symbol,
      productId,
      size: quantity,
      side,
      orderType: 'stop_market_order',
      stopPrice: roundToTick(stopPrice, tickSize),
      reduceOnly: true,
      clientOrderId,
    });

    order.deltaOrderId = String(response.id ?? response.order_id ?? '');
    order.deltaStatus = response.state || null;
    order.status = mapDeltaOrderStatus(response.state);
    await order.save();

    logger.info(`Protective stop placed for ${symbol} at ${stopPrice} (delta id ${order.deltaOrderId})`);
  } catch (error) {
    order.status = 'rejected';
    order.errorMessage = error.message;
    await order.save();
    logger.error(`Could not place the protective stop for ${symbol}: ${error.message}`);
  }

  return order;
}

// Moves the protective stop that belongs to an open position. Paper positions
// keep the level on the Order document; a live stop is cancelled and re-placed
// on Delta because the API has no "modify order" endpoint.
async function moveProtectiveStop(symbol, stopLoss) {
  const target = normalizeSymbol(symbol);
  const price = Number(stopLoss);
  if (!target || !Number.isFinite(price) || price <= 0) return null;

  const stopOrder = await Order.findOne({
    symbol: target,
    purpose: 'stop',
    status: { $in: OPEN_ORDER_STATUSES },
  }).sort({ createdAt: -1 });

  if (!stopOrder) {
    logger.debug(`No protective stop order to move for ${target} — the position tracks it`);
    return null;
  }

  if (stopOrder.mode === 'live' && stopOrder.deltaOrderId) {
    if (!config.trading.isLive) {
      logger.warn(`Protective stop for ${target} was not moved on Delta — live trading is disabled`);
      return stopOrder;
    }
    return replaceLiveStop(stopOrder, price);
  }

  stopOrder.price = price;
  await stopOrder.save();

  logger.info(`Protective stop for ${target} moved to ${price}`);
  return stopOrder;
}

// Cancels the resting protective stops that belong to a position. Called when
// the position is closed by something other than the stop itself, so nothing is
// left resting on the exchange.
async function cancelProtectiveStopsForPosition(position) {
  if (!position) return 0;

  const stops = await Order.find({
    symbol: normalizeSymbol(position.symbol),
    purpose: 'stop',
    status: { $in: OPEN_ORDER_STATUSES },
    'meta.positionId': String(position._id),
  });

  let cancelled = 0;
  for (const stop of stops) {
    if (stop.mode === 'live' && stop.deltaOrderId) {
      if (!config.trading.isLive) {
        logger.warn(`Protective stop for ${position.symbol} was not cancelled — live trading is disabled`);
        continue;
      }
      try {
        await orderService.cancelOrder({ orderId: stop.deltaOrderId, productId: stop.productId });
      } catch (error) {
        logger.warn(`Could not cancel the protective stop ${stop._id}: ${error.message}`);
        continue;
      }
    }

    stop.status = 'cancelled';
    await stop.save();
    cancelled += 1;
  }

  return cancelled;
}

// Delta has no modify-order endpoint, so a moved stop is a cancel plus a fresh
// stop_market_order. Only the tracked Order document is reused.
async function replaceLiveStop(stopOrder, price) {
  const productId = stopOrder.productId || (await marketService.getProduct(stopOrder.symbol)).id;

  try {
    await orderService.cancelOrder({ orderId: stopOrder.deltaOrderId, productId });
  } catch (error) {
    logger.warn(`Could not cancel the old protective stop (${stopOrder.deltaOrderId}): ${error.message}`);
  }

  const clientOrderId = generateClientOrderId();
  const response = await orderService.placeOrder({
    symbol: stopOrder.symbol,
    productId,
    size: stopOrder.quantity,
    side: stopOrder.side,
    orderType: 'stop_market_order',
    stopPrice: price,
    reduceOnly: true,
    clientOrderId,
  });

  stopOrder.price = price;
  stopOrder.clientOrderId = clientOrderId;
  stopOrder.deltaOrderId = String(response.id ?? response.order_id ?? '');
  stopOrder.deltaStatus = response.state || null;
  stopOrder.status = mapDeltaOrderStatus(response.state);
  await stopOrder.save();

  logger.info(`Protective stop for ${stopOrder.symbol} replaced at ${price} (delta id ${stopOrder.deltaOrderId})`);
  return stopOrder;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function assertNotDuplicateInFlight(clientOrderId) {
  if (ordersInFlight.has(clientOrderId)) {
    throw new AppError('Duplicate order blocked: this order is already being processed', 409);
  }
}

// Counts the open positions + resting entry orders for a symbol and returns the
// lowest free slot. `allowed` is false when every slot is taken.
async function concurrencyGate(symbol) {
  const target = normalizeSymbol(symbol);
  const maxConcurrent = Math.max(1, Number(config.strategy.maxConcurrentPositions) || 1);

  const [positions, liveEntries] = await Promise.all([
    positionManager.getOpenPositionsBySymbol(target),
    Order.find({
      symbol: target,
      status: { $in: OPEN_ORDER_STATUSES },
      reduceOnly: { $ne: true },
    }).select('meta'),
  ]);

  const used = new Set();
  positions.forEach((position) => used.add(Number(position.slot) || 0));
  liveEntries.forEach((order) => used.add(Number(order.meta && order.meta.slot) || 0));

  if (used.size >= maxConcurrent) {
    return {
      allowed: false,
      slot: null,
      reason: `${maxConcurrent} concurrent positions are already working for ${target}`,
    };
  }

  let slot = 0;
  while (used.has(slot)) slot += 1;
  return { allowed: true, slot };
}

// Collects the numbers the risk manager needs.
async function buildRiskContext(signal, options) {
  const [openTradesCount, recentOrders, positions, tradesToday] = await Promise.all([
    // Only working ENTRIES count as "open trades" — protective stops are
    // reduce-only and must not eat into the max-open-trades budget.
    Order.countDocuments({ status: { $in: OPEN_ORDER_STATUSES }, reduceOnly: { $ne: true } }),
    Order.find({ createdAt: { $gte: new Date(Date.now() - DUPLICATE_LOOKBACK_MS) } })
      .sort({ createdAt: -1 })
      .limit(25)
      .lean(),
    Position.find({ symbol: signal.symbol, status: 'open' }).lean(),
    Trade.find({ createdAt: { $gte: startOfToday() } }).lean(),
  ]);

  const positionQuantity = positions.reduce((total, item) => total + Math.abs(item.quantity || 0), 0);
  const dailyPnl = tradesToday.reduce((total, trade) => total + (trade.pnl || 0), 0);

  // The market price is only used for the price-deviation check, so a failure
  // here must not stop a legitimate order.
  let referencePrice = options.referencePrice;
  if (!referencePrice && options.fetchReferencePrice !== false) {
    try {
      referencePrice = (await marketService.getTicker(signal.symbol)).price;
    } catch (error) {
      logger.debug(`Could not read the market price for ${signal.symbol}: ${error.message}`);
    }
  }

  return {
    positionQuantity,
    openTradesCount,
    dailyPnl,
    recentOrders,
    referencePrice,
    userId: options.userId || null,
    // Lets the risk manager exempt closing orders from the entry-throttling
    // checks (max open trades / duplicate window).
    reduceOnly: Boolean(options.reduceOnly),
  };
}

// Simulated order: stored in MongoDB, never sent to Delta Exchange.
//
// A market order fills immediately. A limit/stop order RESTS on the book as
// "open" until a later tick trades through its price (see handlePaperTick) or
// its validity window runs out (see cancelExpiredOrders).
async function executePaperOrder(signal, context, options) {
  const price = Number(options.price || signal.price || context.referencePrice || 0);
  const bracket = buildBracket(signal, options);

  if (!price) {
    logger.warn(`Paper order for ${signal.symbol} has no price — storing it as 0`);
  }

  // Resting order: nothing fills yet, the entry waits for its price.
  if (isRestingOrderType(signal.orderType)) {
    const order = await Order.create({
      user: options.userId || null,
      clientOrderId: signal.clientOrderId,
      symbol: signal.symbol,
      side: signal.action === 'BUY' ? 'buy' : 'sell',
      orderType: signal.orderType,
      quantity: signal.quantity,
      price,
      averagePrice: 0,
      status: 'open',
      mode: 'paper',
      ...bracket,
      strategyName: signal.strategyName,
      reason: signal.reason,
      expiresAt: new Date(Date.now() + entryValidityMs()),
    });

    logger.info(
      `Paper order resting: ${order.side} ${order.quantity} ${order.symbol} @ ${price} ` +
        `(expires ${order.expiresAt.toISOString()})`
    );

    return { executed: true, mode: 'paper', order, position: null };
  }

  const order = await Order.create({
    user: options.userId || null,
    clientOrderId: signal.clientOrderId,
    symbol: signal.symbol,
    side: signal.action === 'BUY' ? 'buy' : 'sell',
    orderType: signal.orderType,
    quantity: signal.quantity,
    price,
    averagePrice: price,
    status: 'filled',
    mode: 'paper',
    ...bracket,
    strategyName: signal.strategyName,
    reason: signal.reason,
    filledAt: new Date(),
  });

  logger.info(`Paper order filled: ${order.side} ${order.quantity} ${order.symbol} @ ${price}`);

  let position = null;
  try {
    position = await positionManager.applyOrder(order);
  } catch (error) {
    logger.error('Could not update the position for this paper order', error);
  }

  return { executed: true, mode: 'paper', order, position };
}

// Real order sent to Delta Exchange.
async function executeLiveOrder(signal, options) {
  if (!config.trading.isLive) {
    throw new AppError(
      'Live order blocked: live trading is not enabled. Set TRADING_MODE=live and ENABLE_LIVE_TRADING=true.',
      403
    );
  }

  const product = await marketService.getProduct(signal.symbol);
  const side = signal.action === 'BUY' ? 'buy' : 'sell';
  const bracket = buildBracket(signal, options);
  const resting = isRestingOrderType(signal.orderType);

  // Delta refuses any limit price that is not a whole multiple of the
  // product's tick size (BTCUSD = 0.5). Snap it here or every live limit
  // entry/exit comes back "invalid price".
  const tickSize = product.tick_size ?? product.tickSize ?? null;
  const limitPrice = roundToTick(signal.price, tickSize);

  const order = await Order.create({
    user: options.userId || null,
    clientOrderId: signal.clientOrderId || generateClientOrderId(),
    symbol: signal.symbol,
    productId: product.id,
    side,
    orderType: signal.orderType,
    quantity: signal.quantity,
    price: limitPrice || 0,
    status: 'pending',
    mode: 'live',
    ...bracket,
    strategyName: signal.strategyName,
    reason: signal.reason,
    expiresAt: resting ? new Date(Date.now() + entryValidityMs()) : null,
  });

  try {
    const response = await orderService.placeOrder({
      symbol: signal.symbol,
      productId: product.id,
      size: signal.quantity,
      side,
      orderType: signal.orderType,
      limitPrice,
      reduceOnly: bracket.reduceOnly,
      clientOrderId: order.clientOrderId,
    });

    order.deltaOrderId = String(response.id ?? response.order_id ?? '');
    order.deltaStatus = response.state || null;
    order.status = mapDeltaOrderStatus(response.state);
    order.averagePrice = Number(response.average_fill_price || 0);
    order.price = Number(response.limit_price || limitPrice || 0);
    order.filledAt = order.status === 'filled' ? new Date() : null;
    await order.save();

    logger.info(`Live order submitted: ${order.side} ${order.quantity} ${order.symbol} (delta id ${order.deltaOrderId})`);

    if (order.status === 'filled') {
      await positionManager.applyOrder(order);
    }

    return { executed: true, mode: 'live', order };
  } catch (error) {
    order.status = 'rejected';
    order.errorMessage = error.message;
    await order.save();

    logger.error(`Live order rejected: ${error.message}`);
    throw error;
  }
}

module.exports = {
  execute,
  cancelOrder,
  handleOrderUpdate,
  findLiveOrder,
  findLiveEntries,
  handlePaperTick,
  cancelExpiredOrders,
  placeProtectiveStop,
  moveProtectiveStop,
  cancelProtectiveStopsForPosition,
};
