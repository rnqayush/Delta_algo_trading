// S/R Breakout — BTC pivot-level breakout with retest limit entry.
//
// Runs natively on 5m or 15m, or on 30m bars resampled from the 15m feed; the
// active timeframe is `TUNED.baseMinutes` below.
//
// WHY THIS SHAPE: horizontal S/R is built from confirmed fractal swing pivots
// clustered by ATR; a setup is a bar that CLOSES decisively through a level
// with genuine price-action strength (body, close location, range expansion).
// Entry is a RESTING LIMIT at the broken level (the retest), which on Delta
// only fills when price trades back to the level — exactly the tested
// behaviour, and it pays the maker fee. Stop is N x ATR, target is R x risk.
//
// ---- ACTIVE CONFIG: 30m ----
// BACKTEST (BTCUSD 30m, real Delta data, 70/30 in/out-of-sample split,
// realistic fees + slippage, stop-before-target):
//   This is the ONLY timeframe with a durable edge. 5m loses outright and 15m
//   is ~breakeven (its in-sample PF 1.14 collapsed to 1.03 out-of-sample, with
//   only 1 of 12 top configs surviving). 30m gave an in-sample PF 1.10 and held
//   up out-of-sample, at roughly half the trade count.
//
// LIVE SETTINGS THAT MUST MATCH THE BACKTEST (env):
//     STRATEGY_ENTRY_VALIDITY_MINUTES=360  // retest validity = 12 x 30m
//     STRATEGY_MAX_CONCURRENT_POSITIONS=1  // the backtest runs one slot
//     STRATEGY_CANDLES_15M=2000            // 15m feed; 1000 30m bars, needed
//                                          // for the 200 EMA to converge
//     STRATEGY_CANDLES_5M=0                // the 30m config never reads 5m
//
// Signal shape:
//   { action: 'BUY' | 'SELL', symbol, quantity, orderType: 'limit_order',
//     price,                          // the broken level (the retest limit)
//     stopLoss, takeProfit: [{ price, percent: 100 }],
//     meta: { strategy, side, level, levelTouches, atr, risk, targetR,
//             exitMode: 'simple', timeExitBars, tickSize, barTime },
//     reason }
//
// Not investment advice. Paper-trade first.

'use strict';

const { DEFAULTS, mergeParams, prepare, signalAt } = require('../lib/srBreakoutSignal');

// Closed bars required before the indicators are trusted, as a multiple of the
// trend EMA period. Only matters when a trend EMA is used (the 15m config
// disables it); the 30m config's 200 EMA needs ~4x its period to converge.
const EMA_WARMUP_MULT = 4;

// ACTIVE config — the 30m winner (the only timeframe that held up out-of-sample).
// Kept explicit (not spread from DEFAULTS) so what was tested cannot silently
// drift when the engine's defaults change.
const TUNED_30M = {
  baseMinutes: 30,
  feedMinutes: 15, // 30m is aggregated from the 15m feed
  levelSource: 'pivots',
  entryStyle: 'retest',
  stopMode: 'atr',
  stopAtrMult: 1.5,
  levelLookbackBars: 100,
  minTouches: 2,
  clusterAtrMult: 0.4,
  trendEma: 200, // needs ~800 closed 30m bars (2000 15m candles) to converge
  retestValidityBars: 12,
  exitMode: 'simple',
  targetR: 2,
  timeExitBars: 32,
};

// The 15m config (~breakeven). Set baseMinutes/feedMinutes: 15 and
// STRATEGY_CANDLES_15M=500 to use it.
const TUNED_15M = {
  baseMinutes: 15, // use the 15m feed directly
  feedMinutes: 15,
  levelSource: 'pivots',
  entryStyle: 'retest',
  stopMode: 'atr',
  stopAtrMult: 2,
  levelLookbackBars: 200,
  minTouches: 3,
  clusterAtrMult: 0.4,
  trendEma: 0, // no trend filter: it did not survive on 15m
  retestValidityBars: 24, // 15m bars (= 6h on 15m)
  exitMode: 'simple',
  targetR: 2,
  timeExitBars: 64, // in base bars; already the manager's 15m unit at 15m
};

// The 5m config (loses money — see the header). Set baseMinutes/feedMinutes: 5,
// STRATEGY_CANDLES_5M=2000 and STRATEGY_CANDLES_15M=0 to use it.
const TUNED_5M = {
  baseMinutes: 5, // evaluate on 5m bars
  feedMinutes: 5, // ...taken directly from the 5m feed
  levelSource: 'pivots',
  entryStyle: 'retest',
  stopMode: 'atr',
  stopAtrMult: 3,
  levelLookbackBars: 100,
  minTouches: 3,
  clusterAtrMult: 0.4,
  trendEma: 400, // best of a bad bunch; 400 x 4 = 1600 5m bars of warm-up
  retestValidityBars: 24, // 5m bars (= 2h on 5m)
  exitMode: 'simple',
  targetR: 3,
  timeExitBars: 96, // in base bars; 96 x 5m = 8h
};

