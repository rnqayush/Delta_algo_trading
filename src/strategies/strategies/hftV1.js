// HFTV1 — a 1-MINUTE breakout scalper on EVAAUSD.
//
// The rules, as specified:
//   * instruments: EVAAUSD only. evaluate() holds on anything else,
//     so the file can never trade a symbol nobody asked for. To run it, keep the
//     symbols in TRADE_SYMBOLS below in TRADING_SYMBOLS in .env and set
//     ACTIVE_STRATEGY = 'HFTV1' in strategyManager.js.
//   * timeframe  : 1m.
//   * entry      : a BREAKOUT of the previous CLOSED 1m candle's HIGH or LOW —
//     price above that high opens a BUY, price below that low opens a SELL. One
//     trade per bar.
//   * exit       : a real stop and a real target, both placed at entry and both
//     a PERCENT of the fill — the target further out than the stop, so one
//     winner pays for more than one loser. Whichever price touches first is
//     flattened at market. If neither is touched within MAX_HOLD_BARS candles
//     the trade is flattened on that candle's close (the time stop).
//
// So the life of a trade is: the previous candle's high/low arm the bar, price
// takes one of the two levels, and the trade then runs to its stop, its target,
// or the time stop — whichever comes first.
//
// Bar by bar:
//   1. a new 1m candle closes -> its HIGH and LOW become the breakout levels for
//      the bar that starts now;
//   2. the first tick that trades through one of them opens the trade and fixes
//      its stop (STOP_PCT) and target (TARGET_PCT);
//   3. the trade is flattened the moment price touches the stop or the target,
//      otherwise on the close of the MAX_HOLD_BARS'th candle after entry.

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

// --- exit model: a stop, a target and a time stop --------------------------
// The earlier rules (flatten the instant the trade went green, or the instant
// it went red) fired on a single tick. That leaves no room: the average loser
// came out about the size of the average winner, so the sum only ever bled fees.
// This replaces both with a bracket measured in PERCENT of the fill:
//
//   stop   : STOP_PCT% against the fill  — the loss a loser is allowed to run
//   target : TARGET_PCT% with the fill   — the profit a winner is asked to make
//   time   : flattened on the close of the MAX_HOLD_BARS'th candle after entry
//
// Keep TARGET_PCT > STOP_PCT — that is the whole point, a winner has to pay for
// more than one loser. e.g. STOP 2 / TARGET 6 means one win covers ~3 losses
// before fees, i.e. the break-even win rate is STOP / (STOP + TARGET) = 25%.
const STOP_PCT = 2;      // % adverse move that stops the trade out
const TARGET_PCT = 6;    // % favourable move that books the profit (keep > STOP_PCT)
const MAX_HOLD_BARS = 60; // candles a trade may live before the time stop

