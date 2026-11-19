// HFTV1 — a 1-MINUTE fade (mean-reversion) scalper on EVAAUSD.
//
// The rules, as specified:
//   * instruments: EVAAUSD only. evaluate() holds on anything else,
//     so the file can never trade a symbol nobody asked for. To run it, keep the
//     symbols in TRADE_SYMBOLS below in TRADING_SYMBOLS in .env and set
//     ACTIVE_STRATEGY = 'HFTV1' in strategyManager.js.
//   * timeframe  : 1m.
//   * entry      : a FADE of the previous CLOSED 1m candle's range — a break of
//     its HIGH opens a SHORT, a break of its LOW opens a LONG. This is the
//     opposite of a breakout follower: the bar is expected to snap back.
//     One trade per bar. Set INVERT_SIGNALS below to flip every side.
//   * exit       : book the result the instant the trade moves — the moment the
//     mark leaves the fill the position is flattened at market, the profit
//     booked when it is green and the loss booked when it is red.
//
// So the life of a trade is: the previous candle's high/low arm the bar, price
// pokes through one of them and the fade is opened, and the trade is cut the
// instant the mark leaves the fill — green books the profit, red books the loss.
//
// Bar by bar:
//   1. a new 1m candle closes -> its HIGH and LOW become the fade levels for the
//      bar that starts now;
//   2. the first tick that trades through one of them opens the fade — the high
//      is sold, the low is bought;
//   3. the trade is flattened the instant the mark is off the fill — the profit
//      booked when green, the loss booked when red.

const { normalizeSymbol } = require('../../utils/helpers');

// The instruments this strategy may trade. One instance is built per symbol that
// TRADING_SYMBOLS in .env tracks, each carrying its own `symbol`, so this list is
// the only gate: a symbol outside it is simply held.
const TRADE_SYMBOLS = ['EVAAUSD'];

// A few bars just guarantee the feed is genuinely warm before the first entry.
const MIN_BARS = 5;

// Daily-loss kill switch for THIS strategy only.
//   true  -> obey RISK_MAX_DAILY_LOSS: once the day's realised loss crosses the
//            cap every order for this strategy is rejected ("Trading is halted
//            for today").
//   false -> keep trading no matter what the day's P&L is. Nothing else in the
//            risk manager is relaxed — only the daily-loss check.
const HALT_ON_DAILY_LOSS = false;

// Flip every signal without touching any of the rules:
//   false -> the fade as specified above: a break of the high is SOLD and a
//            break of the low is BOUGHT.
//   true  -> the signals are inverted: a break of the high is BOUGHT and a break
//            of the low is SOLD (i.e. it behaves as a breakout follower).
// Only the order side flips — the levels, the sizing and the exits are unchanged.
const INVERT_SIGNALS = false;

// Order size in CONTRACTS (Delta "lots"). This is the size the fade entry
// sends:
//   > 0 -> that exact number of contracts, and it WINS over
//          STRATEGY_FIXED_CONTRACTS in .env (which is ignored for this strategy).
//   = 0 -> fall back to STRATEGY_FIXED_CONTRACTS, and if that is 0 as well, size
//          from percent_of_equity (10% notional), floored at minContracts.
// Keep it inside RISK_MAX_ORDER_QUANTITY / RISK_MAX_POSITION_SIZE or the risk
// manager will reject the order.
const LOTS = 1;

// ---------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------

class HftV1 {
  constructor() {
    this.name = 'HFTV1';
    this.description =
      `HFTV1 1m fade on ${TRADE_SYMBOLS.join(' / ')}: a break of the previous closed candle's ` +
      'high is sold, a break of its low is bought. The trade is flattened the ' +
      'instant the mark leaves the fill — the profit booked when green, the loss ' +
      'booked when red.';
    // Left blank on purpose: the engine sets this to the instrument this instance
    // was built for on start (see tradingEngine.applyProductSettings), so the
    // instrument is configured in one place — .env — and can never disagree with
    // the WebSocket feed. evaluate() then refuses to act on anything outside
    // TRADE_SYMBOLS.
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
    // The account's leverage for the instrument, read from Delta at startup.
    this.leverage = 1;

    // Only used when LOTS is 0 (percent_of_equity fallback).
    this.notionalPercent = 0.1;

    this.reset();
  }

  getName() {
    return this.name;
  }

  // A fresh instance carrying the same settings but its own bar/trade state.
  // The engine builds one per instrument when TRADING_SYMBOLS tracks several at
  // once, because the reference candle and the trade state are per instrument.
  newInstance() {
    return new HftV1();
  }

