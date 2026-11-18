// "Ichimoku + Daily-Candle_X + HULL-MA_X + MacD" (TradingView Pine v4,
// © SeaSide420) ported to the live engine.
//
// WHAT IT IS
// ----------
// A five-filter confluence system. It fires only when ALL FIVE agree, so a
// signal is rare by construction:
//
//   1. HULL-MA cross   hma1 > hma2   (long) / hma1 < hma2 (short)
//      hma1 = HMA(open, 14) on the 1m chart, hma2 = the same series one bar back
//      (the source compares hma(price) with hma(price[1]) — a slope test, not a
//      crossover of two different lengths).
//   2. Daily candle    D1 > D2       (long) / D1 < D2 (short)
//      the source compares the DAILY open with its previous value: is today
//      opening above yesterday's open.
//   3. Price vs HULL   price > hma2  (long) / price < hma2 (short)
//      price is the source's `open` input — the 1m bar's OPEN, not the close.
//   4. Ichimoku cloud  leadLine1 > leadLine2 (long) / < (short)
//      conversion = donchian(9), base = donchian(26), lead1 = avg of the two,
//      lead2 = donchian(52). Donchian here is avg(lowest(low,len), highest(high,len))
//      on the 1m chart, WITH the current bar included (Pine's lowest/highest default).
//   5. MACD (HULL)     MACD > aMACD  (long) / < (short)
//      MACD = HMA(open,12) - HMA(open,26), aMACD = HMA(MACD, 9) — a Hull-smoothed
//      MACD, not the classic EMA one.
//
// The published script has no stop, no target and no strategy.close: the
// SL/TP block is commented out in the source. Like the other reversal ports in
// this folder, an opposite signal is therefore the only exit.
//
// PORT NOTES / DEVIATIONS FROM THE PINE SOURCE
// --------------------------------------------
// 1. RESOLUTION. The source is "any timeframe"; this port runs on the engine's
//    1m feed (candles1m), and its `security(syminfo.tickerid, "D", ...)` daily
//    call is rebuilt from the 1h feed (candles1h), grouped into UTC days — see
//    dailyOpens() below. That is the only higher-timeframe series the engine
//    hands a strategy; there is no daily feed.
// 2. `barmerge.lookahead_off` is honoured: only completed 1m bars are read
//    (never the forming bar), so a signal cannot repaint. The daily comparison
//    uses the two most recent day opens that are already known.
// 3. The source's `LS=price, offset = -displacement` line assigns a tuple to a
//    variable and is dead code — the Lagging Span is never plotted nor used by
//    any condition. It is dropped here, and `offset`/`displacement` with it.
// 4. SIZING. Pine trades 100% of equity (percent_of_equity). Like the sibling
//    ports this uses a pinned lot size instead — see LOTS below — so the risk
//    manager's order/position caps stay meaningful.
// 5. FILLS. The signal is read on the last CLOSED 1m bar and entered at market
//    on the next engine cycle.
//
// To run it: set ACTIVE_STRATEGY = 'IchimokuHullMacd' in
// src/strategies/strategyManager.js and restart the server. The instrument comes
// from .env (TRADING_SYMBOL / TRADING_SYMBOLS).

// --- source inputs ---------------------------------------------------------
const PERIOD = 14; // "Double HullMA X Period"
const MACD_LEN = 9; // aMACD smoothing length
const MACD_FAST = 12;
const MACD_SLOW = 26;
const CONVERSION_PERIOD = 9; // Ichimoku conversion line
const BASE_PERIOD = 26; // Ichimoku base line
const LAGGING_SPAN_PERIOD = 52; // Ichimoku lead line 2

// The 1m window every filter needs before the whole `and` chain can be true:
// leadLine2 needs 52 bars and hma2 is hma1 shifted one bar further.
const MIN_BARS = 60;

// Daily-loss kill switch for THIS strategy only.
//   true  -> obey RISK_MAX_DAILY_LOSS: once the day's realised loss crosses the
//            cap every order for this strategy is rejected.
//   false -> keep trading no matter what the day's P&L is.
const HALT_ON_DAILY_LOSS = false;

