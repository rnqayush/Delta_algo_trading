// VWAP Breakout-Retest — the one indicator setup that pays Delta's fees.
//
// Why this setup and not the others: across the whole TradingView-style family
// scan (research-daily.js) the ONLY family that is net-positive in BOTH the
// in-sample and out-of-sample halves of the data is the session-VWAP retest.
// Donchian breakouts, opening-range breakouts and all "chase" entries lose on
// cost. The reason is mechanical, not statistical: a retest entry rests as a
// LIMIT at the VWAP (maker, 2 bps, no slippage) instead of paying the taker fee
// (5 bps) plus slippage, which roughly halves the round-trip cost in R terms.
//
// Setup (BTCUSD, 4h bars):
//   * indicator        session VWAP (reset 00:00 UTC) + ATR(14)
//   * signal           close crosses the VWAP (below->above = long bias)
//   * entry            resting LIMIT at the VWAP level, live for `retestWindow`
//                      bars (maker fill); abandoned if never retested
//   * stop             1.5 x ATR(14) beyond entry (market => taker + slippage)
//   * management       stop -> breakeven once +0.5R, then trail 2 x ATR from peak
//   * time-stop        flatten after `holdBars` (24h on 4h)
//   * sizing           0.5% equity risk per trade, notional capped at 3x equity
//
// Real Delta costs are modelled: 2 bps maker / 5 bps taker + 2 bps slippage.
//
//   node backtest/vwap-retest.js                 # full history + last 30 days
//   node backtest/vwap-retest.js --days 7        # also print a strict 7-day report
//   node backtest/vwap-retest.js --tf 1h         # cross-check on 1h bars

'use strict';

const { loadCache } = require('./lib/data');

const SYMBOL = 'BTCUSD';
const RES_SEC = { '1h': 3600, '4h': 14400 };

const CFG = {
  contractValue: 0.001,
  feeMaker: 0.0002,   // 2 bps  — limit entry, limit-friendly trail exits
  feeTaker: 0.0005,   // 5 bps  — stop / time exits
  slippage: 0.0002,   // 2 bps  — adverse, applied to market exits
  initialEquity: 1200,
  riskPct: 0.005,     // 0.5% of equity risked per trade
  maxNotionalPct: 3,  // notional <= 3x equity
};

// The tuned parameter set (identical shape to research-daily.js).
const P = {
  stopAtrMult: 1.5,
  beAtR: 0.5,
  trailAtrMult: 2.0,
  holdHours: 24,
  retestWindow: 8,
  vwapMinDistAtr: 0,
  atrPeriod: 14,
};

// ---------------------------------------------------------------------------
// indicators
// ---------------------------------------------------------------------------

const dayKey = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);

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

function dailyVwap(candles) {
  const n = candles.length;
  const out = new Array(n).fill(null);
  let pv = 0;
  let vv = 0;
  let cur = null;
  for (let i = 0; i < n; i += 1) {
    const d = dayKey(candles[i].time);
    if (d !== cur) { cur = d; pv = 0; vv = 0; }
    const c = candles[i];
    const tp = (c.high + c.low + c.close) / 3;
    pv += tp * c.volume;
    vv += c.volume;
    out[i] = vv > 0 ? pv / vv : c.close;
  }
  return out;
}

function dayBounds(candles) {
  const n = candles.length;
  const dayEnd = new Array(n).fill(n - 1);
  let s = 0;
  for (let i = 1; i <= n; i += 1) {
    if (i === n || dayKey(candles[i].time) !== dayKey(candles[s].time)) {
      for (let j = s; j < i; j += 1) dayEnd[j] = i - 1;
      s = i;
    }
  }
  return { dayEnd };
}

