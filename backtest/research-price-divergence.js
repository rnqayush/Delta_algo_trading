// Backtest of the "[STRATEGY][UL] Price Divergence Strategy v1.1" (JustUncleL,
// Pine v4, 2016) ported to Delta Exchange candles.
//
// What the original does:
//
//   1) Oscillator series (`method`, default 1 = MACD)
//        method 0 = rsi(high, s)  / rsi(low, s)          <- high vs low differ
//        method 1 = macd histogram (default)             <- SAME series both sides
//        method 2 = stoch(close, high, low, s)           <- SAME series both sides
//        method 3 = sma(volume, s)                       <- SAME series both sides
//        method 4 = accdist(s)                           <- SAME series both sides
//        method 5 = fisher(high, s) / fisher(low, s)     <- high vs low differ
//        method 6 = cci(high, s) / cci(low, s)           <- high vs low differ
//      `f_macd` here is sma(src,fast) - sma(src,slow), signal = ema(that, smooth).
//
//   2) 5-bar fractal on those series  (the pivot is the middle bar = [2])
//        top  : src[4] < src[2] and src[3] < src[2] and src[2] > src[1] and src[2] > src[0]
//        bot  : src[4] > src[2] and src[3] > src[2] and src[2] < src[1] and src[2] < src[0]
//
//   3) Divergence vs the PREVIOUS fractal (valuewhen(..., occurrence = 1)):
//        regular bearish : top fractal, high[2]  > prevHigh  and osc[2] < prevOsc
//        hidden  bearish : top fractal, high[2]  < prevHigh  and osc[2] > prevOsc
//        regular bullish : bot fractal, low[2]   < prevLow   and osc[2] > prevOsc
//        hidden  bullish : bot fractal, low[2]   > prevLow   and osc[2] < prevOsc
//
//   4) "Murrey's Math" channel gate (UCS_MMLO), length 100, quad = 2:
//        hi = highest(high,100), lo = lowest(low,100), range = hi - lo
//        midline = lo + range/2
//        oscillator = (close - midline) / (range/2)      // -1 at lo, +1 at hi
//        a/b/c/d = osc > 0 / 0.25 / 0.5 / 0.75   (long quadrants)
//        z/y/x/w = osc < 0 / -0.25 / -0.5 / -0.75 (short quadrants)
//        quad 2 -> long needs b[1], short needs y[1]
//
//   5) Entries:  long  = bullishDiv (regular or hidden) and quad gate
//                short = bearishDiv (regular or hidden) and quad gate
//      Exits  :  long  closes when oscillator <= 0
//                short closes when oscillator >= 0
//
// Not modelled (called out so the numbers are honest):
//   * `strategy.exit(..., trail_points=100, trail_offset=0)`. trail_offset
//     resolves to `na` (the input is 0), so Pine never places the trailing
//     order. The only live exits are the two `strategy.close` calls above.
//     take-profit / stop-loss are likewise 0 -> disabled.
//   * signals read the last CLOSED bar, fills at that close; taker 5 bps +
//     2 bps slippage per leg.
//   * sizing mirrors the script default: percent_of_equity 10.
//
// A REVERSED variant (entries and exits mirrored) is also reported.
//
//   node backtest/research-price-divergence.js
//   node backtest/research-price-divergence.js --tf 15m --days 7
//   node backtest/research-price-divergence.js --method 0

'use strict';

const { loadCache } = require('./lib/data');

const ALL_SYMBOLS = ['BTCUSD', 'ETHUSD', 'SOLUSD', 'XRPUSD', 'DOGEUSD'];
const RES_SEC = { '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600 };

const CFG = {
  initialEquity: 1200,
  notionalPct: 10, // strategy(... default_qty_type=percent_of_equity, default_qty_value=10)
  feeTaker: 0.0005, // 5 bps
  slippage: 0.0002, // 2 bps
};

const STRAT = {
  method: 1, // 0 rsi, 1 macd (default), 2 stoch, 3 volume, 4 acc/dist, 5 fisher, 6 cci
  smooth: 5, // rsi_smooth
  macdFast: 12,
  macdSlow: 26,
  macdSmooth: 9,
  useRegular: true,
  useHidden: true,
  mmloLen: 100,
  mmloMult: 0.125,
  quad: 2,
};

// ---------------------------------------------------------------------------
// indicators
// ---------------------------------------------------------------------------

function sma(values, len) {
  const n = values.length;
  const out = new Array(n).fill(null);
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    sum += values[i];
    if (i >= len) sum -= values[i - len];
    if (i >= len - 1) out[i] = sum / len;
  }
  return out;
}

