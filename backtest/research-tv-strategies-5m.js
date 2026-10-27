// Backtest of the five most-rated TradingView intraday strategies, ported to a
// 5-minute BTCUSD chart on Delta Exchange.
//
// The five, picked from the community/published rankings (TradingView script
// library popularity + the 2026 Strategy Tester round-ups):
//   1. SuperTrend        (KivancOzbilgic)   — ATR ratcheting band, flip entry
//   2. UT Bot Alerts     (QuantNomad)       — ATR trailing-stop flip
//   3. DMI Toolbox       — +DI/-DI cross with ADX >= 25 (64% WR / 3.34 PF claimed)
//   4. Bollinger Squeeze — band pinch, then expansion
//   5. Opening-Range Breakout (ORB)         — the classic session breakout
//
// This is a RESEARCH script: it does not touch src/strategies. Each strategy is
// re-implemented here exactly as it would run live — signal on the close of a
// closed 5m bar, market entry, attached reduce-only bracket, one position at a
// time — and then simulated with real Delta costs.
//
// Two exit models are reported for every strategy, because they answer
// different questions:
//   * NATIVE  — exit the way the original Pine script does (opposite flip /
//               band re-entry / range re-entry). This is the "does the strategy
//               itself have an edge" answer.
//   * BRACKET — fixed SL + a `targetR`-multiple take-profit, both resting on
//               Delta. This is the "does the version we would actually deploy
//               (on-exchange bracket orders) have an edge" answer.
//
//   node backtest/research-tv-strategies-5m.js                    # all five, 5m, 30 days
//   node backtest/research-tv-strategies-5m.js --tf 1m --days 30
//   node backtest/research-tv-strategies-5m.js --days 30 --daily
//   node backtest/research-tv-strategies-5m.js --only supertrend,orb
//
// The indicator periods are bar counts, so `--tf 1m` means "the same strategy
// on a 1-minute chart" (ATR(10) is now 10 minutes, not 50). The one exception
// is the ORB, whose opening range is a TIME window, so `rangeBars` is scaled to
// keep a 15-minute range on every timeframe.
//
// Costs modelled (Delta retail):
//   * entry         market  -> taker 5 bps + 2 bps slippage
//   * stop exit     market  -> taker 5 bps + 2 bps slippage
//   * target exit   resting -> taker 5 bps (filled at the trigger, no slippage)
//   * native exit   market  -> taker 5 bps + 2 bps slippage
// Both gross (zero cost — the pure signal edge) and net (after costs) are shown.

'use strict';

const { loadCache } = require('./lib/data');