// A signal at bar i = "VWAP was crossed on the close of bar i". The retest
// limit is attempted from bar i+1 onward.
function genSignals(candles, base) {
  const n = candles.length;
  const sigs = new Array(n).fill(null);
  let above = false;
  for (let i = 1; i < n; i += 1) {
    const v = base.vwap[i];
    if (v == null || base.atr[i] == null) continue;
    const c = candles[i].close;
    const isAbove = c > v;
    const far = Math.abs(c - v) >= P.vwapMinDistAtr * base.atr[i];
    if (isAbove && !above && far) sigs[i] = { side: 'long', level: v };
    else if (!isAbove && above && far) sigs[i] = { side: 'short', level: v };
    above = isAbove;
  }
  return sigs;
}

// ---------------------------------------------------------------------------
// simulator
// ---------------------------------------------------------------------------

function sizeContracts(entry, stop) {
  const stopDist = Math.abs(entry - stop);
  if (!(stopDist > 0)) return 0;
  const byRisk = Math.floor((CFG.initialEquity * CFG.riskPct) / (stopDist * CFG.contractValue));
  const byNotional = Math.floor((CFG.initialEquity * CFG.maxNotionalPct) / (entry * CFG.contractValue));
  return Math.max(0, Math.min(byRisk, byNotional));
}

function run(candles, base, resSec) {
  const n = candles.length;
  const holdBars = Math.max(1, Math.round((P.holdHours * 3600) / resSec));
  const sigs = genSignals(candles, base);
  const trades = [];

  let pending = null;
  let pos = null;

  const closePos = (exitPrice, bar, reason, isMaker) => {
    const dir = pos.side === 'long' ? 1 : -1;
    const exitFee = exitPrice * pos.contracts * CFG.contractValue * (isMaker ? CFG.feeMaker : CFG.feeTaker);
    const fees = pos.entryFee + exitFee;
    const gross = (exitPrice - pos.entry) * dir * pos.contracts * CFG.contractValue;
    const net = gross - fees;
    trades.push({
      day: dayKey(bar.time),
      side: pos.side,
      entry: pos.entry,
      exit: exitPrice,
      stop: pos.stop,
      contracts: pos.contracts,
      risk: pos.risk,
      net,
      fees,
      rMultiple: net / Math.max(1e-9, pos.riskAmount),
      reason,
      entryTime: pos.barTime,
      exitTime: bar.time,
    });
    pos = null;
  };

  for (let i = Math.max(P.atrPeriod * 3, 60); i < n; i += 1) {
    const bar = candles[i];
    const atrV = base.atr[i];

    // 1. work the resting limit at the VWAP level
    if (!pos && pending) {
      if (i > pending.expires) {
        pending = null;
      } else {
        const dir = pending.side === 'long' ? 1 : -1;
        const level = base.vwap[i];
        let fill = null;
        if (level != null) {
          if (pending.side === 'long' && bar.low <= level) fill = Math.min(bar.open, level);
          else if (pending.side === 'short' && bar.high >= level) fill = Math.max(bar.open, level);
        }
        if (fill != null && atrV != null) {
          const stop = fill - dir * P.stopAtrMult * atrV;
          const contracts = sizeContracts(fill, stop);
          if (contracts > 0) {
            pos = {
              side: pending.side,
              entry: fill,
              stop,
              risk: Math.abs(fill - stop),
              riskAmount: Math.abs(fill - stop) * contracts * CFG.contractValue,
              contracts,
              entryFee: fill * contracts * CFG.contractValue * CFG.feeMaker,
              barTime: bar.time,
              entryBar: i,
              peak: fill,
            };
          }
        }
        pending = null;
      }
    }

    // 2. manage the open position (breakeven + ATR trail + time stop)
    if (pos) {
      const dir = pos.side === 'long' ? 1 : -1;
      const prevClose = candles[i - 1].close;
      pos.peak = dir === 1 ? Math.max(pos.peak, prevClose) : Math.min(pos.peak, prevClose);
      const advance = (pos.peak - pos.entry) * dir;
      const candidates = [pos.stop];
      if (P.beAtR > 0 && advance >= P.beAtR * pos.risk) candidates.push(pos.entry);
      if (P.trailAtrMult > 0 && atrV != null) candidates.push(pos.peak - dir * P.trailAtrMult * atrV);
      const candidate = dir === 1 ? Math.max(...candidates) : Math.min(...candidates);
      if (dir === 1 ? candidate > pos.stop : candidate < pos.stop) pos.stop = candidate;

      const hitStop = dir === 1 ? bar.low <= pos.stop : bar.high >= pos.stop;
      if (hitStop) closePos(pos.stop, bar, 'stop', false);
      else if (i - pos.entryBar >= holdBars) closePos(bar.close, bar, 'time', false);
    }

    // 3. arm a new retest limit on a fresh signal
    if (!pos && !pending && sigs[i] && i + 1 < n) {
      pending = { side: sigs[i].side, expires: i + P.retestWindow };
    }
  }

  if (pos) closePos(candles[n - 1].close, candles[n - 1], 'time', false);
  return trades;
}

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------

