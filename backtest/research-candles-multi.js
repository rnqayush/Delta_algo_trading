// CANDLESTICK PATTERN STUDY — MANY SYMBOLS, MANY TIMEFRAMES
//
// The 1m BTCUSD practice (research-candles-1m.js) found the edge (~0.2-0.4 ATR)
// is several times smaller than the ~9 bps round-trip cost, because a 1-ATR
// stop on 1m is only ~4 bps. The lesson: what matters is not the ATR-unit edge
// but whether  edge_bps = grossR x stopAtr x medianATRbps  beats the cost.
//
// Two ways to win that race:
//   (a) bigger median ATR (volatile symbols / higher timeframes), or
//   (b) bigger grossR (better pattern + context).
// This script hunts for (symbol, timeframe, pattern, context) that win it, and
// checks the result is ROBUST (holds across many symbols, not one lucky one).
//
//   node backtest/research-candles-multi.js --tf 5m
//   node backtest/research-candles-multi.js --tf 15m --days 120
//   node backtest/research-candles-multi.js --tf 5m --stopAtr 2 --costBps 9
'use strict';

const fs = require('fs');
const path = require('path');
const { loadCache } = require('./lib/data');

const DATA_DIR = path.join(__dirname, 'data');
const EXEC_DIR = path.join(DATA_DIR, 'research', 'exec');

const REAL = { maker: 0.0002, taker: 0.0005, slip: 0.0002 };

const CFG = {
  contractValue: 0.001,
  initialEquity: 1200,
  riskPct: 0.005,
  maxNotionalPct: 20,
};

const P = {
  atrPeriod: 14,
  bodyAvgPeriod: 20,
  trendFast: 20,
  trendSlow: 200,
  erPeriod: 10,
  volWindow: 240,
  swingLookback: 20,
};

const ARGS = { tf: '5m', days: 0, stopAtr: 1, targetR: 1, hold: 20, costBps: 9, minTrades: 300, minSymbols: 6, minAtrBps: 0 };

// ---------------------------------------------------------------------------
// indicators
// ---------------------------------------------------------------------------

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

function sma(values, period) {
  const n = values.length;
  const out = new Array(n).fill(null);
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function ema(values, period) {
  const n = values.length;
  const out = new Array(n).fill(null);
  if (n < period) return out;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i += 1) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < n; i += 1) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function erSeries(candles, period) {
  const n = candles.length;
  const out = new Array(n).fill(null);
  for (let i = period; i < n; i += 1) {
    const change = Math.abs(candles[i].close - candles[i - period].close);
    let travel = 0;
    for (let j = i - period + 1; j <= i; j += 1) travel += Math.abs(candles[j].close - candles[j - 1].close);
    out[i] = travel ? change / travel : 0;
  }
  return out;
}

// ---------------------------------------------------------------------------
// pattern library (same geometry as the 1m practice)
// ---------------------------------------------------------------------------

function geom(c) {
  const body = Math.abs(c.close - c.open);
  const range = Math.max(1e-9, c.high - c.low);
  const upper = c.high - Math.max(c.open, c.close);
  const lower = Math.min(c.open, c.close) - c.low;
  const bull = c.close >= c.open;
  return { body, range, upper, lower, bull, bodyFrac: body / range };
}

