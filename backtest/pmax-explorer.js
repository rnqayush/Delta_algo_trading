// "PMax Explorer" (TradingView Pine v4, KivancOzbilgic) ported as a backtest.
//
// WHAT THE SCRIPT ACTUALLY TRADES
// -------------------------------
// Stripping the screener/label machinery, the order-generating half is three
// lines (Pine src: lines 81-108, 142-145):
//
//   MAvg      = getMA(hl2, length)                 // default EMA(10) of hl2
//   atr       = atr(Periods)                        // default RMA of TR, 10
//   PMax      = ratchet of  MAvg +/- Multiplier*atr // default x3, the plotted line
//   buy       = crossover(MAvg, PMax)
//   sell      = crossunder(MAvg, PMax)
//   strategy.entry("Long"/"Short")                  // market, no stop, no target
//
// So it is a SuperTrend-family ALWAYS-IN reversal: the "PMax" line is a
// ratcheting stop built on the MA (not on price); the MA crossing that line
// flips the side. There is no take-profit, no stop and no close call — the next
// opposite cross is the only exit. The second `Pmax()` function in the source
// (line 166) feeds only the multi-symbol screener labels; it carries no signal.
//
// HOW THIS SIMULATION EXECUTES IT
// -------------------------------
// Non-repainting, one position at a time, no look-ahead:
//   * signals are read off CLOSED bars only (MAvg/PMax of bar i);
//   * entries/exits fill at that bar's close, which is what a bot polling the
//     closed candle can actually get;
//   * flat -> enter; holding the opposite side -> close at the close and take
//     the reverse leg on the same bar (the always-in flip);
//   * R is the entry-to-PMax distance (the line IS the stop), so avgR reads in
//     units of "how far the flip level sat from the fill".
//
//   node backtest/pmax-explorer.js
//   node backtest/pmax-explorer.js --tf 5m --symbols BTCUSD,ETHUSD,AINUSD --days 60
//   node backtest/pmax-explorer.js --tf 15m --mult 2 --atr 10 --len 10
//   node backtest/pmax-explorer.js --tf 15m --free      # pure signal edge, no costs
//
// Options:
//   --symbols  comma-separated (default TRADING_SYMBOL or BTCUSD)
//   --tf       candle resolution, default 1m
//   --days     look-back window in days, default 30
//   --mult     ATR multiplier (the "x"), default 3
//   --atr      ATR period, default 10
//   --len      moving-average length, default 10
//   --mav      SMA | EMA | WMA, default EMA
//   --fee      taker fee in bps per leg, default 5
//   --slip     slippage in bps per leg, default 2
//   --free     ignore fees and slippage entirely
//   --invert   trade the FADE of the signal (always-in, so this is an exact
//              sign-flip of the gross return: long where PMax says short)

'use strict';

const { downloadCandles, RESOLUTION_SECONDS } = require('./lib/data');

const DEFAULTS = {
  tf: '1m',
  days: 30,
  mult: 3.0,
  atr: 10,
  len: 10,
  mav: 'EMA',
  fee: 5,
  slip: 2,
  free: false,
};

const SUPPORTED_MAV = ['SMA', 'EMA', 'WMA'];

// ---------------------------------------------------------------------------
// Indicators (identical maths to the Pine source)
// ---------------------------------------------------------------------------

// Pine's ta.rma / SMMA: SMA seed at index len-1, then (v[1]*(len-1)+src)/len.
function rma(values, len) {
  const n = values.length;
  const out = new Array(n).fill(null);
  if (n < len) return out;

  let sum = 0;
  for (let i = 0; i < len; i += 1) sum += values[i];
  out[len - 1] = sum / len;

  for (let i = len; i < n; i += 1) out[i] = (out[i - 1] * (len - 1) + values[i]) / len;
  return out;
}

// ta.atr(len): RMA of true range.
function atrSeries(candles, len) {
  const tr = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const pc = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
  });
  return rma(tr, len);
}

// ta.sma / ta.ema / ta.wma. EMA is SMA-seeded (Pine's convention, and the one
// the sibling backtests in this folder use).
function smaSeries(values, len) {
  const n = values.length;
  const out = new Array(n).fill(null);
  if (n < len) return out;
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    sum += values[i];
    if (i >= len) sum -= values[i - len];
    if (i >= len - 1) out[i] = sum / len;
  }
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

function wmaSeries(values, len) {
  const n = values.length;
  const out = new Array(n).fill(null);
  if (n < len) return out;
  const denom = (len * (len + 1)) / 2;
  for (let i = len - 1; i < n; i += 1) {
    let acc = 0;
    for (let j = 0; j < len; j += 1) acc += values[i - j] * (len - j);
    out[i] = acc / denom;
  }
  return out;
}

