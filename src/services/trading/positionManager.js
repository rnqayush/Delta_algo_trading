// Application-level position state.
//
// Delta API calls stay in services/delta/positionService.js — this file only
// looks after what the bot believes it is holding, and keeps that in sync with
// the orders that fill and the position updates that arrive over the WebSocket.

const Position = require('../../models/Position');
const Trade = require('../../models/Trade');
const logger = require('../../utils/logger');
const { AppError } = require('../../utils/errorHandler');
const { normalizeSymbol } = require('../../utils/helpers');
const config = require('../../config/env');
const positionService = require('../delta/positionService');
const marketService = require('../delta/marketService');

// Profit/loss for closing `quantity` of a position at `exitPrice`.
// A long position gains when the price rises; a short position gains when it falls.
function calculatePnl(side, entryPrice, exitPrice, quantity) {
  const direction = side === 'long' ? 1 : -1;
  return (Number(exitPrice) - Number(entryPrice)) * Number(quantity) * direction;
}

function sideFromOrder(orderSide) {
  return orderSide === 'sell' ? 'short' : 'long';
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function getPositions({ status = 'open', symbol } = {}) {
  const filter = {};
  if (status) filter.status = status;
  if (symbol) filter.symbol = normalizeSymbol(symbol);

  return Position.find(filter).sort({ createdAt: -1 });
}

async function getPositionBySymbol(symbol) {
  const target = normalizeSymbol(symbol);
  if (!target) return null;

  return Position.findOne({ symbol: target, status: 'open' }).sort({ createdAt: -1 });
}

// Every open position for a symbol, oldest first. A symbol can hold several
// when a strategy uses concurrent slots (see orderManager.concurrencyGate).
async function getOpenPositionsBySymbol(symbol) {
  const target = normalizeSymbol(symbol);
  if (!target) return [];

  return Position.find({ symbol: target, status: 'open' }).sort({ createdAt: 1 });
}

// The open Trade that belongs to a position. With concurrent slots there can be
// several open trades for one symbol, so the entry order id (stored in the
// position plan) is the reliable link; fall back to the newest for legacy rows.
async function findTradeForPosition(position) {
  if (!position) return null;

  const entryOrderId = position.plan && position.plan.entryOrderId;
  if (entryOrderId) {
    const linked = await Trade.findOne({ entryOrder: entryOrderId, status: 'open' });
    if (linked) return linked;
  }

  return Trade.findOne({ symbol: position.symbol, status: 'open' }).sort({ createdAt: -1 });
}

// Refreshes the mark-to-market value of every open position for the symbol.
async function updatePositionPrice(symbol, price) {
  const positions = await getOpenPositionsBySymbol(symbol);
  if (!positions.length) return null;

  let last = null;
  for (const position of positions) {
    const currentPrice = Number(price) || position.entryPrice;
    position.currentPrice = currentPrice;
    position.unrealizedPnl = calculatePnl(position.side, position.entryPrice, currentPrice, position.quantity);
    await position.save();
    last = position;
  }
  return last;
}

// ---------------------------------------------------------------------------
// Applying a filled order
// ---------------------------------------------------------------------------

// Opens a brand new position and the Trade that tracks the round trip.
async function openPosition(order, quantity, price, symbol) {
  const side = sideFromOrder(order.side);

  const position = await Position.create({
    user: order.user || null,
    symbol,
    productId: order.productId || null,
    side,
    quantity,
    entryPrice: price,
    currentPrice: price,
    unrealizedPnl: 0,
    status: 'open',
    mode: order.mode,
    strategyName: order.strategyName || 'manual',
    // Which concurrent slot this entry belongs to (0..N-1). Assigned by
    // orderManager.concurrencyGate and carried in the signal meta.
    slot: Number((order.meta && order.meta.slot) || 0),
    // Trade-management plan carried over from the entry signal (may be empty
    // for manual/live-discovered positions, in which case it is left unmanaged).
    stopLoss: order.stopLoss || null,
    initialStopLoss: order.stopLoss || null,
    takeProfit: Array.isArray(order.takeProfit) ? order.takeProfit : [],
    riskPerUnit: order.stopLoss ? Math.abs(price - order.stopLoss) : null,
    stage: 'OPEN',
    plan: { ...(order.meta || {}), entryOrderId: order._id },
    openedAt: new Date(),
  });

  await Trade.create({
    user: order.user || null,
    symbol,
    side: order.side,
    quantity,
    entryPrice: price,
    status: 'open',
    entryOrder: order._id,
    strategyName: order.strategyName || 'manual',
    mode: order.mode,
    entryAt: new Date(),
  });

  logger.info(`Position opened: ${position.side} ${quantity} ${symbol} @ ${price}`);
  return position;
}

// Applies a FILLED order to the local book: opens, increases, reduces, closes
// or reverses the position for that symbol, and writes/completes a Trade.
//
// Call this exactly once per filled order. orderManager does that when it fills
// an order itself, and again from handleOrderUpdate() only on the transition to
// "filled" — never on repeat updates.
async function applyOrder(order) {
  if (!order || order.status !== 'filled') return null;

  const symbol = normalizeSymbol(order.symbol);
  const quantity = Number(order.quantity);
  const price = Number(order.averagePrice || order.price || 0);

  if (!symbol || !Number.isFinite(quantity) || quantity <= 0) {
    logger.warn('Ignored a filled order with no usable symbol or quantity');
    return null;
  }

  const orderSide = sideFromOrder(order.side);

  // A symbol can hold several positions at once (one per concurrent slot), so
  // resolve WHICH position this fill belongs to:
  //   * an exit (reduce-only) carries the target position id in its meta;
  //   * an entry belongs to the slot the concurrency gate assigned it.
  const isExit = Boolean(order.reduceOnly) || order.purpose === 'exit';
  let position = null;
  if (isExit) {
    const explicitId = order.meta && order.meta.positionId;
    position = explicitId ? await Position.findById(explicitId) : await getPositionBySymbol(symbol);
    if (position && position.status !== 'open') position = null;
  } else {
    const slot = Number((order.meta && order.meta.slot) || 0);
    position = await Position.findOne({ symbol, status: 'open', slot }).sort({ createdAt: -1 });
  }

  // 1. Nothing open in this slot — start a new position.
  if (!position) {
    return openPosition(order, quantity, price, symbol);
  }

  // 2. Same direction — the position grows. Keep a weighted average entry price.
  if (position.side === orderSide) {
    const totalQuantity = position.quantity + quantity;
    position.entryPrice =
      (position.entryPrice * position.quantity + price * quantity) / totalQuantity;
    position.quantity = totalQuantity;
    position.currentPrice = price;
    position.unrealizedPnl = 0;
    await position.save();

    const trade = await findTradeForPosition(position);
    if (trade) {
      trade.quantity = totalQuantity;
      trade.entryPrice = position.entryPrice;
      await trade.save();
    }

    logger.info(`Position increased: ${position.side} ${position.quantity} ${symbol} @ ${price}`);
    return position;
  }

  // 3. Opposite direction — reduce, close or reverse.
  const closingQuantity = Math.min(quantity, position.quantity);
  const realizedPnl = calculatePnl(position.side, position.entryPrice, price, closingQuantity);
  position.realizedPnl = (position.realizedPnl || 0) + realizedPnl;

  const remaining = position.quantity - closingQuantity;

  if (remaining > 0) {
    position.quantity = remaining;
    position.currentPrice = price;
    position.unrealizedPnl = calculatePnl(position.side, position.entryPrice, price, remaining);
    await position.save();

    const trade = await findTradeForPosition(position);
    if (trade) {
      trade.quantity = remaining;
      trade.pnl = (trade.pnl || 0) + realizedPnl;
      await trade.save();
    }

    logger.info(`Position reduced: ${position.side} ${remaining} ${symbol} (PnL ${realizedPnl})`);
    return position;
  }

  // Fully closed. Settle the position and its Trade.
  position.quantity = 0;
  position.status = 'closed';
  position.closedAt = new Date();
  position.currentPrice = price;
  position.unrealizedPnl = 0;
  await position.save();

  const trade = await findTradeForPosition(position);
  if (trade) {
    trade.exitPrice = price;
    trade.exitAt = new Date();
    trade.exitOrder = order._id;
    trade.status = 'closed';
    trade.pnl = (trade.pnl || 0) + realizedPnl;
    await trade.save();
  }

  logger.info(`Position closed: ${position.side} ${symbol} @ ${price} (PnL ${realizedPnl})`);

  // 4. If the order was larger than the position, the excess flips direction.
  const leftover = quantity - closingQuantity;
  if (leftover > 0) {
    return openPosition(order, leftover, price, symbol);
  }

  return position;
}

// ---------------------------------------------------------------------------
// Trade management (SL / TP partials / structural trail / exits)
// ---------------------------------------------------------------------------
//
// Driven by the trading engine on every cycle while a position is open. The
// rules mirror §7 of the Sweep & Shift spec: 40% off at +1R, 30% at +2R, lock
// the stop at +1R only after TP2, then trail on confirmed 15m swings.

const SWING_LOOKBACK = 2; // must match the strategy's fractal width
const STALL_CANDLES = 8;
const STALL_BAND_R = 0.5;

function lastConfirmedSwing(candles, type) {
  const priceOf = (candle) => Number(type === 'HIGH' ? candle.high : candle.low);

  for (let i = candles.length - 1 - SWING_LOOKBACK; i >= SWING_LOOKBACK; i -= 1) {
    let isSwing = true;
    for (let j = i - SWING_LOOKBACK; j <= i + SWING_LOOKBACK; j += 1) {
      if (j === i) continue;
      const other = priceOf(candles[j]);
      if (type === 'HIGH' && other >= priceOf(candles[i])) isSwing = false;
      if (type === 'LOW' && other <= priceOf(candles[i])) isSwing = false;
    }
    if (isSwing) return priceOf(candles[i]);
  }

  return null;
}

// Ratchets the stop to the last confirmed 15m swing. Never loosens it.
function trailStop(position, candles15m) {
  if (!Array.isArray(candles15m) || candles15m.length < SWING_LOOKBACK * 2 + 3) return false;

  const swing = lastConfirmedSwing(candles15m, position.side === 'long' ? 'LOW' : 'HIGH');
  if (swing === null) return false;

  const tickSize = Number((position.plan && position.plan.tickSize) || 0);
  const avgBody = Number((position.plan && position.plan.avgBody) || 0);
  const buffer = Math.max(tickSize, 0.2 * avgBody);
  if (buffer <= 0) return false;

  const candidate = position.side === 'long' ? swing - buffer : swing + buffer;
  const next =
    position.side === 'long'
      ? Math.max(Number(position.stopLoss), candidate)
      : Math.min(Number(position.stopLoss), candidate);

  if (Math.abs(next - Number(position.stopLoss)) < 1e-9) return false;

  position.stopLoss = next;
  return true;
}

// Closes a percentage of the position with a reduce-only market order.
async function exitPartial(position, percent, price, reason, userId) {
  const quantity = Math.floor(Number(position.quantity) * (percent / 100));
  if (quantity < 1) return false;

  const orderManager = require('./orderManager');
  const closingSide = position.side === 'long' ? 'SELL' : 'BUY';

  const result = await orderManager.execute(
    {
      action: closingSide,
      symbol: position.symbol,
      quantity,
      price,
      orderType: 'market_order',
      strategyName: position.strategyName,
      reason,
      // Tells applyOrder which of the concurrent positions this exit reduces.
      meta: { positionId: String(position._id) },
    },
    { userId, reduceOnly: true, fetchReferencePrice: false }
  );

  if (!result.executed) {
    logger.warn(`Partial exit (${reason}) was not executed: ${result.reason}`);
    return false;
  }

  logger.info(`Partial exit ${percent}% on ${position.symbol} (${reason})`);
  return true;
}

async function exitPosition(position, price, reason, userId) {
  try {
    logger.info(`Exiting ${position.side} ${position.symbol}: ${reason}`);
    return await closePosition({ symbol: position.symbol, price, userId, positionId: position._id });
  } catch (error) {
    logger.warn(`Could not exit the ${position.side} position on ${position.symbol}: ${error.message}`);
    return position;
  }
}

// Trade management entry point. Runs for EVERY open position of the symbol
// (a strategy can hold several concurrent slots) and dispatches to the manager
// that matches the position's exit plan.
async function manageOpenPosition({ symbol, price, candles15m = [], userId = null } = {}) {
  const positions = await getOpenPositionsBySymbol(symbol);
  if (!positions.length) return null;

  let last = null;
  for (const position of positions) {
    try {
      last = await managePosition(position, { price, candles15m, userId });
    } catch (error) {
      logger.error(`Could not manage position ${position._id} on ${position.symbol}: ${error.message}`);
      last = position;
    }
  }
  return last;
}

// Dispatches a single position to the right exit machine.
function managePosition(position, context) {
  const exitMode = (position.plan && position.plan.exitMode) || 'staged';
  return exitMode === 'simple'
    ? manageSimplePosition(position, context)
    : manageStagedPosition(position, context);
}

// Simple exit machine: one hard stop, one fixed target, one time exit. Used by
// VHR-15, whose backtest models exactly this (full exit at the target).
async function manageSimplePosition(position, { price, userId }) {
  const entry = Number(position.entryPrice);
  const mark = Number(price);
  if (!mark || !entry) return position;

  const side = position.side;
  const stop = Number(position.stopLoss);
  const target =
    Array.isArray(position.takeProfit) && position.takeProfit.length
      ? Number(position.takeProfit[0].price)
      : null;

  // 1. Hard stop (taker / market exit).
  if (Number.isFinite(stop) && (side === 'long' ? mark <= stop : mark >= stop)) {
    return exitPosition(position, mark, `Stop loss at ${stop}`, userId);
  }

  // 2. Fixed target (full exit).
  if (Number.isFinite(target) && target > 0 && (side === 'long' ? mark >= target : mark <= target)) {
    return exitPosition(position, mark, `Target at ${target}`, userId);
  }

  // 3. Time exit — the backtest's hard time stop (e.g. 64 x 15m = 16h).
  const timeExitBars = Number((position.plan && position.plan.timeExitBars) || 0);
  if (timeExitBars > 0) {
    const bars = Math.max(0, Math.floor((Date.now() - new Date(position.openedAt).getTime()) / (15 * 60 * 1000)));
    if (bars >= timeExitBars) {
      return exitPosition(position, mark, `Time exit after ${bars} bars`, userId);
    }
  }

  return position;
}

// Staged exit machine (Sweep & Shift): hard stop, 40% at +1R, 30% at +2R with
// the stop locked to +1R, then a structural trail on the runner. Returns the
// (possibly updated) position.
async function manageStagedPosition(position, { price, candles15m = [], userId }) {
  const entry = Number(position.entryPrice);
  const mark = Number(price);
  if (!mark) return position;

  // Only positions opened with a plan are managed here.
  if (!position.initialStopLoss || !entry) return position;

  const risk = Math.abs(entry - Number(position.initialStopLoss));
  if (!risk) return position;

  const side = position.side;
  const reached = (r) => (side === 'long' ? mark >= entry + r * risk : mark <= entry - r * risk);
  const bars = Math.max(0, Math.floor((Date.now() - new Date(position.openedAt).getTime()) / (15 * 60 * 1000)));

  // 1. Hard stop.
  const stopHit = side === 'long' ? mark <= Number(position.stopLoss) : mark >= Number(position.stopLoss);
  if (stopHit) return exitPosition(position, mark, `Stop loss at ${position.stopLoss}`, userId);

  // 2. TP1 — close 40% at +1R.
  if (position.stage === 'OPEN' && reached(1)) {
    if (await exitPartial(position, 40, mark, 'TP1 (+1R)', userId)) {
      position.stage = 'PARTIAL_1';
      await position.save();
    }
    return position;
  }

  // 3. TP2 — close 30% at +2R, then lock the stop at +1R.
  if (position.stage === 'PARTIAL_1' && reached(2)) {
    if (await exitPartial(position, 30, mark, 'TP2 (+2R)', userId)) {
      position.stage = 'PARTIAL_2';
      position.stopLoss = side === 'long' ? entry + risk : entry - risk;
      await position.save();

      const orderManager = require('./orderManager');
      await orderManager.moveProtectiveStop(position.symbol, position.stopLoss);
    }
    return position;
  }

  // 4. Structural trail (only after TP2 has locked +1R in).
  if (position.stage === 'PARTIAL_2' || position.stage === 'RUNNER') {
    position.stage = 'RUNNER';
    if (trailStop(position, candles15m)) {
      await position.save();
      const orderManager = require('./orderManager');
      await orderManager.moveProtectiveStop(position.symbol, position.stopLoss);
    }
  }

  // 5. Structure failure — two consecutive closes back beyond BOS_LEVEL.
  const bosLevel = Number((position.plan && position.plan.bosLevel) || 0);
  const last2 = candles15m.slice(-2);
  if (bosLevel > 0 && last2.length === 2) {
    const failed = last2.every((c) => (side === 'long' ? Number(c.close) < bosLevel : Number(c.close) > bosLevel));
    if (failed) return exitPosition(position, mark, 'Structure failure', userId);
  }

  // 6. Stall — 8 candles going nowhere.
  if (bars >= STALL_CANDLES && mark > entry - STALL_BAND_R * risk && mark < entry + STALL_BAND_R * risk) {
    return exitPosition(position, mark, 'Stall exit', userId);
  }

  return position;
}

// ---------------------------------------------------------------------------
// Closing a position on purpose (POST /api/positions/:symbol/close)
// ---------------------------------------------------------------------------

// Closing sends a reduce-only order in the opposite direction. It goes through
// the order manager so it is risk-checked, persisted and reflected in the books.
// `positionId` closes one specific slot when a symbol holds several positions.
async function closePosition({ symbol, price, userId = null, positionId = null } = {}) {
  const position = positionId ? await Position.findById(positionId) : await getPositionBySymbol(symbol);
  if (!position || position.status !== 'open') {
    throw new AppError(`No open position found for ${normalizeSymbol(symbol)}`, 404);
  }

  // Required lazily: orderManager already requires this module.
  const orderManager = require('./orderManager');

  const closingSide = position.side === 'long' ? 'SELL' : 'BUY';

  const result = await orderManager.execute(
    {
      action: closingSide,
      symbol: position.symbol,
      quantity: position.quantity,
      price,
      orderType: 'market_order',
      strategyName: position.strategyName,
      reason: `Closing the ${position.side} position on ${position.symbol}`,
      meta: { positionId: String(position._id) },
    },
    { userId, reduceOnly: true, fetchReferencePrice: false }
  );

  if (!result.executed) {
    throw new AppError(result.reason, 400);
  }

  return result.position;
}

// ---------------------------------------------------------------------------
// Delta Exchange synchronisation (live mode only)
// ---------------------------------------------------------------------------

// Rebuilds the local open positions from Delta. Paper mode has nothing to sync.
async function syncPositions() {
  if (config.trading.mode !== 'live') {
    logger.debug('Position sync skipped — not in live mode');
    return getPositions({ status: 'open' });
  }

  const remotePositions = await positionService.getOpenPositions();

  for (const remote of remotePositions) {
    try {
      const product = await marketService.getProductById(remote.product_id);
      const symbol = normalizeSymbol(product.symbol);
      const size = Number(remote.size || 0);
      if (!symbol || size === 0) continue;

      const side = size > 0 ? 'long' : 'short';
      const entryPrice = Number(remote.entry_price || 0);

      await Position.findOneAndUpdate(
        { symbol, status: 'open' },
        {
          $set: {
            productId: Number(remote.product_id),
            side,
            quantity: Math.abs(size),
            entryPrice,
            currentPrice: entryPrice,
            mode: 'live',
            lastSyncedAt: new Date(),
          },
          $setOnInsert: { openedAt: new Date(), strategyName: 'delta' },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    } catch (error) {
      logger.warn(`Could not sync a Delta position: ${error.message}`);
    }
  }

  return getPositions({ status: 'open' });
}

// Applies a private WebSocket position update to the local book.
async function handlePositionUpdate(update = {}) {
  const symbol = normalizeSymbol(update.product_symbol || update.symbol);
  if (!symbol) return null;

  const size = Number(update.size || 0);
  const existing = await getPositionBySymbol(symbol);

  if (size === 0) {
    if (!existing) return null;

    existing.quantity = 0;
    existing.status = 'closed';
    existing.closedAt = new Date();
    existing.lastSyncedAt = new Date();
    await existing.save();

    logger.info(`Position closed from Delta update: ${symbol}`);
    return existing;
  }

  const side = size > 0 ? 'long' : 'short';
  const entryPrice = Number(update.entry_price || existing?.entryPrice || 0);

  if (!existing) {
    const created = await Position.create({
      symbol,
      productId: Number(update.product_id) || null,
      side,
      quantity: Math.abs(size),
      entryPrice,
      currentPrice: entryPrice,
      mode: 'live',
      strategyName: 'delta',
      lastSyncedAt: new Date(),
    });
    return created;
  }

  existing.side = side;
  existing.quantity = Math.abs(size);
  existing.entryPrice = entryPrice || existing.entryPrice;
  existing.lastSyncedAt = new Date();
  await existing.save();

  return existing;
}

module.exports = {
  getPositions,
  getPositionBySymbol,
  getOpenPositionsBySymbol,
  updatePositionPrice,
  applyOrder,
  manageOpenPosition,
  closePosition,
  syncPositions,
  handlePositionUpdate,
  calculatePnl,
};
