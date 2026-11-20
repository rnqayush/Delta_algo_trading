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
const { normalizeSymbol } = require('../utils/helpers');
const TradingEngine = require('../services/trading/tradingEngine');
const Strategy = require('../models/Strategy');
const deltaWebSocket = require('../services/websocket/deltaWebSocket');

// ---------------------------------------------------------------------------
// >>> EDIT THIS LINE <<<
// The strategy the bot runs automatically when the server starts.
// Put the strategy name exactly as it is returned by getName() and leave it
// as '' to start nothing automatically.
// ---------------------------------------------------------------------------
const ACTIVE_STRATEGY ='HFTV1'//'IchimokuHullMacd' // 'EmaSlopeCross1m' // 'MacdReLoaded' // 'TurtlesStrategy' // 'OpenCloseCross1m' | 'EmaSlopeCross1m' | 'SuperTrend2Macd1m' | 'TRSRating5m' | 'MacdCci1m' | 'MacdCci3m' | 'FractalBreakout1m' | 'PivotReversal1m' | 'BestAtrStop1m';

const STRATEGY_FOLDER = path.join(__dirname, 'strategies');

const registry = new Map(); // "examplestrategy" -> strategy instance
const engines = new Map(); // "examplestrategy" -> TradingEngine[] (one per tracked symbol)

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

  // An explicit symbol (manual start) pins one instrument. Otherwise the whole
  // TRADING_SYMBOLS list is tracked together — the account then holds only ONE
  // position across it (see orderManager.concurrencyGate) and takes whichever
  // instrument gets a signal first.
  const requested = options.symbol
    ? [normalizeSymbol(options.symbol)]
    : (Array.isArray(config.trading.symbols) && config.trading.symbols.length
        ? config.trading.symbols
        : [config.trading.symbol || strategy.symbol]);

  // Each tracked instrument needs its own cross/ATR state, so it gets its own
  // strategy instance. A strategy that cannot be cloned stays single-instrument.
  const symbols = requested.length > 1 && typeof strategy.newInstance !== 'function'
    ? [requested[0]]
    : requested;
  if (symbols.length !== requested.length) {
    logger.warn(`Strategy ${strategy.getName()} cannot track multiple symbols — running ${symbols[0]} only`);
  }

  // One shared loss-cooldown clock across every instance, so a loser on any
  // instrument freezes the whole portfolio (see the strategy's LOSS_COOLDOWN_MIN).
  const sharedCooldown = { untilMs: 0 };

  const instances = symbols.map((symbol, index) => {
    const instance = index === 0 ? strategy : strategy.newInstance();
    if (instance.cooldown) instance.cooldown = sharedCooldown;
    return instance;
  });

  const started = [];
  try {
    for (let index = 0; index < symbols.length; index += 1) {
      const engine = new TradingEngine({
        strategy: instances[index],
        intervalMs: useWebSocket ? 0 : options.intervalMs || 5000,
        options: { userId: options.userId || null },
        symbol: symbols[index],
      });

      if (useWebSocket) {
        engine.useWebSocket(deltaWebSocket, [engine.symbol]);
      }

      await engine.start();
      started.push(engine);
    }
  } catch (error) {
    // Never leave half a portfolio running.
    started.forEach((engine) => engine.stop());
    throw error;
  }

  engines.set(key, started);

  await persistStatus(strategy, 'running', symbols);
  logger.info(`Strategy started: ${strategy.getName()} (${symbols.join(', ')})`);

  return {
    strategy: strategy.getName(),
    symbol: symbols[0],
    symbols,
    running: true,
    engines: started.map((engine) => engine.getStatus()),
  };
}

async function stop(name) {
  const key = String(name).toLowerCase();
  const running = engines.get(key);

  if (!running) {
    throw new AppError(`Strategy "${name}" is not running`, 409);
  }

  running.forEach((engine) => engine.stop());
  engines.delete(key);

  await persistStatus(get(name), 'stopped');
  logger.info(`Strategy stopped: ${name}`);

  return { name: running[0].strategy.getName(), running: false };
}

function stopAll() {
  for (const [key, running] of engines.entries()) {
    running.forEach((engine) => engine.stop());
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
  const running = engines.get(String(name).toLowerCase());
  if (!running) return { name, running: false };

  return {
    strategy: running[0].strategy.getName(),
    symbol: running[0].symbol,
    symbols: running.map((engine) => engine.symbol),
    running: true,
    engines: running.map((engine) => engine.getStatus()),
  };
}

// ---------------------------------------------------------------------------
// Database bookkeeping (optional — a failure here must not break trading)
// ---------------------------------------------------------------------------

async function persistStatus(strategy, status, symbols) {
  try {
    const update = {
      status,
      mode: config.trading.mode,
      description: strategy.description || '',
      symbols: symbols || (strategy.symbol ? [strategy.symbol] : []),
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
