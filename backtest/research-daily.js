// Research: which mechanizable strategy family from the TradingView scan can
// actually pay Delta's fees on BTC, and does a per-day profit lock help?
//
//   node backtest/research-daily.js --stage families --tf both   # family search
//   node backtest/research-daily.js --stage lock     --tf 15m    # daily-lock search
//   node backtest/research-daily.js --report --tf 15m            # day-wise report
//
// The TradingView scan (scripts/?script_type=strategies) is dominated by one
// repeated structural idea, shared by the highest-quality entries:
//
//     breakout -> RETEST -> confirmation -> entry      (never chase)
//
// That matters for cost, not just for edge: a retest entry can rest as a LIMIT
// (maker, 2 bps, no slippage) instead of paying the taker fee (5 bps) plus
// slippage. On a 1.5-ATR stop the round trip goes from ~1.0R to ~0.5R.
//
// Families implemented here (all taken from the scan):
//   donchian  - N-bar channel breakout            (Turtle breakout, CNPS21)
//   openrange - break of the first K bars of the UTC day  (intraday ORB)
//   vwap      - break of the daily VWAP, retest   (CNPS18 VWAP retest)
//
// Reality rules, unchanged from the rest of the project:
//   * signals only on CLOSED bars
//   * retest entries fill as resting limits; chase entries fill at next open
//   * if a bar contains both stop and target, the STOP is assumed first
//   * real Delta fees (2 bps maker / 5 bps taker) + 2 bps adverse slippage
//   * fixed-fractional sizing from the stop distance, capped by notional

'use strict';

const { loadCache } = require('./lib/data');

