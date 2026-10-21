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
const { atr } = require('../../utils/indicators');
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
// This reads the LOCAL book, which is only a record — use
// getExchangeOpenPositions() for anything that decides whether a trade may be
// placed.
async function getOpenPositionsBySymbol(symbol) {
  const target = normalizeSymbol(symbol);
  if (!target) return [];

  return Position.find({ symbol: target, status: 'open' }).sort({ createdAt: 1 });
}

// What Delta Exchange ACTUALLY holds for `symbol` right now.
//
// Every placement-time decision must ask the exchange, never the local book:
// a position opened or closed by hand (or by a bracket firing while the bot was
// down) leaves the database stale, and a stale book either blocks a legitimate
// entry or allows a duplicate one. Rows are shaped like local positions so the
// callers (concurrency gate, risk context, strategy state) stay unchanged.
//
// Paper mode has no exchange to ask, so the local book is the truth there.
async function getExchangeOpenPositions(symbol) {
  const target = normalizeSymbol(symbol);
  if (!target) return [];

  if (config.trading.mode !== 'live') {
    return getOpenPositionsBySymbol(target);
  }

  const product = await marketService.getProduct(target);
  const positions = await positionService.getOpenPositions({ productId: product.id });

  return positions
    .filter((position) => Number(position.product_id) === Number(product.id))
    .map((position) => {
      const size = Number(position.size || 0);
      return {
        symbol: target,
        productId: Number(position.product_id),
        side: size > 0 ? 'long' : 'short',
        quantity: Math.abs(size),
        entryPrice: Number(position.entry_price || 0),
        slot: 0,
        source: 'delta',
      };
    });
}

// True when Delta is holding a non-zero position for `symbol`.
async function hasExchangeOpenPosition(symbol) {
  const positions = await getExchangeOpenPositions(symbol);
  return positions.length > 0;
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

  // A position whose entry carried an attached bracket is already protected by
  // Delta — the fixed reduce-only stop and target were created by the entry call
  // itself (see orderManager.executeLiveOrder), so the manager must not place a
  // second set. Everything else (paper, or a signal with no bracket) still gets
  // the local bracket. Required lazily: orderManager already requires this module.
  if (!position.plan.bracketOnExchange) {
    try {
      const orderManager = require('./orderManager');
      await orderManager.placeProtectiveStop(position);
      await orderManager.placeProtectiveTarget(position);
    } catch (error) {
      logger.error('Could not place the protective bracket for the new position', error);
    }
  }

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
    // A reduce-only fill must never open a position. This happens when a
    // resting protective stop fills just after the position was closed another
    // way; there is nothing left to close, so ignore it.
    if (isExit) {
      logger.debug(`Ignored a reduce-only fill for ${symbol} — nothing open to close`);
      return null;
    }
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

  // The position no longer needs its resting bracket. If the leg that filled is
  // already "filled", this only removes whatever is left over from the other
  // leg or from a close made some other way.
  try {
    const orderManager = require('./orderManager');
    await orderManager.cancelProtectiveOrdersForPosition(position);
  } catch (error) {
    logger.warn(`Could not cancel the protective orders for ${symbol}: ${error.message}`);
  }

  // 4. If the order was larger than the position, the excess flips direction.
  const leftover = quantity - closingQuantity;
  if (leftover > 0) {
    return openPosition(order, leftover, price, symbol);
  }

  return position;
}

// ---------------------------------------------------------------------------
// Trade management (fixed bracket + time exit)
// ---------------------------------------------------------------------------
//
// Driven by the trading engine on every cycle while a position is open.
//
// The strategy rests a FIXED stop and a FIXED target on the exchange as
// reduce-only orders, so the bracket is the exit. This manager only mirrors the
// stop locally — a paper stop_market_order never auto-fills, so paper positions
// still need the hard stop checked here — and enforces the time stop that
// recycles the slot.

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
// (a strategy can hold several concurrent slots).
async function manageOpenPosition({ symbol, price, candles1m = [], candles15m = [], userId = null } = {}) {
  const positions = await getOpenPositionsBySymbol(symbol);
  if (!positions.length) return null;

  let last = null;
  for (const position of positions) {
    try {
      last = await manageSimplePosition(position, { price, candles1m, candles15m, userId });
    } catch (error) {
      logger.error(`Could not manage position ${position._id} on ${position.symbol}: ${error.message}`);
      last = position;
    }
  }
  return last;
}

