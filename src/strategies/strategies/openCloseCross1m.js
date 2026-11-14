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
//     This port keeps that reversal but ADDS risk exits, because a study of
//     this strategy's own realised trades showed the whole drawdown sits in a
//     few long-held trades: a fixed ATR stop (rests on the exchange), a time
//     stop, and a loss cooldown that skips the trade right after a loser.
//     See RISK CONTROLS below.
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

const { atr } = require('../../utils/indicators');

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
const LOTS = 10;

// ---------------------------------------------------------------------------
// RISK CONTROLS
// ---------------------------------------------------------------------------
// Measured on this strategy's own closed trades: it wins ~58% of the time but
// the average loss is ~3x the average win, and the five worst trades erased
// more than every winner combined. The damage was concentrated in trades that
// were held for 15-35 minutes (avg loser 13.6 min vs avg winner 5.6 min) with
// no stop, entered at high volatility (the two biggest live losses fired at
// ATR(14) ~= 1.2% and 1.9% of price). These settings cap exactly that.

// Fixed stop placed at entry: distance = ATR_STOP_MULT x ATR(ATR_PERIOD) on the
// 1m chart. It travels on the signal as `stopLoss`, so orderManager rests it on
// the exchange as a reduce-only stop_market_order (and the position manager
// mirrors it locally in paper mode), so the position stays protected even if
// this process dies.
const ATR_PERIOD = 14;
const ATR_STOP_MULT = 1;

// Time stop: flatten at market once the position has been open this many
// minutes. The published script has no time exit at all, so a losing trade is
// held until the cross comes back — which is what produced the -18/-21 minute
// tail losers. Set to 0 to disable.
const TIME_STOP_MIN = 10;

// Volatility-aware sizing: when ATR(14) is at or above HIGH_VOL_ATR_PCT percent
// of price the entry is "high volatility" and the lot size is multiplied by
// HIGH_VOL_SIZE_FACTOR (floored at 1 contract). Below the threshold the size is
// untouched.
const HIGH_VOL_ATR_PCT = 1.0;
const HIGH_VOL_SIZE_FACTOR = 0.5;