const SYMBOL = 'BTCUSD';
const RES_SEC = { '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400 };

// ---------------------------------------------------------------------------
// Indicators
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

// hi[i] = highest high of the `N` bars BEFORE i (so bar i can break it).
function donchian(candles, N) {
  const n = candles.length;
  const hi = new Array(n).fill(null);
  const lo = new Array(n).fill(null);
  for (let i = N; i < n; i += 1) {
    let h = -Infinity;
    let l = Infinity;
    for (let j = i - N; j < i; j += 1) {
      if (candles[j].high > h) h = candles[j].high;
      if (candles[j].low < l) l = candles[j].low;
    }
    hi[i] = h;
    lo[i] = l;
  }
  return { hi, lo };
}

// Session VWAP, reset at each UTC day boundary.
function dailyVwap(candles) {
  const n = candles.length;
  const out = new Array(n).fill(null);
  let pv = 0;
  let vv = 0;
  let cur = null;
  for (let i = 0; i < n; i += 1) {
    const d = dayKey(candles[i].time);
    if (d !== cur) {
      cur = d;
      pv = 0;
      vv = 0;
    }
    const c = candles[i];
    const tp = (c.high + c.low + c.close) / 3;
    const v = c.volume || 0;
    pv += tp * v;
    vv += v;
    out[i] = vv > 0 ? pv / vv : c.close;
  }
  return out;
}

function dayKey(sec) {
  return new Date(sec * 1000).toISOString().slice(0, 10);
}

// First/last bar index of each UTC day, per bar.
function dayBounds(candles) {
  const n = candles.length;
  const dayStart = new Array(n).fill(0);
  const dayEnd = new Array(n).fill(n - 1);
  let s = 0;
  for (let i = 1; i <= n; i += 1) {
    if (i === n || dayKey(candles[i].time) !== dayKey(candles[s].time)) {
      for (let j = s; j < i; j += 1) {
        dayStart[j] = s;
        dayEnd[j] = i - 1;
      }
      s = i;
    }
  }
  return { dayStart, dayEnd };
}

// Opening range = high/low of the first K bars of each UTC day.
function openRange(candles, bounds, K) {
  const n = candles.length;
  const hi = new Array(n).fill(null);
  const lo = new Array(n).fill(null);
  for (let i = 0; i < n; i += 1) {
    if (bounds.dayStart[i] !== i) continue;
    const s = i;
    const e = Math.min(s + K - 1, bounds.dayEnd[i]);
    if (e - s + 1 < K) continue;
    let h = -Infinity;
    let l = Infinity;
    for (let j = s; j <= e; j += 1) {
      if (candles[j].high > h) h = candles[j].high;
      if (candles[j].low < l) l = candles[j].low;
    }
    for (let j = s; j <= bounds.dayEnd[i]; j += 1) {
      hi[j] = h;
      lo[j] = l;
    }
  }
  return { hi, lo };
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

// A signal at bar i means "decided at the close of bar i". Entry is attempted
// from bar i+1. `level` is the price a retest limit rests at.
function genSignals(family, candles, base, p) {
  const n = candles.length;
  const sigs = new Array(n).fill(null);

  if (family === 'donchian') {
    const { hi, lo } = donchian(candles, p.lookback);
    let open_ = false;
    for (let i = 1; i < n; i += 1) {
      if (hi[i] == null) continue;
      const c = candles[i].close;
      if (c > hi[i]) {
        if (!open_) sigs[i] = { side: 'long', level: hi[i] };
        open_ = true;
      } else if (c < lo[i]) {
        if (open_) sigs[i] = { side: 'short', level: lo[i] };
        open_ = false;
      } else {
        open_ = false;
      }
    }
  } else if (family === 'openrange') {
    const K = p.orBars;
    const { hi, lo } = openRange(candles, base.bounds, K);
    let cur = null;
    let longDone = false;
    let shortDone = false;
    for (let i = 0; i < n; i += 1) {
      const d = dayKey(candles[i].time);
      if (d !== cur) {
        cur = d;
        longDone = false;
        shortDone = false;
      }
      if (hi[i] == null || i < base.bounds.dayStart[i] + K) continue;
      const c = candles[i].close;
      if (c > hi[i] && !longDone) {
        sigs[i] = { side: 'long', level: hi[i] };
        longDone = true;
      } else if (c < lo[i] && !shortDone) {
        sigs[i] = { side: 'short', level: lo[i] };
        shortDone = true;
      }
    }
  } else if (family === 'vwap') {
    let above = false;
    for (let i = 1; i < n; i += 1) {
      const v = base.vwap[i];
      if (v == null || base.atr[i] == null) continue;
      const c = candles[i].close;
      const isAbove = c > v;
      const far = Math.abs(c - v) >= p.vwapMinDistAtr * base.atr[i];
      if (isAbove && !above && far) sigs[i] = { side: 'long', level: v, useVwap: true };
      else if (!isAbove && above && far) sigs[i] = { side: 'short', level: v, useVwap: true };
      above = isAbove;
    }
  }

  return sigs;
}

// ---------------------------------------------------------------------------
// Simulator
// ---------------------------------------------------------------------------

function sizeContracts(entry, stop, cfg) {
  const stopDist = Math.abs(entry - stop);
  if (!(stopDist > 0)) return 0;
  const byRisk = Math.floor((cfg.initialEquity * cfg.riskPct) / (stopDist * cfg.contractValue));
  const byNotional = Math.floor(
    (cfg.initialEquity * cfg.maxNotionalPct) / (entry * cfg.contractValue)
  );
  return Math.max(0, Math.min(byRisk, byNotional));
}

function runSim(candles, base, sigs, p, cfg) {
  const n = candles.length;
  const start = Math.max(p.lookback, 60);
  let equity = cfg.initialEquity;
  const trades = [];

  let pending = null; // { side, level, useVwap, market, expires }
  let pos = null;

  const dayPnl = new Map();
  const lockedDays = new Set();
  let lockedSkips = 0;

  const evalDay = (d) => dayPnl.get(d) || 0;

  function closePos(exitPrice, bar, reason, isMaker) {
    const dir = pos.side === 'long' ? 1 : -1;
    const exitNotional = exitPrice * pos.contracts * cfg.contractValue;
    const exitFee = exitNotional * (isMaker ? cfg.feeMaker : cfg.feeTaker);
    const fees = pos.entryFee + exitFee;
    const gross = (exitPrice - pos.entry) * dir * pos.contracts * cfg.contractValue;
    const net = gross - fees;
    equity += net;
    const d = dayKey(bar.time);
    dayPnl.set(d, evalDay(d) + net);
    trades.push({
      day: d,
      side: pos.side,
      entry: pos.entry,
      exit: exitPrice,
      stop: pos.stop,
      contracts: pos.contracts,
      risk: Math.abs(pos.entry - pos.stop),
      net,
      fees,
      rMultiple: net / Math.max(1e-9, pos.riskAmount),
      reason,
      entryTime: pos.barTime,
      exitTime: bar.time,
      dayPnlAfter: evalDay(d),
    });
    pos = null;
  }

  for (let i = start; i < n; i += 1) {
    const bar = candles[i];
    const atrV = base.atr[i];
    const day = dayKey(bar.time);

    // --- 1. fill the pending entry (limit for retest, open for chase) ---
    if (!pos && pending) {
      if (i > pending.expires) {
        pending = null;
      } else {
        const dir = pending.side === 'long' ? 1 : -1;
        const level = pending.useVwap ? base.vwap[i] : pending.level;
        let fill = null;
        if (pending.market) fill = bar.open * (1 + cfg.slippageBps * dir);
        else if (level != null) {
          if (pending.side === 'long' && bar.low <= level) fill = Math.min(bar.open, level);
          else if (pending.side === 'short' && bar.high >= level) fill = Math.max(bar.open, level);
        }

        if (fill != null && atrV != null) {
          const stop = fill - dir * p.stopAtrMult * atrV;
          const contracts = sizeContracts(fill, stop, cfg);
          if (contracts > 0) {
            const maker = !pending.market;
            pos = {
              side: pending.side,
              entry: fill,
              stop,
              risk: Math.abs(fill - stop),
              riskAmount: Math.abs(fill - stop) * contracts * cfg.contractValue,
              contracts,
              entryFee: fill * contracts * cfg.contractValue * (maker ? cfg.feeMaker : cfg.feeTaker),
              barTime: bar.time,
              entryBar: i,
              peak: fill,
            };
          }
        }
        pending = null;
      }
    }

    // --- 2. manage the open position ---
    if (pos) {
      const dir = pos.side === 'long' ? 1 : -1;
      const targetPrice = p.exitMode === 'target' ? pos.entry + dir * p.targetR * pos.risk : null;

      if (p.exitMode === 'trail') {
        const prevClose = candles[i - 1].close;
        pos.peak = dir === 1 ? Math.max(pos.peak, prevClose) : Math.min(pos.peak, prevClose);
        const advance = (pos.peak - pos.entry) * dir;
        const candidates = [pos.stop];
        if (p.beAtR > 0 && advance >= p.beAtR * pos.risk) candidates.push(pos.entry);
        if (p.trailAtrMult > 0 && atrV != null) candidates.push(pos.peak - dir * p.trailAtrMult * atrV);
        const candidate = dir === 1 ? Math.max(...candidates) : Math.min(...candidates);
        if (dir === 1 ? candidate > pos.stop : candidate < pos.stop) pos.stop = candidate;
      }

      const hitStop = dir === 1 ? bar.low <= pos.stop : bar.high >= pos.stop;
      const hitTarget =
        targetPrice != null && (dir === 1 ? bar.high >= targetPrice : bar.low <= targetPrice);

      if (hitStop) closePos(pos.stop, bar, 'stop', false);
      else if (hitTarget) closePos(targetPrice, bar, 'target', true);

      if (pos && p.holdBars > 0 && i - pos.entryBar >= p.holdBars) {
        closePos(bar.close, bar, 'time', false);
      }
    }

    // --- 3. day-wise profit lock / loss cap bookkeeping ---
    const dp = evalDay(day);
    if (p.dailyTargetPct > 0 && dp >= p.dailyTargetPct * cfg.initialEquity) lockedDays.add(day);
    if (p.dailyLossPct > 0 && dp <= -p.dailyLossPct * cfg.initialEquity) lockedDays.add(day);

    // --- 4. new signal, only when flat and not locked out for the day ---
    if (!pos && !pending && sigs[i]) {
      if (lockedDays.has(day)) {
        lockedSkips += 1;
      } else if (i + 1 < n) {
        const sameDay = p.family === 'donchian';
        const maxExp = sameDay ? i + p.retestWindow : Math.min(i + p.retestWindow, base.bounds.dayEnd[i]);
        pending = {
          side: sigs[i].side,
          level: sigs[i].level,
          useVwap: !!sigs[i].useVwap,
          market: p.entryMode === 'breakout',
          expires: p.entryMode === 'breakout' ? i + 1 : maxExp,
        };
      }
    }
  }

  return { trades, equity, lockedSkips };
}

// ---------------------------------------------------------------------------
// Scoring / search
// ---------------------------------------------------------------------------

function loadBase(tf) {
  const cached = loadCache(SYMBOL, tf);
  if (!cached) throw new Error(`No ${tf} cache. Run: node backtest/fetch.js --timeframes ${tf}`);
  const candles = cached.candles;
  return { candles, atr: atr(candles, 14), vwap: dailyVwap(candles), bounds: dayBounds(candles) };
}

function score(trades, from, to) {
  const sel = trades.filter((t) => t.exitTime >= from && t.exitTime < to);
  const n = sel.length;
  const net = sel.reduce((s, t) => s + t.net, 0);
  const wins = sel.filter((t) => t.net > 0).length;
  const gp = sel.filter((t) => t.net > 0).reduce((s, t) => s + t.net, 0);
  const gl = Math.abs(sel.filter((t) => t.net <= 0).reduce((s, t) => s + t.net, 0));
  const days = new Set(sel.map((t) => t.day)).size || 1;
  return {
    n,
    net,
    wr: n ? (wins / n) * 100 : 0,
    pf: gl > 0 ? gp / gl : gp > 0 ? Infinity : 0,
    perDay: n / days,
  };
}

function expand(grid) {
  const keys = Object.keys(grid);
  let out = [{}];
  for (const k of keys) {
    const next = [];
    for (const base of out) for (const v of grid[k]) next.push({ ...base, [k]: v });
    out = next;
  }
  return out;
}

const CFG = {
  contractValue: 0.001,
  feeMaker: 0.0002,
  feeTaker: 0.0005,
  slippageBps: 0.0002,
  initialEquity: 1200,
  riskPct: 0.005,
  maxNotionalPct: 3,
};

const GRIDS = {
  families: {
    family: ['donchian', 'openrange', 'vwap'],
    entryMode: ['retest', 'breakout'],
    stopAtrMult: [1.5, 2.5],
    exit: [
      { exitMode: 'target', targetR: 2.0 },
      { exitMode: 'target', targetR: 3.0 },
      { exitMode: 'trail', trailAtrMult: 2.0, beAtR: 0.5 },
    ],
    holdHours: [8, 24],
    lookback: [20, 55],
    orHours: [1, 2],
    retestWindow: [8],
    vwapMinDistAtr: [0],
    dailyTargetPct: [0],
    dailyLossPct: [0],
  },
  lock: {
    family: ['donchian', 'openrange', 'vwap'],
    entryMode: ['retest'],
    stopAtrMult: [1.5, 2.5],
    exit: [
      { exitMode: 'target', targetR: 2.0 },
      { exitMode: 'trail', trailAtrMult: 2.0, beAtR: 0.5 },
    ],
    holdHours: [8, 24],
    lookback: [20, 55],
    orHours: [1, 2],
    retestWindow: [8],
    vwapMinDistAtr: [0.5],
    dailyTargetPct: [0, 0.01],
    dailyLossPct: [0, 0.005],
  },
};

function parseArgs(argv) {
  const args = { stage: 'families', tf: 'both', top: 12 };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--stage') args.stage = argv[++i];
    else if (a === '--tf') args.tf = argv[++i];
    else if (a === '--top') args.top = Number(argv[++i]);
    else if (a === '--report') args.stage = 'report';
  }
  return args;
}

function buildParams(c, resSec) {
  return {
    family: c.family,
    entryMode: c.entryMode,
    stopAtrMult: c.stopAtrMult,
    exitMode: c.exitMode,
    targetR: c.targetR || 0,
    beAtR: c.beAtR || 0,
    trailAtrMult: c.trailAtrMult || 0,
    holdBars: Math.round(c.holdHours * 3600 / resSec),
    lookback: c.lookback,
    orBars: Math.max(1, Math.round(c.orHours * 3600 / resSec)),
    retestWindow: c.retestWindow,
    vwapMinDistAtr: c.vwapMinDistAtr,
    dailyTargetPct: c.dailyTargetPct || 0,
    dailyLossPct: c.dailyLossPct || 0,
  };
}

function describe(c) {
  return [
    c.family,
    c.entryMode,
    `stop${c.stopAtrMult}ATR`,
    c.exitMode === 'target' ? `TP${c.targetR}R` : `trail${c.trailAtrMult}/be${c.beAtR}`,
    `hold${c.holdHours}h`,
    c.family === 'donchian' ? `dc${c.lookback}` : '',
    c.family === 'openrange' ? `or${c.orHours}h` : '',
    c.family === 'vwap' ? `dist${c.vwapMinDistAtr}` : '',
    c.dailyTargetPct ? `goal$${(c.dailyTargetPct * CFG.initialEquity).toFixed(0)}` : 'noLock',
    c.dailyLossPct ? `cap$${(c.dailyLossPct * CFG.initialEquity).toFixed(0)}` : 'noCap',
  ]
    .filter(Boolean)
    .join(' ');
}

function main() {
  const args = parseArgs(process.argv);
  const tfs = args.tf === 'both' ? ['5m', '15m'] : [args.tf];
  if (args.stage === 'report') return report(tfs[0]);

  const combos = expand(GRIDS[args.stage]).map((c) => {
    const { exit, ...rest } = c;
    return { ...rest, ...exit };
  });
  console.log(
    `costs: maker=${(CFG.feeMaker * 1e4).toFixed(1)}bps taker=${(CFG.feeTaker * 1e4).toFixed(1)}bps slippage=${(CFG.slippageBps * 1e4).toFixed(1)}bps`
  );

  for (const tf of tfs) {
    const base = loadBase(tf);
    const candles = base.candles;
    const resSec = RES_SEC[tf];
    const start = candles[0].time;
    const end = candles[candles.length - 1].time;
    const split = start + (end - start) * 0.7;

    const results = [];
    for (const c of combos) {
      const p = buildParams(c, resSec);
      const sigs = genSignals(c.family, candles, base, p);
      const { trades } = runSim(candles, base, sigs, p, CFG);
      const is = score(trades, start, split);
      const oos = score(trades, split, end + 1);
      if (is.n < 40) continue;
      results.push({ c, is, oos });
    }

    results.sort((a, b) => b.is.net - a.is.net);

    console.log(`\n================ ${tf} — ${combos.length} combos, ${results.length} with >=40 IS trades ================`);
    console.log('rank | IS net | IS PF | IS w/r | IS t/d | OOS net | OOS PF | config');
    results.slice(0, args.top).forEach((r, idx) => {
      console.log(
        `${String(idx + 1).padStart(4)} | ${r.is.net.toFixed(2).padStart(7)} | ${r.is.pf.toFixed(2)} | ` +
          `${r.is.wr.toFixed(0).padStart(3)}% | ${r.is.perDay.toFixed(1)} | ${r.oos.net.toFixed(2).padStart(8)} | ` +
          `${r.oos.pf.toFixed(2)} | ${describe(r.c)}`
      );
    });

    const survivors = results.filter((r) => r.is.net > 0 && r.oos.net > 0);
    console.log(
      `\nProfitable in BOTH windows: ${survivors.length} of ${results.length} ` +
        `(of the top ${Math.min(args.top, results.length)} IS configs, ` +
        `${results.slice(0, args.top).filter((r) => r.oos.net > 0).length} stayed positive OOS)`
    );

    survivors
      .slice()
      .sort((a, b) => b.is.net + b.oos.net - (a.is.net + a.oos.net))
      .slice(0, 8)
      .forEach((r) => {
        console.log(
          `  SURVIVOR IS $${r.is.net.toFixed(0)} (PF ${r.is.pf.toFixed(2)}, ${r.is.perDay.toFixed(1)}/d) | ` +
            `OOS $${r.oos.net.toFixed(0)} (PF ${r.oos.pf.toFixed(2)}) | ${describe(r.c)}`
        );
      });

    // Family-level robustness: a single lucky combo is not evidence, but a whole
    // family that is positive on average in BOTH windows is. Also splits retest
    // vs chase entries, which is the cost-relevant question.
    const group = (keyFn) => {
      const g = new Map();
      for (const r of results) {
        const k = keyFn(r.c);
        const a = g.get(k) || { n: 0, s: 0, isSum: 0, oosSum: 0 };
        a.n += 1;
        if (r.is.net > 0 && r.oos.net > 0) a.s += 1;
        a.isSum += r.is.net;
        a.oosSum += r.oos.net;
        g.set(k, a);
      }
      return [...g.entries()].sort((a, b) => b[1].s / b[1].n - a[1].s / a[1].n);
    };

    console.log('\nby family (survivors / combos, mean IS net, mean OOS net):');
    for (const [k, a] of group((c) => c.family)) {
      console.log(
        `  ${k.padEnd(10)} ${String(a.s).padStart(3)}/${String(a.n).padEnd(4)}  ` +
          `IS $${(a.isSum / a.n).toFixed(0).padStart(6)}  OOS $${(a.oosSum / a.n).toFixed(0).padStart(6)}`
      );
    }
    console.log('by entry mode:');
    for (const [k, a] of group((c) => c.entryMode)) {
      console.log(
        `  ${k.padEnd(10)} ${String(a.s).padStart(3)}/${String(a.n).padEnd(4)}  ` +
          `IS $${(a.isSum / a.n).toFixed(0).padStart(6)}  OOS $${(a.oosSum / a.n).toFixed(0).padStart(6)}`
      );
    }
  }
}

function report(tf) {
  const base = loadBase(tf);
  const p = JSON.parse(process.env.BEST_PARAMS || '{}');
  if (!p.family) throw new Error('set BEST_PARAMS with a full param object');
  const sigs = genSignals(p.family, base.candles, base, p);
  const { trades } = runSim(base.candles, base, sigs, p, CFG);

  const net = trades.reduce((s, t) => s + t.net, 0);
  const wins = trades.filter((t) => t.net > 0).length;
  const byDay = new Map();
  for (const t of trades) {
    const d = byDay.get(t.day) || { n: 0, net: 0 };
    d.n += 1;
    d.net += t.net;
    byDay.set(t.day, d);
  }
  const days = [...byDay.entries()].sort();
  const green = days.filter(([, d]) => d.net > 0).length;

  console.log(`\n=== ${tf} full-year report — ${trades.length} trades ===`);
  console.log(
    `net=$${net.toFixed(2)}  finalEquity=$${(CFG.initialEquity + net).toFixed(2)}  ` +
      `winRate=${((wins / trades.length) * 100).toFixed(1)}%  tradingDays=${days.length}  ` +
      `greenDays=${green} (${((green / days.length) * 100).toFixed(0)}%)  ` +
      `avgTrades/tradingDay=${(trades.length / days.length).toFixed(2)}`
  );

  const byMonth = new Map();
  for (const t of trades) {
    const m = t.day.slice(0, 7);
    byMonth.set(m, (byMonth.get(m) || 0) + t.net);
  }
  console.log('\nmonthly net:');
  for (const [m, v] of [...byMonth.entries()].sort()) {
    console.log(`  ${m}  ${v >= 0 ? '+' : ''}${v.toFixed(2)}`);
  }

  const last = days.slice(-30);
  console.log('\nlast 30 trading days (date  trades  net  cum):');
  let cum = 0;
  for (const [d, x] of last) {
    cum += x.net;
    console.log(
      `  ${d}  ${String(x.n).padStart(3)}  ${x.net >= 0 ? '+' : ''}${x.net.toFixed(2).padStart(8)}  ${cum.toFixed(2).padStart(8)}`
    );
  }
}

main();
