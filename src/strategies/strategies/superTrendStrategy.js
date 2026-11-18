// "SuperTrend STRATEGY" (TradingView Pine v4, © KivancOzbilgic) ported to the
// live engine at the 1-MINUTE resolution.
//
// WHAT IT IS
// ----------
// The classic KivancOzbilgic SuperTrend reversal, in full:
//
//   atr        = atr(Periods)      // ta.atr (RMA of true range), Periods=10
//   src        = hl2               // (high+low)/2
//   up  = src - Multiplier*atr     // the LOWER band  -> ratchets UP
//   dn  = src + Multiplier*atr     // the UPPER band  -> ratchets DOWN
//   trend flips  -1 -> 1  when close crosses ABOVE dn[1]  (the upper band)
//   trend flips   1 -> -1 when close crosses BELOW up[1]  (the lower band)
//   buy  = trend turns 1   (was -1)
//   sell = trend turns -1  (was 1)
//   strategy.entry("BUY"/"SELL")   // market, no stop, no target
//
// NAMING QUIRK: the source's variables are inverted vs the usual convention —
// `up` is the LOWER band (the long trailing line) and `dn` is the UPPER band.
// The port keeps the source's names so a line-by-line comparison is possible.
//
// The published script has no stop, no target and never calls strategy.close,
// so an opposite signal is the ONLY exit — an always-in reversal, exactly like
// the sibling ports in this folder.
//
// PORT NOTES / DEVIATIONS FROM THE PINE SOURCE
// --------------------------------------------
// 1. RESOLUTION. The source is "any timeframe"; this port runs on the engine's
//    1m feed (candles1m).
// 2. `changeATR` (use ta.atr vs sma(tr, Periods)) is exposed below as
//    CHANGE_ATR_METHOD; the source default (ta.atr) is kept.
// 3. SIZING. Pine trades 1 contract by default; this uses a pinned lot size
//    (LOTS) so the risk manager's order/position caps stay meaningful — same
//    convention as the other strategy ports.
// 4. FILLS. The signal is read on the last CLOSED 1m bar and entered at market
//    on the next engine cycle. Non-repainting.
// 5. The cosmetic inputs (showsignals / highlighting / barcoloring) and the
//    date-window filter are display-only in the source and are dropped here.
//
// To run it: it is the strategy wired as ACTIVE_STRATEGY in
// src/strategies/strategyManager.js. The instrument list comes from .env
// (TRADING_SYMBOL / TRADING_SYMBOLS).

// --- source inputs ---------------------------------------------------------
const ATR_PERIOD = 10; // "ATR Period"
const MULTIPLIER = 3.0; // "ATR Multiplier"
const CHANGE_ATR_METHOD = true; // "Change ATR Calculation Method ?" (true = ta.atr, false = sma(tr))
// `src` defaults to hl2; the bands are always built from hl2 here.

// The ATR needs ATR_PERIOD bars to seed and trend needs one prior bar.
const MIN_BARS = ATR_PERIOD + 10;

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

// The published (non-faded) mapping, kept as an explicit switch:
//   false -> the rules as written (buy the trend flip up, sell the flip down)
//   true  -> INVERT the signal (buy the flip down, sell the flip up) — the faded
//            version, which is what was requested and wired live.
// The flip is applied to the side we intend to HOLD (signalSide), never to the
// order action — buildEntry still does BUY-for-long / SELL-for-short. That keeps
// `signalSide === position.side`, which is what the reverse-on-opposite test
// compares.
const INVERT_SIGNALS = false;

// ---------------------------------------------------------------------------
// Indicators
//
// Deliberately local, like the ema() in emaSlopeCross1m.js: the shared
// src/utils/indicators.js is kept in sync with the backtests, and this strategy
// pairs with backtest/supertrend-strategy.js.
// ---------------------------------------------------------------------------

// Pine's ta.rma / SMMA: SMA seed at index len-1, then (v[1]*(len-1)+src)/len.
function rma(values, len) {
  const n = values.length;
  const out = new Array(n).fill(null);
  if (n < len) return out;

  let sum = 0;
  for (let i = 0; i < len; i += 1) sum += values[i];
  out[len - 1] = sum / len;

  for (let i = len; i < n; i += 1) out[i] = (out[i - 1] * (len - 1) + values[i]) / len;
  return out;
}

// Pine's ta.sma: simple average over the trailing `len` values.
function sma(values, len) {
  const n = values.length;
  const out = new Array(n).fill(null);
  if (n < len) return out;
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    sum += values[i];
    if (i >= len) sum -= values[i - len];
    if (i >= len - 1) out[i] = sum / len;
  }
  return out;
}

