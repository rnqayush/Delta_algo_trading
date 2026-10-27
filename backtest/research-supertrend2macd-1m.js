// Backtest of the TradingView "Super Trend 2 MACD" Pine script, ported to a
// 1-minute BTCUSD chart on Delta Exchange.
//
// The original (Pine v2) is:
//   * a LOCAL SuperTrend on the chart timeframe (factor=1, pd=1)
//   * a MAIN SuperTrend on a 120-minute "security" series (factor=1, pd=1)
//   * an SMA-based MACD (12/26/9)
//   * long  when the local trend flips up  AND main trend is up   AND Macd > Signal
//   * short when the local trend flips down AND main trend is down AND Macd < Signal
//   * exits are fixed TP=500 / SL=400 (price points) via strategy.exit
//
// IMPORTANT porting note — the original uses Pine v2 `security(tickerid,"120",...)`
// WITHOUT the lookahead guard. That call fills every 1m bar of a 2h window with
// the 2h bar's FINAL values, i.e. it leaks future information into the backtest
// ("security repainting"). Backtesting it that way would produce a fantasy
// result. This port therefore uses the deployable, non-repainting semantics:
// the main (2h) SuperTrend state visible on a 1m bar is the one from the LAST
// COMPLETED 2h bar. Everything else is faithful.
//
// Model (matches how we would actually deploy it):
//   * signal on the close of a closed 1m bar, market entry at that close
//   * reduce-only bracket resting on Delta: TP=500 pts, SL=400 pts
//   * one position at a time; held until TP or SL (the script has no signal exit)
//   * real Delta retail costs, plus a zero-cost "pure edge" column
//
//   node backtest/research-supertrend2macd-1m.js
//   node backtest/research-supertrend2macd-1m.js --days 7 --daily
//   node backtest/research-supertrend2macd-1m.js --symbol ETHUSD --days 7

'use strict';

const { loadCache } = require('./lib/data');

const BAR_SEC = 60;
const HTF_SEC = 7200; // 120-minute "Main SuperTrend"
const DAY_SEC = 86400;

// Strategy inputs, exactly as published.
const P = {
  factor: 1, // SuperTrend Factor (both)
  pd: 1, // SuperTrend ATR period (both)
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  tpPoints: 500, // "Take Profit"
  slPoints: 400, // "Stop Loss"
  htfSec: 7200, // "Main SuperTrend" resolution (120m)
  useMacd: true,
  exitMode: 'bracket', // 'bracket' (published) | 'trail' (SuperTrend trailing stop)
};

const CFG = {
  contractValue: 0.001, // Delta BTCUSD: 1 contract = 0.001 BTC
  feeTaker: 0.0005, // 5 bps
  feeMaker: 0.0002, // 2 bps
  slippage: 0.0002, // 2 bps (market legs only)
  initialEquity: 1200,
  riskPct: 0.005, // 0.5% of equity per trade
  maxNotionalPct: 3,
};

// ---------------------------------------------------------------------------
// indicators
// ---------------------------------------------------------------------------

function trueRange(candles, i) {
  const c = candles[i];
  if (i === 0) return c.high - c.low;
  const pc = candles[i - 1].close;
  return Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
}

// Wilder RMA (Pine's ta.rma) — for period 1 it degenerates to the raw series.
function rma(values, period) {
  const n = values.length;
  const out = new Array(n).fill(null);
  if (period < 1 || n < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i += 1) sum += values[i];
  out[period - 1] = sum / period;
  for (let i = period; i < n; i += 1) out[i] = (out[i - 1] * (period - 1) + values[i]) / period;
  return out;
}

// Rolling SMA; a null anywhere in the window yields null (matches Pine's na).
function sma(values, period) {
  const n = values.length;
  const out = new Array(n).fill(null);
  let sum = 0;
  let cnt = 0;
  for (let i = 0; i < n; i += 1) {
    const v = values[i];
    if (v == null) { sum = 0; cnt = 0; continue; }
    sum += v;
    cnt += 1;
    if (cnt > period) { sum -= values[i - period]; cnt -= 1; }
    if (cnt === period) out[i] = sum / period;
  }
  return out;
}

