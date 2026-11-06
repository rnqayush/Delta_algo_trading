// "Open Close Cross Strategy R5.1" (TradingView Pine v3, revised by JustUncleL)
// ported to the live engine at the 1-MINUTE resolution.
//
// Front-end model:
//   * SMMA(8) of the close series and SMMA(8) of the open series, both on the
//     1m chart (the script's default "Alternate Resolution" multiplier of 3 only
//     matters when the chart is not 1m; on a 1m feed the strategy resolution is
//     the chart, so this runs at 1m).
//   * the cross is read straight off the published rules — no fade:
//     LONG when the close SMMA crosses OVER the open SMMA,
//     SHORT when it crosses UNDER.
//   * the published script ships SL = 0 and TP = 0 (both disabled) and never
//     calls strategy.close, so an opposite cross simply REVERSES the position.
//     This port keeps that reversal as its only exit: no stop, no target.
//
// The original also uses `security(..., lookahead=barmerge.lookahead_on)` with
// "Delay Open/Close MA" = 0, so on TradingView the cross is read from the
// STILL-FORMING higher-timeframe bar and can repaint. This port reads the last
// CLOSED 1m bar only, which is what can actually be deployed.
//
// WARNING — measured behaviour: this is an always-in reversal system that flips
// many times a day, so retail fees dominate the gross edge. The instrument it
// trades live comes from TRADING_SYMBOL in .env, not from this file.
//
// Bar by bar, on the last CLOSED 1m candle:
//   1. rebuild the open/close SMMAs (no look-ahead);
//   2. look for a crossover / crossunder on this bar;
//   3. flat -> enter at market in the signal's direction;
//      holding the other side -> close at market (reduce-only) and let the
//      next cycle open the reverse leg;
//      already holding the signal's side -> stand down.

const MA_LEN = 8;

// The SMMA needs 8 closes plus one prior bar for the cross comparison.
const MIN_BARS = 20;

// Daily-loss kill switch for THIS strategy only.
//   true  -> obey RISK_MAX_DAILY_LOSS: once the day's realised loss crosses the
//            cap every order for this strategy is rejected ("Trading is halted
//            for today"), the flip included.
//   false -> keep trading no matter what the day's P&L is. Nothing else in the
//            risk manager is relaxed — only the daily-loss check.
const HALT_ON_DAILY_LOSS = false;

// The published (non-faded) mapping, kept as an explicit switch:
//   false -> bull cross (close SMMA over open SMMA) opens a LONG,
//            bear cross opens a SHORT.   <- the R5.1 behaviour
//   true  -> the fade (bull cross short, bear cross long).
// The flip, when used, is applied to the side we intend to HOLD (signalSide),
// never to the order action — buildEntry still does BUY-for-long / SELL-for-
// short. That keeps `signalSide === position.side`, which is what the reverse-
// on-opposite-cross test compares.
const INVERT_SIGNALS = true;

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

// Pine's SMMA (a.k.a. ta.rma / "smoothed" MA): the SMA seeds index len-1, then
// v = (v[1] * (len - 1) + src) / len. A null anywhere before the seed stays null.
function smma(values, len) {
  const n = values.length;
  const out = new Array(n).fill(null);
  if (len < 1 || n < len) return out;

  let sum = 0;
  for (let i = 0; i < len; i += 1) sum += values[i];
  out[len - 1] = sum / len;

  for (let i = len; i < n; i += 1) out[i] = (out[i - 1] * (len - 1) + values[i]) / len;
  return out;
}

// ---------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------

class OpenCloseCross1m {
  constructor() {
    this.name = 'OpenCloseCross1m';
    this.description =
      'Open Close Cross (TradingView R5.1) on the 1m chart: SMMA(8) of the close crossing SMMA(8) ' +
      'of the open is taken the published way — a bull cross opens a long, a bear cross a short. ' +
      'An always-in reversal system with no stop and no target: the next opposite cross reverses ' +
      'the position.';
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

    // The script's default_qty_type = percent_of_equity, default_qty_value = 10.
    // With no stop there is no risk-per-trade to size from, so this is the
    // sizing rule the original uses.
    this.notionalPercent = 0.1;

    this.reset();
  }

  getName() {
    return this.name;
  }

  reset() {
    this.lastBarTime = 0; // last closed 1m bar already evaluated
    this.closeMA = null;
    this.openMA = null;
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

  // Formats a price for log/reason strings at the product's own precision, so it
  // reads correctly for any TRADING_SYMBOL (BTCUSD 0.5 -> 1 dp, AINUSD 0.00001
  // -> 5 dp) instead of collapsing to "0.0".
  fmt(price) {
    const tick = Number(this.tickSize) || 0;
    const decimals = tick > 0 ? (String(tick).split('.')[1] || '').length : 2;
    return Number(price).toFixed(decimals);
  }

  // Rebuilds both SMMAs once per closed bar.
  computeContext(candles) {
    this.closeMA = smma(candles.map((c) => c.close), MA_LEN);
    this.openMA = smma(candles.map((c) => c.open), MA_LEN);
  }

  // Looks for an open/close crossover on the last closed bar. Sets signalSide
  // when one is found; returns a human-readable reason either way.
  detectSignal(candles) {
    const i = candles.length - 1;
    if (i < 1) return 'need one prior bar';

    const c1 = this.closeMA[i];
    const o1 = this.openMA[i];
    const c0 = this.closeMA[i - 1];
    const o0 = this.openMA[i - 1];
    if (c0 == null || o0 == null || c1 == null || o1 == null) {
      return `SMMA(${MA_LEN}) not warmed up on this bar`;
    }

    // The cross itself is read straight off the published rules. Only the side
    // we then choose to hold is flipped (INVERT_SIGNALS), so the entry/exit flow
    // downstream is unchanged.
    if (c0 <= o0 && c1 > o1) {
      this.lastCross = 'bull';
      this.signalSide = INVERT_SIGNALS ? 'short' : 'long';
      this.entryDone = false;
      return `bull cross (close ${this.fmt(c1)} > open ${this.fmt(o1)}) -> hold ${this.signalSide}`;
    }

    if (c0 >= o0 && c1 < o1) {
      this.lastCross = 'bear';
      this.signalSide = INVERT_SIGNALS ? 'long' : 'short';
      this.entryDone = false;
      return `bear cross (close ${this.fmt(c1)} < open ${this.fmt(o1)}) -> hold ${this.signalSide}`;
    }

    return 'no open/close cross on this bar';
  }

  // Places one market entry. The original uses strategy.entry (a market order),
  // and an always-in reversal cannot safely rest an unfilled limit, so this
  // stays a market order. SL = 0 and TP = 0 in the script, so nothing travels
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
        `OpenCloseCross ${side}: close SMMA(${MA_LEN}) crossed ` +
        `${this.lastCross === 'bear' ? 'under' : 'over'} the open SMMA(${MA_LEN}) at ${entry} ` +
        `— market entry, no bracket, the next opposite cross reverses`,
      meta: {
        exitMode: 'reverse',
        family: 'open-close-cross-1m',
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

module.exports = new OpenCloseCross1m();
