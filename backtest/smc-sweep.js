// EQH / EQL liquidity-sweep backtest — the tradeable half of LuxAlgo's
// "Smart Money Concepts" indicator.
//
// The indicator only ever LABELS equal highs/lows; it never emits a sweep. The
// setup this measures is the one the label implies:
//
//   1. a liquidity pool exists — two consecutive swing extremes within
//      `threshold` x ATR(200) of each other (exactly the indicator's EQH/EQL
//      rule: pivot length `pivot`, ATR-normalised tolerance);
//   2. price SWEEPS it — a bar's low pierces an EQL (high pierces an EQH) and,
//      within `reclaim` bars, a bar CLOSES back on the origin side of the
//      level. The poke is the stop hunt, the reclaim is the reversal;
//   3. enter at that reclaim close, stop beyond the sweep wick, target
//      `rr` x the risk. Time-stop after `maxHold` bars.
//
// Non-repainting by construction: a pivot is only usable `pivot` bars after it
// forms, and entries are read off CLOSED bars. One position at a time.
//
// Faithful to the source where it matters and honest where it is not:
//   * pivot: high[p] strictly > the `pivot` bars after it (mirror for lows) —
//     the indicator's `high[size] > ta.highest(size)`;
//   * tolerance: 0.1 x ATR(200) by default (the indicator's default);
//   * the level is the EXTREME of the pool (min of the two lows / max of the
//     two highs), so both lows must be taken out before a sweep counts. The
//     indicator labels the newer pivot; that difference is deliberate.
//
//   node backtest/smc-sweep.js
//   node backtest/smc-sweep.js --symbols BTCUSD,ETHUSD,AINUSD --days 7
//   node backtest/smc-sweep.js --tf 5m --rr 3 --reclaim 5
//   node backtest/smc-sweep.js --free                 # pure signal edge, no costs
//
// Options:
//   --symbols  comma-separated (default TRADING_SYMBOL or BTCUSD)
//   --tf       candle resolution, default 1m
//   --days     look-back window in days, default 5
//   --pivot    swing confirmation length, default 3
//   --threshold  EQH/EQL tolerance in ATR(200), default 0.1
//   --reclaim  max bars from sweep to reclaim close, default 3
//   --rr       reward:risk multiple, default 2
//   --stopbuf  sweep-wick buffer in ATR(200), default 0.1
//   --levelage max bars a level stays live, default 300
//   --maxhold  time-stop in bars, default 120
//   --fee      taker fee in bps per leg, default 5
//   --slip     slippage in bps per leg, default 2
//   --free     ignore fees and slippage entirely

'use strict';

const { downloadCandles, RESOLUTION_SECONDS } = require('./lib/data');

const ATR_LEN = 200; // the indicator's atrMeasure

const DEFAULTS = {
  tf: '1m',
  days: 5,
  pivot: 3,
  threshold: 0.1,
  reclaim: 3,
  rr: 2,
  stopbuf: 0.1,
  levelage: 300,
  maxhold: 120,
  fee: 5,
  slip: 2,
  free: false,
};

// ---------------------------------------------------------------------------
// Indicators (identical maths to the Pine source)
// ---------------------------------------------------------------------------

// Pine's ta.rma / SMMA.
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

// ta.atr(200): RMA of true range.
function atrSeries(candles, len) {
  const tr = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const pc = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
  });
  return rma(tr, len);
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

