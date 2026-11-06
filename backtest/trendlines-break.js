// "Trendlines with Breaks" (TradingView Pine v5, LuxAlgo) ported as a backtest.
//
// WHAT THE INDICATOR ACTUALLY IS
// ------------------------------
// It is NOT a complete strategy — it draws a descending "upper" line off the
// last confirmed swing high and an ascending "lower" line off the last
// confirmed swing low, then flags a one-shot breakout when the close crosses
// either line:
//
//   ph = ta.pivothigh(length, length)      // swing high, confirmed length bars late
//   pl = ta.pivotlow(length, length)       // swing low,  confirmed length bars late
//   slope = ta.atr(length) / length * mult // line drift per bar (ATR-scaled)
//
//   slope_ph := ph ? slope : slope_ph       // re-anchor slope only on a new pivot
//   slope_pl := pl ? slope : slope_pl
//   upper    := ph ? ph   : upper - slope_ph   // descending resistance
//   lower    := pl ? pl   : lower + slope_pl   // ascending support
//
//   upos := ph ? 0 : close > upper - slope_ph * length ? 1 : upos
//   dnos := pl ? 0 : close < lower + slope_pl * length ? 1 : dnos
//
//   breakoutUp   = upos > upos[1]           // 0 -> 1
//   breakoutDown = dnos > dnos[1]           // 0 -> 1
//
// Two things worth being explicit about, because they decide tradability:
//
//   * LAG. `ta.pivothigh(length, length)` needs `length` bars on EACH side, so
//     a swing is only known `length` bars after it printed. On 15m with
//     length=14 that is 14 x 15m = 3.5 HOURS of confirmation delay, on both
//     lines. Every break you act on is against a line whose newest anchor is
//     at least 3.5h old.
//   * BACKPAINT is display-only. `backpaint` feeds the two `plot()` offsets and
//     the `line.set_xy` calls, NOT the upos/dnos maths. The signals are
//     therefore non-repainting and identical in both modes. What backpaint does
//     is shift the drawn line `length` bars into the past, so it LOOKS like the
//     line was already sitting on the pivots historically. This simulation uses
//     the real-time (offset 0) values only.
//
// HOW THIS SIMULATION EXECUTES IT
// -------------------------------
// Non-repainting, one position at a time, no look-ahead:
//   * pivots are read only where the full `length` bars of right-side history
//     exist, and entries are read off the CLOSED bar's close;
//   * on an upward break -> LONG at the close, on a downward break -> SHORT;
//   * the broken line becomes the stop: `upper`/`lower` threshold at entry,
//     padded by `stopbuf` x ATR so a single tick back through the line does not
//     end the trade. The stop is treated as a resting reduce-only order (a bar
//     that gaps past it fills at the bar open);
//   * an opposite breakout closes the trade and flips it;
//   * if the stop fires the book goes flat until the next breakout.
//
//   node backtest/trendlines-break.js
//   node backtest/trendlines-break.js --tf 15m --symbols BTCUSD,ETHUSD,AINUSD --days 60
//   node backtest/trendlines-break.js --tf 15m --length 8 --mult 1
//   node backtest/trendlines-break.js --tf 15m --free          # raw edge, no costs
//
// Options:
//   --symbols   comma-separated (default TRADING_SYMBOL or BTCUSD)
//   --tf        candle resolution, default 15m
//   --days      look-back window in days, default 60
//   --length    swing detection lookback (pivot size), default 14
//   --mult      slope multiplier, default 1
//   --stopbuf   stop padding beyond the broken line in ATR, default 0.5
//   --fee       taker fee in bps per leg, default 5
//   --slip      slippage in bps per leg, default 2
//   --free      ignore fees and slippage entirely

'use strict';

const { downloadCandles, RESOLUTION_SECONDS } = require('./lib/data');

