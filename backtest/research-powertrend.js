// Backtest of "Powertrend - Volume Range Filter [wbburgin]" (Pine v5) on Delta
// Exchange candles.
//
// The script imports `wbburgin/wbburgin_utils/2`. Two helpers come from that
// library and are ported here from their canonical (DonovanWall "Range Filter")
// definition:
//
//   smoothrng(source, length, mult) :
//       wper    = length * 2 - 1
//       avrng   = ta.ema(math.abs(source - source[1]), length)
//       return    ta.ema(avrng, wper) * mult
//
//   trendUp(source) :  a RISING-STREAK COUNTER (not a boolean!)
//       upward = source > source[1] ? upward[1] + 1
//              : source < source[1] ? 0
//              : upward[1]
//       Used as `uprng and ...` it is truthy whenever upward > 0, i.e. the
//       filter's last *change* was upward. Crucially it HOLDS at its previous
//       value on a flat bar — which is exactly the bar a breakout prints on,
//       because the filter is only free to move while its tether (volume)
//       moves. A strict `source > source[1]` reads as a trend too but is FALSE
//       on those flat bars, which silently kills every signal. This was the
//       original bug in this port (fixed by using the counter semantics).
//
// Everything else is verbatim. With the script's DEFAULT inputs the three
// optional filters are all OFF (useadx / usehl / usevwma = false), so the
// strategy collapses to a long-only range-filter breakout:
//
//   smooth   = smoothrng(close, 200, 3)
//   volrng   = rngfilt_volumeadj(close, volume, smooth)   // ATR-style tethered range
//   hband    = volrng + smooth
//   lowband  = volrng - smooth
//   uprng    = trendUp(volrng)
//
//   b (long  entry) =  uprng and ta.crossover(close, hband)
//   s (long  exit ) = not uprng and ta.crossunder(close, lowband)
//   strategy.entry("Long") on b ;  strategy.close("Long") on s
//
// rngfilt_volumeadj is the interesting part: instead of tethering the range
// filter to its own previous value against CLOSE, the "tether source" is
// VOLUME. While volume is rising the filter may only ratchet UP (it is pinned
// at max(close - smooth, prev) -> a rising-volume bar can never pull the band
// down); while volume is falling it may only ratchet DOWN, at
// min(close + smooth, prev). The band therefore tracks the DIRECTION OF VOLUME
// rather than the direction of price.
//
// Modelling choices (kept honest):
//   * the strategy declares NO process_orders_on_close, so Pine fills market
//     orders on the OPEN of the NEXT bar — modelled here.
//   * commission_value = 0.00 and slippage = 0 in the script; we report the
//     pure signal edge AND the net after Delta retail costs
//     (taker 5 bps + 2 bps slippage per leg, both legs market).
//   * default_qty_type = percent_of_equity, default_qty_value = 10, so notional
//     is a flat 10% of a $1,000 account and P&L does not compound.
//   * long only as written; a REVERSED run (short the same signals) is reported
//     alongside for comparison.
//
//   node backtest/research-powertrend.js
//   node backtest/research-powertrend.js --days 7 --tf 1m
//   node backtest/research-powertrend.js --symbols BTCUSD,ETHUSD --tf 15m

'use strict';

const { loadCache } = require('./lib/data');

