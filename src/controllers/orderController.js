// HTTP layer for orders. All the decision making happens in
// services/trading/orderManager.js.

const Order = require('../models/Order');
const orderManager = require('../services/trading/orderManager');
const { AppError } = require('../utils/errorHandler');
const { sendSuccess, normalizeSymbol } = require('../utils/helpers');

// POST /api/orders
// body: { symbol, side: "buy" | "sell", quantity, price?, orderType? }
async function createOrder(req, res, next) {
  try {
    const { symbol, side, quantity, price, orderType, strategy } = req.body;

    if (!symbol) throw new AppError('symbol is required (for example BTCUSD)', 400);
    if (!side) throw new AppError('side is required ("buy" or "sell")', 400);

    const action = String(side).toUpperCase();
    if (!['BUY', 'SELL'].includes(action)) {
      throw new AppError('side must be either "buy" or "sell"', 400);
    }

    // The trading mode always comes from the environment, never from the client.
    const result = await orderManager.execute(
      {
        action,
        symbol,
        quantity,
        price,
        orderType,
        strategyName: strategy || 'manual',
        reason: 'Order placed manually through the API',
      },
      { userId: req.user?._id || null }
    );

    if (!result.executed) {
      throw new AppError(result.reason, 400);
    }

    return sendSuccess(res, { order: result.order, mode: result.mode }, 201);
  } catch (error) {
    next(error);
  }
}

// GET /api/orders?symbol=&status=&limit=
async function getOrders(req, res, next) {
  try {
    const filter = {};
    if (req.query.symbol) filter.symbol = normalizeSymbol(req.query.symbol);
    if (req.query.status) filter.status = req.query.status;

    const limit = Math.min(Number(req.query.limit) || 50, 200);

    // Orders are not filtered per user: the Delta Exchange account is shared,
    // so bots and manual orders belong to the same account.
    const orders = await Order.find(filter).sort({ createdAt: -1 }).limit(limit);

    return sendSuccess(res, { count: orders.length, orders });
  } catch (error) {
    next(error);
  }
}

// GET /api/orders/:id
async function getOrder(req, res, next) {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) throw new AppError('Order not found', 404);

    return sendSuccess(res, { order });
  } catch (error) {
    next(error);
  }
}

// DELETE /api/orders/:id
async function cancelOrder(req, res, next) {
  try {
    const order = await orderManager.cancelOrder({ orderId: req.params.id });
    return sendSuccess(res, { order });
  } catch (error) {
    next(error);
  }
}

module.exports = { createOrder, getOrders, getOrder, cancelOrder };
