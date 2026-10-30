// Backtest of the "TK Cross > EMA200 Strat" (Pine v3) on Delta Exchange candles.
//
// Original logic (the whole thing):
//
//   ema200     = ema(close, 200)
//   donchian(n)= avg(lowest(n), highest(n))          // (lowest low + highest high)/2
//   conversion = donchian(20)                        // Ichimoku Tenkan
//   base       = donchian(60)                        // Ichimoku Kijun
//   lead1      = avg(conversion, base)               // Senkou A   (plot only)
//   lead2      = donchian(120)                       // Senkou B   (plot only)
//
//   strategy.entry('tkcross', strategy.long,
//                  qty = strategy.initial_capital / close,
//                  when = conversion > base and close > ema200)
//   strategy.close('tkcross', when = conversion < base)
//
// So: LONG ONLY, no short side, no stop, no target.
//   * enter long the moment the TK line turns up (conversion > base) while price
//     is above the 200 EMA,
//   * go flat the moment the TK line turns back down (conversion < base).
// `qty = initial_capital / close` is a FIXED notional equal to the account —
// the initial capital, not the live equity — so P&L does not compound.
//
// Modelling notes:
//   * signals are read off the last CLOSED bar and fill at that close (the live
//     bot reads the same completed bar). The lead-line plots are decorative.
//   * pyramiding = 0 in Pine, so a re-entry while already long is ignored.
//   * costs: taker 5 bps + 2 bps slippage per leg.
//
// A REVERSED run (short the exact same signals, flat on the mirror exit) is
// reported alongside for comparison.
//
//   node backtest/research-tk-cross.js
//   node backtest/research-tk-cross.js --tf 15m --days 7
//   node backtest/research-tk-cross.js --symbols BTCUSD --sweep

'use strict';

const { loadCache } = require('./lib/data');

const ALL_SYMBOLS = ['BTCUSD', 'ETHUSD', 'SOLUSD', 'XRPUSD', 'DOGEUSD'];
const RES_SEC = { '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400 };
const SWEEP = ['1m', '15m', '1h', '4h'];

const CFG = {
  initialEquity: 1200,
  notionalPct: 100, // qty = initial_capital / close -> fixed notional = the account
  feeTaker: 0.0005, // 5 bps
  slippage: 0.0002, // 2 bps
};

const STRAT = {
  emaLen: 200,
  conversionPeriods: 20,
  basePeriods: 60,
  laggingSpan2Periods: 120,
  displacement: 30,
};

// ---------------------------------------------------------------------------
// indicators
// ---------------------------------------------------------------------------

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

// donchian(len) = avg(lowest(low, len), highest(high, len))
function donchian(highs, lows, len) {
  const hh = rolling(highs, len, Math.max);
  const ll = rolling(lows, len, Math.min);
  return hh.map((h, i) => (h == null || ll[i] == null ? null : (h + ll[i]) / 2));
}

function signals(candles) {
  const n = candles.length;
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);

  const ema200 = ema(closes, STRAT.emaLen);
  const conversion = donchian(highs, lows, STRAT.conversionPeriods);
  const base = donchian(highs, lows, STRAT.basePeriods);

  const entry = new Array(n).fill(false);
  const exit = new Array(n).fill(false);
  for (let i = 0; i < n; i += 1) {
    if (conversion[i] == null || base[i] == null) continue;
    entry[i] = conversion[i] > base[i] && ema200[i] != null && closes[i] > ema200[i];
    exit[i] = conversion[i] < base[i];
  }
  return { entry, exit, conversion, base, ema200 };
}

// ---------------------------------------------------------------------------
// simulation (long only, flat on the mirror exit)
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

    // exit the held position when the TK cross flips against it
    if (pos) {
      const want = reverse ? sg.entry[i] : sg.exit[i]; // mirrored systems are exact opposites
      if (want) closePos(bar, 'tkcross');
    }

    // entry
    const trigger = reverse ? sg.exit[i] : sg.entry[i];
    if (trigger && !pos) {
      pos = {
        side: reverse ? 'short' : 'long',
        dir: reverse ? -1 : 1,
        entryRaw: bar.close,
        entryTime: bar.time,
      };
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
      `win% ${pct(m.winPct).padStart(6)}  PF ${pf(m.pf).padStart(5)}  ` +
      `avg move ${m.avgPct >= 0 ? '+' : ''}${m.avgPct.toFixed(3)}%  ` +
      `gross $${f2(m.gross).padStart(8)} - cost $${m.costs.toFixed(2).padStart(7)} = net $${f2(m.net).padStart(8)} ` +
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
  console.log(' TK Cross > EMA200 Strat (Pine v3) — backtest on Delta Exchange   [long only as written]');
  console.log(` conversion donchian(${STRAT.conversionPeriods}) vs base donchian(${STRAT.basePeriods}), filter ema(${STRAT.emaLen})   ` +
    `entry conv>base & close>ema200, exit conv<base`);
  console.log(` ${args.tf} bars   data ${new Date(first[0].time * 1000).toISOString().slice(0, 16)} -> ` +
    `${new Date(first[first.length - 1].time * 1000).toISOString().slice(0, 16)} UTC   report window = last ${args.days} calendar days`);
  console.log(` sizing qty = initial_capital/close -> fixed $${(CFG.initialEquity * CFG.notionalPct) / 100} notional (no compounding)   ` +
    `costs taker ${(CFG.feeTaker * 1e4).toFixed(1)}bps + slip ${(CFG.slippage * 1e4).toFixed(1)}bps per leg`);
  console.log('='.repeat(126));

  const agg = { normal: { net: 0, n: 0, gross: 0 }, rev: { net: 0, n: 0, gross: 0 } };

  console.log(`\n\n################  ${args.tf} — LONG (as written) vs REVERSED — LAST ${args.days} DAYS  ################`);
  for (const [sym, candles] of data) {
    const sg = signals(candles);
    const nat = lastNDays(simulate(candles, sg, barSec, false), args.days);
    const rev = lastNDays(simulate(candles, sg, barSec, true), args.days);
    const mn = metrics(nat);
    const mr = metrics(rev);
    agg.normal.net += mn.net; agg.normal.n += mn.n; agg.normal.gross += mn.gross;
    agg.rev.net += mr.net; agg.rev.n += mr.n; agg.rev.gross += mr.gross;
    console.log('');
    if (!nat.length) console.log(`  ${sym.padEnd(20)} no trades`);
    else line(`${sym} LONG`, mn, args.days);
    if (rev.length) line(`${sym} REVERSED`, mr, args.days);
  }

  // --- timeframe sweep on the primary symbol ------------------------------
  console.log(`\n\n################  ${primary} — TIMEFRAME SWEEP (last ${args.days} days, LONG as written)  ################`);
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

  console.log('\n\n################  SUMMARY (portfolio of 5 symbols)  ################');
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

module.exports = { signals, simulate, metrics, CFG, STRAT };
