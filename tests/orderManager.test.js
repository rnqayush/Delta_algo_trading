const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const config = require('../src/config/env');
const Order = require('../src/models/Order');
const Position = require('../src/models/Position');
const Trade = require('../src/models/Trade');
const orderManager = require('../src/services/trading/orderManager');
const orderService = require('../src/services/delta/orderService');

let mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await Promise.all([Order.deleteMany({}), Position.deleteMany({}), Trade.deleteMany({})]);
});

const signal = {
  action: 'BUY',
  symbol: 'BTCUSD',
  quantity: 2,
  price: 100,
  strategyName: 'TestStrategy',
};

// fetchReferencePrice: false keeps the tests offline.
const options = { mode: 'paper', fetchReferencePrice: false };

describe('Order manager (paper mode)', () => {
  it('fills a paper order and stores it in MongoDB', async () => {
    const result = await orderManager.execute(signal, options);

    expect(result.executed).toBe(true);
    expect(result.mode).toBe('paper');
    expect(result.order.status).toBe('filled');

    const stored = await Order.find({});
    expect(stored).toHaveLength(1);
    expect(stored[0].deltaOrderId).toBeNull();
  });

  it('never sends a paper order to Delta Exchange', async () => {
    const spy = jest.spyOn(orderService, 'placeOrder');

    await orderManager.execute(signal, options);

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('opens a position from the filled order', async () => {
    await orderManager.execute(signal, options);

    const position = await Position.findOne({ symbol: 'BTCUSD', status: 'open' });
    expect(position).not.toBeNull();
    expect(position.side).toBe('long');
    expect(position.quantity).toBe(2);
  });

  it('refuses an order that the risk manager rejects', async () => {
    const result = await orderManager.execute({ ...signal, quantity: 9999 }, options);

    expect(result.executed).toBe(false);
    expect(result.reason).toMatch(/maximum allowed/i);
    expect(await Order.countDocuments()).toBe(0);
  });

  it('blocks an order that was already submitted', async () => {
    const fixed = { ...signal, clientOrderId: 'fixed-client-id' };

    await orderManager.execute(fixed, options);

    await expect(orderManager.execute(fixed, options)).rejects.toThrow(/duplicate/i);
    expect(await Order.countDocuments()).toBe(1);
  });

  it('rejects an invalid signal', async () => {
    await expect(orderManager.execute({ action: 'HOLD' }, options)).resolves.toMatchObject({
      executed: false,
    });

    await expect(orderManager.execute({ action: 'BUY', symbol: 'BTCUSD' }, options)).rejects.toThrow(
      /quantity/i
    );
  });

  it('blocks live orders when live trading is not enabled', async () => {
    config.trading.mode = 'live';
    config.trading.liveTradingEnabled = false;

    const result = await orderManager.execute(signal, { mode: 'live' });

    expect(result.executed).toBe(false);
    expect(result.reason).toMatch(/live trading is switched off/i);
    expect(await Order.countDocuments()).toBe(0);

    config.trading.mode = 'paper';
    config.trading.liveTradingEnabled = false;
  });
});

describe('Order manager (resting paper entries)', () => {
  const limit = { ...signal, orderType: 'limit_order', price: 100 };

  it('rests a limit entry instead of filling it immediately', async () => {
    const result = await orderManager.execute(limit, options);

    expect(result.executed).toBe(true);
    expect(result.order.status).toBe('open');
    expect(result.order.averagePrice).toBe(0);
    expect(result.order.filledAt).toBeNull();
    expect(result.order.expiresAt).toBeInstanceOf(Date);
    expect(result.position).toBeNull();
    expect(await Position.countDocuments()).toBe(0);
  });

  it('fills a resting buy limit only once the price trades through it', async () => {
    await orderManager.execute(limit, options);

    // Above the limit — a buy limit is not touched.
    expect(await orderManager.handlePaperTick('BTCUSD', 101)).toBe(0);
    expect(await Position.countDocuments()).toBe(0);

    // At/through the limit — the entry fills at the limit price.
    expect(await orderManager.handlePaperTick('BTCUSD', 100)).toBe(1);

    const order = await Order.findOne({ symbol: 'BTCUSD' });
    expect(order.status).toBe('filled');
    expect(order.averagePrice).toBe(100);

    const position = await Position.findOne({ symbol: 'BTCUSD', status: 'open' });
    expect(position).not.toBeNull();
    expect(position.quantity).toBe(2);
  });

  it('carries the bracket plan onto the stored order', async () => {
    await orderManager.execute(
      {
        ...signal,
        stopLoss: 98,
        takeProfit: [{ price: 102, percent: 40 }],
        meta: { bosLevel: 99, score: 8.5 },
      },
      options
    );

    const order = await Order.findOne({ symbol: 'BTCUSD' });
    expect(order.stopLoss).toBe(98);
    expect(order.takeProfit).toHaveLength(1);
    expect(order.takeProfit[0].price).toBe(102);
    expect(order.takeProfit[0].percent).toBe(40);
    expect(order.meta.bosLevel).toBe(99);
    expect(order.meta.score).toBe(8.5);
  });

  it('cancels a resting order once its validity window has passed', async () => {
    const placed = await orderManager.execute(limit, options);

    // Pretend the entry sat there for longer than the validity window.
    await Order.updateOne(
      { _id: placed.order._id },
      { $set: { expiresAt: new Date(Date.now() - 1000) } }
    );

    expect(await orderManager.cancelExpiredOrders('BTCUSD')).toBe(1);

    const order = await Order.findById(placed.order._id);
    expect(order.status).toBe('cancelled');
  });

  it('cancels a resting order on request', async () => {
    const placed = await orderManager.execute(limit, options);

    const cancelled = await orderManager.cancelOrder({ orderId: placed.order._id });

    expect(cancelled.status).toBe('cancelled');
    await expect(orderManager.cancelOrder({ orderId: placed.order._id })).rejects.toThrow(
      /already cancelled/i
    );
  });
});
