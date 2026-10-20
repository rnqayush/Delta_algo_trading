// Support/Resistance breakout + price-action signal engine.
//
// This is a PURE module: given candles and a parameter set it returns the signal
// that the last CLOSED bar produces. The backtest harness and the live strategy
// both call these exact functions, so what is tested is what runs.
//
// The idea, in one paragraph:
//   Horizontal support/resistance levels are built from confirmed swing pivots
//   (and optionally the Donchian channel). A trade is taken when a bar CLOSES
//   decisively through a level (by an ATR-scaled buffer) AND that bar shows
//   genuine price-action strength (large body, close near the extreme, range
//   expansion). Entries beyond the level are then risk-defined by the level
//   itself, and the move is captured with an R-multiple target or a trail.
//
// Every pivot carries a `confirmedAt` index (pivot + lookback). Levels are only
// ever read from pivots already confirmed at the current bar, which is what
// keeps the whole thing free of look-ahead bias.

'use strict';

const ind = require('./indicators');

const DEFAULTS = {
  // --- indicator windows ---
  atrPeriod: 14,
  trendEma: 0, // 0 disables the trend filter
  trendSlopeBars: 0, // 0 disables the "trend must be sloping" requirement
  volLookback: 20, // window for the average-volume baseline
  minVolMult: 0, // breakout bar volume must be >= X * average (0 disables)
  // Volatility-compression filter: only take breakouts out of a tight range
  // (the classic "coil then expand" setup). 0 disables.
  squeezeLookback: 0,
  maxSqueezeAtr: 0,

  // --- how support/resistance is built ---
  swingLookback: 3, // bars either side of a fractal pivot
  levelLookbackBars: 120, // how far back a level stays "live"
  clusterAtrMult: 0.5, // pivot merge width, in ATRs
  minTouches: 2, // pivots required to call something a level
  levelSource: 'pivots', // 'pivots' | 'donchian' | 'both'

  // --- breakout + price-action confirmation ---
  breakBufferAtr: 0.05, // close must clear the level by this many ATRs
  minBodyRatio: 0.45, // body / range of the breakout bar
  minCloseLocation: 0.6, // long: close in top X of range (short: mirrored)
  minRangeAtr: 0.8, // breakout bar range >= X ATRs (expansion)
  maxRiskPct: 0.05, // reject if stop is further than this % from entry
  minRiskAtr: 0.25,
  maxRiskAtr: 3.0,

  // --- direction ---
  allowLong: true,
  allowShort: true,

  // --- entry ---
  entryStyle: 'close', // 'close' | 'stop' | 'retest'
  retestValidityBars: 8,

  // --- exit ---
  stopMode: 'level', // 'level' | 'atr' | 'tightest'
  stopAtrMult: 1.0,
  stopLevelBufferAtr: 0.25,
  exitMode: 'simple', // 'simple' | 'trail'
  targetR: 2.0, // used by 'simple'
  beAtR: 1.0, // used by 'trail': move stop to breakeven at +X R
  trailAtrMult: 1.5, // used by 'trail': trail distance in ATRs
  timeExitBars: 32, // 0 disables
};

function mergeParams(params) {
  return { ...DEFAULTS, ...(params || {}) };
}

function lowerBoundByAt(arr, targetAt) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].at >= targetAt) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function upperBoundByAt(arr, maxAt) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].at > maxAt) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

