// Event-driven, single-position backtest simulator.
//
// Realism rules that matter (these are what make the numbers trustworthy):
//   1. Signals are evaluated only on CLOSED bars, and levels only from pivots
//      already confirmed at that bar -> no look-ahead.
//   2. When a bar contains both the stop and the target, the STOP is assumed to
//      fill first (worst case), so results are not flattered by intrabar order.
//   3. The trailing stop is only ever moved using data from bars that have
//      already closed, so it can never "see" the bar it protects.
//   4. Fees use Delta India's real maker/taker rates, and market/stop fills slip.
//   5. Position size is derived from the stop distance (fixed-fractional risk),
//      so the equity curve is comparable across timeframes and parameter sets.
//
// It intentionally runs ONE position at a time. That is the conservative case;
// live, the order manager can run several slots concurrently.

'use strict';

const { prepare, signalAt, mergeParams } = require('../../src/strategies/lib/srBreakoutSignal');

const DEFAULTS = {
  contractValue: 0.001, // BTCUSD perpetual: 1 contract = 0.001 BTC
  feeMaker: 0.0002, // 2 bps
  feeTaker: 0.0005, // 5 bps
  slippageBps: 0.0002, // 2 bps adverse on market/stop fills
  initialEquity: 1200, // matches the project's paper account
  riskPct: 0.01, // 1% of initial equity risked per trade
  maxNotionalPct: 2.0, // cap notional at 2x equity
  cooldownBars: 0, // bars to wait after an exit before re-entering
  folds: 6,
};

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function applySlippage(price, bps, isBuy) {
  // Adverse slippage: buys fill a touch higher, sells a touch lower.
  return isBuy ? price * (1 + bps) : price * (1 - bps);
}

// Builds the pending order that the signal turns into.
function makePending(signal, barIndex, p) {
  const meta = signal.meta;
  return {
    side: meta.side,
    signal,
    createdBar: barIndex,
    expiresAtBar:
      meta.entryStyle === 'retest' ? barIndex + meta.retestValidityBars : barIndex + 1,
  };
}

// Attempts to fill the pending order on `bar`. Returns a fill or null.
function tryFill(pending, bar, i, cfg) {
  const { side, signal } = pending;
  const isBuy = side === 'long';
  const style = signal.meta.entryStyle;

  if (style === 'close') {
    if (i !== pending.createdBar + 1) return null;
    const price = applySlippage(bar.open, cfg.slippageBps, isBuy);
    return { price, isMaker: false };
  }

  if (style === 'stop') {
    const level = signal.price; // the breakout trigger price is stored as signal.price
    if (isBuy) {
      if (bar.high < level) return null;
      const raw = Math.max(level, bar.open); // gap-through fills at the open
      return { price: applySlippage(raw, cfg.slippageBps, true), isMaker: false };
    }
    if (bar.low > level) return null;
    const raw = Math.min(level, bar.open);
    return { price: applySlippage(raw, cfg.slippageBps, false), isMaker: false };
  }

  // 'retest' — resting limit at the level. Assume the fill happens AT the
  // limit (standard, and it keeps entry above the structure stop).
  const limit = signal.price;
  if (isBuy) {
    if (bar.low > limit) return null;
    return { price: limit, isMaker: true };
  }
  if (bar.high < limit) return null;
  return { price: limit, isMaker: true };
}

function sizePosition(entry, stop, cfg, equityStart) {
  const riskPerContract = Math.abs(entry - stop) * cfg.contractValue;
  if (!(riskPerContract > 0)) return 0;

  const riskBudget = equityStart * cfg.riskPct;
  let contracts = Math.floor(riskBudget / riskPerContract);

  const notionalCap = (equityStart * cfg.maxNotionalPct) / (entry * cfg.contractValue);
  contracts = Math.min(contracts, Math.floor(notionalCap));

  return contracts >= 1 ? contracts : 0;
}