function ema(values, len) {
  const n = values.length;
  const out = new Array(n).fill(null);
  if (n < len) return out;
  let sum = 0;
  for (let i = 0; i < len; i += 1) sum += values[i];
  out[len - 1] = sum / len;
  const k = 2 / (len + 1);
  for (let i = len; i < n; i += 1) out[i] = values[i] * k + out[i - 1] * (1 - k);
  return out;
}

// Pine ta.rsi (Wilder).
function rsi(src, len) {
  const n = src.length;
  const out = new Array(n).fill(null);
  if (n <= len) return out;
  let ag = 0;
  let al = 0;
  for (let i = 1; i <= len; i += 1) {
    const d = src[i] - src[i - 1];
    if (d >= 0) ag += d;
    else al -= d;
  }
  ag /= len;
  al /= len;
  out[len] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = len + 1; i < n; i += 1) {
    const d = src[i] - src[i - 1];
    ag = (ag * (len - 1) + Math.max(d, 0)) / len;
    al = (al * (len - 1) + Math.max(-d, 0)) / len;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}

function rolling(values, len, fn) {
  const n = values.length;
  const out = new Array(n).fill(null);
  for (let i = len - 1; i < n; i += 1) {
    let acc = values[i - len + 1];
    for (let j = i - len + 2; j <= i; j += 1) acc = fn(acc, values[j]);
    out[i] = acc;
  }
  return out;
}

const highest = (v, len) => rolling(v, len, Math.max);
const lowest = (v, len) => rolling(v, len, Math.min);

// f_macd: sma fast, sma slow, ema signal, return the histogram.
function macdHist(src, fast, slow, smooth) {
  const f = sma(src, fast);
  const s = sma(src, slow);
  const macd = src.map((_, i) => (f[i] == null || s[i] == null ? null : f[i] - s[i]));
  const valid = macd.map((v) => (v == null ? 0 : v));
  const sig = ema(valid, smooth);
  return macd.map((v, i) => (v == null || sig[i] == null ? null : v - sig[i]));
}

function stoch(src, high, low, len) {
  const hh = highest(high, len);
  const ll = lowest(low, len);
  return src.map((v, i) => {
    if (hh[i] == null || ll[i] == null || hh[i] === ll[i]) return null;
    return (100 * (v - ll[i])) / (hh[i] - ll[i]);
  });
}

function cci(src, len) {
  const m = sma(src, len);
  const n = src.length;
  const out = new Array(n).fill(null);
  for (let i = len - 1; i < n; i += 1) {
    let d = 0;
    for (let j = i - len + 1; j <= i; j += 1) d += Math.abs(src[j] - m[i]);
    const dev = d / len;
    out[i] = dev === 0 ? 0 : (src[i] - m[i]) / (0.015 * dev);
  }
  return out;
}

// f_accdist: sma(cum(...), smooth)
function accdist(candles, smooth) {
  const n = candles.length;
  const raw = new Array(n).fill(0);
  let cum = 0;
  const out = new Array(n).fill(null);
  for (let i = 0; i < n; i += 1) {
    const { high, low, close, volume } = candles[i];
    const flat = (close === high && close === low) || high === low;
    const v = flat ? 0 : ((2 * close - low - high) / (high - low)) * volume;
    cum += v;
    raw[i] = cum;
  }
  const s = sma(raw, smooth);
  for (let i = 0; i < n; i += 1) out[i] = s[i];
  return out;
}

// f_fisher
function fisher(src, window) {
  const n = src.length;
  const hh = highest(src, window);
  const ll = lowest(src, window);
  const out = new Array(n).fill(null);
  let value0 = 0;
  let fish = 0;
  for (let i = 0; i < n; i += 1) {
    if (hh[i] == null || ll[i] == null) continue;
    value0 = 0.66 * ((src[i] - ll[i]) / Math.max(hh[i] - ll[i], 0.001) - 0.5) + 0.67 * value0;
    const v1 = value0 > 0.99 ? 0.999 : value0 < -0.99 ? -0.999 : value0;
    fish = 0.5 * Math.log((1 + v1) / Math.max(1 - v1, 0.001)) + 0.5 * fish;
    out[i] = fish;
  }
  return out;
}

