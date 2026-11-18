// CandleBreakout15m — breakout entries off the last CLOSED 15-minute candle.
//
// Ported from backtest/candle-breakouts.js, which is the same code path the live
// signal is computed on: the family functions below replay the whole candles15m
// array and take the LAST bar's direction, so a live signal and a backtested
// signal are identical (no look-ahead, no repaint).
//
// Four setups live here; SETUPS picks which may fire (first enabled one that
// triggers becomes the signal, in SETUP_PRIORITY order):
//
//   range   Donchian break: close beyond the highest high / lowest low of the
//           prior BREAK_LEN bars, in the direction of the TREND_EMA filter.
//   volume  The same break, but only when the bar's volume exceeds VOL_MULT x
//           SMA(volume, VOL_LEN). Fewer, higher-conviction entries.
//   squeeze Inside-bar / narrow-range compression: when a bar is the narrowest
//           of the last NARROW_LOOKBACK bars its high/low are ARMED; a later
//           close beyond either level (within ARM_BARS) fires.
//   orb     Opening-range breakout: the high/low of the first ORB_BARS of each
//           UTC session; the first close beyond either level in the session.
//
// MEASURED (backtest/candle-breakouts.js, 15m, net of 12 bps round trip):
//   * `range` and `volume` are the profitable ones on the volatile small caps
//     this account trades (EVAAUSD: PF 1.58/1.67 over 90d, +22%/+20%, maxDD
//     5.1%/2.5%; AINUSD and JCTUSD positive too). On majors (BTCUSD/ETHUSD) the
//     gross edge is real but fees eat it — expect roughly break-even there.
//   * `squeeze` and `orb` backtested at/under break-even over 90d on 15m, so
//     they are OFF by default. They are kept so the switch is one line.
//   * a pure ATR trail or a breakeven move HURT (PF fell, trades tripled), so
//     the exit is a plain fixed bracket: STOP_ATR_MULT x ATR stop, TARGET_R x
//     risk target, rested on Delta as one attached reduce-only bracket.
//
// Exits are a fixed bracket: the entry carries `stopLoss` and `takeProfit`, so
// orderManager sends them as ONE attached bracket and Delta owns the exit (in
// paper mode the position manager mirrors them locally). The strategy never has
// to manage the position.
//
// To run it: set ACTIVE_STRATEGY = 'CandleBreakout15m' in
// src/strategies/strategyManager.js and restart the server. The symbol comes
// from .env (TRADING_SYMBOL / TRADING_SYMBOLS). The engine must be fetching the
// 15m feed (STRATEGY_CANDLES_15M > 0 — it is 2000 in .env).

const { atr } = require('../../utils/indicators');
const { normalizeSymbol } = require('../../utils/helpers');
const logger = require('../../utils/logger');

// Which setups may fire. `range` and `volume` are the backtested-profitable
// ones; `squeeze` and `orb` measured at/below break-even on 15m.
const SETUPS = {
  range: true,
  volume: false,
  squeeze: false,
  orb: false,
};

// Tie-break order when more than one setup triggers on the same bar.
const SETUP_PRIORITY = ['range', 'volume', 'squeeze', 'orb'];

// Trend filter: longs only above this EMA, shorts only below. 0 disables it
// (backtested positive either way; the filter trims the chop).
const TREND_EMA = 200;

// The instruments this strategy may trade. Empty = any instrument the engine is
// running on. Fill it (e.g. ['EVAAUSD']) to pin it to a whitelist.
const TRADE_SYMBOLS = [];

// --- setup parameters (see backtest/candle-breakouts.js for the sweeps) -----
const ATR_PERIOD = 14;
const BREAK_LEN = 20; // Donchian look-back for range / volume
const VOL_LEN = 20; // volume SMA length
const VOL_MULT = 1.5; // volume surge multiple
const NARROW_LOOKBACK = 5; // squeeze: narrowest-of look-back
const ARM_BARS = 4; // squeeze: trigger validity, in bars
const ORB_BARS = 4; // opening range = first N bars of the UTC day

// --- exit bracket -----------------------------------------------------------
// Stop = STOP_ATR_MULT x ATR(ATR_PERIOD) from the entry; target = TARGET_R x
// risk. Backtested: 2.5 / 2 was the best risk-adjusted, consistent pair across
// every 7d-90d window. Widen the stop and the win rate rises but trades thin out.
const STOP_ATR_MULT = 2.5;
const TARGET_R = 2;

// Order size in CONTRACTS (Delta "lots").
//   > 0 -> that exact size, and it WINS over STRATEGY_FIXED_CONTRACTS in .env.
//   = 0 -> fall back to STRATEGY_FIXED_CONTRACTS, then to equity sizing.
const LOTS = 1;