function detectAt(candles, i, avgBody, avgRange) {
  const found = [];
  if (i < 3) return found;
  const c = candles[i], p1 = candles[i - 1], p2 = candles[i - 2];
  const g = geom(c), g1 = geom(p1), g2 = geom(p2);
  const bigBody = g.body >= avgBody[i] * 1.2;
  const smallBody = g.body <= avgBody[i] * 0.6;

  if (g.bull && bigBody && g.bodyFrac >= 0.7) found.push({ name: 'bullMarubozu', dir: 1 });
  if (!g.bull && bigBody && g.bodyFrac >= 0.7) found.push({ name: 'bearMarubozu', dir: -1 });
  if (g.lower >= g.body * 2 && g.lower >= g.range * 0.5 && g.upper <= g.range * 0.2) found.push({ name: 'hammer', dir: 1 });
  if (g.upper >= g.body * 2 && g.upper >= g.range * 0.5 && g.lower <= g.range * 0.2) found.push({ name: 'shootingStar', dir: -1 });

  if (!g1.bull && g.bull && c.open <= p1.close && c.close >= p1.open && bigBody) found.push({ name: 'bullEngulf', dir: 1 });
  if (g1.bull && !g.bull && c.open >= p1.close && c.close <= p1.open && bigBody) found.push({ name: 'bearEngulf', dir: -1 });

  const insidePrev =
    Math.max(c.open, c.close) <= Math.max(p1.open, p1.close) &&
    Math.min(c.open, c.close) >= Math.min(p1.open, p1.close);
  if (!g1.bull && g1.body >= avgBody[i] && smallBody && insidePrev) found.push({ name: 'bullHarami', dir: 1 });
  if (g1.bull && g1.body >= avgBody[i] && smallBody && insidePrev) found.push({ name: 'bearHarami', dir: -1 });

  if (Math.abs(c.low - p1.low) <= avgRange[i] * 0.05 && g.bull && !g1.bull) found.push({ name: 'tweezerBottom', dir: 1 });
  if (Math.abs(c.high - p1.high) <= avgRange[i] * 0.05 && !g.bull && g1.bull) found.push({ name: 'tweezerTop', dir: -1 });

  if (!g2.bull && g2.body >= avgBody[i] && smallBody && g.bull && c.close > (p2.open + p2.close) / 2) found.push({ name: 'morningStar', dir: 1 });
  if (g2.bull && g2.body >= avgBody[i] && smallBody && !g.bull && c.close < (p2.open + p2.close) / 2) found.push({ name: 'eveningStar', dir: -1 });
  if (g2.bull && g1.bull && g.bull && c.close > p1.close && p1.close > p2.close) found.push({ name: 'threeWhiteSoldiers', dir: 1 });
  if (!g2.bull && !g1.bull && !g.bull && c.close < p1.close && p1.close < p2.close) found.push({ name: 'threeBlackCrows', dir: -1 });

  return found;
}

// ---------------------------------------------------------------------------
// context gates
// ---------------------------------------------------------------------------

function analyseSymbol(candles, win) {
  const n = candles.length;
  const atrArr = atr(candles, P.atrPeriod);

  // median ATR in bps — the number the edge must out-run
  const bps = [];
  for (let i = P.atrPeriod + 1; i < n; i += 1) if (atrArr[i] && candles[i].close > 0) bps.push((atrArr[i] / candles[i].close) * 1e4);
  bps.sort((a, b) => a - b);
  const medAtrBps = bps.length ? bps[Math.floor(bps.length / 2)] : 0;
  if (medAtrBps < ARGS.minAtrBps) return { signals: [], atrArr, medAtrBps, bars: n, skipped: true };

  const erArr = erSeries(candles, P.erPeriod);
  const closes = candles.map((c) => c.close);
  const emaFast = ema(closes, P.trendFast);
  const emaSlow = ema(closes, P.trendSlow);
  const volAvg = sma(candles.map((c) => c.volume), P.volWindow);
  const bodies = candles.map((c) => Math.abs(c.close - c.open));
  const ranges = candles.map((c) => c.high - c.low);
  const avgBody = sma(bodies, P.bodyAvgPeriod);
  const avgRange = sma(ranges, P.bodyAvgPeriod);

  const signals = [];
  for (let i = P.bodyAvgPeriod + 3; i < n - ARGS.hold - 2; i += 1) {
    if (!atrArr[i] || !avgBody[i] || !avgRange[i]) continue;
    if (win && (candles[i].time < win.from || candles[i].time >= win.to)) continue;
    const a = atrArr[i];
    const bar = candles[i];
    const swing = candles.slice(Math.max(0, i - P.swingLookback + 1), i + 1);
    let hi = -Infinity, lo = Infinity;
    for (const w of swing) {
      if (w.high > hi) hi = w.high;
      if (w.low < lo) lo = w.low;
    }
    const ctx = {
      atHigh: bar.high >= hi - 1e-9,
      atLow: bar.low <= lo + 1e-9,
      trendUp: emaSlow[i] !== null && bar.close > emaSlow[i],
      er: erArr[i],
      atrPct: a / bar.close,
      rangeAtr: (bar.high - bar.low) / a,
      stretchAtr: emaFast[i] !== null ? Math.abs(bar.close - emaFast[i]) / a : 0,
      volRatio: volAvg[i] ? bar.volume / volAvg[i] : 1,
    };
    for (const pat of detectAt(candles, i, avgBody, avgRange)) {
      signals.push({ i, name: pat.name, dir: pat.dir, ctx });
    }
  }

  return { signals, atrArr, medAtrBps, bars: n };
}

// ---------------------------------------------------------------------------
// trade sim (1 ATR stop by default; --stopAtr to widen)
// ---------------------------------------------------------------------------

