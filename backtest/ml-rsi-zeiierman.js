// "Machine Learning RSI | AI Classification & Ranking" (TradingView Pine v6,
// Zeiierman) ported as a backtest.
//
// WHY A PORT NEEDS AN EXIT ADDED
// ------------------------------
// The source is an INDICATOR: it draws an ML-RSI line, a conviction-adaptive
// Supertrend and L/S markers, and fires alerts. It never calls strategy.entry,
// has no stop, no target and no close — so there is nothing to "backtest" as
// shipped. This file reconstructs the signal engine faithfully and pairs it
// with the only risk line the script itself provides: its OWN ML Supertrend.
//   * entry  = triggerLong / triggerShort, filled at the trigger bar's close;
//   * exit   = the conviction-adaptive Supertrend trailing stop (the line the
//              Trend Gate already forces entries to sit on the right side of).
// That makes it a "kNN-RSI-gated Supertrend flip" system, which is the only
// way the author's own logic can actually be traded.
//
// WHAT THE ENGINE IS (no neural net anywhere)
// -------------------------------------------
//   1. eight RSI-derived features (value, slope, accel, mid, pct, churn,
//      spread, regime), each min-max normalised over 100 bars;
//   2. a rolling "bank" of the last `depth` labelled bars: features of bar t-4
//      paired with the 4-bar-forward move bucketed to -3..+3 by atrFactor*ATR;
//   3. Fisher-discriminant feature weights (bull vs bear clusters), EMA-blended;
//   4. k-nearest-neighbour vote in weighted, log-compressed distance space;
//   5. gates: Trend Gate (bias must match the Supertrend), Volatility Band
//      (ATR percentile 20-85), Chop Filter, Min Rank (60) and Min Confidence
//      (50), plus a 5-bar cooldown;
//   6. signals fire only when the gated STANCE flips direction.
//
// Anti-look-ahead is preserved the way the source does it: the bank stores a
// DELAYED feature snapshot (t-4) with an already-realised outcome, and signals
// are read off the confirmed bar close only.
//
//   node backtest/ml-rsi-zeiierman.js
//   node backtest/ml-rsi-zeiierman.js --tf 15m --symbols AINUSD,BTCUSD,ETHUSD --days 90
//   node backtest/ml-rsi-zeiierman.js --tf 5m --rank 45 --conf 35 --notrendgate
//   node backtest/ml-rsi-zeiierman.js --tf 1m --free
//
// Options:
//   --symbols      comma-separated (default TRADING_SYMBOL or BTCUSD)
//   --tf           candle resolution, default 5m
//   --days         look-back window in days, default 90
//   --rank         Min Rank to signal, default 60
//   --conf         Min Confidence to signal, default 50
//   --k            analog count, default 8
//   --depth        memory depth (bank rows), default 500
//   --atrfactor    learning sensitivity (xATR), default 0.5
//   --mult         Supertrend base ATR multiplier, default 1.5
//   --mlresp       ML band adaptivity 0..1, default 1
//   --notrendgate  disallow / allow counter-trend signals (default: gate ON)
//   --novolband    disable the volatility band gate (default: ON)
//   --nochop       disable the chop filter (default: ON)
//   --fee          taker fee in bps per leg, default 5
//   --slip         slippage in bps per leg, default 2
//   --free         ignore fees and slippage entirely

'use strict';

const { downloadCandles, RESOLUTION_SECONDS } = require('./lib/data');

const DEFAULTS = {
  tf: '5m',
  days: 90,
  rank: 60,
  conf: 50,
  k: 8,
  depth: 500,
  atrfactor: 0.5,
  mult: 1.5,
  mlresp: 1.0,
  fee: 5,
  slip: 2,
  free: false,
};

// Fixed constants lifted straight from the source.
const RSI_BASE = 14;
const WIN_LEN = 100;
const SPACING_BARS = 4;
const HORIZON_BARS = 4;
const STEP_LEN = 3;
const TREND_LEN = 50;
const CHOP_CUT = 0.5;
const VOL_BAND_LO = 20;
const VOL_BAND_HI = 85;
const ST_ATR_LEN = 10;
const SMOOTH_LEN = 10;
const COOL_BARS = 5;
const AUTO_FLOOR = 0.5;
const AUTO_MIN_ROWS = 60;
const AUTO_SPEED = 1.0; // source default: weights snap to the newest Fisher values