const SYMBOL = 'BTCUSD';
const RES_SEC = { '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400 };
let BAR_SEC = 300; // set from --tf in main()
const DAY_SEC = 86400;

const CFG = {
  contractValue: 0.001,
  feeTaker: 0.0005, // 5 bps
  slippage: 0.0002, // 2 bps, market legs only
  initialEquity: 1200,
  riskPct: 0.005, // 0.5% of equity per trade
  maxNotionalPct: 3, // notional <= 3x equity
};

// ---------------------------------------------------------------------------
// indicators (all operate on ascending 5m candles, time in seconds)
// ---------------------------------------------------------------------------

function atr(candles, period) {
  const n = candles.length;
  const out = new Array(n).fill(null);
  const tr = new Array(n).fill(0);
  for (let i = 1; i < n; i += 1) {
    const h = candles[i].high;
    const l = candles[i].low;
    const pc = candles[i - 1].close;
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  if (n <= period) return out;
  let sum = 0;
  for (let i = 1; i <= period; i += 1) sum += tr[i];
  out[period] = sum / period;
  for (let i = period + 1; i < n; i += 1) out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
  return out;
}

// SuperTrend: the ratcheting upper/lower bands and the trend side per bar.
function superTrend(candles, period, mult) {
  const n = candles.length;
  const atrArr = atr(candles, period);
  const upper = new Array(n).fill(null);
  const lower = new Array(n).fill(null);
  const trend = new Array(n).fill(null);

  for (let i = 0; i < n; i += 1) {
    const a = atrArr[i];
    if (!a || !(a > 0)) continue;
    const hl2 = (candles[i].high + candles[i].low) / 2;
    const bu = hl2 + mult * a;
    const bl = hl2 - mult * a;

    if (i === 0 || upper[i - 1] === null) {
      upper[i] = bu;
      lower[i] = bl;
      trend[i] = 1;
      continue;
    }
    upper[i] = bu < upper[i - 1] || candles[i - 1].close > upper[i - 1] ? bu : upper[i - 1];
    lower[i] = bl > lower[i - 1] || candles[i - 1].close < lower[i - 1] ? bl : lower[i - 1];

    const close = candles[i].close;
    let t;
    if (close > upper[i - 1]) t = 1;
    else if (close < lower[i - 1]) t = -1;
    else {
      t = trend[i - 1] === null ? 1 : trend[i - 1];
      if (t === 1 && lower[i] < lower[i - 1]) lower[i] = lower[i - 1];
      if (t === -1 && upper[i] > upper[i - 1]) upper[i] = upper[i - 1];
    }
    trend[i] = t;
  }

  const line = new Array(n).fill(null);
  for (let i = 0; i < n; i += 1) {
    if (trend[i] === null) continue;
    line[i] = trend[i] === 1 ? lower[i] : upper[i];
  }
  return { upper, lower, trend, line };
}

// UT Bot: the keyValue x ATR trailing stop and the cross state (+1 / -1).
function utBot(candles, period, keyValue) {
  const n = candles.length;
  const atrArr = atr(candles, period);
  const stop = new Array(n).fill(null);
  const pos = new Array(n).fill(null);

  for (let i = 0; i < n; i += 1) {
    const a = atrArr[i];
    if (!a || !(a > 0)) continue;
    const nLoss = keyValue * a;
    const close = candles[i].close;
    const prev = stop[i - 1];

    if (i === 0 || prev === null) {
      stop[i] = close - nLoss;
      pos[i] = 1;
      continue;
    }
    const prevClose = candles[i - 1].close;
    if (close > prev && prevClose > prev) stop[i] = Math.max(prev, close - nLoss);
    else if (close < prev && prevClose < prev) stop[i] = Math.min(prev, close + nLoss);
    else stop[i] = close > prev ? close - nLoss : close + nLoss;

    const pivot = stop[i - 1];
    if (pos[i - 1] === null) pos[i] = close > pivot ? 1 : -1;
    else if (close > pivot && prevClose < pivot) pos[i] = 1;
    else if (close < pivot && prevClose > pivot) pos[i] = -1;
    else pos[i] = pos[i - 1];
  }
  return { stop, pos };
}

// Wilder's DMI / ADX.
function dmi(candles, period) {
  const n = candles.length;
  const plusDI = new Array(n).fill(null);
  const minusDI = new Array(n).fill(null);
  const adxArr = new Array(n).fill(null);
  let trS = 0;
  let pdmS = 0;
  let ndmS = 0;
  let adxValue = null;
  const dx = [];

  for (let i = 0; i < n; i += 1) {
    const c = candles[i];
    let tr;
    let pdm = 0;
    let ndm = 0;
    if (i === 0) {
      tr = c.high - c.low;
    } else {
      const p = candles[i - 1];
      const up = c.high - p.high;
      const down = p.low - c.low;
      pdm = up > down && up > 0 ? up : 0;
      ndm = down > up && down > 0 ? down : 0;
      tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
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
      plusDI[i] = pdi;
      minusDI[i] = ndi;
      const sum = pdi + ndi;
      const dxValue = sum ? (100 * Math.abs(pdi - ndi)) / sum : 0;
      if (adxValue == null) {
        dx.push(dxValue);
        if (dx.length === period) {
          adxValue = dx.reduce((a, b) => a + b, 0) / period;
          adxArr[i] = adxValue;
        }
      } else {
        adxValue = (adxValue * (period - 1) + dxValue) / period;
        adxArr[i] = adxValue;
      }
    }
  }
  return { plusDI, minusDI, adxArr };
}

// Bollinger bands + the band width as a fraction of the mid band.
function bollinger(candles, period, mult) {
  const n = candles.length;
  const mid = new Array(n).fill(null);
  const upper = new Array(n).fill(null);
  const lower = new Array(n).fill(null);
  const width = new Array(n).fill(null);
  for (let i = period - 1; i < n; i += 1) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j += 1) sum += candles[j].close;
    const mean = sum / period;
    let v = 0;
    for (let j = i - period + 1; j <= i; j += 1) {
      const d = candles[j].close - mean;
      v += d * d;
    }
    const sd = Math.sqrt(v / period);
    mid[i] = mean;
    upper[i] = mean + mult * sd;
    lower[i] = mean - mult * sd;
    width[i] = mean > 0 ? (upper[i] - lower[i]) / mean : null;
  }
  return { mid, upper, lower, width };
}