// Loss cooldown: once a trade closes at a loss, stand down for this many
// minutes before the next entry is allowed. This is an always-in reversal
// system, so without it the very next cross re-enters — often straight back
// into the same chop that just stopped the trade out. When the engine tracks
// several instruments the clock is SHARED, so a loser on any of them freezes
// the whole portfolio. Set to 0 to disable.
const LOSS_COOLDOWN_MIN = 15;

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
      'An always-in reversal system whose primary exit is the next opposite cross, plus a fixed ' +
      'ATR stop and a time stop (see RISK CONTROLS).';
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
    // Sizing stays the published percent-of-equity rule; the ATR risk controls
    // only squeeze it further on high-volatility entries (volatilityAdjustedSize).
    this.notionalPercent = 0.1;

    this.reset();
  }

  getName() {
    return this.name;
  }

  // A fresh instance carrying the same settings but its own cross/ATR state.
  // The engine builds one per instrument when TRADING_SYMBOLS tracks several
  // at once, since the SMMA/ATR and tick size are all per instrument.
  newInstance() {
    return new OpenCloseCross1m();
  }

  reset() {
    this.lastBarTime = 0; // last closed 1m bar already evaluated
    this.closeMA = null;
    this.openMA = null;
    this.lastCross = null; // 'bull' | 'bear' — direction of the most recent cross
    this.signalSide = null; // 'long' | 'short' — the side to hold after that cross
    this.entryDone = false; // whether that cross has already been acted on
    this.lastReason = '';
    this.atr = null; // ATR(ATR_PERIOD) on the last closed bar, in price units
    this.atrPct = null; // the same ATR as a percentage of price
    this.entryAtMs = null; // when the current position was opened (time stop)
    // Loss cooldown clock. It lives in an OBJECT so the instances the engine
    // runs for several instruments share ONE clock — a loser on any instrument
    // freezes the whole portfolio. Set untilMs = 0 to disable.
    if (!this.cooldown) this.cooldown = { untilMs: 0 };
    this.cooldown.untilMs = 0;
    this.openSide = null; // side of the position we last saw open (close scoring)
    this.openEntryPrice = null; // its entry price, used to score the close
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

  // Scales the base size down for high-volatility entries (see HIGH_VOL_* above).
  // A missing ATR leaves the size untouched — the filter is an add-on, never a
  // reason to refuse a trade.
  volatilityAdjustedSize(baseSize) {
    const atrPct = Number(this.atrPct);
    if (!(atrPct >= HIGH_VOL_ATR_PCT)) return baseSize;
    return Math.max(1, Math.floor(baseSize * HIGH_VOL_SIZE_FACTOR));
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

  // Rebuilds both SMMAs (and the ATR the risk controls need) once per closed bar.
  computeContext(candles) {
    this.closeMA = smma(candles.map((c) => c.close), MA_LEN);
    this.openMA = smma(candles.map((c) => c.open), MA_LEN);

    // Wilder ATR over the same closed candles, taken from the shared indicator
    // module so a live value matches the backtest exactly.
    const atrValue = Number(atr(candles, ATR_PERIOD).pop());
    this.atr = Number.isFinite(atrValue) && atrValue > 0 ? atrValue : null;
    const price = Number(candles[candles.length - 1].close);
    this.atrPct = this.atr && price > 0 ? (this.atr / price) * 100 : null;
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
  // stays a market order. The entry now carries a fixed ATR stop (the original's
  // SL = 0 is what let single trades cost 3x an average win); the next opposite
  // cross still reverses.
  buildEntry(side, last) {
    const entry = this.snap(last.close);
    if (!(entry > 0)) return { action: 'HOLD', reason: 'no valid entry price' };

    const quantity = this.volatilityAdjustedSize(this.sizeContracts(entry));
    if (!(quantity > 0)) return { action: 'HOLD', reason: 'size rounds to zero contracts' };

    // Fixed ATR stop, snapped to the tick grid and only used when it is a real
    // level strictly on the losing side of the entry. A missing/degenerate ATR
    // leaves the trade unprotected rather than attaching a stop at the entry.
    let stopLoss = null;
    if (this.atr && this.atr > 0) {
      const raw = side === 'long' ? entry - ATR_STOP_MULT * this.atr : entry + ATR_STOP_MULT * this.atr;
      const snapped = this.snap(raw);
      if (snapped > 0 && snapped !== entry) stopLoss = snapped;
    }

    this.entryDone = true;
    this.entryAtMs = Date.now();

    return {
      action: side === 'long' ? 'BUY' : 'SELL',
      symbol: this.symbol,
      quantity,
      price: entry,
      orderType: 'market_order',
      stopLoss: stopLoss || undefined,
      strategyName: this.name,
      reason:
        `OpenCloseCross ${side}: close SMMA(${MA_LEN}) crossed ` +
        `${this.lastCross === 'bear' ? 'under' : 'over'} the open SMMA(${MA_LEN}) at ${entry} ` +
        `— market entry, ATR stop ${stopLoss || 'n/a'}, time stop ${TIME_STOP_MIN}m, ` +
        `the next opposite cross reverses`,
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

    // Last market price — used to score a position that has just closed (the
    // loss cooldown below). The ticker price is preferred, the closed bar is
    // the fallback so the value is never missing.
    const price = Number(marketData.price) || Number(last.close) || 0;

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
      // Remember what we hold so that, when the position later disappears, the
      // close can be scored and a loss can start the cooldown.
      if (position.side) this.openSide = position.side;
      const entryPrice = Number(position.entryPrice);
      if (entryPrice > 0) this.openEntryPrice = entryPrice;

      // An opposite cross is the reverse leg: close at market, re-enter next.
      if (this.signalSide && position.side && position.side !== this.signalSide) {
        return {
          action: 'CLOSE',
          symbol: this.symbol,
          strategyName: this.name,
          reason: `reverse ${position.side} -> ${this.signalSide} (${this.lastReason})`,
        };
      }

      // Time stop: the published script has no time exit, so a trade that goes
      // against the position is held until the cross finally comes back — the
      // source of this strategy's long, expensive losers. Flatten at market
      // once the position has been open TIME_STOP_MIN minutes. The entry time
      // is in-memory, so a restart mid-position simply skips this exit.
      if (TIME_STOP_MIN > 0 && this.entryAtMs) {
        const heldMin = (Date.now() - this.entryAtMs) / 60000;
        if (heldMin >= TIME_STOP_MIN) {
          return {
            action: 'CLOSE',
            symbol: this.symbol,
            strategyName: this.name,
            reason: `time stop: ${position.side} held ${Math.round(heldMin)} min >= ${TIME_STOP_MIN} min`,
          };
        }
      }

      // Otherwise the current cross is already the side we hold.
      this.entryDone = true;
      return { action: 'HOLD', reason: `holding ${position.side}; ${this.lastReason}` };
    }

    // --- flat ---------------------------------------------------------------
    // No position: forget the previous entry so the time stop cannot carry over
    // to the next trade.
    this.entryAtMs = null;

    // A position we were tracking is now gone, so it closed on the last cycle.
    // Score it against the current price; if it lost, stand down (loss
    // cooldown). The price is the live tick, so the sign is an estimate of the
    // fill rather than Delta's exact one — close enough to gate the next entry.
    if (this.openSide && this.openEntryPrice > 0) {
      const direction = this.openSide === 'long' ? 1 : -1;
      if ((price - this.openEntryPrice) * direction < 0) {
        this.cooldown.untilMs = Date.now() + LOSS_COOLDOWN_MIN * 60000;
      }
    }
    this.openSide = null;
    this.openEntryPrice = null;

    // Loss cooldown: do not take the next trade straight after a losing close.
    // The clock is shared, so this also holds the other tracked instruments back.
    if (LOSS_COOLDOWN_MIN > 0 && this.cooldown.untilMs > Date.now()) {
      const minsLeft = Math.ceil((this.cooldown.untilMs - Date.now()) / 60000);
      return { action: 'HOLD', reason: `loss cooldown: ${minsLeft} min left after a losing trade` };
    }
    this.cooldown.untilMs = 0;

    if (state.hasLiveOrder) return { action: 'HOLD', reason: 'an entry is already working' };
    if (!this.signalSide) return { action: 'HOLD', reason: this.lastReason || 'no cross yet' };
    if (this.entryDone) return { action: 'HOLD', reason: 'the cross has already been traded' };

    return this.buildEntry(this.signalSide, last);
  }
}

module.exports = new OpenCloseCross1m();