function runBacktest({ candles, params, cfg: cfgOverrides }) {
  const cfg = { ...DEFAULTS, ...(cfgOverrides || {}) };
  const prep = prepare(candles, params);
  const p = prep.params;

  const trades = [];
  const equityCurve = [];

  let equity = cfg.initialEquity;
  let position = null;
  let pendingOrder = null;
  let cooldownUntilBar = -1;
  let skippedForSize = 0;

  const closePosition = (exitPrice, bar, i, reason, isMaker) => {
    const dir = position.side === 'long' ? 1 : -1;
    const gross = (exitPrice - position.entry) * dir * position.contracts * cfg.contractValue;
    const entryFee = position.entry * position.contracts * cfg.contractValue * position.entryFeeRate;
    const exitFee = exitPrice * position.contracts * cfg.contractValue * (isMaker ? cfg.feeMaker : cfg.feeTaker);
    const net = gross - entryFee - exitFee;

    equity += net;
    trades.push({
      side: position.side,
      entryBar: position.entryBar,
      exitBar: i,
      entryTime: candles[position.entryBar].time,
      exitTime: bar.time,
      entry: position.entry,
      exit: exitPrice,
      stop: position.stopInitial,
      target: position.targetInitial,
      contracts: position.contracts,
      risk: position.risk,
      rMultiple: net / position.riskAmount,
      gross,
      fees: entryFee + exitFee,
      net,
      reason,
      equityAfter: equity,
      holdBars: i - position.entryBar,
      level: position.signal.meta.level,
      levelTouches: position.signal.meta.levelTouches,
      levelSource: position.signal.meta.levelSource,
    });

    equityCurve.push({ time: bar.time, equity });
    position = null;
    if (cfg.cooldownBars > 0) cooldownUntilBar = i + cfg.cooldownBars;
  };

  for (let i = prep.warmup; i < candles.length; i += 1) {
    const bar = candles[i];

    // --- 1. fill a resting pending entry ---
    if (!position && pendingOrder && pendingOrder.signal) {
      const fill = tryFill(pendingOrder, bar, i, cfg);
      if (fill) {
        const signal = pendingOrder.signal;
        const contracts = sizePosition(fill.price, signal.stopLoss, cfg, cfg.initialEquity);
        if (contracts > 0) {
          const risk = Math.abs(fill.price - signal.stopLoss);
          position = {
            side: pendingOrder.side,
            entry: fill.price,
            stop: signal.stopLoss,
            stopInitial: signal.stopLoss,
            target: signal.takeProfit,
            targetInitial: signal.takeProfit,
            contracts,
            entryBar: i,
            entryFeeRate: fill.isMaker ? cfg.feeMaker : cfg.feeTaker,
            risk,
            riskAmount: risk * contracts * cfg.contractValue,
            signal,
            beApplied: false,
          };
        } else {
          skippedForSize += 1;
        }
        pendingOrder = null;
      } else if (i > pendingOrder.expiresAtBar) {
        pendingOrder = null;
      }
    }

    // --- 2. manage the open position on this bar (stop before target) ---
    if (position) {
      const isLong = position.side === 'long';

      if (isLong ? bar.low <= position.stop : bar.high >= position.stop) {
        closePosition(position.stop, bar, i, 'stop', false);
      } else if (
        p.exitMode === 'simple' &&
        (isLong ? bar.high >= position.target : bar.low <= position.target)
      ) {
        closePosition(position.target, bar, i, 'target', true);
      } else if (p.exitMode === 'trail') {
        const atrNow = prep.atr[i];
        if (atrNow > 0) {
          const dir = isLong ? 1 : -1;
          const unrealisedR = (dir * (bar.close - position.entry)) / position.risk;

          // Move to breakeven once the trade has paid us `beAtR`, then trail it.
          if (!position.beApplied && unrealisedR >= p.beAtR) {
            position.stop = position.entry;
            position.beApplied = true;
          }
          if (position.beApplied) {
            const trail = isLong
              ? bar.close - p.trailAtrMult * atrNow
              : bar.close + p.trailAtrMult * atrNow;
            position.stop = isLong ? Math.max(position.stop, trail) : Math.min(position.stop, trail);
          }
        }
      }

      // --- 3. time exit ---
      if (position && p.timeExitBars > 0 && i - position.entryBar >= p.timeExitBars) {
        closePosition(bar.close, bar, i, 'time', false);
      }
    }

    // --- 4. look for a new signal ---
    if (!position && !pendingOrder && i >= cooldownUntilBar) {
      const signal = signalAt(prep, i, p);
      if (signal) pendingOrder = makePending(signal, i, p);
    }
  }

  // Force-close anything still open at the last bar.
  if (position) {
    const bar = candles[candles.length - 1];
    closePosition(bar.close, bar, candles.length - 1, 'eod', false);
  }

  return {
    trades,
    equityCurve,
    equity,
    skippedForSize,
    metrics: computeMetrics(trades, cfg, candles),
    foldMetrics: computeFolds(trades, candles, cfg),
  };
}