function volumeAverage(candles, period, index) {
  if (index < period - 1) return null;
  let sum = 0;
  for (let j = index - period + 1; j <= index; j += 1) sum += candles[j].volume;
  return sum / period;
}

// ---------------------------------------------------------------------------
// the five strategies — each builder returns { sigs, P, exit }
//   sigs[i]  = { side, stop, target }  (entry at the close of bar i)
//   exit(i)  = true when the NATIVE exit fires on bar i's close
// ---------------------------------------------------------------------------

const PARAMS = {
  supertrend: { atrPeriod: 10, multiplier: 2.0, targetR: 2.0 },
  utbot: { atrPeriod: 10, keyValue: 1.0, targetR: 2.0 },
  dmi: { period: 14, adxMin: 25, atrPeriod: 14, stopAtrMult: 1.5, targetR: 2.0 },
  bollinger: {
    bbPeriod: 20, bbMult: 2.0, squeezeLookback: 100, squeezeBars: 3,
    volPeriod: 20, volMult: 1.2, atrPeriod: 14, stopAtrMult: 1.5, targetR: 2.0,
  },
  orb: { rangeBars: 3, tradeWindowHours: 8, maxTradesPerDay: 2, maxStopPoints: 300, targetR: 2.0 },
};

const buildSuperTrend = (candles) => {
  const P = PARAMS.supertrend;
  const n = candles.length;
  const sigs = new Array(n).fill(null);
  const { trend, line } = superTrend(candles, P.atrPeriod, P.multiplier);

  for (let i = 1; i < n; i += 1) {
    const now = trend[i];
    const before = trend[i - 1];
    if (now === null || before === null || now === before) continue;
    const stLine = line[i];
    if (!(stLine > 0)) continue;
    const side = now === 1 ? 'long' : 'short';
    const dir = side === 'long' ? 1 : -1;
    const entry = candles[i].close;
    const risk = Math.abs(entry - stLine);
    if (!(risk > 0)) continue;
    sigs[i] = { side, stop: stLine, target: entry + dir * P.targetR * risk };
  }

  // Native exit: the opposite flip (the SuperTrend line crossing back).
  return { sigs, P, exit: (i, side) => trend[i] !== null && trend[i] !== (side === 'long' ? 1 : -1) };
};

const buildUtBot = (candles) => {
  const P = PARAMS.utbot;
  const n = candles.length;
  const sigs = new Array(n).fill(null);
  const { stop, pos } = utBot(candles, P.atrPeriod, P.keyValue);

  for (let i = 1; i < n; i += 1) {
    const now = pos[i];
    const before = pos[i - 1];
    if (now === null || before === null || now === before) continue;
    const trailing = stop[i];
    if (!(trailing > 0)) continue;
    const side = now === 1 ? 'long' : 'short';
    const dir = side === 'long' ? 1 : -1;
    const entry = candles[i].close;
    const risk = Math.abs(entry - trailing);
    if (!(risk > 0)) continue;
    sigs[i] = { side, stop: trailing, target: entry + dir * P.targetR * risk };
  }

  // Native exit: the trailing stop flipping side.
  return { sigs, P, exit: (i, side) => pos[i] !== null && pos[i] !== (side === 'long' ? 1 : -1) };
};

