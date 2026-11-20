// "SuperTrend STRATEGY” (TradingView Pine v4, © KivancOzbilgic) ported as a backtest.
//
// THE SYSTEM
// ----------
//   atr       = atr(Periods)                        // ta.atr (RMA of true range), Periods=10
//   src       = hl2
//   Multiplier = 3.0
//   up = src - Multiplier*atr, ratcheted so it only ever RISES while close[1] > up[1]
//   dn = src + Multiplier*atr, ratcheted so it only ever FALLS while close[1] < dn[1]
//   trend flips -1 -> 1 when close crosses ABOVE dn[1] (the upper band)
//   trend flips  1 -> -1 when close crosses BELOW up[1] (the lower band)
//   buy  = trend turns 1   (was -1)
//   sell = trend turns -1  (was 1)
//   strategy.entry("BUY" / "SELL")                  // market, no stop, no target
//
// NAMING QUIRK: the source's variables are inverted relative to the usual
// convention — `up` is the LOWER band (the long trailing line) and `dn` is the
// UPPER band. That is exactly how KivancOzbilgic wrote it; this port keeps the
// same behaviour (and names) so line-by-line comparison stays possible.
//
// It is an ALWAYS-IN reversal: a flip is the only exit and the next flip is the
// only entry, so the position is never flat by choice. `changeATR=true` uses
// ta.atr (RMA); set it false to use sma(tr, Periods) instead — both are ported.
//
// PORT NOTES / DEVIATIONS
// -----------------------
// 1. SIZING. Pine default `strategy.entry` is 1 contract, meaningless for
//    crypto. Like the sibling ports this trades a FIXED NOTIONAL of
//    `--notional` x equity per position (default 1.0 = 100%), so return% is the
//    compounded signed price move minus costs. Set --notional to scale it.
// 2. FILLS. Signals are read on the CLOSED bar and filled at the NEXT bar's
//    open (Pine v4 default process_orders_on_close=false). Non-repainting.
// 3. COST. Each reversal is a close + an open = 2 legs, charged at `--fee` +
//    `--slip` per leg. `--free` drops all costs to expose the raw signal edge.
// 4. `--invert` flips every signal (the faded version, i.e. the one wired live
//    in src/strategies/strategies/superTrendStrategy.js).
//
//   node backtest/supertrend-strategy.js --tf 1m --days 7 --symbols EVAAUSD,SOLUSD,XRPUSD,DOGEUSD
//   node backtest/supertrend-strategy.js --tf 1m --days 7 --symbols EVAAUSD,SOLUSD,XRPUSD,DOGEUSD --invert
//   node backtest/supertrend-strategy.js --tf 5m --days 30 --symbols BTCUSD,ETHUSD --free
//
// Options:
//   --symbols    comma-separated (default TRADING_SYMBOL or BTCUSD)
//   --tf         candle resolution, default 1m
//   --days       look-back window in days, default 7
//   --offset     end the window this many days ago (disjoint walk-forward slices), default 0
//   --atr        ATR period, default 10
//   --mult       ATR multiplier, default 3.0
//   --smaatr     use sma(tr, Periods) instead of ta.atr (changeATR=false)
//   --notional   notional per position as x equity, default 1.0
//   --capital    starting equity, default 10000
//   --fee/--slip bps per leg, defaults 3 / 1
//   --invert     flip all signals
//   --free       ignore fees and slippage entirely

'use strict';

const { downloadCandles, RESOLUTION_SECONDS } = require('./lib/data');

const DEFAULTS = {
  tf: '1m', days: 7, offset: 0, atr: 10, mult: 3.0, smaatr: false,
  notional: 1.0, capital: 10000, fee: 3, slip: 1, free: false, invert: false,
};

// ---------------------------------------------------------------------------
// Indicators (identical maths to the Pine source)
// ---------------------------------------------------------------------------

// Pine's ta.rma / SMMA: SMA seed at index len-1, then (v[1]*(len-1)+src)/len.
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

// Pine's ta.sma: simple average over the trailing `len` values.
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

// Pine's `tr` series: tr[0] = high-low, then max(high-low, |high-close[1]|, |low-close[1]|).
function trueRange(candles) {
  return candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const pc = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
  });
}

// atr = changeATR ? atr(Periods) : sma(tr, Periods).
function atrSeries(candles, len, useSma) {
  const tr = trueRange(candles);
  return useSma ? smaSeries(tr, len) : rmaSeries(tr, len);
}

// ---------------------------------------------------------------------------
// Simulation (always-in, next-bar-open fills)
// ---------------------------------------------------------------------------

