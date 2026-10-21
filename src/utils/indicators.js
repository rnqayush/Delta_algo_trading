// Indicator maths shared by the strategies and the trade manager.
//
// These are the SAME functions the backtests in backtest/ use, copied verbatim,
// so a live signal and a backtested signal are computed identically. Each
// function returns one value per candle (a "series"); callers index the last
// (closed) candle.

// Average True Range (Wilder smoothing). Returns null until it is warmed up.
function atr(candles, period = 14) {
  const n = candles.length;
  const out = new Array(n).fill(null);
  if (n <= period) return out;

  const tr = new Array(n).fill(0);
  for (let i = 1; i < n; i += 1) {
    const c = candles[i];
    const prev = candles[i - 1].close;
    tr[i] = Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev));
  }

  let sum = 0;
  for (let i = 1; i <= period; i += 1) sum += tr[i];
  out[period] = sum / period;
  for (let i = period + 1; i < n; i += 1) out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
  return out;
}

// Session VWAP: the volume-weighted typical price accumulated from the start of
// each UTC day. Restarts whenever the UTC calendar day changes.
function dailyVwap(candles) {
  const n = candles.length;
  const out = new Array(n).fill(null);
  let pv = 0;
  let vv = 0;
  let currentDay = null;

  for (let i = 0; i < n; i += 1) {
    const candle = candles[i];
    const day = new Date(candle.time).toISOString().slice(0, 10);
    if (day !== currentDay) {
      currentDay = day;
      pv = 0;
      vv = 0;
    }
    pv += ((candle.high + candle.low + candle.close) / 3) * candle.volume;
    vv += candle.volume;
    out[i] = vv > 0 ? pv / vv : candle.close;
  }
  return out;
}

// ADX (Wilder). Returns null until it is warmed up (needs ~2 x period bars).
function adx(candles, period = 14) {
  const n = candles.length;
  const out = new Array(n).fill(null);
  let trS = 0;
  let pdmS = 0;
  let ndmS = 0;
  let adxValue = null;
  const dx = [];

  for (let i = 0; i < n; i += 1) {
    const candle = candles[i];
    let tr;
    let pdm = 0;
    let ndm = 0;

    if (i === 0) {
      tr = candle.high - candle.low;
    } else {
      const prev = candles[i - 1];
      const up = candle.high - prev.high;
      const down = prev.low - candle.low;
      pdm = up > down && up > 0 ? up : 0;
      ndm = down > up && down > 0 ? down : 0;
      tr = Math.max(candle.high - candle.low, Math.abs(candle.high - prev.close), Math.abs(candle.low - prev.close));
    }

    if (i < period) {
      trS += tr;
      pdmS += pdm;
      ndmS += ndm;
    } else {
      trS = trS - trS / period + tr;
      pdmS = pdmS - pdmS / period + pdm;
      ndmS = ndmS - ndmS / period + ndm;
    }

    if (i >= period && trS > 0) {
      const pdi = (100 * pdmS) / trS;
      const ndi = (100 * ndmS) / trS;
      const sum = pdi + ndi;
      const value = sum ? (100 * Math.abs(pdi - ndi)) / sum : 0;

      if (adxValue == null) {
        dx.push(value);
        if (dx.length === period) {
          adxValue = dx.reduce((a, b) => a + b, 0) / period;
          out[i] = adxValue;
        }
      } else {
        adxValue = (adxValue * (period - 1) + value) / period;
        out[i] = adxValue;
      }
    }
  }
  return out;
}

// Kaufman Efficiency Ratio: net move / total travel over `period` bars.
// ~1 = clean trend, ~0 = choppy range.
function efficiencyRatio(candles, period = 10) {
  const n = candles.length;
  const out = new Array(n).fill(null);

  for (let i = period; i < n; i += 1) {
    const change = Math.abs(candles[i].close - candles[i - period].close);
    let travel = 0;
    for (let j = i - period + 1; j <= i; j += 1) travel += Math.abs(candles[j].close - candles[j - 1].close);
    out[i] = travel ? change / travel : 0;
  }
  return out;
}

module.exports = { atr, dailyVwap, adx, efficiencyRatio };