function sizeContracts(entry, stop) {
  const dist = Math.abs(entry - stop);
  if (!(dist > 0)) return 0;
  const byRisk = Math.floor((CFG.initialEquity * CFG.riskPct) / (dist * CFG.contractValue));
  const byNotional = Math.floor((CFG.initialEquity * CFG.maxNotionalPct) / (entry * CFG.contractValue));
  return Math.max(0, Math.min(byRisk, byNotional));
}

function tradeOne(candles, atrArr, s) {
  const a = atrArr[s.i];
  if (!a || s.dir === 0) return null;
  const entryBar = s.i + 1;
  const entry = candles[entryBar].open;
  const stop = entry - s.dir * ARGS.stopAtr * a;
  const target = entry + s.dir * ARGS.targetR * ARGS.stopAtr * a;
  const contracts = sizeContracts(entry, stop);
  if (!(contracts > 0)) return null;
  const end = Math.min(candles.length - 1, entryBar + ARGS.hold);
  let exitPrice = candles[end].close;
  for (let m = entryBar; m <= end; m += 1) {
    const hitStop = s.dir === 1 ? candles[m].low <= stop : candles[m].high >= stop;
    const hitTarget = s.dir === 1 ? candles[m].high >= target : candles[m].low <= target;
    if (hitStop) { exitPrice = stop; break; }
    if (hitTarget) { exitPrice = target; break; }
  }
  const risk = Math.abs(entry - stop) * contracts * CFG.contractValue;
  const gross = (exitPrice - entry) * s.dir * contracts * CFG.contractValue;
  return { gross, risk, r: gross / Math.max(1e-9, risk), win: gross > 0 };
}

// ---------------------------------------------------------------------------
// setups (pattern-agnostic context gates)
// ---------------------------------------------------------------------------

const SETUPS = [
  { label: 'raw', f: () => true },
  { label: 'extreme', f: (s) => (s.dir === 1 ? s.ctx.atLow : s.ctx.atHigh) },
  { label: 'extreme+exhaust', f: (s) => (s.dir === 1 ? s.ctx.atLow : s.ctx.atHigh) && s.ctx.rangeAtr >= 2 },
  { label: 'extreme+stretch', f: (s) => (s.dir === 1 ? s.ctx.atLow : s.ctx.atHigh) && s.ctx.stretchAtr >= 1.5 },
  { label: 'extreme+range', f: (s) => (s.dir === 1 ? s.ctx.atLow : s.ctx.atHigh) && s.ctx.er !== null && s.ctx.er <= 0.45 },
  { label: 'extreme+volume', f: (s) => (s.dir === 1 ? s.ctx.atLow : s.ctx.atHigh) && s.ctx.volRatio >= 1.5 },
  { label: 'trend-aligned', f: (s) => (s.dir === 1 ? s.ctx.trendUp : !s.ctx.trendUp) },
  { label: 'extreme+trend', f: (s) => (s.dir === 1 ? s.ctx.atLow : s.ctx.atHigh) && (s.dir === 1 ? s.ctx.trendUp : !s.ctx.trendUp) },
];

// ---------------------------------------------------------------------------
// symbol discovery
// ---------------------------------------------------------------------------

function discover(tf) {
  const names = new Set();
  for (const dir of [DATA_DIR, EXEC_DIR]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(new RegExp(`^(.+)_${tf}\\.json$`));
      if (m) names.add(m[1]);
    }
  }
  return [...names].sort();
}

function parseArgs(argv) {
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--tf') ARGS.tf = argv[++i];
    else if (a === '--days') ARGS.days = Number(argv[++i]);
    else if (a === '--stopAtr') ARGS.stopAtr = Number(argv[++i]);
    else if (a === '--targetR') ARGS.targetR = Number(argv[++i]);
    else if (a === '--hold') ARGS.hold = Number(argv[++i]);
    else if (a === '--costBps') ARGS.costBps = Number(argv[++i]);
    else if (a === '--minTrades') ARGS.minTrades = Number(argv[++i]);
    else if (a === '--minAtrBps') ARGS.minAtrBps = Number(argv[++i]);
  }
}

function pad(t, w, right = false) {
  const s = String(t);
  return right ? s.padStart(w) : s.padEnd(w);
}
const fmt = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : 'inf');

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

