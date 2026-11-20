// HFTV1 — a 5-MINUTE fade (mean-reversion) scalper on EVAAUSD.
//
// The rules, as specified:
//   * instruments: EVAAUSD only. evaluate() holds on anything else,
//     so the file can never trade a symbol nobody asked for. To run it, keep the
//     symbols in TRADE_SYMBOLS below in TRADING_SYMBOLS in .env and set
//     ACTIVE_STRATEGY = 'HFTV1' in strategyManager.js.
//   * timeframe  : 5m — the fade levels come from the previous CLOSED 5m candle
//     (the engine's candles5m feed; STRATEGY_CANDLES_5M must be > 0 in .env).
//   * entry      : a FADE of that candle's range — a break of its HIGH opens a
//     SHORT, a break of its LOW opens a LONG. This is the opposite of a breakout
//     follower: the bar is expected to snap back. One trade per 5m bar. Set
//     INVERT_SIGNALS below to flip every side.
//   * exit       : two different rules depending on which side of the fill the
//     mark is on:
//       - RED   -> the loss is booked the instant the mark is on the wrong side
//         of the fill (close at market);
//       - GREEN -> the profit is NOT booked immediately. The trade is held for
//         one minute (timed on the 1m feed) and then closed at the market,
//         i.e. at that 1m candle's close.
//
// So the life of a trade is: the previous 5m candle's high/low arm the bar,
// price pokes through one of them and the fade is opened, a red mark books the
// loss at once, and a green mark is given one minute to run before it is cut at
// the 1m close.
//
// Bar by bar:
//   1. a new 5m candle closes -> its HIGH and LOW become the fade levels for the
//      bar that starts now;
//   2. the first tick that trades through one of them opens the fade — the high
//      is sold, the low is bought;
//   3. red -> close at market immediately; green -> hold one minute, then close
//      at the 1m candle's close.

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
      `HFTV1 5m fade on ${TRADE_SYMBOLS.join(' / ')}: a break of the previous closed 5m candle's ` +
      'high is sold, a break of its low is bought. A red mark books the loss at once; ' +
      'a green mark is held one minute and then closed at the 1m candle close.';
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
    this.lastBarTime = 0; // last closed 5m bar already evaluated (arms the levels)
    this.refHigh = null; // HIGH of that 5m bar — the upside fade level (sell)
    this.refLow = null; // LOW of that 5m bar — the downside fade level (buy)
    this.tradedThisBar = false; // this 5m bar has already produced its trade
    this.entryBarTime1m = 0; // 1m bar time the open trade was first seen at (loss timer)
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
        `HFTV1${INVERT_SIGNALS ? ' inverted' : ''}: price took the ${this.fmt(levelPrice)} 5m ` +
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

    // Fade levels come from the 5m feed; the 1-minute loss timer comes from the
    // 1m feed. The engine fetches both (STRATEGY_CANDLES_5M / STRATEGY_CANDLES_1M).
    const candles5m = Array.isArray(marketData.candles5m) ? marketData.candles5m : [];
    if (candles5m.length < MIN_BARS) {
      return { action: 'HOLD', reason: `warming up (${candles5m.length}/${MIN_BARS} 5m candles)` };
    }

    const last5 = candles5m[candles5m.length - 1];
    if (!last5 || !last5.time) return { action: 'HOLD', reason: 'no closed 5m candle yet' };

    const candles1m = Array.isArray(marketData.candles1m) ? marketData.candles1m : [];
    // The 1-minute loss timer cannot run without the 1m feed, and a losing trade
    // that can never be timed out is worse than no trade. Refuse to act.
    if (!candles1m.length) {
      return {
        action: 'HOLD',
        reason: 'HFTV1 needs the 1m feed for the 1-minute loss timer (set STRATEGY_CANDLES_1M > 0)',
      };
    }
    const last1 = candles1m[candles1m.length - 1];

    // Last market price. The ticker is what the fade is measured against and
    // what the entry/exit really happens at; the closed bar is only a fallback so
    // the value is never missing.
    const price = Number(marketData.price) || Number(last5.close) || 0;

    // A new 5m candle has closed: its HIGH and LOW arm the fade levels for the
    // 5m bar that starts now.
    if (last5.time !== this.lastBarTime) {
      this.lastBarTime = last5.time;
      this.refHigh = Number(last5.high);
      this.refLow = Number(last5.low);
      this.tradedThisBar = false;
      this.lastReason =
        `fade levels armed from the last 5m candle: ${this.fmt(this.refHigh)} high / ${this.fmt(this.refLow)} low`;
    }

    const positions = Array.isArray(state.positions) ? state.positions : [];
    const position = positions[0] || null;

    // --- holding the trade the fade produced -------------------------------
    if (position) {
      const entry = Number(position.entryPrice) || 0;
      const short = position.side === 'short';

      // Remember the 1m bar the trade was first seen on, so the hold timer runs
      // a full minute from the entry.
      if (!this.entryBarTime1m) this.entryBarTime1m = last1.time;

      if (entry > 0 && price > 0) {
        // 1. RED -> book the loss right now, at market.
        const inLoss = short ? price > entry : price < entry;
        if (inLoss) {
          return {
            action: 'CLOSE',
            symbol: this.symbol,
            strategyName: this.name,
            reason:
              `loss booked immediately: ${position.side} entered at ${this.fmt(entry)}, ` +
              `mark ${this.fmt(price)} is red`,
          };
        }

        // 2. GREEN (or dead flat) -> keep the profit on for one full minute,
        //    then close at the 1m candle's close. A newer 1m bar time = a
        //    minute gone.
        const heldOneMinute = this.entryBarTime1m && last1.time > this.entryBarTime1m;
        if (heldOneMinute) {
          return {
            action: 'CLOSE',
            symbol: this.symbol,
            strategyName: this.name,
            reason:
              `profit held 1m: ${position.side} entered at ${this.fmt(entry)}, mark ${this.fmt(price)} green — ` +
              `closed at the ${this.fmt(last1.close)} 1m close`,
          };
        }
      }

      return {
        action: 'HOLD',
        reason: `holding ${position.side} in the green, giving it up to 1m; ${this.lastReason}`,
      };
    }

    // Flat -> the entry timer only means anything while a trade is open.
    this.entryBarTime1m = 0;

    // --- flat: wait for one of the fade levels to break ---------------------
    if (price <= 0) return { action: 'HOLD', reason: 'no live price' };
    if (this.tradedThisBar) {
      return { action: 'HOLD', reason: 'this 5m bar has already traded' };
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
