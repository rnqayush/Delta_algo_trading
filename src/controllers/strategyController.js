// HTTP layer for strategies. Starting/stopping a strategy is handled by
// src/strategies/strategyManager.js — this controller only reads the request.

const strategyManager = require('../strategies/strategyManager');
const { sendSuccess } = require('../utils/helpers');

// GET /api/strategies
async function getStrategies(req, res, next) {
  try {
    const strategies = strategyManager.list();
    return sendSuccess(res, { count: strategies.length, strategies });
  } catch (error) {
    next(error);
  }
}

// POST /api/strategies/:name/start
// body (all optional): { symbol, intervalMs, useWebSocket }
async function startStrategy(req, res, next) {
  try {
    const { symbol, intervalMs, useWebSocket } = req.body || {};

    const status = await strategyManager.start(req.params.name, {
      symbol,
      intervalMs: intervalMs === undefined ? undefined : Number(intervalMs),
      useWebSocket,
      userId: req.user?._id || null,
    });

    return sendSuccess(res, { strategy: status }, 200, `Strategy "${req.params.name}" started`);
  } catch (error) {
    next(error);
  }
}

// POST /api/strategies/:name/stop
async function stopStrategy(req, res, next) {
  try {
    const status = await strategyManager.stop(req.params.name);
    return sendSuccess(res, { strategy: status }, 200, `Strategy "${req.params.name}" stopped`);
  } catch (error) {
    next(error);
  }
}

module.exports = { getStrategies, startStrategy, stopStrategy };
