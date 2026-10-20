// Tests for the trade-management state machine in positionManager.
//
// manageOpenPosition() turns mark price into a stop / time exit decision. The
// fixed target is NOT checked locally — it rests on the exchange as a
// reduce-only take_profit_order — so these tests also cover the paper bracket.

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const Order = require('../src/models/Order');
const Position = require('../src/models/Position');
const Trade = require('../src/models/Trade');
const orderManager = require('../src/services/trading/orderManager');
const positionManager = require('../src/services/trading/positionManager');

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

// An open long with a fixed-bracket plan: entry 100, stop 98, fixed target 102,
// 8h (32 x 15m) time stop.
async function openLong(overrides = {}) {
  return Position.create({
    symbol: 'BTCUSD',
    side: 'long',
    quantity: 100,
    entryPrice: 100,
    currentPrice: 100,
    stopLoss: 98,
    initialStopLoss: 98,
    takeProfit: [{ price: 102, percent: 100 }],
    stage: 'OPEN',
    mode: 'paper',
    strategyName: 'TEST-STRATEGY',
    plan: { exitMode: 'simple', tickSize: 0.5, timeExitBars: 32 },
    openedAt: new Date(),
    ...overrides,
  });
}

describe('positionManager.manageOpenPosition', () => {
  it('exits the whole position when the hard stop is hit', async () => {
    await openLong();

    const result = await positionManager.manageOpenPosition({ symbol: 'BTCUSD', price: 97.5 });

    expect(result.status).toBe('closed');

    const stored = await Position.findOne({ symbol: 'BTCUSD' });
    expect(stored.status).toBe('closed');
    expect(stored.quantity).toBe(0);

    const exitOrder = await Order.findOne({ symbol: 'BTCUSD' });
    expect(exitOrder.side).toBe('sell');
    expect(exitOrder.quantity).toBe(100);
  });

  it('leaves the target to the resting order instead of exiting locally', async () => {
    await openLong();

    await positionManager.manageOpenPosition({ symbol: 'BTCUSD', price: 102.5 });

    const stored = await Position.findOne({ symbol: 'BTCUSD' });
    expect(stored.status).toBe('open');
    expect(stored.quantity).toBe(100);
    expect(await Order.countDocuments()).toBe(0); // no local exit order
  });

  it('exits once the time stop has elapsed', async () => {
    await openLong({ openedAt: new Date(Date.now() - 33 * 15 * 60 * 1000) });

    await positionManager.manageOpenPosition({ symbol: 'BTCUSD', price: 100.5 });

    const stored = await Position.findOne({ symbol: 'BTCUSD' });
    expect(stored.status).toBe('closed');
  });

  it('leaves a position with no stop or time stop untouched', async () => {
    await openLong({ stopLoss: null, initialStopLoss: null, plan: {} });

    await positionManager.manageOpenPosition({ symbol: 'BTCUSD', price: 150 });

    const stored = await Position.findOne({ symbol: 'BTCUSD' });
    expect(stored.status).toBe('open');
    expect(stored.quantity).toBe(100);
  });

  it('ignores a reduce-only fill when nothing is open (never opens a position)', async () => {
    const applied = await positionManager.applyOrder({
      symbol: 'BTCUSD',
      side: 'sell',
      quantity: 10,
      averagePrice: 100,
      status: 'filled',
      reduceOnly: true,
      purpose: 'stop',
      meta: {},
    });

    expect(applied).toBeNull();
    expect(await Position.countDocuments()).toBe(0);
  });
});

describe('positionManager paper end-to-end (exchange-style bracket)', () => {
  const signal = {
    action: 'BUY',
    symbol: 'BTCUSD',
    quantity: 10,
    price: 100,
    orderType: 'limit_order',
    strategyName: 'TEST-STRATEGY',
    stopLoss: 98,
    takeProfit: [{ price: 102, percent: 100 }],
    meta: { exitMode: 'simple', timeExitBars: 32, tickSize: 0.5 },
  };

  it('rests the entry, fills it, then rests a reduce-only stop AND target', async () => {
    const placed = await orderManager.execute(signal, { mode: 'paper', fetchReferencePrice: false });
    expect(placed.order.status).toBe('open');

    // A tick through the limit fills the entry and opens the position.
    expect(await orderManager.handlePaperTick('BTCUSD', 99.9)).toBe(1);

    const position = await Position.findOne({ symbol: 'BTCUSD' });
    expect(position.side).toBe('long');
    expect(position.quantity).toBe(10);
    expect(position.stopLoss).toBe(98);

    const stop = await Order.findOne({ purpose: 'stop' });
    expect(stop.orderType).toBe('stop_market_order');
    expect(stop.side).toBe('sell');
    expect(stop.reduceOnly).toBe(true);
    expect(stop.price).toBe(98);

    const target = await Order.findOne({ purpose: 'target' });
    expect(target.orderType).toBe('take_profit_order');
    expect(target.side).toBe('sell');
    expect(target.reduceOnly).toBe(true);
    expect(target.price).toBe(102);
  });

  it('closes the position at the target and cancels the leftover stop', async () => {
    await orderManager.execute(signal, { mode: 'paper', fetchReferencePrice: false });
    await orderManager.handlePaperTick('BTCUSD', 99.9);

    // A tick to the target fills the resting take-profit.
    expect(await orderManager.handlePaperTick('BTCUSD', 102)).toBe(1);

    const position = await Position.findOne({ symbol: 'BTCUSD' });
    expect(position.status).toBe('closed');
    expect(position.quantity).toBe(0);

    const target = await Order.findOne({ purpose: 'target' });
    expect(target.status).toBe('filled');

    const stop = await Order.findOne({ purpose: 'stop' });
    expect(stop.status).toBe('cancelled');
  });
});
