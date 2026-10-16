// HTTP layer for market data. All Delta API work happens inside
// services/delta/marketService.js — controllers stay thin.

const marketService = require('../services/delta/marketService');
const { AppError } = require('../utils/errorHandler');
const { sendSuccess, normalizeSymbol } = require('../utils/helpers');

// GET /api/market/ticker?symbol=BTCUSD
async function getTicker(req, res, next) {
  try {
    const symbol = normalizeSymbol(req.query.symbol);
    if (!symbol) throw new AppError('A "symbol" query parameter is required (for example BTCUSD)', 400);

    const ticker = await marketService.getTicker(symbol);
    return sendSuccess(res, { ticker });
  } catch (error) {
    next(error);
  }
}

// GET /api/market/products?symbol=BTCUSD
async function getProducts(req, res, next) {
  try {
    const symbol = normalizeSymbol(req.query.symbol);

    if (symbol) {
      const product = await marketService.getProduct(symbol);
      return sendSuccess(res, { count: 1, products: [product] });
    }

    const products = await marketService.getProducts();
    return sendSuccess(res, { count: products.length, products });
  } catch (error) {
    next(error);
  }
}

module.exports = { getTicker, getProducts };