// ---------------------------------------------------------------------------
// Indicators (same maths as the Pine source / the sibling backtests here)
// ---------------------------------------------------------------------------

function rmaSeries(values, len) {
  const n = values.length;
  const out = new Array(n).fill(null);
  if (n < len) return out;
  let sum = 0;
  for (let i = 0; i < len; i += 1) sum += values[i];
  out[len - 1] = sum / len;
  for (let i = len; i < n; i += 1) out[i] = (out[i - 1] * (len - 1) + values[i]) / len;
  return out;
}

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

function atrSeries(candles, len) {
  const tr = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const pc = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
  });
  return rmaSeries(tr, len);
}

// Wilder RSI (RMA of gains/losses).
function rsiSeries(values, len) {
  const n = values.length;
  const out = new Array(n).fill(null);
  if (n < len + 1) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= len; i += 1) {
    const d = values[i] - values[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  let ag = gain / len;
  let al = loss / len;
  out[len] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = len + 1; i < n; i += 1) {
    const d = values[i] - values[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    ag = (ag * (len - 1) + g) / len;
    al = (al * (len - 1) + l) / len;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}

// Population standard deviation (Pine ta.stdev default is biased).
function stdevSeries(values, len) {
  const n = values.length;
  const out = new Array(n).fill(null);
  for (let i = len - 1; i < n; i += 1) {
    let s = 0;
    let s2 = 0;
    let c = 0;
    for (let j = i - len + 1; j <= i; j += 1) {
      if (values[j] == null) continue;
      s += values[j];
      s2 += values[j] * values[j];
      c += 1;
    }
    if (c === 0) continue;
    const mean = s / c;
    out[i] = Math.sqrt(Math.max(0, s2 / c - mean * mean));
  }
  return out;
}

// Percentile rank over the window (share of window values strictly below now).
function percentRankSeries(values, len) {
  const n = values.length;
  const out = new Array(n).fill(null);
  for (let i = len - 1; i < n; i += 1) {
    const cur = values[i];
    if (cur == null) continue;
    let cnt = 0;
    let tot = 0;
    for (let j = i - len + 1; j <= i; j += 1) {
      const v = values[j];
      if (v == null) continue;
      tot += 1;
      if (v < cur) cnt += 1;
    }
    out[i] = tot > 0 ? (cnt / tot) * 100 : null;
  }
  return out;
}

function lowestSeries(values, len) {
  const n = values.length;
  const out = new Array(n).fill(null);
  for (let i = len - 1; i < n; i += 1) {
    let m = Infinity;
    for (let j = i - len + 1; j <= i; j += 1) if (values[j] != null && values[j] < m) m = values[j];
    out[i] = m === Infinity ? null : m;
  }
  return out;
}

function highestSeries(values, len) {
  const n = values.length;
  const out = new Array(n).fill(null);
  for (let i = len - 1; i < n; i += 1) {
    let m = -Infinity;
    for (let j = i - len + 1; j <= i; j += 1) if (values[j] != null && values[j] > m) m = values[j];
    out[i] = m === -Infinity ? null : m;
  }
  return out;
}

// scale01: min-max normalise v over the last `len` bars; flat window -> 0.5.
function scale01Series(values, len) {
  const n = values.length;
  const lo = lowestSeries(values, len);
  const hi = highestSeries(values, len);
  const out = new Array(n).fill(null);
  for (let i = 0; i < n; i += 1) {
    if (lo[i] == null || hi[i] == null || values[i] == null) continue;
    out[i] = hi[i] === lo[i] ? 0.5 : (values[i] - lo[i]) / (hi[i] - lo[i]);
  }
  return out;
}

// EMA over a series that is null-prefixed (e.g. RSI before bar 14). Seeding an
// EMA through those nulls as zeros would poison it for dozens of bars.
function emaFromNulls(values, len) {
  const n = values.length;
  const out = new Array(n).fill(null);
  const start = values.findIndex((v) => v != null);
  if (start < 0) return out;
  const e = emaSeries(values.slice(start), len);
  for (let i = 0; i < e.length; i += 1) out[start + i] = e[i];
  return out;
}

const compress = (d) => Math.log(1 + Math.abs(d));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---------------------------------------------------------------------------
// Bank / weights / neighbour engine
// ---------------------------------------------------------------------------

// Fisher discriminant per feature over the labelled bank, scaled to [floor, 10].
function autoFeatureWeights(bank, minRows, floor) {
  const imp = new Array(8).fill(1);
  if (bank.length < minRows) return imp;

  const sumB = new Array(8).fill(0);
  const sumBe = new Array(8).fill(0);
  const sqB = new Array(8).fill(0);
  const sqBe = new Array(8).fill(0);
  let cntB = 0;
  let cntBe = 0;

  for (const row of bank) {
    const o = row[8];
    if (!(o > 0 || o < 0)) continue;
    const isB = o > 0;
    for (let j = 0; j < 8; j += 1) {
      const v = row[j];
      if (isB) {
        sumB[j] += v;
        sqB[j] += v * v;
      } else {
        sumBe[j] += v;
        sqBe[j] += v * v;
      }
    }
    if (isB) cntB += 1;
    else cntBe += 1;
  }

  if (cntB <= 2 || cntBe <= 2) return imp;

  const fish = new Array(8).fill(0);
  let maxF = 0;
  for (let j = 0; j < 8; j += 1) {
    const mB = sumB[j] / cntB;
    const mBe = sumBe[j] / cntBe;
    const vB = Math.max(0, sqB[j] / cntB - mB * mB);
    const vBe = Math.max(0, sqBe[j] / cntBe - mBe * mBe);
    const f = (mB - mBe) ** 2 / (vB + vBe + 1e-6);
    fish[j] = f;
    maxF = Math.max(maxF, f);
  }
  for (let j = 0; j < 8; j += 1) {
    const norm = maxF > 0 ? fish[j] / maxF : 1;
    imp[j] = Math.max(floor, norm * 10);
  }
  return imp;
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

function simulate(candles, opts) {
  const { rank: gateRank, conf: gateConf, k: kNeighbors, depth, atrFactor, stMultBase,
    stMlResp, useTrendGate, useVolBand, useChop, costPerTrade } = opts;

  const n = candles.length;
  const close = candles.map((c) => c.close);
  const hl2 = candles.map((c) => (c.high + c.low) / 2);

  // ---- precomputed series ------------------------------------------------
  const rOsc = rsiSeries(close, RSI_BASE);
  const rOscF = rsiSeries(close, Math.max(2, Math.round(RSI_BASE / 2)));
  const rOscS = rsiSeries(close, RSI_BASE * 2);
  const atrVal = atrSeries(candles, 14);
  const stAtr = atrSeries(candles, ST_ATR_LEN);
  const atrPct = percentRankSeries(atrVal, 100);

  const slopeRaw = close.map((_, i) => (rOsc[i] == null || rOsc[i - STEP_LEN] == null ? null : rOsc[i] - rOsc[i - STEP_LEN]));
  const accelRaw = close.map((_, i) => (slopeRaw[i] == null || slopeRaw[i - STEP_LEN] == null ? null : slopeRaw[i] - slopeRaw[i - STEP_LEN]));
  const midRaw = close.map((_, i) => (rOsc[i] == null ? null : Math.abs(rOsc[i] - 50) / 50));
  const pctRaw = percentRankSeries(rOsc, WIN_LEN).map((v) => (v == null ? null : v / 100));
  const churnRaw = stdevSeries(rOsc, 14);
  const spreadRaw = close.map((_, i) => (rOscF[i] == null || rOscS[i] == null ? null : rOscF[i] - rOscS[i]));
  const oscEma20 = emaFromNulls(rOsc, 20);
  const regimeRaw = close.map((_, i) => (oscEma20[i] == null || rOsc[i] == null ? null : oscEma20[i] - 50));

  const slopeN = scale01Series(slopeRaw, WIN_LEN);
  const accelN = scale01Series(accelRaw, WIN_LEN);
  const churnN = scale01Series(churnRaw, WIN_LEN);
  const spreadN = scale01Series(spreadRaw, WIN_LEN);
  const regimeN = scale01Series(regimeRaw, WIN_LEN);

  const oscEma5 = emaFromNulls(rOsc, 5);
  const emaTrend = emaSeries(close, TREND_LEN);
  const emaQuick = emaSeries(close, 5);

  const featureAt = (i) => {
    if (rOsc[i] == null || slopeN[i] == null || accelN[i] == null || midRaw[i] == null ||
        pctRaw[i] == null || churnN[i] == null || spreadN[i] == null || regimeN[i] == null) return null;
    return [rOsc[i] / 100, slopeN[i], accelN[i], midRaw[i], pctRaw[i], churnN[i], spreadN[i], regimeN[i]];
  };

  const warmup = Math.max(WIN_LEN + HORIZON_BARS + 10, 130);

  // ---- running state -----------------------------------------------------
  const bank = [];
  const wAuto = new Array(8).fill(1);
  let stLong = null;
  let stShort = null;
  let stDir = 1;
  let convSmoothed = 0;
  let stanceState = 0;
  let stanceAge = 0;
  let changedHist = [false, false, false];
  let lastEntryBar = -Infinity;

  const trades = [];
  let triggers = 0;
  let pos = null;

  const closeTrade = (price, index, reason) => {
    const d = pos.side === 'long' ? 1 : -1;
    const gross = (d * (price - pos.entry)) / pos.entry;
    trades.push({
      side: pos.side, entry: pos.entry, exit: price, gross, net: gross - costPerTrade,
      r: pos.riskFrac > 0 ? gross / pos.riskFrac : 0, bars: index - pos.entryIndex,
      reason, time: candles[index].time,
    });
    pos = null;
  };

  for (let i = warmup; i < n; i += 1) {
    // --- 0. manage the open position with the stop resting from bar i-1 ----
    if (pos && i > pos.entryIndex) {
      const stop = pos.stop;
      const pierced = pos.side === 'long' ? candles[i].low <= stop : candles[i].high >= stop;
      if (pierced) {
        const gapped = pos.side === 'long' ? candles[i].open < stop : candles[i].open > stop;
        closeTrade(gapped ? candles[i].open : stop, i, 'trail');
      }
    }

    const cur = featureAt(i);
    if (!cur || !(atrVal[i] > 0) || !(stAtr[i] > 0)) continue;

    // --- 1. bank the (delayed) labelled example ---------------------------
    if (i > HORIZON_BARS) {
      const past = featureAt(i - HORIZON_BARS);
      const mv = close[i] - close[i - HORIZON_BARS];
      const band = atrFactor * atrVal[i - HORIZON_BARS];
      if (past && band > 0) {
        const outcome = mv > 2 * band ? 3 : mv > band ? 2 : mv > 0 ? 1
          : mv < -2 * band ? -3 : mv < -band ? -2 : mv < 0 ? -1 : 0;
        bank.unshift([...past, outcome]);
        if (bank.length > depth) bank.pop();
      }
    }

    // --- 2. Fisher auto-weights (EMA-blended) -----------------------------
    const wRaw = autoFeatureWeights(bank, AUTO_MIN_ROWS, AUTO_FLOOR);
    for (let j = 0; j < 8; j += 1) wAuto[j] = wAuto[j] + AUTO_SPEED * (wRaw[j] - wAuto[j]);
    const wSum = wAuto.reduce((s, v) => s + v, 0);

    // --- 3. kNN vote in weighted log-distance space -----------------------
    const scanEnd = Math.min(depth - 1, bank.length - 1);
    let nbrs = [];
    for (let idx = 0; idx <= scanEnd; idx += 1) {
      if (idx % SPACING_BARS !== 0) continue;
      const row = bank[idx];
      let g = 0;
      for (let j = 0; j < 8; j += 1) g += wAuto[j] * compress(cur[j] - row[j]);
      if (!Number.isFinite(g)) continue;
      nbrs.push({ gap: g, cls: row[8] });
    }
    nbrs.sort((a, b) => a.gap - b.gap);
    if (nbrs.length > kNeighbors) nbrs = nbrs.slice(0, kNeighbors);

    let total = 0;
    let bull = 0;
    let bear = 0;
    let score = 0;
    let gapSum = 0;
    for (const nb of nbrs) {
      const w = 1 / (1 + nb.gap);
      total += w;
      score += nb.cls * w;
      if (nb.cls > 0) bull += w;
      else if (nb.cls < 0) bear += w;
      gapSum += nb.gap;
    }
    const kCount = nbrs.length;
    const analogScore = total > 0 ? score / total : 0;
    const biasDir = analogScore > 0.15 ? 1 : analogScore < -0.15 ? -1 : 0;
    const agreeFrac = total > 0 ? (biasDir === 1 ? bull : biasDir === -1 ? bear : 0) / total : 0;
    const avgGap = kCount > 0 ? gapSum / kCount : 0;
    const gapScale = wSum * 0.45 + 1e-9;
    const gapTight = clamp(1 - avgGap / gapScale, 0, 1);

    // --- 4. context / ML adaptive Supertrend ------------------------------
    const trendForce = emaTrend[i] != null ? Math.abs(emaQuick[i] - emaTrend[i]) / atrVal[i] : 0;
    const chopRaw = trendForce < CHOP_CUT;
    const chopNow = useChop ? chopRaw : false;
    const slopeUp = rOsc[i] > rOsc[i - STEP_LEN];
    const oscReg = oscEma20[i];
    const oscSmoothUp = oscEma5[i] > oscEma5[i - 1];
    const volHealthy = atrPct[i] != null && atrPct[i] >= VOL_BAND_LO && atrPct[i] <= VOL_BAND_HI;

    const convInst = clamp(analogScore / 1.5, -1, 1);
    convSmoothed = convSmoothed + (2 / (SMOOTH_LEN + 1)) * (convInst - convSmoothed);
    let mlDrive = clamp(Math.abs(convSmoothed) * 0.5 + gapTight * 0.3 + agreeFrac * 0.2, 0, 1);
    if (chopNow) mlDrive *= 0.35;
    const adaptMult = stMultBase * (1 + stMlResp * (1 - mlDrive));

    const upBand = hl2[i] - adaptMult * stAtr[i];
    const dnBand = hl2[i] + adaptMult * stAtr[i];
    const prevClose = close[i - 1];
    stLong = stLong == null ? upBand : prevClose > stLong ? Math.max(upBand, stLong) : upBand;
    stShort = stShort == null ? dnBand : prevClose < stShort ? Math.min(dnBand, stShort) : dnBand;
    const prevDir = stDir;
    if (prevDir === -1 && close[i] > stShort) stDir = 1;
    else if (prevDir === 1 && close[i] < stLong) stDir = -1;
    const stLine = stDir === 1 ? stLong : stShort;

    const aligned = (dir) => (dir === 1 && stDir === 1) || (dir === -1 && stDir === -1);
    const slopeFit = (biasDir === 1 && slopeUp) || (biasDir === -1 && !slopeUp);
    const stretched = (biasDir === 1 && rOsc[i] > 70) || (biasDir === -1 && rOsc[i] < 30);

    // --- 5. stance / rank / confidence ------------------------------------
    const gatesPass = (!useTrendGate || aligned(biasDir)) && (!useVolBand || volHealthy) && !chopNow;
    const prevStance = stanceState;
    if (biasDir === 1 && gatesPass) stanceState = 1;
    else if (biasDir === -1 && gatesPass) stanceState = -1;
    const stanceChanged = stanceState !== prevStance;
    stanceAge = stanceChanged ? 0 : stanceAge + 1;
    const earlyFlip = stanceChanged && (changedHist[0] || changedHist[1] || changedHist[2]);

    const pAgree = 25 * agreeFrac;
    const pGap = 15 * gapTight;
    const pStruct = (slopeFit ? 10 : 0) + (stretched ? 0 : 5);
    const pTrend = aligned(biasDir) ? 10 : 0;
    const pVol = volHealthy ? 10 : atrPct[i] < VOL_BAND_LO ? 5 : 3;
    const regFit = (biasDir === 1 && oscReg > 55) || (biasDir === -1 && oscReg < 45);
    const pReg = regFit ? 10 : oscReg >= 45 && oscReg <= 55 ? 4 : 6;
    const pSmooth = (biasDir === 1 && oscSmoothUp) || (biasDir === -1 && !oscSmoothUp) ? 5 : 0;
    const pHold = Math.min(5, stanceAge);
    const pPen = Math.min(20, (chopRaw ? 8 : 0) + (stretched ? 6 : 0) + (earlyFlip ? 6 : 0) +
      (kCount < kNeighbors ? (5 * (kNeighbors - kCount)) / kNeighbors : 0));
    const rank = biasDir === 0 ? 0 : clamp(pAgree + pGap + pStruct + pTrend + pVol + pReg + pSmooth + pHold - pPen, 0, 100);

    const confRaw = 40 * agreeFrac + 25 * gapTight + 15 * Math.min(1, stanceAge / 5) + 10 * (slopeFit ? 1 : 0) -
      (earlyFlip ? 15 : 0) - (kCount < kNeighbors ? (10 * (kNeighbors - kCount)) / kNeighbors : 0);
    const conf = biasDir === 0 ? 0 : clamp(confRaw, 0, 100);

    // --- 6. signals -------------------------------------------------------
    const flipLong = stanceState === 1 && prevStance !== 1;
    const flipShort = stanceState === -1 && prevStance !== -1;
    const qualifies = rank >= gateRank && conf >= gateConf;
    const coolOK = i - lastEntryBar >= COOL_BARS;
    const triggerLong = flipLong && qualifies && coolOK;
    const triggerShort = flipShort && qualifies && coolOK;
    if (triggerLong || triggerShort) {
      triggers += 1;
      lastEntryBar = i;
    }

    // --- 7. act -----------------------------------------------------------
    if (!pos) {
      if (triggerLong) {
        pos = { side: 'long', entry: close[i], stop: stLine, entryIndex: i, riskFrac: Math.abs(close[i] - stLine) / close[i] };
      } else if (triggerShort) {
        pos = { side: 'short', entry: close[i], stop: stLine, entryIndex: i, riskFrac: Math.abs(close[i] - stLine) / close[i] };
      }
    }
    if (pos) pos.stop = stLine;

    changedHist = [stanceChanged, changedHist[0], changedHist[1]];
  }

  if (pos) closeTrade(candles[n - 1].close, n - 1, 'eod');
  return { trades, triggers };
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

function analyze(candles, opts) {
  const { trades, triggers } = simulate(candles, opts);
  const n = trades.length;
  if (!n) return { trades: 0, triggers, empty: true };

  const spanDays = (candles[candles.length - 1].time - candles[0].time) / 86400;
  const sum = (f) => trades.reduce((s, t) => s + f(t), 0);
  const grossPct = sum((t) => t.gross) * 100;
  const netPct = sum((t) => t.net) * 100;
  const wins = trades.filter((t) => t.net > 0);
  const losses = trades.filter((t) => t.net <= 0);

  let peak = 0;
  let equity = 0;
  let maxDD = 0;
  for (const t of trades) {
    equity += t.net;
    if (equity > peak) peak = equity;
    if (peak - equity > maxDD) maxDD = peak - equity;
  }

  return {
    trades: n,
    triggers,
    spanDays,
    perDay: n / spanDays,
    winPct: (wins.length / n) * 100,
    avgHold: sum((t) => t.bars) / n,
    grossPerDay: grossPct / spanDays,
    netPerDay: netPct / spanDays,
    costPerDay: (grossPct - netPct) / spanDays,
    profitFactor: losses.length
      ? sum((t) => Math.max(t.gross, 0)) / Math.abs(sum((t) => Math.min(t.gross, 0)))
      : Infinity,
    maxDD: maxDD * 100,
    longShare: (trades.filter((t) => t.side === 'long').length / n) * 100,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

const fmt = (v, d = 2, suffix = '') => (Number.isFinite(v) ? v.toFixed(d) + suffix : '-');
const signed = (v, d = 2) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(d)}` : '-');
const pad = (t, w, right = false) => (right ? String(t).padStart(w) : String(t).padEnd(w));

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const tf = args.tf ? String(args.tf) : DEFAULTS.tf;
  if (!RESOLUTION_SECONDS[tf]) {
    console.error(`Unsupported --tf "${tf}". Use one of: ${Object.keys(RESOLUTION_SECONDS).join(', ')}`);
    process.exit(1);
  }

  const days = Number(args.days) || DEFAULTS.days;
  const symbols = (args.symbols ? String(args.symbols).split(',') : [process.env.TRADING_SYMBOL || 'BTCUSD'])
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  const fee = (args.fee !== undefined ? Number(args.fee) : DEFAULTS.fee) / 1e4;
  const slip = (args.slip !== undefined ? Number(args.slip) : DEFAULTS.slip) / 1e4;
  const costPerTrade = DEFAULTS.free || args.free ? 0 : 2 * (fee + slip);

  const opts = {
    rank: args.rank !== undefined ? Number(args.rank) : DEFAULTS.rank,
    conf: args.conf !== undefined ? Number(args.conf) : DEFAULTS.conf,
    k: Number(args.k) || DEFAULTS.k,
    depth: Number(args.depth) || DEFAULTS.depth,
    atrFactor: args.atrfactor !== undefined ? Number(args.atrfactor) : DEFAULTS.atrfactor,
    stMultBase: args.mult !== undefined ? Number(args.mult) : DEFAULTS.mult,
    stMlResp: args.mlresp !== undefined ? Number(args.mlresp) : DEFAULTS.mlresp,
    useTrendGate: !args.notrendgate,
    useVolBand: !args.novolband,
    useChop: !args.nochop,
    costPerTrade,
  };

  console.log(`\nML RSI (Zeiierman) — kNN-RSI-gated Supertrend flip — ${tf} bars, last ${days}d`);
  console.log('='.repeat(118));
  console.log(
    `model   features=8 RSI-derived, bank=${opts.depth}, k=${opts.k}, atrFactor=${opts.atrFactor}, ` +
      `ST mult=${opts.stMultBase} (mlResp ${opts.stMlResp}), gates: rank>=${opts.rank} conf>=${opts.conf}` +
      ` trendGate=${opts.useTrendGate ? 'on' : 'off'} volBand=${opts.useVolBand ? 'on' : 'off'} chop=${opts.useChop ? 'on' : 'off'}`
  );
  console.log(
    costPerTrade > 0
      ? `costs   ${(fee * 1e4).toFixed(1)}bps taker + ${(slip * 1e4).toFixed(1)}bps slip per leg -> ${(costPerTrade * 1e4).toFixed(1)}bps per trade`
      : 'costs   NONE (--free): this is the raw signal edge, not a tradeable result'
  );

  const rows = [];
  for (const symbol of symbols) {
    const toSec = Math.floor(Date.now() / 1000);
    const fromSec = toSec - days * 86400;
    try {
      const { candles } = await downloadCandles({ symbol, resolution: tf, fromSec, toSec });
      if (candles.length < 200) {
        rows.push({ symbol, skipped: `only ${candles.length} bars` });
        continue;
      }
      const m = analyze(candles, opts);
      rows.push({ symbol, bars: candles.length, ...m });
    } catch (error) {
      rows.push({ symbol, skipped: error.message });
    }
  }

  console.log(
    `\n${pad('#', 3, true)} | ${pad('symbol', 10)} | ${pad('bars', 6, true)} | ${pad('trigs', 6, true)} | ` +
      `${pad('trades', 6, true)} | ${pad('/day', 6, true)} | ${pad('win%', 5, true)} | ` +
      `${pad('hold', 6, true)} | ${pad('PF', 5, true)} | ${pad('gross%/d', 8, true)} | ${pad('cost%/d', 8, true)} | ` +
      `${pad('net%/d', 7, true)} | ${pad('maxDD%', 7, true)}`
  );
  console.log('-'.repeat(118));

  rows.forEach((r, index) => {
    if (r.skipped) {
      console.log(`${pad(index + 1, 3, true)} | ${pad(r.symbol, 10)} | skipped: ${r.skipped}`);
      return;
    }
    if (r.empty) {
      console.log(
        `${pad(index + 1, 3, true)} | ${pad(r.symbol, 10)} | ${pad(r.bars, 6, true)} | ${pad(r.triggers, 6, true)} | ` +
          `${pad(0, 6, true)} | no trades`
      );
      return;
    }
    console.log(
      `${pad(index + 1, 3, true)} | ${pad(r.symbol, 10)} | ${pad(r.bars, 6, true)} | ${pad(r.triggers, 6, true)} | ` +
        `${pad(r.trades, 6, true)} | ${pad(fmt(r.perDay, 1), 6, true)} | ${pad(fmt(r.winPct, 1), 5, true)} | ` +
        `${pad(fmt(r.avgHold, 0), 6, true)} | ${pad(fmt(r.profitFactor, 2), 5, true)} | ` +
        `${pad(signed(r.grossPerDay, 2), 8, true)} | ${pad(fmt(r.costPerDay, 2), 8, true)} | ` +
        `${pad(signed(r.netPerDay, 2), 7, true)} | ${pad(fmt(r.maxDD, 1), 7, true)}`
    );
  });

  console.log(
    '\ntrigs = trigger bars fired, trades = entries actually taken, exit = ML Supertrend trailing stop,\n' +
      'PF = gross wins / gross losses, net%/d = what is left after costs.\n' +
      'NOTE: this is an indicator ported with an added exit; treat it as an entry-quality test.'
  );
}

main().catch((error) => {
  console.error('BACKTEST FAILED:', error.message);
  process.exit(1);
});
