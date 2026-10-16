// Tests for the trade-management state machine in positionManager.
//
// manageOpenPosition() turns mark price + closed candles into SL / partial-TP /
// trail / structure-failure / stall decisions. It writes real orders through the
// order manager, so these tests use an in-memory MongoDB (paper mode only).

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

// Builds a 15m candle from just a low/high/close — enough for structure checks.
function candle({ low, high, close }) {
  return { time: 1700000000, open: close, high: high ?? close + 0.5, low: low ?? close - 0.5, close };
}

// An open long position with a 2-point risk (entry 100, stop 98), so +1R = 102
// and +2R = 104. Overrides let each test move the state machine forward.
async function openLong(overrides = {}) {
  return Position.create({
    symbol: 'BTCUSD',
    side: 'long',
    quantity: 100,
    entryPrice: 100,
    currentPrice: 100,
    stopLoss: 98,
    initialStopLoss: 98,
    takeProfit: [
      { price: 102, percent: 40 },
      { price: 104, percent: 30 },
    ],
    stage: 'OPEN',
    mode: 'paper',
    strategyName: 'SweepShift-15',
    plan: { bosLevel: 0, tickSize: 0.5, avgBody: 1 },
    openedAt: new Date(),
    ...overrides,
  });
}

describe('positionManager.manageOpenPosition', () => {
  it('exits the whole position when the hard stop is hit', async () => {
    await openLong({ stopLoss: 98 });

    const result = await positionManager.manageOpenPosition({ symbol: 'BTCUSD', price: 97.5 });

    expect(result.status).toBe('closed');

    const stored = await Position.findOne({ symbol: 'BTCUSD' });
    expect(stored.status).toBe('closed');
    expect(stored.quantity).toBe(0);

    const exitOrder = await Order.findOne({ symbol: 'BTCUSD' });
    expect(exitOrder.side).toBe('sell');
    expect(exitOrder.quantity).toBe(100);
  });

  it('takes 40% off at +1R and moves to PARTIAL_1', async () => {
    await openLong();

    await positionManager.manageOpenPosition({ symbol: 'BTCUSD', price: 102.2 });

    const stored = await Position.findOne({ symbol: 'BTCUSD' });
    expect(stored.stage).toBe('PARTIAL_1');
    expect(stored.quantity).toBe(60); // 100 - 40%

    const partial = await Order.findOne({ symbol: 'BTCUSD' });
    expect(partial.side).toBe('sell');
    expect(partial.quantity).toBe(40);
    expect(partial.orderType).toBe('market_order');
  });

  it('takes 30% off at +2R and locks the stop at +1R', async () => {
    await openLong({ stage: 'PARTIAL_1', quantity: 60 });

    await positionManager.manageOpenPosition({ symbol: 'BTCUSD', price: 104.3 });

    const stored = await Position.findOne({ symbol: 'BTCUSD' });
    expect(stored.stage).toBe('PARTIAL_2');
    expect(stored.quantity).toBe(42); // 60 - floor(60 * 30%) = 60 - 18
    expect(stored.stopLoss).toBe(102); // entry + 1R, never back to break-even-free
  });

  it('trails the stop to the last confirmed swing low and runs the remainder', async () => {
    await openLong({ stage: 'PARTIAL_2', quantity: 42, stopLoss: 102, plan: { bosLevel: 99, tickSize: 0.5, avgBody: 1 } });

    // A confirmed swing low at 103.0 (two lower candles on each side).
    const candles15m = [
      candle({ low: 103.5, close: 104.0 }),
      candle({ low: 103.5, close: 104.0 }),
      candle({ low: 103.5, close: 104.0 }),
      candle({ low: 103.5, close: 104.5 }),
      candle({ low: 103.5, close: 104.5 }),
      candle({ low: 104.0, close: 105.0 }),
      candle({ low: 104.2, close: 105.2 }),
      candle({ low: 103.0, close: 105.0 }), // swing low
      candle({ low: 104.5, close: 106.0 }),
      candle({ low: 104.8, close: 106.2 }),
    ];

    await positionManager.manageOpenPosition({ symbol: 'BTCUSD', price: 106, candles15m });

    const stored = await Position.findOne({ symbol: 'BTCUSD' });
    expect(stored.stage).toBe('RUNNER');
    expect(stored.stopLoss).toBe(102.5); // swing low 103.0 - buffer 0.5
  });

  it('never loosens the trailing stop', async () => {
    await openLong({ stage: 'RUNNER', quantity: 42, stopLoss: 105, plan: { bosLevel: 99, tickSize: 0.5, avgBody: 1 } });

    const candles15m = [
      candle({ low: 103.5, close: 104.0 }),
      candle({ low: 103.5, close: 104.0 }),
      candle({ low: 103.5, close: 104.0 }),
      candle({ low: 103.5, close: 104.5 }),
      candle({ low: 103.5, close: 104.5 }),
      candle({ low: 104.0, close: 105.0 }),
      candle({ low: 104.2, close: 105.2 }),
      candle({ low: 103.0, close: 105.0 }),
      candle({ low: 104.5, close: 106.0 }),
      candle({ low: 104.8, close: 106.2 }),
    ];

    await positionManager.manageOpenPosition({ symbol: 'BTCUSD', price: 106, candles15m });

    const stored = await Position.findOne({ symbol: 'BTCUSD' });
    expect(stored.stopLoss).toBe(105); // a lower swing must not relax the stop
  });

  it('exits on structure failure (two closes back beyond the BOS level)', async () => {
    await openLong({ plan: { bosLevel: 99 } });

    await positionManager.manageOpenPosition({
      symbol: 'BTCUSD',
      price: 100.6,
      candles15m: [candle({ close: 98.4 }), candle({ close: 98.7 })],
    });

    const stored = await Position.findOne({ symbol: 'BTCUSD' });
    expect(stored.status).toBe('closed');
  });

  it('exits a stalled trade that goes nowhere for eight candles', async () => {
    await openLong({
      plan: {},
      openedAt: new Date(Date.now() - 9 * 15 * 60 * 1000),
    });

    await positionManager.manageOpenPosition({ symbol: 'BTCUSD', price: 100.4 });

    const stored = await Position.findOne({ symbol: 'BTCUSD' });
    expect(stored.status).toBe('closed');
  });

  it('leaves a position it cannot manage (no plan) untouched', async () => {
    await openLong({ stopLoss: null, initialStopLoss: null, plan: {} });

    await positionManager.manageOpenPosition({ symbol: 'BTCUSD', price: 150 });

    const stored = await Position.findOne({ symbol: 'BTCUSD' });
    expect(stored.status).toBe('open');
    expect(stored.quantity).toBe(100);
  });
});

