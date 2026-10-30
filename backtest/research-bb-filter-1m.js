// Backtest of the "Bollinger Bands Filter / BB Breakout Strategy" (TradeChartist)
// ported to Delta Exchange candles.
//
// Original (TradingView v4), the parts that matter:
//   basis = sma(close, length)                       // length = 55
//   dev   = mult * stdev(close, length)              // mult   = 1.0
//   upper = basis + dev ;  lower = basis - dev
//   long  = close > upper
//   short = close < lower
//   L1 = barssince(long) ;  S1 = barssince(short)
//   longSignal  = L1 <  S1 and not (L1 <  S1)[1]
//   shortSignal = S1 <  L1 and not (S1 <  L1)[1]
//   -> strategy.entry("Long",  when=longSignal)  +  strategy.close("Long",  when=shortSignal)
//   -> strategy.entry("Short", when=shortSignal) +  strategy.close("Short", when=longSignal)
//
// `L1 < S1` simply means "the most recent band break was an up-break". The
// `not (...)[1]` makes it an edge, so the net behaviour is:
//   * go LONG  on the first close above the upper band after a close below the
//     lower band (alternating breaks only — repeated same-side breaks are ignored),
//   * go SHORT on the first close below the lower band after an up-break.
// i.e. an always-in-the-market mean-extension flip system (pyramiding=1 -> one
// position, reversed on the opposite signal).
//
// The script is run twice: as written, and with buy/sell REVERSED (long signal
// -> short, short signal -> long).
//
// Model: signal on the close of a bar, market fill at that same close, taker
// 5 bps + 2 bps slippage per leg, notional = percent_of_equity 100 (the script's
// own default) on a $1,200 account.
//
//   node backtest/research-bb-filter-1m.js --days 7
//   node backtest/research-bb-filter-1m.js --symbols BTCUSD,ETHUSD
//   node backtest/research-bb-filter-1m.js --length 20 --mult 2

'use strict';

const { loadCache } = require('./lib/data');

const ALL_SYMBOLS = ['BTCUSD', 'ETHUSD', 'SOLUSD', 'XRPUSD', 'DOGEUSD'];
const RES_SEC = { '1m': 60, '5m': 300 };

const CFG = {
  initialEquity: 1200,
  notionalPct: 100, // default_qty_type = percent_of_equity, default_qty_value = 100
  feeTaker: 0.0005, // 5 bps
  slippage: 0.0002, // 2 bps
};

// ---------------------------------------------------------------------------
// indicators / signals
// ---------------------------------------------------------------------------

function bollinger(candles, length, mult) {
  const n = candles.length;
  const basis = new Array(n).fill(null);
  const upper = new Array(n).fill(null);
  const lower = new Array(n).fill(null);
  for (let i = length - 1; i < n; i += 1) {
    let sum = 0;
    for (let j = i - length + 1; j <= i; j += 1) sum += candles[j].close;
    const mean = sum / length;
    let v = 0;
    for (let j = i - length + 1; j <= i; j += 1) {
      const d = candles[j].close - mean;
      v += d * d;
    }
    const sd = Math.sqrt(v / length); // Pine stdev = population stdev
    basis[i] = mean;
    upper[i] = mean + mult * sd;
    lower[i] = mean - mult * sd;
  }
  return { basis, upper, lower };
}

// barssince + the longSignal / shortSignal edge detection
function signals(candles, length, mult) {
  const n = candles.length;
  const { basis, upper, lower } = bollinger(candles, length, mult);
  const long = new Array(n).fill(false);
  const short = new Array(n).fill(false);
  for (let i = 0; i < n; i += 1) {
    if (upper[i] == null) continue;
    long[i] = candles[i].close > upper[i];
    short[i] = candles[i].close < lower[i];
  }

  const L1 = new Array(n).fill(null);
  const S1 = new Array(n).fill(null);
  let lastLong = -1;
  let lastShort = -1;
  for (let i = 0; i < n; i += 1) {
    if (long[i]) lastLong = i;
    if (short[i]) lastShort = i;
    L1[i] = lastLong < 0 ? null : i - lastLong;
    S1[i] = lastShort < 0 ? null : i - lastShort;
  }

  // ls = (L1 < S1) — null (na) while either series has no occurrence yet
  const ls = new Array(n).fill(null);
  for (let i = 0; i < n; i += 1) ls[i] = L1[i] == null || S1[i] == null ? null : L1[i] < S1[i];

  const longSignal = new Array(n).fill(false);
  const shortSignal = new Array(n).fill(false);
  for (let i = 1; i < n; i += 1) {
    const cur = ls[i];
    const prev = ls[i - 1];
    // Pine: `x and not x[1]` is falsy whenever x[1] is na
    if (cur === true && prev === false) longSignal[i] = true;
    if (cur === false && prev === true) shortSignal[i] = true;
  }
  return { longSignal, shortSignal, upper, lower, basis };
}

// ---------------------------------------------------------------------------
// simulation
// ---------------------------------------------------------------------------

