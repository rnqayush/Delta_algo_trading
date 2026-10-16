// Sweep & Shift (S&S-15) — BTC 15m liquidity-sweep continuation.
//
// 100% price action. No indicators, no network, no database. This file only
// turns CLOSED candles into a trade plan (or HOLD). Risk, execution and
// position management live in the other engines (see §19 of the spec).
//
// Full specification: docs/btc-15m-sweep-shift-strategy.md
// Not validated. Not proven profitable. Paper-trade it before real money.
//
// Signal shape returned on a setup:
//   {
//     action: 'BUY' | 'SELL',
//     symbol, quantity, orderType: 'limit_order', price,   // the retest limit
//     stopLoss,                                            // structure-based SL
//     takeProfit: [{ price, percent }, ...],              // 40% @ 1R, 30% @ 2R
//     meta: { side, entry, sl, r, rr, score, sweepExtreme, bosLevel, avgBody },
//     reason,
//   }

'use strict';

// --- design constants (the strategy uses only these) ------------------------
const SWING_LOOKBACK = 2; // fractal half-width (a swing confirms 2 candles later)
const AVG_BODY_N = 20; // volatility unit: mean |close-open| of the last 20 candles
const DISPLACEMENT_X = 1.2; // a displacement body is >= 1.2 x avgBody
const BUFFER_X = 0.2; // stop buffer = max(tickSize, 0.2 x avgBody)
const MIN_RR = 2.0; // minimum reward-to-risk to the nearest opposing liquidity
const MIN_ROOM_RR = 2.5; // the level after that must be at least this far
const BOS_WINDOW = 6; // candles allowed between the sweep and the break
const ENTRY_VALIDITY = 4; // candles the retest limit survives
const SCORE_MIN = 7.0; // minimum trade quality score
const SCORE_MIN_COUNTER = 8.5; // score required against the 1H trend
const MAX_R_PERCENT = 1.2; // |entry - SL| may not exceed 1.2% of price

const SWEEP_WINDOW = 3; // the sweep must appear in the last 3 closed candles
const CLUSTER_TOLERANCE = 0.0015; // 0.15%
const ENTRY_OFFSET = 0.0002; // limit sits 2 bps past the broken level

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
// Swings & volatility
// --------------------------------------------------------------------------

// Confirmed swings only: a swing at index i is usable from candle i+LOOKBACK.
function confirmedSwings(candles, from) {
  const out = [];
  const limit = Number.isFinite(from) ? from : candles.length - 1;

  for (let i = SWING_LOOKBACK; i + SWING_LOOKBACK < candles.length; i += 1) {
    let isHigh = true;
    let isLow = true;

    for (let j = i - SWING_LOOKBACK; j <= i + SWING_LOOKBACK; j += 1) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low <= candles[i].low) isLow = false;
    }

    if (isHigh) out.push({ index: i, price: candles[i].high, type: 'HIGH' });
    if (isLow) out.push({ index: i, price: candles[i].low, type: 'LOW' });
  }

  return out
    .filter((swing) => swing.index + SWING_LOOKBACK <= limit)
    .sort((a, b) => a.index - b.index);
}

function swingHighs(candles, from) {
  return confirmedSwings(candles, from).filter((swing) => swing.type === 'HIGH');
}

function swingLows(candles, from) {
  return confirmedSwings(candles, from).filter((swing) => swing.type === 'LOW');
}

function avgBody(candles) {
  const slice = candles.slice(-AVG_BODY_N);
  if (!slice.length) return 0;
  return slice.reduce((sum, candle) => sum + Math.abs(candle.close - candle.open), 0) / slice.length;
}

// Higher-high/higher-low test on the last two confirmed 1H swings.
function htfBias(hourlyCandles) {
  const from = hourlyCandles.length - 1;
  const highs = swingHighs(hourlyCandles, from);
  const lows = swingLows(hourlyCandles, from);

  if (highs.length < 2 || lows.length < 2) return 'NONE';

  const [h0, h1] = highs.slice(-2).map((swing) => swing.price);
  const [l0, l1] = lows.slice(-2).map((swing) => swing.price);

  if (h1 > h0 && l1 > l0) return 'BULLISH';
  if (h1 < h0 && l1 < l0) return 'BEARISH';
  return 'NEUTRAL';
}

// --------------------------------------------------------------------------
// Liquidity
// --------------------------------------------------------------------------

