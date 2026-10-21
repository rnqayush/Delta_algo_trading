// Intraday scalping research — can a frequent trend-scalper clear Delta's fees?
//
// The user's hypothesis: on a small timeframe the trends are small BUT so are
// the consolidation ranges, so if we (a) only trade when the tape is TRENDING
// and (b) flatten/stop for the day once a good profit is banked, we can scalp
// many small trends per day.
//
// Two maker-entry momentum families are tested (never "chase" — a chase pays
// taker + slippage and every chase family in this project has lost):
//
//   vwap   : close crosses the session VWAP, then a LIMIT rests at the VWAP
//   emapull: trend = EMAfast vs EMAslow, a pullback touches EMAfast and a LIMIT
//            rests at EMAfast
//
// Regime filter (the "don't trade ranges" rule):
//   * adxMin — ADX(14) must be >= adxMin   (trend strength)
//   * erMin  — Kaufman ER must be >= erMin (directional efficiency)
//   Both must pass; these are exactly the two filters named in the project brief.
//
// Cost model (this is the whole game at 1m/5m):
//   entry   LIMIT  -> maker 2 bps
//   TP      LIMIT  -> maker 2 bps        (reduce-only take-profit)
//   stop    MARKET -> taker 5 bps + 2 bps slippage
//   time    MARKET -> taker 5 bps + 2 bps slippage
//
// Daily profit stop: once the day's realised PnL >= dailyTargetPct * equity, no
// new trades are armed for the rest of that UTC day.
//
//   node backtest/research-intraday.js --tf 5m
//   node backtest/research-intraday.js --tf 1m
//   node backtest/research-intraday.js --tf 5m --best   # 7-day report for best

'use strict';

const { loadCache } = require('./lib/data');

const SYMBOL = 'BTCUSD';
const RES_SEC = { '1m': 60, '3m': 180, '5m': 300, '15m': 900 };

const CFG = {
  contractValue: 0.001,
  feeMaker: 0.0002,
  feeTaker: 0.0005,
  slippage: 0.0002,
  initialEquity: 1200,
  riskPct: 0.005,
  maxNotionalPct: 3,
};

// Real Delta fee schedule, kept separate from CFG so --nofee can report the
// raw alpha and the fee drag at the same time.
const REAL = { maker: 0.0002, taker: 0.0005, slip: 0.0002 };

// ---------------------------------------------------------------------------
// indicators
// ---------------------------------------------------------------------------

const dayKey = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);

function atr(candles, period) {
  const n = candles.length;
  const out = new Array(n).fill(null);
  const tr = new Array(n).fill(0);
  for (let i = 1; i < n; i += 1) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  if (n <= period) return out;
  let sum = 0;
  for (let i = 1; i <= period; i += 1) sum += tr[i];
  out[period] = sum / period;
  for (let i = period + 1; i < n; i += 1) out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
  return out;
}