// The exact SuperTrend recurrence from the script (works on any candle series).
function superTrend(candles, factor, pd) {
  const n = candles.length;
  const tr = new Array(n);
  for (let i = 0; i < n; i += 1) tr[i] = trueRange(candles, i);
  const atrArr = rma(tr, pd);

  const up = new Array(n);
  const dn = new Array(n);
  const tUp = new Array(n);
  const tDn = new Array(n);
  const trend = new Array(n);

  for (let i = 0; i < n; i += 1) {
    const a = atrArr[i];
    const hl2 = (candles[i].high + candles[i].low) / 2;
    up[i] = hl2 - factor * a;
    dn[i] = hl2 + factor * a;

    const prevClose = i > 0 ? candles[i - 1].close : null;
    const prevUp = i > 0 ? tUp[i - 1] : null;
    const prevDn = i > 0 ? tDn[i - 1] : null;

    tUp[i] = prevClose != null && prevUp != null && prevClose > prevUp ? Math.max(up[i], prevUp) : up[i];
    tDn[i] = prevClose != null && prevDn != null && prevClose < prevDn ? Math.min(dn[i], prevDn) : dn[i];

    const c = candles[i].close;
    let t;
    if (prevDn != null && c > prevDn) t = 1;
    else if (prevUp != null && c < prevUp) t = -1;
    else t = i > 0 && trend[i - 1] != null ? trend[i - 1] : 1; // nz(Trend[1], 1)
    trend[i] = t;
  }
  const line = new Array(n);
  for (let i = 0; i < n; i += 1) line[i] = trend[i] === 1 ? tUp[i] : tDn[i];
  return { atr: atrArr, up, dn, tUp, tDn, trend, line };
}

// Re-bucket a 1m series into `sec`-second candles (epoch-aligned buckets).
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

// Indicator results are memoised by parameter key so the optimizer can sweep
// thousands of combinations without recomputing the SuperTrends / MACD.
const MEMO = new Map();
const memo = (key, build) => {
  if (!MEMO.has(key)) MEMO.set(key, build());
  return MEMO.get(key);
};

function macdSeries(candles, fast, slow, sig) {
  return memo(`macd:${fast}:${slow}:${sig}`, () => {
    const n = candles.length;
    const closes = candles.map((c) => c.close);
    const fastMA = sma(closes, fast);
    const slowMA = sma(closes, slow);
    const macd = new Array(n).fill(null);
    for (let i = 0; i < n; i += 1) if (fastMA[i] != null && slowMA[i] != null) macd[i] = fastMA[i] - slowMA[i];
    return { macd, signal: sma(macd, sig) };
  });
}

function htfTrendMap(candles, htfSec, factor, pd) {
  return memo(`htf:${htfSec}:${factor}:${pd}`, () => {
    const htf = resample(candles, htfSec);
    const st = superTrend(htf, factor, pd);
    const map = new Map();
    for (let j = 0; j < htf.length; j += 1) map.set(htf[j].time, st.trend[j]);
    return { map, bars: htf.length };
  });
}

// p overrides: factor, pd, htfSec, htfFactor, htfPd, macdFast, macdSlow,
//              macdSignal, useMacd, tpPoints, slPoints.
// `useMacd:false` drops the MACD agreement. Signals carry only the side — the
// stop / target are applied by the simulator from p, so the same signal set can
// be re-simulated against different exits without rebuilding.
function buildSignals(candles, p = P) {
  const n = candles.length;
  const htfSec = p.htfSec || HTF_SEC;
  const htfFactor = p.htfFactor != null ? p.htfFactor : p.factor;
  const htfPd = p.htfPd != null ? p.htfPd : p.pd;

  const local = memo(`lst:${p.factor}:${p.pd}`, () => superTrend(candles, p.factor, p.pd));
  const htfTrendByBucket = htfTrendMap(candles, htfSec, htfFactor, htfPd).map;
  const useMacd = p.useMacd !== false;
  const { macd, signal } = useMacd
    ? macdSeries(candles, p.macdFast, p.macdSlow, p.macdSignal)
    : { macd: null, signal: null };

  const sigs = new Array(n).fill(null);
  const stats = { localFlips: 0, longRaw: 0, shortRaw: 0, long: 0, short: 0 };

  for (let i = 1; i < n; i += 1) {
    const trend = local.trend[i];
    const prevTrend = local.trend[i - 1];
    if (trend === prevTrend) continue;
    stats.localFlips += 1;

    const bucketNow = Math.floor(candles[i].time / htfSec) * htfSec;
    const mTrend = htfTrendByBucket.has(bucketNow - htfSec) ? htfTrendByBucket.get(bucketNow - htfSec) : 1;

    const flipUp = trend === 1 && prevTrend === -1;
    const flipDown = trend === -1 && prevTrend === 1;
    if (flipUp) stats.longRaw += 1;
    if (flipDown) stats.shortRaw += 1;

    let m;
    let s;
    if (useMacd) {
      m = macd[i];
      s = signal[i];
      if (m == null || s == null) continue;
    }

    let side = null;
    if (flipUp && mTrend === 1 && (!useMacd || m > s)) side = 'long';
    else if (flipDown && mTrend === -1 && (!useMacd || m < s)) side = 'short';
    if (!side) continue;
    if (side === 'long') stats.long += 1;
    else stats.short += 1;

    sigs[i] = { side };
  }
  return { sigs, stats, local };
}

