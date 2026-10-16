const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const Order = require('../src/models/Order');
const orderManager = require('../src/services/trading/orderManager');

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
  await Order.deleteMany({});
});

const signal = { action: 'BUY', symbol: 'BTCUSD', quantity: 1, price: 100, strategyName: 'T' };
const options = { mode: 'paper', fetchReferencePrice: false };

it('places the order when nothing is live', async () => {
  const result = await orderManager.execute(signal, options);
  expect(result.executed).toBe(true);
});

it('blocks a new order while another one is still live', async () => {
  await Order.create({
    symbol: 'BTCUSD',
    side: 'buy',
    quantity: 1,
    status: 'open',
    mode: 'live',
    clientOrderId: 'live-1',
  });

  const result = await orderManager.execute(signal, options);

  expect(result.executed).toBe(false);
  expect(result.reason).toMatch(/already live/i);
  expect(await Order.countDocuments()).toBe(1);
});

it('allows an order for a different symbol', async () => {
  await Order.create({
    symbol: 'ETHUSD',
    side: 'buy',
    quantity: 1,
    status: 'partially_filled',
    mode: 'live',
    clientOrderId: 'live-2',
  });

  const result = await orderManager.execute(signal, options);
  expect(result.executed).toBe(true);
});