const buildDmi = (candles) => {
  const P = PARAMS.dmi;
  const n = candles.length;
  const sigs = new Array(n).fill(null);
  const { plusDI, minusDI, adxArr } = dmi(candles, P.period);
  const atrArr = atr(candles, P.atrPeriod);

  for (let i = 1; i < n; i += 1) {
    const pdi = plusDI[i];
    const ndi = minusDI[i];
    if (pdi === null || ndi === null || plusDI[i - 1] === null || minusDI[i - 1] === null) continue;
    const adxValue = adxArr[i];
    if (P.adxMin > 0 && (adxValue === null || adxValue < P.adxMin)) continue;

    let side = null;
    if (pdi > ndi && plusDI[i - 1] <= minusDI[i - 1]) side = 'long';
    else if (ndi > pdi && minusDI[i - 1] <= plusDI[i - 1]) side = 'short';
    if (!side) continue;

    const a = atrArr[i];
    if (!(a > 0)) continue;
    const dir = side === 'long' ? 1 : -1;
    const entry = candles[i].close;
    const stop = entry - dir * P.stopAtrMult * a;
    sigs[i] = { side, stop, target: entry + dir * P.targetR * Math.abs(entry - stop) };
  }

  // Native exit: the DI lines cross back the other way.
  return {
    sigs,
    P,
    exit: (i, side) => {
      const pdi = plusDI[i];
      const ndi = minusDI[i];
      if (pdi === null || ndi === null) return false;
      return side === 'long' ? ndi > pdi : pdi > ndi;
    },
  };
};

const buildBollinger = (candles) => {
  const P = PARAMS.bollinger;
  const n = candles.length;
  const sigs = new Array(n).fill(null);
  const { mid, upper, lower, width } = bollinger(candles, P.bbPeriod, P.bbMult);
  const atrArr = atr(candles, P.atrPeriod);

  const isSqueezed = (index) => {
    const w = width[index];
    if (w === null || index < P.squeezeLookback - 1) return false;
    for (let j = index - P.squeezeLookback + 1; j <= index; j += 1) {
      if (width[j] === null || width[j] < w) return false;
    }
    return true;
  };

  for (let i = 1; i < n; i += 1) {
    if (upper[i] === null || lower[i] === null) continue;
    let coiled = false;
    for (let k = Math.max(1, i - P.squeezeBars + 1); k <= i; k += 1) {
      if (isSqueezed(k)) { coiled = true; break; }
    }
    if (!coiled) continue;

    const prevInside = candles[i - 1].close <= upper[i - 1] && candles[i - 1].close >= lower[i - 1];
    if (!prevInside) continue;

    let side = null;
    if (candles[i].close > upper[i]) side = 'long';
    else if (candles[i].close < lower[i]) side = 'short';
    if (!side) continue;

    const volAvg = volumeAverage(candles, P.volPeriod, i);
    if (volAvg > 0 && candles[i].volume < P.volMult * volAvg) continue;

    const a = atrArr[i];
    if (!(a > 0)) continue;
    const dir = side === 'long' ? 1 : -1;
    const entry = candles[i].close;
    const stop = entry - dir * P.stopAtrMult * a;
    sigs[i] = { side, stop, target: entry + dir * P.targetR * Math.abs(entry - stop) };
  }

  // Native exit: price falls back through the mid band.
  return {
    sigs,
    P,
    exit: (i, side) => {
      if (mid[i] === null) return false;
      return side === 'long' ? candles[i].close < mid[i] : candles[i].close > mid[i];
    },
  };
};