// Groups swings into levels; >= 2 touches within 0.15% makes a CLUSTER.
// Keeps only the levels on the side of the market we care about.
function liquidityLevels(swings, side, price) {
  const levels = [];

  for (const swing of swings) {
    const match = levels.find((level) => Math.abs(level.price - swing.price) / price <= CLUSTER_TOLERANCE);
    if (match) {
      match.touches += 1;
      match.price = side === 'LONG' ? Math.min(match.price, swing.price) : Math.max(match.price, swing.price);
      match.strength = match.touches >= 2 ? 'CLUSTER' : 'SINGLE';
    } else {
      levels.push({ price: swing.price, touches: 1, strength: 'SINGLE' });
    }
  }

  return levels
    .filter((level) => (side === 'LONG' ? level.price < price : level.price > price))
    .sort((a, b) => (side === 'LONG' ? b.price - a.price : a.price - b.price));
}

// Nearest / next opposing liquidity pool (15m + 1H swing highs/lows).
function opposingLevels(candles15m, candles1h, side, price) {
  const pool = [
    ...swingHighs(candles15m, candles15m.length - 1).map((swing) => swing.price),
    ...swingLows(candles1h, candles1h.length - 1).map((swing) => swing.price),
  ].filter((level) => (side === 'LONG' ? level > price : level < price));

  pool.sort((a, b) => (side === 'LONG' ? a - b : b - a));
  return { nearest: pool.length ? pool[0] : null, next: pool.length > 1 ? pool[1] : null };
}

// --------------------------------------------------------------------------
// The pattern: sweep -> BOS -> retest entry
// --------------------------------------------------------------------------

// Looks for a valid sweep of `level` inside the last SWEEP_WINDOW candles.
// Returns { se, index } (sweep extreme + its absolute index) or null.
function detectSweep(candles, level, side, body) {
  const start = Math.max(0, candles.length - SWEEP_WINDOW);

  // Single-candle variant: the same candle pierces and closes back.
  for (let i = candles.length - 1; i >= start; i -= 1) {
    const candle = candles[i];
    if (side === 'LONG' && candle.low < level && candle.close > level) {
      return { se: candle.low, index: i };
    }
    if (side === 'SHORT' && candle.high > level && candle.close < level) {
      return { se: candle.high, index: i };
    }
  }

  // Two-candle variant: candle A pierces, candle B closes back.
  for (let i = start + 1; i < candles.length; i += 1) {
    const a = candles[i - 1];
    const b = candles[i];
    if (side === 'LONG' && a.low < level && b.close > level && a.close >= level - 0.25 * body) {
      return { se: a.low, index: i - 1 };
    }
    if (side === 'SHORT' && a.high > level && b.close < level && a.close <= level + 0.25 * body) {
      return { se: a.high, index: i - 1 };
    }
  }

  return null;
}

// A displacement candle closing beyond `bosLevel` within BOS_WINDOW of the sweep.
function detectBOS(candles, bosLevel, seIndex, side, body) {
  const window = candles.slice(seIndex + 1, seIndex + 1 + BOS_WINDOW);

  for (const candle of window) {
    const candleBody = Math.abs(candle.close - candle.open);
    if (candleBody < DISPLACEMENT_X * body) continue;
    if (side === 'LONG' && candle.close > bosLevel) return candle;
    if (side === 'SHORT' && candle.close < bosLevel) return candle;
  }

  return null;
}

function classifyRejection(candle, body, side) {
  const candleBody = Math.abs(candle.close - candle.open);
  const range = candle.high - candle.low;
  if (range <= 0) return 'NORMAL';

  const inRightThird =
    side === 'LONG' ? candle.close >= candle.low + (2 / 3) * range : candle.close <= candle.low + (1 / 3) * range;

  if (body > 0 && candleBody >= 1.5 * body && inRightThird) return 'STRONG';
  if (body > 0 && candleBody >= DISPLACEMENT_X * body) return 'NORMAL';
  return 'WEAK';
}

// --------------------------------------------------------------------------
// No-trade engine
// --------------------------------------------------------------------------