const TUNED = TUNED_30M;

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(num(value) * factor) / factor;
}

// Accepts Delta's raw candles (string prices / epoch seconds) as clean numbers.
function normalizeCandles(candles) {
  if (!Array.isArray(candles)) return [];
  return candles
    .map((candle) => {
      let time = num(candle.time ?? candle.start_time ?? candle.timestamp);
      if (time > 0 && time < 1e12) time *= 1000; // epoch seconds -> ms
      return {
        time,
        open: num(candle.open),
        high: num(candle.high),
        low: num(candle.low),
        close: num(candle.close),
        volume: num(candle.volume),
      };
    })
    .filter((candle) => candle.high > 0 && candle.low > 0 && candle.time > 0)
    .sort((a, b) => a.time - b.time);
}

// Aggregates a fine candle feed into `minutes` bars. A bucket is only returned
// once its window has fully elapsed, so the strategy never evaluates a bar that
// is still forming (no look-ahead). At feedMinutes === minutes this is the feed
// itself (one candle per bucket), which is why a 15m feed can serve a 15m or
// 30m config but a 5m feed is required for the 5m config.
function resampleBars(feedCandles, minutes, now = Date.now()) {
  const bucketMs = minutes * 60 * 1000;
  const buckets = new Map();

  for (const candle of feedCandles) {
    const start = Math.floor(candle.time / bucketMs) * bucketMs;
    const bucket = buckets.get(start);
    if (!bucket) {
      buckets.set(start, {
        time: start,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume || 0,
      });
    } else {
      bucket.high = Math.max(bucket.high, candle.high);
      bucket.low = Math.min(bucket.low, candle.low);
      bucket.close = candle.close;
      bucket.volume += candle.volume || 0;
    }
  }

  return [...buckets.values()]
    .filter((bucket) => bucket.time + bucketMs <= now)
    .sort((a, b) => a.time - b.time);
}

function resample30m(candles15m, now = Date.now()) {
  return resampleBars(candles15m, 30, now);
}

function hold(reason) {
  return { action: 'HOLD', reason };
}

// Closed base bars required before the indicators (the trend EMA in particular)
// are trusted. Exported so the verifier applies the identical gate.
function minWarmupBars(params) {
  const p = mergeParams(params);
  return Math.max(
    p.trendEma > 0 ? p.trendEma * EMA_WARMUP_MULT : 0,
    p.levelLookbackBars + 10,
    50
  );
}

// The candle resolution the engine must stream for this config: the base bars
// are built by aggregating up from it, so it can never be coarser than
// baseMinutes.
function feedResolution(params) {
  const p = mergeParams(params);
  return `${num(p.feedMinutes) || 15}m`;
}

// The engine's market context keys by resolution (`candles5m`, `candles15m`).
function feedKey(params) {
  const p = mergeParams(params);
  return `candles${num(p.feedMinutes) || 15}m`;
}

class SrBreakoutStrategy {
  constructor(options = {}) {
    this.params = mergeParams({ ...TUNED, ...(options.params || {}) });
    this.baseMinutes = num(this.params.baseMinutes) || 15;
    this.feedMinutes = num(this.params.feedMinutes) || 15;
    this.feedKey = feedKey(this.params);

    this.name = options.name || `SRB-${this.baseMinutes}`;
    this.description =
      `S/R Breakout (SRB-${this.baseMinutes}) — BTC ${this.baseMinutes}m pivot-level breakout, ` +
      `retest limit entry, ${this.params.stopAtrMult}x ATR stop, ${this.params.targetR}R target`;
    this.symbol = options.symbol || 'BTCUSD';

    // Exchange + account facts (filled by the engine from the product).
    this.tickSize = num(options.tickSize) || 0.5;
    this.contractValue = num(options.contractValue) || 0.001;
    this.equity = num(options.equity) || 1000;
    this.riskPercent = num(options.riskPercent) || 0.005;
    this.maxRiskPercent = num(options.maxRiskPercent) || 0.01;
    this.maxNotionalEquity = num(options.maxNotionalEquity) || 3;
    this.minContracts = Math.max(1, Math.floor(num(options.minContracts) || 1));
    this.fixedContracts = Math.max(0, Math.floor(num(options.fixedContracts) || 0));
    this.maxConcurrentPositions = num(options.maxConcurrentPositions) || 1;

    // At most one entry per closed base candle.
    this.lastBarTime = null;
  }

  getName() {
    return this.name;
  }

  reset() {
    this.lastBarTime = null;
  }

