const mongoose = require('mongoose');

// One document per order. In paper mode there is no deltaOrderId because the
// order never reached Delta Exchange.
const orderSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    deltaOrderId: { type: String, default: null },
    clientOrderId: { type: String, index: true },
    symbol: { type: String, required: true, uppercase: true, index: true },
    productId: { type: Number, default: null },

    side: { type: String, enum: ['buy', 'sell'], required: true },
    orderType: { type: String, default: 'market_order' },
    quantity: { type: Number, required: true, min: 0 },
    price: { type: Number, default: 0 },
    averagePrice: { type: Number, default: 0 },

    status: {
      type: String,
      enum: ['pending', 'open', 'partially_filled', 'filled', 'cancelled', 'rejected', 'failed'],
      default: 'pending',
      index: true,
    },
    mode: { type: String, enum: ['paper', 'live'], default: 'paper' },

    // Bracket / trade-plan data. A protective stop is stored as its own order
    // with purpose 'stop' and a link back to the entry via parentOrderId.
    purpose: { type: String, default: 'entry' },
    parentOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
    reduceOnly: { type: Boolean, default: false },
    stopLoss: { type: Number, default: null },
    takeProfit: { type: [{ price: Number, percent: Number }], default: [] },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
    // When set, a resting order is cancelled if it has not filled by this time.
    expiresAt: { type: Date, default: null },

    strategyName: { type: String, default: 'manual' },
    reason: { type: String, default: '' },
    deltaStatus: { type: String, default: null },
    errorMessage: { type: String, default: null },

    filledAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Order', orderSchema);