// The `method` selector — returns { high, low } oscillator series.
function oscillatorSeries(candles) {
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume || 0);
  const s = STRAT.smooth;
  switch (STRAT.method) {
    case 0: return { high: rsi(highs, s), low: rsi(lows, s) };
    case 1: {
      const m = macdHist(closes, STRAT.macdFast, STRAT.macdSlow, STRAT.macdSmooth);
      return { high: m, low: m };
    }
    case 2: {
      const st = stoch(closes, highs, lows, s);
      return { high: st, low: st };
    }
    case 3: {
      const v = sma(volumes, s);
      return { high: v, low: v };
    }
    case 4: {
      const a = accdist(candles, s);
      return { high: a, low: a };
    }
    case 5: return { high: fisher(highs, s), low: fisher(lows, s) };
    case 6: return { high: cci(highs, s), low: cci(lows, s) };
    default: throw new Error(`unknown method ${STRAT.method}`);
  }
}

// ---------------------------------------------------------------------------
// divergence signals
// ---------------------------------------------------------------------------

function topFractal(src) {
  const n = src.length;
  const out = new Array(n).fill(false);
  for (let i = 4; i < n; i += 1) {
    if (src[i - 4] == null || src[i - 2] == null) continue;
    out[i] = src[i - 4] < src[i - 2] && src[i - 3] < src[i - 2] && src[i - 2] > src[i - 1] && src[i - 2] > src[i];
  }
  return out;
}

function botFractal(src) {
  const n = src.length;
  const out = new Array(n).fill(false);
  for (let i = 4; i < n; i += 1) {
    if (src[i - 4] == null || src[i - 2] == null) continue;
    out[i] = src[i - 4] > src[i - 2] && src[i - 3] > src[i - 2] && src[i - 2] < src[i - 1] && src[i - 2] < src[i];
  }
  return out;
}

// valuewhen(cond, src, 1) — the value of `src` at the 2nd most recent bar where
// `cond` was true. `srca[j]` must already be the value carried at bar j.
function valuewhenPrev(cond, srca) {
  const n = cond.length;
  const out = new Array(n).fill(null);
  const idx = [];
  for (let i = 0; i < n; i += 1) {
    if (cond[i]) idx.push(i);
    if (idx.length >= 2) out[i] = srca[idx[idx.length - 2]];
  }
  return out;
}

