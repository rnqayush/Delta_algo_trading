// "Volume-Confirmed Support/Resistance Breakout Strategy" (Pine v6) ported as a
// backtest.
//
// PORTED FAITHFULLY, INCLUDING THE PART THAT MAKES IT DANGEROUS
// ------------------------------------------------------------
// The source sizes every trade at a flat `percent_of_equity = 10` while the
// stop is anchored to the last confirmed swing pivot, whose distance varies by
// an order of magnitude. This port reproduces that exactly (fixed 10% notional)
// so the reported return is what the script would actually have produced — not
// what a risk-normalised version would.
//
// Semantics matched to TradingView:
//   * pivots confirm `pivotRight` bars late -> no look-ahead, but the level a
//     breakout is measured against is at least 10 bars stale;
//   * signals read the confirmed close, orders fill at the NEXT bar's open
//     (process_orders_on_close is off);
//   * stop = broken structural level -/+ an ATR buffer (fallback: 1.5 ATR from
//     close); target = 3.0 ATR from close; both frozen at the signal bar;
//   * when a bar contains both stop and target, the STOP fills first
//     (TradingView's pessimistic assumption);
//   * pyramiding 0, but an opposite signal reverses the position at the open.
//
//   node backtest/vol-sr-breakout.js --tf 1m --days 7 --symbols AINUSD,BTCUSD,ETHUSD
//   node backtest/vol-sr-breakout.js --tf 1m --days 7 --fee 5 --slip 2
//   node backtest/vol-sr-breakout.js --tf 5m --days 30 --nostruct
//
// Options:
//   --symbols   comma-separated (default TRADING_SYMBOL or BTCUSD)
//   --tf        candle resolution, default 1m
//   --days      look-back window in days, default 7
//   --pivleft   pivot left bars, default 10
//   --pivright  pivot right bars, default 10
//   --vollength volume average length, default 20
//   --volmult   volume surge multiplier, default 1.5
//   --ema       trend EMA length, default 200
//   --atr       ATR length, default 14
//   --stopmult  ATR stop multiple (non-structural), default 1.5
//   --tgtmult   ATR target multiple, default 3.0
//   --nostruct  disable the structural stop (use pure ATR)
//   --buffer    structural stop ATR buffer, default 0.25
//   --size      percent of equity per trade, default 10
//   --capital   starting equity, default 10000
//   --fee       taker fee in bps per leg, default 1 (source: 0.01%)
//   --slip      slippage in bps per leg, default 0
//   --free      ignore fees and slippage entirely

'use strict';

const { downloadCandles, RESOLUTION_SECONDS } = require('./lib/data');

const DEFAULTS = {
  tf: '1m', days: 7, pivleft: 10, pivright: 10, vollength: 20, volmult: 1.5,
  ema: 200, atr: 14, stopmult: 1.5, tgtmult: 3.0, buffer: 0.25,
  size: 10, capital: 10000, fee: 1, slip: 0, free: false,
};

// ---------------------------------------------------------------------------
// Indicators
// ---------------------------------------------------------------------------

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

function atrSeries(candles, len) {
  const tr = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const pc = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
  });
  return rmaSeries(tr, len);
}

// ta.pivothigh: at bar i the pivot candidate sits at i - right.
function pivotHighAt(high, i, left, right) {
  if (i < left + right) return null;
  const p = i - right;
  const v = high[p];
  for (let k = p - left; k < p; k += 1) if (!(v > high[k])) return null;
  for (let k = p + 1; k <= i; k += 1) if (!(v > high[k])) return null;
  return v;
}

