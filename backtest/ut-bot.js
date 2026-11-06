// "UT Bot Alerts" (TradingView Pine v4, QuantNomad) ported as a backtest.
//
// WHAT THE SCRIPT ACTUALLY IS
// ---------------------------
// Despite the "Alerts" name it is not a filter you bolt onto another system —
// it is a complete always-in ATR trailing-stop reversal system. Line by line:
//
//   nLoss = a * atr(c)            a = "Key Value" (sensitivity), c = ATR period
//   xATRTrailingStop              a ratchet: it only tightens while price keeps
//                                 closing on the same side of it
//   ema = ema(src, 1)             an EMA of length 1 IS the close, so
//   above = crossover(ema, trail) == close crossing up through the ratchet
//   buy   = close > trail && above
//   sell  = close < trail && below
//
// So `buy`/`sell` are nothing more than "the close crossed the ATR trailing
// stop". There is no trend filter, no session filter, no volume filter and no
// take-profit: the entry trigger and the stop are the SAME line, and the
// opposite cross is the only exit. `pos`/`xcolor` only colour the bars; they
// carry no signal. `h` (Heikin Ashi) is off by default and is not modelled
// here, because the HA feed is an artifact of the chart, not of the exchange.
//
// Because `nz(trail[1], 0)` seeds the ratchet at 0, the very first scored bar
// always lands in the "src > trail" branch and places the stop at src - nLoss.
// Nothing else about the warm-up is special.
//
// HOW THIS SIMULATION EXECUTES IT
// -------------------------------
// Non-repainting, one position at a time, no look-ahead:
//   * signals are read off CLOSED bars only (src = close of bar i);
//   * the stop that is live DURING bar i is the trail produced at the end of
//     bar i-1 — the only value a real bot could have resting on the exchange;
//   * a bar that trades through that stop exits at the stop (the bar's open if
//     it gapped past it), which is what a resting stop_market_order would get;
//   * an opposite signal at a bar's close flips the position at that close.
//
// The result is the honest reading of a trailing-stop system: entries are not
// "buy the cross and hold to a target", they are "get stopped out, then flip".
//
//   node backtest/ut-bot.js
//   node backtest/ut-bot.js --tf 15m --symbols BTCUSD,ETHUSD,AINUSD --days 60
//   node backtest/ut-bot.js --tf 15m --a 2 --atr 10
//   node backtest/ut-bot.js --tf 15m --free      # pure signal edge, no costs
//
// Options:
//   --symbols  comma-separated (default TRADING_SYMBOL or BTCUSD)
//   --tf       candle resolution, default 15m
//   --days     look-back window in days, default 60
//   --a        "Key Value" sensitivity multiplier, default 1
//   --atr      ATR period, default 10
//   --ema      EMA trend gate: longs only above EMA(N), shorts only below (0 = off)
//   --fee      taker fee in bps per leg, default 5
//   --slip     slippage in bps per leg, default 2
//   --free     ignore fees and slippage entirely

'use strict';

const { downloadCandles, RESOLUTION_SECONDS } = require('./lib/data');

const DEFAULTS = {
  tf: '15m',
  days: 60,
  a: 1,
  atr: 10,
  ema: 0,
  fee: 5,
  slip: 2,
  free: false,
};

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

// ta.ema: SMA-seeded exponential average (Pine's ta.ema seeds on the first bar
// with the source, so this uses the standard recursive form from index 0).
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

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