// Order size in CONTRACTS (Delta "lots"):
//   > 0 -> that exact number of contracts, and it WINS over
//          STRATEGY_FIXED_CONTRACTS in .env.
//   = 0 -> fall back to STRATEGY_FIXED_CONTRACTS, and if that is 0 as well, size
//          from percent_of_equity (10% notional), floored at minContracts.
const LOTS = 1;

// ---------------------------------------------------------------------------
// Indicators
//
// These are deliberately local, like the ema() in emaSlopeCross1m.js: the
// shared src/utils/indicators.js is kept in sync with the backtests, and this
// strategy has no backtest counterpart yet.
// ---------------------------------------------------------------------------

// Pine's ta.wma: the linear weighted average, weight `len` on the newest value
// down to 1 on the oldest. Returns null until `len` values are available.
function wma(values, len) {
  const n = values.length;
  const out = new Array(n).fill(null);

  const length = Math.floor(Number(len));
  if (!(length > 0) || n < length) return out;

  const weightSum = (length * (length + 1)) / 2;

  for (let i = length - 1; i < n; i += 1) {
    let acc = 0;
    for (let k = 0; k < length; k += 1) {
      const value = values[i - k];
      if (value == null || !Number.isFinite(value)) {
        acc = null;
        break;
      }
      acc += value * (length - k);
    }
    out[i] = acc == null ? null : acc / weightSum;
  }

  return out;
}

// Pine's ta.hma: HMA = WMA(2 * WMA(src, len/2) - WMA(src, len), round(sqrt(len))).
// A fractional len/2 is truncated, matching Pine's float-to-int cast.
function hma(values, len) {
  const length = Math.floor(Number(len));
  const half = Math.floor(length / 2);
  const root = Math.round(Math.sqrt(length));

  const shortWma = wma(values, half);
  const longWma = wma(values, length);
  const diff = values.map((_, i) =>
    shortWma[i] == null || longWma[i] == null ? null : 2 * shortWma[i] - longWma[i]
  );

  return wma(diff, root);
}

// ---------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------

class IchimokuHullMacd {
  constructor() {
    this.name = 'IchimokuHullMacd';
    this.description =
      'SeaSide420 "Ichimoku + Daily-Candle_X + HULL-MA_X + MacD" (Pine v4) on the 1m chart: ' +
      'Hull-MA(14) slope of the bar OPEN, the daily open vs its previous value, price vs the ' +
      'Hull-MA, the Ichimoku cloud (9/26/52 donchian) and a Hull-smoothed MACD (12/26/9) must ' +
      'all point the same way. No stop and no target: the next opposite signal reverses.';
    // Left blank on purpose: the engine sets this to the tracked symbol on start
    // (see tradingEngine.applyProductSettings), so the instrument is configured
    // in one place — .env — and can never disagree with the market feed.
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
    return new IchimokuHullMacd();
  }

