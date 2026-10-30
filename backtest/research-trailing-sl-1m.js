// Backtest of the "Trailing SL Strategy [QuantNomad]" Pine script, ported to
// Delta Exchange 1-minute candles.
//
// Original (TradingView, v4):
//   sl_val    = % / ATR / Absolute stop distance
//   long_sig  = pos[1] !=  1 and high > trailing_sl[1]
//   short_sig = pos[1] != -1 and low  < trailing_sl[1]
//   trailing_sl := short_sig ? high + sl_val :
//                  long_sig  ? low  - sl_val :
//                  pos[1]==1 ? max(low  - sl_val, trailing_sl[1]) :
//                  pos[1]==-1? min(high + sl_val, trailing_sl[1]) : trailing_sl[1]
//   pos := long_sig ? 1 : short_sig ? -1 : pos[1]
//   if pos !=  1 -> strategy.entry("long",  true,  stop = trailing_sl)
//   if pos != -1 -> strategy.entry("short", false, stop = trailing_sl)
//
// The two strategy.entry() calls place a SINGLE resting stop order at the
// trailing line (Pine updates the order in place each bar). So the whole system
// is a stop-and-reverse: hold a position, trail the line, and when price touches
// the line the resting stop fills and the position flips. This script emulates
// that bar-by-bar:
//   * fills for bar i use the level set at the close of bar i-1 (stop orders
//     rest between bars, they are not repriced mid-bar),
//   * the stop/an entry legs are taker (5 bps) + slippage (2 bps),
//   * position size mirrors the Pine default (percent_of_equity = 50).
//
// Note the original's start-up quirk: on bar 0 pos becomes 1 but no long order
// is placed (pos == 1), so only a short stop rests below -> the very first trade
// of the series is always a short. This port reproduces that faithfully.
//
//   node backtest/research-trailing-sl-1m.js
//   node backtest/research-trailing-sl-1m.js --days 7
//   node backtest/research-trailing-sl-1m.js --sl "pct:4,atr:10:2,abs:10"
//   node backtest/research-trailing-sl-1m.js --symbols BTCUSD,ETHUSD

'use strict';

const { loadCache } = require('./lib/data');

const DAY_SEC = 86400;
const ALL_SYMBOLS = ['BTCUSD', 'ETHUSD', 'SOLUSD', 'XRPUSD', 'DOGEUSD'];

// Delta retail: taker 5 bps. Stop-market legs also slip ~2 bps.
const CFG = {
  initialEquity: 1200,
  notionalPct: 50, // Pine default_qty_type = percent_of_equity, value 50
  feeTaker: 0.0005, // 5 bps
  slippage: 0.0002, // 2 bps, applied to every stop fill
};

// ---------------------------------------------------------------------------
// indicators
// ---------------------------------------------------------------------------

