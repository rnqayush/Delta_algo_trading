// "EMA Slope + EMA Cross Strategy (by ChartArt)" (TradingView Pine v3)
// ported to the live engine at the 1-MINUTE resolution.
//
// Front-end model:
//   * MA1 = EMA(close, 2), MA2 = EMA(close, 4), MA3 = EMA(close, 20), all on the
//     1m chart (the script has no security() call, so it runs at the chart
//     resolution — 1m here).
//   * long  = crossunder(price, MA3) OR (dPrice<0 and dMA1<0 and crossunder(price,MA1) and dMA2>0)
//   * short = crossover (price, MA3) OR (dPrice>0 and dMA1>0 and crossover (price,MA1) and dMA2<0)
//   * both branches are CONTRARIAN: despite the name, it BUYS when price crosses
//     BELOW the slow EMA and SELLS when it crosses ABOVE — it fades the trend.
//   * the published script ships no stop and no target and never calls
//     strategy.close, so an opposite signal simply REVERSES the position. This
//     port keeps that reversal as its only exit: no stop, no target.
//
// Measured behaviour (see backtest/ema-slope-cross.js): an always-in reversal
// system that flips very often — ~220-250 flips/day on a 1m feed. Retail fees
// dominate the gross edge at 1m, so this is expected to lose money live. It is
// wired as the active strategy only because it was requested; the instrument it
// trades comes from TRADING_SYMBOL in .env, not from this file.
//
// Bar by bar, on the last CLOSED 1m candle:
//   1. rebuild the three EMAs (no look-ahead);
//   2. look for the long/short rule on this bar, faded if the IST clock is in
//      the inverted window (see the schedule below);
//   3. flat -> enter at market in the signal's direction;
//      holding the other side -> close at market (reduce-only) and let the
//      next cycle open the reverse leg;
//      already holding the signal's side -> stand down;
//   4. outside both windows -> close any position and take no new entries.
//
// TIME-OF-DAY SCHEDULE (IST): 09:00-18:00 trade the rules as written;
// 22:00-06:00 trade the faded rules; the rest of the clock is flat.

const MA_LEN_1 = 2; // EMA 1 length (source default)
const MA_LEN_2 = 4; // EMA 2 length (source default)
const MA_LEN_3 = 20; // EMA 3 length (source default)

// The EMAs need 20 closes to seed, plus one prior bar for the cross comparison.
const MIN_BARS = 25;

// Daily-loss kill switch for THIS strategy only.
//   true  -> obey RISK_MAX_DAILY_LOSS: once the day's realised loss crosses the
//            cap every order for this strategy is rejected ("Trading is halted
//            for today"), the flip included.
//   false -> keep trading no matter what the day's P&L is. Nothing else in the
//            risk manager is relaxed — only the daily-loss check.
const HALT_ON_DAILY_LOSS = false;

// ---------------------------------------------------------------------------
// Time-of-day schedule (Indian Standard Time, UTC+05:30)
// ---------------------------------------------------------------------------
// The signal mapping is switched by the clock, in IST:
//   09:00 - 18:00 IST -> rules as written (INVERT = false)
//   22:00 - 06:00 IST -> faded            (INVERT = true)
//   everything else   -> OFF: no new entries; any open position is closed.
// The flip (when used) is applied to the side we intend to HOLD (signalSide),
// never to the order action — buildEntry still does BUY-for-long / SELL-for-
// short, keeping `signalSide === position.side` (what the reverse-on-opposite-
// signal test compares).
const TZ_OFFSET_MINUTES = 5 * 60 + 30; // IST = UTC+05:30

const NORMAL_WINDOW = { from: 9, to: 18 }; // [09:00, 18:00) IST, invert off
const INVERT_WINDOW = { from: 22, to: 6 }; // [22:00, 06:00) IST, invert on (wraps midnight)

