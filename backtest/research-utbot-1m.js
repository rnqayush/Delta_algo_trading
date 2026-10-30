// Backtest of the "UT Bot alerts strategy" (StrategiesForEveryone, Pine v5)
// ported to Delta Exchange candles.
//
// Original logic — the parts that actually drive trades:
//
//   ema200  = ta.ema(close, 200)
//   bullish = close > ema200 ;  bearish = close < ema200
//   xATR    = ta.atr(1) ;  nLoss = 3 * xATR          // UT Bot "Key Value" a = 3
//   trail   = classic UT Bot ATR trailing stop (flips side when close crosses it)
//   above   = ta.crossover(close, trail)
//   below   = ta.crossover(trail, close)
//   buy     = close >  trail and above
//   sell    = close <  trail and below
//
//   Long  entry : flat, `buy`, bullish,  in session, date filter
//   Short entry : flat, `sell`, bearish, in session, date filter
//
//   Stop loss   : ATR stop (garethyeo, modified) -> close -/+ 1.5 * ta.atr(14)
//   Take profit : +3.0 R, 50% of the position
//   Break even  : once the trade is +0.75 R the stop moves to the entry price
//   Signal close: strategy.close() when the opposite signal fires AND the trade
//                 is in profit
//   Sizing      : risk based -> qty = equity * risk% / stopDistance
//                 (script `risk` = 2.5, `leverage` = true -> notional is NOT
//                 capped by equity, so this is a leveraged size)
//
// This runs the port twice: as written (NORMAL), and with buy/sell SWAPPED
// (every trigger takes the OPPOSITE side, and the ATR stop / break-even /
// target mirror with it). The swap is applied to the trigger, so the EMA200
// trend gate keeps deciding *when* we trade — we simply fade it.
//
// Modelling choices (kept honest):
//   * signals read the last CLOSED bar; entries fill at that close
//     (process_orders_on_close = true in the source).
//   * intrabar the STOP is assumed to fill before the TARGET (TradingView's
//     worst-case tie-break).
//   * the 50% take-profit leg is modelled as a maker (limit) fill; every stop
//     and every entry/close is a market leg (taker + 2 bps slippage).
//   * equity is held FIXED at the reference size so P&L is path-independent and
//     comparable across symbols: 1 R = risk% of the reference equity.
//
//   node backtest/research-utbot-1m.js
//   node backtest/research-utbot-1m.js --days 7 --tf 1m
//   node backtest/research-utbot-1m.js --symbols BTCUSD,ETHUSD --tf 5m

'use strict';

const { loadCache } = require('./lib/data');