function atr(candles, period) {
  const n = candles.length;
  const out = new Array(n).fill(null);
  const tr = new Array(n).fill(0);
  for (let i = 1; i < n; i += 1) {
    const h = candles[i].high;
    const l = candles[i].low;
    const pc = candles[i - 1].close;
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  if (n <= period) return out;
  let sum = 0;
  for (let i = 1; i <= period; i += 1) sum += tr[i];
  out[period] = sum / period;
  for (let i = period + 1; i < n; i += 1) out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
  return out;
}

// sl_val per bar for one stop spec. Returns an array (null during warm-up).
function slValues(candles, spec) {
  const n = candles.length;
  const out = new Array(n).fill(null);
  if (spec.type === 'pct') {
    for (let i = 0; i < n; i += 1) out[i] = (candles[i].close * spec.pct) / 100;
  } else if (spec.type === 'abs') {
    for (let i = 0; i < n; i += 1) out[i] = spec.value;
  } else {
    const a = atr(candles, spec.len);
    for (let i = 0; i < n; i += 1) out[i] = a[i] == null ? null : a[i] * spec.mult;
  }
  return out;
}

// ---------------------------------------------------------------------------
// strategy emulation (stop-and-reverse at the trailing line)
// ---------------------------------------------------------------------------

function emulate(candles, spec) {
  const n = candles.length;
  const sl = slValues(candles, spec);
  const trades = [];

  let posVar = 0; // Pine `pos`
  let trailPrev = 0; // nz(trailing_sl[1])
  let resting = null; // { side, price } — the single live stop order
  let cur = null; // open position

  const notional = (CFG.initialEquity * CFG.notionalPct) / 100;

  for (let i = 0; i < n; i += 1) {
    const bar = candles[i];
    const s = sl[i];

    // (A) intrabar fill of the stop that rested through this bar
    if (resting && i > 0) {
      const hit = resting.side === 'short' ? bar.low <= resting.price : bar.high >= resting.price;
      if (hit) {
        const price = resting.price;
        if (cur) {
          cur.exitRaw = price;
          cur.exitTime = bar.time;
          cur.exitReason = 'flip';
          trades.push(cur);
        }
        cur = {
          side: resting.side,
          dir: resting.side === 'long' ? 1 : -1,
          entryRaw: price,
          entryTime: bar.time,
          entryRisk: s != null && s > 0 ? s : Math.abs(price) * 0.01,
        };
        resting = null;
      }
    }

    // (B) run the script on the close of this bar
    if (s != null) {
      const longSignal = posVar !== 1 && bar.high > trailPrev;
      const shortSignal = posVar !== -1 && bar.low < trailPrev;

      let trail;
      if (shortSignal) trail = bar.high + s;
      else if (longSignal) trail = bar.low - s;
      else if (posVar === 1) trail = Math.max(bar.low - s, trailPrev);
      else if (posVar === -1) trail = Math.min(bar.high + s, trailPrev);
      else trail = trailPrev;

      posVar = longSignal ? 1 : shortSignal ? -1 : posVar;

      // (C) reprice the single resting stop for the next bar
      //     pos !=  1 -> strategy.entry("long",  true,  stop=trail) -> BUY  stop
      //     pos != -1 -> strategy.entry("short", false, stop=trail) -> SELL stop
      resting = null;
      if (posVar !== 1) resting = { side: 'long', price: trail }; // buy stop
      if (posVar !== -1) resting = { side: 'short', price: trail }; // sell stop
      trailPrev = trail;
    }
  }

  if (cur) {
    const last = candles[n - 1];
    cur.exitRaw = last.close;
    cur.exitTime = last.time;
    cur.exitReason = 'open';
    trades.push(cur);
  }

  // settle P&L in dollars (fixed notional, no compounding)
  for (const t of trades) {
    const qty = notional / t.entryRaw; // coin units
    const entryFill = t.entryRaw * (1 + t.dir * CFG.slippage);
    const exitFill = t.exitRaw * (1 - t.dir * CFG.slippage);
    t.entry = t.entryRaw;
    t.exit = t.exitRaw;
    t.gross = qty * (t.exitRaw - t.entryRaw) * t.dir;
    t.fees = notional * CFG.feeTaker * 2;
    t.net = qty * (exitFill - entryFill) * t.dir - t.fees;
    t.grossR = t.gross / (notional * (t.entryRisk / t.entryRaw));
    t.netR = t.net / (notional * (t.entryRisk / t.entryRaw));
    t.day = new Date(t.exitTime * 1000).toISOString().slice(0, 10);
    t.bars = (t.exitTime - t.entryTime) / 60;
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

  // max drawdown on the realised equity curve (exit order)
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
    avgGrossR: n ? sum((t) => t.grossR) / n : 0,
    avgNetR: n ? sum((t) => t.netR) / n : 0,
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

function line(label, m) {
  console.log(
    `  ${label.padEnd(10)} trades ${String(m.n).padStart(4)}  win% ${pct(m.winPct).padStart(6)}  ` +
      `PF ${pf(m.pf).padStart(5)}  avgR gross ${f2(m.avgGrossR).padStart(6)} / net ${f2(m.avgNetR).padStart(6)}  ` +
      `net $${f2(m.net).padStart(8)} (${((m.net / CFG.initialEquity) * 100).toFixed(2)}%)  ` +
      `maxDD $${f2(m.maxDd)}  hold ${m.avgBars.toFixed(0)}m  green ${m.greenDays}/${m.days}`,
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

function printTrades(trades) {
  console.log('  exit time (UTC)      side   entry        exit        net($)   netR   hold   reason');
  for (const t of [...trades].sort((a, b) => a.exitTime - b.exitTime)) {
    const ts = new Date(t.exitTime * 1000).toISOString().slice(0, 16).replace('T', ' ');
    console.log(
      `  ${ts}   ${t.side.padEnd(5)}  ${t.entry.toFixed(1).padStart(10)}  ${t.exit.toFixed(1).padStart(10)}  ` +
        `${f2(t.net).padStart(8)}  ${f2(t.netR).padStart(6)}  ${String(Math.round(t.bars)).padStart(4)}m  ${t.exitReason}`,
    );
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const PRESETS = [
  { key: 'pct:4', label: '% SL 4 (script default)', spec: { type: 'pct', pct: 4 } },
  { key: 'pct:2', label: '% SL 2', spec: { type: 'pct', pct: 2 } },
  { key: 'pct:1', label: '% SL 1', spec: { type: 'pct', pct: 1 } },
  { key: 'pct:0.5', label: '% SL 0.5', spec: { type: 'pct', pct: 0.5 } },
  { key: 'atr:10:2', label: 'ATR(10) x2', spec: { type: 'atr', len: 10, mult: 2 } },
  { key: 'atr:10:1', label: 'ATR(10) x1', spec: { type: 'atr', len: 10, mult: 1 } },
];

function parseArgs(argv) {
  const a = { days: 7, symbols: ALL_SYMBOLS, sl: null };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--days') a.days = Number(argv[++i]);
    else if (argv[i] === '--symbols') a.symbols = String(argv[++i]).split(',').map((s) => s.trim().toUpperCase());
    else if (argv[i] === '--sl') a.sl = String(argv[++i]).split(',').map((s) => s.trim());
  }
  return a;
}

function specFromKey(key) {
  const hit = PRESETS.find((p) => p.key === key);
  if (hit) return hit.spec;
  const p = key.split(':');
  if (p[0] === 'pct') return { type: 'pct', pct: Number(p[1]) };
  if (p[0] === 'abs') return { type: 'abs', value: Number(p[1]) };
  if (p[0] === 'atr') return { type: 'atr', len: Number(p[1]), mult: Number(p[2]) };
  throw new Error(`bad --sl spec: ${key}`);
}

function main() {
  const args = parseArgs(process.argv);
  const keys = args.sl || PRESETS.map((p) => p.key);
  const labelOf = (k) => (PRESETS.find((p) => p.key === k) || {}).label || k;

  const data = new Map();
  for (const sym of args.symbols) {
    const cached = loadCache(sym, '1m');
    if (!cached || !cached.candles || !cached.candles.length) {
      console.log(`  ${sym}: no 1m cache — run node backtest/fetch.js --symbols ${sym} --timeframes 1m --days 12`);
      continue;
    }
    data.set(sym, cached.candles);
  }

  const first = [...data.values()][0];
  const t0 = new Date(first[0].time * 1000).toISOString().slice(0, 16);
  const t1 = new Date(first[first.length - 1].time * 1000).toISOString().slice(0, 16);
  const primarySym = data.has('BTCUSD') ? 'BTCUSD' : [...data.keys()][0];

  console.log('='.repeat(104));
  console.log(' Trailing SL Strategy [QuantNomad] — 1-minute backtest on Delta Exchange');
  console.log(` data ${t0} -> ${t1} UTC   (${first.length} 1m bars)   report window = last ${args.days} calendar days`);
  console.log(` sizing percent_of_equity ${CFG.notionalPct}% of $${CFG.initialEquity} = $${(CFG.initialEquity * CFG.notionalPct) / 100} notional`);
  console.log(` costs  taker ${(CFG.feeTaker * 1e4).toFixed(1)}bps + slip ${(CFG.slippage * 1e4).toFixed(1)}bps per stop leg`);
  console.log('='.repeat(104));

  // --- 1. headline: primary symbol, script default stop ------------------
  const pKey = 'pct:4';
  const pSym = data.get(primarySym);
  const pAll = emulate(pSym, specFromKey(pKey));
  const pWin = lastNDays(pAll, args.days);

  console.log(`\n\n################  ${primarySym} — script default (${labelOf(pKey)}) — LAST ${args.days} DAYS  ################`);
  const fullM = metrics(pAll);
  console.log(
    `  full 10-day history: ${fullM.n} trades  net $${f2(fullM.net)}  win% ${pct(fullM.winPct)}  PF ${pf(fullM.pf)}`,
  );
  if (!pWin.length) {
    console.log('  no trades in the window.');
  } else {
    line('RESULT', metrics(pWin));
    console.log('');
    printDaily(pWin);
    console.log('');
    printTrades(pWin);
  }

  // --- 2. stop-setting comparison on the primary symbol ------------------
  console.log(`\n\n################  ${primarySym} — stop-setting comparison (last ${args.days} days)  ################`);
  for (const k of keys) {
    const all = emulate(pSym, specFromKey(k));
    const w = lastNDays(all, args.days);
    if (!w.length) {
      console.log(`  ${labelOf(k).padEnd(24)} no trades`);
      continue;
    }
    line(labelOf(k).padEnd(24), metrics(w));
  }

  // --- 3. cross-symbol summary (script default) --------------------------
  console.log(`\n\n################  CROSS-SYMBOL — ${labelOf(pKey)} — LAST ${args.days} DAYS  ################`);
  const rows = [];
  for (const [sym, candles] of data) {
    const w = lastNDays(emulate(candles, specFromKey(pKey)), args.days);
    rows.push([sym, metrics(w)]);
    if (!w.length) {
      console.log(`  ${sym.padEnd(8)} no trades`);
      continue;
    }
    line(sym.padEnd(8), metrics(w));
  }
  const tot = rows.reduce((s, [, m]) => s + m.net, 0);
  const totN = rows.reduce((s, [, m]) => s + m.n, 0);
  const portEq = CFG.initialEquity * rows.length;
  console.log(`  ${'-'.repeat(100)}`);
  console.log(
    `  ${'PORTFOLIO'.padEnd(10)} trades ${String(totN).padStart(4)}  ` +
      `net $${f2(tot)}  (${((tot / portEq) * 100).toFixed(2)}% of $${portEq} deployed)`,
  );
  console.log('');
}

if (require.main === module) main();

module.exports = { emulate, metrics, slValues, CFG, LAST: null };
