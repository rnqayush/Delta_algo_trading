// Pure indicator / price-action maths shared by the backtest harness and the
// live strategy. No side effects, no config lookups — everything is passed in,
// so the exact same functions run in the backtest and in production
// (the project rule: live == tested).

'use strict';

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

// Exponential moving average. Aligned with `values` (null until available).
function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (!values.length || period <= 0 || values.length < period) return out;

  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i += 1) seed += values[i];
  let value = seed / period;
  out[period - 1] = value;
  for (let i = period; i < values.length; i += 1) {
    value = values[i] * k + value * (1 - k);
    out[i] = value;
  }
  return out;
}

// Simple moving average ending at index `i`.
function smaAt(values, i, period) {
  if (period <= 0 || i - period + 1 < 0) return null;
  let sum = 0;
  for (let j = i - period + 1; j <= i; j += 1) sum += values[j];
  return sum / period;
}

// Average true range (Wilder smoothing), aligned with `candles`.
function atr(candles, period) {
  const out = new Array(candles.length).fill(null);
  if (!candles.length || candles.length < period || period <= 0) return out;

  const tr = new Array(candles.length).fill(0);
  for (let i = 0; i < candles.length; i += 1) {
    if (i === 0) {
      tr[i] = candles[0].high - candles[0].low;
    } else {
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

// Wilder RSI, aligned with `candles`.
function rsi(candles, period) {
  const out = new Array(candles.length).fill(null);
  if (candles.length <= period || period <= 0) return out;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const change = candles[i].close - candles[i - 1].close;
    if (change >= 0) gain += change;
    else loss -= change;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < candles.length; i += 1) {
    const change = candles[i].close - candles[i - 1].close;
    const up = change > 0 ? change : 0;
    const down = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + up) / period;
    avgLoss = (avgLoss * (period - 1) + down) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

// Fractal swing pivots.
//
// A swing high at `at` means candles[at].high is strictly higher than the
// `lookback` bars either side. It needs `lookback` bars to the RIGHT to be
// confirmed, so it only becomes usable at `confirmedAt = at + lookback`.
// Respecting `confirmedAt` is what keeps the backtest free of look-ahead bias.
function findPivots(candles, lookback) {
  const highs = [];
  const lows = [];
  const lb = Math.max(1, Math.floor(Number(lookback) || 1));

  for (let i = lb; i < candles.length - lb; i += 1) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - lb; j <= i + lb; j += 1) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low <= candles[i].low) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) highs.push({ at: i, confirmedAt: i + lb, price: candles[i].high, type: 'HIGH' });
    if (isLow) lows.push({ at: i, confirmedAt: i + lb, price: candles[i].low, type: 'LOW' });
  }
  return { highs, lows };
}

// Merges pivots that sit within `tolerance` of each other into one horizontal
// level. `touches` counts how many pivots formed it (more = stronger), and
// `lastAt` is the most recent pivot index (used to drop stale levels).
function clusterPrices(sortedPivots, tolerance) {
  const clusters = [];
  for (const pivot of sortedPivots) {
    const last = clusters[clusters.length - 1];
    if (last && Math.abs(pivot.price - last.price) <= tolerance) {
      last.members.push(pivot);
      last.price = last.members.reduce((sum, m) => sum + m.price, 0) / last.members.length;
      last.touches += 1;
      last.lastAt = Math.max(last.lastAt, pivot.at);
    } else {
      clusters.push({
        price: pivot.price,
        touches: 1,
        lastAt: pivot.at,
        lastConfirmedAt: pivot.confirmedAt,
        members: [pivot],
      });
    }
  }
  return clusters;
}

// Candle body as a fraction of its range — the "price action strength" gauge.
// An impulsive bar closes near an extreme with small wicks; a choppy bar does not.
function bodyRatio(candle) {
  const range = candle.high - candle.low;
  if (range <= 0) return 0;
  return Math.abs(candle.close - candle.open) / range;
}

// Where in its range the candle closed: 1 = on the high, 0 = on the low.
function closeLocation(candle) {
  const range = candle.high - candle.low;
  if (range <= 0) return 0.5;
  return (candle.close - candle.low) / range;
}

// Highest high / lowest low over the `period` bars ending at `endIndex`
// (Donchian channel) — the classic breakout reference level.
function donchian(candles, endIndex, period) {
  if (endIndex - period + 1 < 0 || period <= 0) return null;
  let high = -Infinity;
  let low = Infinity;
  for (let i = endIndex - period + 1; i <= endIndex; i += 1) {
    if (candles[i].high > high) high = candles[i].high;
    if (candles[i].low < low) low = candles[i].low;
  }
  return { high, low };
}

module.exports = {
  num,
  ema,
  smaAt,
  atr,
  rsi,
  findPivots,
  clusterPrices,
  bodyRatio,
  closeLocation,
  donchian,
};
