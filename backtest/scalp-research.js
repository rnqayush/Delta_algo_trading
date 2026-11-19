// SCALP RESEARCH — does any 1-MINUTE edge survive realistic Delta taker costs?
//
// The question this answers: on 1m bars, with ~0.12% round-trip cost (taker fee
// + slippage, both legs), is there ANY entry rule whose average move is larger
// than the cost it pays? It tests a handful of principled 1m ideas across a set
// of symbols and reports them honestly — in-sample AND out-of-sample — so a
// tuned-looking backtest cannot be mistaken for an edge.
//
// HONESTY RULES BAKED IN
// ----------------------
//   * No look-ahead. Every signal is read on the LAST CLOSED bar (index i-1)
//     and the fill is the NEXT bar's OPEN (index i) — a market/taker fill.
//   * Costs on every trade: fee + slippage, both legs.
//   * Intrabar ambiguity is reported two ways (like backtest/hftv1.js):
//       pes — the adverse level (stop) is assumed hit first. The safe reading.
//       opt — the friendly level (target) is assumed hit first.
//     The main table is 'pes'; anything that only works under 'opt' is suspect.
//   * Out-of-sample split. The window is cut in two: the first (1 - --oos) is
//     in-sample (IS), the last --oos is held out (OOS). A rule is only a
//     CANDIDATE if it is positive OOS, not just IS.
//   * One position at a time. After a trade the scan resumes on the bar after
//     its exit — the same single-slot model the live engine enforces.
//
//   node backtest/scalp-research.js
//   node backtest/scalp-research.js --days 30 --symbols BTCUSD,ETHUSD --oos 0.3
//   node backtest/scalp-research.js --fee 5 --slip 1     (taker defaults)
//   node backtest/scalp-research.js --fee 0 --slip 0     (frictionless control)
//
// Options:
//   --symbols  comma-separated (default BTCUSD,ETHUSD,SOLUSD,XRPUSD,EVAAUSD)
//   --tf       candle resolution, default 1m
//   --days     look-back window in days, default 20
//   --oos      out-of-sample fraction, default 0.35
//   --fee      taker fee, bps per leg, default 5
//   --slip     slippage, bps per leg, default 1
//   --size     % of equity per trade (for return%), default 10
//   --capital  starting equity, default 10000
//   --mode     pes | opt | both (default pes)

'use strict';

const { downloadCandles, RESOLUTION_SECONDS } = require('./lib/data');

const DEFAULTS = {
  tf: '1m', days: 20, oos: 0.35,
  symbols: 'BTCUSD,ETHUSD,SOLUSD,XRPUSD,EVAAUSD',
  fee: 5, slip: 1, size: 10, capital: 10000, mode: 'pes',
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (!t.startsWith('--')) continue;
    const key = t.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { args[key] = next; i += 1; } else { args[key] = true; }
  }
  return args;
}

const num = (v, d) => (v !== undefined ? Number(v) : d);

// ---------------------------------------------------------------------------
// Indicator series (computed once per symbol on the FULL series so the IS/OOS
// split never changes a warm-up value). Same maths as src/utils/indicators.js.
// ---------------------------------------------------------------------------

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
  const k = 2 / (period + 1);
  let prev = null;
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    const v = values[i];
    if (i < period - 1) { sum += v; continue; }
    if (i === period - 1) { prev = (sum + v) / period; out[i] = prev; continue; }
    prev = v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function stdev(values, period) {
  const n = values.length;
  const out = new Array(n).fill(null);
  for (let i = period - 1; i < n; i += 1) {
    let mean = 0;
    for (let j = i - period + 1; j <= i; j += 1) mean += values[j];
    mean /= period;
    let v = 0;
    for (let j = i - period + 1; j <= i; j += 1) v += (values[j] - mean) ** 2;
    out[i] = Math.sqrt(v / period);
  }
  return out;
}

function atr(candles, period = 14) {
  const n = candles.length;
  const out = new Array(n).fill(null);
  if (n <= period) return out;
  const tr = new Array(n).fill(0);
  for (let i = 1; i < n; i += 1) {
    const c = candles[i];
    const p = candles[i - 1].close;
    tr[i] = Math.max(c.high - c.low, Math.abs(c.high - p), Math.abs(c.low - p));
  }
  let sum = 0;
  for (let i = 1; i <= period; i += 1) sum += tr[i];
  out[period] = sum / period;
  for (let i = period + 1; i < n; i += 1) out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
  return out;
}