function summarise(trades) {
  const n = trades.length;
  const net = trades.reduce((s, t) => s + t.net, 0);
  const wins = trades.filter((t) => t.net > 0);
  const gp = wins.reduce((s, t) => s + t.net, 0);
  const gl = Math.abs(trades.filter((t) => t.net <= 0).reduce((s, t) => s + t.net, 0));
  const costs = trades.reduce((s, t) => s + t.fees, 0);
  const byDay = new Map();
  for (const t of trades) byDay.set(t.day, (byDay.get(t.day) || 0) + t.net);
  const days = byDay.size || 1;
  const green = [...byDay.values()].filter((v) => v > 0).length;
  return {
    n, net, costs,
    wr: n ? (wins.length / n) * 100 : 0,
    pf: gl > 0 ? gp / gl : gp > 0 ? Infinity : 0,
    avgR: n ? trades.reduce((s, t) => s + t.rMultiple, 0) / n : 0,
    days, green,
    perDay: n / days,
    bestDay: Math.max(0, ...[...byDay.values()]),
    worstDay: Math.min(0, ...[...byDay.values()]),
  };
}

function dayTable(trades, days) {
  const byDay = new Map();
  for (const t of trades) {
    const d = byDay.get(t.day) || { n: 0, w: 0, net: 0 };
    d.n += 1;
    if (t.net > 0) d.w += 1;
    d.net += t.net;
    byDay.set(t.day, d);
  }
  const rows = [...byDay.entries()].sort().slice(-days);
  return rows;
}

function printDayRows(rows) {
  let cum = 0;
  console.log('  date         trades  wins      net($)     cum($)');
  for (const [d, x] of rows) {
    cum += x.net;
    const net = `${x.net >= 0 ? '+' : ''}${x.net.toFixed(2)}`.padStart(10);
    const c = `${cum >= 0 ? '+' : ''}${cum.toFixed(2)}`.padStart(10);
    console.log(`  ${d}  ${String(x.n).padStart(5)}  ${String(x.w).padStart(4)}  ${net}  ${c}`);
  }
}

function parseArgs(argv) {
  const a = { tf: '4h', days: 30 };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--tf') a.tf = argv[++i];
    else if (argv[i] === '--days') a.days = Number(argv[++i]);
  }
  return a;
}

