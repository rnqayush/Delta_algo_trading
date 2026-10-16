const { ExampleStrategy } = require('../src/strategies/strategies/exampleStrategy');
const { isValidSignal, normalizeSignal } = require('../src/utils/helpers');

// Feeds a list of prices into the strategy and returns every signal it produced.
function feedPrices(strategy, prices) {
  const signals = [];
  for (const price of prices) {
    signals.push(strategy.evaluate({ symbol: 'BTCUSD', price }));
  }
  return signals;
}

function findAction(signals, action) {
  return signals.find((signal) => signal.action === action);
}

const RISING = [100, 105, 110, 115, 120, 130, 140];
const FALLING = [140, 130, 120, 110, 100, 90, 80];

describe('Example strategy', () => {
  let strategy;

  beforeEach(() => {
    strategy = new ExampleStrategy();
  });

  it('exposes a name', () => {
    expect(strategy.getName()).toBe('ExampleStrategy');
  });

  it('returns HOLD when there is not enough price history', () => {
    const signal = strategy.evaluate({ symbol: 'BTCUSD', price: 100 });

    expect(signal.action).toBe('HOLD');
  });

  it('returns HOLD when no price is available', () => {
    const signal = strategy.evaluate({ symbol: 'BTCUSD' });

    expect(signal.action).toBe('HOLD');
  });

  it('generates a BUY signal on a rising market', () => {
    const buy = findAction(feedPrices(strategy, RISING), 'BUY');

    expect(buy).toBeDefined();
    expect(buy.symbol).toBe('BTCUSD');
    expect(buy.quantity).toBeGreaterThan(0);
    expect(typeof buy.reason).toBe('string');
  });

  it('generates a SELL signal on a falling market', () => {
    const sell = findAction(feedPrices(strategy, FALLING), 'SELL');

    expect(sell).toBeDefined();
    expect(sell.symbol).toBe('BTCUSD');
  });

  it('does not repeat the same signal while the trend continues', () => {
    const signals = feedPrices(strategy, RISING);
    const buyIndex = signals.findIndex((signal) => signal.action === 'BUY');

    expect(buyIndex).toBeGreaterThan(-1);
    expect(signals[buyIndex + 1].action).toBe('HOLD');
  });

  it('returns a signal that passes validation and normalisation', () => {
    const buy = findAction(feedPrices(strategy, RISING), 'BUY');

    expect(isValidSignal(buy).valid).toBe(true);

    const normalized = normalizeSignal(buy);
    expect(normalized.action).toBe('BUY');
    expect(normalized.symbol).toBe('BTCUSD');
    expect(normalized.clientOrderId).toEqual(expect.any(String));
  });

  it('clears its internal state on reset', () => {
    feedPrices(strategy, RISING);
    strategy.reset();

    expect(strategy.priceHistory).toHaveLength(0);
    expect(strategy.lastAction).toBeNull();
  });
});