function signals(candles) {
  const n = candles.length;
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const closes = candles.map((c) => c.close);
  const osc = oscillatorSeries(candles);

  const isTop = topFractal(osc.high);
  const isBot = botFractal(osc.low);

  // method_high[2] / method_low[2] carries
  const mh2 = new Array(n).fill(null);
  const ml2 = new Array(n).fill(null);
  for (let i = 2; i < n; i += 1) {
    mh2[i] = osc.high[i - 2];
    ml2[i] = osc.low[i - 2];
  }

  const highPrice = valuewhenPrev(isTop, highs.slice(0, n).map((_, i) => (i >= 2 ? highs[i - 2] : null)));
  const lowPrice = valuewhenPrev(isBot, lows.map((_, i) => (i >= 2 ? lows[i - 2] : null)));
  const highPrev = valuewhenPrev(isTop, mh2);
  const lowPrev = valuewhenPrev(isBot, ml2);

  const regBear = new Array(n).fill(false);
  const hidBear = new Array(n).fill(false);
  const regBull = new Array(n).fill(false);
  const hidBull = new Array(n).fill(false);

  for (let i = 2; i < n; i += 1) {
    if (isTop[i] && highPrice[i] != null && highPrev[i] != null && highs[i - 2] != null) {
      regBear[i] = highs[i - 2] > highPrice[i] && mh2[i] < highPrev[i];
      hidBear[i] = highs[i - 2] < highPrice[i] && mh2[i] > highPrev[i];
    }
    if (isBot[i] && lowPrice[i] != null && lowPrev[i] != null && lows[i - 2] != null) {
      regBull[i] = lows[i - 2] < lowPrice[i] && ml2[i] > lowPrev[i];
      hidBull[i] = lows[i - 2] > lowPrice[i] && ml2[i] < lowPrev[i];
    }
  }

  // ---- Murrey's Math oscillator (UCS_MMLO) ------------------------------
  const hh = highest(highs, STRAT.mmloLen);
  const ll = lowest(lows, STRAT.mmloLen);
  const oscMM = new Array(n).fill(null);
  for (let i = 0; i < n; i += 1) {
    if (hh[i] == null || ll[i] == null) continue;
    const range = hh[i] - ll[i];
    if (!(range > 0)) continue;
    const midline = ll[i] + range * 0.5;
    oscMM[i] = (closes[i] - midline) / (range / 2);
  }

  const upGate = new Array(n).fill(false); // long quadrant >= quad level
  const dnGate = new Array(n).fill(false);
  const lvl = STRAT.mmloMult * (STRAT.quad * 2);
  for (let i = 0; i < n; i += 1) {
    if (oscMM[i] == null) continue;
    upGate[i] = oscMM[i] > 0 && oscMM[i] > lvl;
    dnGate[i] = oscMM[i] < 0 && oscMM[i] < -lvl;
  }

  const enterLong = new Array(n).fill(false);
  const enterShort = new Array(n).fill(false);
  for (let i = 1; i < n; i += 1) {
    const bullDiv = (STRAT.useRegular && regBull[i]) || (STRAT.useHidden && hidBull[i]);
    const bearDiv = (STRAT.useRegular && regBear[i]) || (STRAT.useHidden && hidBear[i]);
    enterLong[i] = bullDiv && upGate[i - 1];
    enterShort[i] = bearDiv && dnGate[i - 1];
  }

  return { oscMM, enterLong, enterShort, regBull, regBear, hidBull, hidBear, isTop, isBot };
}

// ---------------------------------------------------------------------------
// simulation
// ---------------------------------------------------------------------------

function simulate(candles, sg, barSec, reverse) {
  const n = candles.length;
  const notional = (CFG.initialEquity * CFG.notionalPct) / 100;
  const trades = [];
  let pos = null;

  const closePos = (bar, reason) => {
    pos.exitRaw = bar.close;
    pos.exitTime = bar.time;
    pos.exitReason = reason;
    trades.push(pos);
    pos = null;
  };

  for (let i = 1; i < n; i += 1) {
    const bar = candles[i];

    // exits: long closes when the oscillator is <= 0, short when >= 0
    if (pos) {
      const origSide = reverse ? (pos.side === 'long' ? 'short' : 'long') : pos.side;
      const o = sg.oscMM[i];
      const hit = o != null && (origSide === 'long' ? o <= 0 : o >= 0);
      if (hit) closePos(bar, 'osc');
    }

    // entries
    let wantLong = sg.enterLong[i];
    let wantShort = sg.enterShort[i];
    if (reverse) {
      const t = wantLong;
      wantLong = wantShort;
      wantShort = t;
    }
    if (wantLong && (!pos || pos.side !== 'long')) {
      if (pos) closePos(bar, 'flip');
      pos = { side: 'long', dir: 1, entryRaw: bar.close, entryTime: bar.time };
    } else if (wantShort && (!pos || pos.side !== 'short')) {
      if (pos) closePos(bar, 'flip');
      pos = { side: 'short', dir: -1, entryRaw: bar.close, entryTime: bar.time };
    }
  }
  if (pos) closePos(candles[n - 1], 'open');

  for (const t of trades) {
    const qty = notional / t.entryRaw;
    const entryFill = t.entryRaw * (1 + t.dir * CFG.slippage);
    const exitFill = t.exitRaw * (1 - t.dir * CFG.slippage);
    t.entry = t.entryRaw;
    t.exit = t.exitRaw;
    t.gross = qty * (t.exitRaw - t.entryRaw) * t.dir;
    t.fees = notional * CFG.feeTaker * 2;
    t.net = qty * (exitFill - entryFill) * t.dir - t.fees;
    t.pct = (t.dir * (t.exitRaw - t.entryRaw)) / t.entryRaw;
    t.day = new Date(t.exitTime * 1000).toISOString().slice(0, 10);
    t.bars = (t.exitTime - t.entryTime) / barSec;
    t.notional = notional;
  }
  return trades;
}

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------