const buildOrb = (candles) => {
  const P = PARAMS.orb;
  const n = candles.length;
  const sigs = new Array(n).fill(null);
  const exits = new Array(n).fill(false);
  let curDay = null;
  let dayStart = 0;
  let orHigh = -Infinity;
  let orLow = Infinity;
  let orCount = 0;
  let trades = 0;

  for (let i = 1; i < n; i += 1) {
    const t = candles[i].time;
    const today = Math.floor(t / DAY_SEC) * DAY_SEC;
    if (today !== curDay) {
      curDay = today;
      dayStart = today;
      orHigh = -Infinity;
      orLow = Infinity;
      orCount = 0;
      trades = 0;
    }

    const c = candles[i];
    if (orCount < P.rangeBars) {
      orHigh = Math.max(orHigh, c.high);
      orLow = Math.min(orLow, c.low);
      orCount += 1;
      continue;
    }
    if ((t - dayStart) >= P.tradeWindowHours * 3600) continue;
    if (trades >= P.maxTradesPerDay) continue;
    if (!(orHigh > orLow)) continue;

    const prev = candles[i - 1];
    const prevInside = prev.close <= orHigh && prev.close >= orLow;
    if (!prevInside) continue;

    let side = null;
    if (c.close > orHigh) side = 'long';
    else if (c.close < orLow) side = 'short';
    if (!side) continue;

    const dir = side === 'long' ? 1 : -1;
    const entry = c.close;
    let stop = side === 'long' ? orLow : orHigh;
    if (Math.abs(entry - stop) > P.maxStopPoints) stop = entry - dir * P.maxStopPoints;
    const risk = Math.abs(entry - stop);
    if (!(risk > 0)) continue;

    sigs[i] = { side, stop, target: entry + dir * P.targetR * risk, orHigh, orLow, dayStart };
    trades += 1;
  }

  // Native exit: the breakout fails (close back inside the range), or the
  // session window closes out the position.
  return {
    sigs,
    P,
    exit: (i, side, pos) => {
      const c = candles[i];
      if (pos && pos.dayStart === Math.floor(c.time / DAY_SEC) * DAY_SEC && (c.time - pos.dayStart) >= P.tradeWindowHours * 3600) {
        return true;
      }
      if (pos && pos.orHigh != null) {
        return side === 'long' ? c.close < pos.orHigh : c.close > pos.orLow;
      }
      return false;
    },
  };
};

const BUILDERS = {
  supertrend: buildSuperTrend,
  utbot: buildUtBot,
  dmi: buildDmi,
  bollinger: buildBollinger,
  orb: buildOrb,
};

// ---------------------------------------------------------------------------
// simulator — market entry on the signal close, bracket resting on Delta
// ---------------------------------------------------------------------------

function sizeContracts(entry, stop) {
  const dist = Math.abs(entry - stop);
  if (!(dist > 0)) return 0;
  const byRisk = Math.floor((CFG.initialEquity * CFG.riskPct) / (dist * CFG.contractValue));
  const byNotional = Math.floor((CFG.initialEquity * CFG.maxNotionalPct) / (entry * CFG.contractValue));
  return Math.max(0, Math.min(byRisk, byNotional));
}