function marketFlags(candles, ticker, htf) {
  const flags = [];
  const last20 = candles.slice(-20);
  if (!last20.length) return flags;

  const price = candles[candles.length - 1].close;
  const range = Math.max(...last20.map((c) => c.high)) - Math.min(...last20.map((c) => c.low));
  if (price > 0 && range / price < 0.005) flags.push('COMPRESSION');

  let falseBreaks = 0;
  for (let i = 10; i < candles.length; i += 1) {
    const priorHigh = Math.max(...candles.slice(i - 10, i).map((c) => c.high));
    const priorLow = Math.min(...candles.slice(i - 10, i).map((c) => c.low));
    if (candles[i].high > priorHigh && candles[i].close < priorHigh) falseBreaks += 1;
    if (candles[i].low < priorLow && candles[i].close > priorLow) falseBreaks += 1;
  }
  if (falseBreaks >= 3) flags.push('CHOP');

  const bid = num(ticker && ticker.bestBid);
  const ask = num(ticker && ticker.bestAsk);
  if (bid > 0 && ask > 0) {
    const spread = (ask - bid) / ((ask + bid) / 2);
    if (spread > 0.0005) flags.push('WIDE_SPREAD');
  }

  const body = avgBody(candles);
  const lastRange = candles[candles.length - 1].high - candles[candles.length - 1].low;
  if (body > 0 && lastRange > 3 * body) flags.push('VOLATILITY_SPASM');

  if (htf === 'NEUTRAL') {
    const lo = Math.min(...last20.map((c) => c.low));
    const hi = Math.max(...last20.map((c) => c.high));
    if (hi > lo) {
      const pos = (price - lo) / (hi - lo);
      if (pos > 0.33 && pos < 0.67) flags.push('RANGE_MIDDLE');
    }
  }

  return flags;
}

function isExtended(candles, side, entryCandidate, body) {
  const swings = side === 'LONG' ? swingLows(candles, candles.length - 1) : swingHighs(candles, candles.length - 1);
  if (!swings.length) return true;

  const extreme = swings[swings.length - 1].price;
  if (Math.abs(entryCandidate - extreme) > 3 * body) return true;

  let streak = 0;
  for (let i = candles.length - 1; i > 0; i -= 1) {
    const bullish = candles[i].close > candles[i].open;
    if ((side === 'LONG' && bullish) || (side === 'SHORT' && !bullish)) streak += 1;
    else break;
  }

  return streak >= 4;
}

// --------------------------------------------------------------------------
// Trade quality score (0-10)
// --------------------------------------------------------------------------

function scoreTrade(ctx) {
  let score = 0;
  score += ctx.htf === 'ALIGNED' ? 2 : ctx.htf === 'NEUTRAL' ? 1 : 0;
  score += ctx.sweepStrength === 'CLUSTER' ? 2 : 1;
  score += ctx.rejection === 'STRONG' ? 1.5 : ctx.rejection === 'NORMAL' ? 0.75 : 0;
  score += ctx.bos === 'STRONG' ? 1.5 : 0.75;
  score += 1; // the entry is always a filled retest
  score += ctx.rr >= 3 ? 1 : ctx.rr >= 2.5 ? 0.75 : 0.5;
  score += ctx.room ? 0.5 : 0;
  score += ctx.softFlag ? 0.25 : 0.5;
  return score;
}

// Nudges the stop away from a round number so it is not an obvious magnet.
function avoidRoundNumber(sl, side, tickSize, body) {
  const hundred = Math.round(sl / 100) * 100;
  if (Math.abs(sl - hundred) < tickSize * 2) {
    return side === 'LONG' ? sl - 0.05 * body : sl + 0.05 * body;
  }
  return sl;
}

// --------------------------------------------------------------------------
// Strategy
// --------------------------------------------------------------------------

class SweepShiftStrategy {
  constructor(options = {}) {
    this.name = options.name || 'SweepShift-15';
    this.description = 'Sweep & Shift (S&S-15) — BTC 15m liquidity-sweep continuation (price action only)';
    this.symbol = options.symbol || 'BTCUSD';

    // Exchange + account facts (supplied by the engine / config).
    this.tickSize = num(options.tickSize) || 0.5;
    this.contractValue = num(options.contractValue) || 1;
    this.equity = num(options.equity) || 1000;
    this.riskPercent = num(options.riskPercent) || 0.005;
    this.maxRiskPercent = num(options.maxRiskPercent) || 0.01;
    this.maxNotionalEquity = num(options.maxNotionalEquity) || 3;
  }

  getName() {
    return this.name;
  }

  reset() {
    // The strategy is stateless — every evaluation is derived from the candles.
  }

