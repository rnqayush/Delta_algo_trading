// Volatility Hedge Reversion (VHR-15) — BTC 15m mean-reversion, both sides.
//
// WHY THIS SHAPE (validated in backtest/run-reversion-freq-backtest.js --hedge,
// 200 days of BTCUSD 15m = six independent 30-day folds):
//   * Raw 15m momentum has ~zero edge; short conditions alone lose money
//     (crypto drifts up). Buying oversold dips is the only positive raw edge,
//     but a long-only book cannot survive a falling month.
//   * So: LONG oversold dips while price is ABOVE the 200 EMA, and SHORT
//     overbought pops while price is BELOW a FALLING 200 EMA. The short leg is
//     what keeps the equity curve green through a -19% month.
//   * Asymmetric bands: longs need only -1.25 sd, shorts need +1.75 sd (the
//     drift makes shorts the harder side, so they must be more stretched).
//   * Entries are resting LIMIT orders at the signal candle close (maker fee);
//     the target is also a limit (maker). Only the hard stop / time exit pays
//     the taker fee. At a pure-taker fee the edge is thin, so maker entries are
//     a real requirement, not a nicety.
//
// Tuned configuration (the "winner" from the hedge grid):
//   band 1.25/1.75, ATR stop 1.5x, ATR target 5x, 16h time exit, <= 4 slots.
//   -> 6/6 folds positive, +$528, 5.0 orders/day (min 4.4), PF 1.23.
//   -> strictly one entry per 15m candle (verified in the backtest), which is
//      why the live strategy de-duplicates by candle time.
//
// Frequency comes from CONCURRENT SLOTS, not from faster trading: a single
// position is limited to ~96 bars/day / hold-time (~1-2/day); four slots let
// the same edge print 4-5 independent entries per day.
//
// Signal shape returned on a setup:
//   {
//     action: 'BUY' | 'SELL',
//     symbol, quantity, orderType: 'limit_order', price,   // the close-price limit
//     stopLoss,                                           // entry -/+ 1.5*ATR
//     takeProfit: [{ price, percent: 100 }],              // full exit at 5*ATR
//     meta: { strategy, side, entry, sl, tp, atr, risk, exitMode: 'simple',
//             timeExitBars, bbMult, ema200, barTime },
//     reason,
//   }
//
// Not investment advice. Paper-trade first — see docs/vhr-15-report.md.

'use strict';

// --- design constants (must match the backtest harness) ---------------------
const EMA_TREND = 200; // regime line
const BB_PERIOD = 20; // mean / band period
const ATR_PERIOD = 14;
const LONG_BB_MULT = 1.25; // long when close <= mean - 1.25 * sd
const SHORT_BB_MULT = 1.75; // short when close >= mean + 1.75 * sd
const SLOPE_BARS = 8; // the 200 EMA must be falling over this many bars to short
const STOP_ATR = 1.5; // stop distance
const TARGET_ATR = 5.0; // target distance (3.3:1 reward:risk)
const TIME_EXIT_BARS = 64; // 64 x 15m = 16h hard time stop
const MAX_RISK_PERCENT_OF_PRICE = 0.05; // reject a stop wider than 5% of price
const MIN_BARS = EMA_TREND + SLOPE_BARS + 2;

// --------------------------------------------------------------------------
// Indicators (identical maths to the backtest, so live == tested)
// --------------------------------------------------------------------------

function emaSeries(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let v = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = v;
  for (let i = period; i < values.length; i += 1) {
    v = values[i] * k + v * (1 - k);
    out[i] = v;
  }
  return out;
}

function smaAt(values, endIndex, period) {
  if (endIndex - period + 1 < 0) return null;
  let sum = 0;
  for (let i = endIndex - period + 1; i <= endIndex; i += 1) sum += values[i];
  return sum / period;
}

function sdAt(values, endIndex, period) {
  const mean = smaAt(values, endIndex, period);
  if (mean === null) return null;
  let sumSq = 0;
  for (let i = endIndex - period + 1; i <= endIndex; i += 1) {
    const d = values[i] - mean;
    sumSq += d * d;
  }
  return Math.sqrt(Math.max(0, sumSq / period));
}

function atrSeries(candles, period) {
  const out = new Array(candles.length).fill(null);
  if (candles.length < period) return out;
  const tr = new Array(candles.length).fill(0);
  for (let i = 0; i < candles.length; i += 1) {
    if (i === 0) tr[i] = candles[0].high - candles[0].low;
    else {
      const prevClose = candles[i - 1].close;
      tr[i] = Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - prevClose),
        Math.abs(candles[i].low - prevClose)
      );
    }
  }
  let sum = 0;
  for (let i = 0; i < period; i += 1) sum += tr[i];
  let value = sum / period;
  out[period - 1] = value;
  for (let i = period; i < candles.length; i += 1) {
    value = (value * (period - 1) + tr[i]) / period;
    out[i] = value;
  }
  return out;
}