// Pine's `tr` series: tr[0] = high-low, then max(high-low, |high-close[1]|, |low-close[1]|).
function trueRange(candles) {
  return candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const pc = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
  });
}

// ---------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------

class SuperTrendStrategy {
  constructor() {
    this.name = 'SuperTrendStrategy';
    this.description =
      'KivancOzbilgic "SuperTrend STRATEGY" (Pine v4) on the 1m chart: ATR(10) x 3 bands around ' +
      'hl2, ratcheting the lower band up and the upper band down; the trend flips when the close ' +
      'crosses the opposite band and BUY/SELL fire on the flip. No stop and no target: the next ' +
      'opposite signal reverses. Signals are INVERTED (the fade) — see INVERT_SIGNALS.';
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
    return new SuperTrendStrategy();
  }

  reset() {
    this.lastBarTime = 0; // last closed 1m bar already evaluated
    this.trend = null; // SuperTrend trend series (1 bull / -1 bear / null warm-up)
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

  // The full SuperTrend trend series, rebuilt once per closed bar. Faithful to
  // the source: the bands ratchet off the PREVIOUS bar's final values and the
  // trend only flips against those, so nothing repaints.
  trendSeries(candles) {
    const n = candles.length;
    const tr = trueRange(candles);
    const atr = CHANGE_ATR_METHOD ? rma(tr, ATR_PERIOD) : sma(tr, ATR_PERIOD);

    const up = new Array(n).fill(null);
    const dn = new Array(n).fill(null);
    const trend = new Array(n).fill(null);

    for (let i = 0; i < n; i += 1) {
      const a = atr[i];
      if (a == null || !(a > 0)) continue;

      const src = (candles[i].high + candles[i].low) / 2;
      const rawUp = src - MULTIPLIER * a;
      const rawDn = src + MULTIPLIER * a;

      // nz(up[1], up) / nz(dn[1], dn): fall back to the raw value at the first bar.
      const up1 = i > 0 && up[i - 1] != null ? up[i - 1] : rawUp;
      const dn1 = i > 0 && dn[i - 1] != null ? dn[i - 1] : rawDn;

      // The ratchet uses close[1] (na at bar 0 -> the condition is false).
      up[i] = i > 0 && candles[i - 1].close > up1 ? Math.max(rawUp, up1) : rawUp;
      dn[i] = i > 0 && candles[i - 1].close < dn1 ? Math.min(rawDn, dn1) : rawDn;

      // nz(trend[1], trend): trend starts at 1 and holds through the warm-up.
      const prevTrend = i > 0 && trend[i - 1] != null ? trend[i - 1] : 1;
      let t = prevTrend;
      if (prevTrend === -1 && candles[i].close > dn1) t = 1;
      else if (prevTrend === 1 && candles[i].close < up1) t = -1;
      trend[i] = t;
    }

    return trend;
  }

  // Rebuilds the trend series once per closed bar.
  computeContext(candles) {
    this.trend = this.trendSeries(candles);
  }

  // Looks for a trend flip on the last closed bar. Sets signalSide when one
  // fires; returns a human-readable reason either way.
  detectSignal(candles) {
    const i = candles.length - 1;
    if (i < 1) return 'need one prior bar';

    const t = this.trend ? this.trend[i] : null;
    const tp = this.trend ? this.trend[i - 1] : null;
    if (t == null || tp == null) return 'SuperTrend not warmed up on this bar';

    let buy = t === 1 && tp === -1;
    let sell = t === -1 && tp === 1;
    if (INVERT_SIGNALS) {
      const swap = buy;
      buy = sell;
      sell = swap;
    }

    if (buy) {
      this.signalSide = 'long';
      this.entryDone = false;
      return `SuperTrend flipped UP${INVERT_SIGNALS ? ' (inverted -> long)' : ''} -> hold long`;
    }
    if (sell) {
      this.signalSide = 'short';
      this.entryDone = false;
      return `SuperTrend flipped DOWN${INVERT_SIGNALS ? ' (inverted -> short)' : ''} -> hold short`;
    }

    return `no flip on this bar (trend ${t === 1 ? 'up' : 'down'})`;
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
        `SuperTrendStrategy ${side}: ${this.lastReason} at ${this.fmt(entry)} — ` +
        'market entry, no bracket, the next opposite signal reverses',
      meta: {
        exitMode: 'reverse',
        family: 'supertrend-strategy',
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
      this.lastReason = this.detectSignal(candles);
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

module.exports = new SuperTrendStrategy();
