// Central configuration module.
// Every other file reads its settings from here, so nothing is hardcoded and
// secrets always come from the .env file.

require('dotenv').config();

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toBoolean(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return ['true', '1', 'yes', 'on'].includes(String(value).toLowerCase());
}

const tradingMode = (process.env.TRADING_MODE || 'paper').toLowerCase();
const liveTradingEnabled = toBoolean(process.env.ENABLE_LIVE_TRADING, false);

const config = {
  env: process.env.NODE_ENV || 'development',
  port: toNumber(process.env.PORT, 5000),
  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/delta_trading_bot',

  jwt: {
    secret: process.env.JWT_SECRET || 'insecure_development_secret',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },

  // Delta Exchange connection details.
  // The keys themselves are never logged or returned in API responses.
  delta: {
    apiKey: process.env.DELTA_API_KEY || '',
    apiSecret: process.env.DELTA_API_SECRET || '',
    baseUrl: process.env.DELTA_BASE_URL || 'https://api.india.delta.exchange',
    wsUrl: process.env.DELTA_WS_URL || 'wss://socket.india.delta.exchange',
    timeout: toNumber(process.env.DELTA_TIMEOUT_MS, 10000),
    maxRetries: toNumber(process.env.DELTA_MAX_RETRIES, 2),
  },

  websocket: {
    enabled: toBoolean(process.env.ENABLE_WEBSOCKET, true),
  },

  // Safety switch. "isLive" is only true when BOTH conditions are met.
  trading: {
    mode: tradingMode, // 'paper' (default) or 'live'
    liveTradingEnabled,
    isLive: tradingMode === 'live' && liveTradingEnabled,
    // The single instrument the bot trades and streams live data for.
    symbol: (process.env.TRADING_SYMBOL || 'BTCUSD').trim().toUpperCase(),
  },

  risk: {
    tradingEnabled: toBoolean(process.env.RISK_TRADING_ENABLED, true),
    maxOrderQuantity: toNumber(process.env.RISK_MAX_ORDER_QUANTITY, 10),
    maxPositionSize: toNumber(process.env.RISK_MAX_POSITION_SIZE, 100),
    maxDailyLoss: toNumber(process.env.RISK_MAX_DAILY_LOSS, 500),
    maxOpenTrades: toNumber(process.env.RISK_MAX_OPEN_TRADES, 5),
    maxPriceDeviationPercent: toNumber(process.env.RISK_MAX_PRICE_DEVIATION_PERCENT, 5),
    duplicateWindowSeconds: toNumber(process.env.RISK_DUPLICATE_WINDOW_SECONDS, 5),
  },

  // Sweep & Shift (S&S-15) strategy + trade-management settings.
  strategy: {
    // Account equity the strategy sizes from (quote currency, e.g. USD).
    equity: toNumber(process.env.STRATEGY_EQUITY, 1000),
    // Fraction of equity risked per trade (0.005 = 0.5%). Hard-capped below.
    riskPercent: toNumber(process.env.STRATEGY_RISK_PERCENT, 0.005),
    maxRiskPercent: toNumber(process.env.STRATEGY_MAX_RISK_PERCENT, 0.01),
    // Max notional per trade as a multiple of equity (3x equity by default).
    // On a leveraged account this doubles as the exposure ceiling: the strategy
    // will not carry more total notional than this multiple of equity.
    maxNotionalEquity: toNumber(process.env.STRATEGY_MAX_NOTIONAL_EQUITY, 3),
    // Smallest tradable size. A tiny (e.g. leveraged) account rounds the
    // risk-based size to zero contracts, which would mean it never trades at
    // all; this floor lets it put on the exchange minimum (1 contract).
    minContracts: toNumber(process.env.STRATEGY_MIN_CONTRACTS, 1),
    // When > 0, every order is exactly this many contracts and the risk/notional
    // sizing is bypassed ("always place 1 lot"). 0 = use risk-based sizing.
    fixedContracts: toNumber(process.env.STRATEGY_FIXED_CONTRACTS, 0),
    // A resting entry limit is cancelled after this many minutes (4 x 15m).
    entryValidityMinutes: toNumber(process.env.STRATEGY_ENTRY_VALIDITY_MINUTES, 60),
    // How many positions a strategy may hold at once. Strategies that do not
    // support it stay at one.
    maxConcurrentPositions: toNumber(process.env.STRATEGY_MAX_CONCURRENT_POSITIONS, 4),
    // How often the engine re-evaluates the strategy and manages positions.
    evaluateIntervalMs: toNumber(process.env.STRATEGY_EVALUATE_INTERVAL_MS, 3000),
    candles15mCount: toNumber(process.env.STRATEGY_CANDLES_15M, 300),
    // 5m feed for strategies whose base timeframe is 5m. 0 disables the extra
    // request, so 15m/30m configs never pay for a series they do not use.
    candles5mCount: toNumber(process.env.STRATEGY_CANDLES_5M, 0),
    candles1hCount: toNumber(process.env.STRATEGY_CANDLES_1H, 100),
  },
};

// Returns the names of required settings that are missing.
// Used at startup so beginners get a clear message instead of a silent failure.
function validateConfig() {
  const problems = [];

  if (!config.mongoUri) problems.push('MONGODB_URI is not set');
  if (!config.jwt.secret || config.jwt.secret === 'insecure_development_secret') {
    problems.push('JWT_SECRET is not set (using an insecure default)');
  }
  if (config.trading.mode === 'live' && !config.trading.liveTradingEnabled) {
    problems.push('TRADING_MODE=live but ENABLE_LIVE_TRADING=false — live orders will be blocked');
  }
  if (!config.delta.apiKey || !config.delta.apiSecret) {
    problems.push('DELTA_API_KEY / DELTA_API_SECRET are not set — private Delta endpoints will fail');
  }

  return problems;
}

module.exports = config;
module.exports.validateConfig = validateConfig;