// Maps an epoch-seconds bar time to its IST session.
//   normal -> trade the rules as written
//   invert -> trade the faded rules
//   off    -> trade nothing and flatten
function sessionAt(epochSeconds) {
  const localMinutes = Math.floor(((((epochSeconds + TZ_OFFSET_MINUTES * 60) % 86400) + 86400) % 86400) / 60);
  const hour = localMinutes / 60;
  const within = (w) => (w.from < w.to ? hour >= w.from && hour < w.to : hour >= w.from || hour < w.to);
  if (within(NORMAL_WINDOW)) return { state: 'normal', invert: false };
  if (within(INVERT_WINDOW)) return { state: 'invert', invert: true };
  return { state: 'off', invert: false };
}

// Order size in CONTRACTS (Delta "lots"). This is the size every entry sends:
//   > 0 -> that exact number of contracts, and it WINS over
//          STRATEGY_FIXED_CONTRACTS in .env (which is ignored for this strategy).
//   = 0 -> fall back to STRATEGY_FIXED_CONTRACTS, and if that is 0 as well, size
//          from percent_of_equity (10% notional), floored at minContracts.
// Keep it inside RISK_MAX_ORDER_QUANTITY / RISK_MAX_POSITION_SIZE or the risk
// manager will reject the order.
const LOTS = 2;

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

class EmaSlopeCross1m {
  constructor() {
    this.name = 'EmaSlopeCross1m';
    this.description =
      'ChartArt EMA Slope + EMA Cross on the 1m chart: EMA(2)/EMA(4)/EMA(20) of the close. ' +
      'Long on a cross under EMA(20) (or the EMA2 pullback slope rule), short on a cross over. ' +
      'An always-in reversal system with no stop and no target: the next opposite signal reverses ' +
      'the position. Contrarian by construction.';
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

    // The source has no stop, so there is no risk-per-trade to size from; this
    // ports the percent-of-equity rule (10% of equity notional).
    this.notionalPercent = 0.1;

    this.reset();
  }

  getName() {
    return this.name;
  }

  // A fresh instance per tracked symbol, so each instrument keeps its own
  // last-bar and signal state.
  newInstance() {
    return new EmaSlopeCross1m();
  }