function ema(values, period) {
  const n = values.length;
  const out = new Array(n).fill(null);
  const k = 2 / (period + 1);
  let prev = null;
  for (let i = 0; i < n; i += 1) {
    const v = values[i];
    prev = prev == null ? v : v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function dailyVwap(candles) {
  const n = candles.length;
  const out = new Array(n).fill(null);
  let pv = 0, vv = 0, cur = null;
  for (let i = 0; i < n; i += 1) {
    const d = dayKey(candles[i].time);
    if (d !== cur) { cur = d; pv = 0; vv = 0; }
    const c = candles[i];
    pv += ((c.high + c.low + c.close) / 3) * c.volume;
    vv += c.volume;
    out[i] = vv > 0 ? pv / vv : c.close;
  }
  return out;
}

function adxSeries(candles, period) {
  const n = candles.length;
  const out = new Array(n).fill(null);
  let trS = 0, pdmS = 0, ndmS = 0, adx = null;
  const dx = [];
  for (let i = 0; i < n; i += 1) {
    const c = candles[i];
    let tr, pdm = 0, ndm = 0;
    if (i === 0) tr = c.high - c.low;
    else {
      const p = candles[i - 1];
      const up = c.high - p.high, dn = p.low - c.low;
      pdm = up > dn && up > 0 ? up : 0;
      ndm = dn > up && dn > 0 ? dn : 0;
      tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    }
    if (i < period) { trS += tr; pdmS += pdm; ndmS += ndm; }
    else { trS = trS - trS / period + tr; pdmS = pdmS - pdmS / period + pdm; ndmS = ndmS - ndmS / period + ndm; }
    if (i >= period && trS > 0) {
      const pdi = (100 * pdmS) / trS, ndi = (100 * ndmS) / trS, s = pdi + ndi;
      const v = s ? (100 * Math.abs(pdi - ndi)) / s : 0;
      if (adx == null) { dx.push(v); if (dx.length === period) { adx = dx.reduce((a, b) => a + b, 0) / period; out[i] = adx; } }
      else { adx = (adx * (period - 1) + v) / period; out[i] = adx; }
    }
  }
  return out;
}

function erSeries(candles, period) {
  const n = candles.length;
  const out = new Array(n).fill(null);
  for (let i = period; i < n; i += 1) {
    const change = Math.abs(candles[i].close - candles[i - period].close);
    let vol = 0;
    for (let j = i - period + 1; j <= i; j += 1) vol += Math.abs(candles[j].close - candles[j - 1].close);
    out[i] = vol ? change / vol : 0;
  }
  return out;
}

function prepare(candles) {
  const closes = candles.map((c) => c.close);
  return {
    candles,
    atr: atr(candles, 14),
    vwap: dailyVwap(candles),
    adx: adxSeries(candles, 14),
    er: erSeries(candles, 10),
    emaF: ema(closes, 21),
    emaS: ema(closes, 55),
  };
}

// ---------------------------------------------------------------------------
// signals
// ---------------------------------------------------------------------------

const HOURS = (sec) => new Date(sec * 1000).getUTCHours();

function genSignals(p, base) {
  base._sigs = base._sigs || {};
  if (base._sigs[p.family]) return base._sigs[p.family];
  const { candles } = base;
  const n = candles.length;
  const sigs = new Array(n).fill(null);

  if (p.family === 'vwap') {
    let above = false;
    for (let i = 1; i < n; i += 1) {
      const v = base.vwap[i];
      if (v == null || base.atr[i] == null) continue;
      const c = candles[i].close;
      const isAbove = c > v;
      if (isAbove && !above) sigs[i] = { side: 'long', level: v };
      else if (!isAbove && above) sigs[i] = { side: 'short', level: v };
      above = isAbove;
    }
  } else if (p.family === 'emapull') {
    for (let i = 2; i < n; i += 1) {
      const f = base.emaF[i], s = base.emaS[i];
      if (f == null || s == null) continue;
      const bar = candles[i];
      if (f > s && bar.low <= f && bar.close > f) sigs[i] = { side: 'long', level: f };
      else if (f < s && bar.high >= f && bar.close < f) sigs[i] = { side: 'short', level: f };
    }
  }

  base._sigs[p.family] = sigs;
  return sigs;
}

// ---------------------------------------------------------------------------
// simulator
// ---------------------------------------------------------------------------

function sizeContracts(entry, stop) {
  const d = Math.abs(entry - stop);
  if (!(d > 0)) return 0;
  const byRisk = Math.floor((CFG.initialEquity * CFG.riskPct) / (d * CFG.contractValue));
  const byNotional = Math.floor((CFG.initialEquity * CFG.maxNotionalPct) / (entry * CFG.contractValue));
  return Math.max(0, Math.min(byRisk, byNotional));
}

function run(p, base) {
  const { candles } = base;
  const n = candles.length;
  const sigs = genSignals(p, base);
  const trades = [];
  const dayPnl = new Map();
  const lockedDays = new Set();
  let pos = null;
  let pending = null;
  let lockedSkips = 0;
  let lastExitBar = -1e9;
  const startBar = 260;

  const closePos = (price, bar, barIdx, reason, isMaker) => {
    const dir = pos.side === 'long' ? 1 : -1;
    const exitFee = price * pos.contracts * CFG.contractValue * (isMaker ? CFG.feeMaker : CFG.feeTaker);
    const fees = pos.entryFee + exitFee;
    const gross = (price - pos.entry) * dir * pos.contracts * CFG.contractValue;
    const net = gross - fees;
    const d = dayKey(bar.time);
    dayPnl.set(d, (dayPnl.get(d) || 0) + net);
    const exitNotional = price * pos.contracts * CFG.contractValue;
    const feeReal = pos.entryNotional * REAL.maker +
      exitNotional * (isMaker ? REAL.maker : REAL.taker + REAL.slip);
    trades.push({ day: d, side: pos.side, net, fees, feeReal, reason, entryTime: pos.barTime, exitTime: bar.time,
      rMultiple: net / Math.max(1e-9, pos.riskAmount) });
    pos = null;
    lastExitBar = barIdx;
  };

  for (let i = startBar; i < n; i += 1) {
    const bar = candles[i];
    const atrV = base.atr[i];
    const day = dayKey(bar.time);

    // 1. work the resting entry limit
    if (!pos && pending) {
      if (i > pending.expires) pending = null;
      else {
        const dir = pending.side === 'long' ? 1 : -1;
        const level = pending.level(base, i);
        let fill = null;
        if (level != null) {
          if (pending.side === 'long' && bar.low <= level) fill = Math.min(bar.open, level);
          else if (pending.side === 'short' && bar.high >= level) fill = Math.max(bar.open, level);
        }
        if (fill != null && atrV != null) {
          const stop = fill - dir * p.stopAtrMult * atrV;
          const contracts = sizeContracts(fill, stop);
          if (contracts > 0) {
            pos = { side: pending.side, entry: fill, stop, risk: Math.abs(fill - stop),
              riskAmount: Math.abs(fill - stop) * contracts * CFG.contractValue, contracts,
              entryNotional: fill * contracts * CFG.contractValue,
              entryFee: fill * contracts * CFG.contractValue * CFG.feeMaker,
              barTime: bar.time, entryBar: i, peak: fill };
          }
        }
        pending = null;
      }
    }

    // 2. manage the open position
    if (pos) {
      const dir = pos.side === 'long' ? 1 : -1;
      const target = p.exitMode === 'target' ? pos.entry + dir * p.targetR * pos.risk : null;

      if (p.exitMode === 'trail') {
        const prevClose = candles[i - 1].close;
        pos.peak = dir === 1 ? Math.max(pos.peak, prevClose) : Math.min(pos.peak, prevClose);
        const adv = (pos.peak - pos.entry) * dir;
        const cand = [pos.stop];
        if (p.beAtR > 0 && adv >= p.beAtR * pos.risk) cand.push(pos.entry);
        if (p.trailAtrMult > 0 && atrV != null) cand.push(pos.peak - dir * p.trailAtrMult * atrV);
        const best = dir === 1 ? Math.max(...cand) : Math.min(...cand);
        if (dir === 1 ? best > pos.stop : best < pos.stop) pos.stop = best;
      }

      const hitStop = dir === 1 ? bar.low <= pos.stop : bar.high >= pos.stop;
      const hitTp = target != null && (dir === 1 ? bar.high >= target : bar.low <= target);
      if (hitStop) closePos(pos.stop, bar, i, 'stop', false);
      else if (hitTp) closePos(target, bar, i, 'target', true);   // reduce-only LIMIT => maker
      else if (p.holdBars > 0 && i - pos.entryBar >= p.holdBars) closePos(bar.close, bar, i, 'time', false);
    }

    // 3. daily profit stop bookkeeping
    const dp = dayPnl.get(day) || 0;
    if (p.dailyTargetPct > 0 && dp >= p.dailyTargetPct * CFG.initialEquity) lockedDays.add(day);

    // 4. arm a new entry on a fresh signal (regime filter + daily stop gate)
    if (!pos && !pending && sigs[i] && i + 1 < n) {
      if (lockedDays.has(day)) { lockedSkips += 1; continue; }
      if (i - lastExitBar < p.cooldown) continue;
      if (p.session && p.session[1] < 24) {
        const h = HOURS(bar.time);
        if (h < p.session[0] || h >= p.session[1]) continue;
      }
      const a = base.adx[i], e = base.er[i];
      if (p.adxMin > 0 && (a == null || a < p.adxMin)) continue;
      if (p.erMin > 0 && (e == null || e < p.erMin)) continue;
      const sig = sigs[i];
      pending = {
        side: sig.side,
        expires: i + p.retestWindow,
        level: sig.level == null ? (b, j) => b.vwap[j] : () => sig.level,
      };
    }
  }

  if (pos) closePos(candles[n - 1].close, candles[n - 1], n - 1, 'time', false);
  return { trades, lockedSkips, lockedDays };
}

// ---------------------------------------------------------------------------
// scoring
// ---------------------------------------------------------------------------

function summarise(trades) {
  const n = trades.length;
  const net = trades.reduce((s, t) => s + t.net, 0);
  const cost = trades.reduce((s, t) => s + t.fees, 0);
  const gross = net + cost;
  const feeReal = trades.reduce((s, t) => s + (t.feeReal || 0), 0);
  const netReal = net - feeReal;
  const gp = trades.filter((t) => t.net > 0).reduce((s, t) => s + t.net, 0);
  const gl = Math.abs(trades.filter((t) => t.net <= 0).reduce((s, t) => s + t.net, 0));
  const byDay = new Map();
  for (const t of trades) byDay.set(t.day, (byDay.get(t.day) || 0) + t.net);
  const days = byDay.size || 1;
  return {
    n, net, cost, gross, feeReal, netReal, wr: n ? (trades.filter((t) => t.net > 0).length / n) * 100 : 0,
    pf: gl > 0 ? gp / gl : gp > 0 ? Infinity : 0,
    avgR: n ? trades.reduce((s, t) => s + t.rMultiple, 0) / n : 0,
    perDay: n / days, green: [...byDay.values()].filter((v) => v > 0).length, days,
  };
}

function windowKeys(candles, days) {
  const keys = [...new Set(candles.map((c) => dayKey(c.time)))].sort();
  return new Set(keys.slice(-(days + 1), -1));
}

// ---------------------------------------------------------------------------
// grid
// ---------------------------------------------------------------------------

const GRID = {
  family: ['vwap', 'emapull'],
  stopAtrMult: [0.5, 0.75, 1.0, 1.5, 2.0, 3.0],
  exits: [
    { exitMode: 'target', targetR: 0.5, beAtR: 0, trailAtrMult: 0 },
    { exitMode: 'target', targetR: 0.75, beAtR: 0, trailAtrMult: 0 },
    { exitMode: 'target', targetR: 1.0, beAtR: 0, trailAtrMult: 0 },
    { exitMode: 'target', targetR: 1.5, beAtR: 0, trailAtrMult: 0 },
    { exitMode: 'target', targetR: 2.0, beAtR: 0, trailAtrMult: 0 },
    { exitMode: 'trail', targetR: 0, beAtR: 0.5, trailAtrMult: 2.0 },
  ],
  erMin: [0, 0.25, 0.45],
  adxMin: [0, 18, 25],
  dailyTargetPct: [0],
  session: [[0, 24], [7, 21]],
  cooldown: [0, 10],
};

function expand() {
  const out = [];
  for (const family of GRID.family)
    for (const stopAtrMult of GRID.stopAtrMult)
      for (const ex of GRID.exits)
        for (const erMin of GRID.erMin)
          for (const adxMin of GRID.adxMin)
            for (const dailyTargetPct of GRID.dailyTargetPct)
              for (const session of GRID.session)
                for (const cooldown of GRID.cooldown)
                  out.push({ family, stopAtrMult, ...ex, erMin, adxMin, dailyTargetPct, session, cooldown });
  return out;
}

function label(p) {
  return [
    p.family, `stop${p.stopAtrMult}ATR`,
    p.exitMode === 'target' ? `TP${p.targetR}R` : `trail${p.trailAtrMult}/be${p.beAtR}`,
    `er>=${p.erMin}`, `adx>=${p.adxMin}`,
    `sess${p.session[0]}-${p.session[1]}`, `cd${p.cooldown}`,
    p.dailyTargetPct ? `goal$${(p.dailyTargetPct * CFG.initialEquity).toFixed(0)}` : 'noGoal',
  ].join(' ');
}

function parseArgs(argv) {
  const a = { tf: '5m', best: false, nofee: false };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--tf') a.tf = argv[++i];
    else if (argv[i] === '--best') a.best = true;
    else if (argv[i] === '--nofee') a.nofee = true;
  }
  return a;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.nofee) {
    CFG.feeMaker = 0;
    CFG.feeTaker = 0;
    CFG.slippage = 0;
  }
  const resSec = RES_SEC[args.tf];
  if (!resSec) throw new Error(`bad tf ${args.tf}`);
  const cached = loadCache(SYMBOL, args.tf);
  if (!cached) throw new Error(`no ${args.tf} cache`);
  const candles = cached.candles;
  const base = prepare(candles);
  const win = windowKeys(candles, 7);
  const first = dayKey(candles[0].time), last = dayKey(candles[candles.length - 1].time);

  console.log(`costs: maker ${CFG.feeMaker * 1e4}bps / taker ${CFG.feeTaker * 1e4}bps + slip ${CFG.slippage * 1e4}bps${args.nofee ? '   [ZERO-COST MODE — raw signal only]' : ''}`);
  console.log(`=== intraday scalp scan — ${SYMBOL} ${args.tf}   data ${first} -> ${last} ===`);

  const baseP = { retestWindow: 12, holdBars: Math.round(3600 / resSec) * 4 }; // 4h max hold
  const combos = expand();
  const rows = combos.map((c) => {
    const p = { ...baseP, ...c };
    const res = run(p, base);
    const recent = res.trades.filter((t) => win.has(t.day));
    return { p, all: summarise(res.trades), s7: summarise(recent), locked: res.lockedDays.size };
  });

  const profitable = rows.filter((r) => r.all.net > 0);
  rows.sort((a, b) => b.all.net - a.all.net);

  console.log(`\n${combos.length} combos — ${profitable.length} net-positive over full history`);
  console.log('\n rank | trades tr/day  win%    PF   avgR      alpha$    fees$   atReal$     7d$ | config');
  const f = (x) => ((x >= 0 ? '+' : '') + x.toFixed(0)).padStart(8);
  rows.slice(0, 18).forEach((r, i) => {
    console.log(
      `${String(i + 1).padStart(5)} | ${String(r.all.n).padStart(6)} ${r.all.perDay.toFixed(2).padStart(6)}  ` +
        `${r.all.wr.toFixed(0).padStart(4)}%  ${(r.all.pf === Infinity ? 'inf' : r.all.pf.toFixed(2)).padStart(5)}  ` +
        `${r.all.avgR.toFixed(2).padStart(5)}  ${f(r.all.gross)}  ${f(-r.all.feeReal)}  ${f(r.all.netReal)}  ${f(r.s7.net)} | ${label(r.p)}`
    );
  });

  const best = rows[0];
  if (!best) return;

  console.log(`\n--- best config 7-day detail ---`);
  console.log(`${label(best.p)}`);
  console.log(` full-history: trades=${best.all.n} (${best.all.perDay.toFixed(2)}/day)  win=${best.all.wr.toFixed(1)}%  PF=${best.all.pf === Infinity ? 'inf' : best.all.pf.toFixed(2)}  net=$${best.all.net.toFixed(2)}`);
  console.log(`   alpha(gross)=$${best.all.gross.toFixed(2)}   realFees=-$${best.all.feeReal.toFixed(2)}   atRealFees=$${best.all.netReal.toFixed(2)}   (fees = ${best.all.gross !== 0 ? ((best.all.feeReal / Math.abs(best.all.gross)) * 100).toFixed(0) : 'n/a'}% of alpha)`);
  console.log(` 7-day: trades=${best.s7.n}  win=${best.s7.wr.toFixed(1)}%  PF=${best.s7.pf === Infinity ? 'inf' : best.s7.pf.toFixed(2)}  net=$${best.s7.net.toFixed(2)}  days stopped by goal=${best.locked}`);

  const res = run({ ...baseP, ...best.p }, base);
  const rows7 = [...win].map((d) => {
    const day = res.trades.filter((t) => t.day === d);
    return { d, n: day.length, w: day.filter((t) => t.net > 0).length, net: day.reduce((s, t) => s + t.net, 0) };
  });
  console.log('\n  date         trades  wins      net($)     cum($)   stopped');
  let cum = 0;
  for (const r of rows7) {
    cum += r.net;
    console.log(
      `  ${r.d}  ${String(r.n).padStart(5)}  ${String(r.w).padStart(4)}  ` +
        `${((r.net >= 0 ? '+' : '') + r.net.toFixed(2)).padStart(10)}  ` +
        `${((cum >= 0 ? '+' : '') + cum.toFixed(2)).padStart(10)}   ${res.lockedDays.has(r.d) ? 'yes' : '-'}`
    );
  }
}

main();