// --------------------------------------------------------------------------
// Small helpers
// --------------------------------------------------------------------------

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(num(value) * factor) / factor;
}

// Accepts Delta's raw candles (string prices) and returns clean numbers.
function normalizeCandles(candles) {
  if (!Array.isArray(candles)) return [];
  return candles
    .map((candle) => ({
      time: num(candle.time ?? candle.start_time ?? candle.timestamp),
      open: num(candle.open),
      high: num(candle.high),
      low: num(candle.low),
      close: num(candle.close),
      volume: num(candle.volume),
    }))
    .filter((candle) => candle.high > 0 && candle.low > 0)
    .sort((a, b) => a.time - b.time);
}

// --------------------------------------------------------------------------
// Strategy
// --------------------------------------------------------------------------

class VolatilityHedgeReversionStrategy {
  constructor(options = {}) {
    this.name = options.name || 'VHR-15';
    this.description =
      'Volatility Hedge Reversion (VHR-15) — BTC 15m band reversion, long above / short below a falling 200 EMA';
    this.symbol = options.symbol || 'BTCUSD';

    // Exchange + account facts (supplied by the engine / config). The BTCUSD
    // fallbacks matter: if the product lookup ever fails the engine keeps them,
    // and a wrong contract value would silently size every order to zero.
    this.tickSize = num(options.tickSize) || 0.5;
    this.contractValue = num(options.contractValue) || 0.001; // BTC per contract
    this.equity = num(options.equity) || 1000;
    this.riskPercent = num(options.riskPercent) || 0.005;
    this.maxRiskPercent = num(options.maxRiskPercent) || 0.01;
    this.maxNotionalEquity = num(options.maxNotionalEquity) || 3;
    // Floor on the order size: on a small account the risk-based size rounds to
    // zero contracts, which would block every trade. Default to the exchange
    // minimum of one contract so the bot can still run.
    this.minContracts = Math.max(1, Math.floor(num(options.minContracts) || 1));
    // When > 0 the order size is fixed to exactly this many contracts and the
    // risk/notional model is bypassed ("always place 1 lot").
    this.fixedContracts = Math.max(0, Math.floor(num(options.fixedContracts) || 0));
    // How many positions this strategy may hold at once (the frequency lever).
    this.maxConcurrentPositions = num(options.maxConcurrentPositions) || 4;

    // Tuned parameters.
    this.longBbMult = num(options.longBbMult) || LONG_BB_MULT;
    this.shortBbMult = num(options.shortBbMult) || SHORT_BB_MULT;
    this.stopAtr = num(options.stopAtr) || STOP_ATR;
    this.targetAtr = num(options.targetAtr) || TARGET_ATR;
    this.timeExitBars = num(options.timeExitBars) || TIME_EXIT_BARS;

    // Candle de-duplication: at most ONE entry per closed 15m candle.
    this.lastBarTime = null;
  }

  getName() {
    return this.name;
  }

  reset() {
    this.lastBarTime = null;
  }

