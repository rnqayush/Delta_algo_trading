// "Super Trend 2 MACD" — 1-minute BTCUSD strategy, ported to the live engine.
//
// Ported from backtest/research-supertrend2macd-1m.js with the parameter set the
// optimizer found net-profitable (backtest/optimize-supertrend2macd-1m.js):
//
//   local SuperTrend : factor 2, ATR 21   (the 1m chart)
//   main  SuperTrend : factor 2, ATR 7    (the 120-minute "security" series)
//   MACD             : 12 / 26 / 9 (SMA based, exactly as in the Pine script)
//   LONG  : the local trend flips UP   AND the main trend is UP   AND Macd > Signal
//   SHORT : the local trend flips DOWN AND the main trend is DOWN AND Macd < Signal
//   TP = 500 pts, SL = 400 pts, resting on Delta as a reduce-only bracket
//   REVERSE: an opposite signal closes the position at market, and the next
//            cycle opens the other side with a resting MAKER limit.
//
// The published script's `security(tickerid,"120",...)` repaints — it leaks the
// final 2h values into every 1m bar of the window. This port, like the backtest,
// reads the main trend from the LAST COMPLETED 2h bar, which is what can
// actually be deployed.
//
// The main SuperTrend is rebuilt by re-bucketing the 1m feed into epoch-aligned
// 2h candles, so it is the same series the backtest computed.
//
// Bar by bar, on the last CLOSED 1m candle:
//   1. rebuild the local SuperTrend and the 2h trend map (no look-ahead);
//   2. look for a local trend FLIP on this bar;
//   3. keep it only when the completed 2h trend and MACD agree with the flip;
//   4. enter with a resting Maker limit at the bar close and send the stop and
//      the target as an on-exchange reduce-only bracket (500 / 400 points);
//   5. while a position is open, stand down — unless the opposite signal fires,
//      in which case close (reduce-only market) and let the next cycle re-enter.
//
// One signal is acted on at most once, and nothing is sent while an entry is
// already resting.

const HTF_MS = 7200 * 1000; // 120-minute main SuperTrend

// Strategy inputs (the optimized set).
const P = {
  factor: 2, // local SuperTrend factor
  pd: 21, // local SuperTrend ATR period
  htfFactor: 2, // main (2h) SuperTrend factor
  htfPd: 7, // main (2h) SuperTrend ATR period
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  tpPoints: 500, // Take Profit, in price points
  slPoints: 400, // Stop Loss, in price points
};

// Warm-up floor: the 2h ATR(7) needs 8 completed 2h buckets (16h = 960 1m bars),
// the 1m ATR(21) needs 21 bars and the MACD needs ~35. 1000 leaves headroom.
const MIN_BARS = 1000;

// ---------------------------------------------------------------------------
// Indicators — identical maths to backtest/research-supertrend2macd-1m.js
// ---------------------------------------------------------------------------

function trueRange(candles, i) {
  const c = candles[i];
  if (i === 0) return c.high - c.low;
  const pc = candles[i - 1].close;
  return Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
}

// Wilder RMA (Pine's ta.rma).
function rma(values, period) {
  const n = values.length;
  const out = new Array(n).fill(null);
  if (period < 1 || n < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i += 1) sum += values[i];
  out[period - 1] = sum / period;
  for (let i = period; i < n; i += 1) out[i] = (out[i - 1] * (period - 1) + values[i]) / period;
  return out;
}

// Rolling SMA; a null anywhere in the window yields null (matches Pine's na).
function sma(values, period) {
  const n = values.length;
  const out = new Array(n).fill(null);
  let sum = 0;
  let cnt = 0;
  for (let i = 0; i < n; i += 1) {
    const v = values[i];
    if (v == null) {
      sum = 0;
      cnt = 0;
      continue;
    }
    sum += v;
    cnt += 1;
    if (cnt > period) {
      sum -= values[i - period];
      cnt -= 1;
    }
    if (cnt === period) out[i] = sum / period;
  }
  return out;
}

// The exact SuperTrend recurrence from the Pine script (works on any candles).
function superTrend(candles, factor, pd) {
  const n = candles.length;
  const tr = new Array(n);
  for (let i = 0; i < n; i += 1) tr[i] = trueRange(candles, i);
  const atrArr = rma(tr, pd);

  const up = new Array(n);
  const dn = new Array(n);
  const tUp = new Array(n);
  const tDn = new Array(n);
  const trend = new Array(n);

  for (let i = 0; i < n; i += 1) {
    const a = atrArr[i];
    const hl2 = (candles[i].high + candles[i].low) / 2;
    up[i] = hl2 - factor * a;
    dn[i] = hl2 + factor * a;

    const prevClose = i > 0 ? candles[i - 1].close : null;
    const prevUp = i > 0 ? tUp[i - 1] : null;
    const prevDn = i > 0 ? tDn[i - 1] : null;

    tUp[i] = prevClose != null && prevUp != null && prevClose > prevUp ? Math.max(up[i], prevUp) : up[i];
    tDn[i] = prevClose != null && prevDn != null && prevClose < prevDn ? Math.min(dn[i], prevDn) : dn[i];

    const c = candles[i].close;
    let t;
    if (prevDn != null && c > prevDn) t = 1;
    else if (prevUp != null && c < prevUp) t = -1;
    else t = i > 0 && trend[i - 1] != null ? trend[i - 1] : 1; // nz(Trend[1], 1)
    trend[i] = t;
  }
  return { atr: atrArr, trend };
}