function rsi(candles, period = 14) {
  const n = candles.length;
  const out = new Array(n).fill(null);
  let gain = 0; let loss = 0; let ag = null; let al = null;
  for (let i = 1; i < n; i += 1) {
    const ch = candles[i].close - candles[i - 1].close;
    const g = ch > 0 ? ch : 0;
    const l = ch < 0 ? -ch : 0;
    if (i <= period) {
      gain += g; loss += l;
      if (i === period) { ag = gain / period; al = loss / period; }
    } else {
      ag = (ag * (period - 1) + g) / period;
      al = (al * (period - 1) + l) / period;
    }
    if (ag != null) out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}

function dailyVwap(candles) {
  const n = candles.length;
  const out = new Array(n).fill(null);
  let pv = 0; let vv = 0; let day = null;
  for (let i = 0; i < n; i += 1) {
    const c = candles[i];
    const d = new Date(c.time * 1000).toISOString().slice(0, 10);
    if (d !== day) { day = d; pv = 0; vv = 0; }
    pv += ((c.high + c.low + c.close) / 3) * (c.volume || 0);
    vv += c.volume || 0;
    out[i] = vv > 0 ? pv / vv : c.close;
  }
  return out;
}

// The high/low of the FIRST 15 bars of each UTC day, per bar (null before it
// exists). Feeds the opening-range breakout.
function openingRange(candles, minutes = 15) {
  const n = candles.length;
  const up = new Array(n).fill(null);
  const dn = new Array(n).fill(null);
  let dayStart = 0;
  const dayOf = (t) => new Date(t * 1000).toISOString().slice(0, 10);
  for (let i = 0; i < n; i += 1) {
    if (i === 0 || dayOf(candles[i].time) !== dayOf(candles[i - 1].time)) dayStart = i;
    if (i >= dayStart + minutes) {
      let h = -Infinity; let l = Infinity;
      for (let k = dayStart; k < dayStart + minutes; k += 1) {
        if (candles[k].high > h) h = candles[k].high;
        if (candles[k].low < l) l = candles[k].low;
      }
      up[i] = h; dn[i] = l;
    }
  }
  return { up, dn };
}

function buildContext(candles) {
  const close = candles.map((c) => c.close);
  const mid = sma(close, 20);
  const sd = stdev(close, 20);
  const bbUp = mid.map((m, i) => (m == null || sd[i] == null ? null : m + 2 * sd[i]));
  const bbDn = mid.map((m, i) => (m == null || sd[i] == null ? null : m - 2 * sd[i]));
  const orb = openingRange(candles, 15);
  return {
    candles,
    atr: atr(candles, 14),
    rsi: rsi(candles, 14),
    emaFast: ema(close, 9),
    emaSlow: ema(close, 21),
    bbUp, bbDn,
    vwap: dailyVwap(candles),
    orbUp: orb.up, orbDn: orb.dn,
  };
}

// highest high / lowest low over the `len` bars BEFORE index `end` (exclusive).
function highestPrev(candles, end, len) {
  if (end - len < 0) return null;
  let h = -Infinity;
  for (let k = end - len; k < end; k += 1) if (candles[k].high > h) h = candles[k].high;
  return h;
}
function lowestPrev(candles, end, len) {
  if (end - len < 0) return null;
  let l = Infinity;
  for (let k = end - len; k < end; k += 1) if (candles[k].low < l) l = candles[k].low;
  return l;
}

// ---------------------------------------------------------------------------
// Strategy catalogue. Each decides on bar i-1 and is filled at open of bar i.
// `exit` is a fixed stop/target bracket in PERCENT of the fill, plus a time stop.
// ---------------------------------------------------------------------------

const STRATEGIES = [
  {
    id: 'donchian_mom',
    why: 'momentum: close breaks the prior 20-bar range',
    warmup: 24,
    exit: { stop: 0.35, target: 0.7, maxBars: 30 },
    gen: (ctx, i) => {
      const hi = highestPrev(ctx.candles, i - 1, 20);
      const lo = lowestPrev(ctx.candles, i - 1, 20);
      const c = ctx.candles[i - 1].close;
      if (hi != null && c > hi) return { side: 'long' };
      if (lo != null && c < lo) return { side: 'short' };
      return null;
    },
  },
  {
    id: 'prevbar_fade',
    why: 'fade: close pokes outside the previous bar, expect snap-back',
    warmup: 4,
    exit: { stop: 0.4, target: 0.4, maxBars: 10 },
    gen: (ctx, i) => {
      const p = ctx.candles[i - 1];
      const pp = ctx.candles[i - 2];
      if (p.close > pp.high) return { side: 'short' };
      if (p.close < pp.low) return { side: 'long' };
      return null;
    },
  },
  {
    id: 'rsi_rev',
    why: 'reversion: RSI(14) oversold/overbought on the last closed bar',
    warmup: 18,
    exit: { stop: 0.35, target: 0.55, maxBars: 20 },
    gen: (ctx, i) => {
      const r = ctx.rsi[i - 1];
      if (r == null) return null;
      if (r < 30) return { side: 'long' };
      if (r > 70) return { side: 'short' };
      return null;
    },
  },
  {
    id: 'bb_rev',
    why: 'reversion: close outside a 20/2 Bollinger band',
    warmup: 24,
    exit: { stop: 0.35, target: 0.55, maxBars: 20 },
    gen: (ctx, i) => {
      const c = ctx.candles[i - 1].close;
      if (ctx.bbUp[i - 1] != null && c > ctx.bbUp[i - 1]) return { side: 'short' };
      if (ctx.bbDn[i - 1] != null && c < ctx.bbDn[i - 1]) return { side: 'long' };
      return null;
    },
  },
  {
    id: 'ema_mom',
    why: 'trend continuation: EMA9 vs EMA21 with close on the fast side',
    warmup: 24,
    exit: { stop: 0.35, target: 0.7, maxBars: 30 },
    gen: (ctx, i) => {
      const f = ctx.emaFast[i - 1]; const s = ctx.emaSlow[i - 1];
      const c = ctx.candles[i - 1].close;
      if (f == null || s == null) return null;
      if (f > s && c > f) return { side: 'long' };
      if (f < s && c < f) return { side: 'short' };
      return null;
    },
  },
  {
    id: 'volbreak_mom',
    why: 'momentum: an expansion bar (range > 1.3x ATR) closing at an extreme',
    warmup: 18,
    exit: { stop: 0.35, target: 0.7, maxBars: 30 },
    gen: (ctx, i) => {
      const b = ctx.candles[i - 1];
      const a = ctx.atr[i - 1];
      if (a == null) return null;
      const range = b.high - b.low;
      if (!(range > 1.3 * a)) return null;
      const pos = (b.close - b.low) / range;
      if (pos > 0.66) return { side: 'long' };
      if (pos < 0.34) return { side: 'short' };
      return null;
    },
  },
  {
    id: 'vwap_rev',
    why: 'reversion: close stretched >1.5x ATR from session VWAP',
    warmup: 18,
    exit: { stop: 0.35, target: 0.55, maxBars: 20 },
    gen: (ctx, i) => {
      const v = ctx.vwap[i - 1]; const a = ctx.atr[i - 1];
      if (v == null || a == null) return null;
      const d = ctx.candles[i - 1].close - v;
      if (d < -1.5 * a) return { side: 'long' };
      if (d > 1.5 * a) return { side: 'short' };
      return null;
    },
  },
  {
    id: 'orb',
    why: 'breakout: first break of the UTC day opening 15m range (once/day)',
    warmup: 16,
    exit: { stop: 0.5, target: 1.0, maxBars: 90 },
    init: () => ({ day: null }),
    gen: (ctx, i, state) => {
      const up = ctx.orbUp[i - 1]; const dn = ctx.orbDn[i - 1];
      if (up == null || dn == null) return null;
      const day = new Date(ctx.candles[i - 1].time * 1000).toISOString().slice(0, 10);
      if (state.day === day) return null;
      const c = ctx.candles[i - 1].close;
      if (c > up) { state.day = day; return { side: 'long' }; }
      if (c < dn) { state.day = day; return { side: 'short' }; }
      return null;
    },
  },
];

// ---------------------------------------------------------------------------
// Simulation. Entries at open[i]; bracket stop/target in percent; time stop.
// ---------------------------------------------------------------------------

function simulate(ctx, strat, opts, mode, startIdx, endIdx) {
  const candles = ctx.candles;
  const { stopPct, targetPct, maxBars } = strat.exit;
  const state = strat.init ? strat.init() : {};
  const warmup = Math.max(strat.warmup, 20);
  const trades = [];

  let i = Math.max(startIdx, warmup);
  while (i < endIdx) {
    const sig = strat.gen(ctx, i, state);
    if (!sig) { i += 1; continue; }

    const bar = candles[i];
    const o = Number(bar.open);
    if (!(o > 0)) { i += 1; continue; }

    const dir = sig.side === 'long' ? 1 : -1;
    const entry = o;
    const stop = entry * (1 - (dir * stopPct) / 100);
    const target = entry * (1 + (dir * targetPct) / 100);
    const lastBar = Math.min(endIdx - 1, i + maxBars);

    let exit = null; let reason = null; let exitIdx = lastBar;
    for (let j = i; j <= lastBar; j += 1) {
      const b = candles[j];
      const hi = Number(b.high); const lo = Number(b.low); const cl = Number(b.close);
      const hitStop = dir > 0 ? lo <= stop : hi >= stop;
      const hitTarget = dir > 0 ? hi >= target : lo <= target;

      if (hitStop && hitTarget) {
        exit = mode === 'pes' ? stop : target;
        reason = mode === 'pes' ? 'stop' : 'target';
        exitIdx = j; break;
      }
      if (hitStop) { exit = stop; reason = 'stop'; exitIdx = j; break; }
      if (hitTarget) { exit = target; reason = 'target'; exitIdx = j; break; }
      if (j === lastBar) { exit = cl; reason = 'time'; exitIdx = j; break; }
    }
    if (exit == null) { exit = Number(candles[lastBar].close); reason = 'time'; exitIdx = lastBar; }

    const grossPct = (dir * (exit - entry)) / entry;
    const netPct = grossPct - opts.costPerLeg * 2;

    trades.push({ side: sig.side, entry, exit, grossPct, netPct, reason, time: bar.time });

    // Single slot: resume after the exit bar.
    i = exitIdx + 1;
  }

  return trades;
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

function metrics(trades, spanDays, capital, sizePct) {
  const n = trades.length;
  if (!n) return { n: 0, empty: true };
  const sum = (f) => trades.reduce((s, t) => s + f(t), 0);
  const wins = trades.filter((t) => t.netPct > 0);
  const losses = trades.filter((t) => t.netPct <= 0);
  const grossWin = sum((t) => (t.netPct > 0 ? t.netPct : 0));
  const grossLoss = Math.abs(sum((t) => (t.netPct <= 0 ? t.netPct : 0)));

  const shares = {};
  for (const t of trades) shares[t.reason] = (shares[t.reason] || 0) + 1;

  const netPct = sum((t) => t.netPct);
  return {
    n,
    perDay: n / spanDays,
    winPct: (wins.length / n) * 100,
    avgWin: wins.length ? (grossWin / wins.length) * 100 : 0,
    avgLoss: losses.length ? (-grossLoss / losses.length) * 100 : 0,
    pf: grossLoss > 0 ? grossWin / grossLoss : Infinity,
    netPct: netPct * 100,
    expPerTrade: (netPct / n) * 100,
    ret: netPct * (sizePct / 100) * 100,
    shares,
  };
}

// Pool several symbol results into one view (mean per-trade expectancy is the
// honest aggregate; summed net% would just favour whichever symbol traded more).
function pool(perSymbol) {
  const all = perSymbol.flatMap((r) => r.trades);
  if (!all.length) return { n: 0, empty: true };
  const n = all.length;
  const wins = all.filter((t) => t.netPct > 0);
  const losses = all.filter((t) => t.netPct <= 0);
  const exp = all.reduce((s, t) => s + t.netPct, 0) / n;
  const grossWin = all.reduce((s, t) => s + (t.netPct > 0 ? t.netPct : 0), 0);
  const grossLoss = Math.abs(all.reduce((s, t) => s + (t.netPct <= 0 ? t.netPct : 0), 0));
  return {
    n,
    winPct: (wins.length / n) * 100,
    expPerTrade: exp * 100,
    pf: grossLoss > 0 ? grossWin / grossLoss : Infinity,
    symbolsPositive: perSymbol.filter((r) => r.netPct > 0).length,
    symbols: perSymbol.length,
  };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '-');
const signed = (v, d = 2) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(d)}` : '-');
const pad = (t, w, right = false) => (right ? String(t).padStart(w) : String(t).padEnd(w));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tf = args.tf ? String(args.tf) : DEFAULTS.tf;
  if (!RESOLUTION_SECONDS[tf]) { console.error(`Unsupported --tf "${tf}"`); process.exit(1); }

  const days = num(args.days, DEFAULTS.days);
  const oosFrac = Math.min(0.8, Math.max(0.1, num(args.oos, DEFAULTS.oos)));
  const sizePct = num(args.size, DEFAULTS.size);
  const capital = num(args.capital, DEFAULTS.capital);
  const fee = num(args.fee, DEFAULTS.fee) / 1e4;
  const slip = num(args.slip, DEFAULTS.slip) / 1e4;
  const costPerLeg = fee + slip;
  const modeArg = args.mode ? String(args.mode) : DEFAULTS.mode;
  const mode = modeArg === 'opt' ? 'opt' : 'pes';

  const symbols = String(args.symbols || DEFAULTS.symbols).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);

  console.log(`\nSCALP RESEARCH — ${tf} bars, last ${days}d, mode=${mode}`);
  console.log('='.repeat(120));
  console.log(
    `decision on the last CLOSED bar -> fill at the next bar's OPEN (taker); ` +
      `cost ${costPerLeg > 0 ? `${(costPerLeg * 2 * 1e4).toFixed(1)}bps round-trip` : 'NONE'}` +
      `   |   OOS = last ${(oosFrac * 100).toFixed(0)}% of the window`
  );

  // --- download + context ---------------------------------------------------
  const data = [];
  for (const symbol of symbols) {
    const toSec = Math.floor(Date.now() / 1000);
    const fromSec = toSec - days * 86400;
    try {
      const { candles } = await downloadCandles({ symbol, resolution: tf, fromSec, toSec });
      if (candles.length < 600) { console.log(`  ${pad(symbol, 10)} skipped: only ${candles.length} bars`); continue; }
      data.push({ symbol, candles, ctx: buildContext(candles) });
      console.log(`  ${pad(symbol, 10)} ${pad(candles.length, 7, true)} bars`);
    } catch (error) {
      console.log(`  ${pad(symbol, 10)} skipped: ${error.message}`);
    }
  }
  if (!data.length) { console.log('no data'); return; }

  const opts = { costPerLeg };

  // --- evaluate every strategy on every symbol, per segment ----------------
  const results = STRATEGIES.map((strat) => {
    const perSymbol = { is: [], oos: [] };
    for (const { symbol, candles, ctx } of data) {
      const n = candles.length;
      const split = Math.floor(n * (1 - oosFrac));
      const spanDays = (candles[n - 1].time - candles[0].time) / 86400;
      const isTrades = simulate(ctx, strat, opts, mode, 0, split);
      const oosTrades = simulate(ctx, strat, opts, mode, split, n);
      perSymbol.is.push({ symbol, trades: isTrades, ...metrics(isTrades, spanDays * (1 - oosFrac), capital, sizePct) });
      perSymbol.oos.push({ symbol, trades: oosTrades, ...metrics(oosTrades, spanDays * oosFrac, capital, sizePct) });
    }
    return { strat, perSymbol, isPool: pool(perSymbol.is), oosPool: pool(perSymbol.oos) };
  });

  // --- pooled summary, ranked by out-of-sample expectancy -------------------
  console.log('\nPOOLED ACROSS SYMBOLS  (ranked by OOS expectancy per trade — the honest number)');
  console.log('-'.repeat(120));
  console.log(
    `${pad('#', 2, true)} | ${pad('strategy', 14)} | ${pad('IS n', 6, true)} | ${pad('IS win%', 7, true)} | ` +
      `${pad('IS exp%', 8, true)} | ${pad('IS net%', 8, true)} | ${pad('OOS n', 6, true)} | ${pad('OOS win%', 8, true)} | ` +
      `${pad('OOS exp%', 9, true)} | ${pad('OOS PF', 6, true)} | ${pad('OOS +/-', 8, true)}`
  );
  const ranked = [...results].sort((a, b) => (b.oosPool.expPerTrade || -9) - (a.oosPool.expPerTrade || -9));
  ranked.forEach((r, idx) => {
    const { isPool, oosPool } = r;
    const sym = oosPool.empty ? '-' : `${oosPool.symbolsPositive}/${oosPool.symbols}`;
    console.log(
      `${pad(idx + 1, 2, true)} | ${pad(r.strat.id, 14)} | ` +
        `${pad(isPool.empty ? 0 : isPool.n, 6, true)} | ${pad(fmt(isPool.winPct, 1), 7, true)} | ` +
        `${pad(signed(isPool.expPerTrade, 3), 8, true)} | ${pad(signed(isPool.netPct, 2), 8, true)} | ` +
        `${pad(oosPool.empty ? 0 : oosPool.n, 6, true)} | ${pad(fmt(oosPool.winPct, 1), 8, true)} | ` +
        `${pad(signed(oosPool.expPerTrade, 3), 9, true)} | ${pad(fmt(oosPool.pf, 2), 6, true)} | ${pad(sym, 8, true)}`
    );
  });

  // --- per-symbol detail for the leaders ------------------------------------
  const leaders = ranked.filter((r) => !r.oosPool.empty && r.oosPool.expPerTrade > 0);
  if (leaders.length) {
    console.log('\nCANDIDATES (positive OOS expectancy) — per-symbol breakdown');
    console.log('-'.repeat(120));
    console.log(
      `${pad('strategy', 14)} | ${pad('symbol', 10)} | ${pad('trades', 7, true)} | ${pad('win%', 6, true)} | ` +
        `${pad('avgWin%', 8, true)} | ${pad('avgLoss%', 8, true)} | ${pad('net%', 8, true)} | ${pad('per-day', 7, true)} | ${pad('exit mix', 22)}`
    );
    for (const r of leaders) {
      for (const row of r.perSymbol.oos) {
        if (row.empty) continue;
        const mix = Object.entries(row.shares).map(([k, v]) => `${k}:${Math.round((v / row.n) * 100)}%`).join(' ');
        console.log(
          `${pad(r.strat.id, 14)} | ${pad(row.symbol, 10)} | ${pad(row.n, 7, true)} | ${pad(fmt(row.winPct, 1), 6, true)} | ` +
            `${pad(signed(row.avgWin, 2), 8, true)} | ${pad(signed(row.avgLoss, 2), 8, true)} | ${pad(signed(row.netPct, 2), 8, true)} | ` +
            `${pad(fmt(row.perDay, 1), 7, true)} | ${pad(mix, 22)}`
        );
      }
    }
  } else {
    console.log('\nNo strategy held a positive out-of-sample expectancy at these costs.');
  }

  // --- how the catalogue is wired -------------------------------------------
  console.log('\nCATALOGUE');
  console.log('-'.repeat(120));
  for (const s of STRATEGIES) {
    console.log(
      `  ${pad(s.id, 14)} stop ${s.exit.stop}% / target ${s.exit.target}% / ${s.exit.maxBars} bars  — ${s.why}`
    );
  }
  console.log(
    '\nexp% = mean NET return per trade on notional (after costs) — the edge per trade;\n' +
      'net% = total summed NET return on notional over the segment (not compounded);\n' +
      'PF   = gross profit / gross loss;  +/- = symbols with positive net% / symbols tested;\n' +
      `mode '${mode}': ${mode === 'pes' ? 'adverse level assumed hit first (safe)' : 'friendly level assumed hit first (optimistic — treat with suspicion)'}.`
  );
}

main().catch((error) => { console.error('RESEARCH FAILED:', error.message); process.exit(1); });