// Order size in CONTRACTS (Delta "lots"). This is the size the breakout entry
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
      `HFTV1 1m breakout on ${TRADE_SYMBOLS.join(' / ')}: a break of the previous closed candle's ` +
      'high buys, a break of its low sells. Each trade carries a stop and a ' +
      'target (a percent of the fill each, the target the wider) and is cut at ' +
      'whichever is touched first, or on the close of a fixed number of candles.';
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
    this.refHigh = null; // HIGH of that bar — the upside breakout level
    this.refLow = null; // LOW of that bar — the downside breakout level
    this.tradedThisBar = false; // this bar has already produced its trade
    this.stopPrice = 0; // stop of the open trade (0 = none)
    this.targetPrice = 0; // target of the open trade (0 = none)
    this.barsHeld = 0; // candles elapsed since that trade was entered
    this.lastReason = '';
  }

  // Stop and target for one entry, both a percent of the fill, the target the
  // wider. `side` may be the order side ('buy'/'sell') or the position side
  // ('long'/'short'); anything that is neither 'sell' nor 'short' is treated as
  // long.
  levelsFor(side, entry) {
    const short = side === 'sell' || side === 'short';
    const stopDist = entry * (STOP_PCT / 100);
    const tgtDist = entry * (TARGET_PCT / 100);
    return short
      ? { stop: entry + stopDist, target: entry - tgtDist }
      : { stop: entry - stopDist, target: entry + tgtDist };
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

  // One breakout entry. A market order: the level has already been taken, so the
  // fill is the whole point of the trade. This marks the bar as traded so a cut
  // (or a stop) cannot immediately re-arm the same breakout.
  buildEntry(side, price) {
    const quantity = this.sizeContracts(price);
    if (!(quantity > 0)) return { action: 'HOLD', reason: 'size rounds to zero contracts' };

    this.tradedThisBar = true;

    // Fix the bracket now, from the fill: it does not move while the trade lives.
    const { stop, target } = this.levelsFor(side, price);
    this.stopPrice = stop;
    this.targetPrice = target;
    this.barsHeld = 0;

    return {
      action: side === 'buy' ? 'BUY' : 'SELL',
      symbol: this.symbol,
      quantity,
      orderType: 'market_order',
      strategyName: this.name,
      reason:
        side === 'buy'
          ? `HFTV1 breakout up: price took the ${this.fmt(this.refHigh)} 1m high — buying`
          : `HFTV1 breakout down: price took the ${this.fmt(this.refLow)} 1m low — selling`,
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

    // Last market price. The ticker is what the breakout is measured against and
    // what the entry/exit really happens at; the closed bar is only a fallback so
    // the value is never missing.
    const price = Number(marketData.price) || Number(last.close) || 0;

    // A new 1m candle has closed: its HIGH and LOW arm the breakout levels for
    // the bar that starts now.
    let newBar = false;
    if (last.time !== this.lastBarTime) {
      newBar = true;
      this.lastBarTime = last.time;
      this.refHigh = Number(last.high);
      this.refLow = Number(last.low);
      this.tradedThisBar = false;
      this.lastReason =
        `breakout levels armed: ${this.fmt(this.refHigh)} high / ${this.fmt(this.refLow)} low`;
    }

    const positions = Array.isArray(state.positions) ? state.positions : [];
    const position = positions[0] || null;

    // --- holding the trade the breakout produced ---------------------------
    if (position) {
      const entry = Number(position.entryPrice) || 0;
      const short = position.side === 'short';

      if (entry > 0 && price > 0) {
        // The bracket was fixed at entry; if the engine restarted while the
        // position was open it is missing, so derive it from the fill again.
        let stop = this.stopPrice;
        let target = this.targetPrice;
        if (!(stop > 0) || !(target > 0)) {
          ({ stop, target } = this.levelsFor(position.side, entry));
        }

        // 1. Stop touched -> the loss is taken at market.
        if (short ? price >= stop : price <= stop) {
          return {
            action: 'CLOSE',
            symbol: this.symbol,
            strategyName: this.name,
            reason:
              `stop hit: ${position.side} entered at ${this.fmt(entry)}, mark ${this.fmt(price)} ` +
              `reached the ${this.fmt(stop)} stop`,
          };
        }

        // 2. Target touched -> the profit is booked at market.
        if (short ? price <= target : price >= target) {
          return {
            action: 'CLOSE',
            symbol: this.symbol,
            strategyName: this.name,
            reason:
              `target hit: ${position.side} entered at ${this.fmt(entry)}, mark ${this.fmt(price)} ` +
              `reached the ${this.fmt(target)} target`,
          };
        }

        // 3. Time stop -> neither was touched, so flatten on the close of the
        // MAX_HOLD_BARS'th candle after entry.
        if (newBar) {
          this.barsHeld += 1;
          if (this.barsHeld >= MAX_HOLD_BARS) {
            return {
              action: 'CLOSE',
              symbol: this.symbol,
              strategyName: this.name,
              reason:
                `time stop: ${position.side} held ${this.barsHeld} candles with no stop or target ` +
                `touch — closing on the ${this.fmt(last.close)} close`,
            };
          }
        }
      }

      return { action: 'HOLD', reason: `holding ${position.side}; ${this.lastReason}` };
    }

    // --- flat: wait for one of the levels to break --------------------------
    // Any bracket left over from a closed trade is stale.
    this.stopPrice = 0;
    this.targetPrice = 0;
    this.barsHeld = 0;

    if (price <= 0) return { action: 'HOLD', reason: 'no live price' };
    if (this.tradedThisBar) {
      return { action: 'HOLD', reason: 'this 1m bar has already traded' };
    }

    if (this.refHigh > 0 && price > this.refHigh) return this.buildEntry('buy', price);
    if (this.refLow > 0 && price < this.refLow) return this.buildEntry('sell', price);

    return { action: 'HOLD', reason: `no breakout yet; ${this.lastReason}` };
  }
}

module.exports = new HftV1();