const ALL_SYMBOLS = ['BTCUSD', 'ETHUSD', 'SOLUSD', 'XRPUSD', 'DOGEUSD'];
const RES_SEC = { '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400 };
const SWEEP = ['1m', '5m', '15m', '1h'];

const CFG = {
  initialEquity: 1000, // strategy initial_capital = 1000
  notionalPct: 10, // default_qty_value = 10 (% of equity)
  feeTaker: 0.0005, // 5 bps
  slippage: 0.0002, // 2 bps, market legs only
};

const STRAT = {
  l: 200, // "Length"
  mult: 3, // Range Multiplier passed to smoothrng
  useadx: false, // ADX filter (off by default)
  usehl: false, // Range Supertrend filter (off by default)
  usevwma: false, // VWMA filter (off by default)
};

// ---------------------------------------------------------------------------
// indicators
// ---------------------------------------------------------------------------

// Pine ta.ema: SMA seed once `len` non-null values have been seen, then the
// recursive form. Leading nulls are skipped (they simply delay the seed).
function ema(values, len) {
  const n = values.length;
  const out = new Array(n).fill(null);
  const k = 2 / (len + 1);
  let sum = 0;
  let count = 0;
  let prev = null;
  for (let i = 0; i < n; i += 1) {
    const v = values[i];
    if (v == null) continue;
    if (prev == null) {
      sum += v;
      count += 1;
      if (count >= len) {
        prev = sum / len;
        out[i] = prev;
      }
    } else {
      prev = v * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

// utils.smoothrng(source, length, mult)
function smoothrng(values, length, mult) {
  const n = values.length;
  const diff = new Array(n).fill(null);
  for (let i = 1; i < n; i += 1) diff[i] = Math.abs(values[i] - values[i - 1]);
  const avrng = ema(diff, length);
  const sm = ema(avrng, length * 2 - 1);
  return sm.map((v) => (v == null ? null : v * mult));
}

// rngfilt_volumeadj(source1 = close, tethersource = volume, smoothrng)
function rngfiltVolumeAdj(closes, volumes, smooth) {
  const n = closes.length;
  const out = new Array(n).fill(null);
  let prev = null;
  for (let i = 0; i < n; i += 1) {
    if (smooth[i] == null) continue;
    const prevRng = prev == null ? 0 : prev; // nz(rngfilt[1])
    const tetherPrev = i > 0 && volumes[i - 1] != null ? volumes[i - 1] : 0; // nz(tethersource[1])
    let val;
    if (volumes[i] > tetherPrev) {
      const cand = closes[i] - smooth[i];
      val = cand < prevRng ? prevRng : cand;
    } else {
      const cand = closes[i] + smooth[i];
      val = cand > prevRng ? prevRng : cand;
    }
    out[i] = val;
    prev = val;
  }
  return out;
}

function crossOver(a, b, i) {
  if (i < 1) return false;
  const a0 = a[i - 1];
  const b0 = b[i - 1];
  const a1 = a[i];
  const b1 = b[i];
  if (a0 == null || b0 == null || a1 == null || b1 == null) return false;
  return a0 <= b0 && a1 > b1;
}

function crossUnder(a, b, i) {
  if (i < 1) return false;
  const a0 = a[i - 1];
  const b0 = b[i - 1];
  const a1 = a[i];
  const b1 = b[i];
  if (a0 == null || b0 == null || a1 == null || b1 == null) return false;
  return a0 >= b0 && a1 < b1;
}

function signals(candles) {
  const n = candles.length;
  const closes = candles.map((c) => c.close);
  const vols = candles.map((c) => c.volume || 0);

  const smooth = smoothrng(closes, STRAT.l, STRAT.mult);
  const volrng = rngfiltVolumeAdj(closes, vols, smooth);
  const hband = volrng.map((v, i) => (v == null || smooth[i] == null ? null : v + smooth[i]));
  const lowband = volrng.map((v, i) => (v == null || smooth[i] == null ? null : v - smooth[i]));

  // utils.trendUp(basetype): rising-streak counter; truthy when the last change
  // was upward. Holds its value (and so its sign) on flat bars.
  const uprng = new Array(n).fill(false);
  let upward = 0;
  for (let i = 1; i < n; i += 1) {
    if (volrng[i] == null || volrng[i - 1] == null) continue;
    if (volrng[i] > volrng[i - 1]) upward += 1;
    else if (volrng[i] < volrng[i - 1]) upward = 0;
    uprng[i] = upward > 0;
  }

  const entry = new Array(n).fill(false);
  const exit = new Array(n).fill(false);
  for (let i = 1; i < n; i += 1) {
    entry[i] = uprng[i] && crossOver(closes, hband, i);
    exit[i] = !uprng[i] && crossUnder(closes, lowband, i);
  }
  return { entry, exit, uprng, hband, lowband, volrng, smooth };
}

// ---------------------------------------------------------------------------
// simulation — long only (as written), fills on the NEXT bar's open
// ---------------------------------------------------------------------------

function simulate(candles, sg, barSec, reverse) {
  const n = candles.length;
  const notional = (CFG.initialEquity * CFG.notionalPct) / 100;
  const trades = [];
  let pos = null;

  const closePos = (price, time, reason) => {
    pos.exitRaw = price;
    pos.exitTime = time;
    pos.exitReason = reason;
    trades.push(pos);
    pos = null;
  };

  for (let i = 1; i < n; i += 1) {
    const bar = candles[i];
    const p = i - 1; // signal bar

    if (pos) {
      const want = reverse ? sg.entry[p] : sg.exit[p]; // mirrored systems are exact opposites
      if (want) closePos(bar.open, bar.time, 'band');
    }
    const trigger = reverse ? sg.exit[p] : sg.entry[p];
    if (trigger && !pos) {
      pos = {
        side: reverse ? 'short' : 'long',
        dir: reverse ? -1 : 1,
        entryRaw: bar.open,
        entryTime: bar.time,
      };
    }
  }
  if (pos) closePos(candles[n - 1].close, candles[n - 1].time, 'open');

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
  for (const t of trades) {
    const d = byDay.get(t.day) || { n: 0, net: 0, gross: 0 };
    d.n += 1;
    d.net += t.net;
    d.gross += t.gross;
    byDay.set(t.day, d);
  }

  return {
    n,
    gross: sum((t) => t.gross),
    net: sum((t) => t.net),
    costs: sum((t) => t.fees),
    winPct: n ? (wins / n) * 100 : 0,
    pf: gl > 0 ? gp / gl : gp > 0 ? Infinity : 0,
    avgPct: n ? (sum((t) => t.pct) / n) * 100 : 0,
    avgBars: n ? sum((t) => t.bars) / n : 0,
    maxDd,
    byDay,
    greenDays: [...byDay.values()].filter((v) => v.net > 0).length,
    days: byDay.size,
  };
}

const f2 = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;
const pct = (v) => `${v.toFixed(1)}%`;
const pf = (v) => (v === Infinity ? 'inf' : v.toFixed(2));

function line(label, m, days) {
  console.log(
    `  ${label.padEnd(18)} trades ${String(m.n).padStart(4)} (${(m.n / days).toFixed(1)}/day)  ` +
      `win% ${pct(m.winPct).padStart(6)}  PF ${pf(m.pf).padStart(5)}  ` +
      `avg move ${m.avgPct >= 0 ? '+' : ''}${m.avgPct.toFixed(3)}%  ` +
      `gross $${f2(m.gross).padStart(7)} - cost $${m.costs.toFixed(2).padStart(6)} = net $${f2(m.net).padStart(7)} ` +
      `(${((m.net / CFG.initialEquity) * 100).toFixed(2)}%)  maxDD $${f2(m.maxDd)}  hold ${m.avgBars.toFixed(0)} bars`,
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
  const a = { days: 7, symbols: ALL_SYMBOLS, tf: '1m', sweep: false };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--days') a.days = Number(argv[++i]);
    else if (argv[i] === '--symbols') a.symbols = String(argv[++i]).split(',').map((s) => s.trim().toUpperCase());
    else if (argv[i] === '--tf') a.tf = String(argv[++i]);
    else if (argv[i] === '--sweep') a.sweep = true;
  }
  return a;
}

function main() {
  const args = parseArgs(process.argv);
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

  console.log('='.repeat(126));
  console.log(' Powertrend - Volume Range Filter [wbburgin] (Pine v5) — backtest on Delta Exchange   [long only as written]');
  console.log(` range filter length ${STRAT.l}, multiplier ${STRAT.mult}   tether = VOLUME   filters: adx=${STRAT.useadx} hl=${STRAT.usehl} vwma=${STRAT.usevwma}`);
  console.log(` ${args.tf} bars   data ${new Date(first[0].time * 1000).toISOString().slice(0, 16)} -> ` +
    `${new Date(first[first.length - 1].time * 1000).toISOString().slice(0, 16)} UTC   report window = last ${args.days} calendar days`);
  console.log(` sizing notional ${CFG.notionalPct}% of $${CFG.initialEquity}   fills at NEXT bar open (Pine default)   ` +
    `costs taker ${(CFG.feeTaker * 1e4).toFixed(1)}bps + slip ${(CFG.slippage * 1e4).toFixed(1)}bps per leg`);
  console.log('='.repeat(126));

  const agg = { normal: { net: 0, n: 0, gross: 0 }, rev: { net: 0, n: 0, gross: 0 } };

  console.log(`\n\n########  ${args.tf} — LONG (as written) vs REVERSED — LAST ${args.days} DAYS  ########`);
  for (const [sym, candles] of data) {
    const sg = signals(candles);
    const nat = lastNDays(simulate(candles, sg, barSec, false), args.days);
    const rev = lastNDays(simulate(candles, sg, barSec, true), args.days);
    const mn = metrics(nat);
    const mr = metrics(rev);
    agg.normal.net += mn.net; agg.normal.n += mn.n; agg.normal.gross += mn.gross;
    agg.rev.net += mr.net; agg.rev.n += mr.n; agg.rev.gross += mr.gross;
    console.log('');
    if (!nat.length) console.log(`  ${sym.padEnd(18)} no trades`);
    else line(`${sym} LONG`, mn, args.days);
    if (rev.length) line(`${sym} REVERSED`, mr, args.days);
  }

  // --- timeframe sweep on the primary symbol ------------------------------
  console.log(`\n\n########  ${primary} — TIMEFRAME SWEEP (last ${args.days} days, LONG as written)  ########`);
  for (const tf of SWEEP) {
    const cached = loadCache(primary, tf);
    if (!cached || !cached.candles || !cached.candles.length) {
      console.log(`  ${tf.padEnd(4)} no cache`);
      continue;
    }
    const bs = RES_SEC[tf];
    const sg = signals(cached.candles);
    const t = lastNDays(simulate(cached.candles, sg, bs, false), args.days);
    if (!t.length) {
      console.log(`  ${tf.padEnd(4)} no trades`);
      continue;
    }
    line(tf.padEnd(4), metrics(t), args.days);
  }

  const candlesP = data.get(primary);
  const tP = lastNDays(simulate(candlesP, signals(candlesP), barSec, false), args.days);
  console.log(`\n\n--- ${primary} ${args.tf} — LONG — daily (last ${args.days} days) ---`);
  if (!tP.length) {
    console.log('  no trades');
  } else {
    line('TOTAL', metrics(tP), args.days);
    printDaily(tP);
  }

  console.log('\n\n########  SUMMARY (portfolio of symbols)  ########');
  const eq = CFG.initialEquity * data.size;
  console.log(
    `  LONG      ${String(agg.normal.n).padStart(5)} trades  gross $${f2(agg.normal.gross).padStart(9)}  net $${f2(agg.normal.net).padStart(9)}  (${((agg.normal.net / eq) * 100).toFixed(2)}% of $${eq})`,
  );
  console.log(
    `  REVERSED  ${String(agg.rev.n).padStart(5)} trades  gross $${f2(agg.rev.gross).padStart(9)}  net $${f2(agg.rev.net).padStart(9)}  (${((agg.rev.net / eq) * 100).toFixed(2)}% of $${eq})`,
  );
  console.log('');
}

if (require.main === module) main();

module.exports = { signals, simulate, metrics, smoothrng, rngfiltVolumeAdj, CFG, STRAT };