// Daily-loss kill switch for THIS strategy only. true -> obey
// RISK_MAX_DAILY_LOSS (orders are rejected once the day's realised loss crosses
// the cap); false -> keep trading whatever the day's P&L is.
const HALT_ON_DAILY_LOSS = true;

// After an entry is sent, ignore the strategy for this long so one signal can
// never open two trades while the position is being created.
const ENTRY_SETTLE_MS = 30 * 1000;

// The EMA(200) needs 200 closes plus the Donchian window to warm up.
const MIN_BARS = TREND_EMA + BREAK_LEN + 1;

const LOG_THROTTLE_MS = 20 * 1000;

// ---------------------------------------------------------------------------
// Indicators
// ---------------------------------------------------------------------------

// Exponential MA; null until `len` bars have accumulated.
function emaSeries(values, len) {
  const n = values.length;
  const out = new Array(n).fill(null);
  if (!(len > 0) || n < len) return out;

  const k = 2 / (len + 1);
  let sum = 0;
  for (let i = 0; i < len; i += 1) sum += values[i];
  out[len - 1] = sum / len;
  for (let i = len; i < n; i += 1) out[i] = values[i] * k + out[i - 1] * (1 - k);
  return out;
}

function smaSeries(values, len) {
  const n = values.length;
  const out = new Array(n).fill(null);
  if (!(len > 0) || n < len) return out;

  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    sum += values[i];
    if (i >= len) sum -= values[i - len];
    if (i >= len - 1) out[i] = sum / len;
  }
  return out;
}

// Highest high / lowest low over the `len` bars ENDING at i-1, so a breakout
// compares the closed bar against the range that PRECEDED it.
function donchianHigh(candles, i, len) {
  if (i - len < 0) return null;
  let m = -Infinity;
  for (let k = i - len; k < i; k += 1) if (candles[k].high > m) m = candles[k].high;
  return m;
}

function donchianLow(candles, i, len) {
  if (i - len < 0) return null;
  let m = Infinity;
  for (let k = i - len; k < i; k += 1) if (candles[k].low < m) m = candles[k].low;
  return m;
}

// ---------------------------------------------------------------------------
// Setup evaluators — each returns a direction for EVERY bar (-1 / 0 / +1)
// ---------------------------------------------------------------------------

// range / volume share the Donchian break; `volumeConfirmed` adds the surge gate.
function levelBreakDirs(candles, ctx, volumeConfirmed) {
  const n = candles.length;
  const dirs = new Array(n).fill(0);

  for (let i = 0; i < n; i += 1) {
    const up = donchianHigh(candles, i, BREAK_LEN);
    const dn = donchianLow(candles, i, BREAK_LEN);
    if (up == null || dn == null) continue;

    if (volumeConfirmed) {
      const volSma = ctx.volSma[i];
      if (volSma == null || !(candles[i].volume > volSma * VOL_MULT)) continue;
    }

    if (candles[i].close > up && ctx.trendAllows(i, 1)) dirs[i] = 1;
    else if (candles[i].close < dn && ctx.trendAllows(i, -1)) dirs[i] = -1;
  }
  return dirs;
}

// Inside-bar / narrow-range squeeze: arm the trigger on a compression bar, then
// fire on the first later close beyond either level (within ARM_BARS).
function squeezeDirs(candles, ctx) {
  const n = candles.length;
  const dirs = new Array(n).fill(0);
  let hi = null;
  let lo = null;
  let expiresAt = -1;

  for (let i = 1; i < n; i += 1) {
    if (i <= expiresAt && hi != null) {
      if (candles[i].close > hi && ctx.trendAllows(i, 1)) {
        dirs[i] = 1;
        expiresAt = -1;
        hi = null;
        lo = null;
        continue;
      }
      if (candles[i].close < lo && ctx.trendAllows(i, -1)) {
        dirs[i] = -1;
        expiresAt = -1;
        hi = null;
        lo = null;
        continue;
      }
    }

    // Compression: this bar's range is the narrowest of the look-back.
    let narrow = true;
    for (let k = Math.max(0, i - (NARROW_LOOKBACK - 1)); k < i; k += 1) {
      if (candles[k].high - candles[k].low <= candles[i].high - candles[i].low) {
        narrow = false;
        break;
      }
    }
    if (narrow) {
      hi = candles[i].high;
      lo = candles[i].low;
      expiresAt = i + ARM_BARS;
    }
  }
  return dirs;
}

