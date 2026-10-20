// The trading engine connects everything together:
//
//   market data -> strategy -> risk manager -> order manager -> position manager
//
// It does NOT contain any trading strategy. It simply asks the strategy for a
// signal and acts on it.

const EventEmitter = require('events');
const marketService = require('../delta/marketService');
const orderManager = require('./orderManager');
const positionManager = require('./positionManager');
const Trade = require('../../models/Trade');
const config = require('../../config/env');
const logger = require('../../utils/logger');
const { AppError } = require('../../utils/errorHandler');
const { isValidSignal, normalizeSignal, normalizeSymbol, startOfToday } = require('../../utils/helpers');

class TradingEngine extends EventEmitter {
  constructor({ strategy, symbol, intervalMs = 5000, options = {} } = {}) {
    super();

    if (!strategy) throw new AppError('TradingEngine requires a strategy', 500);

    this.strategy = strategy;
    this.symbol = normalizeSymbol(symbol || strategy.symbol || 'BTCUSD');
    // intervalMs = 0 means the engine waits for WebSocket data instead of polling.
    this.intervalMs = Number(intervalMs);
    this.options = options;
    this.marketSource = this.intervalMs > 0 ? 'polling' : 'websocket';

    this.timer = null;
    this.running = false;
    this.wsService = null;
    this.wsListener = null;

    this.lastTicker = null;
    this.lastSignal = null;
    this.stats = { ticks: 0, signals: 0, executed: 0, rejected: 0, errors: 0 };

    // Closed-candle context handed to the strategy (refreshed on bar close).
    this.candles15m = [];
    this.candles1h = [];
    this.candleCache = { fetchedAt15: 0, bar15: null, fetchedAt1h: 0, bar1h: null };

    // Daily risk state (trades taken, streak, realised PnL) — refreshed slowly.
    this.daily = { tradesToday: 0, consecutiveLosses: 0, realizedPnlToday: 0, halted: false };
    this.dailyFetchedAt = 0;

    // The heavy pipeline (strategy + management) runs on a throttled cadence.
    this.lastCycleAt = 0;
  }

  setStrategy(strategy) {
    this.strategy = strategy;
    return this;
  }

  async start() {
    if (this.running) throw new AppError('Trading engine is already running', 409);

    this.running = true;

    if (typeof this.strategy.reset === 'function') {
      this.strategy.reset();
    }

    // Give the strategy the exchange facts it needs (tick size, contract value).
    await this.applyProductSettings();

    logger.info(
      `Trading engine started: strategy=${this.strategy.getName()} symbol=${this.symbol} source=${this.marketSource}`
    );
    this.emit('started', { strategy: this.strategy.getName(), symbol: this.symbol });

    if (this.intervalMs > 0) {
      this.timer = setInterval(() => this.safeTick(), this.intervalMs);
    }

    // Run one cycle immediately so there is feedback right away.
    this.safeTick();

    return this;
  }

  stop() {
    if (!this.running) return false;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.wsService && this.wsListener) {
      this.wsService.off('ticker', this.wsListener);
      this.wsListener = null;
    }

    this.running = false;
    logger.info(`Trading engine stopped: strategy=${this.strategy.getName()}`);
    this.emit('stopped', { strategy: this.strategy.getName() });