function metrics(trades) {
  const n = trades.length;
  const sum = (f) => trades.reduce((s, t) => s + f(t), 0);
  const wins = trades.filter((t) => t.net > 0).length;
  const gp = trades.reduce((s, t) => s + (t.net > 0 ? t.net : 0), 0);
  const gl = Math.abs(trades.reduce((s, t) => s + (t.net <= 0 ? t.net : 0), 0));

  const ordered = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  let eq = 0;
  let peak = 0;
  let maxDd = 0;
  for (const t of ordered) {
    eq += t.net;
    if (eq > peak) peak = eq;
    maxDd = Math.min(maxDd, eq - peak);
  }

  const byDay = new Map();
  for (const t of trades) byDay.set(t.day, (byDay.get(t.day) || 0) + t.net);

  return {
    n,
    gross: sum((t) => t.gross),
    net: sum((t) => t.net),
    costs: sum((t) => t.fees),
    long: trades.filter((t) => t.side === 'long').length,
    short: trades.filter((t) => t.side === 'short').length,
    winPct: n ? (wins / n) * 100 : 0,
    pf: gl > 0 ? gp / gl : gp > 0 ? Infinity : 0,
    avgPct: n ? (sum((t) => t.pct) / n) * 100 : 0,
    avgBars: n ? sum((t) => t.bars) / n : 0,
    maxDd,
    byDay,
    greenDays: [...byDay.values()].filter((v) => v > 0).length,
    days: byDay.size,
  };
}

const f2 = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;
const pct = (v) => `${v.toFixed(1)}%`;
const pf = (v) => (v === Infinity ? 'inf' : v.toFixed(2));

function line(label, m, days) {
  console.log(
    `  ${label.padEnd(20)} trades ${String(m.n).padStart(4)} (${(m.n / days).toFixed(1)}/day)  ` +
      `L/S ${m.long}/${m.short}  win% ${pct(m.winPct).padStart(6)}  PF ${pf(m.pf).padStart(5)}  ` +
      `avg move ${m.avgPct >= 0 ? '+' : ''}${m.avgPct.toFixed(3)}%  ` +
      `net $${f2(m.net).padStart(8)} (${((m.net / CFG.initialEquity) * 100).toFixed(2)}%)  ` +
      `maxDD $${f2(m.maxDd)}  hold ${m.avgBars.toFixed(0)} bars  green ${m.greenDays}/${m.days}`,
  );
}

function lastNDays(trades, days) {
  const allDays = [...new Set(trades.map((t) => t.day))].sort();
  const window = new Set(allDays.slice(-days));
  return trades.filter((t) => window.has(t.day));
}