// ---------------------------------------------------------------------------
// simulator
// ---------------------------------------------------------------------------

function sizeContracts(p, entry) {
  const byRisk = Math.floor((CFG.initialEquity * CFG.riskPct) / (p.slPoints * CFG.contractValue));
  const byNotional = Math.floor((CFG.initialEquity * CFG.maxNotionalPct) / (entry * CFG.contractValue));
  return Math.max(0, Math.min(byRisk, byNotional));
}

// mode 'hold'    — one position at a time, held until the exit fires
// mode 'reverse' — Pine-faithful: an opposite signal closes the position at the
//                  bar close and flips straight into the other side
//
// p.exitMode 'bracket' — fixed SL + fixed TP (the published script)
// p.exitMode 'trail'   — the local SuperTrend line as a ratcheting trailing stop
//                        (no fixed TP, rides the trend). `built.local.line` is
//                        used, with a one-bar lag so nothing looks ahead.
function simulate(candles, built, mode, p = P) {
  const n = candles.length;
  const sigs = built.sigs;
  const trail = p.exitMode === 'trail' ? built.local.line : null;
  const maker = p.makerEntry === true; // resting limit entry + resting limit TP
  const feeEntry = maker ? CFG.feeMaker : CFG.feeTaker;
  const slipEntry = maker ? 0 : CFG.slippage;
  const trades = [];
  let pos = null;

  const closePos = (rawExit, bar, reason) => {
    const dir = pos.dir;
    const qty = pos.qty;
    const isTp = reason === 'tp';
    const exitAdj = isTp ? rawExit : rawExit * (1 - dir * CFG.slippage);
    const feeExit = isTp && maker ? CFG.feeMaker : CFG.feeTaker;
    const entryNotional = pos.entryAdj * qty * CFG.contractValue;
    const exitNotional = exitAdj * qty * CFG.contractValue;
    const entryFee = entryNotional * feeEntry;
    const exitFee = exitNotional * feeExit;
    const gross = (rawExit - pos.entryRaw) * dir * qty * CFG.contractValue;
    const net = (exitAdj - pos.entryAdj) * dir * qty * CFG.contractValue - entryFee - exitFee;
    const riskAmount = p.slPoints * qty * CFG.contractValue;
    trades.push({
      day: new Date(bar.time * 1000).toISOString().slice(0, 10),
      side: pos.side,
      entry: pos.entryRaw,
      exit: rawExit,
      reason,
      gross,
      fees: entryFee + exitFee,
      net,
      grossR: ((rawExit - pos.entryRaw) * dir) / p.slPoints,
      netR: net / Math.max(1e-9, riskAmount),
      bars: (bar.time - pos.barTime) / BAR_SEC,
      entryTime: pos.barTime,
      exitTime: bar.time,
    });
    pos = null;
  };

  const openPos = (s, bar) => {
    const dir = s.side === 'long' ? 1 : -1;
    const qty = sizeContracts(p, bar.close);
    if (!(qty > 0)) return;
    pos = {
      side: s.side,
      dir,
      qty,
      entryRaw: bar.close,
      entryAdj: bar.close * (1 + dir * slipEntry),
      stop: bar.close - dir * p.slPoints,
      target: bar.close + dir * p.tpPoints,
      barTime: bar.time,
    };
  };

  for (let i = 1; i < n; i += 1) {
    const bar = candles[i];

    if (pos) {
      const dir = pos.dir;
      // Ratchet the trailing stop to the previous bar's SuperTrend line first.
      if (trail && trail[i - 1] != null) {
        if (dir === 1) pos.stop = Math.max(pos.stop, trail[i - 1]);
        else pos.stop = Math.min(pos.stop, trail[i - 1]);
      }
      const hitStop = dir === 1 ? bar.low <= pos.stop : bar.high >= pos.stop;
      const hitTp = p.exitMode === 'trail' ? false : dir === 1 ? bar.high >= pos.target : bar.low <= pos.target;
      if (hitStop) closePos(pos.stop, bar, 'sl'); // stop first: conservative
      else if (hitTp) closePos(pos.target, bar, 'tp');
      if (pos) {
        const s = sigs[i];
        if (mode === 'reverse' && s && s.side !== pos.side) closePos(bar.close, bar, 'flip');
        if (pos) continue;
      }
    }

    const s = sigs[i];
    if (!s) continue;
    openPos(s, bar);
  }

  if (pos) closePos(candles[n - 1].close, candles[n - 1], 'eod');
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
  const byDay = new Map();
  for (const t of trades) byDay.set(t.day, (byDay.get(t.day) || 0) + t.net);
  return {
    n,
    gross: sum((t) => t.gross),
    net: sum((t) => t.net),
    costs: sum((t) => t.fees),
    winPct: n ? (wins / n) * 100 : 0,
    pf: gl > 0 ? gp / gl : gp > 0 ? Infinity : 0,
    grossR: n ? sum((t) => t.grossR) / n : 0,
    netR: n ? sum((t) => t.netR) / n : 0,
    grossSumR: sum((t) => t.grossR),
    netSumR: sum((t) => t.netR),
    avgBars: n ? sum((t) => t.bars) / n : 0,
    byDay,
    greenDays: [...byDay.values()].filter((v) => v > 0).length,
    days: byDay.size,
  };
}