function pivotLowAt(low, i, left, right) {
  if (i < left + right) return null;
  const p = i - right;
  const v = low[p];
  for (let k = p - left; k < p; k += 1) if (!(v < low[k])) return null;
  for (let k = p + 1; k <= i; k += 1) if (!(v < low[k])) return null;
  return v;
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

function simulate(candles, opts) {
  const { pivleft, pivright, vollength, volmult, emaLen, atrLen, stopMult, tgtMult,
    useStruct, buffer, sizePct, capital, costPerLeg } = opts;

  const n = candles.length;
  const high = candles.map((c) => c.high);
  const low = candles.map((c) => c.low);
  const close = candles.map((c) => c.close);
  const volume = candles.map((c) => c.volume);

  const volAvg = smaSeries(volume, vollength);
  const emaVal = emaSeries(close, emaLen);
  const atrVal = atrSeries(candles, atrLen);

  let resistance = null;
  let support = null;

  let equity = capital;
  const equityCurve = [equity];
  const trades = [];
  let pos = null;
  let pending = null; // {dir, stop, tgt} to execute at next open

  const closeTrade = (price, index, reason) => {
    const d = pos.dir;
    const units = pos.notional / pos.entry;
    const gross = units * (price - pos.entry) * d;
    const cost = pos.notional * costPerLeg * 2;
    equity += gross - cost;
    equityCurve.push(equity);
    trades.push({
      side: d > 0 ? 'long' : 'short',
      entry: pos.entry,
      exit: price,
      grossPct: (d * (price - pos.entry)) / pos.entry,
      netPct: (d * (price - pos.entry)) / pos.entry - costPerLeg * 2,
      pnl: gross - cost,
      bars: index - pos.entryIndex,
      reason,
      time: candles[index].time,
    });
    pos = null;
  };

  const warmup = Math.max(pivleft + pivright + 1, emaLen, atrLen + 1) + 1;

  for (let i = warmup; i < n; i += 1) {
    // --- 1. execute a pending signal at this bar's open -------------------
    if (pending) {
      if (pos) closeTrade(candles[i].open, i, 'reverse');
      pos = {
        dir: pending.dir,
        entry: candles[i].open,
        stop: pending.stop,
        tgt: pending.tgt,
        entryIndex: i,
        notional: (sizePct / 100) * equity,
      };
      pending = null;
    }

    // --- 2. manage the open position with its frozen stop / target --------
    if (pos) {
      const c = candles[i];
      let hit = null;
      if (pos.dir > 0) {
        if (c.open <= pos.stop) hit = { price: c.open, reason: 'stop' };
        else if (c.low <= pos.stop) hit = { price: pos.stop, reason: 'stop' };
        else if (c.open >= pos.tgt) hit = { price: c.open, reason: 'target' };
        else if (c.high >= pos.tgt) hit = { price: pos.tgt, reason: 'target' };
      } else {
        if (c.open >= pos.stop) hit = { price: c.open, reason: 'stop' };
        else if (c.high >= pos.stop) hit = { price: pos.stop, reason: 'stop' };
        else if (c.open <= pos.tgt) hit = { price: c.open, reason: 'target' };
        else if (c.low <= pos.tgt) hit = { price: pos.tgt, reason: 'target' };
      }
      if (hit) closeTrade(hit.price, i, hit.reason);
    }

    // --- 3. S/R staircase -------------------------------------------------
    const ph = pivotHighAt(high, i, pivleft, pivright);
    const pl = pivotLowAt(low, i, pivleft, pivright);
    if (ph != null) resistance = ph;
    if (pl != null) support = pl;

    // --- 4. signal at the confirmed close ---------------------------------
    if (volAvg[i] == null || emaVal[i] == null || !(atrVal[i] > 0)) continue;
    const volumeSurge = volume[i] > volAvg[i] * volmult;
    const prevClose = close[i - 1];
    if (!volumeSurge) continue;

    const longBreakout = resistance != null && prevClose <= resistance && close[i] > resistance && close[i] > emaVal[i];
    const shortBreakout = support != null && prevClose >= support && close[i] < support && close[i] < emaVal[i];
    if (!longBreakout && !shortBreakout) continue;

    const atr = atrVal[i];
    if (longBreakout) {
      const stop = useStruct && support != null ? support - atr * buffer : close[i] - atr * stopMult;
      pending = { dir: 1, stop, tgt: close[i] + atr * tgtMult };
    } else {
      const stop = useStruct && resistance != null ? resistance + atr * buffer : close[i] + atr * stopMult;
      pending = { dir: -1, stop, tgt: close[i] - atr * tgtMult };
    }
  }

  if (pos) closeTrade(candles[n - 1].close, n - 1, 'eod');

  return { trades, equity, capital };
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

function analyze(candles, opts) {
  const { trades, equity, capital } = simulate(candles, opts);
  const spanDays = (candles[candles.length - 1].time - candles[0].time) / 86400;
  const base = { spanDays, equity, capital, ret: (equity / capital - 1) * 100 };
  if (!trades.length) return { ...base, trades: 0, empty: true, wins: 0, losses: 0 };

  const sum = (f) => trades.reduce((s, t) => s + f(t), 0);
  const n = trades.length;
  const wins = trades.filter((t) => t.netPct > 0);
  const losses = trades.filter((t) => t.netPct <= 0);

  // Drawdown is computed on the compounding equity curve.
  let eq = capital;
  let peak2 = capital;
  let maxDDpct = 0;
  for (const t of trades) {
    eq += t.pnl;
    if (eq > peak2) peak2 = eq;
    const dd = ((peak2 - eq) / peak2) * 100;
    if (dd > maxDDpct) maxDDpct = dd;
  }

  return {
    ...base,
    trades: n,
    perDay: n / spanDays,
    winPct: (wins.length / n) * 100,
    avgHold: sum((t) => t.bars) / n,
    grossPct: sum((t) => t.grossPct) * 100,
    netPct: sum((t) => t.netPct) * 100,
    stopShare: (trades.filter((t) => t.reason === 'stop').length / n) * 100,
    profitFactor: losses.length
      ? sum((t) => Math.max(t.grossPct, 0)) / Math.abs(sum((t) => Math.min(t.grossPct, 0)))
      : Infinity,
    maxDDpct,
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

const num = (v, d) => (v !== undefined ? Number(v) : d);
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

  const days = num(args.days, DEFAULTS.days);
  const symbols = (args.symbols ? String(args.symbols).split(',') : [process.env.TRADING_SYMBOL || 'BTCUSD'])
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  const fee = num(args.fee, DEFAULTS.fee) / 1e4;
  const slip = num(args.slip, DEFAULTS.slip) / 1e4;
  const costPerLeg = DEFAULTS.free || args.free ? 0 : fee + slip;

  const opts = {
    pivleft: num(args.pivleft, DEFAULTS.pivleft),
    pivright: num(args.pivright, DEFAULTS.pivright),
    vollength: num(args.vollength, DEFAULTS.vollength),
    volmult: num(args.volmult, DEFAULTS.volmult),
    emaLen: num(args.ema, DEFAULTS.ema),
    atrLen: num(args.atr, DEFAULTS.atr),
    stopMult: num(args.stopmult, DEFAULTS.stopmult),
    tgtMult: num(args.tgtmult, DEFAULTS.tgtmult),
    useStruct: !args.nostruct,
    buffer: num(args.buffer, DEFAULTS.buffer),
    sizePct: num(args.size, DEFAULTS.size),
    capital: num(args.capital, DEFAULTS.capital),
    costPerLeg,
  };

  console.log(`\nVol-Confirmed S/R Breakout — ${tf} bars, last ${days}d`);
  console.log('='.repeat(120));
  console.log(
    `model   pivot(${opts.pivleft},${opts.pivright}) S/R, vol>${opts.volmult}x SMA(${opts.vollength}), EMA${opts.emaLen}, ` +
      `ATR${opts.atrLen} stop ${opts.stopMult}x${opts.useStruct ? ` (structural +${opts.buffer}ATR)` : ''}, target ${opts.tgtMult}x`
  );
  console.log(
    `sizing  ${opts.sizePct}% of equity per trade (flat, as in the source), start $${opts.capital}` +
      `   |   costs ${costPerLeg > 0 ? `${(costPerLeg * 2 * 1e4).toFixed(1)}bps per trade` : 'NONE (--free)'}`
  );

  const rows = [];
  for (const symbol of symbols) {
    const toSec = Math.floor(Date.now() / 1000);
    const fromSec = toSec - days * 86400;
    try {
      const { candles } = await downloadCandles({ symbol, resolution: tf, fromSec, toSec });
      if (candles.length < 300) {
        rows.push({ symbol, skipped: `only ${candles.length} bars` });
        continue;
      }
      rows.push({ symbol, bars: candles.length, ...analyze(candles, opts) });
    } catch (error) {
      rows.push({ symbol, skipped: error.message });
    }
  }

  console.log(
    `\n${pad('#', 3, true)} | ${pad('symbol', 10)} | ${pad('bars', 6, true)} | ${pad('trades', 6, true)} | ` +
      `${pad('/day', 6, true)} | ${pad('win%', 5, true)} | ${pad('stop%', 6, true)} | ${pad('hold', 5, true)} | ` +
      `${pad('PF', 5, true)} | ${pad('gross%', 8, true)} | ${pad('net%', 8, true)} | ${pad('return%', 9, true)} | ${pad('maxDD%', 7, true)}`
  );
  console.log('-'.repeat(122));

  rows.forEach((r, index) => {
    if (r.skipped) {
      console.log(`${pad(index + 1, 3, true)} | ${pad(r.symbol, 10)} | skipped: ${r.skipped}`);
      return;
    }
    if (r.empty) {
      console.log(
        `${pad(index + 1, 3, true)} | ${pad(r.symbol, 10)} | ${pad(r.bars, 6, true)} | ${pad(0, 6, true)} | ` +
          `${pad(fmt(0, 1), 6, true)} | ${pad('-', 5, true)} | ${pad('-', 6, true)} | ${pad('-', 5, true)} | ` +
          `${pad('-', 5, true)} | ${pad('-', 8, true)} | ${pad('-', 8, true)} | ${pad(signed(r.ret, 2), 9, true)} | ${pad('-', 7, true)}`
      );
      return;
    }
    console.log(
      `${pad(index + 1, 3, true)} | ${pad(r.symbol, 10)} | ${pad(r.bars, 6, true)} | ${pad(r.trades, 6, true)} | ` +
        `${pad(fmt(r.perDay, 1), 6, true)} | ${pad(fmt(r.winPct, 1), 5, true)} | ${pad(fmt(r.stopShare, 0), 6, true)} | ` +
        `${pad(fmt(r.avgHold, 0), 5, true)} | ${pad(fmt(r.profitFactor, 2), 5, true)} | ` +
        `${pad(signed(r.grossPct, 2), 8, true)} | ${pad(signed(r.netPct, 2), 8, true)} | ` +
        `${pad(signed(r.ret, 2), 9, true)} | ${pad(fmt(r.maxDDpct, 1), 7, true)}`
    );
  });

  console.log(
    '\ngross%/net% = summed per-trade return on NOTIONAL over the window; return% = actual equity return\n' +
      `with the source's ${opts.sizePct}% flat sizing (so return% ~= net% x ${opts.sizePct}/100); ` +
      'stop% = share of exits hit by the stop;\nPF uses gross so it measures raw signal quality before costs.'
  );
}

main().catch((error) => {
  console.error('BACKTEST FAILED:', error.message);
  process.exit(1);
});