function maSeries(values, len, type) {
  if (type === 'SMA') return smaSeries(values, len);
  if (type === 'WMA') return wmaSeries(values, len);
  return emaSeries(values, len); // EMA (default)
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

// Replays the PMax ratchet + always-in flip over one candle series.
function simulate(candles, opts) {
  const { mult, atrLen, maLen, mavType, costPerTrade, invert } = opts;
  const n = candles.length;
  const hl2 = candles.map((c) => (c.high + c.low) / 2);
  const atr = atrSeries(candles, atrLen);
  const ma = maSeries(hl2, maLen, mavType);

  const warmup = Math.max(atrLen + maLen + 2, 15);
  const trades = [];
  let triggers = 0;

  // Ratchet state. `longStopPrev`/`shortStopPrev` are nz(x[1], x-at-first-bar).
  let longStopPrev = null;
  let shortStopPrev = null;
  let dir = 1;
  let prevMA = null;
  let prevPMax = null;

  let pos = null;

  const enter = (side, price, line, index) => {
    const riskFrac = Math.abs(price - line) / price;
    pos = { side, entry: price, stop: line, entryIndex: index, riskFrac };
  };

  const closeTrade = (price, index, reason) => {
    const d = pos.side === 'long' ? 1 : -1;
    const gross = (d * (price - pos.entry)) / pos.entry;
    trades.push({
      side: pos.side,
      entry: pos.entry,
      exit: price,
      gross,
      net: gross - costPerTrade,
      r: pos.riskFrac > 0 ? gross / pos.riskFrac : 0,
      bars: index - pos.entryIndex,
      reason,
      time: candles[index].time,
    });
    pos = null;
  };

  for (let i = warmup; i < n; i += 1) {
    const m = ma[i];
    const a = atr[i];
    if (m == null || !(a > 0)) continue;

    // --- 1. long / short ratchet, exactly as the Pine iff-chain -----------
    let longStop = m - mult * a;
    const lsp = longStopPrev == null ? longStop : longStopPrev;
    longStop = m > lsp ? Math.max(longStop, lsp) : longStop;

    let shortStop = m + mult * a;
    const ssp = shortStopPrev == null ? shortStop : shortStopPrev;
    shortStop = m < ssp ? Math.min(shortStop, ssp) : shortStop;

    // --- 2. direction flip against the PREVIOUS stops ---------------------
    if (dir === -1 && m > ssp) dir = 1;
    else if (dir === 1 && m < lsp) dir = -1;

    const pMax = dir === 1 ? longStop : shortStop;

    // --- 3. buy / sell on the MA-vs-PMax crossover ------------------------
    let buy = false;
    let sell = false;
    if (prevMA != null && prevPMax != null) {
      buy = prevMA <= prevPMax && m > pMax;
      sell = prevMA >= prevPMax && m < pMax;
    }
    // The fade: an always-in system is fully determined by the side it holds,
    // so swapping the two triggers negates the gross return outright.
    if (invert) {
      const tmp = buy;
      buy = sell;
      sell = tmp;
    }
    if (buy || sell) triggers += 1;

    // --- 4. act: flat -> enter, holding the other side -> flip ------------
    if (!pos) {
      if (buy) enter('long', candles[i].close, pMax, i);
      else if (sell) enter('short', candles[i].close, pMax, i);
    } else if (pos.side === 'long' && sell) {
      closeTrade(candles[i].close, i, 'flip');
      enter('short', candles[i].close, pMax, i);
    } else if (pos.side === 'short' && buy) {
      closeTrade(candles[i].close, i, 'flip');
      enter('long', candles[i].close, pMax, i);
    }

    // --- 5. carry the ratchet and the cross reference forward -------------
    longStopPrev = longStop;
    shortStopPrev = shortStop;
    prevMA = m;
    prevPMax = pMax;
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
    avgR: sum((t) => t.r) / n,
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

  const mavType = (args.mav ? String(args.mav) : DEFAULTS.mav).toUpperCase();
  if (!SUPPORTED_MAV.includes(mavType)) {
    console.error(`Unsupported --mav "${mavType}". Use one of: ${SUPPORTED_MAV.join(', ')}`);
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
    mult: args.mult !== undefined ? Number(args.mult) : DEFAULTS.mult,
    atrLen: Number(args.atr) || DEFAULTS.atr,
    maLen: Number(args.len) || DEFAULTS.len,
    mavType,
    costPerTrade,
    invert: Boolean(args.invert),
  };

  console.log(`\nPMax Explorer (MA x ATR-ratchet reversal) — ${tf} bars, last ${days}d`);
  console.log('='.repeat(96));
  console.log(`model   MAvg=${mavType}(${opts.maLen}) of hl2, PMax ratchet = MAvg +/- ${opts.mult} x ATR(${opts.atrLen}), MA-vs-PMax cross, always-in flip${opts.invert ? '  [FADE: signals inverted]' : ''}`);
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
      if (candles.length < opts.atrLen + opts.maLen + 50) {
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
      `${pad('trades', 6, true)} | ${pad('/day', 6, true)} | ${pad('win%', 5, true)} | ${pad('avgR', 5, true)} | ` +
      `${pad('hold', 6, true)} | ${pad('PF', 5, true)} | ${pad('gross%/d', 8, true)} | ${pad('cost%/d', 8, true)} | ` +
      `${pad('net%/d', 7, true)} | ${pad('maxDD%', 7, true)}`
  );
  console.log('-'.repeat(120));

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
        `${pad(signed(r.avgR, 2), 5, true)} | ${pad(fmt(r.avgHold, 0), 6, true)} | ` +
        `${pad(fmt(r.profitFactor, 2), 5, true)} | ${pad(signed(r.grossPerDay, 2), 8, true)} | ` +
        `${pad(fmt(r.costPerDay, 2), 8, true)} | ${pad(signed(r.netPerDay, 2), 7, true)} | ` +
        `${pad(fmt(r.maxDD, 1), 7, true)}`
    );
  });

  console.log(
    '\ntrigs = raw buy/sell crosses, trades = those actually taken (one position at a time),\n' +
      'avgR = mean return in units of the entry-to-PMax distance (1R = how far the flip line sat),\n' +
      'PF = gross wins / gross losses, net%/d = what is left after costs.'
  );
  console.log(
    '\nNote: this is an ALWAYS-IN system. It is never flat by choice, so long stretches of chop are\n' +
      'paid for in flips; the ratchet is the only thing that decides the side.\n'
  );
}

main().catch((error) => {
  console.error('BACKTEST FAILED:', error.message);
  process.exit(1);
});