// Opening-range breakout: the high/low of the first ORB_BARS bars of each UTC
// session; the first close beyond either level in the session fires (once each
// side per session).
function openingRangeDirs(candles, ctx) {
  const n = candles.length;
  const dirs = new Array(n).fill(0);
  let session = null;
  let barsIn = 0;
  let orHigh = -Infinity;
  let orLow = Infinity;
  let longDone = false;
  let shortDone = false;

  for (let i = 0; i < n; i += 1) {
    // Candle times from the engine are epoch MILLISECONDS.
    const day = Math.floor(candles[i].time / 86400000);
    if (day !== session) {
      session = day;
      barsIn = 0;
      orHigh = -Infinity;
      orLow = Infinity;
      longDone = false;
      shortDone = false;
    }

    if (barsIn < ORB_BARS) {
      if (candles[i].high > orHigh) orHigh = candles[i].high;
      if (candles[i].low < orLow) orLow = candles[i].low;
      barsIn += 1;
      continue;
    }

    if (!longDone && candles[i].close > orHigh && ctx.trendAllows(i, 1)) {
      dirs[i] = 1;
      longDone = true;
    } else if (!shortDone && candles[i].close < orLow && ctx.trendAllows(i, -1)) {
      dirs[i] = -1;
      shortDone = true;
    }
  }
  return dirs;
}

// ---------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------

class CandleBreakout15m {
  constructor() {
    this.name = 'CandleBreakout15m';
    this.description =
      'Candle-breakout entries on the last CLOSED 15m bar: Donchian range break (and an optional ' +
      'volume-confirmed break) in the direction of an EMA200 trend filter. Fixed bracket exit — ' +
      'stop at 2.5 x ATR(14), target at 2R — rested on Delta. Backtested positive on volatile ' +
      'small-cap alts (EVAAUSD/AINUSD/JCTUSD); roughly break-even on majors after fees.';
    // Left blank on purpose: the engine sets this from .env on start.
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
    this.leverage = 1;
    // Only used when LOTS is 0 (percent_of_equity fallback).
    this.notionalPercent = 0.1;

    this.reset();
  }

  getName() {
    return this.name;
  }

  newInstance() {
    return new CandleBreakout15m();
  }