// Advances an ATR trailing stop (and the breakeven move) for one position.
// Only positions whose plan asks for a trail (plan.trailAtrMult > 0) are
// touched. Mirrors the backtest: the trail is anchored to the previous candle's
// close, breakeven is armed once the trade is plan.beAtR x risk in profit, and
// the stop only ever moves in the position's favour.
async function trailStop(position, candles) {
  const plan = position.plan || {};
  const trailAtrMult = Number(plan.trailAtrMult) || 0;
  if (!(trailAtrMult > 0)) return position;

  const entry = Number(position.entryPrice);
  const atrValue = atr(candles, Number(plan.atrPeriod) || 14).pop();
  if (!(entry > 0) || !(atrValue > 0)) return position;

  const dir = position.side === 'long' ? 1 : -1;
  const risk = Math.abs(entry - Number(position.initialStopLoss ?? position.stopLoss));
  const currentStop = Number(position.stopLoss);

  // Anchor the trail to the previous closed candle (the current one is still forming).
  const anchor = candles.length >= 2 ? Number(candles[candles.length - 2].close) : entry;
  let peak = Number(plan.peak);
  if (!Number.isFinite(peak)) peak = entry;
  peak = dir === 1 ? Math.max(peak, anchor) : Math.min(peak, anchor);

  const candidates = [];
  if (Number.isFinite(currentStop)) candidates.push(currentStop);
  if (Number(plan.beAtR) > 0 && risk > 0 && (peak - entry) * dir >= Number(plan.beAtR) * risk) {
    candidates.push(entry); // breakeven
  }
  candidates.push(peak - dir * trailAtrMult * atrValue);
  const nextStop = dir === 1 ? Math.max(...candidates) : Math.min(...candidates);

  position.plan = { ...plan, peak };
  position.markModified('plan');

  const improved = Number.isFinite(nextStop) && (!Number.isFinite(currentStop) || (dir === 1 ? nextStop > currentStop : nextStop < currentStop));
  if (improved) {
    position.stopLoss = nextStop;
    // Keep the resting exchange stop in sync (paper: the order document; live:
    // cancel + re-place, because Delta has no modify endpoint).
    try {
      const orderManager = require('./orderManager');
      await orderManager.moveProtectiveStop(position.symbol, nextStop);
    } catch (error) {
      logger.warn(`Could not move the protective stop for ${position.symbol}: ${error.message}`);
    }
  }

  await position.save();
  return position;
}

// Simple exit machine: a hard stop, an optional ATR trailing stop and a time
// exit.
//
// The fixed target is NOT checked here: it rests on the exchange as a reduce-only
// take_profit_order (filled by Delta in live mode, by orderManager.handlePaperTick
// in paper mode), so each leg has exactly one exit path and there is no
// double-close race between the local loop and the resting order.
async function manageSimplePosition(position, { price, candles1m = [], candles15m = [], userId }) {
  const entry = Number(position.entryPrice);
  const mark = Number(price);
  if (!mark || !entry) return position;

  // A position whose bracket lives on Delta (the entry carried an attached
  // fixed stop + target) is exit-managed by the exchange. Running the local
  // loop as well would put a second, competing exit on the same position: the
  // local hard stop can fire on the same tick as Delta's stop and close twice.
  if (position.plan && position.plan.bracketOnExchange) return position;

  const side = position.side;

  // 0. Advance the trailing stop before the stop is tested, so a stop that was
  //    just trailed into the money can exit on this very tick.
  const plan = position.plan || {};
  if (Number(plan.trailAtrMult) > 0) {
    const candles = plan.atrTimeframe === '15m' ? candles15m : candles1m;
    await trailStop(position, candles);
  }

  const stop = Number(position.stopLoss);

  // 1. Hard stop (taker / market exit).
  if (Number.isFinite(stop) && (side === 'long' ? mark <= stop : mark >= stop)) {
    return exitPosition(position, mark, `Stop loss at ${stop}`, userId);
  }

  // 2. Time exit — the backtest's hard time stop (e.g. 32 x 15m = 8h). It frees
  // the slot so the strategy can take its next setup within the same day.
  const timeExitBars = Number((position.plan && position.plan.timeExitBars) || 0);
  if (timeExitBars > 0) {
    const bars = Math.max(0, Math.floor((Date.now() - new Date(position.openedAt).getTime()) / (15 * 60 * 1000)));
    if (bars >= timeExitBars) {
      return exitPosition(position, mark, `Time exit after ${bars} bars`, userId);
    }
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
  const heldOnDelta = new Set();

  for (const remote of remotePositions) {
    try {
      const product = await marketService.getProductById(remote.product_id);
      const symbol = normalizeSymbol(product.symbol);
      const size = Number(remote.size || 0);
      if (!symbol || size === 0) continue;

      heldOnDelta.add(symbol);
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

  // Delta is the source of truth. A position still marked open locally but gone
  // from Delta was closed outside this process — by hand, or by a bracket that
  // fired while the bot was down. It has to be cleared, otherwise the strategy
  // stands down forever waiting for a position that no longer exists.
  const ghosts = await Position.find({
    status: 'open',
    mode: 'live',
    symbol: { $nin: [...heldOnDelta] },
  });

  for (const ghost of ghosts) {
    ghost.quantity = 0;
    ghost.status = 'closed';
    ghost.closedAt = new Date();
    ghost.lastSyncedAt = new Date();
    await ghost.save();

    logger.warn(
      `Cleared a local position Delta no longer holds: ${ghost.symbol} ${ghost.side} — ` +
        'it was closed outside the bot, so no PnL was booked for it'
    );
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
  getExchangeOpenPositions,
  hasExchangeOpenPosition,
  updatePositionPrice,
  applyOrder,
  manageOpenPosition,
  closePosition,
  syncPositions,
  handlePositionUpdate,
  calculatePnl,
};
