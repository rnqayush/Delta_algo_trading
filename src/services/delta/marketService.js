// Market data: tickers, products (instruments), order book and candles.
// These are public Delta Exchange endpoints, so no API keys are needed.

const deltaClient = require('./deltaClient');
const deltaConfig = require('../../config/deltaConfig');
const logger = require('../../utils/logger');
const { AppError } = require('../../utils/errorHandler');
const { normalizeSymbol } = require('../../utils/helpers');

const { extractResult } = deltaClient;

// Products rarely change, so we cache them for a few minutes instead of
// calling Delta on every request.
const PRODUCT_CACHE_TTL_MS = 5 * 60 * 1000;
let productCache = { items: [], fetchedAt: 0 };

async function getProducts({ force = false } = {}) {
  const isFresh = Date.now() - productCache.fetchedAt < PRODUCT_CACHE_TTL_MS;

  if (!force && productCache.items.length > 0 && isFresh) {
    return productCache.items;
  }

  const response = await deltaClient.publicGet(deltaConfig.endpoints.products);
  const items = extractResult(response, []);

  productCache = {
    items: Array.isArray(items) ? items : [],
    fetchedAt: Date.now(),
  };

  logger.debug(`Loaded ${productCache.items.length} Delta products`);
  return productCache.items;
}

// Returns the full product object for a symbol such as "BTCUSD".
async function getProduct(symbol) {
  const target = normalizeSymbol(symbol);
  if (!target) throw new AppError('A symbol is required', 400);

  const products = await getProducts();
  const product = products.find((item) => item.symbol === target);

  if (!product) {
    throw new AppError(`Product ${target} was not found on Delta Exchange`, 404);
  }
  return product;
}

async function getProductById(productId) {
  const products = await getProducts();
  const product = products.find((item) => Number(item.id) === Number(productId));

  if (!product) {
    throw new AppError(`Product with id ${productId} was not found on Delta Exchange`, 404);
  }
  return product;
}

// Delta sends timestamps in microseconds (sometimes seconds or milliseconds),
// so they are converted to a real Date here.
function toDate(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return new Date();

  if (numeric >= 1e14) return new Date(Math.round(numeric / 1000)); // microseconds
  if (numeric >= 1e11) return new Date(numeric); // milliseconds
  return new Date(numeric * 1000); // seconds
}

function normalizeTicker(raw = {}) {
  return {
    symbol: raw.symbol,
    price: Number(raw.mark_price ?? raw.close ?? raw.spot_price ?? raw.best_bid ?? 0),
    markPrice: Number(raw.mark_price ?? 0),
    bestBid: Number(raw.best_bid ?? 0),
    bestAsk: Number(raw.best_ask ?? 0),
    open: Number(raw.open ?? 0),
    high: Number(raw.high ?? 0),
    low: Number(raw.low ?? 0),
    close: Number(raw.close ?? 0),
    volume: Number(raw.volume ?? 0),
    timestamp: toDate(raw.timestamp),
  };
}

async function getTicker(symbol) {
  const target = normalizeSymbol(symbol);
  if (!target) throw new AppError('A symbol is required to fetch a ticker', 400);

  const response = await deltaClient.publicGet(deltaConfig.endpoints.ticker(target));
  const result = extractResult(response);

  if (!result || Array.isArray(result)) {
    throw new AppError(`No ticker data returned for ${target}`, 404);
  }
  return normalizeTicker(result);
}

async function getTickers({ contractTypes, symbols } = {}) {
  const params = {};
  if (contractTypes) params.contract_types = contractTypes;

  const response = await deltaClient.publicGet(deltaConfig.endpoints.tickers, params);
  const result = extractResult(response, []);
  const list = Array.isArray(result) ? result : [result];

  const normalized = list.map(normalizeTicker);
  if (!symbols || symbols.length === 0) return normalized;

  const wanted = symbols.map(normalizeSymbol);
  return normalized.filter((ticker) => wanted.includes(ticker.symbol));
}

async function getOrderBook(symbol, depth = 10) {
  const target = normalizeSymbol(symbol);
  if (!target) throw new AppError('A symbol is required to fetch the order book', 400);

  const response = await deltaClient.publicGet(deltaConfig.endpoints.orderBook(target));
  return extractResult(response);
}

async function getCandles({ symbol, resolution = '1m', start, end }) {
  const target = normalizeSymbol(symbol);
  if (!target) throw new AppError('A symbol is required to fetch candles', 400);
  if (!start || !end) throw new AppError('Both "start" and "end" are required for candles', 400);

  const response = await deltaClient.publicGet(deltaConfig.endpoints.candles, {
    resolution,
    symbol: target,
    start,
    end,
  });
  return extractResult(response, []);
}

module.exports = {
  getProducts,
  getProduct,
  getProductById,
  getTicker,
  getTickers,
  getOrderBook,
  getCandles,
};
