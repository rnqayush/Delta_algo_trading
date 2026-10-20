// Manual smoke test for LIVE order placement against Delta Exchange.
//
// WHAT IT DOES
//   1. Refuses to run unless live trading is properly enabled.
//   2. Reads the live BTCUSD book.
//   3. Places ONE resting limit BUY a couple of percent BELOW the market, so it
//      sits on the book instead of filling, through the normal order path
//      (concurrency gate -> risk check -> tick-size snap -> Delta -> MongoDB).
//   4. Prints the Delta order id and the MongoDB document that was stored.
//   5. Cancels the order again, so nothing is left open.
//
//   If, against the odds, the order fills in the few seconds it is alive, the
//   script closes it again with a reduce-only market order.
//
// HOW TO RUN
//   1. In .env make sure you have
//        TRADING_MODE=live
//        ENABLE_LIVE_TRADING=true
//        DELTA_API_KEY / DELTA_API_SECRET set
//      and that this machine's IP is whitelisted on the Delta API key.
//   2. Uncomment the run line at the very bottom of this file.
//   3. node scripts/test-live-order.js

const mongoose = require('mongoose');

const config = require('../src/config/env');
const logger = require('../src/utils/logger');
const Order = require('../src/models/Order');
const marketService = require('../src/services/delta/marketService');
const orderManager = require('../src/services/trading/orderManager');

// How far below the last traded price the test limit sits. Must stay under
// RISK_MAX_PRICE_DEVIATION_PERCENT (5) or the risk check rejects it before it
// ever reaches Delta.
const PRICE_OFFSET_PERCENT = 2;

// How long to wait before checking whether the resting order was filled.
const FILL_CHECK_DELAY_MS = 3000;

// true  = cancel the test order again (nothing is left on Delta) — default.
// false = LEAVE the order resting so you can see it in the app under
//         "Open Orders". Cancel it there afterwards, otherwise it keeps
//         occupying a concurrency slot.
const CANCEL_AFTER_TEST = false;

function printSummary(lines) {
  console.log('\n---------------- live order test ----------------');
  for (const line of lines) console.log(`  ${line}`);
  console.log('-------------------------------------------------\n');
}

// Closes a position that the test order accidentally opened.
async function closeAccidentallyFilledPosition(order) {
  logger.warn('The test order filled — closing it again with a reduce-only market order');

  await orderManager.execute(
    {
      action: order.side === 'buy' ? 'SELL' : 'BUY',
      symbol: order.symbol,
      quantity: order.quantity,
      orderType: 'market_order',
      strategyName: 'live-order-test',
      reason: 'Cleanup after the live order placement test',
    },
    { mode: 'live', reduceOnly: true }
  );
}

async function testLiveOrder() {
  // --- Guard rails: never place a real order by accident -------------------
  const problems = config.validateConfig();
  for (const problem of problems) logger.warn(`Configuration: ${problem}`);

  if (!config.trading.isLive) {
    printSummary([
      'Live trading is DISABLED — nothing was sent to Delta.',
      'Set TRADING_MODE=live and ENABLE_LIVE_TRADING=true in .env, then run again.',
    ]);
    return;
  }
  if (!config.delta.apiKey || !config.delta.apiSecret) {
    printSummary(['Delta API keys are missing in .env — nothing was sent.']);
    return;
  }

  const symbol = config.trading.symbol;
  // Use the same size the bot itself would use.
  const quantity = Math.max(1, Number(config.strategy.fixedContracts) || 1);

  await mongoose.connect(config.mongoUri);
  logger.info(`MongoDB connected: ${mongoose.connection.name}`);

  try {
    const product = await marketService.getProduct(symbol);
    const ticker = await marketService.getTicker(symbol);

    const quotes = ticker.quotes || {};
    const ltp = Number(ticker.close ?? ticker.mark_price ?? quotes.best_ask ?? 0);
    if (!ltp) throw new Error(`Could not read a live price for ${symbol}`);

    // A buy limit below the market rests on the book instead of filling.
    const rawPrice = ltp * (1 - PRICE_OFFSET_PERCENT / 100);

    printSummary([
      `symbol          ${symbol} (product id ${product.id})`,
      `live price      ${ltp}`,
      `test limit buy  ~${rawPrice.toFixed(2)} (${PRICE_OFFSET_PERCENT}% below market)`,
      `size            ${quantity} contract(s)`,
    ]);

    const result = await orderManager.execute(
      {
        action: 'BUY',
        symbol,
        quantity,
        orderType: 'limit_order',
        price: rawPrice,
        strategyName: 'live-order-test',
        reason: 'Manual live order placement smoke test',
      },
      { mode: 'live' }
    );

    if (!result.executed) {
      // Blocked by the concurrency gate or the risk manager — Delta was never
      // called, so this is NOT a placement failure. The reason says why.
      printSummary(['Order was NOT sent to Delta.', `Reason: ${result.reason}`]);
      return;
    }

    const order = result.order;
    logger.info(
      `Order accepted by Delta: id=${order.deltaOrderId} status=${order.status} ` +
        `price=${order.price} qty=${order.quantity}`
    );

    await new Promise((resolve) => setTimeout(resolve, FILL_CHECK_DELAY_MS));

    const stored = await Order.findById(order._id);
    const storedState = stored ? stored.status : 'missing from MongoDB';

    if (stored && stored.status === 'filled') {
      await closeAccidentallyFilledPosition(stored);
      printSummary([
        `delta order id  ${stored.deltaOrderId}`,
        'status          filled (closed again with a reduce-only order)',
        'LIVE PLACEMENT: WORKING',
      ]);
      return;
    }

    // Happy path: cancel the resting order again (unless you want to see it
    // stay open in the app).
    if (!CANCEL_AFTER_TEST) {
      printSummary([
        `delta order id  ${order.deltaOrderId}`,
        `limit price     ${order.price}`,
        `mongo id        ${order._id}`,
        '',
        'Order LEFT OPEN on Delta (CANCEL_AFTER_TEST = false).',
        'It should now be visible in the app under Open Orders.',
        'Cancel it in the app, or set CANCEL_AFTER_TEST = true and run again.',
      ]);
      return;
    }

    await orderManager.cancelOrder({ orderId: stored ? stored._id : order._id });

    printSummary([
      `delta order id  ${order.deltaOrderId}`,
      `mongo id        ${order._id}`,
      `mongo status    ${storedState} -> cancelled`,
      '',
      'LIVE PLACEMENT: WORKING (order was accepted, stored, and cancelled)',
    ]);
  } finally {
    await mongoose.disconnect();
    logger.info('MongoDB disconnected');
  }
}

// ---------------------------------------------------------------------------
// UNCOMMENT THE LINE BELOW TO RUN THE TEST.
// ---------------------------------------------------------------------------
// testLiveOrder()
//   .then(() => process.exit(0))
//   .catch((error) => {
//     logger.error(`Live order test failed: ${error.message}`);
//     process.exit(1);
//   });

  // command to run test order>>>>> node scripts/test-live-order.js