// Candle-breakout setups — backtested at a chosen resolution (default 15m).
//
// Four distinct breakout families, all read from the LAST CLOSED bar so a live
// signal and a backtested signal are computed identically:
//
//   range   Donchian range break: close beyond the highest high / lowest low of
//           the prior `breakLen` bars, in the direction of the trend EMA.
//   volume  Same level break, but only when the bar's volume exceeds
//           `volMult` x SMA(volume, volLen). Fewer, higher-conviction entries.
//   squeeze Inside-bar / narrow-range compression: when a bar is the narrowest
//           of the last `narrowLookback` bars its high/low are ARMED as a
//           trigger; a later close beyond either level (within `armBars`) fires.
//   orb     Opening-range breakout: the high/low of the first `orbBars` of each
//           UTC session; the first close beyond either level in the session fires.
//
// Execution model (matches how the live engine trades):
//   * a signal on the closed bar i fills at bar i+1's OPEN (no look-ahead);
//   * one position at a time; a fresh signal while a position is open is ignored;
//   * stop = `stopMult` x ATR(atrLen) from the fill, target = `tgtR` x risk;
//   * when one bar contains both stop and target the STOP fills first
//     (TradingView's pessimistic assumption);
//   * optional ATR trailing stop (`trailMult`) anchored to the prior close, an
//     optional breakeven move (`beAtR` x risk in profit) and a bar-count time
//     exit (`timeExitBars`).
//
// Usage:
//   node backtest/candle-breakouts.js --tf 15m --days 60 --symbols EVAAUSD,BTCUSD,ETHUSD
//   node backtest/candle-breakouts.js --tf 15m --days 60 --family volume
//   node backtest/candle-breakouts.js --tf 15m --days 60 --stopmult 2 --tgtr 2 --trail 2
//
// Options:
//   --symbols   comma-separated (default TRADING_SYMBOL or BTCUSD)
//   --tf        candle resolution, default 15m
//   --days      look-back window in days, default 60
//   --family    all | range | volume | squeeze | orb (default all)
//   --trend     trend EMA length, default 200 (0 disables the filter)
//   --atr       ATR length, default 14
//   --breaklen  Donchian look-back, default 20
//   --vollen    volume average length, default 20
//   --volmult   volume surge multiple, default 1.5
//   --narrow    narrowest-of look-back, default 5
//   --armbars   squeeze trigger validity, default 4
//   --orbbars   opening-range bars, default 4
//   --stopmult  ATR stop multiple, default 1.5
//   --tgtr      target as a multiple of risk, default 2
//   --trail     ATR trail multiple, default 0 (off)
//   --beatr     breakeven at R, default 0 (off)
//   --timeexit  time stop in bars, default 0 (off)
//   --size      percent of equity posted as MARGIN per trade, default 10
//   --lev       leverage on that margin, default 1 (= the notional above)
//   --mmr       maintenance margin rate for the liquidation model, default 0.005
//   --capital   starting equity, default 10000
//   --fee       taker fee in bps per leg, default 5
//   --slip      slippage in bps per leg, default 1
//   --free      ignore fees and slippage entirely

'use strict';

const { downloadCandles, RESOLUTION_SECONDS } = require('./lib/data');

const DEFAULTS = {
  tf: '15m', days: 60, family: 'all', trend: 200, atrLen: 14, breakLen: 20,
  volLen: 20, volMult: 1.5, narrow: 5, armBars: 4, orbBars: 4,
  stopMult: 1.5, tgtR: 2, trail: 0, beAtR: 0, timeExit: 0,
  size: 10, capital: 10000, fee: 5, slip: 1, free: false,
  leverage: 1, mmr: 0.005,
};

const FAMILIES = ['range', 'volume', 'squeeze', 'orb'];

// ---------------------------------------------------------------------------
// Indicators (same maths as src/utils/indicators.js, series form)
// ---------------------------------------------------------------------------

