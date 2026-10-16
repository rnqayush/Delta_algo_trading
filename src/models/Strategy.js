const mongoose = require('mongoose');

// Stores the strategies that the bot knows about and whether they are running.
// The strategy code itself lives in src/strategies, not in the database.
const strategySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    description: { type: String, default: '' },
    symbols: { type: [String], default: [] },
    enabled: { type: Boolean, default: true },
    status: { type: String, enum: ['stopped', 'running', 'error'], default: 'stopped' },
    mode: { type: String, enum: ['paper', 'live'], default: 'paper' },
    params: { type: mongoose.Schema.Types.Mixed, default: {} },
    lastSignal: { type: mongoose.Schema.Types.Mixed, default: null },
    lastStartedAt: { type: Date, default: null },
    lastStoppedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Strategy', strategySchema);