  // marketData: { price/bestBid/bestAsk (or a nested `ticker`), candles15m, daily }
  // state:      { hasOpenPosition, hasLiveOrder, openPositions, liveOrders }
  evaluate(marketData = {}, state = {}) {
    const ticker = marketData.ticker || marketData;
    const price = num(ticker.price ?? ticker.markPrice ?? ticker.mark_price);

    const daily = marketData.daily || {};
    if (daily.halted) return hold('Daily risk limit reached');
    // Session guards mirroring the backtest (max 20 entries/day, 8-loss streak).
    if (num(daily.tradesToday) >= 20) return hold('Max trades for today');
    if (num(daily.consecutiveLosses) >= 8) return hold('Eight consecutive losses — paused for the day');

    const openPositions = num(state.openPositions);
    const liveOrders = num(state.liveOrders);
    const slotsInUse = openPositions + liveOrders;
    if (slotsInUse >= this.maxConcurrentPositions) {
      return hold(`All ${this.maxConcurrentPositions} slots in use`);
    }
    // Back-compat with an engine that only reports booleans.
    if (state.openPositions === undefined && state.hasOpenPosition) return hold('A position is already open');
    if (state.liveOrders === undefined && state.hasLiveOrder) return hold('An entry order is already resting');

    if (!price) return hold('No price available');

    const candles = normalizeCandles(marketData.candles15m);
    if (candles.length < MIN_BARS) {
      return hold(`Not enough closed candles yet (${candles.length}/${MIN_BARS})`);
    }

    const closes = candles.map((c) => c.close);
    const i = candles.length - 1; // the most recent CLOSED candle
    const bar = candles[i];

    // One entry per candle — the backtest never opened twice on the same bar.
    if (this.lastBarTime !== null && bar.time <= this.lastBarTime) {
      return hold('Already evaluated this candle');
    }

    const ema200 = emaSeries(closes, EMA_TREND);
    const atr = atrSeries(candles, ATR_PERIOD);
    const mean = smaAt(closes, i, BB_PERIOD);
    const sd = sdAt(closes, i, BB_PERIOD);
    const e200 = ema200[i];
    const atrNow = atr[i];

    if (mean === null || sd === null || e200 === null || !atrNow || atrNow <= 0) {
      return hold('Indicators not ready');
    }

    const closing = bar.close;
    const above = closing >= e200;

    let side = null;
    let bbMult = null;
    if (above && closing <= mean - this.longBbMult * sd) {
      side = 'LONG';
      bbMult = this.longBbMult;
    } else if (!above && closing >= mean + this.shortBbMult * sd) {
      // Shorts only when the regime is actually falling.
      const prevE200 = i - SLOPE_BARS >= 0 ? ema200[i - SLOPE_BARS] : null;
      if (prevE200 !== null && e200 < prevE200) {
        side = 'SHORT';
        bbMult = this.shortBbMult;
      }
    }

    if (!side) return hold('No stretched band close in this regime');

    const risk = this.stopAtr * atrNow;
    if (risk <= 0 || risk / closing > MAX_RISK_PERCENT_OF_PRICE) return hold('Stop too wide for price');

    const direction = side === 'LONG' ? 1 : -1;
    const entry = closing;
    const sl = entry - direction * risk;
    const tp = entry + direction * this.targetAtr * atrNow;

    const sizing = this.sizePosition({ entry, risk });
    if (!sizing) return hold('Position rounds to zero after the notional cap');

    // Remember the candle so the same setup is not re-issued on later ticks.
    this.lastBarTime = bar.time;

    return {
      action: side === 'LONG' ? 'BUY' : 'SELL',
      symbol: this.symbol,
      quantity: sizing.quantity,
      orderType: 'limit_order',
      price: round(entry, 2),
      stopLoss: round(sl, 2),
      takeProfit: [{ price: round(tp, 2), percent: 100 }],
      meta: {
        strategy: this.name,
        side,
        entry: round(entry, 2),
        sl: round(sl, 2),
        tp: round(tp, 2),
        atr: round(atrNow, 2),
        risk: round(risk, 2),
        bbMult,
        ema200: round(e200, 2),
        regime: above ? 'above200' : 'below200-falling',
        // The trade manager reads these to run the simple stop/target/time exit.
        exitMode: 'simple',
        timeExitBars: this.timeExitBars,
        tickSize: this.tickSize,
        notional: round(sizing.notional, 2),
        riskAmount: round(sizing.riskAmount, 2),
        barTime: bar.time,
      },
      reason:
        `VHR-15 ${side}: close ${round(closing, 2)} vs mean ${round(mean, 2)} ` +
        `${side === 'LONG' ? '-' : '+'} ${bbMult}sd, ` +
        `ema200 ${round(e200, 2)} (${above ? 'above' : 'below, falling'}), ` +
        `sl ${round(sl, 2)} tp ${round(tp, 2)} (${this.stopAtr}x / ${this.targetAtr}x ATR)`,
    };
  }

  // Risk a fixed fraction of equity per slot; the notional cap is shared across
  // the concurrent slots so total exposure stays bounded.
  sizePosition({ entry, risk }) {
    const equity = this.equity;

    // Fixed size ("always 1 lot"): ignore the risk/notional model entirely.
    if (this.fixedContracts > 0) {
      const quantity = this.fixedContracts;
      return {
        quantity,
        notional: quantity * this.contractValue * entry,
        riskAmount: quantity * this.contractValue * risk,
        sizeInBase: quantity * this.contractValue,
      };
    }

    const riskPercent = Math.min(this.riskPercent, this.maxRiskPercent);
    const riskAmount = equity * riskPercent;

    const baseBtc = riskAmount / risk; // BTC amount that risks exactly riskAmount
    const maxNotional = (this.maxNotionalEquity * equity) / Math.max(1, this.maxConcurrentPositions);
    const maxContracts = Math.floor(maxNotional / (this.contractValue * entry));
    // Never size below the tradable floor; the exposure cap (maxContracts) still
    // wins, so a slot that cannot afford even one contract correctly stays out.
    const wantedContracts = Math.max(this.minContracts, Math.floor(baseBtc / this.contractValue));
    const quantity = Math.min(wantedContracts, maxContracts);

    if (!Number.isFinite(quantity) || quantity < 1) return null;

    return {
      quantity,
      notional: quantity * this.contractValue * entry,
      riskAmount,
      sizeInBase: quantity * this.contractValue,
    };
  }
}

function hold(reason) {
  return { action: 'HOLD', reason };
}

const volatilityHedgeReversionStrategy = new VolatilityHedgeReversionStrategy();

module.exports = volatilityHedgeReversionStrategy;
module.exports.VolatilityHedgeReversionStrategy = VolatilityHedgeReversionStrategy;
// Pure helpers exported so they can be unit-tested on their own.
module.exports.helpers = {
  emaSeries,
  smaAt,
  sdAt,
  atrSeries,
  normalizeCandles,
};