function smaSeries(values, len) {
  const n = values.length;
  const out = new Array(n).fill(null);
  if (!(len > 0) || n < len) return out;
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
  if (!(len > 0) || n < len) return out;
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

// Highest high / lowest low over the `len` bars ENDING at i-1 (excludes i, so a
// breakout compares the closed bar against the range that preceded it).
function donchianHigh(high, i, len) {
  if (i - len < 0) return null;
  let m = -Infinity;
  for (let k = i - len; k < i; k += 1) if (high[k] > m) m = high[k];
  return m;
}

function donchianLow(low, i, len) {
  if (i - len < 0) return null;
  let m = Infinity;
  for (let k = i - len; k < i; k += 1) if (low[k] < m) m = low[k];
  return m;
}

// ---------------------------------------------------------------------------
// Signal generation: one direction per bar (-1 / 0 / +1), closed-bar only
// ---------------------------------------------------------------------------

// Signals are produced with the indicator context already computed.
function makeContext(candles, opts) {
  const high = candles.map((c) => c.high);
  const low = candles.map((c) => c.low);
  const close = candles.map((c) => c.close);
  const volume = candles.map((c) => c.volume);
  return {
    high,
    low,
    close,
    volume,
    ema: opts.trend > 0 ? emaSeries(close, opts.trend) : null,
    atr: atrSeries(candles, opts.atrLen),
    volSma: smaSeries(volume, opts.volLen),
  };
}

// Trend gate: longs only above the EMA, shorts only below. A missing EMA value
// (warm-up, or the filter disabled) lets both sides through.
function trendAllows(ctx, i, dir) {
  if (!ctx.ema) return true;
  const e = ctx.ema[i];
  if (e == null) return false;
  return dir > 0 ? ctx.close[i] > e : ctx.close[i] < e;
}

// range / volume share the Donchian break; `volume` adds the surge filter.
function levelBreakDir(ctx, i, volumeConfirmed, opts) {
  const up = donchianHigh(ctx.high, i, opts.breakLen);
  const dn = donchianLow(ctx.low, i, opts.breakLen);
  if (up == null || dn == null) return 0;

  if (volumeConfirmed) {
    const vs = ctx.volSma[i];
    if (vs == null || !(ctx.volume[i] > vs * opts.volMult)) return 0;
  }

  if (ctx.close[i] > up && trendAllows(ctx, i, 1)) return 1;
  if (ctx.close[i] < dn && trendAllows(ctx, i, -1)) return -1;
  return 0;
}

// Inside-bar / narrow-range squeeze: arm the trigger on a compression bar, then
// fire on the first later close beyond either level (within `armBars`).
function squeezeSignals(ctx, opts) {
  const n = ctx.high.length;
  const dirs = new Array(n).fill(0);
  let hi = null;
  let lo = null;
  let expiresAt = -1;

  for (let i = 1; i < n; i += 1) {
    // Fire before re-arming, so a break of the fresh compression bar is not
    // consumed by a stale trigger.
    if (i <= expiresAt && hi != null) {
      if (ctx.close[i] > hi && trendAllows(ctx, i, 1)) {
        dirs[i] = 1;
        expiresAt = -1;
        hi = null;
        lo = null;
        continue;
      }
      if (ctx.close[i] < lo && trendAllows(ctx, i, -1)) {
        dirs[i] = -1;
        expiresAt = -1;
        hi = null;
        lo = null;
        continue;
      }
    }

    // Compression test: this bar's range is the narrowest of the look-back.
    let narrow = true;
    const from = Math.max(0, i - (opts.narrow - 1));
    for (let k = from; k < i; k += 1) {
      if (ctx.high[k] - ctx.low[k] <= ctx.high[i] - ctx.low[i]) {
        narrow = false;
        break;
      }
    }
    if (narrow) {
      hi = ctx.high[i];
      lo = ctx.low[i];
      expiresAt = i + opts.armBars;
    }
  }
  return dirs;
}

// Opening-range breakout: the high/low of the first `orbBars` bars of each UTC
// session; the first close beyond either level in the session fires.
function openingRangeSignals(candles, ctx, opts) {
  const n = candles.length;
  const dirs = new Array(n).fill(0);
  let session = null;
  let barsIn = 0;
  let orHigh = -Infinity;
  let orLow = Infinity;
  let longDone = false;
  let shortDone = false;

  for (let i = 0; i < n; i += 1) {
    // Candle times are epoch SECONDS (see lib/data.js), so a UTC day is 86400.
    const day = Math.floor(candles[i].time / 86400);
    if (day !== session) {
      session = day;
      barsIn = 0;
      orHigh = -Infinity;
      orLow = Infinity;
      longDone = false;
      shortDone = false;
    }

    if (barsIn < opts.orbBars) {
      if (ctx.high[i] > orHigh) orHigh = ctx.high[i];
      if (ctx.low[i] < orLow) orLow = ctx.low[i];
      barsIn += 1;
      continue; // still building the opening range
    }

    if (!longDone && ctx.close[i] > orHigh && trendAllows(ctx, i, 1)) {
      dirs[i] = 1;
      longDone = true;
    } else if (!shortDone && ctx.close[i] < orLow && trendAllows(ctx, i, -1)) {
      dirs[i] = -1;
      shortDone = true;
    }
  }
  return dirs;
}

function buildDirs(candles, ctx, opts, family) {
  if (family === 'squeeze') return squeezeSignals(ctx, opts);
  if (family === 'orb') return openingRangeSignals(candles, ctx, opts);

  const volumeConfirmed = family === 'volume';
  const n = candles.length;
  const dirs = new Array(n).fill(0);
  for (let i = 0; i < n; i += 1) dirs[i] = levelBreakDir(ctx, i, volumeConfirmed, opts);
  return dirs;
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

function simulate(candles, ctx, dirs, opts) {
  const { atr, high, low, close } = ctx;
  const { stopMult, tgtR, trail, beAtR, timeExit, sizePct, capital, costPerLeg, leverage, mmr } = opts;

  let equity = capital;
  const trades = [];
  let pos = null;
  let stopDistSum = 0;
  let stopDistN = 0;

  const closeTrade = (price, i, reason) => {
    const d = pos.dir;
    const units = pos.notional / pos.entry;
    // Isolated margin: a liquidation loses the posted margin and nothing more.
    const liquidated = reason === 'liquidated';
    const gross = liquidated ? -pos.margin : units * (price - pos.entry) * d;
    const cost = liquidated ? 0 : pos.notional * costPerLeg * 2;
    const movePct = liquidated ? -(pos.margin / pos.notional) : (d * (price - pos.entry)) / pos.entry;
    equity += gross - cost;
    trades.push({
      side: d > 0 ? 'long' : 'short',
      entry: pos.entry,
      exit: price,
      grossPct: movePct,
      netPct: movePct - (liquidated ? 0 : costPerLeg * 2),
      pnl: gross - cost,
      bars: i - pos.entryIndex,
      reason,
      time: candles[i].time,
    });
    pos = null;
  };

  const warmup = Math.max(opts.trend || 0, opts.atrLen + 1, opts.breakLen) + 1;

  for (let i = warmup; i < candles.length; i += 1) {
    // 1. manage the open position against this bar -------------------------
    if (pos) {
      const c = candles[i];
      // Optional breakeven / ATR trail, anchored to the PRIOR closed bar.
      if (trail > 0 && i - 1 >= 0 && atr[i - 1] > 0) {
        const anchor = close[i - 1];
        const peak = pos.dir > 0 ? Math.max(pos.peak, anchor) : Math.min(pos.peak, anchor);
        pos.peak = peak;
        const risk = Math.abs(pos.entry - pos.stop);
        const cand = [pos.stop];
        if (beAtR > 0 && risk > 0 && (peak - pos.entry) * pos.dir >= beAtR * risk) cand.push(pos.entry);
        cand.push(peak - pos.dir * trail * atr[i - 1]);
        const next = pos.dir > 0 ? Math.max(...cand) : Math.min(...cand);
        if (pos.dir > 0 ? next > pos.stop : next < pos.stop) pos.stop = next;
      }

      // Liquidation takes precedence over the stop whenever the exchange's
      // liquidation price sits NEARER than the stop. Above roughly
      // leverage = 1 / stopDistance the stop is fiction: every stop-out would
      // really be a liquidation, i.e. a total loss of the posted margin.
      let hit = null;
      const curStopDist = Math.abs(pos.entry - pos.stop) / pos.entry;
      if (pos.liqDist <= curStopDist) {
        const liqPrice =
          pos.liqDist <= 0
            ? pos.entry
            : pos.dir > 0
              ? pos.entry * (1 - pos.liqDist)
              : pos.entry * (1 + pos.liqDist);
        const reached = pos.liqDist <= 0 || (pos.dir > 0 ? c.low <= liqPrice : c.high >= liqPrice);
        if (reached) hit = { price: liqPrice, reason: 'liquidated' };
      }

      if (!hit && pos.dir > 0) {
        if (c.open <= pos.stop) hit = { price: c.open, reason: 'stop' };
        else if (c.low <= pos.stop) hit = { price: pos.stop, reason: 'stop' };
        else if (c.open >= pos.tgt) hit = { price: c.open, reason: 'target' };
        else if (c.high >= pos.tgt) hit = { price: pos.tgt, reason: 'target' };
      } else if (!hit) {
        if (c.open >= pos.stop) hit = { price: c.open, reason: 'stop' };
        else if (c.high >= pos.stop) hit = { price: pos.stop, reason: 'stop' };
        else if (c.open <= pos.tgt) hit = { price: c.open, reason: 'target' };
        else if (c.low <= pos.tgt) hit = { price: pos.tgt, reason: 'target' };
      }
      if (hit) closeTrade(hit.price, i, hit.reason);
      else if (timeExit > 0 && i - pos.entryIndex >= timeExit) closeTrade(c.close, i, 'time');
    }

    // 2. execute yesterday's signal at this bar's open, then look for a new one
    if (!pos && dirs[i - 1] !== 0 && atr[i - 1] > 0) {
      const dir = dirs[i - 1];
      const entry = candles[i].open;
      const risk = stopMult * atr[i - 1];
      const stop = dir > 0 ? entry - risk : entry + risk;
      const tgt = dir > 0 ? entry + tgtR * risk : entry - tgtR * risk;
      const margin = (sizePct / 100) * equity;
      stopDistSum += risk / entry;
      stopDistN += 1;
      pos = {
        dir,
        entry,
        stop,
        tgt,
        entryIndex: i,
        peak: entry,
        margin,
        notional: margin * leverage,
        stopDist: risk / entry,
        // Distance from entry at which the exchange liquidates this isolated
        // position: 1 / leverage, less the maintenance margin requirement.
        liqDist: leverage > 0 ? 1 / leverage - mmr : Infinity,
      };
    }
  }

  if (pos) closeTrade(candles[candles.length - 1].close, candles.length - 1, 'eod');
  return { trades, equity, capital, stopDistAvg: stopDistN ? stopDistSum / stopDistN : 0 };
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

function analyze(candles, opts, family) {
  const ctx = makeContext(candles, opts);
  const dirs = buildDirs(candles, ctx, opts, family);
  const { trades, equity, capital, stopDistAvg } = simulate(candles, ctx, dirs, opts);
  const spanDays = (candles[candles.length - 1].time - candles[0].time) / 86400;
  // The average stop distance sets the leverage ceiling: above 1 / stopDist the
  // exchange liquidates before the stop can ever fill.
  const base = {
    spanDays,
    equity,
    capital,
    ret: (equity / capital - 1) * 100,
    stopDistPct: stopDistAvg * 100,
    levCeiling: stopDistAvg > 0 ? 1 / stopDistAvg : Infinity,
  };

  const n = trades.length;
  if (!n) return { ...base, trades: 0, empty: true };

  const sum = (f) => trades.reduce((s, t) => s + f(t), 0);
  const wins = trades.filter((t) => t.netPct > 0);
  const losses = trades.filter((t) => t.netPct <= 0);
  const grossWin = sum((t) => Math.max(t.grossPct, 0));
  const grossLoss = Math.abs(sum((t) => Math.min(t.grossPct, 0)));

  let eq = capital;
  let peak = capital;
  let maxDDpct = 0;
  for (const t of trades) {
    eq += t.pnl;
    if (eq > peak) peak = eq;
    const dd = ((peak - eq) / peak) * 100;
    if (dd > maxDDpct) maxDDpct = dd;
  }

  return {
    ...base,
    trades: n,
    perDay: n / spanDays,
    winPct: (wins.length / n) * 100,
    avgHold: sum((t) => t.bars) / n,
    avgWin: wins.length ? (sum((t) => (wins.includes(t) ? t.netPct : 0)) / wins.length) * 100 : 0,
    avgLoss: losses.length ? (sum((t) => (losses.includes(t) ? t.netPct : 0)) / losses.length) * 100 : 0,
    netPct: sum((t) => t.netPct) * 100,
    expectancy: (sum((t) => t.netPct) / n) * 100,
    stopShare: (trades.filter((t) => t.reason === 'stop').length / n) * 100,
    liqShare: (trades.filter((t) => t.reason === 'liquidated').length / n) * 100,
    profitFactor: grossLoss ? grossWin / grossLoss : Infinity,
    maxDDpct,
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
  const costPerLeg = DEFAULTS.free || args.free ? 0 : fee + slip;

  const opts = {
    trend: num(args.trend, DEFAULTS.trend),
    atrLen: num(args.atr, DEFAULTS.atrLen),
    breakLen: num(args.breaklen, DEFAULTS.breakLen),
    volLen: num(args.vollen, DEFAULTS.volLen),
    volMult: num(args.volmult, DEFAULTS.volMult),
    narrow: num(args.narrow, DEFAULTS.narrow),
    armBars: num(args.armbars, DEFAULTS.armBars),
    orbBars: num(args.orbbars, DEFAULTS.orbBars),
    stopMult: num(args.stopmult, DEFAULTS.stopMult),
    tgtR: num(args.tgtr, DEFAULTS.tgtR),
    trail: num(args.trail, DEFAULTS.trail),
    beAtR: num(args.beatr, DEFAULTS.beAtR),
    timeExit: num(args.timeexit, DEFAULTS.timeExit),
    sizePct: num(args.size, DEFAULTS.size),
    capital: num(args.capital, DEFAULTS.capital),
    leverage: Math.max(1, num(args.lev, DEFAULTS.leverage)),
    mmr: num(args.mmr, DEFAULTS.mmr),
    costPerLeg,
  };

  const families = !args.family || args.family === 'all'
    ? FAMILIES
    : String(args.family).split(',').map((f) => f.trim()).filter((f) => FAMILIES.includes(f));
  if (!families.length) {
    console.error(`--family must be one of: all, ${FAMILIES.join(', ')}`);
    process.exit(1);
  }

  console.log(`\nCandle-breakout setups — ${tf} bars, last ${days}d`);
  console.log('='.repeat(126));
  console.log(
    `model   trend EMA${opts.trend}, ATR${opts.atrLen} stop ${opts.stopMult}x, target ${opts.tgtR}R` +
      `${opts.trail > 0 ? `, trail ${opts.trail}xATR` : ''}${opts.beAtR > 0 ? `, BE at ${opts.beAtR}R` : ''}` +
      `${opts.timeExit > 0 ? `, time exit ${opts.timeExit} bars` : ''}`
  );
  console.log(
    `sizing  ${opts.sizePct}% of equity posted as margin at ${opts.leverage}x ` +
      `(notional ${((opts.sizePct / 100) * opts.leverage * 100).toFixed(0)}% of equity), start $${opts.capital}` +
      `   |   costs ${costPerLeg > 0 ? `${(costPerLeg * 2 * 1e4).toFixed(1)}bps per round trip` : 'NONE (--free)'}`
  );

  const rows = [];
  for (const symbol of symbols) {
    const toSec = Math.floor(Date.now() / 1000);
    const fromSec = toSec - days * 86400;
    let candles;
    try {
      ({ candles } = await downloadCandles({ symbol, resolution: tf, fromSec, toSec }));
    } catch (error) {
      for (const family of families) rows.push({ symbol, family, skipped: error.message });
      continue;
    }
    if (candles.length < opts.trend + opts.breakLen + 20) {
      for (const family of families) rows.push({ symbol, family, skipped: `only ${candles.length} bars` });
      continue;
    }
    for (const family of families) {
      rows.push({ symbol, family, bars: candles.length, ...analyze(candles, opts, family) });
    }
  }

  console.log(
    `\n${pad('#', 3, true)} | ${pad('symbol', 10)} | ${pad('family', 8)} | ${pad('bars', 6, true)} | ` +
      `${pad('trades', 6, true)} | ${pad('/day', 6, true)} | ${pad('win%', 5, true)} | ${pad('stop%', 6, true)} | ` +
      `${pad('hold', 5, true)} | ${pad('liq%', 6, true)} | ${pad('PF', 5, true)} | ${pad('exp%', 7, true)} | ${pad('net%', 8, true)} | ` +
      `${pad('return%', 8, true)} | ${pad('maxDD%', 7, true)}`
  );
  console.log('-'.repeat(138));

  rows.forEach((r, index) => {
    if (r.skipped) {
      console.log(`${pad(index + 1, 3, true)} | ${pad(r.symbol, 10)} | ${pad(r.family, 8)} | skipped: ${r.skipped}`);
      return;
    }
    if (r.empty) {
      console.log(
        `${pad(index + 1, 3, true)} | ${pad(r.symbol, 10)} | ${pad(r.family, 8)} | ${pad(r.bars, 6, true)} | ` +
          `${pad(0, 6, true)} | ${pad(fmt(0, 1), 6, true)} | ${pad('-', 5, true)} | ${pad('-', 6, true)} | ` +
          `${pad('-', 5, true)} | ${pad('-', 6, true)} | ${pad('-', 5, true)} | ${pad('-', 7, true)} | ${pad('-', 8, true)} | ` +
          `${pad(signed(r.ret, 2), 8, true)} | ${pad('-', 7, true)}`
      );
      return;
    }
    console.log(
      `${pad(index + 1, 3, true)} | ${pad(r.symbol, 10)} | ${pad(r.family, 8)} | ${pad(r.bars, 6, true)} | ` +
        `${pad(r.trades, 6, true)} | ${pad(fmt(r.perDay, 1), 6, true)} | ${pad(fmt(r.winPct, 1), 5, true)} | ` +
        `${pad(fmt(r.stopShare, 0), 6, true)} | ${pad(fmt(r.avgHold, 0), 5, true)} | ${pad(fmt(r.liqShare, 0), 6, true)} | ` +
        `${pad(fmt(r.profitFactor, 2), 5, true)} | ` +
        `${pad(signed(r.expectancy, 2), 7, true)} | ${pad(signed(r.netPct, 2), 8, true)} | ` +
        `${pad(signed(r.ret, 2), 8, true)} | ${pad(fmt(r.maxDDpct, 1), 7, true)}`
    );
  });

  console.log(
    '\nexp% = average per-trade return on NOTIONAL (net of costs); net% = the sum over the window;\n' +
      'return% = actual equity return (compounding, margin x leverage); PF uses gross, so it measures raw signal quality.\n' +
      'liq% = share of trades the exchange liquidated before the stop could fill.'
  );
}

main().catch((error) => {
  console.error('BACKTEST FAILED:', error.message);
  process.exit(1);
});
