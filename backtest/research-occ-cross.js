// Backtest of the TradingView "Open Close Cross Strategy R5.1 (revised by
// JustUncleL)" on Delta Exchange BTCUSD.
//
// What the original (Pine v3) does:
//   * builds an MA of the *open* series and an MA of the *close* series
//     (default type = SMMA, period = 8)
//   * pushes both onto an "Alternate Resolution" = chart_tf * intRes
//     (default intRes = 3, i.e. 3x the chart resolution)
//   * xlong  = crossover(closeMA, openMA)
//     xshort = crossunder(closeMA, openMA)
//   * tradeType = BOTH, SL = 0, TP = 0  ->  no stops at all
//   * strategy.entry("long"/"short") on the cross, pyramiding = 0
//     => with no close rules the position simply REVERSES on the next
//        opposite cross. It is an always-in-market flip system.
//   * default_qty_type = percent_of_equity, default_qty_value = 10
//
// IMPORTANT porting decisions (call them out so the numbers are honest):
//
//  1. NON-REPAINTING. The published script uses
//     `security(..., lookahead=barmerge.lookahead_on)` with "Delay Open/Close
//     MA" = 0. On TradingView the MA/alternate series is therefore evaluated on
//     the STILL-FORMING higher-timeframe bar and the cross can appear then
//     vanish -> the Strategy Tester result is optimistic. This port uses the
//     deployable semantics: the strategy-resolution state seen on a bar is the
//     one from the LAST COMPLETED bar of that resolution. Everything else is
//     faithful.
//
//  2. The MA is computed natively ON the strategy resolution (that is what
//     `security(id, res, smma(close,8))` means, and it is what a live bot would
//     subscribe to). So "chart x intRes" collapses to one number: the strategy
//     resolution. We therefore sweep the strategy resolution directly.
//
//  3. Entries/exits sit on the close of the strategy-resolution bar, which is
//     exactly when Pine's `strategy.entry` (a market order) would fill.
//
// Costs modelled (Delta retail):
//   * published : market in  -> taker 5 bps + 2 bps slip ; market out -> taker 5 bps + 2 bps slip
//   * maker alt.: resting limit at the bar close -> maker 2 bps ; market out -> taker 5 bps + 2 bps slip
// Both zero-cost (pure signal edge) and net figures are shown.
//
//   node backtest/research-occ-cross.js
//   node backtest/research-occ-cross.js --days 7 --symbol BTCUSD --tf 5m --daily

'use strict';

const { loadCache } = require('./lib/data');

const DAY_SEC = 86400;

const CFG = {
  contractValue: 0.001, // Delta BTCUSD: 1 contract = 0.001 BTC
  feeTaker: 0.0005, // 5 bps
  feeMaker: 0.0002, // 2 bps
  slippage: 0.0002, // 2 bps, market legs only
  initialEquity: 1200,
  notionalPct: 0.10, // strategy.percent_of_equity default_qty_value = 10
};

const STRAT = {
  maType: 'SMMA',
  maLen: 8,
  intRes: 3, // published default: alt = chart * 3
};

