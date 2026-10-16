// Example strategy — a moving average crossover.
//
// It exists only to show the shape a strategy must have. It is NOT a real
// trading strategy and it is NOT profitable. Replace it with your own by
// creating src/strategies/strategies/myStrategy.js.
//
// Every strategy must expose:
//   getName()  -> a unique name
//   evaluate(marketData, state) -> a normalised signal
//   reset()    -> optional, clears internal state before a new run
//
// The signal shape is:
//   { action: 'BUY', symbol: 'BTCUSD', quantity: 1, reason: '...' }
//   { action: 'SELL', symbol: 'BTCUSD', quantity: 1, reason: '...' }
//   { action: 'HOLD' }

const config = require('../../config/env');

class ExampleStrategy {
  constructor(options = {}) {
    this.name = options.name || 'ExampleStrategy';
    this.description = 'Simple moving average crossover demo (not a real strategy)';
    // Defaults to TRADING_SYMBOL from the .env file.
    this.symbol = options.symbol || config.trading.symbol;
    this.quantity = options.quantity || 1;
    this.fastPeriod = options.fastPeriod || 3;
    this.slowPeriod = options.slowPeriod || 5;

    this.priceHistory = [];
    this.lastAction = null;
  }

  getName() {
    return this.name;
  }

  reset() {
    this.priceHistory = [];
    this.lastAction = null;
  }

  addPrice(price) {
    this.priceHistory.push(Number(price));
    // We only need the last few prices to keep things simple.
    if (this.priceHistory.length > this.slowPeriod + 1) {
      this.priceHistory.shift();
    }
  }

  average(period) {
    const slice = this.priceHistory.slice(-period);
    if (slice.length < period) return null;
    return slice.reduce((total, value) => total + value, 0) / period;
  }

  // marketData is a ticker object: { symbol, price, markPrice, ... }
  evaluate(marketData = {}) {
    const price = Number(marketData.price ?? marketData.markPrice ?? marketData.mark_price ?? 0);

    if (!price) {
      return { action: 'HOLD', reason: 'No price available in the market data' };
    }

    this.addPrice(price);

    if (this.priceHistory.length < this.slowPeriod + 1) {
      return { action: 'HOLD', reason: 'Not enough price history yet' };
    }

    const fast = this.average(this.fastPeriod);
    const slow = this.average(this.slowPeriod);

    if (fast === null || slow === null) {
      return { action: 'HOLD', reason: 'Not enough price history yet' };
    }

    if (fast > slow && this.lastAction !== 'BUY') {
      this.lastAction = 'BUY';
      return {
        action: 'BUY',
        symbol: this.symbol,
        quantity: this.quantity,
        price,
        reason: `Fast average (${fast.toFixed(2)}) crossed above slow average (${slow.toFixed(2)})`,
      };
    }

    if (fast < slow && this.lastAction !== 'SELL') {
      this.lastAction = 'SELL';
      return {
        action: 'SELL',
        symbol: this.symbol,
        quantity: this.quantity,
        price,
        reason: `Fast average (${fast.toFixed(2)}) crossed below slow average (${slow.toFixed(2)})`,
      };
    }

    return { action: 'HOLD', reason: 'No crossover detected' };
  }
}

const exampleStrategy = new ExampleStrategy();

module.exports = exampleStrategy;
module.exports.ExampleStrategy = ExampleStrategy;
