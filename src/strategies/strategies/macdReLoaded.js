// "MACD ReLoaded" (TradingView Pine v5, © KivancOzbilgic) ported to the live
// engine at the 1-MINUTE resolution.
//
// WHAT IT IS
// ----------
// A MACD whose three moving averages (the fast line, the slow line and the
// signal line) can each be built from ANY of eleven moving-average types, all
// selectable with one `mav` input (default VAR — a CMO/VIDYA-style adaptive
// average):
//
//   MA12 = getMA(src, 12)                       // `mav` applied to close
//   MA26 = getMA(src, 26)                       // `mav` applied to close
//   src2 = MA12 - MA26                          // the MACD line
//   MATR = getMA(src2, 9)                       // the signal line
//   hist = src2 - MATR                          // the histogram
//   buy  = ta.crossover (hist, 0)               // hist crosses ABOVE zero
//   sell = ta.crossunder(hist, 0)               // hist crosses BELOW zero
//   strategy.entry("MacdLong" / "MacdShort")    // market, no stop, no target
//
// The published script has no stop, no target and never calls strategy.close,
// so an opposite signal is the ONLY exit — an always-in reversal, exactly like
// the sibling ports in this folder.
//
// PORT NOTES / DEVIATIONS FROM THE PINE SOURCE
// --------------------------------------------
// 1. RESOLUTION. The source is "any timeframe"; this port runs on the engine's
//    1m feed (candles1m).
// 2. The date-window inputs (FromMonth/.../ToYear) and the local `window()`
//    helper are defined in the source but NEVER used by any condition — they are
//    dead code. They are dropped here.
// 3. SIZING. Pine defaults to 1 contract; like the sibling ports this uses a
//    pinned lot size (LOTS) so the risk manager's order/position caps stay
//    meaningful.
// 4. FILLS. The signal is read on the last CLOSED 1m bar and entered at market
//    on the next engine cycle. Non-repainting.
// 5. The cosmetic inputs (barcoloring / barcolor) are display-only and dropped.
// 6. MA SEEDING. Pine's ta.ema seeds with the SMA of the first `length` values;
//    that same seed is used here (see ema() below), matching emaSlopeCross1m.js.
//    The source's own WWMA/TILL recursions seed from 0 in Pine, but those paths
//    are only reachable if MAV is switched away from the VAR default.
//
// To run it: set ACTIVE_STRATEGY = 'MacdReLoaded' in
// src/strategies/strategyManager.js and restart the server. The instrument comes
// from .env (TRADING_SYMBOL / TRADING_SYMBOLS).

// --- source inputs ---------------------------------------------------------
const MAV = 'VAR'; // "Moving Average Type": SMA|EMA|WMA|DEMA|TMA|VAR|WWMA|ZLEMA|TSF|HULL|TILL
const LENGTH = 12; // "Short Moving Average Length"
const LENGTH1 = 26; // "Long Moving Average Length"
const LENGTH2 = 9; // "Trigger Length"
const T3A1 = 0.7; // "TILLSON T3 Volume Factor"
const CMO_PERIOD = 9; // math.sum window inside the VAR (VIDYA) average

// Everything is built from `close` (the source's `src` input default).

// The signal line needs LENGTH1 + LENGTH2 bars before the histogram is fully
// warmed up; add a margin so the first evaluated bar is never a warm-up artifact.
const MIN_BARS = LENGTH1 + LENGTH2 + 25;

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
//   false -> the rules as written (long on a hist cross above zero, short below)
//   true  -> INVERT the signal (the fade).
// The flip is applied to the side we intend to HOLD (signalSide), never to the
// order action — buildEntry still does BUY-for-long / SELL-for-short.
const INVERT_SIGNALS = true;

// ---------------------------------------------------------------------------
// Indicators
//
// Deliberately local, like the ports around them: the shared
// src/utils/indicators.js is kept in sync with the backtests.
// ---------------------------------------------------------------------------