const RES_SEC = { '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '2h': 7200, '4h': 14400 };
const SWEEP = ['1m', '3m', '5m', '15m', '30m', '1h'];

// ---------------------------------------------------------------------------
// indicators
// ---------------------------------------------------------------------------

// Pine SMMA (a.k.a. Wilder RMA / "smoothed" MA): SMA seed at index len-1,
// then v = (v[1]*(len-1) + src) / len.
function smma(values, len) {
  const n = values.length;
  const out = new Array(n).fill(null);
  if (len < 1 || n < len) return out;
  let sum = 0;
  for (let i = 0; i < len; i += 1) sum += values[i];
  out[len - 1] = sum / len;
  for (let i = len; i < n; i += 1) out[i] = (out[i - 1] * (len - 1) + values[i]) / len;
  return out;
}

// Re-bucket an ascending 1m series into `sec`-second candles (epoch aligned).
function resample(candles, sec) {
  const out = [];
  let cur = null;
  for (const c of candles) {
    const b = Math.floor(c.time / sec) * sec;
    if (!cur || cur.time !== b) {
      if (cur) out.push(cur);
      cur = { time: b, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
    } else {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      cur.volume += c.volume;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// ---------------------------------------------------------------------------
// signals
// ---------------------------------------------------------------------------

function buildSignals(alt) {
  const n = alt.length;
  const closeMA = smma(alt.map((c) => c.close), STRAT.maLen);
  const openMA = smma(alt.map((c) => c.open), STRAT.maLen);
  const sigs = new Array(n).fill(null);
  const stats = { long: 0, short: 0 };

  for (let i = 1; i < n; i += 1) {
    const c0 = closeMA[i - 1];
    const o0 = openMA[i - 1];
    const c1 = closeMA[i];
    const o1 = openMA[i];
    if (c0 == null || o0 == null || c1 == null || o1 == null) continue;
    if (c0 <= o0 && c1 > o1) { sigs[i] = 'long'; stats.long += 1; }
    else if (c0 >= o0 && c1 < o1) { sigs[i] = 'short'; stats.short += 1; }
  }
  return { sigs, closeMA, openMA, stats };
}

// ---------------------------------------------------------------------------
// simulator  (always-in-market reversal — the published model)
// ---------------------------------------------------------------------------

function simulate(alt, sigs, maker) {
  const n = alt.length;
  const feeEntry = maker ? CFG.feeMaker : CFG.feeTaker;
  const slipEntry = maker ? 0 : CFG.slippage;
  const trades = [];
  let pos = null;

  const notional = CFG.initialEquity * CFG.notionalPct;

  const openPos = (side, bar) => {
    const dir = side === 'long' ? 1 : -1;
    pos = {
      side,
      dir,
      qty: notional / (bar.close * CFG.contractValue),
      entryRaw: bar.close,
      entryAdj: bar.close * (1 + dir * slipEntry),
      barTime: bar.time,
    };
  };

  const closePos = (bar, reason) => {
    const dir = pos.dir;
    const qty = pos.qty;
    const exitRaw = bar.close;
    const exitAdj = exitRaw * (1 - dir * CFG.slippage); // exits are market -> taker
    const entryNotional = pos.entryAdj * qty * CFG.contractValue;
    const exitNotional = exitAdj * qty * CFG.contractValue;
    const entryFee = entryNotional * feeEntry;
    const exitFee = exitNotional * CFG.feeTaker;
    const gross = (exitRaw - pos.entryRaw) * dir * qty * CFG.contractValue;
    const net = (exitAdj - pos.entryAdj) * dir * qty * CFG.contractValue - entryFee - exitFee;
    trades.push({
      day: new Date(pos.barTime * 1000).toISOString().slice(0, 10),
      side: pos.side,
      entry: pos.entryRaw,
      exit: exitRaw,
      reason,
      grossPts: (exitRaw - pos.entryRaw) * dir,
      gross,
      fees: entryFee + exitFee,
      net,
      bars: (bar.time - pos.barTime) / (alt.length > 1 ? alt[1].time - alt[0].time : 60),
      entryTime: pos.barTime,
      exitTime: bar.time,
    });
    pos = null;
  };

  for (let i = 1; i < n; i += 1) {
    const s = sigs[i];
    if (!s) continue;
    if (pos && pos.side === s) continue; // pyramiding = 0
    if (pos) closePos(alt[i], 'flip');
    openPos(s, alt[i]);
  }
  if (pos) closePos(alt[n - 1], 'eod');
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
  return {
    n,
    gross: sum((t) => t.gross),
    net: sum((t) => t.net),
    costs: sum((t) => t.fees),
    grossPts: sum((t) => t.grossPts),
    winPct: n ? (wins / n) * 100 : 0,
    pf: gl > 0 ? gp / gl : gp > 0 ? Infinity : 0,
    avgBars: n ? sum((t) => t.bars) / n : 0,
  };
}

const f2 = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;
const pct = (v) => `${v.toFixed(1)}%`;

function inWindow(trades, lastTime, days) {
  const cutoff = lastTime - days * DAY_SEC;
  return trades.filter((t) => t.entryTime >= cutoff);
}

function printDaily(trades) {
  const byDay = new Map();
  for (const t of trades) {
    const d = byDay.get(t.day) || { n: 0, gross: 0, net: 0 };
    d.n += 1;
    d.gross += t.gross;
    d.net += t.net;
    byDay.set(t.day, d);
  }
  console.log('\n--- daily ---');
  console.log('  date         trades   flips      gross%      net%      cum%');
  let cum = 0;
  for (const [day, x] of [...byDay.entries()].sort()) {
    cum += x.net;
    console.log(
      `  ${day}  ${String(x.n).padStart(6)}  ${String(x.n).padStart(6)}  ` +
        `${f2((x.gross / CFG.initialEquity) * 100).padStart(10)}  ` +
        `${f2((x.net / CFG.initialEquity) * 100).padStart(9)}  ` +
        `${f2((cum / CFG.initialEquity) * 100).padStart(9)}`,
    );
  }
}

function row(label, trades, lastTime, days, extraBars) {
  const m = metrics(inWindow(trades, lastTime, days));
  const g = (m.gross / CFG.initialEquity) * 100;
  const net = (m.net / CFG.initialEquity) * 100;
  const cost = (m.costs / CFG.initialEquity) * 100;
  return (
    `  ${label.padEnd(6)}${String(extraBars).padStart(6)}  ${String(m.n).padStart(6)}  ` +
    `${pct(m.winPct).padStart(6)}  ${f2(g).padStart(8)}  ${('-'.concat(cost.toFixed(2))).padStart(8)}  ` +
    `${f2(net).padStart(8)}  ${(m.pf === Infinity ? 'inf' : m.pf.toFixed(2)).padStart(5)}  ` +
    `${m.avgBars.toFixed(0).padStart(8)}  ${f2(m.grossPts).padStart(10)}`
  );
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const a = { days: 7, symbol: 'BTCUSD', tf: '3m', daily: false };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--days') a.days = Number(argv[++i]);
    else if (argv[i] === '--symbol') a.symbol = String(argv[++i]);
    else if (argv[i] === '--tf') a.tf = String(argv[++i]);
    else if (argv[i] === '--daily') a.daily = true;
  }
  return a;
}

function main() {
  const args = parseArgs(process.argv);
  const cached = loadCache(args.symbol, '1m');
  if (!cached || !cached.candles || !cached.candles.length) {
    throw new Error(`No ${args.symbol} 1m cache. Run: node backtest/fetch.js --symbol ${args.symbol} --timeframes 1m --days 30`);
  }
  const base = cached.candles;
  const lastTime = base[base.length - 1].time;
  const first = new Date(base[0].time * 1000).toISOString().slice(0, 16);
  const last = new Date(lastTime * 1000).toISOString().slice(0, 16);
  const windowFrom = new Date((lastTime - args.days * DAY_SEC) * 1000).toISOString().slice(0, 10);

  console.log('============================================================');
  console.log(' "Open Close Cross Strategy R5.1" (TradingView Pine) on BTCUSD');
  console.log(` instrument ${args.symbol}   data ${first} -> ${last}`);
  console.log(` inputs  MA ${STRAT.maType}(${STRAT.maLen}) on open & close, alternate = chart x ${STRAT.intRes}`);
  console.log(' model   non-repainting (last COMPLETED strategy bar), no SL/TP -> always-in reversal');
  console.log(` sizing  notional ${(CFG.notionalPct * 100).toFixed(0)}% of $${CFG.initialEquity} (percent_of_equity default)`);
  console.log(` costs   market in/out taker ${(CFG.feeTaker * 1e4).toFixed(1)}bps + ${(CFG.slippage * 1e4).toFixed(1)}bps slip`);
  console.log(` window  last ${args.days} calendar days  (${windowFrom} -> ${last.slice(0, 10)})`);
  console.log('============================================================');

  // --- strategy-resolution sweep -------------------------------------------
  console.log(`\n########  LAST ${args.days} DAYS  ·  every figure is % of $${CFG.initialEquity} equity  ########`);
  for (const passed of [false, true]) {
    console.log(`\n  ${passed ? 'MAKER' : 'TAKER'} entries (${passed ? 'resting limit at bar close' : 'market at bar close — published'})`);
    console.log('  tf      bars  trades  win%     gross%    costs%      net%     PF  hold(bars)   grossPts');
    for (const tf of SWEEP) {
      if (!RES_SEC[tf]) continue;
      const alt = resample(base, RES_SEC[tf]);
      const built = buildSignals(alt);
      const trades = simulate(alt, built.sigs, passed);
      const barsInWin = alt.filter((b) => b.time >= lastTime - args.days * DAY_SEC).length;
      console.log(row(tf, trades, lastTime, args.days, barsInWin));
    }
  }

  // --- detail for the default resolution -----------------------------------
  const tf = RES_SEC[args.tf] ? args.tf : '3m';
  const alt = resample(base, RES_SEC[tf]);
  const built = buildSignals(alt);
  const barsInWin = alt.filter((b) => b.time >= lastTime - args.days * DAY_SEC).length;
  const cutoff = lastTime - args.days * DAY_SEC;
  let wLong = 0;
  let wShort = 0;
  for (let i = 0; i < alt.length; i += 1) {
    if (alt[i].time < cutoff) continue;
    if (built.sigs[i] === 'long') wLong += 1;
    else if (built.sigs[i] === 'short') wShort += 1;
  }
  console.log(`\n################  DETAIL: ${tf} (published default: chart x ${STRAT.intRes})  ################`);
  console.log(` strategy bars in window: ${barsInWin}`);
  console.log(` crosses in window: ${wLong} long / ${wShort} short`);

  console.log('\n  model    trades  win%     gross%    costs%      net%     PF  hold(bars)   grossPts   avgPts');
  for (const [label, maker] of [['taker', false], ['maker', true]]) {
    const trades = simulate(alt, built.sigs, maker);
    const m = metrics(inWindow(trades, lastTime, args.days));
    if (!m.n) { console.log(`  ${label.padEnd(8)}  no trades`); continue; }
    console.log(
      `  ${label.padEnd(8)}  ${String(m.n).padStart(5)}  ${pct(m.winPct).padStart(6)}  ` +
        `${f2((m.gross / CFG.initialEquity) * 100).padStart(8)}  ${('-'.concat(((m.costs / CFG.initialEquity) * 100).toFixed(2))).padStart(8)}  ` +
        `${f2((m.net / CFG.initialEquity) * 100).padStart(8)}  ${(m.pf === Infinity ? 'inf' : m.pf.toFixed(2)).padStart(5)}  ` +
        `${m.avgBars.toFixed(0).padStart(8)}  ${f2(m.grossPts).padStart(10)}  ${f2(m.grossPts / m.n).padStart(8)}`,
    );
  }

  if (args.daily) {
    console.log('\n(reversal = published model; daily shown for TAKER)');
    printDaily(inWindow(simulate(alt, built.sigs, false), lastTime, args.days));
  }
  console.log('');
}

if (require.main === module) main();

module.exports = { CFG, STRAT, smma, resample, buildSignals, simulate, metrics, inWindow, printDaily };
