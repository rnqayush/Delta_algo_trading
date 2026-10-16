// Runs before every test file.
// dotenv does not overwrite variables that already exist, so these values win
// over whatever is in the local .env file — tests must never hit live trading.

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.TRADING_MODE = 'paper';
process.env.ENABLE_LIVE_TRADING = 'false';
process.env.RISK_TRADING_ENABLED = 'true';
process.env.ENABLE_WEBSOCKET = 'false';