  reset() {
    this.lastBarTime = 0; // last closed 15m bar already evaluated
    this.atrValue = null; // ATR(ATR_PERIOD) on the last closed bar, price units
    this.entrySentAt = 0; // settle guard after sending an entry
    this.signal = { dir: 0, family: null }; // cached breakout for the current bar
    this.entryDoneForBar = 0; // bar time already acted on (one entry per bar)
    this.lastReason = '';
    this.lastLogAt = 0;
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

  // Rounds a price to the product's tick size (Delta rejects anything else).
  snap(price) {
    const tick = Number(this.tickSize) || 0;
    if (!(tick > 0)) return Number(price);
    const decimals = (String(tick).split('.')[1] || '').length;
    return Number((Math.round(price / tick) * tick).toFixed(decimals));
  }

  fmt(price) {
    const tick = Number(this.tickSize) || 0;
    const decimals = tick > 0 ? (String(tick).split('.')[1] || '').length : 2;
    return Number(price).toFixed(decimals);
  }

  note(reason) {
    const now = Date.now();
    if (reason === this.lastReason && now - this.lastLogAt < LOG_THROTTLE_MS) return;
    this.lastReason = reason;
    this.lastLogAt = now;
    logger.info(`candle_breakout_15m (${this.symbol || '?'}): ${reason}`);
  }

  // Trend gate for the given bar. Only enabled setups run through this.
  buildContext(candles) {
    const closes = candles.map((c) => c.close);
    const ema = TREND_EMA > 0 ? emaSeries(closes, TREND_EMA) : null;
    const volSma = smaSeries(candles.map((c) => c.volume), VOL_LEN);

    return {
      volSma,
      trendAllows: (i, dir) => {
        if (!ema) return true;
        const e = ema[i];
        if (e == null) return false;
        return dir > 0 ? closes[i] > e : closes[i] < e;
      },
    };
  }

  // The direction for the LAST closed bar: the first enabled setup that fires.
  lastBarDirection(candles, ctx) {
    const i = candles.length - 1;
    for (const family of SETUP_PRIORITY) {
      if (!SETUPS[family]) continue;

      let dir = 0;
      if (family === 'range') dir = levelBreakDirs(candles, ctx, false)[i];
      else if (family === 'volume') dir = levelBreakDirs(candles, ctx, true)[i];
      else if (family === 'squeeze') dir = squeezeDirs(candles, ctx)[i];
      else if (family === 'orb') dir = openingRangeDirs(candles, ctx)[i];

      if (dir !== 0) return { dir, family };
    }
    return { dir: 0, family: null };
  }

  // One market entry with an attached stop + target bracket. Because the entry
  // carries both, orderManager sends them as ONE attached bracket on Delta (and
  // the position manager mirrors them locally in paper mode), so the exit needs
  // no further management from this strategy.
  buildEntry(dir, family, price) {
    const quantity = this.sizeContracts(price);
    if (!(quantity > 0)) return { action: 'HOLD', reason: 'size rounds to zero contracts' };

    const atrValue = Number(this.atrValue);
    if (!(atrValue > 0)) return { action: 'HOLD', reason: 'no ATR yet — cannot place a bracket' };

    const risk = STOP_ATR_MULT * atrValue;
    const stop = this.snap(dir > 0 ? price - risk : price + risk);
    const target = this.snap(dir > 0 ? price + TARGET_R * risk : price - TARGET_R * risk);

    // A bracket is only worth resting when both legs are on the losing / winning
    // side of the entry; a degenerate ATR would otherwise bracket at the entry.
    if (!(stop > 0) || !(target > 0) || stop === price || target === price) {
      return { action: 'HOLD', reason: 'degenerate ATR — bracket would sit at the entry' };
    }

    const side = dir > 0 ? 'long' : 'short';
    this.entrySentAt = Date.now();
    this.note(`breakout ${side} (${family}) at ${this.fmt(price)} — stop ${this.fmt(stop)}, target ${this.fmt(target)}`);

    return {
      action: dir > 0 ? 'BUY' : 'SELL',
      symbol: this.symbol,
      quantity,
      price: this.snap(price),
      orderType: 'market_order',
      stopLoss: stop,
      takeProfit: [{ price: target, quantity }],
      strategyName: this.name,
      reason:
        `candle breakout ${side} [${family}]: last 15m close broke the setup at ${this.fmt(price)} — ` +
        `bracket stop ${this.fmt(stop)} (${STOP_ATR_MULT}xATR), target ${this.fmt(target)} (${TARGET_R}R)`,
      meta: {
        exitMode: 'bracket',
        family: `candle-breakout-15m-${family}`,
        haltOnDailyLoss: HALT_ON_DAILY_LOSS,
      },
    };
  }

  evaluate(marketData = {}, state = {}) {
    if (TRADE_SYMBOLS.length && !TRADE_SYMBOLS.includes(normalizeSymbol(this.symbol))) {
      return { action: 'HOLD', reason: `candle_breakout_15m trades ${TRADE_SYMBOLS.join(', ')} only` };
    }

    const candles = Array.isArray(marketData.candles15m) ? marketData.candles15m : [];
    if (candles.length < MIN_BARS) {
      return { action: 'HOLD', reason: `warming up (${candles.length}/${MIN_BARS} 15m candles)` };
    }

    const last = candles[candles.length - 1];
    if (!last || !last.time) return { action: 'HOLD', reason: 'no closed 15m candle yet' };

    const price = Number(marketData.price) || Number(last.close) || 0;

    const positions = Array.isArray(state.positions) ? state.positions : [];
    const position = positions[0] || null;
    if (position) {
      // Clear the settle guard so the next flat cycle can arm a fresh entry.
      this.entrySentAt = 0;
      return { action: 'HOLD', reason: `holding ${position.side} — the bracket owns the exit` };
    }

    // One decision per closed 15m bar. Recompute the context (and the signal)
    // only when a new bar has closed; the ticker price can still move a live
    // entry, but the breakout itself is a closed-bar fact.
    const isNewBar = last.time !== this.lastBarTime;
    if (isNewBar) {
      this.lastBarTime = last.time;
      const ctx = this.buildContext(candles);
      const atrValue = Number(atr(candles, ATR_PERIOD).pop());
      this.atrValue = Number.isFinite(atrValue) && atrValue > 0 ? atrValue : null;
      this.signal = this.lastBarDirection(candles, ctx);
    }

    if (this.entrySentAt && Date.now() - this.entrySentAt < ENTRY_SETTLE_MS) {
      return { action: 'HOLD', reason: 'entry just sent — waiting for the position to open' };
    }
    if (!(price > 0)) {
      this.note('no live price yet');
      return { action: 'HOLD', reason: 'no live price' };
    }
    if (state.hasLiveOrder) {
      this.note('an entry is already working');
      return { action: 'HOLD', reason: 'an entry is already working' };
    }

    const signal = this.signal || { dir: 0, family: null };
    if (!signal.dir) {
      this.note(`no breakout on the last closed 15m bar (${SETUP_PRIORITY.filter((f) => SETUPS[f]).join(', ')})`);
      return { action: 'HOLD', reason: 'no breakout on the last closed 15m bar' };
    }

    // One entry per closed bar, even if evaluate() runs several times on it.
    if (this.entryDoneForBar === last.time) {
      return { action: 'HOLD', reason: 'the breakout on this bar has already been traded' };
    }

    const order = this.buildEntry(signal.dir, signal.family, price);
    if (order.action !== 'HOLD') this.entryDoneForBar = last.time;
    return order;
  }
}

module.exports = new CandleBreakout15m();
