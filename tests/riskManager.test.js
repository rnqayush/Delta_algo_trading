const config = require('../src/config/env');
const riskManager = require('../src/services/trading/riskManager');

// The risk manager reads its limits from the config object, so tests can change
// them temporarily and restore them afterwards.
const originalRisk = { ...config.risk };

const validSignal = {
  action: 'BUY',
  symbol: 'BTCUSD',
  quantity: 1,
  price: 100,
};

beforeEach(() => {
  Object.assign(config.risk, originalRisk);
  config.trading.mode = 'paper';
  config.trading.liveTradingEnabled = false;
  config.trading.isLive = false;
});

describe('Risk manager', () => {
  it('allows a valid signal with a clean context', async () => {
    const decision = await riskManager.validate(validSignal, {
      referencePrice: 100,
      positionQuantity: 0,
      openTradesCount: 0,
      dailyPnl: 0,
      recentOrders: [],
    });

    expect(decision.allowed).toBe(true);
  });

  it('rejects trading when it is disabled by configuration', async () => {
    config.risk.tradingEnabled = false;

    const decision = await riskManager.validate(validSignal, {});

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/disabled/i);
  });

  it('rejects an invalid signal', async () => {
    const decision = await riskManager.validate({ action: 'MAYBE', symbol: 'BTCUSD' }, {});

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/invalid trading signal/i);
  });

  it('rejects a signal without a quantity', async () => {
    const decision = await riskManager.validate({ action: 'BUY', symbol: 'BTCUSD' }, {});

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/quantity/i);
  });

  it('rejects an order bigger than the maximum order quantity', async () => {
    const decision = await riskManager.validate(
      { ...validSignal, quantity: config.risk.maxOrderQuantity + 1 },
      {}
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/maximum allowed/i);
  });

  it('rejects an order that would exceed the maximum position size', async () => {
    const decision = await riskManager.validate(validSignal, {
      positionQuantity: config.risk.maxPositionSize,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/position size/i);
  });

  it('rejects new orders once the daily loss limit is reached', async () => {
    const decision = await riskManager.validate(validSignal, {
      dailyPnl: -config.risk.maxDailyLoss,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/daily loss/i);
  });

  it('rejects new orders when the maximum number of open trades is reached', async () => {
    const decision = await riskManager.validate(validSignal, {
      openTradesCount: config.risk.maxOpenTrades,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/open trades/i);
  });

  it('blocks duplicate orders placed moments ago', async () => {
    const decision = await riskManager.validate(validSignal, {
      recentOrders: [{ symbol: 'BTCUSD', side: 'buy', createdAt: new Date() }],
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/duplicate/i);
  });

  it('ignores old orders when checking for duplicates', async () => {
    const oldOrder = { symbol: 'BTCUSD', side: 'buy', createdAt: new Date(Date.now() - 600000) };

    const decision = await riskManager.validate(validSignal, { recentOrders: [oldOrder] });

    expect(decision.allowed).toBe(true);
  });

  it('rejects a price that deviates too far from the market price', async () => {
    const decision = await riskManager.validate({ ...validSignal, price: 200 }, {
      referencePrice: 100,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/deviates/i);
  });

  it('blocks live trading when live mode is not explicitly enabled', async () => {
    config.trading.mode = 'live';
    config.trading.liveTradingEnabled = false;

    const decision = await riskManager.validate(validSignal, {});

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/live trading is switched off/i);
  });

  it('allows trading in live mode once it is enabled', async () => {
    config.trading.mode = 'live';
    config.trading.liveTradingEnabled = true;

    const decision = await riskManager.validate(validSignal, {});

    expect(decision.allowed).toBe(true);
  });
});
