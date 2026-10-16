// Position data and position actions against Delta Exchange.
// Application-level position state lives in services/trading/positionManager.js.

const deltaClient = require('./deltaClient');
const deltaConfig = require('../../config/deltaConfig');
const orderService = require('./orderService');
const marketService = require('./marketService');
const { AppError } = require('../../utils/errorHandler');
const { normalizeSymbol } = require('../../utils/helpers');

const { extractResult } = deltaClient;

async function getPositions({ productId } = {}) {
  const params = productId ? { product_ids: productId } : undefined;

  const response = await deltaClient.get(deltaConfig.endpoints.positions, params);
  return extractResult(response, []);
}

// Only positions with a non-zero size are considered "open".
async function getOpenPositions({ productId } = {}) {
  const positions = await getPositions({ productId });
  if (!Array.isArray(positions)) return [];

  return positions.filter((position) => Math.abs(Number(position.size || 0)) > 0);
}

async function getPositionBySymbol(symbol) {
  const target = normalizeSymbol(symbol);
  const product = await marketService.getProduct(target);

  const positions = await getOpenPositions({ productId: product.id });
  return positions.find((position) => Number(position.product_id) === Number(product.id)) || null;
}

// Closing a position simply means sending a reduce-only market order in the
// opposite direction. That is why this service reuses the order service.
async function closePosition({ symbol, size }) {
  const target = normalizeSymbol(symbol);
  const position = await getPositionBySymbol(target);

  if (!position) {
    throw new AppError(`No open Delta position found for ${target}`, 404);
  }

  const positionSize = Math.abs(Number(position.size));
  const closeSize = size ? Math.abs(Number(size)) : positionSize;
  const side = Number(position.size) > 0 ? 'sell' : 'buy';

  return orderService.placeOrder({
    symbol: target,
    productId: position.product_id,
    size: closeSize,
    side,
    orderType: 'market_order',
    reduceOnly: true,
  });
}

module.exports = {
  getPositions,
  getOpenPositions,
  getPositionBySymbol,
  closePosition,
};