// Replays the SuperTrend ratchet + trend flip over one candle series and
// returns a per-bar trend array (1 = bull, -1 = bear, null = not warmed up).
function superTrend(candles, atrLen, mult, useSma) {
  const n = candles.length;
  const atr = atrSeries(candles, atrLen, useSma);
  const up = new Array(n).fill(null);
  const dn = new Array(n).fill(null);
  const trend = new Array(n).fill(null);

  for (let i = 0; i < n; i += 1) {
    const a = atr[i];
    if (a == null || !(a > 0)) continue;

    const src = (candles[i].high + candles[i].low) / 2;
    const rawUp = src - mult * a;
    const rawDn = src + mult * a;

    // nz(up[1], up) / nz(dn[1], dn): fall back to the raw value at the first bar.
    const up1 = i > 0 && up[i - 1] != null ? up[i - 1] : rawUp;
    const dn1 = i > 0 && dn[i - 1] != null ? dn[i - 1] : rawDn;

    // The ratchet uses close[1] (na at bar 0 -> the condition is false).
    up[i] = i > 0 && candles[i - 1].close > up1 ? Math.max(rawUp, up1) : rawUp;
    dn[i] = i > 0 && candles[i - 1].close < dn1 ? Math.min(rawDn, dn1) : rawDn;

    // nz(trend[1], trend): trend starts at 1 and holds through the warm-up.
    const prevTrend = i > 0 && trend[i - 1] != null ? trend[i - 1] : 1;
    let t = prevTrend;
    if (prevTrend === -1 && candles[i].close > dn1) t = 1;
    else if (prevTrend === 1 && candles[i].close < up1) t = -1;
    trend[i] = t;
  }

  return { trend, up, dn };
}

function simulate(candles, opts) {
  const { atrLen, mult, useSma, notional, capital, costPerLeg, invert } = opts;
  const n = candles.length;
  const O = candles.map((c) => c.open);
  const C = candles.map((c) => c.close);
  const { trend } = superTrend(candles, atrLen, mult, useSma);

  const trades = [];
  let signals = 0;
  let equity = capital;
  let peak = equity;
  let maxDDpct = 0;

  let dir = 0;      // 0 flat, +1 long, -1 short
  let entryPx = 0;
  let entryIdx = 0;
  let pending = 0;  // signal to execute at the NEXT bar's open

  const warm = atrLen + 2;

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

    // --- signal on this bar's close ----------------------------------------
    if (trend[i] == null || trend[i - 1] == null) continue;

    let buy = trend[i] === 1 && trend[i - 1] === -1;
    let sell = trend[i] === -1 && trend[i - 1] === 1;
    if (invert) {
      const t = buy;
      buy = sell;
      sell = t;
    }
    if (buy || sell) signals += 1;

    let target = 0;
    if (buy) target = 1;
    if (sell) target = -1;
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
  const offset = num(args.offset, DEFAULTS.offset);
  const symbols = (args.symbols ? String(args.symbols).split(',') : [process.env.TRADING_SYMBOL || 'BTCUSD'])
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  const fee = num(args.fee, DEFAULTS.fee) / 1e4;
  const slip = num(args.slip, DEFAULTS.slip) / 1e4;
  const costPerLeg = args.free ? 0 : fee + slip;
  const invert = !!args.invert;

  const baseOpts = {
    atrLen: num(args.atr, DEFAULTS.atr),
    mult: num(args.mult, DEFAULTS.mult),
    useSma: !!args.smaatr,
    notional: num(args.notional, DEFAULTS.notional),
    capital: num(args.capital, DEFAULTS.capital),
    costPerLeg,
    invert,
  };

  console.log(`\nSuperTrend STRATEGY (KivancOzbilgic) — ATR(${baseOpts.atrLen}) x ${baseOpts.mult}${baseOpts.useSma ? ' [sma(tr)]' : ''}, ${tf} bars, last ${days}d${invert ? '  [INVERTED]' : ''}`);
  console.log('='.repeat(132));
  console.log(
    `model   ALWAYS-IN trend-reversal (no stops/targets) | notional ${baseOpts.notional}x equity | ` +
      `costs ${costPerLeg > 0 ? `${(costPerLeg * 2 * 1e4).toFixed(1)}bps/flip` : 'NONE (--free)'}`
  );

  const rows = [];
  for (const symbol of symbols) {
    const toSec = Math.floor(Date.now() / 1000) - offset * 86400;
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
    '\nsigs = bars with a trend flip, trades = completed flips (one per reversal); avg% = average net return per flip;\n' +
      'hold = avg bars held; PF on net PnL; long% = share of trades that were long. Always-in: a flat stretch never happens\n' +
      'between the first and last fill. --free isolates the raw signal from costs; --invert tests the faded version.'
  );
}

main().catch((error) => {
  console.error('BACKTEST FAILED:', error.message);
  process.exit(1);
});