const DEFAULTS = {
  tf: '15m',
  days: 60,
  length: 14,
  mult: 1,
  stopbuf: 0.5,
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

// ta.pivothigh(length, length) evaluated at bar i: the pivot sits at i-length
// and must equal the highest high of the (2*length + 1)-bar window centred on
// it (ties allowed, matching Pine's `high[right] == ta.highest(...)` form).
function pivotHigh(candles, i, len) {
  const p = i - len;
  if (p - len < 0) return NaN;
  let mx = -Infinity;
  for (let k = p - len; k <= p + len; k += 1) {
    if (k === p) continue;
    if (candles[k].high > mx) mx = candles[k].high;
  }
  return candles[p].high >= mx ? candles[p].high : NaN;
}

// ta.pivotlow(length, length): mirror of the above.
function pivotLow(candles, i, len) {
  const p = i - len;
  if (p - len < 0) return NaN;
  let mn = Infinity;
  for (let k = p - len; k <= p + len; k += 1) {
    if (k === p) continue;
    if (candles[k].low < mn) mn = candles[k].low;
  }
  return candles[p].low <= mn ? candles[p].low : NaN;
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

// Replays the trendline-break model over one candle series. Returns the closed
// trades plus the raw breakout count, so a run whose breakouts are far above
// its trades (signals swallowed while a position is open / stopped) is visible.
function simulate(candles, opts) {
  const { length, mult, stopbuf, costPerTrade } = opts;
  const n = candles.length;
  const atr = atrSeries(candles, length);

  // Need `length` bars of ATR and `2*length` bars of swing history before the
  // first pivot can even be confirmed.
  const warmup = Math.max(2 * length + 2, length + 2, 20);
  const trades = [];
  let triggers = 0;

  let upper = 0;
  let lower = 0;
  let slopePh = 0;
  let slopePl = 0;
  let upos = 0;
  let dnos = 0;
  let pos = null;

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

    // --- 1. manage the open position with its resting stop -----------------
    if (pos && i > pos.entryIndex) {
      const pierced = pos.side === 'long' ? bar.low <= pos.stop : bar.high >= pos.stop;
      if (pierced) {
        const gapped = pos.side === 'long' ? bar.open < pos.stop : bar.open > pos.stop;
        closeTrade(gapped ? bar.open : pos.stop, i, 'stop');
      }
    }

    const a = atr[i];
    if (!(a > 0)) continue;

    // --- 2. the trendline maths, in the exact Pine assignment order --------
    const ph = pivotHigh(candles, i, length);
    const pl = pivotLow(candles, i, length);
    const slope = (a / length) * mult;

    slopePh = !Number.isNaN(ph) ? slope : slopePh;
    slopePl = !Number.isNaN(pl) ? slope : slopePl;

    upper = !Number.isNaN(ph) ? ph : upper - slopePh;
    lower = !Number.isNaN(pl) ? pl : lower + slopePl;

    const upperThresh = upper - slopePh * length; // line value at the current bar
    const lowerThresh = lower + slopePl * length;

    const nextUpos = !Number.isNaN(ph) ? 0 : src > upperThresh ? 1 : upos;
    const nextDnos = !Number.isNaN(pl) ? 0 : src < lowerThresh ? 1 : dnos;

    const breakoutUp = nextUpos > upos; // 0 -> 1
    const breakoutDown = nextDnos > dnos; // 0 -> 1

    upos = nextUpos;
    dnos = nextDnos;

    if (breakoutUp) triggers += 1;
    if (breakoutDown) triggers += 1;

    // --- 3. act: enter on a break, flip on the opposite break -------------
    if (breakoutUp) {
      if (pos && pos.side === 'short') closeTrade(src, i, 'flip');
      if (!pos) {
        const stop = upperThresh - stopbuf * a;
        pos = {
          side: 'long',
          entry: src,
          stop,
          riskFrac: Math.abs(src - stop) / src,
          entryIndex: i,
        };
      }
    } else if (breakoutDown) {
      if (pos && pos.side === 'long') closeTrade(src, i, 'flip');
      if (!pos) {
        const stop = lowerThresh + stopbuf * a;
        pos = {
          side: 'short',
          entry: src,
          stop,
          riskFrac: Math.abs(stop - src) / src,
          entryIndex: i,
        };
      }
    }
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
    length: Number(args.length) || DEFAULTS.length,
    mult: args.mult !== undefined ? Number(args.mult) : DEFAULTS.mult,
    stopbuf: args.stopbuf !== undefined ? Number(args.stopbuf) : DEFAULTS.stopbuf,
    costPerTrade,
  };

  console.log(`\nTrendlines with Breaks (LuxAlgo) — ${tf} bars, last ${days}d`);
  console.log('='.repeat(104));
  console.log(
    `model   pivot=${opts.length} (=> ${opts.length} bars / ${((opts.length * (RESOLUTION_SECONDS[tf] || 0)) / 3600).toFixed(1)}h confirmation lag) ` +
      `slope=${opts.mult}xATR(${opts.length})/${opts.length} stopbuf=${opts.stopbuf}xATR, flip on opposite break`
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
      if (candles.length < 2 * opts.length + 50) {
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
    `\n${pad('#', 3, true)} | ${pad('symbol', 10)} | ${pad('bars', 6, true)} | ${pad('breaks', 7, true)} | ` +
      `${pad('trades', 6, true)} | ${pad('/day', 6, true)} | ${pad('win%', 5, true)} | ${pad('avgR', 5, true)} | ` +
      `${pad('hold', 6, true)} | ${pad('PF', 5, true)} | ${pad('gross%/d', 8, true)} | ${pad('cost%/d', 8, true)} | ` +
      `${pad('net%/d', 7, true)} | ${pad('maxDD%', 7, true)}`
  );
  console.log('-'.repeat(128));

  rows.forEach((r, index) => {
    if (r.skipped) {
      console.log(`${pad(index + 1, 3, true)} | ${pad(r.symbol, 10)} | skipped: ${r.skipped}`);
      return;
    }
    if (r.empty) {
      console.log(
        `${pad(index + 1, 3, true)} | ${pad(r.symbol, 10)} | ${pad(r.bars, 6, true)} | ${pad(r.triggers, 7, true)} | ` +
          `${pad(0, 6, true)} | no trades`
      );
      return;
    }
    console.log(
      `${pad(index + 1, 3, true)} | ${pad(r.symbol, 10)} | ${pad(r.bars, 6, true)} | ${pad(r.triggers, 7, true)} | ` +
        `${pad(r.trades, 6, true)} | ${pad(fmt(r.perDay, 1), 6, true)} | ${pad(fmt(r.winPct, 1), 5, true)} | ` +
        `${pad(signed(r.avgR, 2), 5, true)} | ${pad(fmt(r.avgHold, 0), 6, true)} | ` +
        `${pad(fmt(r.profitFactor, 2), 5, true)} | ${pad(signed(r.grossPerDay, 2), 8, true)} | ` +
        `${pad(fmt(r.costPerDay, 2), 8, true)} | ${pad(signed(r.netPerDay, 2), 7, true)} | ${pad(fmt(r.maxDD, 1), 7, true)}`
    );
  });

  console.log(
    '\nbreaks = raw up/down line crossings, trades = those actually taken (one position at a time),\n' +
      'avgR = mean return in units of the entry-to-stop risk (1R = broken line + stopbuf x ATR),\n' +
      'PF = gross wins / gross losses, net%/d = what is left after costs.'
  );
  console.log(
    '\nA "breaks >> trades" gap means signals are being swallowed (stopped out or already positioned).\n' +
      'Run with --free to see the raw breakout edge, then WITHOUT it to see what fees leave behind.\n'
  );
}

main().catch((error) => {
  console.error('BACKTEST FAILED:', error.message);
  process.exit(1);
});
