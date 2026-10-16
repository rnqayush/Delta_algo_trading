// HTTP layer for positions. Delta API calls stay in
// services/delta/positionService.js and application logic in
// services/trading/positionManager.js.

const positionManager = require('../services/trading/positionManager');
const { AppError } = require('../utils/errorHandler');
const { sendSuccess, normalizeSymbol } = require('../utils/helpers');

// GET /api/positions?status=open&sync=true
async function getPositions(req, res, next) {
  try {
    if (String(req.query.sync) === 'true') {
      await positionManager.syncPositions();
    }

    const status = req.query.status || 'open';
    const positions = await positionManager.getPositions({ status });

    return sendSuccess(res, { count: positions.length, positions });
  } catch (error) {
    next(error);
  }
}

// GET /api/positions/:symbol
async function getPositionBySymbol(req, res, next) {
  try {
    const symbol = normalizeSymbol(req.params.symbol);
    const position = await positionManager.getPositionBySymbol(symbol);

    if (!position) throw new AppError(`No open position found for ${symbol}`, 404);

    return sendSuccess(res, { position });
  } catch (error) {
    next(error);
  }
}

// POST /api/positions/:symbol/close
async function closePosition(req, res, next) {
  try {
    const symbol = normalizeSymbol(req.params.symbol);
    const position = await positionManager.closePosition({ symbol, price: req.body?.price });

    return sendSuccess(res, { position });
  } catch (error) {
    next(error);
  }
}

module.exports = { getPositions, getPositionBySymbol, closePosition };