function simulate(candles, built, mode) {
  const n = candles.length;
  const sigs = built.sigs;
  const trades = [];
  let pos = null;

  const closePos = (trigger, bar, reason) => {
    const dir = pos.dir;
    // The stop and the native exit are stop-/market orders (taker + slippage);
    // the target is a resting take-profit that fills at its trigger (taker only).
    const exitAdj = reason === 'target' ? trigger : trigger * (1 - dir * CFG.slippage);
    const entryFee = pos.entryAdj * pos.contracts * CFG.contractValue * CFG.feeTaker;
    const exitFee = exitAdj * pos.contracts * CFG.contractValue * CFG.feeTaker;
    const gross = (trigger - pos.entryRaw) * dir * pos.contracts * CFG.contractValue;
    const net = (exitAdj - pos.entryAdj) * dir * pos.contracts * CFG.contractValue - entryFee - exitFee;
    const riskAmount = pos.risk * pos.contracts * CFG.contractValue;
    trades.push({
      day: new Date(bar.time * 1000).toISOString().slice(0, 10),
      side: pos.side,
      entry: pos.entryRaw,
      exit: trigger,
      contracts: pos.contracts,
      gross,
      fees: entryFee + exitFee,
      net,
      grossR: ((trigger - pos.entryRaw) * dir) / pos.risk,
      netR: net / Math.max(1e-9, riskAmount),
      reason,
      bars: (bar.time - pos.barTime) / BAR_SEC,
      entryTime: pos.barTime,
      exitTime: bar.time,
    });
    pos = null;
  };

  const openPos = (sig, bar) => {
    const contracts = sizeContracts(bar.close, sig.stop);
    if (!(contracts > 0)) return;
    const dir = sig.side === 'long' ? 1 : -1;
    pos = {
      side: sig.side,
      dir,
      entryRaw: bar.close,
      entryAdj: bar.close * (1 + dir * CFG.slippage),
      stop: sig.stop,
      target: sig.target,
      risk: Math.abs(bar.close - sig.stop),
      contracts,
      barTime: bar.time,
      orHigh: sig.orHigh,
      orLow: sig.orLow,
      dayStart: sig.dayStart,
    };
  };

  for (let i = 1; i < n; i += 1) {
    const bar = candles[i];

    if (pos) {
      const dir = pos.dir;
      const hitStop = dir === 1 ? bar.low <= pos.stop : bar.high >= pos.stop;
      const hitTarget = dir === 1 ? bar.high >= pos.target : bar.low <= pos.target;
      if (hitStop) {
        closePos(pos.stop, bar, 'stop'); // stop first: conservative
      } else if (mode === 'bracket' && hitTarget) {
        closePos(pos.target, bar, 'target');
      } else if (mode === 'native' && built.exit(i, pos.side, pos)) {
        closePos(bar.close, bar, 'exit');
      }
      // In native mode the exit and the reversal land on the same bar, so fall
      // through and let the signal below re-open the opposite side.
      if (pos) continue;
      if (mode !== 'native') continue;
    }

    const sig = sigs[i];
    if (!sig) continue;
    // Never open a second position in the same direction as the one just closed.
    openPos(sig, bar);
  }

  if (pos) closePos(candles[n - 1].close, candles[n - 1], 'open');
  return trades;
}

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------

function metrics(trades) {
  const n = trades.length;
  const sum = (f) => trades.reduce((s, t) => s + f(t), 0);
  const gwins = trades.filter((t) => t.gross > 0).length;
  const gp = trades.reduce((s, t) => s + (t.net > 0 ? t.net : 0), 0);
  const gl = Math.abs(trades.reduce((s, t) => s + (t.net <= 0 ? t.net : 0), 0));
  const byDay = new Map();
  for (const t of trades) byDay.set(t.day, (byDay.get(t.day) || 0) + t.net);
  return {
    n,
    gross: sum((t) => t.gross),
    net: sum((t) => t.net),
    costs: sum((t) => t.fees),
    winPct: n ? (gwins / n) * 100 : 0,
    pf: gl > 0 ? gp / gl : gp > 0 ? Infinity : 0,
    grossR: n ? sum((t) => t.grossR) / n : 0,
    netR: n ? sum((t) => t.netR) / n : 0,
    avgBars: n ? sum((t) => t.bars) / n : 0,
    byDay,
    greenDays: [...byDay.values()].filter((v) => v > 0).length,
    days: byDay.size,
  };
}

const f2 = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;
const pct = (v) => `${v.toFixed(1)}%`;
const minDay = (t) => (t.length ? t.map((x) => x.day).sort()[0] : null);
const maxDay = (t) => (t.length ? t.map((x) => x.day).sort().slice(-1)[0] : null);