  reset() {
    this.lastBarTime = 0; // last closed 1m bar already evaluated
    this.ma1 = null; // EMA(close, MA_LEN_1)
    this.ma2 = null; // EMA(close, MA_LEN_2)
    this.ma3 = null; // EMA(close, MA_LEN_3)
    this.signalSide = null; // 'long' | 'short' — the side to hold after the last signal
    this.entryDone = false; // whether that signal has already been acted on
    this.sessionState = null; // last IST session seen: 'normal' | 'invert' | 'off'
    this.invertActive = false; // whether the current session fades the signal
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

  // Rebuilds the three EMAs once per closed bar.
  computeContext(candles) {
    const closes = candles.map((c) => c.close);
    this.ma1 = ema(closes, MA_LEN_1);
    this.ma2 = ema(closes, MA_LEN_2);
    this.ma3 = ema(closes, MA_LEN_3);
  }

  // Looks for the ChartArt rules on the last closed bar. Sets signalSide when one
  // fires; returns a human-readable reason either way.
  detectSignal(candles) {
    const i = candles.length - 1;
    if (i < 1) return 'need one prior bar';

    const price = candles[i].close;
    const prevPrice = candles[i - 1].close;
    const m1 = this.ma1[i];
    const m1p = this.ma1[i - 1];
    const m2 = this.ma2[i];
    const m2p = this.ma2[i - 1];
    const m3 = this.ma3[i];
    const m3p = this.ma3[i - 1];
    if (m1 == null || m1p == null || m2 == null || m2p == null || m3 == null || m3p == null) {
      return 'EMAs not warmed up on this bar';
    }

    const dPrice = price - prevPrice;
    const dMA1 = m1 - m1p;
    const dMA2 = m2 - m2p;

    const xUnderMA3 = prevPrice >= m3p && price < m3;
    const xOverMA3 = prevPrice <= m3p && price > m3;
    const xUnderMA1 = prevPrice >= m1p && price < m1;
    const xOverMA1 = prevPrice <= m1p && price > m1;

    let long = xUnderMA3 || (dPrice < 0 && dMA1 < 0 && xUnderMA1 && dMA2 > 0);
    let short = xOverMA3 || (dPrice > 0 && dMA1 > 0 && xOverMA1 && dMA2 < 0);
    if (this.invertActive) {
      const t = long;
      long = short;
      short = t;
    }

    // The source submits both entries when both fire; the short lands last, so
    // the net intended position is short. Reproduced by testing short first.
    if (short) {
      this.signalSide = 'short';
      this.entryDone = false;
      return `short rule (${xOverMA3 ? 'EMA3 cross-over' : 'EMA2/EMA4 slope'}) -> hold short`;
    }
    if (long) {
      this.signalSide = 'long';
      this.entryDone = false;
      return `long rule (${xUnderMA3 ? 'EMA3 cross-under' : 'EMA2/EMA4 slope'}) -> hold long`;
    }

    return 'no signal on this bar';
  }

  // Places one market entry. The original uses strategy.entry (a market order),
  // and an always-in reversal cannot safely rest an unfilled limit, so this
  // stays a market order. No stop and no target travel with the order — the next
  // opposite signal is the only exit.
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
        `EmaSlopeCross ${side}: ${this.lastReason} at ${entry} — ` +
        `market entry, no bracket, the next opposite signal reverses`,
      meta: {
        exitMode: 'reverse',
        family: 'ema-slope-cross-1m',
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

    // IST session for the bar we are deciding on: normal / invert / off.
    const session = sessionAt(last.time);
    // Crossing a session boundary clears the stale signal, so a window always
    // starts from a FRESH rule — a pre-window signal is never carried across
    // (and never re-interpreted under the new invert setting).
    if (session.state !== this.sessionState) {
      this.sessionState = session.state;
      this.signalSide = null;
      this.entryDone = false;
    }
    this.invertActive = session.invert;

    // One signal decision per closed 1m bar. The decision BELOW still runs on
    // every tick, so a pending close or entry is acted on without waiting a bar.
    if (last.time !== this.lastBarTime) {
      this.computeContext(candles);
      this.lastBarTime = last.time;
      this.lastReason = this.detectSignal(candles);
    }

    const positions = Array.isArray(state.positions) ? state.positions : [];
    const position = positions[0] || null;

    // --- outside the trading windows: stand down ----------------------------
    // 09:00-18:00 normal and 22:00-06:00 inverted are the only live windows; the
    // rest of the clock trades nothing and flattens anything still open.
    if (session.state === 'off') {
      if (position) {
        return {
          action: 'CLOSE',
          symbol: this.symbol,
          strategyName: this.name,
          reason: `outside trading windows (IST) -> flatten ${position.side}`,
        };
      }
      return { action: 'HOLD', reason: 'outside trading windows: 09:00-18:00 normal, 22:00-06:00 inverted (IST)' };
    }

    // --- holding a position -------------------------------------------------
    if (position) {
      // An opposite signal is the reverse leg: close at market, re-enter next.
      if (this.signalSide && position.side && position.side !== this.signalSide) {
        return {
          action: 'CLOSE',
          symbol: this.symbol,
          strategyName: this.name,
          reason: `reverse ${position.side} -> ${this.signalSide} (${this.lastReason})`,
        };
      }
      // Otherwise the current signal is already the side we hold.
      this.entryDone = true;
      return { action: 'HOLD', reason: `holding ${position.side}; ${this.lastReason}` };
    }

    // --- flat ---------------------------------------------------------------
    if (state.hasLiveOrder) return { action: 'HOLD', reason: 'an entry is already working' };
    if (!this.signalSide) return { action: 'HOLD', reason: this.lastReason || 'no signal yet' };
    if (this.entryDone) return { action: 'HOLD', reason: 'the signal has already been traded' };

    return this.buildEntry(this.signalSide, last);
  }
}

module.exports = new EmaSlopeCross1m();
