// "EMA Slope + EMA Cross Strategy (by ChartArt)" — Pine v3, ported as a backtest.
//
// THE SYSTEM
// ----------
//   MA1 = EMA(close, 2), MA2 = EMA(close, 4), MA3 = EMA(close, 20)
//   long  = crossunder(price, MA3) OR (dPrice<0 and dMA1<0 and crossunder(price,MA1) and dMA2>0)
//   short = crossover (price, MA3) OR (dPrice>0 and dMA1>0 and crossover (price,MA1) and dMA2<0)
//   It is ALWAYS-IN (never flat) and reverses on every signal. No stops, no targets.
//
// Both branches are CONTRARIAN (mean-reversion): it buys when price crosses BELOW
// the slow EMA and sells when it crosses ABOVE. Despite the name, it is not a
// trend system.
//
// PORT NOTES / DEVIATIONS
// -----------------------
// 1. SIZING. Pine v3 defaults to fixed 1 contract — meaningless for crypto, and
//    with no stop there is no R to risk. This port trades a FIXED NOTIONAL of
//    `--notional` x equity per position (default 1.0 = 100%), so return% is the
//    compounded signed price move minus costs. Set --notional to scale it.
// 2. ORDER OF DOUBLE SIGNALS. When `long` and `short` are both true on one bar,
//    Pine submits both entries, so the short reverses the long and the NET
//    position is short. That ordering (last write wins -> short) is reproduced.
// 3. FILLS. Signals are read on the closed bar and filled at the NEXT bar's open
//    (Pine v3 default process_orders_on_close=false). Non-repainting.
// 4. COST. Each reversal is a close + an open = 2 legs, charged at `--fee`+`--slip`
//    per leg. `--free` drops all costs to expose the raw signal edge.
// 5. `--invert` flips every signal (tests the faded/reverse version).
//
//   node backtest/ema-slope-cross.js --tf 1m --days 7 --symbols AINUSD,BTCUSD,ETHUSD
//   node backtest/ema-slope-cross.js --tf 1m --days 7 --symbols AINUSD,BTCUSD,ETHUSD --free
//   node backtest/ema-slope-cross.js --tf 5m --days 30 --symbols AINUSD,BTCUSD,ETHUSD --invert
//
// Options:
//   --symbols    comma-separated (default TRADING_SYMBOL or BTCUSD)
//   --tf         candle resolution, default 1m
//   --days       look-back window in days, default 7
//   --len1/2/3   EMA lengths, defaults 2 / 4 / 20 (source defaults)
//   --notional   notional per position as x equity, default 1.0
//   --capital    starting equity, default 10000
//   --fee/--slip bps per leg, defaults 3 / 1
//   --invert     flip all signals
//   --free       ignore fees and slippage entirely

'use strict';

const { downloadCandles, RESOLUTION_SECONDS } = require('./lib/data');

const DEFAULTS = {
  tf: '1m', days: 7, len1: 2, len2: 4, len3: 20,
  notional: 1.0, capital: 10000, fee: 3, slip: 1, free: false, invert: false,
};

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
// Simulation (always-in, next-bar-open fills)
// ---------------------------------------------------------------------------