function line(label, m) {
  console.log(
    `   ${label.padEnd(9)} trades ${String(m.n).padStart(4)}  win% ${pct(m.winPct).padStart(6)}  ` +
      `PF ${(m.pf === Infinity ? 'inf' : m.pf.toFixed(2)).padStart(5)}  ` +
      `avgR gross ${f2(m.grossR).padStart(6)} / net ${f2(m.netR).padStart(6)}  ` +
      `net ${f2(m.net).padStart(9)} (${((m.net / CFG.initialEquity) * 100).toFixed(1)}%)  ` +
      `hold ${(m.avgBars / 12).toFixed(1)}h  green ${m.greenDays}/${m.days}`,
  );
}

function reportOne(label, trades, reasonsOut) {
  const m = metrics(trades);
  if (!m.n) {
    console.log(`   ${label.padEnd(9)} no trades`);
    return m;
  }
  line(label, m);
  const reasons = new Map();
  for (const t of trades) reasons.set(t.reason, (reasons.get(t.reason) || 0) + 1);
  const costs = `costs -$${m.costs.toFixed(2)}`;
  console.log(
    `   ${''.padEnd(9)} exits ${[...reasons.entries()].map(([k, v]) => `${k}=${v}`).join(' ')}   ${costs}   ` +
      `period ${minDay(trades)} -> ${maxDay(trades)}`,
  );
  if (reasonsOut) for (const [k, v] of reasons) reasonsOut.set(k, (reasonsOut.get(k) || 0) + v);
  return m;
}

function dayRows(trades) {
  const byDay = new Map();
  for (const t of trades) {
    const d = byDay.get(t.day) || { n: 0, w: 0, net: 0, gross: 0 };
    d.n += 1;
    if (t.gross > 0) d.w += 1;
    d.net += t.net;
    d.gross += t.gross;
    byDay.set(t.day, d);
  }
  return [...byDay.entries()].sort();
}

function printDaily(label, trades) {
  if (!trades.length) return;
  console.log(`\n--- ${label}: daily (native) ---`);
  console.log('  date         trades  wins     gross($)      net($)     cum($)');
  let cum = 0;
  for (const [d, x] of dayRows(trades)) {
    cum += x.net;
    console.log(
      `  ${d}  ${String(x.n).padStart(5)}  ${String(x.w).padStart(4)}  ${f2(x.gross).padStart(10)}  ${f2(x.net).padStart(10)}  ${f2(cum).padStart(10)}`,
    );
  }
}

function lastNDays(trades, days) {
  const allDays = [...new Set(trades.map((t) => t.day))].sort();
  const window = new Set(allDays.slice(-days));
  return trades.filter((t) => window.has(t.day));
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const STRATEGIES = [
  { key: 'supertrend', name: '1. SuperTrend  (KivancOzbilgic) — ATR band flip', nativeNote: 'hold until the band flips' },
  { key: 'utbot', name: '2. UT Bot Alerts  (QuantNomad) — ATR trailing-stop flip', nativeNote: 'hold until the trail flips' },
  { key: 'dmi', name: '3. DMI Toolbox  — +DI/-DI cross with ADX >= 25', nativeNote: 'hold until the DI lines re-cross' },
  { key: 'bollinger', name: '4. Bollinger Squeeze  — band pinch then expansion', nativeNote: 'hold until price closes back through the mid band' },
  { key: 'orb', name: '5. Opening-Range Breakout  — 15m opening range', nativeNote: 'hold until the range fails or the window closes' },
];

function parseArgs(argv) {
  const a = { days: 30, daily: false, only: null, tf: '5m' };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--days') a.days = Number(argv[++i]);
    else if (argv[i] === '--daily') a.daily = true;
    else if (argv[i] === '--tf') a.tf = String(argv[++i]);
    else if (argv[i] === '--only') a.only = String(argv[++i]).split(',').map((s) => s.trim());
  }
  return a;
}