const f2 = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;
const pct = (v) => `${v.toFixed(1)}%`;

function lastNDays(trades, days) {
  const allDays = [...new Set(trades.map((t) => t.day))].sort();
  const window = new Set(allDays.slice(-days));
  return trades.filter((t) => window.has(t.day));
}

function printDaily(trades) {
  const byDay = new Map();
  for (const t of trades) {
    const d = byDay.get(t.day) || { n: 0, tp: 0, sl: 0, gross: 0, net: 0 };
    d.n += 1;
    if (t.reason === 'tp') d.tp += 1;
    if (t.reason === 'sl') d.sl += 1;
    d.gross += t.gross;
    d.net += t.net;
    byDay.set(t.day, d);
  }
  console.log('\n--- daily ---');
  console.log('  date         trades   tp   sl     gross($)      net($)     cum($)');
  let cum = 0;
  for (const [day, x] of [...byDay.entries()].sort()) {
    cum += x.net;
    console.log(
      `  ${day}  ${String(x.n).padStart(6)}  ${String(x.tp).padStart(3)}  ${String(x.sl).padStart(3)}  ` +
        `${f2(x.gross).padStart(10)}  ${f2(x.net).padStart(10)}  ${f2(cum).padStart(10)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const a = { days: 7, daily: false, symbol: 'BTCUSD' };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--days') a.days = Number(argv[++i]);
    else if (argv[i] === '--daily') a.daily = true;
    else if (argv[i] === '--symbol') a.symbol = String(argv[++i]);
  }
  return a;
}

function main() {
  const args = parseArgs(process.argv);
  const cached = loadCache(args.symbol, '1m');
  if (!cached || !cached.candles || !cached.candles.length) {
    throw new Error(
      `No ${args.symbol} 1m cache. Run: node backtest/fetch.js --symbol ${args.symbol} --timeframes 1m --days 30`,
    );
  }
  const candles = cached.candles;
  const first = new Date(candles[0].time * 1000).toISOString().slice(0, 16);
  const last = new Date(candles[candles.length - 1].time * 1000).toISOString().slice(0, 16);

  console.log('============================================================');
  console.log(' "Super Trend 2 MACD" (TradingView Pine) on the 1m chart');
  console.log(` instrument ${args.symbol}   1m bars   data ${first} -> ${last}  (${candles.length} bars)`);
  console.log(
    ` inputs  SuperTrend factor=${P.factor} pd=${P.pd} (local 1m + main ${HTF_SEC / 60}m)   ` +
      `MACD ${P.macdFast}/${P.macdSlow}/${P.macdSignal} (SMA)   TP=${P.tpPoints} SL=${P.slPoints} pts`,
  );
  console.log(
    ` costs   entry taker ${(CFG.feeTaker * 1e4).toFixed(1)}bps + slip ${(CFG.slippage * 1e4).toFixed(1)}bps   ` +
      'stop taker+slip   target taker',
  );
  console.log(` sizing  risk ${(CFG.riskPct * 100).toFixed(2)}% of $${CFG.initialEquity} on a ${P.slPoints}-pt stop`);
  console.log(' main 2h SuperTrend = last COMPLETED 2h bar (non-repainting, no lookahead)');
  console.log(` window = the last ${args.days} calendar days`);
  console.log('============================================================');

  const built = buildSignals(candles, P);
  const holdAll = simulate(candles, built, 'hold', P);
  const revAll = simulate(candles, built, 'reverse', P);
  const stats = built.stats;

  console.log(
    `\nsignals: ${stats.localFlips} local SuperTrend flips, ` +
      `${stats.longRaw} up / ${stats.shortRaw} down; after 2h-trend + MACD filter ` +
      `${stats.long} long / ${stats.short} short`,
  );
  console.log(`2h bars built: ${htfTrendMap(candles, HTF_SEC, P.factor, P.pd).bars}`);

  console.log(`\n################  LAST ${args.days} DAYS  ################`);
  console.log('  model      trades  win%    tp   sl  flip   gross($)     costs($)      net($)   avgR gross  avgR net    PF  hold(min)');
  for (const [label, all] of [['hold', holdAll], ['reverse', revAll]]) {
    const win = lastNDays(all, args.days);
    const m = metrics(win);
    const r = new Map();
    for (const t of win) r.set(t.reason, (r.get(t.reason) || 0) + 1);
    console.log(
      `  ${label.padEnd(10)}${String(m.n).padStart(5)}  ${pct(m.winPct).padStart(6)}  ` +
        `${String(r.get('tp') || 0).padStart(3)}  ${String(r.get('sl') || 0).padStart(3)}  ${String(r.get('flip') || 0).padStart(4)}  ` +
        `${f2(m.gross).padStart(10)}  ${('-'+m.costs.toFixed(2)).padStart(11)}  ${f2(m.net).padStart(10)}  ` +
        `${f2(m.grossR).padStart(10)}  ${f2(m.netR).padStart(9)}  ` +
        `${(m.pf === Infinity ? 'inf' : m.pf.toFixed(2)).padStart(5)}  ${m.avgBars.toFixed(0).padStart(8)}`,
    );
  }

  console.log('\n  full 30-day history:');
  for (const [label, all] of [['hold', holdAll], ['reverse', revAll]]) {
    const m = metrics(all);
    console.log(
      `    ${label.padEnd(8)} trades ${String(m.n).padStart(4)}  win ${pct(m.winPct).padStart(6)}  ` +
        `avgR gross ${f2(m.grossR)} / net ${f2(m.netR)}  net ${f2(m.net)}  PF ${m.pf === Infinity ? 'inf' : m.pf.toFixed(2)}`,
    );
  }

  if (args.daily) {
    console.log('\n(reverse mode is the Pine-faithful one — daily shown for it)');
    printDaily(lastNDays(revAll, args.days));
  }
  console.log('');
}

if (require.main === module) main();

module.exports = {
  P,
  CFG,
  BAR_SEC,
  HTF_SEC,
  DAY_SEC,
  sma,
  rma,
  trueRange,
  superTrend,
  resample,
  macdSeries,
  htfTrendMap,
  buildSignals,
  simulate,
  metrics,
  lastNDays,
  printDaily,
  f2,
  pct,
};