  // marketData: { price, candles15m, ... }
  // state:      { openPositions, liveOrders, ... }
  evaluate(marketData = {}, state = {}) {
    const daily = marketData.daily || {};
    if (daily.halted) return hold('Daily risk limit reached');

    const openPositions = num(state.openPositions);
    const liveOrders = num(state.liveOrders);
    if (openPositions + liveOrders >= this.maxConcurrentPositions) {
      return hold(`All ${this.maxConcurrentPositions} slots in use`);
    }
    if (state.openPositions === undefined && state.hasOpenPosition) return hold('A position is already open');
    if (state.liveOrders === undefined && state.hasLiveOrder) return hold('An entry order is already resting');

    // The engine streams CLOSED candles at the feed resolution, so the last
    // one's close time is "now". Deriving the cutoff from the data (not
    // Date.now()) is what makes the resample deterministic: a bucket counts
    // only once its last feed candle is present. Using the wall clock instead
    // would silently drop the just-completed bar for the first `feedMinutes` of
    // the next one.
    const feed = normalizeCandles(marketData[this.feedKey]);
    const lastTime = feed.length ? feed[feed.length - 1].time : 0;
    const candles = resampleBars(feed, this.baseMinutes, lastTime + this.feedMinutes * 60 * 1000);
    const minBars = minWarmupBars(this.params);
    if (candles.length < minBars) {
      return hold(`Not enough closed ${this.baseMinutes}m candles yet (${candles.length}/${minBars})`);
    }

    const i = candles.length - 1;
    const bar = candles[i];

    // One entry per candle — the backtest never opened twice on the same bar.
    if (this.lastBarTime !== null && bar.time <= this.lastBarTime) {
      return hold('Already evaluated this candle');
    }

    const prep = prepare(candles, this.params);
    const signal = signalAt(prep, i, this.params);
    if (!signal) return hold('No breakout setup on this candle');

    const entry = num(signal.price);
    const risk = Math.abs(entry - num(signal.stopLoss));
    if (!(entry > 0) || !(risk > 0)) return hold('Invalid level price or stop');

    const sizing = this.sizePosition({ entry, risk });
    if (!sizing) return hold('Position rounds to zero after the notional cap');

    this.lastBarTime = bar.time;

    const side = signal.meta.side;
    const targetPrice = num(signal.takeProfit);

    return {
      action: signal.action,
      symbol: this.symbol,
      quantity: sizing.quantity,
      orderType: 'limit_order',
      price: round(entry, 2), // resting limit at the broken level (the retest)
      stopLoss: round(signal.stopLoss, 2),
      takeProfit: [{ price: round(targetPrice, 2), percent: 100 }],
      meta: {
        strategy: this.name,
        side,
        entry: round(entry, 2),
        level: round(signal.meta.level, 2),
        levelTouches: signal.meta.levelTouches,
        levelSource: signal.meta.levelSource,
        atr: round(signal.meta.atr, 2),
        risk: round(risk, 2),
        targetR: this.params.targetR,
        // The position manager reads these to run the simple stop/target/time exit.
        exitMode: 'simple',
        // The position manager counts time in 15m bars; convert from base bars.
        timeExitBars: Math.round(this.params.timeExitBars * (this.baseMinutes / 15)),
        tickSize: this.tickSize,
        notional: round(sizing.notional, 2),
        riskAmount: round(sizing.riskAmount, 2),
        barTime: bar.time,
      },
      reason:
        `${this.name} ${side}: breakout of ${signal.meta.levelSource} level ` +
        `${round(signal.meta.level, 2)} (${signal.meta.levelTouches} touches), ` +
        `retest limit ${round(entry, 2)}, sl ${round(signal.stopLoss, 2)} ` +
        `tp ${round(targetPrice, 2)} (${this.params.stopAtrMult}x ATR / ${this.params.targetR}R)`,
    };
  }

  // Risk a fixed fraction of equity; the notional cap bounds total exposure.
  sizePosition({ entry, risk }) {
    if (this.fixedContracts > 0) {
      const quantity = this.fixedContracts;
      return {
        quantity,
        notional: quantity * this.contractValue * entry,
        riskAmount: quantity * this.contractValue * risk,
      };
    }

    const riskPercent = Math.min(this.riskPercent, this.maxRiskPercent);
    const riskAmount = this.equity * riskPercent;

    const baseBtc = riskAmount / risk;
    const maxNotional = (this.maxNotionalEquity * this.equity) / Math.max(1, this.maxConcurrentPositions);
    const maxContracts = Math.floor(maxNotional / (this.contractValue * entry));
    const wantedContracts = Math.max(this.minContracts, Math.floor(baseBtc / this.contractValue));
    const quantity = Math.min(wantedContracts, maxContracts);

    if (!Number.isFinite(quantity) || quantity < 1) return null;

    return {
      quantity,
      notional: quantity * this.contractValue * entry,
      riskAmount,
    };
  }
}

const srBreakoutStrategy = new SrBreakoutStrategy();

module.exports = srBreakoutStrategy;
module.exports.SrBreakoutStrategy = SrBreakoutStrategy;
// Pure helpers exported so they can be unit-tested on their own.
module.exports.helpers = {
  normalizeCandles,
  resampleBars,
  resample30m,
  minWarmupBars,
  feedResolution,
  feedKey,
  TUNED,
  TUNED_5M,
  TUNED_15M,
  TUNED_30M,
  DEFAULTS,
};
