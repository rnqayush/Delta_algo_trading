// EMA 9/13 Crossover on the 1-MINUTE chart.
//
// Model:
//   * EMA(9) and EMA(13) of the close series, both on the 1m chart.
//   * LONG  when EMA(9) crosses OVER  EMA(13)  (fast over slow),
//     SHORT when EMA(9) crosses UNDER EMA(13)  (fast under slow).
//   * ALWAYS-IN reversal system: there is no stop and no target. The only exit
//     is the next opposite cross — the open position is closed at market and the
//     reverse leg is opened on the following cycle, so the account is (almost)
//     always holding a position.
//
// Bar by bar, on the last CLOSED 1m candle:
//   1. rebuild the two EMAs (no look-ahead);
//   2. look for a crossover / crossunder on this bar;
//   3. flat -> enter at market in the signal's direction;
//      holding the other side -> close at market (reduce-only) and let the
//      next cycle open the reverse leg;
//      already holding the signal's side -> stand down.

const FAST_LEN = 9;
const SLOW_LEN = 13;

// The slow EMA needs 13 closes to seed, plus one prior bar for the cross.
const MIN_BARS = 20;

// Daily-loss kill switch for THIS strategy only.
//   true  -> obey RISK_MAX_DAILY_LOSS: once the day's realised loss crosses the
//            cap every order for this strategy is rejected ("Trading is halted
//            for today"), the flip included.
//   false -> keep trading no matter what the day's P&L is. Nothing else in the
//            risk manager is relaxed — only the daily-loss check.
const HALT_ON_DAILY_LOSS = false;

// Order size in CONTRACTS (Delta "lots"). This is the size every entry sends:
//   > 0 -> that exact number of contracts, and it WINS over
//          STRATEGY_FIXED_CONTRACTS in .env (which is ignored for this strategy).
//   = 0 -> fall back to STRATEGY_FIXED_CONTRACTS, and if that is 0 as well, size
//          from percent_of_equity (10% notional), floored at minContracts.
// Keep it inside RISK_MAX_ORDER_QUANTITY / RISK_MAX_POSITION_SIZE or the risk
// manager will reject the order.
const LOTS = 1;

// ---------------------------------------------------------------------------
// Indicators
// ---------------------------------------------------------------------------

// Pine's ta.ema: the SMA seeds index len-1, then v = src * k + v[1] * (1 - k)
// with k = 2 / (len + 1). A null anywhere before the seed stays null.
function ema(values, len) {
  const n = values.length;
  const out = new Array(n).fill(null);
  if (len < 1 || n < len) return out;

  const k = 2 / (len + 1);
  let sum = 0;
  for (let i = 0; i < len; i += 1) sum += values[i];
  out[len - 1] = sum / len;

  for (let i = len; i < n; i += 1) out[i] = values[i] * k + out[i - 1] * (1 - k);
  return out;
}

// ---------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------

class EmaCross1m {
  constructor() {
    this.name = 'EmaCross1m';
    this.description =
      'EMA 9/13 crossover on the 1m chart: long when EMA(9) crosses over EMA(13), short ' +
      'when it crosses under. An always-in reversal system with no stop and no target — ' +
      'the next opposite cross closes the position and opens the reverse leg.';
    // Left blank on purpose: the engine sets this to TRADING_SYMBOL on start
    // (see tradingEngine.applyProductSettings), so the instrument is configured
    // in one place — .env — and can never disagree with the WebSocket feed.
    this.symbol = null;

    // --- exchange facts, filled in by the engine (applyProductSettings) ---
    this.tickSize = 0.05;
    this.contractValue = 0.01;
    this.equity = 1000;
    this.maxNotionalEquity = 3;
    this.minContracts = 1;
    // Explicit lot size — see the LOTS constant above.
    this.fixedContracts = Math.max(0, Math.floor(LOTS));
    this.maxConcurrentPositions = 1;
    // The account's leverage for the instrument, read from Delta at startup.
    this.leverage = 1;

    // No stop, so there is no risk-per-trade to size from; this uses the
    // percent-of-equity rule (10% of equity notional) when LOTS is 0.
    this.notionalPercent = 0.1;

    this.reset();
  }

  getName() {
    return this.name;
  }

  // A fresh instance per tracked symbol, so each instrument keeps its own
  // last-bar and signal state.
  newInstance() {
    return new EmaCross1m();
  }

