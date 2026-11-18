// manual_trade — a "random entry, instant exit" strategy.
//
// What it does:
//   * whenever the account is FLAT (no open position and no working entry) it
//     opens ONE random trade — a coin flip between a long (BUY) and a short
//     (SELL), market order. Entries fire promptly: a random 0-10s delay, then
//     the trade is sent.
//   * once open, the trade is managed by P&L:
//       - RED   (the mark moved against the entry) -> cut it immediately (CLOSE).
//       - GREEN (the mark moved in favour)         -> take the profit (CLOSE).
//     The thresholds are STOP_LOSS_PCT / TAKE_PROFIT_PCT below; both default to
//     0, i.e. close on the first tick that is red or green — whichever comes.
//   * with the position closed, the account is flat again and it re-arms.
//
// The exits are strategy-driven: on a CLOSE the engine calls
// positionManager.closePosition, which sends a reduce-only market order. No
// stop or target is rested on Delta — no other part of the engine exits a trade.
//
// To run it: set ACTIVE_STRATEGY = 'ManualTrade' in src/strategies/strategyManager.js
// (already wired) and restart the server. The symbol comes from .env
// (TRADING_SYMBOL / TRADING_SYMBOLS); see TRADE_SYMBOLS below to pin a whitelist.

const { normalizeSymbol } = require('../../utils/helpers');
const logger = require('../../utils/logger');

// The instruments this strategy may trade. Empty = any instrument the engine is
// running on. Fill it (e.g. ['BTCUSD']) to pin it to a whitelist.
const TRADE_SYMBOLS = [];

// Random delay before an entry, picked once per flat stretch. Kept short so a
// trade is placed almost immediately after the account goes flat, while still
// being random rather than fixed.
const MIN_WAIT_MS = 0;
const MAX_WAIT_MS = 10 * 1000;

// After an entry is sent, ignore the strategy for this long. A live market order
// should already have created the position by the next cycle, but this covers
// the gap so a single signal can never open two trades.
const ENTRY_SETTLE_MS = 30 * 1000;

// Order size in CONTRACTS (Delta "lots").
//   > 0 -> that exact size, and it WINS over STRATEGY_FIXED_CONTRACTS in .env.
//   = 0 -> fall back to STRATEGY_FIXED_CONTRACTS, then to equity sizing.
// Keep it inside RISK_MAX_ORDER_QUANTITY / RISK_MAX_POSITION_SIZE.
const LOTS = 1;

// Daily-loss kill switch for THIS strategy only (see the other strategies).
//   false -> keep opening trades no matter what the day's P&L is.
const HALT_ON_DAILY_LOSS = false;

// Flips the coin-flip entry:
//   false -> take the random side as-is (a random long stays long).
//   true  -> take the OPPOSITE of the random side (a random long becomes a
//            short and vice versa). Handy to test the other side, or when the
//            account is stuck in one direction.
const INVERT_SIGNALS = true;

// Exit thresholds, as a PERCENT of the entry price. The moment the trade's move
// (measured in the position's own direction) crosses either one it is closed:
//   STOP_LOSS_PCT   : 0 -> cut the instant the trade is RED (never let a loss run)
//   TAKE_PROFIT_PCT : 0 -> take profit the instant the trade is GREEN
// Both default to 0, so any non-flat tick exits. Raise them to require that much
// movement before the exit fires (e.g. 0.2 = close after a 0.2% move).
const STOP_LOSS_PCT = 0;
const TAKE_PROFIT_PCT = 0;

// How often the "nothing to do" status line is printed, at most.
const LOG_THROTTLE_MS = 20 * 1000;

class ManualTrade {
  constructor() {
    this.name = 'ManualTrade';
    this.description =
      'Random entry (coin-flip BUY/SELL) whenever the account is flat, market order. ' +
      'Exits are managed by P&L: a red mark is cut immediately, a green mark takes profit.';
    // Left blank on purpose: the engine sets this from .env on start.
    this.symbol = null;

    // --- exchange facts, filled in by the engine (applyProductSettings) ---
    this.tickSize = 0.0001;
    this.contractValue = 1;
    this.equity = 1000;
    this.maxNotionalEquity = 3;
    this.minContracts = 1;
    // Explicit lot size — see the LOTS constant above.
    this.fixedContracts = Math.max(0, Math.floor(LOTS));
    this.maxConcurrentPositions = 1;
    this.leverage = 1;
    // Only used when LOTS is 0 (percent_of_equity fallback).
    this.notionalPercent = 0.1;

    this.reset();
  }

  getName() {
    return this.name;
  }

  newInstance() {
    return new ManualTrade();
  }

  reset() {
    this.nextEntryAtMs = 0; // when the next random entry becomes due (0 = reschedule)
    this.entrySentAt = 0; // when the last entry was sent (settle guard)
    this.lastReason = '';
    this.lastLogAt = 0;
  }

  // percent_of_equity sizing (10% of equity notional), floored at the exchange
  // minimum. An explicit lot size (LOTS, else STRATEGY_FIXED_CONTRACTS) bypasses
  // the maths entirely.
  sizeContracts(entry) {
    const fixed = Number(this.fixedContracts) || 0;
    if (fixed > 0) return Math.max(1, Math.floor(fixed));

    const price = Number(entry);
    const contractValue = Number(this.contractValue) || 0.001;
    if (!(price > 0)) return Math.max(1, Number(this.minContracts) || 1);

    const notional = (Number(this.equity) || 0) * this.notionalPercent;
    const size = Math.floor(notional / (price * contractValue));
    return Math.max(Number(this.minContracts) || 1, size);
  }

