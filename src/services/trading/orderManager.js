// Application level order logic.
// It decides WHAT should happen with a signal (risk check, paper vs live,
// duplicate protection) while services/delta/orderService.js only knows HOW to
// talk to Delta Exchange.

const config = require('../../config/env');
const Order = require('../../models/Order');
const Trade = require('../../models/Trade');
const riskManager = require('./riskManager');
const positionManager = require('./positionManager');
const orderService = require('../delta/orderService');
const positionService = require('../delta/positionService');
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

// Delta answering "there is no such open order" to a cancel: the order left the
// book behind our back (it filled, or it was cancelled somewhere else). The
// local row is then stale and MUST be settled — an entry row left at "open"
// counts against RISK_MAX_OPEN_TRADES for ever and blocks every later entry
// with "Maximum number of open trades reached".
const VANISHED_ORDER_PATTERNS = [/open_order_not_found/i, /order_not_found/i, /order not found/i];

function isVanishedOrderError(error) {
  const message = String((error && error.message) || error || '');
  return VANISHED_ORDER_PATTERNS.some((pattern) => pattern.test(message));
}

// A LIMIT entry that declares an exchange bracket (meta.exitMode === 'bracket')
// must carry BOTH a fixed stop and a fixed target: Delta only rests the bracket
// when the same order call supplies both prices, so a missing leg would leave an
// unprotected resting order on the book. Refuse it instead of sending it.
// Market entries and trailing exits (meta.exitMode === 'trail') are unaffected.
function checkBracketCompleteness(signal) {
  const meta = signal.meta && typeof signal.meta === 'object' ? signal.meta : {};
  if (meta.exitMode !== 'bracket' || !isRestingOrderType(signal.orderType)) {
    return { ok: true };
  }

  const stop = Number(signal.stopLoss);
  const tp = Array.isArray(signal.takeProfit) ? signal.takeProfit[0] : null;
  const target = tp ? Number(tp.price) : NaN;

  if (!(Number.isFinite(stop) && stop > 0) || !(Number.isFinite(target) && target > 0)) {
    return {
      ok: false,
      reason:
        `A limit bracket entry needs both a stop and a target (stop=${signal.stopLoss}, ` +
        `target=${tp && tp.price})`,
    };
  }
  return { ok: true };
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

// The validity window for one specific resting order. A strategy can pin a
// shorter one per order via meta.entryValidityMs — a grid leg must die with the
// candle it belongs to, not hang around for the global 60m — otherwise the
// global STRATEGY_ENTRY_VALIDITY_MINUTES applies.
function resolveEntryValidityMs(signal) {
  const override = Number(signal.meta && signal.meta.entryValidityMs);
  if (Number.isFinite(override) && override > 0) return override;
  return entryValidityMs();
}

// The bracket / trade plan that must travel with the entry. When the bracket is
// attached on the exchange (see executeLiveOrder) the flag rides along in meta so
// the position manager knows Delta already owns the exit.
function buildBracket(signal, options = {}) {
  const takeProfit = Array.isArray(signal.takeProfit) ? signal.takeProfit : [];
  const meta = signal.meta && typeof signal.meta === 'object' ? { ...signal.meta } : {};
  if (options.bracketOnExchange) meta.bracketOnExchange = true;

  return {
    stopLoss: signal.stopLoss ?? null,
    takeProfit,
    meta,
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

  // Fail fast when live trading is switched off: there is no way the order can
  // be placed, so there is no point asking the exchange for a position snapshot
  // (the concurrency gate below does) before refusing it.
  if (mode === 'live' && !config.trading.liveTradingEnabled) {
    const reason =
      'Live trading is switched off. Set ENABLE_LIVE_TRADING=true (and be sure) before sending real orders.';
    logger.warn(`Order blocked: ${reason}`);
    return { executed: false, reason, signal };
  }

  assertNotDuplicateInFlight(signal.clientOrderId);
  ordersInFlight.add(signal.clientOrderId);

  try {
    const existing = await Order.findOne({ clientOrderId: signal.clientOrderId });
    if (existing) {
      throw new AppError('Duplicate order blocked: this order was already submitted', 409);
    }

    // A bracket-mode limit entry must never rest unprotected on the book.
    const bracketCheck = checkBracketCompleteness(signal);
    if (!bracketCheck.ok) {
      logger.warn(`Order blocked: ${bracketCheck.reason}`);
      return { executed: false, reason: bracketCheck.reason, signal };
    }

    // Concurrency gate. A strategy may hold up to `maxConcurrentPositions`
    // positions at once; each new entry is assigned the lowest free slot so the
    // trade manager can keep the slots independent. Reduce-only exits are exempt.
    if (!options.reduceOnly) {
      const gate = await concurrencyGate(signal.symbol, {
        // A strategy may ask for every instrument to run its own position at the
        // same time instead of sharing one slot across the whole list.
        independentSlots: Boolean(signal.meta && signal.meta.independentSlots),
        // A grid declares how many entry legs may rest at once (see the gate).
        maxWorkingEntries: signal.meta && signal.meta.maxWorkingEntries,
      });
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
    // A grid leg just filled — take the rest of its ladder off the book.
    await cancelGridSiblings(order);
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
// This reads the LOCAL book, which is only a record — use
// findExchangeLiveEntries() for placement-time decisions.
async function findLiveEntries(symbol) {
  const target = normalizeSymbol(symbol);
  if (!target) return [];

  return Order.find({
    symbol: target,
    status: { $in: OPEN_ORDER_STATUSES },
    reduceOnly: { $ne: true },
  }).sort({ createdAt: -1 });
}

// Working ENTRY orders that Delta Exchange itself reports for `symbol`.
//
// The attached bracket rests protective legs on Delta as separate reduce-only
// orders, so they have to be filtered out — otherwise the bot would think an
// entry is still working and refuse to trade. Only genuine entries count.
function isExchangeEntryOrder(order) {
  if (order.reduce_only) return false;

  const stopType = String(order.stop_order_type || '').toLowerCase();
  return stopType !== 'stop_loss_order' && stopType !== 'take_profit_order';
}

async function findExchangeLiveEntries(symbol) {
  const target = normalizeSymbol(symbol);
  if (!target) return [];
  if (config.trading.mode !== 'live') return findLiveEntries(target);

  const product = await marketService.getProduct(target);
  const orders = await orderService.getOpenOrders({ productId: product.id });

  return (Array.isArray(orders) ? orders : [])
    .filter((order) => Number(order.product_id) === Number(product.id))
    .filter(isExchangeEntryOrder)
    .map((order) => ({
      symbol: target,
      side: String(order.side || '').toLowerCase(),
      quantity: Math.abs(Number(order.unfilled_size ?? order.size ?? 0)),
      // The resting price. A grid strategy matches its legs against this to know
      // which levels are already working, so it never sends the same leg twice.
      price: Number(order.limit_price ?? order.stop_price ?? 0),
      slot: 0,
      source: 'delta',
    }));
}

// One live snapshot of what is actually working for `symbol` on Delta: the open
// position(s) and any resting entry order(s). Everything that gates a new order
// reads this, so the database can never disagree with the exchange about
// whether a trade is already on.
async function getExchangeSnapshot(symbol) {
  const target = normalizeSymbol(symbol);

  const [positions, liveEntries] = await Promise.all([
    positionManager.getExchangeOpenPositions(target),
    findExchangeLiveEntries(target),
  ]);

  return {
    positions,
    liveEntries,
    source: config.trading.mode === 'live' ? 'delta' : 'local',
  };
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

    // A grid leg just filled — take the rest of its ladder off the book.
    await cancelGridSiblings(order);

    filled += 1;
  }

  return filled;
}

// Settles a live order Delta no longer has on its book (see
// isVanishedOrderError). Delta is asked for the final state so the log can say
// what really happened; when Delta cannot answer, the row is closed locally as
// "cancelled". Either way the row stops counting as a working entry.
//
// The fill is deliberately NOT pushed into the position book here: this is a
// stale-row cleanup that can run long after the fact, and the position it once
// belonged to is usually already gone — replaying the fill would invent an open
// position the exchange does not hold. Positions are read straight from Delta
// for every placement-time decision, and positionManager.syncPositions()
// reconciles the local book at startup.
async function resolveVanishedOrder(order) {
  try {
    const remote = await orderService.getOrder(order.deltaOrderId);
    if (remote && remote.state) {
      order.deltaStatus = remote.state;
      order.status = mapDeltaOrderStatus(remote.state);
      const averagePrice = Number(remote.average_fill_price || 0);
      if (averagePrice > 0) order.averagePrice = averagePrice;
    }
  } catch (error) {
    logger.warn(
      `Could not read the vanished order ${order.deltaOrderId} from Delta: ${error.message}`
    );
  }

  // Still reading as working after all that -> the exchange does not have it, so
  // it is gone from the book.
  if (OPEN_ORDER_STATUSES.includes(order.status)) order.status = 'cancelled';
  if (order.status === 'filled' && !order.filledAt) order.filledAt = new Date();

  await order.save();

  if (order.status === 'filled') {
    logger.warn(
      `Stale order ${order._id} (${order.symbol}, delta id ${order.deltaOrderId}) had in fact ` +
        `FILLED and was left "open" locally — settled as filled. Positions and PnL are taken ` +
        'from Delta, so the books were never wrong about the exposure.'
    );
  } else {
    logger.info(
      `Stale order ${order._id} (${order.symbol}, delta id ${order.deltaOrderId}) settled as ` +
        `"${order.status}" — Delta no longer has it open`
    );
  }

  return order;
}

// Cancels resting orders whose validity window has passed (the 4-candle rule).
// Returns how many orders were cancelled. Called without a symbol to sweep the
// whole local book, which is what keeps a leftover order on an instrument no
// longer tracked from eating a slot of RISK_MAX_OPEN_TRADES.
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
        // Delta does not have it open any more — settle the local row instead of
        // leaving it "open" for ever (see resolveVanishedOrder).
        if (isVanishedOrderError(error)) {
          await resolveVanishedOrder(order);
          cancelled += 1;
          continue;
        }
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

// A grid rests several sibling entry legs for ONE bar — they all carry the same
// meta.gridGroup. The moment one of them fills it has done its job: the grid is
// meant to produce exactly ONE trade per bar, so every other leg of the group is
// taken off the book here. Orders with no meta.gridGroup (every non-grid order,
// including the reduce-only protective legs) are never touched.
//
// Mirrors cancelExpiredOrders: a leg Delta no longer has is settled through
// resolveVanishedOrder rather than being left "open" and counted as a working
// entry for ever.
async function cancelGridSiblings(order) {
  const group = order && order.meta ? order.meta.gridGroup : null;
  if (!group) return 0;

  const siblings = await Order.find({
    _id: { $ne: order._id },
    'meta.gridGroup': group,
    status: { $in: OPEN_ORDER_STATUSES },
  });

  let cancelled = 0;
  for (const sibling of siblings) {
    if (sibling.mode === 'live' && sibling.deltaOrderId) {
      if (!config.trading.isLive) {
        logger.warn(`Grid leg ${sibling._id} was not cancelled — live trading is disabled`);
        continue;
      }
      try {
        await orderService.cancelOrder({ orderId: sibling.deltaOrderId, productId: sibling.productId });
      } catch (error) {
        if (isVanishedOrderError(error)) {
          await resolveVanishedOrder(sibling);
          cancelled += 1;
          continue;
        }
        logger.warn(`Could not cancel the grid leg ${sibling._id}: ${error.message}`);
        continue;
      }
    }

    sibling.status = 'cancelled';
    await sibling.save();
    cancelled += 1;
  }

  if (cancelled) {
    logger.info(`Grid ${group}: ${cancelled} sibling leg(s) cancelled after the ${order.side} fill`);
  }
  return cancelled;
}

// Resting protective orders for an open position: the stop and the take-profit.
//
// Both are reduce-only orders sitting on the OPPOSITE side of the position and
// both rest on Delta, so the whole bracket survives this process dying. The stop
// is a stop_market_order, the target a take_profit_order; moveProtectiveStop
// keeps the stop in sync with any trailed level.
//
// They are deliberately NOT run through execute(): they are not new entries, so
// they must skip the risk checks, the concurrency gate and the duplicate guard.
const PROTECTIVE_KINDS = {
  stop: {
    purpose: 'stop',
    orderType: 'stop_market_order',
    price: (position) => Number(position.initialStopLoss ?? position.stopLoss),
    storesStopLoss: true,
    reason: 'Protective stop for the open position',
  },
  target: {
    purpose: 'target',
    orderType: 'take_profit_order',
    price: (position) =>
      Array.isArray(position.takeProfit) && position.takeProfit.length
        ? Number(position.takeProfit[0].price)
        : null,
    storesStopLoss: false,
    reason: 'Protective take-profit for the open position',
  },
};

async function placeProtectiveOrder(position, kind) {
  if (!position) return null;

  const spec = PROTECTIVE_KINDS[kind];
  if (!spec) return null;

  const symbol = normalizeSymbol(position.symbol);
  const triggerPrice = spec.price(position);
  const quantity = Math.abs(Number(position.quantity));
  if (!symbol || !Number.isFinite(triggerPrice) || triggerPrice <= 0 || !quantity) return null;

  // A protective order always sits on the opposite side of the position.
  const side = position.side === 'long' ? 'sell' : 'buy';
  const positionId = String(position._id);
  const isLive = position.mode === 'live';

  // Never stack a second order of the same kind for the same position.
  const existing = await Order.findOne({
    symbol,
    purpose: spec.purpose,
    status: { $in: OPEN_ORDER_STATUSES },
    'meta.positionId': positionId,
  });
  if (existing) return existing;

  // Live orders need the product id and a tick-aligned trigger price.
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
    orderType: spec.orderType,
    quantity,
    price: triggerPrice,
    status: isLive ? 'pending' : 'open',
    mode: position.mode,
    purpose: spec.purpose,
    reduceOnly: true,
    stopLoss: spec.storesStopLoss ? triggerPrice : null,
    // Links the order back to the slot it protects so a fill closes the right
    // position (see positionManager.applyOrder).
    meta: { positionId },
    strategyName: position.strategyName || 'manual',
    reason: spec.reason,
  });

  if (!isLive) {
    logger.info(`Paper protective ${kind} resting at ${triggerPrice} for ${symbol}`);
    return order;
  }

  if (!config.trading.isLive) {
    logger.warn(`Protective ${kind} for ${symbol} was not placed — live trading is disabled`);
    return order;
  }

  try {
    const response = await orderService.placeOrder({
      symbol,
      productId,
      size: quantity,
      side,
      orderType: spec.orderType,
      stopPrice: roundToTick(triggerPrice, tickSize),
      reduceOnly: true,
      clientOrderId,
    });

    order.deltaOrderId = String(response.id ?? response.order_id ?? '');
    order.deltaStatus = response.state || null;
    order.status = mapDeltaOrderStatus(response.state);
    await order.save();

    logger.info(`Protective ${kind} placed for ${symbol} at ${triggerPrice} (delta id ${order.deltaOrderId})`);
  } catch (error) {
    order.status = 'rejected';
    order.errorMessage = error.message;
    await order.save();
    logger.error(`Could not place the protective ${kind} for ${symbol}: ${error.message}`);
  }

  return order;
}

// A reduce-only stop_market_order resting just beyond the invalidation level.
async function placeProtectiveStop(position) {
  return placeProtectiveOrder(position, 'stop');
}

// A reduce-only take_profit_order resting at the position's fixed target.
async function placeProtectiveTarget(position) {
  return placeProtectiveOrder(position, 'target');
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

// Cancels the resting protective orders (both the stop and the take-profit)
// that belong to a position. Called when the position is closed by something
// other than the bracket itself, so nothing is left resting on the exchange.
async function cancelProtectiveOrdersForPosition(position) {
  if (!position) return 0;

  const orders = await Order.find({
    symbol: normalizeSymbol(position.symbol),
    purpose: { $in: ['stop', 'target'] },
    status: { $in: OPEN_ORDER_STATUSES },
    'meta.positionId': String(position._id),
  });

  let cancelled = 0;
  for (const order of orders) {
    if (order.mode === 'live' && order.deltaOrderId) {
      if (!config.trading.isLive) {
        logger.warn(
          `Protective ${order.purpose} for ${position.symbol} was not cancelled — live trading is disabled`
        );
        continue;
      }
      try {
        await orderService.cancelOrder({ orderId: order.deltaOrderId, productId: order.productId });
      } catch (error) {
        // Same stale-row trap as the expiry sweep: a "vanished" protective leg
        // left at "open" would block the next stop/target of the same kind from
        // ever being placed (see placeProtectiveOrder).
        if (isVanishedOrderError(error)) {
          await resolveVanishedOrder(order);
          cancelled += 1;
          continue;
        }
        logger.warn(`Could not cancel the protective ${order.purpose} ${order._id}: ${error.message}`);
        continue;
      }
    }

    order.status = 'cancelled';
    await order.save();
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
//
// The counts come from Delta (see getExchangeSnapshot), not from the database,
// so a trade closed by hand can never leave the gate permanently shut.
//
// By default, when several instruments are tracked (TRADING_SYMBOLS) they share
// ONE position slot: a position or a working entry on ANY of them claims it, so
// the free-slot count is taken over the whole list. That is what makes the
// portfolio take whichever instrument gets a signal first — and nothing else.
//
// A strategy can opt out of the shared pool with `meta.independentSlots`: each
// instrument then counts only its own positions and working entries, so several
// of them can hold a position at the same time (each still capped at
// maxConcurrentPositions).
//
// A GRID strategy additionally declares `meta.maxWorkingEntries`: it rests a
// whole LADDER of entry legs at once (e.g. a buy and a sell limit on two price
// levels), so its legs are counted against their own budget instead of the
// position slots — otherwise the second leg would be refused and the ladder
// could never rest. Only ONE leg ever fills, so the ladder still opens at most
// maxConcurrentPositions positions.
async function concurrencyGate(symbol, options = {}) {
  const target = normalizeSymbol(symbol);
  const maxConcurrent = Math.max(1, Number(config.strategy.maxConcurrentPositions) || 1);
  const ladder =
    Number(options.maxWorkingEntries) > 0 ? Math.floor(Number(options.maxWorkingEntries)) : null;

  const independent = options.independentSlots === true;
  const tracked =
    !independent && Array.isArray(config.trading.symbols) && config.trading.symbols.length > 1
      ? config.trading.symbols
      : [target];

  const snapshots = await Promise.all(tracked.map((item) => getExchangeSnapshot(item)));

  const used = new Set();
  snapshots.forEach(({ positions, liveEntries }) => {
    positions.forEach((position) => used.add(Number(position.slot) || 0));
    liveEntries.forEach((order) => used.add(Number(order.slot) || 0));
  });

  if (ladder !== null) {
    const positionCount = snapshots.reduce((total, snap) => total + snap.positions.length, 0);
    const entryCount = snapshots.reduce((total, snap) => total + snap.liveEntries.length, 0);

    if (positionCount >= maxConcurrent) {
      return {
        allowed: false,
        slot: null,
        reason: `${maxConcurrent} concurrent positions are already working for ${tracked.join('/')}`,
      };
    }
    if (entryCount >= ladder) {
      return {
        allowed: false,
        slot: null,
        reason: `the ${ladder}-leg grid is already resting for ${target} — one trade per bar`,
      };
    }
  } else if (used.size >= maxConcurrent) {
    return {
      allowed: false,
      slot: null,
      reason: `${maxConcurrent} concurrent positions are already working for ${tracked.join('/')}`,
    };
  }

  let slot = 0;
  while (used.has(slot)) slot += 1;
  return { allowed: true, slot };
}

// How many trades are really live right now, for the max-open-trades cap.
//
// LIVE: the count is read from Delta — the open positions the account actually
// holds plus the entry orders genuinely working on the book — never from the
// local Order rows. A stale local row (an entry that filled on Delta but was
// never settled here) used to stay "open" for ever and permanently eat the
// RISK_MAX_OPEN_TRADES budget, so every later entry was refused with
// "Maximum number of open trades reached". Delta is the source of truth.
//
// PAPER: there is no exchange to ask, so the local book is the truth there.
//
// A grid's resting legs are ONE trade, not one per leg: the legs of a bar all
// share meta.gridGroup, so each GROUP counts once and only non-grid entries
// count on their own. Otherwise a 4-leg ladder would blow a RISK_MAX_OPEN_TRADES
// of 2 before a single leg had filled.
async function countOpenTrades() {
  if (config.trading.mode !== 'live') {
    // Paper has no exchange to ask, so the local book is the truth. Group the
    // grid legs exactly like the live path so a paper ladder is one trade too.
    const openEntries = await Order.find({
      status: { $in: OPEN_ORDER_STATUSES },
      reduceOnly: { $ne: true },
    })
      .select('meta.gridGroup')
      .lean();

    const groups = new Set();
    let solo = 0;
    openEntries.forEach((row) => {
      const group = row.meta && row.meta.gridGroup;
      if (group) groups.add(group);
      else solo += 1;
    });
    return solo + groups.size;
  }

  const [positions, orders] = await Promise.all([
    positionService.getOpenPositions(),
    orderService.getOpenOrders(),
  ]);

  const openPositions = Array.isArray(positions) ? positions.length : 0;
  // Protective legs are reduce-only and must not eat into the budget.
  const workingEntries = (Array.isArray(orders) ? orders : []).filter(isExchangeEntryOrder);
  const gridGroups = await gridGroupsOf(workingEntries);

  // `gridGroups` maps each working entry's client_order_id to its grid group, so
  // an entry that belongs to a grid is recognised by its ID — not by its group
  // VALUE. Everything else is a plain, single-trade entry.
  const soloEntries = workingEntries.filter(
    (entry) => !gridGroups.has(entry.client_order_id)
  ).length;

  // Each bar of a grid is ONE trade however many legs it rests, so the distinct
  // groups count once each.
  const distinctGroups = new Set(gridGroups.values()).size;

  return openPositions + soloEntries + distinctGroups;
}

// Maps each working entry's client_order_id to the grid group it belongs to (if
// any). Delta does not echo our meta, so the group is recovered through the
// client_order_id we submitted: the local Order row for that id carries
// meta.gridGroup. Returning a map (not just the group values) is what lets the
// caller tell a grid leg apart from a solo entry.
async function gridGroupsOf(entries) {
  const ids = entries.map((entry) => entry.client_order_id).filter(Boolean);
  if (!ids.length) return new Map();

  const rows = await Order.find({ clientOrderId: { $in: ids } })
    .select('clientOrderId meta.gridGroup')
    .lean();

  const byClientOrderId = new Map();
  rows.forEach((row) => {
    const group = row.meta && row.meta.gridGroup;
    if (group) byClientOrderId.set(row.clientOrderId, group);
  });
  return byClientOrderId;
}

// Collects the numbers the risk manager needs.
async function buildRiskContext(signal, options) {
  const [openTradesCount, recentOrders, positions, tradesToday] = await Promise.all([
    countOpenTrades(),
    Order.find({ createdAt: { $gte: new Date(Date.now() - DUPLICATE_LOOKBACK_MS) } })
      .sort({ createdAt: -1 })
      .limit(25)
      .lean(),
    // Exposure is read from Delta, not the local book: the position-size check
    // must reflect what the exchange is really holding.
    positionManager.getExchangeOpenPositions(signal.symbol),
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
    // A strategy can opt out of the daily-loss cap by declaring
    // `haltOnDailyLoss: false` in the signal meta. Anything else (undefined)
    // keeps the cap in force, so this is opt-out only.
    haltOnDailyLoss: signal.meta ? signal.meta.haltOnDailyLoss : undefined,
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
      expiresAt: new Date(Date.now() + resolveEntryValidityMs(signal)),
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
  const resting = isRestingOrderType(signal.orderType);

  // Delta refuses any limit price that is not a whole multiple of the
  // product's tick size (BTCUSD = 0.5). Snap it here or every live limit
  // entry/exit comes back "invalid price".
  const tickSize = product.tick_size ?? product.tickSize ?? null;
  const limitPrice = roundToTick(signal.price, tickSize);

  // An entry that carries both a stop and a target is sent as one ATTACHED
  // BRACKET: Delta creates the position and rests the fixed reduce-only SL/TP
  // in the same call. Nothing is left unprotected, and the position manager
  // never has to place, trail or cancel anything.
  const stopPrice = Number(signal.stopLoss);
  const targetPrice =
    Array.isArray(signal.takeProfit) && signal.takeProfit.length
      ? Number(signal.takeProfit[0].price)
      : NaN;
  const bracketOnExchange =
    !options.reduceOnly &&
    Number.isFinite(stopPrice) &&
    stopPrice > 0 &&
    Number.isFinite(targetPrice) &&
    targetPrice > 0;

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
    ...buildBracket(signal, { ...options, bracketOnExchange }),
    strategyName: signal.strategyName,
    reason: signal.reason,
    expiresAt: resting ? new Date(Date.now() + resolveEntryValidityMs(signal)) : null,
  });

  try {
    const response = await orderService.placeOrder({
      symbol: signal.symbol,
      productId: product.id,
      size: signal.quantity,
      side,
      orderType: signal.orderType,
      limitPrice,
      reduceOnly: Boolean(options.reduceOnly),
      clientOrderId: order.clientOrderId,
      bracketStopLossPrice: bracketOnExchange ? roundToTick(stopPrice, tickSize) : undefined,
      bracketTakeProfitPrice: bracketOnExchange ? roundToTick(targetPrice, tickSize) : undefined,
    });

    order.deltaOrderId = String(response.id ?? response.order_id ?? '');
    order.deltaStatus = response.state || null;
    order.status = mapDeltaOrderStatus(response.state);
    order.averagePrice = Number(response.average_fill_price || 0);
    order.price = Number(response.limit_price || limitPrice || 0);
    order.filledAt = order.status === 'filled' ? new Date() : null;
    await order.save();

    logger.info(
      `Live order submitted: ${order.side} ${order.quantity} ${order.symbol} ` +
        `${order.orderType}${limitPrice ? ` @ ${limitPrice}` : ''}` +
        `${bracketOnExchange ? ` with on-exchange bracket stop ${roundToTick(stopPrice, tickSize)} / TP ${roundToTick(targetPrice, tickSize)}` : ''} ` +
        `(delta id ${order.deltaOrderId})`
    );

    if (order.status === 'filled') {
      await positionManager.applyOrder(order);
      // A grid leg that filled the instant it was sent also clears its ladder.
      await cancelGridSiblings(order);
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
  findExchangeLiveEntries,
  getExchangeSnapshot,
  handlePaperTick,
  cancelExpiredOrders,
  cancelGridSiblings,
  placeProtectiveStop,
  placeProtectiveTarget,
  moveProtectiveStop,
  cancelProtectiveOrdersForPosition,
};