    return true;
  }

  // Never let a failing tick crash the process.
  safeTick() {
    this.tick().catch((error) => {
      this.stats.errors += 1;
      logger.error(`Trading engine tick failed: ${error.message}`);
      this.emit('errorOccurred', error);
    });
  }

  // Polls the market for the latest price.
  async tick() {
    const ticker = await marketService.getTicker(this.symbol);
    return this.handleMarketData(ticker);
  }

  // Runs one full cycle of the pipeline for a single piece of market data.
  async handleMarketData(ticker) {
    if (!ticker || !ticker.price) {
      return { executed: false, reason: 'No usable market data' };
    }

    this.lastTicker = ticker;
    this.stats.ticks += 1;

    try {
      await positionManager.updatePositionPrice(this.symbol, ticker.price);
    } catch (error) {
      logger.debug(`Could not refresh position price: ${error.message}`);
    }

    // WebSocket tickers arrive many times a second; the strategy and the trade
    // manager only need to run a few seconds apart.
    const interval = Number(config.strategy.evaluateIntervalMs) || 3000;
    if (Date.now() - this.lastCycleAt < interval) {
      return { executed: false, reason: 'Throttled' };
    }
    this.lastCycleAt = Date.now();

    // 1. Refresh the closed-candle context the strategy and the trade manager use.
    try {
      await this.refreshMarketContext();
    } catch (error) {
      logger.warn(`Could not refresh the market context: ${error.message}`);
    }

    // 2. Fill any resting paper limit, then drop expired ones (the 4-candle rule).
    try {
      await orderManager.handlePaperTick(this.symbol, ticker.price);
    } catch (error) {
      logger.error(`Paper fill handling failed: ${error.message}`);
    }
    try {
      await orderManager.cancelExpiredOrders(this.symbol);
    } catch (error) {
      logger.error(`Expired-order handling failed: ${error.message}`);
    }

    // 3. Manage an open position first (stop, partials, trail, trap exits).
    try {
      await positionManager.manageOpenPosition({
        symbol: this.symbol,
        price: ticker.price,
        candles15m: this.candles15m,
        userId: this.options.userId || null,
      });
    } catch (error) {
      logger.error(`Position management failed: ${error.message}`);
    }

    // 4. Ask the strategy for a new setup.
    const state = await this.getStrategyState();
    const signal = this.strategy.evaluate(this.buildMarketData(ticker), state);
    if (!signal) return { executed: false, reason: 'Strategy returned no signal' };

    if (String(signal.action || 'HOLD').toUpperCase() === 'HOLD') {
      this.emit('hold', { symbol: this.symbol, reason: signal.reason || 'HOLD' });
      return { executed: false, reason: signal.reason || 'HOLD' };
    }

    const check = isValidSignal(signal);
    if (!check.valid) {
      this.stats.errors += 1;
      logger.warn(`Strategy ${this.strategy.getName()} produced an invalid signal: ${check.reason}`);
      this.emit('invalidSignal', { signal, reason: check.reason });
      return { executed: false, reason: check.reason };
    }

    const normalized = normalizeSignal({
      ...signal,
      symbol: signal.symbol || this.symbol,
      strategyName: signal.strategyName || this.strategy.getName(),
    });

    this.stats.signals += 1;
    this.lastSignal = normalized;

    logger.info(
      `Signal generated by ${normalized.strategyName}: ${normalized.action} ${normalized.quantity} ${normalized.symbol} (${normalized.reason || 'no reason given'})`
    );
    this.emit('signal', normalized);

    const result = await orderManager.execute(normalized, {
      referencePrice: ticker.price,
      userId: this.options.userId || null,
    });

    if (result.executed) this.stats.executed += 1;
    else this.stats.rejected += 1;

    this.emit(result.executed ? 'trade' : 'rejected', result);
    return result;
  }

  // -------------------------------------------------------------------------
  // Market context: closed candles + daily risk state
  // -------------------------------------------------------------------------

  // Reads the instrument once so the strategy can size and buffer correctly.
  async applyProductSettings() {
    const strategy = this.strategy;
    if (!strategy || typeof strategy !== 'object') return;

    try {
      const product = await marketService.getProduct(this.symbol);

      if (strategy.tickSize !== undefined) {
        strategy.tickSize = Number(product.tick_size) || Number(strategy.tickSize) || 0.5;
      }
      if (strategy.contractValue !== undefined) {
        strategy.contractValue = Number(product.contract_value) || Number(strategy.contractValue) || 0.001;
      }
      if (strategy.equity !== undefined) strategy.equity = Number(config.strategy.equity) || strategy.equity;
      if (strategy.riskPercent !== undefined) strategy.riskPercent = Number(config.strategy.riskPercent);
      if (strategy.maxRiskPercent !== undefined) strategy.maxRiskPercent = Number(config.strategy.maxRiskPercent);
      if (strategy.maxNotionalEquity !== undefined) {
        strategy.maxNotionalEquity = Number(config.strategy.maxNotionalEquity);
      }
      if (strategy.minContracts !== undefined) {
        strategy.minContracts = Math.max(1, Number(config.strategy.minContracts) || 1);
      }
      if (strategy.fixedContracts !== undefined) {
        strategy.fixedContracts = Math.max(0, Number(config.strategy.fixedContracts) || 0);
      }
      // Keep the strategy's slot count identical to the order gate's so the two
      // never disagree about how many positions may be open at once.
      if (strategy.maxConcurrentPositions !== undefined) {
        strategy.maxConcurrentPositions = Math.max(1, Number(config.strategy.maxConcurrentPositions) || 1);
      }
      if (!strategy.symbol) strategy.symbol = this.symbol;

      logger.info(
        `Strategy ${strategy.getName()} configured for ${this.symbol}: ` +
          `tickSize=${strategy.tickSize} contractValue=${strategy.contractValue} equity=${strategy.equity}`
      );
    } catch (error) {
      logger.warn(`Could not load the product for ${this.symbol}: ${error.message}`);
    }
  }

  async refreshMarketContext() {
    const now = Date.now();
    const bar15 = Math.floor(now / (15 * 60 * 1000));
    const bar1h = Math.floor(now / (60 * 60 * 1000));

    if (this.candleCache.bar15 !== bar15 || now - this.candleCache.fetchedAt15 > 60000) {
      this.candles15m = await this.fetchCandles('15m', config.strategy.candles15mCount, 15 * 60 * 1000);
      this.candleCache.bar15 = bar15;
      this.candleCache.fetchedAt15 = now;
    }

    if (this.candleCache.bar1h !== bar1h || now - this.candleCache.fetchedAt1h > 300000) {
      this.candles1h = await this.fetchCandles('1h', config.strategy.candles1hCount, 60 * 60 * 1000);
      this.candleCache.bar1h = bar1h;
      this.candleCache.fetchedAt1h = now;
    }

    await this.refreshDailyState();
  }

  // Fetches recent candles and keeps only the closed ones (no look-ahead).
  async fetchCandles(resolution, count, periodMs) {
    // Delta's /v2/history/candles expects the window in epoch SECONDS.
    // Millisecond bounds are rejected with "bad_schema", so convert here.
    const end = Math.floor(Date.now() / 1000);
    const start = end - Math.floor((Number(count) * periodMs) / 1000);

    const raw = await marketService.getCandles({ symbol: this.symbol, resolution, start, end });
    if (!Array.isArray(raw)) return [];

    const now = Date.now();
    return raw
      .map((candle) => {
        let time = Number(candle.time ?? candle.start_time ?? 0);
        if (time > 0 && time < 1e12) time *= 1000; // Delta sends epoch seconds
        return {
          time,
          open: Number(candle.open),
          high: Number(candle.high),
          low: Number(candle.low),
          close: Number(candle.close),
          volume: Number(candle.volume),
        };
      })
      .filter((candle) => candle.high > 0 && candle.low > 0 && candle.time + periodMs <= now)
      .sort((a, b) => a.time - b.time)
      .slice(-Number(count));
  }

  // Rebuilds the day's counters from the Trade collection (survives restarts).
  async refreshDailyState() {
    const now = Date.now();
    if (now - this.dailyFetchedAt < 15000) return this.daily;

    const start = startOfToday();

    const [tradesToday, recentClosed] = await Promise.all([
      Trade.countDocuments({ entryAt: { $gte: start } }),
      Trade.find({ status: 'closed', exitAt: { $gte: start } }).sort({ exitAt: -1 }).limit(20).select('pnl'),
    ]);

    let consecutiveLosses = 0;
    for (const trade of recentClosed) {
      if (Number(trade.pnl) < 0) consecutiveLosses += 1;
      else break;
    }

    const realizedPnlToday = recentClosed.reduce((sum, trade) => sum + Number(trade.pnl || 0), 0);
    const equity = Number(config.strategy.equity) || 0;

    this.daily = {
      tradesToday,
      consecutiveLosses,
      realizedPnlToday,
      halted: equity > 0 && realizedPnlToday <= -0.02 * equity,
    };
    this.dailyFetchedAt = now;

    return this.daily;
  }

  buildMarketData(ticker) {
    return {
      ...ticker,
      ticker,
      candles15m: this.candles15m,
      candles1h: this.candles1h,
      daily: this.daily,
    };
  }

  async getStrategyState() {
    const [positions, liveEntries] = await Promise.all([
      positionManager.getOpenPositionsBySymbol(this.symbol),
      orderManager.findLiveEntries(this.symbol),
    ]);

    // A strategy may hold several concurrent positions; report the counts so it
    // can decide whether a free slot is available. The booleans are kept for
    // strategies that only understand a single position.
    return {
      hasOpenPosition: positions.length > 0,
      hasLiveOrder: liveEntries.length > 0,
      openPositions: positions.length,
      liveOrders: liveEntries.length,
      positions,
    };
  }

  // Switches the engine to event-driven mode using the Delta WebSocket.
  useWebSocket(wsService, symbols) {
    if (!wsService) throw new AppError('A WebSocket service is required', 400);

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.intervalMs = 0;
    this.marketSource = 'websocket';
    this.wsService = wsService;

    wsService.subscribeTickers(symbols && symbols.length ? symbols : [this.symbol]);

    this.wsListener = (data) => {
      if (normalizeSymbol(data.symbol) !== this.symbol) return;

      // Delta's ticker payload has no "price" field: "close" is the last
      // traded price and the best bid/ask live inside "quotes".
      const quotes = data.quotes || {};
      this.handleMarketData({
        symbol: normalizeSymbol(data.symbol),
        price: Number(data.close || data.mark_price || 0),
        markPrice: Number(data.mark_price || 0),
        bestBid: Number(quotes.best_bid || 0),
        bestAsk: Number(quotes.best_ask || 0),
      }).catch((error) => logger.error(`Engine could not handle WebSocket data: ${error.message}`));
    };

    wsService.on('ticker', this.wsListener);
    logger.info(`Trading engine is now listening to WebSocket tickers for ${this.symbol}`);

    return this;
  }

  getState() {
    return {
      strategy: this.strategy.getName(),
      symbol: this.symbol,
      lastTicker: this.lastTicker,
      lastSignal: this.lastSignal,
      stats: { ...this.stats },
    };
  }

  getStatus() {
    return {
      strategy: this.strategy.getName(),
      symbol: this.symbol,
      running: this.running,
      marketSource: this.marketSource,
      intervalMs: this.intervalMs,
      stats: { ...this.stats },
      lastSignal: this.lastSignal,
    };
  }
}

module.exports = TradingEngine;