// Re-buckets the 1m series into epoch-aligned `spanMs` candles.
function resample(candles, spanMs) {
  const out = [];
  let cur = null;
  for (const c of candles) {
    const b = Math.floor(c.time / spanMs) * spanMs;
    if (!cur || cur.time !== b) {
      if (cur) out.push(cur);
      cur = { time: b, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
    } else {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      cur.volume += c.volume;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// ---------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------

class SuperTrend2Macd1m {
  constructor() {
    this.name = 'SuperTrend2Macd1m';
    this.description =
      'Super Trend 2 MACD on the 1m chart: a local SuperTrend (2/21) flip, confirmed by a 2h ' +
      'SuperTrend (2/7, last completed bar) and an SMA MACD (12/26/9), enters with a Maker limit ' +
      'and a 500/400-point reduce-only bracket on Delta. An opposite signal reverses the position.';
    this.symbol = 'BTCUSD';

    // --- exchange facts, filled in by the engine (applyProductSettings) ---
    this.tickSize = 0.5;
    this.contractValue = 0.001;
    this.equity = 1200;
    this.riskPercent = 0.005;
    this.maxNotionalEquity = 3;
    this.minContracts = 1;
    this.fixedContracts = 0;
    this.maxConcurrentPositions = 1;

    this.reset();
  }

  getName() {
    return this.name;
  }

  reset() {
    this.lastBarTime = 0; // last closed 1m bar already evaluated
    this.cacheTime = 0; // bar the indicator cache belongs to
    this.localTrend = null;
    this.htfTrendByBucket = null;
    this.macd = null;
    this.signal = null;
    this.signalSide = null; // 'long' | 'short' — the most recent signal
    this.entryDone = false; // whether that signal has already been acted on
    this.lastReason = '';
  }

  // Risk-based size, floored at the exchange minimum. A fixed size (set from the
  // env) bypasses the maths entirely — that is what a tiny account uses.
  sizeContracts(entry, stop) {
    const fixed = Number(this.fixedContracts) || 0;
    if (fixed > 0) return Math.max(1, Math.floor(fixed));

    const dist = Math.abs(Number(entry) - Number(stop));
    if (!(dist > 0)) return Math.max(1, Number(this.minContracts) || 1);

    const equity = Number(this.equity) || 0;
    const riskAmount = equity * (Number(this.riskPercent) || 0);
    const byRisk = Math.floor(riskAmount / (dist * (Number(this.contractValue) || 0.001)));
    const byNotional = Math.floor(
      (equity * (Number(this.maxNotionalEquity) || 0)) / (Number(entry) * (Number(this.contractValue) || 0.001))
    );
    const size = Math.min(byRisk, byNotional);
    return Math.max(Number(this.minContracts) || 1, size);
  }

  // Rounds a price to the product's tick size (BTCUSD = 0.5).
  snap(price) {
    const tick = Number(this.tickSize) || 0;
    if (!(tick > 0)) return Number(price);
    const decimals = (String(tick).split('.')[1] || '').length;
    return Number((Math.round(price / tick) * tick).toFixed(decimals));
  }

  // Rebuilds the local SuperTrend, the 2h trend map and the MACD once per bar.
  computeContext(candles) {
    const n = candles.length;

    this.localTrend = superTrend(candles, P.factor, P.pd).trend;

    const htf = resample(candles, HTF_MS);
    const htfTrend = superTrend(htf, P.htfFactor, P.htfPd).trend;
    const map = new Map();
    for (let j = 0; j < htf.length; j += 1) map.set(htf[j].time, htfTrend[j]);
    this.htfTrendByBucket = map;

    const closes = candles.map((c) => c.close);
    const fastMa = sma(closes, P.macdFast);
    const slowMa = sma(closes, P.macdSlow);
    const macd = new Array(n).fill(null);
    for (let i = 0; i < n; i += 1) {
      if (fastMa[i] != null && slowMa[i] != null) macd[i] = fastMa[i] - slowMa[i];
    }
    this.macd = macd;
    this.signal = sma(macd, P.macdSignal);
    this.cacheTime = candles[n - 1].time;
  }

  // Looks for a fresh flip on the last closed bar. Sets signalSide when the
  // filters line up; returns a human-readable reason either way.
  detectSignal(candles) {
    const i = candles.length - 1;
    if (i < 1) return 'need one prior bar';

    const trend = this.localTrend[i];
    const prevTrend = this.localTrend[i - 1];
    if (trend === prevTrend) return 'no local SuperTrend flip on this bar';

    const flipUp = trend === 1 && prevTrend === -1;
    const flipDown = trend === -1 && prevTrend === 1;

    const m = this.macd[i];
    const s = this.signal[i];
    if (m == null || s == null) return 'MACD not warmed up on this bar';

    const bucketNow = Math.floor(candles[i].time / HTF_MS) * HTF_MS;
    const prevBucket = bucketNow - HTF_MS;
    const mTrend = this.htfTrendByBucket.has(prevBucket) ? this.htfTrendByBucket.get(prevBucket) : 1;

    let side = null;
    if (flipUp && mTrend === 1 && m > s) side = 'long';
    else if (flipDown && mTrend === -1 && m < s) side = 'short';
    if (!side) {
      return `flip ${flipUp ? 'up' : 'down'} filtered out (2h trend ${mTrend}, MACD ${m.toFixed(1)}/${s.toFixed(1)})`;
    }

    this.signalSide = side;
    this.entryDone = false;
    return `fresh ${side} signal`;
  }

  // Places one resting Maker limit with the 500/400 reduce-only bracket.
  buildEntry(side, last) {
    const dir = side === 'long' ? 1 : -1;
    const entry = this.snap(last.close);
    const stop = this.snap(entry - dir * P.slPoints);
    const target = this.snap(entry + dir * P.tpPoints);
    if (!(entry > 0) || !(stop > 0) || !(target > 0)) {
      return { action: 'HOLD', reason: 'stop or target is not a valid price' };
    }

    const quantity = this.sizeContracts(entry, stop);
    if (!(quantity > 0)) return { action: 'HOLD', reason: 'size rounds to zero contracts' };

    this.entryDone = true;

    return {
      action: side === 'long' ? 'BUY' : 'SELL',
      symbol: this.symbol,
      quantity,
      price: entry,
      orderType: 'limit_order', // Maker fill at the signal price
      stopLoss: stop,
      takeProfit: [{ price: target }],
      strategyName: this.name,
      reason:
        `SuperTrend2MACD ${side}: local ST(${P.factor}/${P.pd}) flipped ${dir === 1 ? 'up' : 'down'} with the ` +
        `2h ST(${P.htfFactor}/${P.htfPd}) and MACD agreeing; maker limit ${entry}, ` +
        `SL ${stop} (-${P.slPoints}), TP ${target} (+${P.tpPoints})`,
      meta: {
        exitMode: 'bracket',
        family: 'supertrend2macd-1m',
        riskPoints: P.slPoints,
        rewardPoints: P.tpPoints,
      },
    };
  }

  evaluate(marketData = {}, state = {}) {
    const candles = Array.isArray(marketData.candles1m) ? marketData.candles1m : [];
    if (candles.length < MIN_BARS) {
      return { action: 'HOLD', reason: `warming up (${candles.length}/${MIN_BARS} 1m candles)` };
    }

    const last = candles[candles.length - 1];
    if (!last || !last.time) return { action: 'HOLD', reason: 'no closed 1m candle yet' };

    // One signal decision per closed 1m bar. The decision BELOW still runs on
    // every tick, so a pending close or entry is acted on without waiting a bar.
    if (last.time !== this.lastBarTime) {
      this.computeContext(candles);
      this.lastBarTime = last.time;
      this.lastReason = this.detectSignal(candles);
    }

    const positions = Array.isArray(state.positions) ? state.positions : [];
    const position = positions[0] || null;

    // --- holding a position -------------------------------------------------
    if (position) {
      // An opposite signal is the reverse leg: close at market, re-enter next.
      if (this.signalSide && position.side && position.side !== this.signalSide) {
        return {
          action: 'CLOSE',
          symbol: this.symbol,
          strategyName: this.name,
          reason: `reverse ${position.side} -> ${this.signalSide} (${this.lastReason})`,
        };
      }
      // Otherwise the current signal (if any) is already the side we hold.
      this.entryDone = true;
      return { action: 'HOLD', reason: `holding ${position.side}; ${this.lastReason}` };
    }

    // --- flat ---------------------------------------------------------------
    if (state.hasLiveOrder) return { action: 'HOLD', reason: 'an entry is already resting' };
    if (!this.signalSide) return { action: 'HOLD', reason: this.lastReason || 'no signal yet' };
    if (this.entryDone) return { action: 'HOLD', reason: 'the signal has already been traded' };

    return this.buildEntry(this.signalSide, last);
  }
}

module.exports = new SuperTrend2Macd1m();