  reset() {
    this.lastBarTime = 0; // last closed 1m bar already evaluated
    this.signalSide = null; // 'long' | 'short' — the side to hold after the last signal
    this.entryDone = false; // whether that signal has already been acted on
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

  // The daily-open series, rebuilt from the 1h candles: the open of the FIRST
  // 1h bar of each UTC day is that day's open. Returned oldest-first.
  dailyOpens(candles1h) {
    const byDay = new Map();

    for (const candle of Array.isArray(candles1h) ? candles1h : []) {
      if (!candle || !candle.time) continue;
      const day = new Date(candle.time).toISOString().slice(0, 10);
      if (!byDay.has(day)) byDay.set(day, Number(candle.open));
    }

    return [...byDay.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([, open]) => open);
  }

  // Pine's lowest(len) / highest(len) — the extremes over the last `len` bars,
  // INCLUDING the current one.
  donchianMid(candles, i, len) {
    if (i < len - 1) return null;

    let lo = Infinity;
    let hi = -Infinity;
    for (let k = i - len + 1; k <= i; k += 1) {
      if (candles[k].low < lo) lo = candles[k].low;
      if (candles[k].high > hi) hi = candles[k].high;
    }

    return (lo + hi) / 2;
  }

  // Rebuilds the 1m indicator context once per closed bar. Everything is derived
  // from the bar OPEN, because the source's `price` input defaults to `open`.
  computeContext(candles) {
    const opens = candles.map((c) => c.open);
    const macdFast = hma(opens, MACD_FAST); // hma(price, MACD_fastLength)
    const macdSlow = hma(opens, MACD_SLOW); // hma(price, MACD_slowLength)

    this.hma1 = hma(opens, PERIOD); // hma(price, Period)
    this.macd = opens.map((_, i) =>
      macdFast[i] == null || macdSlow[i] == null ? null : macdFast[i] - macdSlow[i]
    );
    this.aMacd = hma(this.macd, MACD_LEN); // hma(MACD, MACD_Length)
  }

  // Looks for the five-filter condition on the last closed bar. Sets signalSide
  // when it fires; returns a human-readable reason either way.
  detectSignal(candles, candles1h) {
    const i = candles.length - 1;
    if (i < 1) return 'need one prior bar';

    const last = candles[i];
    const price = Number(last.open); // the source's `price` input = open

    const hma1 = this.hma1[i];
    const hma2 = this.hma1[i - 1]; // hma(price[1], Period)
    const macd = this.macd[i];
    const aMacd = this.aMacd[i];

    if (hma1 == null || hma2 == null || macd == null || aMacd == null) {
      return 'Hull-MA / MACD not warmed up on this bar';
    }

    // --- Ichimoku cloud, on the 1m chart -----------------------------------
    const conversionLine = this.donchianMid(candles, i, CONVERSION_PERIOD);
    const baseLine = this.donchianMid(candles, i, BASE_PERIOD);
    const leadLine2 = this.donchianMid(candles, i, LAGGING_SPAN_PERIOD);
    if (conversionLine == null || baseLine == null || leadLine2 == null) {
      return 'Ichimoku not warmed up on this bar';
    }
    const leadLine1 = (conversionLine + baseLine) / 2;

    // --- daily open vs its previous value ----------------------------------
    const opens = this.dailyOpens(candles1h);
    if (opens.length < 2) {
      return `daily filter warming up (${opens.length}/2 day opens from the 1h feed)`;
    }
    const d1 = opens[opens.length - 1]; // current day's open
    const d2 = opens[opens.length - 2]; // previous day's open

    const hullUp = hma1 > hma2;
    const cloudUp = leadLine1 > leadLine2;
    const macdUp = macd > aMacd;

    const longCondition = hullUp && d1 > d2 && price > hma2 && cloudUp && macdUp;
    const shortCondition = !hullUp && d1 < d2 && price < hma2 && !cloudUp && !macdUp;

    if (shortCondition) {
      this.signalSide = 'short';
      this.entryDone = false;
      return 'short rule (all five filters bearish) -> hold short';
    }
    if (longCondition) {
      this.signalSide = 'long';
      this.entryDone = false;
      return 'long rule (all five filters bullish) -> hold long';
    }

    // Who voted against the majority, for the log line.
    const bullish = [hullUp, d1 > d2, price > hma2, cloudUp, macdUp];
    const agree = bullish.filter(Boolean).length;
    return `${agree}/5 filters bullish — no signal`;
  }

  // Places one market entry. The source uses strategy.entry (a market order),
  // and a reversal cannot safely rest an unfilled limit, so this stays a market
  // order. No stop and no target travel with the order — the next opposite
  // signal is the only exit.
  buildEntry(side, price) {
    const entry = this.snap(price);
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
        `IchimokuHullMacd ${side}: ${this.lastReason} at ${this.fmt(entry)} — ` +
        'market entry, no bracket, the next opposite signal reverses',
      meta: {
        exitMode: 'reverse',
        family: 'ichimoku-hull-macd',
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

    // One signal decision per closed 1m bar. The decision BELOW still runs on
    // every tick, so a pending close or entry is acted on without waiting a bar.
    if (last.time !== this.lastBarTime) {
      this.computeContext(candles);
      this.lastBarTime = last.time;
      this.lastReason = this.detectSignal(candles, marketData.candles1h);
    }

    const positions = Array.isArray(state.positions) ? state.positions : [];
    const position = positions[0] || null;

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

    const price = Number(marketData.price) || Number(last.close) || 0;
    return this.buildEntry(this.signalSide, price);
  }
}

module.exports = new IchimokuHullMacd();
