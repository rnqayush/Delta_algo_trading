const mongoose = require('mongoose');

// Current trading position for one symbol.
const positionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    symbol: { type: String, required: true, uppercase: true, index: true },
    productId: { type: Number, default: null },

    side: { type: String, enum: ['long', 'short'], required: true },
    quantity: { type: Number, required: true, min: 0 },
    entryPrice: { type: Number, default: 0 },
    currentPrice: { type: Number, default: 0 },
    unrealizedPnl: { type: Number, default: 0 },
    realizedPnl: { type: Number, default: 0 },

    status: { type: String, enum: ['open', 'closed'], default: 'open', index: true },
    mode: { type: String, enum: ['paper', 'live'], default: 'paper' },
    strategyName: { type: String, default: 'manual' },

    // Trade-management plan (set when the entry fills). The stop is a real
    // price level; `stage` tracks which partial exits have already fired.
    stopLoss: { type: Number, default: null },
    initialStopLoss: { type: Number, default: null },
    takeProfit: { type: [{ price: Number, percent: Number }], default: [] },
    riskPerUnit: { type: Number, default: null },
    stage: { type: String, enum: ['OPEN', 'PARTIAL_1', 'PARTIAL_2', 'RUNNER'], default: 'OPEN' },
    plan: { type: mongoose.Schema.Types.Mixed, default: {} },

    openedAt: { type: Date, default: Date.now },
    closedAt: { type: Date, default: null },
    lastSyncedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Position', positionSchema);