  reset() {
    this.lastBarTime = 0; // last closed 1m bar already evaluated
    this.fastMA = null; // EMA(close, FAST_LEN)
    this.slowMA = null; // EMA(close, SLOW_LEN)
    this.lastCross = null; // 'bull' | 'bear' — direction of the most recent cross
    this.signalSide = null; // 'long' | 'short' — the side to hold after that cross
    this.entryDone = false; // whether that cross has already been acted on
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

  // Rounds a price to the product's tick size (ETHUSD = 0.05).
  snap(price) {
    const tick = Number(this.tickSize) || 0;
    if (!(tick > 0)) return Number(price);
    const decimals = (String(tick).split('.')[1] || '').length;
    return Number((Math.round(price / tick) * tick).toFixed(decimals));
  }

  // Formats a price for log/reason strings at the product's own precision.
  fmt(price) {
    const tick = Number(this.tickSize) || 0;
    const decimals = tick > 0 ? (String(tick).split('.')[1] || '').length : 2;
    return Number(price).toFixed(decimals);
  }

  // Rebuilds both EMAs once per closed bar.
  computeContext(candles) {
    const closes = candles.map((c) => c.close);
    this.fastMA = ema(closes, FAST_LEN);
    this.slowMA = ema(closes, SLOW_LEN);
  }

  // Looks for an EMA(9)/EMA(13) crossover on the last closed bar. Sets
  // signalSide when one fires; returns a human-readable reason either way.
  detectSignal(candles) {
    const i = candles.length - 1;
    if (i < 1) return 'need one prior bar';

    const f1 = this.fastMA[i];
    const s1 = this.slowMA[i];
    const f0 = this.fastMA[i - 1];
    const s0 = this.slowMA[i - 1];
    if (f0 == null || s0 == null || f1 == null || s1 == null) {
      return `EMA(${SLOW_LEN}) not warmed up on this bar`;
    }

    // Keep the cross flags explicit so the reason strings can say which side
    // the fast EMA moved to.
    const bull = f0 <= s0 && f1 > s1;
    const bear = f0 >= s0 && f1 < s1;

    if (bull) {
      this.lastCross = 'bull';
      this.signalSide = 'long';
      this.entryDone = false;
      return `bull cross (EMA${FAST_LEN} ${this.fmt(f1)} > EMA${SLOW_LEN} ${this.fmt(s1)}) -> hold long`;
    }

    if (bear) {
      this.lastCross = 'bear';
      this.signalSide = 'short';
      this.entryDone = false;
      return `bear cross (EMA${FAST_LEN} ${this.fmt(f1)} < EMA${SLOW_LEN} ${this.fmt(s1)}) -> hold short`;
    }

    return 'no EMA cross on this bar';
  }

  // Places one market entry. An always-in reversal cannot safely rest an
  // unfilled limit, so this stays a market order. No stop and no target travel
  // with the order — the next opposite cross is the only exit.
  buildEntry(side, last) {
    const entry = this.snap(last.close);
    if (!(entry > 0)) return { action: 'HOLD', reason: 'no valid entry price' };

    const quantity = this.sizeContracts(entry);
    if (!(quantity > 0)) return { action: 'HOLD', reason: 'size rounds to zero contracts' };

    this.entryDone = true;

    return {
      action: side === 'long' ? 'BUY' : 'SELL',
      symbol: this.symbol,
      quantity,
      price: entry,
      orderType: 'market_order',
      strategyName: this.name,
      reason:
        `EmaCross ${side}: EMA${FAST_LEN} crossed ${this.lastCross === 'bear' ? 'under' : 'over'} ` +
        `EMA${SLOW_LEN} at ${entry} — market entry, no bracket, the next opposite cross reverses`,
      meta: {
        exitMode: 'reverse',
        family: 'ema-cross-1m',
        // Carried into the risk context so the daily-loss cap can be opted out
        // of for this strategy (see HALT_ON_DAILY_LOSS above).
        haltOnDailyLoss: HALT_ON_DAILY_LOSS,
      },
    };
  }

  evaluate(marketData = {}, state = {}) {
    const candles = Array.isArray(marketData.candles1m) ? marketData.candles1m : [];
    if (candles.length < MIN_BARS) {
      return { action: 'HOLD', reason: `warming up (${candles.length}/${MIN_BARS} 1m candles)` };
    }

    const last = candles[candles.length - 1];
    if (!last || !last.time) return { action: 'HOLD', reason: 'no closed 1m candle yet' };

    // One cross decision per closed 1m bar. The decision BELOW still runs on
    // every tick, so a pending close or entry is acted on without waiting a bar.
    if (last.time !== this.lastBarTime) {
      this.computeContext(candles);
      this.lastBarTime = last.time;
      this.lastReason = this.detectSignal(candles);
    }

    const positions = Array.isArray(state.positions) ? state.positions : [];
    const position = positions[0] || null;

    // --- holding a position -------------------------------------------------
    if (position) {
      // An opposite cross is the reverse leg: close at market, re-enter next.
      if (this.signalSide && position.side && position.side !== this.signalSide) {
        return {
          action: 'CLOSE',
          symbol: this.symbol,
          strategyName: this.name,
          reason: `reverse ${position.side} -> ${this.signalSide} (${this.lastReason})`,
        };
      }
      // Otherwise the current cross is already the side we hold.
      this.entryDone = true;
      return { action: 'HOLD', reason: `holding ${position.side}; ${this.lastReason}` };
    }

    // --- flat ---------------------------------------------------------------
    if (state.hasLiveOrder) return { action: 'HOLD', reason: 'an entry is already working' };
    if (!this.signalSide) return { action: 'HOLD', reason: this.lastReason || 'no cross yet' };
    if (this.entryDone) return { action: 'HOLD', reason: 'the cross has already been traded' };

    return this.buildEntry(this.signalSide, last);
  }
}

module.exports = new EmaCross1m();