// Replays the sweep-reversal model over one candle series.
//
// Returns the closed trades plus the raw trigger count, so a run that fires a
// lot but trades little (signals swallowed while a position is open) is visible.
function simulate(candles, opts) {
  const { pivot, threshold, reclaim, rr, stopbuf, levelage, maxhold, costPerTrade } = opts;
  const n = candles.length;
  const atr = atrSeries(candles, ATR_LEN);

  const warmup = Math.max(ATR_LEN + pivot + 2, 10);
  const trades = [];
  let triggers = 0;

  // Last confirmed pivot level of each kind (the indicator's equalHigh/equalLow
  // UDTs), and the live liquidity pools.
  let lastLow = null;
  let lastHigh = null;
  const levels = []; // { type:'low'|'high', level, confirmedAt }

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
      r: gross / pos.riskFrac,
      bars: index - pos.entryIndex,
      reason,
      time: candles[index].time,
    });
    pos = null;
  };

  for (let i = warmup; i < n; i += 1) {
    const bar = candles[i];
    const a = atr[i];

    // --- 1. manage an open position on this bar ---------------------------
    if (pos) {
      if (i > pos.entryIndex) {
        const hitStop = pos.side === 'long' ? bar.low <= pos.stop : bar.high >= pos.stop;
        const hitTarget = pos.side === 'long' ? bar.high >= pos.target : bar.low <= pos.target;
        if (hitStop) closeTrade(pos.stop, i, 'stop'); // stop first when both touch
        else if (hitTarget) closeTrade(pos.target, i, 'target');
        else if (i - pos.entryIndex >= maxhold) closeTrade(bar.close, i, 'timeout');
      }
      if (pos) continue; // still in a trade — no new signals this bar
    }

    if (!(a > 0)) continue;

    // --- 2. detect liquidity pools (confirmed pivots only) ----------------
    const p = i - pivot;
    if (p >= 0) {
      const pivotHigh = candles[p].high;
      const pivotLow = candles[p].low;
      let isHigh = true;
      let isLow = true;
      for (let k = 1; k <= pivot; k += 1) {
        if (!(pivotHigh > candles[p + k].high)) isHigh = false;
        if (!(pivotLow < candles[p + k].low)) isLow = false;
      }

      const tol = threshold * a;
      if (isLow) {
        if (lastLow !== null && Math.abs(lastLow - pivotLow) < tol) {
          levels.push({ type: 'low', level: Math.min(lastLow, pivotLow), confirmedAt: i });
        }
        lastLow = pivotLow;
      }
      if (isHigh) {
        if (lastHigh !== null && Math.abs(lastHigh - pivotHigh) < tol) {
          levels.push({ type: 'high', level: Math.max(lastHigh, pivotHigh), confirmedAt: i });
        }
        lastHigh = pivotHigh;
      }
    }

    // --- 3. sweep + reclaim -> enter -------------------------------------
    for (let li = levels.length - 1; li >= 0; li -= 1) {
      const lv = levels[li];
      if (i - lv.confirmedAt > levelage) {
        levels.splice(li, 1);
        continue;
      }
      // The pool can only be swept after it is confirmed.
      if (i <= lv.confirmedAt) continue;

      if (lv.sweptAt === undefined) {
        const pierced = lv.type === 'low' ? bar.low < lv.level : bar.high > lv.level;
        if (pierced) {
          lv.sweptAt = i;
          lv.sweepExtreme = lv.type === 'low' ? bar.low : bar.high;
        } else {
          continue;
        }
      } else {
        // extend the sweep extreme while price is still beyond the level
        if (lv.type === 'low') lv.sweepExtreme = Math.min(lv.sweepExtreme, bar.low);
        else lv.sweepExtreme = Math.max(lv.sweepExtreme, bar.high);
      }

      // Reclaim window expired without a close back on the origin side.
      if (i - lv.sweptAt > reclaim) {
        levels.splice(li, 1);
        continue;
      }

      const reclaimed = lv.type === 'low' ? bar.close > lv.level : bar.close < lv.level;
      if (!reclaimed) continue;

      const dir = lv.type === 'low' ? 1 : -1;
      const entry = bar.close;
      const buf = stopbuf * a;
      const stop = lv.sweepExtreme - dir * buf;
      const riskPrice = Math.abs(entry - stop);
      levels.splice(li, 1);
      triggers += 1;

      if (!(riskPrice > 0) || !(entry > 0)) continue;

      pos = {
        side: dir > 0 ? 'long' : 'short',
        entry,
        stop,
        target: entry + dir * rr * riskPrice,
        riskFrac: riskPrice / entry,
        entryIndex: i,
      };
      break; // one position only
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
    profitFactor: losses.length ? sum((t) => Math.max(t.gross, 0)) / Math.abs(sum((t) => Math.min(t.gross, 0))) : Infinity,
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
    pivot: Number(args.pivot) || DEFAULTS.pivot,
    threshold: args.threshold !== undefined ? Number(args.threshold) : DEFAULTS.threshold,
    reclaim: Number(args.reclaim) || DEFAULTS.reclaim,
    rr: Number(args.rr) || DEFAULTS.rr,
    stopbuf: args.stopbuf !== undefined ? Number(args.stopbuf) : DEFAULTS.stopbuf,
    levelage: Number(args.levelage) || DEFAULTS.levelage,
    maxhold: Number(args.maxhold) || DEFAULTS.maxhold,
    costPerTrade,
  };

  console.log(`\nEQH/EQL sweep reversal — ${tf} bars, last ${days}d`);
  console.log('='.repeat(96));
  console.log(
    `model   pivot=${opts.pivot} tol=${opts.threshold}xATR(${ATR_LEN}) reclaim<=${opts.reclaim} ` +
      `rr=${opts.rr} stopbuf=${opts.stopbuf}xATR age=${opts.levelage} maxhold=${opts.maxhold}`
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
      if (candles.length < ATR_LEN + 50) {
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
    `\n${pad('#', 3, true)} | ${pad('symbol', 10)} | ${pad('bars', 6, true)} | ${pad('sweeps', 6, true)} | ` +
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
    '\nsweeps = raw reclaim triggers, trades = those actually taken (one position at a time),\n' +
      'avgR = mean return in units of the risked distance (1R = entry-to-stop),\n' +
      'PF = gross wins / gross losses, net%/d = what is left after costs.'
  );
  console.log(
    '\nA "sweeps >> trades" gap means signals are being swallowed while a position is open.\n' +
      'Run with --free to see the raw edge, then WITHOUT it to see what fees leave behind.\n'
  );
}

main().catch((error) => {
  console.error('BACKTEST FAILED:', error.message);
  process.exit(1);
});