function main() {
  const args = parseArgs(process.argv);
  const resSec = RES_SEC[args.tf];
  if (!resSec) throw new Error(`Unsupported tf "${args.tf}" (use 1h or 4h)`);

  const cached = loadCache(SYMBOL, args.tf);
  if (!cached) throw new Error(`No ${args.tf} cache. Run: node backtest/fetch.js --timeframes ${args.tf}`);

  const candles = cached.candles;
  const base = { atr: atr(candles, P.atrPeriod), vwap: dailyVwap(candles), dayEnd: dayBounds(candles).dayEnd };
  const trades = run(candles, base, resSec);

  const first = dayKey(candles[0].time);
  const last = dayKey(candles[candles.length - 1].time);

  console.log('============================================================');
  console.log(' SETUP: VWAP Breakout-Retest   (session VWAP + ATR(14) trail)');
  console.log(` instrument ${SYMBOL}   timeframe ${args.tf}   data ${first} -> ${last}`);
  console.log(` costs  maker ${(CFG.feeMaker * 1e4).toFixed(1)}bps / taker ${(CFG.feeTaker * 1e4).toFixed(1)}bps + ${(CFG.slippage * 1e4).toFixed(1)}bps slip`);
  console.log(` risk ${(CFG.riskPct * 100).toFixed(2)}%/trade   equity $${CFG.initialEquity}`);
  console.log('------------------------------------------------------------');
  console.log(` entry   LIMIT at session VWAP (maker), valid ${P.retestWindow} bars`);
  console.log(` stop    ${P.stopAtrMult} x ATR(14)  ->  breakeven at +${P.beAtR}R  ->  trail ${P.trailAtrMult} x ATR`);
  console.log(` exit    trail stop hit, or time-stop after ${P.holdHours}h`);
  console.log('============================================================');

  const s = summarise(trades);
  console.log('\n--- full history ---');
  console.log(` trades=${s.n}  winRate=${s.wr.toFixed(1)}%  profitFactor=${s.pf === Infinity ? 'inf' : s.pf.toFixed(2)}  avgR=${s.avgR.toFixed(2)}`);
  console.log(` gross costs paid = -$${s.costs.toFixed(2)}`);
  console.log(` net = ${s.net >= 0 ? '+' : ''}$${s.net.toFixed(2)}   equity $${CFG.initialEquity} -> $${(CFG.initialEquity + s.net).toFixed(2)}  (${((s.net / CFG.initialEquity) * 100).toFixed(1)}%)`);
  console.log(` trading days=${s.days}  green=${s.green} (${((s.green / s.days) * 100).toFixed(0)}%)  ~${s.perDay.toFixed(2)} trades/day`);

  const byYear = new Map();
  for (const t of trades) {
    const y = t.day.slice(0, 4);
    const a = byYear.get(y) || { n: 0, net: 0, w: 0 };
    a.n += 1;
    a.w += t.net > 0 ? 1 : 0;
    a.net += t.net;
    byYear.set(y, a);
  }
  console.log('\n--- by year (robustness) ---');
  for (const [y, a] of [...byYear.entries()].sort()) {
    console.log(`  ${y}  trades=${String(a.n).padStart(4)}  win%=${((a.w / a.n) * 100).toFixed(0).padStart(3)}  net=${a.net >= 0 ? '+' : ''}$${a.net.toFixed(2)}`);
  }

  const reasons = new Map();
  for (const t of trades) reasons.set(t.reason, (reasons.get(t.reason) || 0) + 1);
  console.log(`  exits: ${[...reasons.entries()].map(([k, v]) => `${k}=${v}`).join('  ')}`);

  // 7-day report (the requested window) + a wider 30-day backdrop
  const win7 = dayTable(trades, 7);
  const s7 = summarise(trades.filter((t) => win7.some(([d]) => d === t.day)));
  console.log(`\n--- last 7 days (requested) ---`);
  console.log(` trades=${s7.n}  winRate=${s7.wr.toFixed(1)}%  profitFactor=${s7.pf === Infinity ? 'inf' : s7.pf.toFixed(2)}  avgR=${s7.avgR.toFixed(2)}`);
  console.log(` net = ${s7.net >= 0 ? '+' : ''}$${s7.net.toFixed(2)}   green days=${s7.green}/${win7.length}`);
  printDayRows(win7);

  const win30 = dayTable(trades, 30);
  console.log(`\n--- last 30 days (context) ---`);
  printDayRows(win30);
}

main();