// Build the (pattern x setup x half) trade buckets in a single pass over the
// symbol caches. `split` tags each signal as first/second half of the study
// window so the same run can do in-sample vs out-of-sample validation.
function buildBuckets(symbols) {
  const buckets = new Map(); // key -> { pattern, setup, half, owners:Set, trades:[] }
  const perSymbol = [];

  for (const symbol of symbols) {
    const cached = loadCache(symbol, ARGS.tf);
    if (!cached || !cached.candles || cached.candles.length < 500) continue;
    let candles = cached.candles;
    if (ARGS.days > 0) {
      const from = candles[candles.length - 1].time - ARGS.days * 86400;
      candles = candles.filter((c) => c.time >= from);
    }
    if (candles.length < 500) continue;

    let res;
    try {
      res = analyseSymbol(candles, null);
    } catch (e) {
      continue;
    }
    const { signals, atrArr, medAtrBps, skipped } = res;
    if (skipped) continue;

    for (let si = 0; si < SETUPS.length; si += 1) {
      for (const s of signals) {
        if (!SETUPS[si].f(s)) continue;
        const t = tradeOne(candles, atrArr, s);
        if (!t) continue;
        const half = s.i + 1 < candles.length / 2 ? 0 : 1; // per-symbol first/second half
        const k = `${s.name}|${si}|${half}`;
        let b = buckets.get(k);
        if (!b) {
          b = { pattern: s.name, setup: SETUPS[si].label, half, owners: new Set(), trades: [] };
          buckets.set(k, b);
        }
        b.trades.push(t);
        b.owners.add(symbol);
      }
    }
    perSymbol.push({ symbol, medAtrBps, signals: signals.length, bars: candles.length });
  }
  return { buckets, perSymbol };
}

// Collapse the buckets for the requested halves into ranked rows.
function rowsFrom(buckets, perSymbol, halves) {
  const merged = new Map();
  for (const b of buckets.values()) {
    if (!halves.includes(b.half)) continue;
    const k = `${b.pattern}|${b.setup}`;
    let m = merged.get(k);
    if (!m) {
      m = { pattern: b.pattern, setup: b.setup, owners: new Set(), trades: [] };
      merged.set(k, m);
    }
    for (const t of b.trades) m.trades.push(t);
    for (const o of b.owners) m.owners.add(o);
  }
  const rows = [];
  for (const m of merged.values()) {
    const n = m.trades.length;
    if (n < ARGS.minTrades || m.owners.size < ARGS.minSymbols) continue;
    const grossR = m.trades.reduce((s, t) => s + t.r, 0) / n;
    const win = m.trades.filter((t) => t.win).length / n;
    const ggp = m.trades.filter((t) => t.gross > 0).reduce((s, t) => s + t.gross, 0);
    const ggl = Math.abs(m.trades.filter((t) => t.gross <= 0).reduce((s, t) => s + t.gross, 0));
    const medAtr = perSymbol.filter((s) => m.owners.has(s.symbol)).map((s) => s.medAtrBps).sort((a, c) => a - c);
    const medAtrBps = medAtr.length ? medAtr[Math.floor(medAtr.length / 2)] : 0;
    const edgeBps = grossR * ARGS.stopAtr * medAtrBps;
    const se = Math.sqrt(Math.max(1e-9, win * (1 - win)) / n);
    rows.push({
      pattern: m.pattern,
      setup: m.setup,
      n,
      symbols: m.owners.size,
      win,
      gpf: ggl > 0 ? ggp / ggl : Infinity,
      grossR,
      edgeBps,
      medAtrBps,
      z: win > 0 ? (win - 0.5) / se : 0,
      clears: edgeBps >= ARGS.costBps,
    });
  }
  rows.sort((a, b) => b.edgeBps - a.edgeBps);
  return rows;
}

