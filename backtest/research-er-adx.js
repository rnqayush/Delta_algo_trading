// Research: Efficiency-Ratio / ADX regime gate + small-trend momentum, with a
// day-wise profit lock ("stop for the day once we are up, so we do not give it
// back").
//
//   node backtest/research-er-adx.js --stage gate            # regime/threshold search
//   node backtest/research-er-adx.js --stage daily           # daily-lock search on the best region
//   node backtest/research-er-adx.js --report --tf 5m        # day-wise report for the current best
//
// Reality rules (same as the rest of the project):
//   * signals only on CLOSED bars; entry fills on the NEXT bar's open
//   * if a bar contains both stop and target, the STOP is assumed first
//   * real Delta fees (2 bps maker / 5 bps taker) + 2 bps adverse slippage
//   * fixed-fractional sizing from the stop distance, capped by notional
//
// The honest question this script answers: on a LOWER timeframe, can an
// efficiency-ratio + ADX gate pick only the moments where the move is large
// enough to beat fees, and can a daily profit lock stop us giving it back?

'use strict';

const { loadCache } = require('./lib/data');

const SYMBOL = 'BTCUSD';

// ---------------------------------------------------------------------------
// Indicators
// ---------------------------------------------------------------------------

function ema(values, period) {
  const n = values.length;
  const out = new Array(n).fill(null);
  const k = 2 / (period + 1);
  let prev = null;
  for (let i = 0; i < n; i += 1) {
    if (i === period - 1) {
      let sum = 0;
      for (let j = 0; j < period; j += 1) sum += values[j];
      prev = sum / period;
      out[i] = prev;
    } else if (i >= period) {
      prev = values[i] * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

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

// Wilder ADX.
function adx(candles, period) {
  const n = candles.length;
  const out = new Array(n).fill(null);
  if (n <= period * 2) return out;

  const tr = new Array(n).fill(0);
  const pdm = new Array(n).fill(0);
  const mdm = new Array(n).fill(0);
  for (let i = 1; i < n; i += 1) {
    const h = candles[i].high;
    const l = candles[i].low;
    const pc = candles[i - 1].close;
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    const up = h - candles[i - 1].high;
    const dn = candles[i - 1].low - l;
    pdm[i] = up > dn && up > 0 ? up : 0;
    mdm[i] = dn > up && dn > 0 ? dn : 0;
  }

  let trS = 0;
  let pS = 0;
  let mS = 0;
  for (let i = 1; i <= period; i += 1) {
    trS += tr[i];
    pS += pdm[i];
    mS += mdm[i];
  }

  const dx = new Array(n).fill(null);
  for (let i = period; i < n; i += 1) {
    if (i > period) {
      trS = trS - trS / period + tr[i];
      pS = pS - pS / period + pdm[i];
      mS = mS - mS / period + mdm[i];
    }
    const pdi = trS > 0 ? (100 * pS) / trS : 0;
    const mdi = trS > 0 ? (100 * mS) / trS : 0;
    const sum = pdi + mdi;
    dx[i] = sum > 0 ? (100 * Math.abs(pdi - mdi)) / sum : 0;
  }

  let acc = 0;
  let cnt = 0;
  for (let i = period; i < period * 2; i += 1) {
    acc += dx[i];
    cnt += 1;
  }
  if (!cnt) return out;
  out[period * 2 - 1] = acc / cnt;
  for (let i = period * 2; i < n; i += 1) out[i] = (out[i - 1] * (period - 1) + dx[i]) / period;
  return out;
}

// Kaufman Efficiency Ratio: net move / total path over `period` bars.
function efficiencyRatio(closes, period) {
  const n = closes.length;
  const out = new Array(n).fill(null);
  let sumAbs = 0;
  for (let i = 1; i < n; i += 1) {
    sumAbs += Math.abs(closes[i] - closes[i - 1]);
    if (i - period >= 1) sumAbs -= Math.abs(closes[i - period] - closes[i - period - 1]);
    if (i >= period) {
      const net = Math.abs(closes[i] - closes[i - period]);
      out[i] = sumAbs > 0 ? net / sumAbs : 0;
    }
  }
  return out;
}

function dayKey(sec) {
  return new Date(sec * 1000).toISOString().slice(0, 10);
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

function runSim(candles, ind, p, cfg) {
  const n = candles.length;
  const start = Math.max(p.warmup, 60);
  let equity = cfg.initialEquity;
  const trades = [];

  let pending = null; // { side, stop, createdBar }
  let pos = null; // { side, entry, stop, risk, contracts, entryFee, bar, peak }

  const dayPnl = new Map();
  const lockedDays = new Set();
  let lockedOpens = 0;

  const evalDay = (day) => dayPnl.get(day) || 0;

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
    const atrV = ind.atr[i];
    const day = dayKey(bar.time);

    // --- 1. fill a pending entry on this bar's open (no look-ahead) ---
    if (!pos && pending && i === pending.createdBar + 1) {
      const dir = pending.side === 'long' ? 1 : -1;
      const price = bar.open * (1 + cfg.slippageBps * dir);
      const contracts = sizeContracts(price, pending.stop, cfg);
      if (contracts > 0) {
        pos = {
          side: pending.side,
          entry: price,
          stop: pending.stop,
          risk: Math.abs(price - pending.stop),
          riskAmount: Math.abs(price - pending.stop) * contracts * cfg.contractValue,
          contracts,
          entryFee: price * contracts * cfg.contractValue * cfg.feeTaker,
          barTime: bar.time,
          entryBar: i,
          peak: price,
        };
      }
      pending = null;
    }

    // --- 2. manage the open position ---
    if (pos) {
      const dir = pos.side === 'long' ? 1 : -1;
      const targetPrice =
        p.exitMode === 'target' ? pos.entry + dir * p.targetR * pos.risk : null;

      if (p.exitMode === 'trail') {
        // peaking/trailing may only use CLOSED bars (i.e. the previous bar's close)
        const prevClose = candles[i - 1].close;
        pos.peak = dir === 1 ? Math.max(pos.peak, prevClose) : Math.min(pos.peak, prevClose);

        // How far price has actually gone our way, in risk units. The breakeven
        // move is GATED on this: it must not fire before the trade is in profit.
        const advance = (pos.peak - pos.entry) * dir;
        const candidates = [pos.stop];
        if (p.beAtR > 0 && advance >= p.beAtR * pos.risk) candidates.push(pos.entry);
        if (p.trailAtrMult > 0) candidates.push(pos.peak - dir * p.trailAtrMult * atrV);

        const candidate = dir === 1 ? Math.max(...candidates) : Math.min(...candidates);
        if (dir === 1 ? candidate > pos.stop : candidate < pos.stop) pos.stop = candidate;
      }

      const hitStop = dir === 1 ? bar.low <= pos.stop : bar.high >= pos.stop;
      const hitTarget = targetPrice != null && (dir === 1 ? bar.high >= targetPrice : bar.low <= targetPrice);

      if (hitStop) {
        closePos(pos.stop, bar, 'stop', false);
      } else if (hitTarget) {
        closePos(targetPrice, bar, 'target', true);
      }

      if (pos && p.timeExitBars > 0) {
        const barsHeld = i - pos.entryBar;
        if (barsHeld >= p.timeExitBars) closePos(bar.close, bar, 'time', false);
      }
    }

    // --- 3. daily lock bookkeeping ---
    const dp = evalDay(day);
    if (p.dailyTargetPct > 0 && dp >= p.dailyTargetPct * cfg.initialEquity) lockedDays.add(day);
    if (p.dailyLossPct > 0 && dp <= -p.dailyLossPct * cfg.initialEquity) lockedDays.add(day);

    // --- 4. new signal (only when flat and not locked out) ---
    if (!pos && !pending) {
      if (lockedDays.has(day)) {
        lockedOpens += 1;
      } else {
        const f = ind.fast[i];
        const s = ind.slow[i];
        const a = ind.adx[i];
        const er = ind.er[i];
        const prevF = ind.fast[i - 1];
        const prevS = ind.slow[i - 1];
        const prevClose = candles[i - 1].close;

        if (f != null && s != null && a != null && er != null && atrV != null) {
          const regime = a >= p.adxMin && er >= p.erMin;
          const upNow = f > s && bar.close > f;
          const upPrev = prevF > prevS && prevClose > prevF;
          const dnNow = f < s && bar.close < f;
          const dnPrev = prevF < prevS && prevClose < prevF;

          if (regime && upNow && !upPrev) {
            pending = { side: 'long', stop: bar.close - p.stopAtrMult * atrV, createdBar: i };
          } else if (regime && dnNow && !dnPrev) {
            pending = { side: 'short', stop: bar.close + p.stopAtrMult * atrV, createdBar: i };
          }
        }
      }
    }
  }

  return { trades, equity, lockedOpens };
}

// ---------------------------------------------------------------------------
// Scoring / search
// ---------------------------------------------------------------------------

function loadIndicators(tf) {
  const cached = loadCache(SYMBOL, tf);
  if (!cached) throw new Error(`No ${tf} cache. Run: node backtest/fetch.js --timeframes ${tf}`);
  const candles = cached.candles;
  const closes = candles.map((c) => c.close);
  return {
    candles,
    base: {
      atr: atr(candles, 14),
      adx: adx(candles, 14),
      er: efficiencyRatio(closes, 10),
      emaCache: {},
    },
    emaFor(period) {
      if (!this.base.emaCache[period]) this.base.emaCache[period] = ema(closes, period);
      return this.base.emaCache[period];
    },
  };
}

function withEma(loaded, fastP, slowP) {
  return {
    atr: loaded.base.atr,
    adx: loaded.base.adx,
    er: loaded.base.er,
    fast: loaded.emaFor(fastP),
    slow: loaded.emaFor(slowP),
  };
}

function score(trades, from, to) {
  const sel = trades.filter((t) => t.exitTime >= from && t.exitTime < to);
  const n = sel.length;
  const net = sel.reduce((s, t) => s + t.net, 0);
  const wins = sel.filter((t) => t.net > 0).length;
  const gp = sel.filter((t) => t.net > 0).reduce((s, t) => s + t.net, 0);
  const gl = Math.abs(sel.filter((t) => t.net <= 0).reduce((s, t) => s + t.net, 0));
  const days = new Set(sel.map((t) => t.day)).size || 1;
  const grossWin = sel.filter((t) => t.net > 0).length;
  return {
    n,
    net,
    wr: n ? (wins / n) * 100 : 0,
    pf: gl > 0 ? gp / gl : gp > 0 ? Infinity : 0,
    perDay: n / days,
    grossWin,
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

const WARMUP = 60;

function parseArgs(argv) {
  const args = { stage: 'gate', tf: '5m', top: 12, phase: 'all', fees: 'real' };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--stage') args.stage = argv[++i];
    else if (a === '--tf') args.tf = argv[++i];
    else if (a === '--top') args.top = Number(argv[++i]);
    else if (a === '--report') args.stage = 'report';
    else if (a === '--phase') args.phase = argv[++i];
    else if (a === '--fees') args.fees = argv[++i];
  }
  return args;
}

const GRIDS = {
  // Stage 1: does the regime gate itself create an edge, independent of the lock?
  gate: {
    erMin: [0, 0.3, 0.45],
    adxMin: [0, 15, 20, 25, 30],
    emaPair: [
      [9, 21],
      [5, 13],
    ],
    stopAtrMult: [1.0, 1.5],
    exit: [
      { exitMode: 'target', targetR: 1.0 },
      { exitMode: 'target', targetR: 1.5 },
      { exitMode: 'target', targetR: 2.0 },
      { exitMode: 'trail', trailAtrMult: 1.5, beAtR: 0.5 },
      { exitMode: 'trail', trailAtrMult: 2.5, beAtR: 1.0 },
    ],
    timeExitBars: [12, 36],
  },
  // Stage 1b: WIDE stops / big targets. Cost in R units is feeRate/stopPct, so
  // the only way a lower timeframe can pay fees is a stop wide enough that the
  // round-trip cost is a small fraction of R. This tests whether that rescues it.
  wide: {
    erMin: [0, 0.3],
    adxMin: [15, 20, 25],
    emaPair: [[9, 21]],
    stopAtrMult: [3.0, 4.5, 6.0],
    exit: [
      { exitMode: 'target', targetR: 2.0 },
      { exitMode: 'target', targetR: 3.0 },
      { exitMode: 'trail', trailAtrMult: 3.0, beAtR: 1.0 },
    ],
    timeExitBars: [96, 288],
  },
  // Stage 2: does the day-wise profit lock / loss cap change anything? Tested
  // over BOTH the tight-stop family and the wide-stop (fee-efficient) family.
  daily: {
    erMin: [0.3, 0.45],
    adxMin: [20, 25, 30],
    emaPair: [[9, 21]],
    stopAtrMult: [1.0, 1.5, 3.0],
    exit: [
      { exitMode: 'target', targetR: 1.5 },
      { exitMode: 'target', targetR: 3.0 },
      { exitMode: 'trail', trailAtrMult: 1.5, beAtR: 0.5 },
    ],
    timeExitBars: [36, 288],
    dailyTargetPct: [0, 0.01, 0.02],
    dailyLossPct: [0, 0.005, 0.01],
  },
};

function main() {
  const args = parseArgs(process.argv);
  const tf = args.tf === 'both' ? ['5m', '15m'] : [args.tf];

  if (args.fees === 'zero') {
    CFG.feeMaker = 0;
    CFG.feeTaker = 0;
    CFG.slippageBps = 0;
    console.log('*** ZERO-FEE DIAGNOSTIC (costs removed) ***');
  } else {
    console.log(
      `costs: maker=${(CFG.feeMaker * 1e4).toFixed(1)}bps taker=${(CFG.feeTaker * 1e4).toFixed(1)}bps ` +
        `slippage=${(CFG.slippageBps * 1e4).toFixed(1)}bps`
    );
  }

  if (args.stage === 'report') return report(tf[0]);

  const grid = GRIDS[args.stage];
  const combos = expand(grid).map((c) => {
    const { emaPair, exit, ...rest } = c;
    return { ...rest, emaFast: emaPair[0], emaSlow: emaPair[1], ...exit };
  });

  for (const t of tf) {
    const loaded = loadIndicators(t);
    const candles = loaded.candles;
    const start = candles[0].time;
    const end = candles[candles.length - 1].time;
    const split = start + (end - start) * 0.7;

    const results = [];
    for (const c of combos) {
      const p = {
        warmup: WARMUP,
        erMin: c.erMin,
        adxMin: c.adxMin,
        stopAtrMult: c.stopAtrMult,
        exitMode: c.exitMode,
        targetR: c.targetR || 0,
        beAtR: c.beAtR || 0,
        trailAtrMult: c.trailAtrMult || 0,
        timeExitBars: c.timeExitBars,
        dailyTargetPct: c.dailyTargetPct || 0,
        dailyLossPct: c.dailyLossPct || 0,
      };
      const ind = withEma(loaded, c.emaFast, c.emaSlow);
      const { trades } = runSim(candles, ind, p, CFG);
      const is = score(trades, start, split);
      const oos = score(trades, split, end + 1);
      if (is.n < 60) continue;
      results.push({ c, is, oos });
    }

    results.sort((a, b) => b.is.net - a.is.net);

    console.log(`\n================ ${t} — ${combos.length} combos, ${results.length} with >=60 IS trades ================`);
    console.log('rank | IS net | IS PF | IS w/r | IS t/d | OOS net | OOS PF | config');
    results.slice(0, args.top).forEach((r, idx) => {
      const cfgStr = [
        `er>=${r.c.erMin}`,
        `adx>=${r.c.adxMin}`,
        `ema${r.c.emaFast}/${r.c.emaSlow}`,
        `stop${r.c.stopAtrMult}ATR`,
        r.c.exitMode === 'target' ? `TP${r.c.targetR}R` : `trail${r.c.trailAtrMult}`,
        `t=${r.c.timeExitBars}`,
        r.c.dailyTargetPct ? `goal$${(r.c.dailyTargetPct * 1200).toFixed(0)}` : 'noLock',
        r.c.dailyLossPct ? `stop$${(r.c.dailyLossPct * 1200).toFixed(0)}` : 'noCap',
      ].join(' ');
      console.log(
        `${String(idx + 1).padStart(4)} | ${r.is.net.toFixed(2).padStart(7)} | ${r.is.pf.toFixed(2)} | ` +
          `${r.is.wr.toFixed(0).padStart(3)}% | ${r.is.perDay.toFixed(1)} | ${r.oos.net.toFixed(2).padStart(8)} | ` +
          `${r.oos.pf.toFixed(2)} | ${cfgStr}`
      );
    });

    const survivors = results.filter((r) => r.is.net > 0 && r.oos.net > 0).length;
    console.log(
      `\nProfitable in BOTH windows: ${survivors} of ${results.length} ` +
        `(of the top ${Math.min(args.top, results.length)} IS configs, ` +
        `${results.slice(0, args.top).filter((r) => r.oos.net > 0).length} stayed positive OOS)`
    );
  }
}

function report(tf) {
  const loaded = loadIndicators(tf);
  const candles = loaded.candles;
  const p = BEST.reportParams;
  const ind = withEma(loaded, p.emaFast, p.emaSlow);
  const { trades, equity } = runSim(candles, ind, p, CFG);

  const net = trades.reduce((s, t) => s + t.net, 0);
  const wins = trades.filter((t) => t.net > 0).length;
  const byDay = new Map();
  for (const t of trades) {
    const d = byDay.get(t.day) || { n: 0, net: 0, start: 0 };
    d.n += 1;
    d.net += t.net;
    byDay.set(t.day, d);
  }
  const days = [...byDay.entries()].sort();
  const green = days.filter(([, d]) => d.net > 0).length;

  console.log(`\n=== ${tf} full-year report — ${trades.length} trades ===`);
  console.log(
    `net=$${net.toFixed(2)}  finalEquity=$${(CFG.initialEquity + net).toFixed(2)}  ` +
      `winRate=${((wins / trades.length) * 100).toFixed(1)}%  ` +
      `tradingDays=${days.length}  greenDays=${green} (${((green / days.length) * 100).toFixed(0)}%)  ` +
      `avgTrades/tradingDay=${(trades.length / days.length).toFixed(2)}`
  );

  // monthly
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
    console.log(`  ${d}  ${String(x.n).padStart(3)}  ${x.net >= 0 ? '+' : ''}${x.net.toFixed(2).padStart(8)}  ${cum.toFixed(2).padStart(8)}`);
  }
}

// Best config found so far (updated as the search converges).
const BEST = {
  reportParams: JSON.parse(process.env.BEST_PARAMS || '{}'),
};

main();