  // marketData: { price/bestBid/bestAsk (or a nested `ticker`), candles15m, candles1h, daily }
  // state:      { hasOpenPosition, hasLiveOrder }
  evaluate(marketData = {}, state = {}) {
    const ticker = marketData.ticker || marketData;
    const price = num(ticker.price ?? ticker.markPrice ?? ticker.mark_price);

    const daily = marketData.daily || {};
    if (daily.halted) return hold('Daily risk limit reached');
    if (num(daily.tradesToday) >= 4) return hold('Max trades for today');
    if (num(daily.consecutiveLosses) >= 2) return hold('Two consecutive losses — done for the day');
    if (state.hasOpenPosition) return hold('A position is already open');
    if (state.hasLiveOrder) return hold('An entry order is already resting');

    if (!price) return hold('No price available');
    if (ticker.bestBid && ticker.bestAsk && num(ticker.bestAsk) < num(ticker.bestBid)) {
      return hold('No trade: crossed order book');
    }

    const candles15m = normalizeCandles(marketData.candles15m);
    const candles1h = normalizeCandles(marketData.candles1h);
    if (candles15m.length < AVG_BODY_N + 3 || candles1h.length < 10) {
      return hold('Not enough closed candles yet');
    }

    const htf = htfBias(candles1h);
    const flags = marketFlags(candles15m, ticker, htf);
    if (flags.length) return hold(`No-trade flags: ${flags.join(', ')}`);

    const body = avgBody(candles15m);
    const buffer = Math.max(this.tickSize, BUFFER_X * body);
    const lastIdx = candles15m.length - 1;

    const sides = htf === 'BULLISH' ? ['LONG'] : htf === 'BEARISH' ? ['SHORT'] : ['LONG', 'SHORT'];

    const rejections = [];
    for (const side of sides) {
      const plan = this.buildPlan({ side, candles15m, candles1h, htf, price, body, buffer, lastIdx });
      if (plan && plan.signal) return plan.signal;
      if (plan && plan.reason) rejections.push(plan.reason);
    }

    return hold(rejections.length ? `No valid setup (${rejections.join('; ')})` : 'No valid setup');
  }

