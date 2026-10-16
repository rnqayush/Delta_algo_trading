// Express application setup.
// Note: this file only builds the app — server.js starts it. That separation
// makes the app easy to import in tests.

const express = require('express');
const cors = require('cors');

const config = require('./config/env');
const authRoutes = require('./routes/authRoutes');
const marketRoutes = require('./routes/marketRoutes');
const orderRoutes = require('./routes/orderRoutes');
const positionRoutes = require('./routes/positionRoutes');
const strategyRoutes = require('./routes/strategyRoutes');
const { notFoundHandler, errorHandler } = require('./middlewares/errorMiddleware');

const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ---------------------------------------------------------------------------
// Health check — the simplest way to confirm the backend is alive.
// ---------------------------------------------------------------------------
app.get('/api/health', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Trading backend is running',
    data: {
      environment: config.env,
      tradingMode: config.trading.mode,
      liveTradingEnabled: config.trading.liveTradingEnabled,
      deltaConfigured: Boolean(config.delta.apiKey && config.delta.apiSecret),
      timestamp: new Date().toISOString(),
    },
  });
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.use('/api/auth', authRoutes);
app.use('/api/market', marketRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/positions', positionRoutes);
app.use('/api/strategies', strategyRoutes);

// ---------------------------------------------------------------------------
// Errors (must be last)
// ---------------------------------------------------------------------------
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
