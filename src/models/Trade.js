const mongoose = require('mongoose');

// A trade is the "round trip" record: entry, exit and the resulting PnL.
// The daily-loss risk check reads PnL from this collection.
const tradeSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    symbol: { type: String, required: true, uppercase: true, index: true },

    side: { type: String, enum: ['buy', 'sell'], required: true },
    quantity: { type: Number, required: true, min: 0 },
    entryPrice: { type: Number, required: true, min: 0 },
    exitPrice: { type: Number, default: null },

    pnl: { type: Number, default: 0 },
    status: { type: String, enum: ['open', 'closed'], default: 'open', index: true },

    entryOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
    exitOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },

    strategyName: { type: String, default: 'manual' },
    mode: { type: String, enum: ['paper', 'live'], default: 'paper' },

    entryAt: { type: Date, default: Date.now },
    exitAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Trade', tradeSchema);
