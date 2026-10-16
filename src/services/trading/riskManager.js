// Every trade must pass through here before an order is sent anywhere.
// The manager is intentionally "pure": it does not touch the database or the
// network. The caller (orderManager) passes in the numbers it needs, which also
// makes this file very easy to unit test.

const config = require('../../config/env');
const logger = require('../../utils/logger');
const { isValidSignal } = require('../../utils/helpers');

function allow(reason = 'All risk checks passed') {
  return { allowed: true, reason };
}

function reject(reason) {
  return { allowed: false, reason };
}

// context = {
//   positionQuantity,   how much is already open for this symbol
//   openTradesCount,    how many orders are currently open
//   dailyPnl,           realised profit/loss for today (negative = loss)
//   recentOrders,       recent orders used for duplicate detection
//   referencePrice      current market price, used for the deviation check
// }
async function validate(signal, context = {}) {
  const settings = config.risk;

  // 1. Global kill switch
  if (!settings.tradingEnabled) {
    return reject('Trading is disabled (RISK_TRADING_ENABLED=false)');
  }

  // 2. The signal itself must be valid
  const signalCheck = isValidSignal(signal);
  if (!signalCheck.valid) {
    return reject(signalCheck.reason);
  }

  // 3. Live mode safety: never allow real orders unless it was switched on
  if (config.trading.mode === 'live' && !config.trading.liveTradingEnabled) {
    return reject(
      'Live trading is switched off. Set ENABLE_LIVE_TRADING=true (and be sure) before sending real orders.'
    );
  }

  const quantity = Number(signal.quantity);

  // 4. Maximum size of a single order
  if (quantity > settings.maxOrderQuantity) {
    return reject(
      `Order quantity ${quantity} is above the maximum allowed (${settings.maxOrderQuantity})`
    );
  }

  // 5. Maximum total position size for the symbol
  const positionQuantity = Math.abs(Number(context.positionQuantity || 0));
  const projectedSize = positionQuantity + quantity;
  if (projectedSize > settings.maxPositionSize) {
    return reject(
      `Position size ${projectedSize} would exceed the maximum allowed (${settings.maxPositionSize})`
    );
  }

  // 6. Maximum daily loss
  const dailyPnl = Number(context.dailyPnl || 0);
  if (dailyPnl <= -Math.abs(settings.maxDailyLoss)) {
    return reject(`Daily loss limit reached (${dailyPnl}). Trading is halted for today.`);
  }

  // 7. Maximum number of open trades
  const openTradesCount = Number(context.openTradesCount || 0);
  if (openTradesCount >= settings.maxOpenTrades) {
    return reject(`Maximum number of open trades reached (${settings.maxOpenTrades})`);
  }

  // 8. Duplicate order protection (same symbol + side in a short window)
  const duplicate = findDuplicate(signal, context.recentOrders || []);
  if (duplicate) {
    return reject(
      `Duplicate order blocked: a ${duplicate.side.toUpperCase()} order for ${duplicate.symbol} was already placed moments ago`
    );
  }

  // 9. Price deviation — protects against stale or fat-fingered prices
  const referencePrice = Number(context.referencePrice || 0);
  if (signal.price && referencePrice > 0) {
    const deviation = Math.abs(signal.price - referencePrice) / referencePrice * 100;
    if (deviation > settings.maxPriceDeviationPercent) {
      return reject(
        `Order price ${signal.price} deviates ${deviation.toFixed(2)}% from the market price ${referencePrice} (max ${settings.maxPriceDeviationPercent}%)`
      );
    }
  }

  logger.debug(`Risk checks passed for ${signal.action} ${signal.symbol}`);
  return allow();
}

function findDuplicate(signal, recentOrders) {
  const windowMs = Number(config.risk.duplicateWindowSeconds) * 1000;
  const side = signal.action.toLowerCase();
  const cutoff = Date.now() - windowMs;

  return recentOrders.find((order) => {
    const createdAt = new Date(order.createdAt).getTime();
    return (
      order.symbol === signal.symbol &&
      order.side === side &&
      createdAt >= cutoff
    );
  });
}

// Exposed so callers/tests can inspect the active settings.
function getSettings() {
  return { ...config.risk };
}

module.exports = {
  validate,
  getSettings,
};