// Replays the UT Bot ratchet + flip over one candle series.
//
// Returns the closed trades plus the raw buy/sell trigger count, so a run whose
// triggers are far above its trades (signals swallowed while a position is
// open) is visible.
function simulate(candles, opts) {
  const { a, atrLen, emaLen, costPerTrade } = opts;
  const n = candles.length;
  const atr = atrSeries(candles, atrLen);
  const ema = emaLen > 0 ? emaSeries(candles.map((c) => c.close), emaLen) : null;

  const warmup = Math.max(atrLen + 2, 12, emaLen || 0);
  const trades = [];
  let triggers = 0;

  let trailPrev = 0; // nz(xATRTrailingStop[1], 0)
  let src1 = NaN; // src[1]
  let pos = null; // { side, entry, stop, entryIndex, riskFrac }

  const enter = (side, price, stop, index) => {
    const riskFrac = Math.abs(price - stop) / price;
    pos = { side, entry: price, stop, entryIndex: index, riskFrac };
  };

  const closeTrade = (price, index, reason) => {
    const dir = pos.side === 'long' ? 1 : -1;
    const gross = (dir * (price - pos.entry)) / pos.entry;
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
    const bar = candles[i];
    const src = bar.close;

    // --- 1. manage the open position with the stop it was carrying ---------
    // pos.stop is the trail as it stood at the END of the previous bar, i.e.
    // the only level a real bot could have resting during THIS bar.
    if (pos && i > pos.entryIndex) {
      const pierced = pos.side === 'long' ? bar.low <= pos.stop : bar.high >= pos.stop;
      if (pierced) {
        const gapped = pos.side === 'long' ? bar.open < pos.stop : bar.open > pos.stop;
        closeTrade(gapped ? bar.open : pos.stop, i, 'trail');
      }
    }

    const xATR = atr[i];
    if (!(xATR > 0)) {
      src1 = src;
      continue;
    }
    const nLoss = a * xATR;

    // --- 2. the ratchet, exactly as the Pine iff-chain -------------------
    let trail;
    if (src > trailPrev && src1 > trailPrev) trail = Math.max(trailPrev, src - nLoss);
    else if (src < trailPrev && src1 < trailPrev) trail = Math.min(trailPrev, src + nLoss);
    else if (src > trailPrev) trail = src - nLoss;
    else trail = src + nLoss;

    // --- 3. buy / sell on the close-vs-ratchet crossover ------------------
    const above = src > trail && src1 <= trailPrev;
    const below = trail > src && trailPrev <= src1;
    let buy = src > trail && above;
    let sell = src < trail && below;

    // Optional EMA trend gate: the raw signal is direction-blind, so this is
    // the one filter worth testing on an always-in ratchet.
    if (ema) {
      const trend = ema[i];
      if (trend > 0) {
        if (buy && !(src > trend)) buy = false;
        if (sell && !(src < trend)) sell = false;
      }
    }

    if (buy || sell) triggers += 1;

    // --- 4. act: flat -> enter, holding the other side -> flip ------------
    if (!pos) {
      if (buy) enter('long', src, trail, i);
      else if (sell) enter('short', src, trail, i);
    } else if (pos.side === 'long' && sell) {
      closeTrade(src, i, 'flip');
      enter('short', src, trail, i);
    } else if (pos.side === 'short' && buy) {
      closeTrade(src, i, 'flip');
      enter('long', src, trail, i);
    }

    // --- 5. carry the ratchet forward as the live stop ---------------------
    if (pos) pos.stop = trail;

    trailPrev = trail;
    src1 = src;
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

  // Additive equity curve (notional-normalised), so a chop-then-recover run
  // does not hide behind a compounding assumption it never made.
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

  const days = Number(args.days) || DEFAULTS.days;
  const symbols = (args.symbols ? String(args.symbols).split(',') : [process.env.TRADING_SYMBOL || 'BTCUSD'])
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  const fee = (args.fee !== undefined ? Number(args.fee) : DEFAULTS.fee) / 1e4;
  const slip = (args.slip !== undefined ? Number(args.slip) : DEFAULTS.slip) / 1e4;
  const costPerTrade = DEFAULTS.free || args.free ? 0 : 2 * (fee + slip);

  const opts = {
    a: args.a !== undefined ? Number(args.a) : DEFAULTS.a,
    atrLen: Number(args.atr) || DEFAULTS.atr,
    emaLen: Number(args.ema) || DEFAULTS.ema,
    costPerTrade,
  };

  console.log(`\nUT Bot Alerts (ATR trailing-stop reversal) — ${tf} bars, last ${days}d`);
  console.log('='.repeat(96));
  console.log(
    `model   nLoss=${opts.a} x ATR(${opts.atrLen}) ratchet, close-vs-trail cross, always-in flip` +
      (opts.emaLen > 0 ? `, EMA(${opts.emaLen}) trend gate` : '')
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
      if (candles.length < opts.atrLen + 50) {
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
      'avgR = mean return in units of the entry-to-trail risk (1R = the trailing stop distance),\n' +
      'PF = gross wins / gross losses, net%/d = what is left after costs.'
  );
  console.log(
    '\nNote: this is an ALWAYS-IN system. It is never flat by choice, so a rising market and a\n' +
      'trending market look identical to it — the ratchet is the only thing that decides the side.\n'
  );
}

main().catch((error) => {
  console.error('BACKTEST FAILED:', error.message);
  process.exit(1);
});