function simulate(candles, opts) {
  const { len1, len2, len3, notional, capital, costPerLeg, invert } = opts;
  const n = candles.length;
  const O = candles.map((c) => c.open);
  const C = candles.map((c) => c.close);

  const MA1 = emaSeries(C, len1);
  const MA2 = emaSeries(C, len2);
  const MA3 = emaSeries(C, len3);

  const trades = [];
  let signals = 0;
  let equity = capital;
  let peak = equity;
  let maxDDpct = 0;

  let dir = 0;        // 0 flat, +1 long, -1 short
  let entryPx = 0;
  let entryIdx = 0;
  let pending = 0;    // signal to execute at the NEXT bar's open

  const warm = Math.max(len1, len2, len3) + 1;

  for (let i = warm; i < n; i += 1) {
    // --- execute the signal armed on the previous bar at THIS bar's open ---
    if (pending !== 0 && pending !== dir) {
      if (dir !== 0) {
        const gross = dir * (O[i] / entryPx - 1);
        const net = gross * notional - 2 * costPerLeg * notional;
        equity *= 1 + net;
        trades.push({
          side: dir > 0 ? 'long' : 'short',
          entry: entryPx,
          exit: O[i],
          net: net * 100,
          bars: i - entryIdx,
          time: candles[i].time,
        });
      }
      dir = pending;
      entryPx = O[i];
      entryIdx = i;
      pending = 0;
    }

    // --- mark-to-market drawdown -------------------------------------------
    if (dir !== 0) {
      const mtm = equity * (1 + dir * (C[i] / entryPx - 1) * notional);
      if (mtm > peak) peak = mtm;
      maxDDpct = Math.max(maxDDpct, ((peak - mtm) / peak) * 100);
    } else if (equity > peak) {
      peak = equity;
    }

    // --- compute the signal on this bar's close ----------------------------
    if (MA1[i] == null || MA1[i - 1] == null || MA2[i] == null || MA2[i - 1] == null || MA3[i] == null || MA3[i - 1] == null) {
      continue;
    }
    const dPrice = C[i] - C[i - 1];
    const dMA1 = MA1[i] - MA1[i - 1];
    const dMA2 = MA2[i] - MA2[i - 1];

    const xUnderMA3 = C[i - 1] >= MA3[i - 1] && C[i] < MA3[i];
    const xOverMA3 = C[i - 1] <= MA3[i - 1] && C[i] > MA3[i];
    const xUnderMA1 = C[i - 1] >= MA1[i - 1] && C[i] < MA1[i];
    const xOverMA1 = C[i - 1] <= MA1[i - 1] && C[i] > MA1[i];

    let long = xUnderMA3 || (dPrice < 0 && dMA1 < 0 && xUnderMA1 && dMA2 > 0);
    let short = xOverMA3 || (dPrice > 0 && dMA1 > 0 && xOverMA1 && dMA2 < 0);
    if (invert) { const t = long; long = short; short = t; }
    if (long || short) signals += 1;

    // Pine submits both entries when both are true; the short lands last, so the
    // net intended position is short (reproduced here).
    let target = 0;
    if (long) target = 1;
    if (short) target = -1;
    pending = target;
  }

  // close any open position at the last close
  if (dir !== 0) {
    const gross = dir * (C[n - 1] / entryPx - 1);
    const net = gross * notional - 2 * costPerLeg * notional;
    equity *= 1 + net;
    trades.push({
      side: dir > 0 ? 'long' : 'short',
      entry: entryPx,
      exit: C[n - 1],
      net: net * 100,
      bars: n - 1 - entryIdx,
      time: candles[n - 1].time,
    });
  }

  return { trades, signals, equity, capital, maxDDpct };
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

function analyze(candles, opts) {
  const { trades, signals, equity, capital, maxDDpct } = simulate(candles, opts);
  const spanDays = (candles[candles.length - 1].time - candles[0].time) / 86400;
  const base = { spanDays, signals, equity, capital, ret: (equity / capital - 1) * 100, maxDDpct };
  if (!trades.length) return { ...base, trades: 0, empty: true };

  const n = trades.length;
  const sum = (f) => trades.reduce((s, t) => s + f(t), 0);
  const wins = trades.filter((t) => t.net > 0);
  const grossWin = sum((t) => Math.max(t.net, 0));
  const grossLoss = Math.abs(sum((t) => Math.min(t.net, 0)));

  return {
    ...base,
    trades: n,
    perDay: n / spanDays,
    winPct: (wins.length / n) * 100,
    avgNet: sum((t) => t.net) / n,
    totNet: sum((t) => t.net),
    avgHold: sum((t) => t.bars) / n,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : Infinity,
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
    if (next && !next.startsWith('--')) { args[key] = next; i += 1; } else { args[key] = true; }
  }
  return args;
}

const num = (v, d) => (v !== undefined ? Number(v) : d);
const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '-');
const signed = (v, d = 2) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(d)}` : '-');
const pad = (t, w, right = false) => (right ? String(t).padStart(w) : String(t).padEnd(w));

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const tf = args.tf ? String(args.tf) : DEFAULTS.tf;
  if (!RESOLUTION_SECONDS[tf]) {
    console.error(`Unsupported --tf "${tf}". Use one of: ${Object.keys(RESOLUTION_SECONDS).join(', ')}`);
    process.exit(1);
  }

  const days = num(args.days, DEFAULTS.days);
  const symbols = (args.symbols ? String(args.symbols).split(',') : [process.env.TRADING_SYMBOL || 'BTCUSD'])
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  const fee = num(args.fee, DEFAULTS.fee) / 1e4;
  const slip = num(args.slip, DEFAULTS.slip) / 1e4;
  const costPerLeg = args.free ? 0 : fee + slip;
  const invert = !!args.invert;

  const baseOpts = {
    len1: num(args.len1, DEFAULTS.len1),
    len2: num(args.len2, DEFAULTS.len2),
    len3: num(args.len3, DEFAULTS.len3),
    notional: num(args.notional, DEFAULTS.notional),
    capital: num(args.capital, DEFAULTS.capital),
    costPerLeg,
    invert,
  };

  console.log(`\nChartArt EMA Slope + EMA Cross — ${baseOpts.len1}/${baseOpts.len2}/${baseOpts.len3} EMA, ${tf} bars, last ${days}d${invert ? '  [INVERTED]' : ''}`);
  console.log('='.repeat(132));
  console.log(
    `model   ALWAYS-IN reversal (no stops/targets), fade of the slow EMA | notional ${baseOpts.notional}x equity | ` +
      `costs ${costPerLeg > 0 ? `${(costPerLeg * 2 * 1e4).toFixed(1)}bps/flip` : 'NONE (--free)'}`
  );

  const rows = [];
  for (const symbol of symbols) {
    const toSec = Math.floor(Date.now() / 1000);
    const fromSec = toSec - days * 86400;
    try {
      const { candles } = await downloadCandles({ symbol, resolution: tf, fromSec, toSec });
      if (candles.length < 50) { rows.push({ symbol, skipped: `only ${candles.length} bars` }); continue; }
      rows.push({ symbol, bars: candles.length, ...analyze(candles, baseOpts) });
    } catch (error) {
      rows.push({ symbol, skipped: error.message });
    }
  }

  console.log(
    `\n${pad('#', 3, true)} | ${pad('symbol', 10)} | ${pad('bars', 6, true)} | ${pad('sigs', 6, true)} | ${pad('trades', 6, true)} | ` +
      `${pad('/day', 6, true)} | ${pad('win%', 5, true)} | ${pad('avg%', 6, true)} | ${pad('hold', 5, true)} | ${pad('PF', 5, true)} | ` +
      `${pad('long%', 6, true)} | ${pad('return%', 9, true)} | ${pad('maxDD%', 7, true)}`
  );
  console.log('-'.repeat(132));

  rows.forEach((r, index) => {
    if (r.skipped) { console.log(`${pad(index + 1, 3, true)} | ${pad(r.symbol, 10)} | skipped: ${r.skipped}`); return; }
    if (r.empty) {
      console.log(`${pad(index + 1, 3, true)} | ${pad(r.symbol, 10)} | ${pad(r.bars, 6, true)} | ${pad(r.signals, 6, true)} | no trades            ${pad(signed(r.ret, 2), 9, true)}`);
      return;
    }
    console.log(
      `${pad(index + 1, 3, true)} | ${pad(r.symbol, 10)} | ${pad(r.bars, 6, true)} | ${pad(r.signals, 6, true)} | ${pad(r.trades, 6, true)} | ` +
        `${pad(fmt(r.perDay, 1), 6, true)} | ${pad(fmt(r.winPct, 1), 5, true)} | ${pad(signed(r.avgNet, 3), 6, true)} | ${pad(fmt(r.avgHold, 1), 5, true)} | ` +
        `${pad(fmt(r.profitFactor, 2), 5, true)} | ${pad(fmt(r.longShare, 0), 6, true)} | ${pad(signed(r.ret, 2), 9, true)} | ${pad(fmt(r.maxDDpct, 1), 7, true)}`
    );
  });

  console.log(
    '\nsigs = bars with any signal, trades = completed flips (one per reversal); avg% = average net return per flip;\n' +
      'hold = avg bars held; PF on net PnL; long% = share of trades that were long. Always-in: a flat stretch never happens\n' +
      'between the first and last fill. --free isolates the raw signal from costs; --invert tests the faded version.'
  );
}

main().catch((error) => {
  console.error('BACKTEST FAILED:', error.message);
  process.exit(1);
});