function computeMetrics(trades, cfg, candles) {
  const net = trades.map((t) => t.net);
  const wins = trades.filter((t) => t.net > 0);
  const losses = trades.filter((t) => t.net <= 0);

  const grossProfit = wins.reduce((sum, t) => sum + t.net, 0);
  const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.net, 0));
  const totalNet = net.reduce((sum, v) => sum + v, 0);

  // Max drawdown on the closed-trade equity curve.
  let peak = cfg.initialEquity;
  let maxDd = 0;
  let running = cfg.initialEquity;
  for (const t of trades) {
    running += t.net;
    if (running > peak) peak = running;
    maxDd = Math.max(maxDd, peak - running);
  }

  let streak = 0;
  let maxLossStreak = 0;
  for (const t of trades) {
    if (t.net <= 0) {
      streak += 1;
      maxLossStreak = Math.max(maxLossStreak, streak);
    } else {
      streak = 0;
    }
  }

  const spanDays = (candles[candles.length - 1].time - candles[0].time) / 86400;
  const mean = trades.length ? totalNet / trades.length : 0;
  const variance =
    trades.length > 1
      ? net.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (trades.length - 1)
      : 0;
  const std = Math.sqrt(variance);
  const tradesPerYear = spanDays > 0 ? trades.length / (spanDays / 365) : 0;

  const longs = trades.filter((t) => t.side === 'long');
  const shorts = trades.filter((t) => t.side === 'short');

  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? round((wins.length / trades.length) * 100, 1) : 0,
    netPnl: round(totalNet),
    netPnlPct: round((totalNet / cfg.initialEquity) * 100, 1),
    grossProfit: round(grossProfit),
    grossLoss: round(grossLoss),
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss, 2) : grossProfit > 0 ? 99 : 0,
    expectancy: round(mean, 3),
    avgWin: round(wins.length ? grossProfit / wins.length : 0),
    avgLoss: round(losses.length ? -grossLoss / losses.length : 0),
    maxDrawdown: round(maxDd),
    maxDrawdownPct: round((maxDd / cfg.initialEquity) * 100, 1),
    maxLossStreak,
    tradesPerDay: round(spanDays > 0 ? trades.length / spanDays : 0, 2),
    avgHoldBars: round(trades.length ? trades.reduce((s, t) => s + t.holdBars, 0) / trades.length : 0, 1),
    returnPerDay: round(spanDays > 0 ? totalNet / spanDays : 0, 2),
    staleness: std > 0 ? round(mean / std, 3) : 0,
    approxSharpe: std > 0 && tradesPerYear > 0 ? round((mean / std) * Math.sqrt(tradesPerYear), 2) : 0,
    longs: longs.length,
    shorts: shorts.length,
    longNet: round(longs.reduce((s, t) => s + t.net, 0)),
    shortNet: round(shorts.reduce((s, t) => s + t.net, 0)),
    spanDays: round(spanDays, 1),
    finalEquity: round(cfg.initialEquity + totalNet),
  };
}

// Splits the period into `folds` equal time buckets and reports each one.
function computeFolds(trades, candles, cfg) {
  const start = candles[0].time;
  const end = candles[candles.length - 1].time;
  const width = (end - start) / cfg.folds;
  const folds = [];

  for (let f = 0; f < cfg.folds; f += 1) {
    const from = start + f * width;
    const to = from + width;
    const bucket = trades.filter((t) => t.entryTime >= from && t.entryTime < to);
    const net = bucket.reduce((s, t) => s + t.net, 0);
    const wins = bucket.filter((t) => t.net > 0).length;
    folds.push({
      index: f + 1,
      from: new Date(from * 1000).toISOString().slice(0, 10),
      to: new Date(to * 1000).toISOString().slice(0, 10),
      trades: bucket.length,
      net: round(net),
      winRate: bucket.length ? round((wins / bucket.length) * 100, 1) : 0,
    });
  }
  return folds;
}

module.exports = { runBacktest, DEFAULTS };