function main() {
  parseArgs(process.argv);
  const symbols = discover(ARGS.tf);
  if (!symbols.length) throw new Error(`No *_${ARGS.tf}.json caches found. Run backtest/fetch.js first.`);

  const costBps = ARGS.costBps;
  console.log('============================================================');
  console.log(` CANDLESTICK PATTERN STUDY — ${ARGS.tf}  |  ${symbols.length} symbols  |  window: last ${ARGS.days || 'all'}d`);
  console.log(` trade: stop ${ARGS.stopAtr}ATR  target ${ARGS.targetR}R  hold ${ARGS.hold} bars  |  cost ${costBps.toFixed(2)} bps`);
  console.log(' edge_bps = grossR x stopAtr x medianATRbps   (must beat the cost)');
  console.log('============================================================');

  const { buckets, perSymbol } = buildBuckets(symbols);

  perSymbol.sort((a, b) => b.medAtrBps - a.medAtrBps);
  console.log('\nPER-SYMBOL VOLATILITY (median ATR vs cost)');
  console.log(`  ${pad('symbol', 14)} | ${pad('bars', 7, true)} | ${pad('signals', 8, true)} | ${pad('medATR bps', 10, true)} | ${pad('cost/ATR', 8, true)}`);
  console.log('  ' + '-'.repeat(58));
  for (const s of perSymbol) {
    console.log(
      `  ${pad(s.symbol, 14)} | ${pad(s.bars, 7, true)} | ${pad(s.signals, 8, true)} | ${pad(s.medAtrBps.toFixed(1), 10, true)} | ${pad((costBps / s.medAtrBps).toFixed(2) + 'x', 8, true)}`
    );
  }

  const rows = rowsFrom(buckets, perSymbol, [0, 1]);
  console.log('\nRANKED COMBOS (pattern x context, pooled across symbols)  — sorted by edge_bps');
  console.log(
    `  ${pad('pattern', 18)} | ${pad('setup', 17)} | ${pad('n', 6, true)} | ${pad('sym', 4, true)} | ${pad('win%', 5, true)} | ${pad('gPF', 5, true)} | ${pad('grossR', 7, true)} | ${pad('medATR', 7, true)} | ${pad('edge bps', 8, true)} | ${pad('cost', 5, true)} | clears`
  );
  console.log('  ' + '-'.repeat(126));
  for (const r of rows.slice(0, 25)) {
    console.log(
      `  ${pad(r.pattern, 18)} | ${pad(r.setup, 17)} | ${pad(r.n, 6, true)} | ${pad(r.symbols, 4, true)} | ${pad((r.win * 100).toFixed(1), 5, true)} | ` +
        `${pad(fmt(r.gpf), 5, true)} | ${pad(fmt(r.grossR, 3), 7, true)} | ${pad(r.medAtrBps.toFixed(1), 7, true)} | ${pad(r.edgeBps.toFixed(2), 8, true)} | ` +
        `${pad(costBps.toFixed(1), 5, true)} | ${r.clears ? 'YES' : 'no'}`
    );
  }

  const clearers = rows.filter((r) => r.clears);

  // ---- in-sample vs out-of-sample validation ----------------------------
  // Rank combos on the FIRST half only, then check the same combos on the
  // SECOND half. This is what separates a real edge from a lucky screen.
  const isRows = rowsFrom(buckets, perSymbol, [0]);
  const oosRows = rowsFrom(buckets, perSymbol, [1]);
  const oosByKey = new Map(oosRows.map((r) => [`${r.pattern}|${r.setup}`, r]));

  console.log('\nOUT-OF-SAMPLE CHECK (rank on 1st half -> verify on 2nd half)');
  console.log(
    `  ${pad('pattern', 18)} | ${pad('setup', 17)} | ${pad('IS n', 5, true)} | ${pad('IS win%', 7, true)} | ${pad('IS edge', 8, true)} | ${pad('OOS n', 5, true)} | ${pad('OOS win%', 7, true)} | ${pad('OOS edge', 8, true)} | held?`
  );
  console.log('  ' + '-'.repeat(112));
  const isTop = isRows.filter((r) => r.clears).slice(0, 12);
  let held = 0;
  for (const r of isTop) {
    const o = oosByKey.get(`${r.pattern}|${r.setup}`);
    const ok = o && o.edgeBps >= costBps;
    if (ok) held += 1;
    console.log(
      `  ${pad(r.pattern, 18)} | ${pad(r.setup, 17)} | ${pad(r.n, 5, true)} | ${pad((r.win * 100).toFixed(1), 7, true)} | ${pad(r.edgeBps.toFixed(2), 8, true)} | ` +
        `${pad(o ? o.n : 0, 5, true)} | ${pad(o ? (o.win * 100).toFixed(1) : '-', 7, true)} | ${pad(o ? o.edgeBps.toFixed(2) : '-', 8, true)} | ${ok ? 'YES' : 'no'}`
    );
  }
  console.log(`  => ${isTop.length ? held : 0}/${isTop.length} in-sample clearers survived out-of-sample`);

  console.log('\nVERDICT');
  console.log(`  combos evaluated (n>=${ARGS.minTrades}, symbols>=${ARGS.minSymbols}): ${rows.length}`);
  console.log(`  combos whose edge_bps beats ${costBps.toFixed(1)} bps cost (full window): ${clearers.length}`);
  if (rows.length) {
    const strongest = [...rows].sort((a, b) => b.z - a.z)[0];
    console.log(
      `  most statistically significant: ${strongest.pattern} + ${strongest.setup}  win=${(strongest.win * 100).toFixed(1)}%  ` +
        `n=${strongest.n}  z=${strongest.z.toFixed(1)}  edge=${strongest.edgeBps.toFixed(2)} bps  clears=${strongest.clears ? 'YES' : 'no'}`
    );
  }
  console.log();
}

main();