  reset() {
    this.lastBarTime = 0; // last closed 1m bar already evaluated
    this.refHigh = null; // HIGH of that bar — the upside fade level (sell)
    this.refLow = null; // LOW of that bar — the downside fade level (buy)
    this.tradedThisBar = false; // this bar has already produced its trade
    this.lastReason = '';
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

  // One fade entry. A market order: the level has already been taken, so the
  // fill is the whole point of the trade. `level` is which level armed it
  // ('high' or 'low') and `levelPrice` its price, so the reason stays honest
  // when INVERT_SIGNALS flips the side. This marks the bar as traded so a cut
  // cannot immediately re-arm the same fade.
  buildEntry(side, price, level, levelPrice) {
    const quantity = this.sizeContracts(price);
    if (!(quantity > 0)) return { action: 'HOLD', reason: 'size rounds to zero contracts' };

    this.tradedThisBar = true;

    return {
      action: side === 'sell' ? 'SELL' : 'BUY',
      symbol: this.symbol,
      quantity,
      orderType: 'market_order',
      strategyName: this.name,
      reason:
        `HFTV1${INVERT_SIGNALS ? ' inverted' : ''}: price took the ${this.fmt(levelPrice)} 1m ` +
        `${level} — ${side === 'sell' ? 'shorting' : 'buying'}`,
      meta: {
        // The exits are strategy-driven, not a resting bracket.
        exitMode: 'signal',
        family: 'hftv1',
        // Carried into the risk context so the daily-loss cap can be opted out
        // of for this strategy (see HALT_ON_DAILY_LOSS above).
        haltOnDailyLoss: HALT_ON_DAILY_LOSS,
      },
    };
  }

  evaluate(marketData = {}, state = {}) {
    // Only the whitelisted instrument — EVAAUSD — is ever traded by this file.
    if (!TRADE_SYMBOLS.includes(normalizeSymbol(this.symbol))) {
      return {
        action: 'HOLD',
        reason:
          `HFTV1 trades ${TRADE_SYMBOLS.join(', ')} only (this engine is on ` +
          `${this.symbol || 'no symbol'})`,
      };
    }

    const candles = Array.isArray(marketData.candles1m) ? marketData.candles1m : [];
    if (candles.length < MIN_BARS) {
      return { action: 'HOLD', reason: `warming up (${candles.length}/${MIN_BARS} 1m candles)` };
    }

    const last = candles[candles.length - 1];
    if (!last || !last.time) return { action: 'HOLD', reason: 'no closed 1m candle yet' };

    // Last market price. The ticker is what the fade is measured against and
    // what the entry/exit really happens at; the closed bar is only a fallback so
    // the value is never missing.
    const price = Number(marketData.price) || Number(last.close) || 0;

    // A new 1m candle has closed: its HIGH and LOW arm the fade levels for the
    // bar that starts now.
    let newBar = false;
    if (last.time !== this.lastBarTime) {
      newBar = true;
      this.lastBarTime = last.time;
      this.refHigh = Number(last.high);
      this.refLow = Number(last.low);
      this.tradedThisBar = false;
      this.lastReason =
        `fade levels armed: ${this.fmt(this.refHigh)} high / ${this.fmt(this.refLow)} low`;
    }

    const positions = Array.isArray(state.positions) ? state.positions : [];
    const position = positions[0] || null;

    // --- holding the trade the fade produced -------------------------------
    if (position) {
      const entry = Number(position.entryPrice) || 0;
      const short = position.side === 'short';

      if (entry > 0 && price > 0) {
        // 1. Immediate profit -> book it the instant the mark is on the right
        // side of the fill.
        const inProfit = short ? price < entry : price > entry;
        // 2. Immediate loss -> book it the instant the mark is on the wrong side.
        const inLoss = short ? price > entry : price < entry;

        if (inProfit || inLoss) {
          return {
            action: 'CLOSE',
            symbol: this.symbol,
            strategyName: this.name,
            reason: inProfit
              ? `profit booked: ${position.side} entered at ${this.fmt(entry)}, mark ${this.fmt(price)} is green`
              : `loss booked: ${position.side} entered at ${this.fmt(entry)}, mark ${this.fmt(price)} is red`,
          };
        }

        // 3. Mark still exactly on the fill at a candle close -> flatten there
        //    rather than sit on a dead-flat trade.
        if (newBar) {
          return {
            action: 'CLOSE',
            symbol: this.symbol,
            strategyName: this.name,
            reason:
              `flat close: ${position.side} entered at ${this.fmt(entry)}, mark unmoved — ` +
              `closed at the ${this.fmt(last.close)} candle close`,
          };
        }
      }

      return { action: 'HOLD', reason: `holding ${position.side}; ${this.lastReason}` };
    }

    // --- flat: wait for one of the fade levels to break ---------------------
    if (price <= 0) return { action: 'HOLD', reason: 'no live price' };
    if (this.tradedThisBar) {
      return { action: 'HOLD', reason: 'this 1m bar has already traded' };
    }

    // Which level broke. Left = the fade side; INVERT_SIGNALS then flips it.
    let level = null;
    let levelPrice = 0;
    if (this.refHigh > 0 && price > this.refHigh) {
      level = 'high';
      levelPrice = this.refHigh;
    } else if (this.refLow > 0 && price < this.refLow) {
      level = 'low';
      levelPrice = this.refLow;
    }

    if (level) {
      const fadeSide = level === 'high' ? 'sell' : 'buy';
      const side = INVERT_SIGNALS ? (fadeSide === 'sell' ? 'buy' : 'sell') : fadeSide;
      return this.buildEntry(side, price, level, levelPrice);
    }

    return { action: 'HOLD', reason: `no fade level yet; ${this.lastReason}` };
  }
}

module.exports = new HftV1();
