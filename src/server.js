// Application entry point: connect the database, start the HTTP server and
// (optionally) the real-time WebSocket connection.

const mongoose = require('mongoose');

const app = require('./app');
const config = require('./config/env');
const logger = require('./utils/logger');
const { normalizeSymbol } = require('./utils/helpers');
const deltaWebSocket = require('./services/websocket/deltaWebSocket');
const orderManager = require('./services/trading/orderManager');
const positionManager = require('./services/trading/positionManager');
const strategyManager = require('./strategies/strategyManager');

async function connectDatabase() {
  await mongoose.connect(config.mongoUri);
  logger.info(`MongoDB connected: ${mongoose.connection.name}`);
}

// Logs live market data for the configured symbol. Throttled to one line per
// second so the console stays readable while still showing real-time prices.
let lastTickerLogAt = 0;

function logLiveMarketData(ticker) {
  const now = Date.now();
  if (now - lastTickerLogAt < 1000) return;
  lastTickerLogAt = now;

  const quotes = ticker.quotes || {};
  logger.info(
    `Live ${ticker.symbol}: ltp=${ticker.close ?? '-'} ` +
      `mark=${ticker.mark_price ?? '-'} ` +
      `bid=${quotes.best_bid ?? '-'} ask=${quotes.best_ask ?? '-'} ` +
      `24h=${ticker.ltp_change_24h ?? '-'}%`
  );
}

// Wires the WebSocket events to the managers. Strategy logic is never put here.
function startRealtime() {
  if (!config.websocket.enabled) {
    logger.info('Real-time WebSocket is disabled (ENABLE_WEBSOCKET=false)');
    return;
  }

  deltaWebSocket.on('connected', () => {
    // Public market data for the configured symbol is always streamed.
    deltaWebSocket.subscribeTickers([config.trading.symbol]);
    logger.info(`Subscribed to live market data for ${config.trading.symbol}`);

    // Private channels (orders/positions) are only available with API keys.
    const apiKeysConfigured = Boolean(config.delta.apiKey && config.delta.apiSecret);
    if (!apiKeysConfigured) {
      logger.info('Delta API keys are not set — only public market data will be streamed');
      return;
    }

    deltaWebSocket.subscribeOrderUpdates();
    deltaWebSocket.subscribePositionUpdates();
  });

  deltaWebSocket.on('ticker', (ticker) => {
    if (normalizeSymbol(ticker.symbol) !== config.trading.symbol) return;
    logLiveMarketData(ticker);
  });

  deltaWebSocket.on('orderUpdate', (update) => {
    orderManager
      .handleOrderUpdate(update)
      .catch((error) => logger.error(`Could not apply the order update: ${error.message}`));
  });

  deltaWebSocket.on('positionUpdate', (update) => {
    positionManager
      .handlePositionUpdate(update)
      .catch((error) => logger.error(`Could not apply the position update: ${error.message}`));
  });

  deltaWebSocket.connect();
}

async function startServer() {
  const problems = config.validateConfig();
  for (const problem of problems) logger.warn(`Configuration: ${problem}`);

  await connectDatabase();

  logger.info(
    `Trading mode: ${config.trading.mode.toUpperCase()}` +
      (config.trading.isLive ? ' — LIVE ORDERS ARE ENABLED' : ' — orders are simulated')
  );

  const server = app.listen(config.port, () => {
    logger.info(`Server started on http://localhost:${config.port}`);
    logger.info(`Health check: http://localhost:${config.port}/api/health`);
  });

  startRealtime();

  // Start the strategy named in ACTIVE_STRATEGY (src/strategies/strategyManager.js).
  const strategyStatus = await strategyManager.startActiveStrategy();

  // A configured strategy that did not start must fail the boot, not be ignored:
  // startActiveStrategy() returns null when it swallows an error, which would
  // otherwise leave the server up and silently not trading.
  if (strategyManager.ACTIVE_STRATEGY && !strategyStatus) {
    throw new Error(`active strategy "${strategyManager.ACTIVE_STRATEGY}" failed to start`);
  }

  // Single always-visible startup line. Written straight to stdout (not through
  // `logger`) on purpose: LOG_LEVEL=error mutes info/warn, so this is the one
  // line that confirms a successful boot from `pm2 logs` / `journalctl -u`.
  process.stdout.write(
    `[${new Date().toISOString()}] RUNNING — strategy=${strategyStatus ? strategyStatus.strategy : 'none'} ` +
      `symbol=${strategyStatus ? strategyStatus.symbol : config.trading.symbol} ` +
      `mode=${config.trading.mode.toUpperCase()} port=${config.port}\n`
  );

  const shutdown = async (signal) => {
    logger.info(`${signal} received — shutting down gracefully`);

    strategyManager.stopAll();
    deltaWebSocket.disconnect();

    server.close(async () => {
      await mongoose.connection.close();
      logger.info('Shutdown complete');
      process.exit(0);
    });
  };

  ['SIGINT', 'SIGTERM'].forEach((signal) => {
    process.on(signal, () => shutdown(signal));
  });

  return server;
}

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', reason);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', error);
  process.exit(1);
});

startServer().catch((error) => {
  logger.error(`Failed to start the server: ${error.message}`, error);
  process.exit(1);
});