  // Tries to build a complete trade plan for one direction. Returns
  // { signal } on success or { reason } when a candidate was rejected.
  buildPlan({ side, candles15m, candles1h, htf, price, body, buffer, lastIdx }) {
    const swings = side === 'LONG' ? swingLows(candles15m, lastIdx) : swingHighs(candles15m, lastIdx);
    const levels = liquidityLevels(swings, side, price);
    let lastReason = null;

    for (const level of levels) {
      const sweep = detectSweep(candles15m, level.price, side, body);
      if (!sweep) continue;

      // Invalidation: any of the last candles closing beyond the sweep extreme.
      const sweepWindow = candles15m.slice(-SWEEP_WINDOW);
      const invalidated = sweepWindow.some((c) => (side === 'LONG' ? c.close < sweep.se : c.close > sweep.se));
      if (invalidated) {
        lastReason = 'sweep invalidated by a close beyond SE';
        continue;
      }

      const bosLevels = side === 'LONG' ? swingHighs(candles15m, lastIdx) : swingLows(candles15m, lastIdx);
      const bosLevel = bosLevels.filter((s) => s.index <= sweep.index).pop();
      if (!bosLevel) continue;

      const bos = detectBOS(candles15m, bosLevel.price, sweep.index, side, body);
      if (!bos) continue;

      const entry = side === 'LONG' ? bosLevel.price * (1 + ENTRY_OFFSET) : bosLevel.price * (1 - ENTRY_OFFSET);
      let sl = side === 'LONG' ? sweep.se - buffer : sweep.se + buffer;
      sl = avoidRoundNumber(sl, side, this.tickSize, body);

      const risk = Math.abs(entry - sl);
      if (risk <= 0) continue;
      if (risk / entry > MAX_R_PERCENT / 100) {
        lastReason = 'stop wider than 1.2% of price';
        continue;
      }
      if (isExtended(candles15m, side, entry, body)) {
        lastReason = 'move already extended';
        continue;
      }

      const opp = opposingLevels(candles15m, candles1h, side, entry);
      if (opp.nearest === null) {
        lastReason = 'no opposing liquidity for a target';
        continue;
      }

      const reward = Math.abs(opp.nearest - entry);
      const rr = reward / risk;
      if (rr < MIN_RR) {
        lastReason = `rr ${rr.toFixed(2)} < ${MIN_RR}`;
        continue;
      }

      const room = opp.next !== null ? Math.abs(opp.next - entry) >= MIN_ROOM_RR * risk : false;

      const aligned = (side === 'LONG' && htf === 'BULLISH') || (side === 'SHORT' && htf === 'BEARISH');
      const counter = (side === 'LONG' && htf === 'BEARISH') || (side === 'SHORT' && htf === 'BULLISH');

      const score = scoreTrade({
        htf: aligned ? 'ALIGNED' : htf === 'NEUTRAL' ? 'NEUTRAL' : 'AGAINST',
        sweepStrength: level.strength,
        rejection: classifyRejection(bos, body, side),
        bos:
          Math.abs(bos.close - bosLevel.price) / bosLevel.price >= 0.001 &&
          Math.abs(bos.close - bos.open) >= 1.5 * body
            ? 'STRONG'
            : 'NORMAL',
        rr,
        room,
        softFlag: false,
      });

      if (score < (counter ? SCORE_MIN_COUNTER : SCORE_MIN)) {
        lastReason = `score ${score.toFixed(2)} below threshold`;
        continue;
      }

      const sizing = this.sizePosition({ entry, risk, rr, score, side, sl, sweep, bosLevel, level, body });
      if (!sizing) {
        lastReason = 'position too small after the notional cap';
        continue;
      }

      return {
        signal: {
          action: side === 'LONG' ? 'BUY' : 'SELL',
          symbol: this.symbol,
          quantity: sizing.quantity,
          orderType: 'limit_order',
          price: round(entry, 2),
          stopLoss: round(sl, 2),
          takeProfit: [
            { price: round(side === 'LONG' ? entry + risk : entry - risk, 2), percent: 40 },
            { price: round(side === 'LONG' ? entry + 2 * risk : entry - 2 * risk, 2), percent: 30 },
          ],
          meta: {
            strategy: this.name,
            side,
            entry: round(entry, 2),
            sl: round(sl, 2),
            r: round(risk, 2),
            rr: round(rr, 2),
            score: round(score, 2),
            sweepExtreme: round(sweep.se, 2),
            bosLevel: round(bosLevel.price, 2),
            liquidity: round(level.price, 2),
            liquidityStrength: level.strength,
            nearestOpposing: round(opp.nearest, 2),
            nextOpposing: opp.next === null ? null : round(opp.next, 2),
            avgBody: round(body, 2),
            tickSize: this.tickSize,
            notional: round(sizing.notional, 2),
            riskAmount: round(sizing.riskAmount, 2),
            entryValidityCandles: ENTRY_VALIDITY,
          },
          reason:
            `Sweep+Shift ${side}: swept ${level.strength} liquidity at ${round(level.price, 2)}, ` +
            `BOS at ${round(bosLevel.price, 2)}, rr=${rr.toFixed(2)}, score=${score.toFixed(2)}`,
        },
      };
    }

    return { reason: lastReason };
  }

  // §11: size from the stop distance so a clean stop costs `equity x riskPercent`.
  sizePosition({ entry, risk, rr, score, side, sl, sweep, bosLevel, level, body }) {
    const equity = this.equity;
    const riskPercent = Math.min(this.riskPercent, this.maxRiskPercent);
    const riskAmount = equity * riskPercent;
    const sizeInBase = riskAmount / risk; // BTC amount
    const notional = sizeInBase * entry; // quote currency (USD for BTCUSD)

    // Max notional per trade = maxNotionalEquity x equity.
    const maxNotional = this.maxNotionalEquity * equity;
    if (notional > maxNotional) return null;

    // contracts = notional / contract_value (contract_value comes from Delta's
    // instruments API and is expressed in the quote currency).
    const contracts = this.contractValue > 0 ? notional / this.contractValue : sizeInBase;
    const quantity = Math.floor(contracts);
    if (!Number.isFinite(quantity) || quantity < 1) return null;

    return { quantity, notional: quantity * this.contractValue, riskAmount, sizeInBase };
  }
}

function hold(reason) {
  return { action: 'HOLD', reason };
}

const sweepShiftStrategy = new SweepShiftStrategy();

module.exports = sweepShiftStrategy;
module.exports.SweepShiftStrategy = SweepShiftStrategy;
// Pure helpers exported so they can be unit-tested on their own.
module.exports.helpers = {
  confirmedSwings,
  swingHighs,
  swingLows,
  avgBody,
  htfBias,
  liquidityLevels,
  opposingLevels,
  detectSweep,
  detectBOS,
  classifyRejection,
  marketFlags,
  isExtended,
  scoreTrade,
  normalizeCandles,
};