describe('positionManager paper end-to-end', () => {
  it('rests a limit entry, fills it on a tick, then manages the plan', async () => {
    const signal = {
      action: 'BUY',
      symbol: 'BTCUSD',
      quantity: 10,
      price: 100,
      orderType: 'limit_order',
      strategyName: 'SweepShift-15',
      stopLoss: 98,
      takeProfit: [
        { price: 102, percent: 40 },
        { price: 104, percent: 30 },
      ],
      meta: { bosLevel: 99, tickSize: 0.5, avgBody: 1 },
    };

    // 1. The entry rests; no position exists yet.
    const placed = await orderManager.execute(signal, { mode: 'paper', fetchReferencePrice: false });
    expect(placed.executed).toBe(true);
    expect(placed.order.status).toBe('open');
    expect(placed.order.averagePrice).toBe(0);
    expect(placed.position).toBeNull();
    expect(await Position.countDocuments()).toBe(0);

    // 2. A tick through the limit fills it and opens the position with its plan.
    expect(await orderManager.handlePaperTick('BTCUSD', 99.9)).toBe(1);

    const position = await Position.findOne({ symbol: 'BTCUSD' });
    expect(position.side).toBe('long');
    expect(position.quantity).toBe(10);
    expect(position.stopLoss).toBe(98);
    expect(position.initialStopLoss).toBe(98);
    expect(position.stage).toBe('OPEN');
    expect(position.plan.bosLevel).toBe(99);

    // 3. The manager takes the first partial once +1R is reached.
    await positionManager.manageOpenPosition({ symbol: 'BTCUSD', price: 102.2 });

    const managed = await Position.findOne({ symbol: 'BTCUSD' });
    expect(managed.stage).toBe('PARTIAL_1');
    expect(managed.quantity).toBe(6); // 10 - floor(10 * 40%) = 10 - 4
  });
});