function main() {
  const args = parseArgs(process.argv);
  if (!RES_SEC[args.tf]) throw new Error(`Unknown --tf ${args.tf}. Use one of: ${Object.keys(RES_SEC).join(', ')}`);
  BAR_SEC = RES_SEC[args.tf];
  // The ORB's opening range is a TIME window (15 min), so on a finer timeframe
  // it needs proportionally more bars.
  PARAMS.orb.rangeBars = Math.max(1, Math.round(900 / BAR_SEC));

  const cached = loadCache(SYMBOL, args.tf);
  if (!cached || !cached.candles || !cached.candles.length) {
    throw new Error(`No ${SYMBOL} ${args.tf} cache. Run: node backtest/fetch.js --symbols ${SYMBOL} --timeframes ${args.tf} --days 120`);
  }
  const candles = cached.candles;
  const first = new Date(candles[0].time * 1000).toISOString().slice(0, 16);
  const last = new Date(candles[candles.length - 1].time * 1000).toISOString().slice(0, 16);

  console.log('============================================================');
  console.log(` Five most-rated TradingView intraday strategies on the ${args.tf} chart`);
  console.log(` instrument ${SYMBOL}   ${args.tf} bars   data ${first} -> ${last}  (${candles.length} bars)`);
  console.log(
    ` costs  entry taker ${(CFG.feeTaker * 1e4).toFixed(1)}bps + slip ${(CFG.slippage * 1e4).toFixed(1)}bps   ` +
      'stop/native taker+slip   target taker',
  );
  console.log(` risk ${(CFG.riskPct * 100).toFixed(2)}%/trade on $${CFG.initialEquity}, notional <= ${CFG.maxNotionalPct}x equity`);
  console.log(` window = the last ${args.days} calendar days of the cached data`);
  console.log('============================================================');

  const selected = args.only ? STRATEGIES.filter((s) => args.only.includes(s.key)) : STRATEGIES;
  const perStrategy = [];

  for (const s of selected) {
    const built = BUILDERS[s.key](candles);
    const raw = built.sigs.filter(Boolean).length;
    const natAll = simulate(candles, built, 'native');
    const brkAll = simulate(candles, built, 'bracket');
    perStrategy.push({ s, built, natAll, brkAll });
    console.log(
      `\n... ${s.name}: ${raw} raw signals, ${natAll.length} trades simulated ` +
        `(native) / ${brkAll.length} (bracket)`,
    );
  }

  console.log(`\n\n################  RESULTS — LAST ${args.days} DAYS  ################`);
  for (const { s, built, natAll, brkAll } of perStrategy) {
    console.log(`\n${'='.repeat(96)}`);
    console.log(` ${s.name}`);
    console.log(` params ${JSON.stringify(built.P)}`);
    console.log(` native exit: ${s.nativeNote}`);
    console.log(`${'='.repeat(96)}`);
    const natWin = lastNDays(natAll, args.days);
    const brkWin = lastNDays(brkAll, args.days);
    reportOne('NATIVE', natWin);
    reportOne('BRACKET', brkWin);
    console.log(
      `   ${''.padEnd(9)} full history: native trades=${natAll.length} net=${f2(metrics(natAll).net)}   ` +
        `bracket trades=${brkAll.length} net=${f2(metrics(brkAll).net)}`,
    );
    if (args.daily) printDaily(s.name, natWin);
  }

  console.log(`\n\n################  SUMMARY — LAST ${args.days} DAYS  ################`);
  console.log('  strategy                                   exit      trades  win%    avgR(gross)  avgR(net)    net($)    PF');
  for (const { s, natAll, brkAll } of perStrategy) {
    for (const [label, trades] of [['native', lastNDays(natAll, args.days)], ['bracket', lastNDays(brkAll, args.days)]]) {
      const m = metrics(trades);
      const nm = s.name.length > 40 ? `${s.name.slice(0, 39)}` : s.name;
      console.log(
        `  ${nm.padEnd(42)} ${label.padEnd(8)} ${String(m.n).padStart(5)}  ${pct(m.winPct).padStart(6)}  ` +
          `${f2(m.grossR).padStart(10)}  ${f2(m.netR).padStart(9)}  ${f2(m.net).padStart(9)}  ` +
          `${(m.pf === Infinity ? 'inf' : m.pf.toFixed(2)).padStart(5)}`,
      );
    }
  }
  console.log('');
}

main();