// Rolling simple average of volume, aligned with `candles`.
function rollingAverageVolume(candles, period) {
  const out = new Array(candles.length).fill(null);
  if (period <= 0) return out;
  let sum = 0;
  for (let i = 0; i < candles.length; i += 1) {
    sum += candles[i].volume || 0;
    if (i >= period) sum -= candles[i - period].volume || 0;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

// Pre-computes everything that does not depend on the bar index.
function prepare(candles, params) {
  const p = mergeParams(params);
  const closes = candles.map((c) => c.close);

  const warmup = Math.max(
    p.atrPeriod + 1,
    p.swingLookback * 2 + 2,
    p.trendEma > 0 ? p.trendEma : 0,
    p.minVolMult > 0 ? p.volLookback : 0,
    20
  );

  return {
    candles,
    params: p,
    atr: ind.atr(candles, p.atrPeriod),
    trend: p.trendEma > 0 ? ind.ema(closes, p.trendEma) : null,
    volAvg: p.minVolMult > 0 ? rollingAverageVolume(candles, p.volLookback) : null,
    pivots: ind.findPivots(candles, p.swingLookback),
    warmup,
  };
}

// The pivots that are both confirmed and still recent at bar `i`.
function windowPivots(pivotList, i, p) {
  const from = lowerBoundByAt(pivotList, i - p.levelLookbackBars);
  const to = upperBoundByAt(pivotList, i - p.swingLookback);
  return pivotList.slice(from, to);
}

function byPrice(a, b) {
  return a.price - b.price;
}

// Resistance (above) and support (below) levels visible at bar `i`.
function buildLevels(prep, i, p) {
  const atrNow = prep.atr[i];
  const tolerance = p.clusterAtrMult * atrNow;

  const resistance = [];
  const support = [];

  if (p.levelSource !== 'donchian') {
    const highs = windowPivots(prep.pivots.highs, i, p).slice().sort(byPrice);
    const lows = windowPivots(prep.pivots.lows, i, p).slice().sort(byPrice);
    for (const level of ind.clusterPrices(highs, tolerance)) {
      if (level.touches >= p.minTouches) resistance.push({ ...level, source: 'pivot' });
    }
    for (const level of ind.clusterPrices(lows, tolerance)) {
      if (level.touches >= p.minTouches) support.push({ ...level, source: 'pivot' });
    }
  }

  if (p.levelSource !== 'pivots') {
    // Donchian of the bars BEFORE the current one, so the current bar can break it.
    const channel = ind.donchian(prep.candles, i - 1, p.levelLookbackBars);
    if (channel) {
      resistance.push({
        price: channel.high,
        touches: Math.max(p.minTouches, 1),
        lastAt: i - 1,
        source: 'donchian',
      });
      support.push({
        price: channel.low,
        touches: Math.max(p.minTouches, 1),
        lastAt: i - 1,
        source: 'donchian',
      });
    }
  }

  resistance.sort(byPrice);
  support.sort(byPrice);
  return { resistance, support };
}

// Returns null when the breakout bar passes every confirmation, otherwise the
// name of the first rule it failed (used for diagnostics in the backtest).
function confirmBar(prep, i, p, side) {
  const bar = prep.candles[i];
  const atrNow = prep.atr[i];

  const range = bar.high - bar.low;
  if (range <= 0) return 'zero-range';
  if (range < p.minRangeAtr * atrNow) return 'range-too-small';
  if (ind.bodyRatio(bar) < p.minBodyRatio) return 'weak-body';

  if (p.minVolMult > 0) {
    const volAvg = prep.volAvg ? prep.volAvg[i] : null;
    if (!volAvg || volAvg <= 0) return 'no-volume-baseline';
    if ((bar.volume || 0) < p.minVolMult * volAvg) return 'low-volume';
  }

  if (p.squeezeLookback > 0 && p.maxSqueezeAtr > 0) {
    const channel = ind.donchian(prep.candles, i, p.squeezeLookback);
    if (!channel || channel.high - channel.low > p.maxSqueezeAtr * atrNow) return 'not-compressed';
  }

  if (side === 'long') {
    if (ind.closeLocation(bar) < p.minCloseLocation) return 'close-not-high';
    if (p.trendEma > 0) {
      const trendValue = prep.trend ? prep.trend[i] : null;
      if (!trendValue || bar.close < trendValue) return 'against-trend';
    }
  } else {
    if (ind.closeLocation(bar) > 1 - p.minCloseLocation) return 'close-not-low';
    if (p.trendEma > 0) {
      const trendValue = prep.trend ? prep.trend[i] : null;
      if (!trendValue || bar.close > trendValue) return 'against-trend';
    }
  }

  if (p.trendEma > 0 && p.trendSlopeBars > 0 && prep.trend) {
    const now = prep.trend[i];
    const before = prep.trend[i - p.trendSlopeBars];
    if (now == null || before == null) return 'no-slope';
    if (side === 'long' && now <= before) return 'flat-trend';
    if (side === 'short' && now >= before) return 'flat-trend';
  }

  return null;
}

function resolveStop(entryRef, levelPrice, atrNow, p, side) {
  const byAtr = side === 'long' ? entryRef - p.stopAtrMult * atrNow : entryRef + p.stopAtrMult * atrNow;
  const byLevel =
    side === 'long'
      ? levelPrice - p.stopLevelBufferAtr * atrNow
      : levelPrice + p.stopLevelBufferAtr * atrNow;

  if (p.stopMode === 'atr') return byAtr;
  if (p.stopMode === 'level') return byLevel;
  // 'tightest' — the stop closest to entry, i.e. the smallest risk.
  return side === 'long' ? Math.max(byAtr, byLevel) : Math.min(byAtr, byLevel);
}

// The signal produced by the closed bar at index `i` (or null).
function signalAt(prep, i, params) {
  const p = mergeParams(params || prep.params);
  const { candles } = prep;

  if (i < prep.warmup || i < 1 || i >= candles.length) return null;

  const bar = candles[i];
  const prev = candles[i - 1];
  const atrNow = prep.atr[i];
  const atrPrev = prep.atr[i - 1];
  if (!atrNow || atrNow <= 0 || !atrPrev || atrPrev <= 0) return null;

  const levels = buildLevels(prep, i, p);
  const buffer = p.breakBufferAtr * atrNow;
  const bufferPrev = p.breakBufferAtr * atrPrev;

  const attempt = (side, level) => {
    const entryRef =
      p.entryStyle === 'stop'
        ? side === 'long'
          ? level.price + buffer
          : level.price - buffer
        : p.entryStyle === 'retest'
          ? level.price
          : bar.close;

    const stop = resolveStop(entryRef, level.price, atrNow, p, side);
    const risk = side === 'long' ? entryRef - stop : stop - entryRef;
    if (!(risk > 0)) return null;

    const riskAtr = risk / atrNow;
    if (riskAtr < p.minRiskAtr || riskAtr > p.maxRiskAtr) return null;
    if (risk / entryRef > p.maxRiskPct) return null;

    const target = side === 'long' ? entryRef + p.targetR * risk : entryRef - p.targetR * risk;

    return {
      action: side === 'long' ? 'BUY' : 'SELL',
      orderType: p.entryStyle === 'close' ? 'market' : 'limit',
      price: entryRef,
      stopLoss: stop,
      takeProfit: target,
      meta: {
        side,
        level: level.price,
        levelTouches: level.touches,
        levelSource: level.source,
        atr: atrNow,
        risk,
        riskAtr,
        entryStyle: p.entryStyle,
        stopMode: p.stopMode,
        exitMode: p.exitMode,
        targetR: p.targetR,
        beAtR: p.beAtR,
        trailAtrMult: p.trailAtrMult,
        timeExitBars: p.timeExitBars,
        retestValidityBars: p.retestValidityBars,
        barTime: bar.time,
      },
      reason:
        `${side === 'long' ? 'Breakout above' : 'Breakdown below'} ` +
        `${level.source} level ${level.price.toFixed(2)} (${level.touches} touches) ` +
        `with ${(ind.bodyRatio(bar) * 100).toFixed(0)}% body`,
    };
  };

  // ---- LONG: close crossed from at/below a resistance to decisively above ----
  if (p.allowLong) {
    const broken = levels.resistance.filter(
      (level) => level.price <= bar.close - buffer && prev.close <= level.price + bufferPrev
    );
    if (broken.length) {
      const level = broken[broken.length - 1]; // highest broken level = nearest below price
      if (!confirmBar(prep, i, p, 'long')) {
        const signal = attempt('long', level);
        if (signal) return signal;
      }
    }
  }

  // ---- SHORT: close crossed from at/above a support to decisively below ----
  if (p.allowShort) {
    const broken = levels.support.filter(
      (level) => level.price >= bar.close + buffer && prev.close >= level.price - bufferPrev
    );
    if (broken.length) {
      const level = broken[0]; // lowest broken level = nearest above price
      if (!confirmBar(prep, i, p, 'short')) {
        const signal = attempt('short', level);
        if (signal) return signal;
      }
    }
  }

  return null;
}

module.exports = {
  DEFAULTS,
  mergeParams,
  prepare,
  signalAt,
  buildLevels,
};