// Pine's ta.sma: simple average over the trailing `len` finite values.
function sma(values, len) {
  const n = values.length;
  const out = new Array(n).fill(null);
  const length = Math.floor(Number(len));
  if (!(length > 0)) return out;

  for (let i = length - 1; i < n; i += 1) {
    let sum = 0;
    let ok = true;
    for (let k = 0; k < length; k += 1) {
      const v = values[i - k];
      if (v == null || !Number.isFinite(v)) {
        ok = false;
        break;
      }
      sum += v;
    }
    if (ok) out[i] = sum / length;
  }
  return out;
}

// Pine's ta.ema: the SMA of the first `length` finite values seeds the series,
// then v = src * k + v[1] * (1 - k) with k = 2 / (length + 1). Leading nulls are
// skipped so this can also be chained on the output of another average.
function ema(values, len) {
  const n = values.length;
  const out = new Array(n).fill(null);
  const length = Math.floor(Number(len));
  if (!(length > 0)) return out;

  const k = 2 / (length + 1);
  let sum = 0;
  let count = 0;
  let prev = null;

  for (let i = 0; i < n; i += 1) {
    const v = values[i];

    if (prev == null) {
      // Warm up: accumulate until `length` consecutive finite values, then seed.
      if (v == null || !Number.isFinite(v)) {
        sum = 0;
        count = 0;
        continue;
      }
      sum += v;
      count += 1;
      if (count === length) {
        prev = sum / length;
        out[i] = prev;
      }
      continue;
    }

    if (v == null || !Number.isFinite(v)) {
      prev = null;
      sum = 0;
      count = 0;
      continue;
    }
    prev = v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// Pine's ta.rma / SMMA (also used for the source's Wilder WWMA): the SMA seeds
// index len-1, then (v[1] * (len - 1) + src) / len.
function rma(values, len) {
  const n = values.length;
  const out = new Array(n).fill(null);
  const length = Math.floor(Number(len));
  if (n < length) return out;

  let sum = 0;
  for (let i = 0; i < length; i += 1) sum += values[i];
  out[length - 1] = sum / length;

  for (let i = length; i < n; i += 1) out[i] = (out[i - 1] * (length - 1) + values[i]) / length;
  return out;
}

// Pine's ta.wma: weight `len` on the newest value down to 1 on the oldest.
function wma(values, len) {
  const n = values.length;
  const out = new Array(n).fill(null);
  const length = Math.floor(Number(len));
  if (!(length > 0)) return out;

  const weightSum = (length * (length + 1)) / 2;
  for (let i = length - 1; i < n; i += 1) {
    let acc = 0;
    let ok = true;
    for (let k = 0; k < length; k += 1) {
      const v = values[i - k];
      if (v == null || !Number.isFinite(v)) {
        ok = false;
        break;
      }
      acc += v * (length - k);
    }
    if (ok) out[i] = acc / weightSum;
  }
  return out;
}

// Pine's ta.linreg: least-squares regression over the last `length` bars,
// evaluated `offset` bars back from the newest bar. Returns a series.
function linreg(values, len, offset) {
  const n = values.length;
  const out = new Array(n).fill(null);
  const length = Math.floor(Number(len));
  if (!(length > 0) || n < length) return out;

  const sumX = (length * (length - 1)) / 2;
  const sumX2 = ((length - 1) * length * (2 * length - 1)) / 6;
  const denom = length * sumX2 - sumX * sumX;

  for (let i = length - 1; i < n; i += 1) {
    let sumY = 0;
    let sumXY = 0;
    let ok = true;
    for (let k = 0; k < length; k += 1) {
      const y = values[i - k];
      if (y == null || !Number.isFinite(y)) {
        ok = false;
        break;
      }
      const x = length - 1 - k; // x: 0 = oldest bar, length-1 = newest bar
      sumY += y;
      sumXY += x * y;
    }
    if (!ok) continue;
    const slope = denom === 0 ? 0 : (length * sumXY - sumX * sumY) / denom;
    const intercept = (sumY - slope * sumX) / length;
    out[i] = intercept + slope * (length - 1 - offset);
  }
  return out;
}

// DEMA = 2*EMA - EMA(EMA).
function dema(values, len) {
  const e1 = ema(values, len);
  const e2 = ema(e1, len);
  return values.map((_, i) => (e1[i] == null || e2[i] == null ? null : 2 * e1[i] - e2[i]));
}

// TMA = SMA(SMA(src, ceil(len/2)), floor(len/2) + 1).
function tma(values, len) {
  const length = Math.floor(Number(len));
  return sma(sma(values, Math.ceil(length / 2)), Math.floor(length / 2) + 1);
}

// The source's VAR: a VIDYA-style adaptive average whose smoothing is scaled by
// |CMO| over CMO_PERIOD (9). Pine's math.sum is na until 9 values exist, so the
// effective CMO is 0 there (nz) and the average simply carries the seed.
function varMa(values, len, cmoPeriod = CMO_PERIOD) {
  const n = values.length;
  const out = new Array(n).fill(null);
  const alpha = 2 / (Number(len) + 1);

  let prev = 0;
  for (let i = 0; i < n; i += 1) {
    let vUD = 0;
    let vDD = 0;
    let ok = true;
    for (let k = 0; k < cmoPeriod; k += 1) {
      const idx = i - k;
      const prevIdx = idx - 1;
      if (prevIdx < 0) {
        ok = false;
        break;
      }
      const cur = values[idx];
      const pr = values[prevIdx];
      if (cur == null || pr == null || !Number.isFinite(cur) || !Number.isFinite(pr)) {
        ok = false;
        break;
      }
      if (cur > pr) vUD += cur - pr;
      else if (cur < pr) vDD += pr - cur;
    }

    const cmo = ok && vUD + vDD !== 0 ? (vUD - vDD) / (vUD + vDD) : 0;
    const v = values[i];
    if (v == null || !Number.isFinite(v)) {
      prev = 0;
      continue;
    }
    prev = alpha * Math.abs(cmo) * v + (1 - alpha * Math.abs(cmo)) * prev;
    out[i] = prev;
  }
  return out;
}

// ZLEMA = EMA of the de-lagged series src + src - src[zxLag].
function zlema(values, len) {
  const length = Math.floor(Number(len));
  const lag = length / 2 === Math.round(length / 2) ? length / 2 : (length - 1) / 2;
  const lagInt = Math.floor(lag);
  const adjusted = values.map((v, i) => {
    if (i - lagInt < 0 || v == null || values[i - lagInt] == null) return null;
    return v + v - values[i - lagInt];
  });
  return ema(adjusted, length);
}

// TSF = linreg(src, len, 0) + (linreg(src, len, 0) - linreg(src, len, 1)).
function tsf(values, len) {
  const lrc = linreg(values, len, 0);
  const lrc1 = linreg(values, len, 1);
  return values.map((_, i) => (lrc[i] == null || lrc1[i] == null ? null : lrc[i] + (lrc[i] - lrc1[i])));
}

// HMA = WMA(2 * WMA(src, len/2) - WMA(src, len), round(sqrt(len))).
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

// TILL = the T3: Tim Tillson's six-times-smoothed EMA combination.
function t3(values, len, a) {
  const e1 = ema(values, len);
  const e2 = ema(e1, len);
  const e3 = ema(e2, len);
  const e4 = ema(e3, len);
  const e5 = ema(e4, len);
  const e6 = ema(e5, len);

  const c1 = -a * a * a;
  const c2 = 3 * a * a + 3 * a * a * a;
  const c3 = -6 * a * a - 3 * a - 3 * a * a * a;
  const c4 = 1 + 3 * a + a * a * a + 3 * a * a;

  return values.map((_, i) => {
    if (e6[i] == null || e5[i] == null || e4[i] == null || e3[i] == null) return null;
    return c1 * e6[i] + c2 * e5[i] + c3 * e4[i] + c4 * e3[i];
  });
}

// The source's getMA/getMA1/getMA2: pick one average by the `mav` input.
function movingAverage(type, values, len, t3a) {
  switch (type) {
    case 'SMA':
      return sma(values, len);
    case 'EMA':
      return ema(values, len);
    case 'WMA':
      return wma(values, len);
    case 'DEMA':
      return dema(values, len);
    case 'TMA':
      return tma(values, len);
    case 'WWMA':
      return rma(values, len);
    case 'ZLEMA':
      return zlema(values, len);
    case 'TSF':
      return tsf(values, len);
    case 'HULL':
      return hma(values, len);
    case 'TILL':
      return t3(values, len, t3a);
    case 'VAR':
    default:
      return varMa(values, len);
  }
}

// ---------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------

class MacdReLoaded {
  constructor() {
    this.name = 'MacdReLoaded';
    this.description =
      `KivancOzbilgic "MACD ReLoaded" (Pine v5) on the 1m chart: a MACD built from the ` +
      `"${MAV}" moving average — MA12(getMA, ${LENGTH}) - MA26(getMA, ${LENGTH1}), signal ` +
      `getMA(${LENGTH2}) of that line, and the histogram crossing zero. No stop and no target: ` +
      `the next opposite signal reverses.`;
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
    return new MacdReLoaded();
  }

  reset() {
    this.lastBarTime = 0; // last closed 1m bar already evaluated
    this.ma12 = null; // getMA(close, LENGTH)
    this.ma26 = null; // getMA(close, LENGTH1)
    this.macd = null; // MA12 - MA26 (the MACD line, src2)
    this.signalLine = null; // getMA(macd, LENGTH2) (MATR)
    this.hist = null; // macd - signalLine
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

  // Rebuilds the MACD context once per closed bar: the two `mav`-smoothed lines,
  // the MACD line, its `mav`-smoothed signal line and the histogram.
  computeContext(candles) {
    const closes = candles.map((c) => c.close);

    this.ma12 = movingAverage(MAV, closes, LENGTH, T3A1);
    this.ma26 = movingAverage(MAV, closes, LENGTH1, T3A1);

    this.macd = closes.map((_, i) =>
      this.ma12[i] == null || this.ma26[i] == null ? null : this.ma12[i] - this.ma26[i]
    );

    this.signalLine = movingAverage(MAV, this.macd, LENGTH2, T3A1);

    this.hist = this.macd.map((m, i) =>
      m == null || this.signalLine[i] == null ? null : m - this.signalLine[i]
    );
  }

  // Looks for the histogram zero-cross on the last closed bar. Sets signalSide
  // when one fires; returns a human-readable reason either way.
  detectSignal() {
    const hist = this.hist || [];
    const i = hist.length - 1;
    if (i < 1) return 'need one prior bar';

    const h = hist[i];
    const hp = hist[i - 1];
    if (h == null || hp == null) return 'MACD histogram not warmed up on this bar';

    // Pine's ta.crossover/crossunder against a constant 0.
    let buy = hp <= 0 && h > 0;
    let sell = hp >= 0 && h < 0;
    if (INVERT_SIGNALS) {
      const swap = buy;
      buy = sell;
      sell = swap;
    }

    if (buy) {
      this.signalSide = 'long';
      this.entryDone = false;
      return `hist crossed above 0${INVERT_SIGNALS ? ' (inverted -> long)' : ''} -> hold long`;
    }
    if (sell) {
      this.signalSide = 'short';
      this.entryDone = false;
      return `hist crossed below 0${INVERT_SIGNALS ? ' (inverted -> short)' : ''} -> hold short`;
    }

    return `no zero-cross on this bar (hist ${h.toFixed(6)})`;
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
        `MacdReLoaded ${side}: ${this.lastReason} at ${this.fmt(entry)} — ` +
        'market entry, no bracket, the next opposite signal reverses',
      meta: {
        exitMode: 'reverse',
        family: 'macd-reloaded',
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
      this.lastReason = this.detectSignal();
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

module.exports = new MacdReLoaded();
