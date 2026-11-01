// Keeps track of the strategies the bot knows about and starts/stops them.
//
// Adding a new strategy:
//   1. create src/strategies/strategies/myStrategy.js
//   2. export an object with getName(), evaluate() and (optionally) reset()
// It is picked up automatically — nothing else needs to change.

const fs = require('fs');
const path = require('path');
const config = require('../config/env');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errorHandler');
const TradingEngine = require('../services/trading/tradingEngine');
const Strategy = require('../models/Strategy');
const deltaWebSocket = require('../services/websocket/deltaWebSocket');

// ---------------------------------------------------------------------------
// >>> EDIT THIS LINE <<<
// The strategy the bot runs automatically when the server starts.
// Put the strategy name exactly as it is returned by getName() and leave it
// as '' to start nothing automatically.
// ---------------------------------------------------------------------------
const ACTIVE_STRATEGY ='OpenCloseCross1m'//'PivotReversal1m' //'MacdCci15m'//'FractalBreakout1m' // 'OCC_AYUSH' | 'OpenCloseCross1m' | 'SuperTrend2Macd1m' | 'TRSRating5m' | 'MacdCci1m' | 'MacdCci3m' | 'FractalBreakout1m' | 'PivotReversal1m' | 'BestAtrStop1m';

const STRATEGY_FOLDER = path.join(__dirname, 'strategies');

const registry = new Map(); // "examplestrategy" -> strategy instance
const engines = new Map(); // "examplestrategy" -> running TradingEngine

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

function register(strategy) {
  if (
    !strategy ||
    typeof strategy.getName !== 'function' ||
    typeof strategy.evaluate !== 'function'
  ) {
    logger.warn('Skipped a strategy: it must export an object with getName() and evaluate()');
    return null;
  }

  const name = strategy.getName();
  registry.set(name.toLowerCase(), strategy);
  logger.info(`Strategy registered: ${name}`);
  return name;
}

function loadStrategiesFromDisk() {
  if (!fs.existsSync(STRATEGY_FOLDER)) return;

  const files = fs.readdirSync(STRATEGY_FOLDER).filter((file) => file.endsWith('.js'));

  for (const file of files) {
    try {
      const loaded = require(path.join(STRATEGY_FOLDER, file));
      register(typeof loaded === 'function' ? loaded() : loaded);
    } catch (error) {
      logger.error(`Failed to load strategy file "${file}": ${error.message}`);
    }
  }
}

function get(name) {
  const strategy = registry.get(String(name || '').toLowerCase());
  if (!strategy) {
    throw new AppError(`Strategy "${name}" was not found`, 404);
  }
  return strategy;
}

function list() {
  return [...registry.entries()].map(([key, strategy]) => ({
    name: strategy.getName(),
    description: strategy.description || '',
    symbol: strategy.symbol || null,
    running: engines.has(key),
  }));
}

// ---------------------------------------------------------------------------
// Start / stop
// ---------------------------------------------------------------------------

async function start(name, options = {}) {
  const key = String(name).toLowerCase();
  const strategy = get(name);

  if (engines.has(key)) {
    throw new AppError(`Strategy "${strategy.getName()}" is already running`, 409);
  }

  const useWebSocket = options.useWebSocket === true || options.intervalMs === 0;

  if (useWebSocket && !config.websocket.enabled) {
    throw new AppError('Real-time mode requested but the WebSocket is disabled (ENABLE_WEBSOCKET=false)', 400);
  }

  const engine = new TradingEngine({
    strategy,
    // TRADING_SYMBOL is the single source of truth for the instrument: it drives
    // the WebSocket subscription, the candle feed, the risk checks and the order
    // symbol. A strategy's own `symbol` is only a fallback for when the env is
    // blank; an explicit options.symbol (manual start) still wins.
    symbol: options.symbol || config.trading.symbol || strategy.symbol,
    intervalMs: useWebSocket ? 0 : options.intervalMs || 5000,
    options: { userId: options.userId || null },
  });

  if (useWebSocket) {
    engine.useWebSocket(deltaWebSocket, [engine.symbol]);
  }

  await engine.start();
  engines.set(key, engine);

  await persistStatus(strategy, 'running');
  logger.info(`Strategy started: ${strategy.getName()}`);

  return engine.getStatus();
}

async function stop(name) {
  const key = String(name).toLowerCase();
  const engine = engines.get(key);

  if (!engine) {
    throw new AppError(`Strategy "${name}" is not running`, 409);
  }

  engine.stop();
  engines.delete(key);

  await persistStatus(get(name), 'stopped');
  logger.info(`Strategy stopped: ${name}`);

  return { name: engine.strategy.getName(), running: false };
}

function stopAll() {
  for (const [key, engine] of engines.entries()) {
    engine.stop();
    engines.delete(key);
  }
}

// Starts the strategy named in ACTIVE_STRATEGY. Called once when the server boots.
async function startActiveStrategy() {
  if (!ACTIVE_STRATEGY) {
    logger.info('ACTIVE_STRATEGY is empty — no strategy started automatically');
    return null;
  }

  try {
    // Use the live WebSocket feed when it is enabled, otherwise poll the REST API.
    const options = config.websocket.enabled ? { intervalMs: 0 } : {};
    return await start(ACTIVE_STRATEGY, options);
  } catch (error) {
    logger.error(`Could not start ACTIVE_STRATEGY "${ACTIVE_STRATEGY}": ${error.message}`);
    return null;
  }
}

function getStatus(name) {
  const engine = engines.get(String(name).toLowerCase());
  return engine ? engine.getStatus() : { name, running: false };
}

// ---------------------------------------------------------------------------
// Database bookkeeping (optional — a failure here must not break trading)
// ---------------------------------------------------------------------------

async function persistStatus(strategy, status) {
  try {
    const update = {
      status,
      mode: config.trading.mode,
      description: strategy.description || '',
      symbols: strategy.symbol ? [strategy.symbol] : [],
    };

    if (status === 'running') update.lastStartedAt = new Date();
    if (status === 'stopped') update.lastStoppedAt = new Date();

    await Strategy.findOneAndUpdate(
      { name: strategy.getName() },
      { $set: update },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } catch (error) {
    logger.warn(`Could not save the strategy status in MongoDB: ${error.message}`);
  }
}

loadStrategiesFromDisk();

module.exports = {
  register,
  get,
  list,
  start,
  stop,
  stopAll,
  startActiveStrategy,
  getStatus,
  ACTIVE_STRATEGY,
};
