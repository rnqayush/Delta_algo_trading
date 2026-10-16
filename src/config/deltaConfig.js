// Every Delta Exchange URL path, timeout and WebSocket channel name lives here.
// If Delta changes a path you only need to edit this single file.

const config = require('./env');

module.exports = {
  baseUrl: config.delta.baseUrl,
  wsUrl: config.delta.wsUrl,
  timeout: config.delta.timeout,
  maxRetries: config.delta.maxRetries,
  apiKey: config.delta.apiKey,
  apiSecret: config.delta.apiSecret,

  endpoints: {
    // Market data (public)
    products: '/v2/products',
    product: (symbol) => `/v2/products/${symbol}`,
    tickers: '/v2/tickers',
    ticker: (symbol) => `/v2/tickers/${symbol}`,
    orderBook: (symbol) => `/v2/l2orderbook/${symbol}`,
    candles: '/v2/history/candles',

    // Trading (private)
    orders: '/v2/orders',
    order: (orderId) => `/v2/orders/${orderId}`,
    ordersHistory: '/v2/orders/history',
    positions: '/v2/positions',
    walletBalances: '/v2/wallet/balances',
  },

  // WebSocket channel names used by the real-time service.
  wsChannels: {
    ticker: 'v2/ticker',
    trades: 'v2/trades',
    markPrice: 'mark_price',
    candles1m: 'candlestick_1m',
    orders: 'orders',
    positions: 'positions',
    margins: 'margins',
  },
};