const ALL_SYMBOLS = ['BTCUSD', 'ETHUSD', 'SOLUSD', 'XRPUSD', 'DOGEUSD'];
const RES_SEC = { '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600 };

// Delta retail: taker 5 bps, maker 2 bps, market legs slip ~2 bps.
const CFG = {
  initialEquity: 1200,
  riskPct: 2.5, // source `risk` input = 2.5 (% of equity per trade)
  feeTaker: 0.0005, // 5 bps
  feeMaker: 0.0002, // 2 bps
  slippage: 0.0002, // 2 bps, market legs only
};

const STRAT = {
  emaLen: 200,
  keyValue: 3, // UT Bot `a`
  atrPeriod: 1, // UT Bot `c`
  slAtrLen: 14, // ATR stop loss period
  slAtrMult: 1.5, // ATR stop loss multiplier
  rrBe: 0.75, // break-even at +0.75 R
  rrTp: 3.0, // take profit at +3.0 R
  tpPercent: 50, // % of position taken at the target
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

// Pine ta.atr = Wilder RMA of true range, seeded with the SMA of the first
// `period` TRs.
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

// UT Bot ATR trailing stop + its internal `pos` state.
function utbot(candles, a, c) {
  const n = candles.length;
  const xatr = atr(candles, c);
  const trail = new Array(n).fill(null);
  const posArr = new Array(n).fill(0);
  for (let i = 1; i < n; i += 1) {
    if (xatr[i] == null) continue;
    const src = candles[i].close;
    const src1 = candles[i - 1].close;
    const nLoss = a * xatr[i];
    const t1 = trail[i - 1] == null ? 0 : trail[i - 1];

    let t;
    if (src > t1 && src1 > t1) t = Math.max(t1, src - nLoss);
    else if (src < t1 && src1 < t1) t = Math.min(t1, src + nLoss);
    else if (src > t1) t = src - nLoss;
    else t = src + nLoss;
    trail[i] = t;

    if (src1 < t1 && src > t1) posArr[i] = 1;
    else if (src1 > t1 && src < t1) posArr[i] = -1;
    else posArr[i] = posArr[i - 1];
  }
  return { trail, posArr };
}

function signals(candles) {
  const n = candles.length;
  const closes = candles.map((c) => c.close);
  const ema200 = ema(closes, STRAT.emaLen);
  const { trail } = utbot(candles, STRAT.keyValue, STRAT.atrPeriod);
  const atrSL = atr(candles, STRAT.slAtrLen);

  const bullish = new Array(n).fill(false);
  const bearish = new Array(n).fill(false);
  const buy = new Array(n).fill(false);
  const sell = new Array(n).fill(false);

  for (let i = 1; i < n; i += 1) {
    if (ema200[i] != null) {
      bullish[i] = closes[i] > ema200[i];
      bearish[i] = closes[i] < ema200[i];
    }
    const t = trail[i];
    const tp = trail[i - 1];
    if (t == null || tp == null) continue;
    const above = closes[i - 1] < tp && closes[i] > t; // ta.crossover(close, trail)
    const below = tp < closes[i - 1] && t > closes[i]; // ta.crossover(trail, close)
    buy[i] = closes[i] > t && above;
    sell[i] = closes[i] < t && below;
  }
  return { buy, sell, bullish, bearish, trail, atrSL, ema200 };
}

// ---------------------------------------------------------------------------
// simulation
// ---------------------------------------------------------------------------

function simulate(candles, sg, reverse, barSec) {
  const n = candles.length;
  const E = CFG.initialEquity;
  const riskDollar = (E * CFG.riskPct) / 100; // 1 R
  const mktLeg = CFG.feeTaker + CFG.slippage; // market in / out
  const limLeg = CFG.feeMaker; // resting limit (take-profit)
  const trades = [];
  let pos = null;

  const openLeg = (bar, price, frac, kind) => {
    const legQty = pos.qty * frac;
    const notional = legQty * price;
    const fee = notional * (kind === 'tp' ? limLeg : mktLeg);
    pos.gross += legQty * pos.dir * (price - pos.entryRaw);
    pos.fees += fee;
    pos.legs.push({ kind, price, frac });
  };

  const finish = (bar, reason) => {
    if (pos.legs.length === 0) openLeg(bar, bar.close, pos.remaining, 'close');
    pos.exitTime = bar.time;
    pos.exitReason = reason;
    pos.net = pos.gross - pos.fees;
    pos.R = pos.net / riskDollar;
    pos.day = new Date(pos.exitTime * 1000).toISOString().slice(0, 10);
    pos.bars = (pos.exitTime - pos.entryTime) / barSec;
    trades.push(pos);
    pos = null;
  };

  const open = (bar, side) => {
    const dist = sg.atrSL[bar.i] == null ? null : sg.atrSL[bar.i] * STRAT.slAtrMult;
    if (dist == null || !(dist > 0)) return false;
    const dir = side === 'long' ? 1 : -1;
    const entryRaw = bar.close;
    const qty = riskDollar / dist; // risk-based size (leverage = true, uncapped)
    pos = {
      side,
      dir,
      entryRaw,
      entryTime: bar.time,
      qty,
      riskDollar,
      stopDist: dist,
      slRaw: entryRaw - dir * dist,
      beRaw: entryRaw + dir * dist * STRAT.rrBe,
      tpRaw: entryRaw + dir * dist * STRAT.rrTp,
      remaining: 1,
      gross: 0,
      fees: qty * entryRaw * mktLeg, // entry leg
      legs: [],
    };
    return true;
  };

  for (let i = 1; i < n; i += 1) {
    const bar = { i, time: candles[i].time, high: candles[i].high, low: candles[i].low, close: candles[i].close };

    // (1) manage the open position on this bar's range
    if (pos) {
      const rawLong = sg.buy[i] && sg.bullish[i];
      const rawShort = sg.sell[i] && sg.bearish[i];
      const trigLong = reverse ? rawShort : rawLong;
      const trigShort = reverse ? rawLong : rawShort;
      const closeTrigger = pos.side === 'long' ? trigShort : trigLong;

      // stop first (worst-case tie-break)
      const stopHit = pos.dir === 1 ? bar.low <= pos.slRaw : bar.high >= pos.slRaw;
      const tpHit = pos.dir === 1 ? bar.high >= pos.tpRaw : bar.low <= pos.tpRaw;
      const beHit = pos.dir === 1 ? bar.high >= pos.beRaw : bar.low <= pos.beRaw;

      if (stopHit) {
        openLeg(bar, pos.slRaw, pos.remaining, 'stop');
        finish(bar, 'stop');
      } else if (pos.remaining > 0.5 + 1e-9 && tpHit) {
        // (2) 50% take profit
        openLeg(bar, pos.tpRaw, pos.remaining * (STRAT.tpPercent / 100), 'tp');
        pos.remaining *= 1 - STRAT.tpPercent / 100;
        // (3) signal close of whatever is left
        if (closeTrigger && pos.dir * (bar.close - pos.entryRaw) > 0) {
          openLeg(bar, bar.close, pos.remaining, 'close');
          finish(bar, 'signal');
        } else if (beHit) {
          pos.slRaw = pos.entryRaw; // break-even move, effective next bar
        }
      } else if (closeTrigger && pos.dir * (bar.close - pos.entryRaw) > 0) {
        openLeg(bar, bar.close, pos.remaining, 'close');
        finish(bar, 'signal');
      } else if (beHit) {
        pos.slRaw = pos.entryRaw; // break-even move, effective next bar
      }
    }

    // (4) entries on the close of this bar
    const rawLong = sg.buy[i] && sg.bullish[i];
    const rawShort = sg.sell[i] && sg.bearish[i];
    let want = rawLong ? 'long' : rawShort ? 'short' : null;
    if (reverse && want) want = want === 'long' ? 'short' : 'long';
    if (want && (!pos || pos.side !== want)) {
      if (pos) finish(bar, 'flip'); // Pine nets the opposite entry into a flip
      open(bar, want);
    }
  }

  if (pos) {
    const last = candles[n - 1];
    openLeg({ i: n - 1, time: last.time, high: last.high, low: last.low, close: last.close }, last.close, pos.remaining, 'close');
    finish({ time: last.time, close: last.close }, 'open');
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

  const stopped = trades.filter((t) => t.exitReason === 'stop').length;
  const signalled = trades.filter((t) => t.exitReason === 'signal').length;

  return {
    n,
    gross: sum((t) => t.gross),
    net: sum((t) => t.net),
    costs: sum((t) => t.fees),
    long: trades.filter((t) => t.side === 'long').length,
    short: trades.filter((t) => t.side === 'short').length,
    winPct: n ? (wins / n) * 100 : 0,
    pf: gl > 0 ? gp / gl : gp > 0 ? Infinity : 0,
    avgR: n ? sum((t) => t.R) / n : 0,
    grossR: n ? sum((t) => t.gross / t.riskDollar) / n : 0,
    costR: n ? sum((t) => t.fees / t.riskDollar) / n : 0,
    avgBars: n ? sum((t) => t.bars) / n : 0,
    stopped,
    signalled,
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
    `  ${label.padEnd(18)} trades ${String(m.n).padStart(5)} (${(m.n / days).toFixed(1)}/day)  ` +
      `L/S ${m.long}/${m.short}  win% ${pct(m.winPct).padStart(6)}  PF ${pf(m.pf).padStart(5)}  ` +
      `avg gross ${f2(m.grossR).padStart(6)}R - cost ${m.costR.toFixed(2).padStart(6)}R = net ${f2(m.avgR).padStart(6)}R  ` +
      `net $${f2(m.net).padStart(9)} (${((m.net / CFG.initialEquity) * 100).toFixed(2)}%)  ` +
      `stop/sig ${m.stopped}/${m.signalled}  hold ${m.avgBars.toFixed(0)} bars`,
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
  const a = { days: 7, symbols: ALL_SYMBOLS, tf: '1m' };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--days') a.days = Number(argv[++i]);
    else if (argv[i] === '--symbols') a.symbols = String(argv[++i]).split(',').map((s) => s.trim().toUpperCase());
    else if (argv[i] === '--tf') a.tf = String(argv[++i]);
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
  const riskDollar = (CFG.initialEquity * CFG.riskPct) / 100;

  console.log('='.repeat(118));
  console.log(' UT Bot alerts strategy (StrategiesForEveryone) — backtest on Delta Exchange');
  console.log(` EMA(200) trend gate + UT Bot ATR trail (a=${STRAT.keyValue}, atr=${STRAT.atrPeriod})   ` +
    `stop ${STRAT.slAtrMult}xATR(${STRAT.slAtrLen})   TP ${STRAT.rrTp}R (${STRAT.tpPercent}%)   BE ${STRAT.rrBe}R`);
  console.log(` ${args.tf} bars   data ${new Date(first[0].time * 1000).toISOString().slice(0, 16)} -> ` +
    `${new Date(first[first.length - 1].time * 1000).toISOString().slice(0, 16)} UTC   report window = last ${args.days} calendar days`);
  console.log(` sizing risk ${CFG.riskPct}% of $${CFG.initialEquity} = $${riskDollar.toFixed(2)} per trade (1 R, leverage uncapped)   ` +
    `costs taker ${(CFG.feeTaker * 1e4).toFixed(1)}bps + slip ${(CFG.slippage * 1e4).toFixed(1)}bps (market), maker ${(CFG.feeMaker * 1e4).toFixed(1)}bps (target)`);
  console.log('='.repeat(118));

  // --- per-symbol, normal vs buy/sell swapped -----------------------------
  console.log(`\n\n################  ${args.tf} — NORMAL vs BUY/SELL SWAPPED — LAST ${args.days} DAYS  ################`);
  const agg = { normal: { net: 0, n: 0 }, swap: { net: 0, n: 0 } };
  for (const [sym, candles] of data) {
    const sg = signals(candles);
    const nat = lastNDays(simulate(candles, sg, false, barSec), args.days);
    const swp = lastNDays(simulate(candles, sg, true, barSec), args.days);
    const mn = metrics(nat);
    const ms = metrics(swp);
    agg.normal.net += mn.net; agg.normal.n += mn.n;
    agg.swap.net += ms.net; agg.swap.n += ms.n;
    console.log('');
    line(`${sym} normal`, mn, args.days);
    line(`${sym} SWAPPED`, ms, args.days);
  }

  // --- daily detail for the primary symbol -------------------------------
  const candlesP = data.get(primary);
  const sgP = signals(candlesP);
  const rawL = sgP.buy.filter(Boolean).length;
  const rawS = sgP.sell.filter(Boolean).length;
  console.log(`\n\n${primary} raw UT Bot triggers in cached data: buy ${rawL}, sell ${rawS}`);

  for (const [tag, rev] of [['BUY/SELL SWAPPED', true], ['NORMAL', false]]) {
    const t = lastNDays(simulate(candlesP, sgP, rev, barSec), args.days);
    console.log(`\n\n--- ${primary} ${args.tf} — ${tag} — daily (last ${args.days} days) ---`);
    if (!t.length) {
      console.log('  no trades');
      continue;
    }
    line('TOTAL', metrics(t), args.days);
    printDaily(t);
  }

  console.log('\n\n################  SUMMARY  ################');
  const eq = CFG.initialEquity * data.size;
  console.log(
    `  NORMAL         ${String(agg.normal.n).padStart(6)} trades  net $${f2(agg.normal.net).padStart(10)}  (${((agg.normal.net / eq) * 100).toFixed(2)}% of $${eq})`,
  );
  console.log(
    `  BUY/SELL SWAP  ${String(agg.swap.n).padStart(6)} trades  net $${f2(agg.swap.net).padStart(10)}  (${((agg.swap.net / eq) * 100).toFixed(2)}% of $${eq})`,
  );
  console.log('');
}

if (require.main === module) main();

module.exports = { simulate, signals, metrics, utbot, atr, ema, CFG, STRAT };