function simulate(candles, sg, reverse, barSec) {
  const n = candles.length;
  const notional = (CFG.initialEquity * CFG.notionalPct) / 100;
  const trades = [];
  let pos = null;

  const close = (bar, reason) => {
    pos.exitRaw = bar.close;
    pos.exitTime = bar.time;
    pos.exitReason = reason;
    trades.push(pos);
    pos = null;
  };

  for (let i = 1; i < n; i += 1) {
    const bar = candles[i];
    const longSig = sg.longSignal[i];
    const shortSig = sg.shortSignal[i];
    if (!longSig && !shortSig) continue;

    let want = longSig ? 'long' : 'short';
    if (reverse) want = want === 'long' ? 'short' : 'long';
    if (pos && pos.side === want) continue; // pyramiding=1 -> same-side entry ignored

    if (pos) close(bar, 'flip');
    pos = {
      side: want,
      dir: want === 'long' ? 1 : -1,
      entryRaw: bar.close,
      entryTime: bar.time,
    };
  }
  if (pos) close(candles[n - 1], 'open');

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
    long: trades.filter((t) => t.side === 'long').length,
    short: trades.filter((t) => t.side === 'short').length,
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
    `  ${label.padEnd(20)} trades ${String(m.n).padStart(5)} (${(m.n / days).toFixed(1)}/day)  ` +
      `L/S ${m.long}/${m.short}  win% ${pct(m.winPct).padStart(6)}  PF ${pf(m.pf).padStart(5)}  ` +
      `avg move ${m.avgPct >= 0 ? '+' : ''}${m.avgPct.toFixed(3)}%  ` +
      `net $${f2(m.net).padStart(8)} (${((m.net / CFG.initialEquity) * 100).toFixed(2)}%)  ` +
      `maxDD $${f2(m.maxDd)}  hold ${m.avgBars.toFixed(0)} bars  green ${m.greenDays}/${m.days}`,
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
  const a = { days: 7, symbols: ALL_SYMBOLS, tf: '1m', length: 55, mult: 1.0 };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--days') a.days = Number(argv[++i]);
    else if (argv[i] === '--symbols') a.symbols = String(argv[++i]).split(',').map((s) => s.trim().toUpperCase());
    else if (argv[i] === '--tf') a.tf = String(argv[++i]);
    else if (argv[i] === '--length') a.length = Number(argv[++i]);
    else if (argv[i] === '--mult') a.mult = Number(argv[++i]);
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

  console.log('='.repeat(112));
  console.log(' Bollinger Bands Filter / BB Breakout (TradeChartist) — backtest on Delta Exchange');
  console.log(` SMA ${args.length}, ${args.mult} stdev   ${args.tf} bars   ` +
    `data ${new Date(first[0].time * 1000).toISOString().slice(0, 16)} -> ${new Date(first[first.length - 1].time * 1000).toISOString().slice(0, 16)} UTC`);
  console.log(` report window = last ${args.days} calendar days   sizing percent_of_equity ${CFG.notionalPct}% of $${CFG.initialEquity} = $${(CFG.initialEquity * CFG.notionalPct) / 100} notional`);
  console.log(` costs taker ${(CFG.feeTaker * 1e4).toFixed(1)}bps + slip ${(CFG.slippage * 1e4).toFixed(1)}bps per leg (market in / market out)`);
  console.log('='.repeat(112));

  const sgP = signals(data.get(primary), args.length, args.mult);
  const rawL = sgP.longSignal.filter(Boolean).length;
  const rawS = sgP.shortSignal.filter(Boolean).length;
  console.log(`\n${primary} raw signals in cached data: long ${rawL}, short ${rawS}`);

  // --- per-symbol, normal vs reversed ------------------------------------
  console.log(`\n\n################  ${args.tf} — NORMAL vs REVERSED — LAST ${args.days} DAYS  ################`);
  const agg = { normal: { net: 0, n: 0 }, reverse: { net: 0, n: 0 } };
  for (const [sym, candles] of data) {
    const sg = signals(candles, args.length, args.mult);
    const nat = lastNDays(simulate(candles, sg, false, barSec), args.days);
    const rev = lastNDays(simulate(candles, sg, true, barSec), args.days);
    const mn = metrics(nat);
    const mr = metrics(rev);
    agg.normal.net += mn.net; agg.normal.n += mn.n;
    agg.reverse.net += mr.net; agg.reverse.n += mr.n;
    console.log('');
    line(`${sym} normal`, mn, args.days);
    line(`${sym} REVERSED`, mr, args.days);
  }

  // --- daily detail for the primary symbol -------------------------------
  const candlesP = data.get(primary);
  const sg = signals(candlesP, args.length, args.mult);
  for (const [tag, rev] of [['NORMAL', false], ['REVERSED', true]]) {
    const t = lastNDays(simulate(candlesP, sg, rev, barSec), args.days);
    console.log(`\n\n--- ${primary} ${args.tf} — ${tag} — daily (last ${args.days} days) ---`);
    if (!t.length) { console.log('  no trades'); continue; }
    line('TOTAL', metrics(t), args.days);
    printDaily(t);
  }

  console.log('\n\n################  SUMMARY  ################');
  const eq = CFG.initialEquity * data.size;
  console.log(
    `  NORMAL   ${String(agg.normal.n).padStart(5)} trades  net $${f2(agg.normal.net).padStart(9)}  (${((agg.normal.net / eq) * 100).toFixed(2)}% of $${eq})`,
  );
  console.log(
    `  REVERSED ${String(agg.reverse.n).padStart(5)} trades  net $${f2(agg.reverse.net).padStart(9)}  (${((agg.reverse.net / eq) * 100).toFixed(2)}% of $${eq})`,
  );
  console.log('');
}

main();