  // Formats a price for log/reason strings at the product's own precision.
  fmt(price) {
    const tick = Number(this.tickSize) || 0;
    const decimals = tick > 0 ? (String(tick).split('.')[1] || '').length : 2;
    return Number(price).toFixed(decimals);
  }

  // Prints why the strategy is standing down, throttled so the console is not
  // flooded (the engine runs evaluate() every few seconds).
  note(reason) {
    const now = Date.now();
    if (reason === this.lastReason && now - this.lastLogAt < LOG_THROTTLE_MS) return;
    this.lastReason = reason;
    this.lastLogAt = now;
    logger.info(`manual_trade (${this.symbol || '?'}): ${reason}`);
  }

  // One random market entry. `side` is 'long' or 'short', already coin-flipped
  // by the caller. No stop and no target are attached — the exit is yours.
  buildEntry(side, price) {
    const quantity = this.sizeContracts(price);
    if (!(quantity > 0)) {
      this.note('size rounds to zero contracts');
      return { action: 'HOLD', reason: 'size rounds to zero contracts' };
    }

    this.entrySentAt = Date.now();
    this.nextEntryAtMs = 0;
    this.note(`entering random ${side} (${quantity} contract(s)) at market`);

    return {
      action: side === 'long' ? 'BUY' : 'SELL',
      symbol: this.symbol,
      quantity,
      orderType: 'market_order',
      strategyName: this.name,
      reason:
        `manual_trade random ${side}: coin-flip entry of ${quantity} contract(s) at market — ` +
        'close it by hand on Delta',
      meta: {
        // Exits are manual, not a resting bracket and not strategy-driven.
        exitMode: 'manual',
        family: 'manual-trade',
        haltOnDailyLoss: HALT_ON_DAILY_LOSS,
      },
    };
  }

  evaluate(marketData = {}, state = {}) {
    // A whitelist, when set, is the only gate — never trade outside it.
    if (TRADE_SYMBOLS.length && !TRADE_SYMBOLS.includes(normalizeSymbol(this.symbol))) {
      this.note(`manual_trade trades ${TRADE_SYMBOLS.join(', ')} only`);
      return { action: 'HOLD', reason: `manual_trade trades ${TRADE_SYMBOLS.join(', ')} only` };
    }

    const candles = Array.isArray(marketData.candles1m) ? marketData.candles1m : [];
    const last = candles[candles.length - 1];
    const price = Number(marketData.price) || Number(last && last.close) || 0;

    const positions = Array.isArray(state.positions) ? state.positions : [];
    const position = positions[0] || null;

    // --- holding a trade: manage the exit by P&L ----------------------------
    if (position) {
      // Clear the settle guard so the next flat cycle can schedule a fresh entry.
      this.entrySentAt = 0;

      const entry = Number(position.entryPrice) || 0;
      if (entry > 0 && price > 0) {
        // Move measured in the position's own direction: + = green, - = red.
        const dir = position.side === 'short' ? -1 : 1;
        const movePct = ((price - entry) / entry) * 100 * dir;

        // RED -> cut it immediately.
        if (movePct < -STOP_LOSS_PCT) {
          return {
            action: 'CLOSE',
            symbol: this.symbol,
            strategyName: this.name,
            reason:
              `cut red: ${position.side} is ${movePct.toFixed(3)}% against entry ${this.fmt(entry)} ` +
              `(mark ${this.fmt(price)}) — closing`,
          };
        }

        // GREEN -> take the profit.
        if (movePct > TAKE_PROFIT_PCT) {
          return {
            action: 'CLOSE',
            symbol: this.symbol,
            strategyName: this.name,
            reason:
              `take profit: ${position.side} is +${movePct.toFixed(3)}% from entry ${this.fmt(entry)} ` +
              `(mark ${this.fmt(price)}) — closing`,
          };
        }
      }

      this.note(`holding ${position.side} — managing the exit`);
      return { action: 'HOLD', reason: `holding ${position.side} — managing the exit` };
    }

    // --- flat: open one random trade ----------------------------------------
    // An entry was just sent but the position has not shown up yet; stand down.
    if (this.entrySentAt && Date.now() - this.entrySentAt < ENTRY_SETTLE_MS) {
      this.note('entry just sent — waiting for the position to open');
      return { action: 'HOLD', reason: 'entry just sent — waiting for the position to open' };
    }

    if (!(price > 0)) {
      this.note('no live price yet');
      return { action: 'HOLD', reason: 'no live price' };
    }
    if (state.hasLiveOrder) {
      this.note('an entry is already working');
      return { action: 'HOLD', reason: 'an entry is already working' };
    }

    // Pick the next entry time once per flat stretch (not every cycle), so the
    // wait is a real random delay instead of the minimum of many rolls.
    if (!this.nextEntryAtMs) {
      this.nextEntryAtMs =
        Date.now() + MIN_WAIT_MS + Math.floor(Math.random() * Math.max(1, MAX_WAIT_MS - MIN_WAIT_MS));
    }

    const msLeft = this.nextEntryAtMs - Date.now();
    if (msLeft > 0) {
      this.note(`next random entry in ${Math.ceil(msLeft / 1000)}s`);
      return { action: 'HOLD', reason: `next random entry in ${Math.ceil(msLeft / 1000)}s` };
    }

    // Coin flip: 50/50 long or short, then flipped when INVERT_SIGNALS is on.
    const flip = Math.random() < 0.5 ? 'long' : 'short';
    const side = INVERT_SIGNALS ? (flip === 'long' ? 'short' : 'long') : flip;
    return this.buildEntry(side, price);
  }
}

module.exports = new ManualTrade();