function printDaily(trades) {
  const byDay = new Map();
  for (const t of trades) {
    const d = byDay.get(t.day) || { n: 0, w: 0, net: 0, gross: 0 };
    d.n += 1;
    if (t.net > 0) d.w += 1;
    d.net += t.net;
    d.gross += t.gross;
    byDay.set(t.day, d);
  }
  console.log('  date         trades  wins     gross($)      net($)     cum($)');
  let cum = 0;
  for (const [d, x] of [...byDay.entries()].sort()) {
    cum += x.net;
    console.log(
      `  ${d}  ${String(x.n).padStart(5)}  ${String(x.w).padStart(4)}  ${f2(x.gross).padStart(10)}  ${f2(x.net).padStart(10)}  ${f2(cum).padStart(10)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const a = { days: 7, symbols: ALL_SYMBOLS, tf: '1m', method: null };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--days') a.days = Number(argv[++i]);
    else if (argv[i] === '--symbols') a.symbols = String(argv[++i]).split(',').map((s) => s.trim().toUpperCase());
    else if (argv[i] === '--tf') a.tf = String(argv[++i]);
    else if (argv[i] === '--method') a.method = Number(argv[++i]);
  }
  return a;
}

const METHOD_NAMES = ['rsi', 'macd', 'stoch', 'volume', 'acc/dist', 'fisher', 'cci'];

function main() {
  const args = parseArgs(process.argv);
  if (args.method != null) STRAT.method = args.method;
  const barSec = RES_SEC[args.tf];
  if (!barSec) throw new Error(`unknown --tf ${args.tf}`);

  const data = new Map();
  for (const sym of args.symbols) {
    const cached = loadCache(sym, args.tf);
    if (!cached || !cached.candles || !cached.candles.length) {
      console.log(`  ${sym}: no ${args.tf} cache`);
      continue;
    }
    data.set(sym, cached.candles);
  }
  if (!data.size) throw new Error('no data');

  const first = [...data.values()][0];
  const primary = data.has('BTCUSD') ? 'BTCUSD' : [...data.keys()][0];

  console.log('='.repeat(118));
  console.log(' [STRATEGY][UL] Price Divergence v1.1 (JustUncleL) — backtest on Delta Exchange');
  console.log(` method ${STRAT.method} (${METHOD_NAMES[STRAT.method]}), smooth ${STRAT.smooth}, ` +
    `MMLO len ${STRAT.mmloLen} quad ${STRAT.quad}   divergences: regular ${STRAT.useRegular}, hidden ${STRAT.useHidden}`);
  console.log(` ${args.tf} bars   data ${new Date(first[0].time * 1000).toISOString().slice(0, 16)} -> ` +
    `${new Date(first[first.length - 1].time * 1000).toISOString().slice(0, 16)} UTC   report window = last ${args.days} calendar days`);
  console.log(` sizing percent_of_equity ${CFG.notionalPct}% of $${CFG.initialEquity} = $${(CFG.initialEquity * CFG.notionalPct) / 100} notional   ` +
    `costs taker ${(CFG.feeTaker * 1e4).toFixed(1)}bps + slip ${(CFG.slippage * 1e4).toFixed(1)}bps per leg`);
  console.log('  exit = oscillator crosses 0 (strategy.close); the 100-pt trailing stop is inert (trail_offset = 0 -> na)');
  console.log('='.repeat(118));

  const sgP = signals(data.get(primary));
  console.log(`\n${primary} raw divergence signals in cached data: ` +
    `regBull ${sgP.regBull.filter(Boolean).length}, hidBull ${sgP.hidBull.filter(Boolean).length}, ` +
    `regBear ${sgP.regBear.filter(Boolean).length}, hidBear ${sgP.hidBear.filter(Boolean).length}`);

  const agg = { normal: { net: 0, n: 0 }, rev: { net: 0, n: 0 } };

  console.log(`\n\n################  ${args.tf} — NORMAL vs REVERSED — LAST ${args.days} DAYS  ################`);
  for (const [sym, candles] of data) {
    const sg = signals(candles);
    const nat = lastNDays(simulate(candles, sg, barSec, false), args.days);
    const rev = lastNDays(simulate(candles, sg, barSec, true), args.days);
    const mn = metrics(nat);
    const mr = metrics(rev);
    agg.normal.net += mn.net; agg.normal.n += mn.n;
    agg.rev.net += mr.net; agg.rev.n += mr.n;
    console.log('');
    if (!nat.length) console.log(`  ${sym.padEnd(20)} no trades`);
    else line(`${sym} normal`, mn, args.days);
    if (rev.length) line(`${sym} REVERSED`, mr, args.days);
  }

  const candlesP = data.get(primary);
  for (const [tag, rev] of [['NORMAL', false], ['REVERSED', true]]) {
    const t = lastNDays(simulate(candlesP, signals(candlesP), barSec, rev), args.days);
    console.log(`\n\n--- ${primary} ${args.tf} — ${tag} — daily (last ${args.days} days) ---`);
    if (!t.length) {
      console.log('  no trades');
      continue;
    }
    line('TOTAL', metrics(t), args.days);
    printDaily(t);
  }

  console.log('\n\n################  SUMMARY  ################');
  const eq = CFG.initialEquity * data.size;
  console.log(
    `  NORMAL    ${String(agg.normal.n).padStart(5)} trades  net $${f2(agg.normal.net).padStart(9)}  (${((agg.normal.net / eq) * 100).toFixed(2)}% of $${eq})`,
  );
  console.log(
    `  REVERSED  ${String(agg.rev.n).padStart(5)} trades  net $${f2(agg.rev.net).padStart(9)}  (${((agg.rev.net / eq) * 100).toFixed(2)}% of $${eq})`,
  );
  console.log('');
}

if (require.main === module) main();

module.exports = { signals, simulate, metrics, CFG, STRAT };
